// Privacy mode (nome provvisorio): what leaves this server towards the model.
// Every rule is exercised both ways — it fires where it should and leaves
// everything else alone — and the switch turned off must not change a byte.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { errorResult } from "../src/errors.js";
import { denyOperation, evalRunEnabled, policySummary } from "../src/policy.js";
import {
  PRIVACY_REDACTED_FIELDS,
  guardToolCall,
  parseWordList,
  privacyMode,
  privacySummary,
  resetPrivacyForTests,
  stripPaths,
} from "../src/privacy.js";
import { getOp } from "../src/registry.js";
import { catalogTool } from "../src/tools/catalog.js";
import { jsonResult } from "../src/tools/define-tool.js";
import { doTool } from "../src/tools/do.js";
import { projectInfoTool } from "../src/tools/project-info.js";
import type { ToolResult } from "../src/tools/types.js";
import "../src/operations/index.js";
import "../src/operations/eval.js";
import { nullTransport } from "./helpers/null-transport.js";

const ENV_KEYS = [
  "AE_MCP_PRIVACY",
  "AE_MCP_PRIVACY_WORDS",
  "AE_MCP_PRIVACY_ALLOW_FIELDS",
  "AE_MCP_ENABLE_EVAL",
  "AE_MCP_READONLY",
] as const;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ae-mcp-privacy-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetPrivacyForTests();
});

