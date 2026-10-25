// ae_render_frame's inline images and timeline strip through the real
// handler, against a fake transport that plays the part of After Effects:
// it writes synthetic PNGs where the generated JSX asked for them and answers
// with the payload shape the JSX returns. No After Effects involved.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { decodePng, encodePngSrgb8 } from "../src/color/png16.js";
import { analyzeFrame } from "../src/color/sheet.js";
import { RUNTIME_DIR } from "../src/config.js";
import { renderFrameTool } from "../src/tools/render-frame.js";
import type { ImageContent, ToolResult } from "../src/tools/types.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";

let dir: string;

// Each render reads its files back through readFileSettled, which waits
// ≥250 ms per file for AE's asynchronous writes to finish — real waiting,
// so these tests get more than the default 5 s under a loaded full run.

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "parlez-inline-test-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
});

interface FakeAe extends AeTransport {
  calls: EvalRequest[];
}

const TIMELINE = {
  duration: 4,
  frameRate: 25,
  displayStartTime: 0,
  layersTruncated: false,
  layers: [
    {
      index: 1,
      name: "Title",
      inPoint: 0,
      outPoint: 4,
      enabled: true,
      keys: [0, 1, 2],
      keysTruncated: false,
    },
    {
      index: 2,
      name: "Bg",
      inPoint: 0,
      outPoint: 4,
      enabled: true,
      keys: [],
      keysTruncated: false,
    },
  ],
};

/**
 * Fake After Effects: renders a 320×180 frame per requested time — black,
 * with a white square that moves right as time passes — at the paths the
 * generated JSX carries in `var _paths = [...]`.
 */
function fakeAe(opts: { width?: number; height?: number } = {}): FakeAe {
  const width = opts.width ?? 320;
  const height = opts.height ?? 180;
  const calls: EvalRequest[] = [];
  return {
    calls,
    async execute(req: EvalRequest): Promise<EvalResult> {
      calls.push(req);
      const paths = JSON.parse(/var _paths = (\[.*?\]);/.exec(req.code)![1]) as string[];
      const times = JSON.parse(/var _times = (\[.*?\]);/.exec(req.code)![1]) as number[];
      const frames = [];
      for (const [i, file] of paths.entries()) {
        const rgb = new Float64Array(width * height * 3);
        const x0 = Math.min(width - 20, Math.round(times[i] * 60));
        for (let y = 80; y < 100; y++) {
          for (let x = x0; x < x0 + 20; x++)
            rgb.fill(1, (y * width + x) * 3, (y * width + x) * 3 + 3);
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, encodePngSrgb8(width, height, rgb));
        frames.push({
          ok: true,
          writtenTo: file,
          time: times[i],
          compName: "Main",
          size: [width, height],
          captureKind: "direct",
        });
      }
      const result: Record<string, unknown> = {
        ok: true,
        frames,
        captureKind: "direct",
        compName: "Main",
        workingSpace: "None",
        bitsPerChannel: 8,
        projectFile: null,
      };
      if (req.code.includes("_tlCollect(comp")) result.timeline = TIMELINE;
      return {
        ok: true,
        result,
        error: null,
        errorCode: null,
        stack: null,
        logs: [],
        durationMs: 1,
      };
    },
  };
}

function images(res: ToolResult): ImageContent[] {
  return res.content.filter((c): c is ImageContent => c.type === "image");
}

function payloadOf(res: ToolResult): Record<string, unknown> {
  return (res.structuredContent as { result: Record<string, unknown> }).result;
}

function decoded(img: ImageContent) {
  return decodePng(Buffer.from(img.data, "base64"));
}

/** Drop per-run fields so two calls can be compared. */
function stable(res: ToolResult): unknown {
  const s = structuredClone(res.structuredContent) as Record<string, unknown>;
  delete s.durationMs;
  return s;
}

async function render(args: Record<string, unknown>, transport = fakeAe()) {
  const res = await renderFrameTool.handler(
    {
      compNameOrId: "Main",
      outPath: path.join(dir, `${Math.random().toString(36).slice(2)}.png`),
      ...args,
    } as never,
    transport,
  );
  return { res, transport };
}

