// The timeline strip: one wide, low image of a composition's time axis, so a
// motion check reads at a glance — where the rendered frames sit, how much
// changed between consecutive frames ("motion energy"), and where each
// layer lives and has keyframes. Idea from malkawi06/After-Effects-mcp-pro
// (MIT); this drawing code is our own. Pure Node: rectangles and the 5×7
// font from sheet.ts, no graphics library.
//
//   ┌──────────────────────────────────────────────┐
//   │     0s    1s    2s    3s        ruler         │
//   │     ▆▆▆▆▆|▂▂▂▂▂|                motion        │
//   │     #0    #1    #2              frames        │
//   │  1  ───◆─────◆──────────        layer rows    │
//   │  2        ─────────◆────                      │
//   └──────────────────────────────────────────────┘

import { drawText, resample, textWidth, type Raster, type Rgb } from "./sheet.js";

export interface TimelineLayer {
  index: number;
  name: string;
  inPoint: number;
  outPoint: number;
  enabled: boolean;
  /** Keyframe times in comp seconds, any property of the layer. */
  keys: number[];
}

export interface MotionSegment {
  fromIndex: number;
  toIndex: number;
  from: number;
  to: number;
  /** Mean absolute grey difference between the two frames, 0..1. */
  energy: number;
}

export const STRIP_LAYOUT = {
  pad: 6,
  /** Left margin for row labels; time 0 sits at this x. */
  labelW: 30,
  rulerH: 22,
  motionH: 56,
  frameRowH: 14,
  rowH: 10,
  rowPitch: 14,
  /** More layers than this: unkeyed layers go, then the overflow merges into one row. */
  maxRows: 24,
} as const;

export const STRIP_COLORS = {
  background: [0.09, 0.09, 0.09],
  grid: [0.16, 0.16, 0.16],
  tick: [0.55, 0.55, 0.55],
  label: [0.75, 0.75, 0.75],
  motion: [1, 0.55, 0.24],
  frame: [0.3, 0.8, 0.95],
  span: [0.3, 0.3, 0.3],
  spanDisabled: [0.18, 0.18, 0.18],
  key: [0.95, 0.95, 0.95],
} as const satisfies Record<string, Rgb>;

/**
 * Energy that fills the motion row. The bars scale to the largest segment,
 * but never below this floor — otherwise sensor-level noise between two
 * nearly identical frames would draw as full-height movement.
 */
const MOTION_FLOOR = 0.02;

/** Thumbnail width for the energy measure: enough to see movement, cheap. */
export const ENERGY_THUMB_W = 64;

function grey(img: Raster, tw: number, th: number): Float64Array {
  const rgb = resample(img, tw, th);
  const out = new Float64Array(tw * th);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  }
  return out;
}

/**
 * Motion energy between consecutive frames in TIME order (requests may come
 * in any order): mean absolute difference of small greyscale thumbnails.
 * All thumbnails share the first frame's thumbnail size so frames of
 * different sizes still compare.
 */
export function motionEnergy(frames: Raster[], times: number[]): MotionSegment[] {
  if (frames.length < 2) return [];
  const order = frames.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const first = frames[order[0]];
  const tw = Math.max(1, Math.min(ENERGY_THUMB_W, first.width));
  const th = Math.max(1, Math.round((first.height * tw) / first.width));
  const thumbs = new Map<number, Float64Array>();
  const thumb = (i: number): Float64Array => {
    let t = thumbs.get(i);
    if (!t) {
      t = grey(frames[i], tw, th);
      thumbs.set(i, t);
    }
    return t;
  };
  const out: MotionSegment[] = [];
  for (let k = 1; k < order.length; k++) {
    const a = thumb(order[k - 1]);
    const b = thumb(order[k]);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    out.push({
      fromIndex: order[k - 1],
      toIndex: order[k],
      from: times[order[k - 1]],
      to: times[order[k]],
      energy: sum / a.length,
    });
  }
  return out;
}

export interface StripInput {
  width: number;
  /** Comp duration in seconds: the ruler spans 0..duration. */
  duration: number;
  /** Rendered frame times, index-aligned with the frames. */
  frameTimes: number[];
  motion: MotionSegment[];
  layers: TimelineLayer[];
}

export interface StripRow {
  row: number;
  /** One layer, or several when this is the merged overflow row. */
  layerIndexes: number[];
  keyCount: number;
  merged: boolean;
}

export interface StripImage {
  width: number;
  height: number;
  rgb: Float64Array;
  rows: StripRow[];
  /** Unkeyed layers left out because there were too many to show. */
  layersOmitted: number;
  xForTime: (t: number) => number;
  yRuler: number;
  yMotion: number;
  yFrames: number;
  yRows: number;
}

