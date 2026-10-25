// Checkpoint operations — restore points for the open project, as .aep copies.
//
// A checkpoint is a byte-for-byte copy of the project file, taken right after
// saving it, in a folder of its own (by default `_parlez-checkpoints` next to
// the project; AE_MCP_CHECKPOINT_DIR or `dir` move it). The names carry the
// project, a timestamp and an optional label, so the folder reads as a
// history: `shot__20261025-101500__before-grade.aep`.
//
// Everything here runs on the Node side (Operation.run): Node's filesystem
// does the copying, and After Effects is asked for exactly four things —
// where the project is, to save it, to close it, to open a file. Doing the
// copy in Node keeps it out of ExtendScript's File API and lets every path
// go through the same mailbox guard as the other tools that write files.
//
// Restore replaces the project file in place and reopens it, so the user
// keeps working on the file they know. It is ordered so that a failure at any
// step leaves a usable project open: the current state is checkpointed first,
// the chosen checkpoint is copied next to the project BEFORE anything is
// closed, and only then is the project closed and the copy renamed over it.
//
// Names (`checkpoint.*`, the folder, the environment variable, the
// before-restore label) are provisional — Anthony decides the final ones.

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rejectedOutputPath } from "../config.js";
import { jsxFail, jsxVal, registerOp } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";

/** Environment variable that moves the checkpoint folder (nome provvisorio). */
export const CHECKPOINT_DIR_ENV = "AE_MCP_CHECKPOINT_DIR";
/** Default folder, created next to the project (nome provvisorio). */
export const DEFAULT_CHECKPOINT_SUBDIR = "_parlez-checkpoints";
/** Label of the checkpoint restore takes of the state it is about to replace (nome provvisorio). */
export const BEFORE_RESTORE_LABEL = "prima-del-ripristino";

const MAX_LABEL_LENGTH = 60;
const MAX_COPY_INDEX = 999;

type Failure = { ok: false; error: string; errorCode?: string; hint?: string };

function fail(error: string, extra: { errorCode?: string; hint?: string } = {}): Failure {
  return { ok: false, error, ...extra };
}

