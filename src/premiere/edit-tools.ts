// The pr_* tools that change a Premiere Pro project.
//
// Every one of them follows the same three rules, because Premiere's own
// Ctrl+Z does not take back what a script changed (verified on 26.3.2):
//   1. before anything changes, the saved project file is copied to a
//      restore point (checkpoint.ts);
//   2. the generated code records how to take back every step it took
//      (PR.pushUndo, jsx/premiere-helpers.jsx), so pr_undo_last - or the
//      panel's Annulla button - takes back the whole request at once;
//   3. anything that deletes needs `confirm: true`, passed only when the
//      user asked for it.
// Bulk arguments travel as `payload`, never inlined into the generated code.

import { z } from "zod";

import { errorResult } from "../errors.js";
import type { AeTransport, EvalRequest } from "../transport/AeTransport.js";
import { defineTool, toMcpResult } from "../tools/define-tool.js";
import type { ToolResult } from "../tools/types.js";
import { ensurePremiereCheckpoint } from "./checkpoint.js";
import { isPremierePaused, isPremiereReadOnly } from "./transport.js";

/**
 * Run a changing request behind a restore point. When the copy cannot be
 * made, nothing is sent and nothing changes.
 */
export async function runWithCheckpoint(
  transport: AeTransport,
  req: EvalRequest,
): Promise<ToolResult> {
  let checkpoint: { file: string; created: boolean } | null = null;
  const target = transport.describeTarget ? await transport.describeTarget() : null;
  if (
    target?.mode === "pull" &&
    !isPremierePaused(target.instance) &&
    !isPremiereReadOnly(target.instance)
  ) {
    const project = target.instance.heartbeat?.project ?? null;
    if (!project) {
      return errorResult(
        "OPERATION_FAILED",
        "Premiere non dice dove è salvato il progetto: non posso fare il punto di ritorno, quindi non ho cambiato niente.",
        { hint: "Chiedi all'utente di salvare il progetto (File › Salva) e riprova." },
      );
    }
    try {
      checkpoint = await ensurePremiereCheckpoint(project, req.label ?? "modifica");
    } catch (err) {
      return errorResult(
        "IO",
        `Non ho potuto creare il punto di ritorno (${err instanceof Error ? err.message : String(err)}): non ho cambiato niente.`,
        {
          hint: "Controlla che la cartella del progetto sia scrivibile, oppure imposta AE_MCP_CHECKPOINT_DIR.",
        },
      );
    }
  }
  const result = toMcpResult(await transport.execute({ ...req, mutates: true }));
  if (checkpoint !== null && result.structuredContent && result.isError !== true) {
    result.structuredContent.checkpoint = checkpoint;
    result.content = [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }];
  }
  return result;
}

const MARKER_COLOR = z
  .number()
  .int()
  .min(0)
  .max(7)
  .describe(
    "Marker colour index: 0 green, 1 red, 2 purple, 3 orange, 4 yellow, 5 white, 6 blue, 7 cyan.",
  );

const MARKERS_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var sid = String(seq.sequenceID);
    var steps = [];
    var added = [];
    var updated = [];
    var removed = [];
    var missing = [];
    var i;
    var m;
    var st;
    function entry(marker) {
        var s = PR.markerState(marker);
        s.guid = PR.safe(function () { return String(marker.guid); }, null);
        return s;
    }
    for (i = 0; i < p.remove.length; i++) {
        m = PR.markerByGuid(seq, p.remove[i]);
        if (!m) { missing.push(p.remove[i]); continue; }
        var gone = PR.markerState(m);
        seq.markers.deleteMarker(m);
        steps.push({ kind: "marker.removed", sequenceID: sid, before: gone });
        removed.push(gone);
    }
    for (i = 0; i < p.update.length; i++) {
        var u = p.update[i];
        m = PR.markerByGuid(seq, u.guid);
        if (!m) { missing.push(u.guid); continue; }
        var before = PR.markerState(m);
        st = { name: u.name, comment: u.comment, color: u.color };
        var start = (typeof u.time === "number") ? u.time : before.start;
        if (typeof u.time === "number") st.start = u.time;
        if (typeof u.duration === "number") st.end = start + u.duration;
        else if (typeof u.time === "number" && typeof before.end === "number") st.end = u.time + (before.end - before.start);
        PR.setMarker(m, st);
        steps.push({ kind: "marker.changed", sequenceID: sid, guid: String(u.guid), before: before });
        updated.push(entry(m));
    }
    for (i = 0; i < p.add.length; i++) {
        var a = p.add[i];
        m = seq.markers.createMarker(a.time);
        steps.push({ kind: "marker.created", sequenceID: sid, guid: String(m.guid) });
        st = { name: a.name, comment: a.comment, color: a.color };
        if (typeof a.duration === "number" && a.duration > 0) st.end = a.time + a.duration;
        PR.setMarker(m, st);
        added.push(entry(m));
    }
    PR.pushUndo("pr_markers", steps);
    return {
        sequence: PR.safe(function () { return String(seq.name); }, null),
        added: added,
        updated: updated,
        removed: removed,
        missing: missing,
        undo: steps.length > 0 ? "pr_undo_last (o il bottone Annulla del pannello) annulla tutta questa richiesta" : null
    };
