// Parlez! M5.1 and M5.2 (nomi provvisori): measuring a reference image and
// checking a render against it. Both run on the Node side — they only read
// PNG files, never After Effects — so they work in read-only mode and need
// no project. Images for the model (an enlarged crop, a difference map)
// ride back under OP_INLINE_IMAGES_KEY and become image blocks in ae_do.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { compareImages, COMPARE_DEFAULTS, differenceMap } from "../color/compare.js";
import { encodeInlineImages, INLINE_MAX_BYTES, type InlineSource } from "../color/inline.js";
import {
  capHeight,
  clipBox,
  colorAt,
  cornerRadius,
  CROP_MAX_EDGE,
  cropZoom,
  estimateFontSize,
  gradientStops,
  round,
  roundRgb,
  swatchMedian,
  toHex,
  type Box,
} from "../color/measure.js";
import { decodePng, type DecodedPng } from "../color/png16.js";
import { rejectedOutputPath } from "../config.js";
import { jsxFail, OP_INLINE_IMAGES_KEY, registerOp } from "../registry.js";

type Failure = { ok: false; error: string; errorCode?: string; hint?: string };

function fail(error: string, errorCode = "INVALID_ARGS", hint?: string): Failure {
  return { ok: false, error, errorCode, ...(hint ? { hint } : {}) };
}

function isFailure(v: unknown): v is Failure {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const slash = (p: string) => p.replace(/\\/g, "/");

function nodeOnly(name: string): string {
  return jsxFail(
    `${name} runs on the Node side (it reads PNG files) — call it as its own ae_do, not inside batch.run`,
  );
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Largest image read: 4096×4096. Pixels are held as 64-bit floats (24 bytes
 * each), so this is already ~400 MB; 4K UHD (3840×2160) fits comfortably.
 */
const MAX_PIXELS = 4096 * 4096;

/**
 * Read and decode a PNG named by the caller. Refused: the mailbox (the
 * transport's trust boundary — nothing there is the user's picture), files
 * that are not PNG, images too large to hold in memory.
 */
async function loadPng(
  file: unknown,
  label: string,
): Promise<{ img: DecodedPng; abs: string } | Failure> {
  if (typeof file !== "string" || file.trim() === "") {
    return fail(`${label} deve essere il percorso di un file PNG`);
  }
  const abs = path.resolve(file);
  if (rejectedOutputPath(abs) !== null) {
    return fail(
      `refusing to read inside the mcp-aftereffects IPC mailbox (cassetta): ${label} must be the user's own PNG`,
      "IO",
    );
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(
      code === "ENOENT"
        ? `${label}: file non trovato (${slash(abs)})`
        : `${label}: non riesco a leggere ${slash(abs)} (${errText(err)})`,
      "IO",
    );
  }
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return fail(
      `${label}: solo PNG per ora — ${path.basename(abs)} non è un file PNG`,
      "INVALID_ARGS",
      "Esporta la reference (o il fotogramma) come PNG e passa quel file.",
    );
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w * h > MAX_PIXELS) {
    return fail(
      `${label}: immagine troppo grande (${w}×${h}); il massimo è 4096×4096 pixel`,
      "INVALID_ARGS",
      "Riducila prima di misurarla e passa scalaVerso con la larghezza della composizione.",
    );
  }
  try {
    return { img: decodePng(buf), abs };
  } catch (err) {
    return fail(
      `${label}: PNG non leggibile (${errText(err)}) — i PNG a palette e interlacciati non sono supportati`,
    );
  }
}

// --- argument shapes ---------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseBox(v: unknown, label: string): Box | string {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return `${label} deve essere un riquadro { x, y, w, h } in pixel dell'immagine`;
  }
  const b = v as Record<string, unknown>;
  if (![b.x, b.y, b.w, b.h].every(isNum)) return `${label}: x, y, w, h devono essere numeri`;
  if ((b.w as number) <= 0 || (b.h as number) <= 0)
    return `${label}: w e h devono essere maggiori di 0`;
  return { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number };
}

function parsePoint(v: unknown, label: string): [number, number] | string {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) {
    return `${label} deve essere un punto [x, y] in pixel dell'immagine`;
  }
  return [Math.round(v[0]), Math.round(v[1])];
}

