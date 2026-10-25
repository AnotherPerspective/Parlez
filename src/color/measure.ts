// Measurements on a reference image — the "passaporto della reference"
// (M5.1, nome provvisorio): colors, gradient stops, corner radii, text size,
// enlarged crops. Idea from a public description of a fidelity
// passport; the methods and code are ours. Pure functions on decoded pixels:
// no After Effects, no dependency.
//
// Output keys are Italian because they go straight to the model and from
// there to the user; colors are encoded sRGB 0..1 as decodePng gives them.

import { resample, type Raster, type Rgb } from "./sheet.js";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A decoded image, with alpha when the PNG had it. */
export type Picture = Raster & { alpha?: Float64Array };

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function toHex(rgb: readonly number[]): string {
  return (
    "#" +
    rgb
      .slice(0, 3)
      .map((v) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}

export function roundRgb(rgb: readonly number[]): Rgb {
  return [round(rgb[0], 4), round(rgb[1], 4), round(rgb[2], 4)];
}

/**
 * Intersect a caller's box with the image, in whole pixels. Null when
 * nothing of it is inside.
 */
export function clipBox(img: Raster, box: Box): Box | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------
// Medians via histograms: exact for 8- and 16-bit sources, linear time.

const BINS = 65536;

class ChannelHistogram {
  readonly counts = [new Uint32Array(BINS), new Uint32Array(BINS), new Uint32Array(BINS)];
  n = 0;
  add(img: Raster, pixel: number): void {
    const i = pixel * 3;
    for (let c = 0; c < 3; c++) {
      const v = img.rgb[i + c];
      this.counts[c][Math.round(Math.min(1, Math.max(0, v)) * (BINS - 1))]++;
    }
    this.n++;
  }
  /** Value at quantile q (0..1) of channel c. */
  quantile(c: number, q: number): number {
    const target = Math.min(this.n - 1, Math.floor(q * this.n));
    let seen = 0;
    const counts = this.counts[c];
    for (let b = 0; b < BINS; b++) {
      seen += counts[b];
      if (seen > target) return b / (BINS - 1);
    }
    return 1;
  }
  median(): Rgb {
    return [this.quantile(0, 0.5), this.quantile(1, 0.5), this.quantile(2, 0.5)];
  }
}

function boxHistogram(img: Raster, box: Box): ChannelHistogram {
  const h = new ChannelHistogram();
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) h.add(img, y * img.width + x);
  }
  return h;
}

/** Median color of the 1-px ring along a box's edge: what surrounds a shape. */
function ringMedian(img: Raster, box: Box): Rgb {
  const h = new ChannelHistogram();
  const x1 = box.x + box.w - 1;
  const y1 = box.y + box.h - 1;
  for (let x = box.x; x <= x1; x++) {
    h.add(img, box.y * img.width + x);
    if (y1 !== box.y) h.add(img, y1 * img.width + x);
  }
  for (let y = box.y + 1; y < y1; y++) {
    h.add(img, y * img.width + box.x);
    if (x1 !== box.x) h.add(img, y * img.width + x1);
  }
  return h.median();
}

// ---------------------------------------------------------------------------
// Colors

export function colorAt(img: Picture, x: number, y: number): { rgb: Rgb; alpha?: number } {
  const i = (y * img.width + x) * 3;
  const rgb: Rgb = [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]];
  return img.alpha ? { rgb, alpha: img.alpha[y * img.width + x] } : { rgb };
}

export interface Swatch {
  rgb: Rgb;
  pixel: number;
  /**
   * How uneven the area is: the widest 10th–90th percentile range over the
   * three channels (0 = one flat color). Large values mean the median sits
   * on a texture or a gradient, not a flat fill.
   */
  dispersione: number;
}

