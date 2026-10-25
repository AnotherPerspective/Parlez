// Images that travel inside the tool result, so the model sees a render
// without opening a file. Everything here is pure Node on rasters already in
// memory: pick which images to send (`inline` mode), shrink them to a long
// edge, encode them as 8-bit sRGB PNGs, and keep the total under a byte
// budget — shrinking further, then dropping images, then sending none, each
// step reported as a warning so the caller can say so in the text answer.

import { encodePngSrgb8 } from "./png16.js";
import { composeContactSheet, resample, type Raster } from "./sheet.js";

/** Long edge of an inline image when the caller does not say (px). */
export const INLINE_DEFAULT_MAX_SIZE = 1024;
/** Below this the model can no longer read a frame; drop images instead. */
export const INLINE_MIN_SIZE = 192;
/**
 * Budget for all inline images of one call, counted as base64 characters
 * (what actually travels). About 750 KB of PNG: room for a contact sheet or
 * a couple of full frames, and well inside what MCP clients accept in one
 * tool result.
 */
export const INLINE_MAX_BYTES = 1_000_000;
/** `auto` sends frames one by one up to this many; more become one grid. */
export const INLINE_AUTO_MAX_FRAMES = 4;

export type InlineMode = "auto" | "none" | "all";

export type InlineKind = "frame" | "sheet" | "grid" | "strip";

export interface InlineSource {
  kind: InlineKind;
  /** Frame index (only for kind "frame"). */
  index?: number;
  image: Raster;
}

export interface EncodedInline {
  kind: InlineKind;
  index?: number;
  width: number;
  height: number;
  /** Base64 PNG bytes. */
  data: string;
  mimeType: "image/png";
}

export interface InlinePlan {
  /** In the order the sources were given. */
  images: EncodedInline[];
  /** The long-edge cap finally used, or null when nothing was encoded. */
  longEdge: number | null;
  /** Sum of the base64 lengths of `images`. */
  totalBytes: number;
  /** True when the budget forced a smaller long edge than requested. */
  reduced: boolean;
  /** Sources left out to fit the budget, in the order they were dropped. */
  dropped: Array<{ kind: InlineKind; index?: number }>;
  warning?: string;
}

/** Downscale so the long edge is at most `maxSize`, keeping the aspect. Never upscales. */
export function fitLongEdge(img: Raster, maxSize: number): Raster {
  const long = Math.max(img.width, img.height);
  if (long <= maxSize) return img;
  const scale = maxSize / long;
  const width = img.width >= img.height ? maxSize : Math.max(1, Math.round(img.width * scale));
  const height = img.height > img.width ? maxSize : Math.max(1, Math.round(img.height * scale));
  return { width, height, rgb: resample(img, width, height) };
}

/** Tile width that makes an `auto` grid of `count` frames about `maxSize` px wide. */
export function gridThumbWidth(count: number, maxSize: number): number {
  const columns = Math.ceil(Math.sqrt(count));
  // composeContactSheet's layout: gap + columns × (tile + gap), gap = 8.
  return Math.max(16, Math.floor((maxSize - 8) / columns) - 8);
}

/** True when `mode` sends the frames one by one (not as a sheet or grid). */
function framesGoInline(mode: InlineMode, count: number, hasSheet: boolean): boolean {
  if (mode === "all") return true;
  return mode === "auto" && !hasSheet && count <= INLINE_AUTO_MAX_FRAMES;
}

/**
 * Width (px) each decoded frame must keep for the inline images `mode` will
 * build from it; 0 when it needs none. Lets the caller shrink every frame
 * as soon as it is decoded instead of holding up to 32 full-resolution
 * copies (a 1080p frame is ~50 MB as floating-point RGB).
 *
 * For `all` with many frames the long edge is capped near 2·maxSize/√n: the
 * byte budget cannot carry more than a few full-size frames, so encoding
 * would shrink them to about that anyway — extra pixels would only cost
 * memory.
 */
export function inlineWorkWidth(
  mode: InlineMode,
  frame: { width: number; height: number },
  count: number,
  maxSize: number,
  hasSheet: boolean,
): number {
  if (mode === "none") return 0;
  let width = 0;
  if (framesGoInline(mode, count, hasSheet)) {
    const edge =
      count > INLINE_AUTO_MAX_FRAMES
        ? Math.min(maxSize, Math.max(INLINE_MIN_SIZE, Math.ceil((maxSize * 2) / Math.sqrt(count))))
        : maxSize;
    width = frame.width >= frame.height ? edge : Math.round((frame.width * edge) / frame.height);
  } else if (mode === "auto" && !hasSheet) {
    width = gridThumbWidth(count, maxSize);
  }
  return width === 0 ? 0 : Math.min(frame.width, Math.max(1, width));
}

/**
 * Which rendered images to send for a mode. `auto` sends one picture of the
 * motion: the contact sheet when there is one, else the frames themselves
 * while they are few, else a labelled grid built in memory — never 32
 * separate images. The strip, when drawn, rides along in every mode but
 * `none`.
 */
