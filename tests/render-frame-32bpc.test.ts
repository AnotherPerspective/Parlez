// ae_render_frame in projects WITHOUT color management (workingSpace "None").
// Measured on After Effects 26.5 (29/10/2026), same comp and time: at 8 and
// 16 bpc saveFrameToPng writes the viewer's values; at 32 bpc everything comes
// out exactly ten times darker (white 0.098). The fake After Effects below
// plays both parts: the frame at the requested depth, and the calibration comp
// of known grey solids that measures the scale.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodePng } from "../src/color/png16.js";
import { renderFrameTool } from "../src/tools/render-frame.js";
import type { ToolResult } from "../src/tools/types.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";
import { encodePng16 } from "./helpers/images.js";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "parlez-32bpc-test-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const W = 64;
const H = 32;
/** The solid of the 26.5 measurement, left half; white on the right. */
const BLUE: [number, number, number] = [0.05, 0.1, 0.3];

function scene(scale: number): Float64Array {
  const rgb = new Float64Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = x < W / 2 ? BLUE : [1, 1, 1];
      for (let ch = 0; ch < 3; ch++) rgb[(y * W + x) * 3 + ch] = c[ch] * scale;
    }
  }
  return rgb;
}

/** The calibration comp: four 40 px solids of known grey (src/color/calibration.ts). */
function calibration(scale: number): Float64Array {
  const vals = [0.05, 0.18, 0.5, 1.0];
  const rgb = new Float64Array(160 * 40 * 3);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 160; x++)
      rgb.fill(vals[Math.floor(x / 40)] * scale, (y * 160 + x) * 3, (y * 160 + x) * 3 + 3);
  }
  return rgb;
}

interface FakeAe extends AeTransport {
  calls: EvalRequest[];
}

function ok(result: unknown): EvalResult {
  return { ok: true, result, error: null, errorCode: null, stack: null, logs: [], durationMs: 1 };
}

/**
 * `capture`: what saveFrameToPng multiplies the buffer by at this depth.
 * `calibrationFails`: the calibration call errors out instead.
 */
function fakeAe(opts: {
  bitsPerChannel: number;
  capture: number;
  calibrationFails?: boolean;
}): FakeAe {
  const calls: EvalRequest[] = [];
  return {
    calls,
    async execute(req: EvalRequest): Promise<EvalResult> {
      calls.push(req);
      if (req.label === "capture_calibration") {
        if (opts.calibrationFails) {
          return {
            ok: false,
            result: null,
            error: "AE busy",
            errorCode: "TIMEOUT",
            stack: null,
            logs: [],
            durationMs: 1,
          };
        }
        const file = JSON.parse(/new File\(("[^"]*")\)/.exec(req.code)![1]) as string;
        await fs.writeFile(file, encodePng16(160, 40, calibration(opts.capture)));
        return ok({ ok: true, saved: true });
      }
      const paths = JSON.parse(/var _paths = (\[.*?\]);/.exec(req.code)![1]) as string[];
      for (const file of paths) await fs.writeFile(file, encodePng16(W, H, scene(opts.capture)));
      return ok({
        ok: true,
        frames: paths.map((p) => ({
          ok: true,
          writtenTo: p,
          time: 0,
          compName: "Main",
          size: [W, H],
          captureKind: "direct",
        })),
        captureKind: "direct",
        compName: "Main",
        workingSpace: "None",
        bitsPerChannel: opts.bitsPerChannel,
        // A project per test: the calibration is cached per project, depth and space.
        projectFile: `C:/prove/${Math.random().toString(36).slice(2)}.aep`,
      });
    },
  };
}

function payloadOf(res: ToolResult): Record<string, unknown> {
  return (res.structuredContent as { result: Record<string, unknown> }).result;
}

async function render(transport: FakeAe) {
  const outPath = path.join(dir, `${Math.random().toString(36).slice(2)}.png`);
  const res = await renderFrameTool.handler(
    { compNameOrId: "Main", time: 0, outPath, inline: "none" } as never,
    transport,
  );
  const png = decodePng(await fs.readFile(outPath));
  const at = (x: number) =>
    [0, 1, 2].map((ch) => Math.round(png.rgb[((H / 2) * W + x) * 3 + ch] * 255));
  return { res, png, blue: at(4), white: at(W - 4) };
}

describe("ae_render_frame, working space None", { timeout: 30_000 }, () => {
  it("32 bpc: measures the capture scale and restores it — white comes back at 255", async () => {
    const t = fakeAe({ bitsPerChannel: 32, capture: 0.1 });
    const { res, png, blue, white } = await render(t);
    expect(res.isError).toBe(false);
    expect(t.calls.map((c) => c.label)).toEqual(["render_frame", "capture_calibration"]);
    expect(png.bitDepth).toBe(8);
    expect(white).toEqual([255, 255, 255]);
    // 0.1 and 0.3 sit on a half step of 255: ±1 after the 16-bit round trip.
    blue.forEach((v, ch) => expect(Math.abs(v - [13, 26, 77][ch])).toBeLessThanOrEqual(1));
    const p = payloadOf(res);
    expect(p.colorPipeline).toMatch(/capture scale 1\/10\.00 restored \(32 bpc\)/);
    expect(p.colorWarning).toBeUndefined();
  });

  it("32 bpc whose capture is not scaled: measured as identity, values unchanged", async () => {
    const t = fakeAe({ bitsPerChannel: 32, capture: 1 });
    const { res, white } = await render(t);
    expect(white).toEqual([255, 255, 255]);
    expect(payloadOf(res).colorPipeline).toBe(
      "untagged 16-bit → 8-bit sRGB-tagged (values unchanged)",
    );
  });

  it("32 bpc, calibration failed: values left as captured, with a clear warning", async () => {
    const t = fakeAe({ bitsPerChannel: 32, capture: 0.1, calibrationFails: true });
    const { res, white } = await render(t);
    expect(white).toEqual([26, 26, 26]);
    const p = payloadOf(res);
    expect(p.colorWarning).toMatch(/32 bpc/);
    expect(p.colorWarning).toMatch(/AE busy/);
    expect(p.colorPipeline).toBe("untagged 16-bit → 8-bit sRGB-tagged (values unchanged)");
  });

  for (const bpc of [8, 16]) {
    it(`${bpc} bpc: no calibration, values unchanged`, async () => {
      const t = fakeAe({ bitsPerChannel: bpc, capture: 1 });
      const { res, blue, white } = await render(t);
      expect(t.calls.map((c) => c.label)).toEqual(["render_frame"]);
      expect(white).toEqual([255, 255, 255]);
      expect(blue).toEqual([13, 26, 77]);
      expect(payloadOf(res).colorPipeline).toBe(
        "untagged 16-bit → 8-bit sRGB-tagged (values unchanged)",
      );
    });
  }
});
