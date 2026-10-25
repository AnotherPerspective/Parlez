// Parlez! M3.2 — the confirm gate for operations that delete, overwrite or
// rename. Every case here runs offline: the null transport records whether a
// call would have reached After Effects at all.

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIRM_RULES,
  DESTRUCTIVE_CONFIRM_PARAM,
  confirmCatalogInfo,
  denyUnconfirmed,
} from "../src/confirm-policy.js";
import { APP_CONFIG_CONFIRM_PARAM, getOp, listOps, type Operation } from "../src/registry.js";
import { catalogTool } from "../src/tools/catalog.js";
import { doTool } from "../src/tools/do.js";
import { projectImportTool } from "../src/tools/project-import.js";
import { saveProjectTool } from "../src/tools/save-project.js";
import "../src/operations/index.js";
// eval.run only enters the registry with AE_MCP_ENABLE_EVAL=1 at import time;
// import it directly so the "eval.run is untouched" check sees it.
import "../src/operations/eval.js";
import { nullTransport } from "./helpers/null-transport.js";

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
});

function structured(res: { structuredContent?: unknown }): Record<string, unknown> {
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

function errorOf(res: { structuredContent?: unknown }): {
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
} {
  return structured(res).error as never;
}

const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

/** The decisions in the brief, written out so any drift in the table fails here. */
const ALWAYS = [
  // the 19 of Fable, minus project.rename and command.execute (conditional)
  "comp.delete",
  "layer.delete",
  "project.clear",
  "project.delete_item",
  "project.new",
  "project.open",
  "project.reduce",
  "project.remove_unused_footage",
  "project.consolidate_footage",
  "render.clear_queue",
  "render.remove_item",
  "effect.remove",
  "mask.remove",
  "keyframe.remove",
  "marker.remove",
  "expression.remove",
  "property.remove",
  // the inventory's additions (eval.run left out on purpose)
  "comp.remove_guide",
  "egp.export_mogrt",
  "footage.replace",
  "footage.replace_with_solid",
  "footage.replace_with_placeholder",
  "instance.start",
  "instance.stop",
  "layer.remove_guide",
  "project.auto_fix_expressions",
  // Fable's decision: the six that "replace"
  "effect.set_dropdown_items",
  "egp.set_alternate_source",
  "layer.replace_source",
  "project.replace_font",
  "project.set_xmp",
  "text.paste_range",
].toSorted();

const CONDITIONAL = [
  "project.rename",
  "command.execute",
  "comp.set_props",
  "layer.set_props",
  "item.set_props",
  "keyframe.apply",
  "layer.set_visibility_schedule",
  "layer.split_groups",
  "layer.convert_to_shapes",
  "project.purge",
  "footage.set_proxy",
].toSorted();

const APP_CONFIG = [
  "font.set_favorites",
  "font.set_substitution",
  "font.set_default_for_script",
  "pref.set",
  "pref.delete",
  "pref.set_setting",
  "project.set_default_import_folder",
  "project.set_tool",
  "project.set_memory_limits",
  "project.set_multi_frame_rendering",
  "render.save_template",
].toSorted();

/** Smallest args that pass validation: every required param, typed. */
function minimalArgs(op: Operation): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    string: "x",
    number: 1,
    boolean: true,
    array: [],
    object: {},
    any: "x",
  };
  const args: Record<string, unknown> = {};
  for (const p of op.params) {
    if (p.required && p.name !== "confirm") args[p.name] = sample[p.type];
  }
  return args;
}

function gatedNames(kind: "always" | "conditional"): string[] {
  return listOps()
    .filter((op) => confirmCatalogInfo(op)?.required === kind)
    .map((op) => op.name)
    .toSorted();
}