export function selectInlineSources(
  mode: InlineMode,
  rendered: {
    frames: Raster[];
    sheet?: Raster;
    strip?: Raster;
    frameLabels?: string[];
    /** Long-edge cap the grid is sized for (default INLINE_DEFAULT_MAX_SIZE). */
    maxSize?: number;
  },
): InlineSource[] {
  if (mode === "none") return [];
  const frames = rendered.frames.map((image, index): InlineSource => ({
    kind: "frame",
    index,
    image,
  }));
  const out: InlineSource[] = [];
  if (mode === "all") {
    out.push(...frames);
    if (rendered.sheet) out.push({ kind: "sheet", image: rendered.sheet });
  } else if (rendered.sheet) {
    out.push({ kind: "sheet", image: rendered.sheet });
  } else if (framesGoInline(mode, frames.length, false)) {
    out.push(...frames);
  } else {
    const grid = composeContactSheet(rendered.frames, {
      labels: rendered.frameLabels,
      thumbWidth: gridThumbWidth(frames.length, rendered.maxSize ?? INLINE_DEFAULT_MAX_SIZE),
    });
    out.push({ kind: "grid", image: grid });
  }
  if (rendered.strip) out.push({ kind: "strip", image: rendered.strip });
  return out;
}

function describe(s: { kind: InlineKind; index?: number }): string {
  return s.kind === "frame" ? `frame #${s.index}` : s.kind;
}

/**
 * Lower = dropped first: frames (last index first) go before the strip,
 * which goes before the one image that summarizes the motion.
 */
function dropRank(s: InlineSource): number {
  if (s.kind === "frame") return -(s.index ?? 0) - 1e6;
  if (s.kind === "strip") return 1;
  return 2;
}

function encodeOne(s: InlineSource, longEdge: number): EncodedInline {
  const img = fitLongEdge(s.image, longEdge);
  const data = encodePngSrgb8(img.width, img.height, img.rgb, { adaptiveFilter: true }).toString(
    "base64",
  );
  return {
    kind: s.kind,
    ...(s.index !== undefined ? { index: s.index } : {}),
    width: img.width,
    height: img.height,
    data,
    mimeType: "image/png",
  };
}

/** Encode the sources at `maxSize`, then shrink or drop until they fit `maxBytes`. */
export function encodeInlineImages(
  sources: InlineSource[],
  opts: { maxSize: number; maxBytes: number },
): InlinePlan {
  if (sources.length === 0) {
    return { images: [], longEdge: null, totalBytes: 0, reduced: false, dropped: [] };
  }
  const largest = Math.max(...sources.map((s) => Math.max(s.image.width, s.image.height)));
  let longEdge = Math.min(opts.maxSize, largest);
  const sum = (list: EncodedInline[]): number => list.reduce((n, e) => n + e.data.length, 0);
  let encoded = sources.map((s) => encodeOne(s, longEdge));
  let total = sum(encoded);
  let reduced = false;

  // PNG size scales roughly with pixel count, i.e. with the square of the
  // long edge — hence the square root, plus a margin so one retry usually
  // lands under budget.
  for (
    let attempt = 0;
    total > opts.maxBytes && longEdge > INLINE_MIN_SIZE && attempt < 8;
    attempt++
  ) {
    const factor = Math.min(0.9, Math.sqrt(opts.maxBytes / total) * 0.95);
    longEdge = Math.max(INLINE_MIN_SIZE, Math.floor(longEdge * factor));
    encoded = sources.map((s) => encodeOne(s, longEdge));
    total = sum(encoded);
    reduced = true;
  }

  const kept = sources.map((s, i) => ({ s, e: encoded[i] }));
  const dropped: InlinePlan["dropped"] = [];
  while (total > opts.maxBytes && kept.length > 0) {
    let victim = 0;
    for (let i = 1; i < kept.length; i++) {
      if (dropRank(kept[i].s) < dropRank(kept[victim].s)) victim = i;
    }
    const [gone] = kept.splice(victim, 1);
    total -= gone.e.data.length;
    dropped.push({
      kind: gone.s.kind,
      ...(gone.s.index !== undefined ? { index: gone.s.index } : {}),
    });
  }

  const images = kept.map((k) => k.e);
  const plan: InlinePlan = {
    images,
    longEdge: images.length > 0 ? longEdge : null,
    totalBytes: total,
    reduced,
    dropped,
  };
  if (images.length === 0) {
    plan.warning =
      `no image fits the ${opts.maxBytes}-byte inline budget even at ${INLINE_MIN_SIZE}px — ` +
      "nothing was attached; open the files at writtenTo instead";
  } else if (dropped.length > 0 || reduced) {
    const parts: string[] = [];
    if (reduced) {
      parts.push(
        `inline images reduced to ${longEdge}px on the long edge to stay under ${opts.maxBytes} bytes`,
      );
    }
    if (dropped.length > 0) {
      parts.push(
        `omitted to fit the budget: ${dropped.map(describe).join(", ")} — open them at writtenTo`,
      );
    }
    plan.warning = parts.join("; ");
  }
  return plan;
}
