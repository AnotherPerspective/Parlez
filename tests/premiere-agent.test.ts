// Parlez! for Premiere Pro, end to end without Premiere: the real agent
// (jsx/premiere-agent.jsx, with the shared jsx/serve.jsx and the PR.*
// helpers) runs in the ExtendScript stand-in against a small fake Premiere
// project, and the real PremiereTransport and pr_* tools talk to it through
// a throwaway mailbox. The "panel" is this test calling PARLEZ_PR.tick, the
// way premiere/panel/panel.js does every quarter of a second.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PREMIERE_AGENT_JSX } from "../src/premiere/config.js";
import { prContextTool, prProjectInfoTool, prSequenceInfoTool } from "../src/premiere/tools.js";
import { PremiereTransport, resolvePremiereTarget } from "../src/premiere/transport.js";
import type { EvalResult } from "../src/transport/AeTransport.js";
import { listInstances } from "../src/transport/instances.js";
import type { ToolResult } from "../src/tools/types.js";
import { type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";
import { fakeProject } from "./helpers/premiere-fake.js";

interface PanelStatus {
  ok: boolean;
  id: string;
  enabled: boolean;
  readOnly: boolean;
  served: number;
  refused: number;
  recent: Array<{ label: string; outcome: string; title?: string }>;
}

let tmp: string;
let mailbox: string;
let engine: EsEngine;
let transport: PremiereTransport;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-premiere-"));
  mailbox = path.join(tmp, "runtime").replace(/\\/g, "/");
  engine = makeEngine(tmp);
  // Premiere, not After Effects: no app.settings, no undo groups, no dialog
  // suppression. serve.jsx must not reach for any of them.
  const app = engine.app as unknown as Record<string, unknown>;
  for (const key of [
    "settings",
    "beginUndoGroup",
    "endUndoGroup",
    "beginSuppressDialogs",
    "endSuppressDialogs",
    "scheduleTask",
  ]) {
    delete app[key];
  }
  app.version = "26.3.2";
  app.project = fakeProject();
  transport = new PremiereTransport({
    instancesDir: path.join(mailbox, "premiere"),
    instance: null,
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).PR;
  rmSync(tmp, { recursive: true, force: true });
});

function startAgent() {
  engine.global.PARLEZ_PR_MAILBOX = mailbox;
  // Generated code runs through `new Function`, which sees only real
  // globals; in ExtendScript the helpers' top-level `var PR` is one.
  engine.run(
    `${loadJsx(PREMIERE_AGENT_JSX, ["serve.jsx", "premiere-helpers.jsx"])}\n;globalThis.PR = PR;`,
  );
  const agent = engine.global.PARLEZ_PR as { tick: (on: boolean, ro: boolean) => string };
  expect(agent, "premiere-agent.jsx did not register itself").toBeTruthy();
  return {
    tick: (on: boolean, ro = false) => JSON.parse(agent.tick(on, ro)) as PanelStatus,
  };
}

/** Run `call` while "the panel" ticks with the given switches until it settles. */
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

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("Premiere agent: heartbeat", () => {
  it("heartbeats in <mailbox>/premiere/<id>, never in After Effects' instances folder", async () => {
    const agent = startAgent();
    const status = agent.tick(false);
    expect(status.ok).toBe(true);
    expect(status.id).toMatch(/^pr-[a-z0-9]{6}$/);

    const hb = JSON.parse(
      readFileSync(path.join(mailbox, "premiere", status.id, "heartbeat.json"), "utf8"),
    );
    expect(hb).toMatchObject({
      id: status.id,
      host: "premiere",
      appVersion: "26.3.2",
      projectName: "Prova.prproj",
      paused: true,
      readOnly: false,
    });

    // After Effects looks only in instances/: it cannot see Premiere.
    expect(await listInstances(path.join(mailbox, "instances"))).toEqual([]);
    const live = await resolvePremiereTarget(null, path.join(mailbox, "premiere"));
    expect(live.mode).toBe("pull");
  });

  it("keeps its id across a panel reload in the same Premiere session", () => {
    const first = startAgent().tick(false).id;
    const second = startAgent().tick(false).id;
    expect(second).toBe(first);
  });
});

