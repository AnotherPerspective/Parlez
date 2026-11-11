// Parlez! recipes — the data format of the files in recipes/.
//
// A recipe is DATA, never code: it describes a reusable motion-graphics piece
// (layers, styles, timing, curves) and the executor turns it into ONE
// batch.run of existing kumo operations. Field names are English (kumo's
// convention); every value the user reads stays in their own language.

/** Expression text: a string starting with "=" is evaluated by calc.ts. */
export type Calc = string;

/** A literal or a calc ("= …"). */
export type Value = number | string | boolean | null | Value[] | { [k: string]: Value };

export type ParamType =
  | "text"
  | "color"
  | "font"
  | "length"
  | "time"
  | "format"
  | "curve"
  | "choice";

/** A reference into the chosen archive, with a fallback literal. */
export interface RefDefault {
  $ref: string;
  default?: Value;
}

export interface RecipeParam {
  type: ParamType;
  default?: Value | RefDefault;
  optional?: boolean;
  maxChars?: number;
  min?: string;
  max?: string;
  options?: string[];
  note?: string;
}

export interface Approval {
  by: string;
  date: string;
  note?: string;
}

export type Confidentiality = "libero" | "interno-app" | "cliente";

export interface CardSource {
  type: string;
  ref: string;
  label?: string;
  detail?: string;
  ownership?: string;
  note?: string;
}

export interface CardHeader {
  confidentiality: Confidentiality;
  toClaude?: { numbers: boolean; descriptions: boolean; images: boolean };
  sources?: CardSource[];
  approval?: Approval | null;
  client?: unknown;
}

export interface RecipeShape {
  group: string;
  rect?: { size: Value; position?: Value; roundness?: Value };
  ellipse?: { size: Value };
  fill?: { color: Value; opacity?: Value };
  stroke?: { color: Value; width?: Value };
}

export interface FitTextTemplate {
  template: "fitText";
  layers: string[];
  padX: Value;
  height: Value;
}

export interface RecipeLayer {
  id: string;
  type: "null" | "shape" | "text";
  name: string;
  parent?: string;
  when?: Calc;
  text?: string;
  style?: Record<string, Value>;
  shapes?: RecipeShape[];
  controls?: Array<{ slider: string; value?: Value }>;
  transform?: Record<string, Value>;
  expressions?: Record<string, string | FitTextTemplate>;
  note?: string;
}

export interface RecipeKey {
  at: Value;
  value?: Value;
  offset?: Value;
  curve?: Value;
  phase?: "in" | "out";
}

export interface RecipeTrack {
  layer?: string;
  layers?: string[];
  property: string;
  relative?: boolean;
  spatial?: "linear" | "auto";
  stagger?: { in?: Value; out?: Value };
  keys: RecipeKey[];
}

export interface RecipeCheck {
  check: "insideSafeArea" | "inside" | "fontIs" | "value" | "frames";
  layer?: string;
  layers?: string[];
  area?: "title" | "action";
  container?: string;
  margin?: Value;
  font?: Value;
  property?: string;
  at?: Value;
  equals?: Value;
}

export interface Recipe {
  format: string;
  kind: "recipe";
  id: string;
  version: number;
  status: "draft" | "approved" | "retired";
  title: string;
  summary: string;
  header: CardHeader;
  requires: { ae: string; capabilities: string[] };
  params: Record<string, RecipeParam>;
  let?: Record<string, Value>;
  comp: { create: true; name: string; format: Value; duration: Value; bgColor?: Value };
  layers: RecipeLayer[];
  animation?: RecipeTrack[];
  markers?: Array<{ at: Value; comment: string }>;
  acceptance: { checks: RecipeCheck[]; look: string[] };
  note?: string;
}

/** A font as the executor uses it: always carries a capHeight. */
export interface FontValue {
  postscript: string;
  family?: string;
  style?: string;
  capHeight: number;
}

/** One problem found by the validator or the resolver, in plain Italian. */
export interface RecipeIssue {
  path: string;
  message: string;
}

/** Thrown when a recipe cannot be turned into operations. */
export class RecipeError extends Error {
  readonly issues: RecipeIssue[];
  constructor(issues: RecipeIssue[] | string) {
    const list = typeof issues === "string" ? [{ path: "", message: issues }] : issues;
    super(list.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n"));
    this.name = "RecipeError";
    this.issues = list;
  }
}

/** The lowest After Effects version Parlez! supports (decision of 25/10/2026). */
export const MIN_AE_VERSION = "24.0";

/**
 * Capabilities a recipe may declare in `requires.capabilities`, with the
 * version that introduced each. At run time they are
 * checked by existence, never by version number; the version here only lets
 * the validator catch a `requires.ae` lower than what the declared features need.
 */
export const KNOWN_CAPABILITIES: Readonly<Record<string, string>> = {
  verticalText: "24.2",
  characterRange: "24.3",
  threeDModels: "24.4",
  fontsUsed: "24.5",
  boxAutoFit: "24.6",
  expressionTextStyles: "25.0",
  variableFonts: "26.0",
  parametricMesh: "26.3",
};
