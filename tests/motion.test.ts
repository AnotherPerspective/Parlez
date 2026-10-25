// Parlez! M6.3 — named curves, keyframe.apply_ease, layer.stagger and the
// expression templates. Offline: the generated ExtendScript is linted as ES3
// and, where it matters, RUN in Node against a small in-memory stand-in for
// the After Effects objects it touches (no After Effects involved).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  EASES,
  PENNER_FUNCTIONS,
  bezierToAe,
  bezierY,
  easeToAe,
  getEase,
  isValidBezier,
  maxDeviation,
} from "../src/easing.js";
import { EXPRESSION_TEMPLATES, renderTemplate } from "../src/expression-templates.js";
import { STAGGER_RANKS_JSX, planEaseKeys } from "../src/operations/motion.js";
import { getOp, jsxVal } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import "../src/operations/index.js";
import { lintJsxFile } from "./helpers/lint-jsx.js";
import { nullTransport } from "./helpers/null-transport.js";

const LINE_SEP = String.fromCharCode(0x2028);

// --- helpers ---------------------------------------------------------------

const lintDir = mkdtempSync(path.join(tmpdir(), "parlez-m6-lint-"));
afterAll(() => rmSync(lintDir, { recursive: true, force: true }));
let lintCount = 0;

/** ES3 lint of a generated body, through the same rules as jsx/. */
function es3Errors(code: string): string[] {
  const file = path.join(lintDir, `gen${lintCount++}.jsx`);
  writeFileSync(file, code);
  return lintJsxFile(file)
    .filter((f) => f.severity === "error")
    .map((f) => `${f.rule}: ${f.text}`);
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- the curve table -------------------------------------------------------

/** Declared AE values per name: [out influence, out factor, in influence, in factor]. */
const EXPECTED: Array<[string, [number, number, number, number] | null]> = [
  ["linear", [0.1, 0, 0.1, 0]],
  ["hold", null],
  ["easy-ease", [33.33, 0, 33.33, 0]],
  ["ease-in", [42, 0, 0.1, 0]],
  ["ease-out", [0.1, 0, 42, 0]],
  ["ease-in-out", [42, 0, 42, 0]],
  ["ease-in-sine", [36, 0, 32.9, 1.57]],
  ["ease-out-sine", [32.9, 1.57, 36, 0]],
  ["ease-in-out-sine", [36.4, 0, 36.4, 0]],
  ["ease-in-quad", [33.3, 0, 33.4, 2]],
  ["ease-out-quad", [33.4, 2, 33.3, 0]],
  ["ease-in-out-quad", [47.6, 0.07, 47.6, 0.07]],
  ["ease-in-cubic", [33.3, 0, 33.3, 3]],
  ["ease-out-cubic", [33.3, 3, 33.3, 0]],
  ["ease-in-out-cubic", [65.4, 0, 65.4, 0]],
  ["ease-in-quart", [43.6, 0.01, 26.9, 3.98]],
  ["ease-out-quart", [26.9, 3.98, 43.6, 0.01]],
  ["ease-in-out-quart", [76.8, 0, 76.8, 0]],
  ["ease-in-quint", [52.1, 0.02, 22.6, 4.94]],
  ["ease-out-quint", [22.6, 4.94, 52.1, 0.02]],
  ["ease-in-out-quint", [83.9, 0, 83.9, 0]],
  ["ease-in-expo", [64, 0.03, 15.5, 6.82]],
  ["ease-out-expo", [15.5, 6.82, 64, 0.03]],
  ["ease-in-out-expo", [89.9, 0, 89.9, 0]],
  ["ease-in-circ", [54.7, 0, 0.1, 558]],
  ["ease-out-circ", [0.1, 558, 54.7, 0]],
  ["ease-in-out-circ", [87.8, 0.15, 87.8, 0.15]],
  ["ease-in-back", [33.3, 0, 33.3, 4.71]],
  ["ease-out-back", [33.3, 4.71, 33.3, 0]],
  ["ease-in-out-back", [72.1, -0.76, 72.1, -0.76]],
  ["material-standard", [20, 0, 100, 0]],
  ["material-standard-decelerate", [0.1, 0, 100, 0]],
  ["material-standard-accelerate", [30, 0, 0.1, 0]],
  ["material-emphasized-decelerate", [5, 14, 90, 0]],
  ["material-emphasized-accelerate", [30, 0, 20, 4.25]],
  ["carbon-productive-standard", [20, 0, 62, 0.16]],
  ["carbon-productive-entrance", [0.1, 0, 62, 0.16]],
  ["carbon-productive-exit", [20, 0, 0.1, 0]],
  ["carbon-expressive-standard", [40, 0.35, 70, 0]],
  ["carbon-expressive-entrance", [0.1, 0, 70, 0]],
  ["carbon-expressive-exit", [40, 0.35, 0.1, 0]],
];

const PENNER_FAMILIES = ["sine", "quad", "cubic", "quart", "quint", "expo", "circ", "back"];

describe("the curve table", () => {
  it("has every curve declared above, once, and nothing else", () => {
    const names = EASES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(EXPECTED.map(([n]) => n));
  });

  it("has the 24 Penner curves (in, out, in-out of 8 families), each checked against its function", () => {
    const penner = EASES.filter((e) => e.maxError !== undefined).map((e) => e.name);
    const wanted = PENNER_FAMILIES.flatMap((f) => [
      `ease-in-${f}`,
      `ease-out-${f}`,
      `ease-in-out-${f}`,
    ]);
    expect(penner.toSorted()).toEqual(wanted.toSorted());
    expect(Object.keys(PENNER_FUNCTIONS).toSorted()).toEqual(wanted.toSorted());
  });

  it.each(EXPECTED)("%s → declared After Effects values", (name, expected) => {
    const ae = easeToAe(getEase(name)!);
    if (expected === null) {
      expect(ae).toBeNull();
      return;
    }
    expect([
      r2(ae!.out.influence),
      r2(ae!.out.speedFactor),
      r2(ae!.in.influence),
      r2(ae!.in.speedFactor),
    ]).toEqual(expected);
  });

  it("turns linear into speed 0 / influence 0.1 on both sides, as After Effects shows it", () => {
    expect(easeToAe(getEase("linear")!)).toEqual({
      out: { influence: 0.1, speedFactor: 0 },
      in: { influence: 0.1, speedFactor: 0 },
    });
  });

  it("matches the recipe format's hand-computed rows (the recipe format spec §8.2)", () => {
    // dolce = easy-ease 33.3/0 · 33.3/0; standard 20/0 · 100/0;
    // decelera 5/14 · 90/0; accelera 30/0 · 20/4.25.
    const row = (n: string) => {
      const a = easeToAe(getEase(n)!)!;
      return [r2(a.out.influence), r2(a.out.speedFactor), r2(a.in.influence), r2(a.in.speedFactor)];
    };
    expect(row("easy-ease")).toEqual([33.33, 0, 33.33, 0]);
    expect(row("material-standard")).toEqual([20, 0, 100, 0]);
    expect(row("material-emphasized-decelerate")).toEqual([5, 14, 90, 0]);
    expect(row("material-emphasized-accelerate")).toEqual([30, 0, 20, 4.25]);
  });

  it("keeps every influence inside After Effects' 0.1–100", () => {
    for (const e of EASES) {
      const ae = easeToAe(e);
      if (!ae) continue;
      for (const side of [ae.out, ae.in]) {
        expect(side.influence, e.name).toBeGreaterThanOrEqual(0.1);
        expect(side.influence, e.name).toBeLessThanOrEqual(100);
        expect(Number.isFinite(side.speedFactor), e.name).toBe(true);
      }
    }
  });

  it("stores only valid beziers (x1, x2 inside 0…1)", () => {
    for (const e of EASES) if (e.bezier) expect(isValidBezier(e.bezier), e.name).toBe(true);
  });

  it("is symmetric: out-X is in-X turned around, and in-out curves mirror themselves", () => {
    for (const f of PENNER_FAMILIES) {
      const a = easeToAe(getEase(`ease-in-${f}`)!)!;
      const b = easeToAe(getEase(`ease-out-${f}`)!)!;
      expect(close(a.in.influence, b.out.influence, 0.11), f).toBe(true);
      expect(close(a.out.influence, b.in.influence, 0.11), f).toBe(true);
      expect(
        close(a.in.speedFactor, b.out.speedFactor, 0.01 * Math.max(1, a.in.speedFactor)),
        f,
      ).toBe(true);
      const io = easeToAe(getEase(`ease-in-out-${f}`)!)!;
      expect(close(io.out.influence, io.in.influence, 1e-6), f).toBe(true);
      expect(close(io.out.speedFactor, io.in.speedFactor, 1e-6), f).toBe(true);
    }
    const ein = easeToAe(getEase("ease-in")!)!;
    const eout = easeToAe(getEase("ease-out")!)!;
    expect(ein.out.influence).toBeCloseTo(eout.in.influence, 9);
    expect(ein.in).toEqual(eout.out);
    expect(ein.out.speedFactor).toBe(eout.in.speedFactor);
    const easy = easeToAe(getEase("easy-ease")!)!;
    expect(easy.out.influence).toBeCloseTo(easy.in.influence, 9);
    expect(easy.out.speedFactor).toBe(0);
    expect(easy.in.speedFactor).toBe(0);
  });

  it("stays as close to Penner's functions as each entry claims", () => {
    for (const e of EASES) {
      if (e.maxError === undefined) continue;
      const dev = maxDeviation(e.bezier!, PENNER_FUNCTIONS[e.name]);
      expect(dev, e.name).toBeLessThanOrEqual(e.maxError);
      expect(e.maxError, e.name).toBeLessThan(0.04);
    }
    // quad and cubic are cubic polynomials: the bezier is exact up to rounding.
    for (const n of ["ease-in-quad", "ease-out-quad", "ease-in-cubic", "ease-out-cubic"]) {
      expect(maxDeviation(getEase(n)!.bezier!, PENNER_FUNCTIONS[n]), n).toBeLessThan(0.0005);
    }
  });

  it("never gives a backwards speed except for the overshooting 'back' curves", () => {
    for (const e of EASES) {
      const ae = easeToAe(e);
      if (!ae) continue;
      const negative = ae.out.speedFactor < 0 || ae.in.speedFactor < 0;
      expect(negative, e.name).toBe(e.name === "ease-in-out-back");
      expect(e.overshoot === true, e.name).toBe(e.name.includes("-back"));
    }
  });

  it("round-trips: AE values give the bezier back (non-stub sides)", () => {
    for (const e of EASES) {
      if (e.kind !== "bezier") continue;
      const [x1, y1, x2, y2] = e.bezier!;
      const ae = bezierToAe(e.bezier!);
      if (x1 >= 0.001) {
        expect(close(ae.out.influence / 100, x1, 1e-9), e.name).toBe(true);
        expect(close(ae.out.speedFactor * x1, y1, 1e-9), e.name).toBe(true);
      }
      if (1 - x2 >= 0.001) {
        expect(close(1 - ae.in.influence / 100, x2, 1e-9), e.name).toBe(true);
        expect(close(1 - ae.in.speedFactor * (1 - x2), y2, 1e-9), e.name).toBe(true);
      }
    }
  });

  it("marks the design-system numbers as licence-to-check", () => {
    for (const e of EASES.filter((x) => /^(material|carbon)-/.test(x.name))) {
      expect(e.license, e.name).toContain("licenza da verificare");
    }
    expect(EASES.filter((x) => /^(material|carbon)-/.test(x.name))).toHaveLength(11);
  });

  it("validates custom beziers", () => {
    expect(isValidBezier([0.2, 0, 0, 1])).toBe(true);
    expect(isValidBezier([0.2, -1, 0.5, 2])).toBe(true);
    for (const bad of [
      [1.2, 0, 0, 1],
      [0, 0, -0.1, 1],
      [0, 0, 1],
      [0, 0, 1, Number.NaN],
      "ease",
      null,
    ]) {
      expect(isValidBezier(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(close(bezierY([0.42, 0, 0.58, 1], 0.5), 0.5, 1e-9)).toBe(true);
  });
});

// --- keyframe.apply_ease -----------------------------------------------------

describe("keyframe.apply_ease: planning", () => {
  it("puts each curve on the segment arriving at its key", () => {
    const res = planEaseKeys(
      [
        { time: 0, value: 0 },
        { time: 1, value: 100, curve: "material-emphasized-decelerate" },
        { time: 2, value: 50 },
      ],
      "linear",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [k0, k1, k2] = res.plan;
    expect(k0.in).toBeNull();
    expect(k0.out).toMatchObject({ type: "bezier", influence: 5 });
    expect(k0.out!.factor).toBeCloseTo(14, 9);
    expect(k1.in).toEqual({ type: "bezier", influence: 90, factor: 0 });
    expect(k1.out).toEqual({ type: "linear", influence: 0.1, factor: 0 });
    expect(k2.in).toEqual({ type: "linear", influence: 0.1, factor: 0 });
    expect(k2.out).toBeNull();
  });

  it("accepts a custom [x1, y1, x2, y2] and the hold curve", () => {
    const res = planEaseKeys(
      [
        { time: 0, value: 0 },
        { time: 1, value: 1, curve: [0.25, 0.5, 0.75, 1] },
        { time: 2, value: 2, curve: "hold" },
      ],
      "easy-ease",
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.plan[0].out).toEqual({ type: "bezier", influence: 25, factor: 2 });
    expect(res.plan[1].out).toEqual({ type: "hold", influence: 0.1, factor: 0 });
    expect(res.plan[2].in?.type).toBe("linear");
  });

  it.each([
    [[{ time: 0, value: 0 }], "at least 2"],
    [
      [
        { time: 1, value: 0 },
        { time: 0.5, value: 1 },
      ],
      "increasing time",
    ],
    [
      [
        { time: 0, value: 0 },
        { time: 0, value: 1 },
      ],
      "increasing time",
    ],
    [
      [
        { time: 0, value: 0, curve: "linear" },
        { time: 1, value: 1 },
      ],
      "keys[0].curve",
    ],
    [
      [
        { time: 0, value: 0 },
        { time: 1, value: 1, curve: "ease-in-quadd" },
      ],
      "did you mean 'ease-in-quad'",
    ],
    [
      [
        { time: 0, value: 0 },
        { time: 1, value: 1, curve: [1.5, 0, 0, 1] },
      ],
      "x1 and x2 in 0…1",
    ],
    [
      [
        { time: 0, value: 0 },
        { time: 1, value: 1, interp: "ease" },
      ],
      "use keyframe.apply",
    ],
    [[{ time: 0 }, { time: 1, value: 1 }], "keys[0] must be"],
  ] as Array<[unknown[], string]>)("refuses %j", (keys, message) => {
    const res = planEaseKeys(keys, "easy-ease");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(message);
  });
});

/** In-memory stand-in for one animatable property. */
function fakeProperty(opts: { spatial?: boolean }) {
  const BEZ = 6613;
  const keys: Array<{
    time: number;
    value: unknown;
    inType: number;
    outType: number;
    inEase: Array<{ speed: number; influence: number }>;
    outEase: Array<{ speed: number; influence: number }>;
  }> = [];
  const slots = (v: unknown) => (opts.spatial ? 1 : Array.isArray(v) ? v.length : 1);
  const ease = (v: unknown) =>
    Array.from({ length: slots(v) }, () => ({ speed: 0, influence: 16.666 }));
  const prop = {
    propertyType: 1,
    isSpatial: opts.spatial === true,
    keys,
    get numKeys() {
      return keys.length;
    },
    write(time: number, value: unknown) {
      keys.push({
        time,
        value,
        inType: BEZ,
        outType: BEZ,
        inEase: ease(value),
        outEase: ease(value),
      });
      keys.sort((a, b) => a.time - b.time);
    },
    nearestKeyIndex(t: number) {
      let best = 0;
      for (let i = 0; i < keys.length; i++)
        if (Math.abs(keys[i].time - t) < Math.abs(keys[best].time - t)) best = i;
      return best + 1;
    },
    keyTime: (k: number) => keys[k - 1].time,
    keyValue: (k: number) => keys[k - 1].value,
    keyInTemporalEase: (k: number) => keys[k - 1].inEase,
    keyOutTemporalEase: (k: number) => keys[k - 1].outEase,
    keyInInterpolationType: (k: number) => keys[k - 1].inType,
    keyOutInterpolationType: (k: number) => keys[k - 1].outType,
    setTemporalEaseAtKey(k: number, i: never[], o: never[]) {
      keys[k - 1].inEase = i;
      keys[k - 1].outEase = o;
      keys[k - 1].inType = BEZ;
      keys[k - 1].outType = BEZ;
    },
    setInterpolationTypeAtKey(k: number, i: number, o: number) {
      keys[k - 1].inType = i;
      keys[k - 1].outType = o;
    },
  };
  return prop;
}

const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };

/** Run a generated operation body against stand-ins, as AE would run it. */
function runJsx(code: string, AE: Record<string, unknown>): Record<string, unknown> {
  function KeyframeEase(
    this: { speed: number; influence: number },
    speed: number,
    influence: number,
  ) {
    this.speed = speed;
    this.influence = influence;
  }
  const PropertyType = { PROPERTY: 1, INDEXED_GROUP: 2, NAMED_GROUP: 3 };
  // The generated body is plain ES3; running it is the point of the test.
  // oxlint-disable-next-line no-new-func
  const fn = new Function("AE", "PropertyType", "KeyframeInterpolationType", "KeyframeEase", code);
  return fn(AE, PropertyType, KIT, KeyframeEase) as Record<string, unknown>;
}

function easeAE(prop: ReturnType<typeof fakeProperty>) {
  return {
    findCompByNameOrId: () => ({ name: "Main", frameDuration: 1 / 25 }),
    resolveLayers: () => [{ index: 1, name: "L1" }],
    propertyAtPath: () => prop,
    separationFollowers: () => null,
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    applyKeySpecs(p: typeof prop, specs: Array<{ time: number; value: unknown }>) {
      for (const s of specs) p.write(s.time, s.value);
      return { numKeys: p.numKeys, separated: false, warnings: [] };
    },
  };
}

function applyEase(args: Record<string, unknown>, prop: ReturnType<typeof fakeProperty>) {
  const code = getOp("keyframe.apply_ease")!.toJsx({
    comp: "Main",
    layer: 1,
    property: ["x"],
    ...args,
  });
  return { code, result: runJsx(code, easeAE(prop)) };
}

describe("keyframe.apply_ease: the code After Effects runs", () => {
  it("passes the ES3 lint", () => {
    const code = getOp("keyframe.apply_ease")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["Transform", "Opacity"],
      keys: [
        { time: 0, value: 0 },
        { time: 1, value: 100 },
      ],
    });
    expect(es3Errors(code)).toEqual([]);
  });

  it("turns a named curve into AE speeds from the real values (1-D)", () => {
    const prop = fakeProperty({});
    const { result } = applyEase(
      {
        keys: [
          { time: 0, value: 0 },
          { time: 0.48, value: 100, curve: "material-emphasized-decelerate" },
        ],
      },
      prop,
    );
    expect(result.ok).toBe(true);
    // the recipe format spec §8.2 worked example: 0 → 100 in 0.48 s, m = 208.33/s.
    expect(prop.keys[0].outEase[0].influence).toBe(5);
    expect(prop.keys[0].outEase[0].speed).toBeCloseTo(2916.67, 2);
    expect(prop.keys[1].inEase[0]).toMatchObject({ speed: 0, influence: 90 });
    expect(prop.keys[0].outType).toBe(KIT.BEZIER);
    // Sides without a segment keep what AE had.
    expect(prop.keys[0].inEase[0]).toMatchObject({ influence: 16.666 });
  });

  it("gives each dimension its own speed, so a still dimension stays still", () => {
    const prop = fakeProperty({});
    applyEase(
      {
        keys: [
          { time: 0, value: [100, 100] },
          { time: 1, value: [200, 100], curve: "ease-in-cubic" },
        ],
      },
      prop,
    );
    const inn = prop.keys[1].inEase;
    expect(inn).toHaveLength(2);
    const cubicIn = easeToAe(getEase("ease-in-cubic")!)!.in.speedFactor; // ≈ 3
    expect(inn[0].speed).toBeCloseTo(cubicIn * 100, 9);
    expect(inn[1].speed).toBe(0);
  });

  it("uses the distance along the path for spatial properties, and clamps backwards speed", () => {
    const prop = fakeProperty({ spatial: true });
    const { result } = applyEase(
      {
        keys: [
          { time: 0, value: [0, 0] },
          { time: 1, value: [300, 400], curve: "ease-in-cubic" },
          { time: 2, value: [0, 0], curve: "ease-in-out-back" },
        ],
      },
      prop,
    );
    expect(prop.keys[1].inEase).toHaveLength(1);
    const cubicIn = easeToAe(getEase("ease-in-cubic")!)!.in.speedFactor;
    expect(prop.keys[1].inEase[0].speed).toBeCloseTo(cubicIn * 500, 9); // 500 px in 1 s
    expect(prop.keys[1].outEase[0].speed).toBe(0); // back: negative factor, clamped
    const warnings = (result.layers as Array<{ warnings: string[] }>)[0].warnings;
    expect(warnings.some((w) => w.includes("clamped to 0"))).toBe(true);
  });

  it("writes linear and hold as interpolation types", () => {
    const prop = fakeProperty({});
    applyEase(
      {
        keys: [
          { time: 0, value: 0 },
          { time: 1, value: 10, curve: "linear" },
          { time: 2, value: 20, curve: "hold" },
        ],
      },
      prop,
    );
    expect(prop.keys[0].outType).toBe(KIT.LINEAR);
    expect(prop.keys[1].inType).toBe(KIT.LINEAR);
    expect(prop.keys[1].outType).toBe(KIT.HOLD);
    expect(prop.keys[2].inType).toBe(KIT.LINEAR);
  });

  it("embeds the key values through jsxVal", () => {
    const keys = [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ];
    const code = getOp("keyframe.apply_ease")!.toJsx({
      comp: 'a"b',
      layer: 1,
      property: ['x"); evil("'],
      keys,
    });
    expect(code).toContain(`var _propPath = ${jsxVal(['x"); evil("'])};`);
    expect(code).toContain(jsxVal('a"b'));
  });

  it("returns a plain failure for bad keys, before anything reaches AE", () => {
    const code = getOp("keyframe.apply_ease")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["x"],
      keys: [{ time: 0, value: 0 }],
    });
    expect(code).toContain("at least 2");
    expect(code).not.toContain("applyKeySpecs");
  });

  it("asks confirm for replace: true, like keyframe.apply", async () => {
    const transport = nullTransport();
    const res = await doTool.handler(
      {
        operation: "keyframe.apply_ease",
        args: {
          comp: "Main",
          layer: 1,
          property: ["x"],
          keys: [
            { time: 0, value: 0 },
            { time: 1, value: 1 },
          ],
          replace: true,
        },
      },
      transport,
    );
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(transport.calls).toHaveLength(0);
  });
});

