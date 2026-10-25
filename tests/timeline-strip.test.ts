// The timeline strip, drawn from fake data — no After Effects involved:
// motion energy between consecutive frames, and pixel checks at positions
// the layout makes predictable (second ticks, motion bars, rendered-frame
// lines, keyframe ticks, layer spans).

import { describe, expect, it } from "vitest";

import { decodePng, encodePngSrgb8 } from "../src/color/png16.js";
import type { Raster } from "../src/color/sheet.js";
import {
  drawTimelineStrip,
  motionEnergy,
  STRIP_COLORS,
  STRIP_LAYOUT,
  type TimelineLayer,
} from "../src/color/strip.js";

function solid(width: number, height: number, v: number): Raster {
  return { width, height, rgb: new Float64Array(width * height * 3).fill(v) };
}

/** A black frame with a white 20×20 square whose left edge is at `x`. */
function squareAt(x: number): Raster {
  const img = solid(160, 90, 0);
  for (let y = 35; y < 55; y++) {
    for (let xx = x; xx < x + 20; xx++) {
      const i = (y * 160 + xx) * 3;
      img.rgb[i] = img.rgb[i + 1] = img.rgb[i + 2] = 1;
    }
  }
  return img;
}

function px(img: { width: number; rgb: Float64Array }, x: number, y: number): number[] {
  const i = (y * img.width + x) * 3;
  return [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]].map((v) => Math.round(v * 1000) / 1000);
}

function colorOf(c: readonly [number, number, number]): number[] {
  return c.map((v) => Math.round(v * 1000) / 1000);
}

