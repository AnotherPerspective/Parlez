// Expression templates (Parlez! M6.3).
//
// The 22 templates below are taken from ishu86/after-effects-mcp,
// src/presets/expressions/index.ts:
//
//   MIT License — Copyright (c) 2024 Ishant Kohar
//   (full licence text in THIRD_PARTY_NOTICES.md, section 3)
//
// Kept: names, categories, parameters, defaults and the expression logic.
// Adapted here, and why:
//   - string parameters are no longer pasted inside quotes
//     (`thisComp.layer("{{targetLayer}}")` became `thisComp.layer({{targetLayer}})`):
//     the value is inserted as a JSON string literal, so a layer name with a
//     quote or a backslash cannot break the expression or inject code into it;
//   - vector arithmetic uses AE's add()/mul() instead of + and * on arrays
//     (bounce, inertia, springy, offsetPosition): those work in both the
//     JavaScript and the Legacy ExtendScript expression engines, while + on
//     two arrays is not vector addition in plain JavaScript;
//   - the texts are written as lines joined with "\n" rather than template
//     literals, so nothing in them is ever interpolated by TypeScript.

export type TemplateParamType = "number" | "string" | "boolean" | "array";

export interface TemplateParam {
  type: TemplateParamType;
  default: number | string | boolean | number[];
  description: string;
}

export interface ExpressionTemplate {
  /** Key used by expression.apply_template. */
  key: string;
  title: string;
  category: "wiggle" | "loop" | "time" | "physics" | "linking" | "random";
  description: string;
  /** Expression text with {{param}} placeholders. */
  expression: string;
  parameters: Readonly<Record<string, TemplateParam>>;
}

const lines = (...l: string[]) => l.join("\n");
const num = (d: number, description: string): TemplateParam => ({
  type: "number",
  default: d,
  description,
});
const str = (d: string, description: string): TemplateParam => ({
  type: "string",
  default: d,
  description,
});

/** "Find the last key at or before `time`" — shared by the physics templates. */
const LAST_KEY = [
  "var n = 0;",
  "if (numKeys > 0) {",
  "  n = nearestKey(time).index;",
  "  if (key(n).time > time) n--;",
  "}",
];

