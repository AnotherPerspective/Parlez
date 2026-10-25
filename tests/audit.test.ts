// comp.audit (provisional name), offline. The generated ExtendScript runs in
// Node against a fake object model (tests/helpers/audit-fakes.ts): every rule
// is checked on a case that must be flagged and on one that must not, the
// pure threshold helpers on their own numbers, the code generation for every
// parameter combination, the ES3 lint on the generated code, and the
// read-only contract. What this cannot show — the real After Effects values
// (font metrics, sourceRectAtTime, expressionError text) — is left to
// tests/e2e/audit.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  AUDIT_CORE,
  AUDIT_DEFAULTS,
  AUDIT_RULE_IDS,
  AUDIT_RULES,
} from "../src/operations/audit-rules.js";
import { auditConfig, buildAuditJsx } from "../src/operations/audit.js";
import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import {
  BEZIER,
  effect,
  FakeAVLayer,
  FakeCameraLayer,
  FakeComp,
  FakeFootage,
  FakeProp,
  FakeShapeLayer,
  FakeTextLayer,
  HOLD,
  LINEAR,
  loadFunctions,
  runJsx,
  snapshot,
  writes,
} from "./helpers/audit-fakes.js";
import { lintJsxFile } from "./helpers/lint-jsx.js";

interface Finding {
  regola: string;
  gravita: string;
  composizione: string;
  livello: string | null;
  indice: number | null;
  tempo: number | null;
  messaggio: string;
  comeCorreggere: string;
}
interface Report {
  ok: boolean;
  error?: string;
  composizione: string;
  solaLettura: boolean;
  temporanei: unknown[];
  segnalazioni: Finding[];
  riepilogo: {
    totale: number;
    errori: number;
    avvisi: number;
    note: number;
    perRegola: Record<string, number>;
    testo: string;
    elementiConSegnalazioni: number;
    livelliConSegnalazioni: number;
    perElemento: Array<{ composizione: string; livello: string | null; regole: string[] }>;
    composizioniControllate: string[];
    livelliControllati: number;
    regoleAttive: string[];
    soglie: { margineAreaSicura: number; durataMinimaLineare: number; profondita: number };
  };
  nonControllate: Array<{ regola: string; composizione: string; errore: string }>;
}

function audit(comp: FakeComp, args: Record<string, unknown> = {}, more: FakeComp[] = []): Report {
  const res = runJsx(buildAuditJsx({ comp: comp.name, ...args }), [comp, ...more]) as Report;
  // A rule that threw is a bug in the rule, never an acceptable outcome here.
  if (res.ok) expect(res.nonControllate).toEqual([]);
  return res;
}
function only(
  rule: string,
  comp: FakeComp,
  args: Record<string, unknown> = {},
  more: FakeComp[] = [],
) {
  return audit(comp, { regole: [rule], ...args }, more).segnalazioni;
}
function key(t: number, v: number | number[], interp = LINEAR) {
  return { t, v, inI: interp, outI: interp };
}

// ---------------------------------------------------------------------------

describe("comp.audit registration", () => {
  it("is a read-only comp operation with the documented parameters", () => {
    const op = getOp("comp.audit");
    expect(op).toBeDefined();
    expect(op!.readOnly).toBe(true);
    expect(op!.category).toBe("comp");
    expect(op!.params.map((p) => p.name)).toEqual([
      "comp",
      "regole",
      "profondita",
      "margineAreaSicura",
      "durataMinimaLineare",
    ]);
  });

  it("has exactly the 14 rules of the planning notes §1.2.1, each with its own function", () => {
    expect(AUDIT_RULE_IDS).toHaveLength(14);
    expect(new Set(AUDIT_RULE_IDS).size).toBe(14);
    for (const r of AUDIT_RULES) {
      expect(r.code).toContain(`function ${r.fn}(ctx)`);
      expect(["errore", "avviso", "nota"]).toContain(r.gravita);
    }
  });
});