`;

export const prMarkersTool = defineTool({
  name: "pr_markers",
  title: "Premiere sequence markers",
  description:
    "Add, change or remove markers on a Premiere Pro sequence (default: the active one), in one request. " +
    "Times in seconds. `add` creates markers (name, comment, colour, optional duration); `update` changes " +
    "markers by guid (from pr_sequence_info); `remove` deletes markers by guid and needs confirm: true, " +
    "passed only when the user asked to delete them. A restore point is taken first; pr_undo_last takes " +
    "the whole request back (Premiere's own Ctrl+Z does not).",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    add: z
      .array(
        z.object({
          time: z.number().min(0).describe("Where, in seconds from the start of the sequence."),
          duration: z
            .number()
            .min(0)
            .optional()
            .describe("Length in seconds (0 or omitted: a point)."),
          name: z.string().max(500).optional(),
          comment: z.string().max(5000).optional(),
          color: MARKER_COLOR.optional(),
        }),
      )
      .max(1000)
      .optional(),
    update: z
      .array(
        z.object({
          guid: z.string().describe("The marker's guid, from pr_sequence_info."),
          time: z.number().min(0).optional(),
          duration: z.number().min(0).optional(),
          name: z.string().max(500).optional(),
          comment: z.string().max(5000).optional(),
          color: MARKER_COLOR.optional(),
        }),
      )
      .max(1000)
      .optional(),
    remove: z.array(z.string()).max(1000).optional().describe("Guids of markers to delete."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required (true) to remove markers; pass it only when the user asked for the deletion.",
      ),
  },
  handler: async (args, transport) => {
    const add = args.add ?? [];
    const update = args.update ?? [];
    const remove = args.remove ?? [];
    if (add.length + update.length + remove.length === 0) {
      return errorResult("INVALID_ARGS", "Niente da fare: indica add, update o remove.");
    }
    if (remove.length > 0 && args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        `Togliere ${remove.length} marker cancella qualcosa: serve confirm: true, e solo se l'utente l'ha chiesto.`,
        {
          hint: "Chiedi all'utente se vuole davvero togliere quei marker, poi richiama con confirm: true.",
        },
      );
    }
    return runWithCheckpoint(transport, {
      code: MARKERS_CODE,
      payload: { sequence: args.sequence ?? null, add, update, remove },
      label: "pr_markers",
    });
  },
});

export const prUndoLastTool = defineTool({
  name: "pr_undo_last",
  title: "Undo Claude's last Premiere change",
  description:
    "Take back Claude's last change in Premiere Pro - the whole request, all its steps - the way the panel's " +
    "Annulla button does. Use this instead of Premiere's Ctrl+Z, which does not undo script changes. " +
    "Each call takes back one more request, newest first.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {},
  handler: async (_args, transport) =>
    toMcpResult(
      await transport.execute({
        code: "return PR.undoLast();",
        label: "pr_undo_last",
        mutates: true,
      }),
    ),
});

const BINS_CODE = `
    var p = payload;
    var createdIds = [];
    var moveSteps = [];
    var moved = [];
    var missing = [];
    var problems = [];
    var i;
    for (i = 0; i < p.create.length; i++) {
        if (PR.binByPath(p.create[i], createdIds) === null) {
            problems.push(p.create[i] + ": sul percorso c'e' un elemento che non e' un bin");
        }
    }
    for (i = 0; i < p.move.length; i++) {
        var mv = p.move[i];
        var found = PR.itemByNodeId(mv.nodeId);
        if (!found) { missing.push(mv.nodeId); continue; }
        var target = PR.binByPath(mv.bin, createdIds);
        if (target === null) {
            problems.push(mv.bin + ": sul percorso c'e' un elemento che non e' un bin");
            continue;
        }
        if (PR.sameItem(found.parent, target)) continue;
        var from = PR.parentKey(found.parent);
        found.item.moveBin(target);
        moveSteps.push({ kind: "item.moved", nodeId: String(mv.nodeId), fromBin: from });
        moved.push({ name: PR.safe(function () { return String(found.item.name); }, null), from: found.bin, to: mv.bin });
    }
    // Bins first: taken back last, once the items moved into them are out again.
    var steps = [];
    for (i = 0; i < createdIds.length; i++) steps.push({ kind: "bin.created", nodeId: createdIds[i] });
    for (i = 0; i < moveSteps.length; i++) steps.push(moveSteps[i]);
    PR.pushUndo("pr_bins", steps);
    return {
        binsCreated: createdIds.length,
        moved: moved,
        missing: missing,
        problems: problems,
        undo: steps.length > 0 ? "pr_undo_last (o il bottone Annulla del pannello) annulla tutta questa richiesta" : null
    };
