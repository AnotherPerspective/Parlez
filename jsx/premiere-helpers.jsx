// Parlez! for Premiere Pro - read helpers shared by the generated code.
//
// The PR.* functions turn Premiere's scripting objects (project items,
// sequences, tracks, track items, markers) into plain JSON-safe values.
// Premiere's scripting model changes between versions and some members are
// missing on some objects, so every read goes through PR.safe: one member
// Premiere refuses becomes null in the answer instead of failing the call.
//
// Times are reported in seconds (numbers) - the unit a person thinks in -
// with the frame rate alongside, so a frame number is one multiplication
// away.
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.
// Never coerce a caught exception into a string: use PR.errText.

var PR = PR || {};

PR.TICKS_PER_SECOND = 254016000000;

PR.errText = function (e) {
    try {
        if (e === null || e === undefined) return "unknown error";
        if (typeof e === "string") return e;
        var msg = (e.message === undefined || e.message === null) ? "" : String(e.message);
        if (msg.length === 0) msg = "error";
        if (e.line !== undefined && e.line !== null) msg += " (line " + String(e.line) + ")";
        return msg;
    } catch (eFmt) {
        return "unformattable error";
    }
};

/** fn() or `fallback` when it throws or answers undefined. */
PR.safe = function (fn, fallback) {
    try {
        var v = fn();
        return (v === undefined) ? fallback : v;
    } catch (e) {
        return fallback;
    }
};

PR.round = function (n, digits) {
    if (typeof n !== "number" || isNaN(n)) return null;
    var f = Math.pow(10, digits);
    return Math.round(n * f) / f;
};

PR.path = function (p) {
    if (p === null || p === undefined) return null;
    var s = String(p);
    return (s.length === 0) ? null : s.replace(/\\/g, "/");
};

/** A Premiere Time object (or a ticks string) as seconds; null when unreadable. */
PR.seconds = function (t) {
    if (t === null || t === undefined) return null;
    try {
        if (typeof t === "object") {
            if (typeof t.seconds === "number") return PR.round(t.seconds, 4);
            if (t.ticks !== undefined) return PR.round(Number(t.ticks) / PR.TICKS_PER_SECOND, 4);
            return null;
        }
        var n = Number(t);
        return isNaN(n) ? null : PR.round(n / PR.TICKS_PER_SECOND, 4);
    } catch (e) {
        return null;
    }
};

/** Ticks per frame of a sequence (its timebase); null when unreadable. */
PR.frameTicks = function (seq) {
    var tb = PR.safe(function () { return Number(seq.timebase); }, NaN);
    return (typeof tb === "number" && tb > 0) ? tb : null;
};

/**
 * `seconds` moved onto the sequence's frame grid, as ticks; null without a
 * timebase. Times from the server are seconds with three decimals: 2.002 at
 * 23.976 is a hair short of frame 48, and Premiere cut the clip one frame
 * short, or left a black frame between two clips (2026-11-15).
 */
PR.snapTicks = function (seq, seconds) {
    var tpf = PR.frameTicks(seq);
    if (tpf === null || typeof seconds !== "number") return null;
    return Math.round(seconds * PR.TICKS_PER_SECOND / tpf) * tpf;
};

/** One frame of the sequence, in seconds (0 without a timebase). */
PR.frameSeconds = function (seq) {
    var tpf = PR.frameTicks(seq);
    return (tpf === null) ? 0 : tpf / PR.TICKS_PER_SECOND;
};

/** `seconds` on the frame grid (unchanged without a timebase). */
PR.snap = function (seq, seconds) {
    var ticks = PR.snapTicks(seq, seconds);
    return (ticks === null) ? seconds : ticks / PR.TICKS_PER_SECOND;
};

/**
 * A Premiere Time exactly on the frame grid (set by ticks, not by a
 * floating-point number of seconds); null where Time does not exist.
 */
PR.timeAt = function (seq, seconds) {
    var ticks = PR.snapTicks(seq, seconds);
    try {
        var t = new Time();
        if (ticks !== null) t.ticks = String(ticks);
        else t.seconds = seconds;
        return t;
    } catch (eTime) {
        return null;
    }
};

/** Frames per second of a sequence, from its timebase (ticks per frame). */
PR.fps = function (seq) {
    var timebase = PR.safe(function () { return Number(seq.timebase); }, NaN);
    if (typeof timebase === "number" && timebase > 0) return PR.round(PR.TICKS_PER_SECOND / timebase, 3);
    var frame = PR.safe(function () { return seq.getSettings().videoFrameRate.seconds; }, null);
    if (typeof frame === "number" && frame > 0) return PR.round(1 / frame, 3);
    return null;
};

// --- Timecode (Anthony, 2026-11-15: Parlez! works in timecode) -------------
//
// Every time a pr_* tool takes may be the sequence's timecode "HH:MM:SS:FF"
// (";" before FF in drop-frame), the one the user reads in the timeline: it
// becomes a frame number, then ticks (frame x ticks per frame), with no
// seconds in between. Positions on the timeline count from the sequence's
// start timecode (seq.zeroPoint): at 01:00:00:00, "01:00:01:00" is one second
// in. Lengths (durations, source in/out) count from 00:00:00:00. A number is
// still taken as seconds, for compatibility. Answers carry the timecode and
// the frame number next to the seconds.

/** { tpf, base, drop }: ticks per frame, nominal frames per second, drop-frame. */
PR.rate = function (seq) {
    var tpf = PR.frameTicks(seq);
    if (tpf === null) return null;
    var base = Math.round(PR.TICKS_PER_SECOND / tpf);
    // videoDisplayFormat: 102 = 29.97 drop-frame, 106 = 59.94 drop-frame.
    var fmt = PR.safe(function () { return Number(seq.getSettings().videoDisplayFormat); }, NaN);
    var drop = (fmt === 102 || fmt === 106) && (base === 30 || base === 60);
    return { tpf: tpf, base: base, drop: drop };
};

/** The sequence's start timecode, in ticks (0 when unreadable). */
PR.zeroTicks = function (seq) {
    var z = PR.safe(function () { return Number(seq.zeroPoint); }, NaN);
    return (typeof z === "number" && !isNaN(z) && z > 0) ? z : 0;
};

/** Frames dropped each minute (not every tenth) in drop-frame timecode. */
PR.dropPerMinute = function (base) {
    return Math.round(base / 15);
};

