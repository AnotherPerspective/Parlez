// The two minimal undock-diagnosis panels (jsx/diagnostica-sgancio-*.jsx):
// they open docked and as a window, carry the sizes the test is about, and
// differ only by the "fill" group without a size.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  add(type: string, _b?: unknown, text?: string): Ctl {
    const c = new Ctl(type, text ?? "");
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

function open(v: string, thisObj: unknown = new FakePanel("panel")) {
  engine.run(file(v), thisObj, { Panel: FakePanel, Window: FakeWindow });
  return thisObj as Ctl;
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