describe("comp.audit code generation", () => {
  const ruleFns = AUDIT_RULES.map((r) => r.fn);

  it("emits all 14 rule functions by default", () => {
    const jsx = buildAuditJsx({ comp: "Main" });
    for (const fn of ruleFns) expect(jsx).toContain(`function ${fn}(ctx)`);
  });

  it.each(AUDIT_RULES.map((r) => [r.id, r.fn]))(
    "emits only %s when it is the one asked for",
    (id, fn) => {
      const jsx = buildAuditJsx({ comp: "Main", regole: [id] });
      expect(jsx).toContain(`function ${fn}(ctx)`);
      for (const other of ruleFns.filter((f) => f !== fn))
        expect(jsx).not.toContain(`function ${other}(`);
    },
  );

  it("keeps the table's report order whatever order the rules are listed in", () => {
    const cfg = auditConfig({ regole: ["comp-vuota", "errore-espressione", "area-sicura"] });
    expect(cfg).toEqual({
      regole: ["errore-espressione", "area-sicura", "comp-vuota"],
      ...AUDIT_DEFAULTS,
    });
  });

  it.each([
    [{ regole: ["nope"] }, /unknown rule id\(s\): nope/],
    [{ regole: [] }, /regole is empty/],
    [{ regole: "area-sicura" }, /array of rule ids/],
    [{ regole: [3] }, /array of rule ids/],
    [{ margineAreaSicura: 0.5 }, /margineAreaSicura/],
    [{ margineAreaSicura: -0.01 }, /margineAreaSicura/],
    [{ durataMinimaLineare: -1 }, /durataMinimaLineare/],
    [{ profondita: 1.5 }, /profondita/],
    [{ profondita: 11 }, /profondita/],
  ])("refuses %j on the Node side", (bad, msg) => {
    const jsx = buildAuditJsx({ comp: "Main", ...bad });
    expect(jsx).toMatch(/^return \{ ok: false, error: /);
    const res = runJsx(jsx, []) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(msg);
  });

  it("carries the thresholds into the run and reports them back", () => {
    const c = new FakeComp("Main");
    const res = audit(c, { margineAreaSicura: 0.1, durataMinimaLineare: 0.5, profondita: 2 });
    expect(res.riepilogo.soglie).toEqual({
      margineAreaSicura: 0.1,
      durataMinimaLineare: 0.5,
      profondita: 2,
    });
    expect(audit(c).riepilogo.soglie).toEqual(AUDIT_DEFAULTS);
  });

  it("embeds the comp name as a literal, so a hostile name stays a name", () => {
    const evil = '"; app.project.close(); var x = "';
    const jsx = buildAuditJsx({ comp: evil });
    expect(jsx).toContain(JSON.stringify(evil));
    const res = runJsx(jsx, []) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no comp matching");
  });

  it("reports an unknown comp like every other comp operation", () => {
    const res = runJsx(buildAuditJsx({ comp: "Missing" }), [new FakeComp("Main")]) as {
      ok: boolean;
      error: string;
    };
    expect(res).toEqual({ ok: false, error: "no comp matching Missing" });
  });
});

describe("comp.audit generated code is ES3 and read-only", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "parlez-audit-lint-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const combos: Array<[string, Record<string, unknown>]> = [
    ["all rules", {}],
    [
      "all rules with thresholds",
      { profondita: 3, margineAreaSicura: 0.1, durataMinimaLineare: 0 },
    ],
    ...AUDIT_RULE_IDS.map((id): [string, Record<string, unknown>] => [id, { regole: [id] }]),
  ];

  it.each(combos)("%s: passes the ES3 lint", (label, extra) => {
    const jsx = buildAuditJsx({ comp: "Main", ...extra });
    const file = path.join(dir, `${label.replace(/\W+/g, "_")}.jsx`);
    writeFileSync(file, jsx);
    const errors = lintJsxFile(file).filter((f) => f.severity === "error");
    expect(errors.map((f) => `${f.line} [${f.rule}] ${f.text}`)).toEqual([]);
    expect(jsx).not.toContain("`");
  });

  it("never writes to the project: no setter, no add/remove, no undo group", () => {
    const code = buildAuditJsx({ comp: "Main" }).replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      /\.setValue\w*\s*\(/,
      /\.addProperty\s*\(/,
      /\.addKey\s*\(/,
      /\.remove\w*\s*\(/,
      /\.duplicate\s*\(/,
      /beginUndoGroup|endUndoGroup|executeCommand/,
      /\.(expression|expressionEnabled|motionBlur|enabled|name|inPoint|outPoint|startTime|threeDLayer|parent|value)\s*=[^=]/,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });

  it("leaves a busy comp exactly as it found it", () => {
    const c = new FakeComp("Main");
    c.motionBlur = false;
    const src = new FakeFootage("big.png", 4000, 4000);
    src.footageMissing = true;
    const a = c.add(
      new FakeTextLayer({
        name: "T",
        position: [10, 10],
        rect: { left: 0, top: 0, width: 200, height: 50 },
      }),
    );
    a.tp("ADBE Position").keys = [key(0, [10, 10]), key(2, [500, 10]), key(12, [600, 10])];
    a.tp("ADBE Opacity").expressionEnabled = true;
    a.tp("ADBE Opacity").expressionError = "boom";
    c.add(
      new FakeAVLayer({ name: "B", source: src, scale: [900, 900], inPoint: 20, outPoint: 30 }),
    );
    c.add(
      new FakeAVLayer({
        name: "Adj",
        adjustment: true,
        effects: [effect("Blur", "ADBE Motion Blur"), effect("CC", "CC Radial Blur")],
      }),
    );
    c.add(
      new FakeAVLayer({
        name: "3a",
        threeD: true,
        rect: { left: 0, top: 0, width: 100, height: 100 },
      }),
    );
    c.add(
      new FakeAVLayer({
        name: "3b",
        threeD: true,
        rotationY: 90,
        rect: { left: 0, top: 0, width: 100, height: 100 },
      }),
    );
    c.add(new FakeTextLayer({ name: "under", rect: { left: 0, top: 0, width: 10, height: 10 } }));
    const before = snapshot([c]);
    writes.length = 0;
    const res = audit(c, { profondita: 1 });
    expect(res.ok).toBe(true);
    expect(res.solaLettura).toBe(true);
    expect(res.temporanei).toEqual([]);
    expect(res.riepilogo.totale).toBeGreaterThanOrEqual(12);
    expect(writes).toEqual([]);
    expect(snapshot([c])).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const core = loadFunctions<{
  safeSides(b: Box, w: number, h: number, m: number): string[] | null;
  boxMoved(a: Box, b: Box, tol: number): boolean;
  apply2D(pts: number[][], a: number[], p: number[], s: number[], r: number): number[][];
  boxOf(pts: number[][]): Box;
  linearSegments(
    keys: Array<{ t: number; v: unknown; inI: number; outI: number }>,
    minDur: number,
    visStart: number,
    visEnd: number,
    lin: number,
  ): Array<{ start: number; end: number }>;
  keysAfter(times: number[], end: number, tol: number): number[];
  outsideTime(i: number, o: number, d: number): boolean;
  maxPx(w: number, h: number, chain: number[][]): number;
  angleDiff(a: number, b: number): number;
  coplanar(
    a: { x: number; y: number; z: number; rot: number[]; r: number },
    b: { x: number; y: number; z: number; rot: number[]; r: number },
    tolZ: number,
  ): boolean;
  same(a: unknown, b: unknown): boolean;
  summaryText(
    total: number,
    nLayers: number,
    nComps: number,
    counts: { errore: number; avviso: number; nota: number },
  ): string;
}>(AUDIT_CORE, [
  "_auSafeSides",
  "_auBoxMoved",
  "_auApply2D",
  "_auBoxOf",
  "_auLinearSegments",
  "_auKeysAfter",
  "_auOutsideTime",
  "_auMaxPx",
  "_auAngleDiff",
  "_auCoplanar",
  "_auSame",
  "_auSummaryText",
]);

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});

describe("safe area geometry", () => {
  // 1920x1080 at 5%: margins of 96 px left/right and 54 px top/bottom.
  it.each([
    [box(96, 54, 1824, 1026), []],
    [box(95, 100, 500, 200), ["sinistra"]],
    [box(1500, 100, 1825, 200), ["destra"]],
    [box(500, 53, 600, 200), ["alto"]],
    [box(500, 900, 600, 1027), ["basso"]],
    [box(50, 20, 1900, 300), ["sinistra", "destra", "alto"]],
  ])("%j crosses %j", (b, sides) => {
    expect(core.safeSides(b, 1920, 1080, 0.05)).toEqual(sides);
  });

  it.each([
    ["an empty box", box(500, 500, 500.5, 600)],
    ["a full-frame background", box(-10, -10, 1930, 1090)],
    ["a box parked off-screen", box(-400, 100, -10, 200)],
    ["a box below the frame", box(100, 1100, 300, 1200)],
  ])("does not judge %s", (_label, b) => {
    expect(core.safeSides(b, 1920, 1080, 0.05)).toBeNull();
  });

  it("scales the margin with the parameter", () => {
    expect(core.safeSides(box(150, 200, 500, 300), 1920, 1080, 0.05)).toEqual([]);
    expect(core.safeSides(box(150, 200, 500, 300), 1920, 1080, 0.1)).toEqual(["sinistra"]);
    expect(core.safeSides(box(0, 0, 10, 10), 1920, 1080, 0)).toEqual([]);
  });

  it("tells resting from moving by total corner drift", () => {
    expect(core.boxMoved(box(0, 0, 10, 10), box(1, 1, 11, 11), 4)).toBe(false);
    expect(core.boxMoved(box(0, 0, 10, 10), box(2, 1, 12, 11), 4)).toBe(true);
  });

  it("applies anchor, scale and clockwise rotation like After Effects", () => {
    // Anchor at the centre of a 100x100 rect, placed at (500, 300).
    expect(core.apply2D([[50, 50]], [50, 50], [500, 300], [100, 100], 0)).toEqual([[500, 300]]);
    const [p] = core.apply2D([[100, 50]], [50, 50], [500, 300], [200, 100], 90);
    // 50 px right of the anchor, doubled, then turned 90° clockwise = 100 px down.
    expect(p[0]).toBeCloseTo(500);
    expect(p[1]).toBeCloseTo(400);
    expect(
      core.boxOf([
        [3, 9],
        [1, 4],
        [7, 2],
      ]),
    ).toEqual(box(1, 2, 7, 9));
  });
});

const seg = (t0: number, t1: number, outI = LINEAR, inI = LINEAR, v0 = 0, v1 = 100) => [
  { t: t0, v: v0, inI: LINEAR, outI },
  { t: t1, v: v1, inI, outI: LINEAR },
];
const plane = (z: number, rot: number[], x = 960, y = 540, r = 100) => ({ x, y, z, rot, r });

describe("keyframe timing", () => {
  it("counts a fully linear, changing segment at least the minimum long", () => {
    expect(core.linearSegments(seg(0, 2), 0.2, 0, 10, LINEAR)).toEqual([{ start: 0, end: 2 }]);
    expect(core.linearSegments(seg(0, 0.2), 0.2, 0, 10, LINEAR)).toHaveLength(1);
  });

  it.each([
    ["eased out of the first key", seg(0, 2, BEZIER)],
    ["eased into the second key", seg(0, 2, LINEAR, BEZIER)],
    ["shorter than the minimum", seg(0, 0.12)],
    ["not changing the value", seg(0, 2, LINEAR, LINEAR, 50, 50)],
    ["a hold", seg(0, 2, HOLD)],
  ])("ignores a segment %s", (_label, keys) => {
    expect(core.linearSegments(keys, 0.2, 0, 10, LINEAR)).toEqual([]);
  });

  it("measures only the part that is on screen", () => {
    // Segment 9.9 s – 12 s in a 10 s comp: 0.1 s visible, under the 0.2 s minimum.
    expect(core.linearSegments(seg(9.9, 12), 0.2, 0, 10, LINEAR)).toEqual([]);
    expect(core.linearSegments(seg(9.5, 12), 0.2, 0, 10, LINEAR)).toHaveLength(1);
    expect(core.linearSegments(seg(0, 2), 0, 0, 10, LINEAR)).toHaveLength(1);
  });

  it("compares array values component by component", () => {
    expect(core.same([1, 2], [1, 2])).toBe(true);
    expect(core.same([1, 2], [1, 3])).toBe(false);
    expect(core.same([1, 2], [1, 2, 0])).toBe(false);
    expect(core.same(5, 5.0000001)).toBe(true);
  });

  it("finds keys past the end beyond half a frame", () => {
    expect(core.keysAfter([0, 9.99, 10.01, 11], 10, 0.02)).toEqual([11]);
    expect(core.keysAfter([0, 5], 10, 0.02)).toEqual([]);
  });

  it("calls a layer outside the time range only when no frame of it is inside", () => {
    expect(core.outsideTime(10, 12, 10)).toBe(true);
    expect(core.outsideTime(-5, 0, 10)).toBe(true);
    expect(core.outsideTime(9.96, 12, 10)).toBe(false);
    expect(core.outsideTime(-5, 0.04, 10)).toBe(false);
  });
});

describe("size and 3D geometry", () => {
  it("multiplies the largest scale of the layer and its parents", () => {
    expect(core.maxPx(1000, 500, [[100, 100]])).toBe(1000);
    expect(
      core.maxPx(1000, 500, [
        [3000, 100],
        [110, 100],
      ]),
    ).toBeCloseTo(33000);
    expect(core.maxPx(1000, 4000, [[100, 800]])).toBe(32000);
  });

  it("wraps angle differences", () => {
    expect(core.angleDiff(350, 10)).toBe(20);
    expect(core.angleDiff(0, 360)).toBe(0);
    expect(core.angleDiff(-90, 90)).toBe(180);
  });

  it.each([
    ["same depth, turned 90° on Y, overlapping", plane(0, [0, 0, 0]), plane(3, [0, 90, 0]), true],
    ["5 px apart in depth", plane(0, [0, 0, 0]), plane(5, [0, 90, 0]), false],
    [
      "same orientation (parallel, z-fighting is another matter)",
      plane(0, [0, 0, 0]),
      plane(0, [0, 0, 0.5]),
      false,
    ],
    ["far apart on screen", plane(0, [0, 0, 0]), plane(0, [0, 90, 0], 1700), false],
    ["orientation and rotation that cancel out", plane(0, [0, 360, 0]), plane(0, [0, 0, 0]), false],
  ])("coplanar? %s", (_label, a, b, expected) => {
    expect(core.coplanar(a, b, 5)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// One rule at a time, on fake comps
// ---------------------------------------------------------------------------

describe("rule errore-espressione", () => {
  it("flags an enabled expression that errors, anywhere in the layer", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    const slider = new FakeProp("Slider", "ADBE Slider Control-0001", 0);
    slider.expressionEnabled = true;
    slider.expressionError = "ReferenceError: wiggel is not defined";
    l.effects.children.push(
      new FakeProp("ignored", "x", 0),
      effect("Slider Control", "ADBE Slider Control"),
    );
    (l.effects.children[1] as ReturnType<typeof effect>).children.push(slider);
    const f = only("errore-espressione", c);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      regola: "errore-espressione",
      gravita: "errore",
      livello: "S",
      indice: 1,
      tempo: null,
    });
    expect(f[0].messaggio).toContain("wiggel");
  });

  it("ignores a working expression and a disabled broken one", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    l.tp("ADBE Opacity").expressionEnabled = true;
    l.tp("ADBE Rotate Z").expressionError = "stale error on a disabled expression";
    expect(only("errore-espressione", c)).toEqual([]);
  });
});

describe("rule keyframe-oltre-fine", () => {
  it("flags keys past the end, once per layer, at the first such time", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    l.tp("ADBE Position").keys = [key(0, [0, 0]), key(11, [9, 9]), key(12, [5, 5])];
    l.tp("ADBE Opacity").keys = [key(0, 0), key(10.5, 100)];
    const f = only("keyframe-oltre-fine", c);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ livello: "S", tempo: 10.5 });
    expect(f[0].messaggio).toMatch(/^3 keyframe/);
  });

  it("ignores keys up to the end and a lone key past it", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    l.tp("ADBE Position").keys = [key(0, [0, 0]), key(10, [9, 9])];
    l.tp("ADBE Opacity").keys = [key(12, 0)];
    expect(only("keyframe-oltre-fine", c)).toEqual([]);
  });
});

describe("rule keyframe-lineari", () => {
  it("flags linear motion keys and names the properties", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    l.tp("ADBE Position").keys = [key(1, [0, 0]), key(3, [500, 0])];
    l.tp("ADBE Opacity").keys = [key(0, 0), key(1, 100)];
    const f = only("keyframe-lineari", c);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ livello: "S", tempo: 0, gravita: "avviso" });
    expect(f[0].messaggio).toContain("Position (1)");
    expect(f[0].messaggio).toContain("Opacity (1)");
  });

  it("ignores eased keys, non-motion properties and segments below the minimum", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    l.tp("ADBE Position").keys = [key(0, [0, 0], BEZIER), key(2, [500, 0], BEZIER)];
    l.tp("ADBE Anchor Point").keys = [key(0, [0, 0]), key(2, [50, 0])];
    l.tp("ADBE Scale").keys = [key(0, [100, 100]), key(0.1, [120, 120])];
    expect(only("keyframe-lineari", c)).toEqual([]);
    // The minimum is a parameter: at 0 the 0.1 s scale hop counts.
    expect(only("keyframe-lineari", c, { durataMinimaLineare: 0 })).toHaveLength(1);
  });

  it("ignores a linear segment that lies outside the layer's time", () => {
    const c = new FakeComp("Main");
    const l = c.add(new FakeShapeLayer({ name: "S", inPoint: 5 }));
    l.tp("ADBE Position").keys = [key(0, [0, 0]), key(2, [500, 0])];
    expect(only("keyframe-lineari", c)).toEqual([]);
  });
});