/** "HH:MM:SS:FF" -> frames from 00:00:00:00; { error } when it is not a timecode of this rate. */
PR.tcToFrames = function (tc, rate) {
    var m = /^(\d{1,2})[:;](\d{2})[:;](\d{2})([:;])(\d{2})$/.exec(String(tc));
    if (!m) return { error: "\"" + tc + "\" non e' un timecode: scrivi HH:MM:SS:FF." };
    var h = Number(m[1]);
    var mi = Number(m[2]);
    var s = Number(m[3]);
    var f = Number(m[5]);
    if (mi > 59 || s > 59) return { error: "\"" + tc + "\": minuti e secondi vanno da 00 a 59." };
    if (f >= rate.base) {
        return { error: "\"" + tc + "\": a " + rate.base + " fotogrammi al secondo i fotogrammi vanno da 00 a " + (rate.base - 1) + "." };
    }
    var frames = ((h * 60 + mi) * 60 + s) * rate.base + f;
    if (rate.drop) {
        var d = PR.dropPerMinute(rate.base);
        var minutes = h * 60 + mi;
        if (s === 0 && f < d && mi % 10 !== 0) {
            return { error: "\"" + tc + "\" non esiste in drop-frame: al minuto " + mi + " si salta da ;00 a ;" + (d < 10 ? "0" : "") + d + "." };
        }
        frames -= d * (minutes - Math.floor(minutes / 10));
    }
    return { frames: frames };
};

/** Frames from 00:00:00:00 -> "HH:MM:SS:FF" (";" before FF in drop-frame). */
PR.framesToTc = function (frames, rate) {
    var n = Math.round(frames);
    var neg = n < 0;
    if (neg) n = -n;
    if (rate.drop) {
        var d = PR.dropPerMinute(rate.base);
        var perMinute = rate.base * 60 - d;
        var perTen = perMinute * 10 + d;
        var tens = Math.floor(n / perTen);
        var rest = n % perTen;
        n += d * 9 * tens;
        if (rest > d) n += d * Math.floor((rest - d) / perMinute);
    }
    var f = n % rate.base;
    var totalS = Math.floor(n / rate.base);
    var s = totalS % 60;
    var totalM = Math.floor(totalS / 60);
    var mi = totalM % 60;
    var h = Math.floor(totalM / 60);
    function two(v) { return (v < 10 ? "0" : "") + String(v); }
    return (neg ? "-" : "") + two(h) + ":" + two(mi) + ":" + two(s) + (rate.drop ? ";" : ":") + two(f);
};

/**
 * A time from a tool, as seconds exactly on the frame grid. `kind`:
 * "position" (on the timeline: a timecode counts from the start timecode) or
 * "length" (a duration or a point in the source: from 00:00:00:00).
 * Returns { seconds } or { error }.
 */
PR.timeIn = function (seq, value, kind) {
    if (typeof value === "number") return { seconds: PR.snap(seq, value) };
    var rate = PR.rate(seq);
    if (rate === null) return { error: "Non riesco a leggere i fotogrammi al secondo della sequenza: usa i secondi." };
    var r = PR.tcToFrames(value, rate);
    if (r.error) return r;
    var ticks = r.frames * rate.tpf;
    if (kind === "position") {
        var zero = PR.zeroTicks(seq);
        ticks -= zero;
        if (ticks < 0) {
            return { error: "\"" + value + "\" viene prima dell'inizio della sequenza, che parte da " +
                PR.framesToTc(Math.round(zero / rate.tpf), rate) + "." };
        }
    }
    return { seconds: ticks / PR.TICKS_PER_SECOND };
};

/**
 * Convert, in place, every time field of every object in `list` (seconds or
 * timecode) to seconds on the frame grid. Returns an error text, or null.
 */
PR.timesIn = function (seq, list, fields, kind) {
    for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o === null || typeof o !== "object") continue;
        for (var k = 0; k < fields.length; k++) {
            var v = o[fields[k]];
            if (typeof v !== "number" && typeof v !== "string") continue;
            var r = PR.timeIn(seq, v, kind);
            if (r.error) return fields[k] + ": " + r.error;
            o[fields[k]] = r.seconds;
        }
    }
    return null;
};

/** { tc, frame } for seconds on this sequence (frame counted from its start); null when unreadable. */
PR.tcOut = function (seq, seconds, kind) {
    if (typeof seconds !== "number") return null;
    var rate = PR.rate(seq);
    if (rate === null) return null;
    var frame = Math.round(seconds * PR.TICKS_PER_SECOND / rate.tpf);
    var shown = (kind === "position") ? frame + Math.round(PR.zeroTicks(seq) / rate.tpf) : frame;
    return { tc: PR.framesToTc(shown, rate), frame: frame };
};

/**
 * Add "<field>TC" and "<field>Frame" next to each time field of `obj`
 * (`fields`: { name: "position" | "length" }). Returns obj.
 */
PR.withTimecode = function (seq, obj, fields) {
    if (obj === null || typeof obj !== "object") return obj;
    for (var k in fields) {
        if (!fields.hasOwnProperty(k)) continue;
        var t = PR.tcOut(seq, obj[k], fields[k]);
        if (t === null) continue;
        obj[k + "TC"] = t.tc;
        obj[k + "Frame"] = t.frame;
    }
    return obj;
};

PR.CLIP_TIMES = { start: "position", end: "position", inPoint: "length", outPoint: "length" };

/** "bin", "sequence", "clip", "file" or "root" for a project item. */
PR.itemKind = function (item) {
    if (PR.safe(function () { return item.isSequence(); }, false) === true) return "sequence";
    var type = PR.safe(function () { return item.type; }, null);
    if (type === 2) return "bin";
    if (type === 3) return "root";
    if (type === 4) return "file";
    return "clip";
};

/**
 * Every item under `root`, depth first, as a flat list with the bin path it
 * sits in ("Montaggio/Interviste"). Stops after `max` items and says so.
 */
