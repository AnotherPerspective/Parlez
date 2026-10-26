// Background renders with aerender (aerender.* — names provisional), offline.
// A fake aerender (tests/fixtures/fake-aerender.mjs, a Node script) is
// injected in place of the real one, the way kumo injects `spawn` into its
// transport, and a fake transport answers the one question asked of After
// Effects. Nothing here starts After Effects or a real aerender.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RUNTIME_DIR } from "../src/config.js";
import {
  AERENDER_ENV,
  AERENDER_LAUNCH_ENV,
  aerenderLaunchMode,
  aerenderLaunchPlan,
  aerenderCandidates,
  existingOutputFiles,
  isFile,
  lastLines,
  logPathFor,
  normalizeOutputPath,
  outputOverwriteReason,
  parseProgress,
  sequencePattern,
  timecodeToFrames,
} from "../src/operations/aerender-paths.js";
import {
  resetAerenderJobsForTests,
  resetAerenderTemplateCacheForTests,
  setAerenderHooksForTests,
} from "../src/operations/aerender.js";
import "../src/operations/index.js";
import { guardToolCall, resetPrivacyForTests } from "../src/privacy.js";
import { getOp } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-aerender.mjs", import.meta.url));

/** The aerender arguments inside a shell-mode command line ("aerender" "a" "b"…). */
function shellArgsBack(args: string[]): string[] {
  const line = args[3]!.slice(1, -1);
  return [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).slice(1);
}

// ---------------------------------------------------------------------------
// Fixtures

let root: string;
// A Windows install played on any system (the CI runs on Linux): these
// paths exist only in the fake file system below, and the code under test
// builds the aerender candidate with Windows path rules because the hooks say
// "win32". Real files are used only where a test needs one (macOS layout,
// AE_MCP_AERENDER).
const SUPPORT = "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files";
const afterFx = `${SUPPORT}\\AfterFX.exe`;
const aerenderExe = `${SUPPORT}\\aerender.exe`;
const AERENDER_SLASHED =
  "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe";
const FAKE_FILES = new Set([AERENDER_SLASHED.toLowerCase()]);
/** A real file standing in for aerender when a test needs one on disk. */
let realAerender: string;
let outDir: string;

/** What the fake After Effects answers to aerender.prep. */
interface PrepAnswer {
  file: string | null;
  dirty: boolean;
  comp: Record<string, unknown>;
  sameName: number;
  outputTemplates: string[] | null;
  renderTemplates: string[] | null;
}

function prepAnswer(over: Partial<PrepAnswer> = {}): PrepAnswer {
  return {
    file: path.join(root, "progetti", "Spot.aep").replace(/\\/g, "/"),
    dirty: false,
    comp: {
      name: "Principale",
      id: 7,
      frameRate: 25,
      duration: 10,
      workAreaStart: 0,
      workAreaDuration: 0.2,
    },
    sameName: 1,
    outputTemplates: ["Lossless", "H.264 - Match Render Settings - 15 Mbps", "H.264 - Other"],
    renderTemplates: ["Best Settings", "Draft Settings"],
    ...over,
  };
}

interface FakeTransport extends AeTransport {
  calls: EvalRequest[];
}

function fakeAe(
  answer: PrepAnswer | { ok: false; noComp: true; error: string } = prepAnswer(),
): FakeTransport {
  const calls: EvalRequest[] = [];
  return {
    calls,
    async execute(req: EvalRequest): Promise<EvalResult> {
      calls.push(req);
      return {
        ok: true,
        result: "ok" in answer ? answer : { ok: true, ...answer },
        error: null,
        errorCode: null,
        stack: null,
        logs: [],
        durationMs: 0,
      };
    },
  };
}

interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  options: SpawnOptions;
}
let spawned: Spawned[] = [];
let fakeEnv: Record<string, string> = {};
let restoreHooks: (() => void) | null = null;

function installFake(platform: NodeJS.Platform = "win32", exe: () => string = () => afterFx): void {
  restoreHooks?.();
  restoreHooks = setAerenderHooksForTests({
    platform,
    afterFxPath: exe,
    fileExists: (p: string) => FAKE_FILES.has(p.replace(/\\/g, "/").toLowerCase()) || isFile(p),
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      spawned.push({ command, args, env: options.env, options });
      // Shell mode starts cmd.exe; the fake still runs as itself, with the
      // aerender arguments taken back out of the plan (tested separately).
      if (command === "cmd.exe") args = shellArgsBack(args);
      return nodeSpawn(process.execPath, [FAKE, ...args], {
        ...options,
        windowsVerbatimArguments: false,
        env: { ...process.env, ...fakeEnv },
      });
    },
  });
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "parlez-aerender-"));
  realAerender = path.join(root, "aerender-vero.exe");
  writeFileSync(realAerender, "");
  mkdirSync(path.join(root, "progetti"), { recursive: true });
  writeFileSync(path.join(root, "progetti", "Spot.aep"), "aep");
});

