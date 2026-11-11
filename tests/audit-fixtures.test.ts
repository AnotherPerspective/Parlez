// The two test projects for comp.audit:
//   tests/fixtures/progetto-prova.json — clean, must give 0 findings;
//   tests/fixtures/errori-3.json       — the same project with exactly 3
//                                        planted errors.
// Offline checks: both pass kumo's import validator; the second differs from
// the first in the three planted places and nowhere else; and the audit, run
// on a fake project built the way jsx/import.jsx would build it, finds the
// planted errors and nothing more. The same expectations run against a real
// After Effects in tests/e2e/audit.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildAuditJsx } from "../src/operations/audit.js";
import { validateAeProjectDoc } from "../src/validate.js";
import { fakeProjectFromDoc, runJsx } from "./helpers/audit-fakes.js";

const load = (f: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), "utf8"));
const clean = load("progetto-prova.json");
const planted = load("errori-3.json");

/**
 * What the audit must report on errori-3.json, by rule and layer. Three
 * planted errors give four findings: the third (linear position keys without
 * motion blur) is two defects on one layer, each with its own fix.
 */
const EXPECTED_ERRORI_3 = [
  { regola: "keyframe-lineari", livello: "Cerchio" },
  { regola: "movimento-senza-motion-blur", livello: "Cerchio" },
  { regola: "fuori-dal-tempo", livello: "Credito finale" },
  { regola: "area-sicura", livello: "Sottotitolo" },
];

interface Report {
  ok: boolean;
  segnalazioni: Array<{ regola: string; livello: string | null; composizione: string }>;
  riepilogo: {
    testo: string;
    totale: number;
    errori: number;
    avvisi: number;
    elementiConSegnalazioni: number;
    perElemento: Array<{ composizione: string; livello: string | null; regole: string[] }>;
    composizioniControllate: string[];
  };
  nonControllate: unknown[];
}

function auditDoc(
  doc: unknown,
  args: Record<string, unknown> = {},
  tweak: (comps: ReturnType<typeof fakeProjectFromDoc>) => void = () => {},
): Report {
  const comps = fakeProjectFromDoc(doc as { items: never[] });
  tweak(comps);
  return runJsx(buildAuditJsx({ comp: "Principale", ...args }), comps) as Report;
}