PR.listItems = function (root, max) {
    var out = { items: [], truncated: false, offline: 0 };
    function walk(parent, binPath) {
        var children = PR.safe(function () { return parent.children; }, null);
        var n = PR.safe(function () { return children.numItems; }, 0);
        for (var i = 0; i < n; i++) {
            if (out.items.length >= max) {
                out.truncated = true;
                return;
            }
            var item = PR.safe(function () { return children[i]; }, null);
            if (item === null) continue;
            var kind = PR.itemKind(item);
            var name = PR.safe(function () { return String(item.name); }, "");
            var entry = {
                name: name,
                kind: kind,
                bin: binPath,
                nodeId: PR.safe(function () { return String(item.nodeId); }, null)
            };
            if (kind === "clip" || kind === "file") {
                entry.file = PR.path(PR.safe(function () { return item.getMediaPath(); }, null));
                entry.offline = PR.safe(function () { return item.isOffline() === true; }, null);
                if (entry.offline === true) out.offline++;
            }
            var label = PR.safe(function () { return item.getColorLabel(); }, null);
            if (typeof label === "number") entry.colorLabel = label;
            out.items.push(entry);
            if (kind === "bin") walk(item, binPath.length > 0 ? binPath + "/" + name : name);
            if (out.truncated) return;
        }
    }
    walk(root, "");
    return out;
};

PR.sequenceSummary = function (seq) {
    var s = {
        name: PR.safe(function () { return String(seq.name); }, null),
        sequenceID: PR.safe(function () { return String(seq.sequenceID); }, null),
        width: PR.safe(function () { return Number(seq.frameSizeHorizontal); }, null),
        height: PR.safe(function () { return Number(seq.frameSizeVertical); }, null),
        fps: PR.fps(seq),
        duration: PR.seconds(PR.safe(function () { return seq.end; }, null)),
        videoTracks: PR.safe(function () { return seq.videoTracks.numTracks; }, null),
        audioTracks: PR.safe(function () { return seq.audioTracks.numTracks; }, null)
    };
    PR.withTimecode(seq, s, { duration: "length" });
    var rate = PR.rate(seq);
    if (rate !== null) {
        s.startTimecode = PR.framesToTc(Math.round(PR.zeroTicks(seq) / rate.tpf), rate);
        s.dropFrame = rate.drop;
    }
    return s;
};

PR.allSequences = function () {
    var list = [];
    var seqs = PR.safe(function () { return app.project.sequences; }, null);
    var n = PR.safe(function () { return seqs.numSequences; }, 0);
    for (var i = 0; i < n; i++) {
        var s = PR.safe(function () { return seqs[i]; }, null);
        if (s !== null) list.push(s);
    }
    return list;
};

/**
 * The sequence `target` names - its sequenceID, or its name (exact first,
 * then ignoring case) - or the active sequence when `target` is empty.
 * Returns { seq } or { error }.
 */
PR.findSequence = function (target) {
    var all = PR.allSequences();
    if (target === null || target === undefined || String(target).length === 0) {
        var active = PR.safe(function () { return app.project.activeSequence; }, null);
        if (active) return { seq: active };
        return { error: "Nessuna sequenza attiva in Premiere: aprine una nella timeline, oppure indica il nome." };
    }
    var wanted = String(target);
    var i;
    for (i = 0; i < all.length; i++) {
        if (PR.safe(function () { return String(all[i].sequenceID); }, null) === wanted) return { seq: all[i] };
    }
    var exact = [];
    var loose = [];
    for (i = 0; i < all.length; i++) {
        var name = PR.safe(function () { return String(all[i].name); }, "");
        if (name === wanted) exact.push(all[i]);
        else if (name.toLowerCase() === wanted.toLowerCase()) loose.push(all[i]);
    }
    var hits = (exact.length > 0) ? exact : loose;
    if (hits.length === 1) return { seq: hits[0] };
    if (hits.length > 1) {
        return { error: "Ci sono " + hits.length + " sequenze di nome \"" + wanted + "\": indica il sequenceID." };
    }
    return { error: "Sequenza non trovata: \"" + wanted + "\"." };
};

PR.trackItem = function (clip) {
    var entry = {
        name: PR.safe(function () { return String(clip.name); }, null),
        start: PR.seconds(PR.safe(function () { return clip.start; }, null)),
        end: PR.seconds(PR.safe(function () { return clip.end; }, null)),
        inPoint: PR.seconds(PR.safe(function () { return clip.inPoint; }, null)),
        outPoint: PR.seconds(PR.safe(function () { return clip.outPoint; }, null)),
        nodeId: PR.safe(function () { return String(clip.nodeId); }, null),
        selected: PR.safe(function () { return clip.isSelected() === true; }, null),
        disabled: PR.safe(function () { return clip.disabled === true; }, null)
    };
    var speed = PR.safe(function () { return clip.getSpeed(); }, null);
    if (typeof speed === "number" && speed !== 1) entry.speed = PR.round(speed, 4);
    var item = PR.safe(function () { return clip.projectItem; }, null);
    if (item) {
        entry.source = PR.safe(function () { return String(item.name); }, null);
        entry.sourceNodeId = PR.safe(function () { return String(item.nodeId); }, null);
    }
    return entry;
};

/** One track: its state and its clips, at most `maxClips` of them. */
PR.track = function (track, index, maxClips) {
    var out = {
        index: index,
        name: PR.safe(function () { return String(track.name); }, null),
        muted: PR.safe(function () { return track.isMuted() === true; }, null),
        locked: PR.safe(function () { return track.isLocked() === true; }, null),
        clips: [],
        truncated: false
    };
    var clips = PR.safe(function () { return track.clips; }, null);
    var n = PR.safe(function () { return clips.numItems; }, 0);
    out.clipCount = n;
    for (var i = 0; i < n; i++) {
        if (out.clips.length >= maxClips) {
            out.truncated = true;
            break;
        }
        var clip = PR.safe(function () { return clips[i]; }, null);
        if (clip !== null) out.clips.push(PR.trackItem(clip));
    }
    return out;
};

PR.tracks = function (collection, maxClips) {
    var list = [];
    var n = PR.safe(function () { return collection.numTracks; }, 0);
    for (var i = 0; i < n; i++) {
        var t = PR.safe(function () { return collection[i]; }, null);
        if (t !== null) list.push(PR.track(t, i + 1, maxClips));
    }
    return list;
};

