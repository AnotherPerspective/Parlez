// The Parlez! panel (jsx/panel.jsx) run unchanged inside the ExtendScript
// stand-in, with a bare-bones ScriptUI: enough to find the controls, click
// them and read what they say. The real look and docking can only be checked
// in After Effects.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_JSX,
  PANEL_JSX,
  PAUSE_SETTINGS_KEY,
  PAUSE_SETTINGS_SECTION,
  READ_ONLY_SETTINGS_KEY,
} from "../src/config.js";
import { DEFAULT_CHECKPOINT_SUBDIR, parseCheckpointName } from "../src/operations/checkpoint.js";
import {
  EsFile,
  EsFolder,
  type EsEngine,
  loadJsx,
  makeEngine,
} from "./helpers/extendscript-shim.js";

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
    BrushType: { SOLID_COLOR: 0 },
    newPen: (_type: number, color: number[]) => ({ color }),
    newBrush: (_type: number, color: number[]) => ({ color }),
    font: null as unknown,
    foregroundColor: null as unknown,
    backgroundColor: null as { color: number[] } | null,
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
  /** The traffic light: the first group with a fill. */
  lamp(): number[] | null {
    const g = this.all().find((c) => c.type === "group" && c.graphics.backgroundColor !== null);
    return g?.graphics.backgroundColor?.color.slice(0, 3) ?? null;
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

const GREEN = [0.24, 0.74, 0.38];
const RED = [0.88, 0.26, 0.22];
const YELLOW = [0.96, 0.74, 0.16];
const GREY = [0.45, 0.45, 0.45];

let tmp: string;
let engine: EsEngine;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-panel-"));
  engine = makeEngine(tmp);
  engine.env.APPDATA = path.join(tmp, "AppData").replace(/\\/g, "/");
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

function refresh() {
  (engine.global.AE_MCP_PANEL as { refresh: () => void }).refresh();
}

function enabledSetting(): string | undefined {
  return engine.app.settings.peek(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY);
}

function setEnabled(v: "0" | "1") {
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, v);
}

interface Agent {
  state: { id: string; dir: string; served: number; lastRequestAt: number | null };
  tick: () => void;
}

function startAgent(): Agent {
  engine.global.AE_MCP_AGENT_MAILBOX = path.join(tmp, "runtime").replace(/\\/g, "/");
  engine.env.AE_MCP_INSTANCE = "shotA";
  engine.run(loadJsx(AGENT_JSX, ["serve.jsx"]));
  return engine.global.AE_MCP_AGENT as Agent;
}

function serveOne(agent: Agent, id: string, label: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    path.join(agent.state.dir, `request-${id}.json`),
    JSON.stringify({ id, label, code: "return 1;", undoGroup: true, ...extra }),
    "utf8",
  );
  agent.tick();
}

/** Pretend the last request came in long ago, so the light is not yellow. */
function quiet(agent: Agent) {
  agent.state.lastRequestAt = Date.now() - 60_000;
}

function activeTasks(code: string) {
  return engine.app.tasks.filter((t) => !t.cancelled && t.code.includes(code));
}

describe("the main switch", () => {
  it("starts on «Claude fermo» the first time, red, and remembers that choice", () => {
    expect(enabledSetting()).toBeUndefined();
    const panel = openPanel();
    expect(enabledSetting()).toBe("0");
    expect(panel.says()).toContain("CLAUDE FERMO");
    expect(panel.lamp()).toEqual(RED);
    expect(panel.find("button", "Lascia lavorare Claude")).toBeTruthy();
  });

  it("is one click each way, and a new session shows the saved choice", () => {
    const panel = openPanel();
    panel.find("button", "Lascia lavorare Claude").onClick!();
    expect(enabledSetting()).toBe("1");
    expect(panel.find("button", "Ferma Claude")).toBeTruthy();

    const again = openPanel();
    expect(again.find("button", "Ferma Claude")).toBeTruthy();

    again.find("button", "Ferma Claude").onClick!();
    expect(enabledSetting()).toBe("0");
  });

  it("turning it off reaches the running agent on its next tick", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    panel.find("button", "Ferma Claude").onClick!();
    agent.tick();
    const hb = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
    expect(hb.paused).toBe(true);
  });
});

