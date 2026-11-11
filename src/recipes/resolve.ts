// Resolver: from a validated recipe + the caller's args + an archive to plain
// numbers (recipe format §4–§8). Nothing here talks to After Effects: the
// result is a pure function of its inputs, which is what lets the tests check
// a whole lower third offline.
//
// Units inside: times are whole FRAMES, lengths are PIXELS, colors [r,g,b] 0–1.

import type { Archive, UsedCard } from "./archive.js";
import { archiveFormats, resolveRef } from "./archive.js";
import { CalcError, evaluate, isCalc, parseCalc, truthy } from "./calc.js";
import type { Curve } from "./curves.js";
import { CURVES } from "./curves.js";
import type { PropInfo } from "./props.js";
import { TRANSFORM_KEYS, propertyInfo } from "./props.js";
import type {
  FitTextTemplate,
  FontValue,
  Recipe,
  RecipeCheck,
  RecipeIssue,
  RecipeParam,
  RecipeTrack,
  RefDefault,
  Value,
} from "./types.js";
import { RecipeError } from "./types.js";
import {
  framesToSeconds,
  hexToRgb01,
  isHexColor,
  isLengthLiteral,
  isTimeLiteral,
  lengthToPx,
  round,
  timeToFrames,
} from "./units.js";

/** capHeight used when neither the archive nor the caller gives one (archive format §9.1). */
export const DEFAULT_CAP_HEIGHT = 0.72;

export interface SafeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface FormatDef {
  width: number;
  height: number;
  fps: number;
  safe: { action: Record<string, number>; title: Record<string, number> };
}

/**
 * Fallback formats, used only when the archive's style card has no entry for
 * the format asked (recipe format §6). The 9:16 and 4:5 margins leave
 * room for social-app overlays: a starting point to tune, not a standard.
 */
export const FALLBACK_FORMATS: Readonly<Record<string, FormatDef>> = {
  "16:9": {
    width: 1920,
    height: 1080,
    fps: 25,
    safe: { action: { all: 0.035 }, title: { all: 0.05 } },
  },
  "9:16": {
    width: 1080,
    height: 1920,
    fps: 25,
    safe: { action: { all: 0.035 }, title: { left: 0.05, right: 0.05, top: 0.12, bottom: 0.2 } },
  },
  "1:1": {
    width: 1080,
    height: 1080,
    fps: 25,
    safe: { action: { all: 0.035 }, title: { all: 0.05 } },
  },
  "4:5": {
    width: 1080,
    height: 1350,
    fps: 25,
    safe: { action: { all: 0.035 }, title: { left: 0.05, right: 0.05, top: 0.08, bottom: 0.12 } },
  },
};

export interface ResolvedShape {
  group: string;
  rect?: { size: number[]; position: number[]; roundness: number };
  ellipse?: { size: number[] };
  fill?: { color: number[]; opacity?: number };
  stroke?: { color: number[]; width?: number };
}

export interface ResolvedLayer {
  id: string;
  type: "null" | "shape" | "text";
  name: string;
  parentName: string | null;
  text: string | null;
  style: Record<string, unknown>;
  shapes: ResolvedShape[];
  controls: Array<{ name: string; value: number }>;
  transform: Record<string, unknown>;
  expressions: Array<{ alias: string; info: PropInfo; expression: string }>;
}

export interface ResolvedKey {
  frame: number;
  value: number | number[];
  /** Curve of the segment that ENDS at this key; null on the first key. */
  curve: string | null;
}

export interface ResolvedTrack {
  layerName: string;
  /** Position of the layer in creation order: generated ops follow it. */
  layerOrder: number;
  trackOrder: number;
  alias: string;
  info: PropInfo;
  spatialLinear: boolean;
  keys: ResolvedKey[];
}

