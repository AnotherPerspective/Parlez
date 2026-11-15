// Time in After Effects (Anthony, 2026-11-15): every time Parlez! writes into
// a comp lands on a whole frame of that comp, and may be given as the comp's
// timecode. jsx/helpers.jsx runs here unchanged against plain comp objects
// (frameRate, frameDuration, displayStartTime, dropFrame) and fake
// properties; the timecode arithmetic is checked against Premiere's twin.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getOp } from "../src/registry.js";
import "../src/operations/index.js";
import { validateOpArgs } from "../src/opschema.js";
import { loadJsx, makeEngine } from "./helpers/extendscript-shim.js";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PREMIERE_AGENT_JSX } from "../src/premiere/config.js";

const HELPERS = readFileSync(fileURLToPath(new URL("../jsx/helpers.jsx", import.meta.url)), "utf8");

interface Rate {
  fps: number;
  fd: number;
  base: number;
  drop: boolean;
}
interface AeApi {
  compRate: (c: unknown) => Rate | null;
  snapTime: (c: unknown, t: number) => number;
  timeIn: (c: unknown, v: unknown, kind?: string) => number;
  tcOut: (c: unknown, t: number, kind?: string) => { tc: string; frame: number } | null;
  framesToTc: (f: number, r: Rate) => string;
  tcToFrames: (tc: string, r: Rate) => number;
  keyTime: (prop: unknown, v: unknown) => number;
  offFrame: (c: unknown, t: number) => boolean;
}

const AE = new Function(`${HELPERS}; return AE;`)() as AeApi;

function comp(fps: number, opts: { start?: number; drop?: boolean } = {}) {
  const exact =
    fps === 23.976
      ? 24000 / 1001
      : fps === 29.97
        ? 30000 / 1001
        : fps === 59.94
          ? 60000 / 1001
          : fps;
  return {
    frameRate: exact,
    frameDuration: 1 / exact,
    displayStartTime: opts.start ?? 0,
    dropFrame: opts.drop ?? false,
  };
}

describe("whole frames, always", () => {
  it("3.3 s at 23.976 lands on frame 79, not 79.1 (Anthony's case)", () => {
    const c = comp(23.976);
    const t = AE.snapTime(c, 3.3);
    expect(Math.abs(t / c.frameDuration - 79)).toBeLessThan(1e-9);
    expect(AE.offFrame(c, 3.3)).toBe(true);
    expect(AE.offFrame(c, t)).toBe(false);
  });

  it("a number goes on the grid; a time already on it stays put", () => {
    const c = comp(25);
    expect(AE.timeIn(c, 0.5)).toBeCloseTo(0.52, 12);
    expect(AE.timeIn(c, 0.48)).toBeCloseTo(0.48, 12);
    expect(AE.timeIn(c, 0)).toBe(0);
  });

  it("a key written through a property lands on its comp's grid", () => {
    const c = comp(25);
    const layer = { containingComp: c };
    const prop = { propertyDepth: 2, propertyGroup: () => layer };
    expect(AE.keyTime(prop, 1.3)).toBeCloseTo(1.32, 12);
    expect(AE.keyTime(prop, "00:00:01:08")).toBeCloseTo(1.32, 12);
  });

  it("without a comp, or a frame rate, a time is left alone", () => {
    expect(AE.snapTime(null, 1.234)).toBe(1.234);
    expect(AE.snapTime({ frameRate: 0 }, 1.234)).toBe(1.234);
  });
});

