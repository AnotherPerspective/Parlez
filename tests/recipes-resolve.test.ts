// Resolver, offline: where values come from (args → archive → defaults),
// times at 25 and 30 fps, the calculator, safe areas per format, named curves
// against the curve itself, staggers and multi-key patterns.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadArchive, resolveRef } from "../src/recipes/archive.js";
import { evaluate, parseCalc } from "../src/recipes/calc.js";
import { CURVES, aeSegmentAt, bezierToEase, cubicAt } from "../src/recipes/curves.js";
import { keySpecs } from "../src/recipes/generate.js";
import type { ResolvedTrack } from "../src/recipes/resolve.js";
import { resolveRecipe } from "../src/recipes/resolve.js";
import type { Recipe } from "../src/recipes/types.js";
import { RecipeError } from "../src/recipes/types.js";
import { framesToSeconds, hexToRgb01, lengthToPx, timeToFrames } from "../src/recipes/units.js";
import { validateRecipe } from "../src/recipes/validate.js";

const ARCHIVE_DIR = fileURLToPath(new URL("./fixtures/archivio-lanterna-blu/", import.meta.url));
const archive = loadArchive(ARCHIVE_DIR);
const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL("../recipes/lower-third.json", import.meta.url)), "utf8"),
);
const v = validateRecipe(raw);
if (!v.ok) throw new Error(JSON.stringify(v.issues));
const LT = v.recipe;

function ltWith(edit: (r: Record<string, any>) => void): Recipe {
  const copy = structuredClone(LT) as unknown as Record<string, any>;
  edit(copy);
  return copy as unknown as Recipe;
}

const ctx = (vars: Record<string, unknown>, fps = 25, unit = 1) => ({
  fps,
  unit,
  lookup: (n: string) => {
    if (n in vars) return vars[n];
    throw new Error(`no ${n}`);
  },
});
const calc = (src: string, vars: Record<string, unknown> = {}, fps?: number, unit?: number) =>
  evaluate(parseCalc(src), ctx(vars, fps, unit));

function track(
  alias: string,
  kind: "1d" | "spatial" | "multi",
  a: number | number[],
  b: number | number[],
): ResolvedTrack {
  return {
    layerName: "L",
    layerOrder: 0,
    trackOrder: 0,
    alias,
    info: { path: [], kind },
    spatialLinear: false,
    keys: [
      { frame: 0, value: a, curve: null },
      { frame: 12, value: b, curve: "decelera" },
    ],
  };
}

function safeOf(format: string) {
  return resolveRecipe(LT, { archive, args: { format } });
}

describe("units", () => {
  it("times become whole frames at the comp's rate", () => {
    expect(timeToFrames("12f", 25)).toBe(12);
    expect(timeToFrames("0.5s", 25)).toBe(13); // 12.5 rounds up
    expect(timeToFrames("0.5s", 30)).toBe(15);
    expect(timeToFrames("12f@25", 25)).toBe(12);
    expect(timeToFrames("12f@25", 30)).toBe(14); // 0.48 s × 30 = 14.4
    expect(timeToFrames("2s", 29.97)).toBe(60);
    expect(() => timeToFrames("12px", 25)).toThrow(/non è un tempo/);
  });

  it("seconds for kumo carry no float noise", () => {
    expect(framesToSeconds(14, 30)).toBe(0.466667);
    expect(framesToSeconds(12, 25)).toBe(0.48);
  });

  it("lengths: px stays, u scales with the short side", () => {
    expect(lengthToPx("24px", 2)).toBe(24);
    expect(lengthToPx("24u", 1)).toBe(24);
    expect(lengthToPx("24u", 2)).toBe(48);
    expect(lengthToPx(10, 2)).toBe(10);
  });

  it("colors: #RRGGBB → 0–1", () => {
    expect(hexToRgb01("#14213D")).toEqual([0.0784, 0.1294, 0.2392]);
    expect(hexToRgb01("#ffffff")).toEqual([1, 1, 1]);
    expect(() => hexToRgb01("#FFF")).toThrow(/non è un colore/);
  });
});

