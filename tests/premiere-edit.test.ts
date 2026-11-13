// The Premiere tools that change a project, end to end without Premiere:
// the real agent in the ExtendScript stand-in, the fake project of
// helpers/premiere-fake.ts, the real PremiereTransport and pr_* tools. What
// is checked is the contract every changing tool keeps, because Premiere's
// Ctrl+Z does not take back script changes: a restore point first, the whole
// request taken back by pr_undo_last (or the panel's Annulla), and deletion
// only with confirm: true.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PREMIERE_AGENT_JSX } from "../src/premiere/config.js";
import {
  prBinsTool,
  prMarkersTool,
  prRenameItemsTool,
  prUndoLastTool,
} from "../src/premiere/edit-tools.js";
import { prSequenceCreateTool, prTimelineAddTool } from "../src/premiere/timeline-tools.js";
import { PremiereTransport } from "../src/premiere/transport.js";
import type { ToolResult } from "../src/tools/types.js";
import { type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";
import { FakeItem, fakeProject } from "./helpers/premiere-fake.js";

let tmp: string;
let mailbox: string;
let projectFile: string;
let project: ReturnType<typeof fakeProject>;
let engine: EsEngine;
let transport: PremiereTransport;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-premiere-edit-"));
  mailbox = path.join(tmp, "runtime").replace(/\\/g, "/");
  projectFile = path.join(tmp, "progetti", "Prova.prproj");
  mkdirSync(path.dirname(projectFile), { recursive: true });
  writeFileSync(projectFile, "<project v1/>", "utf8");
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
  project = fakeProject(projectFile);
  app.project = project;
  transport = new PremiereTransport({
    instancesDir: path.join(mailbox, "premiere"),
    instance: null,
  });
  delete process.env.AE_MCP_CHECKPOINT_DIR;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).PR;
  rmSync(tmp, { recursive: true, force: true });
});

function startAgent() {
  engine.global.PARLEZ_PR_MAILBOX = mailbox;
  engine.run(
    `${loadJsx(PREMIERE_AGENT_JSX, ["serve.jsx", "premiere-helpers.jsx"])}\n;globalThis.PR = PR;`,
  );
  const agent = engine.global.PARLEZ_PR as {
    tick: (on: boolean, ro: boolean) => string;
    undoLast: () => string;
  };
  return {
    tick: (on: boolean, ro = false) =>
      JSON.parse(agent.tick(on, ro)) as {
        recent: Array<{ label: string; outcome: string; undoable: boolean; undone?: boolean }>;
      },
    undoLast: () =>
      JSON.parse(agent.undoLast()) as { ok: boolean; undone?: number; error?: string },
  };
}

async function withPanel<T>(
  agent: ReturnType<typeof startAgent>,
  on: boolean,
  ro: boolean,
  call: () => Promise<T>,
): Promise<T> {
  agent.tick(on, ro);
  const timer = setInterval(() => agent.tick(on, ro), 20);
  try {
    return await call();
  } finally {
    clearInterval(timer);
  }
}

const checkpoints = () => {
  try {
    return readdirSync(path.join(path.dirname(projectFile), "_parlez-checkpoints"));
  } catch {
    return [];
  }
};

function result(res: ToolResult): Record<string, unknown> {
  expect(res.isError, JSON.stringify(res.structuredContent ?? res)).toBe(false);
  return (res.structuredContent as { result: Record<string, unknown> }).result;
}

const names = () => project.markers.list.map((m) => m.name).sort();

