// Animation helpers missing in kumo (Parlez! M6.3): named curves,
// staggering, expression templates.

import {
  type Bezier,
  EASES,
  bezierToAe,
  easeNames,
  easeToAe,
  getEase,
  isValidBezier,
} from "../easing.js";
import { EXPRESSION_TEMPLATES, renderTemplate } from "../expression-templates.js";
import { suggestName } from "../opschema.js";
import {
  jsxCompLayerPreamble,
  jsxCompPreamble,
  jsxFail,
  jsxPropertyLookup,
  jsxVal,
  registerOp,
} from "../registry.js";

// --- Named curves ---------------------------------------------------------

registerOp({
  name: "keyframe.list_eases",
  category: "keyframe",
  readOnly: true,
  description:
    "List the named easing curves keyframe.apply_ease understands: each with its cubic-bezier, the After Effects " +
    "values it becomes (influence %, and the factor that multiplies the segment's average speed), source and licence note.",
  params: [],
  toJsx() {
    const table = EASES.map((e) => ({
      name: e.name,
      kind: e.kind,
      bezier: e.bezier,
      ae: easeToAe(e),
      source: e.source,
      license: e.license,
      ...(e.maxError !== undefined ? { maxError: e.maxError } : {}),
      ...(e.overshoot ? { overshoot: true } : {}),
    }));
    // Pure data: the table travels to AE and straight back, so the answer has
    // the same envelope (and ambient context) as every other operation.
    return `return { ok: true, count: ${jsxVal(table.length)}, eases: ${jsxVal(table)} };`;
  },
});

type SideType = "bezier" | "linear" | "hold";
interface SidePlan {
  type: SideType;
  influence: number;
  factor: number;
}

/** Resolve a curve given by name or as [x1, y1, x2, y2]; string = error. */
function resolveCurve(curve: unknown, where: string): { out: SidePlan; in: SidePlan } | string {
  if (isValidBezier(curve)) {
    const ae = bezierToAe(curve as Bezier);
    return {
      out: { type: "bezier", influence: ae.out.influence, factor: ae.out.speedFactor },
      in: { type: "bezier", influence: ae.in.influence, factor: ae.in.speedFactor },
    };
  }
  if (typeof curve !== "string") {
    return `${where}: a curve is a name from keyframe.list_eases or [x1, y1, x2, y2] with x1 and x2 in 0…1`;
  }
  const ease = getEase(curve);
  if (!ease) {
    const hint = suggestName(curve, easeNames());
    return `${where}: unknown curve '${curve}'${hint ? ` — did you mean '${hint}'?` : ""} (see keyframe.list_eases)`;
  }
  if (ease.kind === "hold") {
    return {
      out: { type: "hold", influence: 0.1, factor: 0 },
      in: { type: "linear", influence: 0.1, factor: 0 },
    };
  }
  const ae = easeToAe(ease)!;
  return {
    out: { type: ease.kind, influence: ae.out.influence, factor: ae.out.speedFactor },
    in: { type: ease.kind, influence: ae.in.influence, factor: ae.in.speedFactor },
  };
}

const KEY_FIELDS = new Set(["time", "value", "curve"]);

/**
 * Per-key plan: the IN side comes from the segment arriving at the key, the
 * OUT side from the segment leaving it. First key's IN and last key's OUT are
 * null (no segment: left as After Effects has them). Exported for tests.
 */
