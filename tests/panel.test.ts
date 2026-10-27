// The Parlez! panel (jsx/panel.jsx) run unchanged inside the ExtendScript
// stand-in, with a bare-bones ScriptUI: enough to find the controls, click
// them and read what they say. The real look and docking can only be checked
// in After Effects.

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

/** Counts every write to a control's `text`, to prove the timer writes only changes. */
let textWrites = 0;

class Ctl {
  children: Ctl[] = [];
  private _text: string;
  value = false;
  enabled = true;
  visible = true;
  shown = false;
  closed = false;
  helpTip = "";
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
  layouts = 0;
  layout = {
    layout: () => {
      this.layouts++;
    },
    resize: () => {},
  };
  listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  onClick?: () => void;
  onClose?: () => void;
  [key: string]: unknown;

  constructor(
    readonly type: string,
    text = "",
  ) {
    this._text = text;
  }
  get text(): string {
    return this._text;
  }
  set text(v: string) {
    textWrites++;
    this._text = v;
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
  /** The one ON / OFF control: a native button. */
  toggle(): Ctl {
    return this.find("button", /^(ON|OFF)$/);
  }
  word(): string {
    return this.toggle().text;
  }
  /** The coloured frame around it: the traffic light. */
  face(): Ctl {
    const block = this.toggle();
    return this.all().find((c) => c.children.includes(block))!;
  }
  color(): number[] | null {
    return this.face().graphics.backgroundColor?.color.slice(0, 3) ?? null;
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
  textWrites = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PANEL_SRC = readFileSync(PANEL_JSX, "utf8");
const SCRIPTUI = { newFont: (_f: string, style: string, size: number) => ({ style, size }) };
const MARKER = () => path.join(tmp, "userData", "Parlez", "pannello-in-apertura.txt");

function openPanel(): Ctl {
  const panel = new FakePanel("panel");
  engine.run(PANEL_SRC, panel, { Panel: FakePanel, Window: FakeWindow, ScriptUI: SCRIPTUI });
  return panel;
}

function refresh() {
  (engine.global.AE_MCP_PANEL as { refresh: () => void }).refresh();
}

function setting(key: string): string | undefined {
  return engine.app.settings.peek(PAUSE_SETTINGS_SECTION, key);
}

function setSetting(key: string, v: string) {
  engine.app.settings.saveSetting(PAUSE_SETTINGS_SECTION, key, v);
}

const setEnabled = (v: string) => setSetting(PAUSE_SETTINGS_KEY, v);

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

describe("stability: only standard controls, no custom painting (2026-10-26 crashes)", () => {
  it("has no onDraw, no painting calls, no update(), no rebuilding", () => {
    const code = PANEL_SRC.split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    for (const banned of [
      "onDraw",
      "drawString",
      "fillPath",
      "drawOSControl",
      "measureString",
      ".update(",
      "win.remove(",
      "addEventListener",
    ]) {
      expect(code.includes(banned), banned).toBe(false);
    }
  });

  it("uses only group, statictext, button and checkbox", () => {
    const kinds = new Set(
      openPanel()
        .all()
        .map((c) => c.type),
    );
    expect([...kinds].sort()).toEqual(["button", "checkbox", "group", "statictext"]);
  });

  it("the timer writes nothing when nothing changed", () => {
    setEnabled("1");
    startAgent();
    openPanel();
    refresh();
    textWrites = 0;
    refresh();
    refresh();
    expect(textWrites).toBe(0);
  });

  it("the timer does nothing while the panel is hidden", () => {
    setEnabled("1");
    const panel = openPanel();
    panel.visible = false;
    setEnabled("0");
    refresh();
    expect(panel.word()).toBe("ON");
    panel.visible = true;
    refresh();
    expect(panel.word()).toBe("OFF");
  });

  it("refreshes every 1-2 seconds, one timer however often the panel is opened", () => {
    openPanel();
    openPanel();
    openPanel();
    const tasks = activeTasks("AE_MCP_PANEL");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].delay).toBeGreaterThanOrEqual(1000);
    expect(tasks[0].delay).toBeLessThanOrEqual(2000);
  });

  it("stops its timer once its controls are gone", () => {
    const panel = openPanel();
    for (const c of panel.all()) {
      Object.defineProperty(c, "text", {
        get: () => "",
        set() {
          throw new Error("Object is invalid");
        },
      });
    }
    setEnabled("1");
    refresh();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
  });

  it("run as a plain script: a palette window whose timer stops when it closes", () => {
    engine.run(PANEL_SRC, {}, { Panel: FakePanel, Window: FakeWindow, ScriptUI: SCRIPTUI });
    expect(windows).toHaveLength(1);
    expect(windows[0].type).toBe("window:palette");
    expect(windows[0].text).toBe("Parlez!");
    expect(windows[0].shown).toBe(true);
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(1);
    windows[0].close();
    expect(activeTasks("AE_MCP_PANEL")).toHaveLength(0);
  });

  it("docked: builds into the Panel it is given and opens no window", () => {
    openPanel();
    expect(windows).toHaveLength(0);
  });
});

describe("the look (2026-10-26 screenshot)", () => {
  it("the title is bold and bigger, in a named family a statictext honours", () => {
    const panel = openPanel();
    expect(panel.find("statictext", "Parlez!").graphics.font).toEqual({ style: "BOLD", size: 24 });
    expect(PANEL_SRC).toContain('"Tahoma"');
  });

  it("one control does ON/OFF: a native button inside the coloured frame, no twin", () => {
    const panel = openPanel();
    const block = panel.toggle();
    expect(block.type).toBe("button");
    expect(block.preferredSize[0]).toBeGreaterThanOrEqual(180);
    expect(block.preferredSize[1]).toBeGreaterThanOrEqual(56);
    expect(block.graphics.font).toEqual({ style: "BOLD", size: 32 });
    expect(panel.face().margins).toBeGreaterThanOrEqual(6);
    expect(panel.all().filter((c) => /^(ON|OFF|Accendi|Spegni)$/.test(c.text))).toHaveLength(1);
    block.onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("1");
    expect(panel.word()).toBe("ON");
  });

  it("the status line under the block is centred and grey, said once", () => {
    const panel = openPanel();
    const status = panel.find("statictext", "Claude fermo");
    expect(status.justify).toBe("center");
    expect(panel.says().match(/Claude fermo/g)).toHaveLength(1);
  });

  it("the bottom: counters on one line, the signature bottom right", () => {
    setEnabled("1");
    startAgent();
    const panel = openPanel();
    const counts = panel.find("statictext", /^eseguite /);
    expect(counts.text).toMatch(/^eseguite 0 · rifiutate 0 · nessuna richiesta · shotA v3$/);
    const credit = panel.find("statictext", "Parlez! by Another Perspective");
    expect(credit.justify).toBe("right");
    const foot = panel.all().find((c) => c.children.includes(credit))!;
    expect(foot.children[foot.children.length - 1]).toBe(credit);
    const tail = panel.all().find((c) => c.children.includes(foot))!;
    expect(tail.children[tail.children.length - 1]).toBe(foot);
  });

  it("buttons: two rows of three, same width", () => {
    const panel = openPanel();
    const names = ["Annulla", "Ripristino", "Elenco", "Storico", "Cassetta", "Vista"];
    const buttons = names.map((n) => panel.find("button", new RegExp(`^${n}$`)));
    const rows = new Set(buttons.map((b) => panel.all().find((c) => c.children.includes(b))));
    expect(rows.size).toBe(2);
    for (const r of rows) expect(r!.children.filter((c) => c.type === "button")).toHaveLength(3);
    expect(new Set(buttons.map((b) => b.preferredSize.width)).size).toBe(1);
    expect(() => panel.find("button", "Ripristini")).toThrow();
  });

  it("an empty history takes one line; the first request opens it, with one layout", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    const box = panel.all().find((c) => c.children.some((k) => k.text === "Ultime richieste"))!;
    const rows = box.children.slice(1);
    expect(rows.filter((r) => r.visible)).toHaveLength(1);
    const layoutsBefore = panel.layouts;
    serveOne(agent, "a", "layer.create_null");
    refresh();
    expect(rows.every((r) => r.visible)).toBe(true);
    expect(panel.layouts).toBe(layoutsBefore + 1);
    refresh();
    serveOne(agent, "b", "layer.create_null");
    refresh();
    expect(panel.layouts).toBe(layoutsBefore + 1);
  });

  it("the compact view: block on the left, history in the middle, buttons on the right", () => {
    setSetting("layout", "compatta");
    const panel = openPanel();
    expect(panel.orientation).toBe("row");
    const [left, middle, right] = panel.children;
    expect(left.all()).toContain(panel.face());
    expect(middle.children[0].text).toBe("Ultime richieste");
    expect(right.all().some((c) => c.text === "Annulla")).toBe(true);
  });
});

