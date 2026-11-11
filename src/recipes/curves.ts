// Named curves → After Effects speed/influence (recipe format §8.2–8.3).
//
// TODO M6a: the parlez-m6a-aiuti branch adds dedicated animation helpers
// (named curves in keyframe.apply, stagger). Until that lands the executor
// converts here, on the Node side, and writes plain inInfluence/inSpeed/
// outInfluence/outSpeed numbers that keyframe.apply already accepts
// (jsx/toolkit.jsx AE.applyKeyInterp). When the helper exists, this table
// should become the shared one and these numbers can be replaced by `curve`.
//
// The numbers are a starting point to be confirmed and attributed in M7.2:
// "dolce" is AE's own Easy Ease; "standard", "decelera" and "accelera" are the
// Material 3 easing tokens (Apache-2.0, numbers only).

export type Curve =
  | { kind: "linear" }
  | { kind: "bezier"; bezier: [number, number, number, number]; source: string }
  | {
      kind: "pattern";
      /** Extra keys inside the segment: `at` = fraction of the time, `value` = fraction of the jump. */
      steps: Array<{ at: number; value: number; curve: string }>;
      source: string;
    };

// TODO M6a: replace with the shared curve table once the helper branch is merged.
export const CURVES: Readonly<Record<string, Curve>> = {
  linear: { kind: "linear" },
  dolce: { kind: "bezier", bezier: [0.333, 0, 0.667, 1], source: "After Effects, Easy Ease" },
  standard: { kind: "bezier", bezier: [0.2, 0, 0, 1], source: "Material 3 standard (Apache-2.0)" },
  decelera: {
    kind: "bezier",
    bezier: [0.05, 0.7, 0.1, 1],
    source: "Material 3 emphasized decelerate (Apache-2.0)",
  },
  accelera: {
    kind: "bezier",
    bezier: [0.3, 0, 0.8, 0.15],
    source: "Material 3 emphasized accelerate (Apache-2.0)",
  },
  overshoot: {
    kind: "pattern",
    steps: [
      { at: 0.7, value: 1.06, curve: "decelera" },
      { at: 1, value: 1, curve: "dolce" },
    ],
    source: "Parlez! (schema a più chiavi, §8.3)",
  },
};

export function curveNames(): string[] {
  return Object.keys(CURVES);
}

/** AE accepts influences from 0.1 to 100. */
function clampInfluence(v: number): number {
  return Math.min(100, Math.max(0.1, v));
}

/**
 * The two ends of a bezier curve in AE terms. Influence is a percentage of the
 * segment's duration (AE accepts 0.1–100); the factor multiplies the segment's
 * average speed m = Δvalue / Δtime to give the key's speed.
 *   out side of key 1: influence = x1·100, speed = (y1 / x1)·m
 *   in side of key 2:  influence = (1 − x2)·100, speed = ((1 − y2) / (1 − x2))·m
 */
export function bezierToEase(b: [number, number, number, number]): {
  outInfluence: number;
  outFactor: number;
  inInfluence: number;
  inFactor: number;
} {
  const [x1, y1, x2, y2] = b;
  return {
    outInfluence: clampInfluence(x1 * 100),
    // A zero-length handle has no direction of its own: treat it as "leaves
    // with no speed" rather than dividing by zero.
    outFactor: x1 === 0 ? 0 : y1 / x1,
    inInfluence: clampInfluence((1 - x2) * 100),
    inFactor: x2 === 1 ? 0 : (1 - y2) / (1 - x2),
  };
}

/**
 * Value at normalized time `t` of the AE segment built from these eases — the
 * cubic bezier with handles at (influence, influence·factor). Used by the tests
 * to prove the conversion against the curve itself (§15 point 5).
 */
export function aeSegmentAt(
  ease: { outInfluence: number; outFactor: number; inInfluence: number; inFactor: number },
  t: number,
): number {
  const p1x = ease.outInfluence / 100;
  const p1y = p1x * ease.outFactor;
  const p2x = 1 - ease.inInfluence / 100;
  const p2y = 1 - (ease.inInfluence / 100) * ease.inFactor;
  return cubicAt([p1x, p1y, p2x, p2y], t);
}

/** One coordinate of a cubic bezier from (0,0) to (1,1) at parameter s. */
function bez(a: number, c: number, s: number): number {
  return 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * c + s * s * s;
}

/** y at x = t of a CSS-style cubic-bezier(x1, y1, x2, y2), by bisection on x. */
export function cubicAt(b: [number, number, number, number], t: number): number {
  const [x1, y1, x2, y2] = b;
  let lo = 0;
  let hi = 1;
  let s = t;
  for (let i = 0; i < 60; i++) {
    s = (lo + hi) / 2;
    if (bez(x1, x2, s) < t) lo = s;
    else hi = s;
  }
  return bez(y1, y2, s);
}
