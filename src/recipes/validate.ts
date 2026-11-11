// Recipe validator (recipe format §2–§10). Every message is plain Italian
// and names the field, because the person reading it may be a motion designer
// rather than a programmer. Validation never touches After Effects or the
// archive: whether a `$ref` resolves is decided later, against the archive the
// caller chose (resolve.ts), and reported there.

import { CALC_FUNCTIONS, CalcError, calcNames, isCalc, parseCalc } from "./calc.js";
import { CURVES } from "./curves.js";
import { isWellFormedRef } from "./archive.js";
import { PROPERTY_ALIAS_HELP, TEXT_STYLE_KEYS, TRANSFORM_KEYS, propertyInfo } from "./props.js";
import type { Recipe, RecipeIssue } from "./types.js";
import { KNOWN_CAPABILITIES, MIN_AE_VERSION } from "./types.js";
import { isHexColor, isLengthLiteral, isTimeLiteral } from "./units.js";

export const RECIPE_FORMAT_PREFIX = "parlez.recipe/";

const PARAM_TYPES = ["text", "color", "font", "length", "time", "format", "curve", "choice"];
const LAYER_TYPES = ["null", "shape", "text"];
const CHECK_TYPES = ["insideSafeArea", "inside", "fontIs", "value", "frames"];
const CONFIDENTIALITY = ["libero", "interno-app", "cliente"];
const STATUS = ["draft", "approved", "retired"];
/** Names every calc may read besides params and let (resolve.ts provides them). */
export const CALC_BUILTINS = ["comp", "end", "fps", "safe", "u"];

export type RecipeValidation =
  | { ok: true; recipe: Recipe; issues: [] }
  | { ok: false; issues: RecipeIssue[] };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

class Collector {
  readonly issues: RecipeIssue[] = [];
  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }
}

/**
 * Check a calc's syntax and the names it reads. `known` is what the calc may
 * see at that point (params, the let values defined BEFORE it, builtins).
 */
function checkCalc(c: Collector, path: string, src: string, known: Set<string>): void {
  try {
    const names = calcNames(parseCalc(src));
    for (const n of names) {
      if (!known.has(n)) c.add(path, `nel calcolo «${src}» il nome «${n}» non esiste`);
    }
  } catch (err) {
    if (err instanceof CalcError) c.add(path, `calcolo «${src}» non valido: ${err.message}`);
    else throw err;
  }
}

/** Walk any value: every "= …" string inside it is checked. */
function checkValue(c: Collector, path: string, v: unknown, known: Set<string>): void {
  if (isCalc(v)) checkCalc(c, path, v, known);
  else if (Array.isArray(v)) v.forEach((x, i) => checkValue(c, `${path}[${i}]`, x, known));
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) checkValue(c, `${path}.${k}`, x, known);
}

function checkTimeField(c: Collector, path: string, v: unknown, known: Set<string>): void {
  if (isCalc(v)) return checkCalc(c, path, v, known);
  if (!isTimeLiteral(v)) {
    c.add(
      path,
      `${JSON.stringify(v)} non è un tempo: usa per esempio "12f", "0.5s", "12f@25" o un calcolo "= end - 12f"`,
    );
  }
}