/** Median per channel over a box (assumed clipped): ignores stray pixels, unlike a mean. */
export function swatchMedian(img: Raster, box: Box): Swatch {
  const h = boxHistogram(img, box);
  let spread = 0;
  for (let c = 0; c < 3; c++) spread = Math.max(spread, h.quantile(c, 0.9) - h.quantile(c, 0.1));
  return { rgb: h.median(), pixel: h.n, dispersione: spread };
}

export interface GradientStop {
  t: number;
  at: [number, number];
  rgb: Rgb;
}

/**
 * `stops` evenly spaced colors along a segment, each the median of a small
 * square around its point (radius 2 → 5×5 px), so one noisy pixel cannot
 * set a stop.
 */
export function gradientStops(
  img: Raster,
  from: [number, number],
  to: [number, number],
  stops: number,
  radius = 2,
): GradientStop[] {
  const out: GradientStop[] = [];
  for (let i = 0; i < stops; i++) {
    const t = stops === 1 ? 0 : i / (stops - 1);
    const x = Math.min(img.width - 1, Math.max(0, Math.round(from[0] + (to[0] - from[0]) * t)));
    const y = Math.min(img.height - 1, Math.max(0, Math.round(from[1] + (to[1] - from[1]) * t)));
    const box = clipBox(img, {
      x: x - radius,
      y: y - radius,
      w: 2 * radius + 1,
      h: 2 * radius + 1,
    })!;
    out.push({ t: round(t, 4), at: [x, y], rgb: swatchMedian(img, box).rgb });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corner radius

export interface CornerRadius {
  raggio: number;
  angoli: { altoSinistra: number; altoDestra: number; bassoSinistra: number; bassoDestra: number };
  larghezza: number;
  altezza: number;
  riempimento: Rgb;
  sfondo: Rgb;
  affidabile: boolean;
  note: string[];
}

/** Area a corner of radius r leaves out of its square: r² − πr²/4. */
const CORNER_DEFICIT = 1 - Math.PI / 4;

/**
 * Radius of a rounded rectangle inside `box`, from areas rather than from
 * the curve itself — robust to antialiasing and to a few noisy pixels:
 *
 * 1. background = median of the box's border ring; fill = median of the
 *    middle of the box (the shape is assumed to sit in it);
 * 2. every pixel gets a coverage 0..1 = how far its color is from the
 *    background towards the fill (antialiased edges count partially);
 * 3. width and height = the coverage sums of the rows and columns of the
 *    straight sides; the shape's area = the sum of all coverage;
 * 4. a rounded corner removes r²(1 − π/4) from the w×h rectangle, so each
 *    quarter (split at the coverage centroid) gives its corner's radius,
 *    and the whole gives the average one.
 *
 * Limits: one flat fill on one flat background, axis-aligned, nothing else
 * inside the box. Gradients, borders, shadows, rotation or a box that cuts
 * the shape break it — the result says so (`affidabile: false`, `note`).
 */
export function cornerRadius(img: Raster, box: Box): CornerRadius {
  const notes: string[] = [];
  const bg = ringMedian(img, box);
  const inner =
    clipBox(img, {
      x: box.x + box.w / 3,
      y: box.y + box.h / 3,
      w: box.w / 3,
      h: box.h / 3,
    }) ?? box;
  const fg = swatchMedian(img, inner).rgb;
  const d = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const contrast = Math.sqrt(dd);

  const rows = new Float64Array(box.h);
  const cols = new Float64Array(box.w);
  let total = 0;
  let sx = 0;
  let sy = 0;
  const cov = new Float64Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const i = ((box.y + y) * img.width + box.x + x) * 3;
      let c = 0;
      if (dd > 0) {
        c =
          ((img.rgb[i] - bg[0]) * d[0] +
            (img.rgb[i + 1] - bg[1]) * d[1] +
            (img.rgb[i + 2] - bg[2]) * d[2]) /
          dd;
        // Snap the quantization noise of flat areas to exactly 0 or 1.
        c = c < 0.02 ? 0 : c > 0.98 ? 1 : c;
      }
      cov[y * box.w + x] = c;
      rows[y] += c;
      cols[x] += c;
      total += c;
      sx += c * (x + 0.5);
      sy += c * (y + 0.5);
    }
  }

  // The widest rows (tallest columns): along a straight side every row is
  // that long, and a pill has only its middle rows at full width — a median
  // over "nearly full" rows would come out short. Three, not one, so a
  // single noisy row cannot set it.
  const sideLength = (sums: Float64Array): number => {
    const top = [...sums].sort((a, b) => b - a).slice(0, 3);
    return top.length > 0 ? top.reduce((s, v) => s + v, 0) / top.length : 0;
  };
  const W = sideLength(rows);
  const H = sideLength(cols);
  const cx = total > 0 ? sx / total : box.w / 2;
  const cy = total > 0 ? sy / total : box.h / 2;

  // Coverage per quarter, splitting the pixel that straddles the centroid.
  const quarter = [0, 0, 0, 0]; // TL, TR, BL, BR
  for (let y = 0; y < box.h; y++) {
    const fy = Math.min(1, Math.max(0, cy - y)); // share of this row above cy
    for (let x = 0; x < box.w; x++) {
      const c = cov[y * box.w + x];
      if (c === 0) continue;
      const fx = Math.min(1, Math.max(0, cx - x)); // share left of cx
      quarter[0] += c * fx * fy;
      quarter[1] += c * (1 - fx) * fy;
      quarter[2] += c * fx * (1 - fy);
      quarter[3] += c * (1 - fx) * (1 - fy);
    }
  }
  const maxR = Math.min(W, H) / 2;
  const radiusOf = (missing: number, corners: number): number =>
    Math.min(maxR, Math.sqrt(Math.max(0, missing) / (corners * CORNER_DEFICIT)));
  const qArea = (W / 2) * (H / 2);
  const corner = quarter.map((q) => round(radiusOf(qArea - q, 1), 1));
  const r = radiusOf(W * H - total, 4);

  let reliable = true;
  if (contrast < 0.08) {
    reliable = false;
    notes.push("forma e sfondo hanno quasi lo stesso colore: misura poco affidabile");
  }
  const ringCoverage =
    (rows[0] + rows[box.h - 1] + cols[0] + cols[box.w - 1]) / (2 * (box.w + box.h));
  if (ringCoverage > 0.05) {
    reliable = false;
    notes.push("il riquadro taglia la forma: allargalo in modo che resti un bordo di sfondo");
  }
  if (W === 0 || H === 0) {
    reliable = false;
    notes.push("nessuna forma trovata nel riquadro");
  }
  if (reliable && r < 4) {
    notes.push(
      "raggi sotto 4 px sono al limite: con rumore o compressione possono risultare di qualche pixel più grandi",
    );
  }
  if (maxR > 0 && r >= 0.95 * maxR) {
    notes.push("pillola: il raggio è (quasi) la metà del lato corto");
  }
  const spread = Math.max(...corner) - Math.min(...corner);
  if (spread > Math.max(2, 0.25 * r)) notes.push("gli angoli hanno raggi diversi: vedi `angoli`");
  return {
    raggio: round(r, 1),
    angoli: {
      altoSinistra: corner[0],
      altoDestra: corner[1],
      bassoSinistra: corner[2],
      bassoDestra: corner[3],
    },
    larghezza: round(W, 1),
    altezza: round(H, 1),
    riempimento: fg,
    sfondo: bg,
    affidabile: reliable,
    note: notes,
  };
}

