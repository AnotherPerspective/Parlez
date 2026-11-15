// A small fake of Premiere Pro's scripting objects, for the offline tests of
// the Premiere agent and the pr_* tools: one project with a bin, two clips
// (one offline), one sequence with a video track, a clip on it and two
// markers. Only the members jsx/premiere-helpers.jsx reads or writes exist,
// so a new dependency on something unshimmed fails loudly here.
//
// Markers behave like Premiere's: createMarker(seconds) adds one with a new
// guid, deleteMarker removes it, getFirstMarker/getNextMarker walk them in
// time order, and start/end read as Time objects while accepting a number
// of seconds on assignment.

import { writeFileSync } from "node:fs";

export const TPS = 254016000000;

/** An object shaped like Premiere's collections: numItems / numTracks / numSequences and [i]. */
export function coll<T>(items: T[], countKey: string): Record<string | number, unknown> {
  const c: Record<string | number, unknown> = { [countKey]: items.length };
  items.forEach((item, i) => {
    c[i] = item;
  });
  return c;
}

function toSeconds(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof (v as { seconds?: unknown }).seconds === "number") {
    return (v as { seconds: number }).seconds;
  }
  if (v && typeof v === "object" && typeof (v as { ticks?: unknown }).ticks === "string") {
    return Number((v as { ticks: string }).ticks) / 254016000000;
  }
  throw new Error("bad time");
}

let guidCounter = 0;

export class FakeMarker {
  name = "";
  comments = "";
  type = "Comment";
  guid: string;
  private startS: number;
  private endS: number;
  private color = 0;

  constructor(start: number, guid?: string) {
    this.startS = start;
    this.endS = start;
    this.guid = guid ?? `fake-${++guidCounter}`;
  }
  get start(): { seconds: number } {
    return { seconds: this.startS };
  }
  set start(v: unknown) {
    this.startS = toSeconds(v);
  }
  get end(): { seconds: number } {
    return { seconds: this.endS };
  }
  set end(v: unknown) {
    this.endS = toSeconds(v);
  }
  getColorByIndex(): number {
    return this.color;
  }
  setColorByIndex(i: number): void {
    this.color = i;
  }
}

export class FakeMarkers {
  readonly list: FakeMarker[] = [];
  get numMarkers(): number {
    return this.list.length;
  }
  private sorted(): FakeMarker[] {
    return [...this.list].sort((a, b) => a.start.seconds - b.start.seconds);
  }
  getFirstMarker(): FakeMarker | undefined {
    return this.sorted()[0];
  }
  getNextMarker(m: FakeMarker): FakeMarker | undefined {
    const s = this.sorted();
    return s[s.indexOf(m) + 1];
  }
  createMarker(seconds: number): FakeMarker {
    const m = new FakeMarker(seconds);
    this.list.push(m);
    return m;
  }
  deleteMarker(m: FakeMarker): void {
    const i = this.list.indexOf(m);
    if (i >= 0) this.list.splice(i, 1);
  }
}

let nodeCounter = 0;

/**
 * A project item: clip, bin (type 2) or sequence item. Bins keep a live
 * children collection, so createBin / moveBin / deleteBin show up in the
 * next walk, the way Premiere's do.
 */
export class FakeItem {
  name: string;
  type: number;
  nodeId: string;
  parent: FakeItem | null = null;
  readonly kids: FakeItem[] = [];
  private label: number;
  private media: string | null;
  private offline: boolean;
  private sequence: boolean;