function checkLiteralForType(c: Collector, path: string, type: string, v: unknown, p: Obj): void {
  if (isCalc(v)) return; // checked by checkValue with the param scope
  switch (type) {
    case "text":
      if (typeof v !== "string") c.add(path, "deve essere un testo");
      else if (typeof p.maxChars === "number" && v.length > p.maxChars) {
        c.add(path, `il testo supera ${p.maxChars} caratteri`);
      }
      break;
    case "color":
      if (!isHexColor(v))
        c.add(path, `${JSON.stringify(v)} non è un colore: usa "#RRGGBB", per esempio "#14213D"`);
      break;
    case "font":
      if (typeof v !== "string" && !(isObj(v) && typeof v.postscript === "string")) {
        c.add(
          path,
          'deve essere il nome PostScript del font (es. "Inter-Bold") o un font della scheda di stile',
        );
      }
      break;
    case "length":
      if (typeof v !== "number" && !isLengthLiteral(v)) {
        c.add(path, `${JSON.stringify(v)} non è una lunghezza: usa per esempio "24u" o "24px"`);
      }
      break;
    case "time":
      if (!isTimeLiteral(v))
        c.add(
          path,
          `${JSON.stringify(v)} non è un tempo: usa per esempio "12f", "0.5s" o "12f@25"`,
        );
      break;
    case "format":
      if (typeof v !== "string")
        c.add(path, 'deve essere il nome di un formato, per esempio "16:9"');
      break;
    case "curve":
      if (typeof v !== "string" || !Object.hasOwn(CURVES, v)) {
        c.add(
          path,
          `curva ${JSON.stringify(v)} sconosciuta (ci sono: ${Object.keys(CURVES).join(", ")})`,
        );
      }
      break;
    case "choice":
      if (!Array.isArray(p.options) || !p.options.includes(v as string)) {
        c.add(path, `${JSON.stringify(v)} non è tra le scelte ammesse`);
      }
      break;
    default:
      break;
  }
}

function checkParams(c: Collector, params: unknown): Set<string> {
  const names = new Set<string>();
  if (!isObj(params)) {
    c.add("params", "manca l'elenco dei parametri (un oggetto, anche vuoto)");
    return names;
  }
  for (const [name, raw] of Object.entries(params)) {
    names.add(name);
    const path = `params.${name}`;
    if (!isObj(raw)) {
      c.add(path, "deve essere un oggetto con almeno «type»");
      continue;
    }
    if (typeof raw.type !== "string" || !PARAM_TYPES.includes(raw.type)) {
      c.add(
        `${path}.type`,
        `tipo ${JSON.stringify(raw.type)} sconosciuto (ci sono: ${PARAM_TYPES.join(", ")})`,
      );
      continue;
    }
    if (raw.type === "choice" && (!Array.isArray(raw.options) || raw.options.length === 0)) {
      c.add(`${path}.options`, "un parametro «choice» deve elencare le scelte in «options»");
    }
    if (raw.default === undefined) {
      if (raw.optional !== true)
        c.add(`${path}.default`, "manca il valore predefinito («default»)");
      continue;
    }
    const d = raw.default;
    if (isObj(d) && Object.hasOwn(d, "$ref")) {
      if (typeof d.$ref !== "string" || !isWellFormedRef(d.$ref)) {
        c.add(
          `${path}.default.$ref`,
          `riferimento ${JSON.stringify(d.$ref)} scritto male: usa style:color/<ruolo>, style:font/<ruolo>, style:size/<nome>, technique:<ruolo>/<campo> o card:<id>/<campo>`,
        );
      }
      if (d.default === undefined) {
        if (raw.optional !== true) {
          c.add(
            `${path}.default.default`,
            "manca il valore di riserva accanto al riferimento all'archivio",
          );
        }
      } else {
        checkLiteralForType(c, `${path}.default.default`, raw.type, d.default, raw);
      }
    } else {
      checkLiteralForType(c, `${path}.default`, raw.type, d, raw);
    }
    for (const bound of ["min", "max"] as const) {
      if (raw[bound] !== undefined && !isTimeLiteral(raw[bound]) && raw.type === "time") {
        c.add(`${path}.${bound}`, `${JSON.stringify(raw[bound])} non è un tempo`);
      }
    }
  }
  return names;
}