describe("safe mode", () => {
  function coloured(panel: Ctl): Ctl[] {
    return [panel, ...panel.all()].filter(
      (c) =>
        c.graphics.backgroundColor !== null ||
        c.graphics.foregroundColor !== null ||
        c.graphics.font !== null,
    );
  }

  it("normally: dark background and a coloured block", () => {
    const panel = openPanel();
    expect(panel.graphics.backgroundColor?.color.slice(0, 3)).toEqual([0.18, 0.18, 0.18]);
    expect(panel.color()).toEqual(RED);
  });

  it("with «Sicura» saved: no colours, no fonts, the button still says ON/OFF", () => {
    setSetting("safeMode", "1");
    const panel = openPanel();
    expect(coloured(panel)).toEqual([]);
    expect(panel.word()).toBe("OFF");
    expect(panel.says()).toContain("Claude fermo");
    expect(panel.find("checkbox", "Sicura").value).toBe(true);
  });

  it("the box saves the choice for the next opening", () => {
    const panel = openPanel();
    const box = panel.find("checkbox", "Sicura");
    box.value = true;
    box.onClick!();
    expect(setting("safeMode")).toBe("1");
    expect(panel.says()).toContain("prossima apertura");
  });

  it("switches itself on when the previous opening never finished", () => {
    mkdirSync(path.dirname(MARKER()), { recursive: true });
    writeFileSync(MARKER(), "left behind by a crash", "utf8");
    const panel = openPanel();
    expect(coloured(panel)).toEqual([]);
    expect(setting("safeMode")).toBe("1");
    expect(panel.says()).toContain("Modalità sicura");
  });

  it("a normal opening leaves no marker behind", () => {
    openPanel();
    expect(existsSync(MARKER())).toBe(false);
  });
});