  constructor(
    name: string,
    opts: {
      type?: number;
      nodeId?: string;
      media?: string;
      offline?: boolean;
      label?: number;
      sequence?: boolean;
    } = {},
  ) {
    this.name = name;
    this.type = opts.type ?? 1;
    this.nodeId = opts.nodeId ?? `node-${++nodeCounter}`;
    this.media = opts.media ?? null;
    this.offline = opts.offline ?? false;
    this.label = opts.label ?? 0;
    this.sequence = opts.sequence ?? false;
  }
  get children(): Record<string | number, unknown> {
    return coll(this.kids, "numItems");
  }
  isSequence(): boolean {
    return this.sequence;
  }
  getMediaPath(): string {
    if (this.media === null) throw new Error("no media");
    return this.media;
  }
  /** Premiere's interpretation; stills take the import preference's rate (25 here). */
  frameRate = 25;
  getFootageInterpretation(): { frameRate: number } {
    return { frameRate: this.frameRate };
  }
  /** Source in/out (seconds); null = not set. */
  srcIn: number | null = null;
  srcOut: number | null = null;
  getInPoint(): { seconds: number } {
    return { seconds: this.srcIn ?? 0 };
  }
  getOutPoint(): { seconds: number } {
    return { seconds: this.srcOut ?? 10 };
  }
  setInPoint(seconds: number): void {
    this.srcIn = seconds;
  }
  setOutPoint(seconds: number): void {
    this.srcOut = seconds;
  }
  clearInPoint(): void {
    this.srcIn = null;
  }
  clearOutPoint(): void {
    this.srcOut = null;
  }
  isOffline(): boolean {
    return this.offline;
  }
  getColorLabel(): number {
    return this.label;
  }
  setColorLabel(i: number): void {
    this.label = i;
  }
  add(child: FakeItem): FakeItem {
    child.parent = this;
    this.kids.push(child);
    return child;
  }
  createBin(name: string): FakeItem {
    return this.add(new FakeItem(name, { type: 2 }));
  }
  moveBin(target: FakeItem): void {
    if (this.parent) this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    target.add(this);
  }
  deleteBin(): void {
    if (this.type !== 2) throw new Error("not a bin");
    if (this.parent) this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    this.parent = null;
  }
  /** "Girato/Intervista.mov" - where the item sits now, for assertions. */
  where(): string {
    const parts: string[] = [this.name];
    for (let up = this.parent; up && up.type !== 3; up = up.parent) parts.unshift(up.name);
    return parts.join("/");
  }
}

