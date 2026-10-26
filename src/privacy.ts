// Privacy mode (nome provvisorio) — what leaves this server towards the model.
//
//   AE_MCP_PRIVACY=1                  — turn the filter on (off by default)
//   AE_MCP_PRIVACY_WORDS=<file>       — words/phrases to hide behind labels,
//                                       one per line (# comments, optional
//                                       "[CATEGORY] " prefix)
//   AE_MCP_PRIVACY_ALLOW_FIELDS=a,b   — redacted text fields the user re-opens
//
// Every tool call passes through `guardToolCall` (src/index.ts, `register`),
// so one filter covers all eleven tools, the Node-side operations and the
// errors this server builds itself — the transport only ever sees what After
// Effects answered. On the way IN it turns labels back into the real words,
// so `comp: "[CLIENTE-1]_Main"` still finds the comp; on the way OUT it
// reduces paths to file names, replaces listed words with labels, withholds
// free project texts and drops image blocks.
//
// What the model may see is the user's decision, never the model's: every
// knob is an environment variable read here, no tool argument can change it.
//
// With the switch off `guardToolCall` hands the call straight to the handler,
// so responses stay byte-for-byte what they were.

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { type AeErrorCode, errorResult } from "./errors.js";
import type { Denial } from "./policy.js";
import type { ToolContent, ToolResult } from "./tools/types.js";

export function privacyMode(): boolean {
  return process.env.AE_MCP_PRIVACY === "1";
}

/**
 * Fields whose string values are free project text: layer texts (and the
 * lines of text.measure), expressions (`expr` is expression.disable_all's
 * manifest), item and marker comments, the XMP packet, dropdown menu items
 * and their current text. They come back as `{ redatto, lunghezza, rif }`.
 */
export const PRIVACY_REDACTED_FIELDS = [
  "text",
  "expression",
  "expr",
  "comment",
  "xmp",
  "valueText",
  "items",
  "propertyParameters",
] as const;

/**
 * Fields that hold a file path as their whole value. Their value is reduced
 * to the file name even when it does not look absolute (`renders/out.png`);
 * every other string is still searched for absolute paths by shape.
 */
const PATH_FIELDS = new Set([
  "file",
  "project",
  "projectFile",
  "missingFootagePath",
  "missingPath",
  "writtenTo",
  "outputPath",
  "outputs",
  "outPath",
  "inPath",
  "location",
  "fontLocation",
  "copiedFrom",
  "path",
]);

/** Dialog fields withheld whatever AE_MCP_PRIVACY_ALLOW_FIELDS says. */
const DIALOG_FIELDS = new Set(["text", "window"]);

const DIALOG_SCRUB = "[dialog text withheld]";

const DEFAULT_CATEGORY = "CLIENTE";

// ---------------------------------------------------------------------------
// Paths

// Where an absolute path starts: a drive (C:/ or C:\), a UNC share
// (\\server\), a macOS user or volume folder, a home-relative path, or the
// URI form ExtendScript's File.fullName uses on Windows (/c/Users/...).
const PATH_START =
  String.raw`(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]` +
  String.raw`|(?<![\w\\])\\\\[\w.$-]+\\` +
  // Any absolute POSIX path with at least two segments: /var/folders and
  // /private (where macOS keeps os.tmpdir(), so the IPC mailbox), /tmp and
  // /home (Linux, the CI), but also a NAS mounted at /data. Two exceptions:
  // a first segment made only of digits is expression.disable_all's property
  // path ("/2/1/4"), and the lookbehind keeps it off URLs ("host/a", "//").
  String.raw`|(?<![\w.~:/\\])\/(?=[^/\s"<>|*?]*[^\d/\s"<>|*?])[^/\s"<>|*?]+\/(?=[^/\s"<>|*?])` +
  String.raw`|(?<![\w.~:/\\])\/[A-Za-z]\/` +
  String.raw`|(?<![\w.~/\\])~[\\/])`;

// A path runs until a character no path holds (quotes, <>|*?, line breaks)
// or until the next path starts. Spaces and apostrophes are kept: stopping
// early would leave the rest of a folder name ("Rossi Spa/...") in clear, and
// swallowing a few words of the sentence after the path is the safe mistake.
const PATH_RE = new RegExp(
  PATH_START + String.raw`(?:(?![,;]?\s+` + PATH_START + String.raw`)[^"<>|*?\r\n\t])*`,
  "g",
);

/** Last non-empty segment of a path; the input itself when it has none. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : p;
}

/** Replaces every absolute file path inside `text` with its file name. */
export function stripPaths(text: string): string {
  return text.replace(PATH_RE, (m) => baseName(m));
}

