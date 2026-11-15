// pr_mogrt_add: put a Motion Graphics template (.mogrt) on the timeline.
//
// What Premiere 26.3.2 did when probed (13/11/2026):
//   - Sequence.importMGT(path, ticks, videoTrack0, audioTrack0) places it and
//     ALSO adds project items: a "Motion Graphics Template Media" bin with
//     the template's images. Undo must take those away too, so the project
//     items a call creates are found by comparing the project before and
//     after, and undo deletes them (moved into a bin of their own first:
//     Premiere's scripting can delete bins, with what is in them, but not
//     single items);
//   - the templates that ship with Premiere are Premiere-made titles: their
//     text is not reachable from scripting (getMGTComponent() answers null).
//     Only templates made in After Effects expose their text parameters, so
//     `texts` works on those alone. Not verified on a real After Effects
//     template yet: none was available on the test machine.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import { runWithCheckpoint } from "./edit-tools.js";
import { prPosition } from "./timecode.js";

const MOGRT_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var tcErr = PR.timesIn(seq, [p], ["time"], "position");
    if (tcErr) return { ok: false, error: tcErr };
    var sid = String(seq.sequenceID);
    var nTracks = PR.safe(function () { return seq.videoTracks.numTracks; }, 0);
    if (p.track < 1 || p.track > nTracks) {
        return { ok: false, error: "La sequenza ha " + nTracks + " tracce video: la traccia V" + p.track + " non c'e'." };
    }
    var itemsBefore = PR.projectItemIds();
    var before = PR.timelineItems(seq);
    var ticks = String(Math.round(p.time * PR.TICKS_PER_SECOND));
    var clip = seq.importMGT(p.file, ticks, p.track - 1, p.track - 1);
    var added = PR.newItems(before, PR.timelineItems(seq));
    var created = PR.newProjectItems(itemsBefore);
    var steps = [];
    if (created.length > 0) steps.push({ kind: "project.items.created", nodeIds: created });
    var ids = [];
    var placed = [];
    for (var a = 0; a < added.length; a++) {
        ids.push(added[a].nodeId);
        placed.push(PR.placed(added[a]));
    }
    if (ids.length > 0) steps.push({ kind: "trackitems.added", sequenceID: sid, nodeIds: ids, ripple: false });
    PR.pushUndo("pr_mogrt_add", steps);
    if (ids.length === 0) return { ok: false, error: "Premiere non ha messo il modello in timeline." };
    if (!clip) clip = added[0].item;
    var texts = { set: [], missing: [], note: null };
    var wanted = p.texts;
    var names = [];
    for (var key in wanted) { if (wanted.hasOwnProperty(key)) names.push(key); }
    var mgt = PR.safe(function () { return clip.getMGTComponent(); }, null);
    var params = [];
    if (mgt) {
        var n = PR.safe(function () { return mgt.properties.numItems; }, 0);
        for (var i = 0; i < n; i++) params.push(PR.safe(function () { return String(mgt.properties[i].displayName); }, "?"));
    }
    if (names.length > 0) {
        if (!mgt) {
            texts.note = "Questo modello e' un titolo fatto in Premiere: il suo testo non si puo' cambiare da script. Cambialo a mano nel pannello Grafica essenziale.";
            texts.missing = names;
        } else {
            for (var t = 0; t < names.length; t++) {
                var prop = null;
                for (var q = 0; q < n; q++) {
                    if (PR.safe(function () { return String(mgt.properties[q].displayName); }, "") === names[t]) prop = mgt.properties[q];
                }
                if (prop === null) { texts.missing.push(names[t]); continue; }
                PR.setTextParam(prop, wanted[names[t]]);
                texts.set.push(names[t]);
            }
        }
    }
    return {
        sequence: PR.safe(function () { return String(seq.name); }, null),
        placed: placed,
        projectItemsAdded: created.length,
        editableParams: params,
        texts: texts,
        undo: "pr_undo_last (o il bottone Annulla del pannello) toglie il titolo e quello che ha aggiunto al progetto"
    };
`;

export const prMogrtAddTool = defineTool({
  name: "pr_mogrt_add",
  title: "Premiere: add a title template",
  description:
    "Put a Motion Graphics template (.mogrt file) on a Premiere Pro sequence at `time` (timecode HH:MM:SS:FF) on video track " +
    "`track` (1 = V1). `texts` sets text parameters by name - only templates made in After Effects expose " +
    "them; the result lists the editable parameters (empty for Premiere-made titles, whose text the user " +
    "changes in the Essential Graphics panel). Premiere also adds the template's media to the project. A " +
    "restore point is taken first; pr_undo_last removes the title and what it added to the project.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    file: z.string().min(1).describe("Full path of the .mogrt file."),
    time: prPosition("Where the title goes."),
    track: z.number().int().min(1).max(99).optional().describe("Video track, 1 = V1 (default 2)."),
    texts: z
      .record(z.string(), z.string())
      .optional()
      .describe('Text parameters by their name in the template, e.g. { "Titolo": "Benvenuti" }.'),
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
  },
  handler: async (args, transport) => {
    if (path.extname(args.file).toLowerCase() !== ".mogrt") {
      return errorResult("INVALID_ARGS", "Il file deve essere un modello .mogrt.");
    }
    try {
      await fs.access(args.file);
    } catch {
      return errorResult("IO", `Non trovo il modello: ${path.basename(args.file)}.`, {
        hint: "Controlla il percorso completo del file .mogrt.",
      });
    }
    return runWithCheckpoint(transport, {
      code: MOGRT_CODE,
      payload: {
        file: args.file.replace(/\\/g, "/"),
        time: args.time,
        track: args.track ?? 2,
        texts: args.texts ?? {},
        sequence: args.sequence ?? null,
      },
      label: "pr_mogrt_add",
    });
  },
});
