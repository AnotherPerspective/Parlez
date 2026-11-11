// Recipes on a real After Effects (M6.1 "fatto quando"): the lower third of
// the recipe format spec §12 is built with the Lanterna Blu example archive, its
// acceptance checks pass, and ONE project.undo removes all of it.
//
// NOT RUN by the session that wrote it: it needs After Effects and the
// maintainer's ok. SESSION-MUTATING: it closes the project open in After Effects and
// restores it afterwards, so it requires AE_MCP_E2E=1 (same gate as
// checkpoint.test.ts). The frames it renders go to its own scratch folder.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  E2E_SCRATCH_DIR,
  backupAndOpenTestProject,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";
const WORK_DIR = path.join(E2E_SCRATCH_DIR, `recipes-${Date.now()}`);
const ARCHIVE = fileURLToPath(new URL("../fixtures/archivio-lanterna-blu/", import.meta.url));
const ARGS = { title: "Mario Rossi", subtitle: "Direttrice della fotografia" };

interface RunReport {
  ok: boolean;
  comp: string;
  acceptance: {
    passed: number;
    failed: number;
    unverified: number;
    checks: Array<{ check: string; layer?: string; outcome: string; detail: string }>;
    frames: string[];
  };
  usedCardsLine: string;
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;

describe("e2e recipes (lower third → checks → one undo)", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("recipes", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
      ]);
      return;
    }
    const probe = await probeAe("recipes");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    await fs.mkdir(WORK_DIR, { recursive: true });
    saved = await backupAndOpenTestProject(transport);
    ready = true;
  });

  afterAll(async () => {
    if (transport && saved) await restoreUserProject(transport, saved);
    if (ready) await fs.rm(WORK_DIR, { recursive: true, force: true });
  });

  it("builds the lower third and its acceptance checks pass", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const report = await opRunner(transport).run<RunReport>("recipe.run", {
      recipe: "r-lower-third-barra",
      args: ARGS,
      archivio: ARCHIVE,
      framesDir: WORK_DIR,
    });
    expect(report.ok).toBe(true);
    expect(report.comp).toBe("LT – Mario Rossi");
    const notOk = report.acceptance.checks.filter((c) => c.outcome !== "ok");
    // Fonts are the one check that depends on the machine: without Inter
    // installed After Effects substitutes it, and the check must say so.
    const unexpected = notOk.filter((c) => c.check !== "fontIs");
    expect(unexpected, JSON.stringify(notOk, null, 2)).toEqual([]);
    for (const f of report.acceptance.frames) await expect(fs.stat(f)).resolves.toBeTruthy();
    expect(report.usedCardsLine).toMatch(/^Schede usate: stile s-lanterna v3/);
  });

  it("one project.undo removes the whole piece, comp included", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const ops = opRunner(transport);
    await ops.run("project.undo", {});
    const listed = await ops.run<{ items: Array<{ name: string }> }>("item.list", {
      type: "CompItem",
      nameContains: "LT – Mario Rossi",
    });
    expect(listed.items.map((i) => i.name)).toEqual([]);
  });
});
