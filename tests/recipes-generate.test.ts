// Recipes, offline: the lower third of the recipe format §12 must turn into
// EXACTLY the batch.run of §13 (tests/fixtures/lower-third.atteso.json, written
// by hand from the spec — not generated), every generated op must exist in
// the registry with valid arguments, and the ExtendScript batch.run produces
// from them must pass the ES3 lint. None of this touches After Effects.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { validateOpArgs } from "../src/opschema.js";
import "../src/operations/index.js";
import type { Plan } from "../src/recipes/generate.js";
import { cardsComment, valueMatches } from "../src/recipes/generate.js";
import { planRecipe } from "../src/recipes/library.js";
import { getOp } from "../src/registry.js";
import { lintJsxFile } from "./helpers/lint-jsx.js";

const ARCHIVE = fileURLToPath(new URL("./fixtures/archivio-lanterna-blu/", import.meta.url));
const EXPECTED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/lower-third.atteso.json", import.meta.url)),
    "utf8",
  ),
) as {
  operation: string;
  args: { stopOnError: boolean; ops: Array<{ operation: string; args: Record<string, unknown> }> };
};

const FRAMES = "/tmp/parlez-test";
const NO_ENV = {} as NodeJS.ProcessEnv;

function lowerThird(
  args: Record<string, unknown> = {},
  extra: Partial<Parameters<typeof planRecipe>[0]> = {},
): Plan {
  return planRecipe({
    recipe: "r-lower-third-barra",
    args: { title: "Mario Rossi", subtitle: "Direttrice della fotografia", ...args },
    archivio: ARCHIVE,
    framesDir: FRAMES,
    env: NO_ENV,
    ...extra,
  });
}

function assertRegistryValid(plan: Plan): void {
  plan.batch.args.ops.forEach((o, i) => {
    const op = getOp(o.operation);
    expect(op, `step ${i + 1}: ${o.operation}`).toBeDefined();
    const v = validateOpArgs(op!, o.args);
    expect(v.ok, `step ${i + 1} (${o.operation}): ${v.ok ? "" : JSON.stringify(v.issues)}`).toBe(
      true,
    );
  });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-recipes-lint-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function lintBatch(plan: Plan): void {
  const jsx = getOp("batch.run")!.toJsx(plan.batch.args);
  // A child rejected at codegen would be inlined as a reject block instead of its code.
  expect(jsx).not.toContain("unknown operation");
  expect(jsx).not.toContain("invalid arguments for");
  expect(jsx).not.toContain("cannot run inside batch.run");
  const file = path.join(tmp, `${plan.recipe.id}-${plan.comp.name.length}.jsx`);
  writeFileSync(file, jsx);
  const errors = lintJsxFile(file).filter((f) => f.severity === "error");
  expect(errors.map((e) => `${e.rule}: ${e.text}`)).toEqual([]);
}

describe("lower third (recipe format §12–§13)", () => {
  const plan = lowerThird();

  it("is ONE batch.run that stops on the first error", () => {
    expect(plan.batch.operation).toBe("batch.run");
    expect(plan.batch.args.stopOnError).toBe(true);
  });

  it("produces exactly the expected sequence, step by step", () => {
    const got = plan.batch.args.ops;
    const want = EXPECTED.args.ops;
    // Step by step first, so a failure names the step instead of dumping 40 ops.
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      expect(got[i], `step ${i + 1} (${want[i]?.operation ?? "in più"})`).toEqual(want[i]);
    }
    expect(plan.batch).toEqual({ operation: EXPECTED.operation, args: EXPECTED.args });
  });

  it("builds in 29 steps and verifies in the remaining ones", () => {
    expect(plan.construction).toBe(29);
    expect(
      plan.batch.args.ops
        .slice(plan.construction)
        .every((o) => getOp(o.operation)?.readOnly === true),
    ).toBe(true);
    expect(
      plan.batch.args.ops
        .slice(0, plan.construction)
        .every((o) => getOp(o.operation)?.readOnly !== true),
    ).toBe(true);
  });

  it("uses only existing operations, with arguments the registry accepts", () => {
    assertRegistryValid(plan);
  });

  it("generates ExtendScript that passes the ES3 lint and rejects no child", () => {
    lintBatch(plan);
  });

  it("never asks for a confirmation (nothing is deleted, replaced or renamed)", () => {
    for (const o of plan.batch.args.ops) {
      expect(o.args.replace, o.operation).toBeUndefined();
      if (o.operation === "item.set_props") expect(o.args.name).toBeUndefined();
    }
  });

  it("reports the cards it used, with versions", () => {
    expect(plan.usedCards.map((c) => `${c.id}@${c.version}`).toSorted()).toEqual([
      "s-lanterna@3",
      "t-barra-apertura@1",
      "t-entrata-scorrimento@2",
      "t-uscita-accelerata@1",
    ]);
    expect(plan.usedCardsLine).toContain("Schede usate: stile s-lanterna v3");
    expect(plan.usedCardsLine).toContain(
      "tecnica t-entrata-scorrimento v2 (delay, duration, fade, stagger, distance, curve)",
    );
    expect(plan.defaultsUsed).toEqual([]);
  });

  it("writes a readable summary", () => {
    expect(plan.summary[0]).toBe(
      "Composizione «LT – Mario Rossi»: 1920×1080, 25 fps, 5 s (125 fotogrammi, l'ultimo è il 124).",
    );
    expect(plan.summary).toContain(
      "Animazione LT Barra · control:Apertura: 0f→12f decelera, 12f→112f linear, 112f→124f accelera.",
    );
  });
});

