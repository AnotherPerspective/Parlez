// More Premiere Pro actions, each verified on Premiere 26.3.2 before being
// written (13/11/2026): importing files and After Effects compositions,
// duplicating and opening sequences, track switches, transitions, clip
// volume. Same contract as edit-tools.ts: restore point first, every step
// recorded for pr_undo_last, nothing deleted without confirm.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool, toMcpResult } from "../tools/define-tool.js";
import { runWithCheckpoint } from "./edit-tools.js";
import { prLength } from "./timecode.js";

const UNDO_NOTE = "pr_undo_last (o il bottone Annulla del pannello) annulla tutta questa richiesta";

/** Absolute, and with backslashes on Windows, the form Premiere's importers expect. */
function forPremiere(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.replace(/\//g, "\\") : abs;
}

/**
 * Images in the numbered series that starts at \`first\` ("Clip B_0000.png"):
 * same name, same extension, same number of digits, consecutive numbers up
 * to the first gap. Null when \`first\` is a folder or has no number.
 */
export async function numberedSeries(first: string): Promise<number | null> {
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(path.basename(first));
  if (!m) return null;
  try {
    if (!(await fs.stat(first)).isFile()) return null;
  } catch {
    return null;
  }
  const prefix = m[1]!;
  const digits = m[2]!;
  const ext = m[3]!;
  const names = new Set((await fs.readdir(path.dirname(first))).map((n) => n.toLowerCase()));
  let n = Number(digits);
  let frames = 0;
  while (names.has(`${prefix}${String(n).padStart(digits.length, "0")}${ext}`.toLowerCase())) {
    frames++;
    n++;
  }
  return frames;
}

const IMPORT_CODE = `
    var p = payload;
    var before = PR.projectItemIds();
    var created = [];
    var bin = app.project.rootItem;
    if (typeof p.bin === "string" && p.bin.length > 0) {
        bin = PR.binByPath(p.bin, created);
        if (bin === null) return { ok: false, error: p.bin + ": sul percorso c'e' un elemento che non e' un bin" };
    }
    var results = {};
    // importAsNumberedStills: the first file of a numbered series becomes one
    // clip with every frame (After Effects renders PNG sequences; Premiere
    // follows when they are written again).
    if (p.files.length > 0) results.files = String(app.project.importFiles(p.files, true, bin, p.numbered === true));
    if (p.aep !== null) {
        results.afterEffects = (p.comps.length > 0)
            ? String(app.project.importAEComps(p.aep, p.comps, bin))
            : String(app.project.importAllAEComps(p.aep, bin));
    }
    var ids = PR.newProjectItems(before);
    PR.pushUndo("pr_import", ids.length > 0 ? [{ kind: "project.items.created", nodeIds: ids }] : []);
    /** Frames counted on disk by the server, the clip's rate as Premiere reads it: duration in timecode. */
    function stillSeries(item, entry) {
        var media = String(PR.safe(function () { return item.getMediaPath(); }, "")).split("\\\\").join("/").toLowerCase();
        var hit = null;
        for (var s = 0; s < p.series.length; s++) {
            var first = p.series[s].first.toLowerCase();
            if (media.length >= first.length && media.substring(media.length - first.length) === first) hit = p.series[s];
            else if (entry.name !== null && entry.name.toLowerCase() === p.series[s].name.toLowerCase()) hit = p.series[s];
        }
        if (hit === null && p.series.length === 1) hit = p.series[0];
        if (hit === null) return;
        var fps = PR.safe(function () { return Number(item.getFootageInterpretation().frameRate); }, NaN);
        entry.frames = hit.frames;
        entry.frameRate = (typeof fps === "number" && !isNaN(fps) && fps > 0) ? PR.round(fps, 3) : null;
        entry.durationTC = (entry.frameRate !== null) ? PR.framesToTc(hit.frames, { base: Math.round(fps), drop: false }) : null;
        entry.durationSeconds = (entry.frameRate !== null) ? PR.round(hit.frames / fps, 3) : null;
    }
    var items = [];
    for (var i = 0; i < ids.length && i < 300; i++) {
        var f = PR.itemByNodeId(ids[i]);
        if (!f) continue;
        var entry = { name: PR.safe(function () { return String(f.item.name); }, null), kind: PR.itemKind(f.item), bin: f.bin, nodeId: ids[i] };
        if (p.numbered === true && entry.kind !== "bin") stillSeries(f.item, entry);
        items.push(entry);
    }
    return { premiere: results, imported: items, count: ids.length, undo: ids.length > 0 ? "${UNDO_NOTE}" : null };
`;

export const prImportTool = defineTool({
  name: "pr_import",
  title: "Premiere: import files and After Effects comps",
  description:
    "Import into the Premiere Pro project: media files or whole folders (`files`, full paths), and/or " +
    "compositions of an After Effects project (`aeProject`, a .aep; `aeComps` names some, omitted = all of " +
    "them, linked through Dynamic Link). Into `bin` (created when missing) or the project root. A restore " +
    "point is taken first; pr_undo_last removes everything this call imported. `numberedStills: true`: each " +
    'file is the first image of a numbered series (e.g. "Clip B_0000.png"), imported as one clip with all its ' +
    "frames; the answer gives its frames and duration in timecode.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    files: z
      .array(z.string().min(1))
      .max(500)
      .optional()
      .describe("Full paths of files or folders."),
    aeProject: z.string().optional().describe("Full path of an After Effects project (.aep)."),
    aeComps: z
      .array(z.string().min(1))
      .max(200)
      .optional()
      .describe("Composition names; omit for all."),
    bin: z.string().max(500).optional().describe('Destination bin path, e.g. "Girato/Giorno 1".'),
    numberedStills: z
      .boolean()
      .optional()
      .describe(
        "Each file is the first image of a numbered series (Clip B_0000.png, _0001, ...): one clip per series.",
      ),
  },
  handler: async (args, transport) => {
    const files = args.files ?? [];
    if (files.length === 0 && !args.aeProject) {
      return errorResult("INVALID_ARGS", "Niente da importare: indica files o aeProject.");
    }
    for (const f of [...files, ...(args.aeProject ? [args.aeProject] : [])]) {
      try {
        await fs.access(f);
      } catch {
        return errorResult("IO", `Non trovo: ${path.basename(f)}.`, {
          hint: "Usa il percorso completo.",
        });
      }
    }
    if (args.aeProject && path.extname(args.aeProject).toLowerCase() !== ".aep") {
      return errorResult("INVALID_ARGS", "aeProject deve essere un progetto After Effects (.aep).");
    }
    const series: Array<{ first: string; name: string; frames: number }> = [];
    if (args.numberedStills === true) {
      for (const f of files) {
        const found = await numberedSeries(f);
        if (found === null) {
          return errorResult(
            "INVALID_ARGS",
            `${path.basename(f)}: per una sequenza di immagini indica il primo file, con il numero prima ` +
              `dell'estensione (es. "Clip B_0000.png").`,
          );
        }
        series.push({ first: path.basename(f), name: path.basename(f), frames: found });
      }
    }
    return runWithCheckpoint(transport, {
      code: IMPORT_CODE,
      payload: {
        files: files.map(forPremiere),
        aep: args.aeProject ? forPremiere(args.aeProject) : null,
        comps: args.aeComps ?? [],
        bin: args.bin ?? null,
        numbered: args.numberedStills === true,
        series,
      },
      label: "pr_import",
      timeoutMs: 300_000,
    });
  },
});

