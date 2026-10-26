// The `mutates` flag every request carries, which the Parlez! panel's
// "Sola lettura" switch goes by (jsx/serve.jsx): false exactly for what
// AE_MCP_READONLY would let through — read-only operations and the tools it
// keeps — and true for everything else, including what nobody marked.

import { describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { getOp, listOps } from "../src/registry.js";
import { readOnlyTransport } from "../src/transport/AeTransport.js";
import { transportForTool } from "../src/tools/define-tool.js";
import { doTool } from "../src/tools/do.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { nullTransport } from "./helpers/null-transport.js";

const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

describe("ae_do marks each call by its operation", () => {
  it("a mutating operation goes out as mutates: true", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "layer.create_null", args: { comp: "Main" } }, transport);
    expect(transport.calls[0].mutates).toBe(true);
  });

  it("a read-only operation goes out as mutates: false", async () => {
    const op = listOps().find(
      (o) => o.readOnly === true && !o.run && o.params.every((p) => !p.required),
    );
    expect(op, "no read-only ExtendScript operation without required params").toBeTruthy();
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: op!.name, args: {} }, transport);
    expect(transport.calls[0].mutates).toBe(false);
  });

  it("a read-only Node-side operation marks every call it makes", async () => {
    expect(getOp("checkpoint.list")?.readOnly).toBe(true);
    const transport = nullTransport({ result: { ok: true, file: null } });
    await doTool.handler({ operation: "checkpoint.list", args: {} }, transport);
    expect(transport.calls.length).toBeGreaterThan(0);
    expect(transport.calls.every((c) => c.mutates === false)).toBe(true);
  });
});

describe("static tools", () => {
  it("those AE_MCP_READONLY keeps get a transport that marks calls mutates: false", async () => {
    for (const tool of ALL_TOOLS) {
      const inner = nullTransport();
      await transportForTool(tool, inner).execute({ code: "return 1;" });
      const expected = tool.blockedInReadOnly || tool.name === "ae_do" ? undefined : false;
      expect(inner.calls[0].mutates, tool.name).toBe(expected);
    }
  });

  it("readOnlyTransport keeps describeTarget and close", async () => {
    const inner = {
      ...nullTransport(),
      describeTarget: async () => ({ mode: "push" as const }),
      close: async () => {},
    };
    const wrapped = readOnlyTransport(inner);
    expect(await wrapped.describeTarget!()).toEqual({ mode: "push" });
    expect(typeof wrapped.close).toBe("function");
  });
});
