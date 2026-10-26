// The Parlez! panel's switches, on the After Effects side: jsx/agent.jsx and
// the shared jsx/serve.jsx run unchanged inside the ExtendScript stand-in
// (helpers/extendscript-shim.ts), against a throwaway mailbox and a
// throwaway user-data folder. The switches are the app.settings entries the
// panel writes; nothing here needs After Effects.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_JSX,
  PAUSE_SETTINGS_KEY,
  PAUSE_SETTINGS_SECTION,
  READ_ONLY_SETTINGS_KEY,
} from "../src/config.js";
import { EsFile, type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";

const SERVE_JSX = fileURLToPath(new URL("../jsx/serve.jsx", import.meta.url));

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
  served: number;
  refused: number;
  paused: boolean;
  readOnly: boolean;
  pending: number;
  busy: boolean;
  agentVersion: number;
  dir: string | null;
  historyPath: string | null;
  recent: RecentEntry[];
}

let tmp: string;
let mailbox: string;
let engine: EsEngine;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-pause-"));
  mailbox = path.join(tmp, "runtime").replace(/\\/g, "/");
  engine = makeEngine(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function startAgent(id = "shotA") {
  engine.global.AE_MCP_AGENT_MAILBOX = mailbox;
  engine.env.AE_MCP_INSTANCE = id;
  engine.run(loadJsx(AGENT_JSX, ["serve.jsx"]));
  const agent = engine.global.AE_MCP_AGENT as { state: AgentState; tick: () => void };
  expect(agent, "agent.jsx did not register itself").toBeTruthy();
  return agent;
}

function setEnabled(value: string) {
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, value);
}

function setReadOnly(value: "1" | "0") {
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, READ_ONLY_SETTINGS_KEY, value);
}

function instanceDir(id = "shotA") {
  return path.join(mailbox, "instances", id);
}

function heartbeat(id = "shotA"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(instanceDir(id), "heartbeat.json"), "utf8"));
}

/** Drop a request whose code bumps app.ran, so we can tell whether it executed. */
function putRequest(
  reqId: string,
  id = "shotA",
  extra: { label?: string; title?: string; mutates?: boolean; undoGroup?: boolean } = {},
) {
  const body: Record<string, unknown> = {
    id: reqId,
    label: "probe",
    code: "app.ran = (app.ran || 0) + 1; return 42;",
    payload: null,
    undoGroup: true,
    suppressDialogs: true,
    ...extra,
  };
  writeFileSync(path.join(instanceDir(id), `request-${reqId}.json`), JSON.stringify(body), "utf8");
}

function response(reqId: string, id = "shotA"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(instanceDir(id), `response-${reqId}.json`), "utf8"));
}

function ran(): number {
  return (engine.app as unknown as { ran?: number }).ran ?? 0;
}

describe('the one rule: only "1" means Claude may work (the 2026-10-25 defect)', () => {
  it("no choice saved yet → paused: the first heartbeat says so and nothing runs", () => {
    const agent = startAgent();
    expect(heartbeat().paused).toBe(true);
    putRequest("r1");
    agent.tick();
    expect(response("r1")).toMatchObject({ ok: false, paused: true });
    expect(ran()).toBe(0);
    // The agent does not write a choice: that is the panel's, and the user's.
    expect(engine.app.settings.peek(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY)).toBeUndefined();
  });

  it('"1" → active', () => {
    setEnabled("1");
    const agent = startAgent();
    expect(heartbeat().paused).toBe(false);
    putRequest("r1");
    agent.tick();
    expect(response("r1")).toMatchObject({ id: "r1", ok: true, result: 42 });
    expect(ran()).toBe(1);
    expect(agent.state.served).toBe(1);
  });

  it('"0", or anything that is not exactly "1", → paused', () => {
    startAgent();
    const shared = engine.global.AE_MCP as { isPaused: () => boolean };
    for (const value of ["0", "yes", "true", " 1", ""]) {
      setEnabled(value);
      expect(shared.isPaused(), JSON.stringify(value)).toBe(true);
    }
  });

  it("is exported once, on $.global, for the panel to call", () => {
    startAgent();
    const shared = engine.global.AE_MCP as { isEnabled: () => boolean; isPaused: () => boolean };
    expect(shared.isEnabled()).toBe(false);
    setEnabled("1");
    expect(shared.isEnabled()).toBe(true);
    expect(shared.isPaused()).toBe(false);
  });

  it("announces agent version 3", () => {
    const agent = startAgent();
    expect(agent.state.agentVersion).toBe(3);
    expect(heartbeat().agentVersion).toBe(3);
  });
});