function checkHeader(c: Collector, header: unknown, status: unknown): void {
  if (!isObj(header)) {
    c.add("header", "manca l'intestazione (provenienza, approvazione, riservatezza)");
    return;
  }
  if (
    typeof header.confidentiality !== "string" ||
    !CONFIDENTIALITY.includes(header.confidentiality)
  ) {
    c.add(
      "header.confidentiality",
      `riservatezza ${JSON.stringify(header.confidentiality)} sconosciuta (ci sono: ${CONFIDENTIALITY.join(", ")})`,
    );
  }
  if (status === "approved") {
    const a = header.approval;
    if (!isObj(a) || typeof a.by !== "string" || typeof a.date !== "string") {
      c.add(
        "header.approval",
        "una ricetta approvata deve dire chi l'ha approvata («by») e quando («date»)",
      );
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
      c.add("header.approval.date", "la data va scritta AAAA-MM-GG, per esempio 2026-11-10");
    }
  }
  if (header.sources !== undefined && !Array.isArray(header.sources)) {
    c.add("header.sources", "le fonti vanno in un elenco");
  }
}

function checkRequires(c: Collector, req: unknown): void {
  if (!isObj(req)) {
    c.add(
      "requires",
      `manca «requires» con la versione minima di After Effects (almeno "${MIN_AE_VERSION}")`,
    );
    return;
  }
  const ae = req.ae;
  if (typeof ae !== "string" || !/^\d+\.\d+$/.test(ae)) {
    c.add("requires.ae", `la versione minima va scritta come "24.0"`);
    return;
  }
  if (compareVersions(ae, MIN_AE_VERSION) < 0) {
    c.add(
      "requires.ae",
      `"${ae}" è sotto la versione minima del progetto (${MIN_AE_VERSION}, After Effects 2024)`,
    );
  }
  if (!Array.isArray(req.capabilities)) {
    c.add("requires.capabilities", "serve l'elenco delle funzioni recenti usate (anche vuoto: [])");
    return;
  }
  req.capabilities.forEach((cap, i) => {
    if (typeof cap !== "string" || !Object.hasOwn(KNOWN_CAPABILITIES, cap)) {
      c.add(
        `requires.capabilities[${i}]`,
        `funzione ${JSON.stringify(cap)} sconosciuta (ci sono: ${Object.keys(KNOWN_CAPABILITIES).join(", ")})`,
      );
      return;
    }
    const since = KNOWN_CAPABILITIES[cap];
    if (compareVersions(ae, since) < 0) {
      c.add(
        "requires.ae",
        `la ricetta usa «${cap}», che c'è da After Effects ${since}: la versione minima non può essere "${ae}"`,
      );
    }
  });
}

