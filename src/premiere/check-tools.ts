// pr_project_check: the checks an editor does before handing a project on,
// read-only. Offline media, clips no sequence uses, gaps on the video tracks
// of a sequence, sequences whose size or frame rate differ from the others,
// clips switched off. Built on the same PR.* readers as the other tools.

import { z } from "zod";

import { jsxVal } from "../registry.js";
import { defineTool, toMcpResult } from "../tools/define-tool.js";

export const prProjectCheckTool = defineTool({
  name: "pr_project_check",
  title: "Premiere project check",
  description:
    "Check a Premiere Pro project the way an editor does before delivery, without changing anything: " +
    "offline media, clips not used in any sequence, gaps between clips on the video tracks and clips " +
    "switched off (in one sequence, default the active one, or every sequence), and sequences whose frame " +
    "size or frame rate differ from the most common one.",
  group: "premiere",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    sequence: z
      .string()
      .optional()
      .describe(
        'Sequence name or sequenceID for the timeline checks; "*" for every sequence. Default: the active one.',
      ),
    minGap: z
      .number()
      .min(0)
      .optional()
      .describe("Shortest gap worth reporting, in seconds (default 0.05, about one frame)."),
  },
  handler: async (args, transport) => {
    const code = `
        var minGap = ${jsxVal(args.minGap ?? 0.05)};
        var target = ${jsxVal(args.sequence ?? null)};
        var i;
        var listed = PR.listItems(app.project.rootItem, 100000);
        var offline = [];
        var clipIds = {};
        for (i = 0; i < listed.items.length; i++) {
            var it = listed.items[i];
            if (it.offline === true) offline.push({ name: it.name, bin: it.bin, nodeId: it.nodeId });
            if (it.kind === "clip" || it.kind === "file") clipIds["k" + it.nodeId] = it;
        }
        var all = PR.allSequences();
        var used = {};
        var sizes = {};
        var summaries = [];
        for (i = 0; i < all.length; i++) {
            var s = PR.sequenceSummary(all[i]);
            summaries.push(s);
            var key = s.width + "x" + s.height + "@" + s.fps;
            sizes[key] = (sizes.hasOwnProperty(key) ? sizes[key] : 0) + 1;
            var items = PR.timelineItems(all[i]);
            for (var k = 0; k < items.length; k++) {
                var src = PR.safe(function () { return String(items[k].item.projectItem.nodeId); }, null);
                if (src !== null) used["k" + src] = true;
            }
        }
        var unused = [];
        for (var id in clipIds) {
            if (clipIds.hasOwnProperty(id) && !used.hasOwnProperty(id)) {
                unused.push({ name: clipIds[id].name, bin: clipIds[id].bin, nodeId: clipIds[id].nodeId });
            }
        }
        var common = null;
        var best = 0;
        for (var sk in sizes) {
            if (sizes.hasOwnProperty(sk) && sizes[sk] > best) { best = sizes[sk]; common = sk; }
        }
        var different = [];
        for (i = 0; i < summaries.length; i++) {
            var sum = summaries[i];
            if (sum.width + "x" + sum.height + "@" + sum.fps !== common) {
                different.push({ name: sum.name, width: sum.width, height: sum.height, fps: sum.fps });
            }
        }
        var checked = [];
        if (target === "*") checked = all;
        else {
            var found = PR.findSequence(target);
            if (found.error) return { ok: false, error: found.error };
            checked = [found.seq];
        }
        var timelines = [];
        for (i = 0; i < checked.length; i++) {
            var seq = checked[i];
            var entries = PR.timelineItems(seq);
            var gaps = [];
            var off = [];
            var tracks = {};
            for (var e = 0; e < entries.length; e++) {
                var en = entries[e];
                if (en.kind === "video") {
                    if (!tracks.hasOwnProperty("t" + en.track)) tracks["t" + en.track] = [];
                    tracks["t" + en.track].push(en);
                }
                if (PR.safe(function () { return en.item.disabled === true; }, false)) off.push(PR.placed(en));
            }
            for (var tk in tracks) {
                if (!tracks.hasOwnProperty(tk)) continue;
                var list = tracks[tk];
                list.sort(function (a, b) { return a.start - b.start; });
                for (var q = 1; q < list.length; q++) {
                    var gap = list[q].start - list[q - 1].end;
                    if (gap >= minGap) {
                        gaps.push({ track: "V" + list[q].track, from: list[q - 1].end, to: list[q].start, seconds: PR.round(gap, 3) });
                    }
                }
            }
            timelines.push({ sequence: PR.safe(function () { return String(seq.name); }, null), gaps: gaps, switchedOff: off });
        }
        return {
            offline: offline,
            unused: unused,
            commonFormat: common,
            differentFormat: different,
            timelines: timelines
        };
    `;
    return toMcpResult(
      await transport.execute({ code, label: "pr_project_check", mutates: false }),
    );
  },
});
