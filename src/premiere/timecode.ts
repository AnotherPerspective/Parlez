// Times for the pr_* tools: the sequence's timecode first (Anthony,
// 2026-11-15: "al cinema si ragiona in timecode"). The conversion happens
// inside Premiere (PR.timeIn in jsx/premiere-helpers.jsx), where the
// sequence's frame rate, drop-frame and start timecode are known: timecode ->
// frame number -> ticks, with no seconds in between. A number is still taken
// as seconds, for compatibility.

import { z } from "zod";

/** HH:MM:SS:FF, with ";" allowed before FF (drop-frame) or between all fields. */
export const TIMECODE_RE = /^\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2}$/;

const TC_WORDS =
  'Timecode "HH:MM:SS:FF" of the sequence (frames 00 to base-1: 23.976 and 24 fps -> 00-23, 25 -> 00-24, ' +
  '29.97 and 30 -> 00-29; drop-frame sequences write ";" before FF)';

/**
 * A point on the timeline: the timecode the user reads in Premiere, counted
 * from the sequence's start timecode (at 01:00:00:00, "01:00:01:00" is one
 * second in). A number = seconds from the start of the sequence.
 */
export function prPosition(what: string) {
  return z
    .union([z.string().regex(TIMECODE_RE, "use HH:MM:SS:FF"), z.number().min(0)])
    .describe(
      `${what} ${TC_WORDS}, as shown in Premiere's timeline (it includes the sequence's start timecode). ` +
        "Prefer the timecode; a number is read as seconds from the start of the sequence (kept for compatibility).",
    );
}

/**
 * A length, or a point in the source: a timecode counted from 00:00:00:00
 * ("00:00:02:00" = two seconds). A number = seconds.
 */
export function prLength(what: string) {
  return z
    .union([z.string().regex(TIMECODE_RE, "use HH:MM:SS:FF"), z.number().min(0)])
    .describe(
      `${what} ${TC_WORDS}, counted from 00:00:00:00 (it is a length, not a point on the timeline). ` +
        "Prefer the timecode; a number is read as seconds (kept for compatibility).",
    );
}