afterAll(() => {
  restoreHooks?.();
  rmSync(root, { recursive: true, force: true });
});

let caseNo = 0;
beforeEach(() => {
  caseNo += 1;
  outDir = path.join(root, `render-${caseNo}`);
  spawned = [];
  fakeEnv = {};
  resetAerenderJobsForTests();
  resetAerenderTemplateCacheForTests();
  installFake();
  delete process.env[AERENDER_ENV];
});

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
  delete process.env[AERENDER_LAUNCH_ENV];
  delete process.env.AE_MCP_PRIVACY;
  resetPrivacyForTests();
});

// ---------------------------------------------------------------------------
// Calling through ae_do, so the confirm gate and the policy are the real ones

interface DoRes {
  isError?: boolean;
  structuredContent?: {
    result?: Record<string, unknown>;
    error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  };
}

async function call(operation: string, args: Record<string, unknown>, t: AeTransport = fakeAe()) {
  return (await doTool.handler({ operation, args }, t)) as DoRes;
}
async function ok(operation: string, args: Record<string, unknown>, t?: AeTransport) {
  const res = await call(operation, args, t);
  expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
  return res.structuredContent!.result!;
}
async function refused(operation: string, args: Record<string, unknown>, t?: AeTransport) {
  const res = await call(operation, args, t);
  expect(res.isError, JSON.stringify(res.structuredContent)).toBe(true);
  return res.structuredContent!.error!;
}

/** Poll aerender.status until the render is no longer running. */
async function waitDone(id: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = await ok("aerender.status", { id });
    if (st.status !== "in corso") return st;
    if (Date.now() > until) throw new Error(`render ${id} still running: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Poll until `pred` holds on the status. */
async function waitFor(
  id: string,
  pred: (st: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = await ok("aerender.status", { id });
    if (pred(st)) return st;
    if (Date.now() > until) throw new Error(`condition never met: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const out = (name = "spot.mp4") => path.join(outDir, name);

// ---------------------------------------------------------------------------

describe("aerender paths and progress (pure)", () => {
  it("looks for aerender.exe next to AfterFX.exe on Windows", () => {
    expect(
      aerenderCandidates(
        "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe",
        "win32",
      ).map((p) => p.replace(/\\/g, "/")),
    ).toEqual(["C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe"]);
  });

  it("looks beside the .app bundle on macOS, then inside it", () => {
    const expected = [
      "/Applications/Adobe After Effects 2026/aerender",
      "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/aerender",
    ];
    const app = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app";
    expect(aerenderCandidates(app, "darwin")).toEqual(expected);
    expect(aerenderCandidates(`${app}/`, "darwin")).toEqual(expected);
    // A path to the executable inside the bundle is walked back up.
    expect(aerenderCandidates(`${app}/Contents/MacOS/After Effects`, "darwin")).toEqual(expected);
  });

  it("reads an output path the way a user types it", () => {
    expect(normalizeOutputPath(`"${root}/a b/x.mp4"`)).toBe(path.resolve(root, "a b", "x.mp4"));
    expect(normalizeOutputPath("~/x.mp4")).toBe(path.join(os.homedir(), "x.mp4"));
  });

  it("names the log after the output, next to it", () => {
    expect(logPathFor(path.join("R", "spot.mp4"))).toBe(path.join("R", "spot.aerender.log"));
    expect(logPathFor(path.join("R", "frame_[#####].png"))).toBe(
      path.join("R", "frame.aerender.log"),
    );
  });

  it("recognises image sequences", () => {
    const re = sequencePattern("frame_[#####].png")!;
    expect(re.test("frame_00012.png")).toBe(true);
    expect(re.test("frame_12.png")).toBe(false);
    expect(re.test("frame_00012.jpg")).toBe(false);
    expect(sequencePattern("spot.mp4")).toBeNull();
  });

  it("finds what an output already has on disk, and says when it would be overwritten", () => {
    const d = path.join(root, "existing");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "a.mp4"), "12345");
    writeFileSync(path.join(d, "f_0001.png"), "1");
    writeFileSync(path.join(d, "f_0002.png"), "22");
    expect(existingOutputFiles(path.join(d, "a.mp4"))).toMatchObject({ bytes: 5, sequence: false });
    expect(existingOutputFiles(path.join(d, "f_[####].png"))).toMatchObject({
      bytes: 3,
      sequence: true,
    });
    expect(existingOutputFiles(path.join(d, "none.mp4")).files).toEqual([]);
    expect(outputOverwriteReason({ output: path.join(d, "a.mp4") })).toMatch(
      /esiste già \(a\.mp4\)/,
    );
    expect(outputOverwriteReason({ output: path.join(d, "f_[####].png") })).toMatch(/2 fotogrammi/);
    expect(outputOverwriteReason({ output: path.join(d, "new.mp4") })).toBeNull();
    expect(outputOverwriteReason({})).toBeNull();
  });

  it.each([
    ["0:00:10:00", 25, 250],
    ["0:01:00:05", 25, 1505],
    ["0;00;01;10", 29.97, 40],
    ["1:00:00:00", 24, 86400],
    ["0120", 25, 120],
    ["nonsense", 25, null],
  ])("timecode %s at %d fps is %s frames", (tc, fps, frames) => {
    expect(timecodeToFrames(tc, fps)).toBe(frames);
  });

  it("reads frame, total, finish and errors from aerender's lines", () => {
    const log = [
      "aerender version 26.0",
      "PROGRESS:  Duration: 0:00:04:00",
      "PROGRESS:  Frame Rate: 25.00 (comp)",
      "PROGRESS:  0:00:00:00 (1): 0 Seconds",
      "PROGRESS:  0:00:00:01 (2): 1 Seconds",
      "aerender ERROR: something",
      "PROGRESS:  Render Finished",
    ].join("\r\n");
    expect(parseProgress(log)).toEqual({
      frame: 2,
      totalFromLog: 100,
      finishedLine: true,
      errors: ["aerender ERROR: something"],
    });
    expect(parseProgress("")).toEqual({
      frame: null,
      totalFromLog: null,
      finishedLine: false,
      errors: [],
    });
    expect(lastLines("a\n\nb\r\nc\n", 2)).toEqual(["b", "c"]);
  });
});

