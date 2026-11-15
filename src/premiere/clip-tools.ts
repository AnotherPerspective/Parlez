// The pr_* tools that change clips already on the timeline: trim, move,
// switch off/on, remove. Same contract as edit-tools.ts.
//
// What Premiere 26.3.2 does (probed on a test sequence, 13/11/2026):
//   - setting a track item's `start` / `end` trims it on the timeline;
//   - `move(Time)` shifts it by an offset, but ONLY that item: its audio stays
//     where it was and falls out of sync;
//   - getLinkedItems() is not reliable (it answered null).
// So a clip's audio is found as its companion: the audio item with the same
// source that starts and ends where the video does (PR.companions), and every
// trim or move is applied to the video and its companions together.

import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import { runWithCheckpoint } from "./edit-tools.js";
import { prPosition } from "./timecode.js";

const CLIP_EDIT_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var tcErr = PR.timesIn(seq, p.clips, ["start", "end", "moveTo"], "position");
    if (tcErr) return { ok: false, error: tcErr };
    var sid = String(seq.sequenceID);
    var i;
    var c;
    var e;
    // Checked before anything changes: a request is refused whole.
    for (i = 0; i < p.clips.length; i++) {
        c = p.clips[i];
        e = PR.trackItemByNodeId(seq, c.nodeId);
        if (!e) return { ok: false, error: "Clip non trovata nella sequenza: " + c.nodeId };
        var newStart = (typeof c.start === "number") ? PR.snap(seq, c.start) : e.start;
        var newEnd = (typeof c.end === "number") ? PR.snap(seq, c.end) : e.end;
        if (newEnd <= newStart) return { ok: false, error: "La clip " + c.nodeId + " finirebbe prima di cominciare." };
        if (typeof c.moveTo === "number") c.moveTo = PR.snap(seq, c.moveTo);
        if (typeof c.moveTo === "number") {
            // Premiere 26.3.2: a clip moved with move() across or onto another
            // clip on its track leaves the track out of order, and a clip then
            // renders black or hangs the export. Only moves through empty
            // space are safe, so anything else is refused, confirm or not.
            var len = newEnd - newStart;
            var from = Math.min(e.start, c.moveTo);
            var to = Math.max(e.end, c.moveTo + len);
            var other = PR.overlapping(seq, e, from, to);
            if (other !== null) {
                return {
                    ok: false,
                    error: "Spostare la clip a " + c.moveTo + " s la farebbe passare sopra " + other +
                        ": in Premiere 26.3.2 uno spostamento cosi' rovina la traccia (clip nere o esportazione bloccata)." +
                        " Si possono spostare clip solo dentro uno spazio vuoto. Per cambiare l'ordine: togli la clip" +
                        " (pr_clip_remove) e rimettila dove serve (pr_timeline_add)."
                };
            }
        }
    }
    var steps = [];
    var changed = [];
    for (i = 0; i < p.clips.length; i++) {
        c = p.clips[i];
        e = PR.trackItemByNodeId(seq, c.nodeId);
        var group = [e].concat(PR.companions(seq, e));
        var g;
        if (typeof c.enabled === "boolean") {
            var was = e.item.disabled === true;
            e.item.disabled = !c.enabled;
            steps.push({ kind: "trackitem.disabled", sequenceID: sid, nodeId: e.nodeId, before: was });
        }
        if (typeof c.start === "number" || typeof c.end === "number") {
            for (g = 0; g < group.length; g++) {
                var it = group[g].item;
                var before = {
                    start: group[g].start,
                    end: group[g].end,
                    inPoint: PR.seconds(PR.safe(function () { return it.inPoint; }, null)),
                    outPoint: PR.seconds(PR.safe(function () { return it.outPoint; }, null))
                };
                PR.trimItem(seq, it,
                    (typeof c.start === "number") ? PR.snap(seq, c.start) : group[g].start,
                    (typeof c.end === "number") ? PR.snap(seq, c.end) : group[g].end);
                steps.push({ kind: "trackitem.trimmed", sequenceID: sid, nodeId: group[g].nodeId, before: before });
            }
        }
        if (typeof c.moveTo === "number") {
            var now = PR.trackItemByNodeId(seq, c.nodeId);
            var offset = c.moveTo - now.start;
            var ids = [];
            for (g = 0; g < group.length; g++) {
                PR.moveBy(group[g].item, offset, seq);
                ids.push(group[g].nodeId);
            }
            steps.push({ kind: "trackitems.moved", sequenceID: sid, nodeIds: ids, offset: offset });
        }
        var after = PR.trackItemByNodeId(seq, c.nodeId);
        var entry = PR.placed(after);
        entry.audioMovedWith = group.length - 1;
        entry.enabled = after.item.disabled !== true;
        changed.push(entry);
    }
    PR.pushUndo("pr_clip_edit", steps);
    return {
        sequence: PR.safe(function () { return String(seq.name); }, null),
        changed: changed,
        undo: steps.length > 0 ? "pr_undo_last (o il bottone Annulla del pannello) annulla tutta questa richiesta" : null
    };
