// Named easing curves → After Effects temporal ease (Parlez! M6.3).
//
// A curve describes ONE segment between two keys as a normalized
// cubic-bezier (x1, y1, x2, y2): the same shape CSS and most motion
// tools use. After Effects does not store a bezier per segment; it stores a
// KeyframeEase { speed, influence } on the OUT side of the first key and the
// IN side of the second. The two descriptions meet exactly for a 1-D value:
//
//   segment from (t1, v1) to (t2, v2), Δt = t2 − t1, average speed m = Δv / Δt
//   out of key 1:  influence = x1 × 100          speed = (y1 / x1) × m
//   into key 2:    influence = (1 − x2) × 100    speed = ((1 − y2) / (1 − x2)) × m
//
// (AE puts key 1's handle at t1 + influence·Δt with value v1 + speed·influence·Δt,
// which normalizes back to (x1, y1); same for the other side.) This module
// returns the influences and the dimensionless FACTORS (y1/x1, (1−y2)/(1−x2));
// m depends on the actual key values, so the caller multiplies it in — for
// keyframe.apply_ease that happens inside After Effects, per dimension.
//
// Limits, stated plainly:
//   - Influence lives in 0.1–100 in AE. A handle shorter than 0.1 % (x1 = 0 or
//     x2 = 1, e.g. CSS ease-in's arrival) is written as influence 0.1 with
//     speed 0, which is what AE itself shows for a straight side. The 0.1 %
//     stub changes the drawn curve by at most a tenth of a percent of the
//     segment.
//   - Spatial properties (Position, Anchor Point) ease along the motion path:
//     m is the distance travelled ÷ Δt and must stay ≥ 0, so a curve that
//     dips below 0 or overshoots above 1 (the "back" family) cannot be shown
//     there; the negative side is clamped to 0 with a warning.
//   - Penner's equations are functions, not beziers. Each one is stored here
//     as the single cubic-bezier closest to it (least squares over 201
//     samples, fitted by scripts/fit-easing.mjs); `maxError` says how far the
//     bezier strays from the true function, as a fraction of the full move.
//     quad and cubic are exact (they ARE cubic polynomials); the in-out
//     curves with a sharp turn in the middle are the least faithful (expo
//     and circ in-out ≈ 3.5 %, quint 3.1 %, back 2.7 %, quart 2.1 %, the rest
//     under 1 %). Only "in" and "in-out" are fitted; "out" is the exact
//     mirror of "in", as in Penner's own definition. Curves that never leave
//     0…1 are fitted with non-negative speed factors, so they never produce a
//     backwards speed. Elastic and bounce are left out because one bezier
//     cannot draw them at all.
//   - Multi-key motions (overshoot that settles, bounce) need extra keys or
//     an expression (expression.apply_template) — not a single named curve.

export type Bezier = readonly [number, number, number, number];

export interface EaseSide {
  /** AE influence, 0.1–100 (percent of the segment). */
  influence: number;
  /** Multiply by the segment's average speed m to get AE's speed. */
  speedFactor: number;
}

export interface NamedEase {
  name: string;
  /** "bezier" = temporal ease; "linear" / "hold" = AE interpolation types. */
  kind: "bezier" | "linear" | "hold";
  bezier: Bezier | null;
  /** Where the numbers come from. */
  source: string;
  /** Licence status of the numbers, as far as this repository knows it. */
  license: string;
  /** Penner curves only: largest |bezier − function| over [0, 1], fraction of the move. */
  maxError?: number;
  /** True when the curve leaves 0…1 (spatial properties clamp it). */
  overshoot?: boolean;
}

const MIN_INFLUENCE = 0.1;
const MAX_INFLUENCE = 100;
/** Below this, a handle is a stub: AE gets influence 0.1 and speed 0. */
const STUB = 0.001;

const CSS = "CSS Easing Functions Level 1 (W3C), parole chiave cubic-bezier";
const CSS_LICENSE = "norma pubblica W3C: i numeri si possono usare";
const PENNER =
  "equazioni di Robert Penner (Robert Penner's Easing Functions, 2001), approssimate con una cubic-bezier da scripts/fit-easing.mjs";
const PENNER_LICENSE =
  "formule pubbliche (licenza BSD di Penner); le funzioni e l'approssimazione sono riscritte da zero qui";
const MATERIAL = "Material Design 3, motion tokens (Google)";
const CARBON = "IBM Carbon Design System, motion tokens";
const TO_CHECK = "licenza da verificare prima della pubblicazione: qui ci sono solo i numeri";

function bezierEase(
  name: string,
  bezier: Bezier,
  source: string,
  license: string,
  extra: Partial<NamedEase> = {},
): NamedEase {
  // Judged on the drawn curve, not on the control points: a control point a
  // hair below 0 (Penner's quart, quint) does not make the curve dip.
  let overshoot = false;
  for (let i = 0; i <= 100; i++) {
    const y = bezierY(bezier, i / 100);
    if (y < -0.001 || y > 1.001) overshoot = true;
  }
  return {
    name,
    kind: "bezier",
    bezier,
    source,
    license,
    ...(overshoot ? { overshoot } : {}),
    ...extra,
  };
}

