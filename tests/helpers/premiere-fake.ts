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
  const sequences: FakeSequence[] = [sequence];
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
    /** Lays the clips one after the other on V1, linked audio on A1 (3 + 3 tracks). */
    createNewSequenceFromClips(name: string, items: FakeItem[], target: FakeItem): FakeSequence {
      const item = target.add(new FakeItem(name, { sequence: true }));
      const seq = new FakeSequence(name, `seq-new-${++sequenceCounter}`, item, 3, 3);
      let at = 0;
      for (const source of items) {
        seq.video[0]!.overwriteClip(source, at);
        at += FAKE_CLIP_SECONDS;
      }
      sequences.push(seq);
      return seq;
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
  get start(): { seconds: number } {
    return { seconds: this.startS };
  }
  get end(): { seconds: number } {
    return { seconds: this.endS };
  }
  get inPoint(): { seconds: number } {
    return { seconds: this.inS };
  }
  get outPoint(): { seconds: number } {
    return { seconds: this.outS };
  }
  isSelected(): boolean {
    return this.selected;
  }
  getSpeed(): number {
    return 1;
  }
  /** Premiere's TrackItem.remove(ripple, alignToVideo). */
  remove(ripple: boolean): void {
    this.track.take(this, ripple);
  }
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
  isMuted(): boolean {
    return false;
  }
  isLocked(): boolean {
    return false;
  }
  private targets(): FakeTrack[] {
    return this.linked ? [this, this.linked] : [this];
  }
  private lay(source: FakeItem, at: number): void {
    for (const t of this.targets()) t.items.push(new FakeTrackItem(t, source, at));
  }
  insertClip(source: FakeItem, time: unknown): void {
    const at = toSeconds(time);
    for (const t of this.targets()) {
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
  getInPointAsTime(): { seconds: number } {
    return { seconds: 0 };
  }
  getOutPointAsTime(): { seconds: number } {
    return { seconds: 10 };
  }
}
