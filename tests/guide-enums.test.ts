// AE 26.5 changed the integers behind a guide's orientationType (Adobe's
// scripting changelog; seen on the first real 26.5 run: a "vertical" guide
// listed as "horizontal"). These tests RUN the generated guide code against
// small stand-ins for four kinds of After Effects, offline.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { XMP_EMPTY_NOTE } from "../src/operations/project.js";
import { getOp, jsxVal } from "../src/registry.js";
import "../src/operations/index.js";
import { lintJsxFile } from "./helpers/lint-jsx.js";

type Guide = { orientationType: number; position: number };

/**
 * A comp or layer that stores guides the way a given AE build does.
 * `make(value)` decides which orientation AE really creates for the number
 * it is given; `names` is what getEnumAsString answers (null = not available).
 */
function fakeAe(opts: {
  enumObject?: { HORIZONTAL: number; VERTICAL: number };
  names?: Record<number, string>;
  /** Value stored for what AE actually created, by the orientation it chose. */
  stored: { horizontal: number; vertical: number };
  /** Which orientation AE creates for the value passed to addGuide. */
  creates: (value: number) => "horizontal" | "vertical";
}) {
  const guides: Guide[] = [];
  const added: number[] = [];
  const owner = {
    guides,
    addGuide(value: number, position: number) {
      added.push(value);
      guides.push({ orientationType: opts.stored[opts.creates(value)], position });
      return guides.length - 1;
    },
    removeGuide(i: number) {
      guides.splice(i, 1);
    },
  };
  const AE = {
    findCompByNameOrId: () => owner,
    findLayerInComp: () => owner,
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
  const app = opts.names
    ? { getEnumAsString: (v: number) => (opts.names as Record<number, string>)[v] ?? String(v) }
    : {};
  const run = (code: string) =>
    // The generated body is plain ES3; running it is the point of the test.
    // oxlint-disable-next-line no-new-func
    new Function("AE", "app", "GuideOrientationType", code)(AE, app, opts.enumObject) as Record<
      string,
      unknown
    >;
  return { owner, added, run };
}

const OLD = {
  stored: { horizontal: 0, vertical: 1 },
  creates: (v: number) => (v === 1 ? ("vertical" as const) : ("horizontal" as const)),
};

/** A 26.5-like build that exposes the constants (values made up on purpose). */
const WITH_ENUM = {
  enumObject: { HORIZONTAL: 7101, VERTICAL: 7102 },
  stored: { horizontal: 7101, vertical: 7102 },
  creates: (v: number) => (v === 7102 ? ("vertical" as const) : ("horizontal" as const)),
};

/** A 26.5-like build with the integers swapped and only getEnumAsString to tell. */
const SWAPPED = {
  names: { 0: "GuideOrientationType.VERTICAL", 1: "GuideOrientationType.HORIZONTAL" },
  stored: { horizontal: 1, vertical: 0 },
  creates: (v: number) => (v === 0 ? ("vertical" as const) : ("horizontal" as const)),
};

/** A build where every number makes a horizontal guide. */
const STUCK = {
  names: { 0: "HORIZONTAL" },
  stored: { horizontal: 0, vertical: 0 },
  creates: () => "horizontal" as const,
};

const OPS = [
  ["comp", "comp.add_guide", "comp.list_guides", { comp: "Main" }],
  ["layer", "layer.add_guide", "layer.list_guides", { comp: "Main", layer: 1 }],
] as const;

describe.each(OPS)("%s guides", (_kind, addName, listName, target) => {
  const add = (orientation: string) =>
    getOp(addName)!.toJsx({ ...target, orientation, position: 200 });
  const list = () => getOp(listName)!.toJsx({ ...target });

  it("old After Effects: the old integers, as before", () => {
    const ae = fakeAe(OLD);
    expect(ae.run(add("vertical"))).toMatchObject({
      ok: true,
      guideIndex: 0,
      orientation: "vertical",
    });
    expect(ae.added).toEqual([1]);
    ae.run(add("horizontal"));
    expect(ae.added).toEqual([1, 0]);
    const listed = ae.run(list()) as { guides: Array<{ orientation: string; position: number }> };
    expect(listed.guides.map((g) => g.orientation)).toEqual(["vertical", "horizontal"]);
  });

  it("26.5 with GuideOrientationType: writes and reads the constants", () => {
    const ae = fakeAe(WITH_ENUM);
    expect(ae.run(add("vertical")).ok).toBe(true);
    expect(ae.run(add("horizontal")).ok).toBe(true);
    expect(ae.added).toEqual([7102, 7101]);
    const listed = ae.run(list()) as { guides: Array<{ orientation: string }> };
    expect(listed.guides.map((g) => g.orientation)).toEqual(["vertical", "horizontal"]);
  });

  it("26.5 with swapped integers: reads the enum name, retries, leaves one right guide", () => {
    const ae = fakeAe(SWAPPED);
    const res = ae.run(add("vertical"));
    expect(res).toMatchObject({ ok: true, guideIndex: 0, numGuides: 1, orientation: "vertical" });
    expect(ae.added).toEqual([1, 0]); // old integer first, removed, then the other one
    expect(ae.owner.guides).toHaveLength(1);
    const listed = ae.run(list()) as { guides: Array<{ orientation: string }> };
    expect(listed.guides[0].orientation).toBe("vertical");
  });

  it("a build where nothing gives a vertical guide: fails and leaves no guide behind", () => {
    const ae = fakeAe(STUCK);
    const res = ae.run(add("vertical"));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("instead of a vertical one");
    expect(ae.owner.guides).toHaveLength(0);
  });

  it("refuses an orientation that is neither horizontal nor vertical", () => {
    const code = add("diagonal");
    expect(code).toContain("orientation must be horizontal|vertical");
    expect(code).not.toContain("addGuide(");
  });

  it("embeds the arguments through jsxVal", () => {
    const code = getOp(addName)!.toJsx({ ...target, orientation: "vertical", position: 12.5 });
    expect(code).toContain(`var _want = ${jsxVal("vertical")};`);
    expect(code).toContain(`.addGuide(_cands[_ci], ${jsxVal(12.5)})`);
  });
});

describe("generated guide code is ES3", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "parlez-guides-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["comp.add_guide", { comp: "Main", orientation: "vertical", position: 1 }],
    ["comp.list_guides", { comp: "Main" }],
    ["layer.add_guide", { comp: "Main", layer: 1, orientation: "horizontal", position: 1 }],
    ["layer.list_guides", { comp: "Main", layer: 1 }],
  ] as Array<[string, Record<string, unknown>]>)("%s", (name, args) => {
    const file = path.join(dir, `${name}.jsx`);
    writeFileSync(file, getOp(name)!.toJsx(args));
    const errors = lintJsxFile(file).filter((f) => f.severity === "error");
    expect(errors.map((f) => `${f.rule}: ${f.text}`)).toEqual([]);
  });
});

