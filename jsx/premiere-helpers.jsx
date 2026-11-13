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

/** Frames per second of a sequence, from its timebase (ticks per frame). */
PR.fps = function (seq) {
    var timebase = PR.safe(function () { return Number(seq.timebase); }, NaN);
    if (typeof timebase === "number" && timebase > 0) return PR.round(PR.TICKS_PER_SECOND / timebase, 3);
    var frame = PR.safe(function () { return seq.getSettings().videoFrameRate.seconds; }, null);
    if (typeof frame === "number" && frame > 0) return PR.round(1 / frame, 3);
    return null;
};

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
    return {
        name: PR.safe(function () { return String(seq.name); }, null),
        sequenceID: PR.safe(function () { return String(seq.sequenceID); }, null),
        width: PR.safe(function () { return Number(seq.frameSizeHorizontal); }, null),
        height: PR.safe(function () { return Number(seq.frameSizeVertical); }, null),
        fps: PR.fps(seq),
        duration: PR.seconds(PR.safe(function () { return seq.end; }, null)),
        videoTracks: PR.safe(function () { return seq.videoTracks.numTracks; }, null),
        audioTracks: PR.safe(function () { return seq.audioTracks.numTracks; }, null)
    };
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
PR.setSeconds = function (obj, prop, seconds) {
    function sticks() {
        var v = PR.seconds(PR.safe(function () { return obj[prop]; }, null));
        return typeof v === "number" && Math.abs(v - seconds) < 0.0005;
    }
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
                out.push({
                    nodeId: PR.safe(function () { return String(item.nodeId); }, null),
                    kind: kind,
                    track: t + 1,
                    start: PR.seconds(PR.safe(function () { return item.start; }, null)),
                    end: PR.seconds(PR.safe(function () { return item.end; }, null)),
                    item: item
                });
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
    return {
        nodeId: e.nodeId,
        name: PR.safe(function () { return String(e.item.name); }, null),
        kind: e.kind,
        track: e.track,
        start: e.start,
        end: e.end
    };
};
