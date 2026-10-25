// Synthetic test images for the M5 measurements: flat fills, antialiased
// rounded rectangles (4×4 supersampling, so edges carry partial coverage the
// way real renders do), linear gradients, and text from sheet.ts's 5×7 font.

import { promises as fs } from "node:fs";

import { encodePngSrgb8 } from "../../src/color/png16.js";
import { drawText, type Raster, type Rgb } from "../../src/color/sheet.js";

export function canvas(width: number, height: number, fill: Rgb): Raster {
  const rgb = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = fill[0];
    rgb[i * 3 + 1] = fill[1];
    rgb[i * 3 + 2] = fill[2];
  }
  return { width, height, rgb };
}

function inRoundedRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): boolean {
  if (px < x || px >= x + w || py < y || py >= y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** Antialiased rounded rectangle (radius r, 0 = square corners). */
export function roundedRect(
  img: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: Rgb,
): void {
  const S = 4;
  for (let py = Math.floor(y) - 1; py <= Math.ceil(y + h); py++) {
    for (let px = Math.floor(x) - 1; px <= Math.ceil(x + w); px++) {
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (inRoundedRect(px + (sx + 0.5) / S, py + (sy + 0.5) / S, x, y, w, h, r)) hits++;
        }
      }
      if (hits === 0) continue;
      const a = hits / (S * S);
      const i = (py * img.width + px) * 3;
      for (let c = 0; c < 3; c++) img.rgb[i + c] = img.rgb[i + c] * (1 - a) + color[c] * a;
    }
  }
}

/** Horizontal linear gradient (in encoded values) over the whole image. */
export function horizontalGradient(width: number, height: number, from: Rgb, to: Rgb): Raster {
  const img = canvas(width, height, [0, 0, 0]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) img.rgb[i + c] = from[c] + (to[c] - from[c]) * t;
    }
  }
  return img;
}

/** Text in the 5×7 font: cap height = 7 × scale px exactly. */
export function text(
  img: Raster,
  x: number,
  y: number,
  s: string,
  scale: number,
  color: Rgb,
): void {
  drawText(img.rgb, img.width, x, y, s, color, scale);
}

/** Shift the whole picture right by dx px, filling the gap with `fill`. */
export function shiftRight(img: Raster, dx: number, fill: Rgb): Raster {
  const out = canvas(img.width, img.height, fill);
  for (let y = 0; y < img.height; y++) {
    for (let x = dx; x < img.width; x++) {
      const s = (y * img.width + x - dx) * 3;
      const d = (y * img.width + x) * 3;
      out.rgb[d] = img.rgb[s];
      out.rgb[d + 1] = img.rgb[s + 1];
      out.rgb[d + 2] = img.rgb[s + 2];
    }
  }
  return out;
}

export async function writePng(file: string, img: Raster): Promise<string> {
  await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
  return file;
}

export const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];
