// Pure helpers for the aerender operations (aerender.ts): where aerender sits
// next to After Effects, how an output path is read, which files an output
// names, and how aerender's PROGRESS lines are read. No After Effects, no
// child processes — only the file system checks an output needs.
//
// Kept apart from aerender.ts so that confirm-policy.ts can ask "would this
// call overwrite something?" without importing the operation registry
// (which itself imports confirm-policy.ts).

import { existsSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Environment variable naming aerender directly (nome provvisorio). */
export const AERENDER_ENV = "AE_MCP_AERENDER";

/**
 * Where aerender may be, given the After Effects that resolveAfterFxPath()
 * found, in the order they are tried.
 *
 * Windows: `aerender.exe` sits next to `AfterFX.exe` in `Support Files`
 * (Adobe's documentation; same place malkawi uses).
 *
 * macOS: AE_MCP_EXE names the `.app` bundle. Adobe documents aerender "in
 * the After Effects application folder" — the folder that holds the bundle,
 * e.g. `/Applications/Adobe After Effects 2026/aerender` (malkawi uses this
 * too). Inside the bundle (`Contents/MacOS/aerender`) is tried second, as a
 * fallback nobody has confirmed. A path pointing inside the bundle (to the
 * executable) is walked back up to the `.app` first.
 */
export function aerenderCandidates(afterFx: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    const p = path.posix;
    const norm = afterFx.replace(/\\/g, "/").replace(/\/+$/, "");
    const idx = norm.toLowerCase().lastIndexOf(".app");
    const bundle = idx >= 0 ? norm.slice(0, idx + 4) : norm;
    if (!bundle.toLowerCase().endsWith(".app")) return [p.join(p.dirname(bundle), "aerender")];
    return [p.join(p.dirname(bundle), "aerender"), p.join(bundle, "Contents", "MacOS", "aerender")];
  }
  const w = path.win32;
  return [w.join(w.dirname(afterFx), "aerender.exe")];
}

/**
 * A path as the user (or the model) typed it: quotes from a copied Explorer /
 * Finder path stripped, `~` expanded, made absolute. Same reading as the
 * checkpoint operations.
 */
export function normalizeOutputPath(raw: string): string {
  let p = raw.trim();
  if (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p[p.length - 1] === p[0]) {
    p = p.slice(1, -1).trim();
  }
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * aerender writes an image sequence when the file name carries `[#…#]`
 * (`frame_[#####].png` → frame_00000.png, frame_00001.png, …). Returns a
 * regular expression for the file names such an output produces, or null
 * for a single-file output.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function sequencePattern(fileName: string): RegExp | null {
  const m = /^(.*)\[(#+)\](.*)$/.exec(fileName);
  if (!m) return null;
  return new RegExp(`^${escapeRe(m[1]!)}\\d{${m[2]!.length},}${escapeRe(m[3]!)}$`, "i");
}

export interface OutputFiles {
  /** Existing files the output names: the file itself, or the frames of a sequence. */
  files: string[];
  bytes: number;
  sequence: boolean;
}

/** The files that are already on disk under this output path. */
export function existingOutputFiles(output: string): OutputFiles {
  const pattern = sequencePattern(path.basename(output));
  if (pattern === null) {
    try {
      const st = statSync(output);
      return st.isFile()
        ? { files: [output], bytes: st.size, sequence: false }
        : { files: [], bytes: 0, sequence: false };
    } catch {
      return { files: [], bytes: 0, sequence: false };
    }
  }
  const dir = path.dirname(output);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => pattern.test(n));
  } catch {
    return { files: [], bytes: 0, sequence: true };
  }
  let bytes = 0;
  const files: string[] = [];
  for (const n of names) {
    const full = path.join(dir, n);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      bytes += st.size;
      files.push(full);
    } catch {
      // gone between readdir and stat: not there
    }
  }
  return { files, bytes, sequence: true };
}

/**
 * A single-file output that came out under another extension: same folder,
 * same name before the extension, written at or after `sinceMs`. Happens
 * when aerender uses an output module whose format does not match the
 * extension that was asked for (After Effects then picks the extension).
 * Not verified on a real aerender; harmless when it never happens.
 */
export function outputUnderOtherExtension(output: string, sinceMs: number): OutputFiles | null {
  if (sequencePattern(path.basename(output)) !== null) return null;
  const dir = path.dirname(output);
  const stem = path.basename(output, path.extname(output)).toLowerCase();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (n.toLowerCase() === path.basename(output).toLowerCase()) continue;
    const ext = path.extname(n);
    if (ext === "" || ext.toLowerCase() === ".log") continue;
    if (path.basename(n, ext).toLowerCase() !== stem) continue;
    const full = path.join(dir, n);
    try {
      const st = statSync(full);
      if (st.isFile() && st.mtimeMs >= sinceMs - 2000) {
        return { files: [full], bytes: st.size, sequence: false };
      }
    } catch {
      // gone: not there
    }
  }
  return null;
}