describe("rule movimento-senza-motion-blur", () => {
  it("flags a moving layer, and a child moved by its parent", () => {
    const c = new FakeComp("Main");
    const parent = c.add(new FakeAVLayer({ name: "Ctrl", nullLayer: true }));
    parent.tp("ADBE Rotate Z").keys = [key(0, 0), key(2, 90)];
    const child = c.add(new FakeShapeLayer({ name: "Child" }));
    child.parent = parent;
    const mover = c.add(new FakeTextLayer({ name: "Mover" }));
    mover.tp("ADBE Scale").keys = [key(0, [100, 100], BEZIER), key(1, [50, 50], BEZIER)];
    expect(only("movimento-senza-motion-blur", c).map((f) => f.livello)).toEqual([
      "Child",
      "Mover",
    ]);
  });

  it("ignores motion blur on, opacity-only animation, unchanged keys, nulls and hidden layers", () => {
    const c = new FakeComp("Main");
    const on = c.add(new FakeShapeLayer({ name: "On", motionBlur: true }));
    on.tp("ADBE Position").keys = [key(0, [0, 0]), key(1, [9, 9])];
    c.add(new FakeShapeLayer({ name: "Fade" })).tp("ADBE Opacity").keys = [key(0, 0), key(1, 100)];
    c.add(new FakeShapeLayer({ name: "Still" })).tp("ADBE Position").keys = [
      key(0, [5, 5]),
      key(1, [5, 5]),
    ];
    c.add(new FakeAVLayer({ name: "Null", nullLayer: true })).tp("ADBE Position").keys = [
      key(0, [0, 0]),
      key(1, [9, 9]),
    ];
    c.add(new FakeShapeLayer({ name: "Off", enabled: false })).tp("ADBE Position").keys = [
      key(0, [0, 0]),
      key(1, [9, 9]),
    ];
    expect(only("movimento-senza-motion-blur", c)).toEqual([]);
  });
});