/** Markers of a sequence (or of a project item), in time order, at most `max`. */
PR.markers = function (collection, max) {
    var out = { markers: [], truncated: false };
    var count = PR.safe(function () { return collection.numMarkers; }, 0);
    if (count === 0) return out;
    var m = PR.safe(function () { return collection.getFirstMarker(); }, null);
    var guard = 0;
    while (m && guard < count + 1) {
        guard++;
        if (out.markers.length >= max) {
            out.truncated = true;
            break;
        }
        var marker = m;
        var entry = {
            name: PR.safe(function () { return String(marker.name); }, ""),
            comment: PR.safe(function () { return String(marker.comments); }, ""),
            start: PR.seconds(PR.safe(function () { return marker.start; }, null)),
            end: PR.seconds(PR.safe(function () { return marker.end; }, null)),
            type: PR.safe(function () { return String(marker.type); }, null),
            guid: PR.safe(function () { return String(marker.guid); }, null)
        };
        var color = PR.safe(function () { return marker.getColorByIndex(); }, null);
        if (typeof color === "number") entry.colorIndex = color;
        out.markers.push(entry);
        m = PR.safe(function () { return collection.getNextMarker(marker); }, null);
    }
    return out;
};

// --- Undo: every change Claude makes knows how to take itself back --------
// Premiere's scripting has no undo groups, and Ctrl+Z does not take back
// what a script changed (verified on Premiere 26.3.2 with a sequence
// marker). So every operation that changes the project records, step by
// step, how to put things back, and PR.undoLast() replays one whole request
// in reverse - the rule "one request, one undo" kept by Parlez! itself. The
// stack lives in $.global, so it survives the panel being reopened and is
// shared by the pr_undo_last tool and the panel's Annulla button.

PR.UNDO_MAX = 30;

PR.undoStack = function () {
    if (!$.global.PARLEZ_PR_UNDO || typeof $.global.PARLEZ_PR_UNDO.length !== "number") {
        $.global.PARLEZ_PR_UNDO = [];
    }
    return $.global.PARLEZ_PR_UNDO;
};

PR.undoCount = function () {
    return PR.undoStack().length;
};

/** Record one request's steps (each { kind, ... }); nothing when no step was taken. */
PR.pushUndo = function (label, steps) {
    if (!steps || steps.length === 0) return;
    var stack = PR.undoStack();
    stack.push({ t: new Date().getTime(), label: String(label), steps: steps });
    while (stack.length > PR.UNDO_MAX) stack.shift();
};

PR.sequenceById = function (id) {
    var all = PR.allSequences();
    for (var i = 0; i < all.length; i++) {
        if (PR.safe(function () { return String(all[i].sequenceID); }, null) === String(id)) return all[i];
    }
    return null;
};

PR.markerByGuid = function (seq, guid) {
    var markers = PR.safe(function () { return seq.markers; }, null);
    var count = PR.safe(function () { return markers.numMarkers; }, 0);
    var m = PR.safe(function () { return markers.getFirstMarker(); }, null);
    var guard = 0;
    while (m && guard < count + 1) {
        guard++;
        var cur = m;
        if (PR.safe(function () { return String(cur.guid); }, null) === String(guid)) return cur;
        m = PR.safe(function () { return markers.getNextMarker(cur); }, null);
    }
    return null;
};

/** Marker fields Parlez! sets and restores. Times in seconds. */
PR.markerState = function (m) {
    var s = {
        name: PR.safe(function () { return String(m.name); }, ""),
        comment: PR.safe(function () { return String(m.comments); }, ""),
        start: PR.seconds(PR.safe(function () { return m.start; }, null)),
        end: PR.seconds(PR.safe(function () { return m.end; }, null))
    };
    var color = PR.safe(function () { return m.getColorByIndex(); }, null);
    if (typeof color === "number") s.color = color;
    return s;
};

/**
 * Set a Time-valued member (marker start/end, clip in/out...) to `seconds`.
 * Premiere accepts a number of seconds on most builds; when the value does
 * not stick, a Time object is tried. Returns true when it reads back right.
 */
PR.setSeconds = function (obj, prop, seconds, seq) {
    // With a sequence: onto its frame grid, set by ticks first.
    if (seq) {
        seconds = PR.snap(seq, seconds);
        var exact = PR.timeAt(seq, seconds);
        if (exact !== null) {
            try { obj[prop] = exact; } catch (eExact) { /* the number below */ }
        }
    }
    function sticks() {
        var v = PR.seconds(PR.safe(function () { return obj[prop]; }, null));
        return typeof v === "number" && Math.abs(v - seconds) < 0.0005;
    }
    if (sticks()) return true;
    try { obj[prop] = seconds; } catch (eNum) { /* try a Time below */ }
    if (sticks()) return true;
    try {
        var t = new Time();
        t.seconds = seconds;
        obj[prop] = t;
    } catch (eTime) { /* no Time constructor here */ }
    return sticks();
};

/** Apply `state` ({ name?, comment?, start?, end?, color? }) to a marker. */
PR.setMarker = function (m, state) {
    if (typeof state.name === "string") m.name = state.name;
    if (typeof state.comment === "string") m.comments = state.comment;
    var curEnd = PR.seconds(PR.safe(function () { return m.end; }, null));
    // Moving later: the end goes first, so start never passes end on the way.
    if (typeof state.end === "number" && typeof state.start === "number" &&
            typeof curEnd === "number" && state.start > curEnd) {
        PR.setSeconds(m, "end", state.end);
        PR.setSeconds(m, "start", state.start);
    } else {
        if (typeof state.start === "number") PR.setSeconds(m, "start", state.start);
        if (typeof state.end === "number") PR.setSeconds(m, "end", state.end);
    }
    if (typeof state.color === "number") {
        try { m.setColorByIndex(state.color); } catch (eColor) { /* older Premiere: no marker colours */ }
    }
};