`;

export const prBinsTool = defineTool({
  name: "pr_bins",
  title: "Premiere bins",
  description:
    'Organise the Premiere Pro project panel: create bins (paths like "Girato/Interviste", missing levels are ' +
    "created) and move items (clips, sequences, bins - by nodeId from pr_project_info) into a bin, which is " +
    "created when missing. Nothing is renamed or deleted. A restore point is taken first; pr_undo_last moves " +
    "everything back and removes the bins it created (if empty).",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    create: z
      .array(z.string().min(1).max(500))
      .max(200)
      .optional()
      .describe("Bin paths to create."),
    move: z
      .array(
        z.object({
          nodeId: z.string().describe("The item's nodeId, from pr_project_info."),
          bin: z
            .string()
            .min(1)
            .max(500)
            .describe('Destination bin path, e.g. "Girato/Interviste".'),
        }),
      )
      .max(2000)
      .optional(),
  },
  handler: async (args, transport) => {
    const create = args.create ?? [];
    const move = args.move ?? [];
    if (create.length + move.length === 0) {
      return errorResult("INVALID_ARGS", "Niente da fare: indica create o move.");
    }
    return runWithCheckpoint(transport, {
      code: BINS_CODE,
      payload: { create, move },
      label: "pr_bins",
    });
  },
});

const RENAME_CODE = `
    var p = payload;
    var steps = [];
    var changed = [];
    var missing = [];
    for (var i = 0; i < p.items.length; i++) {
        var it = p.items[i];
        var found = PR.itemByNodeId(it.nodeId);
        if (!found) { missing.push(it.nodeId); continue; }
        var entry = { nodeId: String(it.nodeId) };
        if (typeof it.name === "string") {
            var before = String(found.item.name);
            if (before !== it.name) {
                found.item.name = it.name;
                steps.push({ kind: "item.renamed", nodeId: String(it.nodeId), before: before });
                entry.from = before;
                entry.name = it.name;
            }
        }
        if (typeof it.label === "number") {
            var was = PR.safe(function () { return found.item.getColorLabel(); }, null);
            if (was !== it.label) {
                found.item.setColorLabel(it.label);
                if (typeof was === "number") steps.push({ kind: "item.labeled", nodeId: String(it.nodeId), before: was });
                entry.label = it.label;
            }
        }
        changed.push(entry);
    }
    PR.pushUndo("pr_rename_items", steps);
    return {
        changed: changed,
        missing: missing,
        undo: steps.length > 0 ? "pr_undo_last (o il bottone Annulla del pannello) annulla tutta questa richiesta" : null
    };
`;

export const prRenameItemsTool = defineTool({
  name: "pr_rename_items",
  title: "Premiere item names and labels",
  description:
    "Rename Premiere Pro project items (clips, bins, sequences - by nodeId from pr_project_info) and/or set " +
    "their colour label (0-15, Premiere's label order). Renaming needs confirm: true and is done ONLY when the " +
    "user asked for those names; colour labels need no confirm. A restore point is taken first; pr_undo_last " +
    "puts back the old names and labels.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    items: z
      .array(
        z.object({
          nodeId: z.string(),
          name: z.string().min(1).max(500).optional(),
          label: z.number().int().min(0).max(15).optional(),
        }),
      )
      .min(1)
      .max(2000),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required (true) when any name changes; pass it only when the user asked for the renaming.",
      ),
  },
  handler: async (args, transport) => {
    const renames = args.items.filter((i) => typeof i.name === "string").length;
    if (renames > 0 && args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        `Rinominare ${renames} elementi cambia nomi che l'utente usa: serve confirm: true, e solo se l'utente l'ha chiesto.`,
        {
          hint: "Mostra all'utente i nomi vecchi e nuovi, chiedi l'ok, poi richiama con confirm: true.",
        },
      );
    }
    return runWithCheckpoint(transport, {
      code: RENAME_CODE,
      payload: { items: args.items },
      label: "pr_rename_items",
    });
  },
});
