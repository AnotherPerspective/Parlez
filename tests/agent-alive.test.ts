// The agent keeps itself alive (Parlez! 0.2). On After Effects 26.5 /
// Windows (2026-11-14/15) opening a project, Import File and other modal
// windows made After Effects drop every pending app.scheduleTask of the
// session at once, silently: the agent stopped for good, and the only way back
// was a script run by hand. jsx/agent.jsx now runs as a chain of one-shot
// steps with a generation, and watch()/revive() start a new chain - from the
// panel's timer, from a click, from a second evaluation of the file.
//
// The shim's dropAllTasks() is what After Effects did; runPending() is time
// passing. Staleness is set by moving the agent's last step back, so no test
// waits on the clock.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_JSX, PAUSE_SETTINGS_KEY, PAUSE_SETTINGS_SECTION } from "../src/config.js";
import { EsFile, type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";

interface RecentEntry {
  t: number;
  label: string;
  title: string;
  outcome: string;
  ms: number;
  undoable: boolean;
}

interface AgentState {
  id: string;
  gen: number;
  ticks: number;
  served: number;
  busy: boolean;
  stopped: boolean;
  dir: string | null;
  lastTickAt: number;
  lastReviveAt: number;
  lastHeartbeatAt: number;
  lastError: string | null;
  restarts: number;
  historyPath: string | null;
  recent: RecentEntry[];
}

interface Agent {
  state: AgentState;
  tick: () => void;
  step: (gen: number) => void;
  watch: (source: string) => boolean;
  revive: (source: string, force?: boolean) => boolean;
  stop: () => void;
}

let tmp: string;
let mailbox: string;
let engine: EsEngine;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-alive-"));
  mailbox = path.join(tmp, "runtime").replace(/\\/g, "/");
  engine = makeEngine(tmp);
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, "1");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const AGENT_SRC = loadJsx(AGENT_JSX, ["serve.jsx"]);

function loadAgent(id: string | null = "shotA"): Agent {
  engine.global.AE_MCP_AGENT_MAILBOX = mailbox;
  if (id !== null) engine.env.AE_MCP_INSTANCE = id;
  engine.run(AGENT_SRC);
  return engine.global.AE_MCP_AGENT as Agent;
}

const isStep = (code: string) => code.includes("AE_MCP_AGENT.step(");
const steps = () => engine.app.pendingTasks().filter((t) => isStep(t.code));

/** As if the agent had not stepped for `ms`. */
function silence(agent: Agent, ms = 5000) {
  agent.state.lastTickAt = Date.now() - ms;
  agent.state.lastReviveAt = 0;
}

function heartbeat(agent: Agent): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(agent.state.dir!, "heartbeat.json"), "utf8"));
}