describe("agent.jsx with Claude stopped", () => {
  it("does not run the request, answers it as paused, and keeps the heartbeat going", () => {
    setEnabled("0");
    const agent = startAgent();
    putRequest("r1");
    agent.tick();

    expect(ran()).toBe(0);
    expect(engine.app.undoGroups).toBe(0);
    const res = response("r1");
    expect(res).toMatchObject({ id: "r1", ok: false, phase: "dispatch", paused: true });
    expect(String(res.error)).toContain("pausa");
    // Consumed, so it cannot run later when the switch goes back on.
    expect(existsSync(path.join(instanceDir(), "request-r1.json"))).toBe(false);
    expect(agent.state.served).toBe(0);
    expect(agent.state.refused).toBe(1);
    expect(heartbeat().refused).toBe(1);
  });

  it("follows the switch on the next tick, without restarting", () => {
    setEnabled("0");
    const agent = startAgent();

    setEnabled("1");
    agent.tick();
    // A state change is written at once, not at the next one-second beat.
    expect(heartbeat().paused).toBe(false);
    putRequest("r2");
    agent.tick();
    expect(response("r2")).toMatchObject({ ok: true, result: 42 });

    setEnabled("0");
    agent.tick();
    expect(heartbeat().paused).toBe(true);
    putRequest("r3");
    agent.tick();
    expect(response("r3")).toMatchObject({ ok: false, paused: true });
    expect(ran()).toBe(1);
  });
});

describe("agent.jsx with «Sola lettura»", () => {
  it("runs requests marked mutates: false and refuses the rest", () => {
    setEnabled("1");
    setReadOnly("1");
    const agent = startAgent();
    expect(heartbeat().readOnly).toBe(true);

    putRequest("read", "shotA", { mutates: false });
    agent.tick();
    expect(response("read")).toMatchObject({ ok: true, result: 42 });

    putRequest("write", "shotA", { mutates: true });
    agent.tick();
    expect(response("write")).toMatchObject({ ok: false, phase: "dispatch", readOnly: true });
    expect(String(response("write").error)).toContain("sola lettura");

    // No field = an older server: counts as a change, so it is refused.
    putRequest("old");
    agent.tick();
    expect(response("old")).toMatchObject({ ok: false, readOnly: true });

    expect(ran()).toBe(1);
    expect(agent.state.served).toBe(1);
    expect(agent.state.refused).toBe(2);
  });

  it("follows the box on the next tick", () => {
    setEnabled("1");
    const agent = startAgent();
    expect(heartbeat().readOnly).toBe(false);
    setReadOnly("1");
    agent.tick();
    expect(heartbeat().readOnly).toBe(true);
    setReadOnly("0");
    agent.tick();
    expect(heartbeat().readOnly).toBe(false);
  });

  it("loses to the pause switch: stopped means stopped, reads included", () => {
    setEnabled("0");
    setReadOnly("1");
    const agent = startAgent();
    putRequest("read", "shotA", { mutates: false });
    agent.tick();
    expect(response("read")).toMatchObject({ ok: false, paused: true });
  });
});

describe("agent.jsx keeps the last requests for the panel", () => {
  it("records time, label, title, outcome and duration of the last 8, never the code", () => {
    setEnabled("1");
    const agent = startAgent();
    for (let i = 1; i <= 10; i++) {
      putRequest(`r${i}`, "shotA", { label: `layer.op_${i}`, title: `operazione ${i}` });
      agent.tick();
    }
    const recent = agent.state.recent;
    expect(recent.map((e) => e.label)).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10].map((i) => `layer.op_${i}`),
    );
    expect(recent.map((e) => e.title)).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10].map((i) => `operazione ${i}`),
    );
    expect(recent.every((e) => e.outcome === "ok" && typeof e.t === "number")).toBe(true);
    expect(recent.every((e) => typeof e.ms === "number" && e.ms >= 0)).toBe(true);
    const hb = heartbeat();
    expect((hb.recent as unknown[]).length).toBe(8);
    expect(typeof hb.lastRequestAt).toBe("number");
    expect(JSON.stringify(hb)).not.toContain("app.ran");
  });

  it("falls back to the label when the server sent no title", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest("r", "shotA", { label: "layer.create_null" });
    agent.tick();
    expect(agent.state.recent[0].title).toBe("layer.create_null");
  });

  it("marks what one Undo would revert: a change that ran inside an undo group", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest("change", "shotA", { label: "layer.create_null" });
    agent.tick();
    putRequest("look", "shotA", { label: "comp_info", mutates: false });
    agent.tick();
    putRequest("undo", "shotA", { label: "project.undo", undoGroup: false });
    agent.tick();
    expect(agent.state.recent.map((e) => [e.label, e.undoable])).toEqual([
      ["layer.create_null", true],
      ["comp_info", false],
      ["project.undo", false],
    ]);
  });

  it("records refusals and failures with their outcome", () => {
    setEnabled("0");
    const agent = startAgent();
    putRequest("p", "shotA", { label: "layer.create_null" });
    agent.tick();
    setEnabled("1");
    writeFileSync(path.join(instanceDir(), "request-bad.json"), "{ not json", "utf8");
    agent.tick();
    expect(agent.state.recent.map((e) => [e.label, e.outcome, e.undoable])).toEqual([
      ["layer.create_null", "paused", false],
      ["(senza nome)", "error", false],
    ]);
  });

  it("keeps labels to one bounded line", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest("long", "shotA", { label: `a\nb${"x".repeat(200)}` });
    agent.tick();
    const label = agent.state.recent[0].label;
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(60);
  });
});