`;

export const prClipEditTool = defineTool({
  name: "pr_clip_edit",
  title: "Premiere: trim, move, switch clips",
  description:
    "Change clips already on a Premiere Pro timeline (track item nodeIds from pr_sequence_info): `start` / " +
    "`end` trim where the clip begins and ends on the timeline (timecode HH:MM:SS:FF); `moveTo` moves it so it begins " +
    "there, only through empty space (Premiere 26.3.2 breaks a clip moved across or onto others: to reorder, " +
    "remove it and put it back with pr_timeline_add); `enabled` switches it off or on. The clip's audio " +
    "(same source, same position) is trimmed and moved with it, so they stay in sync. A restore point is " +
    "taken first; pr_undo_last puts everything back.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    clips: z
      .array(
        z.object({
          nodeId: z.string().describe("Track item nodeId, from pr_sequence_info."),
          start: prPosition("New start on the timeline (trims the head).").optional(),
          end: prPosition("New end on the timeline (trims the tail).").optional(),
          moveTo: prPosition("Move the clip so it begins here.").optional(),
          enabled: z.boolean().optional().describe("false switches the clip off, true on."),
        }),
      )
      .min(1)
      .max(500),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: CLIP_EDIT_CODE,
      payload: {
        sequence: args.sequence ?? null,
        clips: args.clips,
      },
      label: "pr_clip_edit",
    }),
});

const CLIP_REMOVE_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var removed = [];
    var missing = [];
    for (var i = 0; i < p.clips.length; i++) {
        var e = PR.trackItemByNodeId(seq, p.clips[i]);
        if (!e) { missing.push(p.clips[i]); continue; }
        var group = [e].concat(p.withAudio ? PR.companions(seq, e) : []);
        for (var g = 0; g < group.length; g++) {
            removed.push(PR.placed(group[g]));
            group[g].item.remove(p.ripple === true, false);
        }
    }
    return {
        sequence: PR.safe(function () { return String(seq.name); }, null),
        removed: removed,
        missing: missing,
        undo: removed.length > 0
            ? "pr_undo_last non rimette le clip tolte: si torna indietro solo dal punto di ritorno"
            : null
    };
`;

export const prClipRemoveTool = defineTool({
  name: "pr_clip_remove",
  title: "Premiere: remove clips from the timeline",
  description:
    "Remove clips from a Premiere Pro timeline (track item nodeIds from pr_sequence_info), with their audio " +
    "unless withAudio is false; ripple closes the gap. Needs confirm: true, passed only when the user asked " +
    "to remove them. The project items stay in the project. pr_undo_last cannot put removed clips back: the " +
    "restore point taken first is the way back, so say so before removing.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    clips: z.array(z.string()).min(1).max(500).describe("Track item nodeIds."),
    ripple: z.boolean().optional().describe("Close the gap left behind (default false)."),
    withAudio: z.boolean().optional().describe("Remove the clip's audio too (default true)."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required (true); pass it only when the user asked to remove these clips."),
  },
  handler: async (args, transport) => {
    if (args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        `Togliere ${args.clips.length} clip dalla timeline cancella qualcosa che pr_undo_last non rimette: ` +
          "serve confirm: true, e solo se l'utente l'ha chiesto.",
        {
          hint: "Dì all'utente quali clip togli e che si torna indietro solo dal punto di ritorno; poi confirm: true.",
        },
      );
    }
    return runWithCheckpoint(transport, {
      code: CLIP_REMOVE_CODE,
      payload: {
        sequence: args.sequence ?? null,
        clips: args.clips,
        ripple: args.ripple === true,
        withAudio: args.withAudio !== false,
      },
      label: "pr_clip_remove",
    });
  },
});