/** Take back one recorded step. Returns null when done, else why not. */
PR.undoStep = function (step) {
    var seq;
    var m;
    if (step.kind === "marker.created") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        m = PR.markerByGuid(seq, step.guid);
        if (!m) return "marker gi\u00e0 tolto";
        seq.markers.deleteMarker(m);
        return null;
    }
    if (step.kind === "marker.changed") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        m = PR.markerByGuid(seq, step.guid);
        if (!m) return "marker non trovato";
        PR.setMarker(m, step.before);
        return null;
    }
    if (step.kind === "marker.removed") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        m = seq.markers.createMarker(step.before.start);
        PR.setMarker(m, step.before);
        return null;
    }
    var found;
    if (step.kind === "item.renamed") {
        found = PR.itemByNodeId(step.nodeId);
        if (!found) return "elemento non trovato";
        found.item.name = step.before;
        return null;
    }
    if (step.kind === "item.labeled") {
        found = PR.itemByNodeId(step.nodeId);
        if (!found) return "elemento non trovato";
        found.item.setColorLabel(step.before);
        return null;
    }
    if (step.kind === "item.moved") {
        found = PR.itemByNodeId(step.nodeId);
        if (!found) return "elemento non trovato";
        var rootKey = PR.safe(function () { return String(app.project.rootItem.nodeId); }, null);
        var back = (step.fromBin === "ROOT" || step.fromBin === rootKey)
            ? { item: app.project.rootItem }
            : PR.itemByNodeId(step.fromBin);
        if (!back) return "bin di partenza non trovato";
        found.item.moveBin(back.item);
        return null;
    }
    if (step.kind === "media.released") {
        found = PR.itemByNodeId(step.nodeId);
        if (!found) return "clip non trovata";
        delete PR.releasedMedia()[String(step.nodeId)];
        return PR.relinkMedia(found.item, step.path);
    }
    if (step.kind === "bin.created") {
        found = PR.itemByNodeId(step.nodeId);
        if (!found) return "bin gi\u00e0 tolto";
        var left = PR.safe(function () { return found.item.children.numItems; }, 0);
        if (left > 0) return "il bin creato non \u00e8 vuoto: lasciato al suo posto";
        found.item.deleteBin();
        return null;
    }
    if (step.kind === "trackitems.added") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var gone = 0;
        // Newest last: take them out in reverse, so a ripple closes each gap in turn.
        for (var k = step.nodeIds.length - 1; k >= 0; k--) {
            var hit = PR.trackItemByNodeId(seq, step.nodeIds[k]);
            if (!hit) continue;
            hit.item.remove(step.ripple === true, false);
            gone++;
        }
        return gone > 0 ? null : "clip gi\u00e0 tolte";
    }
    if (step.kind === "trackitem.disabled") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var dis = PR.trackItemByNodeId(seq, step.nodeId);
        if (!dis) return "clip non trovata";
        dis.item.disabled = step.before === true;
        return null;
    }
    if (step.kind === "trackitem.trimmed") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var tr = PR.trackItemByNodeId(seq, step.nodeId);
        if (!tr) return "clip non trovata";
        PR.trimItem(seq, tr.item, step.before.start, step.before.end);
        // The source as it was (trimItem keeps it under the clip; this puts
        // back exactly what was there, stale values included).
        if (typeof step.before.inPoint === "number") PR.setSeconds(tr.item, "inPoint", step.before.inPoint, seq);
        if (typeof step.before.outPoint === "number") PR.setSeconds(tr.item, "outPoint", step.before.outPoint, seq);
        return null;
    }
    if (step.kind === "trackitems.moved") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var back = 0;
        for (var mv = 0; mv < step.nodeIds.length; mv++) {
            var it = PR.trackItemByNodeId(seq, step.nodeIds[mv]);
            if (!it) continue;
            PR.moveBy(it.item, -step.offset);
            back++;
        }
        return back > 0 ? null : "clip non trovate";
    }
    if (step.kind === "track.state") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var tk = PR.trackAt(seq, step.trackKind, step.track);
        if (!tk) return "traccia non trovata";
        PR.setTrackState(tk, step.prop, step.before);
        return null;
    }
    if (step.kind === "transition.added") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var tt = PR.trackAt(seq, step.trackKind, step.track);
        if (!tt) return "traccia non trovata";
        var trs = tt.transitions;
        var nt = PR.safe(function () { return trs.numItems; }, 0);
        for (var ti = 0; ti < nt; ti++) {
            var trn = trs[ti];
            if (Math.abs(PR.seconds(trn.start) - step.start) < 0.05) {
                trn.remove(false, false);
                return null;
            }
        }
        return "transizione gi\u00e0 tolta";
    }
    if (step.kind === "audio.level") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza non trovata";
        var al = PR.trackItemByNodeId(seq, step.nodeId);
        if (!al) return "clip non trovata";
        var lv = PR.volumeLevel(al.item);
        if (lv === null) return "volume non trovato";
        lv.setValue(step.before, true);
        return null;
    }
    if (step.kind === "project.items.created") {
        return PR.deleteProjectItems(step.nodeIds);
    }
    if (step.kind === "sequence.created") {
        seq = PR.sequenceById(step.sequenceID);
        if (!seq) return "sequenza gi\u00e0 tolta";
        app.project.deleteSequence(seq);
        return null;
    }
    return "passo sconosciuto: " + String(step.kind);
};

/**
 * Take back Claude's last change, all of its steps, newest first. Returns
 * { ok, label, undone, failed } or { ok: false, error } when there is
 * nothing to take back.
 */
PR.undoLast = function () {
    var stack = PR.undoStack();
    if (stack.length === 0) return { ok: false, error: "Non c'\u00e8 nessuna modifica di Claude da annullare." };
    var record = stack.pop();
    var undone = 0;
    var failed = [];
    for (var i = record.steps.length - 1; i >= 0; i--) {
        var why;
        try {
            why = PR.undoStep(record.steps[i]);
        } catch (e) {
            why = PR.errText(e);
        }
        if (why === null) undone++;
        else failed.push({ kind: String(record.steps[i].kind), why: why });
    }
    return { ok: true, label: record.label, undone: undone, failed: failed };
};

// --- Project items: find, bins, names, labels -----------------------------

/**
 * Visit every item under the project root, depth first: fn(item, parent,
 * binPath). fn returning true stops the walk.
 */
PR.walkItems = function (fn) {
    function walk(parent, binPath) {
        var children = PR.safe(function () { return parent.children; }, null);
        var n = PR.safe(function () { return children.numItems; }, 0);
        for (var i = 0; i < n; i++) {
            var item = PR.safe(function () { return children[i]; }, null);
            if (item === null) continue;
            if (fn(item, parent, binPath) === true) return true;
            if (PR.itemKind(item) === "bin") {
                var name = PR.safe(function () { return String(item.name); }, "");
                if (walk(item, binPath.length > 0 ? binPath + "/" + name : name) === true) return true;
            }
        }
        return false;
    }
    walk(app.project.rootItem, "");
};

