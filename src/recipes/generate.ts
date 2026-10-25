// Generator: from a resolved recipe to ONE batch.run of existing kumo
// operations (the recipe format spec §11–§13). The construction comes first, then
// the read-only verification steps in the same batch — one call, one undo
// group, and the proof comes back with the build.
//
// Every operation name and parameter here exists in src/operations/*.ts; the
// tests run each generated op through the registry's own argument validator.

import type { UsedCard } from "./archive.js";
import { CURVES, bezierToEase } from "./curves.js";
import type { ResolvedCheck, ResolvedTrack, Resolved, SafeRect } from "./resolve.js";
import { framesToSeconds, round } from "./units.js";

export interface BatchOp {
  operation: string;
  args: Record<string, unknown>;
}

export type ReadSlot =
  | { kind: "bounds"; index: number; layer: string; frame: number }
  | { kind: "measure"; index: number; layer: string }
  | { kind: "value"; index: number; layer: string; alias: string; frame: number }
  | { kind: "frame"; index: number; frame: number; outPath: string };

export interface Plan {
  recipe: { id: string; version: number; title: string };
  comp: Resolved["comp"];
  format: string;
  batch: { operation: "batch.run"; args: { stopOnError: true; ops: BatchOp[] } };
  /** How many leading ops build; the rest are verification reads. */
  construction: number;
  reads: ReadSlot[];
  checks: ResolvedCheck[];
  look: string[];
  usedCards: UsedCard[];
  usedCardsLine: string;
  defaultsUsed: Resolved["defaultsUsed"];
  warnings: string[];
  confidentiality: string;
  summary: string[];
}

export interface PlanOptions {
  /** Absolute folder for the render.frame PNGs of the "frames" check. */
  framesDir: string;
}

type KeySpec = Record<string, unknown>;

/** A ReadSlot before its batch index is known (Omit distributed over the union). */
type SlotInput = ReadSlot extends infer S ? (S extends ReadSlot ? Omit<S, "index"> : never) : never;

type Side = { linear: true } | { linear: false; influence: number; speed: number };

/**
 * One side of a key, from the curve of the segment it borders (§8.2).
 * TODO M6a: once keyframe.apply takes a named `curve`, pass the name instead.
 */
function sideOf(
  track: ResolvedTrack,
  a: number,
  b: number,
  which: "in" | "out",
  fps: number,
  warnings: string[],
): Side {
  const curveName = track.keys[b].curve ?? "linear";
  const curve = CURVES[curveName];
  if (!curve || curve.kind !== "bezier") return { linear: true };
  const ease = bezierToEase(curve.bezier);
  const factor = which === "out" ? ease.outFactor : ease.inFactor;
  const influence = which === "out" ? ease.outInfluence : ease.inInfluence;
  const ka = track.keys[a];
  const kb = track.keys[b];
  const dt = (kb.frame - ka.frame) / fps;
  let m = 0;
  if (typeof ka.value === "number" && typeof kb.value === "number") {
    m = (kb.value - ka.value) / dt;
  } else if (track.info.kind === "spatial") {
    const va = ka.value as number[];
    const vb = kb.value as number[];
    m = Math.hypot(...va.map((x, i) => vb[i] - x)) / dt;
  } else if (factor !== 0) {
    // kumo eases every dimension with ONE speed (jsx/helpers.jsx AE.setEase):
    // a non-zero speed would also move the dimension meant to stay still.
    // TODO M6a: per-dimension speeds once keyframe.apply accepts them.
    warnings.push(
      `«${track.layerName}» · ${track.alias}: la curva «${curveName}» ha una velocità che kumo non sa dare a una sola dimensione; uso velocità 0 (anima un cursore a una dimensione per la curva esatta)`,
    );
  }
  return { linear: false, influence: round(influence, 2), speed: round(factor * m, 2) };
}

/** keyframe.apply key list for one track: values plus both sides of every key. */
export function keySpecs(track: ResolvedTrack, fps: number, warnings: string[]): KeySpec[] {
  const n = track.keys.length;
  return track.keys.map((k, i) => {
    const spec: KeySpec = { time: framesToSeconds(k.frame, fps), value: k.value };
    const inSide = i > 0 ? sideOf(track, i - 1, i, "in", fps, warnings) : null;
    const outSide = i < n - 1 ? sideOf(track, i, i + 1, "out", fps, warnings) : null;
    if (inSide?.linear && outSide?.linear) {
      spec.interp = "linear";
      return spec;
    }
    if (inSide) {
      if (inSide.linear) spec.inType = "linear";
      else {
        spec.inInfluence = inSide.influence;
        spec.inSpeed = inSide.speed;
      }
    }
    if (outSide) {
      if (outSide.linear) spec.outType = "linear";
      else {
        spec.outInfluence = outSide.influence;
        spec.outSpeed = outSide.speed;
      }
    }
    return spec;
  });
}

