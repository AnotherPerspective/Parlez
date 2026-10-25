// Units of the recipe format (the recipe format spec §3): times, lengths, colors.
//
// Inside the executor every time is a WHOLE number of frames and every length
// is in pixels. Seconds appear only at the very end, when an operation is
// written for kumo (which wants seconds). Keeping frames as the inner unit is
// what puts every key on the frame grid: a key between two frames is invisible
// in After Effects and impossible to drag back by hand.

const TIME_RE = /^(-?\d+(?:\.\d+)?)(f|s)(?:@(\d+(?:\.\d+)?))?$/;
const LENGTH_RE = /^(-?\d+(?:\.\d+)?)(px|u)$/;
const HEX_RE = /^#([0-9a-fA-F]{6})$/;

/** True when `s` is a time literal: "12f", "0.5s", "12f@25". */
export function isTimeLiteral(s: unknown): s is string {
  return typeof s === "string" && TIME_RE.test(s.trim());
}

/** True when `s` is a length literal: "24px", "24u". */
export function isLengthLiteral(s: unknown): s is string {
  return typeof s === "string" && LENGTH_RE.test(s.trim());
}

/** True when `s` is a "#RRGGBB" color. */
export function isHexColor(s: unknown): s is string {
  return typeof s === "string" && HEX_RE.test(s.trim());
}

/**
 * Frames at `fps` for a time literal. "12f" counts frames at the comp's own
 * rate; "12f@25" is 12 frames AT 25 fps (how technique cards store timings,
 * since they come from projects with different rates), converted with the
 * same rounding as seconds.
 */
export function timeToFrames(literal: string, fps: number): number {
  const m = TIME_RE.exec(literal.trim());
  if (!m) throw new Error(`«${literal}» non è un tempo (usa per esempio "12f", "0.5s" o "12f@25")`);
  const n = Number(m[1]);
  if (m[2] === "s") return Math.round(n * fps);
  if (m[3] !== undefined) return Math.round((n / Number(m[3])) * fps);
  return Math.round(n);
}

/**
 * Pixels for a length literal or a plain number (already pixels). `unit` is
 * the size of 1u: short side of the comp / 1080, so the same recipe keeps the
 * same presence in 16:9, 9:16, 1:1, 4:5 and 4K.
 */
export function lengthToPx(literal: string | number, unit: number): number {
  if (typeof literal === "number") return literal;
  const m = LENGTH_RE.exec(literal.trim());
  if (!m) throw new Error(`«${literal}» non è una lunghezza (usa per esempio "24u" o "24px")`);
  const n = Number(m[1]);
  return m[2] === "u" ? n * unit : n;
}

/** "#RRGGBB" → [r, g, b] in 0–1, rounded to 4 decimals (kumo's color form). */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`«${hex}» non è un colore (usa "#RRGGBB", per esempio "#14213D")`);
  const v = parseInt(m[1], 16);
  return [
    round(((v >> 16) & 255) / 255, 4),
    round(((v >> 8) & 255) / 255, 4),
    round((v & 255) / 255, 4),
  ];
}

/** Round half away from zero to `decimals`; never returns -0. */
export function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = (Math.sign(n) * Math.round(Math.abs(n) * f + Number.EPSILON * f)) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Seconds for a frame count, rounded so 1/30-type rates do not leak float noise. */
export function framesToSeconds(frames: number, fps: number): number {
  return round(frames / fps, 6);
}