function historyText(): string {
  const dir = path.join(tmp, "userData", "Parlez", "storico");
  return readdirSync(dir)
    .map((name) => readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}

describe("a chain of one-shot steps, never a repeating task", () => {
  it("books one step of 250 ms, and each step books exactly the next one", () => {
    loadAgent();
    expect(engine.app.tasks.some((t) => t.repeat)).toBe(false);
    expect(steps()).toHaveLength(1);
    expect(steps()[0].delay).toBe(250);
    for (let i = 0; i < 5; i++) {
      expect(engine.runPending(isStep)).toBe(1);
      expect(steps()).toHaveLength(1);
    }
    expect(engine.app.tasks.some((t) => t.repeat)).toBe(false);
  });

  it("a step of an older chain ends on arrival: never two chains", () => {
    const agent = loadAgent();
    const old = steps()[0];
    expect(agent.revive("prova", true)).toBe(true);
    // After Effects runs the old step anyway (cancelTask came too late).
    old.cancelled = false;
    engine.runPending(isStep);
    expect(steps()).toHaveLength(1);
    for (let i = 0; i < 4; i++) engine.runPending(isStep);
    expect(steps()).toHaveLength(1);
  });

  it("revived many times in a row, still one chain", () => {
    const agent = loadAgent();
    for (let i = 0; i < 6; i++) agent.revive("prova", true);
    for (const t of engine.app.tasks) if (isStep(t.code) && !t.done) t.cancelled = false;
    engine.runPending(isStep);
    expect(steps()).toHaveLength(1);
  });

  it("an exception inside a step does not end the chain", () => {
    const agent = loadAgent();
    // The very object the agent closed over (serve.jsx exports it on $.global).
    (engine.global.AE_MCP as { isPaused: () => boolean }).isPaused = () => {
      throw new Error("boom");
    };
    engine.runPending(isStep);
    expect(agent.state.lastError).toMatch(/boom/);
    expect(steps()).toHaveLength(1);
  });
});

describe("watch(): back after After Effects drops every task", () => {
  it("does nothing while the agent steps", () => {
    const agent = loadAgent();
    engine.runPending(isStep);
    expect(agent.watch("pannello")).toBe(false);
    expect(steps()).toHaveLength(1);
  });

  it("revives a silent agent, which says so once it has really stepped", () => {
    const agent = loadAgent();
    engine.runPending(isStep);
    engine.app.dropAllTasks();
    silence(agent, 12_000);
    expect(steps()).toHaveLength(0);

    expect(agent.watch("pannello")).toBe(true);
    expect(steps()).toHaveLength(1);
    // Announced by the first step, not by the attempt.
    expect(agent.state.recent.some((e) => e.outcome === "restart")).toBe(false);
    engine.runPending(isStep);

    const restart = agent.state.recent[agent.state.recent.length - 1];
    expect(restart.outcome).toBe("restart");
    expect(restart.title).toBe("Agente riavviato dopo una finestra di dialogo");
    expect(restart.undoable).toBe(false);
    expect(restart.ms).toBeGreaterThanOrEqual(12_000);
    expect(agent.state.restarts).toBe(1);
    expect(heartbeat(agent)).toMatchObject({ restarts: 1 });
    expect((heartbeat(agent).lastRestart as { source: string }).source).toBe("pannello");
    expect(historyText()).toMatch(
      /\| Agente riavviato dopo una finestra di dialogo \| riavvio \| ripartito \| 1\d s/,
    );
    // And it goes on.
    engine.runPending(isStep);
    expect(steps()).toHaveLength(1);
  });

  it("names the project that opened, or the one that closed", () => {
    const agent = loadAgent();
    engine.app.project.file = new EsFile(path.join(tmp, "vecchio.aep"));
    agent.state.lastHeartbeatAt = 0;
    engine.runPending(isStep);
    engine.app.dropAllTasks();
    silence(agent);
    agent.watch("pannello");
    engine.app.project.file = new EsFile(path.join(tmp, "nuovo.aep"));
    engine.runPending(isStep);
    expect(agent.state.recent[agent.state.recent.length - 1].title).toBe(
      "Agente riavviato dopo apertura progetto",
    );

    agent.state.lastHeartbeatAt = 0;
    engine.runPending(isStep);
    engine.app.dropAllTasks();
    silence(agent);
    agent.watch("pannello");
    engine.app.project.file = null;
    engine.runPending(isStep);
    expect(agent.state.recent[agent.state.recent.length - 1].title).toBe(
      "Agente riavviato dopo chiusura progetto",
    );
  });

  it("several watchers in a row make one restart, announced once", () => {
    const agent = loadAgent();
    engine.app.dropAllTasks();
    silence(agent);
    expect(agent.watch("pannello")).toBe(true);
    // Right behind: the chain was booked a moment ago, give it time.
    expect(agent.watch("clic nel pannello")).toBe(false);
    expect(agent.watch("agente")).toBe(false);
    engine.runPending(isStep);
    expect(agent.state.recent.filter((e) => e.outcome === "restart")).toHaveLength(1);
    expect(agent.state.restarts).toBe(1);
  });

  it("keeps trying while After Effects refuses, and announces the silence from the first stop", () => {
    const agent = loadAgent();
    engine.app.dropAllTasks();
    silence(agent, 8000);
    engine.app.refuseTasks = true;
    expect(agent.watch("pannello")).toBe(false);
    expect(agent.state.lastError).toMatch(/scheduleTask: Cannot run a script while a modal dialog/);
    engine.app.refuseTasks = false;
    agent.state.lastReviveAt = 0;
    expect(agent.watch("pannello")).toBe(true);
    engine.runPending(isStep);
    const restart = agent.state.recent[agent.state.recent.length - 1];
    expect(restart.outcome).toBe("restart");
    expect(restart.ms).toBeGreaterThanOrEqual(8000);
  });

  it("never while a request runs, never after stop() unless forced", () => {
    const agent = loadAgent();
    silence(agent);
    agent.state.busy = true;
    expect(agent.watch("pannello")).toBe(false);
    expect(agent.revive("Riavvia", true)).toBe(false);
    agent.state.busy = false;

    agent.stop();
    expect(steps()).toHaveLength(0);
    silence(agent);
    expect(agent.watch("pannello")).toBe(false);
    expect(steps()).toHaveLength(0);
    expect(agent.revive("pulsante Riavvia", true)).toBe(true);
    expect(agent.state.stopped).toBe(false);
    engine.runPending(isStep);
    expect(steps()).toHaveLength(1);
  });

  it("looks at the panel's timer about once a second, through watch() only", () => {
    const agent = loadAgent();
    let watched = 0;
    engine.global.AE_MCP_PANEL = { watch: () => watched++ };
    (agent.state as unknown as { lastPanelWatchAt: number }).lastPanelWatchAt = 0;
    engine.runPending(isStep);
    engine.runPending(isStep);
    engine.runPending(isStep);
    expect(watched).toBe(1);
  });
});

describe("a second evaluation of agent.jsx (the stub run again, a script run by hand)", () => {
  it("leaves a live agent alone: same object, one chain", () => {
    const agent = loadAgent();
    engine.runPending(isStep);
    loadAgent();
    expect(engine.global.AE_MCP_AGENT).toBe(agent);
    expect(steps()).toHaveLength(1);
  });

  it("revives a silent one in place", () => {
    const agent = loadAgent();
    engine.app.dropAllTasks();
    silence(agent);
    loadAgent();
    expect(engine.global.AE_MCP_AGENT).toBe(agent);
    expect(steps()).toHaveLength(1);
    engine.runPending(isStep);
    expect((heartbeat(agent).lastRestart as { source: string }).source).toBe(
      "nuovo caricamento dello script di avvio",
    );
  });

  it("takes over from a silent agent of an earlier build, keeping its id, list and counters", () => {
    let stopped = 0;
    const earlier = {
      t: Date.now() - 60_000,
      label: "comp.list",
      title: "guarda le composizioni",
      outcome: "ok",
      ms: 120,
      undoable: false,
    };
    engine.global.AE_MCP_AGENT = {
      state: {
        id: "ae-old123",
        idSource: "random",
        agentVersion: 3,
        startedAt: 1000,
        served: 7,
        refused: 1,
        busy: false,
        recent: [earlier],
        lastHeartbeatAt: Date.now() - 30_000,
      },
      stop: () => stopped++,
    };
    const agent = loadAgent(null);
    expect(stopped).toBe(1);
    expect(agent.state.id).toBe("ae-old123");
    expect(agent.state.served).toBe(7);
    expect(agent.state.dir).toMatch(/instances\/ae-old123$/);
    expect(steps()).toHaveLength(1);
    engine.runPending(isStep);
    expect(agent.state.recent[0]).toEqual(earlier);
    const restart = agent.state.recent[agent.state.recent.length - 1];
    expect(restart.outcome).toBe("restart");
    expect(restart.ms).toBeGreaterThanOrEqual(30_000);
  });

  it("does not take over from an earlier build that is still beating, or busy", () => {
    const fresh = {
      state: { id: "ae-live01", busy: false, lastHeartbeatAt: Date.now() },
      stop: () => {},
    };
    engine.global.AE_MCP_AGENT = fresh;
    loadAgent(null);
    expect(engine.global.AE_MCP_AGENT).toBe(fresh);
    const busy = { state: { id: "ae-busy01", busy: true, lastHeartbeatAt: 0 }, stop: () => {} };
    engine.global.AE_MCP_AGENT = busy;
    loadAgent(null);
    expect(engine.global.AE_MCP_AGENT).toBe(busy);
    expect(steps()).toHaveLength(0);
  });
});
