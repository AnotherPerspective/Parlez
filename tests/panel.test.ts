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
  helpTip = "";
  size = [200, 60];
  updates = 0;
  preferredSize: Record<string, number> = { width: 0, height: 0 };
  graphics = {
    PenType: { SOLID_COLOR: 0 },
    BrushType: { SOLID_COLOR: 0 },
    newPen: (_type: number, color: number[]) => ({ color }),
    newBrush: (_type: number, color: number[]) => ({ color }),
    font: null as unknown,
    foregroundColor: null as unknown,
    backgroundColor: null as { color: number[] } | null,
    drawn: [] as string[],
    newPath: () => {},
    rectPath: () => {},
    fillPath: (_brush: unknown) => {},
    measureString: (s: string) => [s.length * 10, 20],
    drawString(s: string) {
      this.drawn.push(s);
    },
    drawOSControl: () => {},
  };
  layout = { layout: () => {}, resize: () => {} };
  onClick?: () => void;
  onClose?: () => void;
  onDraw?: () => void;
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
  remove(child: Ctl): void {
    this.children = this.children.filter((c) => c !== child);
  }
  update(): void {
    this.updates++;
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
  /** The ON/OFF block. */
  block(): Ctl {
    return this.find("button", /^(ON|OFF) ?$/);
  }
  word(): string {
    return this.block().text.trim();
  }
  color(): number[] {
    return this.block().fillColor as number[];
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

const GREEN = [0.2, 0.72, 0.36];
const RED = [0.86, 0.24, 0.2];
const YELLOW = [0.95, 0.72, 0.12];
const GREY = [0.42, 0.42, 0.42];

let tmp: string;
let engine: EsEngine;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-panel-"));
  engine = makeEngine(tmp);
  windows.length = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PANEL_SRC = readFileSync(PANEL_JSX, "utf8");
const SCRIPTUI = { newFont: (_f: string, style: string, size: number) => ({ style, size }) };

function openPanel(): Ctl {
  const panel = new FakePanel("panel");
  engine.run(PANEL_SRC, panel, { Panel: FakePanel, Window: FakeWindow, ScriptUI: SCRIPTUI });
  return panel;
}

function refresh() {
  (engine.global.AE_MCP_PANEL as { refresh: () => void }).refresh();
}

function enabledSetting(): string | undefined {
  return engine.app.settings.peek(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY);
}

function setEnabled(v: string) {
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, PAUSE_SETTINGS_KEY, v);
}

interface Agent {
  state: {
    id: string;
    dir: string;
    served: number;
    busy: boolean;
    lastRequestAt: number | null;
    historyPath: string | null;
  };
  tick: () => void;
}

function startAgent(): Agent {
  engine.global.AE_MCP_AGENT_MAILBOX = path.join(tmp, "runtime").replace(/\\/g, "/");
  engine.env.AE_MCP_INSTANCE = "shotA";
  engine.run(loadJsx(AGENT_JSX, ["serve.jsx"]));
  return engine.global.AE_MCP_AGENT as Agent;
}

function putRequest(agent: Agent, id: string, label: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    path.join(agent.state.dir, `request-${id}.json`),
    JSON.stringify({ id, label, code: "return 1;", undoGroup: true, ...extra }),
    "utf8",
  );
}

function serveOne(agent: Agent, id: string, label: string, extra: Record<string, unknown> = {}) {
  putRequest(agent, id, label, extra);
  agent.tick();
}

function historyRows(panel: Ctl): string[] {
  const box = panel.all().find((c) => c.children.some((k) => k.text === "Ultime richieste"))!;
  return box.children.map((c) => c.text).filter((t) => t && t !== "Ultime richieste");
}

function activeTasks(code: string) {
  return engine.app.tasks.filter((t) => !t.cancelled && t.code.includes(code));
}