export function fakeProject(projectPath = String.raw`D:\Prove\Prova.prproj`) {
  const root = new FakeItem("root", { type: 3, nodeId: "n-root" });
  const bin = root.add(new FakeItem("Girato", { type: 2, nodeId: "n-bin" }));
  const clip = bin.add(
    new FakeItem("Intervista.mov", {
      nodeId: "n-clip",
      media: String.raw`D:\Lavori\Cliente Rossi\Intervista.mov`,
      label: 3,
    }),
  );
  bin.add(
    new FakeItem("Drone.mp4", { nodeId: "n-drone", media: "D:/Lavori/Drone.mp4", offline: true }),
  );
  const seqItem = root.add(new FakeItem("Montaggio", { nodeId: "n-seq", sequence: true }));
  const sequence = new FakeSequence("Montaggio", "seq-guid-1", seqItem, 1, 0);
  const first = new FakeTrackItem(sequence.video[0]!, clip, 0, { nodeId: "t-1", inS: 1 });
  first.selected = true;
  sequence.video[0]!.items.push(first);
  const markers = sequence.markers;
  const m1 = new FakeMarker(0, "m1");
  m1.name = "Inizio";
  m1.comments = "attacco";
  m1.setColorByIndex(1);
  const m2 = new FakeMarker(2, "m2");
  m2.name = "Titolo";
  m2.end = 3;
  m2.setColorByIndex(4);
  markers.list.push(m1, m2);
  sequence.mgtRoot = root;
  const sequences: FakeSequence[] = [sequence];
  const cloneSequence = (seq: FakeSequence): FakeSequence => {
    const item = root.add(new FakeItem(seq.name + " Copy", { sequence: true }));
    const copy = new FakeSequence(
      seq.name + " Copy",
      "seq-copy-" + String(++sequenceCounter),
      item,
      seq.video.length,
      seq.audio.length,
    );
    copy.mgtRoot = root;
    copy.cloner = cloneSequence;
    sequences.push(copy);
    return copy;
  };
  sequence.cloner = cloneSequence;
  // Like Premiere 26.3.2: the reframed sequence goes into an "Auto Reframed Sequences" bin.
  const reframe = (seq: FakeSequence, name: string, w: number, h: number): FakeSequence => {
    let bin = root.kids.find((k) => k.name === "Auto Reframed Sequences");
    if (!bin) bin = root.createBin("Auto Reframed Sequences");
    const item = bin.add(new FakeItem(name, { sequence: true }));
    const made = new FakeSequence(
      name,
      "seq-reframe-" + String(++sequenceCounter),
      item,
      seq.video.length,
      seq.audio.length,
    );
    made.frameSizeHorizontal = w;
    made.frameSizeVertical = h;
    made.mgtRoot = root;
    made.cloner = cloneSequence;
    sequences.push(made);
    return made;
  };
  sequence.reframer = reframe;
  return {
    name: "Prova.prproj",
    path: projectPath,
    // Like Premiere: every read hands out a new wrapper, so === never matches
    // two reads of the same item (the agent must compare nodeIds).
    get rootItem(): FakeItem {
      return Object.create(root) as FakeItem;
    },
    get sequences() {
      return coll(sequences, "numSequences");
    },
    activeSequence: sequence as FakeSequence | null,
    saves: 0,
    save(): void {
      this.saves++;
    },
    /** Lays the clips one after the other on V1, linked audio on A1 (3 + 3 tracks). */
    createNewSequenceFromClips(name: string, items: FakeItem[], target: FakeItem): FakeSequence {
      const item = target.add(new FakeItem(name, { sequence: true }));
      const seq = new FakeSequence(name, `seq-new-${++sequenceCounter}`, item, 3, 3);
      let at = 0;
      for (const source of items) {
        seq.video[0]!.overwriteClip(source, at);
        at += FAKE_CLIP_SECONDS;
      }
      seq.mgtRoot = root;
      seq.cloner = cloneSequence;
      seq.reframer = reframe;
      sequences.push(seq);
      return seq;
    },
    imported: [] as string[],
    /** The importAsNumberedStills flag of each importFiles call. */
    importedAsNumbered: [] as boolean[],
    importFiles(paths: string[], _suppress: boolean, target: FakeItem, numbered = false): boolean {
      this.importedAsNumbered.push(numbered);
      for (const p of paths) {
        this.imported.push(p);
        target.add(new FakeItem(p.split(/[\\/]/).pop()!, { media: p }));
      }
      return true;
    },
    importAEComps(_aep: string, names: string[], target: FakeItem): boolean {
      for (const n of names) target.add(new FakeItem(n));
      return true;
    },
    importAllAEComps(_aep: string, target: FakeItem): boolean {
      target.add(new FakeItem("Comp 1"));
      target.add(new FakeItem("Comp 2"));
      return true;
    },
    exportAAF(_seq: FakeSequence, out: string): number {
      writeFileSync(out, "aaf");
      return 1;
    },
    exportOMF(_seq: FakeSequence, out: string): number {
      writeFileSync(out, "omf");
      return 1;
    },
    openSequence(id: string): boolean {
      const found = sequences.find((q) => q.sequenceID === id);
      if (found) this.activeSequence = found;
      return found !== undefined;
    },
    deleteSequence(seq: FakeSequence): void {
      sequences.splice(sequences.indexOf(seq), 1);
      const item = seq.projectItem;
      if (item.parent) item.parent.kids.splice(item.parent.kids.indexOf(item), 1);
    },
    /** For assertions: the first sequence, its markers, the project's items. */
    markers,
    sequence,
    allSequences: sequences,
    items: { root, bin, clip, seqItem },
  };
}

/** Seconds a fake clip lasts when put on a timeline. */
export const FAKE_CLIP_SECONDS = 4;

let trackItemCounter = 0;
let sequenceCounter = 0;

/** A clip on a track: start/end on the timeline, in/out in the source. */
export class FakeTrackItem {
  name: string;
  nodeId: string;
  disabled = false;
  selected = false;
  projectItem: FakeItem;
  track: FakeTrack;
  startS: number;
  endS: number;
  inS: number;
  outS: number;

