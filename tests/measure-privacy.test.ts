// The M5 images (reference.measure's crop, frame.compare's difference map)
// through the real MCP server: they arrive as image blocks normally, and the
// existing privacy filter (AE_MCP_PRIVACY=1) withholds them. Offline — both
// operations run on the Node side and never reach After Effects.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpTestClient } from "./harness.js";
import { canvas, roundedRect, writePng } from "./helpers/images.js";

let dir: string;
let card: string;
let other: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "parlez-m5-privacy-"));
  const img = canvas(200, 120, [0.1, 0.1, 0.15]);
  roundedRect(img, 40, 30, 120, 60, 12, [0.9, 0.4, 0.2]);
  card = await writePng(path.join(dir, "Rossi-card.png"), img);
  other = await writePng(path.join(dir, "render.png"), canvas(200, 120, [0.1, 0.1, 0.15]));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const measureArgs = () => ({
  operation: "reference.measure",
  args: { file: card, crop: { x: 30, y: 20, w: 40, h: 40 } },
});
const compareArgs = () => ({
  operation: "frame.compare",
  args: { file: other, reference: card },
});

function texts(content: Array<Record<string, unknown>>): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text as string)
    .join("\n");
}

describe("M5 images without privacy mode", () => {
  const client = new McpTestClient();
  beforeAll(async () => client.connect({ AE_MCP_PRIVACY: "0" }));
  afterAll(async () => client.close());

  it("crop and difference map arrive as image blocks after the JSON", async () => {
    for (const call of [measureArgs(), compareArgs()]) {
      const { content } = await client.callRaw("ae_do", call);
      expect(content[0].type).toBe("text");
      expect(content.filter((c) => c.type === "image")).toHaveLength(1);
    }
  });
});

describe("M5 images with AE_MCP_PRIVACY=1", () => {
  const client = new McpTestClient();
  beforeAll(async () => client.connect({ AE_MCP_PRIVACY: "1" }));
  afterAll(async () => client.close());

  it("withholds the crop and the difference map, keeps the measurements", async () => {
    const m = await client.callRaw("ae_do", measureArgs());
    expect(m.content.filter((c) => c.type === "image")).toHaveLength(0);
    expect(texts(m.content)).toContain("withheld");
    expect(texts(m.content)).toContain('"size"');
    // the path is reduced to the file name
    expect(texts(m.content)).not.toContain(dir.replace(/\\/g, "\\\\"));

    const c = await client.callRaw("ae_do", compareArgs());
    expect(c.content.filter((x) => x.type === "image")).toHaveLength(0);
    expect(texts(c.content)).toContain('"passa"');
  });
});