function penner(name: string, bezier: Bezier, maxError: number): NamedEase {
  return bezierEase(name, bezier, PENNER, PENNER_LICENSE, { maxError });
}

/**
 * The table. The recipe format used Italian working names; they map as:
 * dolce = easy-ease, standard = material-standard,
 * decelera = material-emphasized-decelerate, accelera = material-emphasized-accelerate.
 */
export const EASES: readonly NamedEase[] = [
  {
    name: "linear",
    kind: "linear",
    bezier: [0, 0, 1, 1],
    source: "interpolazione lineare di After Effects",
    license: "nessuna (non è un'opera)",
  },
  {
    name: "hold",
    kind: "hold",
    bezier: null,
    source: "interpolazione «tieni» di After Effects: il valore salta all'arrivo",
    license: "nessuna (non è un'opera)",
  },
  bezierEase(
    "easy-ease",
    [1 / 3, 0, 2 / 3, 1],
    "«Easy Ease» di After Effects (influenza 33,3 %, velocità 0 da entrambi i lati)",
    "nessuna (comportamento predefinito di After Effects)",
  ),
  bezierEase("ease-in", [0.42, 0, 1, 1], CSS, CSS_LICENSE),
  bezierEase("ease-out", [0, 0, 0.58, 1], CSS, CSS_LICENSE),
  bezierEase("ease-in-out", [0.42, 0, 0.58, 1], CSS, CSS_LICENSE),

  // Robert Penner's families. Numbers produced by scripts/fit-easing.mjs.
  penner("ease-in-sine", [0.36, 0, 0.671, 0.483], 0.0003),
  penner("ease-out-sine", [0.329, 0.517, 0.64, 1], 0.0003),
  penner("ease-in-out-sine", [0.364, 0, 0.636, 1], 0.0003),
  penner("ease-in-quad", [0.333, 0, 0.666, 0.332], 0.0002),
  penner("ease-out-quad", [0.334, 0.668, 0.667, 1], 0.0002),
  penner("ease-in-out-quad", [0.476, 0.035, 0.524, 0.965], 0.0038),
  penner("ease-in-cubic", [0.333, 0, 0.667, 0], 0.0002),
  penner("ease-out-cubic", [0.333, 1, 0.667, 1], 0.0002),
  penner("ease-in-out-cubic", [0.654, 0, 0.346, 1], 0.0091),
  penner("ease-in-quart", [0.436, 0.006, 0.731, -0.071], 0.0005),
  penner("ease-out-quart", [0.269, 1.071, 0.564, 0.994], 0.0005),
  penner("ease-in-out-quart", [0.768, 0, 0.232, 1], 0.0206),
  penner("ease-in-quint", [0.521, 0.012, 0.774, -0.117], 0.0011),
  penner("ease-out-quint", [0.226, 1.117, 0.479, 0.988], 0.0011),
  penner("ease-in-out-quint", [0.839, 0, 0.161, 1], 0.0307),
  penner("ease-in-expo", [0.64, 0.019, 0.845, -0.057], 0.0012),
  penner("ease-out-expo", [0.155, 1.057, 0.36, 0.981], 0.0012),
  penner("ease-in-out-expo", [0.899, 0, 0.101, 1], 0.0351),
  penner("ease-in-circ", [0.547, 0, 0.999, 0.442], 0.0005),
  penner("ease-out-circ", [0.001, 0.558, 0.453, 1], 0.0005),
  penner("ease-in-out-circ", [0.878, 0.132, 0.122, 0.868], 0.0355),
  penner("ease-in-back", [0.333, 0, 0.667, -0.567], 0.0003),
  penner("ease-out-back", [0.333, 1.567, 0.667, 1], 0.0003),
  penner("ease-in-out-back", [0.721, -0.546, 0.279, 1.546], 0.0268),

  // Design-system tokens: numbers only, licence still to be checked (M7.2).
  bezierEase("material-standard", [0.2, 0, 0, 1], MATERIAL, TO_CHECK),
  bezierEase("material-standard-decelerate", [0, 0, 0, 1], MATERIAL, TO_CHECK),
  bezierEase("material-standard-accelerate", [0.3, 0, 1, 1], MATERIAL, TO_CHECK),
  bezierEase("material-emphasized-decelerate", [0.05, 0.7, 0.1, 1], MATERIAL, TO_CHECK),
  bezierEase("material-emphasized-accelerate", [0.3, 0, 0.8, 0.15], MATERIAL, TO_CHECK),
  bezierEase("carbon-productive-standard", [0.2, 0, 0.38, 0.9], CARBON, TO_CHECK),
  bezierEase("carbon-productive-entrance", [0, 0, 0.38, 0.9], CARBON, TO_CHECK),
  bezierEase("carbon-productive-exit", [0.2, 0, 1, 0.9], CARBON, TO_CHECK),
  bezierEase("carbon-expressive-standard", [0.4, 0.14, 0.3, 1], CARBON, TO_CHECK),
  bezierEase("carbon-expressive-entrance", [0, 0, 0.3, 1], CARBON, TO_CHECK),
  bezierEase("carbon-expressive-exit", [0.4, 0.14, 1, 1], CARBON, TO_CHECK),
];