describe("calculator", () => {
  it("does arithmetic, units, vectors and functions", () => {
    expect(calc("= 2 + 3 * 4")).toBe(14);
    expect(calc("= (2 + 3) * 4")).toBe(20);
    expect(calc("= -H/2 + 18", { H: 112.24 })).toBeCloseTo(-38.12, 10);
    expect(calc("= end - 12f", { end: 124 })).toBe(112);
    expect(calc("= 0.5s + 1f", {}, 30)).toBe(16);
    expect(calc("= 12f@25", {}, 30)).toBe(14);
    expect(calc("= [600u, 2 * 3]", {}, 25, 2)).toEqual([1200, 6]);
    expect(calc("= safe.title.left + 24u", { safe: { title: { left: 96 } } })).toBe(120);
    expect(calc("= round(min(3.4, 9) + max(1, 2))")).toBe(5);
    expect(calc("= if(subtitle, 1, 2)", { subtitle: "" })).toBe(2);
    expect(calc("= if(subtitle, 1, 2)", { subtitle: "Ruolo" })).toBe(1);
  });

  it("refuses what is not in its tiny language", () => {
    expect(() => parseCalc("= alert(1)")).toThrow(/funzione sconosciuta «alert»/);
    expect(() => parseCalc("= a; b")).toThrow(/carattere inatteso/);
    expect(() => parseCalc("= 12fx")).toThrow(/non è un numero/);
    expect(() => calc("= 1 / 0")).toThrow(/divisione per zero/);
    expect(() => calc("= x.y", { x: {} })).toThrow(/«y» non c'è/);
  });
});

describe("named curves (§8.2)", () => {
  it("convert to AE influence and speed factor as the spec's table says", () => {
    expect(
      bezierToEase((CURVES.decelera as { bezier: [number, number, number, number] }).bezier),
    ).toEqual({
      outInfluence: 5,
      outFactor: expect.closeTo(14, 9),
      inInfluence: expect.closeTo(90, 9),
      inFactor: 0,
    });
    const acc = bezierToEase(
      (CURVES.accelera as { bezier: [number, number, number, number] }).bezier,
    );
    expect(acc.outInfluence).toBeCloseTo(30, 9);
    expect(acc.outFactor).toBe(0);
    expect(acc.inInfluence).toBeCloseTo(20, 9);
    expect(acc.inFactor).toBeCloseTo(4.25, 9);
    const dolce = bezierToEase(
      (CURVES.dolce as { bezier: [number, number, number, number] }).bezier,
    );
    expect(dolce.outInfluence).toBeCloseTo(33.3, 9);
    expect(dolce.inInfluence).toBeCloseTo(33.3, 9);
  });

  it("the AE segment built from those numbers IS the curve (max error under 0.5%)", () => {
    for (const [name, c] of Object.entries(CURVES)) {
      if (c.kind !== "bezier") continue;
      const ease = bezierToEase(c.bezier);
      let worst = 0;
      for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        worst = Math.max(worst, Math.abs(aeSegmentAt(ease, t) - cubicAt(c.bezier, t)));
      }
      expect(worst, name).toBeLessThan(0.005);
    }
  });

  it("speeds: 1D signed, spatial by distance, multi-dimensional held at 0 with a warning", () => {
    const w: string[] = [];
    expect(keySpecs(track("opacity", "1d", 100, 0), 25, w)[0].outSpeed).toBe(-2916.67);
    expect(keySpecs(track("position", "spatial", [0, 0], [30, 40]), 25, w)[0].outSpeed).toBe(
      1458.33,
    ); // 50 px / 0.48 s × 14
    expect(w).toEqual([]);
    expect(keySpecs(track("scale", "multi", [0, 100], [100, 100]), 25, w)[0].outSpeed).toBe(0);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/velocità 0/);
  });
});