describe("the confirm table", () => {
  it("names only operations that exist", () => {
    for (const name of Object.keys(CONFIRM_RULES)) {
      expect(getOp(name), name).toBeDefined();
    }
  });

  it("marks exactly the operations decided for 'always'", () => {
    expect(ALWAYS).toHaveLength(32);
    expect(gatedNames("always")).toEqual(ALWAYS);
  });

  it("marks exactly the operations decided for 'conditional'", () => {
    expect(gatedNames("conditional")).toEqual(CONDITIONAL);
  });

  it("leaves the 11 appConfig operations exactly as kumo had them", () => {
    const appConfig = listOps()
      .filter((op) => op.appConfig)
      .map((op) => op.name)
      .toSorted();
    expect(appConfig).toEqual(APP_CONFIG);
    for (const name of APP_CONFIG) {
      const op = getOp(name)!;
      expect(op.destructive, name).toBeUndefined();
      expect(
        op.params.filter((p) => p.name === "confirm"),
        name,
      ).toEqual([APP_CONFIG_CONFIRM_PARAM]);
    }
  });

  it("does not touch eval.run, which stays off by default instead", () => {
    const op = getOp("eval.run")!;
    expect(op.destructive).toBeUndefined();
    expect(op.params.some((p) => p.name === "confirm")).toBe(false);
  });

  it("injects one optional confirm param into every gated operation", () => {
    for (const name of [...ALWAYS, ...CONDITIONAL]) {
      const confirms = getOp(name)!.params.filter((p) => p.name === "confirm");
      expect(confirms, name).toEqual([DESTRUCTIVE_CONFIRM_PARAM]);
      expect(confirms[0].required).toBe(false);
    }
  });

  it("gives every gated operation a plain reason", () => {
    for (const name of [...ALWAYS, ...CONDITIONAL]) {
      expect(getOp(name)!.destructiveReason, name).toMatch(/\S{3,}/);
    }
  });

  it("leaves operations outside the table ungated", () => {
    for (const name of ["layer.create_solid", "keyframe.add", "comp.info", "batch.run"]) {
      const op = getOp(name)!;
      expect(confirmCatalogInfo(op), name).toBeNull();
      expect(
        op.params.some((p) => p.name === "confirm"),
        name,
      ).toBe(false);
    }
  });
});

describe("operations that always need confirm", () => {
  it.each(ALWAYS)("%s is refused without confirm, before contacting AE", async (name) => {
    const op = getOp(name)!;
    const transport = nullTransport(OK_RESPONSE);
    const res = await doTool.handler({ operation: name, args: minimalArgs(op) }, transport);
    expect(res.isError).toBe(true);
    const err = errorOf(res);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.details?.confirmRequired).toBe(true);
    expect(err.message).toContain(`'${name}'`);
    expect(err.message).toContain(op.destructiveReason!);
    expect(err.message).toContain("Non l'ho eseguita");
    expect(err.message).toContain("confirm: true");
    expect(err.hint).toContain("utente");
    expect(transport.calls).toHaveLength(0);
  });

  it.each(ALWAYS)("%s is refused with confirm: false too", async (name) => {
    const op = getOp(name)!;
    const transport = nullTransport(OK_RESPONSE);
    const res = await doTool.handler(
      { operation: name, args: { ...minimalArgs(op), confirm: false } },
      transport,
    );
    expect(errorOf(res).code).toBe("FORBIDDEN");
    expect(transport.calls).toHaveLength(0);
  });

  it.each(ALWAYS)("%s passes the gate with confirm: true", async (name) => {
    const op = getOp(name)!;
    const args = { ...minimalArgs(op), confirm: true };
    expect(denyUnconfirmed(op, args)).toBeNull();
    // Node-side operations (instance.start / stop) would really start or stop
    // After Effects; for them the gate decision above is the whole test.
    if (op.run) return;
    const transport = nullTransport(OK_RESPONSE);
    const res = await doTool.handler({ operation: name, args }, transport);
    expect(res.isError, JSON.stringify(structured(res))).toBe(false);
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects a confirm that is not a boolean as invalid arguments", async () => {
    const transport = nullTransport(OK_RESPONSE);
    const res = await doTool.handler(
      { operation: "layer.delete", args: { comp: "Main", layer: 1, confirm: "yes" } },
      transport,
    );
    expect(errorOf(res).code).toBe("INVALID_ARGS");
    expect(transport.calls).toHaveLength(0);
  });

  it("still lets read-only mode refuse first, whatever confirm says", async () => {
    process.env.AE_MCP_READONLY = "1";
    const transport = nullTransport(OK_RESPONSE);
    const res = await doTool.handler(
      { operation: "layer.delete", args: { comp: "Main", layer: 1, confirm: true } },
      transport,
    );
    expect(errorOf(res).code).toBe("FORBIDDEN");
    expect(errorOf(res).message).toContain("AE_MCP_READONLY");
    expect(transport.calls).toHaveLength(0);
  });
});

