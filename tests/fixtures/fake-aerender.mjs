// A stand-in for aerender in the offline tests (tests/aerender-ops.test.ts):
// takes the same arguments, prints PROGRESS lines in the shape the parser
// expects, and writes the output file. It never renders anything and never
// touches After Effects. Behaviour comes from environment variables:
//
//   FAKE_AERENDER_FRAMES       frames to "render" (default 5)
//   FAKE_AERENDER_INTERVAL_MS  pause between frames (default 20)
//   FAKE_AERENDER_EXIT         exit code at the end (default 0)
//   FAKE_AERENDER_NO_OUTPUT=1  finish without writing the output
//   FAKE_AERENDER_HANG=1       after the frames, wait until killed (for cancel)
//   FAKE_AERENDER_ENGINE_LOST=1  what AE 26.5's aerender printed on 2026-10-26
//                              when its render engine dropped the connection:
//                              an ERROR line, no file, and still exit code 0
//   FAKE_AERENDER_EXT=.mov     write the output under this extension instead

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const output = arg("-output");
const comp = arg("-comp") ?? "?";
const frames = Number(process.env.FAKE_AERENDER_FRAMES ?? 5);
const interval = Number(process.env.FAKE_AERENDER_INTERVAL_MS ?? 20);
const exitCode = Number(process.env.FAKE_AERENDER_EXIT ?? 0);
const hang = process.env.FAKE_AERENDER_HANG === "1";
const noOutput = process.env.FAKE_AERENDER_NO_OUTPUT === "1";
const engineLost = process.env.FAKE_AERENDER_ENGINE_LOST === "1";
const ext = process.env.FAKE_AERENDER_EXT;

const pad = (n) => String(n).padStart(2, "0");
const say = (line) => process.stdout.write(`${line}\n`);

say("aerender version 26.0x00 (fake)");
if (engineLost) {
  say("PROGRESS: Launching After Effects...");
  say("PROGRESS: Adding specified comp to Render Queue");
  say("aerender ERROR An existing connection was forcibly closed by the remote host.");
  say(": Unable to receive at line 518");
  process.exit(0);
}
say(`PROGRESS:  Starting composition "${comp}".`);
say(`PROGRESS:  Output To: ${output}`);
say(`PROGRESS:  Duration: 0:00:${pad(Math.floor(frames / 25))}:${pad(frames % 25)}`);
say("PROGRESS:  Frame Rate: 25.00 (comp)");

if (output && hang) {
  // A partial file, so cancel can show it is left in place.
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, "partial");
}

let frame = 0;
const tick = () => {
  if (frame < frames) {
    say(`PROGRESS:  0:00:00:${pad(frame)} (${frame + 1}): 0 Seconds`);
    frame += 1;
    setTimeout(tick, interval);
    return;
  }
  if (hang) {
    setInterval(() => {}, 1000);
    return;
  }
  say("PROGRESS:  Total Time Elapsed: 0 Seconds");
  if (exitCode !== 0) {
    process.stderr.write("aerender ERROR: fake failure\n");
  } else {
    say("PROGRESS:  Render Finished");
  }
  if (output && !noOutput && exitCode === 0) {
    mkdirSync(path.dirname(output), { recursive: true });
    const target = ext
      ? output.slice(0, output.length - path.extname(output).length) + ext
      : output;
    writeFileSync(target, "fake video bytes");
  }
  process.exit(exitCode);
};
tick();
