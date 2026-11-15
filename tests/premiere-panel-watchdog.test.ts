// The Premiere panel's giro (premiere/panel/panel.js) restarts when an answer
// is lost. It used to book the next tick only from the answer to the previous
// one: on After Effects (2026-11-15) a script sent just as a modal window
// opened was dropped with no answer at all, and one lost answer would have
// stopped the giro for good. The page runs here with a do-nothing DOM and
// fake timers; evalScript records the calls and answers only when told.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREMIERE_PANEL_SRC } from "../src/premiere/config.js";

const SRC = readFileSync(path.join(PREMIERE_PANEL_SRC, "panel.js"), "utf8");

/** Anything the page asks of the DOM: an element that accepts everything. */
function fakeElement(): unknown {
  const target: Record<string, unknown> = {
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
    addEventListener(type: string, fn: (e: unknown) => void) {
      const l = target.listeners as Record<string, Array<(e: unknown) => void>>;
      (l[type] ??= []).push(fn);
    },
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    children: [],
  };
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key as string] : ""),
    set: (t, key, value) => {
      t[key as string] = value;
      return true;
    },
  });
}

interface Call {
  script: string;
  answer: (result: string) => void;
}

let calls: Call[];
/** The page's elements by id, to click its buttons. */
let byId: Map<string, Record<string, unknown>>;

function click(id: string) {
  const el = byId.get(id)!;
  const listeners = (el.listeners as Record<string, Array<(e: unknown) => void>>).click ?? [];
  for (const fn of listeners) fn({ preventDefault() {} });
}

function openPanel() {
  calls = [];
  byId = new Map();
  const storage = new Map<string, string>([["parlez.claudeEnabled", "1"]]);
  const window = {
    __adobe_cep__: {
      evalScript: (script: string, cb: (r: string) => void) => calls.push({ script, answer: cb }),
      getSystemPath: (kind: string) =>
        kind === "extension"
          ? "file:///C:/Users/x/AppData/Roaming/Adobe/CEP/extensions/com.anotherperspective.parlez"
          : "",
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  };
  const document = {
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, fakeElement() as Record<string, unknown>);
      return byId.get(id);
    },
    createElement: () => fakeElement(),
  };
  new Function("window", "document", SRC)(window, document);
}

const ticks = () => calls.filter((c) => c.script.includes("PARLEZ_PR.tick("));
const pings = () => calls.filter((c) => c.script === "1");
const AGENT = JSON.stringify({ ok: true, id: "pr-1", recent: [] });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the Premiere panel's giro survives a lost answer", () => {
  it("answered ticks follow one another, and no ping is sent", () => {
    openPanel();
    for (let i = 0; i < 5; i++) {
      ticks()[ticks().length - 1].answer(AGENT);
      vi.advanceTimersByTime(250);
    }
    expect(ticks()).toHaveLength(6);
    // The last one is out, but not for long enough to be suspected.
    vi.advanceTimersByTime(3000);
    expect(pings()).toHaveLength(0);
  });

  it("a tick never answered: a ping after 5 s, and when the ping comes back first, a new giro", () => {
    openPanel();
    expect(ticks()).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    expect(pings()).toHaveLength(1);
    pings()[0].answer("1");
    expect(ticks()).toHaveLength(2);
    // The new giro goes on as usual.
    ticks()[1].answer(AGENT);
    vi.advanceTimersByTime(250);
    expect(ticks()).toHaveLength(3);
  });

  it("a long request is not mistaken for a lost answer: its own answer comes before the ping's", () => {
    openPanel();
    vi.advanceTimersByTime(6000);
    expect(pings()).toHaveLength(1);
    ticks()[0].answer(AGENT);
    pings()[0].answer("1");
    vi.advanceTimersByTime(250);
    // One giro: tick 1, then its follower; the ping started nothing.
    expect(ticks()).toHaveLength(2);
  });

  it("the late answer of a tick given up for lost does not start a second giro", () => {
    openPanel();
    vi.advanceTimersByTime(6000);
    pings()[0].answer("1");
    expect(ticks()).toHaveLength(2);
    ticks()[0].answer(AGENT);
    vi.advanceTimersByTime(250);
    expect(ticks()).toHaveLength(2);
  });

  it("one ping at a time, another if that one is lost too", () => {
    openPanel();
    vi.advanceTimersByTime(6000);
    vi.advanceTimersByTime(3000);
    expect(pings()).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(pings()).toHaveLength(2);
  });
});

describe("the Premiere panel's buttons and its agent", () => {
  it("Ripristino, Elenco and Storico ask the agent, with fixed calls", () => {
    openPanel();
    click("checkpoint");
    click("checkpoint-folder");
    click("history");
    const scripts = calls.map((c) => c.script);
    expect(scripts).toContain("PARLEZ_PR.checkpoint()");
    expect(scripts).toContain("PARLEZ_PR.openCheckpoints()");
    expect(scripts).toContain("PARLEZ_PR.openHistory()");
  });

  it("an agent gone from Premiere is loaded again from the host stub, not more than once in 10 s", () => {
    openPanel();
    const answerMissing = () => {
      ticks()[ticks().length - 1].answer("missing");
      vi.advanceTimersByTime(250);
    };
    for (let i = 0; i < 4; i++) answerMissing();
    vi.advanceTimersByTime(2000);
    answerMissing();
    const reloads = () => calls.filter((c) => c.script.includes("$.evalFile("));
    expect(reloads()).toHaveLength(1);
    expect(reloads()[0].script).toContain(
      '"C:/Users/x/AppData/Roaming/Adobe/CEP/extensions/com.anotherperspective.parlez/host/parlez-stub.jsx"',
    );
    for (let i = 0; i < 8; i++) answerMissing();
    expect(reloads()).toHaveLength(1);
  });
});