/** [operation, args, needs confirm?] — the arguments that make the difference. */
const CONDITIONAL_CASES: Array<[string, Record<string, unknown>, boolean]> = [
  ["comp.set_props", { comp: "Main", props: { name: "Nuovo" } }, true],
  ["comp.set_props", { comp: "Main", props: { duration: 5, name: "Nuovo" } }, true],
  ["comp.set_props", { comp: "Main", props: { duration: 5 } }, false],
  ["layer.set_props", { comp: "Main", layer: 1, props: { name: "Titolo" } }, true],
  ["layer.set_props", { comp: "Main", layer: "all", props: { enabled: false } }, false],
  ["item.set_props", { item: 3, name: "Nuovo" }, true],
  ["item.set_props", { item: 3, label: 4, comment: "ok" }, false],
  [
    "keyframe.apply",
    { comp: "Main", layer: 1, property: ["Transform", "Opacity"], keys: [], replace: true },
    true,
  ],
  [
    "keyframe.apply",
    { comp: "Main", layer: 1, property: ["Transform", "Opacity"], keys: [], replace: false },
    false,
  ],
  [
    "keyframe.apply",
    { comp: "Main", layer: 1, property: ["Transform", "Opacity"], keys: [] },
    false,
  ],
  ["layer.set_visibility_schedule", { comp: "Main", entries: [] }, true],
  ["layer.set_visibility_schedule", { comp: "Main", entries: [], mode: "opacity" }, true],
  ["layer.set_visibility_schedule", { comp: "Main", entries: [], mode: "inOut" }, false],
  ["layer.split_groups", { comp: "Main", layer: 1 }, true],
  ["layer.split_groups", { comp: "Main", layer: 1, keepOriginal: false }, true],
  ["layer.split_groups", { comp: "Main", layer: 1, keepOriginal: true }, false],
  ["layer.convert_to_shapes", { comp: "Main", layer: 1, removeSource: true }, true],
  ["layer.convert_to_shapes", { comp: "Main", layer: 1, removeFootage: true }, true],
  ["layer.convert_to_shapes", { comp: "Main", layer: 1 }, false],
  [
    "layer.convert_to_shapes",
    { comp: "Main", layer: 1, removeSource: false, stripSuffix: false },
    false,
  ],
  ["project.purge", {}, true],
  ["project.purge", { target: "all" }, true],
  ["project.purge", { target: "undo" }, true],
  ["project.purge", { target: "image" }, false],
  ["footage.set_proxy", { item: 3 }, true],
  ["footage.set_proxy", { item: 3, path: "C:/proxy.mov" }, false],
  ["footage.set_proxy", { item: 3, solidColor: [0, 0, 0] }, false],
  ["footage.set_proxy", { item: 3, placeholder: true }, false],
  ["footage.set_proxy", { item: 3, placeholder: false }, true],
  ["project.rename", { map: { a: "b" } }, true],
  ["project.rename", { map: { a: "b" }, dryRun: false }, true],
  ["project.rename", { map: { a: "b" }, dryRun: true }, false],
];