const SLIDER_MATCH_NAME = "ADBE Slider Control";
const SLIDER_VALUE_PATH = (name: string) => [
  "ADBE Effect Parade",
  name,
  "ADBE Slider Control-0001",
];

function framesFile(framesDir: string, recipeId: string, frame: number): string {
  const dir = framesDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${dir}/${recipeId}-${String(frame).padStart(3, "0")}f.png`;
}

/** The line written in the comp comment and said in chat (the archive format spec §8.3). */
export function cardsComment(recipe: { id: string; version: number }, used: UsedCard[]): string {
  const sorted = [...used].sort((a, b) => a.id.localeCompare(b.id));
  const styles = sorted.filter((c) => c.kind === "style").map((c) => `${c.id} v${c.version}`);
  const others = sorted.filter((c) => c.kind !== "style").map((c) => `${c.id} v${c.version}`);
  const cards =
    styles.length + others.length === 0
      ? "nessuna (valori predefiniti della ricetta)"
      : [styles.join(", "), others.join(", ")].filter((s) => s !== "").join("; ");
  return `Parlez! · ricetta ${recipe.id} v${recipe.version} · schede: ${cards}`;
}

function usedCardsLine(recipe: { id: string; version: number }, used: UsedCard[]): string {
  const sorted = [...used].sort((a, b) => a.id.localeCompare(b.id));
  const kindWord: Record<string, string> = {
    style: "stile",
    technique: "tecnica",
    recipe: "ricetta",
    sample: "campione",
  };
  const parts = sorted.map(
    (c) => `${kindWord[c.kind] ?? c.kind} ${c.id} v${c.version} (${c.fields.join(", ")})`,
  );
  parts.push(`ricetta ${recipe.id} v${recipe.version}`);
  return `Schede usate: ${parts.join(" · ")}`;
}

export function buildPlan(r: Resolved, opts: PlanOptions): Plan {
  const comp = r.comp.name;
  const fps = r.comp.fps;
  const warnings = [...r.warnings];
  const ops: BatchOp[] = [];
  const push = (operation: string, args: Record<string, unknown>) => ops.push({ operation, args });

  push("comp.create", {
    name: comp,
    width: r.comp.width,
    height: r.comp.height,
    fps,
    duration: r.comp.duration,
    ...(r.comp.bgColor ? { bgColor: r.comp.bgColor } : {}),
  });

  // Per layer: create → contents → parent → transform. Parenting with
  // jump: true BEFORE the transform means the recipe's numbers are read in the
  // parent's space, as the recipe writes them (layer.set_parent, layer.ts).
  for (const l of r.layers) {
    if (l.type === "null") push("layer.create_null", { comp, name: l.name });
    else if (l.type === "shape") {
      push("layer.create_shape", { comp, name: l.name });
      // A fresh shape layer has an empty Contents, so the k-th group added is
      // at index k — no result needs to travel between batch steps.
      l.shapes.forEach((s, k) => {
        const groupIndex = k + 1;
        push("shape.add_group", { comp, layer: l.name, name: s.group });
        if (s.rect)
          push("shape.add_rect", {
            comp,
            layer: l.name,
            groupIndex,
            size: s.rect.size,
            position: s.rect.position,
            roundness: s.rect.roundness,
          });
        if (s.ellipse)
          push("shape.add_ellipse", { comp, layer: l.name, groupIndex, size: s.ellipse.size });
        if (s.fill)
          push("shape.add_fill", {
            comp,
            layer: l.name,
            groupIndex,
            color: s.fill.color,
            ...(s.fill.opacity !== undefined ? { opacity: s.fill.opacity } : {}),
          });
        if (s.stroke)
          push("shape.add_stroke", {
            comp,
            layer: l.name,
            groupIndex,
            color: s.stroke.color,
            ...(s.stroke.width !== undefined ? { width: s.stroke.width } : {}),
          });
      });
    } else {
      push("layer.create_text", { comp, name: l.name, text: l.text ?? "" });
      if (Object.keys(l.style).length > 0)
        push("text.set_style", { comp, layer: l.name, ...l.style });
    }
    for (const c of l.controls) {
      push("effect.add", { comp, layer: l.name, matchName: SLIDER_MATCH_NAME, name: c.name });
      if (c.value !== 0)
        push("property.set", {
          comp,
          layer: l.name,
          property: SLIDER_VALUE_PATH(c.name),
          value: c.value,
        });
    }
    if (l.parentName)
      push("layer.set_parent", { comp, layer: l.name, parentLayer: l.parentName, jump: true });
    if (Object.keys(l.transform).length > 0)
      push("transform.set", { comp, layer: l.name, ...l.transform });
  }

  for (const l of r.layers) {
    for (const e of l.expressions)
      push("expression.set", {
        comp,
        layer: l.name,
        property: e.info.path,
        expression: e.expression,
      });
  }

  // Keys grouped by layer, in creation order, then by track: the same order a
  // person would check them in the timeline.
  const tracks = [...r.tracks].sort(
    (a, b) => a.layerOrder - b.layerOrder || a.trackOrder - b.trackOrder,
  );
  for (const t of tracks) {
    push("keyframe.apply", {
      comp,
      layer: t.layerName,
      property: t.info.path,
      keys: keySpecs(t, fps, warnings),
      // No `replace`: the layers are new, and replace: true would need the
      // user's confirm (confirm-policy.ts) for keys that cannot exist.
      ...(t.spatialLinear ? { spatialTangents: "linear" } : {}),
    });
  }

  for (const m of r.markers)
    push("marker.add_comp", { comp, time: framesToSeconds(m.frame, fps), comment: m.comment });
  push("item.set_props", { item: comp, comment: cardsComment(r.recipe, r.usedCards) });

  const construction = ops.length;

  // §13.3 — verification reads, de-duplicated.
  const reads: ReadSlot[] = [];
  const seen = new Set<string>();
  const read = (key: string, slot: SlotInput, operation: string, args: Record<string, unknown>) => {
    if (seen.has(key)) return;
    seen.add(key);
    reads.push({ ...slot, index: ops.length } as ReadSlot);
    push(operation, args);
  };
  for (const c of r.checks) {
    if (c.check === "insideSafeArea" || c.check === "inside") {
      const names = c.check === "inside" ? [...c.layers, c.container] : c.layers;
      for (const layer of names) {
        read(
          `bounds|${layer}|${c.frame}`,
          { kind: "bounds", layer, frame: c.frame },
          "layer.bounds",
          { comp, layer, time: framesToSeconds(c.frame, fps) },
        );
      }
    } else if (c.check === "fontIs") {
      for (const layer of c.layers)
        read(`measure|${layer}`, { kind: "measure", layer }, "text.measure", { comp, layer });
    } else if (c.check === "value") {
      for (const layer of c.layers) {
        for (const frame of c.frames) {
          read(
            `value|${layer}|${c.alias}|${frame}`,
            { kind: "value", layer, alias: c.alias, frame },
            "property.get",
            {
              comp,
              layer,
              property: c.info.path,
              time: framesToSeconds(frame, fps),
            },
          );
        }
      }
    } else {
      for (const frame of c.frames) {
        const outPath = framesFile(opts.framesDir, r.recipe.id, frame);
        read(`frame|${frame}`, { kind: "frame", frame, outPath }, "render.frame", {
          comp,
          time: framesToSeconds(frame, fps),
          outPath,
        });
      }
    }
  }

  return {
    recipe: r.recipe,
    comp: r.comp,
    format: r.format,
    batch: { operation: "batch.run", args: { stopOnError: true, ops } },
    construction,
    reads,
    checks: r.checks,
    look: r.look,
    usedCards: r.usedCards,
    usedCardsLine: usedCardsLine(r.recipe, r.usedCards),
    defaultsUsed: r.defaultsUsed,
    warnings,
    confidentiality: r.confidentiality,
    summary: summarize(r, tracks),
  };
}

/** The readable summary Anthony approves instead of the JSON (the recipe format spec §11). */
function summarize(r: Resolved, tracks: ResolvedTrack[]): string[] {
  const typeWord: Record<string, string> = { null: "null", shape: "forma", text: "testo" };
  const lines = [
    `Composizione «${r.comp.name}»: ${r.comp.width}×${r.comp.height}, ${r.comp.fps} fps, ${r.comp.duration} s (${r.comp.durationFrames} fotogrammi, l'ultimo è il ${r.comp.end}).`,
    `Livelli dal basso: ${r.layers.map((l) => `${l.name} (${typeWord[l.type]})`).join(", ")}.`,
  ];
  for (const t of tracks) {
    const segs = t.keys.slice(1).map((k, i) => `${t.keys[i].frame}f→${k.frame}f ${k.curve}`);
    lines.push(`Animazione ${t.layerName} · ${t.alias}: ${segs.join(", ")}.`);
  }
  lines.push(
    r.usedCards.length > 0
      ? usedCardsLine(r.recipe, r.usedCards)
      : "Schede usate: nessuna, solo i valori predefiniti della ricetta.",
  );
  return lines;
}

