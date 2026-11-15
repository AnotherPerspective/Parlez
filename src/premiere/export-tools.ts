// Exporting from Premiere Pro: one frame as PNG (so Claude can see the cut)
// and a whole sequence as a file.
//
// Both go through Sequence.exportAsMediaDirect, which renders inside Premiere
// with a preset (.epr). What Premiere 26.3.2 did when probed (13/11/2026):
//   - it wants Windows paths with backslashes; with forward slashes or the
//     8.3 short names of the temp folder it answered "Unknown Error";
//   - the PNG preset writes an image sequence, so one frame comes out as
//     "<name>0.png";
//   - QE's exportFramePNG answered false and wrote nothing, so it is not used.
// One frame is the sequence's in/out set to that frame for the export, and
// put back right after (in a finally), so the project ends as it started.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import { rejectedOutputPath } from "../config.js";
import { errorResult } from "../errors.js";
import { defineTool, jsonResult, toMcpResult } from "../tools/define-tool.js";
import type { ImageContent } from "../tools/types.js";

/** Premiere's own presets, under its install folder (Windows layout; macOS untested). */
function systemPreset(platform: NodeJS.Platform, file: string): string {
  const base =
    platform === "darwin"
      ? "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MediaIO/systempresets"
      : path.join(
          process.env.ProgramFiles ?? "C:\\Program Files",
          "Adobe",
          "Adobe Premiere Pro 2026",
          "MediaIO",
          "systempresets",
        );
  return path.join(base, file);
}

const PNG_PRESET = path.join("3F3F3F3F_504E4720", "PNG Sequence (Match Source).epr");
const H264_PRESET = path.join("3F3F3F3F_4D6F6F56", "H264 Match Source - High bitrate.epr");

/** The path as Premiere wants it on Windows: absolute, backslashes. */
function forPremiere(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.replace(/\//g, "\\") : abs;
}

/** Long form of a Windows path (no 8.3 short names, which Premiere refused). */
async function longPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

const EXPORT_CODE = `
    var p = payload;
    var found = PR.findSequence(p.sequence);
    if (found.error) return { ok: false, error: found.error };
    var seq = found.seq;
    var oldIn = seq.getInPointAsTime().ticks;
    var oldOut = seq.getOutPointAsTime().ticks;
    var result = null;
    var error = null;
    try {
        if (p.frame !== null) {
            var fps = PR.fps(seq);
            seq.setInPoint(String(Math.round(p.frame * PR.TICKS_PER_SECOND)));
            seq.setOutPoint(String(Math.round((p.frame + 1 / fps) * PR.TICKS_PER_SECOND)));
        }
        result = String(seq.exportAsMediaDirect(p.out, p.preset, p.range));
    } catch (e) {
        error = PR.errText(e);
    } finally {
        if (p.frame !== null) {
            seq.setInPoint(oldIn);
            seq.setOutPoint(oldOut);
        }
    }
    if (error !== null) return { ok: false, error: "Esportazione non riuscita: " + error };
    if (result !== "No Error") return { ok: false, error: "Esportazione non riuscita: " + result };
    return { sequence: PR.safe(function () { return String(seq.name); }, null), premiere: result };
`;

export const prFrameTool = defineTool({
  name: "pr_frame",
  title: "Premiere: look at a frame",
  description:
    "Render one frame of a Premiere Pro sequence (default the active one) at `time` seconds as a PNG and " +
    "show it, so you can see the cut. The sequence's in/out points are set to that frame for the render and " +
    "put back right after; nothing else in the project changes. The PNG is saved in a temp folder.",
  group: "premiere",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    time: z.number().min(0).describe("Which frame, in seconds from the start of the sequence."),
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
  },
  handler: async (args, transport) => {
    const dir = await longPath(path.join(os.tmpdir(), "parlez-premiere-frames"));
    await fs.mkdir(dir, { recursive: true });
    const stem = `fotogramma-${randomUUID().slice(0, 8)}`;
    const res = await transport.execute({
      code: EXPORT_CODE,
      payload: {
        sequence: args.sequence ?? null,
        frame: args.time,
        out: forPremiere(path.join(await longPath(dir), `${stem}.png`)),
        preset: forPremiere(systemPreset(process.platform, PNG_PRESET)),
        range: 1,
      },
      label: "pr_frame",
      mutates: false,
      timeoutMs: 120_000,
    });
    const failed = toMcpResult(res);
    if (failed.isError) return failed;
    // The PNG preset numbers its frames: "<stem>0.png" for the only one.
    const names = (await fs.readdir(dir)).filter((n) => n.startsWith(stem) && n.endsWith(".png"));
    if (names.length === 0) {
      return errorResult("OPERATION_FAILED", "Premiere dice di aver esportato, ma il PNG non c'è.");
    }
    names.sort();
    const file = path.join(dir, names[0]!);
    const image: ImageContent = {
      type: "image",
      data: (await fs.readFile(file)).toString("base64"),
      mimeType: "image/png",
    };
    const ok = jsonResult({ time: args.time, file: file.replace(/\\/g, "/") });
    return { ...ok, content: [...ok.content, image] };
  },
});

