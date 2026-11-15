// The pr_* tools that build sequences and put clips on the timeline. Same
// contract as edit-tools.ts: restore point first, every step recorded so
// pr_undo_last takes the whole request back, confirm for anything that
// destroys. What a change added to the timeline is found by comparing the
// clips on every track before and after (PR.timelineItems / PR.newItems), so
// the undo removes exactly those clips, linked audio included.

import { z } from "zod";

import { defineTool } from "../tools/define-tool.js";
import { runWithCheckpoint } from "./edit-tools.js";

const SEQUENCE_CREATE_CODE = `
    var p = payload;
    var items = [];
    var missing = [];
    var i;
    for (i = 0; i < p.clips.length; i++) {
        var f = PR.itemByNodeId(p.clips[i]);
        var kind = f ? PR.itemKind(f.item) : null;
        if (!f || kind === "bin" || kind === "root") { missing.push(p.clips[i]); continue; }
        items.push(f.item);
    }
    if (items.length === 0) return { ok: false, error: "Nessuna delle clip indicate esiste nel progetto." };
    var createdIds = [];
    var bin = app.project.rootItem;
    if (typeof p.bin === "string" && p.bin.length > 0) {
        bin = PR.binByPath(p.bin, createdIds);
        if (bin === null) return { ok: false, error: p.bin + ": sul percorso c'e' un elemento che non e' un bin" };
    }
    var known = {};
    var all = PR.allSequences();
    for (i = 0; i < all.length; i++) known["k" + PR.safe(function () { return String(all[i].sequenceID); }, "")] = true;
    var seq = app.project.createNewSequenceFromClips(p.name, items, bin);
    if (!seq) {
        all = PR.allSequences();
        for (i = 0; i < all.length; i++) {
            if (!known.hasOwnProperty("k" + PR.safe(function () { return String(all[i].sequenceID); }, ""))) seq = all[i];
        }
    }
    var steps = [];
    for (i = 0; i < createdIds.length; i++) steps.push({ kind: "bin.created", nodeId: createdIds[i] });
    if (!seq) {
        PR.pushUndo("pr_sequence_create", steps);
        return { ok: false, error: "Premiere non ha creato la sequenza." };
    }
    steps.push({ kind: "sequence.created", sequenceID: String(seq.sequenceID) });
    PR.pushUndo("pr_sequence_create", steps);
    var placed = PR.timelineItems(seq);
    var clips = [];
    for (i = 0; i < placed.length; i++) clips.push(PR.placed(placed[i]));
    return {
        sequence: PR.sequenceSummary(seq),
        clips: clips,
        missing: missing,
        undo: "pr_undo_last (o il bottone Annulla del pannello) toglie la sequenza creata"
    };
`;

export const prSequenceCreateTool = defineTool({
  name: "pr_sequence_create",
  title: "Premiere sequence from clips",
  description:
    "Create a new Premiere Pro sequence from project clips (nodeIds from pr_project_info), placed one after " +
    "the other in the order given; the sequence takes its settings from the first clip. Optionally into a bin " +
    "(created when missing). A restore point is taken first; pr_undo_last deletes the new sequence.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    name: z.string().min(1).max(250).describe("Name of the new sequence."),
    clips: z.array(z.string()).min(1).max(500).describe("Project item nodeIds, in timeline order."),
    bin: z.string().max(500).optional().describe('Bin path for the sequence, e.g. "Sequenze".'),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: SEQUENCE_CREATE_CODE,
      payload: { name: args.name, clips: args.clips, bin: args.bin ?? null },
      label: "pr_sequence_create",
    }),
});