/** Ruler label step: the smallest "round" number of seconds that leaves room for a label. */
const LABEL_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export function drawTimelineStrip(input: StripInput): StripImage {
  const L = STRIP_LAYOUT;
  const C = STRIP_COLORS;
  const width = Math.max(L.labelW + L.pad + 16, Math.round(input.width));
  const duration =
    input.duration > 0 ? input.duration : Math.max(1, ...input.frameTimes.filter((t) => t > 0));

  // Row selection: every layer when they fit; otherwise the keyed ones (a
  // static layer's bar says little), and past maxRows the rest share a row.
  const keyed = input.layers.filter((l) => l.keys.length > 0);
  const shown = input.layers.length <= L.maxRows ? input.layers : keyed;
  const layersOmitted = input.layers.length - shown.length;
  const groups: TimelineLayer[][] =
    shown.length <= L.maxRows
      ? shown.map((l) => [l])
      : [...shown.slice(0, L.maxRows - 1).map((l) => [l]), shown.slice(L.maxRows - 1)];

  const yRuler = L.pad;
  const yMotion = yRuler + L.rulerH;
  const yFrames = yMotion + L.motionH;
  const yRows = yFrames + L.frameRowH;
  const height = yRows + groups.length * L.rowPitch + L.pad;
  const rgb = new Float64Array(width * height * 3);

  const x0 = L.labelW;
  const x1 = width - L.pad - 1;
  const xForTime = (t: number): number =>
    x0 + Math.round(Math.min(1, Math.max(0, t / duration)) * (x1 - x0));

  const fill = (x: number, y: number, w: number, h: number, c: Rgb): void => {
    const xa = Math.max(0, x);
    const ya = Math.max(0, y);
    const xb = Math.min(width, x + w);
    const yb = Math.min(height, y + h);
    for (let yy = ya; yy < yb; yy++) {
      for (let xx = xa; xx < xb; xx++) {
        const i = (yy * width + xx) * 3;
        rgb[i] = c[0];
        rgb[i + 1] = c[1];
        rgb[i + 2] = c[2];
      }
    }
  };

  fill(0, 0, width, height, C.background);

  // Seconds: a faint grid through everything below the ruler, short ticks in
  // the ruler, a label every `step` seconds. Too dense to tick every second
  // (long comps on a narrow strip) → only the labelled ones.
  const pxPerSec = (x1 - x0) / duration;
  const labelRoom = textWidth("0000s", 1) + 4;
  const step =
    LABEL_STEPS.find((s) => s * pxPerSec >= labelRoom) ?? LABEL_STEPS[LABEL_STEPS.length - 1];
  const tickEvery = pxPerSec >= 4 ? 1 : step;
  for (let s = 0; s <= duration + 1e-9; s += tickEvery) {
    const x = xForTime(s);
    const labelled = Math.abs(s / step - Math.round(s / step)) < 1e-9;
    fill(x, yMotion, 1, height - L.pad - yMotion, C.grid);
    const tickH = labelled ? 10 : 6;
    fill(x, yMotion - tickH, 1, tickH, C.tick);
    if (labelled) {
      // The last label would run off the right edge: tuck it left of its tick.
      const text = `${s}s`;
      const lx = x + 2 + textWidth(text, 1) > width ? x - textWidth(text, 1) : x + 2;
      drawText(rgb, width, lx, yRuler + 2, text, C.label, 1);
    }
  }

  // Motion: one bar per segment between consecutive frames, baseline below.
  fill(x0, yMotion + L.motionH - 1, x1 - x0 + 1, 1, C.grid);
  const maxEnergy = Math.max(MOTION_FLOOR, ...input.motion.map((m) => m.energy));
  for (const m of input.motion) {
    const xa = xForTime(m.from);
    const xb = xForTime(m.to);
    const h =
      m.energy > 0
        ? Math.max(1, Math.round((L.motionH - 4) * Math.min(1, m.energy / maxEnergy)))
        : 0;
    fill(xa + 1, yMotion + L.motionH - 1 - h, Math.max(1, xb - xa - 1), h, C.motion);
  }

  // Layer rows: index label, in–out span, a small diamond per keyframe.
  const rows: StripRow[] = [];
  for (const [r, group] of groups.entries()) {
    const y = yRows + r * L.rowPitch;
    const merged = shown.length > L.maxRows && r === L.maxRows - 1;
    drawText(rgb, width, L.pad, y + 1, merged ? "+" : String(group[0].index), C.label, 1);
    let keyCount = 0;
    for (const layer of group) {
      const xa = xForTime(Math.max(0, layer.inPoint));
      const xb = xForTime(Math.min(duration, layer.outPoint));
      if (xb > xa) fill(xa, y + 2, xb - xa, L.rowH - 4, layer.enabled ? C.span : C.spanDisabled);
    }
    for (const layer of group) {
      for (const t of layer.keys) {
        const xc = xForTime(t);
        for (let dy = 0; dy < L.rowH; dy++) {
          const half = Math.min(2, dy < L.rowH / 2 ? dy : L.rowH - 1 - dy);
          fill(xc - half, y + dy, 2 * half + 1, 1, C.key);
        }
        keyCount++;
      }
    }
    rows.push({ row: r, layerIndexes: group.map((l) => l.index), keyCount, merged });
  }

  // Rendered frames last, so their lines sit on top of ruler and motion bars.
  let labelEnd = -Infinity;
  const byTime = input.frameTimes.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  for (const { t, i } of byTime) {
    const x = xForTime(t);
    fill(x, yRuler, 1, yFrames - yRuler, C.frame);
    const label = `#${i}`;
    const lx = Math.min(x + 2, x1 - textWidth(label, 1));
    if (lx > labelEnd) {
      drawText(rgb, width, lx, yFrames + 3, label, C.frame, 1);
      labelEnd = lx + textWidth(label, 1);
    }
  }

  return { width, height, rgb, rows, layersOmitted, xForTime, yRuler, yMotion, yFrames, yRows };
}