describe("the ON / OFF block", () => {
  it("starts on OFF, red, «Claude fermo», and saves that first choice", () => {
    expect(enabledSetting()).toBeUndefined();
    const panel = openPanel();
    expect(enabledSetting()).toBe("0");
    expect(panel.word()).toBe("OFF");
    expect(panel.color()).toEqual(RED);
    expect(panel.says()).toContain("Claude fermo");
    expect(panel.block().helpTip).toContain("Clic per accenderlo");
  });

  it("is one click each way, and a new session shows the saved choice", () => {
    const panel = openPanel();
    panel.block().onClick!();
    expect(enabledSetting()).toBe("1");
    expect(panel.word()).toBe("ON");

    const again = openPanel();
    expect(again.word()).toBe("ON");
    again.block().onClick!();
    expect(enabledSetting()).toBe("0");
    expect(again.word()).toBe("OFF");
  });

  it("draws itself: fill and the word, with a coloured frame as the fallback", () => {
    const panel = openPanel();
    const block = panel.block();
    expect(typeof block.onDraw).toBe("function");
    block.onDraw!.call(block);
    expect(block.graphics.drawn).toEqual(["OFF"]);
    const frame = panel.all().find((c) => c.children.includes(block))!;
    expect(frame.graphics.backgroundColor?.color.slice(0, 3)).toEqual(RED);
  });

  it("falls back to the native button when custom drawing throws", () => {
    const panel = openPanel();
    const block = panel.block();
    let native = 0;
    block.graphics.fillPath = () => {
      throw new Error("not supported");
    };
    block.graphics.drawOSControl = () => {
      native++;
    };
    block.onDraw!.call(block);
    expect(native).toBe(1);
  });

  it("says so when After Effects does not keep the choice", () => {
    engine.app.settings.saveSetting = () => {
      throw new Error("prefs locked");
    };
    const panel = openPanel();
    expect(panel.says()).toContain("Non riesco a salvare");
    expect(panel.word()).toBe("OFF");
    panel.block().onClick!();
    expect(panel.word()).toBe("OFF");
  });
});

describe("panel and agent can never disagree (the 2026-10-25 defect)", () => {
  it("for every value of the switch, the block and the heartbeat say the same", () => {
    const agent = startAgent();
    const panel = openPanel();
    for (const value of ["0", "1", "yes", "", "1"]) {
      setEnabled(value);
      agent.tick();
      refresh();
      const hb = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
      expect(panel.word() === "ON", JSON.stringify(value)).toBe(hb.paused === false);
    }
  });

  it("asks the agent's rule, not its own copy, when the agent is there", () => {
    startAgent();
    (engine.global.AE_MCP as { isEnabled: () => boolean }).isEnabled = () => true;
    const panel = openPanel();
    expect(panel.word()).toBe("ON");
  });

  it("turning it off reaches the running agent on its next tick", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    panel.block().onClick!();
    agent.tick();
    const hb = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
    expect(hb.paused).toBe(true);
  });
});

describe("the traffic light", () => {
  it("is grey ON «non collegato» without the startup script", () => {
    setEnabled("1");
    const panel = openPanel();
    expect(panel.word()).toBe("ON");
    expect(panel.color()).toEqual(GREY);
    expect(panel.says()).toContain("non collegato");
  });

  it("is green «in attesa» when Claude may work and nothing is happening", () => {
    setEnabled("1");
    startAgent();
    const panel = openPanel();
    expect(panel.color()).toEqual(GREEN);
    expect(panel.says()).toContain("in attesa");
  });

  it("is yellow «sta elaborando» while a request runs: the agent makes the panel paint", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    const colours: number[][] = [];
    const statuses: string[] = [];
    const registry = engine.global.AE_MCP_PANEL as { onAgent: () => void };
    const original = registry.onAgent;
    registry.onAgent = () => {
      original();
      colours.push(panel.color());
      statuses.push(panel.says());
    };
    serveOne(agent, "r1", "layer.create_null");
    expect(colours).toEqual([YELLOW, GREEN]);
    expect(statuses[0]).toContain("sta elaborando");
    expect(panel.updates).toBe(2);
  });

  it("is yellow «sta ricevendo» while requests are waiting", () => {
    setEnabled("1");
    const agent = startAgent();
    putRequest(agent, "a", "x");
    putRequest(agent, "b", "y");
    agent.tick();
    const panel = openPanel();
    expect(panel.color()).toEqual(YELLOW);
    expect(panel.says()).toContain("sta ricevendo");
  });

  it("stays red while stopped, whatever the agent does", () => {
    setEnabled("0");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "r1", "layer.create_null");
    refresh();
    expect(panel.color()).toEqual(RED);
  });

  it("is grey «non risponde» when the heartbeat has stopped", () => {
    setEnabled("1");
    const agent = startAgent();
    const file = path.join(agent.state.dir, "heartbeat.json");
    const stale = JSON.parse(readFileSync(file, "utf8"));
    stale.ts = Date.now() - 60_000;
    writeFileSync(file, JSON.stringify(stale), "utf8");
    const panel = openPanel();
    expect(panel.color()).toEqual(GREY);
    expect(panel.says()).toContain("non risponde");
  });
});