describe("pr_markers", () => {
  it("adds markers with name, comment, colour and length, after a restore point", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prMarkersTool.handler(
        {
          add: [
            { time: 5, name: "Stacco", comment: "musica", color: 3 },
            { time: 7, duration: 1.5, name: "Titolo" },
          ],
        },
        transport,
      ),
    );
    const r = result(res);
    expect(r.added).toMatchObject([
      { name: "Stacco", comment: "musica", start: 5, end: 5, color: 3 },
      { name: "Titolo", start: 7, end: 8.5 },
    ]);
    expect(names()).toEqual(["Inizio", "Stacco", "Titolo", "Titolo"]);
    const cp = (res.structuredContent as { checkpoint: { file: string; created: boolean } })
      .checkpoint;
    expect(cp.created).toBe(true);
    expect(cp.file).toMatch(/^Prova__\d{8}-\d{6}__pr-markers\.prproj$/);
    expect(checkpoints()).toEqual([cp.file]);
    // the panel's history knows this one can be taken back
    expect(agent.tick(true).recent.at(-1)).toMatchObject({ label: "pr_markers", undoable: true });
  });

  it("pr_undo_last takes the whole request back, then says there is nothing left", async () => {
    const agent = startAgent();
    await withPanel(agent, true, false, () =>
      prMarkersTool.handler(
        {
          add: [
            { time: 5, name: "A" },
            { time: 6, name: "B" },
          ],
        },
        transport,
      ),
    );
    expect(project.markers.numMarkers).toBe(4);
    const undo = await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(result(undo)).toMatchObject({ ok: true, label: "pr_markers", undone: 2, failed: [] });
    expect(names()).toEqual(["Inizio", "Titolo"]);
    const recent = agent.tick(true).recent;
    expect(recent.find((e) => e.label === "pr_markers")).toMatchObject({
      undone: true,
      undoable: false,
    });
    const again = await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(again.isError).toBe(true);
  });

  it("update changes a marker, and undo puts back name, colour and time", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prMarkersTool.handler(
        { update: [{ guid: "m2", name: "Nuovo", color: 6, time: 4 }] },
        transport,
      ),
    );
    expect(result(res).updated).toMatchObject([{ name: "Nuovo", color: 6, start: 4, end: 5 }]);
    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    const m2 = project.markers.list.find((m) => m.guid === "m2")!;
    expect([m2.name, m2.getColorByIndex(), m2.start.seconds, m2.end.seconds]).toEqual([
      "Titolo",
      4,
      2,
      3,
    ]);
  });

  it("remove needs confirm: true; without it nothing is touched and no restore point is taken", async () => {
    const agent = startAgent();
    const refused = await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ remove: ["m1"] }, transport),
    );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.structuredContent)).toContain("confirm: true");
    expect(project.markers.numMarkers).toBe(2);
    expect(checkpoints()).toEqual([]);

    const done = await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ remove: ["m1"], confirm: true }, transport),
    );
    expect(result(done).removed).toMatchObject([{ name: "Inizio", comment: "attacco" }]);
    expect(names()).toEqual(["Titolo"]);

    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    const back = project.markers.list.find((m) => m.name === "Inizio")!;
    expect([back.comments, back.start.seconds, back.getColorByIndex()]).toEqual(["attacco", 0, 1]);
  });

  it("a guid that does not exist is reported, not invented", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ update: [{ guid: "nope", name: "x" }] }, transport),
    );
    expect(result(res)).toMatchObject({ missing: ["nope"], updated: [] });
  });
});

describe("restore points", () => {
  it("are not repeated while the saved project file has not changed", async () => {
    const agent = startAgent();
    await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ add: [{ time: 1 }] }, transport),
    );
    await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ add: [{ time: 2 }] }, transport),
    );
    expect(checkpoints()).toHaveLength(1);
    writeFileSync(projectFile, "<project v2/>", "utf8");
    const third = await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ add: [{ time: 3 }] }, transport),
    );
    expect(checkpoints()).toHaveLength(2);
    expect(
      (third.structuredContent as { checkpoint: { created: boolean } }).checkpoint.created,
    ).toBe(true);
  });

  it("go where AE_MCP_CHECKPOINT_DIR says", async () => {
    const custom = path.join(tmp, "punti");
    process.env.AE_MCP_CHECKPOINT_DIR = custom;
    const agent = startAgent();
    await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ add: [{ time: 1 }] }, transport),
    );
    expect(readdirSync(custom)).toHaveLength(1);
    expect(checkpoints()).toEqual([]);
  });

  it("when one cannot be made, nothing changes", async () => {
    rmSync(projectFile);
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ add: [{ time: 1 }] }, transport),
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("punto di ritorno");
    expect(project.markers.numMarkers).toBe(2);
  });
});

