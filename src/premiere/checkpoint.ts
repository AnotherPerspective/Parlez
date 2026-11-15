// Restore points for Premiere Pro projects.
//
// Before every pr_* call that may change the project, the project FILE as it
// was last saved is copied into a folder of its own - by default
// `_parlez-checkpoints` next to the project, the same folder and naming
// After Effects' checkpoints use (src/operations/checkpoint.ts);
// AE_MCP_CHECKPOINT_DIR moves it. Parlez! never saves over the user's
// project to make one: the copy is the last save, which is what "torna a
// prima" can reopen. Changes made since that save are taken back by the undo
// journal instead (PR.undoLast, jsx/premiere-helpers.jsx).
//
// A new copy is made only when the file differs from the newest copy, so a
// session of small edits on an unsaved project leaves one restore point, not
// hundreds.

import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";

import { CHECKPOINT_DIR_ENV, DEFAULT_CHECKPOINT_SUBDIR } from "../operations/checkpoint.js";

export interface PremiereCheckpoint {
  /** File name of the copy (never its folder: privacy). */
  file: string;
  /** False when the newest copy already matched the saved project. */
  created: boolean;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Letters, digits and dashes only, for the label part of a file name. */
function safeLabel(label: string): string {
  return label
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function checkpointDirFor(
  projectFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const custom = env[CHECKPOINT_DIR_ENV]?.trim();
  return custom
    ? path.resolve(custom)
    : path.join(path.dirname(projectFile), DEFAULT_CHECKPOINT_SUBDIR);
}

async function newestCopy(dir: string, stem: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const ours = names.filter((n) => n.startsWith(`${stem}__`) && n.endsWith(".prproj"));
  ours.sort();
  return ours.length > 0 ? path.join(dir, ours[ours.length - 1]!) : null;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}

/**
 * Copy the saved project into the checkpoint folder unless the newest copy
 * is already identical. Throws when the project cannot be read or the copy
 * cannot be written: the caller then refuses the change.
 */
export async function ensurePremiereCheckpoint(
  projectFile: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<PremiereCheckpoint> {
  if (!/\.prproj$/i.test(projectFile)) {
    throw new Error("il progetto aperto non è un file .prproj salvato");
  }
  const dir = checkpointDirFor(projectFile, env);
  const stem = path.basename(projectFile).replace(/\.prproj$/i, "");
  const newest = await newestCopy(dir, stem);
  if (newest !== null && (await sameBytes(newest, projectFile))) {
    return { file: path.basename(newest), created: false };
  }
  await fs.mkdir(dir, { recursive: true });
  const base = `${stem}__${stamp(now)}__${safeLabel(label) || "prima-di-claude"}`;
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? `${base}.prproj` : `${base}-${i}.prproj`;
    try {
      await fs.copyFile(projectFile, path.join(dir, name), fsConstants.COPYFILE_EXCL);
      return { file: name, created: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("troppi punti di ritorno con lo stesso nome");
}
