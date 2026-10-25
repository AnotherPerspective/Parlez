// frame.compare (M5.2): render vs reference on a grid of cells, ΔE2000 of the
// cell means, pass/fail against thresholds. Synthetic images only.

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RUNTIME_DIR } from "../src/config.js";
import { compareImages } from "../src/color/compare.js";
import { decodePng } from "../src/color/png16.js";
import type { Raster, Rgb } from "../src/color/sheet.js";
import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import type { ImageContent } from "../src/tools/types.js";
import { canvas, roundedRect, shiftRight, writePng } from "./helpers/images.js";
import { nullTransport } from "./helpers/null-transport.js";

const WHITE: Rgb = [1, 1, 1];
const BARS: Rgb[] = [
  [0.85, 0.1, 0.1],
  [0.1, 0.2, 0.85],
  [0.1, 0.65, 0.2],
];

/** 480×480, white, three 60 px vertical bars at x = 60, 180, 300. */
function bars(): Raster {
  const img = canvas(480, 480, WHITE);
  BARS.forEach((c, i) => roundedRect(img, 60 + i * 120, 0, 60, 480, 0, c));
  return img;
}

/** Scale every channel towards white a little: a faint, even tint. */
function tint(img: Raster, k: number): Raster {
  return { ...img, rgb: img.rgb.map((v) => v + (1 - v) * k) };
}

let dir: string;
let ref: string;
let same: string;
let shifted: string;
let tinted: string;
let half: string;
let wide: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "parlez-m5-compare-"));
  ref = await writePng(path.join(dir, "ref.png"), bars());
  same = await writePng(path.join(dir, "same.png"), bars());
  shifted = await writePng(path.join(dir, "shifted.png"), shiftRight(bars(), 10, WHITE));
  tinted = await writePng(path.join(dir, "tinted.png"), tint(bars(), 0.04));
  // the same picture at half size
  const small = canvas(240, 240, WHITE);
  BARS.forEach((c, i) => roundedRect(small, 30 + i * 60, 0, 30, 240, 0, c));
  half = await writePng(path.join(dir, "half.png"), small);
  wide = await writePng(path.join(dir, "wide.png"), canvas(640, 360, WHITE));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Cell = { riga: number; colonna: number; deltaE: number; area: { x: number; w: number } };
type Result = {
  ok: boolean;
  error?: string;
  media: number;
  massimo: number;
  fuori: { celle: number; percentuale: number };
  passa: boolean;
  esito: string;
  griglia: [number, number];
  size: [number, number];
  peggiori: Cell[];
  avvisi?: string[];
};

async function compare(args: Record<string, unknown>): Promise<Result> {
  return (await getOp("frame.compare")!.run!(args, nullTransport())) as Result;
}

describe("frame.compare", () => {
  it("identical images: ΔE 0 everywhere, passes", async () => {
    const r = await compare({ file: same, reference: ref });
    expect(r.ok).toBe(true);
    expect(r.griglia).toEqual([24, 24]);
    expect(r.media).toBe(0);
    expect(r.massimo).toBe(0);
    expect(r.fuori).toEqual({ celle: 0, percentuale: 0 });
    expect(r.passa).toBe(true);
    expect(r.esito).toMatch(/passa/);
  });

  it("shifted by 10 px: fails, and the worst cells sit on the bars' edges", async () => {
    const r = await compare({ file: shifted, reference: ref });
    expect(r.passa).toBe(false);
    expect(r.fuori.percentuale).toBeGreaterThan(0.05);
    expect(r.peggiori.length).toBe(10);
    // 20 px cells: the edges at x = 60, 120, 180, 240, 300, 360 fall in
    // columns 3, 6, 9, 12, 15, 18 — the only cells the shift can change.
    const edgeColumns = new Set([3, 6, 9, 12, 15, 18]);
    for (const c of r.peggiori) {
      expect(edgeColumns.has(c.colonna)).toBe(true);
      expect(c.deltaE).toBeGreaterThan(10);
      expect(c.area.w).toBe(20);
    }
    // worst first
    const des = r.peggiori.map((c) => c.deltaE);
    expect(des).toEqual([...des].sort((a, b) => b - a));
  });

  it("a faint even tint passes the defaults but fails a strict cell threshold", async () => {
    const loose = await compare({ file: tinted, reference: ref });
    expect(loose.passa).toBe(true);
    expect(loose.media).toBeGreaterThan(0);
    expect(loose.media).toBeLessThan(8);
    const strict = await compare({ file: tinted, reference: ref, sogliaCella: 0.5 });
    expect(strict.passa).toBe(false);
    const strictMean = await compare({ file: tinted, reference: ref, maxMedia: 0.1 });
    expect(strictMean.passa).toBe(false);
  });

  it("brings different sizes to the same size before comparing", async () => {
    const r = await compare({ file: half, reference: ref });
    expect(r.size).toEqual([240, 240]);
    expect(r.passa).toBe(true);
    expect(r.media).toBeLessThan(1);
  });

  it("warns when the aspect ratios differ", async () => {
    const r = await compare({ file: wide, reference: ref });
    expect(r.ok).toBe(true);
    expect((r.avvisi ?? []).join(" ")).toMatch(/proporzioni/);
  });

  it("takes a custom grid", async () => {
    const r = await compare({ file: same, reference: ref, griglia: 8 });
    expect(r.griglia).toEqual([8, 8]);
  });

  it("returns the difference map inline unless mappa: false", async () => {
    const withMap = await doTool.handler(
      { operation: "frame.compare", args: { file: shifted, reference: ref } },
      nullTransport(),
    );
    const imgs = withMap.content.filter((c): c is ImageContent => c.type === "image");
    expect(imgs).toHaveLength(1);
    const map = decodePng(Buffer.from(imgs[0].data, "base64"));
    expect(map.width).toBeGreaterThan(0);
    const noMap = await doTool.handler(
      { operation: "frame.compare", args: { file: shifted, reference: ref, mappa: false } },
      nullTransport(),
    );
    expect(noMap.content.filter((c) => c.type === "image")).toHaveLength(0);
  });

  it("refuses mailbox paths and non-PNG files", async () => {
    const r = await compare({ file: path.join(RUNTIME_DIR, "a.png"), reference: ref });
    expect(r.ok).toBe(false);
    const txt = path.join(dir, "notes.txt");
    await import("node:fs").then((fs) => fs.writeFileSync(txt, "hello"));
    const r2 = await compare({ file: same, reference: txt });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/solo PNG/);
  });
});

describe("compareImages (pure)", () => {
  it("maps worst-cell areas back to the file's own pixel grid", () => {
    const a = canvas(96, 96, WHITE);
    const b = canvas(48, 48, WHITE);
    roundedRect(b, 0, 0, 2, 2, 0, [0, 0, 0]); // top-left cell differs
    const r = compareImages(a, b, { grid: 4 });
    expect(r.size).toEqual([48, 48]);
    expect(r.worst[0]).toMatchObject({ row: 0, col: 0 });
    // the file (a) is 96 px wide: its first 4×4-grid cell is 24 px
    expect(r.worst[0].area).toEqual({ x: 0, y: 0, w: 24, h: 24 });
  });
});
