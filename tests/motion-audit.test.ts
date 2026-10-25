// comp.audit_motion (M5.3) offline: the ExtendScript it sends (read-only,
// outside an undo group, arguments through jsxVal) and the Node-side
// analysis of what After Effects would answer, fed by a fake transport.

import { describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import type { EvalRequest, EvalResult } from "../src/transport/AeTransport.js";
import { nullTransport, type NullTransport } from "./helpers/null-transport.js";

const N = 10;
const times = Array.from({ length: N }, (_, i) => (i * 4.96) / (N - 1));
const ramp = (from: number, to: number) => times.map((_, i) => from + ((to - from) * i) / (N - 1));
const still = <T>(v: T) => times.map(() => v);

function layer(
  name: string,
  over: Partial<{
    path: string;
    depth: number;
    precomp: boolean;
    active: boolean[];
    position: Array<number[] | null>;
    scale: Array<number[] | null>;
    opacity: Array<number | null>;
    rotation: Array<number | null>;
    keyed: Record<string, boolean>;
  }> = {},
) {
  return {
    name,
    index: 1,
    path: over.path ?? `Main > ${name}`,
    depth: over.depth ?? 0,
    precomp: over.precomp ?? false,
    active: over.active ?? still(true),
    position: over.position ?? still([960, 540]),
    scale: over.scale ?? still([100, 100]),
    opacity: over.opacity ?? still(100),
    rotation: over.rotation ?? still(0),
    keyed: over.keyed ?? { position: false, scale: false, opacity: false, rotation: false },
  };
}

/** A comp with 5 layers: 3 animated (move, fade in, scale) and 2 that never move. */
const FIVE = {
  ok: true,
  comp: "Main",
  duration: 5,
  frameRate: 25,
  times,
  truncated: false,
  layers: [
    layer("Logo", {
      position: ramp(100, 900).map((x) => [x, 540]),
      keyed: { position: true, scale: false, opacity: false, rotation: false },
    }),
    layer("Titolo", {
      opacity: ramp(0, 100),
      keyed: { position: false, scale: false, opacity: true, rotation: false },
    }),
    layer("Forma", {
      scale: ramp(50, 120).map((s) => [s, s]),
      keyed: { position: false, scale: true, opacity: false, rotation: false },
    }),
    layer("Sfondo"),
    layer("Cornice"),
  ],
};

function fakeAe(result: unknown): NullTransport {
  return nullTransport({ result });
}

async function audit(args: Record<string, unknown>, result: unknown = FIVE) {
  const transport = fakeAe(result);
  const out = (await getOp("comp.audit_motion")!.run!(args, transport)) as Record<string, unknown>;
  return { out, req: transport.calls[0] as EvalRequest };
}

type Row = {
  percorso: string;
  stato: string;
  spostamento: { percorso: number; netto: number };
  scala: { variazione: number };
  opacita: { min: number; max: number };
  dissolvenze: string[];
  rotazione: { variazione: number };
};

describe("comp.audit_motion", () => {
  it("is a read-only, Node-side operation", () => {
    const op = getOp("comp.audit_motion")!;
    expect(op.readOnly).toBe(true);
    expect(typeof op.run).toBe("function");
    expect(op.toJsx({ comp: "Main" })).toContain("ae_do");
  });

  it("sends one read with the arguments encoded, outside an undo group", async () => {
    const { req } = await audit({ comp: 'Ma"in', campioni: 12, profondita: 3 });
    expect(req.undoGroup).toBe(false);
    expect(req.code).toContain('"Ma\\"in"');
    expect(req.code).toContain("var _n = 12;");
    expect(req.code).toContain("var _maxDepth = 3;");
    expect(req.code).toContain("sourceTime");
  });

  it("sorts 5 layers into 3 animated and 2 still, with a plain summary", async () => {
    const { out } = await audit({ comp: "Main" });
    expect(out.ok).toBe(true);
    expect(out.riepilogo).toBe("5 livelli, 3 animati, 2 fermi.");
    const rows = out.livelli as Row[];
    const byName = new Map(rows.map((r) => [r.percorso, r]));
    expect(byName.get("Main > Logo")!.stato).toBe("animato");
    expect(byName.get("Main > Logo")!.spostamento.netto).toBeCloseTo(800, 6);
    expect(byName.get("Main > Logo")!.spostamento.percorso).toBeCloseTo(800, 6);
    expect(byName.get("Main > Titolo")!.dissolvenze).toEqual(["entrata"]);
    expect(byName.get("Main > Forma")!.scala.variazione).toBeCloseTo(70, 6);
    expect(byName.get("Main > Sfondo")!.stato).toBe("fermo");
    expect(byName.get("Main > Cornice")!.stato).toBe("fermo");
    expect(out.fermi).toEqual(["Main > Sfondo", "Main > Cornice"]);
  });

  it("flags keyframes that the samples did not catch, instead of calling the layer still", async () => {
    const res = {
      ...FIVE,
      layers: [
        layer("Lampo", {
          keyed: { position: false, scale: false, opacity: true, rotation: false },
        }),
      ],
    };
    const { out } = await audit({ comp: "Main" }, res);
    expect((out.livelli as Row[])[0].stato).toBe("animato tra i campioni");
    expect(out.riepilogo).toMatch(/1 livello/);
  });

  it("detects fade-outs, rotation, and layers never visible at the sampled times", async () => {
    const res = {
      ...FIVE,
      layers: [
        layer("Uscita", { opacity: ramp(100, 0) }),
        layer("Ruota", { rotation: ramp(0, 90) }),
        layer("Spento", { active: still(false) }),
      ],
    };
    const { out } = await audit({ comp: "Main" }, res);
    const [exit, spin, off] = out.livelli as Row[];
    expect(exit.dissolvenze).toEqual(["uscita"]);
    expect(spin.rotazione.variazione).toBeCloseTo(90, 6);
    expect(spin.stato).toBe("animato");
    expect(off.stato).toBe("mai visibile");
  });

  it("reports precomp layers with their path and says how many are inside precomps", async () => {
    const res = {
      ...FIVE,
      layers: [
        layer("Pre", { precomp: true }),
        layer("Stella", {
          path: "Main > Pre > Stella",
          depth: 1,
          position: ramp(0, 50).map((x) => [x, 0]),
        }),
      ],
    };
    const { out } = await audit({ comp: "Main" }, res);
    expect((out.livelli as Row[])[1].percorso).toBe("Main > Pre > Stella");
    expect(out.riepilogo).toMatch(/1 dentro le precomposizioni/);
  });

  it("ignores sub-pixel jitter (expression noise) when deciding still or animated", async () => {
    const res = {
      ...FIVE,
      layers: [layer("Quasi", { position: times.map((_, i) => [960 + (i % 2) * 0.01, 540]) })],
    };
    const { out } = await audit({ comp: "Main" }, res);
    expect((out.livelli as Row[])[0].stato).toBe("fermo");
  });

  it("rejects bad arguments before contacting AE", async () => {
    const t = nullTransport();
    const op = getOp("comp.audit_motion")!;
    const r1 = (await op.run!({ comp: "Main", campioni: 1 }, t)) as { ok: boolean; error: string };
    expect(r1.ok).toBe(false);
    const r2 = (await op.run!({ comp: "Main", profondita: 9 }, t)) as { ok: boolean };
    expect(r2.ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it("passes on After Effects' own failure (no such comp)", async () => {
    const { out } = await audit({ comp: "Nope" }, { ok: false, error: "no comp matching Nope" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Nope/);
  });

  it("reports a transport failure as a failure", async () => {
    const t = nullTransport({
      ok: false,
      error: "timeout",
      errorCode: "TIMEOUT",
    } as Partial<EvalResult>);
    const out = (await getOp("comp.audit_motion")!.run!({ comp: "Main" }, t)) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});