describe("project.get_xmp hands back plain text", () => {
  const run = (xmpPacket: unknown) =>
    // oxlint-disable-next-line no-new-func
    new Function("app", "AE", getOp("project.get_xmp")!.toJsx({}))(
      { project: { xmpPacket } },
      { errText: (e: unknown) => String(e) },
    ) as {
      ok: boolean;
      xmp?: unknown;
      length?: number;
      xmpType?: string;
      error?: string;
      note?: string;
    };

  it("a primitive string comes back unchanged", () => {
    expect(run("<x:xmpmeta/>")).toEqual({
      ok: true,
      length: 12,
      xmp: "<x:xmpmeta/>",
      xmpType: "string",
    });
  });

  it("a String object becomes plain text (the serializer would turn it into an array or drop it)", () => {
    // oxlint-disable-next-line no-new-wrappers
    const res = run(new String("<x:xmpmeta/>"));
    expect(res.xmp).toBe("<x:xmpmeta/>");
    expect(typeof res.xmp).toBe("string");
    expect(res.length).toBe(12);
    expect(res.xmpType).toBe("object");
  });

  // Second 26.5 run: a fresh, never-saved project answered xmpType "undefined".
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
  ])(
    "no packet (%s) is an empty string with length 0 and a note, never a missing field",
    (_label, value) => {
      const res = run(value);
      expect(res).toEqual({
        ok: true,
        length: 0,
        xmp: "",
        xmpType: typeof value === "string" ? "string" : value === null ? "object" : "undefined",
        note: XMP_EMPTY_NOTE,
      });
      expect(res.note).toContain("salvalo una volta");
    },
  );

  it("a function is reported, not passed on as its source text", () => {
    const res = run(function () {});
    expect(res.ok).toBe(false);
    expect(res.xmpType).toBe("function");
  });
});
