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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_JSX,
  AGENT_STUB_FILENAME,
  PANEL_IMAGES_DIR,
  PANEL_JSX,
  PAUSE_SETTINGS_KEY,
  PAUSE_SETTINGS_SECTION,
  READ_ONLY_SETTINGS_KEY,
} from "../src/config.js";
import { DEFAULT_CHECKPOINT_SUBDIR, parseCheckpointName } from "../src/operations/checkpoint.js";
import { panelSource } from "../src/panel-install.js";
import {
  EsFile,
  EsFolder,
  type EsEngine,
  loadJsx,
  makeEngine,
} from "./helpers/extendscript-shim.js";

/** Counts every write to a control's `text`, to prove the timer writes only changes. */
let textWrites = 0;
/** A control type whose creation throws, to see how the panel reports it. */
let failOn: string | null = null;

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
  image: { normal: string; disabled: string; pressed: string; rollover: string } | null = null;
  props: Record<string, unknown> | null = null;
  active = true;
  add(type: string, _bounds?: unknown, content?: unknown, props?: Record<string, unknown>): Ctl {
    // As After Effects does (AE 26.5, 2026-10-28): an iconbutton without a
    // picture is a "Bad argument", and so is whatever a test asks to fail.
    if ((type === "iconbutton" && !content) || type === failOn) throw new Error("Bad argument");
    const c = new Ctl(type, typeof content === "string" ? content : "");
    if (content && typeof content === "object") c.image = content as Ctl["image"];
    c.props = props ?? null;
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
  /** The one ON / OFF control: the picture button (or, without pictures, a plain one). */
  toggle(): Ctl {
    const hit = this.all().find(
      (c) => c.type === "iconbutton" || (c.type === "button" && /^(ON|OFF)$/.test(c.text)),
    );
    if (!hit) throw new Error("no ON/OFF control");
    return hit;
  }
  /** Which picture it shows: on, off, busy, idle. */
  look(): string {
    const block = this.toggle();
    if (block.image === null) return block.text === "OFF" ? "off" : "on";
    return path.basename(block.image.normal).replace(/(-small)?\.png$/, "");
  }
  word(): string {
    return this.look() === "off" ? "OFF" : "ON";
  }
  /** The traffic-light colour of that picture. */
  color(): number[] {
    return { on: GREEN, off: RED, busy: YELLOW, idle: GREY }[this.look()]!;
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
  failOn = null;
  systemCalls = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PANEL_SRC = readFileSync(PANEL_JSX, "utf8");
/** What install-panel writes: the same file with the pictures' folder filled in. */
let INSTALLED_SRC = "";
beforeAll(async () => {
  INSTALLED_SRC = await panelSource();
});
const SCRIPTUI = {
  newFont: (_f: string, style: string, size: number) => ({ style, size }),
  newImage: (normal: string, disabled: string, pressed: string, rollover: string) => ({
    normal,
    disabled,
    pressed,
    rollover,
  }),
};

/** Commands the panel handed to the operating system (system.callSystem). */
let systemCalls: string[] = [];
const SYSTEM = {
  callSystem: (cmd: string) => {
    systemCalls.push(cmd);
    return "";
  },
};

function openPanel(source = INSTALLED_SRC): Ctl {
  const panel = new FakePanel("panel");
  engine.run(source, panel, {
    Panel: FakePanel,
    Window: FakeWindow,
    ScriptUI: SCRIPTUI,
    system: SYSTEM,
  });
  return panel;
}

function settle() {
  (engine.global.AE_MCP_PANEL as { settle: () => void }).settle();
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

/**
 * Steps of a timer chain still booked (the one-shot size check is not one).
 * Since 0.2 no timer repeats: each step books the next.
 */
function activeTasks(code: string) {
  return engine.app
    .pendingTasks()
    .filter((t) => t.code.includes(code) && t.code.includes(".step("));
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
    ]) {
      expect(code.includes(banned), banned).toBe(false);
    }
    // Mouse listeners only on the signature text, where nothing depends on them.
    const listened = code.match(/([\w.]+)\.addEventListener\(/g) ?? [];
    expect(new Set(listened)).toEqual(new Set(["ui.credit.addEventListener("]));
  });

  it("uses only group, statictext, iconbutton, button and checkbox", () => {
    const kinds = new Set(
      openPanel()
        .all()
        .map((c) => c.type),
    );
    expect([...kinds].sort()).toEqual(["button", "checkbox", "group", "iconbutton", "statictext"]);
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
    engine.run(
      INSTALLED_SRC,
      {},
      {
        Panel: FakePanel,
        Window: FakeWindow,
        ScriptUI: SCRIPTUI,
        system: SYSTEM,
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

  it("docked: builds into the Panel it is given and opens no window", () => {
    openPanel();
    expect(windows).toHaveLength(0);
  });
});

describe("the look (2026-10-26 screenshot)", () => {
  it("has no title inside: the tab already says Parlez!; only the signature names it", () => {
    const panel = openPanel();
    const named = panel.all().filter((c) => c.text.includes("Parlez!"));
    expect(named.map((c) => [c.type, c.text])).toEqual([
      ["statictext", "Parlez! by Another Perspective"],
    ]);
    expect(PANEL_SRC).toContain('"Tahoma"');
  });

  it("has a minimum size fitting its content, docked or floating, vertical or compact", () => {
    const vertical = openPanel();
    expect(vertical.minimumSize).toEqual([224, 380]);
    expect(vertical.preferredSize).toEqual([224, 380]);
    setSetting("layout", "compatta");
    const compact = openPanel();
    expect(compact.minimumSize).toEqual([760, 210]);
    engine.run(
      INSTALLED_SRC,
      {},
      {
        Panel: FakePanel,
        Window: FakeWindow,
        ScriptUI: SCRIPTUI,
        system: SYSTEM,
      },
    );
    expect(windows[0].minimumSize).toEqual([760, 210]);
    expect(windows[0].layouts).toBeGreaterThan(0);
  });

  it("never squeezes the ON/OFF picture, and lays out again when resized", () => {
    const panel = openPanel();
    const block = panel.toggle();
    expect(block.minimumSize).toEqual(block.preferredSize);
    expect(block.maximumSize).toEqual(block.preferredSize);
    expect(block.alignment).toEqual(["center", "top"]);
    let resized = 0;
    panel.layout.resize = () => {
      resized++;
    };
    (panel.onResizing as () => void)();
    (panel.onResize as () => void)();
    expect(resized).toBe(2);
  });

  it("one control does ON/OFF: a picture toolbutton, no frame, no twin", () => {
    const panel = openPanel();
    const block = panel.toggle();
    expect(block.type).toBe("iconbutton");
    expect(block.props).toEqual({ style: "toolbutton" });
    expect(block.preferredSize).toEqual([200, 56]);
    expect(panel.all().filter((c) => /^(ON|OFF|Accendi|Spegni)$/.test(c.text))).toHaveLength(0);
    expect(panel.all().filter((c) => c.type === "iconbutton" && c !== credit(panel))).toHaveLength(
      1,
    );
    expect(panel.look()).toBe("off");
    block.onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("1");
    expect(panel.word()).toBe("ON");
    // Nothing stays highlighted after the click.
    expect(block.active).toBe(false);
  });

  it("each picture comes with its mouse-over and pressed versions, all present", () => {
    const panel = openPanel();
    const image = panel.toggle().image!;
    expect(path.basename(image.normal)).toBe("off-small.png");
    expect(path.basename(image.rollover)).toBe("off-over-small.png");
    expect(path.basename(image.pressed)).toBe("off-down-small.png");
    for (const f of [image.normal, image.rollover, image.pressed]) expect(existsSync(f)).toBe(true);
    expect(path.resolve(path.dirname(image.normal))).toBe(path.resolve(PANEL_IMAGES_DIR));
  });

  it("without the pictures it falls back to a plain button reading ON / OFF", () => {
    const panel = openPanel(PANEL_SRC);
    const block = panel.toggle();
    expect(block.type).toBe("button");
    expect(block.text).toBe("OFF");
    block.onClick!();
    expect(block.text).toBe("ON");
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
    expect(counts.text).toMatch(/^eseguite 0 · rifiutate 0 · nessuna richiesta · shotA v4$/);
    // The signature: in a group that takes all the space left, glued to its
    // bottom-right corner, and that group is the panel's last child.
    const sig = credit(panel);
    expect(sig.alignment).toEqual(["right", "bottom"]);
    const foot = panel.all().find((c) => c.children.includes(sig))!;
    expect(foot.alignment).toEqual(["fill", "fill"]);
    expect(panel.children[panel.children.length - 1]).toBe(foot);
  });

  it("buttons: three rows of two, same width (2026-11-15: narrower)", () => {
    const panel = openPanel();
    const names = ["Annulla", "Ripristino", "Elenco", "Storico", "Cassetta", "Vista"];
    const buttons = names.map((n) => panel.find("button", new RegExp(`^${n}$`)));
    const rows = new Set(buttons.map((b) => panel.all().find((c) => c.children.includes(b))));
    expect(rows.size).toBe(3);
    for (const r of rows) expect(r!.children.filter((c) => c.type === "button")).toHaveLength(2);
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
    expect(left.all()).toContain(panel.toggle());
    expect(panel.toggle().preferredSize).toEqual([200, 56]);
    expect(path.basename(panel.toggle().image!.normal)).toBe("off-small.png");
    expect(middle.children[0].text).toBe("Ultime richieste");
    expect(right.all().some((c) => c.text === "Annulla")).toBe(true);
  });
});

/** The signature. */
function credit(panel: Ctl): Ctl {
  return panel.find("statictext", "Parlez! by Another Perspective");
}

describe("the signature", () => {
  it("is text, very light grey, never a button", () => {
    const panel = openPanel();
    const sig = credit(panel);
    expect(sig.type).toBe("statictext");
    expect(sig.alignment).toEqual(["right", "bottom"]);
    expect(sig.graphics.foregroundColor).toEqual({ color: [0.86, 0.86, 0.86] });
    expect(sig.helpTip).toContain("https://www.anotherperspectivepictures.com");
    expect(panel.all().filter((c) => c.type === "iconbutton")).toHaveLength(1);
  });

  it("turns pure white under the mouse and back when it leaves", () => {
    const sig = credit(openPanel());
    sig.fire("mouseover");
    expect(sig.graphics.foregroundColor).toEqual({ color: [1, 1, 1] });
    sig.fire("mouseout");
    expect(sig.graphics.foregroundColor).toEqual({ color: [0.86, 0.86, 0.86] });
  });

  it("a press (mousedown, not click) opens the site in the user's browser", () => {
    const sig = credit(openPanel());
    expect(sig.listeners.click).toBeUndefined();
    sig.fire("mousedown");
    expect(systemCalls).toEqual(['cmd /c start "" "https://www.anotherperspectivepictures.com"']);
    expect(PANEL_SRC).toContain('system.callSystem("open \\"" + SITE_URL');
    expect(PANEL_SRC).toContain('var SITE_URL = "https://www.anotherperspectivepictures.com";');
  });

  it("ignores firma.png: the picture made it look like a button", async () => {
    const panel = openPanel(await sourceWithSignature());
    expect(credit(panel).type).toBe("statictext");
  });
});

/** A pictures' folder with every generated picture, plus firma.png. */
async function sourceWithSignature(): Promise<string> {
  const dir = path.join(tmp, "images");
  mkdirSync(dir);
  for (const name of readdirSync(PANEL_IMAGES_DIR)) {
    writeFileSync(path.join(dir, name), readFileSync(path.join(PANEL_IMAGES_DIR, name)));
  }
  writeFileSync(path.join(dir, "firma.png"), "png", "utf8");
  return panelSource(PANEL_JSX, dir);
}

describe("a failure while building shows in the panel, which still opens", () => {
  it("names the block and the error, and the rest keeps working", () => {
    setEnabled("1");
    failOn = "checkbox";
    const panel = openPanel();
    expect(panel.says()).toMatch(
      /una parte del pannello non si è aperta\. riquadro.*: Bad argument/,
    );
    // The block itself was built before the failing checkbox, and toggles.
    panel.toggle().onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("0");
  });

  it("says nothing when everything opened", () => {
    expect(openPanel().says()).not.toContain("non si è aperta");
  });
});

describe("undocking: never collapsed (AE 26.5, 2026-10-27)", () => {
  it("every top-level group asks for a size, not just «fill»", () => {
    for (const layout of ["verticale", "compatta"]) {
      setSetting("layout", layout);
      const panel = openPanel();
      for (const child of panel.children) {
        const min = child.minimumSize as number[] | undefined;
        expect(min, `${layout}: ${child.type}`).toBeDefined();
        expect(min![0] * min![1], `${layout}: ${child.type}`).toBeGreaterThan(0);
      }
    }
  });

  it("lays out, then resizes, after every child is in", () => {
    let calls: string[] = [];
    const panel = new FakePanel("panel");
    panel.layout = {
      layout: () => {
        calls.push("layout");
      },
      resize: () => {
        calls.push("resize");
      },
    };
    engine.run(INSTALLED_SRC, panel, {
      Panel: FakePanel,
      Window: FakeWindow,
      ScriptUI: SCRIPTUI,
      system: SYSTEM,
    });
    expect(calls.slice(0, 2)).toEqual(["layout", "resize"]);
    calls = [];
  });

  it("schedules one check right after opening, and grows a collapsed panel back", () => {
    const panel = openPanel();
    const once = engine.app.tasks.filter((t) => !t.repeat && t.code.includes("settle"));
    expect(once).toHaveLength(1);
    panel.size = [24, 24];
    settle();
    expect(panel.size).toEqual([224, 380]);
  });

  it("does the same when shown and from the timer", () => {
    const panel = openPanel();
    panel.size = [20, 30];
    (panel.onShow as () => void)();
    expect(panel.size).toEqual([224, 380]);
    panel.size = [20, 30];
    refresh();
    expect(panel.size).toEqual([224, 380]);
  });

  it("leaves a narrow column the user docked it in alone", () => {
    const panel = openPanel();
    panel.size = [260, 900];
    settle();
    refresh();
    expect(panel.size).toEqual([260, 900]);
  });

  it("gives up after three tries, so it never fights After Effects from the timer", () => {
    const panel = openPanel();
    const before = panel.layouts;
    for (let i = 0; i < 6; i++) {
      panel.size = [10, 10];
      settle();
    }
    // Three fixes, plus the one layout after opening (settleOnce).
    expect(panel.layouts - before).toBe(4);
  });

  it("lays itself out once after opening, so the signature sits at the bottom (2026-11-15)", () => {
    const panel = openPanel();
    const before = panel.layouts;
    settle();
    settle();
    expect(panel.layouts - before).toBe(1);
  });

  it("lays itself out again after Riavvia, whose message can change its height", () => {
    setEnabled("1");
    const panel = openPanel();
    settle();
    const before = panel.layouts;
    panel.find("button", "Riavvia").onClick!();
    expect(panel.layouts - before).toBeGreaterThanOrEqual(1);
  });
});

describe("no safe mode in the panel", () => {
  it("has no «Sicura» box, no safeMode setting, no marker file", () => {
    const panel = openPanel();
    expect(() => panel.find("checkbox", "Sicura")).toThrow();
    for (const gone of ["safeMode", "Sicura", "sicura", "pannello-in-apertura"]) {
      expect(PANEL_SRC.includes(gone), gone).toBe(false);
    }
    expect(existsSync(path.join(tmp, "userData", "Parlez"))).toBe(false);
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
  it("sits inset from the panel's edge, so its focus outline is never cut (both views)", () => {
    for (const layout of ["verticale", "compatta"]) {
      setSetting("layout", layout);
      const panel = openPanel();
      const box = panel.find("checkbox", "Sola lettura");
      const holder = panel.all().find((c) => c.children.includes(box))!;
      expect(holder.type, layout).toBe("group");
      expect(holder.margins, layout).toEqual([10, 2, 10, 2]);
    }
  });

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
    expect(panel.says()).toContain("· shotA v4");
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

// --- The watchdog (Parlez! 0.2) --------------------------------------------
// After Effects 26.5 dropped every pending scheduleTask when a project opened
// (2026-11-14/15): the agent and the panel stopped for good. The shim's
// dropAllTasks() is that; runPending() is time passing.

interface LiveAgent extends Agent {
  state: Agent["state"] & {
    lastTickAt: number;
    lastReviveAt: number;
    lastHeartbeatAt: number;
    lastPanelWatchAt: number;
    restarts: number;
    recent: Array<{ outcome: string; title: string }>;
  };
  watch: (source: string) => boolean;
}

interface PanelTimer {
  timer: { gen: number; lastStepAt: number; closed: boolean };
}

const panelSteps = () => activeTasks("AE_MCP_PANEL");
const agentSteps = () =>
  engine.app.pendingTasks().filter((t) => t.code.includes("AE_MCP_AGENT.step("));
const runPanel = () => engine.runPending((code) => code.includes("AE_MCP_PANEL.step("));
const runAgent = () => engine.runPending((code) => code.includes("AE_MCP_AGENT.step("));
const panelTimer = () => (engine.global.AE_MCP_PANEL as PanelTimer).timer;

/** As if the agent had not stepped for `ms`, and After Effects had dropped its tasks. */
function stopAgent(agent: LiveAgent, ms = 5000) {
  engine.app.dropAllTasks();
  agent.state.lastTickAt = Date.now() - ms;
  agent.state.lastReviveAt = 0;
}

/** As if the panel's timer had not stepped for `ms`. */
function stopPanelTimer(ms = 5000) {
  engine.app.dropAllTasks();
  panelTimer().lastStepAt = Date.now() - ms;
}

/** The panel's chain still going while the agent's was lost. */
function keepPanelTimer(lateBy = 0) {
  panelTimer().lastStepAt = Date.now() - lateBy;
  engine.app.scheduleTask(`$.global.AE_MCP_PANEL.step(${panelTimer().gen})`, 1000, false);
}

/** Make the heartbeat look old, so the panel shows «non risponde». */
function silenceHeartbeat(agent: LiveAgent) {
  const file = path.join(agent.state.dir, "heartbeat.json");
  const hb = JSON.parse(readFileSync(file, "utf8"));
  hb.ts = Date.now() - 60_000;
  writeFileSync(file, JSON.stringify(hb), "utf8");
}

function restartButton(panel: Ctl): Ctl {
  return panel.find("button", "Riavvia");
}

describe("the watchdog: a chain of one-shot steps", () => {
  it("never a repeating task: each step books the next, once a second", () => {
    openPanel();
    expect(engine.app.tasks.some((t) => t.repeat)).toBe(false);
    expect(panelSteps()).toHaveLength(1);
    expect(panelSteps()[0].delay).toBe(1000);
    for (let i = 0; i < 4; i++) {
      expect(runPanel()).toBe(1);
      expect(panelSteps()).toHaveLength(1);
    }
  });

  it("a step booked by an earlier opening never revives that chain", () => {
    openPanel();
    const old = panelSteps()[0];
    openPanel();
    // After Effects runs the old step after all.
    old.cancelled = false;
    runPanel();
    expect(panelSteps()).toHaveLength(1);
    runPanel();
    expect(panelSteps()).toHaveLength(1);
  });
});

describe("the watchdog: the panel brings the agent back", () => {
  it("from its timer, and the list says so", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    stopAgent(agent, 12_000);
    keepPanelTimer();
    runPanel();
    expect(agentSteps()).toHaveLength(1);
    runAgent();
    expect(agent.state.restarts).toBe(1);
    refresh();
    expect(historyRows(panel)[0]).toMatch(
      /^\d\d:\d\d {2}Riavviato dopo una finestra di dialogo {2}\d+ s$/,
    );
  });

  it("from a hidden panel too (a docked tab in the background)", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    panel.visible = false;
    stopAgent(agent);
    keepPanelTimer();
    runPanel();
    expect(agentSteps()).toHaveLength(1);
    expect(panelSteps()).toHaveLength(1);
  });

  it("not from a late step: After Effects was blocked for everyone, judge at the next one", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    openPanel();
    stopAgent(agent);
    keepPanelTimer(4000);
    runPanel();
    expect(agentSteps()).toHaveLength(0);
    runPanel();
    expect(agentSteps()).toHaveLength(1);
  });

  it("the agent re-books a lost panel timer", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    openPanel();
    stopPanelTimer();
    expect(panelSteps()).toHaveLength(0);
    agent.state.lastPanelWatchAt = 0;
    agent.tick();
    expect(panelSteps()).toHaveLength(1);
  });

  it("a closed panel stays closed: nobody re-books its timer", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    for (const c of panel.all()) {
      Object.defineProperty(c, "text", {
        get: () => "",
        set() {
          throw new Error("Object is invalid");
        },
      });
    }
    setEnabled("0");
    refresh();
    expect(panelSteps()).toHaveLength(0);
    panelTimer().lastStepAt = Date.now() - 60_000;
    agent.state.lastPanelWatchAt = 0;
    agent.tick();
    expect(panelSteps()).toHaveLength(0);
  });
});

describe("the watchdog: when After Effects dropped both timers, the next click", () => {
  it("brings both back and does nothing else, then the switch works again", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    stopAgent(agent);
    panelTimer().lastStepAt = Date.now() - 5000;
    panel.toggle().onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("1");
    expect(panel.says()).toContain("Parlez! era fermo e l'ho fatto ripartire");
    expect(agentSteps()).toHaveLength(1);
    expect(panelSteps()).toHaveLength(1);
    runAgent();
    panel.toggle().onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("0");
  });

  it("on «Sola lettura» leaves the box as it was", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    stopAgent(agent);
    const box = panel.find("checkbox", "Sola lettura");
    box.value = true;
    box.onClick!();
    expect(setting(READ_ONLY_SETTINGS_KEY)).not.toBe("1");
    expect(box.value).toBe(false);
  });

  it("on the other buttons does not open anything", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    stopAgent(agent);
    panel.find("button", "Cassetta").onClick!();
    expect(EsFolder.executed).toHaveLength(0);
    panel.find("button", "Cassetta").onClick!();
    expect(EsFolder.executed).toHaveLength(1);
  });

  it("a click while everything ticks is just a click", () => {
    setEnabled("1");
    startAgent();
    const panel = openPanel();
    panel.toggle().onClick!();
    expect(setting(PAUSE_SETTINGS_KEY)).toBe("0");
    expect(panel.says()).not.toContain("era fermo");
  });
});

