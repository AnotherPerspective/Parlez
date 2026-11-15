// Timecode in Parlez! for Premiere (Anthony, 2026-11-15: "al cinema si
// ragiona in timecode"). The conversion lives inside Premiere
// (jsx/premiere-helpers.jsx: PR.rate, PR.tcToFrames, PR.framesToTc,
// PR.timeIn, PR.tcOut), run here unchanged against plain sequence objects
// with the timebase, display format and start timecode Premiere reports.

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PREMIERE_AGENT_JSX } from "../src/premiere/config.js";
import { TIMECODE_RE } from "../src/premiere/timecode.js";
import { type EsEngine, loadJsx, makeEngine } from "./helpers/extendscript-shim.js";

const TPS = 254016000000;

interface Rate {
  tpf: number;
  base: number;
  drop: boolean;
}
interface PRApi {
  rate: (seq: unknown) => Rate | null;
  tcToFrames: (tc: string, rate: Rate) => { frames?: number; error?: string };
  framesToTc: (frames: number, rate: Rate) => string;
  timeIn: (seq: unknown, v: unknown, kind: string) => { seconds?: number; error?: string };
  tcOut: (seq: unknown, seconds: number, kind: string) => { tc: string; frame: number } | null;
  snapTicks: (seq: unknown, seconds: number) => number | null;
}

let tmp: string;
let engine: EsEngine;
let PR: PRApi;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-tc-"));
  engine = makeEngine(tmp);
  engine.run(
    `${loadJsx(PREMIERE_AGENT_JSX.replace("premiere-agent.jsx", "premiere-helpers.jsx"))}\n;globalThis.PR = PR;`,
  );
  PR = (globalThis as Record<string, unknown>).PR as PRApi;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).PR;
  rmSync(tmp, { recursive: true, force: true });
});

/** A sequence as Premiere describes it: ticks per frame, display format, start timecode. */
function seq(tpf: number, opts: { format?: number; zeroTicks?: number } = {}) {
  return {
    timebase: String(tpf),
    zeroPoint: String(opts.zeroTicks ?? 0),
    getSettings: () => ({ videoDisplayFormat: opts.format ?? 0 }),
  };
}

const RATES = {
  "23.976": (TPS * 1001) / 24000,
  "24": TPS / 24,
  "25": TPS / 25,
  "29.97": (TPS * 1001) / 30000,
  "30": TPS / 30,
  "59.94": (TPS * 1001) / 60000,
};

describe("frame rates: base and drop-frame", () => {
  it("23.976 and 24 count 24 frames, 25 counts 25, 29.97 and 30 count 30", () => {
    expect(PR.rate(seq(RATES["23.976"]))).toMatchObject({ base: 24, drop: false });
    expect(PR.rate(seq(RATES["24"]))).toMatchObject({ base: 24, drop: false });
    expect(PR.rate(seq(RATES["25"]))).toMatchObject({ base: 25, drop: false });
    expect(PR.rate(seq(RATES["29.97"]))).toMatchObject({ base: 30, drop: false });
    expect(PR.rate(seq(RATES["30"]))).toMatchObject({ base: 30, drop: false });
  });

  it("drop-frame only for 29.97 / 59.94 sequences that display it (formats 102, 106)", () => {
    expect(PR.rate(seq(RATES["29.97"], { format: 102 }))?.drop).toBe(true);
    expect(PR.rate(seq(RATES["29.97"], { format: 103 }))?.drop).toBe(false);
    expect(PR.rate(seq(RATES["59.94"], { format: 106 }))).toMatchObject({ base: 60, drop: true });
    expect(PR.rate(seq(RATES["25"], { format: 102 }))?.drop).toBe(false);
  });
});

