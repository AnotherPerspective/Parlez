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

export function fakeProject(projectPath = "D:\\Prove\\Prova.prproj") {
  const clip = {
    name: "Intervista.mov",
    type: 1,
    nodeId: "n-clip",
    isSequence: () => false,
    getMediaPath: () => "D:\\Lavori\\Cliente Rossi\\Intervista.mov",
    isOffline: () => false,
    getColorLabel: () => 3,
  };
  const offline = {
    name: "Drone.mp4",
    type: 1,
    nodeId: "n-drone",
    isSequence: () => false,
    getMediaPath: () => "D:/Lavori/Drone.mp4",
    isOffline: () => true,
    getColorLabel: () => 0,
  };
  const bin = {
    name: "Girato",
    type: 2,
    nodeId: "n-bin",
    isSequence: () => false,
    children: coll([clip, offline], "numItems"),
  };
  const seqItem = { name: "Montaggio", type: 1, nodeId: "n-seq", isSequence: () => true };
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
    rootItem: { children: coll([bin, seqItem], "numItems") },
    sequences: coll([sequence], "numSequences"),
    activeSequence: sequence,
    /** For assertions: the sequence's markers. */
    markers,
  };
}