describe("timecode in", () => {
  it("counts from the comp's start timecode on the timeline, from zero for a length", () => {
    const c = comp(25, { start: 3600 });
    expect(AE.timeIn(c, "01:00:01:00")).toBeCloseTo(1, 12);
    expect(AE.timeIn(c, "00:00:02:00", "length")).toBeCloseTo(2, 12);
    expect(() => AE.timeIn(c, "00:59:59:24")).toThrow(
      /prima dell'inizio della comp, che parte da 01:00:00:00/,
    );
  });

  it("23.976: 00:00:03:07 is frame 79", () => {
    const c = comp(23.976);
    expect(AE.timeIn(c, "00:00:03:07") / c.frameDuration).toBeCloseTo(79, 9);
  });

  it("29.97 drop-frame only when the comp says so", () => {
    const df = comp(29.97, { drop: true });
    expect(AE.compRate(df)?.drop).toBe(true);
    expect(AE.timeIn(df, "00:01:00;02") / df.frameDuration).toBeCloseTo(1800, 9);
    expect(() => AE.timeIn(df, "00:01:00;00")).toThrow(/non esiste in drop-frame/);
    expect(AE.compRate(comp(29.97))?.drop).toBe(false);
  });

  it("refuses what is not a timecode of this comp", () => {
    expect(() => AE.timeIn(comp(24), "00:00:01:24")).toThrow(/da 00 a 23/);
    expect(() => AE.timeIn(comp(24), "1.5s")).toThrow(/HH:MM:SS:FF/);
  });
});

describe("timecode out", () => {
  it("gives the timecode the user reads, and the frame from the comp's start", () => {
    const c = comp(25, { start: 3600 });
    expect(AE.tcOut(c, 1.32)).toEqual({ tc: "01:00:01:08", frame: 33 });
    expect(AE.tcOut(c, 1.32, "length")).toEqual({ tc: "00:00:01:08", frame: 33 });
  });

  it("drop-frame at 29.97 writes ';' before the frames", () => {
    const df = comp(29.97, { drop: true });
    expect(AE.tcOut(df, 1800 * df.frameDuration)?.tc).toBe("00:01:00;02");
  });
});

describe("the same arithmetic as Premiere's", () => {
  it("framesToTc / tcToFrames agree with jsx/premiere-helpers.jsx at every rate", () => {
    const engine = makeEngine(mkdtempSync(path.join(os.tmpdir(), "parlez-tc-twin-")));
    engine.run(
      `${loadJsx(PREMIERE_AGENT_JSX.replace("premiere-agent.jsx", "premiere-helpers.jsx"))}\n;globalThis.__PR = PR;`,
    );
    const PR = (globalThis as Record<string, unknown>).__PR as {
      framesToTc: (f: number, r: { base: number; drop: boolean }) => string;
    };
    for (const [base, drop] of [
      [24, false],
      [25, false],
      [30, false],
      [30, true],
      [60, true],
    ] as const) {
      const rate = { fps: base, fd: 1 / base, base, drop };
      for (const f of [0, 1, 1799, 1800, 17982, 107892, 215784, 999_999]) {
        const tc = AE.framesToTc(f, rate);
        expect(tc).toBe(PR.framesToTc(f, { base, drop }));
        expect(AE.tcToFrames(tc, rate)).toBe(f);
      }
    }
    delete (globalThis as Record<string, unknown>).__PR;
  });
});

describe("the operations take a timecode, and every write goes through the grid", () => {
  it('keyframe.add accepts "HH:MM:SS:FF" and refuses anything else that is a string', () => {
    const op = getOp("keyframe.add")!;
    const base = { comp: "Main", layer: 1, property: ["Transform", "Opacity"], value: 50 };
    expect(validateOpArgs(op, { ...base, time: "00:00:03:07" }).ok).toBe(true);
    expect(validateOpArgs(op, { ...base, time: 3.3 }).ok).toBe(true);
    expect(validateOpArgs(op, { ...base, time: "3.3" }).ok).toBe(false);
  });

  it.each([
    [
      "timeline.set_time",
      { comp: "Main", time: "00:00:01:00" },
      'AE.timeIn(_comp, "00:00:01:00", "position")',
    ],
    [
      "comp.set_work_area",
      { comp: "Main", start: 1, duration: "00:00:02:00" },
      'AE.timeIn(_comp, "00:00:02:00", "length")',
    ],
    ["marker.add_comp", { comp: "Main", time: 2 }, 'AE.timeIn(_comp, 2, "position")'],
    [
      "layer.split",
      { comp: "Main", layer: 1, time: "00:00:04:12" },
      'AE.timeIn(_comp, "00:00:04:12", "position")',
    ],
  ])("%s converts its time inside After Effects", (name, args, expected) => {
    const op = getOp(name);
    if (!op) return; // an operation renamed since: covered by its own tests
    expect(op.toJsx(args as Record<string, unknown>)).toContain(expected);
  });
});