function isFailure(v: unknown): v is Failure {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Forward slashes, like every other path this server reports. */
const slash = (p: string) => p.replace(/\\/g, "/");

function nodeOnly(name: string): string {
  return jsxFail(
    `${name} runs on the Node side (it copies project files) — call it as its own ae_do, not inside batch.run`,
  );
}

// --- Names -------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time as YYYYMMDD-HHMMSS — the clock the user reads. */
export function formatStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function stampToDisplay(stamp: string): string {
  return (
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`
  );
}

/**
 * A label safe to put in a file name: letters (any script), digits, '-' and
 * '_'. Separators, dots and parentheses go, so a label can neither leave the
 * folder nor be mistaken for the " (N)" suffix; runs of '_' collapse so it
 * never contains the '__' that separates the name's parts.
 */
export function sanitizeLabel(label: unknown): string {
  if (typeof label !== "string") return "";
  return label
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/_{2,}/g, "_")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/[-_]+$/g, "");
}

/** `<project>__<YYYYMMDD-HHMMSS>[__<label>][ (N)].aep` */
export function checkpointFileName(stem: string, date: Date, label: string, copy = 1): string {
  const clean = sanitizeLabel(label);
  return (
    `${stem}__${formatStamp(date)}` +
    (clean ? `__${clean}` : "") +
    (copy > 1 ? ` (${copy})` : "") +
    ".aep"
  );
}

export interface ParsedCheckpointName {
  project: string;
  stamp: string;
  label: string;
  copy: number;
}

const NAME_RE = /^(.+?)__(\d{8}-\d{6})(?:__([\p{L}\p{N}_-]+))?(?: \((\d+)\))?\.aep$/iu;

/**
 * Read a checkpoint file name back, or null when it is not one. With `stem`,
 * only checkpoints of that project match (case-insensitively — the file
 * systems AE runs on mostly are), which also handles project names that
 * themselves contain '__'.
 */
export function parseCheckpointName(fileName: string, stem?: string): ParsedCheckpointName | null {
  let project: string;
  let rest: string;
  if (stem !== undefined) {
    const prefix = `${stem}__`;
    if (fileName.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
    project = fileName.slice(0, stem.length);
    rest = fileName.slice(prefix.length);
    const m = /^(\d{8}-\d{6})(?:__([\p{L}\p{N}_-]+))?(?: \((\d+)\))?\.aep$/iu.exec(rest);
    if (!m) return null;
    return { project, stamp: m[1]!, label: m[2] ?? "", copy: m[3] ? Number(m[3]) : 1 };
  }
  const m = NAME_RE.exec(fileName);
  if (!m) return null;
  return { project: m[1]!, stamp: m[2]!, label: m[3] ?? "", copy: m[4] ? Number(m[4]) : 1 };
}

/** True when `projectFile` looks like a checkpoint opened directly. */
function isCheckpointFile(projectFile: string): boolean {
  return (
    parseCheckpointName(path.basename(projectFile)) !== null ||
    path.basename(path.dirname(projectFile)) === DEFAULT_CHECKPOINT_SUBDIR
  );
}

const stemOf = (projectFile: string) => path.basename(projectFile, path.extname(projectFile));

// --- Paths -------------------------------------------------------------------

/**
 * A path as the user (or the model) typed it: quotes from a copied Explorer /
 * Finder path stripped, `~` expanded, made absolute (relative ones against
 * `base`). On Windows `path` already accepts either slash.
 */
function normalizeUserPath(raw: string, base?: string): string {
  let p = raw.trim();
  if (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p[p.length - 1] === p[0]) {
    p = p.slice(1, -1).trim();
  }
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
  return base === undefined ? path.resolve(p) : path.resolve(base, p);
}

/** a and b name the same location (case-insensitively on Windows). */
const samePath = (a: string, b: string) => path.relative(a, b) === "";

function explicitDir(dirArg: unknown): string | null {
  if (typeof dirArg === "string" && dirArg.trim()) return dirArg;
  const env = process.env[CHECKPOINT_DIR_ENV]?.trim();
  return env ? env : null;
}

/**
 * Where checkpoints of `projectFile` live: `dir`, else the environment
 * variable, else `_parlez-checkpoints` next to the project. Never the mailbox.
 */
export function resolveCheckpointDir(
  projectFile: string | null,
  dirArg: unknown,
): { dir: string } | { error: string; errorCode: string } {
  const raw = explicitDir(dirArg);
  let dir: string;
  if (raw !== null) dir = normalizeUserPath(raw);
  else if (projectFile !== null) {
    dir = path.join(path.dirname(path.resolve(projectFile)), DEFAULT_CHECKPOINT_SUBDIR);
  } else {
    return {
      error:
        "Non so dove cercare i checkpoint: il progetto aperto non è mai stato salvato. " +
        "Salvalo prima, oppure indica la cartella con `dir`.",
      errorCode: "INVALID_ARGS",
    };
  }
  const rejected = rejectedOutputPath(dir);
  if (rejected) return { error: rejected, errorCode: "IO" };
  return { dir };
}

/**
 * The checkpoint file `arg` names inside `dir`: a bare file name, or a path
 * (relative ones resolve against `dir`). Anything that is not directly in
 * `dir`, is not a checkpoint name, or is not a plain file is refused — this
 * is what keeps restore and delete inside the folder.
 */
async function resolveCheckpointArg(
  dir: string,
  arg: string,
  stem: string | undefined,
): Promise<{ file: string; parsed: ParsedCheckpointName } | Failure> {
  const file = normalizeUserPath(arg, dir);
  if (!samePath(path.dirname(file), dir)) {
    return fail(
      `Il file indicato non è nella cartella dei checkpoint (${slash(dir)}): ${slash(file)}`,
      { errorCode: "INVALID_ARGS", hint: "Usa un nome o un percorso dato da checkpoint.list." },
    );
  }
  const parsed = parseCheckpointName(path.basename(file), stem);
  if (!parsed) {
    return fail(
      stem === undefined
        ? `«${path.basename(file)}» non è un checkpoint.`
        : `«${path.basename(file)}» non è un checkpoint del progetto «${stem}».`,
      { errorCode: "INVALID_ARGS", hint: "Usa un nome o un percorso dato da checkpoint.list." },
    );
  }
  // lstat, not stat: a link named like a checkpoint is not one of ours.
  const stat = await fs.lstat(file).catch(() => null);
  if (stat === null) {
    return fail(`Checkpoint non trovato: ${slash(file)}`, {
      errorCode: "IO",
      hint: "checkpoint.list mostra quelli disponibili.",
    });
  }
  if (!stat.isFile()) return fail(`Non è un file normale: ${slash(file)}`, { errorCode: "IO" });
  return { file, parsed };
}

// --- Copying -------------------------------------------------------------------

/**
 * Copy `src` into `dir` under a new checkpoint name. Never overwrites: the
 * copy is exclusive (COPYFILE_EXCL), and a name already taken — two
 * checkpoints in the same second — gets " (2)", " (3)"…
 */
export async function copyToNewCheckpoint(
  src: string,
  dir: string,
  stem: string,
  date: Date,
  label: string,
): Promise<{ path: string; sizeBytes: number }> {
  await fs.mkdir(dir, { recursive: true });
  for (let copy = 1; copy <= MAX_COPY_INDEX; copy++) {
    const dest = path.join(dir, checkpointFileName(stem, date, label, copy));
    try {
      await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    await verifySameSize(src, dest);
    return { path: dest, sizeBytes: (await fs.stat(dest)).size };
  }
  throw new Error(`too many checkpoints named ${checkpointFileName(stem, date, label)} in ${dir}`);
}

/** A copy that came out short is removed rather than kept as a "checkpoint". */
async function verifySameSize(src: string, dest: string): Promise<void> {
  const [a, b] = await Promise.all([fs.stat(src), fs.stat(dest)]);
  if (a.size !== b.size) {
    await fs.rm(dest, { force: true });
    throw new Error(`incomplete copy of ${slash(src)} (${b.size} of ${a.size} bytes)`);
  }
}

export interface CheckpointEntry {
  file: string;
  path: string;
  project: string;
  label: string;
  createdAt: string;
  sizeBytes: number;
}

/** The checkpoints in `dir` (of `stem` only, when given), newest first. */
async function listCheckpointFiles(dir: string, stem?: string): Promise<CheckpointEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: Array<{ entry: CheckpointEntry; stamp: string; born: number; copy: number }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const parsed = parseCheckpointName(e.name, stem);
    if (!parsed) continue;
    const full = path.join(dir, e.name);
    const stat = await fs.stat(full);
    found.push({
      entry: {
        file: e.name,
        path: slash(full),
        project: parsed.project,
        label: parsed.label,
        createdAt: stampToDisplay(parsed.stamp),
        sizeBytes: stat.size,
      },
      stamp: parsed.stamp,
      // Within one second the name cannot tell which came first; the copy's
      // creation time can (not mtime: copying keeps the project's).
      born: stat.birthtimeMs,
      copy: parsed.copy,
    });
  }
  // `found` is local, so sorting it in place is fine (the server's lib has no toSorted).
  found.sort((a, b) =>
    a.stamp !== b.stamp ? b.stamp.localeCompare(a.stamp) : b.born - a.born || b.copy - a.copy,
  );
  return found.map((f) => f.entry);
}

// --- After Effects calls -------------------------------------------------------
//
// Every input travels on one `var _arg = …;` line, encoded by jsxVal. The
// calls run outside an undo group: saving is not undoable, and closing or
// opening a project inside a group orphans it (see project.open). Dialogs
// stay suppressed — a project boundary is where missing-file alerts pop up.
// Messages coming back from ExtendScript are plain ASCII; the Italian ones
// are written here, on the Node side.

const FILE_OF_PROJECT = `(app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null)`;

async function aeCall(
  transport: AeTransport,
  label: string,
  arg: Record<string, unknown>,
  body: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | Failure> {
  const res = await transport.execute({
    label,
    code: `var _arg = ${jsxVal(arg)};\n${body}`,
    undoGroup: false,
    suppressDialogs: true,
    timeoutMs,
  });
  if (!res.ok) {
    return fail(`After Effects non ha risposto (${res.error ?? "errore sconosciuto"})`, {
      errorCode: res.errorCode ?? "TRANSPORT",
    });
  }
  const r = res.result;
  if (typeof r !== "object" || r === null) {
    return fail("risposta inattesa da After Effects", { errorCode: "OPERATION_FAILED" });
  }
  return r as Record<string, unknown>;
}

async function aeProjectFile(transport: AeTransport): Promise<{ file: string | null } | Failure> {
  const r = await aeCall(
    transport,
    "checkpoint.info",
    {},
    `return { ok: true, file: ${FILE_OF_PROJECT}, dirty: !!app.project.dirty };`,
    30_000,
  );
  if (isFailure(r)) return r;
  return { file: typeof r.file === "string" ? path.resolve(r.file) : null };
}

const NEVER_SAVED =
  "Il progetto aperto non è mai stato salvato, quindi non ha un file da copiare. " +
  "Salvalo prima (ae_save_project con `path`), oppure passa `saveAs` con il percorso completo " +
  "del file .aep da creare.";

/**
 * Save the open project — to its own file, or to `saveAs` when it has none.
 * Always saves (not only when AE reports changes): the checkpoint must match
 * what is on screen, and `dirty` is not worth betting the safety copy on.
 */
async function aeSave(
  transport: AeTransport,
  saveAs: string | null,
): Promise<{ file: string; savedAs: boolean } | Failure> {
  const r = await aeCall(
    transport,
    "checkpoint.save",
    { saveAs: saveAs === null ? null : slash(saveAs) },
    `
        if (!app.project.file) {
            if (_arg.saveAs === null) return { ok: false, neverSaved: true, error: "never saved" };
            app.project.save(new File(_arg.saveAs));
            if (!app.project.file) return { ok: false, error: "Save As did not produce a project file" };
            return { ok: true, file: ${FILE_OF_PROJECT}, savedAs: true };
        }
        if (_arg.saveAs !== null) return { ok: false, hasFile: true, error: "the project already has a file" };
        app.project.save();
        return { ok: true, file: ${FILE_OF_PROJECT}, savedAs: false };
    `,
    120_000,
  );
  if (isFailure(r)) {
    if ((r as { neverSaved?: unknown }).neverSaved === true) {
      return fail(NEVER_SAVED, { errorCode: "OPERATION_FAILED" });
    }
    return fail(`Salvataggio non riuscito: ${r.error}`, { errorCode: r.errorCode });
  }
  if (typeof r.file !== "string") return fail("risposta inattesa da After Effects al salvataggio");
  return { file: path.resolve(r.file), savedAs: r.savedAs === true };
}

/** Close the project — only if it is still `expected` (it may have changed since). */
async function aeClose(transport: AeTransport, expected: string): Promise<true | Failure> {
  const r = await aeCall(
    transport,
    "checkpoint.close",
    { expect: slash(expected) },
    `
        var _now = ${FILE_OF_PROJECT};
        if (_now === null || _now.toLowerCase() !== String(_arg.expect).toLowerCase()) {
            return { ok: false, error: "the open project is no longer the one being restored" };
        }
        app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        return { ok: true };
    `,
    60_000,
  );
  if (isFailure(r)) return r;
  return true;
}

async function aeOpen(
  transport: AeTransport,
  file: string,
): Promise<{ file: string; numItems: number | null } | Failure> {
  const r = await aeCall(
    transport,
    "checkpoint.open",
    { path: slash(file) },
    `
        var _file = new File(_arg.path);
        if (!_file.exists) return { ok: false, error: "file not found" };
        app.open(_file);
        return { ok: true, file: ${FILE_OF_PROJECT}, numItems: app.project.numItems };
    `,
    120_000,
  );
  if (isFailure(r)) return r;
  return {
    file: typeof r.file === "string" ? r.file : slash(file),
    numItems: typeof r.numItems === "number" ? r.numItems : null,
  };
}

// --- Shared steps ----------------------------------------------------------------

interface Snapshot {
  checkpoint: string;
  sizeBytes: number;
  createdAt: string;
  project: string;
}

/** Save the project, then copy its file into `dir` as a new checkpoint. */
async function saveAndCopy(
  transport: AeTransport,
  projectFile: string,
  dir: string,
  label: string,
): Promise<Snapshot | Failure> {
  const saved = await aeSave(transport, null);
  if (isFailure(saved)) return saved;
  if (!samePath(saved.file, projectFile)) {
    return fail(
      `Il progetto aperto è cambiato durante l'operazione (ora: ${slash(saved.file)}). Riprova.`,
    );
  }
  return copySnapshot(projectFile, dir, label);
}