function listOf(v: unknown, label: string, max: number): unknown[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return `${label} deve essere un elenco`;
  if (v.length > max) return `${label}: al massimo ${max} per chiamata`;
  return v;
}

/** A caller's box clipped to the image, or the reason it cannot be measured. */
function boxIn(img: DecodedPng, v: unknown, label: string): Box | string {
  const b = parseBox(v, label);
  if (typeof b === "string") return b;
  const c = clipBox(img, b);
  if (c === null) {
    return `${label} è fuori dall'immagine (${img.width}×${img.height})`;
  }
  return c;
}

function inside(img: DecodedPng, p: [number, number]): boolean {
  return p[0] >= 0 && p[1] >= 0 && p[0] < img.width && p[1] < img.height;
}

function inlinePng(kind: "crop" | "map", image: InlineSource["image"], maxSize: number) {
  const plan = encodeInlineImages([{ kind, image }], { maxSize, maxBytes: INLINE_MAX_BYTES });
  return {
    images: plan.images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
    warning: plan.warning,
  };
}

// --- reference.measure ---------------------------------------------------------

const BOX_DOC = "{ x, y, w, h } in pixel dell'immagine";

registerOp({
  name: "reference.measure",
  category: "reference",
  readOnly: true,
  description:
    "Passaporto della reference (nome provvisorio): measure a reference PNG instead of eyeballing it. " +
    "Always returns the size; on request: the color at points (`punti`), the median color of areas " +
    "(`swatch`), the color stops along a segment (`gradienti`), the corner radius of a flat rounded " +
    "rectangle (`raggi`, estimated from areas — check `affidabile`/`note`), the cap height of text and " +
    "an ESTIMATED font size (`testo`), and an enlarged crop (`crop`) returned as an inline image. " +
    "Coordinates are image pixels; pass `scalaVerso` (the destination comp width) to also get every " +
    "position and length rescaled to the comp. Colors: RGB 0–1 and hex. PNG only for now; read-only.",
  params: [
    { name: "file", type: "string", description: "Path of the reference PNG", required: true },
    {
      name: "scalaVerso",
      type: "number",
      description:
        "Width in px of the destination comp: adds rescaled values (factor = scalaVerso / image width)",
      required: false,
    },
    {
      name: "punti",
      type: "array",
      description: "Points [[x, y], …]: color at each",
      required: false,
    },
    {
      name: "swatch",
      type: "array",
      description: `Areas [${BOX_DOC}, …]: median color per channel of each`,
      required: false,
    },
    {
      name: "gradienti",
      type: "array",
      description:
        "Segments [{ da: [x, y], a: [x, y], tappe?: N (default 5) }, …]: N colors along each, local medians",
      required: false,
    },
    {
      name: "raggi",
      type: "array",
      description: `Boxes [${BOX_DOC}, …] each around ONE flat rounded rectangle with some background margin`,
      required: false,
    },
    {
      name: "testo",
      type: "array",
      description: `Boxes [${BOX_DOC}, …] each around capital letters (or digits): cap height and estimated font size; optional soglia (0–1, default 0.25)`,
      required: false,
    },
    {
      name: "crop",
      type: "object",
      description: `${BOX_DOC} plus optional zoom (1–16): an enlarged crop, returned as an inline image`,
      required: false,
    },
  ],
  toJsx: () => nodeOnly("reference.measure"),
  async run(args) {
    const loaded = await loadPng(args.file, "file");
    if (isFailure(loaded)) return loaded;
    const { img, abs } = loaded;

    let k: number | null = null;
    if (args.scalaVerso !== undefined) {
      if (!isNum(args.scalaVerso) || args.scalaVerso <= 0 || args.scalaVerso > 16384) {
        return fail("scalaVerso deve essere la larghezza della composizione in pixel (1–16384)");
      }
      k = args.scalaVerso / img.width;
    }
    const sc = (v: number) => (k === null ? undefined : round(v * k, 1));
    const scBox = (b: Box) =>
      k === null ? undefined : { x: sc(b.x), y: sc(b.y), w: sc(b.w), h: sc(b.h) };
    const out: Record<string, unknown> = {
      ok: true,
      file: slash(abs),
      size: [img.width, img.height],
      scala: k === null ? null : round(k, 6),
    };

    const punti = listOf(args.punti, "punti", 64);
    if (typeof punti === "string") return fail(punti);
    if (punti.length > 0) {
      const res = [];
      for (const [i, v] of punti.entries()) {
        const p = parsePoint(v, `punti[${i}]`);
        if (typeof p === "string") return fail(p);
        if (!inside(img, p))
          return fail(`punti[${i}] è fuori dall'immagine (${img.width}×${img.height})`);
        const c = colorAt(img, p[0], p[1]);
        res.push({
          at: p,
          ...(k !== null ? { scalato: [sc(p[0]), sc(p[1])] } : {}),
          rgb: roundRgb(c.rgb),
          hex: toHex(c.rgb),
          ...(c.alpha !== undefined ? { alpha: round(c.alpha, 4) } : {}),
        });
      }
      out.punti = res;
    }

    const swatch = listOf(args.swatch, "swatch", 32);
    if (typeof swatch === "string") return fail(swatch);
    if (swatch.length > 0) {
      const res = [];
      for (const [i, v] of swatch.entries()) {
        const b = boxIn(img, v, `swatch[${i}]`);
        if (typeof b === "string") return fail(b);
        const s = swatchMedian(img, b);
        res.push({
          area: b,
          ...(k !== null ? { areaScalata: scBox(b) } : {}),
          rgb: roundRgb(s.rgb),
          hex: toHex(s.rgb),
          pixel: s.pixel,
          dispersione: round(s.dispersione, 4),
        });
      }
      out.swatch = res;
    }

    const gradienti = listOf(args.gradienti, "gradienti", 16);
    if (typeof gradienti === "string") return fail(gradienti);
    if (gradienti.length > 0) {
      const res = [];
      for (const [i, v] of gradienti.entries()) {
        const g = (v ?? {}) as Record<string, unknown>;
        const da = parsePoint(g.da, `gradienti[${i}].da`);
        if (typeof da === "string") return fail(da);
        const a = parsePoint(g.a, `gradienti[${i}].a`);
        if (typeof a === "string") return fail(a);
        if (!inside(img, da) || !inside(img, a)) {
          return fail(
            `gradienti[${i}]: da e a devono stare dentro l'immagine (${img.width}×${img.height})`,
          );
        }
        const n = g.tappe ?? 5;
        if (!isNum(n) || !Number.isInteger(n) || n < 2 || n > 64) {
          return fail(`gradienti[${i}].tappe deve essere un numero intero da 2 a 64`);
        }
        res.push({
          da,
          a,
          tappe: gradientStops(img, da, a, n).map((s) => ({
            t: s.t,
            at: s.at,
            ...(k !== null ? { scalato: [sc(s.at[0]), sc(s.at[1])] } : {}),
            rgb: roundRgb(s.rgb),
            hex: toHex(s.rgb),
          })),
        });
      }
      out.gradienti = res;
    }

    const raggi = listOf(args.raggi, "raggi", 16);
    if (typeof raggi === "string") return fail(raggi);
    if (raggi.length > 0) {
      const res = [];
      for (const [i, v] of raggi.entries()) {
        const b = boxIn(img, v, `raggi[${i}]`);
        if (typeof b === "string") return fail(b);
        const m = cornerRadius(img, b);
        res.push({
          area: b,
          raggio: m.raggio,
          ...(k !== null ? { raggioScalato: sc(m.raggio) } : {}),
          angoli: m.angoli,
          larghezza: m.larghezza,
          altezza: m.altezza,
          ...(k !== null
            ? { larghezzaScalata: sc(m.larghezza), altezzaScalata: sc(m.altezza) }
            : {}),
          riempimento: toHex(m.riempimento),
          sfondo: toHex(m.sfondo),
          affidabile: m.affidabile,
          note: m.note,
          metodo:
            "area mancante agli angoli rispetto al rettangolo pieno (copertura con antialias)",
        });
      }
      out.raggi = res;
    }

    const testo = listOf(args.testo, "testo", 16);
    if (typeof testo === "string") return fail(testo);
    if (testo.length > 0) {
      const res = [];
      for (const [i, v] of testo.entries()) {
        const b = boxIn(img, v, `testo[${i}]`);
        if (typeof b === "string") return fail(b);
        const soglia = (v as Record<string, unknown>).soglia ?? 0.25;
        if (!isNum(soglia) || soglia <= 0 || soglia >= 1) {
          return fail(`testo[${i}].soglia deve essere un numero tra 0 e 1`);
        }
        const m = capHeight(img, b, soglia);
        const f = estimateFontSize(m.altezzaMaiuscole);
        res.push({
          area: b,
          altezzaMaiuscole: m.altezzaMaiuscole,
          ...(k !== null ? { altezzaScalata: sc(m.altezzaMaiuscole) } : {}),
          corpoStimato: round(f.corpo, 1),
          corpoMin: round(f.min, 1),
          corpoMax: round(f.max, 1),
          ...(k !== null
            ? {
                corpoScalato: sc(f.corpo),
                corpoMinScalato: sc(f.min),
                corpoMaxScalato: sc(f.max),
              }
            : {}),
          righe: m.righe,
          da: m.da,
          a: m.a,
          sfondo: toHex(m.sfondo),
          nota:
            "stima: il corpo è l'altezza delle maiuscole divisa per 0,70 (tra 0,66 e 0,75 secondo il carattere). " +
            "Misura solo maiuscole o cifre: ascendenti, discendenti e accenti allungano la misura.",
        });
      }
      out.testo = res;
    }

    if (args.crop !== undefined) {
      const b = boxIn(img, args.crop, "crop");
      if (typeof b === "string") return fail(b);
      const z = (args.crop as Record<string, unknown>).zoom;
      if (z !== undefined && (!isNum(z) || !Number.isInteger(z) || z < 1 || z > 16)) {
        return fail("crop.zoom deve essere un numero intero da 1 a 16");
      }
      const c = cropZoom(img, b, z as number | undefined);
      const inline = inlinePng("crop", c.image, CROP_MAX_EDGE);
      out.crop = {
        area: b,
        ...(k !== null ? { areaScalata: scBox(b) } : {}),
        zoom: c.zoom,
        size: [c.image.width, c.image.height],
        ...(inline.warning ? { avviso: inline.warning } : {}),
      };
      out[OP_INLINE_IMAGES_KEY] = inline.images;
    }
    return out;
  },
});

