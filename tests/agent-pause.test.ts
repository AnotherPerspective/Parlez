// The pause switch, on the After Effects side: jsx/agent.jsx and the shared
// jsx/serve.jsx run unchanged inside the ExtendScript stand-in
// (helpers/extendscript-shim.ts), against a throwaway mailbox. The switch is
// the app.settings entry the panel writes; nothing here needs After Effects.

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

import { AGENT_JSX, PAUSE_SETTINGS_KEY, PAUSE_SETTINGS_SECTION } from "../src/config.js";
import { EsFile, type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";

const SERVE_JSX = fileURLToPath(new URL("../jsx/serve.jsx", import.meta.url));

interface AgentState {
  id: string;
  served: number;
  refused: number;
  paused: boolean;
  agentVersion: number;
  dir: string | null;
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

function setEnabled(value: "1" | "0") {
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, value);
}

function instanceDir(id = "shotA") {
  return path.join(mailbox, "instances", id);
}

function heartbeat(id = "shotA"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(instanceDir(id), "heartbeat.json"), "utf8"));
}

/** Drop a request whose code bumps app.ran, so we can tell whether it executed. */
function putRequest(reqId: string, id = "shotA") {
  const body = {
    id: reqId,
    label: "probe",
    code: "app.ran = (app.ran || 0) + 1; return 42;",
    payload: null,
    undoGroup: true,
    suppressDialogs: true,
  };
  writeFileSync(path.join(instanceDir(id), `request-${reqId}.json`), JSON.stringify(body), "utf8");
}

function response(reqId: string, id = "shotA"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(instanceDir(id), `response-${reqId}.json`), "utf8"));
}

function ran(): number {
  return (engine.app as unknown as { ran?: number }).ran ?? 0;
}

describe("agent.jsx with no switch set (panel never opened)", () => {
  it("serves requests exactly as before and reports paused: false", () => {
    const agent = startAgent();
    expect(heartbeat().paused).toBe(false);
    putRequest("r1");
    agent.tick();
    expect(response("r1")).toMatchObject({ id: "r1", ok: true, result: 42 });
    expect(ran()).toBe(1);
    expect(agent.state.served).toBe(1);
    expect(agent.state.refused).toBe(0);
  });

  it("announces an agent version that knows the switch", () => {
    const agent = startAgent();
    expect(agent.state.agentVersion).toBeGreaterThanOrEqual(2);
    expect(heartbeat().agentVersion).toBe(agent.state.agentVersion);
  });
});

describe("agent.jsx with Claude stopped", () => {
  it("does not run the request, answers it as paused, and keeps the heartbeat going", () => {
    setEnabled("0");
    const agent = startAgent();
    const hb = heartbeat();
    expect(hb.paused).toBe(true);

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
    expect(ran()).toBe(1);

    setEnabled("0");
    agent.tick();
    expect(heartbeat().paused).toBe(true);
    putRequest("r3");
    agent.tick();
    expect(response("r3")).toMatchObject({ ok: false, paused: true });
    expect(ran()).toBe(1);
  });

  it('treats anything but "0" as allowed, so a damaged setting never locks the user out silently', () => {
    engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, "yes");
    const agent = startAgent();
    expect(heartbeat().paused).toBe(false);
    putRequest("r1");
    agent.tick();
    expect(response("r1")).toMatchObject({ ok: true });
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
  it("refuses a pushed request too while Claude is stopped", () => {
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
  it("serve.jsx reads the section and key the server and panel use", () => {
    const serveSrc = readFileSync(SERVE_JSX, "utf8");
    expect(serveSrc).toContain(`"${PAUSE_SETTINGS_SECTION}"`);
    expect(serveSrc).toContain(`"${PAUSE_SETTINGS_KEY}"`);
  });

  it("the shim leaves no stray files in the instance directory", () => {
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
