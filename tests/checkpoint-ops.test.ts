// The checkpoint.* operations, offline. A fake After Effects stands in for the
// transport: it keeps the "project in memory" as a string, writes it to the
// real .aep file on save and reads it back on open, so the copies made by the
// operations can be checked byte for byte in a temp folder. Nothing here
// talks to After Effects; the real round trip is tests/e2e/checkpoint.test.ts.

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUNTIME_DIR } from "../src/config.js";
import {
  BEFORE_RESTORE_LABEL,
  CHECKPOINT_DIR_ENV,
  DEFAULT_CHECKPOINT_SUBDIR,
  checkpointFileName,
  copyToNewCheckpoint,
  formatStamp,
  parseCheckpointName,
  resolveCheckpointDir,
  sanitizeLabel,
} from "../src/operations/checkpoint.js";
import "../src/operations/index.js";
import { validateOpArgs } from "../src/opschema.js";
import { denyOperation } from "../src/policy.js";
import { getOp } from "../src/registry.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";

// --- A fake After Effects -----------------------------------------------------

interface FakeAe extends AeTransport {
  calls: EvalRequest[];
  labels(): string[];
  state: {
    file: string | null;
    memory: string;
    dirty: boolean;
    /** Make one call (by label) fail at the transport level. */
    failLabel?: string;
    /** The close call answers "the project changed under us". */
    refuseClose?: boolean;
  };
}