function checkLayers(c: Collector, layers: unknown, known: Set<string>): Map<string, Obj> {
  const ids = new Map<string, Obj>();
  if (!Array.isArray(layers) || layers.length === 0) {
    c.add("layers", "servono dei livelli (un elenco, dal basso verso l'alto)");
    return ids;
  }
  const names = new Set<string>();
  layers.forEach((raw, i) => {
    const path = `layers[${i}]`;
    if (!isObj(raw)) {
      c.add(path, "ogni livello è un oggetto");
      return;
    }
    if (typeof raw.id !== "string" || raw.id === "")
      c.add(`${path}.id`, "manca l'«id» del livello");
    else if (ids.has(raw.id))
      c.add(`${path}.id`, `l'id «${raw.id}» è già usato da un altro livello`);
    if (typeof raw.type !== "string" || !LAYER_TYPES.includes(raw.type)) {
      c.add(
        `${path}.type`,
        `tipo di livello ${JSON.stringify(raw.type)} non consentito: le ricette fanno solo livelli veri e modificabili (${LAYER_TYPES.join(", ")}), niente solidi, immagini o filmati`,
      );
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "")
      c.add(`${path}.name`, "manca il nome del livello");
    else if (names.has(raw.name))
      c.add(
        `${path}.name`,
        `il nome «${raw.name}» è già usato: in kumo i livelli si trovano per nome, servono nomi diversi`,
      );
    else names.add(raw.name);
    if (raw.parent !== undefined && (typeof raw.parent !== "string" || !ids.has(raw.parent))) {
      c.add(
        `${path}.parent`,
        `il genitore ${JSON.stringify(raw.parent)} deve essere un livello che viene PRIMA nell'elenco`,
      );
    }
    if (raw.when !== undefined) {
      if (!isCalc(raw.when)) c.add(`${path}.when`, '«when» è un calcolo, per esempio "= subtitle"');
      else checkCalc(c, `${path}.when`, raw.when, known);
    }
    if (raw.type === "text" && typeof raw.text !== "string")
      c.add(`${path}.text`, "un livello di testo deve avere «text»");
    if (raw.type !== "shape" && raw.shapes !== undefined)
      c.add(`${path}.shapes`, "le forme si mettono solo nei livelli «shape»");
    if (raw.type !== "text" && raw.style !== undefined)
      c.add(`${path}.style`, "lo stile del testo si mette solo nei livelli «text»");
    if (raw.type === "shape") {
      if (!Array.isArray(raw.shapes) || raw.shapes.length === 0)
        c.add(`${path}.shapes`, "un livello «shape» deve avere almeno una forma");
      else
        raw.shapes.forEach((s, j) => {
          const sp = `${path}.shapes[${j}]`;
          if (!isObj(s) || typeof s.group !== "string")
            return c.add(sp, "ogni forma ha un gruppo con nome («group»)");
          if (!isObj(s.rect) && !isObj(s.ellipse))
            c.add(sp, "la forma deve avere «rect» o «ellipse»");
          if (!isObj(s.fill) && !isObj(s.stroke))
            c.add(sp, "la forma deve avere «fill» o «stroke», o non si vede");
          checkValue(c, sp, s, known);
        });
    }
    if (isObj(raw.style)) {
      for (const k of Object.keys(raw.style)) {
        if (!(TEXT_STYLE_KEYS as readonly string[]).includes(k)) {
          c.add(
            `${path}.style.${k}`,
            `«${k}» non è uno stile del testo che le ricette sanno impostare (${TEXT_STYLE_KEYS.join(", ")})`,
          );
        }
      }
      checkValue(c, `${path}.style`, raw.style, known);
    }
    if (raw.transform !== undefined) {
      if (!isObj(raw.transform)) c.add(`${path}.transform`, "«transform» è un oggetto");
      else {
        for (const k of Object.keys(raw.transform)) {
          if (!(TRANSFORM_KEYS as readonly string[]).includes(k)) {
            c.add(
              `${path}.transform.${k}`,
              `«${k}» non si imposta qui (${TRANSFORM_KEYS.join(", ")})`,
            );
          }
        }
        checkValue(c, `${path}.transform`, raw.transform, known);
      }
    }
    if (raw.controls !== undefined) {
      if (!Array.isArray(raw.controls)) c.add(`${path}.controls`, "«controls» è un elenco");
      else
        raw.controls.forEach((ctl, j) => {
          if (!isObj(ctl) || typeof ctl.slider !== "string")
            c.add(
              `${path}.controls[${j}]`,
              'ogni controllo è un cursore con nome: { "slider": "Apertura" }',
            );
        });
    }
    if (raw.expressions !== undefined) {
      if (!isObj(raw.expressions))
        c.add(`${path}.expressions`, "«expressions» è un oggetto proprietà → espressione");
      else
        for (const [alias, ex] of Object.entries(raw.expressions)) {
          const ep = `${path}.expressions.${alias}`;
          if (!propertyInfo(alias))
            c.add(ep, `proprietà «${alias}» sconosciuta (ci sono: ${PROPERTY_ALIAS_HELP})`);
          if (typeof ex === "string") continue;
          if (!isObj(ex) || ex.template !== "fitText")
            c.add(ep, 'un\'espressione è un testo o un modello { "template": "fitText", … }');
          else {
            if (!Array.isArray(ex.layers) || ex.layers.some((l) => typeof l !== "string"))
              c.add(`${ep}.layers`, "fitText vuole l'elenco degli id dei testi");
            checkValue(c, ep, { padX: ex.padX, height: ex.height }, known);
          }
        }
    }
    if (typeof raw.id === "string") ids.set(raw.id, raw);
  });
  // fitText may name text layers listed later (they are created before the
  // expressions are written), so it is checked once every id is known.
  layers.forEach((raw, i) => {
    if (!isObj(raw) || !isObj(raw.expressions)) return;
    for (const [alias, ex] of Object.entries(raw.expressions)) {
      if (!isObj(ex) || !Array.isArray(ex.layers)) continue;
      for (const id of ex.layers) {
        if (typeof id === "string" && ids.get(id)?.type !== "text") {
          c.add(
            `layers[${i}].expressions.${alias}.layers`,
            `«${id}» non è un livello di testo della ricetta`,
          );
        }
      }
    }
  });
  return ids;
}