export function planEaseKeys(
  keys: unknown[],
  defaultCurve: unknown,
):
  | { ok: true; plan: Array<{ time: number; in: SidePlan | null; out: SidePlan | null }> }
  | { ok: false; error: string } {
  if (keys.length < 2)
    return { ok: false, error: "keys needs at least 2 keys — a curve lives between two keys" };
  const segments: Array<{ out: SidePlan; in: SidePlan } | null> = [null];
  let prev = -Infinity;
  for (const [i, k] of keys.entries()) {
    const key = k as Record<string, unknown>;
    if (
      !key ||
      typeof key !== "object" ||
      typeof key.time !== "number" ||
      !Number.isFinite(key.time) ||
      key.value === undefined
    ) {
      return { ok: false, error: `keys[${i}] must be { time: number, value, curve? }` };
    }
    for (const field of Object.keys(key)) {
      if (!KEY_FIELDS.has(field)) {
        return {
          ok: false,
          error: `keys[${i}].${field} is not accepted here (time, value, curve) — for per-key interp/speed/influence use keyframe.apply`,
        };
      }
    }
    if (key.time <= prev)
      return {
        ok: false,
        error: `keys must be in increasing time order (keys[${i}].time = ${key.time})`,
      };
    prev = key.time;
    if (i === 0) {
      if (key.curve !== undefined) {
        return {
          ok: false,
          error: "keys[0].curve has no effect: a key's curve describes the segment ARRIVING at it",
        };
      }
      continue;
    }
    const resolved = resolveCurve(
      key.curve !== undefined ? key.curve : defaultCurve,
      key.curve !== undefined ? `keys[${i}].curve` : "curve",
    );
    if (typeof resolved === "string") return { ok: false, error: resolved };
    segments.push(resolved);
  }
  const plan = keys.map((k, i) => ({
    time: (k as { time: number }).time,
    in: segments[i] ? segments[i]!.in : null,
    out: i + 1 < segments.length && segments[i + 1] ? segments[i + 1]!.out : null,
  }));
  return { ok: true, plan };
}

