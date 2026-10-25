// Parlez! recipes (provisional names): recipe.list, recipe.plan, recipe.run.
//
// Node-side operations. A recipe is data (recipes/*.json, format in
// src/recipes/types.ts); the executor resolves it offline and builds ONE
// batch.run, so the whole piece lands in a single undo group. recipe.plan
// stops before After Effects and returns the operation list — it is what the
// tests use and what Claude can show before running.

import * as os from "node:os";
import * as path from "node:path";

import { validateOpArgs } from "../opschema.js";
import { executeOp } from "../recipes/execute.js";
import type { Plan } from "../recipes/generate.js";
import { evaluateAcceptance } from "../recipes/generate.js";
import { RECIPES_DIR_ENV, listRecipes, planRecipe } from "../recipes/library.js";
import { ARCHIVE_DIR_ENV } from "../recipes/archive.js";
import { RecipeError } from "../recipes/types.js";
import { getOp, jsxFail, registerOp } from "../registry.js";

function nodeOnly(name: string): string {
  return jsxFail(
    `${name} runs on the Node side (it builds a batch.run itself) — call it as its own ae_do, not inside batch.run`,
  );
}

function fail(error: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, error, ...extra };
}

/** Default folder for the acceptance frames: outside the IPC mailbox, per user. */
function defaultFramesDir(): string {
  return path.join(os.tmpdir(), "parlez-ricette");
}

const RECIPE_PARAM = {
  name: "recipe",
  type: "string" as const,
  description:
    "Recipe id or file name, from recipe.list (e.g. 'r-lower-third-barra' or 'lower-third').",
  required: true,
};
const ARGS_PARAM = {
  name: "args",
  type: "object" as const,
  description:
    "Recipe parameters to override (e.g. { title: 'Mario Rossi', subtitle: 'Regista', format: '9:16' }). Everything omitted comes from the archive, then from the recipe's defaults.",
  required: false,
};
const ARCHIVE_PARAM = {
  name: "archivio",
  type: "string" as const,
  description: `Archive folder (the archive format spec) the recipe takes colors, fonts and timings from. Default: ${ARCHIVE_DIR_ENV}; with neither, the recipe's own defaults are used and the report says so.`,
  required: false,
};
const FRAMES_PARAM = {
  name: "framesDir",
  type: "string" as const,
  description:
    "Absolute folder for the acceptance frames (PNG). Default: the OS temp folder, subfolder parlez-ricette.",
  required: false,
};

/** Every generated op must exist and accept its arguments: a last guard before AE. */
function selfCheck(plan: Plan): string[] {
  const problems: string[] = [];
  plan.batch.args.ops.forEach((o, i) => {
    const op = getOp(o.operation);
    if (!op) return problems.push(`passo ${i + 1}: operazione «${o.operation}» inesistente`);
    const v = validateOpArgs(op, o.args);
    if (!v.ok)
      problems.push(
        `passo ${i + 1} (${o.operation}): ${v.issues.map((x) => `${x.path} — ${x.message}`).join("; ")}`,
      );
  });
  return problems;
}

function planOrFail(
  args: Record<string, unknown>,
  existingNames?: string[],
): Plan | ReturnType<typeof fail> {
  try {
    const plan = planRecipe({
      recipe: String(args.recipe),
      args: (args.args as Record<string, unknown> | undefined) ?? {},
      archivio: args.archivio as string | undefined,
      existingNames,
      framesDir:
        typeof args.framesDir === "string" && args.framesDir.trim() !== ""
          ? args.framesDir
          : defaultFramesDir(),
    });
    const problems = selfCheck(plan);
    if (problems.length > 0)
      return fail(
        `la ricetta ha prodotto operazioni non valide (errore interno): ${problems.join(" | ")}`,
      );
    return plan;
  } catch (err) {
    if (err instanceof RecipeError) {
      return fail(`la ricetta non si può preparare: ${err.message}`, {
        issues: err.issues,
        errorCode: "INVALID_ARGS",
      });
    }
    throw err;
  }
}

registerOp({
  name: "recipe.list",
  category: "recipe",
  description:
    "List the Parlez! recipes (reusable pieces: lower third, title…) shipped in recipes/ and in the user folder " +
    `${RECIPES_DIR_ENV}: id, title, one-line summary, version, and any validation problem. Run one with recipe.plan / recipe.run.`,
  params: [],
  readOnly: true,
  toJsx: () => nodeOnly("recipe.list"),
  async run() {
    const all = listRecipes();
    return {
      ok: true,
      recipes: all.map((r) => {
        const raw = (r.raw ?? {}) as Record<string, unknown>;
        const entry: Record<string, unknown> = {
          id: raw.id ?? r.stem,
          file: path.basename(r.file),
          source: r.source,
          title: raw.title ?? null,
          summary: raw.summary ?? null,
          version: raw.version ?? null,
          status: raw.status ?? null,
          params: r.recipe ? Object.keys(r.recipe.params) : [],
          valid: r.recipe !== null,
        };
        if (!r.recipe)
          entry.problems = r.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
        return entry;
      }),
    };
  },
});