// --- acceptance (§10) ---

export type Outcome = "ok" | "fallito" | "non verificabile";

export interface CheckOutcome {
  check: ResolvedCheck["check"];
  layer?: string;
  frame?: number;
  outcome: Outcome;
  detail: string;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxOf(result: unknown): Box | null {
  const cs = (result as { compSpace?: Record<string, unknown> } | null)?.compSpace;
  if (!cs) return null;
  const pts = ["topLeft", "topRight", "bottomLeft", "bottomRight"].map((k) => cs[k]);
  if (!pts.every((p) => Array.isArray(p) && p.length >= 2 && p.every((x) => typeof x === "number")))
    return null;
  const xs = (pts as number[][]).map((p) => p[0]);
  const ys = (pts as number[][]).map((p) => p[1]);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

const TOLERANCE_PX = 0.5;

function within(inner: Box, outer: Box | SafeRect, margin = 0): boolean {
  return (
    inner.left >= outer.left + margin - TOLERANCE_PX &&
    inner.right <= outer.right - margin + TOLERANCE_PX &&
    inner.top >= outer.top + margin - TOLERANCE_PX &&
    inner.bottom <= outer.bottom - margin + TOLERANCE_PX
  );
}

function fmtBox(b: Box): string {
  return `x ${round(b.left, 1)}…${round(b.right, 1)}, y ${round(b.top, 1)}…${round(b.bottom, 1)}`;
}

/**
 * Whether a value read from After Effects is the one a check expects.
 *
 * After Effects reports Scale, Position and Anchor Point with THREE components
 * even on a 2D layer (seen on 26.5: Scale [0, 100, 100] where the recipe means
 * [0, 100]), and stores numbers with float noise. A recipe writes only the
 * dimensions it means, so only those are compared — the first N — each within
 * a tolerance; a 1-element array also matches a plain number.
 */
export function valueMatches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") {
    const a = Array.isArray(actual) && actual.length === 1 ? actual[0] : actual;
    return (
      typeof a === "number" && Math.abs(a - expected) <= Math.max(0.01, Math.abs(expected) * 1e-6)
    );
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => valueMatches(actual[i], e));
  }
  return actual === expected;
}

