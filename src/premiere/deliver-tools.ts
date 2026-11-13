// Deliverables from Premiere Pro: interchange files for other programs
// (XML for DaVinci Resolve / Final Cut, AAF and OMF for the sound mix), an
// automatically reframed copy of a sequence (9:16, 1:1, ...), captions from
// an .srt file. Each verified on Premiere 26.3.2 on 13/11/2026:
//   - exportAsFinalCutProXML, exportAAF and exportOMF write their files;
//   - autoReframeSequence makes a new sequence and also an "Auto Reframed
//     Sequences" bin: undo removes both;
//   - createCaptionTrack adds captions that scripting cannot remove (deleting
//     the imported .srt leaves them in the sequence), so captions need
//     confirm and come back out only through the restore point.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { rejectedOutputPath } from "../config.js";
import { errorResult } from "../errors.js";
import { defineTool, jsonResult, toMcpResult } from "../tools/define-tool.js";
import { runWithCheckpoint } from "./edit-tools.js";

/** Absolute, and with backslashes on Windows, the form Premiere's exporters expect. */
function forPremiere(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.replace(/\//g, "\\") : abs;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const EXTENSIONS: Record<string, string> = { xml: ".xml", aaf: ".aaf", omf: ".omf" };

const INTERCHANGE_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var r;
    if (p.format === "xml") r = seq.exportAsFinalCutProXML(p.out, 1);
    else if (p.format === "aaf") r = app.project.exportAAF(seq, p.out, 0, 0, 48000, 16, 1, 0, 0, 0);
    else r = app.project.exportOMF(seq, p.out, String(seq.name), 48000, 16, 1, 0, 0, 0, 0);
    return { sequence: String(seq.name), premiere: String(r) };
`;

export const prExportInterchangeTool = defineTool({
  name: "pr_export_interchange",
  title: "Premiere: XML / AAF / OMF for other programs",
  description:
    "Export a Premiere Pro sequence (default the active one) for another program: `xml` (Final Cut Pro XML, " +
    "read by DaVinci Resolve and Final Cut), `aaf` or `omf` (for the sound mix, audio embedded, 48 kHz / " +
    "16 bit). Overwriting an existing file needs confirm: true, only if the user asked. The project does not change.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    format: z.enum(["xml", "aaf", "omf"]),
    outPath: z.string().min(1).describe("Full path of the file to write."),
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    confirm: z.boolean().optional().describe("Required (true) to overwrite an existing file."),
  },
  handler: async (args, transport) => {
    let out = path.resolve(args.outPath);
    if (path.extname(out).toLowerCase() !== EXTENSIONS[args.format]) out += EXTENSIONS[args.format];
    const inMailbox = rejectedOutputPath(out);
    if (inMailbox) return errorResult("INVALID_ARGS", inMailbox);
    const already = await exists(out);
    if (already && args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        `Il file ${path.basename(out)} esiste già: sovrascriverlo serve confirm: true, e solo se l'utente l'ha chiesto.`,
      );
    }
    await fs.mkdir(path.dirname(out), { recursive: true });
    const res = toMcpResult(
      await transport.execute({
        code: INTERCHANGE_CODE,
        payload: { sequence: args.sequence ?? null, format: args.format, out: forPremiere(out) },
        label: "pr_export_interchange",
        mutates: true,
        timeoutMs: 600_000,
      }),
    );
    if (res.isError) return res;
    if (!(await exists(out))) {
      return errorResult(
        "OPERATION_FAILED",
        "Premiere dice di aver esportato, ma il file non c'è.",
      );
    }
    return jsonResult({ file: out.replace(/\\/g, "/"), format: args.format, overwritten: already });
  },
});

const REFRAME_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var before = PR.projectItemIds();
    var known = {};
    var all = PR.allSequences();
    var i;
    for (i = 0; i < all.length; i++) known["k" + String(all[i].sequenceID)] = true;
    var name = (typeof p.name === "string" && p.name.length > 0) ? p.name : String(seq.name) + " - " + p.num + "x" + p.den;
    seq.autoReframeSequence(p.num, p.den, p.motion, name, false);
    var made = null;
    all = PR.allSequences();
    for (i = 0; i < all.length; i++) {
        if (!known.hasOwnProperty("k" + String(all[i].sequenceID))) made = all[i];
    }
    var ids = PR.newProjectItems(before);
    var steps = [];
    if (ids.length > 0) steps.push({ kind: "project.items.created", nodeIds: ids });
    if (made) steps.push({ kind: "sequence.created", sequenceID: String(made.sequenceID) });
    PR.pushUndo("pr_auto_reframe", steps);
    if (!made) return { ok: false, error: "Premiere non ha creato la sequenza riformattata." };
    return { sequence: PR.sequenceSummary(made), undo: "pr_undo_last toglie la sequenza riformattata e il bin che Premiere ha creato" };
`;

export const prAutoReframeTool = defineTool({
  name: "pr_auto_reframe",
  title: "Premiere: reframe a sequence (9:16, 1:1...)",
  description:
    "Make a reframed copy of a Premiere Pro sequence (default the active one) for another aspect ratio - " +
    "9:16 for stories and reels, 1:1, 4:5 - with Premiere's Auto Reframe, which follows the action. The " +
    "original sequence is not changed. Premiere analyses the footage: it can take a while. A restore point is " +
    "taken first; pr_undo_last removes the new sequence and the bin Premiere created for it.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    ratio: z.enum(["9:16", "1:1", "4:5", "16:9"]).describe("Aspect ratio of the copy."),
    motion: z
      .enum(["default", "slower", "faster"])
      .optional()
      .describe("How quickly the frame follows the action (default: default)."),
    name: z.string().min(1).max(250).optional().describe("Name of the new sequence."),
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
  },
  handler: async (args, transport) => {
    const [num, den] = args.ratio.split(":").map(Number);
    return runWithCheckpoint(transport, {
      code: REFRAME_CODE,
      payload: {
        sequence: args.sequence ?? null,
        num,
        den,
        motion: args.motion ?? "default",
        name: args.name ?? null,
      },
      label: "pr_auto_reframe",
      timeoutMs: 1_800_000,
    });
  },
});

const CAPTIONS_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var before = PR.projectItemIds();
    app.project.importFiles([p.srt], true, app.project.rootItem, false);
    var ids = PR.newProjectItems(before);
    if (ids.length === 0) return { ok: false, error: "Premiere non ha importato il file dei sottotitoli." };
    var item = PR.itemByNodeId(ids[0]).item;
    var r = seq.createCaptionTrack(item, p.start);
    return {
        sequence: String(seq.name),
        captions: PR.safe(function () { return String(item.name); }, null),
        premiere: String(r),
        undo: "pr_undo_last non toglie i sottotitoli: si torna indietro dal punto di ritorno, oppure a mano eliminando la traccia dei sottotitoli in Premiere"
    };
`;

export const prCaptionsTool = defineTool({
  name: "pr_captions",
  title: "Premiere: captions from a subtitle file",
  description:
    "Add captions to a Premiere Pro sequence (default the active one) from a subtitle file (.srt, full path), " +
    "starting at `start` seconds (default 0). Needs confirm: true, only if the user asked: Premiere's " +
    "scripting cannot take captions out again, so the way back is the restore point taken first (or deleting " +
    "the caption track by hand in Premiere).",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    srt: z.string().min(1).describe("Full path of the subtitle file (.srt)."),
    start: z
      .number()
      .min(0)
      .optional()
      .describe("Where the captions start, in seconds (default 0)."),
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required (true): captions cannot be undone by Parlez!."),
  },
  handler: async (args, transport) => {
    if (path.extname(args.srt).toLowerCase() !== ".srt") {
      return errorResult("INVALID_ARGS", "Il file dei sottotitoli deve essere un .srt.");
    }
    if (!(await exists(args.srt))) {
      return errorResult("IO", `Non trovo il file dei sottotitoli: ${path.basename(args.srt)}.`);
    }
    if (args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        "I sottotitoli non si possono togliere con pr_undo_last: serve confirm: true, e solo se l'utente l'ha chiesto.",
        {
          hint: "Dì all'utente che si torna indietro dal punto di ritorno o eliminando a mano la traccia dei sottotitoli.",
        },
      );
    }
    return runWithCheckpoint(transport, {
      code: CAPTIONS_CODE,
      payload: {
        sequence: args.sequence ?? null,
        srt: forPremiere(args.srt),
        start: args.start ?? 0,
      },
      label: "pr_captions",
    });
  },
});

export const DELIVER_TOOLS = [prExportInterchangeTool, prAutoReframeTool, prCaptionsTool];