registerOp({
  name: "keyframe.apply_ease",
  category: "keyframe",
  description:
    "Write keys with NAMED curves (keyframe.list_eases) or custom [x1,y1,x2,y2] cubic-beziers, converted to After Effects " +
    "speed/influence from the real key values — per dimension, so a Scale whose Y stays still keeps Y still. " +
    "keys = [{ time, value, curve? }]: a key's curve shapes the segment ARRIVING at it; `curve` is the default for keys without one. " +
    "Kept apart from keyframe.apply on purpose: its interp 'easeIn' means AE's Easy Ease In (slow INTO the key), " +
    "the opposite of the CSS name 'ease-in' used here. Handles separated dimensions. replace=true clears existing keys first.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index, name, { id }, 'selected', 'all', or an array of those",
      required: true,
    },
    {
      name: "property",
      type: "array",
      description: 'Property path, e.g. ["Transform","Position"]',
      required: true,
    },
    {
      name: "keys",
      type: "array",
      description: "[{ time, value, curve? }, …] — at least 2, increasing times",
      required: true,
    },
    {
      name: "curve",
      type: "any",
      description:
        "Default curve for segments whose arrival key has no curve: a name or [x1,y1,x2,y2] (default 'easy-ease')",
      required: false,
      default: "easy-ease",
    },
    {
      name: "replace",
      type: "boolean",
      description: "Remove the property's existing keys first (default false)",
      required: false,
      default: false,
    },
    {
      name: "spatialTangents",
      type: "string",
      description:
        "auto | linear — 'linear' straightens the motion path between Position keys (default auto)",
      required: false,
      default: "auto",
    },
  ],
  toJsx(args) {
    const keys = Array.isArray(args.keys) ? (args.keys as unknown[]) : [];
    const planned = planEaseKeys(keys, args.curve ?? "easy-ease");
    if (!planned.ok) return jsxFail(planned.error);
    const spatial = args.spatialTangents ?? "auto";
    if (spatial !== "auto" && spatial !== "linear")
      return jsxFail("spatialTangents must be auto|linear");
    const specs = keys.map((k) => ({
      time: (k as { time: number }).time,
      value: (k as { value: unknown }).value,
    }));
    return `
            ${jsxCompPreamble(args)}
            var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
            if (_layers.length === 0) return { ok: false, error: "no layers matched" };
            var _propPath = ${jsxVal(args.property)};
            var _specs = ${jsxVal(specs)};
            var _plan = ${jsxVal(planned.plan)};
            var _opts = { replace: ${jsxVal(args.replace === true)}, interp: null, spatialTangents: ${jsxVal(spatial)} };
            var _LIN = KeyframeInterpolationType.LINEAR;
            var _BEZ = KeyframeInterpolationType.BEZIER;
            var _HOLD = KeyframeInterpolationType.HOLD;
            function _typeOf(name) {
                if (name === "linear") return _LIN;
                if (name === "hold") return _HOLD;
                return _BEZ;
            }
            // Average speed of the segment ka -> kb, one entry per ease slot:
            // spatial properties (one slot, array value) move along the path,
            // so their speed is distance / time and never negative.
            function _segSpeeds(tp, ka, kb, slots, warn) {
                var dt = tp.keyTime(kb) - tp.keyTime(ka);
                var a = tp.keyValue(ka);
                var b = tp.keyValue(kb);
                var out = [];
                var d;
                if (typeof a === "number" && typeof b === "number") {
                    out.push((b - a) / dt);
                } else if (a instanceof Array && b instanceof Array && slots === 1) {
                    var sum = 0;
                    for (d = 0; d < a.length; d++) sum += (b[d] - a[d]) * (b[d] - a[d]);
                    out.push(Math.sqrt(sum) / dt);
                } else if (a instanceof Array && b instanceof Array) {
                    for (d = 0; d < slots; d++) out.push((b[d] - a[d]) / dt);
                } else {
                    for (d = 0; d < slots; d++) out.push(0);
                    warn("the value is not a number or a list of numbers: speeds set to 0, only the influences shape the curve");
                }
                return out;
            }
            function _side(side, current, speeds, spatial, warn) {
                if (side === null) return current;
                var arr = [];
                for (var d = 0; d < current.length; d++) {
                    var sp = side.factor * speeds[d];
                    if (spatial && sp < 0) {
                        sp = 0;
                        warn("this curve goes past its start or end; along a motion path the speed cannot be negative, clamped to 0");
                    }
                    arr.push(new KeyframeEase(sp, side.influence));
                }
                return arr;
            }
            function _applyEases(tp, warnings) {
                var said = {};
                function warn(msg) { if (!said.hasOwnProperty(msg)) { said[msg] = true; warnings.push(msg); } }
                var idx = [];
                var i;
                for (i = 0; i < _plan.length; i++) idx.push(tp.nearestKeyIndex(_plan[i].time));
                for (i = 0; i + 1 < idx.length; i++) {
                    if (idx[i + 1] !== idx[i] + 1) warn("another key sits between keys " + (i + 1) + " and " + (i + 2) + ": the curve shapes the stretch up to that key");
                }
                var isSpatial = false;
                try { isSpatial = tp.isSpatial === true; } catch (eSp) {}
                for (i = 0; i < _plan.length; i++) {
                    var ki = idx[i];
                    var curIn = tp.keyInTemporalEase(ki);
                    var curOut = tp.keyOutTemporalEase(ki);
                    var inType = tp.keyInInterpolationType(ki);
                    var outType = tp.keyOutInterpolationType(ki);
                    var inSpeeds = i > 0 ? _segSpeeds(tp, idx[i - 1], ki, curIn.length, warn) : null;
                    var outSpeeds = i + 1 < _plan.length ? _segSpeeds(tp, ki, idx[i + 1], curOut.length, warn) : null;
                    var inArr = _side(_plan[i]["in"], curIn, inSpeeds, isSpatial, warn);
                    var outArr = _side(_plan[i].out, curOut, outSpeeds, isSpatial, warn);
                    // Ease first: setting it flips both sides to BEZIER, so the
                    // planned (or previous) types are re-asserted afterwards.
                    tp.setTemporalEaseAtKey(ki, inArr, outArr);
                    if (_plan[i]["in"] !== null) inType = _typeOf(_plan[i]["in"].type);
                    if (_plan[i].out !== null) outType = _typeOf(_plan[i].out.type);
                    tp.setInterpolationTypeAtKey(ki, inType, outType);
                }
            }
            var _out = [];
            var _failed = 0;
            for (var _li = 0; _li < _layers.length; _li++) {
                var _l = _layers[_li];
                var _node = AE.propertyAtPath(_l, _propPath);
                if (!_node || _node.propertyType !== PropertyType.PROPERTY) { _failed++; _out.push({ index: _l.index, name: _l.name, ok: false, error: "property path not found on this layer" }); continue; }
                try {
                    var _r = AE.applyKeySpecs(_node, _specs, _opts);
                    var _w = _r.warnings;
                    var _targets = AE.separationFollowers(_node);
                    if (!_targets) _targets = [_node];
                    for (var _ti = 0; _ti < _targets.length; _ti++) _applyEases(_targets[_ti], _w);
                    _out.push({ index: _l.index, name: _l.name, ok: true, numKeys: _r.numKeys, separated: _r.separated, warnings: _w });
                } catch (eK) {
                    _failed++;
                    _out.push({ index: _l.index, name: _l.name, ok: false, error: AE.errText(eK) });
                }
            }
            return { ok: _failed === 0, error: _failed === 0 ? null : (_failed + " of " + _layers.length + " layers failed"), layers: _out };
        `;
  },
});

