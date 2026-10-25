// reference.measure (M5.1, "passaporto della reference") on three synthetic
// test images whose true measurements are known by construction — the
// offline stand-in for "measured by hand". Tolerances, as the plan sets
// them: ±2 px for lengths, ΔE2000 ≤ 2 for colors.
//
//   1. card     640×360: dark background, an orange rounded rectangle
//               (radius 24) and the text "2026" (cap height 56 px)
//   2. gradient 512×128: blue → orange, left to right
//   3. corners  400×200: a square-cornered box and a pill (radius = h/2)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RUNTIME_DIR } from "../src/config.js";
import { deltaE2000, srgbToLab } from "../src/color/lab.js";
import { capHeight, cornerRadius, estimateFontSize, swatchMedian } from "../src/color/measure.js";
import { decodePng } from "../src/color/png16.js";
import type { Rgb } from "../src/color/sheet.js";
import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import type { ImageContent } from "../src/tools/types.js";
import {
  canvas,
  hexToRgb,
  horizontalGradient,
  roundedRect,
  text,
  writePng,
} from "./helpers/images.js";
import { nullTransport } from "./helpers/null-transport.js";

const BG: Rgb = [30 / 255, 30 / 255, 40 / 255];
const ORANGE: Rgb = [232 / 255, 93 / 255, 58 / 255];
const WHITE: Rgb = [1, 1, 1];
const BLUE: Rgb = [0, 0, 1];
const AMBER: Rgb = [1, 0.5, 0];

let dir: string;
let card: string;
let gradient: string;
let corners: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "parlez-m5-measure-"));
  const c = canvas(640, 360, BG);
  roundedRect(c, 100, 80, 300, 160, 24, ORANGE);
  text(c, 440, 150, "2026", 8, WHITE);
  card = await writePng(path.join(dir, "card.png"), c);
  gradient = await writePng(
    path.join(dir, "gradient.png"),
    horizontalGradient(512, 128, BLUE, AMBER),
  );
  const k = canvas(400, 200, WHITE);
  roundedRect(k, 20, 20, 140, 80, 0, [0.1, 0.2, 0.3]);
  roundedRect(k, 200, 40, 160, 60, 30, [0.2, 0.6, 0.3]);
  corners = await writePng(path.join(dir, "corners.png"), k);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Result = Record<string, unknown> & { ok: boolean; error?: string };

async function measure(args: Record<string, unknown>): Promise<Result> {
  return (await getOp("reference.measure")!.run!(args, nullTransport())) as Result;
}

function dE(a: readonly number[], b: readonly number[]): number {
  return deltaE2000(srgbToLab(a as Rgb), srgbToLab(b as Rgb));
}