describe("Premiere agent: the switches", () => {
  it("starts OFF: a call is refused as PAUSED and nothing runs", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, false, false, () =>
      transport.execute({ code: "return 1;", label: "probe", mutates: false, timeoutMs: 5000 }),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("PAUSED");
    expect(res.error).toContain("Premiere Pro");
  });

  it("ON: a call runs inside Premiere and comes back", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      transport.execute({ code: "return { v: app.version };", label: "probe", timeoutMs: 5000 }),
    );
    expect(res.ok, res.error ?? "").toBe(true);
    expect(res.result).toEqual({ v: "26.3.2" });
    const status = agent.tick(true);
    expect(status.served).toBe(1);
    expect(status.recent.at(-1)).toMatchObject({ label: "probe", outcome: "ok" });
  });

  it("Sola lettura: reads pass, anything that may change the project is refused", async () => {
    const agent = startAgent();
    const read = await withPanel(agent, true, true, () =>
      transport.execute({ code: "return 1;", label: "read", mutates: false, timeoutMs: 5000 }),
    );
    expect(read.ok).toBe(true);
    const write = await withPanel(agent, true, true, () =>
      transport.execute({ code: "return 2;", label: "write", timeoutMs: 5000 }),
    );
    expect(write.errorCode).toBe("READ_ONLY");
  });

  it("switching OFF after a request was queued still refuses it, and counts it as refused", async () => {
    const agent = startAgent();
    agent.tick(true);
    const pending = transport.execute({ code: "return 1;", label: "late", timeoutMs: 5000 });
    // The transport saw ON; the panel flips to OFF before serving.
    await new Promise((r) => setTimeout(r, 150));
    const res = await withPanel(agent, false, false, () => pending);
    expect(res.errorCode).toBe("PAUSED");
    expect(agent.tick(false).refused).toBe(1);
  });

  it("a script error comes back as JSX_THROW, not a timeout", async () => {
    const agent = startAgent();
    const res: EvalResult = await withPanel(agent, true, false, () =>
      transport.execute({ code: "throw new Error('boom');", label: "bad", timeoutMs: 5000 }),
    );
    expect(res.errorCode).toBe("JSX_THROW");
    expect(res.error).toContain("boom");
  });
});

describe("Premiere transport without a panel", () => {
  it("answers NO_INSTANCE at once, telling the user to open the panel", async () => {
    const started = Date.now();
    const res = await transport.execute({ code: "return 1;", timeoutMs: 5000 });
    expect(res.errorCode).toBe("NO_INSTANCE");
    expect(res.error).toContain("pannello Parlez!");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ignores a heartbeat that is not Premiere's", async () => {
    const dir = path.join(mailbox, "premiere", "ae-x");
    rmSync(dir, { recursive: true, force: true });
    await import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
    writeFileSync(
      path.join(dir, "heartbeat.json"),
      JSON.stringify({ id: "ae-x", host: "aftereffects", ts: Date.now(), ticks: 5 }),
    );
    const target = await resolvePremiereTarget(null, path.join(mailbox, "premiere"));
    expect(target.mode).toBe("error");
  });
});