describe("operations that need confirm only with certain arguments", () => {
  it("covers every conditional operation except command.execute (see command-policy tests)", () => {
    const covered = new Set(CONDITIONAL_CASES.map(([name]) => name));
    expect([...covered, "command.execute"].toSorted()).toEqual(CONDITIONAL);
  });

  it.each(CONDITIONAL_CASES)("%s %j → confirm needed: %s", async (name, args, needed) => {
    const op = getOp(name)!;
    expect(denyUnconfirmed(op, args) !== null).toBe(needed);

    const transport = nullTransport(OK_RESPONSE);
    const res = await doTool.handler({ operation: name, args }, transport);
    if (needed) {
      expect(errorOf(res).code).toBe("FORBIDDEN");
      expect(errorOf(res).details?.confirmRequired).toBe(true);
      expect(transport.calls).toHaveLength(0);
    } else {
      expect(res.isError, JSON.stringify(structured(res))).toBe(false);
      expect(transport.calls).toHaveLength(1);
    }

    // With confirm: true every one of them goes through.
    const confirmed = nullTransport(OK_RESPONSE);
    const res2 = await doTool.handler(
      { operation: name, args: { ...args, confirm: true } },
      confirmed,
    );
    expect(res2.isError, JSON.stringify(structured(res2))).toBe(false);
    expect(confirmed.calls).toHaveLength(1);
  });

  it("says why, in the words of the specific case", () => {
    const rename = denyUnconfirmed(getOp("layer.set_props")!, {
      comp: "Main",
      layer: 1,
      props: { name: "x" },
    })!;
    expect(rename.message).toContain("rinomina");
    const replace = denyUnconfirmed(getOp("keyframe.apply")!, { replace: true })!;
    expect(replace.message).toContain("replace: true");
  });

  it("points project.rename at its dry run", () => {
    const denial = denyUnconfirmed(getOp("project.rename")!, { map: { a: "b" } })!;
    expect(denial.message).toContain("dryRun: true");
  });
});

describe("batch.run children", () => {
  const batch = () => getOp("batch.run")!;

  it("refuses an unconfirmed child and still runs its siblings", () => {
    const jsx = batch().toJsx({
      ops: [
        { operation: "layer.delete", args: { comp: "Main", layer: 1 } },
        { operation: "layer.create_null", args: { comp: "Main" } },
      ],
    });
    expect(jsx).toContain("'layer.delete' cancella uno o più livelli");
    expect(jsx).toContain("index: 0");
    // The sibling is generated as a real block, not rejected.
    expect(jsx).toContain("var _r1 = (function()");
    expect(jsx).not.toContain("var _r0 = (function()");
  });

  it("lets a child through on its own confirm only", () => {
    const jsx = batch().toJsx({
      ops: [
        { operation: "layer.delete", args: { comp: "Main", layer: 1, confirm: true } },
        { operation: "layer.delete", args: { comp: "Main", layer: 2 } },
      ],
    });
    expect(jsx).toContain("var _r0 = (function()");
    expect(jsx).not.toContain("var _r1 = (function()");
    expect(jsx.match(/serve una conferma/g)).toHaveLength(1);
  });

  it("applies the conditional rules to children as well", () => {
    const jsx = batch().toJsx({
      ops: [
        { operation: "layer.set_props", args: { comp: "Main", layer: 1, props: { name: "x" } } },
        { operation: "layer.set_props", args: { comp: "Main", layer: 1, props: { label: 2 } } },
      ],
    });
    expect(jsx).not.toContain("var _r0 = (function()");
    expect(jsx).toContain("var _r1 = (function()");
  });

  it("refuses a forbidden menu command in a child even with confirm", () => {
    const jsx = batch().toJsx({
      ops: [{ operation: "command.execute", args: { id: 2004, confirm: true } }],
    });
    expect(jsx).toContain("è vietato");
    expect(jsx).not.toContain("var _r0 = (function()");
  });

  it("runs a whole batch through ae_do without contacting AE for the refused child", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler(
      {
        operation: "batch.run",
        args: { ops: [{ operation: "comp.delete", args: { comp: "Main" } }] },
      },
      transport,
    );
    // The batch itself still runs (its other children could be fine); the
    // refused child is a fixed failure entry, never a comp.remove() call.
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].code).not.toContain(".remove()");
    expect(transport.calls[0].code).toContain("serve una conferma");
  });
});