describe("the traffic light", () => {
  it("is grey when the startup script is not running", () => {
    setEnabled("1");
    const panel = openPanel();
    expect(panel.lamp()).toEqual(GREY);
    expect(panel.says()).toContain("NON COLLEGATO");
  });

  it("is green when Claude may work and nothing is happening", () => {
    setEnabled("1");
    startAgent();
    const panel = openPanel();
    expect(panel.lamp()).toEqual(GREEN);
    expect(panel.says()).toContain("CLAUDE PUÒ LAVORARE");
  });

  it("is yellow for a few seconds after a request, then green again", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "r1", "layer.create_null");
    refresh();
    expect(panel.lamp()).toEqual(YELLOW);
    expect(panel.says()).toContain("CLAUDE STA LAVORANDO");
    quiet(agent);
    refresh();
    expect(panel.lamp()).toEqual(GREEN);
  });

  it("stays red while stopped, whatever the agent does", () => {
    setEnabled("0");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "r1", "layer.create_null");
    refresh();
    expect(panel.lamp()).toEqual(RED);
  });

  it("is grey with a warning when the heartbeat has stopped", () => {
    setEnabled("1");
    const agent = startAgent();
    const file = path.join(agent.state.dir, "heartbeat.json");
    const stale = JSON.parse(readFileSync(file, "utf8"));
    stale.ts = Date.now() - 60_000;
    writeFileSync(file, JSON.stringify(stale), "utf8");
    const panel = openPanel();
    expect(panel.lamp()).toEqual(GREY);
    expect(panel.says()).toContain("NON RISPONDE");
  });
});

describe("«Sola lettura»", () => {
  it("is saved by the box and reaches the agent", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    const box = panel.find("checkbox", "Sola lettura");
    box.value = true;
    box.onClick!();
    expect(engine.app.settings.peek(PAUSE_SETTINGS_SECTION, READ_ONLY_SETTINGS_KEY)).toBe("1");
    agent.tick();
    const hb = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
    expect(hb.readOnly).toBe(true);
    quiet(agent);
    refresh();
    expect(panel.says()).toContain("Sola lettura");
    expect(panel.lamp()).toEqual(GREEN);
  });
});

describe("last actions and counters", () => {
  it("lists the newest first with time and label, and counts", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    expect(panel.says()).toContain("Nessuna azione in questa sessione.");
    serveOne(agent, "a", "layer.create_null");
    serveOne(agent, "b", "comp_info", { mutates: false });
    refresh();
    const rows = panel
      .find("panel", "Ultime azioni")
      .children.map((c) => c.text)
      .filter(Boolean);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\d\d:\d\d:\d\d {3}comp_info$/);
    expect(rows[1]).toMatch(/layer\.create_null$/);
    expect(panel.says()).toMatch(/Eseguite 2 · rifiutate 0 · ultima \d+ s fa/);
    expect(panel.says()).toContain("Istanza shotA · agente v3");
  });

  it("marks refusals", () => {
    setEnabled("0");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "a", "layer.create_null");
    refresh();
    expect(panel.says()).toContain("layer.create_null  (rifiutata: pausa)");
    expect(panel.says()).toMatch(/rifiutate 1/);
  });
});

describe("«Annulla ultima di Claude»", () => {
  it("is off until Claude changed something", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    expect(panel.find("button", "Annulla ultima").enabled).toBe(false);
    serveOne(agent, "look", "comp_info", { mutates: false });
    refresh();
    expect(panel.find("button", "Annulla ultima").enabled).toBe(false);
  });

  it("names the action, asks, and runs Edit > Undo once", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "a", "layer.create_null");
    serveOne(agent, "b", "comp_info", { mutates: false });
    refresh();
    const undo = panel.find("button", "Annulla ultima");
    expect(undo.enabled).toBe(true);
    undo.onClick!();
    expect(engine.dialogs.shown[0]).toContain("«layer.create_null»");
    expect(engine.dialogs.shown[0]).toContain("cronologia");
    expect(engine.app.commands).toEqual([16]);
    expect(panel.says()).toContain("layer.create_null  (annullata)");
    // Nothing of Claude's left to undo.
    expect(undo.enabled).toBe(false);
  });

  it("does nothing when the user says no", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "a", "layer.create_null");
    refresh();
    engine.dialogs.answer = false;
    panel.find("button", "Annulla ultima").onClick!();
    expect(engine.app.commands).toEqual([]);
  });
});

