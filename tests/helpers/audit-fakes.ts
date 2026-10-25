// A small fake of the After Effects object model, just wide enough to run the
// comp.audit ExtendScript in Node: comps, layers, property groups, keyframes,
// sourceRectAtTime. It also builds a fake project from an import document
// (the ae_project_import_json format), the way jsx/import.jsx would — so the
// two test projects can be audited offline.
//
// Every write the audit could make is recorded in `writes`, and the tests
// compare snapshots before and after: the audit is read-only or it fails.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LINEAR = 6613;
export const BEZIER = 6614;
export const HOLD = 6615;

export const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };
export const KeyframeInterpolationType = { LINEAR, BEZIER, HOLD };

/** Shared log of anything that tried to change the fake project. */
export const writes: string[] = [];

type Value = number | number[] | string | null;

export interface FakeKey {
  t: number;
  v: Value;
  inI?: number;
  outI?: number;
}

function lerp(a: Value, b: Value, f: number): Value {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * f;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => x + ((b[i] ?? x) - x) * f);
  return a;
}

export class FakeProp {
  readonly propertyType = PropertyType.PROPERTY;
  canSetExpression = true;
  expressionEnabled = false;
  expressionError = "";
  constructor(
    readonly name: string,
    readonly matchName: string,
    public value: Value,
    public keys: FakeKey[] = [],
  ) {}
  get numKeys(): number {
    return this.keys.length;
  }
  keyTime(k: number): number {
    return this.keys[k - 1].t;
  }
  keyValue(k: number): Value {
    return this.keys[k - 1].v;
  }
  keyInInterpolationType(k: number): number {
    return this.keys[k - 1].inI ?? LINEAR;
  }
  keyOutInterpolationType(k: number): number {
    return this.keys[k - 1].outI ?? LINEAR;
  }
  /** Piecewise linear between keys: enough to tell moving from resting. */
  valueAtTime(t: number): Value {
    const ks = this.keys;
    if (ks.length === 0) return this.value;
    if (t <= ks[0].t) return ks[0].v;
    for (let i = 0; i + 1 < ks.length; i++) {
      if (t <= ks[i + 1].t) {
        const f = (t - ks[i].t) / (ks[i + 1].t - ks[i].t);
        return ks[i].outI === HOLD ? ks[i].v : lerp(ks[i].v, ks[i + 1].v, f);
      }
    }
    return ks[ks.length - 1].v;
  }
  setValue(): void {
    writes.push(`setValue ${this.matchName}`);
  }
  setValueAtTime(): void {
    writes.push(`setValueAtTime ${this.matchName}`);
  }
  addKey(): void {
    writes.push(`addKey ${this.matchName}`);
  }
  removeKey(): void {
    writes.push(`removeKey ${this.matchName}`);
  }
}

export class FakeGroup {
  readonly propertyType = PropertyType.NAMED_GROUP;
  enabled = true;
  constructor(
    public name: string,
    readonly matchName: string,
    readonly children: Array<FakeProp | FakeGroup> = [],
  ) {}
  get numProperties(): number {
    return this.children.length;
  }
  property(key: number | string): FakeProp | FakeGroup | null {
    if (typeof key === "number") return this.children[key - 1] ?? null;
    return this.children.find((c) => c.matchName === key || c.name === key) ?? null;
  }
  addProperty(mn: string): never {
    writes.push(`addProperty ${mn}`);
    throw new Error("read-only fake: addProperty");
  }
  remove(): void {
    writes.push(`remove ${this.matchName}`);
  }
}

export class FakeFootage {
  footageMissing = false;
  constructor(
    readonly name: string,
    readonly width: number,
    readonly height: number,
  ) {}
}

export interface LayerOpts {
  name: string;
  inPoint?: number;
  outPoint?: number;
  enabled?: boolean;
  threeD?: boolean;
  motionBlur?: boolean;
  adjustment?: boolean;
  guide?: boolean;
  nullLayer?: boolean;
  hasAudio?: boolean;
  audioEnabled?: boolean;
  source?: FakeFootage | FakeComp | null;
  /** Layer-space rect (sourceRectAtTime). Default: the source's size, else 100x100 at the origin. */
  rect?: { left: number; top: number; width: number; height: number };
  position?: number[];
  anchor?: number[];
  scale?: number[];
  rotation?: number;
  opacity?: number;
  orientation?: number[];
  rotationX?: number;
  rotationY?: number;
  effects?: FakeGroup[];
}

