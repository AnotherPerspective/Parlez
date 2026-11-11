// Frame check against a reference (M5.2): both images are
// brought to one size, cut into a grid, and each cell's mean color is
// compared with CIEDE2000.
//
// Cell means, not single pixels: a 1-px misregistration or a different
// antialiasing should not fail a frame, a wrong color or a misplaced block
// should. The mean is taken on the encoded values — close to what the eye
// averages over a small area, and the same space the PNGs are in.

import { fitLongEdge } from "./inline.js";
import { deltaE2000, srgbToLab } from "./lab.js";
import { resample, type Raster, type Rgb } from "./sheet.js";

export interface CompareOptions {
  /** Cells per side (columns = rows). */
  grid: number;
  /** A cell is "out" above this ΔE2000. */
  cellThreshold?: number;
  /** Pass needs at most this fraction of cells out (0..1). */
  maxOutside?: number;
  /** Pass needs the mean ΔE at most this. */
  maxMean?: number;
  /** How many of the worst cells to list. */
  worst?: number;
}

export const COMPARE_DEFAULTS = {
  grid: 24,
  cellThreshold: 10,
  maxOutside: 0.05,
  maxMean: 8,
  worst: 10,
} as const;

export interface WorstCell {
  row: number;
  col: number;
  deltaE: number;
  /** The cell in the FILE's own pixels (x, y, w, h). */
  area: { x: number; y: number; w: number; h: number };
  color: Rgb;
  referenceColor: Rgb;
}

export interface CompareResult {
  /** Common size both images were brought to. */
  size: [number, number];
  grid: [number, number];
  /** ΔE2000 per cell, row-major. */
  cells: Float64Array;
  mean: number;
  max: number;
  outside: { count: number; fraction: number };
  pass: boolean;
  worst: WorstCell[];
  aspectMismatch: boolean;
  thresholds: { cellThreshold: number; maxOutside: number; maxMean: number };
}

/** First pixel of cell `i` along an axis of `n` pixels cut in `cells` (resample's binning). */
function cellStart(i: number, n: number, cells: number): number {
  return Math.ceil((i * n) / cells);
}

function shrinkTo(img: Raster, w: number, h: number): Raster {
  if (img.width === w && img.height === h) return img;
  return { width: w, height: h, rgb: resample(img, w, h) };
}

export function compareImages(
  file: Raster,
  reference: Raster,
  opts: CompareOptions,
): CompareResult {
  const cellThreshold = opts.cellThreshold ?? COMPARE_DEFAULTS.cellThreshold;
  const maxOutside = opts.maxOutside ?? COMPARE_DEFAULTS.maxOutside;
  const maxMean = opts.maxMean ?? COMPARE_DEFAULTS.maxMean;
  const worstN = opts.worst ?? COMPARE_DEFAULTS.worst;
  // The smaller size on each axis: both images only ever shrink, so no
  // invented pixels; area averaging keeps the colors honest.
  const W = Math.min(file.width, reference.width);
  const H = Math.min(file.height, reference.height);
  const cols = opts.grid;
  const rows = opts.grid;
  if (cols > W || rows > H) {
    throw new Error(`grid ${cols}×${rows} is finer than the images (${W}×${H} px)`);
  }
  const a = resample(shrinkTo(file, W, H), cols, rows);
  const b = resample(shrinkTo(reference, W, H), cols, rows);

  const cells = new Float64Array(cols * rows);
  let sum = 0;
  let max = 0;
  let out = 0;
  for (let i = 0; i < cells.length; i++) {
    const ca: Rgb = [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
    const cb: Rgb = [b[i * 3], b[i * 3 + 1], b[i * 3 + 2]];
    const de = deltaE2000(srgbToLab(ca), srgbToLab(cb));
    cells[i] = de;
    sum += de;
    if (de > max) max = de;
    if (de > cellThreshold) out++;
  }
  const mean = sum / cells.length;
  const fraction = out / cells.length;

  const sx = file.width / W;
  const sy = file.height / H;
  const order = Array.from(cells.keys())
    .filter((i) => cells[i] > 0)
    .sort((i, j) => cells[j] - cells[i])
    .slice(0, worstN);
  const worst = order.map((i): WorstCell => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x0 = Math.round(cellStart(col, W, cols) * sx);
    const x1 = Math.round(cellStart(col + 1, W, cols) * sx);
    const y0 = Math.round(cellStart(row, H, rows) * sy);
    const y1 = Math.round(cellStart(row + 1, H, rows) * sy);
    return {
      row,
      col,
      deltaE: cells[i],
      area: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      color: [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]],
      referenceColor: [b[i * 3], b[i * 3 + 1], b[i * 3 + 2]],
    };
  });

  const ra = file.width / file.height;
  const rb = reference.width / reference.height;
  return {
    size: [W, H],
    grid: [cols, rows],
    cells,
    mean,
    max,
    outside: { count: out, fraction },
    pass: fraction <= maxOutside && mean <= maxMean,
    worst,
    aspectMismatch: Math.abs(ra - rb) / rb > 0.01,
    thresholds: { cellThreshold, maxOutside, maxMean },
  };
}

const GREEN: Rgb = [0.2, 0.75, 0.3];
const YELLOW: Rgb = [0.95, 0.8, 0.15];
const RED: Rgb = [0.9, 0.15, 0.1];

function ramp(t: number): Rgb {
  const [p, q, k] = t < 0.5 ? [GREEN, YELLOW, t * 2] : [YELLOW, RED, (t - 0.5) * 2];
  return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
}

/**
 * The file in dimmed grey with every cell tinted from green (ΔE 0) through
 * yellow (the cell threshold) to red (twice the threshold or more), so the
 * places that differ show at a glance.
 */
export function differenceMap(file: Raster, result: CompareResult, maxEdge = 512): Raster {
  const base = fitLongEdge(file, maxEdge);
  const [cols, rows] = result.grid;
  const threshold = result.thresholds.cellThreshold;
  const rgb = new Float64Array(base.width * base.height * 3);
  for (let y = 0; y < base.height; y++) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / base.height));
    for (let x = 0; x < base.width; x++) {
      const col = Math.min(cols - 1, Math.floor((x * cols) / base.width));
      const de = result.cells[row * cols + col];
      const tint = ramp(Math.min(1, de / (2 * threshold)));
      const i = (y * base.width + x) * 3;
      const grey =
        0.35 * (0.2126 * base.rgb[i] + 0.7152 * base.rgb[i + 1] + 0.0722 * base.rgb[i + 2]);
      for (let c = 0; c < 3; c++) rgb[i + c] = grey + 0.6 * tint[c];
    }
  }
  return { width: base.width, height: base.height, rgb };
}