export const prExportTool = defineTool({
  name: "pr_export",
  title: "Premiere: export a sequence",
  description:
    "Export a Premiere Pro sequence (default the active one) to a file, rendered inside Premiere with a " +
    'preset (.epr; default Premiere\'s H.264 "Match Source - High bitrate"). `range`: the whole sequence, ' +
    "its in/out points, or its work area. Premiere is busy until it finishes. Overwriting an existing file " +
    "needs confirm: true, only if the user asked. The project does not change.",
  group: "premiere",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    outPath: z.string().min(1).describe("Full path of the file to write (e.g. .mp4)."),
    preset: z
      .string()
      .optional()
      .describe("Full path of an .epr export preset. Default: H.264 Match Source."),
    range: z
      .enum(["all", "inout", "workarea"])
      .optional()
      .describe("What to export (default all)."),
    sequence: z
      .string()
      .optional()
      .describe("Sequence name or sequenceID. Omit for the active sequence."),
    timeoutMinutes: z
      .number()
      .min(1)
      .max(240)
      .optional()
      .describe("How long to wait (default 30)."),
    confirm: z.boolean().optional().describe("Required (true) to overwrite an existing file."),
  },
  handler: async (args, transport) => {
    const out = path.resolve(args.outPath);
    const inMailbox = rejectedOutputPath(out);
    if (inMailbox) return errorResult("INVALID_ARGS", inMailbox);
    let exists = false;
    try {
      await fs.access(out);
      exists = true;
    } catch {
      /* new file */
    }
    if (exists && args.confirm !== true) {
      return errorResult(
        "INVALID_ARGS",
        `Il file ${path.basename(out)} esiste già: sovrascriverlo serve confirm: true, e solo se l'utente l'ha chiesto.`,
      );
    }
    const preset = args.preset ?? systemPreset(process.platform, H264_PRESET);
    try {
      await fs.access(preset);
    } catch {
      return errorResult("IO", `Non trovo il preset di esportazione: ${path.basename(preset)}.`);
    }
    await fs.mkdir(path.dirname(out), { recursive: true });
    const minutes = args.timeoutMinutes ?? 30;
    const res = await transport.execute({
      code: EXPORT_CODE,
      payload: {
        sequence: args.sequence ?? null,
        frame: null,
        out: forPremiere(out),
        preset: forPremiere(preset),
        range: args.range === "inout" ? 1 : args.range === "workarea" ? 2 : 0,
      },
      label: "pr_export",
      mutates: true,
      timeoutMs: minutes * 60_000,
    });
    const result = toMcpResult(res);
    if (result.isError) return result;
    try {
      const st = await fs.stat(out);
      return jsonResult({ file: out.replace(/\\/g, "/"), bytes: st.size, overwritten: exists });
    } catch {
      return errorResult(
        "OPERATION_FAILED",
        "Premiere dice di aver esportato, ma il file non c'è.",
      );
    }
  },
});