// ---------------------------------------------------------------------------
// Text size

export interface CapHeight {
  /** Height in px of the tallest band of "ink" rows: the capitals' height when the box holds capitals. */
  altezzaMaiuscole: number;
  /** Top and bottom row of that band, in image coordinates. */
  da: number;
  a: number;
  /** Separate bands of ink found (lines of text). */
  righe: number;
  sfondo: Rgb;
  soglia: number;
}

/**
 * Cap height from "ink": a pixel is ink when one channel differs from the
 * background (median of the box's border ring) by more than `threshold`.
 * Rows holding ink form bands; the tallest band is the measured height.
 * Gaps of one row are bridged (thin horizontal strokes).
 */
export function capHeight(img: Raster, box: Box, threshold = 0.25): CapHeight {
  const bg = ringMedian(img, box);
  const inkRow: boolean[] = [];
  for (let y = box.y; y < box.y + box.h; y++) {
    let ink = false;
    for (let x = box.x; x < box.x + box.w && !ink; x++) {
      const i = (y * img.width + x) * 3;
      ink =
        Math.abs(img.rgb[i] - bg[0]) > threshold ||
        Math.abs(img.rgb[i + 1] - bg[1]) > threshold ||
        Math.abs(img.rgb[i + 2] - bg[2]) > threshold;
    }
    inkRow.push(ink);
  }
  const bands: Array<[number, number]> = [];
  for (let y = 0; y < inkRow.length; y++) {
    if (!inkRow[y]) continue;
    const last = bands[bands.length - 1];
    if (last && y - last[1] <= 2) last[1] = y;
    else bands.push([y, y]);
  }
  let best: [number, number] | null = null;
  for (const b of bands) if (!best || b[1] - b[0] > best[1] - best[0]) best = b;
  const tallest = best ? best[1] - best[0] + 1 : 0;
  const lines = bands.filter((b) => b[1] - b[0] + 1 >= 0.3 * tallest).length;
  return {
    altezzaMaiuscole: tallest,
    da: best ? box.y + best[0] : box.y,
    a: best ? box.y + best[1] : box.y,
    righe: lines,
    sfondo: bg,
    soglia: threshold,
  };
}

