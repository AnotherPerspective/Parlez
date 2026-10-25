// CIEDE2000 and the sRGB → Lab conversion, checked against published values.
//
// The 34 pairs are the test data of G. Sharma, W. Wu, E. N. Dalal, "The
// CIEDE2000 color-difference formula: implementation notes, supplementary
// test data, and mathematical observations", Color Research & Application
// 30(1), 2005, Table 1 — the standard check for an implementation, chosen
// there to exercise the hue-angle and mean-hue edge cases (pairs 7–16).
// Values transcribed to four decimals, as published.

import { describe, expect, it } from "vitest";

import { deltaE2000, srgbToLab, type Lab } from "../src/color/lab.js";

const SHARMA_2005: Array<[Lab, Lab, number]> = [
  [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
  [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
  [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
  [[50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, -0.9009, -85.5211], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
  [[50.0, -1.0, 2.0], [50.0, 0.0, 0.0], 2.3669],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0009], 7.1792],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.001], 7.1792],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0012], 7.2195],
  [[50.0, -0.001, 2.49], [50.0, 0.0009, -2.49], 4.8045],
  [[50.0, -0.001, 2.49], [50.0, 0.001, -2.49], 4.8045],
  [[50.0, -0.001, 2.49], [50.0, 0.0011, -2.49], 4.7461],
  [[50.0, 2.5, 0.0], [50.0, 0.0, -2.5], 4.3065],
  [[50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492],
  [[50.0, 2.5, 0.0], [61.0, -5.0, 29.0], 22.8977],
  [[50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
  [[50.0, 2.5, 0.0], [58.0, 24.0, 15.0], 19.4535],
  [[50.0, 2.5, 0.0], [50.0, 3.1736, 0.5854], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 3.2972, 0.0], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 1.8634, 0.5757], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 3.2592, 0.335], 1.0],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

describe("deltaE2000", () => {
  it.each(SHARMA_2005.map((p, i) => [i + 1, ...p] as const))(
    "Sharma–Wu–Dalal pair %i",
    (_n, a, b, expected) => {
      expect(deltaE2000(a, b)).toBeCloseTo(expected, 4);
    },
  );

  it("is symmetric and zero for identical colors", () => {
    for (const [a, b] of SHARMA_2005) {
      expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
      expect(deltaE2000(a, a)).toBe(0);
    }
  });
});

describe("srgbToLab (D65)", () => {
  it("maps white to L 100 and black to L 0, both neutral", () => {
    const white = srgbToLab([1, 1, 1]);
    expect(white[0]).toBeCloseTo(100, 2);
    expect(Math.abs(white[1])).toBeLessThan(0.01);
    expect(Math.abs(white[2])).toBeLessThan(0.01);
    expect(srgbToLab([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("matches the usual reference values for sRGB red, green, blue and mid grey", () => {
    const close = (got: Lab, want: Lab) =>
      got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(0.05));
    close(srgbToLab([1, 0, 0]), [53.24, 80.09, 67.2]);
    close(srgbToLab([0, 1, 0]), [87.73, -86.18, 83.18]);
    close(srgbToLab([0, 0, 1]), [32.3, 79.19, -107.86]);
    // sRGB 50 % (0.5 encoded) is L* 53.39, not 50: the curve is not linear.
    close(srgbToLab([0.5, 0.5, 0.5]), [53.39, 0, 0]);
  });

  it("puts one 8-bit step of mid grey well under ΔE 1", () => {
    const d = deltaE2000(
      srgbToLab([128 / 255, 128 / 255, 128 / 255]),
      srgbToLab([129 / 255, 128 / 255, 128 / 255]),
    );
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
});