describe("ae_render_frame inline images", { timeout: 30_000 }, () => {
  it("auto, one frame: JSON text first, then that frame as a PNG image", async () => {
    const { res } = await render({ time: 1 });
    expect(res.isError).toBe(false);
    expect(res.content[0].type).toBe("text");
    const imgs = images(res);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].mimeType).toBe("image/png");
    expect(res.content.indexOf(imgs[0])).toBe(1);
    const png = decoded(imgs[0]);
    expect([png.width, png.height]).toEqual([320, 180]);
    // the moving square sits at x = 60 for t = 1 s
    const i = (90 * 320 + 65) * 3;
    expect(png.rgb[i]).toBe(1);
  });

  it("auto with a contact sheet: the sheet only, not every frame", async () => {
    const { res } = await render({ times: [0, 1, 2, 3], contactSheet: {} });
    const imgs = images(res);
    expect(imgs).toHaveLength(1);
    const sheet = payloadOf(res).contactSheet as { size: [number, number] };
    expect([decoded(imgs[0]).width, decoded(imgs[0]).height]).toEqual(sheet.size);
  });

  it("auto with several frames and no sheet: each frame, in index order", async () => {
    const { res } = await render({ times: [0, 1, 2] });
    const imgs = images(res);
    expect(imgs).toHaveLength(3);
    // frame order: the square moves right, so its first white column grows
    const firstWhite = imgs.map((img) => {
      const png = decoded(img);
      for (let x = 0; x < png.width; x++) if (png.rgb[(90 * png.width + x) * 3] > 0.5) return x;
      return -1;
    });
    expect(firstWhite).toEqual([0, 60, 120]);
  });

  it("auto with many frames and no sheet: one labelled grid no wider than inlineMaxSize", async () => {
    const { res } = await render({ times: [0, 0.5, 1, 1.5, 2, 2.5], inlineMaxSize: 512 });
    const imgs = images(res);
    expect(imgs).toHaveLength(1);
    const grid = decoded(imgs[0]);
    expect(grid.width).toBeLessThanOrEqual(512);
    expect(grid.width).toBeGreaterThan(400); // sized to fill the cap, not tiny
    expect(payloadOf(res).inlineWarning).toBeUndefined();
  });

  it("none: text only — paths and sizes as before", async () => {
    const { res } = await render({ times: [0, 1], inline: "none" });
    expect(images(res)).toEqual([]);
    expect(res.content).toHaveLength(1);
    const frames = payloadOf(res).frames as Array<{ writtenTo: string }>;
    expect(frames).toHaveLength(2);
  });

  it("all: every frame, then the sheet", async () => {
    const { res } = await render({ times: [0, 1, 2], contactSheet: {}, inline: "all" });
    const imgs = images(res);
    expect(imgs).toHaveLength(4);
    const sheet = payloadOf(res).contactSheet as { size: [number, number] };
    expect([decoded(imgs[3]).width, decoded(imgs[3]).height]).toEqual(sheet.size);
  });

  it("inlineMaxSize caps the long edge of every inline image", async () => {
    const { res } = await render({ time: 0, inlineMaxSize: 160 });
    const png = decoded(images(res)[0]);
    expect([png.width, png.height]).toEqual([160, 90]);
    // the file on disk keeps full size
    const p = payloadOf(res) as { writtenTo: string; size: number[] };
    expect(p.size).toEqual([320, 180]);
    expect(decodePng(await fs.readFile(p.writtenTo)).width).toBe(320);
  });

  it("structuredContent and the JSON text do not depend on the images", async () => {
    const outPath = path.join(dir, "same.png");
    const a = await renderFrameTool.handler(
      { compNameOrId: "Main", outPath, times: [0, 1], contactSheet: {}, inline: "none" },
      fakeAe(),
    );
    const b = await renderFrameTool.handler(
      { compNameOrId: "Main", outPath, times: [0, 1], contactSheet: {}, inline: "all" },
      fakeAe(),
    );
    expect(images(b).length).toBeGreaterThan(0);
    expect(stable(b)).toEqual(stable(a));
    // A filter that strips image blocks leaves exactly the text-only answer.
    const filtered = b.content.filter((c) => c.type !== "image");
    expect(filtered).toHaveLength(1);
    expect(JSON.parse((filtered[0] as { text: string }).text).result).toEqual(
      JSON.parse((a.content[0] as { text: string }).text).result,
    );
  });

  it("works in read-only mode: inline images are a read", async () => {
    process.env.AE_MCP_READONLY = "1";
    const { res } = await render({ time: 2 });
    expect(res.isError).toBe(false);
    expect(images(res)).toHaveLength(1);
  });

  it("an error stays a plain error, with no images", async () => {
    const transport: AeTransport = {
      async execute(): Promise<EvalResult> {
        return {
          ok: true,
          result: { ok: false, error: "no comp matching Nope" },
          error: null,
          errorCode: null,
          stack: null,
          logs: [],
          durationMs: 0,
        };
      },
    };
    const { res } = await render({ time: 0 }, transport as FakeAe);
    expect(res.isError).toBe(true);
    expect(images(res)).toEqual([]);
  });
});