// --- frame.compare ---------------------------------------------------------------

registerOp({
  name: "frame.compare",
  category: "frame",
  readOnly: true,
  description:
    "Controllo del fotogramma (nome provvisorio): compare a rendered PNG with a reference PNG. Both are " +
    "brought to the same size and cut into a grid (default 24×24); each cell's mean color is compared " +
    "with ΔE2000. Returns mean and max ΔE, how many cells are over `sogliaCella` (default 10), the worst " +
    "cells with their position in the rendered file, and a verdict: passes when at most `maxCelleFuori` " +
    "(default 0.05 = 5 %) of the cells are over and the mean is at most `maxMedia` (default 8). " +
    "`mappa` (default true) adds an inline image: the frame in grey, cells green→yellow→red. PNG only; read-only.",
  params: [
    { name: "file", type: "string", description: "The rendered frame (PNG)", required: true },
    { name: "reference", type: "string", description: "The reference image (PNG)", required: true },
    {
      name: "griglia",
      type: "number",
      description: "Cells per side, 2–64 (default 24)",
      required: false,
      default: COMPARE_DEFAULTS.grid,
    },
    {
      name: "sogliaCella",
      type: "number",
      description: "ΔE2000 above which a cell is out (default 10)",
      required: false,
      default: COMPARE_DEFAULTS.cellThreshold,
    },
    {
      name: "maxCelleFuori",
      type: "number",
      description: "Largest fraction of cells out that still passes, 0–1 (default 0.05)",
      required: false,
      default: COMPARE_DEFAULTS.maxOutside,
    },
    {
      name: "maxMedia",
      type: "number",
      description: "Largest mean ΔE2000 that still passes (default 8)",
      required: false,
      default: COMPARE_DEFAULTS.maxMean,
    },
    {
      name: "peggiori",
      type: "number",
      description: "How many worst cells to list, 0–100 (default 10)",
      required: false,
      default: COMPARE_DEFAULTS.worst,
    },
    {
      name: "mappa",
      type: "boolean",
      description: "Return the difference map as an inline image (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx: () => nodeOnly("frame.compare"),
  async run(args) {
    const grid = args.griglia ?? COMPARE_DEFAULTS.grid;
    if (!isNum(grid) || !Number.isInteger(grid) || grid < 2 || grid > 64) {
      return fail("griglia deve essere un numero intero da 2 a 64");
    }
    const cellThreshold = args.sogliaCella ?? COMPARE_DEFAULTS.cellThreshold;
    if (!isNum(cellThreshold) || cellThreshold <= 0)
      return fail("sogliaCella deve essere maggiore di 0");
    const maxOutside = args.maxCelleFuori ?? COMPARE_DEFAULTS.maxOutside;
    if (!isNum(maxOutside) || maxOutside < 0 || maxOutside > 1) {
      return fail("maxCelleFuori deve essere una frazione da 0 a 1 (0.05 = 5 %)");
    }
    const maxMean = args.maxMedia ?? COMPARE_DEFAULTS.maxMean;
    if (!isNum(maxMean) || maxMean < 0) return fail("maxMedia deve essere 0 o più");
    const worst = args.peggiori ?? COMPARE_DEFAULTS.worst;
    if (!isNum(worst) || !Number.isInteger(worst) || worst < 0 || worst > 100) {
      return fail("peggiori deve essere un numero intero da 0 a 100");
    }

    const a = await loadPng(args.file, "file");
    if (isFailure(a)) return a;
    const b = await loadPng(args.reference, "reference");
    if (isFailure(b)) return b;

    let r;
    try {
      r = compareImages(a.img, b.img, { grid, cellThreshold, maxOutside, maxMean, worst });
    } catch (err) {
      return fail(`confronto impossibile: ${errText(err)}`);
    }
    const pct = (v: number) => `${round(v * 100, 1)} %`;
    const reasons: string[] = [];
    if (r.outside.fraction > maxOutside) {
      reasons.push(`celle fuori soglia ${pct(r.outside.fraction)} (massimo ${pct(maxOutside)})`);
    }
    if (r.mean > maxMean) reasons.push(`ΔE medio ${round(r.mean, 2)} (massimo ${maxMean})`);
    const esito = r.pass
      ? `passa: ΔE medio ${round(r.mean, 2)}, celle fuori soglia ${pct(r.outside.fraction)}`
      : `non passa: ${reasons.join("; ")}`;

    const avvisi: string[] = [];
    if (a.img.width !== b.img.width || a.img.height !== b.img.height) {
      avvisi.push(
        `dimensioni diverse (${a.img.width}×${a.img.height} e ${b.img.width}×${b.img.height}): confronto fatto a ${r.size[0]}×${r.size[1]}`,
      );
    }
    if (r.aspectMismatch) {
      avvisi.push(
        "le proporzioni delle due immagini sono diverse: per confrontarle sono state deformate, il risultato vale poco",
      );
    }

    const out: Record<string, unknown> = {
      ok: true,
      file: slash(a.abs),
      reference: slash(b.abs),
      size: r.size,
      griglia: r.grid,
      media: round(r.mean, 2),
      massimo: round(r.max, 2),
      fuori: { celle: r.outside.count, percentuale: round(r.outside.fraction, 4) },
      passa: r.pass,
      esito,
      soglie: { sogliaCella: cellThreshold, maxCelleFuori: maxOutside, maxMedia: maxMean },
      peggiori: r.worst.map((c) => ({
        riga: c.row,
        colonna: c.col,
        area: c.area,
        deltaE: round(c.deltaE, 2),
        colore: toHex(c.color),
        coloreReference: toHex(c.referenceColor),
      })),
    };
    if (args.mappa !== false) {
      const inline = inlinePng("map", differenceMap(a.img, r), 512);
      if (inline.warning) avvisi.push(inline.warning);
      out[OP_INLINE_IMAGES_KEY] = inline.images;
    }
    if (avvisi.length > 0) out.avvisi = avvisi;
    return out;
  },
});