describe("ae_catalog shows the gate", () => {
  type Detail = {
    name: string;
    confirm?: { required: string; reason?: string; allowedIds?: number[]; forbiddenIds?: number[] };
    params: Array<{ name: string; required: boolean }>;
  };

  async function category(name: string): Promise<Detail[]> {
    const res = await catalogTool.handler({ category: name }, nullTransport());
    return (structured(res) as { operations: Detail[] }).operations;
  }

  it("marks always / conditional / ungated operations", async () => {
    const layer = await category("layer");
    const byName = new Map(layer.map((d) => [d.name, d]));
    expect(byName.get("layer.delete")!.confirm).toEqual({
      required: "always",
      reason: "cancella uno o più livelli",
    });
    expect(byName.get("layer.set_props")!.confirm?.required).toBe("conditional");
    expect(byName.get("layer.set_props")!.confirm?.reason).toContain("name");
    expect(byName.get("layer.create_solid")!.confirm).toBeUndefined();
    const confirmParam = byName.get("layer.delete")!.params.find((p) => p.name === "confirm");
    expect(confirmParam).toMatchObject({ required: false });
  });

  it("lists the command ids for command.execute", async () => {
    const cmd = (await category("command")).find((d) => d.name === "command.execute")!;
    expect(cmd.confirm?.required).toBe("conditional");
    expect(cmd.confirm?.allowedIds).toContain(16);
    expect(cmd.confirm?.allowedIds).toContain(2450);
    expect(cmd.confirm?.forbiddenIds).toContain(2004);
  });

  it("names the gated operations in the overview", async () => {
    const res = await catalogTool.handler({}, nullTransport());
    const payload = structured(res) as { confirm: string; confirmRequired: string[] };
    expect(payload.confirm).toContain("confirm: true");
    expect(payload.confirmRequired.toSorted()).toEqual([...ALWAYS, ...CONDITIONAL].toSorted());
  });
});

describe("fixed tools", () => {
  it("ae_save_project refuses without confirm, before contacting AE", async () => {
    const transport = nullTransport(OK_RESPONSE);
    const res = await saveProjectTool.handler({}, transport);
    expect(res.isError).toBe(true);
    expect(errorOf(res).code).toBe("FORBIDDEN");
    expect(errorOf(res).details?.confirmRequired).toBe(true);
    expect(errorOf(res).message).toContain("confirm: true");
    expect(transport.calls).toHaveLength(0);

    const saveAs = nullTransport(OK_RESPONSE);
    await saveProjectTool.handler({ path: "C:/x.aep", confirm: false }, saveAs);
    expect(saveAs.calls).toHaveLength(0);
  });

  it("ae_save_project saves with confirm: true", async () => {
    const transport = nullTransport({ result: { ok: true, saved: true } });
    const res = await saveProjectTool.handler({ confirm: true }, transport);
    expect(res.isError).toBe(false);
    expect(transport.calls).toHaveLength(1);
  });

  const doc = { items: [] };

  it("ae_project_import_json needs confirm only with clearFirst", async () => {
    const refused = nullTransport(OK_RESPONSE);
    const res = await projectImportTool.handler(
      { json: doc, clearFirst: true, skipValidation: true },
      refused,
    );
    expect(errorOf(res).code).toBe("FORBIDDEN");
    expect(errorOf(res).details?.confirmRequired).toBe(true);
    expect(errorOf(res).hint).toContain("dryRun: true");
    expect(refused.calls).toHaveLength(0);

    const appended = nullTransport({ result: { ok: true } });
    await projectImportTool.handler({ json: doc, skipValidation: true }, appended);
    expect(appended.calls).toHaveLength(1);

    const confirmed = nullTransport({ result: { ok: true } });
    await projectImportTool.handler(
      { json: doc, clearFirst: true, skipValidation: true, confirm: true },
      confirmed,
    );
    expect(confirmed.calls).toHaveLength(1);
    expect(confirmed.calls[0].payload).toMatchObject({ opts: { clearFirst: true } });
  });

  it("ae_project_import_json lets a clearFirst dry run look without confirm", async () => {
    const transport = nullTransport(OK_RESPONSE);
    const res = await projectImportTool.handler(
      { json: doc, clearFirst: true, dryRun: true, skipValidation: true },
      transport,
    );
    expect(res.isError).toBe(false);
    expect(structured(res).dryRun).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });
});
