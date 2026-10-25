// recipe.list / recipe.plan / recipe.run through the registry and ae_do, with
// a scripted transport: recipe.run must reach After Effects with ONE batch.run
// (plus the read of comp names before it), undo a half-built piece, and turn
// the verification reads into plain-Italian outcomes.

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import "../src/operations/index.js";
import type { Plan } from "../src/recipes/generate.js";
import { getOp } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import type { AeTransport, EvalRequest, EvalResult } from "../src/transport/AeTransport.js";

const ARCHIVE = fileURLToPath(new URL("./fixtures/archivio-lanterna-blu/", import.meta.url));
const FRAMES = "/tmp/parlez-test";
const ARGS = { title: "Mario Rossi", subtitle: "Direttrice della fotografia" };

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
});

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

/** A transport that answers each call with the next scripted function. */
function scripted(...answers: Array<(req: EvalRequest) => EvalResult>) {
  const calls: EvalRequest[] = [];
  const transport: AeTransport & { calls: EvalRequest[] } = {
    calls,
    async execute(req) {
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

function box(l: number, t: number, r: number, b: number) {
  return {
    ok: true,
    compSpace: { topLeft: [l, t], topRight: [r, t], bottomLeft: [l, b], bottomRight: [r, b] },
  };
}

/** Results for every op of a plan: building steps ok, reads with plausible values. */
function batchResults(p: Plan, opts: { failAt?: number; titleBox?: number[] } = {}): unknown[] {
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
      if (slot.alias === "scale") return { ok: true, value: [0, 100] };
      return { ok: true, value: 0 };
    }
    return { ok: true, path: slot.outPath };
  });
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
      "/tmp/parlez-test/r-lower-third-barra-020f.png",
      "/tmp/parlez-test/r-lower-third-barra-062f.png",
      "/tmp/parlez-test/r-lower-third-barra-111f.png",
    ]);
    expect(r.usedCardsLine).toMatch(/^Schede usate: stile s-lanterna v3/);
    expect(r.acceptance.look).toHaveLength(5);
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
