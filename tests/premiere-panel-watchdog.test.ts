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
    addEventListener() {},
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

function openPanel() {
  calls = [];
  const storage = new Map<string, string>([["parlez.claudeEnabled", "1"]]);
  const window = {
    __adobe_cep__: {
      evalScript: (script: string, cb: (r: string) => void) => calls.push({ script, answer: cb }),
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  };
  const document = {
    getElementById: () => fakeElement(),
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
