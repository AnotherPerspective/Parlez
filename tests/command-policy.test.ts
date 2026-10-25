// Parlez! M3.3 — which menu commands `command.execute` may run: forbidden
// (always refused), allowed (no confirm), everything else (confirm: true).
// Table in, verdict out, all offline.

import { describe, expect, it } from "vitest";

import {
  ALLOWED_COMMANDS,
  FORBIDDEN_COMMANDS,
  FORBIDDEN_MENU_NAMES,
  commandVerdict,
} from "../src/command-policy.js";
import { getOp, jsxVal, wantsUndoGroup } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import { REDO_COMMAND_ID, UNDO_COMMAND_ID } from "../src/operations/command.js";
import "../src/operations/index.js";
import { nullTransport } from "./helpers/null-transport.js";

const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

const ids = (table: Readonly<Record<number, unknown>>): number[] => Object.keys(table).map(Number);

/** The ids command.list hands out — the only ids this repository knows. */
function commandListIds(): number[] {
  const jsx = getOp("command.list")!.toJsx({});
  return [...jsx.matchAll(/\{ id: (\d+), name: "/g)].map((m) => Number(m[1]));
}

async function execute(args: Record<string, unknown>) {
  const transport = nullTransport(OK_RESPONSE);
  const res = await doTool.handler({ operation: "command.execute", args }, transport);
  const error = (
    res.structuredContent as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      | undefined
  )?.error;
  return { res, error, calls: transport.calls };
}

describe("the three lists", () => {
  it("invents no ids: every listed id is in command.list or the 3973 fallback", () => {
    const known = new Set([...commandListIds(), 3973]);
    for (const id of [...ids(FORBIDDEN_COMMANDS), ...ids(ALLOWED_COMMANDS)]) {
      expect(known.has(id), String(id)).toBe(true);
    }
  });

  it("never puts an id in two lists", () => {
    const allowed = new Set(ids(ALLOWED_COMMANDS));
    for (const id of ids(FORBIDDEN_COMMANDS)) expect(allowed.has(id), String(id)).toBe(false);
  });

  it("gives every entry a name and a reason", () => {
    const entries = [
      ...Object.values(FORBIDDEN_COMMANDS),
      ...Object.values(ALLOWED_COMMANDS),
      ...FORBIDDEN_MENU_NAMES,
    ];
    for (const e of entries) {
      expect(e.name).toMatch(/\S/);
      expect(e.reason).toMatch(/\S{3,}/);
    }
  });

  it("keeps the command.list names next to their ids", () => {
    const jsx = getOp("command.list")!.toJsx({});
    for (const [id, entry] of [
      ...Object.entries(FORBIDDEN_COMMANDS),
      ...Object.entries(ALLOWED_COMMANDS),
    ]) {
      expect(jsx, id).toContain(`{ id: ${id}, name: "${entry.name}" }`);
    }
  });

  it("keeps Undo and Redo allowed, with the ids command.ts uses", () => {
    expect(ALLOWED_COMMANDS[UNDO_COMMAND_ID]?.name).toBe("Undo");
    expect(ALLOWED_COMMANDS[REDO_COMMAND_ID]?.name).toBe("Redo");
  });

  it("never lists a forbidden menu name as an allowed one", () => {
    const allowedNames = new Set(Object.values(ALLOWED_COMMANDS).map((e) => e.name));
    for (const e of FORBIDDEN_MENU_NAMES) expect(allowedNames.has(e.name), e.name).toBe(false);
  });
});

/** command id → expected verdict. Every id of command.list appears once. */
const TABLE: Array<[number, "forbidden" | "allowed" | "confirm"]> = [
  [16, "allowed"],
  [2004, "forbidden"],
  [2005, "allowed"],
  [2019, "forbidden"],
  [2025, "allowed"],
  [2028, "allowed"],
  [2030, "forbidden"],
  [2031, "forbidden"],
  [2035, "allowed"],
  [2040, "allowed"],
  [2055, "forbidden"],
  [2071, "forbidden"],
  [2072, "confirm"],
  [2078, "confirm"],
  [2156, "allowed"],
  [2157, "allowed"],
  [2158, "allowed"],
  [2243, "confirm"],
  [2349, "confirm"],
  [2371, "confirm"],
  [2450, "allowed"],
  [2501, "allowed"],
  [2691, "allowed"],
  [2732, "confirm"],
  [3101, "forbidden"],
  [10312, "allowed"],
  // not in command.list: everything unknown needs confirm
  [3973, "confirm"],
  [5, "confirm"],
  [999999, "confirm"],
];

describe("command id → verdict", () => {
  it("covers every id of command.list", () => {
    const tabled = new Set(TABLE.map(([id]) => id));
    for (const id of commandListIds()) expect(tabled.has(id), String(id)).toBe(true);
  });

  it.each(TABLE)("%i → %s", (id, kind) => {
    expect(commandVerdict(id).kind).toBe(kind);
  });

  it("treats a non-number id as needing confirm (validation rejects it before anyway)", () => {
    expect(commandVerdict("2040").kind).toBe("confirm");
  });
});

describe("ae_do command.execute", () => {
  const forbidden = TABLE.filter(([, k]) => k === "forbidden").map(([id]) => id);
  const allowed = TABLE.filter(([, k]) => k === "allowed").map(([id]) => id);
  const needsConfirm = TABLE.filter(([, k]) => k === "confirm").map(([id]) => id);

  it.each(forbidden)("refuses forbidden %i, even with confirm: true", async (id) => {
    for (const args of [{ id }, { id, confirm: true }]) {
      const { res, error, calls } = await execute(args);
      expect(res.isError).toBe(true);
      expect(error?.code).toBe("FORBIDDEN");
      expect(error?.details?.confirmRequired).toBe(false);
      expect(error?.message).toContain("vietato");
      expect(error?.message).toContain("confirm: true non cambia nulla");
      expect(calls).toHaveLength(0);
    }
  });

  it.each(allowed)("runs allowed %i without confirm", async (id) => {
    const { res, calls } = await execute({ id });
    expect(res.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each(needsConfirm)("asks confirm for %i, and runs it with confirm: true", async (id) => {
    const refused = await execute({ id });
    expect(refused.error?.code).toBe("FORBIDDEN");
    expect(refused.error?.details?.confirmRequired).toBe(true);
    expect(refused.error?.message).toContain(`comando di menu ${id}`);
    expect(refused.calls).toHaveLength(0);

    const confirmed = await execute({ id, confirm: true });
    expect(confirmed.res.isError).toBe(false);
    expect(confirmed.calls).toHaveLength(1);
  });

  it("keeps Undo / Redo outside the undo group, as before", async () => {
    for (const id of [UNDO_COMMAND_ID, REDO_COMMAND_ID]) {
      const { calls } = await execute({ id });
      expect(calls[0].undoGroup).toBe(false);
      expect(wantsUndoGroup(getOp("command.execute")!, { id })).toBe(false);
    }
  });
});

describe("the name check inside After Effects", () => {
  const op = () => getOp("command.execute")!;

  it("carries the forbidden menu names through jsxVal and refuses on a match", () => {
    const jsx = op().toJsx({ id: 2072 });
    expect(jsx).toContain(`var _blocked = ${jsxVal(FORBIDDEN_MENU_NAMES)};`);
    expect(jsx).toContain("app.findMenuCommandId(_blocked[_bi].name)");
    expect(jsx).toContain("if (_bid && _bid === 2072)");
    // The check must come before the command runs.
    expect(jsx.indexOf("findMenuCommandId")).toBeLessThan(jsx.indexOf("app.executeCommand"));
  });

  it("covers the commands whose ids are unknown here", () => {
    const names = FORBIDDEN_MENU_NAMES.map((e) => e.name);
    for (const name of ["New Project", "Open Project...", "Close Project", "Save", "Exit"]) {
      expect(names).toContain(name);
    }
  });

  it("leaves the Undo / Redo code exactly as it was", () => {
    for (const id of [UNDO_COMMAND_ID, REDO_COMMAND_ID]) {
      const jsx = op().toJsx({ id });
      expect(jsx).not.toContain("findMenuCommandId");
      expect(jsx).toContain(`app.executeCommand(${id});`);
    }
  });
});

describe("the read-only command operations", () => {
  it("stay read-only and ungated", () => {
    for (const name of ["command.find", "command.list"]) {
      const op = getOp(name)!;
      expect(op.readOnly).toBe(true);
      expect(op.destructive).toBeUndefined();
      expect(op.forbidden).toBeUndefined();
      expect(op.params.some((p) => p.name === "confirm")).toBe(false);
    }
  });
});