describe("«Riavvia», the last resort", () => {
  it("is always there: a stopped panel cannot make it appear", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    expect(restartButton(panel).visible).toBe(true);
    silenceHeartbeat(agent);
    refresh();
    expect(restartButton(panel).visible).toBe(true);
  });

  it("forces a restart of an agent that can restart itself", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    silenceHeartbeat(agent);
    refresh();
    engine.app.dropAllTasks();
    restartButton(panel).onClick!();
    expect(panel.says()).toContain("Riavvio in corso");
    expect(agentSteps()).toHaveLength(1);
    expect(panelSteps()).toHaveLength(1);
    runAgent();
    expect(agent.state.recent[agent.state.recent.length - 1]).toMatchObject({
      outcome: "restart",
    });
  });

  it("says why when a request is running", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    const panel = openPanel();
    agent.state.busy = true;
    restartButton(panel).onClick!();
    expect(panel.says()).toContain("sta eseguendo una richiesta");
  });

  function writeStub(body: string) {
    const dir = path.join(tmp, "userData", "Adobe", "After Effects", "26.5", "Scripts", "Startup");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, AGENT_STUB_FILENAME), body, "utf8");
  }

  it("with no agent at all, loads the startup script again", () => {
    setEnabled("1");
    writeStub(
      '$.global.AE_MCP_AGENT = { state: { id: "dallo-stub", agentVersion: 4 }, watch: function () { return false; } };',
    );
    const panel = openPanel();
    expect(panel.says()).toContain("non collegato");
    restartButton(panel).onClick!();
    expect((engine.global.AE_MCP_AGENT as Agent).state.id).toBe("dallo-stub");
    expect(panel.says()).toContain("Parlez! caricato di nuovo");
  });

  it("without the startup script, says to reinstall", () => {
    setEnabled("1");
    const panel = openPanel();
    restartButton(panel).onClick!();
    expect(panel.says()).toContain("Non trovo lo script di avvio");
  });

  it("an agent of an earlier build that cannot restart itself: the startup script, never two agents", () => {
    setEnabled("1");
    const earlier = {
      state: { id: "ae-old999", agentVersion: 3, busy: false, lastHeartbeatAt: Date.now() },
    };
    engine.global.AE_MCP_AGENT = earlier;
    // The real stub loads agent.jsx, which leaves a live agent alone.
    writeStub("if (!$.global.AE_MCP_AGENT) $.global.AE_MCP_AGENT = { state: { id: 'nuovo' } };");
    const panel = openPanel();
    restartButton(panel).onClick!();
    expect(engine.global.AE_MCP_AGENT).toBe(earlier);
    expect(panel.says()).toContain("risponde già");
  });
});

