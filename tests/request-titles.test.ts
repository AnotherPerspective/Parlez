// The plain-Italian names the Parlez! panel's history shows (request-titles.ts),
// and how they reach the agent: ae_do sends a batch's steps, the transport
// turns label and steps into the request's `title`.

import { describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import { describeRequest, knownTitles, titleFor } from "../src/request-titles.js";
import { doTool } from "../src/tools/do.js";
import { nullTransport } from "./helpers/null-transport.js";

const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

// Labels that are not operations: the static tools' and the Node-side steps'.
const NON_OPERATION_LABELS = new Set([
  "context",
  "project_info",
  "comp_info",
  "layer_info",
  "version_info",
  "render_frame",
  "save_project",
  "project_export_json",
  "project_import_json",
  "checkpoint.info",
  "checkpoint.save",
  "checkpoint.close",
  "checkpoint.open",
  "aerender.prep",
  // Registered only with AE_MCP_ENABLE_EVAL=1.
  "eval.run",
]);

describe("the table", () => {
  it("translates the reference examples", () => {
    expect(titleFor("layer.create_text")).toBe("crea livello di testo");
    expect(titleFor("render.frame")).toBe("renderizza fotogramma");
    expect(titleFor("render_frame")).toBe("renderizza fotogramma");
    expect(titleFor("checkpoint.create")).toBe("punto di ripristino");
    expect(titleFor("comp.audit")).toBe("controllo automatico");
  });

  it("shows an unknown name as it is", () => {
    expect(titleFor("shape.add_zigzag")).toBe("shape.add_zigzag");
  });

  it("only names things that exist: registered operations or known request labels", () => {
    for (const name of knownTitles()) {
      expect(getOp(name) !== undefined || NON_OPERATION_LABELS.has(name), name).toBe(true);
    }
  });
});

describe("a batch", () => {
  it("says how many steps and names the first three", () => {
    expect(
      describeRequest("batch.run", [
        "layer.create_text",
        "text.set_content",
        "effect.add",
        "layer.move",
      ]),
    ).toBe("lotto di 4 operazioni: crea livello di testo, modifica testo, aggiunge effetto…");
    expect(describeRequest("batch.run", ["layer.create_null"])).toBe(
      "lotto di 1 operazione: crea oggetto nullo",
    );
    expect(describeRequest("batch.run")).toBe("lotto di operazioni");
  });

  it("ae_do sends the steps by registered name only", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler(
      {
        operation: "batch.run",
        args: {
          ops: [
            { operation: "layer.create_null", args: { comp: "Main" } },
            { operation: "Rossi Spa secret plan", args: {} },
          ],
        },
      },
      transport,
    );
    expect(transport.calls[0].steps).toEqual(["layer.create_null", "?"]);
  });

  it("other operations send no steps", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "layer.create_null", args: { comp: "Main" } }, transport);
    expect(transport.calls[0].steps).toBeUndefined();
  });
});