/** The operations put every input on one `var _arg = {...};` line. */
function argOf(code: string): Record<string, unknown> {
  const m = /var _arg = (.*);\r?\n/.exec(code);
  if (!m) throw new Error(`no _arg line in:\n${code}`);
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

const slash = (p: string) => p.replace(/\\/g, "/");
const same = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase();

const ok = (result: unknown): EvalResult => ({
  ok: true,
  result,
  error: null,
  errorCode: null,
  stack: null,
  logs: [],
  durationMs: 0,
});

function fakeAe(initial: { file: string | null; memory: string; dirty?: boolean }): FakeAe {
  const calls: EvalRequest[] = [];
  const state: FakeAe["state"] = { dirty: false, ...initial };
  return {
    calls,
    state,
    labels: () => calls.map((c) => c.label ?? ""),
    async execute(req) {
      calls.push(req);
      if (req.label && req.label === state.failLabel) {
        return { ...ok(null), ok: false, error: "simulated timeout", errorCode: "TIMEOUT" };
      }
      const arg = argOf(req.code);
      switch (req.label) {
        case "checkpoint.info":
          return ok({ ok: true, file: state.file && slash(state.file), dirty: state.dirty });
        case "checkpoint.save": {
          const saveAs = typeof arg.saveAs === "string" ? arg.saveAs : null;
          if (state.file === null) {
            if (saveAs === null) return ok({ ok: false, neverSaved: true, error: "never saved" });
            state.file = saveAs;
            await fs.writeFile(state.file, state.memory);
            state.dirty = false;
            return ok({ ok: true, file: slash(state.file), saved: true, savedAs: true });
          }
          if (saveAs !== null) return ok({ ok: false, error: "already has a file" });
          await fs.writeFile(state.file, state.memory);
          state.dirty = false;
          return ok({ ok: true, file: slash(state.file), savedAs: false });
        }
        case "checkpoint.close": {
          const wanted = String(arg.expect);
          if (state.refuseClose || state.file === null || !same(state.file, wanted)) {
            return ok({ ok: false, error: "project changed" });
          }
          state.file = null;
          state.memory = "";
          return ok({ ok: true });
        }
        case "checkpoint.open": {
          const p = String(arg.path);
          state.memory = await fs.readFile(p, "utf8");
          state.file = p;
          state.dirty = false;
          return ok({ ok: true, file: slash(p), numItems: 1 });
        }
        default:
          throw new Error(`fake AE got an unexpected call: ${req.label}`);
      }
    },
  };
}

interface Res {
  ok: boolean;
  error?: string;
  errorCode?: string;
  [k: string]: unknown;
}

async function run(name: string, args: Record<string, unknown>, transport: AeTransport) {
  const op = getOp(name);
  if (!op?.run) throw new Error(`${name} is not a Node-side operation`);
  return (await op.run(args, transport)) as Res;
}

let tmp: string;
let projectFile: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-checkpoint-"));
  projectFile = path.join(tmp, "shot.aep");
  await fs.writeFile(projectFile, "A");
  savedEnv = process.env[CHECKPOINT_DIR_ENV];
  delete process.env[CHECKPOINT_DIR_ENV];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env[CHECKPOINT_DIR_ENV];
  else process.env[CHECKPOINT_DIR_ENV] = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

const defaultDir = () => path.join(tmp, DEFAULT_CHECKPOINT_SUBDIR);
const read = (p: string) => fs.readFile(p, "utf8");
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

// --- File names -----------------------------------------------------------------

describe("checkpoint file names", () => {
  const d = new Date(2026, 9, 25, 9, 5, 3);

  it("stamps local time as YYYYMMDD-HHMMSS", () => {
    expect(formatStamp(d)).toBe("20261025-090503");
  });

  it("is <project>__<stamp>__<label>.aep, the label part only when there is one", () => {
    expect(checkpointFileName("shot", d, "prima della modifica")).toBe(
      "shot__20261025-090503__prima-della-modifica.aep",
    );
    expect(checkpointFileName("shot", d, "")).toBe("shot__20261025-090503.aep");
    expect(checkpointFileName("shot", d, "x", 2)).toBe("shot__20261025-090503__x (2).aep");
    expect(checkpointFileName("shot", d, "", 3)).toBe("shot__20261025-090503 (3).aep");
  });

  it("cleans labels so they can never leave the folder or break the name", () => {
    expect(sanitizeLabel("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeLabel("C:\\Windows")).toBe("C-Windows");
    expect(sanitizeLabel("però è già")).toBe("però-è-già");
    expect(sanitizeLabel("a__b")).toBe("a_b");
    expect(sanitizeLabel("copia (2)")).toBe("copia-2");
    expect(sanitizeLabel(undefined)).toBe("");
    expect(sanitizeLabel("   ")).toBe("");
    expect(sanitizeLabel("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("parses back what it writes, including projects whose name has '__'", () => {
    const name = checkpointFileName("shot__w1", d, "prova", 2);
    expect(parseCheckpointName(name, "shot__w1")).toEqual({
      project: "shot__w1",
      stamp: "20261025-090503",
      label: "prova",
      copy: 2,
    });
    expect(parseCheckpointName(name)?.project).toBe("shot__w1");
    expect(parseCheckpointName("shot__20261025-090503.aep", "SHOT")?.label).toBe("");
  });

  it("recognises only checkpoint names, and only of the given project", () => {
    expect(parseCheckpointName("shot.aep")).toBeNull();
    expect(parseCheckpointName("shot__20261025-090503.txt")).toBeNull();
    expect(parseCheckpointName("shot__2026-10-25.aep")).toBeNull();
    expect(parseCheckpointName("other__20261025-090503.aep", "shot")).toBeNull();
  });

  it("never overwrites: a taken name gets a (2), (3)… suffix", async () => {
    const dir = path.join(tmp, "cps");
    await fs.mkdir(dir);
    const taken = path.join(dir, checkpointFileName("shot", d, "x"));
    await fs.writeFile(taken, "OLD");
    const second = await copyToNewCheckpoint(projectFile, dir, "shot", d, "x");
    const third = await copyToNewCheckpoint(projectFile, dir, "shot", d, "x");
    expect(path.basename(second.path)).toBe("shot__20261025-090503__x (2).aep");
    expect(path.basename(third.path)).toBe("shot__20261025-090503__x (3).aep");
    expect(await read(taken)).toBe("OLD");
    expect(second.sizeBytes).toBe(1);
  });
});

// --- Folder -----------------------------------------------------------------------

describe("checkpoint folder", () => {
  it("defaults to a subfolder next to the project", () => {
    expect(resolveCheckpointDir(projectFile, undefined)).toEqual({ dir: defaultDir() });
  });

  it("uses the environment variable over the default, and `dir` over both", () => {
    process.env[CHECKPOINT_DIR_ENV] = path.join(tmp, "from-env");
    expect(resolveCheckpointDir(projectFile, undefined)).toEqual({
      dir: path.join(tmp, "from-env"),
    });
    expect(resolveCheckpointDir(projectFile, path.join(tmp, "explicit"))).toEqual({
      dir: path.join(tmp, "explicit"),
    });
  });

  it("accepts either slash style and ~ for the home folder", () => {
    const mixed = `${tmp.replace(/\\/g, "/")}/a\\b`.replace(/\\/g, path.sep === "\\" ? "\\" : "/");
    expect(resolveCheckpointDir(projectFile, mixed)).toEqual({ dir: path.resolve(mixed) });
    expect(resolveCheckpointDir(projectFile, "~/cps")).toEqual({
      dir: path.join(os.homedir(), "cps"),
    });
  });

  it("refuses the IPC mailbox, from `dir` and from the environment", () => {
    const inMailbox = path.join(RUNTIME_DIR, "cps");
    expect(resolveCheckpointDir(projectFile, inMailbox)).toHaveProperty("error");
    process.env[CHECKPOINT_DIR_ENV] = inMailbox;
    expect(resolveCheckpointDir(projectFile, undefined)).toHaveProperty("error");
  });

  it("needs a project path or an explicit folder", () => {
    expect(resolveCheckpointDir(null, undefined)).toHaveProperty("error");
  });
});

// --- checkpoint.create ------------------------------------------------------------

describe("checkpoint.create", () => {
  it("saves a dirty project, then copies it into the folder", async () => {
    const ae = fakeAe({ file: projectFile, memory: "B", dirty: true });
    const res = await run("checkpoint.create", { name: "prima prova" }, ae);
    expect(res.ok).toBe(true);
    expect(res.savedOriginal).toBe(true);
    expect(await read(projectFile)).toBe("B");
    const cp = String(res.path);
    expect(cp).not.toContain("\\");
    expect(path.dirname(path.resolve(cp))).toBe(defaultDir());
    expect(path.basename(cp)).toMatch(/^shot__\d{8}-\d{6}__prima-prova( \(\d+\))?\.aep$/);
    expect(await read(cp)).toBe("B");
    expect(res.sizeBytes).toBe(1);
    expect(typeof res.createdAt).toBe("string");
  });

  it("saves even a project AE calls clean, and leaves the label out when there is none", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A2", dirty: false });
    const res = await run("checkpoint.create", {}, ae);
    expect(res.ok).toBe(true);
    expect(res.savedOriginal).toBe(true);
    expect(await read(projectFile)).toBe("A2");
    expect(path.basename(String(res.path))).toMatch(/^shot__\d{8}-\d{6}( \(\d+\))?\.aep$/);
  });

  it("refuses a project that was never saved, and picks no place for it", async () => {
    const ae = fakeAe({ file: null, memory: "X", dirty: true });
    const res = await run("checkpoint.create", {}, ae);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("mai stato salvato");
    expect(res.error).toContain("saveAs");
    expect(ae.state.file).toBeNull();
    expect((await fs.readdir(tmp)).toSorted()).toEqual(["shot.aep"]);
  });

  it("with saveAs, saves a never-saved project there first, then checkpoints it", async () => {
    const target = path.join(tmp, "nuovo", "nuovo.aep");
    const ae = fakeAe({ file: null, memory: "N", dirty: true });
    const res = await run("checkpoint.create", { saveAs: target }, ae);
    expect(res.ok).toBe(true);
    expect(res.savedAs).toBe(slash(target));
    expect(await read(target)).toBe("N");
    expect(path.dirname(path.resolve(String(res.path)))).toBe(
      path.join(tmp, "nuovo", DEFAULT_CHECKPOINT_SUBDIR),
    );
  });

  it("refuses a saveAs that exists, is not .aep, or sits in the mailbox — before contacting AE", async () => {
    const ae = fakeAe({ file: null, memory: "N", dirty: true });
    const existing = await run("checkpoint.create", { saveAs: projectFile }, ae);
    expect(existing.ok).toBe(false);
    expect(existing.error).toContain("esiste già");
    const notAep = await run("checkpoint.create", { saveAs: path.join(tmp, "x.txt") }, ae);
    expect(notAep.ok).toBe(false);
    const planted = path.join(RUNTIME_DIR, "planted.aep");
    const mailbox = await run("checkpoint.create", { saveAs: planted }, ae);
    expect(mailbox.ok).toBe(false);
    expect(mailbox.errorCode).toBe("IO");
    expect(await exists(planted)).toBe(false);
    expect(ae.calls).toHaveLength(0);
  });

  it("refuses saveAs for a project that already has a file (that would be a Save As)", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const res = await run("checkpoint.create", { saveAs: path.join(tmp, "other.aep") }, ae);
    expect(res.ok).toBe(false);
    expect(ae.state.file).toBe(projectFile);
    expect(await exists(path.join(tmp, "other.aep"))).toBe(false);
  });

  it("refuses a folder inside the mailbox without contacting AE or writing anything", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const dir = path.join(RUNTIME_DIR, "cps-test");
    const res = await run("checkpoint.create", { dir }, ae);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("IO");
    expect(ae.calls).toHaveLength(0);
    expect(await exists(dir)).toBe(false);
  });

  it("reports a transport failure as a failure", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    ae.state.failLabel = "checkpoint.save";
    const res = await run("checkpoint.create", {}, ae);
    expect(res.ok).toBe(false);
    expect(await exists(defaultDir())).toBe(false);
  });

  it("warns when the open project is itself a checkpoint file", async () => {
    await fs.mkdir(defaultDir());
    const cpFile = path.join(defaultDir(), "shot__20261025-090503.aep");
    await fs.writeFile(cpFile, "A");
    const ae = fakeAe({ file: cpFile, memory: "A" });
    const res = await run("checkpoint.create", { dir: defaultDir() }, ae);
    expect(res.ok).toBe(true);
    expect(String(res.warning)).toContain("checkpoint");
  });
});

// --- checkpoint.list ----------------------------------------------------------------

describe("checkpoint.list", () => {
  it("lists only this project's checkpoints, newest first, with label, date and size", async () => {
    const dir = defaultDir();
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "shot__20261025-090000__primo.aep"), "1");
    await fs.writeFile(path.join(dir, "shot__20261025-100000.aep"), "22");
    await fs.writeFile(path.join(dir, "shot__20261025-100000 (2).aep"), "333");
    await fs.writeFile(path.join(dir, "other__20261025-110000.aep"), "x");
    await fs.writeFile(path.join(dir, "note.txt"), "x");
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const res = await run("checkpoint.list", {}, ae);
    expect(res.ok).toBe(true);
    const list = res.checkpoints as Array<Record<string, unknown>>;
    expect(list.map((c) => c.file)).toEqual([
      "shot__20261025-100000 (2).aep",
      "shot__20261025-100000.aep",
      "shot__20261025-090000__primo.aep",
    ]);
    expect(list[2]).toMatchObject({ label: "primo", sizeBytes: 1, project: "shot" });
    expect(list[2]!.createdAt).toBe("2026-10-25 09:00:00");
    expect(String(list[0]!.path)).not.toContain("\\");
    expect(res.dir).toBe(slash(dir));
  });

  it("with `dir`, lists every checkpoint in that folder", async () => {
    const dir = path.join(tmp, "elsewhere");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "shot__20261025-090000.aep"), "1");
    await fs.writeFile(path.join(dir, "other__20261025-110000.aep"), "x");
    const res = await run("checkpoint.list", { dir }, fakeAe({ file: null, memory: "" }));
    expect(res.ok).toBe(true);
    expect((res.checkpoints as unknown[]).length).toBe(2);
  });

  it("is empty, not an error, when the folder does not exist yet", async () => {
    const res = await run("checkpoint.list", {}, fakeAe({ file: projectFile, memory: "A" }));
    expect(res.ok).toBe(true);
    expect(res.checkpoints).toEqual([]);
    expect(await exists(defaultDir())).toBe(false);
  });

  it("explains what to do for a never-saved project", async () => {
    const res = await run("checkpoint.list", {}, fakeAe({ file: null, memory: "" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("mai stato salvato");
  });
});

// --- checkpoint.restore ---------------------------------------------------------------

async function threeCheckpoints(ae: FakeAe): Promise<string[]> {
  const out: string[] = [];
  for (const [content, label] of [
    ["A", "uno"],
    ["B", "due"],
    ["C", "tre"],
  ] as const) {
    ae.state.memory = content;
    ae.state.dirty = true;
    const res = await run("checkpoint.create", { name: label }, ae);
    expect(res.ok, String(res.error)).toBe(true);
    out.push(String(res.path));
  }
  return out;
}

describe("checkpoint.restore", () => {
  it("refuses without confirm: true, before contacting AE", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    for (const args of [{ checkpoint: "x.aep" }, { checkpoint: "x.aep", confirm: false }]) {
      const res = await run("checkpoint.restore", args, ae);
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("FORBIDDEN");
      expect(res.error).toContain("confirm");
    }
    expect(ae.calls).toHaveLength(0);
    const schema = validateOpArgs(getOp("checkpoint.restore")!, { checkpoint: "x.aep" });
    expect(schema.ok, "missing confirm fails ae_do's schema check too").toBe(false);
  });

  it("creates, ruins, restores the second: the project file is the second again", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const [cp1, cp2, cp3] = await threeCheckpoints(ae);
    ae.state.memory = "ROVINATO";
    ae.state.dirty = true;

    const res = await run(
      "checkpoint.restore",
      { checkpoint: path.basename(cp2!), confirm: true },
      ae,
    );
    expect(res.ok, String(res.error)).toBe(true);

    // The original file now holds the second checkpoint, and AE has it open.
    expect(await read(projectFile)).toBe("B");
    expect(ae.state.memory).toBe("B");
    expect(same(ae.state.file!, projectFile)).toBe(true);
    expect(res.openFile).toBe(slash(projectFile));
    expect(res.restoredFrom).toBe(slash(cp2!));

    // The ruined state was kept in a "before restore" checkpoint first.
    const before = String(res.beforeRestoreCheckpoint);
    expect(path.basename(before)).toContain(`__${BEFORE_RESTORE_LABEL}`);
    expect(await read(before)).toBe("ROVINATO");

    // Every checkpoint is untouched, and no temp file is left behind.
    expect([await read(cp1!), await read(cp2!), await read(cp3!)]).toEqual(["A", "B", "C"]);
    expect((await fs.readdir(tmp)).toSorted()).toEqual([DEFAULT_CHECKPOINT_SUBDIR, "shot.aep"]);
    expect(ae.labels()).toContain("checkpoint.close");
  });

  it("accepts the full path listed by checkpoint.list", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const [cp1] = await threeCheckpoints(ae);
    const res = await run("checkpoint.restore", { checkpoint: cp1, confirm: true }, ae);
    expect(res.ok, String(res.error)).toBe(true);
    expect(await read(projectFile)).toBe("A");
  });

  it("refuses a checkpoint outside the folder, of another project, or missing — touching nothing", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A", dirty: true });
    await fs.mkdir(defaultDir());
    const outside = path.join(tmp, "shot__20261025-090000.aep");
    await fs.writeFile(outside, "Z");
    const other = path.join(defaultDir(), "other__20261025-090000.aep");
    await fs.writeFile(other, "Z");
    for (const checkpoint of [
      outside,
      path.join(defaultDir(), "..", "shot__20261025-090000.aep"),
      path.basename(other),
      "shot__20261025-235959.aep",
      "shot.aep",
    ]) {
      const res = await run("checkpoint.restore", { checkpoint, confirm: true }, ae);
      expect(res.ok, checkpoint).toBe(false);
    }
    // Only the read-only info call went out: nothing saved, nothing closed.
    expect(new Set(ae.labels())).toEqual(new Set(["checkpoint.info"]));
    expect(await read(projectFile)).toBe("A");
    expect(ae.state.dirty).toBe(true);
  });

  it("if copying the checkpoint fails, the original stays open and intact", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const [, cp2] = await threeCheckpoints(ae);
    ae.state.memory = "ROVINATO";
    ae.state.dirty = true;
    const realCopy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest, mode) => {
      if (String(dest).includes("parlez-ripristino")) throw new Error("disk full (simulated)");
      return realCopy(src, dest, mode);
    });
    const res = await run("checkpoint.restore", { checkpoint: cp2, confirm: true }, ae);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("disk full");
    expect(ae.labels()).not.toContain("checkpoint.close");
    expect(same(ae.state.file!, projectFile)).toBe(true);
    expect(ae.state.memory).toBe("ROVINATO");
    expect(await read(projectFile)).toBe("ROVINATO");
    expect((await fs.readdir(tmp)).toSorted()).toEqual([DEFAULT_CHECKPOINT_SUBDIR, "shot.aep"]);
  });

  it("if AE will not close the project, nothing is replaced and the temp copy is removed", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const [, cp2] = await threeCheckpoints(ae);
    ae.state.memory = "ROVINATO";
    ae.state.dirty = true;
    ae.state.refuseClose = true;
    const res = await run("checkpoint.restore", { checkpoint: cp2, confirm: true }, ae);
    expect(res.ok).toBe(false);
    expect(await read(projectFile)).toBe("ROVINATO");
    expect(same(ae.state.file!, projectFile)).toBe(true);
    expect((await fs.readdir(tmp)).toSorted()).toEqual([DEFAULT_CHECKPOINT_SUBDIR, "shot.aep"]);
  });

  it("if replacing the file fails, the untouched original is reopened", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const [, cp2] = await threeCheckpoints(ae);
    ae.state.memory = "ROVINATO";
    ae.state.dirty = true;
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("file locked (simulated)"));
    const res = await run("checkpoint.restore", { checkpoint: cp2, confirm: true }, ae);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("file locked");
    expect(res.openFile).toBe(slash(projectFile));
    expect(await read(projectFile)).toBe("ROVINATO");
    expect(same(ae.state.file!, projectFile)).toBe(true);
    expect(ae.state.memory).toBe("ROVINATO");
    expect((await fs.readdir(tmp)).toSorted()).toEqual([DEFAULT_CHECKPOINT_SUBDIR, "shot.aep"]);
  });

  it("refuses a project that was never saved, and one opened straight from a checkpoint", async () => {
    const unsaved = await run(
      "checkpoint.restore",
      { checkpoint: "shot__20261025-090000.aep", confirm: true },
      fakeAe({ file: null, memory: "X" }),
    );
    expect(unsaved.ok).toBe(false);
    expect(unsaved.error).toContain("mai stato salvato");

    await fs.mkdir(defaultDir());
    const cpFile = path.join(defaultDir(), "shot__20261025-090000.aep");
    await fs.writeFile(cpFile, "A");
    await fs.writeFile(path.join(defaultDir(), "shot__20261025-100000.aep"), "B");
    const ae = fakeAe({ file: cpFile, memory: "A" });
    const res = await run(
      "checkpoint.restore",
      { checkpoint: "shot__20261025-100000.aep", dir: defaultDir(), confirm: true },
      ae,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("checkpoint");
    expect(await read(cpFile)).toBe("A");
  });
});