// --- Stagger --------------------------------------------------------------

/**
 * ES3 source of the ordering rule, shared by the generated JSX and the tests
 * (which evaluate this very text). _staggerRanks(n, order, seed)[i] is the
 * step count for the i-th layer: "normal" 0,1,2…; "reverse" n-1…0; "center"
 * the middle first, then outwards in rings; "random" a seeded shuffle
 * (Park–Miller minimal standard generator: integer-exact in doubles, so
 * Node and ExtendScript agree to the last digit).
 */
export const STAGGER_RANKS_JSX = `
function _staggerRanks(n, order, seed) {
    var r = [];
    var i;
    var u;
    if (order === "reverse") {
        for (i = 0; i < n; i++) r.push(n - 1 - i);
        return r;
    }
    if (order === "center") {
        var c = (n - 1) / 2;
        var dist = [];
        var rings = [];
        for (i = 0; i < n; i++) dist.push(Math.abs(i - c));
        for (i = 0; i < n; i++) {
            var known = false;
            for (u = 0; u < rings.length; u++) {
                if (Math.abs(rings[u] - dist[i]) < 1e-9) known = true;
            }
            if (!known) rings.push(dist[i]);
        }
        rings.sort(function (a, b) { return a - b; });
        for (i = 0; i < n; i++) {
            for (u = 0; u < rings.length; u++) {
                if (Math.abs(rings[u] - dist[i]) < 1e-9) { r.push(u); break; }
            }
        }
        return r;
    }
    if (order === "random") {
        var s = Math.floor(Math.abs(seed)) % 2147483647;
        if (s === 0) s = 1;
        var perm = [];
        for (i = 0; i < n; i++) perm.push(i);
        for (i = n - 1; i > 0; i--) {
            s = (s * 16807) % 2147483647;
            var j = s % (i + 1);
            var tmp = perm[i];
            perm[i] = perm[j];
            perm[j] = tmp;
        }
        for (i = 0; i < n; i++) r.push(0);
        for (i = 0; i < n; i++) r[perm[i]] = i;
        return r;
    }
    for (i = 0; i < n; i++) r.push(i);
    return r;
}
`;

/** Longest cascade the motion-design skill accepts (skill §1, [stima]). */
export const STAGGER_WARN_SECONDS = 0.5;

const ORDERS = ["normal", "reverse", "center", "random"];