describe("rule fuori-dal-tempo", () => {
  it("flags layers that start after the end or end before the start", () => {
    const c = new FakeComp("Main");
    c.add(new FakeTextLayer({ name: "Late", inPoint: 11, outPoint: 13 }));
    c.add(new FakeTextLayer({ name: "Early", inPoint: -4, outPoint: 0 }));
    c.add(
      new FakeAVLayer({
        name: "AudioOnly",
        enabled: false,
        hasAudio: true,
        inPoint: 12,
        outPoint: 14,
      }),
    );
    const f = only("fuori-dal-tempo", c);
    expect(f.map((x) => x.livello)).toEqual(["Late", "Early", "AudioOnly"]);
    expect(f[0]).toMatchObject({ tempo: 11, gravita: "errore" });
  });

  it("ignores layers with at least a frame inside, and switched-off silent layers", () => {
    const c = new FakeComp("Main");
    c.add(new FakeTextLayer({ name: "Edge", inPoint: 9.96, outPoint: 13 }));
    c.add(new FakeTextLayer({ name: "Off", enabled: false, inPoint: 12, outPoint: 14 }));
    expect(only("fuori-dal-tempo", c)).toEqual([]);
  });
});

describe("rule file-mancante", () => {
  it("flags a layer whose footage is missing, and only that one", () => {
    const c = new FakeComp("Main");
    const gone = new FakeFootage("intervista.mov", 1920, 1080);
    gone.footageMissing = true;
    c.add(new FakeAVLayer({ name: "Gone", source: gone }));
    c.add(new FakeAVLayer({ name: "Here", source: new FakeFootage("logo.png", 400, 400) }));
    c.add(new FakeTextLayer({ name: "Text" }));
    const f = only("file-mancante", c);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ livello: "Gone", gravita: "errore" });
    expect(f[0].messaggio).toContain("intervista.mov");
  });
});