// --- checkpoint.delete -----------------------------------------------------------------

describe("checkpoint.delete", () => {
  it("refuses without confirm: true", async () => {
    const ae = fakeAe({ file: projectFile, memory: "A" });
    const res = await run("checkpoint.delete", { checkpoint: "x.aep", confirm: false }, ae);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("FORBIDDEN");
    expect(ae.calls).toHaveLength(0);
  });

  it("deletes one checkpoint in the folder", async () => {
    await fs.mkdir(defaultDir());
    const cp = path.join(defaultDir(), "shot__20261025-090000.aep");
    await fs.writeFile(cp, "1");
    const res = await run(
      "checkpoint.delete",
      { checkpoint: path.basename(cp), confirm: true },
      fakeAe({ file: projectFile, memory: "A" }),
    );
    expect(res.ok, String(res.error)).toBe(true);
    expect(res.deleted).toBe(slash(cp));
    expect(await exists(cp)).toBe(false);
  });

  it("never deletes outside the folder, a non-checkpoint, or the project itself", async () => {
    await fs.mkdir(defaultDir());
    const outside = path.join(tmp, "shot__20261025-090000.aep");
    await fs.writeFile(outside, "1");
    const ae = fakeAe({ file: projectFile, memory: "A" });
    for (const args of [
      { checkpoint: outside },
      { checkpoint: path.join("..", "shot__20261025-090000.aep") },
      { checkpoint: "shot.aep", dir: tmp },
      { checkpoint: projectFile, dir: tmp },
    ]) {
      const res = await run("checkpoint.delete", { ...args, confirm: true }, ae);
      expect(res.ok, JSON.stringify(args)).toBe(false);
    }
    expect(await exists(outside)).toBe(true);
    expect(await exists(projectFile)).toBe(true);
  });
});