export const EXPRESSION_TEMPLATES: readonly ExpressionTemplate[] = [
  // --- wiggle ---
  {
    key: "wiggle",
    title: "Basic Wiggle",
    category: "wiggle",
    description: "Adds random motion to a property",
    expression: "wiggle({{frequency}}, {{amplitude}})",
    parameters: {
      frequency: num(2, "Oscillations per second"),
      amplitude: num(50, "Maximum deviation"),
    },
  },
  {
    key: "wiggleSmooth",
    title: "Smooth Wiggle",
    category: "wiggle",
    description: "Smooth, organic wiggle with multiple noise layers",
    expression: lines(
      "var freq = {{frequency}};",
      "var amp = {{amplitude}};",
      "var octaves = {{octaves}};",
      "var mult = {{multiplier}};",
      "wiggle(freq, amp, octaves, mult)",
    ),
    parameters: {
      frequency: num(2, "Base frequency"),
      amplitude: num(50, "Maximum amplitude"),
      octaves: num(2, "Noise octaves"),
      multiplier: num(0.5, "Amplitude multiplier per octave"),
    },
  },
  {
    key: "wiggleFadeIn",
    title: "Wiggle Fade In",
    category: "wiggle",
    description: "Wiggle that gradually increases in intensity",
    expression: lines(
      "var freq = {{frequency}};",
      "var amp = {{amplitude}};",
      "var fadeTime = {{fadeTime}};",
      "var t = Math.min(time / fadeTime, 1);",
      "wiggle(freq, amp * t)",
    ),
    parameters: {
      frequency: num(3, "Wiggle frequency"),
      amplitude: num(30, "Max amplitude"),
      fadeTime: num(1, "Fade in duration"),
    },
  },
  {
    key: "wiggleFadeOut",
    title: "Wiggle Fade Out",
    category: "wiggle",
    description: "Wiggle that gradually decreases",
    expression: lines(
      "var freq = {{frequency}};",
      "var amp = {{amplitude}};",
      "var fadeStart = {{fadeStart}};",
      "var fadeDuration = {{fadeDuration}};",
      "var t = Math.max(0, 1 - (time - fadeStart) / fadeDuration);",
      "wiggle(freq, amp * t)",
    ),
    parameters: {
      frequency: num(3, "Wiggle frequency"),
      amplitude: num(30, "Max amplitude"),
      fadeStart: num(2, "When fade begins"),
      fadeDuration: num(1, "Fade duration"),
    },
  },

  // --- loop ---
  {
    key: "loopCycle",
    title: "Loop Cycle",
    category: "loop",
    description: "Loop keyframes in a continuous cycle",
    expression: 'loopOut("cycle")',
    parameters: {},
  },
  {
    key: "loopPingpong",
    title: "Loop Pingpong",
    category: "loop",
    description: "Loop keyframes back and forth",
    expression: 'loopOut("pingpong")',
    parameters: {},
  },
  {
    key: "loopOffset",
    title: "Loop Offset",
    category: "loop",
    description: "Loop with continuous progression",
    expression: 'loopOut("offset")',
    parameters: {},
  },
  {
    key: "loopContinue",
    title: "Loop Continue",
    category: "loop",
    description: "Continue velocity after last keyframe",
    expression: 'loopOut("continue")',
    parameters: {},
  },
  {
    key: "loopWithDelay",
    title: "Loop With Delay",
    category: "loop",
    description: "Loop animation with a pause between cycles",
    expression: lines(
      "var delay = {{delay}};",
      "var loopDuration = key(numKeys).time - key(1).time;",
      "var t = time % (loopDuration + delay);",
      "if (t > loopDuration) {",
      "  key(numKeys).value;",
      "} else {",
      "  valueAtTime(t + key(1).time);",
      "}",
    ),
    parameters: { delay: num(0.5, "Pause between loops") },
  },

  // --- time ---
  {
    key: "clock",
    title: "Clock",
    category: "time",
    description: "Display current system time",
    expression: lines(
      "var d = new Date();",
      "var h = d.getHours();",
      "var m = d.getMinutes();",
      "var s = d.getSeconds();",
      '(h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s',
    ),
    parameters: {},
  },
  {
    key: "countdown",
    title: "Countdown Timer",
    category: "time",
    description: "Countdown timer display",
    expression: lines(
      "var total = {{totalSeconds}};",
      "var remaining = Math.max(0, total - time);",
      "var m = Math.floor(remaining / 60);",
      "var s = Math.floor(remaining % 60);",
      '(m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s',
    ),
    parameters: { totalSeconds: num(60, "Total countdown time") },
  },
  {
    key: "countup",
    title: "Count Up",
    category: "time",
    description: "Animated number counter",
    expression: lines(
      "var startValue = {{start}};",
      "var endValue = {{end}};",
      "var duration = {{duration}};",
      "var t = Math.min(time / duration, 1);",
      "Math.round(startValue + (endValue - startValue) * t)",
    ),
    parameters: {
      start: num(0, "Starting number"),
      end: num(100, "Ending number"),
      duration: num(2, "Animation duration"),
    },
  },
  {
    key: "frameNumber",
    title: "Frame Number",
    category: "time",
    description: "Display current frame number",
    expression: "Math.floor(time * {{frameRate}}) + {{offset}}",
    parameters: {
      frameRate: num(30, "Frames per second"),
      offset: num(1, "Starting frame number"),
    },
  },

  // --- physics ---
  {
    key: "bounce",
    title: "Bounce",
    category: "physics",
    description: "Bouncy overshoot after keyframes",
    expression: lines(
      "var amp = {{amplitude}};",
      "var freq = {{frequency}};",
      "var decay = {{decay}};",
      ...LAST_KEY,
      "if (n > 0) {",
      "  var t = time - key(n).time;",
      "  var v = velocityAtTime(key(n).time - 0.001);",
      "  add(value, mul(v, amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t)));",
      "} else {",
      "  value;",
      "}",
    ),
    parameters: {
      amplitude: num(0.1, "Bounce amplitude"),
      frequency: num(3, "Bounce frequency"),
      decay: num(5, "Decay rate"),
    },
  },
  {
    key: "inertia",
    title: "Inertia",
    category: "physics",
    description: "Momentum/inertia after keyframes",
    expression: lines(
      "var friction = {{friction}};",
      ...LAST_KEY,
      "if (n > 0) {",
      "  var t = time - key(n).time;",
      "  var v = velocityAtTime(key(n).time - 0.001);",
      "  add(value, mul(v, (1 - Math.exp(-friction * t)) / friction));",
      "} else {",
      "  value;",
      "}",
    ),
    parameters: { friction: num(5, "Friction coefficient") },
  },
  {
    key: "springy",
    title: "Spring",
    category: "physics",
    description: "Spring physics animation",
    expression: lines(
      "var mass = {{mass}};",
      "var stiffness = {{stiffness}};",
      "var damping = {{damping}};",
      ...LAST_KEY,
      "if (n > 0) {",
      "  var t = time - key(n).time;",
      "  var omega = Math.sqrt(stiffness / mass);",
      "  var zeta = damping / (2 * Math.sqrt(mass * stiffness));",
      "  var v = velocityAtTime(key(n).time - 0.001);",
      "  if (zeta < 1) {",
      "    var omegaD = omega * Math.sqrt(1 - zeta * zeta);",
      "    add(value, mul(v, Math.exp(-zeta * omega * t) * Math.sin(omegaD * t) / omegaD));",
      "  } else {",
      "    value;",
      "  }",
      "} else {",
      "  value;",
      "}",
    ),
    parameters: {
      mass: num(1, "Mass"),
      stiffness: num(100, "Spring stiffness"),
      damping: num(10, "Damping"),
    },
  },

  // --- linking ---
  {
    key: "matchPosition",
    title: "Match Position",
    category: "linking",
    description: "Match position of another layer",
    expression: lines("var target = thisComp.layer({{targetLayer}});", "target.transform.position"),
    parameters: { targetLayer: str("Target", "Target layer name") },
  },
  {
    key: "offsetPosition",
    title: "Offset Position",
    category: "linking",
    description: "Position offset from another layer",
    expression: lines(
      "var target = thisComp.layer({{targetLayer}});",
      "var offset = [{{offsetX}}, {{offsetY}}];",
      "add(target.transform.position, offset)",
    ),
    parameters: {
      targetLayer: str("Target", "Target layer name"),
      offsetX: num(100, "X offset"),
      offsetY: num(0, "Y offset"),
    },
  },
  {
    key: "followWithDelay",
    title: "Follow With Delay",
    category: "linking",
    description: "Follow another layer with time delay",
    expression: lines(
      "var target = thisComp.layer({{targetLayer}});",
      "var delay = {{delay}};",
      "target.transform.position.valueAtTime(time - delay)",
    ),
    parameters: {
      targetLayer: str("Target", "Target layer name"),
      delay: num(0.1, "Follow delay in seconds"),
    },
  },
  {
    key: "inverseRotation",
    title: "Inverse Rotation",
    category: "linking",
    description: "Inverse rotation of another layer",
    expression: lines(
      "var target = thisComp.layer({{targetLayer}});",
      "-target.transform.rotation",
    ),
    parameters: { targetLayer: str("Target", "Target layer name") },
  },

  // --- random ---
  {
    key: "randomPosition",
    title: "Random Position",
    category: "random",
    description: "Random position within bounds",
    expression: lines(
      "seedRandom(index, true);",
      "var minX = {{minX}};",
      "var maxX = {{maxX}};",
      "var minY = {{minY}};",
      "var maxY = {{maxY}};",
      "[random(minX, maxX), random(minY, maxY)]",
    ),
    parameters: {
      minX: num(0, "Minimum X"),
      maxX: num(1920, "Maximum X"),
      minY: num(0, "Minimum Y"),
      maxY: num(1080, "Maximum Y"),
    },
  },
  {
    key: "randomRotation",
    title: "Random Rotation",
    category: "random",
    description: "Random rotation value",
    expression: lines("seedRandom(index, true);", "random({{min}}, {{max}})"),
    parameters: {
      min: num(-180, "Minimum rotation"),
      max: num(180, "Maximum rotation"),
    },
  },
];