describe("the panel's switches stop changes before anything is copied or changed", () => {
  it("OFF", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, false, false, () =>
      prMarkersTool.handler({ add: [{ time: 1 }] }, transport),
    );
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("PAUSED");
    expect(project.markers.numMarkers).toBe(2);
    expect(checkpoints()).toEqual([]);
  });

  it("Sola lettura", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, true, () =>
      prMarkersTool.handler({ add: [{ time: 1 }] }, transport),
    );
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("READ_ONLY");
    expect(project.markers.numMarkers).toBe(2);
    expect(checkpoints()).toEqual([]);
  });
});

describe("the panel's Annulla button", () => {
  it("takes back Claude's last change and marks it in the history", async () => {
    const agent = startAgent();
    await withPanel(agent, true, false, () =>
      prMarkersTool.handler({ add: [{ time: 9, name: "Da togliere" }] }, transport),
    );
    expect(agent.undoLast()).toMatchObject({ ok: true, undone: 1 });
    expect(names()).toEqual(["Inizio", "Titolo"]);
    const recent = agent.tick(true).recent;
    expect(recent.at(-2)).toMatchObject({ label: "pr_markers", undone: true });
    expect(recent.at(-1)).toMatchObject({ label: "pr_undo_last", outcome: "ok" });
    expect(agent.undoLast()).toMatchObject({ ok: false });
  });
});

describe("pr_bins", () => {
  it("creates nested bins and moves items in; undo moves them back and removes the new bins", async () => {
    const agent = startAgent();
    const { clip, seqItem, root } = project.items;
    const res = await withPanel(agent, true, false, () =>
      prBinsTool.handler(
        {
          create: ["Grafica"],
          move: [
            { nodeId: "n-clip", bin: "Girato/Interviste" },
            { nodeId: "n-seq", bin: "Sequenze" },
          ],
        },
        transport,
      ),
    );
    const r = result(res);
    expect(r).toMatchObject({ binsCreated: 3, missing: [], problems: [] });
    expect(clip.where()).toBe("Girato/Interviste/Intervista.mov");
    expect(seqItem.where()).toBe("Sequenze/Montaggio");
    expect(root.kids.map((k) => k.name)).toEqual(["Girato", "Grafica", "Sequenze"]);

    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(clip.where()).toBe("Girato/Intervista.mov");
    expect(seqItem.where()).toBe("Montaggio");
    expect(root.kids.map((k) => k.name).sort()).toEqual(["Girato", "Montaggio"]);
    expect(project.items.bin.kids.map((k) => k.name)).toEqual(["Drone.mp4", "Intervista.mov"]);
  });

  it("does not move into a clip, and reports unknown nodeIds", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prBinsTool.handler(
        {
          move: [
            { nodeId: "n-drone", bin: "Girato/Intervista.mov" },
            { nodeId: "nope", bin: "X" },
          ],
        },
        transport,
      ),
    );
    const r = result(res);
    expect((r.problems as string[])[0]).toContain("Girato/Intervista.mov");
    expect(r.missing).toEqual(["nope"]);
    expect(project.items.bin.kids.map((k) => k.name)).toEqual(["Intervista.mov", "Drone.mp4"]);
  });

  it("leaves a bin it created when undo finds something else inside", async () => {
    const agent = startAgent();
    await withPanel(agent, true, false, () =>
      prBinsTool.handler({ move: [{ nodeId: "n-clip", bin: "Nuovo" }] }, transport),
    );
    const nuovo = project.items.root.kids.find((k) => k.name === "Nuovo")!;
    nuovo.add(new FakeItem("Mio.mov"));
    const undo = await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(result(undo)).toMatchObject({ undone: 1 });
    expect((result(undo).failed as Array<{ why: string }>)[0]!.why).toContain("non");
    expect(project.items.clip.where()).toBe("Girato/Intervista.mov");
    expect(nuovo.kids.map((k) => k.name)).toEqual(["Mio.mov"]);
  });
});

