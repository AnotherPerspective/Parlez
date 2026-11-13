// Trimming, moving, switching off, removing and cutting clips on a Premiere
// timeline, end to end without Premiere (same setup as premiere-edit.test.ts).
// The fake behaves the way Premiere 26.3.2 did when probed: start/end trim on
// the timeline, move() shifts only the item it is called on, the QE razor
// cuts one track at a time.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prProjectCheckTool } from "../src/premiere/check-tools.js";
import { prClipEditTool, prClipRemoveTool, prRazorTool } from "../src/premiere/clip-tools.js";
import { PREMIERE_AGENT_JSX } from "../src/premiere/config.js";
import { prUndoLastTool } from "../src/premiere/edit-tools.js";
import { prSequenceCreateTool } from "../src/premiere/timeline-tools.js";
import { prMogrtAddTool } from "../src/premiere/title-tools.js";
import { prExportTool, prFrameTool } from "../src/premiere/export-tools.js";
import { PremiereTransport } from "../src/premiere/transport.js";
import type { ToolResult } from "../src/tools/types.js";
import { type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";
import { FakeItem, type FakeSequence, fakeProject, fakeQe } from "./helpers/premiere-fake.js";

let tmp: string;
let project: ReturnType<typeof fakeProject>;
let engine: EsEngine;
let transport: PremiereTransport;
let seq: FakeSequence;
let agent: { tick: (on: boolean, ro: boolean) => string };

const g = globalThis as Record<string, unknown>;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-premiere-clips-"));
  const mailbox = path.join(tmp, "runtime").replace(/\\/g, "/");
  const projectFile = path.join(tmp, "progetti", "Prova.prproj");
  mkdirSync(path.dirname(projectFile), { recursive: true });
  writeFileSync(projectFile, "<project/>", "utf8");
  engine = makeEngine(tmp);
  const app = engine.app as unknown as Record<string, unknown>;
  for (const key of [
    "settings",
    "beginUndoGroup",
    "endUndoGroup",
    "beginSuppressDialogs",
    "endSuppressDialogs",
  ]) {
    delete app[key];
  }
  app.version = "26.3.2";
  app.enableQE = () => undefined;
  project = fakeProject(projectFile);
  app.project = project;
  g.qe = fakeQe(project);
  transport = new PremiereTransport({
    instancesDir: path.join(mailbox, "premiere"),
    instance: null,
  });
  engine.global.PARLEZ_PR_MAILBOX = mailbox;
  engine.run(
    `${loadJsx(PREMIERE_AGENT_JSX, ["serve.jsx", "premiere-helpers.jsx"])}\n;globalThis.PR = PR;`,
  );
  agent = engine.global.PARLEZ_PR as { tick: (on: boolean, ro: boolean) => string };
  // A sequence with three clips, each with its audio on A1: 0-4, 4-8, 8-12.
  const res = await run(() =>
    prSequenceCreateTool.handler(
      { name: "Bozza", clips: ["n-clip", "n-drone", "n-clip"] },
      transport,
    ),
  );
  expect(res.isError).toBe(false);
  seq = project.allSequences.at(-1)!;
  project.activeSequence = seq;
});

afterEach(() => {
  delete g.PR;
  delete g.qe;
  rmSync(tmp, { recursive: true, force: true });
});

async function run<T>(call: () => Promise<T>): Promise<T> {
  agent.tick(true, false);
  const timer = setInterval(() => agent.tick(true, false), 20);
  try {
    return await call();
  } finally {
    clearInterval(timer);
  }
}

function result(res: ToolResult): Record<string, unknown> {
  expect(res.isError, JSON.stringify(res.structuredContent ?? res)).toBe(false);
  return (res.structuredContent as { result: Record<string, unknown> }).result;
}

const v1 = () =>
  seq.video[0]!.items.map((i) => [i.name, i.startS, i.endS, i.disabled] as const).toSorted(
    (a, b) => a[1] - b[1],
  );
const a1 = () =>
  seq.audio[0]!.items.map((i) => [i.name, i.startS, i.endS] as const).toSorted(
    (a, b) => a[1] - b[1],
  );
const id = (start: number) => seq.video[0]!.items.find((i) => i.startS === start)!.nodeId;

