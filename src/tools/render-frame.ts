import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { measureCaptureTransfer, calibrationKey } from "../color/calibration.js";
import {
  encodeInlineImages,
  INLINE_DEFAULT_MAX_SIZE,
  INLINE_MAX_BYTES,
  inlineWorkWidth,
  selectInlineSources,
  type InlineMode,
} from "../color/inline.js";
import { decodePng, encodePngSrgb8 } from "../color/png16.js";
import { readFileSettled } from "../color/settled-read.js";
import {
  analyzeFrame,
  composeContactSheet,
  frameLabel,
  resample,
  SHEET_THUMB_WIDTH,
  type FrameAnalysis,
  type Raster,
} from "../color/sheet.js";
import {
  drawTimelineStrip,
  ENERGY_THUMB_W,
  motionEnergy,
  type TimelineLayer,
} from "../color/strip.js";
import { profileForWorkingSpace, sceneLinearToDisplaySrgb } from "../color/transform.js";
import { rejectedOutputPath } from "../config.js";
import { errorResult } from "../errors.js";
import { readOnlyMode } from "../policy.js";
import { RENDER_FRAME_FN, TIMELINE_KEYS_FN } from "../operations/snippets.js";
import { jsxVal } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { defineTool, toMcpResult } from "./define-tool.js";
import type { ImageContent } from "./types.js";

interface RenderedFrame {
  ok: boolean;
  error?: string;
  writtenTo?: string;
  time?: number;
  size?: [number, number];
  captureKind?: "ocio" | "direct";
  analysis?: FrameAnalysis;
}

interface ContactSheetReport {
  writtenTo: string;
  size: [number, number];
  columns: number;
  rows: number;
  thumbSize: [number, number];
  frames: number;
}

/** What the JSX returns for the strip (consumed on the Node side, never echoed). */
interface TimelineData {
  duration: number;
  frameRate: number;
  displayStartTime: number;
  layers: Array<TimelineLayer & { keysTruncated?: boolean }>;
  layersTruncated?: boolean;
}

interface TimelineStripReport {
  writtenTo: string;
  size: [number, number];
  duration: number;
  /** Change between consecutive frames in time order, 0..1 (mean grey difference). */
  motion: Array<{ from: number; to: number; fromIndex: number; toIndex: number; energy: number }>;
  /** One per strip row, top to bottom; `layer` null = merged overflow row. */
  rows: Array<{
    row: number;
    layer: number | null;
    name: string;
    keyframes: number;
    keyTimes: number[];
    keyTimesTruncated?: boolean;
  }>;
  layersOmitted?: number;
}

interface RenderFramePayload {
  ok: boolean;
  error?: string;
  frames?: RenderedFrame[];
  writtenTo?: string;
  time?: number;
  compName?: string;
  size?: [number, number];
  workingSpace?: string;
  bitsPerChannel?: number;
  projectFile?: string | null;
  captureKind?: "ocio" | "direct";
  method?: string;
  colorPipeline?: string;
  colorWarning?: string;
  analysis?: FrameAnalysis;
  analysisWarning?: string;
  contactSheet?: ContactSheetReport;
  contactSheetWarning?: string;
  timeline?: TimelineData;
  timelineError?: string;
  timelineStrip?: TimelineStripReport;
  timelineStripWarning?: string;
  inlineWarning?: string;
}

interface ContactSheetArgs {
  columns?: number;
  thumbWidth?: number;
  outPath?: string;
}

interface TimelineStripArgs {
  width?: number;
  outPath?: string;
}

/** Default strip width (px): wide enough to read seconds and keyframes. */
const STRIP_DEFAULT_WIDTH = 1024;
/** JSX caps for the keyframe walk — see TIMELINE_KEYS_FN. */
const STRIP_MAX_LAYERS = 100;
const STRIP_MAX_KEYS = 200;
/** Key times listed per row in the text answer; the image shows them all. */
const STRIP_REPORT_KEYS = 64;

