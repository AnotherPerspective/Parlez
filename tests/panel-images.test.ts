// The ON/OFF pictures of the Parlez! panel: what src/panel-images.ts draws,
// and that the copies committed in jsx/panel-images/ (the ones install-panel
// points the panel at) are exactly those.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { decodePng } from "../src/color/png16.js";
import { PANEL_IMAGES_DIR } from "../src/config.js";
import {
  PANEL_SIZES,
  PANEL_STATES,
  buildPanelImages,
  panelImageNames,
} from "../src/panel-images.js";

const built = buildPanelImages();

function pixel(img: ReturnType<typeof decodePng>, x: number, y: number) {
  const i = y * img.width + x;
  const rgb = [img.rgb[i * 3], img.rgb[i * 3 + 1], img.rgb[i * 3 + 2]].map(
    (v) => Math.round(v * 255) / 255,
  );
  return { rgb, alpha: img.alpha ? img.alpha[i] : 1 };
}

const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1.5 / 255);

describe("the pictures", () => {
  it("are 4 states × 3 looks × 2 sizes", () => {
    expect(panelImageNames()).toHaveLength(24);
    expect([...built.keys()].sort()).toEqual([...panelImageNames()].sort());
  });

  it("have the sizes of the two layouts", () => {
    for (const [name, bytes] of built) {
      const img = decodePng(bytes);
      const want = name.includes("-small") ? PANEL_SIZES["-small"] : PANEL_SIZES[""];
      expect([img.width, img.height], name).toEqual([want.width, want.height]);
    }
  });

  it("are full of the state's colour, with transparent rounded corners", () => {
    for (const [state, { color }] of Object.entries(PANEL_STATES)) {
      const img = decodePng(built.get(`${state}.png`)!);
      // Just inside the left edge, half-way down: the block's colour.
      expect(close(pixel(img, 6, img.height / 2).rgb, color), state).toBe(true);
      expect(pixel(img, 6, img.height / 2).alpha).toBe(1);
      // The very corner: outside the rounded rectangle.
      expect(pixel(img, 0, 0).alpha).toBe(0);
    }
  });

  it("carry the word in white, centred", () => {
    for (const state of Object.keys(PANEL_STATES)) {
      const img = decodePng(built.get(`${state}.png`)!);
      let white = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (close(pixel(img, x, y).rgb, [1, 1, 1])) {
            white++;
            sumX += x;
            sumY += y;
          }
        }
      }
      expect(white, state).toBeGreaterThan(500);
      // The ink's centre of mass sits in the middle of the block.
      expect(Math.abs(sumX / white - img.width / 2), state).toBeLessThan(img.width * 0.06);
      expect(Math.abs(sumY / white - img.height / 2), state).toBeLessThan(img.height * 0.06);
    }
  });

  it("are lighter under the mouse and darker when pressed", () => {
    const at = (name: string) => pixel(decodePng(built.get(name)!), 6, 44).rgb;
    const normal = at("on.png");
    const over = at("on-over.png");
    const down = at("on-down.png");
    for (let i = 0; i < 3; i++) {
      expect(over[i]).toBeGreaterThan(normal[i]);
      expect(down[i]).toBeLessThan(normal[i]);
    }
  });

  it("are the same bytes every time (so the committed copies can be checked)", () => {
    const again = buildPanelImages();
    for (const [name, bytes] of built) expect(again.get(name)!.equals(bytes), name).toBe(true);
  });
});

describe("jsx/panel-images/", () => {
  it("holds exactly what the generator produces (run `npm run build` after changing it)", () => {
    // firma.png, when present, is drawn by scripts/render-signature.ps1, not here.
    const onDisk = readdirSync(PANEL_IMAGES_DIR).filter(
      (n) => n.endsWith(".png") && n !== "firma.png",
    );
    expect(onDisk.sort()).toEqual([...built.keys()].sort());
    for (const [name, bytes] of built) {
      expect(readFileSync(path.join(PANEL_IMAGES_DIR, name)).equals(bytes), name).toBe(true);
    }
  });
});