export class FakeAVLayer {
  index = 0;
  name: string;
  enabled: boolean;
  hasVideo = true;
  hasAudio: boolean;
  audioEnabled: boolean;
  inPoint: number;
  outPoint: number;
  threeDLayer: boolean;
  motionBlur: boolean;
  adjustmentLayer: boolean;
  guideLayer: boolean;
  nullLayer: boolean;
  parent: FakeAVLayer | null = null;
  source: FakeFootage | FakeComp | null;
  rect: { left: number; top: number; width: number; height: number };
  readonly transform: FakeGroup;
  readonly effects: FakeGroup;
  readonly root: FakeGroup;

  constructor(o: LayerOpts) {
    this.name = o.name;
    this.enabled = o.enabled ?? true;
    this.hasAudio = o.hasAudio ?? false;
    this.audioEnabled = o.audioEnabled ?? this.hasAudio;
    this.inPoint = o.inPoint ?? 0;
    this.outPoint = o.outPoint ?? 10;
    this.threeDLayer = o.threeD ?? false;
    this.motionBlur = o.motionBlur ?? false;
    this.adjustmentLayer = o.adjustment ?? false;
    this.guideLayer = o.guide ?? false;
    this.nullLayer = o.nullLayer ?? false;
    this.source = o.source ?? null;
    const sw = this.source?.width;
    const sh = this.source?.height;
    this.rect = o.rect ?? { left: 0, top: 0, width: sw ?? 100, height: sh ?? 100 };
    const three = this.threeDLayer;
    const anchor = o.anchor ?? (sw !== undefined && sh !== undefined ? [sw / 2, sh / 2] : [0, 0]);
    const props: FakeProp[] = [
      new FakeProp(
        "Anchor Point",
        "ADBE Anchor Point",
        three ? [...anchor, 0].slice(0, 3) : anchor,
      ),
      new FakeProp("Position", "ADBE Position", o.position ?? (three ? [960, 540, 0] : [960, 540])),
      new FakeProp("Scale", "ADBE Scale", o.scale ?? (three ? [100, 100, 100] : [100, 100])),
    ];
    if (three) {
      props.push(new FakeProp("Orientation", "ADBE Orientation", o.orientation ?? [0, 0, 0]));
      props.push(new FakeProp("X Rotation", "ADBE Rotate X", o.rotationX ?? 0));
      props.push(new FakeProp("Y Rotation", "ADBE Rotate Y", o.rotationY ?? 0));
    }
    props.push(new FakeProp("Rotation", "ADBE Rotate Z", o.rotation ?? 0));
    props.push(new FakeProp("Opacity", "ADBE Opacity", o.opacity ?? 100));
    this.transform = new FakeGroup("Transform", "ADBE Transform Group", props);
    this.effects = new FakeGroup("Effects", "ADBE Effect Parade", o.effects ?? []);
    this.root = new FakeGroup(this.name, "ADBE AV Layer", [this.transform, this.effects]);
  }

  get numProperties(): number {
    return this.root.numProperties;
  }
  property(key: number | string): FakeProp | FakeGroup | null {
    return this.root.property(key);
  }
  /** Shortcut for tests: a transform property by matchName. */
  tp(matchName: string): FakeProp {
    return this.transform.property(matchName) as FakeProp;
  }
  sourceRectAtTime(): { left: number; top: number; width: number; height: number } {
    return { ...this.rect };
  }
}
export class FakeTextLayer extends FakeAVLayer {}
export class FakeShapeLayer extends FakeAVLayer {}
export class FakeCameraLayer extends FakeAVLayer {}
export class FakeLightLayer extends FakeAVLayer {}

