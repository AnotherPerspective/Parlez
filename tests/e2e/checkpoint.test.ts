// Checkpoint cycle on a real After Effects: three checkpoints, ruin the
// project, restore the second, and check the project is the second again.
//
// SESSION-MUTATING: closes the project currently open in After Effects and
// restores it afterwards, so it requires AE_MCP_E2E=1 in addition to AE being
// reachable (same gate as tools.test.ts). Everything it writes — the test
// project and its checkpoint folder — lives in its own folder under the e2e
// scratch dir and is removed at the end.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BEFORE_RESTORE_LABEL } from "../../src/operations/checkpoint.js";
import { jsxVal } from "../../src/registry.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  E2E_SCRATCH_DIR,
  backupAndOpenTestProject,
  buildFixtureProject,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";
const WORK_DIR = path.join(E2E_SCRATCH_DIR, `checkpoint-${Date.now()}`);
const PROJECT = path.join(WORK_DIR, "cp_test.aep");

interface Shape {
  items: string[];
  layers: Record<string, number>;
}

async function shapeOf(transport: FileIpcTransport): Promise<Shape> {
  const res = await transport.execute({
    code: `
      var items = [];
      var layers = {};
      for (var i = 1; i <= app.project.numItems; i++) {
          var it = app.project.item(i);
          items.push(it.name);
          if (it instanceof CompItem) layers[it.name] = it.numLayers;
      }
      items.sort();
      return { items: items, layers: layers };
    `,
    label: "e2e_checkpoint_shape",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("shape failed: " + res.error);
  return res.result as Shape;
}

async function addComp(transport: FileIpcTransport, name: string): Promise<void> {
  const res = await transport.execute({
    code: `
      var c = app.project.items.addComp(${jsxVal(name)}, 640, 360, 1, 2, 25);
      c.layers.addNull();
      return { ok: true };
    `,
    label: "e2e_checkpoint_add_comp",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("addComp failed: " + res.error);
}

async function ruin(transport: FileIpcTransport): Promise<void> {
  const res = await transport.execute({
    code: `
      for (var i = app.project.numItems; i >= 1; i--) app.project.item(i).remove();
      return { ok: true, left: app.project.numItems };
    `,
    label: "e2e_checkpoint_ruin",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("ruin failed: " + res.error);
}

interface Created {
  path: string;
  file: string;
  savedAs: string | null;
}

interface Listed {
  checkpoints: Array<{ file: string; label: string; path: string }>;
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;
const created: Created[] = [];
let secondShape: Shape | null = null;

describe("e2e checkpoint (create → ruin → restore)", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("checkpoint", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
        "   cmd        : set AE_MCP_E2E=1 && npm test",
      ]);
      return;
    }
    const probe = await probeAe("checkpoint");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    await fs.mkdir(WORK_DIR, { recursive: true });
    saved = await backupAndOpenTestProject(transport);
    await buildFixtureProject(transport);
    ready = true;
  });

  afterAll(async () => {
    if (transport && saved) await restoreUserProject(transport, saved);
    if (ready) await fs.rm(WORK_DIR, { recursive: true, force: true });
  });

  it("refuses to checkpoint a never-saved project without saveAs", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const err = await opRunner(transport).expectRefusal("checkpoint.create", { name: "uno" });
    expect(err.message).toContain("mai stato salvato");
  });

  it("creates three checkpoints (the first saves the project via saveAs)", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const ops = opRunner(transport);
    created.push(await ops.run<Created>("checkpoint.create", { name: "uno", saveAs: PROJECT }));
    expect(created[0]!.savedAs?.toLowerCase()).toBe(PROJECT.replace(/\\/g, "/").toLowerCase());

    await addComp(transport, "seconda");
    created.push(await ops.run<Created>("checkpoint.create", { name: "due" }));
    secondShape = await shapeOf(transport);

    await addComp(transport, "terza");
    created.push(await ops.run<Created>("checkpoint.create", { name: "tre" }));

    for (const c of created) expect((await fs.stat(c.path)).size).toBeGreaterThan(0);
    const listed = await ops.run<Listed>("checkpoint.list", {});
    expect(listed.checkpoints.map((c) => c.label)).toEqual(["tre", "due", "uno"]);
  });

  it("refuses to restore without confirm: true", async (ctx) => {
    if (!ready || !transport || created.length < 2) return ctx.skip();
    const err = await opRunner(transport).expectRefusal("checkpoint.restore", {
      checkpoint: created[1]!.file,
      confirm: false,
    });
    expect(err.code).toBe("FORBIDDEN");
  });

  it("restores the second checkpoint over a ruined project: identical to the second", async (ctx) => {
    if (!ready || !transport || created.length < 3 || !secondShape) return ctx.skip();
    await ruin(transport);
    expect((await shapeOf(transport)).items).toHaveLength(0);

    const ops = opRunner(transport);
    const res = await ops.run<{ openFile: string; beforeRestoreCheckpoint: string }>(
      "checkpoint.restore",
      { checkpoint: created[1]!.file, confirm: true },
    );
    expect(res.openFile.toLowerCase()).toBe(PROJECT.replace(/\\/g, "/").toLowerCase());
    expect(await shapeOf(transport)).toEqual(secondShape);

    // The ruined state was kept, and the other checkpoints are still there.
    expect(path.basename(res.beforeRestoreCheckpoint)).toContain(BEFORE_RESTORE_LABEL);
    const listed = await ops.run<Listed>("checkpoint.list", {});
    expect(listed.checkpoints.map((c) => c.label)).toEqual([
      BEFORE_RESTORE_LABEL,
      "tre",
      "due",
      "uno",
    ]);
  });

  it("deletes one checkpoint with confirm: true", async (ctx) => {
    if (!ready || !transport || created.length < 1) return ctx.skip();
    await opRunner(transport).run("checkpoint.delete", {
      checkpoint: created[0]!.file,
      confirm: true,
    });
    await expect(fs.access(created[0]!.path)).rejects.toThrow();
  });
});
