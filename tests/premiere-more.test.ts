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
  prMediaRefreshTool,
  prMediaReleaseTool,
  prSequenceDuplicateTool,
  prSequenceOpenTool,
  prTracksTool,
  prTransitionTool,
} from "../src/premiere/more-tools.js";
import {
  prAutoReframeTool,
  prCaptionsTool,
  prExportInterchangeTool,
} from "../src/premiere/deliver-tools.js";
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

  it("a numbered image series (After Effects PNG render) as one clip, with its duration in timecode", async () => {
    const dir = path.join(tmp, "render");
    mkdirSync(dir, { recursive: true });
    for (let n = 0; n < 60; n++)
      writeFileSync(path.join(dir, `Clip B_${String(n).padStart(4, "0")}.png`), "x");
    // After the gap: not part of the series.
    writeFileSync(path.join(dir, "Clip B_0061.png"), "x");
    writeFileSync(path.join(dir, "Clip A_0000.png"), "x");
    const first = path.join(dir, "Clip B_0000.png");
    const res = await run(() =>
      prImportTool.handler({ files: [first], numberedStills: true }, transport),
    );
    const r = result(res);
    expect(project.importedAsNumbered.at(-1)).toBe(true);
    expect(r.imported).toEqual([
      expect.objectContaining({
        name: "Clip B_0000.png",
        frames: 60,
        frameRate: 25,
        durationTC: "00:00:02:10",
        durationSeconds: 2.4,
      }),
    ]);
    // Without the flag: plain files, as before.
    await run(() => prImportTool.handler({ files: [first] }, transport));
    expect(project.importedAsNumbered.at(-1)).toBe(false);
  });

  it("numberedStills needs the first image of a series, not a folder or a name without a number", async () => {
    const dir = path.join(tmp, "render");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "logo.png"), "x");
    for (const f of [dir, path.join(dir, "logo.png")]) {
      const res = await prImportTool.handler({ files: [f], numberedStills: true }, transport);
      expect((res.structuredContent as { error: { code: string } }).error.code).toBe(
        "INVALID_ARGS",
      );
    }
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
    // On the 25 fps grid of the fake: 2.5 s is half a frame, rounded to 2.52.
    expect(placed).toMatchObject([{ start: 8, end: 9.52 }]);
    expect([project.items.clip.srcIn, project.items.clip.srcOut]).toEqual([null, null]);
  });
});