describe("lower third, other inputs", () => {
  it("without a subtitle drops the layer, its keys, its checks and its part of the bar", () => {
    const plan = lowerThird({ subtitle: "" });
    const names = plan.batch.args.ops.map((o) => o.args.layer ?? o.args.name);
    expect(names).not.toContain("LT Sottotitolo");
    const rect = plan.batch.args.ops.find((o) => o.operation === "shape.add_rect")!;
    // H = 18 + 40.88 + 18: one line of text only.
    expect(rect.args.size).toEqual([600, 76.88]);
    const size = plan.batch.args.ops.find((o) => o.operation === "expression.set")!;
    expect(size.args.expression).not.toContain("LT Sottotitolo");
    assertRegistryValid(plan);
    lintBatch(plan);
  });

  it("in 9:16 sits in the taller bottom margin of the style card", () => {
    const plan = lowerThird({ format: "9:16" });
    const create = plan.batch.args.ops[0];
    expect(create.args).toMatchObject({ width: 1080, height: 1920, fps: 25 });
    const ctrl = plan.batch.args.ops[2];
    // safe.title: left 5% of 1080 = 54, bottom = 1920 × 0.8 = 1536; minus H/2.
    expect(ctrl.args.position).toEqual([54, 1479.88]);
  });

  it("without an archive falls back to the recipe's literals and says so", () => {
    const plan = lowerThird({}, { archivio: undefined });
    expect(plan.usedCards).toEqual([]);
    expect(plan.defaultsUsed.length).toBeGreaterThan(5);
    expect(plan.warnings[0]).toBe(
      "nessun archivio indicato: uso i valori predefiniti della ricetta",
    );
    const style = plan.batch.args.ops.find((o) => o.operation === "text.set_style")!;
    expect(style.args.font).toBe("Arial-BoldMT");
    expect(plan.batch.args.ops.find((o) => o.operation === "item.set_props")!.args.comment).toBe(
      "Parlez! · ricetta r-lower-third-barra v1 · schede: nessuna (valori predefiniti della ricetta)",
    );
    assertRegistryValid(plan);
  });

  it("gives the comp a free name when one already exists", () => {
    const plan = lowerThird({}, { existingNames: ["LT – Mario Rossi", "LT – Mario Rossi 2"] });
    expect(plan.comp.name).toBe("LT – Mario Rossi 3");
    expect(
      plan.batch.args.ops.every(
        (o) =>
          o.operation === "comp.create" ||
          o.args.comp === "LT – Mario Rossi 3" ||
          o.args.item === "LT – Mario Rossi 3",
      ),
    ).toBe(true);
    expect(plan.warnings.some((w) => w.includes("c'è già"))).toBe(true);
  });

  it("at 4K doubles every length (1u = 2 px) but keeps the timing", () => {
    // A 4K format only in a temporary copy of the archive's style card.
    const dir = mkdtempSync(path.join(os.tmpdir(), "parlez-arch-4k-"));
    try {
      copyArchive(ARCHIVE, dir, (style) => {
        (style.formats as Record<string, unknown>)["4K"] = {
          width: 3840,
          height: 2160,
          fps: 25,
          safe: { action: { all: 0.035 }, title: { all: 0.05 } },
        };
      });
      const plan = lowerThird({ format: "4K" }, { archivio: dir });
      const style = plan.batch.args.ops.find((o) => o.operation === "text.set_style")!;
      expect(style.args.fontSize).toBe(112);
      const rect = plan.batch.args.ops.find((o) => o.operation === "shape.add_rect")!;
      expect(rect.args.size).toEqual([1200, 224.48]);
      const slider = plan.batch.args.ops.find((o) => o.operation === "keyframe.apply")!;
      expect((slider.args.keys as Array<{ time: number }>).map((k) => k.time)).toEqual([
        0, 0.48, 4.48, 4.96,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("at 30 fps converts the 25 fps cards and the frame counts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "parlez-arch-30-"));
    try {
      copyArchive(ARCHIVE, dir, (style) => {
        (style.formats as Record<string, Record<string, unknown>>)["16:9"].fps = 30;
      });
      const plan = lowerThird({}, { archivio: dir });
      expect(plan.batch.args.ops[0].args).toMatchObject({ fps: 30, duration: 5 });
      const slider = plan.batch.args.ops.find((o) => o.operation === "keyframe.apply")!;
      // barIn "12f@25" = 0.48 s = 14.4 → 14 frames at 30 fps; end = 149f.
      const times = (slider.args.keys as Array<{ time: number }>).map((k) => k.time);
      expect(times).toEqual([0, 0.466667, 4.5, 4.966667]);
      assertRegistryValid(plan);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("second recipe: centred title with a fade", () => {
  it("plans, validates and lints", () => {
    const plan = planRecipe({
      recipe: "r-titolo-dissolvenza",
      args: { title: "Capitolo uno" },
      archivio: ARCHIVE,
      framesDir: FRAMES,
      env: NO_ENV,
    });
    expect(plan.batch.args.ops[0].operation).toBe("comp.create");
    const style = plan.batch.args.ops.find((o) => o.operation === "text.set_style")!;
    expect(style.args).toMatchObject({
      font: "Inter-Bold",
      fontSize: 120,
      justification: "center",
    });
    assertRegistryValid(plan);
    lintBatch(plan);
  });
});

describe("valueMatches (values as After Effects reports them)", () => {
  it("compares only the dimensions the recipe means", () => {
    // Scale, Position and Anchor Point come back with a z on 2D layers.
    expect(valueMatches([0, 100, 100], [0, 100])).toBe(true);
    expect(valueMatches([960, 540, 0], [960, 540])).toBe(true);
    expect(valueMatches([0, 0, 0], [0, 0])).toBe(true);
    expect(valueMatches([0, 100], [0, 100])).toBe(true);
  });

  it("tolerates float noise but not a real difference", () => {
    expect(valueMatches([0.004, 99.996, 100], [0, 100])).toBe(true);
    expect(valueMatches(1920.0000001, 1920)).toBe(true);
    expect(valueMatches([0.5, 100, 100], [0, 100])).toBe(false);
    expect(valueMatches(0.02, 0)).toBe(false);
  });

  it("a missing dimension, or a different kind of value, never matches", () => {
    expect(valueMatches([0], [0, 100])).toBe(false);
    expect(valueMatches(0, [0, 100])).toBe(false);
    expect(valueMatches([0, 100], 0)).toBe(false);
    expect(valueMatches([0], 0)).toBe(true);
    expect(valueMatches("0", 0)).toBe(false);
  });
});

describe("cardsComment", () => {
  it("puts the style first and sorts the rest", () => {
    expect(
      cardsComment({ id: "r-x", version: 2 }, [
        { id: "t-b", kind: "technique", version: 1, fields: [] },
        { id: "s-a", kind: "style", version: 4, fields: [] },
        { id: "t-a", kind: "technique", version: 3, fields: [] },
      ]),
    ).toBe("Parlez! · ricetta r-x v2 · schede: s-a v4; t-a v3, t-b v1");
  });
});

/** Copy the fixture archive, letting the test edit the style card. */
function copyArchive(
  from: string,
  to: string,
  editStyle: (style: Record<string, unknown>) => void,
): void {
  const files = [
    "archivio.json",
    "stile/s-lanterna.json",
    "tecnica/t-barra-apertura.json",
    "tecnica/t-entrata-scorrimento.json",
    "tecnica/t-uscita-accelerata.json",
  ];
  for (const f of files) {
    const target = path.join(to, f);
    const content = readFileSync(path.join(from, f), "utf8");
    if (f.startsWith("stile/")) {
      const style = JSON.parse(content) as Record<string, unknown>;
      editStyle(style);
      writeFileOut(target, JSON.stringify(style));
    } else writeFileOut(target, content);
  }
}

function writeFileOut(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