// --- Policy ---------------------------------------------------------------------------

describe("checkpoint.* and the capability policy", () => {
  const NAMES = ["checkpoint.create", "checkpoint.list", "checkpoint.restore", "checkpoint.delete"];

  it("are Node-side and refuse to be inlined into batch.run", () => {
    for (const name of NAMES) {
      const op = getOp(name)!;
      expect(op.category).toBe("checkpoint");
      expect(typeof op.run).toBe("function");
      expect(op.toJsx({})).toContain("Node side");
    }
  });

  it("only checkpoint.list survives AE_MCP_READONLY=1", () => {
    const prev = process.env.AE_MCP_READONLY;
    process.env.AE_MCP_READONLY = "1";
    try {
      expect(denyOperation(getOp("checkpoint.list")!)).toBeNull();
      for (const name of NAMES.filter((n) => n !== "checkpoint.list")) {
        expect(denyOperation(getOp(name)!), name).not.toBeNull();
      }
    } finally {
      if (prev === undefined) delete process.env.AE_MCP_READONLY;
      else process.env.AE_MCP_READONLY = prev;
    }
  });

  it("restore and delete declare a required confirm parameter", () => {
    for (const name of ["checkpoint.restore", "checkpoint.delete"]) {
      const confirm = getOp(name)!.params.find((p) => p.name === "confirm");
      expect(confirm?.required, name).toBe(true);
    }
  });
});