describe("rule cc-radial-blur", () => {
  it("flags an enabled CC Radial Blur on an enabled layer", () => {
    const c = new FakeComp("Main");
    c.add(new FakeAVLayer({ name: "A", effects: [effect("Zoom", "CC Radial Blur")] }));
    c.add(new FakeAVLayer({ name: "OffFx", effects: [effect("Zoom", "CC Radial Blur", false)] }));
    c.add(
      new FakeAVLayer({
        name: "OffLayer",
        enabled: false,
        effects: [effect("Zoom", "CC Radial Blur")],
      }),
    );
    c.add(new FakeAVLayer({ name: "Other", effects: [effect("Radial", "ADBE Radial Blur")] }));
    expect(only("cc-radial-blur", c).map((f) => f.livello)).toEqual(["A"]);
  });
});

describe("rule blur-regolazione", () => {
  it("flags edge-pulling blurs on adjustment layers without CC RepeTile before them", () => {
    const c = new FakeComp("Main");
    c.add(
      new FakeAVLayer({
        name: "Adj",
        adjustment: true,
        effects: [effect("Dir", "ADBE Motion Blur"), effect("Rad", "ADBE Radial Blur")],
      }),
    );
    const f = only("blur-regolazione", c);
    expect(f).toHaveLength(2);
    expect(f[0].messaggio).toContain("'Dir'");
  });

  it("ignores RepeTile first, RepeTile after (still flagged), normal layers and Gaussian blur", () => {
    const c = new FakeComp("Main");
    c.add(
      new FakeAVLayer({
        name: "Tiled",
        adjustment: true,
        effects: [effect("T", "CC RepeTile"), effect("B", "ADBE Box Blur2")],
      }),
    );
    c.add(new FakeAVLayer({ name: "Plain", effects: [effect("B", "ADBE Box Blur2")] }));
    c.add(
      new FakeAVLayer({
        name: "Gauss",
        adjustment: true,
        effects: [effect("G", "ADBE Gaussian Blur 2")],
      }),
    );
    c.add(
      new FakeAVLayer({
        name: "TooLate",
        adjustment: true,
        effects: [effect("B", "ADBE Box Blur2"), effect("T", "CC RepeTile")],
      }),
    );
    expect(only("blur-regolazione", c).map((f) => f.livello)).toEqual(["TooLate"]);
  });
});