export class FakeComp {
  static nextId = 100;
  id = FakeComp.nextId++;
  layers: FakeAVLayer[] = [];
  motionBlur = true;
  frameRate = 25;
  constructor(
    public name: string,
    public width = 1920,
    public height = 1080,
    public duration = 10,
  ) {}
  get frameDuration(): number {
    return 1 / this.frameRate;
  }
  get numLayers(): number {
    return this.layers.length;
  }
  layer(i: number): FakeAVLayer {
    return this.layers[i - 1];
  }
  add<T extends FakeAVLayer>(l: T): T {
    this.layers.push(l);
    l.index = this.layers.length;
    return l;
  }
}

export function effect(name: string, matchName: string, enabled = true): FakeGroup {
  const g = new FakeGroup(name, matchName, []);
  g.enabled = enabled;
  return g;
}

// ---------------------------------------------------------------------------
// Running the generated ExtendScript
// ---------------------------------------------------------------------------

const JSX_DIR = new URL("../../jsx/", import.meta.url);
const HELPERS = readFileSync(fileURLToPath(new URL("helpers.jsx", JSX_DIR)), "utf8");
const TOOLKIT = readFileSync(fileURLToPath(new URL("toolkit.jsx", JSX_DIR)), "utf8");

const GLOBAL_NAMES = [
  "app",
  "CompItem",
  "AVLayer",
  "TextLayer",
  "ShapeLayer",
  "CameraLayer",
  "LightLayer",
  "PropertyType",
  "KeyframeInterpolationType",
];

function globals(comps: FakeComp[]): unknown[] {
  const app = {
    project: { numItems: comps.length, item: (i: number) => comps[i - 1] ?? null },
  };
  return [
    app,
    FakeComp,
    FakeAVLayer,
    FakeTextLayer,
    FakeShapeLayer,
    FakeCameraLayer,
    FakeLightLayer,
    PropertyType,
    KeyframeInterpolationType,
  ];
}

/** Run a generated operation body the way the dispatcher does, with helpers + toolkit loaded. */
export function runJsx(jsx: string, comps: FakeComp[]): unknown {
  const fn = new Function(...GLOBAL_NAMES, `${HELPERS}\n${TOOLKIT}\n${jsx}`) as (
    ...a: unknown[]
  ) => unknown;
  return fn(...globals(comps));
}

const plain = (n: string) => n.replace(/^_au(.)/, (_m, c: string) => c.toLowerCase());

/**
 * Load ES3 source and hand back the named functions, for unit tests of single
 * helpers. `_auSafeSides` comes back as `safeSides`: the prefix only keeps the
 * generated script's names apart from kumo's.
 */
export function loadFunctions<T>(es3: string, names: string[], comps: FakeComp[] = []): T {
  const ret = `return { ${names.map((n) => `${plain(n)}: ${n}`).join(", ")} };`;
  const fn = new Function(...GLOBAL_NAMES, `${HELPERS}\n${TOOLKIT}\n${es3}\n${ret}`) as (
    ...a: unknown[]
  ) => T;
  return fn(...globals(comps));
}

// ---------------------------------------------------------------------------
// A fake project from an import document
// ---------------------------------------------------------------------------

interface DocKey {
  time: number;
  value: Value;
  inInterp: number | null;
  outInterp: number | null;
}
interface DocProp {
  matchName: string;
  value?: Value | { fontSize?: number; text?: string };
  keyframes?: DocKey[];
}
interface DocGroup {
  matchName: string;
  properties?: DocProp[];
  groups?: DocGroup[];
}
interface DocLayer {
  index: number;
  name: string;
  type: string;
  enabled: boolean;
  inPoint: number;
  outPoint: number;
  sourceId?: number | null;
  threeDLayer?: boolean;
  text?: string | null;
  transformGroup?: DocGroup | null;
  textGroup?: DocGroup | null;
  contentsGroup?: DocGroup | null;
  parentIndex: number | null;
}
interface DocItem {
  id: number;
  name: string;
  type: string;
  width?: number;
  height?: number;
  duration?: number;
  frameRate?: number;
  motionBlur?: boolean;
  layers?: DocLayer[];
}

