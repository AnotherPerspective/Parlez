// The pictures of the Parlez! panel's ON/OFF block (jsx/panel.jsx).
//
// After Effects delivers clicks to a ScriptUI `iconbutton` in "toolbutton"
// style reliably, and draws it without a frame or a focus outline; mouse
// events on groups never reach a script (seen on AE 26.5, 2026-10-27), and a
// native button inside a coloured frame looked wrong. So the block is a
// picture: a rounded rectangle full of the state's colour with ON or OFF in
// white, centred. One picture per state and per look the button takes
// (normal, mouse over, pressed), in two sizes (the vertical and the compact
// layout). They are generated here, not drawn by hand, so the colours stay
// those of the panel and nothing else ships but the PNGs.
//
// The letters are geometry - an elliptic ring, bars and a slanted band -
// rendered with 4×4 supersampling for smooth edges; only O, N and F are
// needed. Output is 8-bit RGBA PNG (transparent corners), encoded with
// node:zlib; no dependency.
//
// `npm run build` writes them to jsx/panel-images/ (scripts/
// build-panel-images.mjs); tests/panel-images.test.ts fails when the files
// there drift from what this module produces.

import * as zlib from "node:zlib";

export type Rgb = [number, number, number];

/** The panel's traffic-light colours (jsx/panel.jsx keeps the same values). */
export const PANEL_STATES: Record<string, { color: Rgb; word: "ON" | "OFF" }> = {
  on: { color: [0.2, 0.72, 0.36], word: "ON" },
  off: { color: [0.86, 0.24, 0.2], word: "OFF" },
  busy: { color: [0.95, 0.72, 0.12], word: "ON" },
  idle: { color: [0.42, 0.42, 0.42], word: "ON" },
};

/** Mouse over: 12% lighter. Pressed: 15% darker. */
export const PANEL_VARIANTS: Record<string, (c: Rgb) => Rgb> = {
  "": (c) => c,
  "-over": (c) => c.map((v) => v + (1 - v) * 0.12) as Rgb,
  "-down": (c) => c.map((v) => v * 0.85) as Rgb,
};

export const PANEL_SIZES: Record<string, { width: number; height: number }> = {
  "": { width: 320, height: 88 },
  "-small": { width: 200, height: 56 },
};

/** Every file name the panel loads: <state><variant><size>.png. */
export function panelImageNames(): string[] {
  const names: string[] = [];
  for (const state of Object.keys(PANEL_STATES)) {
    for (const size of Object.keys(PANEL_SIZES)) {
      for (const variant of Object.keys(PANEL_VARIANTS))
        names.push(`${state}${variant}${size}.png`);
    }
  }
  return names;
}

// --- Letters, in units of the cap height (0..1, y downwards) -------------

const STROKE = 0.22;
const GAP = 0.16;

interface Glyph {
  width: number;
  inside(x: number, y: number): boolean;
}

const GLYPHS: Record<string, Glyph> = {
  O: {
    width: 0.98,
    inside(x, y) {
      const cx = 0.49;
      const cy = 0.5;
      const outer = ((x - cx) / 0.49) ** 2 + ((y - cy) / 0.5) ** 2 <= 1;
      const inner = ((x - cx) / (0.49 - STROKE)) ** 2 + ((y - cy) / (0.5 - STROKE * 0.86)) ** 2 < 1;
      return outer && !inner;
    },
  },
  N: {
    width: 0.86,
    inside(x, y) {
      if (x < 0 || x > 0.86 || y < 0 || y > 1) return false;
      if (x <= STROKE || x >= 0.86 - STROKE) return true;
      const centre = STROKE / 2 + (0.86 - STROKE) * y;
      return Math.abs(x - centre) <= STROKE * 0.62;
    },
  },
  F: {
    width: 0.68,
    inside(x, y) {
      if (x < 0 || x > 0.68 || y < 0 || y > 1) return false;
      if (x <= STROKE) return true;
      if (y <= STROKE * 0.95) return true;
      return y >= 0.43 && y <= 0.43 + STROKE * 0.88 && x <= 0.6;
    },
  },
};

function wordWidth(word: string): number {
  let w = 0;
  for (const ch of word) w += GLYPHS[ch].width;
  return w + GAP * (word.length - 1);
}

/** Is (x, y) - in cap-height units from the word's top-left - on a letter? */
function onWord(word: string, x: number, y: number): boolean {
  let left = 0;
  for (const ch of word) {
    const g = GLYPHS[ch];
    if (x >= left && x <= left + g.width) return g.inside(x - left, y);
    left += g.width + GAP;
  }
  return false;
}

/** Inside a rounded rectangle of w×h with corner radius r (pixel units). */
function inRoundedRect(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const SUPERSAMPLE = 4;

/**
 * One picture, as straight (non-premultiplied) RGBA bytes: the block in
 * `color`, `word` in white, centred, cap height half the block's height.
 */
export function renderBlock(width: number, height: number, color: Rgb, word: string): Buffer {
  const out = Buffer.alloc(width * height * 4);
  const cap = Math.round(height * 0.46);
  const wordPx = wordWidth(word) * cap;
  const left = (width - wordPx) / 2;
  const top = (height - cap) / 2;
  const radius = Math.max(4, Math.round(height * 0.1));
  const n = SUPERSAMPLE;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let cover = 0;
      let ink = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = px + (sx + 0.5) / n;
          const y = py + (sy + 0.5) / n;
          if (!inRoundedRect(x, y, width, height, radius)) continue;
          cover++;
          if (onWord(word, (x - left) / cap, (y - top) / cap)) ink++;
        }
      }
      const i = (py * width + px) * 4;
      if (cover === 0) continue;
      const t = ink / cover;
      for (let ch = 0; ch < 3; ch++) {
        out[i + ch] = Math.round((color[ch] * (1 - t) + t) * 255);
      }
      out[i + 3] = Math.round((cover / (n * n)) * 255);
    }
  }
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGBA PNG, sRGB-tagged. Deterministic: same pixels, same bytes. */
export function encodePngRgba8(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Every picture the panel needs, by file name. */
export function buildPanelImages(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [state, { color, word }] of Object.entries(PANEL_STATES)) {
    for (const [size, { width, height }] of Object.entries(PANEL_SIZES)) {
      for (const [variant, tint] of Object.entries(PANEL_VARIANTS)) {
        const rgba = renderBlock(width, height, tint(color), word);
        files.set(`${state}${variant}${size}.png`, encodePngRgba8(width, height, rgba));
      }
    }
  }
  return files;
}