describe("keyframe.list_eases", () => {
  it("is read-only and returns the whole table", () => {
    const op = getOp("keyframe.list_eases")!;
    expect(op.readOnly).toBe(true);
    const code = op.toJsx({});
    const result = runJsx(code, {});
    expect(result.count).toBe(EASES.length);
    const material = (result.eases as Array<{ name: string; ae: unknown; license: string }>).find(
      (e) => e.name === "material-standard",
    )!;
    expect(material.ae).toEqual({
      out: { influence: 20, speedFactor: 0 },
      in: { influence: 100, speedFactor: 0 },
    });
    expect(es3Errors(code)).toEqual([]);
  });
});

// --- layer.stagger -------------------------------------------------------------

// The ordering rule is ES3 text shared with the generated code: evaluate THAT text.
// oxlint-disable-next-line no-new-func
const staggerRanks = new Function(`${STAGGER_RANKS_JSX}\nreturn _staggerRanks;`)() as (
  n: number,
  order: string,
  seed: number,
) => number[];

describe("layer.stagger: order", () => {
  it.each([
    ["normal", 5, [0, 1, 2, 3, 4]],
    ["reverse", 5, [4, 3, 2, 1, 0]],
    ["center", 5, [2, 1, 0, 1, 2]],
    ["center", 4, [1, 0, 0, 1]],
    ["center", 1, [0]],
    ["normal", 0, []],
  ] as Array<[string, number, number[]]>)("%s with %i layers", (order, n, ranks) => {
    expect(staggerRanks(n, order, 1)).toEqual(ranks);
  });

  it("shuffles with a seed: a permutation, the same every time for the same seed", () => {
    const a = staggerRanks(8, "random", 42);
    expect(a.toSorted((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(staggerRanks(8, "random", 42)).toEqual(a);
    expect(staggerRanks(8, "random", 7)).not.toEqual(a);
    expect(staggerRanks(8, "random", 0)).toEqual(staggerRanks(8, "random", 0));
    expect(staggerRanks(8, "random", 0).toSorted((x, y) => x - y)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("is ES3", () => {
    expect(es3Errors(STAGGER_RANKS_JSX)).toEqual([]);
  });
});

/** Layers with one animated Opacity each, as the stagger walk sees them. */
function fakeLayers(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const opacity = {
      propertyType: 1,
      matchName: "ADBE Opacity",
      dimensionsSeparated: false,
      keys: [{ time: 0 }, { time: 0.4 }],
      get numKeys() {
        return this.keys.length;
      },
    };
    const transform = { propertyType: 3, numProperties: 1, property: () => opacity };
    return {
      index: i + 1,
      name: `L${i + 1}`,
      startTime: 0,
      opacity,
      numProperties: 1,
      property: () => transform,
    };
  });
}

function staggerAE(layers: ReturnType<typeof fakeLayers>) {
  return {
    findCompByNameOrId: () => ({ name: "Main", frameDuration: 1 / 25 }),
    resolveLayers: () => layers,
    snapshotKeys: (p: { keys: Array<{ time: number }> }) => p.keys.map((k) => ({ ...k })),
    removeAllKeys: (p: { keys: unknown[] }) => {
      p.keys = [];
    },
    applyKeys: (p: { keys: unknown[] }, keys: unknown[]) => {
      p.keys = keys;
    },
    separationFollowers: () => null,
    propertyAtPath: (l: ReturnType<typeof fakeLayers>[number]) => l.opacity,
  };
}

function stagger(args: Record<string, unknown>, layers: ReturnType<typeof fakeLayers>) {
  const code = getOp("layer.stagger")!.toJsx({ comp: "Main", layers: "selected", ...args });
  return { code, result: runJsx(code, staggerAE(layers)) };
}

describe("layer.stagger: what it does", () => {
  it("passes the ES3 lint", () => {
    const { code } = stagger({ step: 2, unit: "frames" }, fakeLayers(1));
    expect(es3Errors(code)).toEqual([]);
  });

  it("shifts the keys by position × step, in frames", () => {
    const layers = fakeLayers(3);
    const { result } = stagger({ step: 2, unit: "frames" }, layers);
    expect(result.ok).toBe(true);
    expect(layers.map((l) => l.opacity.keys[0].time)).toEqual([0, 0.08, 0.16]);
    expect(layers.map((l) => l.startTime)).toEqual([0, 0, 0]);
    expect(result.warnings).toEqual([]);
  });

  it("moves the layer start in mode 'start', keys untouched", () => {
    const layers = fakeLayers(3);
    stagger({ step: 0.1, mode: "start", order: "reverse" }, layers);
    expect(layers.map((l) => Math.round(l.startTime * 1000) / 1000)).toEqual([0.2, 0.1, 0]);
    expect(layers.map((l) => l.opacity.keys[0].time)).toEqual([0, 0, 0]);
  });

  it("warns when the cascade lasts more than 0.5 s, not at exactly 0.5 s", () => {
    const over = stagger({ step: 0.1 }, fakeLayers(7)).result;
    expect((over.warnings as string[]).some((w) => w.includes("more than 0.5 s"))).toBe(true);
    const edge = stagger({ step: 0.1 }, fakeLayers(6)).result;
    expect((edge.warnings as string[]).some((w) => w.includes("0.5 s"))).toBe(false);
  });

  it("warns when a step in seconds is not a whole number of frames", () => {
    const { result } = stagger({ step: 0.05 }, fakeLayers(2));
    expect((result.warnings as string[]).some((w) => w.includes("whole number of frames"))).toBe(
      true,
    );
  });

  it("refuses to push keys below 0 s and then changes nothing at all", () => {
    const layers = fakeLayers(3);
    const { result } = stagger({ step: -0.1 }, layers);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("cannot be negative");
    expect(layers.map((l) => l.opacity.keys[0].time)).toEqual([0, 0, 0]);
  });

  it.each([
    [{ step: 1, unit: "beats" }, "unit must be"],
    [{ step: 1, mode: "middle" }, "mode must be"],
    [{ step: 1, order: "sideways" }, "order must be"],
    [{ step: 1, mode: "start", property: ["Transform", "Opacity"] }, "property only applies"],
    [{ step: Number.NaN }, "step must be"],
  ] as Array<[Record<string, unknown>, string]>)("refuses %j", (args, message) => {
    const code = getOp("layer.stagger")!.toJsx({ comp: "Main", layers: "selected", ...args });
    expect(code).toContain(message);
    expect(code).not.toContain("resolveLayers");
  });

  it("embeds the layer list through jsxVal", () => {
    const code = getOp("layer.stagger")!.toJsx({ comp: "Main", layers: ['a"); evil("'], step: 1 });
    expect(code).toContain(`AE.resolveLayers(_comp, ${jsxVal(['a"); evil("'])})`);
  });
});

// --- expression templates ----------------------------------------------------

describe("expression templates", () => {
  it("has the 22 templates of ishu86, no duplicate", () => {
    const keys = EXPRESSION_TEMPLATES.map((t) => t.key);
    expect(keys).toHaveLength(22);
    expect(new Set(keys).size).toBe(22);
    expect(keys.toSorted()).toEqual(
      [
        "wiggle",
        "wiggleSmooth",
        "wiggleFadeIn",
        "wiggleFadeOut",
        "loopCycle",
        "loopPingpong",
        "loopOffset",
        "loopContinue",
        "loopWithDelay",
        "clock",
        "countdown",
        "countup",
        "frameNumber",
        "bounce",
        "inertia",
        "springy",
        "matchPosition",
        "offsetPosition",
        "followWithDelay",
        "inverseRotation",
        "randomPosition",
        "randomRotation",
      ].toSorted(),
    );
  });

  it.each(EXPRESSION_TEMPLATES.map((t) => [t.key, t] as const))(
    "%s: every placeholder is a declared parameter with a default of its type, and it compiles",
    (_key, t) => {
      const placeholders = [...t.expression.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      expect(new Set(placeholders)).toEqual(new Set(Object.keys(t.parameters)));
      for (const [name, p] of Object.entries(t.parameters)) {
        expect(p.description, name).toMatch(/\S/);
        expect(Array.isArray(p.default) ? "array" : typeof p.default, name).toBe(p.type);
      }
      const rendered = renderTemplate(t.key);
      if (!rendered.ok) throw new Error(rendered.error);
      expect(rendered.expression).not.toContain("{{");
      // Compile only (never run): the text must be valid JavaScript.
      // oxlint-disable-next-line no-new-func
      expect(() => new Function(rendered.expression)).not.toThrow();
    },
  );

  it("fills parameters and keeps defaults for the others", () => {
    const r = renderTemplate("wiggleSmooth", { frequency: 4 });
    expect(r).toEqual({
      ok: true,
      expression:
        "var freq = 4;\nvar amp = 50;\nvar octaves = 2;\nvar mult = 0.5;\nwiggle(freq, amp, octaves, mult)",
    });
  });

  it("turns any string into a quoted literal: quotes, backslashes, line breaks, line separators", () => {
    for (const name of [
      'He said "hi"',
      "back\\slash",
      "a\nb",
      `x${LINE_SEP}y`,
      '"); app.quit(); ("',
    ]) {
      const r = renderTemplate("matchPosition", { targetLayer: name });
      if (!r.ok) throw new Error(r.error);
      const first = r.expression.split("\n")[0];
      expect(first.startsWith("var target = thisComp.layer(")).toBe(true);
      // Exactly one string literal, which parses back to the name given.
      const literal = first.slice("var target = thisComp.layer(".length, -2);
      expect(JSON.parse(literal)).toBe(name);
      // oxlint-disable-next-line no-new-func
      expect(() => new Function(r.expression)).not.toThrow();
      expect(r.expression).not.toContain(LINE_SEP);
    }
  });

  it("does not expand a placeholder hidden inside a value", () => {
    const r = renderTemplate("offsetPosition", { targetLayer: "{{offsetX}}" });
    if (!r.ok) throw new Error(r.error);
    expect(r.expression).toContain('thisComp.layer("{{offsetX}}")');
    expect(r.expression).toContain("var offset = [100, 0];");
  });

  it.each([
    ["nope", {}, "unknown template"],
    ["wiggle", { frequency: "2" }, "must be a number"],
    ["wiggle", { frequency: Number.POSITIVE_INFINITY }, "must be a number"],
    ["wiggle", { freq: 2 }, "has no parameter 'freq'"],
    ["matchPosition", { targetLayer: 3 }, "must be a string"],
  ] as Array<[string, Record<string, unknown>, string]>)(
    "refuses %s %j",
    (key, params, message) => {
      const r = renderTemplate(key, params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(message);
    },
  );

  it("expression.list_templates lists all 22, or one category", () => {
    const op = getOp("expression.list_templates")!;
    expect(op.readOnly).toBe(true);
    expect(runJsx(op.toJsx({}), {}).count).toBe(22);
    expect(runJsx(op.toJsx({ category: "physics" }), {}).count).toBe(3);
  });

  it("expression.apply_template embeds the rendered text through jsxVal and passes the ES3 lint", () => {
    const args = {
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      template: "matchPosition",
      params: { targetLayer: 'Logo "A"' },
    };
    const code = getOp("expression.apply_template")!.toJsx(args);
    const rendered = renderTemplate("matchPosition", { targetLayer: 'Logo "A"' });
    if (!rendered.ok) throw new Error(rendered.error);
    expect(code).toContain(`_node.expression = ${jsxVal(rendered.expression)};`);
    expect(es3Errors(code)).toEqual([]);
  });

  it("expression.apply_template replaces an existing expression only with confirm", () => {
    const base = { comp: "Main", layer: 1, property: ["x"], template: "wiggle" };
    expect(getOp("expression.apply_template")!.toJsx(base)).toContain(
      '_node.expression !== "" && true',
    );
    expect(getOp("expression.apply_template")!.toJsx({ ...base, confirm: true })).toContain(
      '_node.expression !== "" && false',
    );
  });

  it("expression.apply_template fails plainly on a bad template call", () => {
    const code = getOp("expression.apply_template")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["x"],
      template: "wiggle",
      params: { amp: 1 },
    });
    expect(code).toContain("has no parameter 'amp'");
    expect(code).not.toContain("_node.expression =");
  });
});