describe("test projects for comp.audit", () => {
  it.each([
    ["progetto-prova.json", clean],
    ["errori-3.json", planted],
  ])("%s passes the import validator with no issues or warnings", (_f, doc) => {
    const v = validateAeProjectDoc(doc);
    expect(v.issues).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("the clean project is 1920x1080, 25 fps, with text, shapes, a solid, eased keys and a precomp", () => {
    const comps = clean.items.filter((i: { type: string }) => i.type === "CompItem");
    for (const c of comps) expect([c.width, c.height, c.frameRate]).toEqual([1920, 1080, 25]);
    const main = comps.find((c: { name: string }) => c.name === "Principale");
    const types = main.layers.map((l: { type: string }) => l.type);
    expect(types).toEqual(["TextLayer", "TextLayer", "ShapeLayer", "AVLayer", "AVLayer"]);
    const precompIds = new Set(comps.map((c: { id: number }) => c.id));
    expect(main.layers.some((l: { sourceId?: number }) => precompIds.has(l.sourceId!))).toBe(true);
    expect(clean.items.some((i: { sourceKind?: string }) => i.sourceKind === "solid")).toBe(true);
    // Eased = BEZIER (6613) with an ease; no linear (6612) and no hold (6614) anywhere.
    const keys = JSON.stringify(clean).match(/"inInterp": ?6613/g) ?? [];
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(clean)).not.toMatch(/"(in|out)Interp": ?(6612|6614)/);
  });

  it.each([
    ["progetto-prova.json", clean],
    ["errori-3.json", planted],
  ])("%s uses After Effects' own interpolation numbers, and names that agree", (_f, doc) => {
    // The numbers are what jsx/import.jsx applies (setInterpolationTypeAtKey);
    // the names are informational. They must say the same thing.
    const NAMES: Record<number, string> = { 6612: "linear", 6613: "bezier", 6614: "hold" };
    const seen: Array<{
      inInterp: number;
      outInterp: number;
      inInterpName?: string;
      outInterpName?: string;
    }> = [];
    JSON.stringify(doc, (k, v) => {
      if (k === "keyframes") seen.push(...(v as typeof seen));
      return v;
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const kf of seen) {
      expect(Object.keys(NAMES).map(Number)).toContain(kf.inInterp);
      expect(kf.inInterpName).toBe(NAMES[kf.inInterp]);
      expect(kf.outInterpName).toBe(NAMES[kf.outInterp]);
    }
  });

  it("errori-3 is the clean project plus exactly the three planted changes", () => {
    const strip = (doc: typeof clean) => {
      const d = structuredClone(doc);
      const main = d.items.find((i: { name: string }) => i.name === "Principale");
      // 1. one extra layer that starts after the comp ends
      const late = main.layers.findIndex((l: { name: string }) => l.name === "Credito finale");
      if (late !== -1) {
        expect(main.layers[late]).toMatchObject({ inPoint: 11, outPoint: 13, startTime: 11 });
        main.layers.splice(late, 1);
        main.layers.forEach((l: { index: number }, i: number) => (l.index = i + 1));
        main.layerCount = main.layers.length;
      }
      const sub = main.layers.find((l: { name: string }) => l.name === "Sottotitolo");
      const pos = sub.transformGroup.properties[0];
      // 2. the subtitle pushed down into the bottom margin (5% of 1080 = 54 px)
      if (pos.value[1] === 1050) pos.value = [960, 620];
      const dot = main.layers.find((l: { name: string }) => l.name === "Cerchio");
      const dotPos = dot.transformGroup.properties[0];
      // 3. linear position keys on the circle
      if (dotPos.keyframes) {
        expect(
          dotPos.keyframes.map((k: { inInterp: number; outInterp: number }) => [
            k.inInterp,
            k.outInterp,
          ]),
        ).toEqual([
          [6612, 6612],
          [6612, 6612],
        ]);
        delete dotPos.keyframes;
      }
      return d;
    };
    expect(strip(planted)).toEqual(clean);
    expect(planted).not.toEqual(clean);
  });

  it("offline, the audit finds nothing on the clean project, precomp included", () => {
    const res = auditDoc(clean, { profondita: 1 });
    expect(res.ok).toBe(true);
    expect(res.nonControllate).toEqual([]);
    expect(res.riepilogo.composizioniControllate).toEqual(["Principale", "Sfondo animato"]);
    expect(res.segnalazioni).toEqual([]);
    expect(res.riepilogo.testo).toBe("Nessuna segnalazione.");
  });

  it("offline, the audit finds the three planted errors and nothing else", () => {
    const res = auditDoc(planted, { profondita: 1 });
    expect(res.ok).toBe(true);
    expect(res.nonControllate).toEqual([]);
    const got = res.segnalazioni.map((f) => ({ regola: f.regola, livello: f.livello }));
    expect(got).toEqual(EXPECTED_ERRORI_3);
    // Four findings, three elements: one problem per planted error.
    expect(res.riepilogo).toMatchObject({
      totale: 4,
      errori: 1,
      avvisi: 3,
      elementiConSegnalazioni: 3,
    });
    expect(res.riepilogo.perElemento).toEqual([
      {
        composizione: "Principale",
        livello: "Cerchio",
        regole: ["keyframe-lineari", "movimento-senza-motion-blur"],
      },
      { composizione: "Principale", livello: "Credito finale", regole: ["fuori-dal-tempo"] },
      { composizione: "Principale", livello: "Sottotitolo", regole: ["area-sicura"] },
    ]);
    expect(res.riepilogo.testo).toBe(
      "3 problemi su 3 livelli, 4 segnalazioni (1 errore, 3 avvisi).",
    );
  });

  it("offline, with motion blur switched on for the circle, three findings remain", () => {
    // The same step the E2E suite takes with layer.set_props after the import.
    const res = auditDoc(planted, { profondita: 1 }, (comps) => {
      const main = comps.find((c) => c.name === "Principale")!;
      main.layers.find((l) => l.name === "Cerchio")!.motionBlur = true;
    });
    const got = res.segnalazioni.map((f) => ({ regola: f.regola, livello: f.livello }));
    expect(got).toEqual(
      EXPECTED_ERRORI_3.filter((e) => e.regola !== "movimento-senza-motion-blur"),
    );
    expect(res.riepilogo.testo).toBe(
      "3 problemi su 3 livelli, 3 segnalazioni (1 errore, 2 avvisi).",
    );
  });
});

describe("the first run on After Effects 26.5 (25/10/2026)", () => {
  // What happened: errori-3.json then wrote the circle's keys as 6613, after
  // a comment in src/schema.ts that calls 6613 LINEAR. After Effects reads
  // 6613 as BEZIER (6612 is LINEAR), so the import made bezier keys and the
  // linear-keyframe rule rightly said nothing: 3 findings instead of 4. The
  // fake now uses After Effects' numbers (tests/helpers/audit-fakes.ts), so
  // it reproduces that run — and shows the corrected project gives all 4.
  const withCircleKeys = (interp: number) => {
    const d = structuredClone(planted);
    const main = d.items.find((i: { name: string }) => i.name === "Principale");
    const dot = main.layers.find((l: { name: string }) => l.name === "Cerchio");
    for (const k of dot.transformGroup.properties[0].keyframes) {
      k.inInterp = interp;
      k.outInterp = interp;
      delete k.inInterpName;
      delete k.outInterpName;
    }
    return d;
  };

  it("with the old 6613 keys the rule stays silent, as it did in After Effects", () => {
    const res = auditDoc(withCircleKeys(6613), { profondita: 1 });
    expect(res.segnalazioni.map((f) => ({ regola: f.regola, livello: f.livello }))).toEqual(
      EXPECTED_ERRORI_3.filter((e) => e.regola !== "keyframe-lineari"),
    );
  });

  it("with 6612 (LINEAR) keys the rule finds the circle", () => {
    const res = auditDoc(withCircleKeys(6612), { profondita: 1 });
    expect(res.segnalazioni.map((f) => ({ regola: f.regola, livello: f.livello }))).toEqual(
      EXPECTED_ERRORI_3,
    );
  });
});