describe("«Sola lettura»", () => {
  it("is saved by the box, reaches the agent and shows in the status", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    const box = panel.find("checkbox", "Sola lettura");
    expect(box.helpTip).toContain("non modificarlo");
    box.value = true;
    box.onClick!();
    expect(engine.app.settings.peek(PAUSE_SETTINGS_SECTION, READ_ONLY_SETTINGS_KEY)).toBe("1");
    agent.tick();
    const hb = JSON.parse(readFileSync(path.join(agent.state.dir, "heartbeat.json"), "utf8"));
    expect(hb.readOnly).toBe(true);
    refresh();
    expect(panel.says()).toContain("in attesa · sola lettura");
  });
});

describe("history and counters", () => {
  it("lists the newest first: time, title in Italian, ✓ and duration", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    expect(panel.says()).toContain("Nessuna richiesta in questa sessione.");
    serveOne(agent, "a", "layer.create_null", { title: "crea oggetto nullo" });
    serveOne(agent, "b", "comp_info", { mutates: false, title: "guarda la composizione" });
    refresh();
    const rows = historyRows(panel);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\d\d:\d\d {2}guarda la composizione {2}✓ {2}\d+(,\d)? s$/);
    expect(rows[1]).toMatch(/crea oggetto nullo {2}✓/);
    expect(panel.says()).toMatch(/eseguite 2 · rifiutate 0 · ultima \d+ s fa/);
    expect(panel.says()).toContain("shotA · agente v3");
  });

  it("marks refusals and shortens long titles", () => {
    setEnabled("0");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "a", "batch.run", {
      title: "lotto di 5 operazioni: crea livello di testo, modifica testo, aggiunge effetto…",
    });
    refresh();
    const row = historyRows(panel)[0];
    expect(row).toContain("rifiutata (pausa)");
    expect(row).toContain("lotto di 5 operazioni: crea l…");
  });

  it("shows 5 rows in the compact view and 8 in the vertical one", () => {
    setEnabled("1");
    const agent = startAgent();
    for (let i = 0; i < 10; i++) serveOne(agent, `r${i}`, `op_${i}`);
    const vertical = openPanel();
    expect(historyRows(vertical)).toHaveLength(8);
    vertical.find("button", "Vista").onClick!();
    expect(historyRows(vertical)).toHaveLength(5);
  });
});

describe("the two layouts", () => {
  it("starts vertical, switches to compact and back, and remembers the choice", () => {
    const panel = openPanel();
    expect(panel.orientation).toBe("column");
    expect(panel.find("button", "Vista").helpTip).toContain("compatta");
    panel.find("button", "Vista").onClick!();
    expect(panel.orientation).toBe("row");
    expect(engine.app.settings.peek(PAUSE_SETTINGS_SECTION, "layout")).toBe("compatta");
    // Rebuilt, not duplicated: one block.
    expect(panel.all().filter((c) => /^(ON|OFF) ?$/.test(c.text))).toHaveLength(1);

    const again = openPanel();
    expect(again.orientation).toBe("row");
    again.find("button", "Vista").onClick!();
    expect(again.orientation).toBe("column");
  });

  it("keeps working after a switch: the block still toggles", () => {
    const panel = openPanel();
    panel.find("button", "Vista").onClick!();
    panel.block().onClick!();
    expect(enabledSetting()).toBe("1");
    expect(panel.word()).toBe("ON");
  });

  it("uses short labels, with the details in the tooltips", () => {
    const panel = openPanel();
    for (const b of panel.all().filter((c) => c.type === "button")) {
      expect(b.text.trim().split(/\s+/).length, b.text).toBeLessThanOrEqual(2);
      expect(b.helpTip.length, b.text).toBeGreaterThan(10);
    }
  });
});

describe("«Annulla»", () => {
  it("is off until Claude changed something", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    expect(panel.find("button", "Annulla").enabled).toBe(false);
    serveOne(agent, "look", "comp_info", { mutates: false });
    refresh();
    expect(panel.find("button", "Annulla").enabled).toBe(false);
  });

  it("names the action, asks, and runs Edit > Undo once", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "a", "layer.create_null", { title: "crea oggetto nullo" });
    serveOne(agent, "b", "comp_info", { mutates: false });
    refresh();
    const undo = panel.find("button", "Annulla");
    expect(undo.enabled).toBe(true);
    undo.onClick!();
    expect(engine.dialogs.shown[0]).toContain("«crea oggetto nullo»");
    expect(engine.dialogs.shown[0]).toContain("cronologia");
    expect(engine.app.commands).toEqual([16]);
    expect(historyRows(panel)[1]).toContain("annullata");
    expect(undo.enabled).toBe(false);
  });

  it("does nothing when the user says no", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    serveOne(agent, "a", "layer.create_null");
    refresh();
    engine.dialogs.answer = false;
    panel.find("button", "Annulla").onClick!();
    expect(engine.app.commands).toEqual([]);
  });
});