function checkTracks(
  c: Collector,
  tracks: unknown,
  layerIds: Map<string, Obj>,
  known: Set<string>,
): void {
  if (tracks === undefined) return;
  if (!Array.isArray(tracks)) {
    c.add("animation", "«animation» è un elenco di tracce");
    return;
  }
  tracks.forEach((raw, i) => {
    const path = `animation[${i}]`;
    if (!isObj(raw)) return c.add(path, "ogni traccia è un oggetto");
    const targets =
      raw.layers !== undefined ? raw.layers : raw.layer !== undefined ? [raw.layer] : [];
    if (!Array.isArray(targets) || targets.length === 0)
      c.add(path, "la traccia deve dire su quale livello lavora («layer» o «layers»)");
    else
      for (const id of targets) {
        if (typeof id !== "string" || !layerIds.has(id))
          c.add(path, `il livello ${JSON.stringify(id)} non è nella ricetta`);
      }
    const info = typeof raw.property === "string" ? propertyInfo(raw.property) : null;
    if (!info)
      c.add(
        `${path}.property`,
        `proprietà ${JSON.stringify(raw.property)} sconosciuta (ci sono: ${PROPERTY_ALIAS_HELP})`,
      );
    if (raw.relative === true && raw.property !== "position" && raw.property !== "anchorPoint") {
      c.add(`${path}.relative`, "«relative» vale solo per position e anchorPoint");
    }
    if (raw.spatial !== undefined && raw.spatial !== "linear" && raw.spatial !== "auto")
      c.add(`${path}.spatial`, '«spatial» è "linear" o "auto"');
    if (raw.stagger !== undefined) {
      if (!isObj(raw.stagger)) c.add(`${path}.stagger`, '«stagger» è { "in": …, "out": … }');
      else
        for (const k of ["in", "out"])
          if (raw.stagger[k] !== undefined)
            checkTimeField(c, `${path}.stagger.${k}`, raw.stagger[k], known);
    }
    if (!Array.isArray(raw.keys) || raw.keys.length < 2) {
      c.add(`${path}.keys`, "servono almeno due chiavi");
      return;
    }
    raw.keys.forEach((k, j) => {
      const kp = `${path}.keys[${j}]`;
      if (!isObj(k)) return c.add(kp, "ogni chiave è un oggetto");
      if (k.at === undefined) c.add(`${kp}.at`, "manca il tempo della chiave («at»)");
      else checkTimeField(c, `${kp}.at`, k.at, known);
      const hasValue = k.value !== undefined;
      const hasOffset = k.offset !== undefined;
      if (raw.relative === true ? !hasOffset : !hasValue) {
        c.add(
          kp,
          raw.relative === true
            ? "in una traccia «relative» ogni chiave ha «offset»"
            : "manca il valore della chiave («value»)",
        );
      }
      if (hasValue) checkValue(c, `${kp}.value`, k.value, known);
      if (hasOffset) checkValue(c, `${kp}.offset`, k.offset, known);
      if (k.curve !== undefined) {
        if (j === 0)
          c.add(
            `${kp}.curve`,
            "la prima chiave non ha curva: la curva sta sulla chiave di arrivo del tratto",
          );
        else if (isCalc(k.curve)) checkCalc(c, `${kp}.curve`, k.curve, known);
        else if (typeof k.curve !== "string" || !Object.hasOwn(CURVES, k.curve)) {
          c.add(
            `${kp}.curve`,
            `curva ${JSON.stringify(k.curve)} sconosciuta (ci sono: ${Object.keys(CURVES).join(", ")})`,
          );
        }
      }
      if (k.phase !== undefined && k.phase !== "in" && k.phase !== "out")
        c.add(`${kp}.phase`, '«phase» è "in" o "out"');
    });
  });
}

