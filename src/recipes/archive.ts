// Reading an archive to resolve a recipe's `$ref`s.
//
// Only the folder the caller names is read — by the `archivio` parameter or
// AE_MCP_ARCHIVE_DIR — and only through its archivio.json
// index: bozze/ and storico/ are never listed there, and a card that is not
// `approved` never resolves, so a draft of the grinding step cannot leak into
// a build. There is no default folder: without an archive every reference
// falls back to the recipe's own literal and the report says so.

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import type { Value } from "./types.js";
import { RecipeError } from "./types.js";

export const ARCHIVE_DIR_ENV = "AE_MCP_ARCHIVE_DIR";

interface IndexEntry {
  id: string;
  kind: "style" | "technique" | "recipe" | "sample";
  role?: string;
  version: number;
  file: string;
  summary?: string;
}

interface ArchiveFile {
  format: string;
  id: string;
  title?: string;
  confidentiality?: string;
  roles?: { style?: string; technique?: Record<string, string> };
  index: IndexEntry[];
}

export interface Card {
  id: string;
  kind: string;
  version: number;
  status: string;
  [k: string]: unknown;
}

export interface UsedCard {
  id: string;
  kind: string;
  version: number;
  fields: string[];
}

export interface Archive {
  dir: string;
  id: string;
  title: string;
  confidentiality: string;
  card(id: string): Card | null;
  styleCard(): Card | null;
  techniqueFor(role: string): Card | null;
}

/** The archive folder to use: the explicit parameter, else the env var, else none. */
export function archiveDirFrom(
  param: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof param === "string" && param.trim() !== "") return param.trim();
  const fromEnv = env[ARCHIVE_DIR_ENV]?.trim();
  return fromEnv ? fromEnv : null;
}

export function loadArchive(dir: string): Archive {
  const indexPath = path.join(dir, "archivio.json");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new RecipeError(`l'archivio «${dir}» non esiste o non è una cartella`);
  }
  if (!existsSync(indexPath)) {
    throw new RecipeError(`nell'archivio «${dir}» manca archivio.json`);
  }
  let parsed: ArchiveFile;
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8")) as ArchiveFile;
  } catch (err) {
    throw new RecipeError(
      `archivio.json non si legge: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed.index)) {
    throw new RecipeError("archivio.json: manca l'elenco «index» delle schede");
  }
  const byId = new Map<string, IndexEntry>();
  for (const e of parsed.index) byId.set(e.id, e);
  const cache = new Map<string, Card | null>();
  const root = path.resolve(dir);

  const card = (id: string): Card | null => {
    if (cache.has(id)) return cache.get(id) ?? null;
    const entry = byId.get(id);
    let result: Card | null = null;
    if (entry) {
      const file = path.resolve(root, entry.file);
      // A card file outside the archive folder (or in its drafts) is not part
      // of the archive, whatever the index says.
      const rel = path.relative(root, file);
      const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      const firstDir = rel.split(/[\\/]/)[0];
      if (inside && firstDir !== "bozze" && firstDir !== "storico" && existsSync(file)) {
        try {
          const c = JSON.parse(readFileSync(file, "utf8")) as Card;
          if (c && c.id === id && c.status === "approved") result = c;
        } catch {
          result = null;
        }
      }
    }
    cache.set(id, result);
    return result;
  };

  return {
    dir: root,
    id: parsed.id,
    title: parsed.title ?? parsed.id,
    confidentiality: parsed.confidentiality ?? "interno-app",
    card,
    styleCard() {
      const id = parsed.roles?.style ?? parsed.index.find((e) => e.kind === "style")?.id;
      return id ? card(id) : null;
    },
    techniqueFor(role: string) {
      const id =
        parsed.roles?.technique?.[role] ??
        parsed.index.find((e) => e.kind === "technique" && e.role === role)?.id;
      return id ? card(id) : null;
    },
  };
}

export type RefResult =
  | { ok: true; value: Value; card: Card; field: string }
  | { ok: false; reason: string };

const REF_RE = /^(style|technique|card):([^/]+)\/(.+)$/;

/** True when `ref` has one of the shapes of the recipe format §4.2. */
export function isWellFormedRef(ref: string): boolean {
  const m = REF_RE.exec(ref);
  if (!m) return false;
  if (m[1] === "style") return ["color", "font", "size"].includes(m[2]);
  return true;
}

function dig(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Resolve one reference. Style references go through the style card's
 * `roles` (a recipe asks for "primary", the archive says which named color
 * that is); technique references through archivio.json's roles; card
 * references by id. A technique field is looked up in `motion` first, then
 * at the top of the card.
 */
export function resolveRef(ref: string, archive: Archive | null): RefResult {
  const m = REF_RE.exec(ref);
  if (!m) return { ok: false, reason: `il riferimento «${ref}» non è scritto bene` };
  if (!archive) return { ok: false, reason: "nessun archivio indicato" };
  const [, scheme, a, field] = m;

  if (scheme === "style") {
    const style = archive.styleCard();
    if (!style) return { ok: false, reason: "l'archivio non ha una scheda di stile approvata" };
    if (a === "size") {
      const v = dig(style.sizes, field);
      return v === undefined
        ? { ok: false, reason: `la scheda di stile non ha la misura «${field}»` }
        : { ok: true, value: v as Value, card: style, field: `size/${field}` };
    }
    const roleTable = a === "color" ? "color" : "font";
    const named = dig(style.roles, `${roleTable}.${field}`);
    if (typeof named !== "string") {
      return { ok: false, reason: `la scheda di stile non assegna il ruolo ${a}/${field}` };
    }
    const table = a === "color" ? style.colors : style.fonts;
    const entry = dig(table, named);
    if (entry === undefined) {
      return { ok: false, reason: `il ruolo ${a}/${field} punta a «${named}», che non c'è` };
    }
    if (a === "color") {
      const hex = dig(entry, "hex");
      return typeof hex === "string"
        ? { ok: true, value: hex, card: style, field: `color/${field}` }
        : { ok: false, reason: `il colore «${named}» non ha «hex»` };
    }
    return { ok: true, value: entry as Value, card: style, field: `font/${field}` };
  }

  const card = scheme === "technique" ? archive.techniqueFor(a) : archive.card(a);
  if (!card) {
    return {
      ok: false,
      reason:
        scheme === "technique"
          ? `nessuna scheda tecnica approvata con il ruolo «${a}»`
          : `nessuna scheda approvata con id «${a}»`,
    };
  }
  const v = dig(card.motion, field) ?? dig(card, field);
  return v === undefined
    ? { ok: false, reason: `la scheda ${card.id} non ha il campo «${field}»` }
    : { ok: true, value: v as Value, card, field };
}

/** The style card's formats table, or null. */
export function archiveFormats(archive: Archive | null): Record<string, unknown> | null {
  const style = archive?.styleCard();
  const f = style?.formats;
  return f && typeof f === "object" ? (f as Record<string, unknown>) : null;
}