async function copySnapshot(
  projectFile: string,
  dir: string,
  label: string,
): Promise<Snapshot | Failure> {
  const date = new Date();
  try {
    const cp = await copyToNewCheckpoint(projectFile, dir, stemOf(projectFile), date, label);
    return {
      checkpoint: cp.path,
      sizeBytes: cp.sizeBytes,
      createdAt: stampToDisplay(formatStamp(date)),
      project: projectFile,
    };
  } catch (err) {
    return fail(`Copia del checkpoint non riuscita: ${errText(err)}`, { errorCode: "IO" });
  }
}

const DIR_PARAM = {
  name: "dir",
  type: "string" as const,
  description:
    `Checkpoint folder. Default: $${CHECKPOINT_DIR_ENV} if set, else ${DEFAULT_CHECKPOINT_SUBDIR}/ next to ` +
    "the project. Never inside the server's IPC mailbox.",
  required: false,
};

// --- Operations -------------------------------------------------------------------

registerOp({
  name: "checkpoint.create",
  category: "checkpoint",
  description:
    "Make a restore point: SAVE the open project to its own .aep (this overwrites the project file " +
    "with the current state, like Ctrl+S), then copy that file to " +
    `<folder>/<project>__<YYYYMMDD-HHMMSS>__<name>.aep. Folder: \`dir\`, else $${CHECKPOINT_DIR_ENV}, ` +
    `else ${DEFAULT_CHECKPOINT_SUBDIR}/ next to the project. Never overwrites a checkpoint. Use it before ` +
    "any risky change. A project that was never saved is refused unless you pass `saveAs` (an absolute " +
    ".aep path the USER chose) — never pick a location yourself. Returns the checkpoint path, size, date.",
  params: [
    {
      name: "name",
      type: "string",
      description: "Short label for this checkpoint, e.g. 'before-grade' (optional).",
      required: false,
    },
    DIR_PARAM,
    {
      name: "saveAs",
      type: "string",
      description:
        "Only for a project that was never saved: absolute path of the new .aep to save it to first " +
        "(must not exist). Ask the user for it.",
      required: false,
    },
  ],
  toJsx: () => nodeOnly("checkpoint.create"),
  async run(args, transport) {
    const label = sanitizeLabel(args.name);

    // Input problems first, before After Effects is asked to do anything.
    if (explicitDir(args.dir) !== null) {
      const d = resolveCheckpointDir(null, args.dir);
      if ("error" in d) return fail(d.error, { errorCode: d.errorCode });
    }
    let saveAs: string | null = null;
    if (typeof args.saveAs === "string" && args.saveAs.trim()) {
      saveAs = normalizeUserPath(args.saveAs);
      if (path.extname(saveAs).toLowerCase() !== ".aep") {
        return fail(`saveAs deve essere un file .aep: ${slash(saveAs)}`, {
          errorCode: "INVALID_ARGS",
        });
      }
      const rejected = rejectedOutputPath(saveAs);
      if (rejected) return fail(rejected, { errorCode: "IO" });
      if (await exists(saveAs)) {
        return fail(`saveAs esiste già, non lo sovrascrivo: ${slash(saveAs)}`, {
          errorCode: "IO",
          hint: "Chiedi all'utente un percorso nuovo.",
        });
      }
    }

    const info = await aeProjectFile(transport);
    if (isFailure(info)) return info;

    let projectFile: string;
    let savedAs: string | null = null;
    if (info.file === null) {
      if (saveAs === null) return fail(NEVER_SAVED, { errorCode: "OPERATION_FAILED" });
      try {
        await fs.mkdir(path.dirname(saveAs), { recursive: true });
      } catch (err) {
        return fail(`Non riesco a creare la cartella di ${slash(saveAs)}: ${errText(err)}`, {
          errorCode: "IO",
        });
      }
      const saved = await aeSave(transport, saveAs);
      if (isFailure(saved)) return saved;
      projectFile = saved.file;
      savedAs = slash(saved.file);
    } else {
      if (saveAs !== null) {
        return fail(
          `Il progetto ha già un file (${slash(info.file)}): saveAs serve solo per un progetto mai salvato. ` +
            "Per salvarlo altrove usa ae_save_project con `path`.",
          { errorCode: "INVALID_ARGS" },
        );
      }
      projectFile = info.file;
    }

    const d = resolveCheckpointDir(projectFile, args.dir);
    if ("error" in d) return fail(d.error, { errorCode: d.errorCode });

    // Just saved by Save As, the file on disk is already current.
    const snap =
      savedAs !== null
        ? await copySnapshot(projectFile, d.dir, label)
        : await saveAndCopy(transport, projectFile, d.dir, label);
    if (isFailure(snap)) return snap;

    return {
      ok: true,
      path: slash(snap.checkpoint),
      file: path.basename(snap.checkpoint),
      dir: slash(d.dir),
      label,
      createdAt: snap.createdAt,
      sizeBytes: snap.sizeBytes,
      project: slash(projectFile),
      // Saving overwrote the project file with the current state — said
      // plainly, because that is a write to the user's file.
      savedOriginal: true,
      savedAs,
      ...(isCheckpointFile(projectFile)
        ? {
            warning:
              "Il progetto aperto sembra essere esso stesso un checkpoint: stai lavorando su una copia " +
              "nella cartella dei checkpoint, non sul progetto originale.",
          }
        : {}),
      message:
        `Progetto salvato in ${slash(projectFile)} e copiato nel checkpoint ` +
        `${path.basename(snap.checkpoint)}.`,
    };
  },
});