export type ResolvedCheck =
  | {
      check: "insideSafeArea";
      layers: string[];
      area: "title" | "action";
      frame: number;
      rect: SafeRect;
    }
  | { check: "inside"; layers: string[]; container: string; margin: number; frame: number }
  | { check: "fontIs"; layers: string[]; font: FontValue }
  | {
      check: "value";
      layers: string[];
      alias: string;
      info: PropInfo;
      frames: number[];
      equals: unknown;
    }
  | { check: "frames"; frames: number[] };

export interface DefaultUsed {
  param: string;
  ref: string;
  reason: string;
  value: Value;
}

export interface Resolved {
  recipe: { id: string; version: number; title: string };
  comp: {
    name: string;
    width: number;
    height: number;
    fps: number;
    durationFrames: number;
    duration: number;
    end: number;
    bgColor: number[] | null;
  };
  format: string;
  unit: number;
  safe: { title: SafeRect; action: SafeRect };
  params: Record<string, unknown>;
  layers: ResolvedLayer[];
  tracks: ResolvedTrack[];
  markers: Array<{ frame: number; comment: string }>;
  checks: ResolvedCheck[];
  look: string[];
  usedCards: UsedCard[];
  defaultsUsed: DefaultUsed[];
  warnings: string[];
  confidentiality: string;
}

export interface ResolveOptions {
  args?: Record<string, unknown>;
  archive?: Archive | null;
  /** Comp names already in the project (recipe.run reads them first). */
  existingNames?: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isRefDefault(v: unknown): v is RefDefault {
  return isObj(v) && typeof v.$ref === "string";
}

const CONFIDENTIALITY_ORDER = ["libero", "interno-app", "cliente"];

function stricter(a: string, b: string): string {
  return CONFIDENTIALITY_ORDER.indexOf(b) > CONFIDENTIALITY_ORDER.indexOf(a) ? b : a;
}

function safeRect(spec: Record<string, number>, w: number, h: number): SafeRect {
  const side = (k: string) => spec[k] ?? spec.all ?? 0;
  const left = round(w * side("left"), 2);
  const right = round(w * (1 - side("right")), 2);
  const top = round(h * side("top"), 2);
  const bottom = round(h * (1 - side("bottom")), 2);
  return {
    left,
    right,
    top,
    bottom,
    width: round(right - left, 2),
    height: round(bottom - top, 2),
  };
}

/** Round every number inside a value (vectors included) to `decimals`. */
function roundDeep(v: unknown, decimals: number): unknown {
  if (typeof v === "number") return round(v, decimals);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, decimals));
  return v;
}

function fillPlaceholders(text: string, params: Obj): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const v = params[name];
    return typeof v === "string" || typeof v === "number" ? String(v) : whole;
  });
}

function toFont(v: unknown, path: string, warnings: string[]): FontValue {
  if (typeof v === "string") {
    warnings.push(
      `${path}: del font «${v}» non si conosce l'altezza delle maiuscole, uso ${DEFAULT_CAP_HEIGHT}`,
    );
    return { postscript: v, capHeight: DEFAULT_CAP_HEIGHT };
  }
  if (isObj(v) && typeof v.postscript === "string") {
    const capHeight = typeof v.capHeight === "number" ? v.capHeight : DEFAULT_CAP_HEIGHT;
    if (typeof v.capHeight !== "number") {
      warnings.push(
        `${path}: il font «${v.postscript}» non dice l'altezza delle maiuscole, uso ${DEFAULT_CAP_HEIGHT}`,
      );
    }
    return {
      postscript: v.postscript,
      ...(typeof v.family === "string" ? { family: v.family } : {}),
      ...(typeof v.style === "string" ? { style: v.style } : {}),
      capHeight,
    };
  }
  throw new RecipeError([{ path, message: "non è un font (serve il nome PostScript)" }]);
}

function toColor(v: unknown, path: string): number[] {
  if (isHexColor(v)) return hexToRgb01(v);
  if (
    Array.isArray(v) &&
    (v.length === 3 || v.length === 4) &&
    v.every((x) => typeof x === "number" && x >= 0 && x <= 1)
  ) {
    return v.slice(0, 3).map((x) => round(x, 4));
  }
  throw new RecipeError([{ path, message: `${JSON.stringify(v)} non è un colore ("#RRGGBB")` }]);
}