/** nodeId -> media path of the clips pr_media_release set offline, for pr_media_refresh. */
PR.releasedMedia = function () {
    if (!$.global.PARLEZ_PR_RELEASED || typeof $.global.PARLEZ_PR_RELEASED !== "object") $.global.PARLEZ_PR_RELEASED = {};
    return $.global.PARLEZ_PR_RELEASED;
};

/** A media path with forward slashes, lower case: for comparing paths only. */
PR.pathKey = function (p) {
    return String(p).split(String.fromCharCode(92)).join("/").toLowerCase();
};

/**
 * Media clips of the project picked by nodeId and/or by the folder their
 * media sits in (sub-folders too): [{ item, nodeId, path, bin }]. Bins and
 * sequences are never picked.
 */
PR.mediaTargets = function (nodeIds, folder) {
    var out = [];
    var want = {};
    for (var i = 0; i < nodeIds.length; i++) want[String(nodeIds[i])] = true;
    var dir = null;
    if (typeof folder === "string" && folder.length > 0) {
        dir = PR.pathKey(folder);
        if (dir.charAt(dir.length - 1) !== "/") dir += "/";
    }
    PR.walkItems(function (item, parent, binPath) {
        if (PR.itemKind(item) !== "clip") return false;
        var id = String(PR.safe(function () { return item.nodeId; }, ""));
        var media = PR.safe(function () { return String(item.getMediaPath()); }, null);
        var hit = want.hasOwnProperty(id) && want[id] === true;
        if (!hit && dir !== null && media !== null && media.length > 0) {
            var key = PR.pathKey(media);
            hit = key.length > dir.length && key.substring(0, dir.length) === dir;
        }
        if (hit) out.push({ item: item, nodeId: id, path: media, bin: binPath });
        return false;
    });
    return out;
};

/**
 * Put a released clip back on its file and read the file again: Premiere
 * keeps showing frames it has already shown until refreshMedia (2026-11-15).
 * Returns null, or what went wrong in Italian.
 */
PR.relinkMedia = function (item, path) {
    var offline = PR.safe(function () { return item.isOffline() === true; }, false);
    if (offline) {
        if (typeof path !== "string" || path.length === 0) return "non so a quale file ricollegarla";
        var linked = PR.safe(function () { return item.changeMediaPath(path, true); }, false);
        if (linked === false) return "Premiere non l'ha ricollegata a " + path;
    }
    var fresh = PR.safe(function () { item.refreshMedia(); return true; }, false);
    return fresh ? null : "Premiere non ha riletto il file";
};

/** { item, parent, bin } for the item with this nodeId, or null. */
PR.itemByNodeId = function (nodeId) {
    var hit = null;
    PR.walkItems(function (item, parent, binPath) {
        if (PR.safe(function () { return String(item.nodeId); }, null) === String(nodeId)) {
            hit = { item: item, parent: parent, bin: binPath };
            return true;
        }
        return false;
    });
    return hit;
};

/** nodeId of an item's parent bin, "ROOT" for the project root. */
// Premiere hands out a new wrapper object on every read of a member, so two
// references to the same item are never === (found on 26.3.2: undoing a
// move could not find the project root). Items are compared by nodeId.
PR.sameItem = function (a, b) {
    var ka = PR.safe(function () { return String(a.nodeId); }, null);
    var kb = PR.safe(function () { return String(b.nodeId); }, null);
    return ka !== null && ka === kb;
};

PR.isRoot = function (item) {
    return PR.sameItem(item, app.project.rootItem);
};

/** nodeId of an item's parent bin, "ROOT" for the project root. */
PR.parentKey = function (parent) {
    if (PR.isRoot(parent)) return "ROOT";
    return PR.safe(function () { return String(parent.nodeId); }, "ROOT");
};

/**
 * The bin at "A/B/C" under the root, creating what is missing. Every bin
 * created is appended to `created` (its nodeId), so it can be taken back.
 * Returns the bin, or null when a name on the way is a clip, not a bin.
 */
PR.binByPath = function (binPath, created) {
    var parts = String(binPath).split("/");
    var cur = app.project.rootItem;
    for (var p = 0; p < parts.length; p++) {
        var want = parts[p].replace(/^s+|s+$/g, "");
        if (want.length === 0) continue;
        var next = null;
        var children = PR.safe(function () { return cur.children; }, null);
        var n = PR.safe(function () { return children.numItems; }, 0);
        for (var i = 0; i < n; i++) {
            var c = PR.safe(function () { return children[i]; }, null);
            if (c !== null && PR.safe(function () { return String(c.name); }, "") === want) {
                if (PR.itemKind(c) !== "bin") return null;
                next = c;
                break;
            }
        }
        if (next === null) {
            next = cur.createBin(want);
            created.push(String(next.nodeId));
        }
        cur = next;
    }
    return cur;
};

// --- The timeline: what is on it, what a change added ---------------------

/** Every clip on every track: [{ nodeId, kind: "video"|"audio", track, start, end }]. */
PR.timelineItems = function (seq) {
    var out = [];
    function scan(collection, kind) {
        var n = PR.safe(function () { return collection.numTracks; }, 0);
        for (var t = 0; t < n; t++) {
            var track = PR.safe(function () { return collection[t]; }, null);
            var clips = PR.safe(function () { return track.clips; }, null);
            var c = PR.safe(function () { return clips.numItems; }, 0);
            for (var i = 0; i < c; i++) {
                var item = PR.safe(function () { return clips[i]; }, null);
                if (item === null) continue;
                out.push(PR.withTimecode(seq, {
                    nodeId: PR.safe(function () { return String(item.nodeId); }, null),
                    kind: kind,
                    track: t + 1,
                    start: PR.seconds(PR.safe(function () { return item.start; }, null)),
                    end: PR.seconds(PR.safe(function () { return item.end; }, null)),
                    item: item
                }, { start: "position", end: "position" }));
            }
        }
    }
    scan(PR.safe(function () { return seq.videoTracks; }, null), "video");
    scan(PR.safe(function () { return seq.audioTracks; }, null), "audio");
    return out;
};

