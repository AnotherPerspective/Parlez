// Fixes from the first real run on After Effects 26.5 / Windows (2026-10-25),
// offline. Two defects:
//
//   1. aerender loads Scripts/Startup too, so the resident agent started inside
//      the render engine: a second "instance" with one tick and no project, and
//      every unnamed call failed with "2 After Effects instances are live".
//   2. Calls that should have gone to the live agent fell back to the push path
//      (which does not deliver on that machine) and timed out after 60 s. The
//      heartbeat read at the start of a call can land in the instant the agent
//      replaces heartbeat.json (remove, then rename the .tmp over it), and a
//      missing file reads as "no agent".
//
// Heartbeats are written by hand. Transport tests always NAME their instance
// (a throwaway id in the real mailbox), so a real After Effects with the agent
// running on this machine can never receive anything from them.

import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_GRACE_MS,
  HEARTBEAT_FILENAME,
  HEARTBEAT_STALE_MS,
  NEVER_TICKED_MS,
  PULL_ONLY_ENV,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  instanceDirFor,
  pullOnlyMode,
} from "../src/config.js";
import { FileIpcTransport, type SpawnFn } from "../src/transport/FileIpcTransport.js";
import { setOsascriptRunner, setPowerShellRunner } from "../src/transport/dialogs.js";
import {
  isAlive,
  readInstance,
  recentlyAliveAgent,
  resolveTarget,
} from "../src/transport/instances.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The transport scans for dialogs on its failure paths; never reach the desktop.
let restoreRunners: Array<() => void> = [];
beforeAll(() => {
  restoreRunners = [setPowerShellRunner(async () => "[]"), setOsascriptRunner(async () => "[]")];
});
afterAll(() => restoreRunners.forEach((restore) => restore()));

let root: string;
const savedPullOnly = process.env[PULL_ONLY_ENV];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "parlez-agent-fix-"));
  delete process.env[PULL_ONLY_ENV];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedPullOnly === undefined) delete process.env[PULL_ONLY_ENV];
  else process.env[PULL_ONLY_ENV] = savedPullOnly;
});

function heartbeatBody(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    idSource: "random",
    agentVersion: 2,
    aeVersion: "26.5x89",
    project: null,
    projectName: null,
    busy: false,
    ticks: 40,
    ts: Date.now(),
    ...overrides,
  });
}

async function writeHeartbeat(
  base: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(base, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, HEARTBEAT_FILENAME), heartbeatBody(id, overrides), "utf8");
  return dir;
}

// --- 1. The agent inside aerender --------------------------------------------

describe("an agent that never ticked is not a live instance", () => {
  it("ignores a heartbeat that says renderEngine", () => {
    const now = Date.now();
    expect(isAlive({ id: "r", project: null, projectName: null, ts: now }, now)).toBe(true);
    expect(
      isAlive({ id: "r", project: null, projectName: null, renderEngine: true, ts: now }, now),
    ).toBe(false);
  });

  it("drops a one-tick heartbeat once the next one is overdue", () => {
    const now = Date.now();
    const hb = (ticks: number | undefined, age: number) => ({
      id: "x",
      project: null,
      projectName: null,
      ticks,
      ts: now - age,
    });
    // Fresh: a real agent's very first heartbeat looks exactly like this.
    expect(isAlive(hb(1, 300), now)).toBe(true);
    // The agent inside aerender: one tick, then silence.
    expect(isAlive(hb(1, NEVER_TICKED_MS + 100), now)).toBe(false);
    // A ticking agent stays live until the normal staleness limit.
    expect(isAlive(hb(30, NEVER_TICKED_MS + 100), now)).toBe(true);
    // Heartbeats from agents that predate `ticks` keep the old rule.
    expect(isAlive(hb(undefined, NEVER_TICKED_MS + 100), now)).toBe(true);
    // Busy is busy, whatever the count.
    expect(
      isAlive({ ...hb(1, NEVER_TICKED_MS + 100), busy: true, busySince: now - 4000 }, now),
    ).toBe(true);
  });

  it("the 2026-10-25 case: the real instance wins over the aerender one", async () => {
    await writeHeartbeat(root, "ae-fcdn8h", {
      project: "C:/prove/aerender-prova.aep",
      projectName: "aerender-prova.aep",
    });
    // As logged: {"id":"ae-xet7em","project":null,"numItems":0,"ticks":1,"served":0}
    await writeHeartbeat(root, "ae-xet7em", { ticks: 1, served: 0, numItems: 0 });
    const r = await resolveTarget(null, root);
    expect(r.mode, JSON.stringify(r)).toBe("pull");
    if (r.mode === "pull") expect(r.instance.id).toBe("ae-fcdn8h");
  });

  it("still refuses to guess between two instances that both tick", async () => {
    await writeHeartbeat(root, "shotA");
    await writeHeartbeat(root, "shotB");
    const r = await resolveTarget(null, root);
    expect(r.mode).toBe("error");
    if (r.mode === "error") expect(r.kind).toBe("ambiguous");
  });

  it("agent.jsx stays out of the render engine and out of our own aerender launches", () => {
    const src = readFileSync(path.join(import.meta.dirname, "..", "jsx", "agent.jsx"), "utf8");
    const guard = src.indexOf("app.isRenderEngine");
    const optOut = src.indexOf('$.getenv("AE_MCP_AGENT_DISABLE")');
    const install = src.indexOf("$.global.AE_MCP_AGENT = {");
    expect(guard).toBeGreaterThan(0);
    expect(optOut).toBeGreaterThan(0);
    // Both checks run before the poller is installed, not after.
    expect(guard).toBeLessThan(install);
    expect(optOut).toBeLessThan(install);
  });
});