describe("aerender.info", () => {
  it("finds aerender.exe next to AfterFX.exe", async () => {
    const r = await ok("aerender.info", {});
    expect(r).toMatchObject({ found: true, source: "afterEffects", platform: "win32" });
    expect(r.path).toBe(AERENDER_SLASHED);
    expect(r.afterEffects).toBe(afterFx.replace(/\\/g, "/"));
  });

  it("finds aerender beside the .app on macOS", async () => {
    const appDir = path.join(root, "mac", "Adobe After Effects 2026");
    const app = path.join(appDir, "Adobe After Effects 2026.app");
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(appDir, "aerender"), "");
    installFake("darwin", () => app.replace(/\\/g, "/"));
    const r = await ok("aerender.info", {});
    expect(r.found).toBe(true);
    expect(r.path).toBe(path.join(appDir, "aerender").replace(/\\/g, "/"));
    expect(r.tried).toHaveLength(2);
  });

  it("reports every path tried when aerender is missing, and when After Effects is", async () => {
    installFake("win32", () => "C:\\nowhere\\AfterFX.exe");
    const r = await ok("aerender.info", {});
    expect(r.found).toBe(false);
    expect(r.tried).toEqual(["C:/nowhere/aerender.exe"]);
    installFake("win32", () => {
      throw new Error("Could not locate AfterFX.exe");
    });
    const r2 = await ok("aerender.info", {});
    expect(r2.found).toBe(false);
    expect(String(r2.message)).toContain("Could not locate AfterFX.exe");
  });

  it("takes AE_MCP_AERENDER first", async () => {
    process.env[AERENDER_ENV] = realAerender;
    installFake("win32", () => {
      throw new Error("not consulted");
    });
    const r = await ok("aerender.info", {});
    expect(r).toMatchObject({ found: true, source: "env" });
  });
});

