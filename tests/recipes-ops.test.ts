// recipe.list / recipe.plan / recipe.run through the registry and ae_do, with
// a scripted transport: recipe.run must reach After Effects with ONE batch.run
// (plus the read of comp names before it), undo a half-built piece, and turn
// the verification reads into plain-Italian outcomes.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { decodePng } from "../src/color/png16.js";
import "../src/operations/index.js";
import type { Plan } from "../src/recipes/generate.js";
import { getOp } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";
import { encodePng16 } from "./helpers/images.js";

const ARCHIVE = fileURLToPath(new URL("./fixtures/archivio-lanterna-blu/", import.meta.url));
// A real folder: recipe.run now waits for the acceptance PNGs to land on disk.
const FRAMES = mkdtempSync(path.join(os.tmpdir(), "parlez-recipes-frames-"));
/** The frame paths as the plan writes them (forward slashes). */
const FRAMES_POSIX = FRAMES.replace(/\\/g, "/");
const ARGS = { title: "Mario Rossi", subtitle: "Direttrice della fotografia" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
});
afterAll(() => rmSync(FRAMES, { recursive: true, force: true }));

function evalOk(result: unknown): EvalResult {
  return {
    ok: true,
    result: { result },
    error: null,
    errorCode: null,
    stack: null,
    logs: [],
    durationMs: 1,
  };
}

/** The project-settings read recipe.run makes before building (frame colors). */
const SETTINGS_LABEL = "recipe.run: impostazioni";
const settings8bit = () =>
  evalOk({ ok: true, file: null, bitsPerChannel: 8, workingSpace: "None" });

/**
 * A transport that answers each call with the next scripted function. The
 * settings read is answered aside — an 8 bpc project without color
 * management, which needs no calibration — so the scripts stay about the
 * names read and the batch.
 */
function scripted(...answers: Array<(req: EvalRequest) => EvalResult>) {
  const calls: EvalRequest[] = [];
  const transport: AeTransport & { calls: EvalRequest[] } = {
    calls,
    async execute(req) {
      if (req.label === SETTINGS_LABEL) return settings8bit();
      calls.push(req);
      const next = answers[calls.length - 1];
      if (!next) throw new Error(`unexpected call ${calls.length}: ${req.label}`);
      return next(req);
    },
  };
  return transport;
}

async function plan(args: Record<string, unknown> = {}): Promise<Plan> {
  const r = (await getOp("recipe.plan")!.run!(
    { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES, ...args },
    scripted(),
  )) as Plan & { ok: boolean };
  expect(r.ok).toBe(true);
  return r;
}

// Corners come back with a z, as After Effects gives them for a 2D layer.
function box(l: number, t: number, r: number, b: number) {
  return {
    ok: true,
    compSpace: {
      topLeft: [l, t, 0],
      topRight: [r, t, 0],
      bottomLeft: [l, b, 0],
      bottomRight: [r, b, 0],
    },
  };
}

/**
 * Results for every op of a plan: building steps ok, reads with plausible values.
 * Like After Effects, render.frame answers ok and the PNG appears on its own
 * schedule: at once (default), after `framesDelayMs`, or never.
 */