const DUPLICATE_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var known = {};
    var all = PR.allSequences();
    var i;
    for (i = 0; i < all.length; i++) known["k" + String(all[i].sequenceID)] = true;
    found.seq.clone();
    var copy = null;
    all = PR.allSequences();
    for (i = 0; i < all.length; i++) {
        if (!known.hasOwnProperty("k" + String(all[i].sequenceID))) copy = all[i];
    }
    if (!copy) return { ok: false, error: "Premiere non ha duplicato la sequenza." };
    if (typeof p.name === "string" && p.name.length > 0) copy.name = p.name;
    PR.pushUndo("pr_sequence_duplicate", [{ kind: "sequence.created", sequenceID: String(copy.sequenceID) }]);
    return { copy: PR.sequenceSummary(copy), undo: "pr_undo_last toglie la copia" };
`;

export const prSequenceDuplicateTool = defineTool({
  name: "pr_sequence_duplicate",
  title: "Premiere: duplicate a sequence",
  description:
    "Duplicate a Premiere Pro sequence (default the active one), optionally naming the copy - a safe version " +
    "to work on. A restore point is taken first; pr_undo_last removes the copy.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    name: z
      .string()
      .min(1)
      .max(250)
      .optional()
      .describe('Name of the copy (default: Premiere\'s "… Copy").'),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: DUPLICATE_CODE,
      payload: { sequence: args.sequence ?? null, name: args.name ?? null },
      label: "pr_sequence_duplicate",
    }),
});

const OPEN_CODE = `
    var found = PR.findSequence(payload.sequence);
    if (found.error) return { ok: false, error: found.error };
    app.project.openSequence(String(found.seq.sequenceID));
    var act = app.project.activeSequence;
    return { active: act ? String(act.name) : null };
