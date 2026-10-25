// Parlez! M5.3 (nome provvisorio): comp.audit_motion — "does anything
// actually move?". One read-only call samples position, scale, opacity and
// rotation of every layer at N times, descending into precomps on their own
// time (layer.sourceTime), and the Node side turns the samples into a plain
// report: travel, scale change, fades, rotation, layers that never move.
// Idea from a public description of a sampled motion check; the
// code is ours, on kumo's helpers (AE.readValue, AE.hasKeys).

import { jsxFail, jsxVal, registerOp } from "../registry.js";

type Failure = { ok: false; error: string; errorCode?: string; hint?: string };

function fail(error: string, errorCode = "INVALID_ARGS"): Failure {
  return { ok: false, error, errorCode };
}

export const MOTION_DEFAULTS = {
  /** Samples over the comp: 10 catches a move, a fade or a pop in a typical 5–10 s piece. */
  campioni: 10,
  /** Precomp levels to descend into. */
  profondita: 2,
} as const;

/** Rows the JSX returns at most: keeps a huge comp from flooding the answer. */
const MAX_LAYERS = 300;

/**
 * Below these, a change between samples is noise (sub-pixel expression
 * wiggle, float rounding), not animation.
 */
const STILL = { position: 0.5, scale: 0.1, opacity: 0.5, rotation: 0.1 } as const;

/** Opacity at or below this counts as invisible, for fades. */
const FADE_FLOOR = 1;

/** The generated ExtendScript (exported for the tests). */
export function buildMotionJsx(comp: unknown, samples: number, depth: number): string {
  return `
        var _comp = AE.findCompByNameOrId(${jsxVal(comp)});
        if (!_comp) return { ok: false, error: "no comp matching " + ${jsxVal(String(comp))} };
        var _n = ${jsxVal(samples)};
        var _maxDepth = ${jsxVal(depth)};
        var _maxLayers = ${jsxVal(MAX_LAYERS)};
        var _end = _comp.duration - _comp.frameDuration;
        if (_end < 0) _end = 0;
        var _times = [];
        for (var _i = 0; _i < _n; _i++) _times.push((_end * _i) / (_n - 1));
        var _rows = [];
        var _truncated = false;
        function _amProp(layer, match) {
            var tr = null;
            try { tr = layer.property("ADBE Transform Group"); } catch (eT) { return null; }
            if (!tr) return null;
            try { return tr.property(match); } catch (eP) { return null; }
        }
        function _amRead(p, t) {
            if (!p) return null;
            try { return AE.valueToJson(AE.readValue(p, t)); } catch (eR) { return null; }
        }
        function _amKeyed(p) {
            if (!p) return false;
            try { if (AE.hasKeys(p)) return true; } catch (eK) { }
            try { if (p.canSetExpression && p.expressionEnabled && p.expression !== "") return true; } catch (eE) { }
            return false;
        }
        function _amWalk(c, times, parentActive, path, depth, stack) {
            for (var li = 1; li <= c.numLayers; li++) {
                if (_rows.length >= _maxLayers) { _truncated = true; return; }
                var l = c.layer(li);
                var src = null;
                try { src = l.source; } catch (eS) { src = null; }
                var isComp = src !== null && src instanceof CompItem;
                var pPos = _amProp(l, "ADBE Position");
                var pScale = _amProp(l, "ADBE Scale");
                var pOpac = _amProp(l, "ADBE Opacity");
                var pRot = _amProp(l, "ADBE Rotate Z");
                var row = {
                    name: l.name, index: l.index, path: path + " > " + l.name, depth: depth, precomp: isComp,
                    active: [], position: [], scale: [], opacity: [], rotation: [],
                    keyed: { position: _amKeyed(pPos), scale: _amKeyed(pScale), opacity: _amKeyed(pOpac), rotation: _amKeyed(pRot) }
                };
                var childTimes = [];
                for (var ti = 0; ti < times.length; ti++) {
                    var t = times[ti];
                    var on = l.enabled && t >= l.inPoint && t < l.outPoint;
                    if (parentActive !== null && !parentActive[ti]) on = false;
                    row.active.push(on);
                    row.position.push(_amRead(pPos, t));
                    row.scale.push(_amRead(pScale, t));
                    row.opacity.push(_amRead(pOpac, t));
                    row.rotation.push(_amRead(pRot, t));
                    if (isComp) {
                        var st = t - l.startTime;
                        try { st = l.sourceTime(t); } catch (eSt) { }
                        childTimes.push(st);
                    }
                }
                _rows.push(row);
                if (isComp && depth < _maxDepth && !stack.hasOwnProperty("c" + src.id)) {
                    stack["c" + src.id] = true;
                    _amWalk(src, childTimes, row.active, row.path, depth + 1, stack);
                    delete stack["c" + src.id];
                }
            }
        }
        _amWalk(_comp, _times, null, _comp.name, 0, {});
        return {
            ok: true, comp: _comp.name, duration: _comp.duration, frameRate: _comp.frameRate,
            times: _times, truncated: _truncated, layers: _rows
        };
    `;
}