function batchResults(
  p: Plan,
  opts: {
    failAt?: number;
    titleBox?: number[];
    scale?: unknown;
    opacity?: unknown;
    framesDelayMs?: number;
    framesNever?: boolean;
  } = {},
): unknown[] {
  for (const s of p.reads) {
    if (s.kind !== "frame") continue;
    rmSync(s.outPath, { force: true });
    if (opts.framesNever || opts.failAt !== undefined) continue;
    const write = () => writeFileSync(s.outPath, PNG);
    if (opts.framesDelayMs) setTimeout(write, opts.framesDelayMs);
    else write();
  }
  return p.batch.args.ops.map((o, i) => {
    if (opts.failAt !== undefined) {
      if (i < opts.failAt) return { ok: true };
      if (i === opts.failAt) return { ok: false, error: "no comp matching LT – Mario Rossi" };
      return { skipped: true };
    }
    if (i < p.construction) return { ok: true };
    const slot = p.reads.find((s) => s.index === i)!;
    if (slot.kind === "bounds") {
      if (slot.layer === "LT Barra") return box(96, 913.76, 600, 1026);
      if (slot.layer === "LT Titolo")
        return opts.titleBox
          ? box(...(opts.titleBox as [number, number, number, number]))
          : box(124, 932, 420, 973);
      return box(124, 985, 560, 1009);
    }
    if (slot.kind === "measure") {
      return {
        ok: true,
        fontFamily: "Inter",
        fontStyle: slot.layer === "LT Titolo" ? "Bold" : "Regular",
      };
    }
    if (slot.kind === "value") {
      // Scale as After Effects 26.5 reports it on a 2D layer: three components.
      if (slot.alias === "scale") return { ok: true, value: opts.scale ?? [0, 100, 100] };
      return { ok: true, value: opts.opacity ?? 0 };
    }
    return { ok: true, path: slot.outPath };
  });
}

/** A 16-bit capture of a 32 bpc project: the grey `v(x)` written ×0.1. */
function grey(w: number, h: number, v: (x: number) => number): Buffer {
  const rgb = new Float64Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.fill(v(i % w) * 0.1, i * 3, i * 3 + 3);
  return encodePng16(w, h, rgb);
}

const namesAnswer = (names: string[]) => () =>
  evalOk({ ok: true, items: names.map((name) => ({ name, type: "CompItem" })) });

describe("recipe.list", () => {
  it("lists the shipped recipes, valid", async () => {
    const r = (await getOp("recipe.list")!.run!({}, scripted())) as {
      ok: boolean;
      recipes: Array<{ id: string; valid: boolean; source: string; file: string }>;
    };
    expect(r.ok).toBe(true);
    const ids = r.recipes.map((x) => x.id);
    expect(ids).toContain("r-lower-third-barra");
    expect(ids).toContain("r-titolo-dissolvenza");
    expect(r.recipes.every((x) => x.valid && x.source === "incluse")).toBe(true);
  });
});