describe("reference.measure — sizes and colors", () => {
  it("reports the image size and a point's color as RGB 0–1 and hex", async () => {
    const r = await measure({ file: card, punti: [[250, 160]] });
    expect(r.ok).toBe(true);
    expect(r.size).toEqual([640, 360]);
    const [p] = r.punti as Array<{ at: number[]; rgb: number[]; hex: string }>;
    expect(p.at).toEqual([250, 160]);
    expect(p.hex).toBe("#E85D3A");
    expect(dE(p.rgb, ORANGE)).toBeLessThanOrEqual(2);
  });

  it("swatch: the median color of an area, robust to stray pixels", async () => {
    const r = await measure({ file: card, swatch: [{ x: 150, y: 120, w: 200, h: 80 }] });
    const [s] = r.swatch as Array<{ rgb: number[]; hex: string; pixel: number }>;
    expect(s.pixel).toBe(200 * 80);
    expect(dE(s.rgb, ORANGE)).toBeLessThanOrEqual(2);
    // a fifth of the area painted white does not move the median
    const img = canvas(50, 50, ORANGE);
    for (let i = 0; i < 500; i++) img.rgb.fill(1, i * 15, i * 15 + 3);
    const noisy = swatchMedian(img, { x: 0, y: 0, w: 50, h: 50 });
    expect(dE(noisy.rgb, ORANGE)).toBeLessThan(0.5);
  });

  it("gradient: N stops along a segment, each the local median color", async () => {
    const r = await measure({
      file: gradient,
      gradienti: [{ da: [0, 64], a: [511, 64], tappe: 5 }],
    });
    const [g] = r.gradienti as Array<{ tappe: Array<{ t: number; at: number[]; rgb: number[] }> }>;
    expect(g.tappe.map((s) => s.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    for (const s of g.tappe) {
      const want = BLUE.map((v, c) => v + (AMBER[c] - v) * (s.at[0] / 511));
      expect(dE(s.rgb, want)).toBeLessThanOrEqual(2);
    }
    expect(g.tappe[0].at).toEqual([0, 64]);
    expect(g.tappe[4].at).toEqual([511, 64]);
  });
});

describe("reference.measure — corner radius", () => {
  it("finds radius 24 on the card's rounded rectangle, every corner within ±2 px", async () => {
    const r = await measure({ file: card, raggi: [{ x: 90, y: 70, w: 320, h: 180 }] });
    const [m] = r.raggi as Array<{
      raggio: number;
      angoli: Record<string, number>;
      larghezza: number;
      altezza: number;
      riempimento: string;
      affidabile: boolean;
    }>;
    expect(Math.abs(m.raggio - 24)).toBeLessThanOrEqual(2);
    for (const v of Object.values(m.angoli)) expect(Math.abs(v - 24)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.larghezza - 300)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.altezza - 160)).toBeLessThanOrEqual(2);
    expect(dE(hexToRgb(m.riempimento), ORANGE)).toBeLessThanOrEqual(2);
    expect(m.affidabile).toBe(true);
  });

  it("square corners measure about 0; a pill measures half its height and says so", async () => {
    const r = await measure({
      file: corners,
      raggi: [
        { x: 10, y: 10, w: 160, h: 100 },
        { x: 190, y: 30, w: 180, h: 80 },
      ],
    });
    const [square, pill] = r.raggi as Array<{ raggio: number; note: string[] }>;
    expect(square.raggio).toBeLessThanOrEqual(2);
    expect(Math.abs(pill.raggio - 30)).toBeLessThanOrEqual(2);
    expect(pill.note.join(" ")).toMatch(/pillola|metà/);
  });

  it("holds within ±2 px on a noisy, 8-bit quantized picture", () => {
    let seed = 7;
    const noise = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32 - 0.5;
    };
    const img = canvas(400, 200, [0.95, 0.95, 0.95]);
    roundedRect(img, 200.3, 40.6, 160, 60, 24, [0.2, 0.3, 0.6]);
    for (let i = 0; i < img.rgb.length; i++) {
      img.rgb[i] =
        Math.round(Math.min(1, Math.max(0, img.rgb[i] + (noise() * 6) / 255)) * 255) / 255;
    }
    const m = cornerRadius(img, { x: 190, y: 30, w: 180, h: 80 });
    expect(Math.abs(m.raggio - 24)).toBeLessThanOrEqual(2);
    expect(m.affidabile).toBe(true);
  });

  it("is not reliable when shape and background have almost the same color", () => {
    const img = canvas(120, 80, [0.5, 0.5, 0.5]);
    roundedRect(img, 20, 20, 80, 40, 10, [0.51, 0.5, 0.5]);
    const m = cornerRadius(img, { x: 10, y: 10, w: 100, h: 60 });
    expect(m.affidabile).toBe(false);
  });
});

