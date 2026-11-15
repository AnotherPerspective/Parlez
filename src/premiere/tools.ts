// The MCP tools for Premiere Pro (pr_*). Read-only for now: what is in the
// project, what is in a sequence. The actions that change a project come
// once the list is agreed with the maintainer.
//
// The generated code runs inside Premiere through jsx/premiere-agent.jsx,
// with the PR.* helpers of jsx/premiere-helpers.jsx in scope. Same rules as
// the After Effects side: ES3 only, every argument through jsxVal.

import * as path from "node:path";
import { z } from "zod";

import { jsxVal } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { instanceLabel } from "../transport/instances.js";
import { defineTool, jsonResult, toMcpResult } from "../tools/define-tool.js";
import type { AnyTool } from "../tools/index.js";
import { PREMIERE_INSTANCES_DIR } from "./config.js";
import {
  PREMIERE_INSTANCE_ENV,
  isPremierePaused,
  isPremiereReadOnly,
  livePremiereInstances,
  resolvePremiereTarget,
} from "./transport.js";
import {
  prBinsTool,
  prMarkersTool,
  prRenameItemsTool,
  prSaveProjectTool,
  prUndoLastTool,
} from "./edit-tools.js";
import { prSequenceCreateTool, prTimelineAddTool } from "./timeline-tools.js";
import { prClipEditTool, prClipRemoveTool, prRazorTool } from "./clip-tools.js";
import { prProjectCheckTool } from "./check-tools.js";
import { prMogrtAddTool } from "./title-tools.js";
import { prExportTool, prFrameTool } from "./export-tools.js";
import {
  prAudioLevelTool,
  prImportTool,
  prMediaRefreshTool,
  prMediaReleaseTool,
  prSequenceDuplicateTool,
  prSequenceOpenTool,
  prTracksTool,
  prTransitionTool,
} from "./more-tools.js";
import { prAutoReframeTool, prCaptionsTool, prExportInterchangeTool } from "./deliver-tools.js";

const PREMIERE_INSTANCE_PARAM = z
  .string()
  .optional()
  .describe(
    "Premiere Pro to address when several are connected: its id (pr-…) or the name of the project " +
      `it has open. Omit to use the only one connected (or ${PREMIERE_INSTANCE_ENV}).`,
  );

function bindPremiere(transport: AeTransport, instance: unknown): AeTransport {
  const named = typeof instance === "string" ? instance.trim() : "";
  if (!named) return transport;
  return {
    execute: (req) => transport.execute({ instance: named, ...req }),
    // The restore point needs to know which project the call will touch.
    describeTarget: () => resolvePremiereTarget(named, PREMIERE_INSTANCES_DIR),
    ...(transport.close ? { close: () => transport.close!() } : {}),
  };
}

const RULES = [
  "Premiere Pro è comandato attraverso il pannello Parlez! (Finestra › Estensioni): se è chiuso o su OFF, Claude è fermo.",
  "Leggere: pr_project_info (progetto), pr_sequence_info (sequenze, tracce, clip, marker).",
  "Ctrl+Z di Premiere NON annulla le modifiche di Claude: per tornare indietro usa pr_undo_last, che annulla tutta l'ultima richiesta. Prima di ogni modifica Parlez! copia il progetto salvato in _parlez-checkpoints.",
  "Cancellare qualcosa richiede confirm: true, da passare solo se l'utente l'ha chiesto.",
  "I tempi sono in secondi; `fps` dice quanti fotogrammi al secondo ha la sequenza.",
  "Non rinominare, spostare o cancellare niente senza il permesso esplicito dell'utente.",
];

export const prContextTool = defineTool({
  name: "pr_context",
  title: "Premiere context",
  description:
    "Premiere Pro: is it connected, which project is open, are the panel's switches on (ON/OFF, Sola lettura), " +
    "and the rules for working in Premiere. Start here before any other pr_* tool.",
  group: "premiere",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {},
  handler: async () => {
    const live = await livePremiereInstances(PREMIERE_INSTANCES_DIR);
    return jsonResult({
      connected: live.length > 0,
      instances: live.map((i) => ({
        id: i.id,
        label: instanceLabel(i),
        projectName: i.heartbeat?.projectName ?? null,
        project: i.heartbeat?.project ? path.basename(i.heartbeat.project) : null,
        appVersion: (i.heartbeat as { appVersion?: unknown } | null)?.appVersion ?? null,
        claudeOn: !isPremierePaused(i),
        readOnly: isPremiereReadOnly(i),
        busy: i.heartbeat?.busy === true,
      })),
      rules: RULES,
      ...(live.length === 0
        ? {
            hint:
              "Nessun Premiere collegato: chiedi all'utente di aprire Premiere Pro e il pannello Parlez! " +
              "(Finestra › Estensioni › Parlez!) e di metterlo su ON.",
          }
        : {}),
    });
  },
});