describe("pr_rename_items", () => {
  it("renaming needs confirm: true; labels do not", async () => {
    const agent = startAgent();
    const refused = await withPanel(agent, true, false, () =>
      prRenameItemsTool.handler({ items: [{ nodeId: "n-clip", name: "Int_01" }] }, transport),
    );
    expect(refused.isError).toBe(true);
    expect(project.items.clip.name).toBe("Intervista.mov");

    const label = await withPanel(agent, true, false, () =>
      prRenameItemsTool.handler({ items: [{ nodeId: "n-clip", label: 7 }] }, transport),
    );
    expect(result(label).changed).toEqual([{ nodeId: "n-clip", label: 7 }]);
    expect(project.items.clip.getColorLabel()).toBe(7);
  });

  it("renames and relabels, and undo puts both back", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prRenameItemsTool.handler(
        {
          items: [
            { nodeId: "n-clip", name: "INT_01", label: 5 },
            { nodeId: "n-seq", name: "Montaggio v2" },
          ],
          confirm: true,
        },
        transport,
      ),
    );
    expect(result(res).changed).toEqual([
      { nodeId: "n-clip", from: "Intervista.mov", name: "INT_01", label: 5 },
      { nodeId: "n-seq", from: "Montaggio", name: "Montaggio v2" },
    ]);
    expect([project.items.clip.name, project.items.seqItem.name]).toEqual([
      "INT_01",
      "Montaggio v2",
    ]);
    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect([
      project.items.clip.name,
      project.items.seqItem.name,
      project.items.clip.getColorLabel(),
    ]).toEqual(["Intervista.mov", "Montaggio", 3]);
  });
});

describe("pr_sequence_create", () => {
  it("builds a sequence from clips in order, into a new bin; undo deletes it and the bin", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prSequenceCreateTool.handler(
        { name: "Bozza 1", clips: ["n-drone", "n-clip", "nope"], bin: "Sequenze" },
        transport,
      ),
    );
    const r = result(res);
    expect(r.missing).toEqual(["nope"]);
    expect((r.sequence as { name: string }).name).toBe("Bozza 1");
    const clips = r.clips as Array<{ name: string; kind: string; track: number; start: number }>;
    expect(clips.filter((c) => c.kind === "video").map((c) => [c.name, c.start])).toEqual([
      ["Drone.mp4", 0],
      ["Intervista.mov", 4],
    ]);
    expect(project.allSequences.map((q) => q.name)).toEqual(["Montaggio", "Bozza 1"]);
    expect(project.items.root.kids.map((k) => k.name)).toContain("Sequenze");

    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(project.allSequences.map((q) => q.name)).toEqual(["Montaggio"]);
    expect(project.items.root.kids.map((k) => k.name)).toEqual(["Girato", "Montaggio"]);
  });
});