`;

export const prSequenceOpenTool = defineTool({
  name: "pr_sequence_open",
  title: "Premiere: open a sequence",
  description:
    "Open a Premiere Pro sequence in the timeline and make it the active one (the razor and transitions work " +
    "on the active sequence). Changes what the user sees, not the project.",
  group: "premiere",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    sequence: z.string().describe("Sequence name or sequenceID."),
  },
  handler: async (args, transport) =>
    toMcpResult(
      await transport.execute({
        code: OPEN_CODE,
        payload: { sequence: args.sequence },
        label: "pr_sequence_open",
        mutates: false,
      }),
    ),
});

const TRACKS_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var sid = String(seq.sequenceID);
    var i;
    for (i = 0; i < p.tracks.length; i++) {
        if (!PR.trackAt(seq, p.tracks[i].kind, p.tracks[i].index)) {
            return { ok: false, error: "Traccia " + (p.tracks[i].kind === "audio" ? "A" : "V") + p.tracks[i].index + " non trovata." };
        }
    }
    var steps = [];
    var changed = [];
    var props = ["muted", "locked", "targeted"];
    for (i = 0; i < p.tracks.length; i++) {
        var t = p.tracks[i];
        var track = PR.trackAt(seq, t.kind, t.index);
        var entry = { track: (t.kind === "audio" ? "A" : "V") + t.index };
        for (var k = 0; k < props.length; k++) {
            var want = t[props[k]];
            if (typeof want !== "boolean") continue;
            var was = PR.trackState(track, props[k]);
            if (was === want) continue;
            PR.setTrackState(track, props[k], want);
            steps.push({ kind: "track.state", sequenceID: sid, trackKind: t.kind, track: t.index, prop: props[k], before: was === true });
            entry[props[k]] = PR.trackState(track, props[k]);
        }
        changed.push(entry);
    }
    PR.pushUndo("pr_tracks", steps);
    return { changed: changed, undo: steps.length > 0 ? "${UNDO_NOTE}" : null };
`;