describe("where values come from (§4.1)", () => {
  it("args beat the archive, the archive beats the recipe's literal", () => {
    const fromArchive = resolveRecipe(LT, { archive });
    expect(fromArchive.params.barColor).toEqual([0.0784, 0.1294, 0.2392]); // notte
    expect(fromArchive.params.barIn).toBe(12);
    const fromArgs = resolveRecipe(LT, { archive, args: { barColor: "#FF0000", barIn: "20f" } });
    expect(fromArgs.params.barColor).toEqual([1, 0, 0]);
    expect(fromArgs.params.barIn).toBe(20);
    const noArchive = resolveRecipe(LT, {});
    expect(noArchive.params.titleColor).toEqual([1, 1, 1]); // the recipe's own "#FFFFFF"
    expect(noArchive.defaultsUsed.find((d) => d.param === "titleColor")?.reason).toBe(
      "nessun archivio indicato",
    );
  });

  it("an unresolved reference falls back and says why", () => {
    const r = resolveRecipe(
      ltWith((x) => (x.params.barIn.default.$ref = "technique:bar-slide/duration")),
      { archive },
    );
    expect(r.params.barIn).toBe(12);
    expect(r.warnings).toContain(
      'usato "12f" al posto di technique:bar-slide/duration: nessuna scheda tecnica approvata con il ruolo «bar-slide»',
    );
  });

  it("a draft from the grinding step is never used, even when asked for by id", () => {
    expect(resolveRef("card:t-entrata-lenta/duration", archive)).toEqual({
      ok: false,
      reason: "nessuna scheda approvata con id «t-entrata-lenta»",
    });
    // The real text-entry card wins, not the draft with the same role in bozze/.
    expect(resolveRecipe(LT, { archive }).params.textIn).toBe(12);
  });

  it("refuses an argument the recipe does not have, and a text that is too long", () => {
    expect(() => resolveRecipe(LT, { archive, args: { titolo: "x" } })).toThrow(
      /la ricetta non ha il parametro «titolo»/,
    );
    expect(() => resolveRecipe(LT, { archive, args: { title: "x".repeat(40) } })).toThrow(
      /supera 32 caratteri/,
    );
    expect(() => resolveRecipe(LT, { archive, args: { duration: "2s" } })).toThrow(
      /meno del minimo \(3s\)/,
    );
  });

  it("records every card it read, field by field", () => {
    const r = resolveRecipe(LT, { archive });
    const style = r.usedCards.find((c) => c.id === "s-lanterna");
    // In reading order: params first, then the format they settle.
    expect(style?.fields).toEqual([
      "color/primary",
      "color/onPrimary",
      "color/accent",
      "font/title",
      "font/body",
      "size/lowerThirdTitle",
      "size/lowerThirdSub",
      "format/16:9",
    ]);
  });
});