export const renderFrameTool = defineTool({
  name: "ae_render_frame",
  title: "Render frame",
  description:
    "Render one or more frames to PNG. Use to visually verify edits. " +
    "The agent's 'eyes' — pair with mutations for a visual feedback loop. " +
    "Headless and deterministic. Pass `time` for one frame, or `times` for several in ONE call " +
    "(motion checks): files land at <outPath stem>_<index>.png and are listed in `frames`. " +
    "`contactSheet` tiles every frame into one labelled PNG (<stem>_sheet.png) so a motion check is one image; " +
    "`analyze` measures each capture (uniform edge bands = black bars / transparent margins, content bounds, coverage) " +
    "so off-frame elements and letterboxing are caught numerically. " +
    "`timelineStrip` draws one wide image of the comp's time axis (<stem>_strip.png): seconds, the rendered " +
    "frames, motion energy between consecutive frames, and each layer's span and keyframes. " +
    "Images also come back INLINE, after the JSON text, so you can look without opening files: " +
    "`inline: 'auto'` (default) sends the contact sheet if requested, else the frames (a labelled grid " +
    "when there are more than 4), plus the strip; 'all' sends every frame too; 'none' sends paths only. " +
    "Inline images are scaled to `inlineMaxSize` px on the long edge (default 1024) and kept under a total " +
    "byte budget — shrunk further or omitted with an `inlineWarning` when over it; files on disk stay full size. " +
    "In color-managed projects (workingSpace != None) the capture applies AE's own " +
    "display transform via a transient OCIO Display Transform adjustment layer, and the PNG comes back " +
    "viewer-accurate and sRGB-tagged. Where that layer cannot be used — read-only mode, an AE without the " +
    "OCIO effect, or a failed capture calibration — the result falls back to a pure-math ACES conversion or " +
    "to raw values with an explicit colorWarning; check colorPipeline / colorWarning on the response.",
  group: "render",
  // Survives read-only mode: it writes a PNG, and the visual verification loop
  // is the whole point of an audit session. Note this is NOT a
  // never-touches-the-project tool. In a color-managed project the capture
  // path adds a transient adjustment layer, and the calibration probe builds a
  // scratch comp — both removed before the call returns, both leaving the
  // project dirty and one undo step consumed. Read-only mode is exactly where
  // that must not happen, so both are gated on !readOnlyMode() below and the
  // call degrades to the pure-math path instead.
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    compNameOrId: z
      .union([z.string(), z.number()])
      .describe("Composition name or numeric item id."),
    time: z
      .number()
      .nonnegative()
      .optional()
      .describe("Time in seconds to render. Give exactly one of `time` or `times`."),
    times: z
      .array(z.number().nonnegative())
      .min(1)
      .max(32)
      .optional()
      .describe(
        "Several times in seconds, rendered in ONE call. Files are written as " +
          "<outPath stem>_<index><ext> and reported in `frames` (index-aligned).",
      ),
    outPath: z
      .string()
      .describe(
        "Absolute path to write the PNG. Parent directory is created if missing. " +
          "With `times`, used as the naming stem for every frame.",
      ),
    useDisplayStartTime: z
      .boolean()
      .optional()
      .describe("If true, times are interpreted relative to comp.displayStartTime. Default false."),
    colorManaged: z
      .enum(["auto", "off"])
      .optional()
      .describe(
        "'auto' (default): detect the working space and return a viewer-accurate, 8-bit sRGB-tagged PNG. " +
          "'off': raw legacy output (16-bit, untagged, working-space values — dark/wrong-looking in " +
          "color-managed projects).",
      ),
    analyze: z
      .boolean()
      .optional()
      .describe(
        "Measure each capture: uniform bands at every edge (width + transparent/color — black bars, " +
          "letterboxing, empty margins), the bounding box of non-background pixels, coverage, mean RGB. " +
          "Reported per frame as `analysis` (measured on the capture before color conversion).",
      ),
    contactSheet: z
      .object({
        columns: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Tiles per row (default ceil(sqrt(n)))."),
        thumbWidth: z
          .number()
          .int()
          .min(16)
          .max(2048)
          .optional()
          .describe("Tile width in px, never upscaled (default 480)."),
        outPath: z.string().optional().describe("Sheet path (default <outPath stem>_sheet.png)."),
      })
      .optional()
      .describe(
        "Tile all rendered frames into ONE labelled PNG (#index + time above each tile). Pass {} for defaults.",
      ),
    timelineStrip: z
      .object({
        width: z
          .number()
          .int()
          .min(256)
          .max(4096)
          .optional()
          .describe(`Strip width in px (default ${STRIP_DEFAULT_WIDTH}).`),
        outPath: z.string().optional().describe("Strip path (default <outPath stem>_strip.png)."),
      })
      .optional()
      .describe(
        "Draw the comp's timeline as one wide, low PNG: second ticks, rendered frame times (#index), " +
          "motion energy between consecutive frames (orange bars), and per layer its in–out span with " +
          "keyframe diamonds (row label = layer index; `timelineStrip.rows` maps rows to layer names). " +
          "Reads keyframes without changing the project. Pass {} for defaults.",
      ),
    inline: z
      .enum(["auto", "none", "all"])
      .optional()
      .describe(
        "Images returned inside the response, after the JSON. 'auto' (default): the contact sheet if " +
          "requested, else the frames (a labelled grid when more than 4), plus the strip. " +
          "'all': every frame, then sheet and strip. 'none': paths and measurements only.",
      ),
    inlineMaxSize: z
      .number()
      .int()
      .min(64)
      .max(2048)
      .optional()
      .describe(
        `Long edge in px of each inline image (default ${INLINE_DEFAULT_MAX_SIZE}); never upscaled. ` +
          "Files on disk keep full size.",
      ),
  },
  handler: async (args, transport) => {
    if ((args.time === undefined) === (args.times === undefined)) {
      return errorResult("INVALID_ARGS", "give exactly one of `time` or `times`", {
        hint: "`time: 1.5` renders one frame; `times: [0, 1, 2]` renders several in one call.",
      });
    }
    const rejection = rejectedOutputPath(args.outPath);
    if (rejection !== null) {
      return errorResult("IO", rejection, {
        details: { outPath: path.resolve(args.outPath) },
        hint: "Render to a path outside the mailbox.",
      });
    }
    const abs = path.resolve(args.outPath).replace(/\\/g, "/");
    if (args.contactSheet?.outPath !== undefined) {
      const sheetRejection = rejectedOutputPath(args.contactSheet.outPath);
      if (sheetRejection !== null) {
        return errorResult("IO", sheetRejection, {
          details: { outPath: path.resolve(args.contactSheet.outPath) },
          hint: "Write the contact sheet to a path outside the mailbox.",
        });
      }
    }
    if (args.timelineStrip?.outPath !== undefined) {
      const stripRejection = rejectedOutputPath(args.timelineStrip.outPath);
      if (stripRejection !== null) {
        return errorResult("IO", stripRejection, {
          details: { outPath: path.resolve(args.timelineStrip.outPath) },
          hint: "Write the timeline strip to a path outside the mailbox.",
        });
      }
    }
    return nativeFlow(args, abs, transport);
  },
});

