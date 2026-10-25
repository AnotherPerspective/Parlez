// End-to-end checks for the M6.3 animation helpers (Parlez!): what After
// Effects actually stores after keyframe.apply_ease, layer.stagger and
// expression.apply_template. The offline suite (tests/motion.test.ts) runs the
// same generated code against stand-ins; only a real After Effects can say
// whether KeyframeEase, startTime and expressions behave as the stand-ins do.
//
// SESSION-MUTATING: closes the project currently open in After Effects, swaps
// in a disposable fixture, and restores the original afterwards. Requires
// AE_MCP_E2E=1 on top of AE being reachable. Not run by the M6.3 session.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { easeToAe, getEase } from "../../src/easing.js";
import { renderTemplate } from "../../src/expression-templates.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  backupAndOpenTestProject,
  buildFixtureProject,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;
let ops: ReturnType<typeof opRunner> | null = null;

type Ease = { speed: number; influence: number };

function o(): ReturnType<typeof opRunner> {
  if (!ops) throw new Error("suite not ready");
  return ops;
}

/** Read state directly, not through the operations under test. */
async function probe<T>(code: string): Promise<T> {
  const res = await transport!.execute({ code, label: "e2e_motion_probe", timeoutMs: 30_000 });
  if (!res.ok) throw new Error("state probe failed: " + res.error);
  return res.result as T;
}

const easeProbe = (prop: string) => `
  var l = AE.findLayerInComp(AE.findCompByNameOrId("test_comp"), "blue_layer");
  var p = l.property("Transform").property(${JSON.stringify(prop)});
  function list(arr) { var o = []; for (var i = 0; i < arr.length; i++) o.push({ speed: arr[i].speed, influence: arr[i].influence }); return o; }
  return { out1: list(p.keyOutTemporalEase(1)), in2: list(p.keyInTemporalEase(2)), numKeys: p.numKeys };
`;

describe("e2e motion helpers", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("motion", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
      ]);
      return;
    }
    const probeResult = await probeAe("motion");
    if (!probeResult.ready || !probeResult.transport) return;
    transport = probeResult.transport;
    saved = await backupAndOpenTestProject(transport);
    await buildFixtureProject(transport);
    ops = opRunner(transport);
    ready = true;
  }, 180_000);

  afterAll(async () => {
    if (transport && saved) await restoreUserProject(transport, saved);
  });

  it("keyframe.apply_ease stores the converted speed and influence (1-D)", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("keyframe.apply_ease", {
      comp: "test_comp",
      layer: "blue_layer",
      property: ["Transform", "Opacity"],
      keys: [
        { time: 0, value: 0 },
        { time: 0.48, value: 100, curve: "material-emphasized-decelerate" },
      ],
    });
    const got = await probe<{ out1: Ease[]; in2: Ease[] }>(easeProbe("Opacity"));
    expect(got.out1[0].influence).toBeCloseTo(5, 3);
    // AE stores the key time on a frame of the 29.97 fps fixture: allow 1 %.
    expect(got.out1[0].speed / 2916.67).toBeGreaterThan(0.98);
    expect(got.out1[0].speed / 2916.67).toBeLessThan(1.02);
    expect(got.in2[0]).toMatchObject({
      influence: expect.closeTo(90, 3),
      speed: expect.closeTo(0, 6),
    });
  });

  it("keyframe.apply_ease keeps a still Scale dimension still", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("keyframe.apply_ease", {
      comp: "test_comp",
      layer: "blue_layer",
      property: ["Transform", "Scale"],
      keys: [
        { time: 0, value: [100, 100] },
        { time: 1, value: [200, 100], curve: "ease-in-cubic" },
      ],
    });
    const got = await probe<{ in2: Array<{ speed: number }> }>(easeProbe("Scale"));
    const factor = easeToAe(getEase("ease-in-cubic")!)!.in.speedFactor;
    expect(got.in2[0].speed).toBeCloseTo(factor * 100, 1);
    expect(got.in2[1].speed).toBeCloseTo(0, 6);
  });

  it("layer.stagger mode 'start' moves the second layer by the step", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ stepSeconds: number }>("layer.stagger", {
      comp: "test_comp",
      layers: ["red_layer", "blue_layer"],
      step: 3,
      unit: "frames",
      mode: "start",
    });
    const got = await probe<{ red: number; blue: number }>(`
      var c = AE.findCompByNameOrId("test_comp");
      return { red: AE.findLayerInComp(c, "red_layer").startTime, blue: AE.findLayerInComp(c, "blue_layer").startTime };
    `);
    expect(got.blue - got.red).toBeCloseTo(res.stepSeconds, 6);
    expect(res.stepSeconds).toBeCloseTo(3 / 29.97, 4);
  });

  it("expression.apply_template writes the rendered text, and replaces it only with confirm", async (ctx) => {
    if (!ready) return ctx.skip();
    const rendered = renderTemplate("wiggle", { frequency: 3 });
    if (!rendered.ok) throw new Error(rendered.error);
    const args = {
      comp: "test_comp",
      layer: "blue_layer",
      property: ["Transform", "Rotation"],
      template: "wiggle",
      params: { frequency: 3 },
    };
    const first = await o().run<{ expressionError: string }>("expression.apply_template", args);
    expect(first.expressionError).toBe("");
    const text = await probe<{ e: string }>(`
      var l = AE.findLayerInComp(AE.findCompByNameOrId("test_comp"), "blue_layer");
      return { e: l.property("Transform").property("Rotation").expression };
    `);
    expect(text.e).toBe(rendered.expression);
    await o().expectRefusal("expression.apply_template", {
      ...args,
      template: "loopCycle",
      params: {},
    });
    await o().run("expression.apply_template", {
      ...args,
      template: "loopCycle",
      params: {},
      confirm: true,
    });
  });
});