describe("a piece of a clip: the out frame is in (Premiere 26.3.2, 2026-11-15)", () => {
  it("sourceIn 0, sourceOut 2 at 25 fps places exactly 50 frames, not 49", async () => {
    const res = await run(() =>
      prTimelineAddTool.handler(
        { sequence: "Bozza", clips: [{ nodeId: "n-clip", sourceIn: 0, sourceOut: 2 }] },
        transport,
      ),
    );
    const placed = (
      result(res).placed as Array<{ kind: string; start: number; end: number }>
    ).filter((p) => p.kind === "video");
    expect(placed).toHaveLength(1);
    expect(Math.round((placed[0].end - placed[0].start) * 25)).toBe(50);
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

describe("pr_export_interchange", () => {
  it("writes XML, AAF and OMF, adding the extension; will not overwrite without confirm", async () => {
    for (const format of ["xml", "aaf", "omf"] as const) {
      const res = await run(() =>
        prExportInterchangeTool.handler(
          { format, outPath: path.join(tmp, "uscite", "Bozza"), sequence: "Bozza" },
          transport,
        ),
      );
      expect(res.isError, JSON.stringify(res.structuredContent)).toBe(false);
      expect((res.structuredContent as { file: string }).file).toMatch(
        new RegExp(`Bozza[.]${format}$`),
      );
    }
    const again = await run(() =>
      prExportInterchangeTool.handler(
        { format: "xml", outPath: path.join(tmp, "uscite", "Bozza.xml"), sequence: "Bozza" },
        transport,
      ),
    );
    expect(JSON.stringify(again.structuredContent)).toContain("confirm: true");
  });
});

describe("pr_auto_reframe", () => {
  it("makes a 9:16 copy; undo removes it and the bin Premiere made for it", async () => {
    const res = await run(() =>
      prAutoReframeTool.handler({ ratio: "9:16", sequence: "Bozza" }, transport),
    );
    expect(result(res).sequence).toMatchObject({ name: "Bozza - 9x16", width: 608, height: 1080 });
    expect(names()).toContain("Auto Reframed Sequences");
    await run(() => prUndoLastTool.handler({}, transport));
    expect(project.allSequences.map((q) => q.name)).not.toContain("Bozza - 9x16");
    expect(names()).not.toContain("Auto Reframed Sequences");
  });
});

describe("pr_captions", () => {
  it("needs confirm and an .srt; with them the captions go on the sequence", async () => {
    const srt = path.join(tmp, "sub.srt");
    writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nCiao\n");
    const refused = await run(() => prCaptionsTool.handler({ srt, sequence: "Bozza" }, transport));
    expect(refused.isError).toBe(true);
    expect(seq.captions).toEqual([]);
    const wrong = await prCaptionsTool.handler(
      { srt: path.join(tmp, "x.txt"), confirm: true },
      transport,
    );
    expect(wrong.isError).toBe(true);
    const res = await run(() =>
      prCaptionsTool.handler({ srt, sequence: "Bozza", confirm: true }, transport),
    );
    expect(String(result(res).undo)).toContain("punto di ritorno");
    expect(seq.captions).toEqual(["sub.srt"]);
  });
});

describe("pr_import of numbered series: one call each, at the right rate (2026-11-15)", () => {
  function series(name: string, frames: number): string {
    const dir = path.join(tmp, `render-${name}`);
    mkdirSync(dir, { recursive: true });
    for (let n = 0; n < frames; n++) {
      writeFileSync(path.join(dir, `${name}_${String(n).padStart(4, "0")}.png`), "x");
    }
    return path.join(dir, `${name}_0000.png`);
  }
  type Imported = Array<{
    name: string;
    frames: number;
    frameRate: number;
    durationTC: string;
    frameRateFrom: string;
    warning?: string;
  }>;

  it("three series in one call: three importFiles calls, three clips", async () => {
    const files = [series("Clip A", 96), series("Clip B", 96), series("Clip C", 48)];
    const calls = project.importedAsNumbered.length;
    const res = await run(() =>
      prImportTool.handler({ files, numberedStills: true, frameRate: 23.976 }, transport),
    );
    expect(project.importedAsNumbered.slice(calls)).toEqual([true, true, true]);
    const items = result(res).imported as Imported;
    expect(items.map((i) => [i.name, i.frames, i.durationTC])).toEqual([
      ["Clip A_0000.png", 96, "00:00:04:00"],
      ["Clip B_0000.png", 96, "00:00:04:00"],
      ["Clip C_0000.png", 48, "00:00:02:00"],
    ]);
    expect(items.every((i) => i.frameRate === 23.976 && i.frameRateFrom === "richiesto")).toBe(
      true,
    );
  });

  it("23.976 is set as 24000/1001, the rate After Effects renders at", async () => {
    await run(() =>
      prImportTool.handler(
        { files: [series("Clip A", 24)], numberedStills: true, frameRate: 23.976 },
        transport,
      ),
    );
    const clip = project.items.root.kids.find((k) => k.name === "Clip A_0000.png")!;
    expect(clip.frameRate).toBe(24000 / 1001);
  });

  it("without frameRate: the active sequence's rate", async () => {
    const res = await run(() =>
      prImportTool.handler({ files: [series("Clip A", 50)], numberedStills: true }, transport),
    );
    const [clip] = result(res).imported as Imported;
    expect(clip).toMatchObject({
      frameRate: 25,
      frameRateFrom: "sequenza attiva",
      durationTC: "00:00:02:00",
    });
    expect(clip!.warning).toBeUndefined();
  });

  it("without frameRate nor an active sequence: Premiere's own rate, and a warning", async () => {
    project.activeSequence = null;
    const res = await run(() =>
      prImportTool.handler({ files: [series("Clip A", 30)], numberedStills: true }, transport),
    );
    const [clip] = result(res).imported as Imported;
    expect(clip!.frameRateFrom).toBe("preferenza di Premiere");
    expect(clip!.warning).toContain("Passa frameRate");
  });
});

describe("pr_media_release / pr_media_refresh: After Effects writes the files again (2026-11-15)", () => {
  function clip(nodeId: string) {
    const walk = (kids: typeof project.items.root.kids): (typeof kids)[number] | null => {
      for (const k of kids) {
        if (k.nodeId === nodeId) return k;
        const hit = walk(k.kids);
        if (hit) return hit;
      }
      return null;
    };
    return walk(project.items.root.kids)!;
  }

  it("release sets the clips offline and leaves the timeline as it was; refresh links them back", async () => {
    const timeline = v1();
    const released = await run(() => prMediaReleaseTool.handler({ items: ["n-clip"] }, transport));
    expect(result(released).count).toBe(1);
    expect(clip("n-clip").isOffline()).toBe(true);
    expect(v1()).toEqual(timeline);

    const refreshed = await run(() => prMediaRefreshTool.handler({ items: ["n-clip"] }, transport));
    expect(result(refreshed)).toMatchObject({ count: 1, relinked: 1, failed: [] });
    expect(clip("n-clip").isOffline()).toBe(false);
    expect(clip("n-clip").getMediaPath()).toBe(String.raw`D:\Lavori\Cliente Rossi\Intervista.mov`);
    expect(clip("n-clip").refreshed).toBe(1);
    expect(v1()).toEqual(timeline);
  });

  it("picks the clips by the folder of their files, and refresh alone empties the cache", async () => {
    const dir = path.join(tmp, "render-B");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "Clip B_0000.png"), "x");
    writeFileSync(path.join(dir, "Clip B_0001.png"), "x");
    const imported = await run(() =>
      prImportTool.handler(
        { files: [path.join(dir, "Clip B_0000.png")], numberedStills: true },
        transport,
      ),
    );
    const [item] = result(imported).imported as Array<{ nodeId: string }>;
    const refreshed = await run(() => prMediaRefreshTool.handler({ folder: dir }, transport));
    expect(result(refreshed)).toMatchObject({ count: 1, relinked: 0 });
    expect(clip(item!.nodeId).refreshed).toBe(1);
    const released = await run(() => prMediaReleaseTool.handler({ folder: dir }, transport));
    expect(result(released).count).toBe(1);
    expect(clip("n-clip").isOffline()).toBe(false);
  });

  it("pr_undo_last after a release links the clips back", async () => {
    await run(() => prMediaReleaseTool.handler({ items: ["n-clip"] }, transport));
    await run(() => prUndoLastTool.handler({}, transport));
    expect(clip("n-clip").isOffline()).toBe(false);
  });

  it("refuses a call with no clips, and a folder that does not exist", async () => {
    const none = await prMediaReleaseTool.handler({}, transport);
    expect((none.structuredContent as { error: { code: string } }).error.code).toBe("INVALID_ARGS");
    const missing = await prMediaRefreshTool.handler({ folder: path.join(tmp, "nope") }, transport);
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe("IO");
  });

  it("both explain the flow: release, render the changed stretch, refresh", () => {
    for (const tool of [prMediaReleaseTool, prMediaRefreshTool, prImportTool]) {
      expect(tool.description).toContain("pr_media_release");
      expect(tool.description).toContain("pr_media_refresh");
    }
  });
});