/**
 * Cap height is a fraction of the font size (the em): about 0.70 for common
 * sans serifs (Helvetica/Arial 0.72, Roboto 0.71, Inter 0.73), lower for
 * many serifs (Times 0.66), higher for some display faces. The range uses
 * 0.66–0.75. In After Effects the font size is that em in px at 100 % scale.
 */
export function estimateFontSize(cap: number): { corpo: number; min: number; max: number } {
  return { corpo: cap / 0.7, min: cap / 0.75, max: cap / 0.66 };
}

// ---------------------------------------------------------------------------
// Crop

export const CROP_TARGET_EDGE = 768;
export const CROP_MAX_EDGE = 1536;

/**
 * Cut `box` out and enlarge it by a whole factor with nearest-neighbour
 * pixels — every source pixel becomes a visible square, which is the point
 * of a magnifier. Default factor: about 768 px on the long edge, at most 8×.
 */
export function cropZoom(img: Raster, box: Box, zoom?: number): { image: Raster; zoom: number } {
  const long = Math.max(box.w, box.h);
  let z = zoom ?? Math.max(1, Math.min(8, Math.floor(CROP_TARGET_EDGE / long)));
  z = Math.max(1, Math.min(z, Math.floor(CROP_MAX_EDGE / long) || 1));
  const w = box.w * z;
  const h = box.h * z;
  const rgb = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = box.y + Math.floor(y / z);
    for (let x = 0; x < w; x++) {
      const s = (sy * img.width + box.x + Math.floor(x / z)) * 3;
      const d = (y * w + x) * 3;
      rgb[d] = img.rgb[s];
      rgb[d + 1] = img.rgb[s + 1];
      rgb[d + 2] = img.rgb[s + 2];
    }
  }
  let image: Raster = { width: w, height: h, rgb };
  // A crop wider than the cap at 1× is shrunk instead of enlarged.
  if (Math.max(w, h) > CROP_MAX_EDGE) {
    const k = CROP_MAX_EDGE / Math.max(w, h);
    const tw = Math.max(1, Math.round(w * k));
    const th = Math.max(1, Math.round(h * k));
    image = { width: tw, height: th, rgb: resample(image, tw, th) };
  }
  return { image, zoom: z };
}