/** Whole-value path rule for a known path field. */
function stripPathField(key: string, value: string): string {
  // `path` is also expression.disable_all's property path ("/2/1/4"), which
  // restore_all needs intact: only an absolute file path counts there.
  if (key === "path") return value;
  if (!/[\\/]/.test(value)) return value;
  return baseName(value);
}

// ---------------------------------------------------------------------------
// Word list

export interface WordEntry {
  /** The word or phrase as written in the file. */
  word: string;
  /** Its stable label, e.g. "[CLIENTE-1]". */
  label: string;
}

/** Parses the word-list file: one word or phrase per line. */
export function parseWordList(content: string): WordEntry[] {
  const entries: WordEntry[] = [];
  const seen = new Set<string>();
  const counters = new Map<string, number>();
  for (const raw of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tagged = /^\[([\p{L}\p{N}_]+)\]\s*(.+)$/u.exec(line);
    const category = tagged ? tagged[1]!.toUpperCase() : DEFAULT_CATEGORY;
    const word = (tagged ? tagged[2]! : line).trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    const n = (counters.get(category) ?? 0) + 1;
    counters.set(category, n);
    entries.push({ word, label: `[${category}-${n}]` });
  }
  return entries;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Session state — labels, spellings seen, redacted texts

interface Session {
  entries: WordEntry[];
  /** Single-pass matcher, longest phrase first; null without words. */
  wordRe: RegExp | null;
  byLower: Map<string, WordEntry>;
  byLabel: Map<string, WordEntry>;
  /** Spellings of each label's word actually seen in responses. */
  spellings: Map<string, Set<string>>;
  /** Redacted texts by reference, so a marker passed back restores them. */
  vault: Map<string, string>;
  refs: Map<string, string>;
  redacted: Set<string>;
  allowed: string[];
  /** Set when the word list was configured but could not be read. */
  configError: string | null;
}

let session: Session | null = null;

/** Drops the session so the next call re-reads the environment. Tests only. */
export function resetPrivacyForTests(): void {
  session = null;
}

function currentSession(): Session {
  if (session) return session;
  let entries: WordEntry[] = [];
  let configError: string | null = null;
  const file = process.env.AE_MCP_PRIVACY_WORDS?.trim();
  if (file) {
    try {
      entries = parseWordList(readFileSync(file, "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "read error";
      configError = `the word list in AE_MCP_PRIVACY_WORDS (${path.basename(file)}) could not be read: ${code}`;
    }
  }
  const sorted = [...entries].sort((a, b) => b.word.length - a.word.length);
  const allowRaw = process.env.AE_MCP_PRIVACY_ALLOW_FIELDS ?? "";
  const known = new Set<string>(PRIVACY_REDACTED_FIELDS);
  const allowed = allowRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => known.has(s));
  session = {
    entries,
    wordRe:
      sorted.length > 0
        ? new RegExp(sorted.map((e) => escapeRegExp(e.word)).join("|"), "giu")
        : null,
    byLower: new Map(entries.map((e) => [e.word.toLowerCase(), e])),
    byLabel: new Map(entries.map((e) => [e.label, e])),
    spellings: new Map(),
    vault: new Map(),
    refs: new Map(),
    redacted: new Set(PRIVACY_REDACTED_FIELDS.filter((f) => !allowed.includes(f))),
    allowed,
    configError,
  };
  return session;
}

function hideWords(s: Session, text: string): string {
  if (!s.wordRe) return text;
  return text.replace(s.wordRe, (m) => {
    const entry =
      s.byLower.get(m.toLowerCase()) ??
      s.entries.find((e) => new RegExp(`^${escapeRegExp(e.word)}$`, "iu").test(m));
    if (!entry) return m;
    let seen = s.spellings.get(entry.label);
    if (!seen) s.spellings.set(entry.label, (seen = new Set()));
    seen.add(m);
    return entry.label;
  });
}

function restoreWords(s: Session, text: string): string {
  if (s.entries.length === 0) return text;
  return text.replace(/\[([\p{L}\p{N}_]+)-(\d+)\]/gu, (m, cat: string, n: string) => {
    const entry = s.byLabel.get(`[${cat.toUpperCase()}-${n}]`);
    if (!entry) return m;
    // The project's own spelling when it used just one ("ROSSI_Main"),
    // since comp and layer lookups are case-sensitive; else the file's.
    const seen = s.spellings.get(entry.label);
    return seen && seen.size === 1 ? [...seen][0]! : entry.word;
  });
}

interface Marker {
  redatto: true;
  lunghezza: number;
  rif: string;
}

function redact(s: Session, value: string): Marker {
  let ref = s.refs.get(value);
  if (!ref) {
    ref = `T${s.refs.size + 1}`;
    s.refs.set(value, ref);
    s.vault.set(ref, value);
  }
  return { redatto: true, lunghezza: value.length, rif: ref };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Inbound: labels and markers back to what they stand for

class UnknownMarker extends Error {}

function restoreValue(s: Session, value: unknown): unknown {
  if (typeof value === "string") return restoreWords(s, value);
  if (Array.isArray(value)) return value.map((v) => restoreValue(s, v));
  if (!isPlainObject(value)) return value;
  if (value.redatto === true) {
    const original = typeof value.rif === "string" ? s.vault.get(value.rif) : undefined;
    if (original === undefined) throw new UnknownMarker();
    return original;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[restoreWords(s, k)] = restoreValue(s, v);
  return out;
}

// ---------------------------------------------------------------------------
// Outbound: the filtered copy of a response

/** Dialog strings quoted elsewhere in the same response (DIALOG_OPEN messages). */
function collectDialogStrings(value: unknown, inDialog: boolean, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectDialogStrings(v, inDialog, out);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (inDialog && DIALOG_FIELDS.has(k) && typeof v === "string" && v.trim().length >= 3) {
      out.add(v);
      // describeDialogs() folds line breaks before quoting the text.
      out.add(v.replace(/\s*\n\s*/g, " "));
    }
    collectDialogStrings(v, k === "dialogs" || k === "dismissed" || inDialog, out);
  }
}

interface Pass {
  s: Session;
  scrub: string[];
}

function filterString(p: Pass, value: string, key: string | null): string {
  let out = value;
  for (const d of p.scrub) out = out.split(d).join(DIALOG_SCRUB);
  if (key !== null && PATH_FIELDS.has(key)) out = stripPathField(key, out);
  return hideWords(p.s, stripPaths(out));
}

function filterValue(p: Pass, value: unknown, key: string | null, inDialog: boolean): unknown {
  if (typeof value === "string") {
    if (key !== null && inDialog && DIALOG_FIELDS.has(key)) return redact(p.s, value);
    if (key !== null && p.s.redacted.has(key)) return redact(p.s, value);
    return filterString(p, value, key);
  }
  if (Array.isArray(value)) {
    // An array takes its field's rules: outputs[] are paths, items[] menu entries.
    return value.map((v) => filterValue(p, v, key, inDialog));
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const child = k === "dialogs" || k === "dismissed" || inDialog;
    out[filterString(p, k, null)] = filterValue(p, v, k, child);
  }
  return out;
}

/** The text errorResult() would have produced for this envelope. */
function errorTextOf(envelope: Record<string, unknown>): string | null {
  const e = envelope.error;
  if (envelope.ok !== false || !isPlainObject(e)) return null;
  if (typeof e.code !== "string" || typeof e.message !== "string") return null;
  const rebuilt = errorResult(e.code as AeErrorCode, e.message, {
    hint: typeof e.hint === "string" ? e.hint : undefined,
    details: isPlainObject(e.details) ? e.details : undefined,
    stack: typeof e.stack === "string" ? e.stack : null,
  });
  const first = rebuilt.content[0];
  return first?.type === "text" ? first.text : null;
}

function filterText(p: Pass, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(filterValue(p, parsed, null, false), null, text.includes("\n") ? 2 : 0);
    }
  } catch {
    // not JSON — fall through to the string rules
  }
  return filterString(p, text, null);
}

function privacyNote(s: Session): Record<string, unknown> {
  return {
    on: true,
    words: s.entries.length,
    redactedFields: [...s.redacted],
    allowedFields: s.allowed,
    rules: [
      "file paths are reduced to the file name",
      "labels like [CLIENTE-1] stand for words the user hides: use them as they are in arguments — the server puts the real word back before running",
      "redacted texts arrive as { redatto: true, lunghezza, rif }: you cannot read them; pass the object back unchanged to reuse the original text",
      "ae_project_export_json needs outPath; project.get_xmp and eval.run are off; image blocks are not sent",
    ],
  };
}

function sanitizeResult(toolName: string, result: ToolResult, s: Session): ToolResult {
  const scrubSet = new Set<string>();
  collectDialogStrings(result.structuredContent, false, scrubSet);
  const p: Pass = { s, scrub: [...scrubSet].sort((a, b) => b.length - a.length) };

  const original = result.structuredContent;
  let structured: Record<string, unknown> | undefined;
  if (original !== undefined) {
    structured = filterValue(p, original, null, false) as Record<string, unknown>;
    if (toolName === "ae_context" && structured.ok === true) structured.privacy = privacyNote(s);
  }

  const asJson = original !== undefined ? JSON.stringify(original, null, 2) : null;
  const asError = original !== undefined ? errorTextOf(original) : null;
  const content: ToolContent[] = [];
  let images = 0;
  for (const item of result.content) {
    if (item.type === "image") {
      images++;
      continue;
    }
    let text: string;
    if (structured !== undefined && item.text === asJson) {
      text = JSON.stringify(structured, null, 2);
    } else if (structured !== undefined && asError !== null && item.text === asError) {
      text = errorTextOf(structured) ?? filterText(p, item.text);
    } else {
      text = filterText(p, item.text);
    }
    content.push({ ...item, text });
  }
  if (images > 0) {
    content.push({
      type: "text",
      text:
        `[privacy] ${images} image block${images === 1 ? "" : "s"} withheld (AE_MCP_PRIVACY=1): ` +
        "the frames stay on disk at the paths listed above.",
    });
  }
  return {
    ...result,
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

// ---------------------------------------------------------------------------
// Policy hooks

/** Refusal for an operation that sends out too much in privacy mode. */
export function denyForPrivacy(opName: string): Denial | null {
  if (!privacyMode()) return null;
  if (opName === "project.get_xmp" || opName === "eval.run") {
    return {
      message: `operation '${opName}' is disabled while AE_MCP_PRIVACY=1 is set`,
      hint:
        opName === "eval.run"
          ? "Use a dedicated operation from ae_catalog."
          : "The XMP packet carries authors and history; ask the user to unset AE_MCP_PRIVACY if it is really needed.",
    };
  }
  return null;
}

/** Tool-level refusals, decided before anything reaches After Effects. */
function denyToolCall(toolName: string, args: unknown): ToolResult | null {
  if (toolName === "ae_project_export_json") {
    const outPath = isPlainObject(args) ? args.outPath : undefined;
    if (typeof outPath !== "string" || outPath.trim() === "") {
      return errorResult(
        "FORBIDDEN",
        "ae_project_export_json without outPath would return the whole project inline, which AE_MCP_PRIVACY=1 does not allow",
        {
          hint: "Pass outPath: the document is written to disk and only its file name and size come back.",
        },
      );
    }
  }
  return null;
}

/** Segment for policySummary(); null while privacy mode is off. */
export function privacySummary(): string | null {
  if (!privacyMode()) return null;
  const s = currentSession();
  if (s.configError) return "privacy=ON (word list UNREADABLE — every call is refused)";
  const parts = [`words=${s.entries.length}`, "paths=file name only"];
  parts.push(`redacted=${[...s.redacted].join("|") || "none"}`);
  if (s.allowed.length > 0) parts.push(`allowed=${s.allowed.join("|")}`);
  return `privacy=ON (${parts.join(", ")})`;
}

// ---------------------------------------------------------------------------
// The one entry point

/**
 * Runs one tool call under the privacy policy. With privacy off this is
 * exactly `run(args)`. With it on: refuse what may not run, restore labels and
 * redacted markers in the arguments, run, and filter the result.
 */
export async function guardToolCall(
  toolName: string,
  args: unknown,
  run: (args: unknown) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!privacyMode()) return run(args);
  const s = currentSession();
  if (s.configError) {
    return sanitizeResult(
      toolName,
      errorResult("FORBIDDEN", `privacy mode is on but ${s.configError}`, {
        hint: "Fix or unset AE_MCP_PRIVACY_WORDS and restart the server. Nothing runs until then, so no listed word can slip out.",
      }),
      s,
    );
  }
  const refused = denyToolCall(toolName, args);
  if (refused) return sanitizeResult(toolName, refused, s);

  let restored: unknown;
  try {
    restored = restoreValue(s, args);
  } catch (err) {
    if (!(err instanceof UnknownMarker)) throw err;
    return sanitizeResult(
      toolName,
      errorResult(
        "INVALID_ARGS",
        "an argument carries a redacted text ({ redatto: true }) this server cannot give back",
        {
          hint: "Pass the redacted object exactly as it was received (rif included), or write the text out.",
        },
      ),
      s,
    );
  }

  let result: ToolResult;
  try {
    result = await run(restored);
  } catch (err) {
    // Same envelope as the catch in src/index.ts, built here so that the
    // message and stack (which can carry paths) are filtered too.
    result = errorResult("TRANSPORT", err instanceof Error ? err.message : String(err), {
      details: { tool: toolName },
      stack: err instanceof Error ? (err.stack ?? null) : null,
    });
  }
  return sanitizeResult(toolName, result, s);
}
