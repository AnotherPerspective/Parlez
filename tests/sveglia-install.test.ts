// The sveglia (provisional name, cep/sveglia): installed into the user's CEP
// extensions folder, recognised by its manifest, and named the same way in
// jsx/agent.jsx and jsx/panel.jsx, which look for it. Everything in a temp
// folder: the real CEP folder is never touched.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_JSX, PANEL_JSX } from "../src/config.js";
import {
  SVEGLIA_BUNDLE_ID,
  SVEGLIA_SRC,
  installSveglia,
  svegliaDebugMode,
  svegliaDir,
  svegliaStatus,
  uninstallSveglia,
} from "../src/sveglia-install.js";

let home: string;
const machine = () => ({
  platform: "win32" as const,
  env: { APPDATA: path.join(home, "Roaming") },
  home,
});

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "parlez-sveglia-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("install-sveglia", () => {
  it("goes to the user's CEP extensions folder, under its bundle id", () => {
    expect(svegliaDir(machine())).toBe(
      path.join(home, "Roaming", "Adobe", "CEP", "extensions", SVEGLIA_BUNDLE_ID),
    );
  });

  it("writes manifest (with the version), page and script; then is current", async () => {
    const report = await installSveglia({ ...machine(), version: "0.2.0" });
    expect(report.written.map((p) => path.relative(report.dir, p)).sort()).toEqual(
      [path.join("CSXS", "manifest.xml"), "index.html", "sveglia.js"].sort(),
    );
    const manifest = readFileSync(path.join(report.dir, "CSXS", "manifest.xml"), "utf8");
    expect(manifest).toContain('ExtensionBundleVersion="0.2.0"');
    expect(manifest).not.toContain("PARLEZ_VERSION");
    expect(manifest).toContain('<Host Name="AEFT"');
    expect(manifest).toContain("<AutoVisible>false</AutoVisible>");
    expect((await svegliaStatus({ ...machine(), version: "0.2.0" })).current).toBe(true);
    const again = await installSveglia({ ...machine(), version: "0.2.0" });
    expect(again.written).toEqual([]);
  });

  it("a dry run writes nothing", async () => {
    const report = await installSveglia({ ...machine(), version: "0.2.0", dryRun: true });
    expect(report.written).toHaveLength(3);
    expect((await svegliaStatus({ ...machine(), version: "0.2.0" })).installed).toBe(false);
  });

  it("uninstall removes only a folder whose manifest is ours", async () => {
    await installSveglia({ ...machine(), version: "0.2.0" });
    expect((await uninstallSveglia(machine())).removed).toBe(true);
    const dir = svegliaDir(machine());
    await fs.mkdir(path.join(dir, "CSXS"), { recursive: true });
    await fs.writeFile(path.join(dir, "CSXS", "manifest.xml"), "<ExtensionManifest/>", "utf8");
    const report = await uninstallSveglia(machine());
    expect(report).toMatchObject({ removed: false, foreign: true });
  });

  it("reads CEP's debug mode for CSXS.12, never writes it", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return "    PlayerDebugMode    REG_SZ    1\n";
    };
    const debug = await svegliaDebugMode("win32", run);
    expect(debug).toMatchObject({ major: 12, mode: "on" });
    expect(debug.command).toContain("reg add HKCU\\Software\\Adobe\\CSXS.12");
    expect(calls).toEqual([
      ["reg", "query", "HKCU\\Software\\Adobe\\CSXS.12", "/v", "PlayerDebugMode"],
    ]);
  });
});

describe("the sveglia and the rest agree", () => {
  it("agent.jsx and panel.jsx look for the same folder name", () => {
    expect(readFileSync(AGENT_JSX, "utf8")).toContain(`"${SVEGLIA_BUNDLE_ID}"`);
    expect(readFileSync(PANEL_JSX, "utf8")).toContain(`"${SVEGLIA_BUNDLE_ID}"`);
    expect(readFileSync(path.join(SVEGLIA_SRC, "CSXS", "manifest.xml"), "utf8")).toContain(
      `ExtensionBundleId="${SVEGLIA_BUNDLE_ID}"`,
    );
  });

  it("the page sends After Effects only fixed code, and goes nowhere on the network", () => {
    const js = readFileSync(path.join(SVEGLIA_SRC, "sveglia.js"), "utf8");
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|require\("(https?|net|dns|tls)"\)/);
    expect(js).toContain("cep.evalScript(PULSE");
    expect(js.match(/evalScript\(/g)).toHaveLength(1);
  });
});