describe("ae_render_frame analyze with inline images on", { timeout: 30_000 }, () => {
  // Field report 25/10 (AE 26.5): analysis.width came back 1440 for a 1920
  // comp. The cause was the comp itself — the comp.resize e2e test had left
  // it at 1440 after an AE timeout — but this pins the contract anyway: the
  // inline pass shrinks its own copies, never what `analyze` measures.
  it("measures the full-size capture (1920×1080), the same with inline on or off", async () => {
    const args = {
      times: [0, 1],
      analyze: true,
      contactSheet: { columns: 3, thumbWidth: 240 },
    };
    const on = await render(args, fakeAe({ width: 1920, height: 1080 }));
    const off = await render({ ...args, inline: "none" }, fakeAe({ width: 1920, height: 1080 }));
    expect(images(on.res).length).toBeGreaterThan(0);
    type Frame = { writtenTo: string; analysis: Record<string, unknown> };
    const framesOn = payloadOf(on.res).frames as Frame[];
    const framesOff = payloadOf(off.res).frames as Frame[];
    const a = framesOn[1].analysis;
    expect(a.width).toBe(1920);
    expect(a.height).toBe(1080);
    // the white square of t = 1 s, in the frame's own pixels
    expect(a.contentBounds).toEqual({ left: 60, top: 80, width: 20, height: 20 });
    expect(a.coverage).toBeCloseTo(400 / (1920 * 1080), 12);
    // identical to measuring the file directly, and to the inline-off run
    for (const [i, f] of framesOn.entries()) {
      expect(f.analysis).toEqual(analyzeFrame(decodePng(await fs.readFile(f.writtenTo))));
      expect(f.analysis).toEqual(framesOff[i].analysis);
    }
  });
});

describe("ae_render_frame timelineStrip", { timeout: 30_000 }, () => {
  it("asks AE for keyframe times only when the strip is requested", async () => {
    const plain = await render({ times: [0, 1] });
    expect(plain.transport.calls[0].code).not.toContain("_tlCollect(comp");
    const withStrip = await render({ times: [0, 1], timelineStrip: {} });
    expect(withStrip.transport.calls[0].code).toContain("_tlCollect(comp");
  });

  it("writes the strip PNG, reports motion and keyframes, and sends it inline after the frames", async () => {
    const { res } = await render({ times: [0, 1, 2, 3], timelineStrip: { width: 800 } });
    const p = payloadOf(res);
    expect(p.timeline).toBeUndefined(); // raw AE data is consumed, not echoed
    const strip = p.timelineStrip as {
      writtenTo: string;
      size: [number, number];
      duration: number;
      motion: Array<{ from: number; to: number; energy: number }>;
      rows: Array<{ layer: number | null; name: string; keyframes: number; keyTimes: number[] }>;
    };
    expect(p.timelineStripWarning).toBeUndefined();
    expect(strip.writtenTo.endsWith("_strip.png")).toBe(true);
    expect(strip.size[0]).toBe(800);
    expect(strip.duration).toBe(4);
    expect(strip.motion).toHaveLength(3);
    for (const m of strip.motion) expect(m.energy).toBeGreaterThan(0);
    expect(strip.rows.map((r) => [r.layer, r.name, r.keyframes])).toEqual([
      [1, "Title", 3],
      [2, "Bg", 0],
    ]);
    expect(strip.rows[0].keyTimes).toEqual([0, 1, 2]);
    const onDisk = decodePng(await fs.readFile(strip.writtenTo));
    expect([onDisk.width, onDisk.height]).toEqual(strip.size);
    // auto, 4 frames, no sheet: 4 frames then the strip
    const imgs = images(res);
    expect(imgs).toHaveLength(5);
    expect(decoded(imgs[4]).width).toBe(800);
  });

  it("refuses a strip path inside the mailbox before contacting AE", async () => {
    const transport = fakeAe();
    const { res } = await render(
      { times: [0, 1], timelineStrip: { outPath: path.join(RUNTIME_DIR, "strip.png") } },
      transport,
    );
    expect(res.isError).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });

  it("still draws frames and motion when AE returns no keyframe data", async () => {
    const base = fakeAe();
    const transport: FakeAe = {
      calls: base.calls,
      async execute(req) {
        const out = await base.execute(req);
        delete (out.result as Record<string, unknown>).timeline;
        return out;
      },
    };
    const { res } = await render({ times: [0, 2], timelineStrip: {} }, transport);
    const p = payloadOf(res);
    const strip = p.timelineStrip as { rows: unknown[]; motion: unknown[] };
    expect(strip.rows).toEqual([]);
    expect(strip.motion).toHaveLength(1);
    expect(p.timelineStripWarning).toMatch(/keyframe/);
  });
});