describe("agent.jsx writes a history file, one per session", () => {
  it("in <user data>/Parlez/storico, one line per request, never the code", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest("a", "shotA", { label: "layer.create_text", title: "crea livello di testo" });
    agent.tick();
    setEnabled("0");
    putRequest("b", "shotA", { label: "layer.delete", title: "cancella livello" });
    agent.tick();

    const dir = path.join(tmp, "userData", "Parlez", "storico");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^storico-\d{8}-\d{6}-shotA\.txt$/);
    expect(agent.state.historyPath).toBe(`${dir.replace(/\\/g, "/")}/${files[0]}`);
    const lines = readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines[0]).toContain("istanza shotA");
    expect(lines[2]).toMatch(
      /^\d\d:\d\d:\d\d \| crea livello di testo \| layer\.create_text \| eseguita \| \d+(,\d)? s$/,
    );
    expect(lines[3]).toMatch(/cancella livello \| layer\.delete \| rifiutata \(pausa\) \| \d/);
    expect(lines.join("\n")).not.toContain("app.ran");
  });

  it("writes nothing until a request arrives", () => {
    startAgent();
    expect(existsSync(path.join(tmp, "userData", "Parlez", "storico"))).toBe(false);
  });
});

describe("agent.jsx for the panel's live state", () => {
  it("reports how many requests are waiting («sta ricevendo»)", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest("a");
    putRequest("b");
    putRequest("c");
    agent.tick();
    // One served this tick, two still waiting.
    expect(heartbeat().pending).toBe(2);
    agent.tick();
    agent.tick();
    agent.tick();
    expect(heartbeat().pending).toBe(0);
  });

  it("asks the panel to redraw right before and after each request, busy in between", () => {
    setEnabled("1");
    const agent = startAgent();
    const seen: boolean[] = [];
    engine.global.AE_MCP_PANEL = { onAgent: () => seen.push(agent.state.busy) };
    putRequest("a");
    agent.tick();
    expect(seen).toEqual([true, false]);
  });

  it("serves on even when the panel's redraw throws", () => {
    setEnabled("1");
    const agent = startAgent();
    engine.global.AE_MCP_PANEL = {
      onAgent: () => {
        throw new Error("panel gone");
      },
    };
    putRequest("a");
    agent.tick();
    expect(response("a")).toMatchObject({ ok: true });
  });

  it("never serves a second request from inside the first (a redraw may let a tick run)", () => {
    setEnabled("1");
    const agent = startAgent();
    let nested = 0;
    engine.global.AE_MCP_PANEL = {
      onAgent: () => {
        if (agent.state.busy) {
          nested++;
          agent.tick();
        }
      },
    };
    putRequest("a");
    putRequest("b");
    agent.tick();
    expect(nested).toBe(1);
    expect(agent.state.served).toBe(1);
  });
});

/** Serve one request the way dispatcher.jsx does: serve.jsx alone, shared mailbox. */
function serve(reqId: string) {
  const dir = path.join(tmp, "mbox").replace(/\\/g, "/");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `request-${reqId}.json`),
    JSON.stringify({ id: reqId, label: "x", code: "app.ran = 1; return 1;" }),
    "utf8",
  );
  engine.run(
    `${readFileSync(SERVE_JSX, "utf8")}\nAE_MCP.serveRequest(new File(${JSON.stringify(
      `${dir}/request-${reqId}.json`,
    )}), ${JSON.stringify(dir)}, ${JSON.stringify(`${dir}/dispatcher.log`)});`,
  );
  return JSON.parse(readFileSync(path.join(dir, `response-${reqId}.json`), "utf8"));
}

describe("serve.jsx (shared with the push dispatcher)", () => {
  it("refuses a pushed request too while no choice is saved", () => {
    expect(serve("p0")).toMatchObject({ ok: false, paused: true });
    expect(ran()).toBe(0);
  });

  it("refuses a pushed request while Claude is stopped", () => {
    setEnabled("0");
    expect(serve("p1")).toMatchObject({ ok: false, paused: true });
    expect(ran()).toBe(0);
  });

  it("runs it when Claude may work", () => {
    setEnabled("1");
    expect(serve("p2")).toMatchObject({ ok: true, result: 1 });
    expect(ran()).toBe(1);
  });
});

describe("the switch is named the same everywhere", () => {
  it("serve.jsx uses the section and keys of the server and panel", () => {
    const serveSrc = readFileSync(SERVE_JSX, "utf8");
    expect(serveSrc).toContain(`"${PAUSE_SETTINGS_SECTION}"`);
    expect(serveSrc).toContain(`"${PAUSE_SETTINGS_KEY}"`);
    expect(serveSrc).toContain(`"${READ_ONLY_SETTINGS_KEY}"`);
  });

  it("the shim leaves no stray files in the instance directory", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest("r1");
    agent.tick();
    const left = readdirSync(instanceDir()).filter(
      (n) => !/^(heartbeat\.json|response-r1\.json|agent\.log)$/.test(n),
    );
    expect(left).toEqual([]);
    expect(new EsFile(path.join(instanceDir(), "heartbeat.json")).exists).toBe(true);
  });
});