describe("rule livello-enorme", () => {
  it("flags a layer past 30,000 px at its largest scale, parents included", () => {
    const c = new FakeComp("Main");
    const big = c.add(
      new FakeAVLayer({ name: "Zoom", source: new FakeFootage("map.png", 4000, 3000) }),
    );
    big.tp("ADBE Scale").keys = [key(0, [100, 100]), key(5, [800, 800])];
    const parent = c.add(new FakeAVLayer({ name: "P", nullLayer: true, scale: [400, 400] }));
    const child = c.add(
      new FakeAVLayer({
        name: "C",
        source: new FakeFootage("bg.png", 1920, 1080),
        scale: [400, 400],
      }),
    );
    child.parent = parent;
    const f = only("livello-enorme", c);
    expect(f.map((x) => x.livello)).toEqual(["Zoom", "C"]);
    expect(f[0].messaggio).toContain("32000 px");
  });

  it("ignores layers under the limit and layers without a source size", () => {
    const c = new FakeComp("Main");
    c.add(
      new FakeAVLayer({
        name: "Ok",
        source: new FakeFootage("map.png", 4000, 3000),
        scale: [-700, 700],
      }),
    );
    c.add(new FakeTextLayer({ name: "Text", scale: [5000, 5000] }));
    expect(only("livello-enorme", c)).toEqual([]);
  });
});

describe("rule 3d-coplanari", () => {
  const card = { left: 0, top: 0, width: 400, height: 300 };
  it("flags sibling 3D layers on the same plane turned differently", () => {
    const c = new FakeComp("Main");
    c.add(new FakeAVLayer({ name: "Front", threeD: true, rect: card }));
    c.add(
      new FakeAVLayer({
        name: "Side",
        threeD: true,
        rect: card,
        orientation: [0, 90, 0],
        position: [1000, 540, 2],
      }),
    );
    const f = only("3d-coplanari", c);
    expect(f).toHaveLength(1);
    expect(f[0].livello).toBe("Side");
    expect(f[0].messaggio).toContain("'Front'");
  });

  it("ignores different parents, depth gaps, same orientation, 2D layers and no time overlap", () => {
    const c = new FakeComp("Main");
    const p = c.add(new FakeAVLayer({ name: "Rig", nullLayer: true, threeD: true }));
    c.add(new FakeAVLayer({ name: "A", threeD: true, rect: card }));
    const b = c.add(new FakeAVLayer({ name: "B", threeD: true, rect: card, rotationY: 90 }));
    b.parent = p;
    c.add(
      new FakeAVLayer({
        name: "Deep",
        threeD: true,
        rect: card,
        rotationX: 45,
        position: [960, 540, 50],
      }),
    );
    c.add(new FakeAVLayer({ name: "Twin", threeD: true, rect: card, position: [970, 540, 0] }));
    c.add(new FakeAVLayer({ name: "Flat", rect: card, rotation: 45 }));
    c.add(
      new FakeAVLayer({
        name: "Later",
        threeD: true,
        rect: card,
        rotationY: 90,
        inPoint: 20,
        outPoint: 30,
      }),
    );
    expect(only("3d-coplanari", c)).toEqual([]);
  });
});

