// comp.audit on a real After Effects: import each test
// project with ae_project_import_json, run the audit, and check it finds the
// planted errors and nothing else — the acceptance test of M4.3. Also checks
// that the audit leaves the project exactly as it found it.
//
// SESSION-MUTATING: closes the project currently open in After Effects, works
// in fresh projects, and restores the original afterwards (dirty or unsaved
// projects are Save-As'd first — see harness.backupAndOpenTestProject).
// Requires AE_MCP_E2E=1 on top of AE being reachable. Not run yet: written in
// M4b, to be run on After Effects 2026 / Windows with the maintainer's ok.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectImportTool } from "../../src/tools/project-import.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  backupAndOpenTestProject,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const CLEAN = path.join(FIXTURES, "progetto-prova.json");
const PLANTED = path.join(FIXTURES, "errori-3.json");

/** Same expectation as the offline tests/audit-fixtures.test.ts. */
const EXPECTED_ERRORI_3 = [
  { regola: "keyframe-lineari", livello: "Cerchio" },
  { regola: "movimento-senza-motion-blur", livello: "Cerchio" },
  { regola: "fuori-dal-tempo", livello: "Credito finale" },
  { regola: "area-sicura", livello: "Sottotitolo" },
];

interface Report {
  ok: boolean;
  solaLettura: boolean;
  temporanei: unknown[];
  segnalazioni: Array<{ regola: string; livello: string | null; messaggio: string }>;
  riepilogo: {
    testo: string;
    totale: number;
    elementiConSegnalazioni: number;
    composizioniControllate: string[];
  };
  nonControllate: unknown[];
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;

async function freshProject(t: FileIpcTransport): Promise<void> {
  const res = await t.execute({
    code: `
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      app.newProject();
      return { numItems: app.project.numItems };
    `,
    label: "audit_fresh_project",
    timeoutMs: 30_000,
    undoGroup: false, // crosses a project boundary — see harness.backupAndOpenTestProject
  });
  if (!res.ok) throw new Error("fresh project failed: " + res.error);
}

async function importDoc(t: FileIpcTransport, inPath: string): Promise<string[]> {
  const res = (await projectImportTool.handler({ inPath }, t)) as {
    isError?: boolean;
    structuredContent?: { result?: { warnings?: string[] } };
  };
  expect(res.isError, "import failed: " + JSON.stringify(res.structuredContent)).toBeFalsy();
  return res.structuredContent?.result?.warnings ?? [];
}

/**
 * Everything the audit must not change, read straight from After Effects:
 * items, layers, switches, timing, effect and property counts, transform
 * values.
 */
async function projectState(t: FileIpcTransport): Promise<unknown> {
  const res = await t.execute({
    code: `
      var out = { numItems: app.project.numItems, comps: [] };
      for (var i = 1; i <= app.project.numItems; i++) {
          var it = app.project.item(i);
          if (!(it instanceof CompItem)) continue;
          var c = { name: it.name, motionBlur: it.motionBlur, layers: [] };
          for (var li = 1; li <= it.numLayers; li++) {
              var l = it.layer(li);
              var fx = l.property("ADBE Effect Parade");
              var tg = l.property("ADBE Transform Group");
              c.layers.push({
                  name: l.name, enabled: l.enabled, inPoint: l.inPoint, outPoint: l.outPoint,
                  motionBlur: l.motionBlur, threeD: l.threeDLayer,
                  effects: fx ? fx.numProperties : null,
                  position: String(tg.property("ADBE Position").value),
                  opacity: tg.property("ADBE Opacity").value
              });
          }
          out.comps.push(c);
      }
      return out;
    `,
    label: "audit_state",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("state read failed: " + res.error);
  return res.result;
}

describe("e2e comp.audit on the two test projects", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("audit", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
      ]);
      return;
    }
    const probe = await probeAe("audit");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    ready = true;
  });

  afterAll(async () => {
    if (transport && saved) await restoreUserProject(transport, saved);
  });

  it("finds nothing on the clean project, precomp included", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await freshProject(transport);
    const warnings = await importDoc(transport, CLEAN);
    const res = await opRunner(transport).run<Report>("comp.audit", {
      comp: "Principale",
      profondita: 1,
    });
    expect(res.nonControllate, "rules that failed to run").toEqual([]);
    expect(res.riepilogo.composizioniControllate).toEqual(["Principale", "Sfondo animato"]);
    expect(
      res.segnalazioni,
      "findings on the clean project (import warnings: " + JSON.stringify(warnings) + ")",
    ).toEqual([]);
  });

  it("finds the three planted errors and nothing else", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await freshProject(transport);
    const warnings = await importDoc(transport, PLANTED);
    const res = await opRunner(transport).run<Report>("comp.audit", {
      comp: "Principale",
      profondita: 1,
    });
    expect(res.nonControllate, "rules that failed to run").toEqual([]);
    const got = res.segnalazioni.map((f) => ({ regola: f.regola, livello: f.livello }));
    expect(got, "findings (import warnings: " + JSON.stringify(warnings) + ")").toEqual(
      EXPECTED_ERRORI_3,
    );
    expect(res.riepilogo.elementiConSegnalazioni).toBe(3);
    expect(res.riepilogo.testo).toBe(
      "3 problemi su 3 livelli, 4 segnalazioni (1 errore, 3 avvisi).",
    );
    for (const f of res.segnalazioni) expect(f.messaggio.length).toBeGreaterThan(10);
  });

  it("drops the motion blur finding once the circle's motion blur is on", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await freshProject(transport);
    await importDoc(transport, PLANTED);
    const ops = opRunner(transport);
    // The import format does not carry the layer switch; set it the way a
    // user (or Claude) would fix the finding.
    await ops.run("layer.set_props", {
      comp: "Principale",
      layer: "Cerchio",
      props: { motionBlur: true },
    });
    const res = await ops.run<Report>("comp.audit", { comp: "Principale", profondita: 1 });
    expect(res.nonControllate, "rules that failed to run").toEqual([]);
    const got = res.segnalazioni.map((f) => ({ regola: f.regola, livello: f.livello }));
    expect(got).toEqual(
      EXPECTED_ERRORI_3.filter((e) => e.regola !== "movimento-senza-motion-blur"),
    );
    expect(res.riepilogo.totale).toBe(3);
  });

  it("leaves the project exactly as it found it", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await freshProject(transport);
    await importDoc(transport, PLANTED);
    const before = await projectState(transport);
    const res = await opRunner(transport).run<Report>("comp.audit", {
      comp: "Principale",
      profondita: 1,
    });
    expect(res.solaLettura).toBe(true);
    expect(res.temporanei).toEqual([]);
    expect(await projectState(transport)).toEqual(before);
  });
});