describe("pr_* tools against the fake project", () => {
  it("pr_project_info lists bins, clips, offline media and sequences", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () => prProjectInfoTool.handler({}, transport));
    expect(res.isError, JSON.stringify(res)).toBe(false);
    const result = structured(res).result as Record<string, unknown>;
    expect(result).toMatchObject({
      name: "Prova.prproj",
      project: "D:/Prove/Prova.prproj",
      activeSequence: "Montaggio",
      offlineCount: 1,
      truncated: false,
    });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.name, i.kind, i.bin])).toEqual([
      ["Girato", "bin", ""],
      ["Intervista.mov", "clip", "Girato"],
      ["Drone.mp4", "clip", "Girato"],
      ["Montaggio", "sequence", ""],
    ]);
    expect(items[1]).toMatchObject({
      file: "D:/Lavori/Cliente Rossi/Intervista.mov",
      offline: false,
      colorLabel: 3,
    });
    expect(result.sequences).toEqual([
      {
        name: "Montaggio",
        sequenceID: "seq-guid-1",
        width: 1920,
        height: 1080,
        fps: 25,
        duration: 10,
        durationTC: "00:00:10:00",
        durationFrame: 250,
        startTimecode: "00:00:00:00",
        dropFrame: false,
        videoTracks: 1,
        audioTracks: 0,
      },
    ]);
  });

  it("pr_project_info stops at maxItems and says so", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prProjectInfoTool.handler({ maxItems: 2 }, transport),
    );
    const result = structured(res).result as Record<string, unknown>;
    expect(result.itemCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("pr_sequence_info reads tracks, clips and markers of the active sequence", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, false, () =>
      prSequenceInfoTool.handler({}, transport),
    );
    expect(res.isError, JSON.stringify(res)).toBe(false);
    const result = structured(res).result as Record<string, unknown>;
    expect(result).toMatchObject({
      name: "Montaggio",
      fps: 25,
      playhead: 2.5,
      playheadTC: "00:00:02:13",
      inPoint: 0,
      outPoint: 10,
      outPointTC: "00:00:10:00",
    });
    const video = result.video as Array<Record<string, unknown>>;
    expect(video[0]).toMatchObject({
      index: 1,
      name: "V1",
      muted: false,
      locked: false,
      clipCount: 1,
    });
    expect((video[0].clips as unknown[])[0]).toMatchObject({
      name: "Intervista.mov",
      start: 0,
      end: 4,
      inPoint: 1,
      outPoint: 5,
      selected: true,
      source: "Intervista.mov",
    });
    expect(result.markers).toEqual([
      {
        name: "Inizio",
        comment: "attacco",
        start: 0,
        end: 0,
        startTC: "00:00:00:00",
        startFrame: 0,
        endTC: "00:00:00:00",
        endFrame: 0,
        type: "Comment",
        guid: "m1",
        colorIndex: 1,
      },
      {
        name: "Titolo",
        comment: "",
        start: 2,
        end: 3,
        startTC: "00:00:02:00",
        startFrame: 50,
        endTC: "00:00:03:00",
        endFrame: 75,
        type: "Comment",
        guid: "m2",
        colorIndex: 4,
      },
    ]);
  });

  it("pr_sequence_info finds a sequence by name and reports one it cannot find", async () => {
    const agent = startAgent();
    const byName = await withPanel(agent, true, false, () =>
      prSequenceInfoTool.handler({ sequence: "montaggio" }, transport),
    );
    expect(byName.isError).toBe(false);
    const missing = await withPanel(agent, true, false, () =>
      prSequenceInfoTool.handler({ sequence: "Non c'è" }, transport),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.type === "text" && missing.content[0].text).toContain(
      "Sequenza non trovata",
    );
  });

  it("the read tools pass Sola lettura", async () => {
    const agent = startAgent();
    const res = await withPanel(agent, true, true, () => prProjectInfoTool.handler({}, transport));
    expect(res.isError).toBe(false);
  });

  it("pr_context says whether Premiere is connected, without contacting it", async () => {
    const res = await prContextTool.handler({}, transport);
    // The real mailbox may or may not have a Premiere connected; the shape is what matters.
    const s = structured(res);
    expect(typeof s.connected).toBe("boolean");
    expect(Array.isArray(s.rules)).toBe(true);
  });
});

describe("Premiere agent: the panel's Ripristino, Elenco and Storico", () => {
  function agentApi() {
    return engine.global.PARLEZ_PR as {
      checkpoint: () => string;
      openCheckpoints: () => string;
      openHistory: () => string;
    };
  }

  function realProject() {
    const dir = path.join(tmp, "progetti");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "Spot.prproj");
    writeFileSync(file, "progetto", "utf8");
    (engine.app as unknown as Record<string, unknown>).project = fakeProject(file);
    return { dir, file };
  }

  it("Ripristino saves, then copies the project into _parlez-checkpoints, never overwriting", () => {
    startAgent();
    const { dir } = realProject();
    const first = JSON.parse(agentApi().checkpoint());
    expect(first.ok).toBe(true);
    expect(first.message).toMatch(/^Ripristino creato: Spot__\d{8}-\d{6}__pannello\.prproj$/);
    const second = JSON.parse(agentApi().checkpoint());
    expect(second.ok).toBe(true);
    const copies = readdirSync(path.join(dir, "_parlez-checkpoints"));
    expect(copies).toHaveLength(2);
    expect((engine.app as unknown as { project: { saves: number } }).project.saves).toBe(2);
  });

  it("Ripristino and Elenco say so when the project was never saved", () => {
    startAgent();
    (engine.app as unknown as Record<string, unknown>).project = fakeProject("");
    expect(JSON.parse(agentApi().checkpoint()).message).toContain("Salva prima il progetto");
    expect(agentApi().openCheckpoints()).toBe("nosave");
  });

  it("every request goes into a history file next to After Effects', which Storico opens", async () => {
    const agent = startAgent();
    await withPanel(agent, true, false, () =>
      transport.execute({
        code: "return 1;",
        label: "pr_context",
        mutates: false,
        timeoutMs: 5000,
      }),
    );
    const storico = path.join(tmp, "userData", "Parlez", "storico");
    const files = readdirSync(storico).filter((n) => n.startsWith("storico-premiere-"));
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(storico, files[0]), "utf8")).toMatch(
      /\| pr_context \| eseguita \|/,
    );
    expect(agentApi().openHistory()).toBe("ok");
  });
});