const TIMELINE_ADD_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var sid = String(seq.sequenceID);
    var i;
    var c;
    var nTracks = PR.safe(function () { return seq.videoTracks.numTracks; }, 0);
    // Everything is checked before anything changes: a request is refused whole.
    for (i = 0; i < p.clips.length; i++) {
        c = p.clips[i];
        var tn = (typeof c.track === "number") ? c.track : 1;
        if (tn < 1 || tn > nTracks) {
            return { ok: false, error: "La sequenza ha " + nTracks + " tracce video: la traccia V" + tn + " non c'e'." };
        }
        if (!PR.itemByNodeId(c.nodeId)) return { ok: false, error: "Clip non trovata nel progetto: " + c.nodeId };
        if (c.mode !== "insert" && typeof c.time === "number" && c.time < PR.trackEnd(seq, tn) && p.confirm !== true) {
            return {
                ok: false,
                error: "Sovrascrivere a " + c.time + " s sulla traccia V" + tn +
                    " coprirebbe clip che ci sono gia': serve confirm: true, e solo se l'utente l'ha chiesto." +
                    " In alternativa: mode insert (sposta avanti il resto), oppure senza tempo (in coda)."
            };
        }
        // Inserting inside a clip cuts it in two (seen on Premiere 26.3.2); undo
        // takes the new clip out but cannot join the two pieces again.
        var inside = (c.mode === "insert" && typeof c.time === "number") ? PR.clipAcross(seq, tn, c.time) : null;
        if (inside !== null && p.confirm !== true) {
            return {
                ok: false,
                error: "Inserire a " + c.time + " s sulla traccia V" + tn + " taglierebbe in due la clip " + inside +
                    ": serve confirm: true, e solo se l'utente l'ha chiesto. In alternativa scegli un tempo tra due clip."
            };
        }
    }
    var splitNames = [];
    var steps = [];
    var placed = [];
    var problems = [];
    var covered = false;
    for (i = 0; i < p.clips.length; i++) {
        c = p.clips[i];
        var t = (typeof c.track === "number") ? c.track : 1;
        var track = seq.videoTracks[t - 1];
        var source = PR.itemByNodeId(c.nodeId).item;
        var at = PR.snap(seq, (typeof c.time === "number") ? c.time : PR.trackEnd(seq, t));
        if (c.mode !== "insert" && at < PR.trackEnd(seq, t)) covered = true;
        // A piece of the source: in/out on the project item for the placing,
        // put back right after (an item with none reads as 0 / full length).
        var srcIn = null;
        var srcOut = null;
        var usePiece = (typeof c.sourceIn === "number" || typeof c.sourceOut === "number");
        if (usePiece) {
            srcIn = PR.seconds(source.getInPoint());
            srcOut = PR.seconds(source.getOutPoint());
            // On the frame grid. And one frame more on the out: placed with an
            // out point, Premiere 26.3.2 leaves the out frame itself out of
            // the clip (sourceOut 2.002 at 23.976 gave 47 frames, not 48,
            // even on the grid; seen twice on 2026-11-15).
            if (typeof c.sourceIn === "number") source.setInPoint(PR.snap(seq, c.sourceIn), 4);
            if (typeof c.sourceOut === "number") source.setOutPoint(PR.snap(seq, c.sourceOut) + PR.frameSeconds(seq), 4);
        }
        var before = PR.timelineItems(seq);
        // Seconds first; some Premiere builds want a Time object instead.
        var tries = [at];
        var tm = PR.timeAt(seq, at);
        if (tm !== null) tries.push(tm);
        var added = [];
        var lastError = null;
        for (var k = 0; k < tries.length && added.length === 0; k++) {
            try {
                if (c.mode === "insert") track.insertClip(source, tries[k]);
                else track.overwriteClip(source, tries[k]);
            } catch (eAdd) {
                lastError = PR.errText(eAdd);
            }
            added = PR.newItems(before, PR.timelineItems(seq));
        }
        if (usePiece) {
            source.clearInPoint(4);
            source.clearOutPoint(4);
            if (Math.abs(PR.seconds(source.getInPoint()) - srcIn) > 0.001) source.setInPoint(srcIn, 4);
            if (Math.abs(PR.seconds(source.getOutPoint()) - srcOut) > 0.001) source.setOutPoint(srcOut, 4);
        }
        if (added.length === 0) {
            problems.push(String(c.nodeId) + ": " + (lastError || "Premiere non ha messo la clip in timeline"));
            continue;
        }
        // What starts where the clip went is ours; anything else new is a piece
        // of a clip Premiere cut to make room, and it stays on undo.
        var ids = [];
        var startAt = null;
        var a;
        for (a = 0; a < added.length; a++) {
            if (typeof added[a].start === "number" && (startAt === null || added[a].start < startAt)) startAt = added[a].start;
        }
        for (a = 0; a < added.length; a++) {
            if (typeof added[a].start === "number" && Math.abs(added[a].start - startAt) < 0.1) {
                ids.push(added[a].nodeId);
                placed.push(PR.placed(added[a]));
            } else {
                splitNames.push(PR.safe(function () { return String(added[a].item.name); }, "?"));
            }
        }
        steps.push({ kind: "trackitems.added", sequenceID: sid, nodeIds: ids, ripple: c.mode === "insert" });
    }
    PR.pushUndo("pr_timeline_add", steps);
    var undo = null;
    if (steps.length > 0) {
        undo = (covered || splitNames.length > 0)
            ? "pr_undo_last toglie le clip messe; quello che hanno coperto o tagliato torna com'era solo dal punto di ritorno"
            : "pr_undo_last (o il bottone Annulla del pannello) toglie tutte le clip messe";
    }
    return {
        sequence: PR.safe(function () { return String(seq.name); }, null),
        placed: placed,
        split: splitNames,
        problems: problems,
        undo: undo
    };
`;

export const prTimelineAddTool = defineTool({
  name: "pr_timeline_add",
  title: "Premiere: put clips on the timeline",
  description:
    "Put project clips (nodeIds from pr_project_info) on a Premiere Pro sequence's video track (1-based, " +
    "default V1; linked audio follows on its own). Without `time` a clip goes at the end of that track. " +
    'mode "overwrite" (default) lays it over what is there; "insert" pushes everything after it later. ' +
    "sourceIn / sourceOut take only that piece of the clip (seconds into the source). " +
    "Overwriting where there are clips already needs confirm: true, only if the user asked. A restore point " +
    "is taken first; pr_undo_last removes every clip this call put down.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    clips: z
      .array(
        z.object({
          nodeId: z.string().describe("Project item nodeId."),
          time: z
            .number()
            .min(0)
            .optional()
            .describe("Where, in seconds. Omit: at the end of the track."),
          track: z.number().int().min(1).max(99).optional().describe("Video track, 1 = V1."),
          mode: z.enum(["overwrite", "insert"]).optional(),
          sourceIn: z
            .number()
            .min(0)
            .optional()
            .describe("Use the source from here (seconds into the clip)."),
          sourceOut: z
            .number()
            .min(0)
            .optional()
            .describe("Use the source up to here (seconds into the clip)."),
        }),
      )
      .min(1)
      .max(500),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required (true) to overwrite clips already on the timeline; only if the user asked.",
      ),
  },
  handler: async (args, transport) =>
    runWithCheckpoint(transport, {
      code: TIMELINE_ADD_CODE,
      payload: {
        sequence: args.sequence ?? null,
        clips: args.clips,
        confirm: args.confirm === true,
      },
      label: "pr_timeline_add",
    }),
});
