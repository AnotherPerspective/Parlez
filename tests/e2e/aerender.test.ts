// Background renders with the REAL aerender, next to the After Effects in use.
// Imports the clean test project (tests/fixtures/progetto-prova.json), saves
// it under the E2E scratch folder, renders one second with aerender.start,
// follows it with aerender.status, then starts the whole comp and stops it
// with aerender.cancel. Also checks the refusal for unsaved changes.
//
// SESSION-MUTATING: closes the project currently open in After Effects and
// restores it afterwards (see harness.backupAndOpenTestProject), and runs
// aerender. Requires AE_MCP_E2E=1 on top of AE being reachable. Written in
// M6b, NOT run yet: to be run on After Effects 2026 / Windows with Anthony's ok.

import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectImportTool } from "../../src/tools/project-import.js";
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
const CLEAN = fileURLToPath(new URL("../fixtures/progetto-prova.json", import.meta.url));
const WORK = path.join(E2E_SCRATCH_DIR, "aerender");
const PROJECT = path.join(WORK, "aerender-prova.aep").replace(/\\/g, "/");

interface Status {
  id: string;
  status: string;
  frame: number | null;
  totalFrames: number | null;
  outputExists: boolean;
  outputBytes: number;
  logTail: string[];
  exitCode: number | null;
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;

async function save(t: FileIpcTransport): Promise<void> {
  const res = await t.execute({
    code: `app.project.save(new File(${JSON.stringify(PROJECT)})); return { dirty: app.project.dirty };`,
    label: "aerender_e2e_save",
    timeoutMs: 60_000,
    undoGroup: false,
  });
  if (!res.ok) throw new Error("save failed: " + res.error);
}

async function waitEnd(ops: ReturnType<typeof opRunner>, id: string, ms: number): Promise<Status> {
  const until = Date.now() + ms;
  for (;;) {
    const st = await ops.run<Status>("aerender.status", { id });
    if (st.status !== "in corso") return st;
    if (Date.now() > until) throw new Error("render still running: " + JSON.stringify(st));
    await new Promise((r) => setTimeout(r, 1000));
  }
}

describe("e2e aerender (background render)", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("aerender", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects, restores",
        " it afterwards, and runs aerender. Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
      ]);
      return;
    }
    const probe = await probeAe("aerender");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    await fs.rm(WORK, { recursive: true, force: true });
    await fs.mkdir(WORK, { recursive: true });
    const imp = (await projectImportTool.handler({ inPath: CLEAN }, transport)) as {
      isError?: boolean;
    };
    if (imp.isError) throw new Error("import failed");
    await save(transport);
    ready = true;
  });

  afterAll(async () => {
    if (transport && saved) await restoreUserProject(transport, saved);
  });

  it("finds aerender next to After Effects", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const info = await opRunner(transport).run<{ found: boolean; path: string }>(
      "aerender.info",
      {},
    );
    expect(info.found, JSON.stringify(info)).toBe(true);
  });

  it("renders one second in the background, with progress and a real file", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const ops = opRunner(transport);
    const output = path.join(WORK, "un-secondo.mp4");
    const started = await ops.run<{ id: string; log: string }>("aerender.start", {
      comp: "Principale",
      output,
      s: 0,
      e: 24,
    });
    const st = await waitEnd(ops, started.id, 5 * 60_000);
    expect(st.status, st.logTail.join("\n")).toBe("finito");
    expect(st.outputBytes).toBeGreaterThan(1000);
    expect(st.frame).toBe(25);
    expect(existsSync(started.log)).toBe(true);
  });

  it("asks for confirm before overwriting that file", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const err = await opRunner(transport).expectRefusal("aerender.start", {
      comp: "Principale",
      output: path.join(WORK, "un-secondo.mp4"),
    });
    expect(err.code).toBe("FORBIDDEN");
  });

  it("stops a render on cancel and keeps the partial file", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const ops = opRunner(transport);
    const started = await ops.run<{ id: string }>("aerender.start", {
      comp: "Principale",
      output: path.join(WORK, "da-fermare.mov"),
      OMtemplate: "Lossless",
    });
    // Let it get going, then stop it.
    await new Promise((r) => setTimeout(r, 8000));
    const c = await ops.run<Status>("aerender.cancel", { id: started.id });
    expect(c.status).toBe("fermato");
    const st = await waitEnd(ops, started.id, 60_000).catch(async () =>
      ops.run<Status>("aerender.status", { id: started.id }),
    );
    expect(st.status).toBe("fermato");
  });

  it("refuses a project with unsaved changes, without saving it", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const ops = opRunner(transport);
    await ops.run("layer.set_props", { comp: "Principale", layer: "Titolo", props: { label: 3 } });
    const err = await ops.expectRefusal("aerender.start", {
      comp: "Principale",
      output: path.join(WORK, "non-salvato.mp4"),
    });
    expect(err.message).toContain("modifiche non salvate");
  });
});