/** nodeIds in `after` that were not in `before` (both from PR.timelineItems). */
PR.newItems = function (before, after) {
    var seen = {};
    var i;
    for (i = 0; i < before.length; i++) seen["k" + before[i].nodeId] = true;
    var added = [];
    for (i = 0; i < after.length; i++) {
        if (seen.hasOwnProperty("k" + after[i].nodeId)) continue;
        added.push(after[i]);
    }
    return added;
};

PR.trackItemByNodeId = function (seq, nodeId) {
    var all = PR.timelineItems(seq);
    for (var i = 0; i < all.length; i++) {
        if (all[i].nodeId === String(nodeId)) return all[i];
    }
    return null;
};

/** End (seconds) of the last clip on video track n and audio track n, 0 when empty. */
PR.trackEnd = function (seq, n) {
    var all = PR.timelineItems(seq);
    var end = 0;
    for (var i = 0; i < all.length; i++) {
        if (all[i].track === n && typeof all[i].end === "number" && all[i].end > end) end = all[i].end;
    }
    return end;
};

/** Plain description of a clip on the timeline, for answers. */
PR.placed = function (e) {
    var out = {
        nodeId: e.nodeId,
        name: PR.safe(function () { return String(e.item.name); }, null),
        kind: e.kind,
        track: e.track,
        startTC: e.startTC,
        endTC: e.endTC,
        startFrame: e.startFrame,
        endFrame: e.endFrame,
        start: e.start,
        end: e.end
    };
    return out;
};

/** Name of the clip on video track n that `time` falls strictly inside, or null. */
PR.clipAcross = function (seq, n, time) {
    var all = PR.timelineItems(seq);
    for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (e.kind !== "video" || e.track !== n) continue;
        if (typeof e.start === "number" && typeof e.end === "number" && time > e.start + 0.05 && time < e.end - 0.05) {
            return PR.safe(function () { return String(e.item.name); }, "?");
        }
    }
    return null;
};

/**
 * The audio items that belong with a video clip: same source, starting and
 * ending where it does. Premiere 26.3.2's getLinkedItems() answered null,
 * and move() shifts only the item it is called on.
 */
PR.companions = function (seq, e) {
    if (e.kind !== "video") return [];
    var source = PR.safe(function () { return String(e.item.projectItem.nodeId); }, null);
    var all = PR.timelineItems(seq);
    var out = [];
    for (var i = 0; i < all.length; i++) {
        var a = all[i];
        if (a.kind !== "audio") continue;
        if (Math.abs(a.start - e.start) > 0.05 || Math.abs(a.end - e.end) > 0.05) continue;
        var src = PR.safe(function () { return String(a.item.projectItem.nodeId); }, null);
        if (src !== null && src === source) out.push(a);
    }
    return out;
};

/** Name of another clip on e's track overlapping [from, to), or null. */
PR.overlapping = function (seq, e, from, to) {
    var all = PR.timelineItems(seq);
    for (var i = 0; i < all.length; i++) {
        var o = all[i];
        if (o.kind !== e.kind || o.track !== e.track || o.nodeId === e.nodeId) continue;
        if (o.start < to - 0.05 && o.end > from + 0.05) return PR.safe(function () { return String(o.item.name); }, "?");
    }
    return null;
};

/**
 * Shift a track item by `seconds` (Premiere's move takes a Time offset). With
 * a sequence, the offset is a whole number of frames, set by ticks.
 */
PR.moveBy = function (item, seconds, seq) {
    var t = seq ? PR.timeAt(seq, seconds) : null;
    if (t === null) {
        try {
            t = new Time();
            t.seconds = seq ? PR.snap(seq, seconds) : seconds;
        } catch (eTime) {
            t = seq ? PR.snap(seq, seconds) : seconds;
        }
    }
    item.move(t);
};

/**
 * Trim a track item to [start, end] on the timeline, keeping the source
 * under it where it was. Premiere 26.3.2 moved the edge but not the source:
 * a later start cut the END of the source, and inPoint / outPoint went stale
 * (2026-11-15). So the source in and out are set too.
 */
PR.trimItem = function (seq, item, start, end) {
    var oldStart = PR.seconds(PR.safe(function () { return item.start; }, null));
    var oldIn = PR.seconds(PR.safe(function () { return item.inPoint; }, null));
    start = PR.snap(seq, start);
    end = PR.snap(seq, end);
    // Growing to the left first, so start never passes end on the way.
    if (typeof oldStart === "number" && start < oldStart) {
        PR.setSeconds(item, "start", start, seq);
        PR.setSeconds(item, "end", end, seq);
    } else {
        PR.setSeconds(item, "end", end, seq);
        PR.setSeconds(item, "start", start, seq);
    }
    if (typeof oldStart === "number" && typeof oldIn === "number") {
        var newIn = PR.snap(seq, oldIn + (start - oldStart));
        if (newIn < 0) newIn = 0;
        PR.setSeconds(item, "inPoint", newIn, seq);
        PR.setSeconds(item, "outPoint", PR.snap(seq, newIn + (end - start)), seq);
    }
};

/**
 * Seconds as the "HH:MM:SS:FF" timecode Premiere's QE razor takes, counting
 * frames at the nominal rate (24 for 23.976). Non-drop-frame only: a
 * 29.97 drop-frame sequence would be off by a few frames per minute.
 */
PR.timecode = function (seconds, fps) {
    var nominal = Math.round(fps);
    var frames = Math.round(seconds * fps);
    var ff = frames % nominal;
    var totalSeconds = Math.floor(frames / nominal);
    function two(n) { return (n < 10 ? "0" : "") + String(n); }
    return two(Math.floor(totalSeconds / 3600)) + ":" + two(Math.floor(totalSeconds / 60) % 60) + ":" +
        two(totalSeconds % 60) + ":" + two(ff);
};

/** nodeIds of every project item, as a lookup object ("k" + nodeId). */
PR.projectItemIds = function () {
    var ids = {};
    PR.walkItems(function (item) {
        var id = PR.safe(function () { return String(item.nodeId); }, null);
        if (id !== null) ids["k" + id] = true;
        return false;
    });
    return ids;
};

/** nodeIds of project items not in `before` (from PR.projectItemIds). */
PR.newProjectItems = function (before) {
    var out = [];
    PR.walkItems(function (item) {
        var id = PR.safe(function () { return String(item.nodeId); }, null);
        if (id !== null && !before.hasOwnProperty("k" + id)) out.push(id);
        return false;
    });
    return out;
};