function vec(v: unknown, path: string): number[] {
  if (Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)))
    return v as number[];
  throw new RecipeError([
    {
      path,
      message: `serve un vettore di numeri, per esempio [0, 0]; invece è ${JSON.stringify(v)}`,
    },
  ]);
}

function numberOf(v: unknown, path: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new RecipeError([{ path, message: `serve un numero; invece è ${JSON.stringify(v)}` }]);
}

export function resolveRecipe(recipe: Recipe, opts: ResolveOptions = {}): Resolved {
  const args = opts.args ?? {};
  const archive = opts.archive ?? null;
  const warnings: string[] = [];
  const used = new Map<string, UsedCard>();
  const defaultsUsed: DefaultUsed[] = [];
  const issues: RecipeIssue[] = [];

  const markUsed = (card: { id: string; kind: string; version: number }, field: string) => {
    const u = used.get(card.id) ?? {
      id: card.id,
      kind: card.kind,
      version: card.version,
      fields: [],
    };
    if (!u.fields.includes(field)) u.fields.push(field);
    used.set(card.id, u);
  };

  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(recipe.params, key)) {
      issues.push({
        path: `args.${key}`,
        message: `la ricetta non ha il parametro «${key}» (ha: ${Object.keys(recipe.params).join(", ")})`,
      });
    }
  }

  // §4.1 — where each value comes from: args, then the archive, then the literal.
  const rawParams: Obj = {};
  for (const [name, p] of Object.entries(recipe.params)) {
    if (Object.hasOwn(args, name) && args[name] !== undefined) {
      rawParams[name] = args[name];
      continue;
    }
    const d = p.default;
    if (isRefDefault(d)) {
      const r = resolveRef(d.$ref, archive);
      if (r.ok) {
        rawParams[name] = r.value;
        markUsed(r.card, r.field);
      } else {
        rawParams[name] = d.default;
        if (d.default !== undefined) {
          defaultsUsed.push({ param: name, ref: d.$ref, reason: r.reason, value: d.default });
          warnings.push(`usato ${JSON.stringify(d.default)} al posto di ${d.$ref}: ${r.reason}`);
        }
      }
    } else {
      rawParams[name] = d;
    }
    if (rawParams[name] === undefined && p.optional !== true) {
      issues.push({ path: `params.${name}`, message: "manca il valore e non c'è un predefinito" });
    }
  }
  if (issues.length > 0) throw new RecipeError(issues);

  // The format decides fps and the size of 1u, which every time and length
  // below depends on — so it is settled before anything is converted.
  const formatName = (() => {
    const f = recipe.comp.format;
    if (isCalc(f)) {
      const v = evaluate(parseCalc(f), {
        fps: 25,
        unit: 1,
        lookup: (n) => {
          if (Object.hasOwn(rawParams, n)) return rawParams[n];
          throw new CalcError(`«${n}» non si può usare per scegliere il formato`);
        },
      });
      return String(v);
    }
    return String(f);
  })();
  const fromArchive = archiveFormats(archive)?.[formatName];
  const formatDef = (fromArchive as FormatDef | undefined) ?? FALLBACK_FORMATS[formatName];
  if (!formatDef || !Number.isFinite(formatDef.width) || !Number.isFinite(formatDef.fps)) {
    const known = [
      ...new Set([...Object.keys(archiveFormats(archive) ?? {}), ...Object.keys(FALLBACK_FORMATS)]),
    ];
    throw new RecipeError([
      {
        path: "comp.format",
        message: `formato «${formatName}» sconosciuto (ci sono: ${known.join(", ")})`,
      },
    ]);
  }
  if (fromArchive) {
    const style = archive?.styleCard();
    if (style) markUsed(style, `format/${formatName}`);
  }
  const { width, height, fps } = formatDef;
  const unit = Math.min(width, height) / 1080;
  const safe = {
    title: safeRect(formatDef.safe?.title ?? { all: 0.05 }, width, height),
    action: safeRect(formatDef.safe?.action ?? { all: 0.035 }, width, height),
  };

  // Typed conversion of every param.
  const params: Obj = {};
  for (const [name, p] of Object.entries(recipe.params) as Array<[string, RecipeParam]>) {
    const raw = rawParams[name];
    const path = `params.${name}`;
    try {
      params[name] = convertParam(p, raw, path, fps, unit, warnings);
    } catch (err) {
      if (err instanceof RecipeError) issues.push(...err.issues);
      else issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (issues.length > 0) throw new RecipeError(issues);

  const env: Obj = { ...params };
  const builtins: Obj = { comp: { width, height, fps }, fps, safe, u: unit };

  const ctx = {
    fps,
    unit,
    lookup(n: string): unknown {
      if (Object.hasOwn(env, n)) return env[n];
      if (Object.hasOwn(builtins, n)) return builtins[n];
      throw new CalcError(`il nome «${n}» non esiste`);
    },
  };

  const ev = (v: unknown, path: string): unknown => {
    try {
      if (isCalc(v)) return evaluate(parseCalc(v), ctx);
      if (Array.isArray(v)) return v.map((x, i) => ev(x, `${path}[${i}]`));
      if (isTimeLiteral(v)) return timeToFrames(v, fps);
      if (isLengthLiteral(v)) return lengthToPx(v, unit);
      if (isHexColor(v)) return hexToRgb01(v);
      return v;
    } catch (err) {
      if (err instanceof RecipeError) throw err;
      throw new RecipeError([{ path, message: err instanceof Error ? err.message : String(err) }]);
    }
  };

  // Duration first: `end` must exist before let values that use it.
  const durationFrames = numberOf(ev(recipe.comp.duration, "comp.duration"), "comp.duration");
  if (durationFrames < 2)
    throw new RecipeError([{ path: "comp.duration", message: "la durata è troppo corta" }]);
  const end = durationFrames - 1;
  builtins.end = end;

  for (const [name, v] of Object.entries(recipe.let ?? {})) env[name] = ev(v, `let.${name}`);

  // §5 — the comp, with a name that does not collide (kumo finds comps by
  // name and takes the FIRST match, jsx/helpers.jsx AE.findCompByNameOrId).
  const baseName = fillPlaceholders(recipe.comp.name, params);
  let compName = baseName;
  const existing = new Set(opts.existingNames ?? []);
  for (let n = 2; existing.has(compName); n++) compName = `${baseName} ${n}`;
  if (compName !== baseName)
    warnings.push(`una composizione «${baseName}» c'è già: la nuova si chiama «${compName}»`);

  const bgColor =
    recipe.comp.bgColor === undefined
      ? null
      : toColor(ev(recipe.comp.bgColor, "comp.bgColor"), "comp.bgColor");

  // §7 — layers, skipping the ones whose `when` is false.
  const layers: ResolvedLayer[] = [];
  const byId = new Map<string, ResolvedLayer>();
  recipe.layers.forEach((l, i) => {
    const path = `layers[${i}]`;
    if (l.when !== undefined && !truthy(ev(l.when, `${path}.when`))) return;
    const parent = l.parent === undefined ? null : byId.get(l.parent);
    if (l.parent !== undefined && !parent) {
      throw new RecipeError([
        {
          path: `${path}.parent`,
          message: `il genitore «${l.parent}» non è stato creato (il suo «when» è falso)`,
        },
      ]);
    }
    const style: Obj = {};
    for (const [k, v] of Object.entries(l.style ?? {})) {
      const val = ev(v, `${path}.style.${k}`);
      if (k === "font") style.font = toFont(val, `${path}.style.font`, warnings).postscript;
      else if (k === "fillColor" || k === "strokeColor")
        style[k] = toColor(val, `${path}.style.${k}`);
      else style[k] = roundDeep(val, 2);
    }
    const shapes: ResolvedShape[] = (l.shapes ?? []).map((s, j) => {
      const sp = `${path}.shapes[${j}]`;
      const out: ResolvedShape = { group: s.group };
      if (s.rect) {
        out.rect = {
          size: roundDeep(
            vec(ev(s.rect.size, `${sp}.rect.size`), `${sp}.rect.size`),
            2,
          ) as number[],
          position:
            s.rect.position === undefined
              ? [0, 0]
              : (roundDeep(
                  vec(ev(s.rect.position, `${sp}.rect.position`), `${sp}.rect.position`),
                  2,
                ) as number[]),
          roundness:
            s.rect.roundness === undefined
              ? 0
              : round(
                  numberOf(ev(s.rect.roundness, `${sp}.rect.roundness`), `${sp}.rect.roundness`),
                  2,
                ),
        };
      }
      if (s.ellipse)
        out.ellipse = {
          size: roundDeep(
            vec(ev(s.ellipse.size, `${sp}.ellipse.size`), `${sp}.ellipse.size`),
            2,
          ) as number[],
        };
      if (s.fill) {
        out.fill = {
          color: [...toColor(ev(s.fill.color, `${sp}.fill.color`), `${sp}.fill.color`), 1],
        };
        if (s.fill.opacity !== undefined)
          out.fill.opacity = numberOf(
            ev(s.fill.opacity, `${sp}.fill.opacity`),
            `${sp}.fill.opacity`,
          );
      }
      if (s.stroke) {
        out.stroke = {
          color: [...toColor(ev(s.stroke.color, `${sp}.stroke.color`), `${sp}.stroke.color`), 1],
        };
        if (s.stroke.width !== undefined)
          out.stroke.width = round(
            numberOf(ev(s.stroke.width, `${sp}.stroke.width`), `${sp}.stroke.width`),
            2,
          );
      }
      return out;
    });
    const transform: Obj = {};
    for (const k of TRANSFORM_KEYS) {
      if (l.transform && Object.hasOwn(l.transform, k))
        transform[k] = roundDeep(ev(l.transform[k], `${path}.transform.${k}`), 2);
    }
    const layer: ResolvedLayer = {
      id: l.id,
      type: l.type,
      name: fillPlaceholders(l.name, params),
      parentName: parent ? parent.name : null,
      text: l.text === undefined ? null : fillPlaceholders(l.text, params),
      style,
      shapes,
      controls: (l.controls ?? []).map((c, j) => ({
        name: c.slider,
        value:
          c.value === undefined
            ? 0
            : numberOf(ev(c.value, `${path}.controls[${j}].value`), `${path}.controls[${j}].value`),
      })),
      transform,
      expressions: [],
    };
    layers.push(layer);
    byId.set(l.id, layer);
  });

  // Expressions after all layers exist: fitText names text layers listed later.
  recipe.layers.forEach((l, i) => {
    const layer = byId.get(l.id);
    if (!layer) return;
    for (const [alias, ex] of Object.entries(l.expressions ?? {})) {
      const info = propertyInfo(alias) as PropInfo;
      const expression =
        typeof ex === "string"
          ? ex
          : fitTextExpression(ex, byId, ev, `layers[${i}].expressions.${alias}`);
      layer.expressions.push({ alias, info, expression });
    }
  });

  const layerOrder = new Map(layers.map((l, i) => [l.id, i]));
  const tracks: ResolvedTrack[] = [];
  (recipe.animation ?? []).forEach((t, ti) => {
    tracks.push(...resolveTrack(t, ti, byId, layerOrder, ev, end));
  });

  const markers = (recipe.markers ?? []).map((m, i) => {
    const frame = Math.round(numberOf(ev(m.at, `markers[${i}].at`), `markers[${i}].at`));
    if (frame < 0 || frame > end)
      throw new RecipeError([
        {
          path: `markers[${i}].at`,
          message: `il fotogramma ${frame} è fuori dalla composizione (0…${end})`,
        },
      ]);
    return { frame, comment: m.comment };
  });

  const checks: ResolvedCheck[] = [];
  recipe.acceptance.checks.forEach((c, i) => {
    const r = resolveCheck(c, `acceptance.checks[${i}]`, byId, ev, safe, warnings);
    if (r) checks.push(r);
  });

  let confidentiality: string = recipe.header.confidentiality;
  if (archive && used.size > 0)
    confidentiality = stricter(confidentiality, archive.confidentiality);

  return {
    recipe: { id: recipe.id, version: recipe.version, title: recipe.title },
    comp: {
      name: compName,
      width,
      height,
      fps,
      durationFrames,
      duration: framesToSeconds(durationFrames, fps),
      end,
      bgColor,
    },
    format: formatName,
    unit,
    safe,
    params,
    layers,
    tracks,
    markers,
    checks,
    look: [...recipe.acceptance.look],
    usedCards: [...used.values()],
    defaultsUsed,
    warnings,
    confidentiality,
  };
}

function convertParam(
  p: RecipeParam,
  raw: unknown,
  path: string,
  fps: number,
  unit: number,
  warnings: string[],
): unknown {
  if (raw === undefined) return p.type === "text" ? "" : null;
  switch (p.type) {
    case "text": {
      if (typeof raw !== "string")
        throw new RecipeError([{ path, message: "deve essere un testo" }]);
      if (p.maxChars !== undefined && raw.length > p.maxChars) {
        throw new RecipeError([{ path, message: `«${raw}» supera ${p.maxChars} caratteri` }]);
      }
      return raw;
    }
    case "color":
      return toColor(raw, path);
    case "font":
      return toFont(raw, path, warnings);
    case "length":
      if (typeof raw !== "number" && !isLengthLiteral(raw))
        throw new RecipeError([
          { path, message: `${JSON.stringify(raw)} non è una lunghezza ("24u" o "24px")` },
        ]);
      return lengthToPx(raw, unit);
    case "time": {
      if (!isTimeLiteral(raw))
        throw new RecipeError([
          { path, message: `${JSON.stringify(raw)} non è un tempo ("12f", "0.5s" o "12f@25")` },
        ]);
      const frames = timeToFrames(raw, fps);
      if (p.min !== undefined && frames < timeToFrames(p.min, fps))
        throw new RecipeError([{ path, message: `«${raw}» è meno del minimo (${p.min})` }]);
      if (p.max !== undefined && frames > timeToFrames(p.max, fps))
        throw new RecipeError([{ path, message: `«${raw}» è più del massimo (${p.max})` }]);
      return frames;
    }
    case "curve":
      if (typeof raw !== "string" || !Object.hasOwn(CURVES, raw)) {
        throw new RecipeError([
          {
            path,
            message: `curva ${JSON.stringify(raw)} sconosciuta (ci sono: ${Object.keys(CURVES).join(", ")})`,
          },
        ]);
      }
      return raw;
    case "choice":
      if (!p.options?.includes(raw as string))
        throw new RecipeError([
          {
            path,
            message: `${JSON.stringify(raw)} non è tra le scelte (${(p.options ?? []).join(", ")})`,
          },
        ]);
      return raw;
    case "format":
      return String(raw);
    default:
      return raw;
  }
}

function fitTextExpression(
  t: FitTextTemplate,
  byId: Map<string, ResolvedLayer>,
  ev: (v: unknown, path: string) => unknown,
  path: string,
): string {
  // Only the texts that were actually created: an empty optional subtitle
  // must not leave the expression pointing at a layer that is not there.
  const names = t.layers
    .map((id) => byId.get(id)?.name)
    .filter((n): n is string => typeof n === "string");
  if (names.length === 0)
    throw new RecipeError([
      { path, message: "fitText: nessuno dei testi indicati è stato creato" },
    ]);
  const padX = round(numberOf(ev(t.padX, `${path}.padX`), `${path}.padX`), 2);
  const height = round(numberOf(ev(t.height, `${path}.height`), `${path}.height`), 2);
  const rects = names
    .map((n) => `thisComp.layer(${JSON.stringify(n)}).sourceRectAtTime(time, false)`)
    .join(", ");
  return [
    `var r = [${rects}];`,
    "var w = 0;",
    "for (var i = 0; i < r.length; i++) w = Math.max(w, r[i].left + r[i].width);",
    `[w + 2 * ${padX}, ${height}]`,
  ].join("\n");
}

function curveName(v: unknown, path: string): string {
  if (typeof v !== "string" || !Object.hasOwn(CURVES, v)) {
    throw new RecipeError([
      {
        path,
        message: `curva ${JSON.stringify(v)} sconosciuta (ci sono: ${Object.keys(CURVES).join(", ")})`,
      },
    ]);
  }
  return v;
}

function addVec(a: number[], b: number[], path: string): number[] {
  if (a.length !== b.length)
    throw new RecipeError([
      { path, message: `lo spostamento ha ${b.length} valori, la posizione ${a.length}` },
    ]);
  return a.map((x, i) => x + b[i]);
}

function lerp(a: number | number[], b: number | number[], f: number): number | number[] {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * f;
  const av = a as number[];
  const bv = b as number[];
  return av.map((x, i) => x + (bv[i] - x) * f);
}

function resolveTrack(
  t: RecipeTrack,
  trackOrder: number,
  byId: Map<string, ResolvedLayer>,
  layerOrder: Map<string, number>,
  ev: (v: unknown, path: string) => unknown,
  end: number,
): ResolvedTrack[] {
  const path = `animation[${trackOrder}]`;
  const info = propertyInfo(t.property) as PropInfo;
  const targets = (t.layers ?? (t.layer !== undefined ? [t.layer] : [])).filter((id) =>
    byId.has(id),
  );
  const staggerIn =
    t.stagger?.in === undefined
      ? 0
      : numberOf(ev(t.stagger.in, `${path}.stagger.in`), `${path}.stagger.in`);
  const staggerOut =
    t.stagger?.out === undefined
      ? 0
      : numberOf(ev(t.stagger.out, `${path}.stagger.out`), `${path}.stagger.out`);

  return targets.map((id, i) => {
    const layer = byId.get(id) as ResolvedLayer;
    let rest: number[] | null = null;
    if (t.relative === true) {
      const r = layer.transform[t.property];
      if (!Array.isArray(r)) {
        throw new RecipeError([
          {
            path,
            message: `«relative»: il livello «${id}» non ha una ${t.property} di riposo in «transform»`,
          },
        ]);
      }
      rest = r as number[];
    }
    // §8.4 — layer i (from 0) shifts its entry keys by i × stagger.in and its
    // exit keys by i × stagger.out; a negative out makes the last layers leave first.
    let keys: ResolvedKey[] = t.keys.map((k, j) => {
      const kp = `${path}.keys[${j}]`;
      const shift = (k.phase === "out" ? staggerOut : staggerIn) * i;
      const frame = Math.round(numberOf(ev(k.at, `${kp}.at`), `${kp}.at`)) + shift;
      let value: number | number[];
      if (rest)
        value = addVec(rest, vec(ev(k.offset, `${kp}.offset`), `${kp}.offset`), `${kp}.offset`);
      else {
        const v = ev(k.value, `${kp}.value`);
        value = typeof v === "number" ? v : vec(v, `${kp}.value`);
      }
      return {
        frame,
        value: roundDeep(value, 4) as number | number[],
        curve:
          j === 0 || k.curve === undefined
            ? j === 0
              ? null
              : "linear"
            : curveName(ev(k.curve, `${kp}.curve`), `${kp}.curve`),
      };
    });

    keys = expandPatterns(keys, path);
    for (let j = 0; j < keys.length; j++) {
      if (keys[j].frame < 0 || keys[j].frame > end) {
        throw new RecipeError([
          {
            path,
            message: `livello «${layer.name}»: la chiave al fotogramma ${keys[j].frame} è fuori dalla composizione (0…${end})`,
          },
        ]);
      }
      if (j > 0 && keys[j].frame <= keys[j - 1].frame) {
        throw new RecipeError([
          {
            path,
            message: `livello «${layer.name}»: le chiavi non sono in ordine (fotogramma ${keys[j - 1].frame} poi ${keys[j].frame})`,
          },
        ]);
      }
    }
    return {
      layerName: layer.name,
      layerOrder: layerOrder.get(id) as number,
      trackOrder,
      alias: t.property,
      info,
      spatialLinear: t.spatial === "linear",
      keys,
    };
  });
}

/** §8.3 — a "pattern" curve (overshoot) becomes extra keys inside its segment. */
function expandPatterns(keys: ResolvedKey[], path: string): ResolvedKey[] {
  const out: ResolvedKey[] = [];
  keys.forEach((k, j) => {
    const c: Curve | undefined = k.curve ? CURVES[k.curve] : undefined;
    if (j === 0 || !c || c.kind !== "pattern") {
      out.push(k);
      return;
    }
    const prev = keys[j - 1];
    for (const step of c.steps) {
      const frame =
        step.at >= 1 ? k.frame : Math.round(prev.frame + step.at * (k.frame - prev.frame));
      if (frame <= out[out.length - 1].frame) {
        throw new RecipeError([
          {
            path,
            message: `il tratto che finisce al fotogramma ${k.frame} è troppo corto per la curva «${k.curve}»`,
          },
        ]);
      }
      const value =
        step.at >= 1
          ? k.value
          : (roundDeep(lerp(prev.value, k.value, step.value), 4) as number | number[]);
      out.push({ frame, value, curve: step.curve });
    }
  });
  return out;
}

function resolveCheck(
  c: RecipeCheck,
  path: string,
  byId: Map<string, ResolvedLayer>,
  ev: (v: unknown, path: string) => unknown,
  safe: { title: SafeRect; action: SafeRect },
  warnings: string[],
): ResolvedCheck | null {
  const ids = c.layers ?? (c.layer !== undefined ? [c.layer] : []);
  const names = ids
    .map((id) => byId.get(id)?.name)
    .filter((n): n is string => typeof n === "string");
  const frameOf = (v: unknown, p: string) => Math.round(numberOf(ev(v, p), p));
  const ats = c.at === undefined ? [] : Array.isArray(c.at) ? c.at : [c.at];
  if (c.check !== "frames" && names.length === 0) {
    warnings.push(`${path}: nessuno dei livelli del controllo è stato creato, controllo saltato`);
    return null;
  }
  switch (c.check) {
    case "insideSafeArea": {
      const area = c.area === "action" ? "action" : "title";
      return {
        check: "insideSafeArea",
        layers: names,
        area,
        frame: frameOf(ats[0], `${path}.at`),
        rect: safe[area],
      };
    }
    case "inside": {
      const container = byId.get(c.container ?? "");
      if (!container) {
        warnings.push(`${path}: il contenitore non è stato creato, controllo saltato`);
        return null;
      }
      const margin =
        c.margin === undefined ? 0 : numberOf(ev(c.margin, `${path}.margin`), `${path}.margin`);
      return {
        check: "inside",
        layers: names,
        container: container.name,
        margin: round(margin, 2),
        frame: frameOf(ats[0], `${path}.at`),
      };
    }
    case "fontIs":
      return {
        check: "fontIs",
        layers: names,
        font: toFont(ev(c.font, `${path}.font`), `${path}.font`, []),
      };
    case "value":
      return {
        check: "value",
        layers: names,
        alias: c.property as string,
        info: propertyInfo(c.property as string) as PropInfo,
        frames: ats.map((a, i) => frameOf(a, `${path}.at[${i}]`)),
        equals: roundDeep(ev(c.equals, `${path}.equals`), 4),
      };
    case "frames":
      return { check: "frames", frames: ats.map((a, i) => frameOf(a, `${path}.at[${i}]`)) };
    default:
      return null;
  }
}