  constructor(
    track: FakeTrack,
    source: FakeItem,
    start: number,
    opts: { nodeId?: string; inS?: number } = {},
  ) {
    this.track = track;
    this.projectItem = source;
    this.name = source.name;
    this.nodeId = opts.nodeId ?? "ti-" + String(++trackItemCounter);
    this.startS = start;
    this.endS = start + FAKE_CLIP_SECONDS;
    this.inS = opts.inS ?? 0;
    this.outS = this.inS + FAKE_CLIP_SECONDS;
  }
  // Like Premiere 26.3.2: start/end trim the clip on the timeline (the other
  // end stays put) but leave the source alone - a later start shows the
  // source from the same in point, and inPoint / outPoint go stale (seen on
  // 2026-11-15); move(Time) shifts only this item, not its audio.
  get start(): { seconds: number } {
    return { seconds: this.startS };
  }
  set start(v: unknown) {
    this.startS = toSeconds(v);
  }
  get end(): { seconds: number } {
    return { seconds: this.endS };
  }
  set end(v: unknown) {
    this.endS = toSeconds(v);
  }
  get inPoint(): { seconds: number } {
    return { seconds: this.inS };
  }
  set inPoint(v: unknown) {
    this.inS = toSeconds(v);
  }
  get outPoint(): { seconds: number } {
    return { seconds: this.outS };
  }
  set outPoint(v: unknown) {
    this.outS = toSeconds(v);
  }
  isSelected(): boolean {
    return this.selected;
  }
  getSpeed(): number {
    return 1;
  }
  level = 0.17782793939114;
  get components(): Record<string | number, unknown> {
    if (!this.track.name.startsWith("A")) return coll([], "numItems");
    const level = {
      displayName: "Level",
      getValue: () => this.level,
      setValue: (v: number) => {
        this.level = v;
      },
    };
    return coll([{ displayName: "Volume", properties: coll([level], "numItems") }], "numItems");
  }
  move(offset: unknown): void {
    const by = toSeconds(offset);
    this.startS += by;
    this.endS += by;
  }
  /** Premiere's TrackItem.remove(ripple, alignToVideo). */
  remove(ripple: boolean): void {
    this.track.take(this, ripple);
  }
}

/**
 * Premiere's undocumented QE razor for the fake's active sequence: cuts the
 * clip across an "HH:MM:SS:FF" timecode on one track, only that track.
 */
export function fakeQe(project: { activeSequence: FakeSequence | null }, fps = 25) {
  const toSec = (tc: string) => {
    const [h, m, s, f] = tc.split(":").map(Number);
    return h! * 3600 + m! * 60 + s! + f! / fps;
  };
  const cut = (track: FakeTrack, tc: string) => {
    const at = toSec(tc);
    for (const it of track.items.slice()) {
      if (it.startS < at && it.endS > at) {
        const piece = new FakeTrackItem(track, it.projectItem, at, {
          inS: it.inS + (at - it.startS),
        });
        piece.endS = it.endS;
        it.endS = at;
        track.items.push(piece);
      }
    }
  };
  // Like QE: a track's items in time order; addTransition centres it on the cut.
  const qeTrack = (track: FakeTrack) => {
    const sorted = () => [...track.items].sort((a, b) => a.startS - b.startS);
    return {
      razor: (tc: string) => cut(track, tc),
      get numItems() {
        return track.items.length;
      },
      getItemAt: (k: number) => {
        const it = sorted()[k]!;
        return {
          name: it.name,
          type: "Clip",
          addTransition: (tr: { name: string }, atStart: boolean, tc: string) => {
            const d = toSec(tc);
            const at = atStart ? it.startS : it.endS;
            track.transitionList.push({ name: tr.name, startS: at - d / 2, endS: at + d / 2 });
            return true;
          },
        };
      },
    };
  };
  const byName = (name: string) =>
    ["Cross Dissolve", "Dip to Black", "Constant Power"].includes(name) ? { name } : null;
  return {
    project: {
      getVideoTransitionByName: byName,
      getAudioTransitionByName: byName,
      getActiveSequence() {
        const seq = project.activeSequence!;
        return {
          name: seq.name,
          getVideoTrackAt: (i: number) => qeTrack(seq.video[i]!),
          getAudioTrackAt: (i: number) => qeTrack(seq.audio[i]!),
        };
      },
    },
  };
}

export class FakeTrack {
  name: string;
  readonly items: FakeTrackItem[] = [];
  /** The audio track that receives the linked audio of what lands here (video tracks only). */
  linked: FakeTrack | null = null;