describe("rule testo-2d-sotto-3d", () => {
  it("flags 2D text below a 3D layer it shares time with", () => {
    const c = new FakeComp("Main");
    c.add(new FakeShapeLayer({ name: "Cube", threeD: true }));
    c.add(new FakeTextLayer({ name: "Caption" }));
    const f = only("testo-2d-sotto-3d", c);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ livello: "Caption" });
  });

  it("ignores text above, 3D text, non-text 2D layers, cameras and no time overlap", () => {
    const c = new FakeComp("Main");
    c.add(new FakeTextLayer({ name: "Above" }));
    c.add(new FakeCameraLayer({ name: "Cam", threeD: true }));
    c.add(new FakeShapeLayer({ name: "Cube", threeD: true, outPoint: 4 }));
    c.add(new FakeTextLayer({ name: "Text3D", threeD: true }));
    c.add(new FakeShapeLayer({ name: "Shape2D" }));
    c.add(new FakeTextLayer({ name: "AfterCube", inPoint: 4 }));
    // "Text3D" is 3D and spans the whole comp, so it is a 3D layer above "AfterCube".
    expect(only("testo-2d-sotto-3d", c).map((f) => f.livello)).toEqual(["AfterCube"]);
    c.layers[3].threeDLayer = false;
    c.layers[3].outPoint = 4;
    expect(only("testo-2d-sotto-3d", c).map((f) => f.livello)).toEqual(["Text3D"]);
  });
});

describe("rule area-sicura", () => {
  const rect = { left: 0, top: -40, width: 300, height: 50 };
  it("flags a resting element across the margin, with the sides and time", () => {
    const c = new FakeComp("Main");
    c.add(new FakeTextLayer({ name: "Low", rect, position: [800, 1050] }));
    c.add(
      new FakeShapeLayer({
        name: "Corner",
        rect: { left: -50, top: -50, width: 100, height: 100 },
        position: [60, 60],
      }),
    );
    const f = only("area-sicura", c);
    expect(f.map((x) => x.livello)).toEqual(["Low", "Corner"]);
    expect(f[0].messaggio).toContain("basso");
    expect(f[0].messaggio).toContain("5%");
    expect(f[1].messaggio).toContain("sinistra, alto");
    expect(f[0].tempo).toBeCloseTo(10 / 24, 3);
  });

  it("measures through parent, scale and anchor", () => {
    const c = new FakeComp("Main");
    const p = c.add(new FakeAVLayer({ name: "Rig", nullLayer: true, position: [1900, 540] }));
    const child = c.add(new FakeTextLayer({ name: "Pushed", rect, position: [-200, 0] }));
    child.parent = p;
    const small = c.add(
      new FakeShapeLayer({
        name: "Scaled",
        rect: { left: -50, top: -50, width: 100, height: 100 },
        position: [1780, 540],
        scale: [50, 50],
      }),
    );
    expect(only("area-sicura", c).map((x) => x.livello)).toEqual(["Pushed"]);
    small.tp("ADBE Scale").value = [200, 200];
    expect(only("area-sicura", c).map((x) => x.livello)).toEqual(["Pushed", "Scaled"]);
  });

  it("ignores elements that only cross the margin while moving, or while invisible", () => {
    const c = new FakeComp("Main");
    const fly = c.add(new FakeTextLayer({ name: "FlyIn", rect }));
    // Comes in from the left for the whole comp, never resting.
    fly.tp("ADBE Position").keys = [key(0, [-400, 540]), key(10, [800, 540])];
    const faded = c.add(
      new FakeTextLayer({ name: "Faded", rect, position: [10, 540], opacity: 0 }),
    );
    expect(faded).toBeDefined();
    c.add(new FakeTextLayer({ name: "Inside", rect, position: [800, 540] }));
    c.add(new FakeAVLayer({ name: "Bg", source: new FakeFootage("bg", 1920, 1080) }));
    c.add(new FakeTextLayer({ name: "Card3D", rect, position: [10, 10, 0], threeD: true }));
    c.add(
      new FakeTextLayer({
        name: "Outside time",
        rect,
        position: [10, 540],
        inPoint: 20,
        outPoint: 30,
      }),
    );
    expect(only("area-sicura", c)).toEqual([]);
  });

  it("takes the margin from the parameter", () => {
    const c = new FakeComp("Main");
    c.add(new FakeTextLayer({ name: "T", rect, position: [150, 540] }));
    expect(only("area-sicura", c)).toEqual([]);
    const f = only("area-sicura", c, { margineAreaSicura: 0.1 });
    expect(f).toHaveLength(1);
    expect(f[0].messaggio).toContain("10%");
  });

  it("runs on the top comp only, not on precomps", () => {
    const pre = new FakeComp("Lower third", 800, 200);
    pre.add(new FakeTextLayer({ name: "Name", rect, position: [10, 100] }));
    const c = new FakeComp("Main");
    c.add(new FakeAVLayer({ name: "LT", source: pre, position: [960, 900] }));
    expect(only("area-sicura", c, { profondita: 1 }, [pre])).toEqual([]);
  });
});

describe("rule motion-blur-comp", () => {
  it("flags the comp switch off while a layer moves, once", () => {
    const c = new FakeComp("Main");
    c.motionBlur = false;
    for (const n of ["A", "B"])
      c.add(new FakeShapeLayer({ name: n })).tp("ADBE Position").keys = [
        key(0, [0, 0]),
        key(1, [9, 9]),
      ];
    const f = only("motion-blur-comp", c);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ livello: null, indice: null, composizione: "Main" });
    expect(f[0].messaggio).toContain("'A'");
  });

  it("ignores the switch on, or off with nothing moving", () => {
    const c = new FakeComp("Main");
    c.add(new FakeShapeLayer({ name: "A" })).tp("ADBE Position").keys = [
      key(0, [0, 0]),
      key(1, [9, 9]),
    ];
    expect(only("motion-blur-comp", c)).toEqual([]);
    c.motionBlur = false;
    c.layers[0].tp("ADBE Position").keys = [];
    expect(only("motion-blur-comp", c)).toEqual([]);
  });
});

