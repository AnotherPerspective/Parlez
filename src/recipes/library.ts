// Where recipes live and how one becomes a plan.
//
// Two folders, nothing else: the recipes shipped with Parlez! (recipes/ at the
// package root) and, optionally, a user folder named by AE_MCP_RECIPES_DIR
// (provisional name). A recipe is addressed by its id or its file name, never
// by an arbitrary path — the tool reads only these two folders.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { archiveDirFrom, loadArchive } from "./archive.js";
import type { Plan } from "./generate.js";
import { buildPlan } from "./generate.js";
import { resolveRecipe } from "./resolve.js";
import type { Recipe, RecipeIssue } from "./types.js";
import { RecipeError } from "./types.js";
import { validateRecipe } from "./validate.js";

export const RECIPES_DIR_ENV = "AE_MCP_RECIPES_DIR";

/** recipes/ next to src/ (sources) or dist/ (build): two levels up either way. */
export const BUILT_IN_RECIPES_DIR = fileURLToPath(new URL("../../recipes/", import.meta.url));

export interface RecipeFile {
  file: string;
  source: "incluse" | "utente";
}

export interface LoadedRecipe extends RecipeFile {
  stem: string;
  raw: unknown;
  recipe: Recipe | null;
  issues: RecipeIssue[];
}

function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

export function recipeFiles(env: NodeJS.ProcessEnv = process.env): RecipeFile[] {
  const out: RecipeFile[] = jsonFilesIn(BUILT_IN_RECIPES_DIR).map((file) => ({
    file,
    source: "incluse",
  }));
  const userDir = env[RECIPES_DIR_ENV]?.trim();
  if (userDir)
    out.push(...jsonFilesIn(userDir).map((file) => ({ file, source: "utente" as const })));
  return out;
}

export function loadRecipeFile(f: RecipeFile): LoadedRecipe {
  const stem = path.basename(f.file, path.extname(f.file));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f.file, "utf8"));
  } catch (err) {
    return {
      ...f,
      stem,
      raw: null,
      recipe: null,
      issues: [
        {
          path: "",
          message: `il file non è JSON valido: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const v = validateRecipe(raw);
  return { ...f, stem, raw, recipe: v.ok ? v.recipe : null, issues: v.issues };
}

export function listRecipes(env: NodeJS.ProcessEnv = process.env): LoadedRecipe[] {
  return recipeFiles(env).map(loadRecipeFile);
}

/** The recipe with this id or file name. Throws RecipeError, in Italian, when it is missing or invalid. */
export function findRecipe(name: string, env: NodeJS.ProcessEnv = process.env): LoadedRecipe {
  const all = listRecipes(env);
  const matches = all.filter(
    (r) => r.stem === name || (r.raw as { id?: unknown } | null)?.id === name,
  );
  if (matches.length === 0) {
    const ids = all.map((r) => (r.raw as { id?: unknown } | null)?.id ?? r.stem).join(", ");
    throw new RecipeError(`nessuna ricetta «${name}» (ci sono: ${ids || "nessuna"})`);
  }
  if (matches.length > 1) {
    throw new RecipeError(
      `ci sono ${matches.length} ricette «${name}» (${matches.map((m) => `${m.source}/${path.basename(m.file)}`).join(", ")}): togline una o usa il nome del file`,
    );
  }
  const found = matches[0];
  if (!found.recipe) throw new RecipeError(found.issues);
  return found;
}

export interface PlanRequest {
  recipe: string;
  args?: Record<string, unknown>;
  archivio?: string;
  existingNames?: string[];
  framesDir: string;
  env?: NodeJS.ProcessEnv;
}

/** Recipe name → plan, without After Effects. */
export function planRecipe(req: PlanRequest): Plan {
  const env = req.env ?? process.env;
  const loaded = findRecipe(req.recipe, env);
  const dir = archiveDirFrom(req.archivio, env);
  const archive = dir ? loadArchive(dir) : null;
  const resolved = resolveRecipe(loaded.recipe as Recipe, {
    args: req.args,
    archive,
    existingNames: req.existingNames,
  });
  if (!archive)
    resolved.warnings.unshift("nessun archivio indicato: uso i valori predefiniti della ricetta");
  return buildPlan(resolved, { framesDir: req.framesDir });
}