export const prTracksTool = defineTool({
  name: "pr_tracks",
  title: "Premiere: mute, lock, target tracks",
  description:
    "Switch Premiere Pro tracks of a sequence (default the active one): `muted`, `locked`, `targeted`, for " +
    "video (V1 = index 1) or audio tracks. A restore point is taken first; pr_undo_last puts them back.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    tracks: z
      .array(
        z.object({
          kind: z.enum(["video", "audio"]),
          index: z.number().int().min(1).max(99),
          muted: z.boolean().optional(),
          locked: z.boolean().optional(),
          targeted: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(100),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: TRACKS_CODE,
      payload: { sequence: args.sequence ?? null, tracks: args.tracks },
      label: "pr_tracks",
    }),
});

const TRANSITION_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var tcErr = PR.timesIn(seq, p.items, ["duration"], "length");
    if (tcErr) return { ok: false, error: tcErr };
    var sid = String(seq.sequenceID);
    var fps = PR.fps(seq);
    // QE works on the active sequence only.
    app.project.openSequence(sid);
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    var steps = [];
    var added = [];
    var problems = [];
    for (var i = 0; i < p.items.length; i++) {
        var it = p.items[i];
        var e = PR.trackItemByNodeId(seq, it.nodeId);
        if (!e) { problems.push(it.nodeId + ": clip non trovata"); continue; }
        var name = (typeof it.name === "string") ? it.name : (e.kind === "audio" ? "Constant Power" : "Cross Dissolve");
        var tr = (e.kind === "audio") ? qe.project.getAudioTransitionByName(name) : qe.project.getVideoTransitionByName(name);
        if (!tr) { problems.push(name + ": transizione non trovata"); continue; }
        var qt = (e.kind === "audio") ? qs.getAudioTrackAt(e.track - 1) : qs.getVideoTrackAt(e.track - 1);
        var q = PR.qeItemFor(qt, e);
        if (q === null) { problems.push(it.nodeId + ": clip non trovata nel QE"); continue; }
        var track = PR.trackAt(seq, e.kind, e.track);
        var beforeStarts = PR.transitionStarts(track);
        q.addTransition(tr, it.at !== "end", PR.timecode(typeof it.duration === "number" ? it.duration : 1, fps));
        var afterStarts = PR.transitionStarts(track);
        var newStart = null;
        for (var a = 0; a < afterStarts.length; a++) {
            var seen = false;
            for (var b = 0; b < beforeStarts.length; b++) if (Math.abs(afterStarts[a] - beforeStarts[b]) < 0.01) seen = true;
            if (!seen) newStart = afterStarts[a];
        }
        if (newStart === null) { problems.push(it.nodeId + ": Premiere non ha aggiunto la transizione"); continue; }
        steps.push({ kind: "transition.added", sequenceID: sid, trackKind: e.kind, track: e.track, start: newStart });
        added.push({ clip: PR.safe(function () { return String(e.item.name); }, null), track: (e.kind === "audio" ? "A" : "V") + e.track, transition: name, start: newStart });
    }
    PR.pushUndo("pr_transition", steps);
    return { added: added, problems: problems, undo: steps.length > 0 ? "${UNDO_NOTE}" : null };
`;

export const prTransitionTool = defineTool({
  name: "pr_transition",
  title: "Premiere: add transitions",
  description:
    "Add a transition at the start (default) or end of clips on a Premiere Pro timeline (track item nodeIds " +
    "from pr_sequence_info): video clips get Cross Dissolve, audio clips Constant Power, unless `name` says " +
    "another Premiere transition. `duration` as a timecode length (default 00:00:01:00). Makes the sequence active (Premiere's " +
    "QE scripting needs it). A restore point is taken first; pr_undo_last removes the transitions.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    items: z
      .array(
        z.object({
          nodeId: z.string().describe("Track item nodeId."),
          at: z.enum(["start", "end"]).optional(),
          duration: prLength("How long the transition lasts (default 00:00:01:00).").optional(),
          name: z.string().optional().describe('Premiere transition name, e.g. "Dip to Black".'),
        }),
      )
      .min(1)
      .max(200),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: TRANSITION_CODE,
      payload: { sequence: args.sequence ?? null, items: args.items },
      label: "pr_transition",
    }),
});

const LEVEL_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var sid = String(seq.sequenceID);
    var steps = [];
    var changed = [];
    var problems = [];
    for (var i = 0; i < p.clips.length; i++) {
        var c = p.clips[i];
        var e = PR.trackItemByNodeId(seq, c.nodeId);
        if (!e) { problems.push(c.nodeId + ": clip non trovata"); continue; }
        // A video clip: its audio companions get the level.
        var targets = (e.kind === "audio") ? [e] : PR.companions(seq, e);
        if (targets.length === 0) { problems.push(c.nodeId + ": nessun audio collegato"); continue; }
        for (var t = 0; t < targets.length; t++) {
            var lv = PR.volumeLevel(targets[t].item);
            if (lv === null) { problems.push(targets[t].nodeId + ": volume non trovato"); continue; }
            var before = Number(lv.getValue());
            lv.setValue(PR.dbToLevel(c.db), true);
            steps.push({ kind: "audio.level", sequenceID: sid, nodeId: targets[t].nodeId, before: before });
            changed.push({ nodeId: targets[t].nodeId, name: PR.safe(function () { return String(targets[t].item.name); }, null), fromDb: PR.levelToDb(before), db: PR.levelToDb(Number(lv.getValue())) });
        }
    }
    PR.pushUndo("pr_audio_level", steps);
    return { changed: changed, problems: problems, undo: steps.length > 0 ? "${UNDO_NOTE}" : null };
`;

export const prAudioLevelTool = defineTool({
  name: "pr_audio_level",
  title: "Premiere: clip volume",
  description:
    "Set the volume of clips on a Premiere Pro timeline, in dB (0 = unchanged, -6 = half as loud). Give audio " +
    "track item nodeIds, or video ones to set the audio that goes with them. A restore point is taken first; " +
    "pr_undo_last puts the old levels back.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    clips: z
      .array(z.object({ nodeId: z.string(), db: z.number().min(-96).max(15) }))
      .min(1)
      .max(500),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: LEVEL_CODE,
      payload: { sequence: args.sequence ?? null, clips: args.clips },
      label: "pr_audio_level",
    }),
});

export const MORE_TOOLS = [
  prImportTool,
  prSequenceDuplicateTool,
  prSequenceOpenTool,
  prTracksTool,
  prTransitionTool,
  prAudioLevelTool,
];