registerOp({
  name: "layer.stagger",
  category: "layer",
  description:
    "Offset layers in a cascade: the i-th layer (in the chosen order) moves by i × step. mode 'keys' shifts every " +
    "keyframe of the layer (or only `property`), mode 'start' moves the whole layer in time. order: normal | reverse | " +
    "center (middle first) | random (repeatable with `seed`). Warns when the cascade lasts more than 0.5 s.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layers",
      type: "any",
      description:
        "Layer index, name, { id }, 'selected', or an array of those — the array order is the 'normal' order",
      required: true,
    },
    {
      name: "step",
      type: "number",
      description: "Offset between neighbours (may be negative)",
      required: true,
    },
    {
      name: "unit",
      type: "string",
      description: "seconds | frames (default seconds)",
      required: false,
      default: "seconds",
    },
    {
      name: "mode",
      type: "string",
      description: "keys | start (default keys)",
      required: false,
      default: "keys",
    },
    {
      name: "order",
      type: "string",
      description: "normal | reverse | center | random (default normal)",
      required: false,
      default: "normal",
    },
    {
      name: "seed",
      type: "number",
      description: "Seed for order 'random' (default 1); same seed, same order",
      required: false,
      default: 1,
    },
    {
      name: "property",
      type: "array",
      description:
        "mode 'keys' only: shift just this property path (default: every animated property)",
      required: false,
    },
  ],
  toJsx(args) {
    const step = args.step as number;
    if (!Number.isFinite(step)) return jsxFail("step must be a finite number");
    const unit = args.unit ?? "seconds";
    if (unit !== "seconds" && unit !== "frames") return jsxFail("unit must be seconds|frames");
    const mode = args.mode ?? "keys";
    if (mode !== "keys" && mode !== "start") return jsxFail("mode must be keys|start");
    const order = args.order ?? "normal";
    if (typeof order !== "string" || !ORDERS.includes(order))
      return jsxFail(`order must be ${ORDERS.join("|")}`);
    const seed = args.seed ?? 1;
    if (typeof seed !== "number" || !Number.isFinite(seed))
      return jsxFail("seed must be a finite number");
    if (args.property !== undefined && mode !== "keys")
      return jsxFail("property only applies to mode 'keys'");
    return `
            ${jsxCompPreamble(args)}
            ${STAGGER_RANKS_JSX}
            var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layers)});
            if (_layers.length === 0) return { ok: false, error: "no layers matched" };
            var _unit = ${jsxVal(unit)};
            var _step = ${jsxVal(step)};
            var _stepSec = _unit === "frames" ? _step * _comp.frameDuration : _step;
            var _mode = ${jsxVal(mode)};
            var _path = ${jsxVal(args.property ?? null)};
            var _ranks = _staggerRanks(_layers.length, ${jsxVal(order)}, ${jsxVal(seed)});
            var _warnings = [];
            var _maxRank = 0;
            for (var _ri = 0; _ri < _ranks.length; _ri++) if (_ranks[_ri] > _maxRank) _maxRank = _ranks[_ri];
            var _total = Math.abs(_maxRank * _stepSec);
            if (_total > ${jsxVal(STAGGER_WARN_SECONDS)} + 1e-9) {
                _warnings.push("the cascade lasts " + (Math.round(_total * 1000) / 1000) + " s, more than 0.5 s: the last layer arrives when the eye has moved on — shorten the step or group the layers");
            }
            if (_unit === "seconds") {
                var _frames = _stepSec / _comp.frameDuration;
                if (Math.abs(_frames - Math.round(_frames)) > 1e-6) _warnings.push("step is not a whole number of frames: keys will land between frames");
            }
            // Properties whose keys move with the layer: every animated leaf
            // except markers and Time Remap (layer timing, which mode 'start'
            // covers), and separated leaders (their X/Y/Z followers carry the keys).
            function _animated(layer) {
                var found = [];
                function walk(group) {
                    for (var i = 1; i <= group.numProperties; i++) {
                        var p = null;
                        try { p = group.property(i); } catch (eG) { continue; }
                        if (!p) continue;
                        if (p.propertyType === PropertyType.PROPERTY) {
                            if (p.matchName === "ADBE Time Remapping" || p.matchName === "ADBE Marker") continue;
                            var sep = false;
                            try { sep = p.dimensionsSeparated === true; } catch (eS) {}
                            if (sep) continue;
                            var nk = 0;
                            try { nk = p.numKeys; } catch (eN) { continue; }
                            if (nk > 0) found.push(p);
                        } else {
                            walk(p);
                        }
                    }
                }
                if (_path !== null) {
                    var node = AE.propertyAtPath(layer, _path);
                    if (!node || node.propertyType !== PropertyType.PROPERTY) return null;
                    var followers = AE.separationFollowers(node);
                    var list = followers ? followers : [node];
                    for (var f = 0; f < list.length; f++) if (list[f].numKeys > 0) found.push(list[f]);
                    return found;
                }
                walk(layer);
                return found;
            }
            // Plan everything before touching anything: a key pushed below 0 s
            // must stop the call while every layer is still as it was.
            var _jobs = [];
            for (var _i = 0; _i < _layers.length; _i++) {
                var _l = _layers[_i];
                var _offset = _ranks[_i] * _stepSec;
                var _job = { layer: _l, rank: _ranks[_i], offset: _offset, props: [] };
                if (_mode === "keys" && _offset !== 0) {
                    var _props = _animated(_l);
                    if (_props === null) return { ok: false, error: "property path not found on layer " + _l.index + " (" + _l.name + ")" };
                    for (var _p = 0; _p < _props.length; _p++) {
                        var _snap = AE.snapshotKeys(_props[_p]);
                        for (var _k = 0; _k < _snap.length; _k++) {
                            _snap[_k].time = _snap[_k].time + _offset;
                            if (_snap[_k].time < 0) return { ok: false, error: "layer " + _l.index + " (" + _l.name + "): a key would move to " + _snap[_k].time + " s; key times cannot be negative" };
                        }
                        _job.props.push({ prop: _props[_p], keys: _snap });
                    }
                }
                _jobs.push(_job);
            }
            var _report = [];
            for (var _j = 0; _j < _jobs.length; _j++) {
                var _jb = _jobs[_j];
                var _moved = 0;
                if (_mode === "start") {
                    _jb.layer.startTime = _jb.layer.startTime + _jb.offset;
                } else {
                    for (var _q = 0; _q < _jb.props.length; _q++) {
                        AE.removeAllKeys(_jb.props[_q].prop);
                        AE.applyKeys(_jb.props[_q].prop, _jb.props[_q].keys);
                        _moved += _jb.props[_q].keys.length;
                    }
                }
                _report.push({ index: _jb.layer.index, name: _jb.layer.name, rank: _jb.rank, offset: _jb.offset, keysMoved: _moved });
            }
            return { ok: true, count: _report.length, stepSeconds: _stepSec, totalSeconds: _total, layers: _report, warnings: _warnings };
        `;
  },
});