describe("rule comp-vuota", () => {
  it("flags an empty comp as an error, and not a comp with layers", () => {
    const c = new FakeComp("Empty");
    expect(only("comp-vuota", c)).toMatchObject([
      { regola: "comp-vuota", gravita: "errore", livello: null },
    ]);
    c.add(new FakeTextLayer({ name: "T" }));
    expect(only("comp-vuota", c)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

describe("comp.audit runner", () => {
  it("descends into precomps up to profondita, once each, and counts by severity", () => {
    const inner = new FakeComp("Inner");
    const mid = new FakeComp("Mid");
    mid.add(new FakeAVLayer({ name: "In1", source: inner }));
    mid.add(new FakeAVLayer({ name: "In2", source: inner }));
    const c = new FakeComp("Main");
    c.add(new FakeAVLayer({ name: "M", source: mid }));
    const all = [c, mid, inner];
    expect(audit(c, {}, all).riepilogo.composizioniControllate).toEqual(["Main"]);
    expect(audit(c, { profondita: 1 }, all).riepilogo.composizioniControllate).toEqual([
      "Main",
      "Mid",
    ]);
    const deep = audit(c, { profondita: 5 }, all);
    expect(deep.riepilogo.composizioniControllate).toEqual(["Main", "Mid", "Inner"]);
    // Inner is empty: one error, found in the precomp and labelled with it.
    expect(deep.segnalazioni).toMatchObject([{ regola: "comp-vuota", composizione: "Inner" }]);
    expect(deep.riepilogo).toMatchObject({
      totale: 1,
      errori: 1,
      avvisi: 0,
      note: 0,
      perRegola: { "comp-vuota": 1 },
      livelliControllati: 3,
    });
  });

  it("reports a rule that throws instead of hiding it, and keeps the others running", () => {
    const c = new FakeComp("Main");
    const broken = c.add(new FakeTextLayer({ name: "Broken" }));
    Object.defineProperty(broken, "inPoint", {
      get: () => {
        throw new Error("inPoint unreadable");
      },
    });
    const gone = new FakeFootage("clip.mov", 100, 100);
    gone.footageMissing = true;
    c.add(new FakeAVLayer({ name: "Gone", source: gone }));
    const res = runJsx(buildAuditJsx({ comp: "Main" }), [c]) as Report;
    expect(res.ok).toBe(true);
    expect(res.nonControllate).toContainEqual({
      regola: "fuori-dal-tempo",
      composizione: "Main",
      errore: "inPoint unreadable",
    });
    // Rules that never touch inPoint still ran and still report.
    expect(res.segnalazioni.map((f) => f.regola)).toContain("file-mancante");
  });

  it("counts distinct elements with findings", () => {
    const c = new FakeComp("Main");
    c.motionBlur = false;
    const l = c.add(new FakeShapeLayer({ name: "S" }));
    l.tp("ADBE Position").keys = [key(0, [300, 300]), key(2, [900, 300])];
    const res = audit(c);
    expect(res.segnalazioni.map((f) => f.regola)).toEqual([
      "keyframe-lineari",
      "movimento-senza-motion-blur",
      "motion-blur-comp",
    ]);
    // Two on the layer, one on the comp itself: two problems, three findings.
    expect(res.riepilogo.elementiConSegnalazioni).toBe(2);
    expect(res.riepilogo.livelliConSegnalazioni).toBe(1);
    expect(res.riepilogo.perElemento).toEqual([
      {
        composizione: "Main",
        livello: "S",
        regole: ["keyframe-lineari", "movimento-senza-motion-blur"],
      },
      { composizione: "Main", livello: null, regole: ["motion-blur-comp"] },
    ]);
    expect(res.riepilogo.testo).toBe(
      "2 problemi su 1 livello e 1 composizione, 3 segnalazioni (3 avvisi).",
    );
    expect(res.riepilogo.regoleAttive).toEqual(AUDIT_RULE_IDS);
  });
});

describe("readable summary", () => {
  const counts = (errore: number, avviso: number, nota: number) => ({ errore, avviso, nota });
  it.each([
    [0, 0, 0, counts(0, 0, 0), "Nessuna segnalazione."],
    [4, 3, 0, counts(1, 3, 0), "3 problemi su 3 livelli, 4 segnalazioni (1 errore, 3 avvisi)."],
    [1, 1, 0, counts(0, 0, 1), "1 problema su 1 livello, 1 segnalazione (1 nota)."],
    [1, 0, 1, counts(1, 0, 0), "1 problema su 1 composizione, 1 segnalazione (1 errore)."],
    [
      5,
      2,
      2,
      counts(2, 1, 2),
      "4 problemi su 2 livelli e 2 composizioni, 5 segnalazioni (2 errori, 1 avviso, 2 note).",
    ],
  ])("%i findings on %i layers and %i comps: %j", (total, nLayers, nComps, c, text) => {
    expect(core.summaryText(total, nLayers, nComps, c)).toBe(text);
  });
});
