#!/usr/bin/env node
// Fit one cubic-bezier to each of Robert Penner's easing equations and print
// the numbers stored in src/easing.ts (Parlez! M6.3). Run after `npm run build`:
//
//   node scripts/fit-easing.mjs
//
// Method: least squares over 201 evenly spaced samples of [0, 1], minimized
// with Nelder–Mead from several starting curves (x1 and x2 kept inside 0…1 so
// the bezier stays a function of time). Deterministic: same output every run.
// Offline and self-contained — no dependency, no network.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "easing.js");
const { PENNER_FUNCTIONS, bezierY, maxDeviation } = await import(pathToFileURL(dist).href);

const SAMPLES = 200;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// x1, x2 inside 0…1 keep the bezier a function of time. For a bounded curve
// also y1 >= 0 and y2 <= 1: those are exactly the conditions for both speed
// factors (y1/x1 and (1 - y2)/(1 - x2)) to be >= 0, i.e. no backwards speed.
const legal = (p, bounded) => [
  clamp01(p[0]),
  bounded ? Math.max(0, p[1]) : p[1],
  clamp01(p[2]),
  bounded ? Math.min(1, p[3]) : p[3],
];

// A curve that never leaves 0…1 (all but "back") must not get a bezier that
// does: a dip below 0 would be a fitting artefact, and on a Position it
// would turn into a clamped negative speed. The penalty forbids it.
function cost(fn, p, bounded) {
  const b = legal(p, bounded);
  let sum = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = i / SAMPLES;
    const y = bezierY(b, x);
    const d = y - fn(x);
    sum += d * d;
    if (bounded) {
      const out = y < 0 ? -y : y > 1 ? y - 1 : 0;
      sum += 1000 * out * out;
    }
  }
  return sum / (SAMPLES + 1);
}

function nelderMead(f, start, step = 0.1, iterations = 4000) {
  const n = start.length;
  let simplex = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    p[i] += step;
    simplex.push(p);
  }
  let values = simplex.map(f);
  for (let it = 0; it < iterations; it++) {
    const order = values.map((v, i) => i).toSorted((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    const centroid = Array.from({ length: n }, () => 0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const towards = (k) => centroid.map((c, j) => c + k * (worst[j] - c));
    const reflected = towards(-1);
    const fr = f(reflected);
    if (fr < values[0]) {
      const expanded = towards(-2);
      const fe = f(expanded);
      if (fe < fr) [simplex[n], values[n]] = [expanded, fe];
      else [simplex[n], values[n]] = [reflected, fr];
    } else if (fr < values[n - 1]) {
      [simplex[n], values[n]] = [reflected, fr];
    } else {
      const contracted = towards(0.5);
      const fc = f(contracted);
      if (fc < values[n]) [simplex[n], values[n]] = [contracted, fc];
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return simplex[best];
}

const STARTS = [
  [0.33, 0, 0.67, 1],
  [0.5, 0, 0.75, 0],
  [0.25, 1, 0.5, 1],
  [0.6, 0, 0.4, 1],
  [0.4, -0.5, 0.7, 0.2],
  [0.3, 0.8, 0.6, 1.5],
];

const round = (v) => Math.round(v * 1000) / 1000;
// Penner defines out(t) = 1 - in(1 - t), so the out curve is the in curve
// turned half a circle: (x1, y1, x2, y2) -> (1 - x2, 1 - y2, 1 - x1, 1 - y1).
// Only "in" and "in-out" are fitted; "out" is that exact mirror, and in-out is
// fitted with the same symmetry built in (x2 = 1 - x1, y2 = 1 - y1).
const mirror = (b) => [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]];
const symmetric = (q) => [q[0], q[1], 1 - q[0], 1 - q[1]];

function fit(name, fn) {
  const bounded = !name.includes("back");
  const inOut = name.includes("in-out");
  const expand = inOut ? symmetric : (q) => q;
  const starts = inOut ? STARTS.map((st) => st.slice(0, 2)) : STARTS;
  let best = null;
  let bestCost = Infinity;
  for (const st of starts) {
    const q = nelderMead((v) => cost(fn, expand(v), bounded), st);
    const b = legal(expand(q), bounded);
    const c = cost(fn, b, bounded);
    if (c < bestCost) [best, bestCost] = [b, c];
  }
  return best.map(round);
}

const fitted = new Map();
for (const [name, fn] of Object.entries(PENNER_FUNCTIONS)) {
  if (name.startsWith("ease-out-")) continue;
  fitted.set(name, fit(name, fn));
}
for (const name of Object.keys(PENNER_FUNCTIONS)) {
  const b = name.startsWith("ease-out-")
    ? mirror(fitted.get(name.replace("ease-out-", "ease-in-"))).map(round)
    : fitted.get(name);
  const err = Math.ceil(maxDeviation(b, PENNER_FUNCTIONS[name]) * 10000) / 10000;
  console.log(`  penner(${JSON.stringify(name)}, [${b.join(", ")}], ${err}),`);
}