/** The read value as the check compares it: the extra components are left out. */
function comparedPart(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected) && Array.isArray(actual) && actual.length > expected.length) {
    return actual.slice(0, expected.length);
  }
  return actual;
}

function okResult(r: unknown): boolean {
  return r !== null && typeof r === "object" && (r as { ok?: unknown }).ok === true;
}

/** Turn the batch's verification results into plain-Italian outcomes. */
export function evaluateAcceptance(plan: Plan, results: unknown[]): CheckOutcome[] {
  const fps = plan.comp.fps;
  const resultAt = (i: number): unknown => results[i];
  const slot = <K extends ReadSlot["kind"]>(
    kind: K,
    match: (s: Extract<ReadSlot, { kind: K }>) => boolean,
  ) =>
    plan.reads.find(
      (s): s is Extract<ReadSlot, { kind: K }> =>
        s.kind === kind && match(s as Extract<ReadSlot, { kind: K }>),
    );
  const boundsOf = (layer: string, frame: number): Box | null => {
    const s = slot("bounds", (x) => x.layer === layer && x.frame === frame);
    const r = s ? resultAt(s.index) : undefined;
    return okResult(r) ? boxOf(r) : null;
  };
  const out: CheckOutcome[] = [];
  const at = (frame: number) => `${frame}f (${framesToSeconds(frame, fps)} s)`;

  for (const c of plan.checks) {
    if (c.check === "insideSafeArea") {
      for (const layer of c.layers) {
        const b = boundsOf(layer, c.frame);
        if (!b)
          out.push({
            check: c.check,
            layer,
            frame: c.frame,
            outcome: "non verificabile",
            detail: `After Effects non ha dato i bordi di «${layer}» a ${at(c.frame)}`,
          });
        else
          out.push({
            check: c.check,
            layer,
            frame: c.frame,
            outcome: within(b, c.rect) ? "ok" : "fallito",
            detail: `«${layer}» a ${at(c.frame)}: ${fmtBox(b)}; area ${c.area === "title" ? "del titolo" : "di azione"} ${fmtBox(c.rect)}`,
          });
      }
    } else if (c.check === "inside") {
      const outer = boundsOf(c.container, c.frame);
      for (const layer of c.layers) {
        const b = boundsOf(layer, c.frame);
        if (!b || !outer)
          out.push({
            check: c.check,
            layer,
            frame: c.frame,
            outcome: "non verificabile",
            detail: `mancano i bordi di «${layer}» o di «${c.container}» a ${at(c.frame)}`,
          });
        else
          out.push({
            check: c.check,
            layer,
            frame: c.frame,
            outcome: within(b, outer, c.margin) ? "ok" : "fallito",
            detail: `«${layer}» ${fmtBox(b)} dentro «${c.container}» ${fmtBox(outer)} con margine ${c.margin} px`,
          });
      }
    } else if (c.check === "fontIs") {
      for (const layer of c.layers) {
        const s = slot("measure", (x) => x.layer === layer);
        const r = (s ? resultAt(s.index) : undefined) as
          | { ok?: boolean; fontFamily?: unknown; fontStyle?: unknown }
          | undefined;
        if (!r || r.ok !== true || typeof r.fontFamily !== "string") {
          out.push({
            check: c.check,
            layer,
            outcome: "non verificabile",
            detail: `After Effects non ha detto il font di «${layer}»`,
          });
        } else if (!c.font.family) {
          out.push({
            check: c.check,
            layer,
            outcome: "non verificabile",
            detail: `«${layer}» usa ${r.fontFamily} ${String(r.fontStyle ?? "")}; la ricetta conosce solo il nome PostScript «${c.font.postscript}»`,
          });
        } else {
          const ok =
            r.fontFamily === c.font.family &&
            (c.font.style === undefined || r.fontStyle === c.font.style);
          out.push({
            check: c.check,
            layer,
            outcome: ok ? "ok" : "fallito",
            detail:
              `«${layer}» usa ${r.fontFamily} ${String(r.fontStyle ?? "")}; atteso ${c.font.family} ${c.font.style ?? ""}${ok ? "" : " (se il font non è installato After Effects ne mette un altro)"}`.trim(),
          });
        }
      }
    } else if (c.check === "value") {
      for (const layer of c.layers) {
        for (const frame of c.frames) {
          const s = slot(
            "value",
            (x) => x.layer === layer && x.alias === c.alias && x.frame === frame,
          );
          const r = (s ? resultAt(s.index) : undefined) as
            | { ok?: boolean; value?: unknown }
            | undefined;
          if (!r || r.ok !== true)
            out.push({
              check: c.check,
              layer,
              frame,
              outcome: "non verificabile",
              detail: `nessun valore di ${c.alias} per «${layer}» a ${at(frame)}`,
            });
          else
            out.push({
              check: c.check,
              layer,
              frame,
              outcome: valueMatches(r.value, c.equals) ? "ok" : "fallito",
              detail:
                `«${layer}» · ${c.alias} a ${at(frame)}: ${JSON.stringify(comparedPart(r.value, c.equals))}, atteso ${JSON.stringify(c.equals)}` +
                (comparedPart(r.value, c.equals) !== r.value
                  ? ` (After Effects dà ${JSON.stringify(r.value)}: contano le prime ${(c.equals as unknown[]).length} componenti)`
                  : ""),
            });
        }
      }
    } else {
      for (const frame of c.frames) {
        const s = slot("frame", (x) => x.frame === frame);
        const r = s ? resultAt(s.index) : undefined;
        out.push({
          check: c.check,
          frame,
          outcome: okResult(r) ? "ok" : "non verificabile",
          detail:
            okResult(r) && s
              ? `fotogramma ${at(frame)} in ${s.outPath}: da guardare`
              : `il fotogramma ${at(frame)} non è stato salvato`,
        });
      }
    }
  }
  return out;
}