registerOp({
  name: "recipe.plan",
  category: "recipe",
  description:
    "Prepare a recipe WITHOUT touching After Effects: resolve its parameters (args → archive → defaults), convert times to frames, " +
    "named curves to speed/influence, place it in the format's safe area, and return the exact batch.run it would send, " +
    "the acceptance checks, the readable summary and the archive cards used. Show it to the user before recipe.run when in doubt.",
  params: [
    RECIPE_PARAM,
    ARGS_PARAM,
    ARCHIVE_PARAM,
    FRAMES_PARAM,
    {
      name: "existingNames",
      type: "array",
      description:
        "Comp names already in the project, to pick a free name (recipe.run reads them itself).",
      required: false,
    },
  ],
  readOnly: true,
  toJsx: () => nodeOnly("recipe.plan"),
  async run(args) {
    const plan = planOrFail(
      args,
      Array.isArray(args.existingNames) ? (args.existingNames as string[]) : undefined,
    );
    if ("ok" in plan) return plan;
    return { ok: true, ...plan };
  },
});

registerOp({
  name: "recipe.run",
  category: "recipe",
  description:
    "Build a recipe in After Effects: one read (comp names, to avoid a duplicate), then ONE batch.run — a single Ctrl+Z removes " +
    "everything — with the verification reads at its tail. Returns the acceptance checks (safe area, fonts, values, frames to look at), " +
    "what to look at, and the archive cards used: quote `usedCardsLine` to the user. If a building step fails, what was built is undone " +
    "with one project.undo (undoOnError, default true).",
  params: [
    RECIPE_PARAM,
    ARGS_PARAM,
    ARCHIVE_PARAM,
    FRAMES_PARAM,
    {
      name: "undoOnError",
      type: "boolean",
      description: "Undo the partial build when a building step fails (default true).",
      required: false,
    },
    {
      name: "timeoutMs",
      type: "number",
      description:
        "Timeout for the build call in milliseconds (default 120000; the frames take time).",
      required: false,
    },
  ],
  toJsx: () => nodeOnly("recipe.run"),
  async run(args, transport) {
    const first = planOrFail(args);
    if ("ok" in first) return first;

    // kumo finds comps by name and takes the first match: read the names that
    // could collide, then plan again with them so the new comp gets a free one.
    const listed = await executeOp(
      transport,
      "item.list",
      { type: "CompItem", nameContains: first.comp.name },
      { label: "recipe.run: nomi" },
    );
    if (!listed.ok)
      return fail(`non riesco a leggere le composizioni del progetto: ${listed.error}`, {
        errorCode: listed.errorCode,
      });
    const items = (
      (listed.result as { items?: Array<{ name?: unknown }> } | null)?.items ?? []
    ).map((i) => String(i.name));
    const plan = items.length > 0 ? planOrFail(args, items) : first;
    if ("ok" in plan) return plan;

    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 120_000;
    const ran = await executeOp(transport, "batch.run", plan.batch.args, {
      label: `Parlez! ${plan.recipe.id}`,
      timeoutMs,
    });
    if (!ran.ok)
      return fail(`After Effects non ha eseguito la ricetta: ${ran.error}`, {
        errorCode: ran.errorCode,
      });

    const results = ((ran.result as { results?: unknown[] } | null)?.results ?? []) as unknown[];
    const failedAt = results.findIndex(
      (r, i) => i < plan.construction && (r as { ok?: unknown } | null)?.ok === false,
    );
    if (failedAt >= 0) {
      const step = plan.batch.args.ops[failedAt];
      const error = String((results[failedAt] as { error?: unknown }).error ?? "errore");
      // Undo only when something was built: an empty undo group is not on the
      // stack, and an undo then would revert the user's own previous action.
      const builtSomething = results
        .slice(0, failedAt)
        .some((r) => (r as { ok?: unknown } | null)?.ok === true);
      let undone = false;
      if (args.undoOnError !== false && builtSomething) {
        const u = await executeOp(transport, "project.undo", {}, { label: "recipe.run: annulla" });
        undone = u.ok;
      }
      return fail(
        `la costruzione si è fermata al passo ${failedAt + 1} (${step.operation}): ${error}. ` +
          (undone
            ? "Quello che era stato creato è stato annullato (un Ctrl+Z)."
            : builtSomething
              ? "Quello che era stato creato è rimasto: un Ctrl+Z lo toglie."
              : "Non è stato creato niente."),
        { failedStep: { index: failedAt, operation: step.operation, args: step.args }, undone },
      );
    }

    const checks = evaluateAcceptance(plan, results);
    const failed = checks.filter((c) => c.outcome === "fallito").length;
    const unverified = checks.filter((c) => c.outcome === "non verificabile").length;
    return {
      ok: true,
      comp: plan.comp.name,
      operations: plan.batch.args.ops.length,
      construction: plan.construction,
      acceptance: {
        passed: checks.length - failed - unverified,
        failed,
        unverified,
        checks,
        look: plan.look,
        frames: plan.reads
          .filter((r) => r.kind === "frame")
          .map((r) => (r as { outPath: string }).outPath),
      },
      usedCards: plan.usedCards,
      usedCardsLine: plan.usedCardsLine,
      defaultsUsed: plan.defaultsUsed,
      warnings: plan.warnings,
      confidentiality: plan.confidentiality,
      summary: plan.summary,
    };
  },
});
