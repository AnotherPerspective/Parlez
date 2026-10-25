// The ExtendScript side of comp.audit (provisional name): one shared core and
// one function per rule. Kept apart from the registration in audit.ts so the
// tests can load exactly this code into Node, with fake layers, and check every
// threshold and every rule without After Effects.
//
// Everything here is ES3 and is spliced verbatim into the generated script:
// no backticks, no `${`, no backslash escapes, no tool arguments. The rule
// list and thresholds are ideas from malkawi06/After-Effects-mcp-pro
// (host.jsx `audit` and `safeArea`, MIT); the code is written from scratch on
// kumo's helpers (AE.readValue, AE.layerRect, AE.errText) and, unlike the
// original, never adds temporary effects to measure anything.
//
// Read-only contract: these functions only read properties and call
// valueAtTime / sourceRectAtTime / keyTime / keyValue. They never set a value,
// add or remove a property, or change a switch.

export type AuditSeverity = "errore" | "avviso" | "nota";

export interface AuditRuleDef {
  /** Identifier reported in each finding and accepted by the `regole` parameter (provisional). */
  id: string;
  gravita: AuditSeverity;
  /** Name of the ES3 function below that implements the rule. */
  fn: string;
  /** One line for ae_catalog and the report: what the rule looks for. */
  descrizione: string;
  /**
   * Run only on the comp that was asked for, not on precomps reached through
   * `profondita`. True for the safe-area rule: a precomp's frame is not the
   * screen (a 800x200 lower-third precomp would flag everything in it).
   */
  soloPrincipale?: boolean;
  code: string;
}

/** Thresholds and their defaults. Each one is explained where it is used. */
export const AUDIT_DEFAULTS = {
  /** Safe-area margin as a fraction of width/height: 5 % is the title-safe convention malkawi uses. */
  margineAreaSicura: 0.05,
  /**
   * Shortest linear segment worth reporting, in seconds. Below ~5 frames at
   * 25 fps the eye cannot tell a linear segment from an eased one, so very
   * short linear hops (often deliberate snaps) would only be noise.
   */
  durataMinimaLineare: 0.2,
  /** Precomp levels to descend into: 0 = only the comp asked for. */
  profondita: 0,
} as const;

/**
 * Shared ES3 core: value access, pure geometry/time helpers (unit-tested on
 * their own), the finding collector and the runner.
 */
