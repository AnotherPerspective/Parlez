// The switch panel (jsx/panel.jsx, nome provvisorio) run unchanged inside the
// ExtendScript stand-in, with a bare-bones ScriptUI: enough to find the
// controls, click them and read what they say. The real look and docking
// can only be checked in After Effects.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_JSX, PANEL_JSX, PAUSE_SETTINGS_KEY, PAUSE_SETTINGS_SECTION } from "../src/config.js";
import { EsFolder, type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";

class Ctl {
  children: Ctl[] = [];
  text: string;
  value = false;
  enabled = true;
  shown = false;
  closed = false;
  preferredSize: Record<string, number> = { width: 0, height: 0 };
  graphics = {
    PenType: { SOLID_COLOR: 0 },
    newPen: (_type: number, color: number[]) => ({ color }),
    font: null as unknown,
    foregroundColor: null as unknown,
  };
  layout = { layout: () => {}, resize: () => {} };
  onClick?: () => void;
  onClose?: () => void;
  [key: string]: unknown;

  constructor(
    readonly type: string,
    text = "",
  ) {
    this.text = text;
  }
  add(type: string, _bounds?: unknown, text?: string): Ctl {
    const c = new Ctl(type, text ?? "");
    this.children.push(c);
    return c;
  }
  show(): void {
    this.shown = true;
  }
  center(): void {}
  close(): void {
    this.closed = true;
    this.onClose?.();
  }
  /** Every descendant, depth first. */
  all(): Ctl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(type: string, text: string | RegExp): Ctl {
    const hit = this.all().find(
      (c) =>
        c.type === type && (typeof text === "string" ? c.text.includes(text) : text.test(c.text)),
    );
    if (!hit) throw new Error(`no ${type} matching ${String(text)}`);
    return hit;
  }
  /** All static text, for "does the panel say X" checks. */
  says(): string {
    return this.all()
      .filter((c) => c.type === "statictext")
      .map((c) => c.text)
      .join("\n");
  }
}

class FakePanel extends Ctl {}
const windows: Ctl[] = [];
class FakeWindow extends Ctl {
  constructor(type: string, title: string) {
    super(`window:${type}`, title);
    windows.push(this);
  }
}

let tmp: string;
let engine: EsEngine;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-panel-"));
  engine = makeEngine(tmp);
  windows.length = 0;
  EsFolder.executed = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PANEL_SRC = readFileSync(PANEL_JSX, "utf8");

function openPanel(): Ctl {
  const panel = new FakePanel("panel");
  engine.run(PANEL_SRC, panel, {
    Panel: FakePanel,
    Window: FakeWindow,
    ScriptUI: { newFont: () => ({}) },
  });
  return panel;
}

function setting(): string | undefined {
  return engine.app.settings.peek(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY);
}

function startAgent() {
  engine.global.AE_MCP_AGENT_MAILBOX = path.join(tmp, "runtime").replace(/\\/g, "/");
  engine.env.AE_MCP_INSTANCE = "shotA";
  engine.run(loadJsx(AGENT_JSX, ["serve.jsx"]));
  return engine.global.AE_MCP_AGENT as {
    state: { id: string; dir: string; served: number };
    tick: () => void;
  };
}

function activeTasks(code: string) {
  return engine.app.tasks.filter((t) => !t.cancelled && t.code.includes(code));
}

describe("the switch", () => {
  it("starts on «Claude fermo» the first time and remembers that choice", () => {
    expect(setting()).toBeUndefined();
    const panel = openPanel();
    expect(setting()).toBe("0");
    expect(panel.find("radiobutton", "Claude fermo").value).toBe(true);
    expect(panel.find("radiobutton", "Claude può lavorare").value).toBe(false);
  });

  it("saves «Claude può lavorare» and shows it again next session", () => {
    const panel = openPanel();
    const on = panel.find("radiobutton", "Claude può lavorare");
    on.value = true;
    panel.find("radiobutton", "Claude fermo").value = false;
    on.onClick!();
    expect(setting()).toBe("1");

    // A new After Effects session keeps app.settings and builds a fresh panel.
    const again = openPanel();
    expect(again.find("radiobutton", "Claude può lavorare").value).toBe(true);
    expect(again.find("radiobutton", "Claude fermo").value).toBe(false);
  });

  it("turning it off reaches the running agent on its next tick", () => {
    engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, "1");
    const agent = startAgent();
    const panel = openPanel();
    const off = panel.find("radiobutton", "Claude fermo");
    off.value = true;
    off.onClick!();
    expect(setting()).toBe("0");
    agent.tick();
    const hb = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
    expect(hb.paused).toBe(true);
  });
});

describe("the status line", () => {
  it("says the startup script is not running when there is no agent", () => {
    const panel = openPanel();
    expect(panel.says()).toMatch(/non (è )?attivo/);
    expect(panel.find("button", "Apri la cassetta").enabled).toBe(false);
  });

  it("names the instance and counts the requests it served", () => {
    engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, "1");
    const agent = startAgent();
    const panel = openPanel();
    expect(panel.says()).toContain("attivo");
    expect(panel.says()).toContain("shotA");
    expect(panel.says()).toMatch(/eseguite: 0/);

    writeFileSync(
      path.join(agent.state.dir, "request-r1.json"),
      JSON.stringify({ id: "r1", label: "x", code: "return 1;" }),
      "utf8",
    );
    agent.tick();
    panel.find("button", "Aggiorna").onClick!();
    expect(panel.says()).toMatch(/eseguite: 1/);
  });

  it("warns when the heartbeat has stopped", () => {
    const agent = startAgent();
    const stale = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
    stale.ts = Date.now() - 60_000;
    writeFileSync(path.join(agent.state.dir, "heartbeat.json"), JSON.stringify(stale), "utf8");
    const panel = openPanel();
    expect(panel.says()).toMatch(/battito/);
  });

  it("opens the instance folder from «Apri la cassetta»", () => {
    const agent = startAgent();
    const panel = openPanel();
    const open = panel.find("button", "Apri la cassetta");
    expect(open.enabled).toBe(true);
    open.onClick!();
    expect(EsFolder.executed).toEqual([agent.state.dir]);
  });
});

describe("docking and refreshing", () => {
  it("builds into the Panel it is given and opens no window", () => {
    openPanel();
    expect(windows).toHaveLength(0);
  });

  it("opens a floating window when run as a plain script, and stops refreshing when it closes", () => {
    engine.run(
      PANEL_SRC,
      {},
      {
        Panel: FakePanel,
        Window: FakeWindow,
        ScriptUI: { newFont: () => ({}) },
      },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].type).toBe("window:palette");
    expect(windows[0].shown).toBe(true);
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(1);
    windows[0].close();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
  });

  it("keeps one refresh timer however often the panel is rebuilt", () => {
    openPanel();
    openPanel();
    openPanel();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(1);
  });

  it("stops its timer instead of throwing once its controls are gone", () => {
    const panel = openPanel();
    // A docked panel that was closed: touching its controls throws in AE.
    for (const c of panel.all()) {
      Object.defineProperty(c, "text", {
        set() {
          throw new Error("Object is invalid");
        },
      });
    }
    (engine.global.AE_MCP_PANEL as { refresh: () => void }).refresh();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
  });
});

describe("the panel and the server agree on the switch", () => {
  it("uses the same app.settings section and key", () => {
    expect(PANEL_SRC).toContain(`"${PAUSE_SETTINGS_SECTION}"`);
    expect(PANEL_SRC).toContain(`"${PAUSE_SETTINGS_KEY}"`);
  });
});