describe("the watchdog and the rest agree", () => {
  it("names the startup script as install-agent writes it", () => {
    expect(PANEL_SRC).toContain(`"${AGENT_STUB_FILENAME}"`);
  });
});

describe("driven by the sveglia (cep/sveglia)", () => {
  function installSveglia() {
    mkdirSync(
      path.join(
        tmp,
        "userData",
        "Adobe",
        "CEP",
        "extensions",
        "com.anotherperspective.parlez.sveglia",
      ),
      { recursive: true },
    );
  }
  const panelPulse = () => (engine.global.AE_MCP_PANEL as { pulse: () => void }).pulse();

  it("with the sveglia installed, the panel books no timer of its own", () => {
    installSveglia();
    openPanel();
    expect(panelSteps()).toHaveLength(0);
  });

  it("a pulse refreshes it (at most once a second) and ends its own chain", () => {
    setEnabled("1");
    const panel = openPanel();
    expect(panelSteps()).toHaveLength(1);
    setEnabled("0");
    panelTimer().lastStepAt = 0;
    panelPulse();
    expect(panel.word()).toBe("OFF");
    expect(panelSteps()).toHaveLength(0);
    setEnabled("1");
    panelPulse();
    expect(panel.word()).toBe("OFF");
  });

  it("while pulsed, nobody re-books its timer", () => {
    setEnabled("1");
    const agent = startAgent() as LiveAgent;
    openPanel();
    engine.global.AE_MCP_SVEGLIA_AT = Date.now();
    stopPanelTimer();
    agent.state.lastPanelWatchAt = 0;
    agent.tick();
    expect(panelSteps()).toHaveLength(0);
  });
});