// --- Expression templates -------------------------------------------------

registerOp({
  name: "expression.list_templates",
  category: "expression",
  readOnly: true,
  description:
    "List the ready-made expression templates (wiggle, loops, counters, bounce/inertia/spring, linking, random) with " +
    "their parameters and defaults. Apply one with expression.apply_template.",
  params: [
    {
      name: "category",
      type: "string",
      description: "Only this category (wiggle|loop|time|physics|linking|random)",
      required: false,
    },
  ],
  toJsx(args) {
    const list = EXPRESSION_TEMPLATES.filter(
      (t) => args.category === undefined || t.category === args.category,
    ).map((t) => ({
      name: t.key,
      title: t.title,
      category: t.category,
      description: t.description,
      parameters: t.parameters,
      expression: t.expression,
    }));
    return `return { ok: true, count: ${jsxVal(list.length)}, templates: ${jsxVal(list)} };`;
  },
});

registerOp({
  name: "expression.apply_template",
  category: "expression",
  description:
    "Fill an expression template (expression.list_templates) with parameters and apply it to a property, like expression.set. " +
    "Values are type-checked; strings become quoted literals. If the property already has an expression it is replaced " +
    "only with confirm: true.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    {
      name: "template",
      type: "string",
      description: "Template name from expression.list_templates",
      required: true,
    },
    {
      name: "params",
      type: "object",
      description: "Template parameters; omitted ones take their default",
      required: false,
    },
    {
      name: "confirm",
      type: "boolean",
      description:
        "Needed only when the property already has an expression: that expression is replaced. Pass it only with the user's yes.",
      required: false,
    },
  ],
  toJsx(args) {
    const rendered = renderTemplate(
      String(args.template),
      (args.params ?? {}) as Record<string, unknown>,
    );
    if (!rendered.ok) return jsxFail(rendered.error);
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.canSetExpression) return { ok: false, error: "property does not support expressions" };
            if (_node.expression !== "" && ${jsxVal(args.confirm !== true)}) {
                return { ok: false, confirmRequired: true, error: ${jsxVal("la proprietà ha già un'espressione: applicare il modello la sostituisce. Non l'ho fatto: se l'utente è d'accordo, ripeti la chiamata con confirm: true.")}, existing: _node.expression };
            }
            _node.expression = ${jsxVal(rendered.expression)};
            _node.expressionEnabled = true;
            var _err = "";
            try { _err = _node.expressionError; } catch (eE) { _err = ""; }
            return { ok: true, name: _node.name, template: ${jsxVal(args.template)}, expression: ${jsxVal(rendered.expression)}, expressionError: _err };
        `;
  },
});
