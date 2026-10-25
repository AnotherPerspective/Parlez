// Recipe validator, offline: the shipped recipes pass, and each kind of
// mistake gives the plain-Italian message a motion designer can act on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listRecipes } from "../src/recipes/library.js";
import { validateRecipe } from "../src/recipes/validate.js";

const LOWER_THIRD = JSON.parse(
  readFileSync(fileURLToPath(new URL("../recipes/lower-third.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

/** A deep copy of the lower third with one change applied. */
function variant(edit: (r: Record<string, any>) => void): Record<string, unknown> {
  const copy = structuredClone(LOWER_THIRD) as Record<string, any>;
  edit(copy);
  return copy;
}

function messages(raw: unknown): string[] {
  const v = validateRecipe(raw);
  return v.ok ? [] : v.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("shipped recipes", () => {
  it("every recipe in recipes/ is valid", () => {
    const all = listRecipes({} as NodeJS.ProcessEnv);
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const r of all) expect(r.issues, r.file).toEqual([]);
  });
});

describe("validator messages", () => {
  it("a missing field", () => {
    expect(messages(variant((r) => delete r.title))).toEqual(["title: manca il titolo"]);
    expect(messages(variant((r) => delete r.params.title.default))).toEqual([
      "params.title.default: manca il valore predefinito («default»)",
    ]);
  });

  it("a wrong unit", () => {
    expect(messages(variant((r) => (r.params.barIn.default.default = "12px")))).toEqual([
      'params.barIn.default.default: "12px" non è un tempo: usa per esempio "12f", "0.5s" o "12f@25"',
    ]);
    expect(messages(variant((r) => (r.params.textMove.default.default = "40")))).toEqual([
      'params.textMove.default.default: "40" non è una lunghezza: usa per esempio "24u" o "24px"',
    ]);
    expect(messages(variant((r) => (r.params.barColor.default.default = "blu")))).toEqual([
      'params.barColor.default.default: "blu" non è un colore: usa "#RRGGBB", per esempio "#14213D"',
    ]);
  });

  it("a badly written archive reference", () => {
    const m = messages(variant((r) => (r.params.barColor.default.$ref = "stile:colore/primario")));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(
      /^params\.barColor\.default\.\$ref: riferimento "stile:colore\/primario" scritto male/,
    );
  });

  it("a layer type that is not allowed (no flat images, no solids)", () => {
    const m = messages(variant((r) => (r.layers[1].type = "solid")));
    expect(m).toContain(
      'layers[1].type: tipo di livello "solid" non consentito: le ricette fanno solo livelli veri e modificabili (null, shape, text), niente solidi, immagini o filmati',
    );
  });

  it("a minimum After Effects version below the project's, or below a declared feature", () => {
    expect(messages(variant((r) => (r.requires.ae = "23.0")))).toEqual([
      'requires.ae: "23.0" è sotto la versione minima del progetto (24.0, After Effects 2024)',
    ]);
    expect(messages(variant((r) => (r.requires.capabilities = ["characterRange"])))).toEqual([
      'requires.ae: la ricetta usa «characterRange», che c\'è da After Effects 24.3: la versione minima non può essere "24.0"',
    ]);
    expect(messages(variant((r) => (r.requires.capabilities = ["teletrasporto"])))[0]).toMatch(
      /^requires\.capabilities\[0\]: funzione "teletrasporto" sconosciuta/,
    );
    expect(
      messages(
        variant((r) => ((r.requires.ae = "24.3"), (r.requires.capabilities = ["characterRange"]))),
      ),
    ).toEqual([]);
  });

  it("a calc that reads a name that does not exist", () => {
    expect(messages(variant((r) => (r.let.titleY = "= -H/2 + padY + tilteCap")))).toEqual([
      "let.titleY: nel calcolo «= -H/2 + padY + tilteCap» il nome «tilteCap» non esiste",
    ]);
  });

  it("a let value that reads one defined after it", () => {
    expect(messages(variant((r) => (r.let.padX = "= gap")))).toEqual([
      "let.padX: nel calcolo «= gap» il nome «gap» non esiste",
    ]);
  });

  it("a broken calc", () => {
    const m = messages(variant((r) => (r.let.H = "= padY * (2 + ")));
    expect(m).toEqual(["let.H: calcolo «= padY * (2 + » non valido: calcolo incompleto"]);
    expect(messages(variant((r) => (r.let.H = "= floor(padY)")))).toEqual([
      "let.H: calcolo «= floor(padY)» non valido: funzione sconosciuta «floor» (ci sono: min, max, round, abs, if)",
    ]);
  });

  it("an unknown curve", () => {
    expect(messages(variant((r) => (r.animation[0].keys[1].curve = "elastica")))[0]).toMatch(
      /^animation\[0\]\.keys\[1\]\.curve: curva "elastica" sconosciuta \(ci sono: linear, dolce/,
    );
  });

  it("an unknown property", () => {
    expect(messages(variant((r) => (r.animation[2].property = "opacità")))[0]).toMatch(
      /^animation\[2\]\.property: proprietà "opacità" sconosciuta/,
    );
  });

  it("a parent that comes later, and a duplicated layer name", () => {
    const m = messages(
      variant((r) => {
        r.layers[0].parent = "bar";
        r.layers[3].name = "LT Titolo";
      }),
    );
    expect(m).toContain(
      'layers[0].parent: il genitore "bar" deve essere un livello che viene PRIMA nell\'elenco',
    );
    expect(m).toContain(
      "layers[3].name: il nome «LT Titolo» è già usato: in kumo i livelli si trovano per nome, servono nomi diversi",
    );
  });

  it("an approved recipe without approval", () => {
    expect(messages(variant((r) => (r.status = "approved")))).toEqual([
      "header.approval: una ricetta approvata deve dire chi l'ha approvata («by») e quando («date»)",
    ]);
    expect(
      messages(
        variant(
          (r) => (
            (r.status = "approved"),
            (r.header.approval = { by: "Anthony", date: "10/11/2026" })
          ),
        ),
      ),
    ).toEqual(["header.approval.date: la data va scritta AAAA-MM-GG, per esempio 2026-11-10"]);
  });

  it("no acceptance check", () => {
    expect(messages(variant((r) => delete r.acceptance))).toEqual([
      "acceptance: manca il controllo di accettazione (cosa guardare dopo l'esecuzione)",
    ]);
  });

  it("a curve on the first key", () => {
    expect(messages(variant((r) => (r.animation[0].keys[0].curve = "dolce")))).toEqual([
      "animation[0].keys[0].curve: la prima chiave non ha curva: la curva sta sulla chiave di arrivo del tratto",
    ]);
  });

  it("not an object at all", () => {
    expect(messages("ciao")).toEqual([": una ricetta è un oggetto JSON"]);
  });
});