  constructor(name: string) {
    this.name = name;
  }
  get clips(): Record<string | number, unknown> {
    return coll(
      [...this.items].sort((a, b) => a.startS - b.startS),
      "numItems",
    );
  }
  muted = false;
  locked = false;
  targeted = false;
  readonly transitionList: Array<{ name: string; startS: number; endS: number }> = [];
  isMuted(): boolean {
    return this.muted;
  }
  isLocked(): boolean {
    return this.locked;
  }
  isTargeted(): boolean {
    return this.targeted;
  }
  setMute(v: number): void {
    this.muted = v === 1;
  }
  setLocked(v: number): void {
    this.locked = v === 1;
  }
  setTargeted(on: boolean): void {
    this.targeted = on;
  }
  get transitions(): Record<string | number, unknown> {
    return coll(
      this.transitionList.map((t) => ({
        name: t.name,
        start: { seconds: t.startS },
        end: { seconds: t.endS },
        remove: () => {
          this.transitionList.splice(this.transitionList.indexOf(t), 1);
        },
      })),
      "numItems",
    );
  }
  private targets(): FakeTrack[] {
    return this.linked ? [this, this.linked] : [this];
  }
  private lay(source: FakeItem, at: number): void {
    for (const t of this.targets()) {
      const item = new FakeTrackItem(t, source, at, { inS: source.srcIn ?? 0 });
      if (source.srcIn !== null || source.srcOut !== null) {
        // Like Premiere 26.3.2 (2026-11-15): placed with an out point, the
        // clip stops one frame before it (the fake runs at 25 fps).
        const len =
          (source.srcOut ?? 10) - (source.srcIn ?? 0) - (source.srcOut !== null ? 0.04 : 0);
        item.endS = at + len;
        item.outS = item.inS + len;
      }
      t.items.push(item);
    }
  }
  insertClip(source: FakeItem, time: unknown): void {
    const at = toSeconds(time);
    for (const t of this.targets()) {
      // Like Premiere: a clip the insert point falls inside is cut in two,
      // and the second piece is a new track item.
      for (const it of t.items.slice()) {
        if (it.startS < at && it.endS > at) {
          const piece = new FakeTrackItem(t, it.projectItem, at, {
            inS: it.inS + (at - it.startS),
          });
          piece.endS = it.endS;
          it.endS = at;
          t.items.push(piece);
        }
      }
      for (const it of t.items) {
        if (it.startS >= at) {
          it.startS += FAKE_CLIP_SECONDS;
          it.endS += FAKE_CLIP_SECONDS;
        }
      }
    }
    this.lay(source, at);
  }
  overwriteClip(source: FakeItem, time: unknown): void {
    const at = toSeconds(time);
    for (const t of this.targets()) {
      // Whatever lies under the new clip is gone (enough for these tests).
      for (const it of t.items.slice()) {
        if (it.startS < at + FAKE_CLIP_SECONDS && it.endS > at)
          t.items.splice(t.items.indexOf(it), 1);
      }
    }
    this.lay(source, at);
  }
  take(item: FakeTrackItem, ripple: boolean): void {
    const i = this.items.indexOf(item);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (!ripple) return;
    const len = item.endS - item.startS;
    for (const it of this.items) {
      if (it.startS >= item.endS) {
        it.startS -= len;
        it.endS -= len;
      }
    }
  }
}

export class FakeSequence {
  name: string;
  sequenceID: string;
  frameSizeHorizontal = 1920;
  frameSizeVertical = 1080;
  timebase = String(TPS / 25);
  readonly video: FakeTrack[];
  readonly audio: FakeTrack[];
  readonly markers = new FakeMarkers();
  /** The project root, for importMGT (set by fakeProject). */
  mgtRoot: FakeItem | null = null;
  /** Set by fakeProject: how this sequence is cloned. */
  cloner: ((seq: FakeSequence) => FakeSequence) | null = null;
  clone(): boolean {
    this.cloner!(this);
    return true;
  }
  /** Captions added by createCaptionTrack: their source item names. */
  readonly captions: string[] = [];
  /** Set by fakeProject: how Auto Reframe makes its sequence. */
  reframer: ((seq: FakeSequence, name: string, w: number, h: number) => FakeSequence) | null = null;
  exportAsFinalCutProXML(out: string): boolean {
    writeFileSync(out, "<xmeml/>");
    return true;
  }
  autoReframeSequence(num: number, den: number, _motion: string, name: string): FakeSequence {
    return this.reframer!(this, name, Math.round((1080 * num) / den), 1080);
  }
  createCaptionTrack(item: FakeItem): boolean {
    this.captions.push(item.name);
    return true;
  }

