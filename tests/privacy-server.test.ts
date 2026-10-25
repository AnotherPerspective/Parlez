// Privacy mode end to end over the real MCP stdio transport: proves the one
// line in src/index.ts routes every tool call through the filter. Offline —
// every call here is answered before anything would reach After Effects.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RUNTIME_DIR } from "../src/config.js";
import { McpTestClient } from "./harness.js";

describe("mcp server with AE_MCP_PRIVACY=1 (offline)", () => {
  const client = new McpTestClient();
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ae-mcp-privacy-srv-"));
    const words = path.join(dir, "parole.txt");
    // The second entry is an operation name, so restoring it visibly changes
    // what the handler does.
    writeFileSync(words, "# clienti\nRossi\n[OP] keyframe.add\n", "utf8");
    await client.connect({ AE_MCP_PRIVACY: "1", AE_MCP_PRIVACY_WORDS: words });
  });

  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports itself in the catalog policy and withholds project.get_xmp", async () => {
    const payload = await client.call<{
      categories: Array<{ category: string; operations: string[] }>;
      policy: string;
    }>("ae_catalog");
    expect(payload.policy).toContain("privacy=ON");
    expect(payload.policy).toContain("words=2");
    const operations = payload.categories.flatMap((c) => c.operations);
    expect(operations).toContain("project.set_xmp");
    expect(operations).not.toContain("project.get_xmp");
  });

  it("refuses project.get_xmp with FORBIDDEN", async () => {
    const text = await client.callExpectError("ae_do", { operation: "project.get_xmp" });
    expect(text).toContain("[FORBIDDEN]");
    expect(text).toContain("AE_MCP_PRIVACY");
  });

  it("refuses an inline project export", async () => {
    const text = await client.callExpectError("ae_project_export_json", {});
    expect(text).toContain("[FORBIDDEN]");
    expect(text).toContain("outPath");
  });

  it("labels a listed word on the way out", async () => {
    const text = await client.callExpectError("ae_do", { operation: "Rossi.info" });
    expect(text).toContain("[UNKNOWN_OPERATION]");
    expect(text).toContain("'[CLIENTE-1].info'");
    expect(text).not.toContain("Rossi");
  });

  it("restores a label on the way in (the handler sees the real word)", async () => {
    // Unrestored, "[OP-1]" is an unknown operation; restored, it is
    // keyframe.add and fails on its missing arguments instead.
    const text = await client.callExpectError("ae_do", {
      operation: "[OP-1]",
      args: { comp: "Rossi_Main", layer: 1, property: ["Transform", "Position"], value: [0, 0] },
    });
    expect(text).toContain("[INVALID_ARGS]");
    expect(text).toContain("time");
    expect(text).not.toContain("UNKNOWN_OPERATION");
    expect(text).not.toContain("Rossi");
  });

  it("strips paths from errors the server builds itself", async () => {
    // Writing into the mailbox is refused Node-side, with the full mailbox
    // path in the message and in details.outPath.
    const text = await client.callExpectError("ae_project_export_json", {
      outPath: path.join(RUNTIME_DIR, "Rossi.json"),
    });
    expect(text).toContain("[IO]");
    expect(text).toContain("[CLIENTE-1].json");
    expect(text).not.toContain("AppData");
    expect(text).not.toContain(path.dirname(RUNTIME_DIR));
  });
});