interface RawLayer {
  name: string;
  index: number;
  path: string;
  depth: number;
  precomp: boolean;
  active: boolean[];
  position: Array<number[] | null>;
  scale: Array<number[] | null>;
  opacity: Array<number | null>;
  rotation: Array<number | null>;
  keyed: Partial<Record<"position" | "scale" | "opacity" | "rotation", boolean>>;
}

interface RawMotion {
  ok: true;
  comp: string;
  duration: number;
  frameRate: number;
  times: number[];
  truncated: boolean;
  layers: RawLayer[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function nums(xs: Array<number | null>, idx: number[]): number[] {
  return idx.map((i) => xs[i]).filter((v): v is number => typeof v === "number");
}

function vecs(xs: Array<number[] | null>, idx: number[]): number[][] {
  return idx.map((i) => xs[i]).filter((v): v is number[] => Array.isArray(v));
}

function range(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

const PROP_LABEL = {
  position: "posizione",
  scale: "scala",
  opacity: "opacità",
  rotation: "rotazione",
};

/** One layer's samples → a plain report row. */
function analyzeLayer(l: RawLayer) {
  const idx = l.active.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  const pos = vecs(l.position, idx);
  let travel = 0;
  for (let i = 1; i < pos.length; i++) {
    travel += Math.hypot(...pos[i].map((v, c) => v - (pos[i - 1][c] ?? 0)));
  }
  const net =
    pos.length > 1 ? Math.hypot(...pos[pos.length - 1].map((v, c) => v - (pos[0][c] ?? 0))) : 0;
  const scales = vecs(l.scale, idx);
  const scaleAxes = scales.length > 0 ? scales[0].length : 0;
  let scaleChange = 0;
  for (let c = 0; c < scaleAxes; c++)
    scaleChange = Math.max(scaleChange, range(scales.map((s) => s[c] ?? 0)));
  const allScale = scales.flat();
  const opac = nums(l.opacity, idx);
  const rot = nums(l.rotation, idx);

  const fades: string[] = [];
  if (opac.length > 1) {
    const top = Math.max(...opac);
    if (opac[0] <= FADE_FLOOR && top >= 10) fades.push("entrata");
    if (opac[opac.length - 1] <= FADE_FLOOR && top >= 10) fades.push("uscita");
  }
  const moved =
    travel > STILL.position ||
    scaleChange > STILL.scale ||
    range(opac) > STILL.opacity ||
    range(rot) > STILL.rotation;
  const keyed = (Object.keys(PROP_LABEL) as Array<keyof typeof PROP_LABEL>).filter(
    (p) => l.keyed[p] === true,
  );
  let stato: string;
  if (idx.length === 0) stato = "mai visibile";
  else if (moved) stato = "animato";
  else if (keyed.length > 0) stato = "animato tra i campioni";
  else stato = "fermo";

  return {
    percorso: l.path,
    nome: l.name,
    indice: l.index,
    profondita: l.depth,
    precomp: l.precomp,
    stato,
    campioniVisibili: idx.length,
    spostamento: { percorso: r1(travel), netto: r1(net) },
    scala: {
      min: allScale.length > 0 ? r1(Math.min(...allScale)) : null,
      max: allScale.length > 0 ? r1(Math.max(...allScale)) : null,
      variazione: r1(scaleChange),
    },
    opacita: {
      min: opac.length > 0 ? r1(Math.min(...opac)) : null,
      max: opac.length > 0 ? r1(Math.max(...opac)) : null,
    },
    dissolvenze: fades,
    rotazione: { variazione: r1(range(rot)) },
    animatiConChiavi: keyed.map((p) => PROP_LABEL[p]),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The whole report (exported for the tests). */
export function analyzeMotion(raw: RawMotion) {
  const rows = raw.layers.map(analyzeLayer);
  const count = (s: string) => rows.filter((r) => r.stato === s).length;
  const animated = count("animato");
  const still = count("fermo");
  const between = count("animato tra i campioni");
  const never = count("mai visibile");
  const nested = rows.filter((r) => r.profondita > 0).length;
  let summary =
    `${plural(rows.length, "livello", "livelli")}, ${plural(animated, "animato", "animati")}, ` +
    plural(still, "fermo", "fermi");
  if (between > 0) summary += `, ${plural(between, "animato", "animati")} tra i campioni`;
  if (never > 0) summary += `, ${plural(never, "mai visibile", "mai visibili")}`;
  if (nested > 0) summary += `; ${nested} dentro le precomposizioni`;
  summary += ".";
  return {
    ok: true,
    comp: raw.comp,
    durata: raw.duration,
    campioni: raw.times.map((t) => Math.round(t * 1000) / 1000),
    riepilogo: summary,
    conteggi: {
      livelli: rows.length,
      animati: animated,
      fermi: still,
      traCampioni: between,
      maiVisibili: never,
    },
    fermi: rows.filter((r) => r.stato === "fermo").map((r) => r.percorso),
    livelli: rows,
    ...(raw.truncated ? { troncato: `letti solo i primi ${MAX_LAYERS} livelli` } : {}),
    nota:
      "campioni a intervalli regolari: un movimento più breve dell'intervallo può sfuggire (stato «animato tra i campioni» se ci sono keyframe o espressioni). " +
      "Dentro le precomposizioni i valori sono relativi alla precomposizione.",
  };
}

registerOp({
  name: "comp.audit_motion",
  category: "comp",
  readOnly: true,
  description:
    "Controllo del movimento (nome provvisorio): sample position, scale, opacity and rotation of every layer " +
    "at N evenly spaced times (default 10, first to last frame), descending into precomps on their own time " +
    "(`profondita`, default 2). Per layer: travel and net displacement in px, scale change, opacity range " +
    "and fades in/out (from/to 0), rotation change, and a state — animato, fermo, 'animato tra i campioni' " +
    "(keyframes or expressions the samples did not catch) or 'mai visibile'. Summary in plain Italian " +
    "('5 livelli, 3 animati, 2 fermi.'). Read-only.",
  params: [
    { name: "comp", type: "any", description: "Comp name or numeric id", required: true },
    {
      name: "campioni",
      type: "number",
      description: "Sample times, 2–60 (default 10)",
      required: false,
      default: MOTION_DEFAULTS.campioni,
    },
    {
      name: "profondita",
      type: "number",
      description: "Precomp levels to descend into, 0–5 (default 2)",
      required: false,
      default: MOTION_DEFAULTS.profondita,
    },
  ],
  toJsx: () =>
    jsxFail(
      "comp.audit_motion analyses its samples on the Node side — call it as its own ae_do, not inside batch.run",
    ),
  async run(args, transport) {
    const n = args.campioni ?? MOTION_DEFAULTS.campioni;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 2 || n > 60) {
      return fail("campioni deve essere un numero intero da 2 a 60");
    }
    const depth = args.profondita ?? MOTION_DEFAULTS.profondita;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 5) {
      return fail("profondita deve essere un numero intero da 0 a 5");
    }
    if (typeof args.comp !== "string" && typeof args.comp !== "number") {
      return fail("comp deve essere il nome o l'id di una composizione");
    }
    const res = await transport.execute({
      label: "comp.audit_motion",
      code: buildMotionJsx(args.comp, n, depth),
      // A pure read: no undo step to leave behind.
      undoGroup: false,
      timeoutMs: 120_000,
    });
    if (!res.ok) {
      return fail(
        `After Effects non ha risposto (${res.error ?? "errore sconosciuto"})`,
        res.errorCode ?? "TRANSPORT",
      );
    }
    const r = res.result as { ok?: unknown; error?: unknown } | null;
    if (r === null || typeof r !== "object")
      return fail("risposta inattesa da After Effects", "OPERATION_FAILED");
    if (r.ok !== true) {
      return fail(
        typeof r.error === "string" ? r.error : "lettura non riuscita",
        "OPERATION_FAILED",
      );
    }
    return analyzeMotion(r as RawMotion);
  },
});