describe("the ON / OFF switch", () => {
  it("starts on OFF, red, «Claude fermo», and saves that first choice", () => {
    expect(setting(PAUSE_SETTINGS_KEY)).toBeUndefined();
    const panel = openPanel();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("0");
    expect(panel.word()).toBe("OFF");
    expect(panel.color()).toEqual(RED);
    expect(panel.says()).toContain("Claude fermo");
  });

  it("is one click each way, and a new opening shows the saved choice", () => {
    const panel = openPanel();
    panel.toggle().onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("1");
    expect(panel.word()).toBe("ON");

    const again = openPanel();
    expect(again.word()).toBe("ON");
    again.toggle().onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("0");
    expect(again.word()).toBe("OFF");
  });

  it("says so when After Effects does not keep the choice", () => {
    engine.app.settings.saveSetting = () => {
      throw new Error("prefs locked");
    };
    const panel = openPanel();
    expect(panel.says()).toContain("Non riesco a salvare");
    panel.toggle().onClick!();
    expect(panel.word()).toBe("OFF");
  });
});

describe("panel and agent can never disagree (the 2026-10-25 defect)", () => {
  it("for every value of the switch, the panel and the heartbeat say the same", () => {
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
    panel.toggle().onClick!();
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

  it("is yellow «sta elaborando» while the agent says busy", () => {
    setEnabled("1");
    const agent = startAgent();
    const panel = openPanel();
    agent.state.busy = true;
    refresh();
    expect(panel.color()).toEqual(YELLOW);
    expect(panel.says()).toContain("sta elaborando");
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
    expect(setting(READ_ONLY_SETTINGS_KEY)).toBe("1");
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
    expect(panel.says()).toContain("· shotA v3");
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
});

describe("the two layouts", () => {
  it("vertical by default with 8 rows; «Vista» saves compact for the next opening", () => {
    setEnabled("1");
    const agent = startAgent();
    for (let i = 0; i < 10; i++) serveOne(agent, `r${i}`, `op_${i}`);
    const vertical = openPanel();
    expect(vertical.orientation).toBe("column");
    expect(historyRows(vertical)).toHaveLength(8);
    vertical.find("button", "Vista").onClick!();
    expect(setting("layout")).toBe("compatta");
    // Not rebuilt while open.
    expect(vertical.orientation).toBe("column");
    expect(vertical.says()).toContain("riapri il pannello");

    const compact = openPanel();
    expect(compact.orientation).toBe("row");
    expect(historyRows(compact)).toHaveLength(5);
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

describe("«Ripristino» and «Elenco»", () => {
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

  it("«Elenco» opens the folder, or says there is none yet", () => {
    const dir = openProject();
    const panel = openPanel();
    panel.find("button", "Elenco").onClick!();
    expect(panel.says()).toContain("Nessun punto di ripristino");
    expect(EsFolder.executed).toEqual([]);
    panel.find("button", /^Ripristino$/).onClick!();
    panel.find("button", "Elenco").onClick!();
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
