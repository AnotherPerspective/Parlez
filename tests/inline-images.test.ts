// Inline images for ae_render_frame, on synthetic rasters — no After Effects
// involved: the long-edge fit (sizes and pixel averaging), the filtered PNG
// encoder, which images each `inline` mode picks, and the byte budget that
// shrinks or drops them.

import { describe, expect, it } from "vitest";

import {
  encodeInlineImages,
  fitLongEdge,
  gridThumbWidth,
  INLINE_AUTO_MAX_FRAMES,
  INLINE_MIN_SIZE,
  inlineWorkWidth,
  selectInlineSources,
  type InlineSource,
} from "../src/color/inline.js";
import { decodePng, encodePngSrgb8 } from "../src/color/png16.js";
import type { Raster } from "../src/color/sheet.js";

function solid(width: number, height: number, fill: [number, number, number]): Raster {
  const rgb = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = fill[0];
    rgb[i * 3 + 1] = fill[1];
    rgb[i * 3 + 2] = fill[2];
  }
  return { width, height, rgb };
}

/** Deterministic noise: incompressible, so byte budgets bite. */
function noise(width: number, height: number, seed = 1): Raster {
  const rgb = new Float64Array(width * height * 3);
  let s = seed >>> 0;
  for (let i = 0; i < rgb.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    rgb[i] = (s >>> 24) / 255;
  }
  return { width, height, rgb };
}

function pixel(img: Raster, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 3;
  return [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]];
}

function base64Bytes(data: string): number {
  return Buffer.from(data, "base64").length;
}

describe("fitLongEdge", () => {
  it("scales a landscape frame so the long edge equals the limit, keeping the aspect", () => {
    const out = fitLongEdge(solid(1920, 1080, [0.5, 0.5, 0.5]), 1024);
    expect(out.width).toBe(1024);
    expect(out.height).toBe(576);
  });

  it("scales a portrait frame on its height", () => {
    const out = fitLongEdge(solid(1080, 1920, [0, 0, 0]), 512);
    expect(out.height).toBe(512);
    expect(out.width).toBe(288);
  });

  it("never upscales a frame already inside the limit", () => {
    const src = solid(300, 200, [0.2, 0.4, 0.6]);
    const out = fitLongEdge(src, 1024);
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out).toBe(src);
  });

  it("averages the pixels it merges (box filter, not nearest neighbour)", () => {
    // 4×2 checkerboard of black/white columns → 2×1: each output pixel
    // swallows one black and one white column per row → mid grey.
    const src = solid(4, 2, [0, 0, 0]);
    for (let y = 0; y < 2; y++) {
      for (const x of [1, 3]) {
        const i = (y * 4 + x) * 3;
        src.rgb[i] = src.rgb[i + 1] = src.rgb[i + 2] = 1;
      }
    }
    const out = fitLongEdge(src, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    for (const v of out.rgb) expect(v).toBeCloseTo(0.5, 10);
  });

  it("keeps separate regions separate: left half red, right half blue", () => {
    const src = solid(200, 100, [1, 0, 0]);
    for (let y = 0; y < 100; y++) {
      for (let x = 100; x < 200; x++) {
        const i = (y * 200 + x) * 3;
        src.rgb[i] = 0;
        src.rgb[i + 2] = 1;
      }
    }
    const out = fitLongEdge(src, 20);
    expect(out.width).toBe(20);
    expect(out.height).toBe(10);
    expect(pixel(out, 0, 5)).toEqual([1, 0, 0]);
    expect(pixel(out, 19, 5)).toEqual([0, 0, 1]);
  });
});

describe("encodePngSrgb8 adaptive filter", () => {
  it("round-trips exactly and is smaller than the unfiltered file on a gradient", () => {
    const w = 256;
    const h = 64;
    const img = solid(w, h, [0, 0, 0]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        img.rgb[i] = x / 255;
        img.rgb[i + 1] = (x + y) / 400;
        img.rgb[i + 2] = y / 63;
      }
    }
    const plain = encodePngSrgb8(w, h, img.rgb);
    const filtered = encodePngSrgb8(w, h, img.rgb, { adaptiveFilter: true });
    expect(filtered.length).toBeLessThan(plain.length);
    const back = decodePng(filtered);
    const ref = decodePng(plain);
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    expect(back.rgb).toEqual(ref.rgb);
  });
});

describe("selectInlineSources", () => {
  const frames = [0, 1, 2].map(() => solid(64, 36, [0.3, 0.3, 0.3]));
  const sheet = solid(200, 120, [0.1, 0.1, 0.1]);
  const strip = solid(400, 80, [0.05, 0.05, 0.05]);

  it("none: nothing", () => {
    expect(selectInlineSources("none", { frames, sheet, strip })).toEqual([]);
  });

  it("auto with a contact sheet: the sheet only, then the strip", () => {
    const picked = selectInlineSources("auto", { frames, sheet, strip });
    expect(picked.map((s) => s.kind)).toEqual(["sheet", "strip"]);
    expect(picked[0].image).toBe(sheet);
  });

  it("auto without a sheet: the frames themselves, up to the limit", () => {
    const picked = selectInlineSources("auto", { frames });
    expect(picked.map((s) => `${s.kind}${s.index}`)).toEqual(["frame0", "frame1", "frame2"]);
  });

  it("auto with more frames than the limit and no sheet: one labelled grid, built in memory", () => {
    const many = Array.from({ length: INLINE_AUTO_MAX_FRAMES + 1 }, () =>
      solid(64, 36, [0.5, 0.5, 0.5]),
    );
    const picked = selectInlineSources("auto", {
      frames: many,
      frameLabels: many.map((_, i) => `#${i}`),
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].kind).toBe("grid");
    expect(picked[0].image.width).toBeGreaterThan(64);
  });

  it("all: every frame, then the sheet, then the strip", () => {
    const picked = selectInlineSources("all", { frames, sheet, strip });
    expect(picked.map((s) => s.kind)).toEqual(["frame", "frame", "frame", "sheet", "strip"]);
  });
});