registerOp({
  name: "checkpoint.list",
  category: "checkpoint",
  description:
    "List the restore points (checkpoint.create) of the open project, newest first: file name, path, " +
    "label, date, size. With `dir`, list every checkpoint in that folder (all projects). Read-only.",
  params: [DIR_PARAM],
  readOnly: true,
  toJsx: () => nodeOnly("checkpoint.list"),
  async run(args, transport) {
    // A folder named by the caller is listed whole, without asking AE; the
    // default (or $AE_MCP_CHECKPOINT_DIR) is filtered to the open project.
    const dirGiven = typeof args.dir === "string" && args.dir.trim() !== "";
    let projectFile: string | null = null;
    if (!dirGiven) {
      const info = await aeProjectFile(transport);
      if (isFailure(info)) return info;
      projectFile = info.file;
      if (projectFile === null && explicitDir(undefined) === null) {
        return fail(
          "Il progetto aperto non è mai stato salvato, quindi non ha checkpoint. " +
            "Per vedere una cartella di checkpoint passa `dir`.",
          { errorCode: "OPERATION_FAILED" },
        );
      }
    }
    const d = resolveCheckpointDir(projectFile, args.dir);
    if ("error" in d) return fail(d.error, { errorCode: d.errorCode });
    const stem = projectFile === null ? undefined : stemOf(projectFile);
    let checkpoints: CheckpointEntry[];
    try {
      checkpoints = await listCheckpointFiles(d.dir, stem);
    } catch (err) {
      return fail(`Non riesco a leggere ${slash(d.dir)}: ${errText(err)}`, { errorCode: "IO" });
    }
    return {
      ok: true,
      dir: slash(d.dir),
      project: projectFile === null ? null : slash(projectFile),
      count: checkpoints.length,
      checkpoints,
    };
  },
});