export const prProjectInfoTool = defineTool({
  name: "pr_project_info",
  title: "Premiere project info",
  description:
    "Premiere Pro project overview: name and file, every bin and item (clips, sequences, bins) with the bin " +
    "it sits in, which media are offline, and every sequence with size, fps and duration. Read-only.",
  group: "premiere",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    maxItems: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Stop listing project items after this many (default 500)."),
  },
  handler: async (args, transport) => {
    const code = `
        var maxItems = ${jsxVal(args.maxItems ?? 500)};
        var proj = app.project;
        if (!proj) return { ok: false, error: "Nessun progetto aperto in Premiere Pro." };
        var listed = PR.listItems(proj.rootItem, maxItems);
        var sequences = [];
        var all = PR.allSequences();
        for (var i = 0; i < all.length; i++) sequences.push(PR.sequenceSummary(all[i]));
        var active = PR.safe(function () { return proj.activeSequence; }, null);
        return {
            name: PR.safe(function () { return String(proj.name); }, null),
            project: PR.path(PR.safe(function () { return proj.path; }, null)),
            appVersion: PR.safe(function () { return String(app.version); }, null),
            activeSequence: active ? PR.safe(function () { return String(active.name); }, null) : null,
            sequences: sequences,
            itemCount: listed.items.length,
            truncated: listed.truncated,
            offlineCount: listed.offline,
            items: listed.items
        };
    `;
    return toMcpResult(await transport.execute({ code, label: "pr_project_info", mutates: false }));
  },
});

export const prSequenceInfoTool = defineTool({
  name: "pr_sequence_info",
  title: "Premiere sequence info",
  description:
    "One Premiere Pro sequence in detail: settings (size, fps, duration), playhead and in/out points, every " +
    "video and audio track with its clips (name, start/end on the timeline, in/out in the source, source item), " +
    "and the sequence markers (name, comment, start/end, colour). Defaults to the active sequence. Read-only.",
  group: "premiere",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe(
        "Sequence name or sequenceID (from pr_project_info). Omit for the active sequence.",
      ),
    maxClips: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Stop listing clips on a track after this many (default 300)."),
    markers: z.boolean().optional().describe("Include the sequence markers (default true)."),
  },
  handler: async (args, transport) => {
    const code = `
        var found = PR.findSequence(${jsxVal(args.sequence ?? null)});
        if (found.error) return { ok: false, error: found.error };
        var seq = found.seq;
        var maxClips = ${jsxVal(args.maxClips ?? 300)};
        var out = PR.sequenceSummary(seq);
        out.playhead = PR.seconds(PR.safe(function () { return seq.getPlayerPosition(); }, null));
        out.inPoint = PR.seconds(PR.safe(function () { return seq.getInPointAsTime(); }, null));
        out.outPoint = PR.seconds(PR.safe(function () { return seq.getOutPointAsTime(); }, null));
        PR.withTimecode(seq, out, { playhead: "position", inPoint: "position", outPoint: "position" });
        out.video = PR.tracks(PR.safe(function () { return seq.videoTracks; }, null), maxClips);
        out.audio = PR.tracks(PR.safe(function () { return seq.audioTracks; }, null), maxClips);
        // Timecode next to the seconds of every clip (start/end on the timeline, in/out in the source).
        var groups = [out.video, out.audio];
        for (var gi = 0; gi < groups.length; gi++) {
            for (var ti = 0; groups[gi] && ti < groups[gi].length; ti++) {
                var cl = groups[gi][ti].clips;
                for (var ci = 0; cl && ci < cl.length; ci++) PR.withTimecode(seq, cl[ci], PR.CLIP_TIMES);
            }
        }
        if (${jsxVal(args.markers !== false)}) {
            var m = PR.markers(PR.safe(function () { return seq.markers; }, null), 1000);
            // Timecode and frame next to the seconds, as pr_markers answers.
            for (var mi = 0; mi < m.markers.length; mi++) {
                PR.withTimecode(seq, m.markers[mi], { start: "position", end: "position" });
            }
            out.markers = m.markers;
            out.markersTruncated = m.truncated;
        }
        return out;
    `;
    return toMcpResult(
      await transport.execute({ code, label: "pr_sequence_info", mutates: false }),
    );
  },
});

function withPremiereInstance(tool: AnyTool): AnyTool {
  if (tool.name === "pr_context") return tool;
  return {
    ...tool,
    inputShape: { ...tool.inputShape, instance: PREMIERE_INSTANCE_PARAM },
    handler: async (args: Record<string, unknown> | undefined, transport: AeTransport) => {
      const { instance, ...rest } = args ?? {};
      return tool.handler(rest, bindPremiere(transport, instance));
    },
  };
}

/** Every Premiere tool, in registration order. */
export const PREMIERE_TOOLS: AnyTool[] = [
  prContextTool,
  prProjectInfoTool,
  prSequenceInfoTool,
  prProjectCheckTool,
  prFrameTool,
  prMarkersTool,
  prBinsTool,
  prRenameItemsTool,
  prSequenceCreateTool,
  prTimelineAddTool,
  prClipEditTool,
  prClipRemoveTool,
  prRazorTool,
  prMogrtAddTool,
  prExportTool,
  prSaveProjectTool,
  prImportTool,
  prMediaReleaseTool,
  prMediaRefreshTool,
  prSequenceDuplicateTool,
  prSequenceOpenTool,
  prTracksTool,
  prTransitionTool,
  prAudioLevelTool,
  prExportInterchangeTool,
  prAutoReframeTool,
  prCaptionsTool,
  prUndoLastTool,
].map((tool) => withPremiereInstance(tool as AnyTool));