function checkAcceptance(
  c: Collector,
  acc: unknown,
  layerIds: Map<string, Obj>,
  known: Set<string>,
): void {
  if (!isObj(acc)) {
    c.add("acceptance", "manca il controllo di accettazione (cosa guardare dopo l'esecuzione)");
    return;
  }
  if (
    !Array.isArray(acc.look) ||
    acc.look.length === 0 ||
    acc.look.some((l) => typeof l !== "string")
  ) {
    c.add("acceptance.look", "serve almeno una frase su cosa guardare");
  }
  if (!Array.isArray(acc.checks)) {
    c.add("acceptance.checks", "servono i controlli automatici (un elenco)");
    return;
  }
  const layerRef = (path: string, id: unknown) => {
    if (typeof id !== "string" || !layerIds.has(id))
      c.add(path, `il livello ${JSON.stringify(id)} non è nella ricetta`);
  };
  acc.checks.forEach((raw, i) => {
    const path = `acceptance.checks[${i}]`;
    if (!isObj(raw) || typeof raw.check !== "string" || !CHECK_TYPES.includes(raw.check)) {
      return c.add(path, `controllo sconosciuto (ci sono: ${CHECK_TYPES.join(", ")})`);
    }
    const many =
      raw.layers !== undefined ? raw.layers : raw.layer !== undefined ? [raw.layer] : undefined;
    if (raw.check !== "frames") {
      if (!Array.isArray(many) || many.length === 0)
        c.add(path, "il controllo deve dire su quali livelli");
      else many.forEach((id) => layerRef(path, id));
    }
    const ats = Array.isArray(raw.at) ? raw.at : raw.at === undefined ? [] : [raw.at];
    ats.forEach((t, j) =>
      checkTimeField(c, `${path}.at${Array.isArray(raw.at) ? `[${j}]` : ""}`, t, known),
    );
    switch (raw.check) {
      case "insideSafeArea":
        if (raw.area !== "title" && raw.area !== "action")
          c.add(`${path}.area`, 'l\'area è "title" o "action"');
        if (ats.length !== 1) c.add(`${path}.at`, "serve un tempo («at»)");
        break;
      case "inside":
        layerRef(`${path}.container`, raw.container);
        if (ats.length !== 1) c.add(`${path}.at`, "serve un tempo («at»)");
        if (raw.margin !== undefined) checkValue(c, `${path}.margin`, raw.margin, known);
        break;
      case "fontIs":
        if (raw.font === undefined) c.add(`${path}.font`, "manca il font atteso");
        else checkValue(c, `${path}.font`, raw.font, known);
        break;
      case "value":
        if (typeof raw.property !== "string" || !propertyInfo(raw.property))
          c.add(`${path}.property`, `proprietà sconosciuta (ci sono: ${PROPERTY_ALIAS_HELP})`);
        if (ats.length === 0) c.add(`${path}.at`, "serve almeno un tempo («at»)");
        if (raw.equals === undefined) c.add(`${path}.equals`, "manca il valore atteso («equals»)");
        break;
      case "frames":
        if (ats.length === 0) c.add(`${path}.at`, "serve almeno un tempo («at»)");
        break;
      default:
        break;
    }
  });
}

