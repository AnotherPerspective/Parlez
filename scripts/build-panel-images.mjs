// Writes the Parlez! panel's ON/OFF pictures into jsx/panel-images/ from the
// compiled src/panel-images.ts. Run by `npm run build` after tsc; the files
// are committed, so an install works without building, and
// tests/panel-images.test.ts fails when they drift from the generator.

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildPanelImages } = await import(new URL("../dist/panel-images.js", import.meta.url).href);

const outDir = join(root, "jsx", "panel-images");
mkdirSync(outDir, { recursive: true });
const files = buildPanelImages();
for (const name of readdirSync(outDir)) {
  if (name.endsWith(".png") && !files.has(name)) unlinkSync(join(outDir, name));
}
for (const [name, bytes] of files) writeFileSync(join(outDir, name), bytes);
console.log(`panel images: ${files.size} written to ${outDir}`);