const BY_NAME = new Map(EASES.map((e) => [e.name, e]));

export function getEase(name: string): NamedEase | undefined {
  return BY_NAME.get(name);
}

export function easeNames(): string[] {
  return EASES.map((e) => e.name);
}

function clampInfluence(v: number): number {
  return Math.min(MAX_INFLUENCE, Math.max(MIN_INFLUENCE, v));
}

/** Out side of the first key and in side of the second, for one segment. */
export function bezierToAe(b: Bezier): { out: EaseSide; in: EaseSide } {
  const [x1, y1, x2, y2] = b;
  const out: EaseSide =
    x1 < STUB
      ? { influence: MIN_INFLUENCE, speedFactor: 0 }
      : { influence: clampInfluence(x1 * 100), speedFactor: y1 / x1 };
  const inn: EaseSide =
    1 - x2 < STUB
      ? { influence: MIN_INFLUENCE, speedFactor: 0 }
      : { influence: clampInfluence((1 - x2) * 100), speedFactor: (1 - y2) / (1 - x2) };
  return { out, in: inn };
}

/** AE values for a named curve; `linear` is 0 / 0.1 on both sides, like AE shows it. */
export function easeToAe(ease: NamedEase): { out: EaseSide; in: EaseSide } | null {
  if (ease.kind === "hold") return null;
  if (ease.kind === "linear") {
    return {
      out: { influence: MIN_INFLUENCE, speedFactor: 0 },
      in: { influence: MIN_INFLUENCE, speedFactor: 0 },
    };
  }
  return bezierToAe(ease.bezier!);
}

/** True when (x1, y1, x2, y2) is a usable custom curve: x inside 0…1, all finite. */
export function isValidBezier(v: unknown): v is Bezier {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    v[0] >= 0 &&
    v[0] <= 1 &&
    v[2] >= 0 &&
    v[2] <= 1
  );
}

// --- Reference functions, for checking the table (tests, fit script) ---

/** y of a normalized cubic-bezier at progress x (x1, x2 in 0…1 keep x monotonic). */
export function bezierY(b: Bezier, x: number): number {
  const [x1, y1, x2, y2] = b;
  const coord = (s: number, p1: number, p2: number) =>
    3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  // Bisection: x(s) is monotonic for x1, x2 in [0, 1]; 60 halvings reach
  // double precision without the divergence Newton shows near flat spots.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (coord(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return coord((lo + hi) / 2, y1, y2);
}

// Robert Penner's easing equations (2001), written out from their published
// mathematical form — t is progress 0…1, the result is the eased fraction.
const BACK = 1.70158;
const BACK_IN_OUT = BACK * 1.525;
export const PENNER_FUNCTIONS: Readonly<Record<string, (t: number) => number>> = {
  "ease-in-sine": (t) => 1 - Math.cos((t * Math.PI) / 2),
  "ease-out-sine": (t) => Math.sin((t * Math.PI) / 2),
  "ease-in-out-sine": (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  "ease-in-quad": (t) => t * t,
  "ease-out-quad": (t) => 1 - (1 - t) * (1 - t),
  "ease-in-out-quad": (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  "ease-in-cubic": (t) => t ** 3,
  "ease-out-cubic": (t) => 1 - (1 - t) ** 3,
  "ease-in-out-cubic": (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  "ease-in-quart": (t) => t ** 4,
  "ease-out-quart": (t) => 1 - (1 - t) ** 4,
  "ease-in-out-quart": (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  "ease-in-quint": (t) => t ** 5,
  "ease-out-quint": (t) => 1 - (1 - t) ** 5,
  "ease-in-out-quint": (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  "ease-in-expo": (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  "ease-out-expo": (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  "ease-in-out-expo": (t) => {
    if (t === 0 || t === 1) return t;
    return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
  },
  "ease-in-circ": (t) => 1 - Math.sqrt(1 - t * t),
  "ease-out-circ": (t) => Math.sqrt(1 - (t - 1) * (t - 1)),
  "ease-in-out-circ": (t) =>
    t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,
  "ease-in-back": (t) => (BACK + 1) * t ** 3 - BACK * t * t,
  "ease-out-back": (t) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  "ease-in-out-back": (t) =>
    t < 0.5
      ? ((2 * t) ** 2 * ((BACK_IN_OUT + 1) * 2 * t - BACK_IN_OUT)) / 2
      : ((2 * t - 2) ** 2 * ((BACK_IN_OUT + 1) * (t * 2 - 2) + BACK_IN_OUT) + 2) / 2,
};

/** Largest |bezier − fn| over `samples + 1` evenly spaced points of [0, 1]. */
export function maxDeviation(b: Bezier, fn: (t: number) => number, samples = 200): number {
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    worst = Math.max(worst, Math.abs(bezierY(b, x) - fn(x)));
  }
  return worst;
}