export const AUDIT_CORE = `
    // Samples per layer for the safe-area rule (malkawi's choice: 12 instants
    // spread over the comp, each at the middle of its slice).
    var _AU_SAMPLES = 12;
    // After Effects cannot draw a layer wider or taller than 30,000 px; past
    // that, renders go black without an error.
    var _AU_MAX_PX = 30000;
    // Two 3D layers closer than this in Z count as "on the same plane".
    var _AU_COPLANAR_Z = 5;
    // Below this opacity a layer is treated as not visible at that instant.
    var _AU_MIN_OPACITY = 5;
    // Total corner drift (px) between t and t + step that still counts as "at rest".
    var _AU_REST_TOL = 4;

    // Transform properties whose animation moves pixels on screen, so they
    // need motion blur. Opacity fades do not.
    var _AU_SPATIAL = {
        "ADBE Position": 1, "ADBE Position_0": 1, "ADBE Position_1": 1, "ADBE Position_2": 1,
        "ADBE Anchor Point": 1, "ADBE Scale": 1,
        "ADBE Rotate Z": 1, "ADBE Rotate X": 1, "ADBE Rotate Y": 1, "ADBE Orientation": 1
    };
    // Motion properties where a linear segment reads as a mechanical start/stop.
    var _AU_LINEAR_PROPS = {
        "ADBE Position": 1, "ADBE Position_0": 1, "ADBE Position_1": 1, "ADBE Position_2": 1,
        "ADBE Scale": 1, "ADBE Rotate Z": 1, "ADBE Rotate X": 1, "ADBE Rotate Y": 1,
        "ADBE Orientation": 1, "ADBE Opacity": 1
    };
    // Blurs that sample past the frame edge and pull transparency in when they
    // sit on an adjustment layer (malkawi's list). Gaussian Blur is left out:
    // it has its own Repeat Edge Pixels switch.
    var _AU_EDGE_BLURS = { "ADBE Motion Blur": 1, "ADBE Radial Blur": 1, "ADBE Box Blur2": 1 };

    function _auGet(obj, key, fallback) {
        try {
            var v = obj[key];
            return (v === undefined || v === null) ? fallback : v;
        } catch (eGet) { return fallback; }
    }
    function _auRound(x, digits) {
        var m = Math.pow(10, digits);
        return Math.round(x * m) / m;
    }
    function _auClip(s, n) {
        s = String(s);
        return (s.length > n) ? (s.substring(0, n) + "...") : s;
    }
    function _auTp(layer, matchName) {
        try {
            var tg = layer.property("ADBE Transform Group");
            return tg ? tg.property(matchName) : null;
        } catch (eTp) { return null; }
    }
    function _auVal(prop, t) {
        if (!prop) return null;
        try { return AE.readValue(prop, t); } catch (eVal) { return null; }
    }
    function _auKind(l) {
        if (l instanceof CameraLayer) return "camera";
        if (l instanceof LightLayer) return "light";
        if (l instanceof TextLayer) return "text";
        if (l instanceof ShapeLayer) return "shape";
        return "av";
    }
    // A layer that puts pixels on screen: enabled, with video, and not a
    // guide, adjustment, null, camera or light layer.
    function _auIsVisual(l) {
        var k = _auKind(l);
        if (k === "camera" || k === "light") return false;
        if (_auGet(l, "enabled", false) !== true) return false;
        if (_auGet(l, "hasVideo", true) !== true) return false;
        if (_auGet(l, "guideLayer", false) === true) return false;
        if (_auGet(l, "adjustmentLayer", false) === true) return false;
        if (_auGet(l, "nullLayer", false) === true) return false;
        return true;
    }
    function _auTimeOverlap(a, b) {
        return a.inPoint < b.outPoint && b.inPoint < a.outPoint;
    }
    // Equal values: numbers, or arrays of numbers. Anything else (text
    // documents, shapes) compares by identity, which reads as "changed".
    function _auSame(a, b) {
        if (a instanceof Array && b instanceof Array) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {
                if (Math.abs(a[i] - b[i]) > 0.000001) return false;
            }
            return true;
        }
        if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 0.000001;
        return a === b;
    }
    function _auWalk(group, fn, depth) {
        if (depth > 12) return;
        var n = _auGet(group, "numProperties", 0);
        for (var i = 1; i <= n; i++) {
            var p = null;
            try { p = group.property(i); } catch (eW) { continue; }
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) fn(p);
            else _auWalk(p, fn, depth + 1);
        }
    }
    function _auKeyList(p) {
        var out = [];
        var n = _auGet(p, "numKeys", 0);
        for (var k = 1; k <= n; k++) {
            out.push({
                t: p.keyTime(k),
                v: p.keyValue(k),
                inI: p.keyInInterpolationType(k),
                outI: p.keyOutInterpolationType(k)
            });
        }
        return out;
    }
    function _auPropChanges(p) {
        var n = _auGet(p, "numKeys", 0);
        if (n < 2) return false;
        var v0 = p.keyValue(1);
        for (var k = 2; k <= n; k++) {
            if (!_auSame(v0, p.keyValue(k))) return true;
        }
        return false;
    }
    function _auSelfMoves(l) {
        var tg = null;
        try { tg = l.property("ADBE Transform Group"); } catch (eTg) { return false; }
        if (!tg) return false;
        for (var i = 1; i <= tg.numProperties; i++) {
            var p = null;
            try { p = tg.property(i); } catch (eP) { continue; }
            if (p && _AU_SPATIAL.hasOwnProperty(p.matchName) && _auPropChanges(p)) return true;
        }
        return false;
    }
    // Moves on screen if it, or any parent up the chain, has spatial keys.
    function _auMoves(l) {
        var cur = l;
        for (var guard = 0; cur && guard < 50; guard++) {
            if (_auSelfMoves(cur)) return true;
            cur = _auGet(cur, "parent", null);
        }
        return false;
    }

    // ---- pure helpers (no After Effects objects) ----

    // Key times past the comp end, beyond half a frame of tolerance.
    function _auKeysAfter(times, end, tol) {
        var out = [];
        for (var i = 0; i < times.length; i++) {
            if (times[i] > end + tol) out.push(times[i]);
        }
        return out;
    }
    // Linear segments: both sides of the segment LINEAR, the value really
    // changes, and at least minDur of it falls inside [visStart, visEnd].
    function _auLinearSegments(keys, minDur, visStart, visEnd, linearType) {
        var segs = [];
        for (var k = 0; k + 1 < keys.length; k++) {
            var a = keys[k];
            var b = keys[k + 1];
            if (a.outI !== linearType || b.inI !== linearType) continue;
            if (_auSame(a.v, b.v)) continue;
            var s = Math.max(a.t, visStart);
            var e = Math.min(b.t, visEnd);
            if (e - s < minDur - 0.000001) continue;
            segs.push({ start: a.t, end: b.t });
        }
        return segs;
    }
    function _auOutsideTime(inPoint, outPoint, duration) {
        return inPoint >= duration || outPoint <= 0;
    }
    // One 2D layer transform, layer space to parent space. Rotation is
    // clockwise on screen because Y points down, as in After Effects.
    function _auApply2D(pts, anchor, pos, scale, rot) {
        var rad = rot * Math.PI / 180;
        var c = Math.cos(rad);
        var s = Math.sin(rad);
        var out = [];
        for (var i = 0; i < pts.length; i++) {
            var x = (pts[i][0] - anchor[0]) * scale[0] / 100;
            var y = (pts[i][1] - anchor[1]) * scale[1] / 100;
            out.push([pos[0] + x * c - y * s, pos[1] + x * s + y * c]);
        }
        return out;
    }
    function _auBoxOf(pts) {
        var b = { left: pts[0][0], top: pts[0][1], right: pts[0][0], bottom: pts[0][1] };
        for (var i = 1; i < pts.length; i++) {
            if (pts[i][0] < b.left) b.left = pts[i][0];
            if (pts[i][0] > b.right) b.right = pts[i][0];
            if (pts[i][1] < b.top) b.top = pts[i][1];
            if (pts[i][1] > b.bottom) b.bottom = pts[i][1];
        }
        return b;
    }
    // Sides of the frame whose safe margin the box crosses. null = not
    // judged: empty, (nearly) full-frame like a background, or entirely
    // off-screen (parked outside on purpose).
    function _auSafeSides(b, w, h, margin) {
        var bw = b.right - b.left;
        var bh = b.bottom - b.top;
        if (bw <= 1 || bh <= 1) return null;
        if (bw > w * 0.95 && bh > h * 0.95) return null;
        if (b.right < 0 || b.left > w || b.bottom < 0 || b.top > h) return null;
        var mx = w * margin;
        var my = h * margin;
        var sides = [];
        if (b.left < mx) sides.push("sinistra");
        if (b.right > w - mx) sides.push("destra");
        if (b.top < my) sides.push("alto");
        if (b.bottom > h - my) sides.push("basso");
        return sides;
    }
    function _auBoxMoved(a, b, tol) {
        var d = Math.abs(a.left - b.left) + Math.abs(a.top - b.top) +
            Math.abs(a.right - b.right) + Math.abs(a.bottom - b.bottom);
        return d > tol;
    }
    // Largest on-screen size in px, given the source size and, for the layer
    // and each parent, the largest |scale| it ever takes.
    function _auMaxPx(w, h, chain) {
        var sx = 1;
        var sy = 1;
        for (var i = 0; i < chain.length; i++) {
            sx = sx * chain[i][0] / 100;
            sy = sy * chain[i][1] / 100;
        }
        return Math.max(w * sx, h * sy);
    }
    function _auAngleDiff(a, b) {
        var d = Math.abs(a - b) % 360;
        return (d > 180) ? (360 - d) : d;
    }
    // Two 3D layers that would cut through each other: within tolZ in depth,
    // turned differently (any axis by more than 1 degree), and close enough
    // in X/Y for their extents to touch.
    function _auCoplanar(a, b, tolZ) {
        if (Math.abs(a.z - b.z) >= tolZ) return false;
        var differ = false;
        for (var i = 0; i < 3; i++) {
            if (_auAngleDiff(a.rot[i], b.rot[i]) > 1) differ = true;
        }
        if (!differ) return false;
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy) < a.r + b.r;
    }

    function _auPlural(n, one, many) {
        return n + " " + ((n === 1) ? one : many);
    }
    // The summary in one sentence, for reading aloud to a person:
    // "3 problemi su 3 livelli, 4 segnalazioni (1 errore, 3 avvisi)."
    function _auSummaryText(total, nLayers, nComps, counts) {
        if (total === 0) return "Nessuna segnalazione.";
        var where = [];
        if (nLayers > 0) where.push(_auPlural(nLayers, "livello", "livelli"));
        if (nComps > 0) where.push(_auPlural(nComps, "composizione", "composizioni"));
        var kinds = [];
        if (counts.errore > 0) kinds.push(_auPlural(counts.errore, "errore", "errori"));
        if (counts.avviso > 0) kinds.push(_auPlural(counts.avviso, "avviso", "avvisi"));
        if (counts.nota > 0) kinds.push(_auPlural(counts.nota, "nota", "note"));
        return _auPlural(nLayers + nComps, "problema", "problemi") + " su " + where.join(" e ") + ", " +
            _auPlural(total, "segnalazione", "segnalazioni") + " (" + kinds.join(", ") + ").";
    }

    // ---- measurements on layers ----

    // The layer's rendered rect carried into comp space through its own and
    // every parent's 2D transform, as a box. null when it cannot be measured
    // without a camera projection (the layer or a parent is 3D).
    function _auCompBox(layer, t) {
        var rect = AE.layerRect(layer, t);
        if (!rect) return null;
        var pts = [
            [rect.left, rect.top], [rect.left + rect.width, rect.top],
            [rect.left, rect.top + rect.height], [rect.left + rect.width, rect.top + rect.height]
        ];
        var cur = layer;
        for (var guard = 0; cur && guard < 50; guard++) {
            if (_auGet(cur, "threeDLayer", false) === true) return null;
            var a = _auVal(_auTp(cur, "ADBE Anchor Point"), t);
            var p = _auVal(_auTp(cur, "ADBE Position"), t);
            var s = _auVal(_auTp(cur, "ADBE Scale"), t);
            var r = _auVal(_auTp(cur, "ADBE Rotate Z"), t);
            pts = _auApply2D(pts, a || [0, 0], p || [0, 0], s || [100, 100], (typeof r === "number") ? r : 0);
            cur = _auGet(cur, "parent", null);
        }
        return _auBoxOf(pts);
    }
    function _auMaxScale(prop) {
        if (!prop) return [100, 100];
        var n = _auGet(prop, "numKeys", 0);
        if (n === 0) {
            var v = prop.value;
            return [Math.abs(v[0]), Math.abs(v[1])];
        }
        var mx = [0, 0];
        for (var k = 1; k <= n; k++) {
            var kv = prop.keyValue(k);
            if (Math.abs(kv[0]) > mx[0]) mx[0] = Math.abs(kv[0]);
            if (Math.abs(kv[1]) > mx[1]) mx[1] = Math.abs(kv[1]);
        }
        return mx;
    }
    function _au3DInfo(l, t) {
        var p = _auVal(_auTp(l, "ADBE Position"), t) || [0, 0, 0];
        var o = _auVal(_auTp(l, "ADBE Orientation"), t) || [0, 0, 0];
        var rx = _auVal(_auTp(l, "ADBE Rotate X"), t);
        var ry = _auVal(_auTp(l, "ADBE Rotate Y"), t);
        var rz = _auVal(_auTp(l, "ADBE Rotate Z"), t);
        var s = _auVal(_auTp(l, "ADBE Scale"), t) || [100, 100, 100];
        var rect = AE.layerRect(l, t) || { left: 0, top: 0, width: 0, height: 0 };
        var w = rect.width * Math.abs(s[0]) / 100;
        var h = rect.height * Math.abs(s[1]) / 100;
        return {
            x: p[0], y: p[1], z: (p.length > 2) ? p[2] : 0,
            rot: [
                o[0] + ((typeof rx === "number") ? rx : 0),
                o[1] + ((typeof ry === "number") ? ry : 0),
                o[2] + ((typeof rz === "number") ? rz : 0)
            ],
            r: Math.sqrt(w * w + h * h) / 2
        };
    }

    // ---- collector and runner ----

    function _auMakeCtx(comp, depth, cfg, out) {
        var ctx = { comp: comp, depth: depth, cfg: cfg, regola: null, gravita: null };
        ctx.add = function (layer, tempo, messaggio, comeCorreggere) {
            out.push({
                regola: ctx.regola,
                gravita: ctx.gravita,
                composizione: comp.name,
                livello: layer ? layer.name : null,
                indice: layer ? layer.index : null,
                tempo: (typeof tempo === "number") ? _auRound(tempo, 3) : null,
                messaggio: messaggio,
                comeCorreggere: comeCorreggere
            });
        };
        return ctx;
    }
    function _auRun(root, cfg, rules) {
        var out = [];
        var failed = [];
        var visited = {};
        var queue = [{ comp: root, depth: 0 }];
        var comps = [];
        var nLayers = 0;
        visited["c" + root.id] = true;
        while (queue.length > 0) {
            var job = queue.shift();
            var c = job.comp;
            comps.push(c.name);
            nLayers += c.numLayers;
            var ctx = _auMakeCtx(c, job.depth, cfg, out);
            for (var r = 0; r < rules.length; r++) {
                if (rules[r].soloPrincipale && job.depth > 0) continue;
                ctx.regola = rules[r].id;
                ctx.gravita = rules[r].gravita;
                try { rules[r].fn(ctx); }
                catch (eRule) { failed.push({ regola: rules[r].id, composizione: c.name, errore: AE.errText(eRule) }); }
            }
            if (job.depth < cfg.profondita) {
                for (var i = 1; i <= c.numLayers; i++) {
                    var src = _auGet(c.layer(i), "source", null);
                    if (src && src instanceof CompItem && !visited.hasOwnProperty("c" + src.id)) {
                        visited["c" + src.id] = true;
                        queue.push({ comp: src, depth: job.depth + 1 });
                    }
                }
            }
        }
        var counts = { errore: 0, avviso: 0, nota: 0 };
        var perRegola = {};
        // One "problem" per element: a layer, or the comp itself for
        // comp-level findings. Two rules on one layer are one problem with
        // two findings, each with its own fix.
        var groups = {};
        var perElemento = [];
        var nLayersHit = 0;
        var nCompsHit = 0;
        for (var f = 0; f < out.length; f++) {
            var g = out[f].gravita;
            if (counts.hasOwnProperty(g)) counts[g] += 1;
            var rk = out[f].regola;
            perRegola[rk] = perRegola.hasOwnProperty(rk) ? perRegola[rk] + 1 : 1;
            var isComp = out[f].livello === null;
            var tk = "k" + out[f].composizione + "|" + (isComp ? "" : out[f].livello);
            if (!groups.hasOwnProperty(tk)) {
                groups[tk] = { composizione: out[f].composizione, livello: out[f].livello, regole: [] };
                perElemento.push(groups[tk]);
                if (isComp) nCompsHit += 1;
                else nLayersHit += 1;
            }
            groups[tk].regole.push(rk);
        }
        var active = [];
        for (var a = 0; a < rules.length; a++) active.push(rules[a].id);
        return {
            ok: true,
            composizione: root.name,
            solaLettura: true,
            temporanei: [],
            segnalazioni: out,
            riepilogo: {
                testo: _auSummaryText(out.length, nLayersHit, nCompsHit, counts),
                totale: out.length,
                errori: counts.errore,
                avvisi: counts.avviso,
                note: counts.nota,
                perRegola: perRegola,
                elementiConSegnalazioni: nLayersHit + nCompsHit,
                livelliConSegnalazioni: nLayersHit,
                perElemento: perElemento,
                composizioniControllate: comps,
                livelliControllati: nLayers,
                regoleAttive: active,
                soglie: {
                    margineAreaSicura: cfg.margineAreaSicura,
                    durataMinimaLineare: cfg.durataMinimaLineare,
                    profondita: cfg.profondita
                }
            },
            nonControllate: failed
        };
    }
`;