/** Turns privacy mode on, optionally with a word list written to a temp file. */
function privacyOn(words?: string, allow?: string): void {
  process.env.AE_MCP_PRIVACY = "1";
  if (words !== undefined) {
    const file = path.join(dir, `words-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(file, words, "utf8");
    process.env.AE_MCP_PRIVACY_WORDS = file;
  }
  if (allow !== undefined) process.env.AE_MCP_PRIVACY_ALLOW_FIELDS = allow;
  resetPrivacyForTests();
}

/** Runs a canned result through the guard as if a tool had returned it. */
async function pass(
  result: ToolResult,
  toolName = "ae_do",
  args: unknown = {},
): Promise<ToolResult> {
  return guardToolCall(toolName, args, async () => result);
}

function sc(res: ToolResult): any {
  return res.structuredContent as any;
}

function text(res: ToolResult): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

// A sample of the shapes the real tools return: project summary with footage
// paths, layer text, expressions, markers, dialogs, an error with a stack.
function sampleResults(): ToolResult[] {
  return [
    jsonResult({
      result: {
        project: { file: "C:/Clienti/Rossi Spa/2026/spot.aep", dirty: false },
        items: [
          {
            id: 1,
            name: "Rossi_Main",
            comment: "consegna venerdì",
            file: "D:/Footage/Rossi/clip 01.mov",
          },
        ],
        layers: [{ name: "Titolo", text: "Il nuovo modello Rossi", expression: "wiggle(2,5)" }],
      },
      context: { project: { file: "/Users/anthony/Lavori/Rossi/spot.aep" } },
      logs: ["opened \\\\nas01\\clienti\\Rossi\\spot.aep"],
      durationMs: 12,
    }),
    errorResult(
      "OPERATION_FAILED",
      "comp.info: no comp 'Rossi_Main' in C:\\Clienti\\Rossi\\spot.aep",
      {
        details: {
          operation: "comp.info",
          dialogs: [
            {
              pid: 1,
              id: "2",
              text: "Missing: C:/a/b.png",
              width: 1,
              height: 1,
              window: "spot.aep - After Effects",
            },
          ],
        },
        stack: "Error: boom\n    at C:\\Users\\anthony\\parlez\\dist\\index.js:10:5",
        logs: ["x"],
        durationMs: 3,
      },
    ),
    {
      content: [
        { type: "text", text: '{"ok":true,"doc":{"file":"C:/x/y.aep"}}' },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      structuredContent: { ok: true, doc: { file: "C:/x/y.aep" } },
      isError: false,
    },
  ];
}

// ---------------------------------------------------------------------------

describe("switch off (default)", () => {
  it("is off unless AE_MCP_PRIVACY=1", () => {
    expect(privacyMode()).toBe(false);
    process.env.AE_MCP_PRIVACY = "true";
    expect(privacyMode()).toBe(false);
    process.env.AE_MCP_PRIVACY = "1";
    expect(privacyMode()).toBe(true);
  });

  it("returns the handler's result untouched, byte for byte", async () => {
    // A word list and an allowlist in the environment must not matter while
    // the switch itself is off.
    const file = path.join(dir, "ignored.txt");
    writeFileSync(file, "Rossi\n", "utf8");
    process.env.AE_MCP_PRIVACY_WORDS = file;
    process.env.AE_MCP_PRIVACY_ALLOW_FIELDS = "text";
    for (const sample of sampleResults()) {
      const before = JSON.stringify(sample);
      const out = await pass(sample);
      expect(out).toBe(sample);
      expect(JSON.stringify(out)).toBe(before);
    }
  });

  it("passes the arguments through as the same object", async () => {
    const args = { operation: "comp.info", args: { comp: "[CLIENTE-1]_Main" } };
    let seen: unknown;
    await guardToolCall("ae_do", args, async (a) => {
      seen = a;
      return jsonResult({});
    });
    expect(seen).toBe(args);
  });

  it("lets a throwing handler throw, as before", async () => {
    await expect(
      guardToolCall("ae_do", {}, async () => {
        throw new Error("bug at C:/Users/anthony/x.ts");
      }),
    ).rejects.toThrow("C:/Users/anthony/x.ts");
  });

  it("adds nothing to policySummary and denies nothing extra", () => {
    expect(privacySummary()).toBeNull();
    expect(policySummary()).not.toContain("privacy");
    expect(denyOperation(getOp("project.get_xmp")!)).toBeNull();
    process.env.AE_MCP_ENABLE_EVAL = "1";
    expect(evalRunEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("stripPaths", () => {
  it.each([
    ["C:/Clienti/Rossi/spot.aep", "spot.aep"],
    ["C:\\Clienti\\Rossi\\spot.aep", "spot.aep"],
    ["c:\\Clienti\\Rossi Spa\\2026\\spot finale v2.aep", "spot finale v2.aep"],
    ["\\\\nas01\\clienti\\Rossi\\spot.aep", "spot.aep"],
    ["/Users/anthony/Lavori/Rossi/spot.aep", "spot.aep"],
    ["/Volumes/Archivio/Rossi/clip.mov", "clip.mov"],
    ["~/Desktop/Rossi/spot.aep", "spot.aep"],
    ["/c/Users/anthony/Rossi/spot.aep", "spot.aep"],
    ["file:///C:/Clienti/Rossi/spot.aep", "file:///spot.aep"],
    ["C:/Users/Anthony's Work/Rossi/spot.aep", "spot.aep"],
    // macOS temp (the IPC mailbox sits here) and system folders.
    ["/var/folders/x7/abc123/T/mcp-aftereffects/runtime/Rossi.json", "Rossi.json"],
    ["/private/var/folders/x7/abc123/T/out.png", "out.png"],
    ["/Applications/Adobe After Effects 2026/aerender", "aerender"],
    ["/Library/Fonts/Rossi Brand.otf", "Rossi Brand.otf"],
    // Linux (the CI): temp and home.
    ["/tmp/mcp-aftereffects/runtime/Rossi.json", "Rossi.json"],
    ["/home/anthony/Lavori/Rossi/spot.aep", "spot.aep"],
    ["/opt/render/Rossi/out.mov", "out.mov"],
    // Any other root, e.g. a NAS mounted on Linux.
    ["/data/clienti/Rossi Spa/spot.aep", "spot.aep"],
  ])("reduces %s to the file name", (input, expected) => {
    expect(stripPaths(input)).toBe(expected);
  });

  it("strips paths inside free text and keeps the sentence", () => {
    expect(stripPaths("File not found: C:\\Clienti\\Rossi\\spot.aep")).toBe(
      "File not found: spot.aep",
    );
    expect(stripPaths('cannot open "D:/Lavori/Rossi/a.png" now')).toBe('cannot open "a.png" now');
    expect(stripPaths("missing C:/a/Rossi/b.png, D:/c/Bianchi/d.png")).toBe("missing b.png, d.png");
    expect(stripPaths("in /Users/anthony/Rossi/x.aep and ~/Bianchi/y.aep")).toBe(
      "in x.aep and y.aep",
    );
  });

  it("never leaves a folder name behind, even when a sentence follows the path", () => {
    const out = stripPaths("C:/Clienti/Rossi Spa/spot.aep is missing");
    expect(out).not.toContain("Clienti");
    expect(out).not.toContain("Rossi");
  });

  it.each([
    "https://example.com/a/b",
    "12:30 at 25 fps",
    "/1/2/3",
    "and/or",
    "Transform > Position",
    "w/h ratio 16/9",
    "AE.findComps(nameOrIdOrPattern) — '*' glob supported",
    "a:b/c",
    "https://example.com/tmp/x.png",
    "var/let are not ES3-safe",
    "/var",
    "/2/1/4/12",
    "frame 24/25 at /30",
    "http://localhost:8000/history/abc",
    "",
  ])("leaves %j alone", (input) => {
    expect(stripPaths(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------

describe("parseWordList", () => {
  it("reads one word or phrase per line, skipping blanks and # comments", () => {
    const entries = parseWordList("\uFEFF# clienti\nRossi\n\n  Rossi Spa  \n# fine\n");
    expect(entries.map((e) => [e.word, e.label])).toEqual([
      ["Rossi", "[CLIENTE-1]"],
      ["Rossi Spa", "[CLIENTE-2]"],
    ]);
  });

  it("keeps one entry per word regardless of case", () => {
    const entries = parseWordList("Rossi\nROSSI\nrossi\n");
    expect(entries).toHaveLength(1);
  });

  it("takes an optional [CATEGORY] prefix with its own counter", () => {
    const entries = parseWordList("Rossi\n[PRODOTTO] Modello X\nBianchi\n[prodotto] Y-Phone\n");
    expect(entries.map((e) => e.label)).toEqual([
      "[CLIENTE-1]",
      "[PRODOTTO-1]",
      "[CLIENTE-2]",
      "[PRODOTTO-2]",
    ]);
    expect(entries[1]!.word).toBe("Modello X");
  });
});

// ---------------------------------------------------------------------------

describe("paths in responses", () => {
  it("reduces known path fields and free-text paths to the file name, in both copies", async () => {
    privacyOn();
    const out = await pass(sampleResults()[0]!);
    const s = sc(out);
    expect(s.result.project.file).toBe("spot.aep");
    expect(s.result.items[0].file).toBe("clip 01.mov");
    expect(s.context.project.file).toBe("spot.aep");
    expect(s.logs[0]).toBe("opened spot.aep");
    // content[].text is rebuilt from the filtered object, exactly as jsonResult would.
    const { ok: _ok, ...payload } = s;
    expect(out.content[0]).toEqual(jsonResult(payload).content[0]);
    expect(text(out)).not.toMatch(/Clienti|Users|anthony|Footage|nas01/);
  });

  it("reduces whole-value path fields even when they are relative", async () => {
    privacyOn();
    const out = await pass(
      jsonResult({
        writtenTo: "renders/Rossi/out.png",
        outputs: ["C:/Consegne/Rossi/a.png", "C:/Consegne/Rossi/b.png"],
        fontLocation: "C:\\Users\\anthony\\AppData\\Local\\Fonts\\Brand.otf",
      }),
    );
    expect(sc(out).writtenTo).toBe("out.png");
    expect(sc(out).outputs).toEqual(["a.png", "b.png"]);
    expect(sc(out).fontLocation).toBe("Brand.otf");
  });

  it("leaves property paths and non-path values in known fields alone", async () => {
    privacyOn();
    const manifestPath = "/2/1/4";
    const out = await pass(
      jsonResult({ manifest: [{ layer: 1, path: manifestPath }], project: null, file: "spot.aep" }),
    );
    expect(sc(out).manifest[0].path).toBe(manifestPath);
    expect(sc(out).project).toBeNull();
    expect(sc(out).file).toBe("spot.aep");
  });

  it("rebuilds an error's text from the filtered envelope", async () => {
    privacyOn();
    const out = await pass(sampleResults()[1]!);
    const err = sc(out).error;
    expect(err.message).toBe("comp.info: no comp 'Rossi_Main' in spot.aep");
    expect(err.stack).toContain("index.js:10:5");
    expect(err.stack).not.toContain("anthony");
    const rebuilt = errorResult(err.code, err.message, {
      details: err.details,
      stack: err.stack,
      logs: err.logs,
      durationMs: err.durationMs,
    });
    expect(out.content).toEqual(rebuilt.content);
    expect(out.isError).toBe(true);
  });

  it("filters a text block that is not the JSON of structuredContent", async () => {
    privacyOn();
    const out = await pass({
      content: [
        { type: "text", text: "saved to C:/Clienti/Rossi/spot.aep" },
        { type: "text", text: '{"file":"C:/Clienti/Rossi/x.aep"}' },
      ],
    });
    expect((out.content[0] as { text: string }).text).toBe("saved to spot.aep");
    expect(JSON.parse((out.content[1] as { text: string }).text)).toEqual({ file: "x.aep" });
  });
});

// ---------------------------------------------------------------------------

describe("words → labels", () => {
  it("replaces listed words in any string, case-insensitively, with stable labels", async () => {
    privacyOn("Rossi\nBianchi\n");
    const first = await pass(
      jsonResult({ comps: ["Rossi_Main", "BIANCHI cut", "rossi"], note: "per Rossi e Bianchi" }),
    );
    expect(sc(first).comps).toEqual(["[CLIENTE-1]_Main", "[CLIENTE-2] cut", "[CLIENTE-1]"]);
    expect(sc(first).note).toBe("per [CLIENTE-1] e [CLIENTE-2]");
    // Same label on a later call in the same session.
    const second = await pass(jsonResult({ name: "Bianchi" }));
    expect(sc(second).name).toBe("[CLIENTE-2]");
    expect(text(first)).not.toMatch(/rossi|bianchi/i);
  });

  it("matches the longest phrase first", async () => {
    privacyOn("Rossi\nRossi Spa\n");
    const out = await pass(jsonResult({ name: "Rossi Spa — Rossi" }));
    expect(sc(out).name).toBe("[CLIENTE-2] — [CLIENTE-1]");
  });

  it("applies to file names left after path stripping and to object keys", async () => {
    privacyOn("Rossi\n");
    const out = await pass(
      jsonResult({ file: "C:/Clienti/Rossi/Rossi_spot.aep", idMap: { Rossi_Main: 4 } }),
    );
    expect(sc(out).file).toBe("[CLIENTE-1]_spot.aep");
    expect(sc(out).idMap).toEqual({ "[CLIENTE-1]_Main": 4 });
  });

  it("does not touch strings that contain no listed word", async () => {
    privacyOn("Rossi\n");
    const payload = { name: "Main", n: 3, flags: [true, null], nested: { a: "b" } };
    const out = await pass(jsonResult(payload));
    expect(sc(out)).toEqual({ ok: true, ...payload });
  });

  it("escapes regex characters in listed phrases", async () => {
    privacyOn("A+B (2026)\n");
    const out = await pass(jsonResult({ name: "Spot A+B (2026) v1", other: "AAB 2026" }));
    expect(sc(out).name).toBe("Spot [CLIENTE-1] v1");
    expect(sc(out).other).toBe("AAB 2026");
  });
});

describe("labels → words in arguments", () => {
  it("restores labels in nested arguments before the handler runs", async () => {
    privacyOn("Rossi\n[PRODOTTO] Modello X\n");
    // Labels exist once the model has seen them, but the mapping is fixed by
    // the file, so restoring works from the first call too.
    let seen: any;
    await guardToolCall(
      "ae_do",
      {
        operation: "batch.run",
        args: {
          operations: [
            { op: "comp.info", args: { comp: "[CLIENTE-1]_Main" } },
            {
              op: "text.set_content",
              args: { comp: "[CLIENTE-1]_Main", layer: 1, text: "Scopri [PRODOTTO-1] oggi" },
            },
          ],
        },
      },
      async (a) => {
        seen = a;
        return jsonResult({});
      },
    );
    expect(seen.args.operations[0].args.comp).toBe("Rossi_Main");
    expect(seen.args.operations[1].args.text).toBe("Scopri Modello X oggi");
  });

  it("restores labels used as object keys", async () => {
    privacyOn("Rossi\n");
    let seen: any;
    await guardToolCall(
      "ae_do",
      { operation: "expression.restore_all", args: { replacements: { "[CLIENTE-1]": "Bianchi" } } },
      async (a) => {
        seen = a;
        return jsonResult({});
      },
    );
    expect(seen.args.replacements).toEqual({ Rossi: "Bianchi" });
  });

  it("gives back the spelling seen in the project when there was only one", async () => {
    privacyOn("Rossi\n");
    await pass(jsonResult({ name: "ROSSI_Main" }));
    let seen: any;
    await guardToolCall("ae_do", { comp: "[CLIENTE-1]_Main" }, async (a) => {
      seen = a;
      return jsonResult({});
    });
    expect(seen.comp).toBe("ROSSI_Main");
  });

  it("falls back to the spelling in the file when the project used several", async () => {
    privacyOn("Rossi\n");
    await pass(jsonResult({ a: "ROSSI", b: "rossi" }));
    let seen: any;
    await guardToolCall("ae_do", { comp: "[cliente-1]" }, async (a) => {
      seen = a;
      return jsonResult({});
    });
    expect(seen.comp).toBe("Rossi");
  });

  it("leaves unknown labels and label-like text alone", async () => {
    privacyOn("Rossi\n");
    let seen: any;
    await guardToolCall("ae_do", { a: "[CLIENTE-9]", b: "[NOTE-1]", c: 5 }, async (a) => {
      seen = a;
      return jsonResult({});
    });
    expect(seen).toEqual({ a: "[CLIENTE-9]", b: "[NOTE-1]", c: 5 });
  });
});

// ---------------------------------------------------------------------------

describe("redacted text fields", () => {
  it("lists the fields named in the brief", () => {
    for (const f of ["text", "expression", "comment", "xmp", "valueText", "items"]) {
      expect(PRIVACY_REDACTED_FIELDS).toContain(f);
    }
  });

  it("returns project texts as { redatto, lunghezza } instead of the text", async () => {
    privacyOn();
    const out = await pass(sampleResults()[0]!);
    const layer = sc(out).result.layers[0];
    expect(layer.text).toMatchObject({ redatto: true, lunghezza: "Il nuovo modello Rossi".length });
    expect(layer.expression).toMatchObject({ redatto: true, lunghezza: 11 });
    expect(sc(out).result.items[0].comment).toMatchObject({ redatto: true, lunghezza: 16 });
    expect(layer.name).toBe("Titolo");
    expect(text(out)).not.toContain("modello");
    expect(text(out)).not.toContain("wiggle");
  });

  it("redacts text.measure lines, dropdown items, valueText and xmp", async () => {
    privacyOn();
    const out = await pass(
      jsonResult({
        result: {
          text: "Riga uno\rRiga due",
          lines: [
            { index: 0, characterStart: 0, characterEnd: 8, text: "Riga uno" },
            { index: 1, characterStart: 9, characterEnd: 17, text: "Riga due" },
          ],
          valueText: "Opzione B",
          items: ["Opzione A", "Opzione B"],
          xmp: "<x:xmpmeta>autore</x:xmpmeta>",
          value: { __kind: "TextDocument", text: "Claim", fontSize: 40 },
        },
      }),
    );
    const r = sc(out).result;
    expect(r.lines[1]).toMatchObject({
      index: 1,
      characterEnd: 17,
      text: { redatto: true, lunghezza: 8 },
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ redatto: true, lunghezza: 9 });
    expect(r.valueText).toMatchObject({ redatto: true });
    expect(r.xmp).toMatchObject({ redatto: true });
    expect(r.value.text).toMatchObject({ redatto: true, lunghezza: 5 });
    expect(r.value.fontSize).toBe(40);
    expect(text(out)).not.toMatch(/Riga|Opzione|autore|Claim/);
  });

  it("leaves null, numbers and arrays of objects in those fields alone", async () => {
    privacyOn();
    const payload = { text: null, comment: 3, items: [{ id: 1, name: "Main" }] };
    const out = await pass(jsonResult(payload));
    expect(sc(out)).toEqual({ ok: true, ...payload });
  });

  it("re-opens only the fields the user allows from the environment", async () => {
    privacyOn("Rossi\n", "text, comment");
    const out = await pass(sampleResults()[0]!);
    const layer = sc(out).result.layers[0];
    // Re-opened, but still with words and paths filtered.
    expect(layer.text).toBe("Il nuovo modello [CLIENTE-1]");
    expect(sc(out).result.items[0].comment).toBe("consegna venerdì");
    expect(layer.expression).toMatchObject({ redatto: true });
  });

  it("cannot be re-opened by an argument", async () => {
    privacyOn();
    const out = await guardToolCall(
      "ae_do",
      {
        operation: "layer.info",
        allowFields: ["text"],
        privacy: false,
        AE_MCP_PRIVACY_ALLOW_FIELDS: "text",
      },
      async () => jsonResult({ text: "segreto" }),
    );
    expect(sc(out).text).toMatchObject({ redatto: true });
  });

  it("gives a redacted text back unchanged when the model passes the marker back", async () => {
    privacyOn();
    // expression.disable_all → expression.restore_all round-trips the texts.
    const disabled = await pass(
      jsonResult({ result: { manifest: [{ layer: 1, path: "/2/1", expr: "time*10" }] } }),
    );
    const marker = sc(disabled).result.manifest[0].expr;
    expect(marker).toMatchObject({ redatto: true, lunghezza: 7 });
    let seen: any;
    await guardToolCall(
      "ae_do",
      { operation: "expression.restore_all", args: { manifest: sc(disabled).result.manifest } },
      async (a) => {
        seen = a;
        return jsonResult({});
      },
    );
    expect(seen.args.manifest[0]).toEqual({ layer: 1, path: "/2/1", expr: "time*10" });
  });

  it("refuses a call carrying a redacted marker it cannot give back", async () => {
    privacyOn();
    let ran = false;
    const out = await guardToolCall(
      "ae_do",
      { operation: "text.set_content", args: { text: { redatto: true, lunghezza: 4 } } },
      async () => {
        ran = true;
        return jsonResult({});
      },
    );
    expect(ran).toBe(false);
    expect(out.isError).toBe(true);
    expect(sc(out).error.code).toBe("INVALID_ARGS");
  });
});

// ---------------------------------------------------------------------------

describe("operations and tools limited in privacy mode", () => {
  it("refuses ae_project_export_json without outPath before contacting AE", async () => {
    privacyOn();
    let ran = false;
    const out = await guardToolCall("ae_project_export_json", {}, async () => {
      ran = true;
      return jsonResult({});
    });
    expect(ran).toBe(false);
    expect(sc(out).error.code).toBe("FORBIDDEN");
    expect(sc(out).error.message).toContain("outPath");
  });

  it("allows ae_project_export_json with outPath and returns only the file name", async () => {
    privacyOn();
    const out = await guardToolCall(
      "ae_project_export_json",
      { outPath: "C:/Clienti/Rossi/p.json" },
      async () => jsonResult({ writtenTo: "C:/Clienti/Rossi/p.json", bytes: 10 }),
    );
    expect(sc(out).writtenTo).toBe("p.json");
  });

  it("denies project.get_xmp through the policy gate (catalog and ae_do agree)", async () => {
    privacyOn();
    const denial = denyOperation(getOp("project.get_xmp")!);
    expect(denial?.message).toContain("AE_MCP_PRIVACY");
    expect(denyOperation(getOp("project.set_xmp")!)).toBeNull();

    const transport = nullTransport();
    const res = await doTool.handler({ operation: "project.get_xmp" }, transport);
    expect(transport.calls).toHaveLength(0);
    expect(sc(res).error.code).toBe("FORBIDDEN");

    const catalog = await catalogTool.handler({ category: "project" }, nullTransport());
    expect(JSON.stringify(sc(catalog))).not.toContain("project.get_xmp");
  });

  it("keeps eval.run off even with AE_MCP_ENABLE_EVAL=1", () => {
    privacyOn();
    process.env.AE_MCP_ENABLE_EVAL = "1";
    expect(evalRunEnabled()).toBe(false);
    expect(denyOperation(getOp("eval.run")!)?.message).toContain("eval.run");
  });

  it("shows itself in policySummary", () => {
    privacyOn("Rossi\nBianchi\n", "comment");
    expect(policySummary()).toContain("privacy=ON");
    expect(policySummary()).toContain("words=2");
    expect(policySummary()).toContain("allowed=comment");
  });

  it("adds a privacy note to ae_context", async () => {
    privacyOn("Rossi\n");
    const out = await pass(jsonResult({ project: { file: "C:/a/Rossi/x.aep" } }), "ae_context");
    expect(sc(out).privacy).toMatchObject({ on: true, words: 1 });
    expect(text(out)).toContain('"privacy"');
    // Other tools do not get the note.
    const other = await pass(jsonResult({}), "ae_project_info");
    expect(sc(other).privacy).toBeUndefined();
  });
});

describe("dialogs", () => {
  const dialog = {
    pid: 4242,
    id: "655",
    text: "File mancanti:\nC:/Clienti/Rossi/logo.png",
    width: 400,
    height: 200,
    window: "Rossi_spot.aep - Adobe After Effects 2026",
  };

  it("withholds dialog text and window title, even when 'text' is re-opened", async () => {
    privacyOn(undefined, "text");
    const out = await pass(jsonResult({ result: { dialogs: [dialog] } }));
    const d = sc(out).result.dialogs[0];
    expect(d.text).toMatchObject({ redatto: true });
    expect(d.window).toMatchObject({ redatto: true });
    expect(d.id).toBe("655");
    expect(d.pid).toBe(4242);
  });

  it("scrubs the dialog text that DIALOG_OPEN messages quote", async () => {
    privacyOn();
    const message =
      "After Effects is showing a modal dialog, and no script can run until it is closed: " +
      `"File mancanti: C:/Clienti/Rossi/logo.png" (pid 4242 in "${dialog.window}", id 655) — retry`;
    const out = await pass(errorResult("DIALOG_OPEN", message, { details: { dialogs: [dialog] } }));
    const msg = sc(out).error.message as string;
    expect(msg).toContain("pid 4242");
    expect(msg).toContain("id 655");
    expect(msg).not.toMatch(/mancanti|logo|Rossi/);
    expect(text(out)).not.toMatch(/mancanti|logo|Rossi/);
  });

  it("withholds the text of a dismissed dialog", async () => {
    privacyOn();
    const out = await pass(
      jsonResult({ result: { dismissed: { id: "655", text: "Salvare le modifiche?" } } }),
    );
    expect(sc(out).result.dismissed.text).toMatchObject({ redatto: true });
  });
});

describe("image blocks", () => {
  it("drops image content and keeps the path in the text", async () => {
    privacyOn();
    const out = await pass({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, frames: ["C:/Clienti/Rossi/f1.png"] }, null, 2),
        },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      structuredContent: { ok: true, frames: ["C:/Clienti/Rossi/f1.png"] },
      isError: false,
    });
    expect(out.content.some((c) => c.type === "image")).toBe(false);
    expect(text(out)).toContain("f1.png");
    expect(text(out)).toContain("image");
    expect(sc(out).frames).toEqual(["C:/Clienti/Rossi/f1.png".split("/").pop()]);
  });
});

describe("failures in privacy mode", () => {
  it("turns a throwing handler into a filtered TRANSPORT error", async () => {
    privacyOn("Rossi\n");
    const out = await guardToolCall("ae_comp_info", {}, async () => {
      throw new Error("cannot read C:/Clienti/Rossi/spot.aep");
    });
    expect(out.isError).toBe(true);
    expect(sc(out).error.code).toBe("TRANSPORT");
    expect(sc(out).error.message).toBe("cannot read spot.aep");
    expect(sc(out).error.details).toEqual({ tool: "ae_comp_info" });
    expect(text(out)).not.toMatch(/Clienti|Rossi/);
  });

  it("refuses every call when the word list cannot be read (fails closed)", async () => {
    process.env.AE_MCP_PRIVACY = "1";
    process.env.AE_MCP_PRIVACY_WORDS = path.join(dir, "Rossi", "missing.txt");
    resetPrivacyForTests();
    let ran = false;
    const out = await guardToolCall("ae_catalog", {}, async () => {
      ran = true;
      return jsonResult({});
    });
    expect(ran).toBe(false);
    expect(sc(out).error.code).toBe("FORBIDDEN");
    expect(sc(out).error.message).toContain("missing.txt");
    expect(text(out)).not.toContain("Rossi");
    expect(policySummary()).toContain("UNREADABLE");
  });
});

describe("real tools through the guard", () => {
  it("filters ae_project_info fed by a canned After Effects answer", async () => {
    privacyOn("Rossi\n");
    const transport = nullTransport({
      result: {
        file: "C:/Clienti/Rossi/spot.aep",
        items: [{ id: 1, name: "Rossi_Main", comment: "nota", file: "C:/Footage/Rossi/a.mov" }],
      },
    });
    const out = await guardToolCall("ae_project_info", {}, (a) =>
      projectInfoTool.handler(a as any, transport),
    );
    const r = sc(out).result;
    expect(r.file).toBe("spot.aep");
    expect(r.items[0]).toMatchObject({
      name: "[CLIENTE-1]_Main",
      comment: { redatto: true },
      file: "a.mov",
    });
    expect(text(out)).not.toMatch(/Rossi|Clienti|Footage|nota/);
  });

  it("sends restored words to After Effects and labels them on the way back", async () => {
    privacyOn("Rossi\n");
    const transport = nullTransport({
      result: {
        result: { ok: true, name: "Rossi_Main" },
        context: { project: { file: "C:/x/Rossi/s.aep" } },
      },
    });
    const out = await guardToolCall(
      "ae_do",
      { operation: "comp.info", args: { comp: "[CLIENTE-1]_Main" } },
      (a) => doTool.handler(a as any, transport),
    );
    expect(transport.calls[0]!.code).toContain("Rossi_Main");
    expect(sc(out).result.name).toBe("[CLIENTE-1]_Main");
    expect(sc(out).context.project.file).toBe("s.aep");
  });
});
