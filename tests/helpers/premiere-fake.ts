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
  const trackItem = {
    name: "Intervista.mov",
    start: { seconds: 0 },
    end: { seconds: 4 },
    inPoint: { seconds: 1 },
    outPoint: { seconds: 5 },
    nodeId: "t-1",
    disabled: false,
    isSelected: () => true,
    getSpeed: () => 1,
    projectItem: clip,
  };
  const markers = new FakeMarkers();
  const m1 = new FakeMarker(0, "m1");
  m1.name = "Inizio";
  m1.comments = "attacco";
  m1.setColorByIndex(1);
  const m2 = new FakeMarker(2, "m2");
  m2.name = "Titolo";
  m2.end = 3;
  m2.setColorByIndex(4);
  markers.list.push(m1, m2);
  const sequence = {
    name: "Montaggio",
    sequenceID: "seq-guid-1",
    frameSizeHorizontal: 1920,
    frameSizeVertical: 1080,
    timebase: String(TPS / 25),
    end: String(10 * TPS),
    videoTracks: coll(
      [
        {
          name: "V1",
          isMuted: () => false,
          isLocked: () => false,
          clips: coll([trackItem], "numItems"),
        },
      ],
      "numTracks",
    ),
    audioTracks: coll([], "numTracks"),
    markers,
    getPlayerPosition: () => ({ seconds: 2.5 }),
    getInPointAsTime: () => ({ seconds: 0 }),
    getOutPointAsTime: () => ({ seconds: 10 }),
    projectItem: seqItem,
  };
  return {
    name: "Prova.prproj",
    path: projectPath,
    rootItem: root,
    sequences: coll([sequence], "numSequences"),
    activeSequence: sequence,
    /** For assertions: the sequence's markers and the project's items. */
    markers,
    items: { root, bin, clip, seqItem },
  };
}
