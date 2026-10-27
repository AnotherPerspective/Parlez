// The minimal undock-diagnosis panels (jsx/diagnostica-sgancio-*.jsx): A and
// B open docked and as a window and differ only by the "fill" group; C, D, E
// are the bisection steps towards the real panel (picture button, timer,
// whole structure).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PANEL_FILENAME } from "../src/config.js";
import { panelSource } from "../src/panel-install.js";
import { type EsEngine, makeEngine } from "./helpers/extendscript-shim.js";

class Ctl {
  children: Ctl[] = [];
  text: string;
  size = [300, 200];
  shown = false;
  preferredSize: unknown = { width: 0, height: 0 };
  layouts = 0;
  layout = {
    layout: () => {
      this.layouts++;
    },
    resize: () => {},
  };
  [key: string]: unknown;
  constructor(
    readonly type: string,
    text = "",
  ) {
    this.text = text;
  }
  image: unknown = null;
  add(type: string, _b?: unknown, content?: unknown): Ctl {
    const c = new Ctl(type, typeof content === "string" ? content : "");
    if (content && typeof content === "object") c.image = content;
    this.children.push(c);
    return c;
  }
  center(): void {}
  show(): void {
    this.shown = true;
  }
  all(): Ctl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
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

const file = (v: string) =>
  readFileSync(
    fileURLToPath(new URL(`../jsx/diagnostica-sgancio-${v}.jsx`, import.meta.url)),
    "utf8",
  );

let tmp: string;
let engine: EsEngine;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-sgancio-"));
  engine = makeEngine(tmp);
  windows.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SCRIPTUI = {
  newImage: (normal: string, _d: string, pressed: string, rollover: string) => ({
    normal,
    pressed,
    rollover,
  }),
  newFont: () => ({}),
};

function open(v: string, thisObj: unknown = new FakePanel("panel")) {
  engine.run(file(v), thisObj, { Panel: FakePanel, Window: FakeWindow, ScriptUI: SCRIPTUI });
  return thisObj as Ctl;
}

/** Pretend the file sits in ScriptUI Panels next to an installed Parlez!.jsx. */
async function installedNextTo(v: string): Promise<void> {
  const panels = path.join(tmp, "ScriptUI Panels");
  mkdirSync(panels, { recursive: true });
  writeFileSync(path.join(panels, PANEL_FILENAME), await panelSource(), "utf8");
  engine.dollar.fileName = path.join(panels, `diagnostica-sgancio-${v}.jsx`).replace(/\\/g, "/");
}

describe.each(["a", "b"])("variant %s", (v) => {
  it("builds into the docked Panel with preferred and minimum size 300 × 200", () => {
    const panel = open(v);
    expect(panel.preferredSize).toEqual([300, 200]);
    expect(panel.minimumSize).toEqual([300, 200]);
    expect(panel.layouts).toBe(1);
    expect(windows).toHaveLength(0);
    expect(panel.all().some((c) => c.text === "misura: 300 x 200")).toBe(true);
  });

  it("shows its size after every resize", () => {
    const panel = open(v);
    panel.size = [40, 18];
    (panel.onResize as () => void).call(panel);
    expect(panel.all().some((c) => c.text === "misura: 40 x 18")).toBe(true);
  });

  it("opens as a palette window when run as a script", () => {
    open(v, {});
    expect(windows).toHaveLength(1);
    expect(windows[0].type).toBe("window:palette");
    expect(windows[0].shown).toBe(true);
  });
});

describe("the only difference", () => {
  it("A has its texts on the root; B in one group with alignment fill and no size", () => {
    const a = open("a");
    expect(a.children.map((c) => c.type)).toEqual(["statictext", "statictext"]);
    const b = open("b");
    expect(b.children.map((c) => c.type)).toEqual(["group"]);
    const g = b.children[0];
    expect(g.alignment).toEqual(["fill", "fill"]);
    expect(g.minimumSize).toBeUndefined();
    expect(g.preferredSize).toEqual({ width: 0, height: 0 });
  });
});

describe.each(["c", "d", "e"])("bisection step %s", (v) => {
  it("finds the pictures through the installed Parlez!.jsx and shows the fixed-size picture button", async () => {
    await installedNextTo(v);
    const panel = open(v);
    const block = panel.all().find((c) => c.type === "iconbutton")!;
    expect(block).toBeDefined();
    expect(block.preferredSize).toEqual([320, 88]);
    expect(block.minimumSize).toEqual([320, 88]);
    expect(block.maximumSize).toEqual([320, 88]);
    expect(path.basename((block.image as { normal: string }).normal)).toBe("on.png");
    (block.onClick as () => void)();
    expect(path.basename((block.image as { normal: string }).normal)).toBe("off.png");
    expect(panel.layouts).toBe(1);
  });

  it("says so, instead of failing, when the pictures are not there", () => {
    const panel = open(v);
    expect(panel.all().some((c) => c.text.startsWith("Immagini non trovate"))).toBe(true);
  });
});

describe.each(["d", "e"])("bisection step %s: the timer", (v) => {
  it("changes one text every 1.5 s and never lays out or resizes", () => {
    const panel = open(v);
    const task = engine.app.tasks.find((t) => t.repeat)!;
    expect(task.delay).toBe(1500);
    const before = panel.layouts;
    engine.run(task.code, undefined);
    engine.run(task.code, undefined);
    expect(panel.all().some((c) => c.text === "timer: 2")).toBe(true);
    expect(panel.layouts).toBe(before);
  });
});

describe("bisection step e: the whole structure", () => {
  it("has the real panel's controls, with no logic", async () => {
    await installedNextTo("e");
    const panel = open("e");
    const all = panel.all();
    expect(all.filter((c) => c.type === "button").map((c) => c.text)).toEqual([
      "Annulla",
      "Ripristino",
      "Elenco",
      "Storico",
      "Cassetta",
      "Vista",
    ]);
    expect(all.some((c) => c.type === "checkbox" && c.text === "Sola lettura")).toBe(true);
    expect(all.some((c) => c.text === "Parlez! by Another Perspective")).toBe(true);
    expect(panel.minimumSize).toEqual([344, 440]);
    expect(panel.children.map((c) => c.type)).toEqual(["group", "group", "group", "group"]);
  });
});