/** Validate a parsed recipe file. */
export function validateRecipe(raw: unknown): RecipeValidation {
  const c = new Collector();
  if (!isObj(raw))
    return { ok: false, issues: [{ path: "", message: "una ricetta è un oggetto JSON" }] };

  if (typeof raw.format !== "string" || !raw.format.startsWith(RECIPE_FORMAT_PREFIX)) {
    c.add("format", `manca la versione del formato (per esempio "${RECIPE_FORMAT_PREFIX}0.1")`);
  }
  if (raw.kind !== "recipe") c.add("kind", 'deve essere "recipe"');
  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
    c.add(
      "id",
      'l\'id è fatto di lettere minuscole, numeri e trattini (es. "r-lower-third-barra")',
    );
  }
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1)
    c.add("version", "la versione è un numero intero da 1 in su");
  if (typeof raw.status !== "string" || !STATUS.includes(raw.status))
    c.add("status", `lo stato è uno tra ${STATUS.join(", ")}`);
  if (typeof raw.title !== "string" || raw.title.trim() === "") c.add("title", "manca il titolo");
  if (typeof raw.summary !== "string" || raw.summary.trim() === "")
    c.add("summary", "manca il riassunto di una riga");
  else if (raw.summary.length > 140)
    c.add("summary", `il riassunto è di ${raw.summary.length} caratteri: al massimo 140`);

  checkHeader(c, raw.header, raw.status);
  checkRequires(c, raw.requires);
  const paramNames = checkParams(c, raw.params);

  const known = new Set<string>([...paramNames, ...CALC_BUILTINS]);
  if (isObj(raw.params)) {
    // Calcs inside params see only builtins and other params' literals: in
    // practice defaults are literals or $refs, so a calc there is rare.
    for (const [name, p] of Object.entries(raw.params))
      if (isObj(p)) checkValue(c, `params.${name}`, p.default, known);
  }
  if (raw.let !== undefined) {
    if (!isObj(raw.let)) c.add("let", "«let» è un oggetto nome → valore");
    else
      for (const [name, v] of Object.entries(raw.let)) {
        if (known.has(name))
          c.add(`let.${name}`, `«${name}» è già il nome di un parametro o di un valore di sistema`);
        checkValue(c, `let.${name}`, v, known);
        known.add(name); // later let values may read this one, earlier ones may not
      }
  }

  if (!isObj(raw.comp)) c.add("comp", "manca la composizione («comp»)");
  else {
    if (raw.comp.create !== true)
      c.add(
        "comp.create",
        'nella versione 0.1 una ricetta crea sempre una composizione nuova: "create": true',
      );
    if (typeof raw.comp.name !== "string" || raw.comp.name.trim() === "")
      c.add("comp.name", "manca il nome della composizione");
    if (raw.comp.format === undefined) c.add("comp.format", "manca il formato della composizione");
    else checkValue(c, "comp.format", raw.comp.format, known);
    if (raw.comp.duration === undefined)
      c.add("comp.duration", "manca la durata della composizione");
    else checkTimeField(c, "comp.duration", raw.comp.duration, known);
    if (
      raw.comp.bgColor !== undefined &&
      !isHexColor(raw.comp.bgColor) &&
      !isCalc(raw.comp.bgColor)
    ) {
      c.add("comp.bgColor", 'il colore di fondo è "#RRGGBB"');
    }
  }

  const layerIds = checkLayers(c, raw.layers, known);
  checkTracks(c, raw.animation, layerIds, known);
  if (raw.markers !== undefined) {
    if (!Array.isArray(raw.markers)) c.add("markers", "«markers» è un elenco");
    else
      raw.markers.forEach((m, i) => {
        if (!isObj(m) || typeof m.comment !== "string")
          return c.add(`markers[${i}]`, "ogni marcatore ha «at» e «comment»");
        checkTimeField(c, `markers[${i}].at`, m.at, known);
      });
  }
  checkAcceptance(c, raw.acceptance, layerIds, known);

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, recipe: raw as unknown as Recipe, issues: [] };
}

/** Names known to calcs, exported for the help text of recipe.plan. */
export const CALC_HELP = `funzioni: ${CALC_FUNCTIONS.join(", ")}; valori di sistema: ${CALC_BUILTINS.join(", ")}`;