describe("pr_clip_edit", () => {
  it("trims, moves and switches off; the audio follows; undo puts everything back", async () => {
    const res = await run(() =>
      prClipEditTool.handler(
        {
          sequence: "Bozza",
          clips: [
            { nodeId: id(4), end: 7 },
            { nodeId: id(8), moveTo: 20 },
            { nodeId: id(0), enabled: false },
          ],
        },
        transport,
      ),
    );
    expect(
      (result(res).changed as Array<{ audioMovedWith: number }>).map((c) => c.audioMovedWith),
    ).toEqual([1, 1, 1]);
    expect(v1()).toEqual([
      ["Intervista.mov", 0, 4, true],
      ["Drone.mp4", 4, 7, false],
      ["Intervista.mov", 20, 24, false],
    ]);
    expect(a1()).toEqual([
      ["Intervista.mov", 0, 4],
      ["Drone.mp4", 4, 7],
      ["Intervista.mov", 20, 24],
    ]);
    await run(() => prUndoLastTool.handler({}, transport));
    expect(v1()).toEqual([
      ["Intervista.mov", 0, 4, false],
      ["Drone.mp4", 4, 8, false],
      ["Intervista.mov", 8, 12, false],
    ]);
    expect(a1().map((x) => [x[1], x[2]])).toEqual([
      [0, 4],
      [4, 8],
      [8, 12],
    ]);
  });

  it("refuses a move across or onto another clip, confirm or not (Premiere 26.3.2 breaks the track)", async () => {
    for (const moveTo of [2, 20]) {
      const res = await run(() =>
        prClipEditTool.handler(
          { sequence: "Bozza", clips: [{ nodeId: id(0), moveTo }] },
          transport,
        ),
      );
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.structuredContent)).toContain("pr_timeline_add");
    }
    expect(v1().map((x) => x[1])).toEqual([0, 4, 8]);
  });

  it("refuses a clip that would end before it starts", async () => {
    const res = await run(() =>
      prClipEditTool.handler(
        { sequence: "Bozza", clips: [{ nodeId: id(4), start: 7, end: 6 }] },
        transport,
      ),
    );
    expect(res.isError).toBe(true);
    expect(v1().map((x) => [x[1], x[2]])[1]).toEqual([4, 8]);
  });
});

describe("pr_clip_remove", () => {
  it("needs confirm: true", async () => {
    const res = await run(() =>
      prClipRemoveTool.handler({ sequence: "Bozza", clips: [id(4)] }, transport),
    );
    expect(res.isError).toBe(true);
    expect(v1()).toHaveLength(3);
  });

  it("removes the clip and its audio; ripple closes the gap; it says undo cannot bring it back", async () => {
    const res = await run(() =>
      prClipRemoveTool.handler(
        { sequence: "Bozza", clips: [id(4), "nope"], ripple: true, confirm: true },
        transport,
      ),
    );
    const r = result(res);
    expect((r.removed as Array<{ kind: string }>).map((x) => x.kind)).toEqual(["video", "audio"]);
    expect(r.missing).toEqual(["nope"]);
    expect(String(r.undo)).toContain("punto di ritorno");
    expect(v1().map((x) => [x[0], x[1]])).toEqual([
      ["Intervista.mov", 0],
      ["Intervista.mov", 4],
    ]);
    expect(a1().map((x) => x[1])).toEqual([0, 4]);
  });
});