  /**
   * Like Premiere 26.3.2: lays a "Graphic" clip on video track v (0-based)
   * and adds the template's media to a "Motion Graphics Template Media" bin.
   * A path containing "AE" stands for an After Effects-made template, whose
   * text parameter "Titolo" is reachable through getMGTComponent().
   */
  importMGT(file: string, ticks: string, v: number): FakeTrackItem {
    const root = this.mgtRoot!;
    let bin = root.kids.find((k) => k.name === "Motion Graphics Template Media");
    if (!bin) bin = root.createBin("Motion Graphics Template Media");
    bin.add(new FakeItem("Logo_Dummy.png", { media: "C:/x/Logo_Dummy.png" }));
    const source = new FakeItem("Graphic");
    const at = Number(ticks) / TPS;
    const item = new FakeTrackItem(this.video[v]!, source, at);
    this.video[v]!.items.push(item);
    const aeMade = file.includes("AE");
    let value = JSON.stringify({ textEditValue: "Testo", fontSize: 80 });
    (item as unknown as { getMGTComponent: () => unknown }).getMGTComponent = () =>
      aeMade
        ? {
            properties: coll(
              [
                {
                  displayName: "Titolo",
                  getValue: () => value,
                  setValue: (x: string) => {
                    value = x;
                  },
                },
              ],
              "numItems",
            ),
          }
        : null;
    (item as unknown as { mgtValue: () => string }).mgtValue = () => value;
    return item;
  }
  projectItem: FakeItem;

  constructor(name: string, id: string, item: FakeItem, videoTracks: number, audioTracks: number) {
    this.name = name;
    this.sequenceID = id;
    this.projectItem = item;
    this.video = Array.from({ length: videoTracks }, (_, i) => new FakeTrack("V" + String(i + 1)));
    this.audio = Array.from({ length: audioTracks }, (_, i) => new FakeTrack("A" + String(i + 1)));
    this.video.forEach((t, i) => {
      t.linked = this.audio[i] ?? null;
    });
  }
  get videoTracks(): Record<string | number, unknown> {
    return coll(this.video, "numTracks");
  }
  get audioTracks(): Record<string | number, unknown> {
    return coll(this.audio, "numTracks");
  }
  get end(): string {
    let end = 10;
    for (const t of [...this.video, ...this.audio])
      for (const it of t.items) end = Math.max(end, it.endS);
    return String(end * TPS);
  }
  getPlayerPosition(): { seconds: number } {
    return { seconds: 2.5 };
  }
  /** In/out points as tick strings, like Premiere's Time.ticks. */
  inTicks = "0";
  outTicks = String(10 * TPS);
  /** What exportAsMediaDirect was asked, for assertions. */
  readonly exports: Array<{
    out: string;
    preset: string;
    range: number;
    inS: number;
    outS: number;
  }> = [];

  getInPointAsTime(): { seconds: number; ticks: string } {
    return { seconds: Number(this.inTicks) / TPS, ticks: this.inTicks };
  }
  getOutPointAsTime(): { seconds: number; ticks: string } {
    return { seconds: Number(this.outTicks) / TPS, ticks: this.outTicks };
  }
  setInPoint(ticks: string): void {
    this.inTicks = String(ticks);
  }
  setOutPoint(ticks: string): void {
    this.outTicks = String(ticks);
  }
  /**
   * Like Premiere 26.3.2: answers "No Error" and writes the file; a PNG
   * preset writes an image sequence, so the frame lands in "<name>0.png".
   */
  exportAsMediaDirect(out: string, preset: string, range: number): string {
    this.exports.push({
      out,
      preset,
      range,
      inS: Number(this.inTicks) / TPS,
      outS: Number(this.outTicks) / TPS,
    });
    const target = /\.png$/i.test(out) ? out.replace(/\.png$/i, "0.png") : out;
    writeFileSync(target, /\.png$/i.test(out) ? FAKE_PNG : "video");
    return "No Error";
  }
}

/** A 1x1 PNG, enough to stand for an exported frame. */
const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