/**
 * The confirm rule of aerender.start (see confirm-policy.ts): the reason a
 * call needs confirm: true because its output already exists, or null.
 */
export function outputOverwriteReason(args: Record<string, unknown>): string | null {
  if (typeof args.output !== "string" || args.output.trim() === "") return null;
  const existing = existingOutputFiles(normalizeOutputPath(args.output));
  if (existing.files.length === 0) return null;
  return existing.sequence
    ? `sovrascrive ${existing.files.length} fotogrammi già presenti con lo stesso nome nella cartella di uscita`
    : `sovrascrive il file di uscita, che esiste già (${path.basename(existing.files[0]!)})`;
}

/** The log aerender's output is written to: `<output stem>.aerender.log`, next to the output. */
export function logPathFor(output: string): string {
  const base = path.basename(output);
  const stem = base
    .replace(/\[#+\]/g, "")
    .replace(/\.[^.]*$/, "")
    .replace(/[_\s.-]+$/, "");
  return path.join(path.dirname(output), `${stem || "render"}.aerender.log`);
}

// --- Progress -----------------------------------------------------------------
//
// What aerender prints on stdout, as far as the documentation and other
// projects show (NOT verified on a real aerender yet — M6 on AE 2026):
//
//   PROGRESS:  Duration: 0:00:10:00
//   PROGRESS:  Frame Rate: 25.00 (comp)
//   PROGRESS:  0:00:00:00 (1): 0 Seconds
//   PROGRESS:  0:00:00:01 (2): 1 Seconds
//   …
//   PROGRESS:  Total Time Elapsed: 12 Seconds
//
// The frame lines are the ones that matter: a time, the frame number in
// parentheses (counting from 1 in the render, per malkawi's reading) and the
// seconds that frame took. "Duration" and "Frame Rate" give the total. The
// time may be a timecode (H:MM:SS:FF, ';' before the frames when drop-frame)
// or plain frames, depending on the project's time display.

export interface ProgressInfo {
  /** Last frame number seen on a frame line. */
  frame: number | null;
  /** Total frames, from "Duration" × "Frame Rate" when both were printed. */
  totalFromLog: number | null;
  /** True once a line says the render finished. */
  finishedLine: boolean;
  /** Lines starting with an error marker (aerender ERROR / "error:"), newest last. */
  errors: string[];
}

/** Frames in a timecode (`H:MM:SS:FF`, `;` allowed) or a plain frame count. */
export function timecodeToFrames(tc: string, fps: number): number | null {
  const t = tc.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(\d+)[:;](\d{1,2})[:;](\d{1,2})[:;](\d{1,3})$/.exec(t);
  if (!m || !(fps > 0)) return null;
  const [h, mi, s, f] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return Math.round((h * 3600 + mi * 60 + s) * fps) + f;
}

const FRAME_LINE = /^PROGRESS:\s+(\S+)\s+\((\d+)\):/;
const DURATION_LINE = /^PROGRESS:\s+Duration:\s+(\S+)/i;
const RATE_LINE = /^PROGRESS:\s+Frame Rate:\s+([\d.]+)/i;
const FINISHED_LINE = /^PROGRESS:\s+.*(Render Finished|Finished composition)/i;
const ERROR_LINE = /^(aerender\s+)?error\b|^\s*\S*\s*error:/i;

/** Read everything the log says about progress. */
export function parseProgress(text: string): ProgressInfo {
  let frame: number | null = null;
  let duration: string | null = null;
  let rate: number | null = null;
  let finishedLine = false;
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fm = FRAME_LINE.exec(line);
    if (fm) {
      frame = Number(fm[2]);
      continue;
    }
    const dm = DURATION_LINE.exec(line);
    if (dm) duration = dm[1]!;
    const rm = RATE_LINE.exec(line);
    if (rm) rate = Number(rm[1]);
    if (FINISHED_LINE.test(line)) finishedLine = true;
    if (ERROR_LINE.test(line)) errors.push(line);
  }
  const totalFromLog = duration !== null && rate !== null ? timecodeToFrames(duration, rate) : null;
  return {
    frame,
    totalFromLog: totalFromLog && totalFromLog > 0 ? totalFromLog : null,
    finishedLine,
    errors,
  };
}

/** Last `n` non-empty lines of `text`. */
export function lastLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(Math.max(0, lines.length - n));
}

/** True when aerender can be found at `p` (a regular file). */
export function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}