describe("reference.measure — text size", () => {
  it("measures the cap height of '2026' (56 px) and estimates the font size from it", async () => {
    const r = await measure({ file: card, testo: [{ x: 430, y: 140, w: 205, h: 80 }] });
    const [t] = r.testo as Array<{
      altezzaMaiuscole: number;
      corpoStimato: number;
      corpoMin: number;
      corpoMax: number;
      nota: string;
    }>;
    expect(Math.abs(t.altezzaMaiuscole - 56)).toBeLessThanOrEqual(2);
    expect(t.corpoStimato).toBeCloseTo(56 / 0.7, 0);
    expect(t.corpoMin).toBeLessThan(t.corpoStimato);
    expect(t.corpoMax).toBeGreaterThan(t.corpoStimato);
    expect(t.nota).toMatch(/stima/);
  });

  it("ignores a faint background and counts two text lines as two bands", () => {
    const img = canvas(200, 120, [0.95, 0.95, 0.95]);
    text(img, 10, 10, "12", 4, [0, 0, 0]); // 28 px
    text(img, 10, 60, "34", 4, [0, 0, 0]);
    const m = capHeight(img, { x: 0, y: 0, w: 200, h: 120 });
    expect(m.righe).toBe(2);
    expect(Math.abs(m.altezzaMaiuscole - 28)).toBeLessThanOrEqual(1);
    expect(estimateFontSize(28).corpo).toBeCloseTo(40, 6);
  });
});

describe("reference.measure — scalaVerso and crop", () => {
  it("rescales coordinates and lengths to the destination comp width", async () => {
    const r = await measure({
      file: card,
      scalaVerso: 1920,
      punti: [[250, 160]],
      raggi: [{ x: 90, y: 70, w: 320, h: 180 }],
      testo: [{ x: 430, y: 140, w: 205, h: 80 }],
    });
    expect(r.scala).toBe(3);
    const [p] = r.punti as Array<{ scalato: number[] }>;
    expect(p.scalato).toEqual([750, 480]);
    const [m] = r.raggi as Array<{ raggioScalato: number }>;
    expect(Math.abs(m.raggioScalato - 72)).toBeLessThanOrEqual(6);
    const [t] = r.testo as Array<{ altezzaScalata: number; corpoScalato: number }>;
    expect(Math.abs(t.altezzaScalata - 168)).toBeLessThanOrEqual(6);
    expect(t.corpoScalato).toBeCloseTo(t.altezzaScalata / 0.7, 0);
  });

  it("crop comes back enlarged, inline, with nearest-neighbour pixels", async () => {
    const res = await doTool.handler(
      {
        operation: "reference.measure",
        args: { file: card, crop: { x: 380, y: 60, w: 40, h: 40 } },
      },
      nullTransport(),
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].type).toBe("text");
    const imgs = res.content.filter((c): c is ImageContent => c.type === "image");
    expect(imgs).toHaveLength(1);
    const png = decodePng(Buffer.from(imgs[0].data, "base64"));
    expect([png.width, png.height]).toEqual([320, 320]);
    // every 8×8 block is one source pixel
    const at = (x: number, y: number) =>
      Array.from(png.rgb.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3));
    expect(at(0, 0)).toEqual(at(7, 7));
    const result = (res.structuredContent as { result: Record<string, unknown> }).result;
    expect(result.crop).toMatchObject({ zoom: 8, size: [320, 320] });
    expect(result.inlineImages).toBeUndefined(); // the image travels as a block, not inside the JSON
  });
});

describe("reference.measure — refusals", () => {
  it("refuses a file inside the mailbox", async () => {
    const r = await measure({ file: path.join(RUNTIME_DIR, "x.png") });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mailbox|cassetta/i);
  });

  it("refuses a file that is not a PNG: only PNG for now", async () => {
    const jpg = path.join(dir, "photo.jpg");
    writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]));
    const r = await measure({ file: jpg });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/solo PNG/);
  });

  it("reports a missing file and a box outside the image", async () => {
    expect((await measure({ file: path.join(dir, "nope.png") })).ok).toBe(false);
    const r = await measure({ file: card, swatch: [{ x: 700, y: 0, w: 10, h: 10 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fuori/);
  });

  it("with no measurement asked, answers with the size alone", async () => {
    const r = await measure({ file: card });
    expect(r.ok).toBe(true);
    expect(r.size).toEqual([640, 360]);
  });
});