/** Default companion path: the frame stem plus a suffix (`_sheet`, `_strip`). */
function companionPathFor(abs: string, suffix: string, explicit: string | undefined): string {
  if (explicit !== undefined) return path.resolve(explicit).replace(/\\/g, "/");
  const ext = path.extname(abs) || ".png";
  const stem = abs.slice(0, abs.length - (path.extname(abs).length || 0));
  return `${stem}${suffix}${ext}`;
}

/**
 * Measure every written capture. Runs on the raw files — before any color
 * conversion — because that is where the alpha channel still is, and
 * "transparent margin" vs "black bar" is the distinction the check exists
 * for. Failures never fail the render: they are reported as a warning.
 */
async function attachAnalysis(
  payload: RenderFramePayload,
  frames: RenderedFrame[],
  written: string[],
  multi: boolean,
  read: SettledRead,
): Promise<void> {
  try {
    for (const [i, file] of written.entries()) {
      const analysis = analyzeFrame(decodePng(await read(file)));
      if (multi) frames[i].analysis = analysis;
      else payload.analysis = analysis;
    }
  } catch (err) {
    payload.analysisWarning = `analysis failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

type SettledRead = (file: string) => Promise<Buffer>;

/**
 * readFileSettled once per file per call. Its stability wait (≥250 ms) is
 * only needed while AE may still be writing; after the first settled read —
 * and our own awaited rewrites — a plain read is enough, so analysis, color
 * processing and the sheet/strip/inline pass do not each pay it again.
 */
function settledReader(): SettledRead {
  const settled = new Set<string>();
  return async (file) => {
    if (settled.has(file)) return fs.readFile(file);
    const buf = await readFileSettled(file);
    settled.add(file);
    return buf;
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decode the FINAL files (after color processing) for everything that needs
 * pixels — sheet, strip, inline images — one at a time, each shrunk at once
 * to the width those need (`workWidth`). Never all full-resolution frames in
 * memory together: 32 frames of 1080p would be ~1.6 GB of floating point.
 */
async function loadFinals(
  written: string[],
  read: SettledRead,
  workWidth: (width: number, height: number) => number,
): Promise<Raster[]> {
  const out: Raster[] = [];
  for (const file of written) {
    const img = decodePng(await read(file));
    const tw = Math.min(img.width, Math.max(1, Math.round(workWidth(img.width, img.height))));
    if (tw >= img.width) {
      out.push({ width: img.width, height: img.height, rgb: img.rgb });
    } else {
      const th = Math.max(1, Math.round((img.height * tw) / img.width));
      out.push({ width: tw, height: th, rgb: resample(img, tw, th) });
    }
  }
  return out;
}

/** Tile the final frames into one labelled sheet; returns it for inline use. */
async function attachContactSheet(
  payload: RenderFramePayload,
  images: Raster[],
  labels: string[],
  sheetPath: string,
  opts: ContactSheetArgs,
): Promise<Raster | undefined> {
  try {
    const sheet = composeContactSheet(images, {
      columns: opts.columns,
      thumbWidth: opts.thumbWidth,
      labels,
    });
    await fs.mkdir(path.dirname(sheetPath), { recursive: true });
    await fs.writeFile(sheetPath, encodePngSrgb8(sheet.width, sheet.height, sheet.rgb));
    payload.contactSheet = {
      writtenTo: sheetPath,
      size: [sheet.width, sheet.height],
      columns: sheet.columns,
      rows: sheet.rows,
      thumbSize: [sheet.thumbWidth, sheet.thumbHeight],
      frames: images.length,
    };
    return sheet;
  } catch (err) {
    payload.contactSheetWarning = `contact sheet failed: ${errText(err)}`;
    return undefined;
  }
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Draw the timeline strip from the final frames and the keyframe data the
 * JSX collected. Missing keyframe data still yields a strip (ruler, frames,
 * motion) plus a warning; any other failure is a warning, never a failed
 * render. Returns the strip for inline use.
 */
async function attachTimelineStrip(
  payload: RenderFramePayload,
  images: Raster[],
  times: number[],
  stripPath: string,
  opts: TimelineStripArgs,
): Promise<Raster | undefined> {
  const timeline = payload.timeline;
  const timelineError = payload.timelineError;
  // Raw AE data is an input to the drawing, not part of the answer: the
  // report below carries what is worth reading, in a bounded size.
  delete payload.timeline;
  delete payload.timelineError;
  try {
    const motion = motionEnergy(images, times);
    const layers = timeline?.layers ?? [];
    const duration = timeline && timeline.duration > 0 ? timeline.duration : Math.max(0, ...times);
    const strip = drawTimelineStrip({
      width: opts.width ?? STRIP_DEFAULT_WIDTH,
      duration,
      frameTimes: times,
      motion,
      layers,
    });
    await fs.mkdir(path.dirname(stripPath), { recursive: true });
    await fs.writeFile(
      stripPath,
      encodePngSrgb8(strip.width, strip.height, strip.rgb, { adaptiveFilter: true }),
    );
    const byIndex = new Map(layers.map((l) => [l.index, l]));
    payload.timelineStrip = {
      writtenTo: stripPath,
      size: [strip.width, strip.height],
      duration: round(duration, 4),
      motion: motion.map((m) => ({
        from: m.from,
        to: m.to,
        fromIndex: m.fromIndex,
        toIndex: m.toIndex,
        energy: round(m.energy, 4),
      })),
      rows: strip.rows.map((r) => {
        const members = r.layerIndexes.map((i) => byIndex.get(i)).filter((l) => l !== undefined);
        const keyTimes = [...new Set(members.flatMap((l) => l.keys.map((k) => round(k, 3))))].sort(
          (a, b) => a - b,
        );
        const truncated =
          keyTimes.length > STRIP_REPORT_KEYS || members.some((l) => l.keysTruncated === true);
        return {
          row: r.row,
          layer: r.merged ? null : r.layerIndexes[0],
          name: r.merged ? `${members.length} more layers` : (members[0]?.name ?? ""),
          keyframes: r.keyCount,
          keyTimes: keyTimes.slice(0, STRIP_REPORT_KEYS),
          ...(truncated ? { keyTimesTruncated: true } : {}),
        };
      }),
      ...(strip.layersOmitted > 0 ? { layersOmitted: strip.layersOmitted } : {}),
    };
    const notes: string[] = [];
    if (!timeline) {
      notes.push(
        `keyframe data unavailable${timelineError ? ` (${timelineError})` : ""} — strip shows frames and motion only`,
      );
    } else if (timeline.layersTruncated) {
      notes.push(`only the first ${STRIP_MAX_LAYERS} layers were read`);
    }
    if (notes.length > 0) payload.timelineStripWarning = notes.join("; ");
    return strip;
  } catch (err) {
    payload.timelineStripWarning = `timeline strip failed: ${errText(err)}`;
    return undefined;
  }
}

/**
 * Pick, shrink and encode the images that ride along in the response. The
 * JSON answer never depends on them — only `inlineWarning` mentions them,
 * and only when the byte budget forced a change — so a client (or a privacy
 * filter) that drops image blocks loses nothing else.
 */
function buildInlineImages(
  payload: RenderFramePayload,
  mode: InlineMode,
  maxSize: number,
  rendered: {
    frames: Raster[];
    sheet?: Raster;
    strip?: Raster;
    frameLabels: string[];
    maxSize: number;
  },
): ImageContent[] {
  try {
    const sources = selectInlineSources(mode, rendered);
    const plan = encodeInlineImages(sources, { maxSize, maxBytes: INLINE_MAX_BYTES });
    if (plan.warning) payload.inlineWarning = plan.warning;
    return plan.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
  } catch (err) {
    payload.inlineWarning = `inline images failed, open the files at writtenTo: ${errText(err)}`;
    return [];
  }
}

/** Per-frame output paths: the single path as-is, or stem_<index><ext> for `times`. */
function framePaths(abs: string, count: number, multi: boolean): string[] {
  if (!multi) return [abs];
  const ext = path.extname(abs) || ".png";
  const stem = abs.slice(0, abs.length - (path.extname(abs).length || 0));
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`${stem}_${i}${ext}`);
  return out;
}

async function nativeFlow(
  args: {
    compNameOrId: string | number;
    time?: number;
    times?: number[];
    useDisplayStartTime?: boolean;
    colorManaged?: "auto" | "off";
    analyze?: boolean;
    contactSheet?: ContactSheetArgs;
    timelineStrip?: TimelineStripArgs;
    inline?: InlineMode;
    inlineMaxSize?: number;
  },
  abs: string,
  transport: AeTransport,
) {
  const multi = args.times !== undefined;
  const times = args.times ?? [args.time as number];
  const paths = framePaths(abs, times.length, multi);
  const wantStrip = args.timelineStrip !== undefined;
  // Built apart from the main template: a template nested inside an
  // interpolation would hide the rest of this file from the codegen lint.
  const timelineCall = wantStrip
    ? `try { _out.timeline = _tlCollect(comp, ${jsxVal(STRIP_MAX_LAYERS)}, ${jsxVal(STRIP_MAX_KEYS)}); } catch (eTl) { _out.timelineError = AE.errText(eTl); }`
    : "";
  // Color-managed projects: instead of reimplementing the view transform,
  // make AE apply its own — drop a transient adjustment layer carrying an
  // "OCIO Display Transform" effect on top of the comp and capture that.
  // Verified bit-near (mean 0.04/255) against a viewer-referenced capture;
  // the only artifact is the linear capture scale, which the calibration
  // pass restores. An adjustment layer (not a wrapper comp) so the viewer
  // keeps showing the same comp — and ONE layer serves every requested
  // frame, which is why `times` is cheaper than repeated single calls.
  // Mutating (one undo group, self-cleaning), so read-only mode falls back
  // to the pure-math conversion below.
  const tryOcio = args.colorManaged !== "off" && !readOnlyMode();
  const code = `
        ${RENDER_FRAME_FN}
        ${wantStrip ? TIMELINE_KEYS_FN : ""}
        var _arg = ${jsxVal(args.compNameOrId)};
        var comp = AE.findCompByNameOrId(_arg);
        if (!comp) return { ok: false, error: "no comp matching " + String(_arg) };
        var _ws = AE.safeGet(function () { return app.project.workingSpace; }, "None");
        var _times = ${jsxVal(times)};
        var _paths = ${jsxVal(paths)};
        var _useDst = ${jsxVal(!!args.useDisplayStartTime)};
        var _useOcio = ${jsxVal(tryOcio)} && _ws !== "None" && _ws !== "";
        var _frames = [];
        function _renderAll(kind) {
            for (var _fi = 0; _fi < _times.length; _fi++) {
                var _r = _renderFrame(comp, _times[_fi], _paths[_fi], _useDst);
                _r.captureKind = kind;
                _frames.push(_r);
            }
        }
        if (_useOcio) {
            var _adj = null;
            var _adjSrc = null;
            try {
                _adj = comp.layers.addSolid([1, 1, 1], "__mcp_ocio__", comp.width, comp.height, comp.pixelAspect);
                _adjSrc = _adj.source;
                _adj.adjustmentLayer = true;
                try {
                    var _maxT = _times[0];
                    for (var _mi = 1; _mi < _times.length; _mi++) { if (_times[_mi] > _maxT) _maxT = _times[_mi]; }
                    if (_useDst) _maxT = _maxT + comp.displayStartTime;
                    if (_adj.outPoint < _maxT + comp.frameDuration) _adj.outPoint = _maxT + comp.frameDuration;
                } catch (eOp) { }
                var _fxOk = false;
                try {
                    _adj.property("Effects").addProperty("ADBE OCIO Display Transform");
                    _fxOk = true;
                } catch (eFx) { /* pre-OCIO AE or ICC color engine */ }
                if (_fxOk) _renderAll("ocio");
            } catch (eTmp) { /* fall through to direct capture */ }
            if (_adj) { try { _adj.remove(); } catch (eRm) { } }
            if (_adjSrc) { try { _adjSrc.remove(); } catch (eRs) { } }
        }
        if (_frames.length === 0) _renderAll("direct");
        var _allOk = true;
        var _firstError = null;
        for (var _ci = 0; _ci < _frames.length; _ci++) {
            if (!_frames[_ci].ok) { _allOk = false; if (_firstError === null) _firstError = _frames[_ci].error; }
        }
        var _out = { ok: _allOk, frames: _frames, captureKind: _frames.length > 0 ? _frames[0].captureKind : null };
        if (!_allOk) _out.error = _firstError;
        if (_allOk) {
            _out.compName = comp.name;
            _out.workingSpace = _ws;
            _out.bitsPerChannel = AE.safeGet(function () { return app.project.bitsPerChannel; }, 8);
            _out.projectFile = app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null;
            ${timelineCall}
        }
        return _out;
    `;
  const result = await transport.execute({
    code,
    label: "render_frame",
    timeoutMs: 120_000 + (times.length - 1) * 30_000,
  });
  if (!result.ok) return toMcpResult(result);
  const payload = result.result as RenderFramePayload;
  const frames = payload?.frames ?? [];
  // Single-frame calls keep the pre-`times` response shape (top-level
  // writtenTo/time/size); multi-frame calls report through `frames`.
  if (payload && payload.ok === true && !multi && frames.length === 1) {
    payload.writtenTo = frames[0].writtenTo;
    payload.time = frames[0].time;
    payload.size = frames[0].size;
    delete payload.frames;
  }
  if (!payload || payload.ok !== true) {
    return toMcpResult(result);
  }

  const written: string[] = (multi ? frames.map((f) => f.writtenTo) : [payload.writtenTo]).filter(
    (p): p is string => typeof p === "string",
  );
  // Analysis first: it wants the raw capture, alpha channel included.
  const read = settledReader();
  if (args.analyze) await attachAnalysis(payload, frames, written, multi, read);
  if (args.colorManaged !== "off") {
    payload.method = "native";
    await colorPostProcess(payload, written, transport, read);
  }
  // Sheet, strip and inline images last, from the files as they will be viewed.
  const inlineMode: InlineMode = args.inline ?? "auto";
  let images: ImageContent[] = [];
  if (args.contactSheet || args.timelineStrip || inlineMode !== "none") {
    const inlineMaxSize = args.inlineMaxSize ?? INLINE_DEFAULT_MAX_SIZE;
    const sheetWidth = args.contactSheet ? (args.contactSheet.thumbWidth ?? SHEET_THUMB_WIDTH) : 0;
    const workWidth = (width: number, height: number): number =>
      Math.max(
        sheetWidth,
        inlineWorkWidth(
          inlineMode,
          { width, height },
          written.length,
          inlineMaxSize,
          args.contactSheet !== undefined,
        ),
        args.timelineStrip ? ENERGY_THUMB_W : 0,
      );
    let finals: Raster[] | null = null;
    try {
      finals = await loadFinals(written, read, workWidth);
    } catch (err) {
      const msg = `could not read the rendered files back: ${errText(err)}`;
      if (args.contactSheet) payload.contactSheetWarning = `contact sheet failed: ${msg}`;
      if (args.timelineStrip) payload.timelineStripWarning = `timeline strip failed: ${msg}`;
      if (inlineMode !== "none") payload.inlineWarning = `inline images failed: ${msg}`;
    }
    if (finals) {
      const frameTimes = multi
        ? frames.map((f, i) => f.time ?? times[i])
        : [payload.time ?? times[0]];
      const labels = frameTimes.map((t, i) => frameLabel(i, t));
      const sheet = args.contactSheet
        ? await attachContactSheet(
            payload,
            finals,
            labels,
            companionPathFor(abs, "_sheet", args.contactSheet.outPath),
            args.contactSheet,
          )
        : undefined;
      const strip = args.timelineStrip
        ? await attachTimelineStrip(
            payload,
            finals,
            frameTimes,
            companionPathFor(abs, "_strip", args.timelineStrip.outPath),
            args.timelineStrip,
          )
        : undefined;
      images = buildInlineImages(payload, inlineMode, inlineMaxSize, {
        frames: finals,
        sheet,
        strip,
        frameLabels: labels,
        maxSize: inlineMaxSize,
      });
    }
  }
  // Raw keyframe data never reaches the answer, whatever happened above.
  delete payload.timeline;
  delete payload.timelineError;
  const out = toMcpResult(result);
  // Images go after the JSON text: content[0] stays the full answer for
  // clients that read only the first block or do not render images.
  if (!out.isError) out.content.push(...images);
  return out;
}

/**
 * Convert the captures in place to viewer-accurate, sRGB-tagged 8-bit PNGs
 * (see the tool description for the three pipelines). Reports through
 * payload.colorPipeline / payload.colorWarning; never throws.
 */
async function colorPostProcess(
  payload: RenderFramePayload,
  written: string[],
  transport: AeTransport,
  read: SettledRead,
): Promise<void> {
  const workingSpace = payload.workingSpace ?? "None";
  try {
    if (workingSpace === "None" || workingSpace === "") {
      // Values are already display-referred; the only fix needed is an
      // explicit color tag so viewers stop guessing at the 16-bit file.
      for (const file of written) {
        const img = decodePng(await read(file));
        await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
      }
      payload.colorPipeline = "untagged 16-bit → 8-bit sRGB-tagged (values unchanged)";
      return;
    }

    const calib = await measureCaptureTransfer(
      transport,
      calibrationKey(payload.projectFile ?? null, workingSpace, payload.bitsPerChannel ?? 8),
      !readOnlyMode(),
    );
    const calibFailed = "error" in calib || calib.kind === "unknown";
    const gain = !calibFailed && calib.kind === "linear" ? 1 / calib.scale : 1;

    if (payload.captureKind === "ocio") {
      if (calibFailed) {
        payload.colorWarning =
          `AE applied its display transform, but the capture scale could not be measured (${"error" in calib ? calib.error : "non-linear transfer"}) — ` +
          "the file is uniformly dark by that unknown scale. Verify colors against the AE viewer manually.";
        return;
      }
      for (const file of written) {
        const img = decodePng(await read(file));
        for (let i = 0; i < img.rgb.length; i++) img.rgb[i] *= gain;
        await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
      }
      payload.colorPipeline =
        "AE OCIO display transform (viewer-exact, any working space)" +
        (gain !== 1 ? ` + capture scale 1/${gain.toFixed(2)} restored` : "");
      return;
    }

    // Direct capture of a color-managed project (read-only mode, or an AE
    // without the OCIO effect): pure-math fallback for the working spaces we
    // know, verified within ~1.7/255 of the viewer on ACES/ACEScg.
    const profile = profileForWorkingSpace(workingSpace);
    if (profile === null) {
      payload.colorWarning =
        `working space '${workingSpace}' has no built-in conversion — the file contains raw working-space ` +
        "values and will not match the viewer. Verify colors against the AE viewer manually if they matter here.";
      return;
    }
    if (calibFailed) {
      payload.colorWarning =
        `could not characterize this AE version's capture transfer (${"error" in calib ? calib.error : "non-linear transfer"}) — ` +
        "the file contains raw working-space values. Verify colors against the AE viewer manually if they matter here.";
      return;
    }
    for (const file of written) {
      const img = decodePng(await read(file));
      for (let i = 0; i < img.rgb.length; i++) img.rgb[i] *= gain;
      sceneLinearToDisplaySrgb(img.rgb, profile.toRec709);
      await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
    }
    payload.colorPipeline =
      `${profile.note}` + (gain !== 1 ? ` (capture scale 1/${gain.toFixed(2)} restored)` : "");
  } catch (err) {
    payload.colorWarning = `color post-processing failed, file left as raw capture: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}