// --- 2. Torn heartbeat reads ----------------------------------------------------

describe("a heartbeat caught mid-replace", () => {
  it("reads the .tmp when heartbeat.json is momentarily missing", async () => {
    const dir = path.join(root, "ae-mid");
    await fs.mkdir(dir, { recursive: true });
    // The agent's writeAtomic: tmp written and closed, old file removed, rename pending.
    await fs.writeFile(path.join(dir, `${HEARTBEAT_FILENAME}.tmp`), heartbeatBody("ae-mid"));
    const info = await readInstance(dir);
    expect(info.alive).toBe(true);
    expect(info.heartbeat?.id).toBe("ae-mid");
  });

  it("reads the .tmp when heartbeat.json is half-written", async () => {
    const dir = await writeHeartbeat(root, "ae-torn");
    await fs.writeFile(path.join(dir, HEARTBEAT_FILENAME), '{"id":"ae-torn","ts":17', "utf8");
    await fs.writeFile(path.join(dir, `${HEARTBEAT_FILENAME}.tmp`), heartbeatBody("ae-torn"));
    expect((await readInstance(dir)).alive).toBe(true);
  });

  it("picks up the file once the rename lands, a moment later", async () => {
    const dir = path.join(root, "ae-late");
    await fs.mkdir(dir, { recursive: true });
    const read = readInstance(dir);
    await fs.writeFile(path.join(dir, HEARTBEAT_FILENAME), heartbeatBody("ae-late"));
    // Either the first read or the retry sees it; what must not happen is a
    // missing file being taken as final when it reappears milliseconds later.
    const info = await read;
    expect(info.alive || (await readInstance(dir)).alive).toBe(true);
  });

  it("an old leftover .tmp does not bring a dead agent back", async () => {
    const dir = path.join(root, "ae-dead");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${HEARTBEAT_FILENAME}.tmp`),
      heartbeatBody("ae-dead", { ts: Date.now() - 10 * 60_000 }),
    );
    expect((await readInstance(dir)).alive).toBe(false);
  });
});

// --- 2. Grace before giving up on an agent that was just alive -------------------

describe("recentlyAliveAgent", () => {
  it("finds an agent that went quiet a moment ago", async () => {
    await writeHeartbeat(root, "ae-quiet", { ts: Date.now() - HEARTBEAT_STALE_MS - 500 });
    const r = await recentlyAliveAgent(null, root);
    expect(r?.id).toBe("ae-quiet");
  });

  it("ignores agents gone longer than the grace, render engines and one-tick agents", async () => {
    await writeHeartbeat(root, "ae-old", { ts: Date.now() - AGENT_GRACE_MS - 1000 });
    await writeHeartbeat(root, "ae-render", {
      renderEngine: true,
      ts: Date.now() - HEARTBEAT_STALE_MS - 500,
    });
    await writeHeartbeat(root, "ae-once", { ticks: 1, ts: Date.now() - HEARTBEAT_STALE_MS - 500 });
    expect(await recentlyAliveAgent(null, root)).toBeNull();
  });

  it("with a name, only the instance that name addresses counts", async () => {
    await writeHeartbeat(root, "shotA", { ts: Date.now() - HEARTBEAT_STALE_MS - 500 });
    expect((await recentlyAliveAgent("shotA", root))?.id).toBe("shotA");
    expect(await recentlyAliveAgent("shotB", root)).toBeNull();
  });

  it("nothing at all (the user who never installed the agent): no wait", async () => {
    expect(await recentlyAliveAgent(null, root)).toBeNull();
  });
});

// --- Transport: grace and pull-only, end to end ------------------------------------

function noSpawn(): { spawn: SpawnFn; calls: number } {
  const state = { calls: 0, spawn: undefined as unknown as SpawnFn };
  state.spawn = () => {
    state.calls++;
    throw new Error("the push path must not be used here");
  };
  return state;
}

/** Serve every request in `dir` once, then return how many were served. */
async function serveOnce(dir: string): Promise<number> {
  let served = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(REQUEST_PREFIX) || !name.endsWith(".json")) continue;
    const rid = name.slice(REQUEST_PREFIX.length, -".json".length);
    await fs.unlink(path.join(dir, name));
    const response = {
      id: rid,
      ok: true,
      phase: "execute",
      result: "served",
      error: null,
      stack: null,
      logs: [],
    };
    await fs.writeFile(path.join(dir, `${RESPONSE_PREFIX}${rid}.json`), JSON.stringify(response));
    served++;
  }
  return served;
}

/** A stand-in agent in the REAL mailbox, under a throwaway name. */
async function fakeAgent(overrides: Record<string, unknown> = {}) {
  const id = `t-fix-${randomUUID().slice(0, 8)}`;
  const dir = instanceDirFor(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, HEARTBEAT_FILENAME), heartbeatBody(id, overrides));
  let timer: NodeJS.Timeout | null = null;
  return {
    id,
    dir,
    /** Start beating and serving, as an agent that came back does. */
    resume() {
      timer = setInterval(() => {
        void fs
          .writeFile(path.join(dir, HEARTBEAT_FILENAME), heartbeatBody(id))
          .then(() => serveOnce(dir));
      }, 50);
    },
    async stop() {
      if (timer) clearInterval(timer);
      await sleep(80);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("the transport waits for an agent instead of giving up on it", () => {
  it("an agent quiet for a few seconds gets the call when it comes back — no push", async () => {
    const agent = await fakeAgent({ ts: Date.now() - HEARTBEAT_STALE_MS - 500 });
    const launcher = noSpawn();
    try {
      const transport = new FileIpcTransport({ instance: agent.id, spawn: launcher.spawn });
      setTimeout(() => agent.resume(), 700);
      const res = await transport.execute({ code: "return 1;", label: "grace", timeoutMs: 8_000 });
      expect(res.ok, res.error ?? "").toBe(true);
      expect(res.result).toBe("served");
      expect(launcher.calls).toBe(0);
    } finally {
      await agent.stop();
    }
  });

  it("an agent gone longer than the grace is reported at once, as before", async () => {
    const agent = await fakeAgent({ ts: Date.now() - AGENT_GRACE_MS - 5_000 });
    try {
      const started = Date.now();
      const res = await new FileIpcTransport({
        instance: agent.id,
        spawn: noSpawn().spawn,
      }).execute({ code: "return 1;", label: "gone", timeoutMs: 8_000 });
      expect(res.errorCode).toBe("NO_INSTANCE");
      expect(res.error).toContain("stopped ticking");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await agent.stop();
    }
  });
});

describe(`${PULL_ONLY_ENV}=1 (never the push path)`, () => {
  it("is read at call time", () => {
    expect(pullOnlyMode()).toBe(false);
    process.env[PULL_ONLY_ENV] = "1";
    expect(pullOnlyMode()).toBe(true);
  });

  it("waits for a named agent that is not there yet, then uses it", async () => {
    process.env[PULL_ONLY_ENV] = "1";
    const id = `t-fix-${randomUUID().slice(0, 8)}`;
    const dir = instanceDirFor(id);
    const launcher = noSpawn();
    let timer: NodeJS.Timeout | null = null;
    try {
      const transport = new FileIpcTransport({ instance: id, spawn: launcher.spawn });
      const call = transport.execute({ code: "return 1;", label: "late", timeoutMs: 8_000 });
      await sleep(600);
      // The agent registers under that name (After Effects finished starting).
      await fs.mkdir(dir, { recursive: true });
      timer = setInterval(() => {
        void fs
          .writeFile(path.join(dir, HEARTBEAT_FILENAME), heartbeatBody(id))
          .then(() => serveOnce(dir));
      }, 50);
      const res = await call;
      expect(res.ok, res.error ?? "").toBe(true);
      expect(launcher.calls).toBe(0);
    } finally {
      if (timer) clearInterval(timer);
      await sleep(80);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("gives up at the call's timeout with a clear message, never launching", async () => {
    process.env[PULL_ONLY_ENV] = "1";
    const launcher = noSpawn();
    const started = Date.now();
    const res = await new FileIpcTransport({
      instance: `t-fix-nobody-${randomUUID().slice(0, 6)}`,
      spawn: launcher.spawn,
    }).execute({ code: "return 1;", label: "nobody", timeoutMs: 900 });
    expect(res.errorCode).toBe("NO_INSTANCE");
    expect(res.error).toContain(PULL_ONLY_ENV);
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    expect(launcher.calls).toBe(0);
  });

  it("refuses a transport forced onto push, instead of pushing", async () => {
    process.env[PULL_ONLY_ENV] = "1";
    const launcher = noSpawn();
    const res = await new FileIpcTransport({ instance: null, spawn: launcher.spawn }).execute({
      code: "return 1;",
      label: "forced",
      timeoutMs: 900,
    });
    expect(res.errorCode).toBe("NO_INSTANCE");
    expect(res.error).toContain(PULL_ONLY_ENV);
    expect(launcher.calls).toBe(0);
  });
});