/** The 14 rules, in report order. */
export const AUDIT_RULES: AuditRuleDef[] = [
  {
    id: "errore-espressione",
    gravita: "errore",
    fn: "_auR_espressione",
    descrizione: "Proprietà con un'espressione accesa che dà errore",
    code: `
    function _auR_espressione(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            _auWalk(l, function (p) {
                var err = "";
                try {
                    if (p.canSetExpression && p.expressionEnabled) err = p.expressionError;
                } catch (eEx) { err = ""; }
                if (typeof err === "string" && err.length > 0) {
                    ctx.add(l, null,
                        "L'espressione su '" + p.name + "' dà errore: " + _auClip(err, 160),
                        "Apri l'espressione di '" + p.name + "' e correggila, oppure spegnila.");
                }
            }, 0);
        }
    }
`,
  },
  {
    id: "keyframe-oltre-fine",
    gravita: "errore",
    fn: "_auR_keyOltreFine",
    descrizione: "Keyframe dopo la fine della composizione (quella parte non si vede)",
    code: `
    function _auR_keyOltreFine(ctx) {
        var c = ctx.comp;
        var tol = c.frameDuration / 2;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var count = 0;
            var first = null;
            var names = [];
            _auWalk(l, function (p) {
                // Markers are not animation: one past the end changes nothing on screen.
                if (p.matchName === "ADBE Marker") return;
                var n = _auGet(p, "numKeys", 0);
                if (n < 2) return;
                var times = [];
                for (var k = 1; k <= n; k++) times.push(p.keyTime(k));
                var after = _auKeysAfter(times, c.duration, tol);
                if (after.length > 0) {
                    count += after.length;
                    if (first === null || after[0] < first) first = after[0];
                    names.push(p.name);
                }
            }, 0);
            if (count > 0) {
                ctx.add(l, first,
                    count + " keyframe dopo la fine della composizione (" + names.join(", ") + "): quella parte dell'animazione non si vede.",
                    "Sposta i keyframe prima di " + _auRound(c.duration, 2) + " s, oppure allunga la composizione.");
            }
        }
    }
`,
  },
  {
    id: "keyframe-lineari",
    gravita: "avviso",
    fn: "_auR_lineari",
    descrizione:
      "Segmenti di keyframe lineari su posizione, scala, rotazione o opacità, lunghi almeno durataMinimaLineare",
    code: `
    function _auR_lineari(ctx) {
        var c = ctx.comp;
        var lin = KeyframeInterpolationType.LINEAR;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var tg = null;
            try { tg = l.property("ADBE Transform Group"); } catch (eTg) { tg = null; }
            if (!tg) continue;
            var visStart = Math.max(0, l.inPoint);
            var visEnd = Math.min(c.duration, l.outPoint);
            var found = [];
            var firstT = null;
            for (var j = 1; j <= tg.numProperties; j++) {
                var p = null;
                try { p = tg.property(j); } catch (eP) { continue; }
                if (!p || !_AU_LINEAR_PROPS.hasOwnProperty(p.matchName)) continue;
                var segs = _auLinearSegments(_auKeyList(p), ctx.cfg.durataMinimaLineare, visStart, visEnd, lin);
                if (segs.length > 0) {
                    found.push(p.name + " (" + segs.length + ")");
                    if (firstT === null || segs[0].start < firstT) firstT = segs[0].start;
                }
            }
            if (found.length > 0) {
                ctx.add(l, firstT,
                    "Keyframe lineari su " + found.join(", ") + ": il movimento parte e si ferma di colpo.",
                    "Seleziona i keyframe e applica Easy Ease (F9), a meno che il movimento debba sembrare meccanico.");
            }
        }
    }
`,
  },
  {
    id: "movimento-senza-motion-blur",
    gravita: "avviso",
    fn: "_auR_mbLivello",
    descrizione:
      "Livello che si muove (posizione, scala, rotazione, anche tramite genitore) con il motion blur spento",
    code: `
    function _auR_mbLivello(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (!_auIsVisual(l)) continue;
            if (!_auMoves(l)) continue;
            if (_auGet(l, "motionBlur", false) === true) continue;
            ctx.add(l, null,
                "Il livello si muove ma ha il motion blur spento: il movimento sembrerà a scatti.",
                "Accendi l'interruttore Motion Blur del livello (e quello della composizione).");
        }
    }
`,
  },
  {
    id: "fuori-dal-tempo",
    gravita: "errore",
    fn: "_auR_fuoriTempo",
    descrizione: "Livello interamente fuori dalla durata della composizione",
    code: `
    function _auR_fuoriTempo(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var audible = _auGet(l, "hasAudio", false) === true && _auGet(l, "audioEnabled", false) === true;
            if (_auGet(l, "enabled", false) !== true && !audible) continue;
            if (!_auOutsideTime(l.inPoint, l.outPoint, c.duration)) continue;
            ctx.add(l, l.inPoint,
                "Il livello è tutto fuori dalla durata della composizione (da " + _auRound(l.inPoint, 2) +
                    " s a " + _auRound(l.outPoint, 2) + " s, la composizione dura " + _auRound(c.duration, 2) + " s): non si vede mai.",
                "Porta il livello dentro la linea del tempo, oppure toglilo se non serve.");
        }
    }
`,
  },
  {
    id: "file-mancante",
    gravita: "errore",
    fn: "_auR_fileMancante",
    descrizione: "Livello il cui file sorgente non si trova sul disco",
    code: `
    function _auR_fileMancante(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var src = _auGet(l, "source", null);
            if (!src || _auGet(src, "footageMissing", false) !== true) continue;
            ctx.add(l, null,
                "Il file sorgente '" + src.name + "' non si trova sul disco.",
                "Ricollega il file (Sostituisci metraggio) o la cartella in cui si trova.");
        }
    }
`,
  },
  {
    id: "cc-radial-blur",
    gravita: "avviso",
    fn: "_auR_ccRadialBlur",
    descrizione: "Effetto CC Radial Blur acceso (molto lento in anteprima e render)",
    code: `
    function _auR_ccRadialBlur(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (_auGet(l, "enabled", false) !== true) continue;
            var fx = null;
            try { fx = l.property("ADBE Effect Parade"); } catch (eFx) { fx = null; }
            if (!fx) continue;
            for (var e = 1; e <= fx.numProperties; e++) {
                var eff = fx.property(e);
                if (eff.matchName !== "CC Radial Blur" || _auGet(eff, "enabled", true) !== true) continue;
                ctx.add(l, null,
                    "C'è CC Radial Blur ('" + eff.name + "'): è molto lento e può bloccare anteprima e render.",
                    "Usa Sfocatura radiale (Radial Blur, tipo Zoom, qualità Bozza) al suo posto.");
            }
        }
    }
`,
  },
  {
    id: "blur-regolazione",
    gravita: "avviso",
    fn: "_auR_blurRegolazione",
    descrizione:
      "Sfocatura direzionale, radiale o box veloce su un livello di regolazione senza CC RepeTile prima",
    code: `
    function _auR_blurRegolazione(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (_auGet(l, "adjustmentLayer", false) !== true || _auGet(l, "enabled", false) !== true) continue;
            var fx = null;
            try { fx = l.property("ADBE Effect Parade"); } catch (eFx) { fx = null; }
            if (!fx) continue;
            var tiled = false;
            for (var e = 1; e <= fx.numProperties; e++) {
                var eff = fx.property(e);
                if (_auGet(eff, "enabled", true) !== true) continue;
                if (eff.matchName === "CC RepeTile") { tiled = true; continue; }
                if (!tiled && _AU_EDGE_BLURS.hasOwnProperty(eff.matchName)) {
                    ctx.add(l, null,
                        "Sfocatura '" + eff.name + "' su un livello di regolazione senza CC RepeTile prima: ai bordi del quadro entra il trasparente.",
                        "Aggiungi CC RepeTile prima della sfocatura, per allargare l'immagine oltre i bordi.");
                }
            }
        }
    }
`,
  },
  {
    id: "livello-enorme",
    gravita: "errore",
    fn: "_auR_enorme",
    descrizione:
      "Livello che alla scala massima (sua e dei genitori) supera 30.000 px, il limite di After Effects",
    code: `
    function _auR_enorme(ctx) {
        var c = ctx.comp;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (!_auIsVisual(l)) continue;
            var src = _auGet(l, "source", null);
            if (!src) continue;
            var w = _auGet(src, "width", null);
            var h = _auGet(src, "height", null);
            if (typeof w !== "number" || typeof h !== "number") continue;
            var chain = [];
            var cur = l;
            for (var guard = 0; cur && guard < 50; guard++) {
                chain.push(_auMaxScale(_auTp(cur, "ADBE Scale")));
                cur = _auGet(cur, "parent", null);
            }
            var px = _auMaxPx(w, h, chain);
            if (px > _AU_MAX_PX) {
                ctx.add(l, null,
                    "Alla scala massima il livello arriva a circa " + Math.round(px) + " px (il limite è 30.000 px): oltre, il render diventa nero.",
                    "Riduci la scala massima, dividi il livello in parti, o sostituiscilo con un solido grande quanto il quadro.");
            }
        }
    }
`,
  },
  {
    id: "3d-coplanari",
    gravita: "avviso",
    fn: "_auR_coplanari",
    descrizione:
      "Due livelli 3D fratelli quasi sullo stesso piano ma orientati diversamente (uno taglia l'altro)",
    code: `
    function _auR_coplanari(ctx) {
        var c = ctx.comp;
        var groups = {};
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (!_auIsVisual(l) || _auGet(l, "threeDLayer", false) !== true) continue;
            var par = _auGet(l, "parent", null);
            var key = par ? ("p" + par.index) : "root";
            if (!groups.hasOwnProperty(key)) groups[key] = [];
            var list = groups[key];
            var info = _au3DInfo(l, Math.max(0, l.inPoint));
            for (var s = 0; s < list.length; s++) {
                if (!_auTimeOverlap(list[s].layer, l)) continue;
                if (_auCoplanar(list[s].info, info, _AU_COPLANAR_Z)) {
                    ctx.add(l, null,
                        "'" + l.name + "' e '" + list[s].layer.name + "' sono quasi sullo stesso piano 3D ma girati in modo diverso: uno taglia l'altro.",
                        "Allontana i due livelli in profondità (Z) di qualche pixel, oppure allinea il loro orientamento.");
                }
            }
            list.push({ layer: l, info: info });
        }
    }
`,
  },
  {
    id: "testo-2d-sotto-3d",
    gravita: "avviso",
    fn: "_auR_testo2d",
    descrizione: "Testo 2D sotto livelli 3D nello stesso tempo (i 3D gli vengono disegnati sopra)",
    code: `
    function _auR_testo2d(ctx) {
        var c = ctx.comp;
        var seen = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (!_auIsVisual(l)) continue;
            if (_auGet(l, "threeDLayer", false) === true) { seen.push(l); continue; }
            if (_auKind(l) !== "text") continue;
            for (var s = 0; s < seen.length; s++) {
                if (!_auTimeOverlap(seen[s], l)) continue;
                ctx.add(l, null,
                    "Testo 2D sotto il livello 3D '" + seen[s].name + "': i livelli 3D gli vengono disegnati sopra.",
                    "Sposta il testo sopra i livelli 3D nel pannello dei livelli, oppure rendilo 3D.");
                break;
            }
        }
    }
`,
  },
  {
    id: "area-sicura",
    gravita: "avviso",
    fn: "_auR_areaSicura",
    soloPrincipale: true,
    descrizione:
      "Elemento 2D fermo (a riposo) che esce dal margine dell'area sicura (margineAreaSicura, 5% di base)",
    code: `
    function _auR_areaSicura(ctx) {
        var c = ctx.comp;
        var m = ctx.cfg.margineAreaSicura;
        var pct = _auRound(m * 100, 1);
        // Compare against a box a little later to tell resting from moving:
        // 0.1 s, or two frames if that is longer.
        var step = Math.max(0.1, 2 * c.frameDuration);
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (!_auIsVisual(l) || _auGet(l, "threeDLayer", false) === true) continue;
            var opProp = _auTp(l, "ADBE Opacity");
            for (var s = 0; s < _AU_SAMPLES; s++) {
                var t = (s + 0.5) * c.duration / _AU_SAMPLES;
                if (t < l.inPoint || t >= l.outPoint) continue;
                var op = _auVal(opProp, t);
                if (typeof op === "number" && op < _AU_MIN_OPACITY) continue;
                var b = _auCompBox(l, t);
                if (!b) break;
                var b2 = _auCompBox(l, t + step);
                if (b2 && _auBoxMoved(b, b2, _AU_REST_TOL)) continue;
                var sides = _auSafeSides(b, c.width, c.height, m);
                if (!sides || sides.length === 0) continue;
                ctx.add(l, t,
                    "Da fermo esce dall'area sicura del " + pct + "% (lato " + sides.join(", ") + "): su alcuni schermi può essere tagliato.",
                    "Sposta o rimpicciolisci il livello finché resta dentro il margine del " + pct + "%.");
                break;
            }
        }
    }
`,
  },
  {
    id: "motion-blur-comp",
    gravita: "avviso",
    fn: "_auR_mbComp",
    descrizione: "Interruttore Motion Blur della composizione spento mentre dei livelli si muovono",
    code: `
    function _auR_mbComp(ctx) {
        var c = ctx.comp;
        if (_auGet(c, "motionBlur", true) === true) return;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (!_auIsVisual(l) || !_auMoves(l)) continue;
            ctx.add(null, null,
                "L'interruttore Motion Blur della composizione è spento mentre dei livelli si muovono (per esempio '" + l.name + "'): il motion blur non si vede da nessuna parte.",
                "Accendi l'interruttore Motion Blur in alto nel pannello della composizione.");
            return;
        }
    }
`,
  },
  {
    id: "comp-vuota",
    gravita: "errore",
    fn: "_auR_compVuota",
    descrizione: "Composizione senza livelli",
    code: `
    function _auR_compVuota(ctx) {
        if (ctx.comp.numLayers === 0) {
            ctx.add(null, null, "La composizione è vuota.", "Aggiungi dei livelli, oppure togli la composizione se non serve.");
        }
    }
`,
  },
];

export const AUDIT_RULE_IDS: string[] = AUDIT_RULES.map((r) => r.id);