describe("pr_timeline_add", () => {
  it("appends at the end of the track, linked audio included; undo removes exactly those", async () => {
    const agent = startAgent();
    const created = await withPanel(agent, true, false, () =>
      prSequenceCreateTool.handler({ name: "Bozza", clips: ["n-clip"] }, transport),
    );
    const seqName = (result(created).sequence as { name: string }).name;
    const seq = project.allSequences.find((q) => q.name === seqName)!;
    const res = await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler(
        { sequence: seqName, clips: [{ nodeId: "n-drone" }, { nodeId: "n-clip" }] },
        transport,
      ),
    );
    const placed = result(res).placed as Array<{ kind: string; start: number; track: number }>;
    expect(placed.filter((p) => p.kind === "video").map((p) => p.start)).toEqual([4, 8]);
    expect(placed.filter((p) => p.kind === "audio")).toHaveLength(2);
    expect(seq.video[0]!.items).toHaveLength(3);

    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(seq.video[0]!.items.map((i) => i.startS)).toEqual([0]);
    expect(seq.audio[0]!.items.map((i) => i.startS)).toEqual([0]);
  });

  it("insert pushes the rest later, and undo closes the gap again", async () => {
    const agent = startAgent();
    const created = await withPanel(agent, true, false, () =>
      prSequenceCreateTool.handler({ name: "Bozza", clips: ["n-clip", "n-drone"] }, transport),
    );
    const seq = project.allSequences.find(
      (q) => q.name === (result(created).sequence as { name: string }).name,
    )!;
    await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler(
        { sequence: seq.sequenceID, clips: [{ nodeId: "n-clip", time: 4, mode: "insert" }] },
        transport,
      ),
    );
    expect(
      seq.video[0]!.items.map((i) => [i.name, i.startS]).sort(
        (a, b) => Number(a[1]) - Number(b[1]),
      ),
    ).toEqual([
      ["Intervista.mov", 0],
      ["Intervista.mov", 4],
      ["Drone.mp4", 8],
    ]);
    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    expect(
      seq.video[0]!.items.map((i) => [i.name, i.startS]).sort(
        (a, b) => Number(a[1]) - Number(b[1]),
      ),
    ).toEqual([
      ["Intervista.mov", 0],
      ["Drone.mp4", 4],
    ]);
  });

  it("overwriting clips already there needs confirm: true, and nothing changes without it", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler({ clips: [{ nodeId: "n-drone", time: 1 }] }, transport),
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("confirm: true");
    expect(project.sequence.video[0]!.items.map((i) => i.nodeId)).toEqual(["t-1"]);

    const ok = await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler(
        { clips: [{ nodeId: "n-drone", time: 1 }], confirm: true },
        transport,
      ),
    );
    expect(String(result(ok).undo)).toContain("punto di ritorno");
  });

  it("refuses a track that does not exist, before changing anything", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler({ clips: [{ nodeId: "n-drone", track: 4 }] }, transport),
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("V4");
    expect(project.sequence.video[0]!.items).toHaveLength(1);
  });
});

describe("pr_timeline_add inside a clip (Premiere cuts it in two)", () => {
  it("needs confirm: true, and nothing changes without it", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler(
        { clips: [{ nodeId: "n-drone", time: 2, mode: "insert" }] },
        transport,
      ),
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("taglierebbe in due");
    expect(project.sequence.video[0]!.items.map((i) => [i.nodeId, i.startS, i.endS])).toEqual([
      ["t-1", 0, 4],
    ]);
  });

  it("with confirm, the cut piece is reported and undo takes out only the inserted clip", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prTimelineAddTool.handler(
        { clips: [{ nodeId: "n-drone", time: 2, mode: "insert" }], confirm: true },
        transport,
      ),
    );
    const r = result(res);
    expect(r.split).toEqual(["Intervista.mov"]);
    expect((r.placed as Array<{ name: string }>).map((p) => p.name)).toEqual(["Drone.mp4"]);
    expect(String(r.undo)).toContain("punto di ritorno");

    await withPanel(agent, true, false, () => prUndoLastTool.handler({}, transport));
    // The inserted clip is gone and the gap closed; the cut stays (two pieces, same source).
    const v1 = project.sequence.video[0]!.items.map((i) => [i.name, i.startS, i.endS]).sort(
      (a, b) => Number(a[1]) - Number(b[1]),
    );
    expect(v1).toEqual([
      ["Intervista.mov", 0, 2],
      ["Intervista.mov", 2, 4],
    ]);
  });
});