describe("«Ripristino»", () => {
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
    expect(panel.find("button", /^Ripristino$/).enabled).toBe(false);
    panel.find("button", /^Ripristino$/).onClick!();
    expect(panel.says()).toContain("Salva prima il progetto");
    expect(engine.app.project.saves).toBe(0);
  });

  it("saves, then copies into _parlez-checkpoints under a name checkpoint.list reads", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", /^Ripristino$/).onClick!();
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
    expect(panel.says()).toContain("Ripristino creato");
  });

  it("never overwrites: a second one in the same second gets « (2)»", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", /^Ripristino$/).onClick!();
    panel.find("button", /^Ripristino$/).onClick!();
    const names = readdirSync(path.join(dir, DEFAULT_CHECKPOINT_SUBDIR)).sort();
    expect(names).toHaveLength(2);
    const parsed = names.map((n) => parseCheckpointName(n, "ShotA")!);
    expect(parsed.every((p) => p !== null)).toBe(true);
    if (parsed[0].stamp === parsed[1].stamp) {
      expect(parsed.map((p) => p.copy).sort()).toEqual([1, 2]);
    }
  });

  it("refuses .aepx, whose copy would not open as .aep", () => {
    openProject("ShotA.aepx");
    const panel = openPanel();
    panel.find("button", /^Ripristino$/).onClick!();
    expect(panel.says()).toContain(".aep");
    expect(engine.app.project.saves).toBe(0);
  });

  it("«Ripristini» opens the folder, or says there is none yet", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", "Ripristini").onClick!();
    expect(panel.says()).toContain("Nessun punto di ripristino");
    expect(EsFolder.executed).toEqual([]);
    panel.find("button", /^Ripristino$/).onClick!();
    panel.find("button", "Ripristini").onClick!();
    expect(EsFolder.executed).toEqual([
      path.join(dir, DEFAULT_CHECKPOINT_SUBDIR).replace(/\\/g, "/"),
    ]);
  });
});

describe("«Storico» and «Cassetta»", () => {
  it("«Storico» opens this session's history file once there is one", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    panel.find("button", "Storico").onClick!();
    expect(panel.says()).toContain("Nessuna richiesta registrata");
    serveOne(agent, "a", "layer.create_null");
    refresh();
    panel.find("button", "Storico").onClick!();
    expect(EsFile.executed).toEqual([agent.state.historyPath]);
  });

  it("«Cassetta» is off without an agent and opens the instance folder with one", () => {
    const off = openPanel();
    expect(off.find("button", "Cassetta").enabled).toBe(false);
    const agent = startAgent();
    const panel = openPanel();
    panel.find("button", "Cassetta").onClick!();
    expect(EsFolder.executed).toEqual([agent.state.dir]);
  });
});

describe("docking and refreshing", () => {
  it("builds into the Panel it is given, dark, and opens no window", () => {
    const panel = openPanel();
    expect(windows).toHaveLength(0);
    expect(panel.graphics.backgroundColor?.color.slice(0, 3)).toEqual([0.18, 0.18, 0.18]);
    expect(panel.find("statictext", "Parlez!")).toBeTruthy();
  });

  it("opens a floating window titled Parlez! when run as a plain script, and stops refreshing when it closes", () => {
    engine.run(PANEL_SRC, {}, { Panel: FakePanel, Window: FakeWindow, ScriptUI: SCRIPTUI });
    expect(windows).toHaveLength(1);
    expect(windows[0].type).toBe("window:palette");
    expect(windows[0].text).toBe("Parlez!");
    expect(windows[0].shown).toBe(true);
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(1);
    windows[0].close();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
    expect((engine.global.AE_MCP_PANEL as { onAgent: unknown }).onAgent).toBeNull();
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

  it("stops its timer and the agent's redraws once its controls are gone", () => {
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
    expect((engine.global.AE_MCP_PANEL as { onAgent: unknown }).onAgent).toBeNull();
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