describe("«Punto di ripristino»", () => {
  function openProject(name = "ShotA.aep") {
    const dir = path.join(tmp, "work");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, "AEP-BYTES-0123456789", "utf8");
    engine.app.project.file = new EsFile(file);
    return dir;
  }

  it("refuses a project that was never saved", () => {
    const panel = openPanel();
    expect(panel.find("button", "Punto di ripristino").enabled).toBe(false);
    panel.find("button", "Punto di ripristino").onClick!();
    expect(panel.says()).toContain("Salva prima il progetto");
    expect(engine.app.project.saves).toBe(0);
  });

  it("saves, then copies into _parlez-checkpoints under a name checkpoint.list reads", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", "Punto di ripristino").onClick!();
    expect(engine.app.project.saves).toBe(1);
    const folder = path.join(dir, DEFAULT_CHECKPOINT_SUBDIR);
    const files = readdirSync(folder);
    expect(files).toHaveLength(1);
    expect(parseCheckpointName(files[0], "ShotA")).toMatchObject({
      project: "ShotA",
      label: "pannello",
      copy: 1,
    });
    expect(readFileSync(path.join(folder, files[0]), "utf8")).toBe("AEP-BYTES-0123456789");
    expect(panel.says()).toContain("Punto di ripristino creato");
  });

  it("never overwrites: a second one in the same second gets « (2)»", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", "Punto di ripristino").onClick!();
    panel.find("button", "Punto di ripristino").onClick!();
    const names = readdirSync(path.join(dir, DEFAULT_CHECKPOINT_SUBDIR)).sort();
    expect(names).toHaveLength(2);
    const parsed = names.map((n) => parseCheckpointName(n, "ShotA")!);
    expect(parsed.every((p) => p !== null)).toBe(true);
    // Same second → " (2)"; a second boundary in between → two plain names.
    if (parsed[0].stamp === parsed[1].stamp) {
      expect(parsed.map((p) => p.copy).sort()).toEqual([1, 2]);
    }
  });

  it("refuses .aepx, whose copy would not open as .aep", () => {
    openProject("ShotA.aepx");
    const panel = openPanel();
    panel.find("button", "Punto di ripristino").onClick!();
    expect(panel.says()).toContain(".aep");
    expect(engine.app.project.saves).toBe(0);
  });

  it("opens the folder, or says there is none yet", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", "Cartella ripristini").onClick!();
    expect(panel.says()).toContain("Nessun punto di ripristino");
    expect(EsFolder.executed).toEqual([]);
    panel.find("button", "Punto di ripristino").onClick!();
    panel.find("button", "Cartella ripristini").onClick!();
    expect(EsFolder.executed).toEqual([
      path.join(dir, DEFAULT_CHECKPOINT_SUBDIR).replace(/\\/g, "/"),
    ]);
  });
});

describe("the mailbox button", () => {
  it("is off without an agent and opens the instance folder with one", () => {
    const off = openPanel();
    expect(off.find("button", "Apri la cassetta").enabled).toBe(false);
    const agent = startAgent();
    const panel = openPanel();
    panel.find("button", "Apri la cassetta").onClick!();
    expect(EsFolder.executed).toEqual([agent.state.dir]);
  });
});

describe("docking and refreshing", () => {
  it("builds into the Panel it is given and opens no window", () => {
    openPanel();
    expect(windows).toHaveLength(0);
  });

  it("opens a floating window titled Parlez! when run as a plain script, and stops refreshing when it closes", () => {
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
    expect(windows[0].text).toBe("Parlez!");
    expect(windows[0].shown).toBe(true);
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(1);
    windows[0].close();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
  });

  it("refreshes every 1-2 seconds and keeps one timer however often it is rebuilt", () => {
    openPanel();
    openPanel();
    openPanel();
    const tasks = activeTasks("AE_MCP_PANEL");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].delay).toBeGreaterThanOrEqual(1000);
    expect(tasks[0].delay).toBeLessThanOrEqual(2000);
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
    refresh();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
  });
});

describe("accented text survives any file encoding", () => {
  // After Effects may read a .jsx without a BOM in the system code page, so
  // a raw "è" inside a string would show as "Ã¨". Strings are escaped instead.
  for (const file of [PANEL_JSX, AGENT_JSX, AGENT_JSX.replace(/agent\.jsx$/, "serve.jsx")]) {
    it(`${path.basename(file)} has only ASCII inside string literals`, () => {
      const offenders = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .flatMap((line) => line.match(/"(?:[^"\\]|\\.)*"/g) ?? [])
        .filter((literal) => [...literal].some((ch) => ch.charCodeAt(0) > 0x7f));
      expect(offenders).toEqual([]);
    });
  }
});

describe("the panel and the rest agree", () => {
  it("uses the same app.settings section and keys, and the checkpoint folder", () => {
    expect(PANEL_SRC).toContain(`"${PAUSE_SETTINGS_SECTION}"`);
    expect(PANEL_SRC).toContain(`"${PAUSE_SETTINGS_KEY}"`);
    expect(PANEL_SRC).toContain(`"${READ_ONLY_SETTINGS_KEY}"`);
    expect(PANEL_SRC).toContain(`"${DEFAULT_CHECKPOINT_SUBDIR}"`);
  });
});