registerOp({
  name: "checkpoint.restore",
  category: "checkpoint",
  description:
    "Go back to a restore point. REPLACES the open project's .aep with the chosen checkpoint and reopens " +
    "it, so the user keeps working on the same file. First makes a checkpoint of the current state " +
    `(label '${BEFORE_RESTORE_LABEL}', which saves the project), so nothing is lost and the restore can ` +
    "itself be undone the same way. The checkpoint is copied next to the project before anything is " +
    "closed: if a step fails, the project stays open. Requires confirm: true, passed only when the user " +
    "asked to go back. `checkpoint`: a file name or path from checkpoint.list.",
  params: [
    {
      name: "checkpoint",
      type: "string",
      description:
        "Checkpoint to restore: its file name or full path, as given by checkpoint.list.",
      required: true,
    },
    DIR_PARAM,
  ],
  // confirm: true is enforced by the general gate (confirm-policy.ts), which
  // also injects the `confirm` param: refused in ae_do / batch.run before run().
  toJsx: () => nodeOnly("checkpoint.restore"),
  async run(args, transport) {
    const chosen = typeof args.checkpoint === "string" ? args.checkpoint.trim() : "";
    if (!chosen) return fail("checkpoint mancante", { errorCode: "INVALID_ARGS" });
    if (explicitDir(args.dir) !== null) {
      const d = resolveCheckpointDir(null, args.dir);
      if ("error" in d) return fail(d.error, { errorCode: d.errorCode });
    }

    const info = await aeProjectFile(transport);
    if (isFailure(info)) return info;
    if (info.file === null) {
      return fail(
        "Il progetto aperto non è mai stato salvato: non c'è un file da riportare indietro.",
        { errorCode: "OPERATION_FAILED" },
      );
    }
    const projectFile = info.file;
    if (isCheckpointFile(projectFile)) {
      return fail(
        `Il progetto aperto è un file di checkpoint (${slash(projectFile)}), non il progetto originale. ` +
          "Apri il progetto originale e ripristina da lì.",
        { errorCode: "OPERATION_FAILED" },
      );
    }
    const d = resolveCheckpointDir(projectFile, args.dir);
    if ("error" in d) return fail(d.error, { errorCode: d.errorCode });
    const target = await resolveCheckpointArg(d.dir, chosen, stemOf(projectFile));
    if (isFailure(target)) return target;

    // 1. Keep what is open now. This saves the project to its file.
    const before = await saveAndCopy(transport, projectFile, d.dir, BEFORE_RESTORE_LABEL);
    if (isFailure(before)) {
      return fail(
        `Ripristino annullato: non sono riuscito a fare il checkpoint di sicurezza. ${before.error}`,
        { errorCode: before.errorCode },
      );
    }

    // 2. Copy the checkpoint next to the project, while the project is still
    //    open: if this fails, nothing has been closed or replaced.
    const temp = path.join(
      path.dirname(projectFile),
      `.${path.basename(projectFile)}.parlez-ripristino-${randomUUID().slice(0, 8)}.tmp`,
    );
    try {
      await fs.copyFile(target.file, temp, fsConstants.COPYFILE_EXCL);
      await verifySameSize(target.file, temp);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {});
      return fail(
        `Ripristino annullato: copia del checkpoint non riuscita (${errText(err)}). ` +
          `Il progetto è ancora aperto e il suo file non è stato sostituito (è stato solo salvato).`,
        { errorCode: "IO" },
      );
    }

    // 3. Close the project (already saved, and kept in step 1).
    const closed = await aeClose(transport, projectFile);
    if (isFailure(closed)) {
      await fs.rm(temp, { force: true }).catch(() => {});
      return fail(
        `Ripristino annullato: After Effects non ha chiuso il progetto (${closed.error}). ` +
          "Il file del progetto non è stato sostituito.",
        { errorCode: closed.errorCode },
      );
    }

    // 4. Put the checkpoint in place of the project file. Same folder, so a
    //    rename: the file is either the old one or the new one, never half.
    try {
      await renameWithRetry(temp, projectFile);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {});
      const reopened = await aeOpen(transport, projectFile);
      return {
        ...fail(
          `Ripristino non riuscito: non ho potuto sostituire il file (${errText(err)}). ` +
            (isFailure(reopened)
              ? `Il file originale è intatto ma After Effects non l'ha riaperto: aprilo a mano (${slash(projectFile)}).`
              : "Ho riaperto il progetto originale, intatto."),
          { errorCode: "IO" },
        ),
        openFile: isFailure(reopened) ? null : slash(projectFile),
        beforeRestoreCheckpoint: slash(before.checkpoint),
      };
    }

    // 5. Open it again.
    const opened = await aeOpen(transport, projectFile);
    if (isFailure(opened)) {
      return fail(
        `Il file è stato ripristinato, ma After Effects non è riuscito ad aprirlo (${opened.error}). ` +
          `Aprilo a mano: ${slash(projectFile)}`,
        { errorCode: opened.errorCode },
      );
    }

    return {
      ok: true,
      restoredFrom: slash(target.file),
      openFile: slash(projectFile),
      beforeRestoreCheckpoint: slash(before.checkpoint),
      savedOriginalFirst: true,
      numItems: opened.numItems,
      message:
        `Ripristinato «${path.basename(target.file)}». Il progetto aperto è di nuovo ` +
        `${slash(projectFile)}. Lo stato di prima è nel checkpoint ${path.basename(before.checkpoint)}.`,
    };
  },
});