/**
 * Delete project items this program created. Premiere's scripting deletes
 * bins (with their content) but not single items, so the items are moved
 * into a bin of their own and that bin is deleted. A created bin is deleted
 * whole only when everything in it was created too; otherwise it stays.
 * Returns null when done, else why not.
 */
PR.deleteProjectItems = function (nodeIds) {
    var mine = {};
    var i;
    for (i = 0; i < nodeIds.length; i++) mine["k" + nodeIds[i]] = true;
    var loose = [];
    var bins = [];
    for (i = 0; i < nodeIds.length; i++) {
        var f = PR.itemByNodeId(nodeIds[i]);
        if (!f) continue;
        var parentMine = mine.hasOwnProperty("k" + PR.safe(function () { return String(f.parent.nodeId); }, ""));
        if (parentMine) continue;
        if (PR.itemKind(f.item) === "bin") bins.push(f.item);
        else loose.push(f.item);
    }
    var kept = 0;
    for (i = 0; i < bins.length; i++) {
        var foreign = false;
        var bin = bins[i];
        PR.walkItems(function (item, parent) {
            if (PR.sameItem(parent, bin) && !mine.hasOwnProperty("k" + PR.safe(function () { return String(item.nodeId); }, ""))) foreign = true;
            return false;
        });
        if (foreign) { kept++; continue; }
        bin.deleteBin();
    }
    if (loose.length > 0) {
        var trash = app.project.rootItem.createBin("Parlez - da togliere");
        for (i = 0; i < loose.length; i++) loose[i].moveBin(trash);
        trash.deleteBin();
    }
    return kept > 0 ? "un bin creato contiene anche altro: lasciato al suo posto" : null;
};

/**
 * Set a text parameter of an After Effects-made template. Its value is
 * either plain text or a JSON document with the text in textEditValue.
 */
PR.setTextParam = function (prop, text) {
    var current = PR.safe(function () { return String(prop.getValue()); }, "");
    var doc = null;
    try {
        doc = JSON.parse(current);
    } catch (eJson) {
        doc = null;
    }
    if (doc !== null && typeof doc === "object" && doc.hasOwnProperty("textEditValue")) {
        doc.textEditValue = text;
        prop.setValue(JSON.stringify(doc), true);
    } else {
        prop.setValue(text, true);
    }
};

// --- Tracks, transitions, volume ------------------------------------------

/** Video or audio track n (1-based), or null. */
PR.trackAt = function (seq, kind, n) {
    var coll = (kind === "audio") ? seq.audioTracks : seq.videoTracks;
    var count = PR.safe(function () { return coll.numTracks; }, 0);
    if (n < 1 || n > count) return null;
    return coll[n - 1];
};

/** Read "muted" / "locked" / "targeted" of a track as a boolean. */
PR.trackState = function (track, prop) {
    if (prop === "muted") return PR.safe(function () { return track.isMuted() === true; }, null);
    if (prop === "locked") return PR.safe(function () { return track.isLocked() === true; }, null);
    if (prop === "targeted") return PR.safe(function () { return track.isTargeted() === true; }, null);
    return null;
};

PR.setTrackState = function (track, prop, on) {
    var v = on ? 1 : 0;
    if (prop === "muted") track.setMute(v);
    else if (prop === "locked") track.setLocked(v);
    else if (prop === "targeted") track.setTargeted(on === true, true);
};

/**
 * The "Level" property of a clip's Volume component. Premiere stores it as
 * an amplitude where 0 dB is about 0.1778: dB = 20 * log10(value) + 15
 * (read on Premiere 26.3.2: 0.17782793939114 at 0 dB).
 */
PR.volumeLevel = function (item) {
    var comps = PR.safe(function () { return item.components; }, null);
    var n = PR.safe(function () { return comps.numItems; }, 0);
    for (var c = 0; c < n; c++) {
        var comp = comps[c];
        if (PR.safe(function () { return String(comp.displayName); }, "") !== "Volume") continue;
        var pn = PR.safe(function () { return comp.properties.numItems; }, 0);
        for (var p = 0; p < pn; p++) {
            var prop = comp.properties[p];
            if (PR.safe(function () { return String(prop.displayName); }, "") === "Level") return prop;
        }
    }
    return null;
};

PR.levelToDb = function (v) {
    if (typeof v !== "number" || v <= 0) return null;
    return PR.round(20 * Math.log(v) / Math.LN10 + 15, 2);
};

PR.dbToLevel = function (db) {
    return Math.pow(10, (db - 15) / 20);
};

/** Start times (seconds) of the transitions on a track. */
PR.transitionStarts = function (track) {
    var out = [];
    var trs = PR.safe(function () { return track.transitions; }, null);
    var n = PR.safe(function () { return trs.numItems; }, 0);
    for (var i = 0; i < n; i++) {
        var s = PR.seconds(PR.safe(function () { return trs[i].start; }, null));
        if (typeof s === "number") out.push(s);
    }
    return out;
};

/**
 * The QE item for timeline entry `e` on QE track `qt`. QE lists a track's
 * items in time order, gaps included as items of their own, so the clip is
 * the one with the same name at the same position among the named ones;
 * null when they disagree.
 */
PR.qeItemFor = function (qt, e) {
    var mine = [];
    var all = PR.timelineItems(PR.safe(function () { return app.project.activeSequence; }, null));
    for (var i = 0; i < all.length; i++) {
        if (all[i].kind === e.kind && all[i].track === e.track) mine.push(all[i]);
    }
    mine.sort(function (a, b) { return a.start - b.start; });
    var index = -1;
    for (i = 0; i < mine.length; i++) if (mine[i].nodeId === e.nodeId) index = i;
    if (index < 0) return null;
    var wanted = PR.safe(function () { return String(e.item.name); }, "");
    var n = PR.safe(function () { return qt.numItems; }, 0);
    var k = -1;
    for (i = 0; i < n; i++) {
        var q = qt.getItemAt(i);
        var qn = PR.safe(function () { return String(q.name); }, "");
        var qtype = PR.safe(function () { return String(q.type); }, "");
        if (qn.length === 0 || qtype === "Empty") continue;
        k++;
        if (k === index) return (qn === wanted) ? q : null;
    }
    return null;
};