const BY_KEY = new Map(EXPRESSION_TEMPLATES.map((t) => [t.key, t]));

export function getExpressionTemplate(key: string): ExpressionTemplate | undefined {
  return BY_KEY.get(key);
}

/**
 * A value as expression source. Strings become JSON string literals (with the
 * two line separators JavaScript engines may reject escaped), never raw text.
 */
function literal(type: TemplateParamType, value: unknown): string | null {
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  }
  if (type === "boolean") return typeof value === "boolean" ? String(value) : null;
  if (type === "string") {
    return typeof value === "string"
      ? JSON.stringify(value)
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029")
      : null;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return `[${value.map(String).join(", ")}]`;
  }
  return null;
}

export type RenderResult = { ok: true; expression: string } | { ok: false; error: string };

/** Fill a template's placeholders; every value is type-checked first. */
export function renderTemplate(key: string, params: Record<string, unknown> = {}): RenderResult {
  const template = getExpressionTemplate(key);
  if (!template) {
    return {
      ok: false,
      error: `unknown template '${key}' (see expression.list_templates)`,
    };
  }
  const declared = Object.keys(template.parameters);
  for (const name of Object.keys(params)) {
    if (params[name] !== undefined && !declared.includes(name)) {
      return {
        ok: false,
        error: `template '${key}' has no parameter '${name}' (it takes: ${declared.join(", ") || "none"})`,
      };
    }
  }
  const literals: Record<string, string> = {};
  for (const [name, def] of Object.entries(template.parameters)) {
    const value = params[name] !== undefined ? params[name] : def.default;
    const lit = literal(def.type, value);
    if (lit === null) {
      return { ok: false, error: `parameter '${name}' of template '${key}' must be a ${def.type}` };
    }
    literals[name] = lit;
  }
  // One pass over the TEMPLATE text: a value that itself contains "{{x}}"
  // (a layer named so) is inserted as-is and never expanded again.
  let missing: string | null = null;
  const text = template.expression.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(literals, name)) {
      missing = name;
      return "";
    }
    return literals[name];
  });
  if (missing !== null) {
    return { ok: false, error: `template '${key}' uses an undeclared placeholder '${missing}'` };
  }
  return { ok: true, expression: text };
}