describe("motionEnergy", () => {
  it("is zero between identical frames and grows with movement", () => {
    const frames = [squareAt(10), squareAt(10), squareAt(40), squareAt(120)];
    const seg = motionEnergy(frames, [0, 1, 2, 3]);
    expect(seg).toHaveLength(3);
    expect(seg[0].energy).toBe(0);
    expect(seg[1].energy).toBeGreaterThan(0);
    expect(seg[2].energy).toBeGreaterThan(0);
    expect(seg.map((s) => [s.fromIndex, s.toIndex])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("is the mean absolute grey difference: black vs white is 1", () => {
    const seg = motionEnergy([solid(32, 18, 0), solid(32, 18, 1)], [0, 0.5]);
    expect(seg[0].energy).toBeCloseTo(1, 6);
    expect(seg[0].from).toBe(0);
    expect(seg[0].to).toBe(0.5);
  });

  it("pairs frames in time order, whatever order they were requested in", () => {
    const seg = motionEnergy([squareAt(80), squareAt(0), squareAt(40)], [2, 0, 1]);
    expect(seg.map((s) => [s.fromIndex, s.toIndex])).toEqual([
      [1, 2],
      [2, 0],
    ]);
    expect(seg.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("needs two frames: one frame gives no segments", () => {
    expect(motionEnergy([solid(8, 8, 0)], [0])).toEqual([]);
  });
});

describe("drawTimelineStrip", () => {
  const layers: TimelineLayer[] = [
    { index: 1, name: "Title", inPoint: 0, outPoint: 4, enabled: true, keys: [0, 1, 2] },
    { index: 2, name: "Logo", inPoint: 2, outPoint: 4, enabled: true, keys: [3] },
  ];
  const strip = drawTimelineStrip({
    width: 600,
    duration: 4,
    frameTimes: [0, 2, 4],
    motion: [
      { fromIndex: 0, toIndex: 1, from: 0, to: 2, energy: 0.2 },
      { fromIndex: 1, toIndex: 2, from: 2, to: 4, energy: 0 },
    ],
    layers,
  });
  const L = STRIP_LAYOUT;

  it("is wide and low, with one row per layer", () => {
    expect(strip.width).toBe(600);
    expect(strip.height).toBe(L.pad + L.rulerH + L.motionH + L.frameRowH + 2 * L.rowPitch + L.pad);
    expect(strip.height).toBeLessThan(strip.width / 3);
    expect(strip.rows.map((r) => r.layerIndexes)).toEqual([[1], [2]]);
    expect(strip.rows.map((r) => r.keyCount)).toEqual([3, 1]);
  });

  it("maps time 0 to the plot's left edge and the duration to its right edge", () => {
    expect(strip.xForTime(0)).toBe(L.labelW);
    expect(strip.xForTime(4)).toBe(600 - L.pad - 1);
    expect(strip.xForTime(99)).toBe(600 - L.pad - 1);
  });

  it("draws a second tick in the ruler at every whole second", () => {
    const y = strip.yRuler + L.rulerH - 2;
    const x1 = strip.xForTime(1);
    expect(px(strip, x1, y)).toEqual(colorOf(STRIP_COLORS.tick));
    // halfway between two seconds: background
    const xHalf = Math.round((strip.xForTime(1) + strip.xForTime(2)) / 2);
    expect(px(strip, xHalf, y)).toEqual(colorOf(STRIP_COLORS.background));
  });

  it("draws a motion bar where something moved and none where nothing did", () => {
    const bottom = strip.yMotion + L.motionH - 2;
    const moving = Math.round((strip.xForTime(0) + strip.xForTime(2)) / 2);
    // 2.5 s, not 3 s: whole seconds carry a faint grid line.
    const still = strip.xForTime(2.5);
    expect(px(strip, moving, bottom)).toEqual(colorOf(STRIP_COLORS.motion));
    expect(px(strip, still, bottom)).toEqual(colorOf(STRIP_COLORS.background));
  });

  it("marks each rendered frame with a vertical line through the motion row", () => {
    const x = strip.xForTime(2);
    expect(px(strip, x, strip.yMotion + 2)).toEqual(colorOf(STRIP_COLORS.frame));
    expect(px(strip, x, strip.yRuler + 1)).toEqual(colorOf(STRIP_COLORS.frame));
  });

  it("draws the layer span and a keyframe tick on the layer's own row", () => {
    const row0 = strip.yRows;
    const mid0 = row0 + Math.floor(L.rowH / 2);
    // keyframe of layer 1 at 1 s
    expect(px(strip, strip.xForTime(1), mid0)).toEqual(colorOf(STRIP_COLORS.key));
    // layer 1 span between keys (1.5 s): span colour
    expect(px(strip, strip.xForTime(1.5), mid0)).toEqual(colorOf(STRIP_COLORS.span));
    const mid1 = row0 + L.rowPitch + Math.floor(L.rowH / 2);
    // layer 2 starts at 2 s: before that, no span
    expect(px(strip, strip.xForTime(1.5), mid1)).toEqual(colorOf(STRIP_COLORS.background));
    expect(px(strip, strip.xForTime(2.5), mid1)).toEqual(colorOf(STRIP_COLORS.span));
    expect(px(strip, strip.xForTime(3), mid1)).toEqual(colorOf(STRIP_COLORS.key));
  });

  it("survives a PNG round trip (8-bit, sRGB-tagged)", () => {
    const back = decodePng(encodePngSrgb8(strip.width, strip.height, strip.rgb));
    expect([back.width, back.height]).toEqual([strip.width, strip.height]);
  });

  it("with many layers, keeps the keyed ones and merges the overflow into one last row", () => {
    const many: TimelineLayer[] = Array.from({ length: L.maxRows * 2 + 10 }, (_, i) => ({
      index: i + 1,
      name: `L${i + 1}`,
      inPoint: 0,
      outPoint: 4,
      enabled: true,
      keys: i % 2 === 0 ? [i % 4] : [],
    }));
    const s = drawTimelineStrip({
      width: 400,
      duration: 4,
      frameTimes: [],
      motion: [],
      layers: many,
    });
    expect(s.rows).toHaveLength(L.maxRows);
    // Unkeyed layers are left out once there are too many to show.
    expect(s.layersOmitted).toBe(many.filter((l) => l.keys.length === 0).length);
    const keyed = many.filter((l) => l.keys.length > 0);
    expect(s.rows[0].layerIndexes).toEqual([keyed[0].index]);
    const last = s.rows[s.rows.length - 1];
    expect(last.merged).toBe(true);
    expect(last.layerIndexes).toEqual(keyed.slice(L.maxRows - 1).map((l) => l.index));
  });

  it("draws frames and ruler even with no layer data", () => {
    const s = drawTimelineStrip({
      width: 300,
      duration: 2,
      frameTimes: [1],
      motion: [],
      layers: [],
    });
    expect(s.rows).toEqual([]);
    expect(px(s, s.xForTime(1), s.yMotion + 2)).toEqual(colorOf(STRIP_COLORS.frame));
  });
});