describe("timecode <-> frames", () => {
  it("non-drop: frame = ((HH*60+MM)*60+SS)*base + FF, and back", () => {
    const r24 = PR.rate(seq(RATES["23.976"]))!;
    expect(PR.tcToFrames("00:00:02:00", r24).frames).toBe(48);
    expect(PR.tcToFrames("01:00:00:00", r24).frames).toBe(86400);
    expect(PR.framesToTc(86447, r24)).toBe("01:00:01:23");
    const r25 = PR.rate(seq(RATES["25"]))!;
    expect(PR.tcToFrames("00:00:01:24", r25).frames).toBe(49);
    const r30 = PR.rate(seq(RATES["30"]))!;
    expect(PR.framesToTc(1800, r30)).toBe("00:01:00:00");
    for (const r of [r24, r25, r30]) {
      for (const f of [0, 1, 1234, 86399, 999_999]) {
        expect(PR.tcToFrames(PR.framesToTc(f, r), r).frames).toBe(f);
      }
    }
  });

  it("29.97 drop-frame: skips ;00 and ;01 every minute but the tenth, with ';' before the frames", () => {
    const df = PR.rate(seq(RATES["29.97"], { format: 102 }))!;
    expect(PR.framesToTc(1799, df)).toBe("00:00:59;29");
    expect(PR.framesToTc(1800, df)).toBe("00:01:00;02");
    expect(PR.framesToTc(17982, df)).toBe("00:10:00;00");
    expect(PR.framesToTc(107892, df)).toBe("01:00:00;00");
    expect(PR.tcToFrames("00:01:00;02", df).frames).toBe(1800);
    expect(PR.tcToFrames("01:00:00;00", df).frames).toBe(107892);
    expect(PR.tcToFrames("00:01:00;00", df).error).toMatch(/non esiste in drop-frame/);
    for (const f of [0, 1, 1799, 1800, 17981, 17982, 17983, 107891, 500_000]) {
      expect(PR.tcToFrames(PR.framesToTc(f, df), df).frames).toBe(f);
    }
  });

  it("59.94 drop-frame skips four frames a minute", () => {
    const df = PR.rate(seq(RATES["59.94"], { format: 106 }))!;
    expect(PR.framesToTc(3600, df)).toBe("00:01:00;04");
    expect(PR.tcToFrames(PR.framesToTc(215784, df), df).frames).toBe(215784);
  });

  it("refuses what is not a timecode of this rate", () => {
    const r25 = PR.rate(seq(RATES["25"]))!;
    expect(PR.tcToFrames("00:00:01:25", r25).error).toMatch(/da 00 a 24/);
    expect(PR.tcToFrames("00:61:00:00", r25).error).toMatch(/da 00 a 59/);
    expect(PR.tcToFrames("1.5", r25).error).toMatch(/HH:MM:SS:FF/);
  });
});

describe("times in and out of the tools", () => {
  it("23.976: 00:00:02:00 is exactly 48 frames (2.002 s), no seconds in between", () => {
    const s = seq(RATES["23.976"]);
    const r = PR.timeIn(s, "00:00:02:00", "length");
    // What reaches Premiere is ticks: exactly 48 frames' worth.
    expect(PR.snapTicks(s, r.seconds!)).toBe(48 * RATES["23.976"]);
    expect(r.seconds).toBeCloseTo(2.002, 9);
  });

  it("a timecode on the timeline counts from the sequence's start timecode (01:00:00:00)", () => {
    const s = seq(RATES["25"], { zeroTicks: 3600 * TPS });
    expect(PR.timeIn(s, "01:00:01:00", "position").seconds).toBe(1);
    expect(PR.timeIn(s, "00:59:59:24", "position").error).toMatch(
      /prima dell'inizio della sequenza, che parte da 01:00:00:00/,
    );
    // A length does not: two seconds are two seconds.
    expect(PR.timeIn(s, "00:00:02:00", "length").seconds).toBe(2);
    expect(PR.tcOut(s, 1, "position")).toEqual({ tc: "01:00:01:00", frame: 25 });
    expect(PR.tcOut(s, 1, "length")).toEqual({ tc: "00:00:01:00", frame: 25 });
  });

  it("drop-frame start timecode 01:00:00;00 at 29.97", () => {
    const s = seq(RATES["29.97"], { format: 102, zeroTicks: 107892 * RATES["29.97"] });
    expect(PR.tcOut(s, 0, "position")?.tc).toBe("01:00:00;00");
    const back = PR.timeIn(s, "01:00:01;00", "position").seconds!;
    expect(Math.round((back * TPS) / RATES["29.97"])).toBe(30);
  });

  it("a number is still seconds, put on the frame grid", () => {
    const s = seq(RATES["23.976"]);
    expect(PR.snapTicks(s, PR.timeIn(s, 2.002, "position").seconds!)).toBe(48 * RATES["23.976"]);
  });

  it("the tools' schema takes the same timecodes", () => {
    for (const ok of ["00:00:02:00", "01:00:00;00", "1:02:03:04"])
      expect(TIMECODE_RE.test(ok)).toBe(true);
    for (const bad of ["2.002", "00:00:02", "00:00:02:000", "aa:bb:cc:dd"])
      expect(TIMECODE_RE.test(bad)).toBe(false);
  });
});