describe("formats and safe areas (§6)", () => {
  it("16:9 from the style card: 5% each side", () => {
    const r = safeOf("16:9");
    expect([r.comp.width, r.comp.height, r.comp.fps, r.unit]).toEqual([1920, 1080, 25, 1]);
    expect(r.safe.title).toEqual({
      left: 96,
      right: 1824,
      top: 54,
      bottom: 1026,
      width: 1728,
      height: 972,
    });
    expect(r.safe.action).toEqual({
      left: 67.2,
      right: 1852.8,
      top: 37.8,
      bottom: 1042.2,
      width: 1785.6,
      height: 1004.4,
    });
  });

  it("9:16 from the style card: room for the social interface top and bottom", () => {
    const r = safeOf("9:16");
    expect(r.safe.title).toEqual({
      left: 54,
      right: 1026,
      top: 230.4,
      bottom: 1536,
      width: 972,
      height: 1305.6,
    });
    expect(r.unit).toBe(1);
  });

  it("1:1 and 4:5 are not in the card: the fallback table is used", () => {
    expect(safeOf("1:1").safe.title).toEqual({
      left: 54,
      right: 1026,
      top: 54,
      bottom: 1026,
      width: 972,
      height: 972,
    });
    expect(safeOf("4:5").safe.title).toEqual({
      left: 54,
      right: 1026,
      top: 108,
      bottom: 1188,
      width: 972,
      height: 1080,
    });
    expect(safeOf("4:5").usedCards.find((c) => c.id === "s-lanterna")?.fields).not.toContain(
      "format/4:5",
    );
  });

  it("an unknown format is refused with the list of known ones", () => {
    expect(() => safeOf("21:9")).toThrow(
      /formato «21:9» sconosciuto \(ci sono: 16:9, 9:16, 1:1, 4:5\)/,
    );
  });

  it("the lower third sits on the title area's bottom-left in every format", () => {
    for (const format of ["16:9", "9:16", "1:1", "4:5"]) {
      const r = safeOf(format);
      const ctrl = r.layers.find((l) => l.id === "ctrl")!;
      const H = 112.24;
      expect(ctrl.transform.position, format).toEqual([
        r.safe.title.left,
        Math.round((r.safe.title.bottom - H / 2) * 100) / 100,
      ]);
    }
  });
});

describe("staggers and multi-key curves (§8.3–8.4)", () => {
  it("entry keys shift by i × stagger.in, exit keys by i × stagger.out", () => {
    const r = resolveRecipe(LT, { archive });
    const frames = (layer: string, alias: string) =>
      r.tracks.find((t) => t.layerName === layer && t.alias === alias)!.keys.map((k) => k.frame);
    expect(frames("LT Titolo", "position")).toEqual([5, 17, 106, 116]);
    expect(frames("LT Sottotitolo", "position")).toEqual([8, 20, 104, 114]);
    expect(frames("LT Titolo", "opacity")).toEqual([5, 15, 106, 116]);
    expect(frames("LT Sottotitolo", "opacity")).toEqual([8, 18, 104, 114]);
    expect(frames("LT Barra", "control:Apertura")).toEqual([0, 12, 112, 124]);
  });

  it("a bigger stagger from args moves only the later layers", () => {
    const r = resolveRecipe(LT, { archive, args: { stagger: "6f" } });
    expect(
      r.tracks.find((t) => t.layerName === "LT Titolo" && t.alias === "opacity")!.keys[0].frame,
    ).toBe(5);
    expect(
      r.tracks.find((t) => t.layerName === "LT Sottotitolo" && t.alias === "opacity")!.keys[0]
        .frame,
    ).toBe(11);
  });

  it("overshoot adds a key at 70% of the time that passes the target by 6%", () => {
    const r = resolveRecipe(
      ltWith((x) => (x.animation[0].keys[1].curve = "overshoot")),
      { archive },
    );
    const bar = r.tracks.find((t) => t.layerName === "LT Barra")!;
    expect(bar.keys.slice(0, 3)).toEqual([
      { frame: 0, value: 0, curve: null },
      { frame: 8, value: 106, curve: "decelera" },
      { frame: 12, value: 100, curve: "dolce" },
    ]);
  });

  it("keys out of order or outside the comp are refused", () => {
    expect(() =>
      resolveRecipe(
        ltWith((x) => (x.animation[0].keys[1].at = "200f")),
        { archive },
      ),
    ).toThrow(RecipeError);
    expect(() =>
      resolveRecipe(
        ltWith((x) => (x.animation[0].keys[1].at = "200f")),
        { archive },
      ),
    ).toThrow(/fuori dalla composizione \(0…124\)/);
    expect(() => resolveRecipe(LT, { archive, args: { barIn: "3s" } })).toThrow(
      /le chiavi non sono in ordine/,
    );
  });
});