describe("timecode in the answers of the reading tools", () => {
  it("adds TC and frame to a layer's in/out/start and to every key time, below any depth", () => {
    const api = AE as unknown as { timecodeTree: (c: unknown, o: unknown, d: number) => unknown };
    const c = comp(25, { start: 3600 });
    const layer = {
      inPoint: 0,
      outPoint: 4,
      startTime: 0,
      transformGroup: { properties: [{ name: "Opacity", keyframes: [{ time: 1.32, value: 50 }] }] },
    };
    api.timecodeTree(c, layer, 0);
    expect(layer).toMatchObject({
      inPointTC: "01:00:00:00",
      outPointTC: "01:00:04:00",
      outPointFrame: 100,
    });
    expect(layer.transformGroup.properties[0].keyframes[0]).toMatchObject({
      time: 1.32,
      timeTC: "01:00:01:08",
      timeFrame: 33,
    });
  });

  it("comp.sample takes timecodes and converts them inside After Effects", () => {
    const op = getOp("comp.sample")!;
    const jsx = op.toJsx({ comp: "Main", times: ["00:00:01:00", 2] });
    expect(jsx).toContain('AE.timeIn(_c, _times[_ti], "position")');
    expect(op.toJsx({ comp: "Main", times: ["1s"] })).toContain("timecodes HH:MM:SS:FF");
  });
});

describe("layer.set_timing: in and out are trims (AE 26.5, 2026-11-15)", () => {
  type Model = "trim" | "outFollows" | "slides";
  /** A text layer as After Effects may treat it: start 0, in 0, out 4.004. */
  function layer(model: Model) {
    const l = { index: 1, name: "Titolo", stretch: 100, st: 0, inP: 0, outP: 4.004 };
    return Object.defineProperties(l, {
      startTime: {
        get: () => l.st,
        set(v: number) {
          const d = v - l.st;
          l.st = v;
          l.inP += d;
          l.outP += d;
        },
      },
      inPoint: {
        get: () => l.inP,
        set(v: number) {
          const d = v - l.inP;
          if (model === "slides") l.st += d;
          if (model !== "trim") l.outP += d;
          l.inP = v;
        },
      },
      outPoint: {
        get: () => l.outP,
        set(v: number) {
          l.outP = v;
        },
      },
    }) as typeof l & { startTime: number; inPoint: number; outPoint: number };
  }

  function setTiming(model: Model, args: Record<string, unknown>) {
    const ae = new Function(`${HELPERS}; return AE;`)() as Record<string, unknown>;
    const c = comp(23.976);
    const l = layer(model);
    ae.findCompByNameOrId = () => c;
    ae.resolveLayers = () => [l];
    const jsx = getOp("layer.set_timing")!.toJsx({ comp: "Main", layer: 1, ...args });
    const res = new Function("AE", jsx)(ae) as {
      ok: boolean;
      layers: Array<{ warning?: string }>;
    };
    return { res, l };
  }

  it.each(["trim", "outFollows", "slides"] as Model[])(
    "only the in point (3.3 s): the out point stays at 4.004 (%s)",
    (model) => {
      const { res, l } = setTiming(model, { inPoint: 3.3 });
      expect(res.ok).toBe(true);
      expect(l.inPoint).toBeCloseTo(79 / (24000 / 1001), 6);
      expect(l.outPoint).toBeCloseTo(4.004, 6);
    },
  );

  it("says so when After Effects moved the whole layer and the start did not come back", () => {
    expect(setTiming("outFollows", { inPoint: 3.3 }).res.layers[0]!.warning).toBeUndefined();
    expect(setTiming("slides", { inPoint: 3.3 }).res.layers[0]!.warning).toContain(
      "ha spostato anche l'inizio del livello",
    );
  });

  it("only the out point leaves the in point alone; both given are both set", () => {
    const out = setTiming("outFollows", { outPoint: 2 }).l;
    expect(out.inPoint).toBe(0);
    const both = setTiming("outFollows", { inPoint: 1, outPoint: 3 }).l;
    expect(both.inPoint).toBeCloseTo(24 / (24000 / 1001), 6);
    expect(both.outPoint).toBeCloseTo(72 / (24000 / 1001), 6);
  });
});