describe("aerender.start refuses", () => {
  it("an output inside the IPC mailbox", async () => {
    const t = fakeAe();
    const e = await refused(
      "aerender.start",
      { comp: "Principale", output: path.join(RUNTIME_DIR, "x.mp4") },
      t,
    );
    expect(e.code).toBe("IO");
    expect(t.calls).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it("a missing output (schema) and an output without an extension", async () => {
    expect((await refused("aerender.start", { comp: "Principale" })).code).toBe("INVALID_ARGS");
    const e = await refused("aerender.start", {
      comp: "Principale",
      output: path.join(outDir, "senza"),
    });
    expect(e.message).toContain("estensione");
  });

  it("a project that was never saved", async () => {
    const e = await refused(
      "aerender.start",
      { comp: "Principale", output: out() },
      fakeAe(prepAnswer({ file: null })),
    );
    expect(e.message).toContain("mai stato salvato");
    expect(spawned).toHaveLength(0);
  });

  it("a project with unsaved changes, pointing at ae_save_project or checkpoint.create, without saving", async () => {
    const t = fakeAe(prepAnswer({ dirty: true }));
    const e = await refused("aerender.start", { comp: "Principale", output: out() }, t);
    expect(e.message).toContain("modifiche non salvate");
    expect(e.hint).toContain("ae_save_project");
    expect(e.hint).toContain("checkpoint.create");
    // The one call to AE is the read; nothing saves.
    expect(t.calls.map((c) => c.label)).toEqual(["aerender.prep"]);
    expect(t.calls[0]!.code).not.toMatch(/\.save\s*\(/);
    expect(spawned).toHaveLength(0);
  });

  it("a missing default template, listing the ones there are", async () => {
    const e = await refused(
      "aerender.start",
      { comp: "Principale", output: out() },
      fakeAe(prepAnswer({ outputTemplates: ["Lossless", "ProRes 422"] })),
    );
    expect(e.message).toContain("H.264");
    expect(e.message).toContain("Lossless | ProRes 422");
    expect(e.hint).toContain("render.list_templates");
  });

  it("an output template that does not exist, and a render template that does not", async () => {
    const e = await refused("aerender.start", {
      comp: "Principale",
      output: out(),
      OMtemplate: "Nope",
    });
    expect(e.message).toContain("Lossless | H.264");
    const e2 = await refused("aerender.start", {
      comp: "Principale",
      output: out(),
      RStemplate: "Nope",
    });
    expect(e2.message).toContain("Best Settings | Draft Settings");
  });

  it("an output that already exists, unless confirmed", async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(out(), "old");
    const t = fakeAe();
    const e = await refused("aerender.start", { comp: "Principale", output: out() }, t);
    expect(e.code).toBe("FORBIDDEN");
    expect(e.details?.confirmRequired).toBe(true);
    expect(e.message).toContain("esiste già");
    expect(t.calls).toHaveLength(0);
    const r = await ok("aerender.start", { comp: "Principale", output: out(), confirm: true });
    expect((await waitDone(String(r.id))).status).toBe("finito");
  });

  it("frame numbers that are not whole, or out of order", async () => {
    expect(
      (await refused("aerender.start", { comp: "Principale", output: out(), s: 1.5 })).message,
    ).toContain("intero");
    expect(
      (await refused("aerender.start", { comp: "Principale", output: out(), s: 10, e: 5 })).message,
    ).toContain("prima di s");
  });

  it("an unknown comp", async () => {
    const e = await refused(
      "aerender.start",
      { comp: "Missing", output: out() },
      fakeAe({ ok: false, noComp: true, error: "no comp matching Missing" }),
    );
    expect(e.message).toContain("Nessuna composizione");
  });

  it("when aerender cannot be found", async () => {
    installFake("win32", () => "C:\\nowhere\\AfterFX.exe");
    const e = await refused("aerender.start", { comp: "Principale", output: out() });
    expect(e.code).toBe("AE_NOT_FOUND");
    expect(e.message).toContain("nowhere");
  });
});

describe("aerender.start → status → done", () => {
  it("starts at once, then reports progress and a finished, non-empty output", async () => {
    fakeEnv = { FAKE_AERENDER_FRAMES: "5", FAKE_AERENDER_INTERVAL_MS: "20" };
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    expect(r).toMatchObject({
      status: "in corso",
      comp: "Principale",
      outputTemplate: "H.264 - Match Render Settings - 15 Mbps",
      expectedFrames: 5,
      log: path.join(outDir, "spot.aerender.log").replace(/\\/g, "/"),
    });
    expect(String(r.id)).toMatch(/^aer-\d+$/);
    // The command names aerender, the project and the output — nothing from the mailbox.
    const command = r.command as string[];
    expect(command[0]).toBe(AERENDER_SLASHED);
    expect(spawned[0]!.command).toBe(aerenderExe);
    expect(command.join(" ")).not.toContain(RUNTIME_DIR.replace(/\\/g, "/"));
    expect(spawned[0]!.args).toEqual([
      "-project",
      path.join(root, "progetti", "Spot.aep"),
      "-comp",
      "Principale",
      "-output",
      out(),
      "-OMtemplate",
      "H.264 - Match Render Settings - 15 Mbps",
    ]);
    // aerender loads Scripts/Startup like After Effects does: this keeps the
    // resident agent from registering the render engine as an instance.
    expect(spawned[0]!.env?.AE_MCP_AGENT_DISABLE).toBe("1");

    const done = await waitDone(String(r.id));
    expect(done).toMatchObject({
      status: "finito",
      frame: 5,
      totalFrames: 5,
      totalFrom: "log",
      percent: 100,
      exitCode: 0,
      outputExists: true,
    });
    expect(done.outputBytes).toBeGreaterThan(0);
    expect(done.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(done.warnings).toBeUndefined();
    const tail = done.logTail as string[];
    expect(tail.some((l) => l.includes("Render Finished"))).toBe(true);
    // The log is on disk next to the output, with our header and footer.
    const log = readFileSync(path.join(outDir, "spot.aerender.log"), "utf8");
    expect(log).toContain("=== Parlez! aerender");
    expect(log).toContain("PROGRESS:  0:00:00:04 (5)");
    await waitFor(String(r.id), () =>
      readFileSync(path.join(outDir, "spot.aerender.log"), "utf8").includes("uscito con codice 0"),
    );
  });

  it("shows a render in progress with frame and percentage", async () => {
    fakeEnv = {
      FAKE_AERENDER_FRAMES: "4",
      FAKE_AERENDER_INTERVAL_MS: "10",
      FAKE_AERENDER_HANG: "1",
    };
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    const st = await waitFor(String(r.id), (s) => s.frame === 4);
    expect(st).toMatchObject({ status: "in corso", totalFrames: 4, percent: 100 });
    expect(String(st.message)).toContain("fotogramma 4 di 4");
    await ok("aerender.cancel", { id: r.id });
    await waitFor(String(r.id), (s) => s.exitCode !== null || s.status === "fermato");
  });

  it("passes the optional flags as aerender spells them, and leaves the others out", async () => {
    const r = await ok("aerender.start", {
      comp: "Principale",
      output: out(),
      OMtemplate: "lossless",
      RStemplate: "Draft Settings",
      s: 0,
      e: 3,
      reuse: true,
      mfr: false,
      continueOnMissingFootage: true,
    });
    expect(r).toMatchObject({
      outputTemplate: "Lossless",
      renderTemplate: "Draft Settings",
      expectedFrames: 4,
    });
    expect(spawned[0]!.args.slice(6)).toEqual([
      "-OMtemplate",
      "Lossless",
      "-RStemplate",
      "Draft Settings",
      "-s",
      "0",
      "-e",
      "3",
      "-reuse",
      "-mfr",
      "OFF",
      "100",
      "-continueOnMissingFootage",
    ]);
    await waitDone(String(r.id));
    // continueOnMissingFootage is off unless asked for.
    const r2 = await ok("aerender.start", { comp: "Principale", output: out("b.mp4") });
    expect(spawned[1]!.args).not.toContain("-continueOnMissingFootage");
    await waitDone(String(r2.id));
  });

  it("warns about duplicate comp names", async () => {
    const r = await ok(
      "aerender.start",
      { comp: "Principale", output: out() },
      fakeAe(prepAnswer({ sameName: 2 })),
    );
    expect((r.warnings as string[])[0]).toContain("2 composizioni");
    await waitDone(String(r.id));
  });

  it("starts twice in a row on a clean project with an empty render queue (E2E 2026-10-26)", async () => {
    // A fake After Effects with state, modelled on AE 26.5: any change to
    // the render queue marks the project as modified, and a modified
    // project refuses the next start. The first version added and removed a
    // queue item to read the templates, and the second start failed.
    const state = { dirty: false, queue: 0 };
    const calls: EvalRequest[] = [];
    const stateful: AeTransport = {
      async execute(req: EvalRequest): Promise<EvalResult> {
        calls.push(req);
        if (/renderQueue\.items\.add\s*\(|\.remove\s*\(/.test(req.code)) state.dirty = true;
        return {
          ok: true,
          result: {
            ok: true,
            ...prepAnswer({ dirty: state.dirty, outputTemplates: null, renderTemplates: null }),
          },
          error: null,
          errorCode: null,
          stack: null,
          logs: [],
          durationMs: 0,
        };
      },
    };
    const a = await ok("aerender.start", { comp: "Principale", output: out("a.mp4") }, stateful);
    const b = await ok("aerender.start", { comp: "Principale", output: out("b.mp4") }, stateful);
    expect(state).toEqual({ dirty: false, queue: 0 });
    for (const c of calls) expect(c.code).not.toMatch(/items\.add\s*\(|\.remove\s*\(|\.save\s*\(/);
    // No list could be read without touching the queue: aerender picks its
    // default output module, and the response says so.
    expect(a.outputTemplate).toBeNull();
    expect(spawned[0]!.args).not.toContain("-OMtemplate");
    expect((a.warnings as string[]).join(" ")).toContain("modello di uscita predefinito");
    await waitDone(String(a.id));
    await waitDone(String(b.id));
  });

  it("remembers the templates read from a queue item for later calls with an empty queue", async () => {
    const first = await ok("aerender.start", { comp: "Principale", output: out("a.mp4") });
    expect(first.outputTemplate).toBe("H.264 - Match Render Settings - 15 Mbps");
    const later = await ok(
      "aerender.start",
      { comp: "Principale", output: out("b.mp4") },
      fakeAe(prepAnswer({ outputTemplates: null, renderTemplates: null })),
    );
    expect(later.outputTemplate).toBe("H.264 - Match Render Settings - 15 Mbps");
    expect(later.warnings).toBeUndefined();
    await waitDone(String(first.id));
    await waitDone(String(later.id));
  });

  it("finds the output under another extension when the template's format differs", async () => {
    fakeEnv = { FAKE_AERENDER_EXT: ".mov" };
    const r = await ok("aerender.start", { comp: "Principale", output: out("spot.mp4") });
    const st = await waitDone(String(r.id));
    expect(st).toMatchObject({ status: "finito", outputExists: true });
    expect(st.outputActual).toBe(out("spot.mov").replace(/\\/g, "/"));
    expect((st.warnings as string[])[0]).toContain("spot.mov");
  });

  it("asks After Effects only to read, with the comp encoded as a literal", async () => {
    const t = fakeAe();
    const evil = '"); app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); ("';
    const r = await ok("aerender.start", { comp: evil, output: out() }, t);
    const literal = JSON.stringify({ comp: evil });
    expect(t.calls[0]!.code).toContain(literal);
    // Outside that literal, the code neither saves nor closes anything.
    expect(t.calls[0]!.code.replace(literal, "")).not.toMatch(/\.save\s*\(|\.close\s*\(/);
    await waitDone(String(r.id));
  });
});

describe("aerender failures and cancel", () => {
  it("reports a non-zero exit as failed, with the log's last lines", async () => {
    fakeEnv = { FAKE_AERENDER_EXIT: "3" };
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    const st = await waitDone(String(r.id));
    expect(st).toMatchObject({ status: "fallito", exitCode: 3, outputExists: false });
    expect(String(st.message)).toContain("codice 3");
    expect((st.logTail as string[]).some((l) => l.includes("fake failure"))).toBe(true);
  });

  it("reports exit 0 without an output file as failed", async () => {
    fakeEnv = { FAKE_AERENDER_NO_OUTPUT: "1" };
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    const st = await waitDone(String(r.id));
    expect(st).toMatchObject({ status: "fallito", exitCode: 0 });
    expect(String(st.message)).toContain("non c'è");
  });

  it("puts aerender's own error first when it exits 0 without a file (AE 26.5, 2026-10-26)", async () => {
    fakeEnv = { FAKE_AERENDER_ENGINE_LOST: "1" };
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    const st = await waitDone(String(r.id));
    expect(st).toMatchObject({ status: "fallito", exitCode: 0, outputExists: false });
    expect(String(st.message)).toContain("An existing connection was forcibly closed");
  });

  it("stops a running render, keeps the partial file, and leaves an ended one alone", async () => {
    fakeEnv = {
      FAKE_AERENDER_FRAMES: "2",
      FAKE_AERENDER_INTERVAL_MS: "10",
      FAKE_AERENDER_HANG: "1",
    };
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    const id = String(r.id);
    await waitFor(id, (s) => s.frame === 2);
    const c = await ok("aerender.cancel", { id });
    expect(c.status).toBe("fermato");
    expect(String(c.message)).toContain("non è stato cancellato");
    // The process really ends.
    const st = await waitFor(
      id,
      (s) =>
        s.exitCode !== null ||
        readFileSync(path.join(outDir, "spot.aerender.log"), "utf8").includes("fermato ==="),
    );
    expect(st.status).toBe("fermato");
    expect(st.outputExists).toBe(true);
    expect(readFileSync(out(), "utf8")).toBe("partial");
    const again = await ok("aerender.cancel", { id });
    expect(String(again.message)).toContain("già terminato");
  });

  it("refuses an unknown id for status and cancel, naming the known ones", async () => {
    const e = await refused("aerender.status", { id: "aer-99" });
    expect(e.code).toBe("INVALID_ARGS");
    expect(e.message).toContain("Non ne conosco nessuno");
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    const e2 = await refused("aerender.cancel", { id: "aer-99" });
    expect(e2.message).toContain(String(r.id));
    await waitDone(String(r.id));
  });

  it("lists every render when no id is given", async () => {
    const a = await ok("aerender.start", { comp: "Principale", output: out("a.mp4") });
    const b = await ok("aerender.start", { comp: "Principale", output: out("b.mp4") });
    await waitDone(String(a.id));
    await waitDone(String(b.id));
    const all = await ok("aerender.status", {});
    expect(all.count).toBe(2);
    expect((all.renders as Array<{ id: string }>).map((x) => x.id)).toEqual([a.id, b.id]);
  });
});

describe("aerender under the policy", () => {
  it("keeps only info and status in AE_MCP_READONLY=1", async () => {
    process.env.AE_MCP_READONLY = "1";
    expect(getOp("aerender.info")!.readOnly).toBe(true);
    expect(getOp("aerender.status")!.readOnly).toBe(true);
    await ok("aerender.info", {});
    await ok("aerender.status", {});
    expect((await refused("aerender.start", { comp: "Principale", output: out() })).code).toBe(
      "FORBIDDEN",
    );
    expect((await refused("aerender.cancel", { id: "aer-1" })).code).toBe("FORBIDDEN");
    expect(spawned).toHaveLength(0);
  });

  it("cannot ride inside batch.run", () => {
    for (const name of ["aerender.info", "aerender.start", "aerender.status", "aerender.cancel"]) {
      expect(getOp(name)!.toJsx({})).toContain("Node side");
    }
  });

  it("in privacy mode, the log lines and paths that come back are reduced to file names", async () => {
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    await waitDone(String(r.id));
    process.env.AE_MCP_PRIVACY = "1";
    resetPrivacyForTests();
    const t = fakeAe();
    const res = await guardToolCall(
      "ae_do",
      { operation: "aerender.status", args: { id: r.id } },
      (a) => doTool.handler(a as never, t),
    );
    const text = JSON.stringify(res);
    const dirs = [outDir, outDir.replace(/\\/g, "/"), outDir.replace(/\\/g, "\\\\")];
    for (const d of dirs) expect(text).not.toContain(d);
    expect(text).toContain("spot.mp4");
    expect(text).toContain("Output To: spot.mp4");
  });
});

describe("how aerender is launched (AE 26.5 / Windows, 2026-10-26)", () => {
  // Detached, aerender lost its render engine; the same command from a shell
  // worked. Detached on Windows means no console at all (DETACHED_PROCESS);
  // attached with windowsHide means a console without a window. Hypothesis,
  // not verified: aerender needs a console to keep its engine.
  it("defaults to attached on Windows and detached elsewhere, and reads the variable", () => {
    expect(aerenderLaunchMode("win32", {})).toEqual({ mode: "attached", ignored: null });
    expect(aerenderLaunchMode("darwin", {})).toEqual({ mode: "detached", ignored: null });
    expect(aerenderLaunchMode("win32", { [AERENDER_LAUNCH_ENV]: " Shell " })).toEqual({
      mode: "shell",
      ignored: null,
    });
    expect(aerenderLaunchMode("win32", { [AERENDER_LAUNCH_ENV]: "detached" }).mode).toBe(
      "detached",
    );
    expect(aerenderLaunchMode("win32", { [AERENDER_LAUNCH_ENV]: "boh" })).toEqual({
      mode: "attached",
      ignored: "boh",
    });
  });

  it("plans each mode", () => {
    const exe = "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe";
    const argv = ["-comp", "Comp 1", "-OMtemplate", "H.264 - Match Render Settings - 15 Mbps"];
    expect(aerenderLaunchPlan("attached", exe, argv)).toEqual({
      command: exe,
      argv,
      detached: false,
      verbatim: false,
    });
    expect(aerenderLaunchPlan("detached", exe, argv)).toEqual({
      command: exe,
      argv,
      detached: true,
      verbatim: false,
    });
    expect(aerenderLaunchPlan("shell", exe, argv)).toEqual({
      command: "cmd.exe",
      argv: [
        "/d",
        "/s",
        "/c",
        `""${exe}" "-comp" "Comp 1" "-OMtemplate" "H.264 - Match Render Settings - 15 Mbps""`,
      ],
      detached: false,
      verbatim: true,
    });
  });

  it.each(['Comp "1"', "100% rosso", "riga\ndue"])(
    "shell mode refuses an argument cmd.exe would misread: %j",
    (bad) => {
      const plan = aerenderLaunchPlan("shell", "C:/a/aerender.exe", ["-comp", bad]);
      expect(plan).toHaveProperty("error");
    },
  );

  it("starts attached by default, with a hidden window and the agent kept out", async () => {
    const r = await ok("aerender.start", { comp: "Principale", output: out() });
    expect(r.launch).toBe("attached");
    expect(spawned[0]!.options).toMatchObject({ detached: false, windowsHide: true });
    expect(spawned[0]!.options.windowsVerbatimArguments).toBeUndefined();
    const st = await waitDone(String(r.id));
    expect(st).toMatchObject({ status: "finito", launch: "attached" });
    expect(readFileSync(path.join(outDir, "spot.aerender.log"), "utf8")).toContain(
      "avvio attached",
    );
  });

  it("switches strategy through AE_MCP_AERENDER_LAUNCH without rebuilding", async () => {
    process.env[AERENDER_LAUNCH_ENV] = "shell";
    const a = await ok("aerender.start", { comp: "Principale", output: out("a.mp4") });
    expect(a.launch).toBe("shell");
    expect(spawned[0]!.command).toBe("cmd.exe");
    expect(spawned[0]!.options).toMatchObject({ detached: false, windowsVerbatimArguments: true });
    expect((await waitDone(String(a.id))).status).toBe("finito");

    process.env[AERENDER_LAUNCH_ENV] = "detached";
    const b = await ok("aerender.start", { comp: "Principale", output: out("b.mp4") });
    expect(spawned[1]!.options).toMatchObject({ detached: true });
    await waitDone(String(b.id));

    process.env[AERENDER_LAUNCH_ENV] = "boh";
    const c = await ok("aerender.start", { comp: "Principale", output: out("c.mp4") });
    expect(c.launch).toBe("attached");
    expect((c.warnings as string[]).join(" ")).toContain("boh");
    await waitDone(String(c.id));
  });

  it("refuses, before writing anything, an argument shell mode cannot quote", async () => {
    process.env[AERENDER_LAUNCH_ENV] = "shell";
    const e = await refused(
      "aerender.start",
      { comp: "Principale", output: out() },
      fakeAe(prepAnswer({ comp: { ...prepAnswer().comp, name: "100% rosso" } })),
    );
    expect(e.message).toContain("100% rosso");
    expect(spawned).toHaveLength(0);
  });

  // The only test here that needs Windows itself: it runs the real cmd.exe.
  // Everything else plays Windows through the injected platform and paths.
  it.skipIf(process.platform !== "win32")(
    "shell mode, through the real cmd.exe: quoting, the log redirect and the exit code all hold",
    async () => {
      // node.exe stands in for aerender.exe; the fake is its first argument.
      const dir = path.join(root, "cmd vero");
      mkdirSync(dir, { recursive: true });
      const output = path.join(dir, "uscita con spazi.mp4");
      const plan = aerenderLaunchPlan("shell", process.execPath, [
        FAKE,
        "-comp",
        "Comp 1",
        "-output",
        output,
      ]);
      if ("error" in plan) throw new Error(plan.error);
      const logFile = path.join(dir, "log.txt");
      const fd = openSync(logFile, "w");
      const code = await new Promise<number | null>((resolve) => {
        const child = nodeSpawn(plan.command, plan.argv, {
          windowsHide: true,
          windowsVerbatimArguments: plan.verbatim,
          stdio: ["ignore", fd, fd],
          env: { ...process.env, FAKE_AERENDER_FRAMES: "2", FAKE_AERENDER_EXIT: "0" },
        });
        child.on("exit", resolve);
      });
      closeSync(fd);
      expect(code).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("fake video bytes");
      const log = readFileSync(logFile, "utf8");
      expect(log).toContain('Starting composition "Comp 1"');
      expect(log).toContain("PROGRESS:  0:00:00:01 (2)");
    },
  );
});