function findGroup(g: DocGroup | null | undefined, mn: string): DocGroup | null {
  if (!g) return null;
  if (g.matchName === mn) return g;
  for (const sub of g.groups ?? []) {
    const hit = findGroup(sub, mn);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rough text extents: 0.55 em per character, cap height above the baseline,
 * left-justified (the anchor sits on the baseline, as in After Effects). Text
 * in the test projects is short and kept well inside or well outside the
 * margins, so the real font's metrics do not change the verdicts.
 */
function textRect(fontSize: number, text: string) {
  return { left: 0, top: -0.75 * fontSize, width: 0.55 * fontSize * text.length, height: fontSize };
}

function shapeRect(contents: DocGroup | null | undefined) {
  for (const mn of ["ADBE Vector Shape - Ellipse", "ADBE Vector Shape - Rect"]) {
    const g = findGroup(contents, mn);
    const size = g?.properties?.find((p) => p.matchName.endsWith("Size"))?.value;
    if (Array.isArray(size)) {
      return { left: -size[0] / 2, top: -size[1] / 2, width: size[0], height: size[1] };
    }
  }
  return { left: 0, top: 0, width: 0, height: 0 };
}

/**
 * Build fake comps from an import document, mirroring jsx/import.jsx: what it
 * restores (timing, transform values and keys, comp motion blur, 3D switch)
 * and what it does not — notably the LAYER motion blur switch, which the
 * import format does not carry, so every imported layer has it off.
 */
export function fakeProjectFromDoc(doc: { items: DocItem[] }): FakeComp[] {
  const sources = new Map<number, FakeFootage | FakeComp>();
  const comps: FakeComp[] = [];
  for (const it of doc.items) {
    if (it.type === "FootageItem") {
      sources.set(it.id, new FakeFootage(it.name, it.width ?? 100, it.height ?? 100));
    } else if (it.type === "CompItem") {
      const c = new FakeComp(it.name, it.width, it.height, it.duration);
      c.frameRate = it.frameRate ?? 25;
      c.motionBlur = it.motionBlur ?? false;
      sources.set(it.id, c);
      comps.push(c);
    }
  }
  for (const it of doc.items) {
    if (it.type !== "CompItem") continue;
    const c = sources.get(it.id) as FakeComp;
    const built: FakeAVLayer[] = [];
    for (const ls of it.layers ?? []) {
      let layer: FakeAVLayer;
      const common = {
        name: ls.name,
        inPoint: ls.inPoint,
        outPoint: ls.outPoint,
        enabled: ls.enabled,
        threeD: ls.threeDLayer ?? false,
      };
      if (ls.type === "TextLayer") {
        const td = ls.textGroup?.properties?.[0]?.value as { fontSize?: number; text?: string };
        const rect = textRect(td?.fontSize ?? 36, td?.text ?? ls.text ?? "");
        layer = new FakeTextLayer({ ...common, rect });
      } else if (ls.type === "ShapeLayer") {
        layer = new FakeShapeLayer({ ...common, rect: shapeRect(ls.contentsGroup) });
      } else {
        const src = ls.sourceId != null ? (sources.get(ls.sourceId) ?? null) : null;
        layer = new FakeAVLayer({ ...common, source: src });
      }
      for (const ps of ls.transformGroup?.properties ?? []) {
        const prop = layer.tp(ps.matchName);
        if (!prop) continue;
        if (ps.value !== undefined) prop.value = ps.value as Value;
        prop.keys = (ps.keyframes ?? []).map((k) => ({
          t: k.time,
          v: k.value,
          inI: k.inInterp ?? LINEAR,
          outI: k.outInterp ?? LINEAR,
        }));
      }
      built.push(layer);
    }
    for (const l of built) c.add(l);
    (it.layers ?? []).forEach((ls, i) => {
      if (ls.parentIndex != null) built[i].parent = built[ls.parentIndex - 1];
    });
  }
  return comps;
}

/** Everything the audit could have changed, as plain data, for before/after comparison. */
export function snapshot(comps: FakeComp[]): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(comps, (key, v) => {
    if (key === "parent" || key === "source") return v ? (v as { name: string }).name : v;
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[seen]";
      seen.add(v);
    }
    return v;
  });
}