const RAZOR_CODE = `
    var p = payload;
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: "Nessuna sequenza attiva in Premiere: la lametta lavora sulla sequenza aperta nella timeline." };
    if (p.sequence !== null && String(seq.name) !== p.sequence && String(seq.sequenceID) !== p.sequence) {
        return { ok: false, error: "La lametta lavora solo sulla sequenza attiva, che ora e' " + String(seq.name) + ": chiedi all'utente di aprire " + p.sequence + " nella timeline." };
    }
    var fps = PR.fps(seq);
    if (typeof fps !== "number" || fps <= 0) return { ok: false, error: "Non riesco a leggere i fotogrammi al secondo della sequenza." };
    var tcErr = PR.timesIn(seq, [p], ["time"], "position");
    if (tcErr) return { ok: false, error: tcErr };
    var tc = PR.timecode(p.time, fps);
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    var before = PR.timelineItems(seq);
    var cut = [];
    var kinds = ["video", "audio"];
    for (var k = 0; k < kinds.length; k++) {
        var coll = (kinds[k] === "video") ? seq.videoTracks : seq.audioTracks;
        var n = PR.safe(function () { return coll.numTracks; }, 0);
        for (var t = 0; t < n; t++) {
            var across = false;
            for (var b = 0; b < before.length; b++) {
                var e = before[b];
                if (e.kind === kinds[k] && e.track === t + 1 && p.time > e.start + 0.05 && p.time < e.end - 0.05) across = true;
            }
            if (!across) continue;
            var qt = (kinds[k] === "video") ? qs.getVideoTrackAt(t) : qs.getAudioTrackAt(t);
            qt.razor(tc);
            cut.push((kinds[k] === "video" ? "V" : "A") + (t + 1));
        }
    }
    var pieces = PR.newItems(before, PR.timelineItems(seq));
    return {
        sequence: String(seq.name),
        timecode: tc,
        tracksCut: cut,
        newPieces: pieces.length,
        undo: cut.length > 0 ? "pr_undo_last non riunisce i pezzi: si torna indietro solo dal punto di ritorno" : null
    };
`;

export const prRazorTool = defineTool({
  name: "pr_razor",
  title: "Premiere: cut clips at a time",
  description:
    "Cut (razor) every clip that crosses `time` (timecode HH:MM:SS:FF) on the ACTIVE Premiere Pro sequence, video and " +
    "audio together. Uses Premiere's undocumented QE scripting. Needs confirm: true, only if the user asked: " +
    "pr_undo_last cannot join the pieces again, only the restore point taken first can.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    time: prPosition("Where to cut."),
    sequence: z
      .string()
      .optional()
      .describe(
        "Name or sequenceID, only to check it is the active one (the cut is always on the active sequence).",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe("Required (true); only if the user asked for the cut."),
  },
  handler: async (args, transport) => {
    if (args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        "Tagliare con la lametta non si annulla con pr_undo_last: serve confirm: true, e solo se l'utente l'ha chiesto.",
        {
          hint: "Dì all'utente dove tagli e che si torna indietro solo dal punto di ritorno; poi confirm: true.",
        },
      );
    }
    return runWithCheckpoint(transport, {
      code: RAZOR_CODE,
      payload: { time: args.time, sequence: args.sequence ?? null },
      label: "pr_razor",
    });
  },
});
