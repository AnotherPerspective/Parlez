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