describe("recipe.plan", () => {
  it("never calls After Effects", async () => {
    const t = scripted();
    await getOp("recipe.plan")!.run!(
      { recipe: "lower-third", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    );
    expect(t.calls).toHaveLength(0);
  });

  it("explains an invalid argument in Italian, before anything runs", async () => {
    const r = (await getOp("recipe.plan")!.run!(
      { recipe: "lower-third", args: { titolo: "x" } },
      scripted(),
    )) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(
      /la ricetta non si può preparare: args\.titolo: la ricetta non ha il parametro «titolo»/,
    );
  });

  it("names the recipes there are when one is missing", async () => {
    const r = (await getOp("recipe.plan")!.run!({ recipe: "logo-reveal" }, scripted())) as {
      ok: boolean;
      error: string;
    };
    expect(r.error).toMatch(
      /nessuna ricetta «logo-reveal» \(ci sono: r-lower-third-barra, r-titolo-dissolvenza\)/,
    );
  });

  it("stays available in read-only mode, through ae_do", async () => {
    process.env.AE_MCP_READONLY = "1";
    const t = scripted();
    const res = await doTool.handler(
      {
        operation: "recipe.plan",
        args: { recipe: "lower-third", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      },
      t,
    );
    expect(res.isError).toBe(false);
    expect(t.calls).toHaveLength(0);
  });
});

describe("recipe.run", () => {
  it("reads the comp names, then sends ONE batch.run — one undo group", async () => {
    const p = await plan();
    const t = scripted(namesAnswer([]), () => evalOk({ ok: true, results: batchResults(p) }));
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(t.calls).toHaveLength(2);
    const batchCalls = t.calls.filter((c) => c.code.includes("var _results = [];"));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].undoGroup).toBe(true);
    expect(batchCalls[0].label).toBe("Parlez! r-lower-third-barra");
    // The names read is read-only and is not a batch.
    expect(t.calls[0].label).toBe("recipe.run: nomi");
    expect(t.calls[0].code).not.toContain("var _results = [];");

    expect(r.ok).toBe(true);
    expect(r.comp).toBe("LT – Mario Rossi");
    expect(r.acceptance.failed).toBe(0);
    expect(r.acceptance.unverified).toBe(0);
    expect(r.acceptance.passed).toBe(r.acceptance.checks.length);
    expect(r.acceptance.frames).toEqual([
      `${FRAMES_POSIX}/r-lower-third-barra-020f.png`,
      `${FRAMES_POSIX}/r-lower-third-barra-062f.png`,
      `${FRAMES_POSIX}/r-lower-third-barra-111f.png`,
    ]);
    expect(r.acceptance.framesMissing).toEqual([]);
    expect(r.usedCardsLine).toMatch(/^Schede usate: stile s-lanterna v3/);
    expect(r.acceptance.look).toHaveLength(5);
  });

  it("waits for frames that After Effects writes after it has answered", async () => {
    // Prova del 25/10 su After Effects 26.5: render.frame diceva ok, ma il PNG
    // non c'era ancora quando il rapporto veniva letto (ENOENT nel test E2E).
    const p = await plan();
    const t = scripted(namesAnswer([]), () =>
      evalOk({ ok: true, results: batchResults(p, { framesDelayMs: 400 }) }),
    );
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(r.acceptance.unverified).toBe(0);
    expect(r.acceptance.frames).toHaveLength(3);
    // When recipe.run returns, every frame it lists is really on disk.
    for (const f of r.acceptance.frames as string[]) expect(statSync(f).size).toBeGreaterThan(0);
  });

  it("a frame that never arrives is «non verificabile», not an error", async () => {
    const p = await plan();
    const t = scripted(namesAnswer([]), () =>
      evalOk({ ok: true, results: batchResults(p, { framesNever: true }) }),
    );
    const started = Date.now();
    const r = (await getOp("recipe.run")!.run!(
      {
        recipe: "r-lower-third-barra",
        args: ARGS,
        archivio: ARCHIVE,
        framesDir: FRAMES,
        framesTimeoutMs: 300,
      },
      t,
    )) as Record<string, any>;
    // The three frames are waited for together, not one after the other.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.ok).toBe(true);
    expect(r.acceptance.failed).toBe(0);
    expect(r.acceptance.unverified).toBe(3);
    expect(r.acceptance.frames).toEqual([]);
    expect(r.acceptance.framesMissing).toHaveLength(3);
    const frame = r.acceptance.checks.find((c: { check: string }) => c.check === "frames");
    expect(frame.outcome).toBe("non verificabile");
    expect(frame.detail).toBe(
      `il fotogramma 20f (0.8 s) doveva arrivare in ${FRAMES_POSIX}/r-lower-third-barra-020f.png, ma il file non c'è: After Effects lo scrive dopo aver risposto, e non è arrivato in tempo`,
    );
  });

  it("picks a free comp name when the project already has one", async () => {
    const p = await plan({ existingNames: ["LT – Mario Rossi"] });
    const t = scripted(namesAnswer(["LT – Mario Rossi"]), () =>
      evalOk({ ok: true, results: batchResults(p) }),
    );
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(r.comp).toBe("LT – Mario Rossi 2");
    expect(t.calls[1].code).toContain('"LT – Mario Rossi 2"');
  });

  it("reads Scale with three components on a 2D layer as the two the recipe means", async () => {
    // Prova del 25/10 su After Effects 26.5: [0, 100, 100] contro [0, 100] dava «fallito».
    const p = await plan();
    const t = scripted(namesAnswer([]), () => evalOk({ ok: true, results: batchResults(p) }));
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    const scale = r.acceptance.checks.filter((c: { detail: string }) => c.detail.includes("scale"));
    expect(scale.map((c: { outcome: string }) => c.outcome)).toEqual(["ok", "ok"]);
    expect(scale[0].detail).toBe(
      "«LT Barra» · scale a 0f (0 s): [0,100], atteso [0,100] (After Effects dà [0,100,100]: contano le prime 2 componenti)",
    );
  });

  it("still fails a wrong value, and tolerates After Effects' float noise", async () => {
    const p = await plan();
    const run = async (scale: unknown, opacity: unknown) => {
      const t = scripted(namesAnswer([]), () =>
        evalOk({ ok: true, results: batchResults(p, { scale, opacity }) }),
      );
      const r = (await getOp("recipe.run")!.run!(
        { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
        t,
      )) as Record<string, any>;
      return r.acceptance.checks
        .filter((c: { check: string }) => c.check === "value")
        .map((c: { outcome: string }) => c.outcome);
    };
    expect(await run([50, 100, 100], 0)).toEqual(["fallito", "fallito", "ok", "ok", "ok", "ok"]);
    expect(await run([0.000001, 99.999999, 100], 0.0000001)).toEqual(Array(6).fill("ok"));
    expect(await run([0, 100, 100], [0])).toEqual(Array(6).fill("ok"));
    expect(await run([0], 0)).toEqual(["fallito", "fallito", "ok", "ok", "ok", "ok"]);
  });

  it("reports a layer outside the safe area as failed, in plain words", async () => {
    const p = await plan();
    const t = scripted(namesAnswer([]), () =>
      evalOk({ ok: true, results: batchResults(p, { titleBox: [124, 932, 1900, 973] }) }),
    );
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(r.ok).toBe(true);
    const bad = r.acceptance.checks.filter((c: { outcome: string }) => c.outcome === "fallito");
    expect(bad.map((c: { check: string; layer: string }) => `${c.check}/${c.layer}`)).toEqual([
      "insideSafeArea/LT Titolo",
      "inside/LT Titolo",
    ]);
    expect(bad[0].detail).toBe(
      "«LT Titolo» a 62f (2.48 s): x 124…1900, y 932…973; area del titolo x 96…1824, y 54…1026",
    );
  });

  it("undoes a half-built piece with one project.undo", async () => {
    const p = await plan();
    const t = scripted(
      namesAnswer([]),
      () =>
        evalOk({
          ok: false,
          error: "1 of 43 operations failed",
          results: batchResults(p, { failAt: 5 }),
        }),
      () => evalOk({ ok: true }),
    );
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(r.ok).toBe(false);
    expect(r.undone).toBe(true);
    expect(r.error).toBe(
      "la costruzione si è fermata al passo 6 (shape.add_rect): no comp matching LT – Mario Rossi. Quello che era stato creato è stato annullato (un Ctrl+Z).",
    );
    expect(t.calls).toHaveLength(3);
    // Undo must run with no group open, or it reverts nothing (project.undo).
    expect(t.calls[2].undoGroup).toBe(false);
  });

  it("does not undo when nothing was built (it would revert the user's own last action)", async () => {
    const p = await plan();
    const t = scripted(namesAnswer([]), () =>
      evalOk({ ok: false, results: batchResults(p, { failAt: 0 }) }),
    );
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(r.ok).toBe(false);
    expect(r.undone).toBe(false);
    expect(r.error).toMatch(/Non è stato creato niente\.$/);
    expect(t.calls).toHaveLength(2);
  });

  it("leaves a half-built piece in place when asked (undoOnError: false)", async () => {
    const p = await plan();
    const t = scripted(namesAnswer([]), () =>
      evalOk({ ok: false, results: batchResults(p, { failAt: 5 }) }),
    );
    const r = (await getOp("recipe.run")!.run!(
      {
        recipe: "r-lower-third-barra",
        args: ARGS,
        archivio: ARCHIVE,
        framesDir: FRAMES,
        undoOnError: false,
      },
      t,
    )) as Record<string, any>;
    expect(r.undone).toBe(false);
    expect(r.error).toMatch(/un Ctrl\+Z lo toglie\.$/);
    expect(t.calls).toHaveLength(2);
  });

  it("is refused in read-only mode before any call to After Effects", async () => {
    process.env.AE_MCP_READONLY = "1";
    const t = scripted();
    const res = await doTool.handler(
      { operation: "recipe.run", args: { recipe: "lower-third" } },
      t,
    );
    expect(res.isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("cannot ride inside a batch.run", () => {
    const jsx = getOp("batch.run")!.toJsx({
      ops: [{ operation: "recipe.run", args: { recipe: "lower-third" } }],
    });
    expect(jsx).toContain("runs on the Node side");
  });

  it("32 bpc without color management: frames come back at the viewer's values, one Ctrl+Z intact", async () => {
    // After Effects 26.5, 29/10/2026: in a 32 bpc project saveFrameToPng
    // writes every value ×0.1 (white 0.098), so Claude was looking at frames
    // ten times darker than the comp. Fake AE: every capture is ×0.1.
    const p = await plan();
    const labels: string[] = [];
    const t: AeTransport = {
      async execute(req) {
        labels.push(req.label ?? "");
        if (req.label === "recipe.run: nomi") return namesAnswer([])();
        if (req.label === SETTINGS_LABEL)
          return evalOk({
            ok: true,
            file: "C:/prove/ricetta-32.aep",
            bitsPerChannel: 32,
            workingSpace: "None",
          });
        if (req.label === "capture_calibration") {
          // The four solids of src/color/calibration.ts: 0.05, 0.18, 0.5, 1.0.
          const file = JSON.parse(/new File\(("[^"]*")\)/.exec(req.code)![1]) as string;
          writeFileSync(
            file,
            grey(160, 40, (x) => [0.05, 0.18, 0.5, 1][Math.floor(x / 40)]),
          );
          return { ...evalOk(null), result: { ok: true, saved: true } };
        }
        const results = batchResults(p);
        for (const s of p.reads)
          if (s.kind === "frame")
            writeFileSync(
              s.outPath,
              grey(8, 8, () => 1),
            );
        return evalOk({ ok: true, results });
      },
    };
    const r = (await getOp("recipe.run")!.run!(
      { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      t,
    )) as Record<string, any>;
    expect(r.ok).toBe(true);
    // The calibration comes BEFORE the build: the recipe stays the last undo step.
    expect(labels).toEqual([
      "recipe.run: nomi",
      SETTINGS_LABEL,
      "capture_calibration",
      "Parlez! r-lower-third-barra",
    ]);
    expect(r.acceptance.colorPipeline).toMatch(/capture scale 1\/10\.00 restored \(32 bpc\)/);
    expect(r.acceptance.colorWarning).toBeUndefined();
    for (const f of r.acceptance.frames as string[]) {
      const png = decodePng(readFileSync(f));
      expect(png.bitDepth).toBe(8);
      expect(Math.round(png.rgb[0] * 255)).toBe(255);
    }
  });

  it("works end to end through ae_do", async () => {
    const p = await plan();
    const t = scripted(namesAnswer([]), () => evalOk({ ok: true, results: batchResults(p) }));
    const res = await doTool.handler(
      {
        operation: "recipe.run",
        args: { recipe: "r-lower-third-barra", args: ARGS, archivio: ARCHIVE, framesDir: FRAMES },
      },
      t,
    );
    expect(res.isError).toBe(false);
    const payload = res.structuredContent as { result: { ok: boolean; operations: number } };
    expect(payload.result.ok).toBe(true);
    expect(payload.result.operations).toBe(43);
  });
});
