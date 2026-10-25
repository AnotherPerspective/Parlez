// Property aliases of the recipe format → kumo property paths (the recipe format spec §7).
//
// Paths use After Effects matchNames or names the recipe itself gave (a shape
// group, a slider), never AE's display names: those change with the language
// After Effects runs in, and a recipe must work the same in Italian and English.

export type PropKind = "1d" | "spatial" | "multi";

export interface PropInfo {
  path: string[];
  kind: PropKind;
}

const TRANSFORM: Readonly<Record<string, PropInfo>> = {
  position: { path: ["ADBE Transform Group", "ADBE Position"], kind: "spatial" },
  anchorPoint: { path: ["ADBE Transform Group", "ADBE Anchor Point"], kind: "spatial" },
  // Scale has two dimensions and kumo eases them with one shared speed
  // (jsx/helpers.jsx AE.setEase): "multi" lets the executor refuse a speed
  // that would move the dimension meant to stay still.
  scale: { path: ["ADBE Transform Group", "ADBE Scale"], kind: "multi" },
  rotation: { path: ["ADBE Transform Group", "ADBE Rotate Z"], kind: "1d" },
  opacity: { path: ["ADBE Transform Group", "ADBE Opacity"], kind: "1d" },
};

const SHAPE_RE = /^shape:([^/]+)\/rect\.(size|position)$/;
const CONTROL_RE = /^control:(.+)$/;

/** The kumo path for an alias, or null when the alias is not one we know. */
export function propertyInfo(alias: string): PropInfo | null {
  if (Object.hasOwn(TRANSFORM, alias)) return TRANSFORM[alias];
  const c = CONTROL_RE.exec(alias);
  if (c) return { path: ["ADBE Effect Parade", c[1], "ADBE Slider Control-0001"], kind: "1d" };
  const s = SHAPE_RE.exec(alias);
  if (s) {
    return {
      path: [
        "ADBE Root Vectors Group",
        s[1],
        "ADBE Vectors Group",
        "ADBE Vector Shape - Rect",
        s[2] === "size" ? "ADBE Vector Rect Size" : "ADBE Vector Rect Position",
      ],
      // Treated as non-spatial on purpose: whether AE eases Rect Position
      // along a path is not verified yet, and "multi" is the safe reading.
      kind: "multi",
    };
  }
  return null;
}

export const PROPERTY_ALIAS_HELP =
  "position, anchorPoint, scale, rotation, opacity, control:<nome>, shape:<gruppo>/rect.size, shape:<gruppo>/rect.position";

/** transform keys a layer may set, in the order the executor writes them. */
export const TRANSFORM_KEYS = ["position", "anchorPoint", "scale", "rotation", "opacity"] as const;

/** text.set_style parameters a recipe may set on a text layer. */
export const TEXT_STYLE_KEYS = [
  "font",
  "fontSize",
  "fillColor",
  "strokeColor",
  "strokeWidth",
  "applyFill",
  "applyStroke",
  "tracking",
  "leading",
  "justification",
  "baselineShift",
  "allCaps",
  "smallCaps",
] as const;