describe("inlineWorkWidth (how small each decoded frame may be kept)", () => {
  const hd = { width: 1920, height: 1080 };

  it("none needs nothing; a sheet in auto needs nothing from the frames", () => {
    expect(inlineWorkWidth("none", hd, 3, 1024, false)).toBe(0);
    expect(inlineWorkWidth("auto", hd, 3, 1024, true)).toBe(0);
  });

  it("frames sent one by one keep the inline size; portrait frames fit their height", () => {
    expect(inlineWorkWidth("auto", hd, 1, 1024, false)).toBe(1024);
    expect(inlineWorkWidth("auto", { width: 1080, height: 1920 }, 1, 1024, false)).toBe(576);
    // never wider than the frame itself
    expect(inlineWorkWidth("auto", { width: 640, height: 360 }, 1, 1024, false)).toBe(640);
  });

  it("an auto grid needs only its tile width", () => {
    expect(inlineWorkWidth("auto", hd, 9, 1024, false)).toBe(gridThumbWidth(9, 1024));
    expect(gridThumbWidth(9, 1024)).toBe(Math.floor((1024 - 8) / 3) - 8);
  });

  it("all with many frames is capped near 2·maxSize/√n, never below the minimum", () => {
    expect(inlineWorkWidth("all", hd, 16, 1024, false)).toBe(512);
    expect(inlineWorkWidth("all", hd, 32, 1024, false)).toBe(Math.ceil(2048 / Math.sqrt(32)));
    expect(inlineWorkWidth("all", hd, 32, 256, false)).toBe(INLINE_MIN_SIZE);
  });
});

describe("encodeInlineImages", () => {
  it("encodes PNGs no larger than maxSize on the long edge, in the order given", () => {
    const sources: InlineSource[] = [
      { kind: "frame", index: 0, image: solid(1920, 1080, [1, 0, 0]) },
      { kind: "frame", index: 1, image: solid(1920, 1080, [0, 1, 0]) },
    ];
    const plan = encodeInlineImages(sources, { maxSize: 640, maxBytes: 1_000_000 });
    expect(plan.warning).toBeUndefined();
    expect(plan.reduced).toBe(false);
    expect(plan.images.map((i) => i.index)).toEqual([0, 1]);
    for (const img of plan.images) {
      expect(img.mimeType).toBe("image/png");
      const png = decodePng(Buffer.from(img.data, "base64"));
      expect([png.width, png.height]).toEqual([640, 360]);
      expect([img.width, img.height]).toEqual([640, 360]);
    }
    const green = decodePng(Buffer.from(plan.images[1].data, "base64"));
    expect(Array.from(green.rgb.subarray(0, 3))).toEqual([0, 1, 0]);
  });

  it("shrinks further when the total is over budget, and says so", () => {
    const sources: InlineSource[] = [{ kind: "frame", index: 0, image: noise(800, 450) }];
    const plan = encodeInlineImages(sources, { maxSize: 800, maxBytes: 300_000 });
    expect(plan.images).toHaveLength(1);
    expect(plan.reduced).toBe(true);
    expect(plan.totalBytes).toBeLessThanOrEqual(300_000);
    expect(plan.longEdge).toBeLessThan(800);
    expect(plan.longEdge).toBeGreaterThanOrEqual(INLINE_MIN_SIZE);
    expect(plan.warning).toMatch(/reduced/);
    // totalBytes counts the base64 text that actually travels.
    expect(plan.totalBytes).toBe(plan.images.reduce((n, i) => n + i.data.length, 0));
    expect(base64Bytes(plan.images[0].data)).toBeGreaterThan(0);
  });

  it("drops frames before the sheet when even the minimum size does not fit", () => {
    const sources: InlineSource[] = [
      { kind: "frame", index: 0, image: noise(400, 400, 1) },
      { kind: "frame", index: 1, image: noise(400, 400, 2) },
      { kind: "sheet", image: noise(400, 400, 3) },
    ];
    // A 192 px averaged-noise PNG is 75–111 KB, i.e. 100–148 K of base64:
    // the budget holds one image and never two.
    const plan = encodeInlineImages(sources, { maxSize: 400, maxBytes: 160_000 });
    expect(plan.images.map((i) => i.kind)).toEqual(["sheet"]);
    expect(plan.dropped).toEqual([
      { kind: "frame", index: 1 },
      { kind: "frame", index: 0 },
    ]);
    expect(plan.warning).toMatch(/omitted/);
  });

  it("falls back to paths only, with a warning, when nothing fits", () => {
    const sources: InlineSource[] = [{ kind: "frame", index: 0, image: noise(400, 400) }];
    const plan = encodeInlineImages(sources, { maxSize: 400, maxBytes: 1_000 });
    expect(plan.images).toEqual([]);
    expect(plan.dropped).toEqual([{ kind: "frame", index: 0 }]);
    expect(plan.warning).toMatch(/no image fits/);
  });

  it("returns an empty plan, without warning, for no sources", () => {
    const plan = encodeInlineImages([], { maxSize: 1024, maxBytes: 1_000_000 });
    expect(plan.images).toEqual([]);
    expect(plan.warning).toBeUndefined();
  });
});