describe("pr_razor", () => {
  it("needs confirm: true", async () => {
    const res = await run(() => prRazorTool.handler({ time: 2 }, transport));
    expect(res.isError).toBe(true);
    expect(v1()).toHaveLength(3);
  });

  it("works only on the active sequence", async () => {
    const res = await run(() =>
      prRazorTool.handler({ time: 2, sequence: "Montaggio", confirm: true }, transport),
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("sequenza attiva");
  });

  it("cuts video and audio together where a clip crosses the time", async () => {
    const res = await run(() => prRazorTool.handler({ time: 2, confirm: true }, transport));
    const r = result(res);
    expect(r).toMatchObject({ timecode: "00:00:02:00", tracksCut: ["V1", "A1"], newPieces: 2 });
    expect(v1().map((x) => [x[1], x[2]])).toEqual([
      [0, 2],
      [2, 4],
      [4, 8],
      [8, 12],
    ]);
    expect(a1()).toHaveLength(4);
  });
});

describe("pr_project_check", () => {
  it("finds offline media, gaps and clips switched off, changing nothing", async () => {
    await run(() =>
      prClipEditTool.handler(
        {
          sequence: "Bozza",
          clips: [
            { nodeId: id(8), moveTo: 15 },
            { nodeId: id(0), enabled: false },
          ],
        },
        transport,
      ),
    );
    const before = JSON.stringify(v1());
    const res = await run(() => prProjectCheckTool.handler({ sequence: "Bozza" }, transport));
    const r = result(res);
    expect(r.offline).toEqual([{ name: "Drone.mp4", bin: "Girato", nodeId: "n-drone" }]);
    expect(r.unused).toEqual([]);
    const tl = (r.timelines as Array<{ gaps: unknown[]; switchedOff: unknown[] }>)[0]!;
    expect(tl.gaps).toEqual([{ track: "V1", from: 8, to: 15, seconds: 7 }]);
    expect(tl.switchedOff).toHaveLength(1);
    expect(JSON.stringify(v1())).toBe(before);
  });
});

describe("pr_mogrt_add", () => {
  function template(name: string): string {
    const file = path.join(tmp, name);
    writeFileSync(file, "mogrt", "utf8");
    return file;
  }

  it("places a Premiere-made title, says its text cannot be set, and undo removes it and its media", async () => {
    const res = await run(() =>
      prMogrtAddTool.handler(
        {
          sequence: "Bozza",
          file: template("Titolo.mogrt"),
          time: 2,
          track: 2,
          texts: { Titolo: "Ciao" },
        },
        transport,
      ),
    );
    const r = result(res);
    expect((r.placed as Array<{ track: number; start: number }>)[0]).toMatchObject({
      track: 2,
      start: 2,
    });
    expect(r.projectItemsAdded).toBe(2);
    expect(r.editableParams).toEqual([]);
    expect((r.texts as { missing: string[]; note: string }).note).toContain("Grafica essenziale");
    expect(project.items.root.kids.map((k) => k.name)).toContain("Motion Graphics Template Media");

    await run(() => prUndoLastTool.handler({}, transport));
    expect(seq.video[1]!.items).toHaveLength(0);
    expect(project.items.root.kids.map((k) => k.name)).not.toContain(
      "Motion Graphics Template Media",
    );
    expect(project.items.root.kids.map((k) => k.name)).not.toContain("Parlez - da togliere");
  });

  it("sets the text of an After Effects-made template inside its JSON value", async () => {
    const res = await run(() =>
      prMogrtAddTool.handler(
        {
          sequence: "Bozza",
          file: template("AE titolo.mogrt"),
          time: 1,
          texts: { Titolo: "Benvenuti", Altro: "x" },
        },
        transport,
      ),
    );
    const r = result(res);
    expect(r.editableParams).toEqual(["Titolo"]);
    expect(r.texts).toMatchObject({ set: ["Titolo"], missing: ["Altro"], note: null });
    const placed = seq.video[1]!.items[0] as unknown as { mgtValue: () => string };
    expect(JSON.parse(placed.mgtValue())).toEqual({ textEditValue: "Benvenuti", fontSize: 80 });
  });

  it("only deletes media it added: a template bin that holds the user's things stays", async () => {
    await run(() =>
      prMogrtAddTool.handler(
        { sequence: "Bozza", file: template("Uno.mogrt"), time: 1 },
        transport,
      ),
    );
    const bin = project.items.root.kids.find((k) => k.name === "Motion Graphics Template Media")!;
    bin.add(new FakeItem("Mio logo.png"));
    await run(() =>
      prMogrtAddTool.handler(
        { sequence: "Bozza", file: template("Due.mogrt"), time: 6 },
        transport,
      ),
    );
    await run(() => prUndoLastTool.handler({}, transport));
    expect(bin.kids.map((k) => k.name)).toEqual(["Logo_Dummy.png", "Mio logo.png"]);
  });

  it("refuses a file that is not a .mogrt, or that does not exist, before contacting Premiere", async () => {
    const wrong = await prMogrtAddTool.handler({ file: template("x.mov"), time: 1 }, transport);
    expect(wrong.isError).toBe(true);
    const missing = await prMogrtAddTool.handler(
      { file: path.join(tmp, "nope.mogrt"), time: 1 },
      transport,
    );
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe("IO");
  });
});

describe("pr_frame and pr_export", () => {
  it("pr_frame renders one frame, shows it, and puts the in/out points back", async () => {
    seq.inTicks = "123";
    seq.outTicks = "456";
    const res = await run(() => prFrameTool.handler({ time: 2, sequence: "Bozza" }, transport));
    expect(res.isError, JSON.stringify(res.structuredContent)).toBe(false);
    expect(res.content.map((c) => c.type)).toEqual(["text", "image"]);
    const asked = seq.exports.at(-1)!;
    expect(asked.range).toBe(1);
    expect(asked.inS).toBe(2);
    expect(asked.out).toMatch(/fotogramma-[0-9a-f]{8}\.png$/);
    expect([seq.inTicks, seq.outTicks]).toEqual(["123", "456"]);
  });

  it("pr_export writes the file, and will not overwrite it without confirm", async () => {
    const preset = path.join(tmp, "H264.epr");
    writeFileSync(preset, "<preset/>", "utf8");
    const out = path.join(tmp, "uscite", "Bozza.mp4");
    const first = await run(() =>
      prExportTool.handler({ outPath: out, preset, sequence: "Bozza", range: "inout" }, transport),
    );
    expect(first.isError, JSON.stringify(first.structuredContent)).toBe(false);
    expect(seq.exports.at(-1)!.range).toBe(1);
    const again = await run(() =>
      prExportTool.handler({ outPath: out, preset, sequence: "Bozza" }, transport),
    );
    expect(JSON.stringify(again.structuredContent)).toContain("confirm: true");
    const forced = await run(() =>
      prExportTool.handler({ outPath: out, preset, sequence: "Bozza", confirm: true }, transport),
    );
    expect((forced.structuredContent as { overwritten: boolean }).overwritten).toBe(true);
  });

  it("pr_export refuses a missing preset before contacting Premiere", async () => {
    const res = await prExportTool.handler(
      { outPath: path.join(tmp, "x.mp4"), preset: path.join(tmp, "nope.epr") },
      transport,
    );
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("IO");
  });
});