registerOp({
  name: "checkpoint.delete",
  category: "checkpoint",
  description:
    "Delete ONE checkpoint file from the checkpoint folder. Refuses anything that is not a checkpoint " +
    "name directly inside that folder, and never touches the project file. Requires confirm: true, " +
    "passed only when the user asked for this deletion.",
  params: [
    {
      name: "checkpoint",
      type: "string",
      description: "Checkpoint to delete: its file name or full path, as given by checkpoint.list.",
      required: true,
    },
    DIR_PARAM,
  ],
  // confirm: true is enforced by the general gate (confirm-policy.ts).
  toJsx: () => nodeOnly("checkpoint.delete"),
  async run(args, transport) {
    const chosen = typeof args.checkpoint === "string" ? args.checkpoint.trim() : "";
    if (!chosen) return fail("checkpoint mancante", { errorCode: "INVALID_ARGS" });
    if (explicitDir(args.dir) !== null) {
      const d = resolveCheckpointDir(null, args.dir);
      if ("error" in d) return fail(d.error, { errorCode: d.errorCode });
    }

    // Asked even with an explicit `dir`: it is what proves the file is not
    // the project After Effects has open.
    const info = await aeProjectFile(transport);
    if (isFailure(info)) return info;
    const d = resolveCheckpointDir(info.file, args.dir);
    if ("error" in d) return fail(d.error, { errorCode: d.errorCode });
    const target = await resolveCheckpointArg(d.dir, chosen, undefined);
    if (isFailure(target)) return target;
    if (info.file !== null && samePath(target.file, info.file)) {
      return fail("Questo è il file del progetto aperto, non un checkpoint: non lo cancello.", {
        errorCode: "FORBIDDEN",
      });
    }
    try {
      await fs.unlink(target.file);
    } catch (err) {
      return fail(`Cancellazione non riuscita: ${errText(err)}`, { errorCode: "IO" });
    }
    return { ok: true, deleted: slash(target.file) };
  },
});

/**
 * On Windows a file just closed by After Effects can stay briefly held by an
 * antivirus or the search indexer, which makes the rename fail with
 * EPERM/EBUSY for a moment. Retry those a few times; anything else fails at once.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
