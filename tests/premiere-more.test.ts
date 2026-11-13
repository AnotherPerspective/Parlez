// The Premiere actions added after the first montage test: import (files and
// After Effects comps), a piece of a clip, duplicate/open a sequence, track
// switches, transitions, clip volume. End to end without Premiere, same
// setup as premiere-clips.test.ts; each behaviour mirrors what Premiere
// 26.3.2 did when probed on 13/11/2026.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PREMIERE_AGENT_JSX } from "../src/premiere/config.js";
import { prUndoLastTool } from "../src/premiere/edit-tools.js";
import {
  prAudioLevelTool,
  prImportTool,
  prSequenceDuplicateTool,
  prSequenceOpenTool,
  prTracksTool,
  prTransitionTool,
} from "../src/premiere/more-tools.js";
import { prSequenceCreateTool, prTimelineAddTool } from "../src/premiere/timeline-tools.js";
import { PremiereTransport } from "../src/premiere/transport.js";
import type { ToolResult } from "../src/tools/types.js";
import { type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";
import { type FakeSequence, fakeProject, fakeQe } from "./helpers/premiere-fake.js";

let tmp: string;
let project: ReturnType<typeof fakeProject>;
let engine: EsEngine;
let transport: PremiereTransport;
let seq: FakeSequence;
let agent: { tick: (on: boolean, ro: boolean) => string };

const g = globalThis as Record<string, unknown>;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-premiere-more-"));
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
  const res = await run(() =>
    prSequenceCreateTool.handler({ name: "Bozza", clips: ["n-clip", "n-drone"] }, transport),
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

const names = () => project.items.root.kids.map((k) => k.name);
const v1 = () =>
  seq.video[0]!.items.map((i) => [i.name, i.startS, i.endS] as const).toSorted(
    (a, b) => a[1] - b[1],
  );
const id = (start: number) => seq.video[0]!.items.find((i) => i.startS === start)!.nodeId;

describe("pr_import", () => {
  it("imports files into a new bin; undo removes the bin and what it imported", async () => {
    const a = path.join(tmp, "a.mov");
    const b = path.join(tmp, "b.wav");
    writeFileSync(a, "x");
    writeFileSync(b, "x");
    const res = await run(() =>
      prImportTool.handler({ files: [a, b], bin: "Girato/Audio" }, transport),
    );
    const r = result(res);
    expect(r.count).toBe(3);
    expect(
      (r.imported as Array<{ name: string; bin: string }>).map((i) => [i.name, i.bin]),
    ).toEqual([
      ["Audio", "Girato"],
      ["a.mov", "Girato/Audio"],
      ["b.wav", "Girato/Audio"],
    ]);
    await run(() => prUndoLastTool.handler({}, transport));
    const girato = project.items.root.kids.find((k) => k.name === "Girato")!;
    expect(girato.kids.map((k) => k.name)).toEqual(["Intervista.mov", "Drone.mp4"]);
  });

  it("imports After Effects comps by name, or all of them", async () => {
    const aep = path.join(tmp, "Titoli.aep");
    writeFileSync(aep, "x");
    const some = await run(() =>
      prImportTool.handler({ aeProject: aep, aeComps: ["Titolo"] }, transport),
    );
    expect((result(some).imported as Array<{ name: string }>).map((i) => i.name)).toEqual([
      "Titolo",
    ]);
    const all = await run(() => prImportTool.handler({ aeProject: aep }, transport));
    expect(result(all).count).toBe(2);
  });

  it("refuses a missing file and a project that is not .aep, before contacting Premiere", async () => {
    const missing = await prImportTool.handler({ files: [path.join(tmp, "nope.mov")] }, transport);
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe("IO");
    const notAep = path.join(tmp, "x.prproj");
    writeFileSync(notAep, "x");
    const wrong = await prImportTool.handler({ aeProject: notAep }, transport);
    expect(wrong.isError).toBe(true);
    expect(names()).toEqual(["Girato", "Montaggio", "Bozza"]);
  });
});

describe("a piece of a clip", () => {
  it("pr_timeline_add with sourceIn/sourceOut places only that piece and leaves the source as it was", async () => {
    const res = await run(() =>
      prTimelineAddTool.handler(
        { sequence: "Bozza", clips: [{ nodeId: "n-clip", sourceIn: 1, sourceOut: 2.5 }] },
        transport,
      ),
    );
    const placed = (
      result(res).placed as Array<{ kind: string; start: number; end: number }>
    ).filter((p) => p.kind === "video");
    expect(placed).toMatchObject([{ start: 8, end: 9.5 }]);
    expect([project.items.clip.srcIn, project.items.clip.srcOut]).toEqual([null, null]);
  });
});

describe("sequences", () => {
  it("pr_sequence_duplicate names the copy; undo removes it", async () => {
    const res = await run(() =>
      prSequenceDuplicateTool.handler({ sequence: "Bozza", name: "Bozza v2" }, transport),
    );
    expect((result(res).copy as { name: string }).name).toBe("Bozza v2");
    expect(project.allSequences.map((q) => q.name)).toContain("Bozza v2");
    await run(() => prUndoLastTool.handler({}, transport));
    expect(project.allSequences.map((q) => q.name)).not.toContain("Bozza v2");
  });

  it("pr_sequence_open makes a sequence the active one", async () => {
    const res = await run(() => prSequenceOpenTool.handler({ sequence: "Montaggio" }, transport));
    expect(result(res)).toEqual({ active: "Montaggio" });
  });
});

describe("pr_tracks", () => {
  it("mutes and locks; undo puts them back; a missing track refuses the whole request", async () => {
    const res = await run(() =>
      prTracksTool.handler(
        {
          sequence: "Bozza",
          tracks: [
            { kind: "audio", index: 1, muted: true },
            { kind: "video", index: 2, locked: true },
          ],
        },
        transport,
      ),
    );
    expect(result(res).changed).toEqual([
      { track: "A1", muted: true },
      { track: "V2", locked: true },
    ]);
    await run(() => prUndoLastTool.handler({}, transport));
    expect([seq.audio[0]!.muted, seq.video[1]!.locked]).toEqual([false, false]);
    const bad = await run(() =>
      prTracksTool.handler(
        { sequence: "Bozza", tracks: [{ kind: "video", index: 9, muted: true }] },
        transport,
      ),
    );
    expect(bad.isError).toBe(true);
  });
});

describe("pr_transition", () => {
  it("adds a cross dissolve at a cut and undo removes it; an unknown transition is reported", async () => {
    const res = await run(() =>
      prTransitionTool.handler(
        {
          sequence: "Bozza",
          items: [{ nodeId: id(4) }, { nodeId: id(0), name: "Spirale magica" }],
        },
        transport,
      ),
    );
    const r = result(res);
    expect(r.added).toMatchObject([{ track: "V1", transition: "Cross Dissolve", start: 3.5 }]);
    expect(String((r.problems as string[])[0])).toContain("Spirale magica");
    expect(seq.video[0]!.transitionList).toHaveLength(1);
    await run(() => prUndoLastTool.handler({}, transport));
    expect(seq.video[0]!.transitionList).toHaveLength(0);
  });
});

describe("pr_audio_level", () => {
  it("sets the level in dB on the audio of a video clip; undo puts the old level back", async () => {
    const res = await run(() =>
      prAudioLevelTool.handler(
        { sequence: "Bozza", clips: [{ nodeId: id(0), db: -6 }] },
        transport,
      ),
    );
    expect(result(res).changed).toMatchObject([{ fromDb: 0, db: -6 }]);
    const audio = seq.audio[0]!.items.find((i) => i.startS === 0)!;
    expect(audio.level).toBeCloseTo(Math.pow(10, -21 / 20), 6);
    await run(() => prUndoLastTool.handler({}, transport));
    expect(audio.level).toBeCloseTo(0.17782793939114, 9);
    expect(v1()).toHaveLength(2);
  });
});
