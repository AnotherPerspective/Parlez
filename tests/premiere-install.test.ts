// Installing the Parlez! panel for Premiere Pro, on a fake machine under a
// temp folder: what lands in the CEP extensions folder, how the status
// tells current from stale, what uninstall removes and what it leaves, and
// how CEP's debug mode is read (never written).

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CEP_BUNDLE_ID, CEP_STUB_RELATIVE, PREMIERE_AGENT_JSX } from "../src/premiere/config.js";
import {
  PREMIERE_STUB_MARKER,
  cepExtensionsDir,
  debugModeCommand,
  findPremiere,
  installPremierePanel,
  premierePanelDir,
  premierePanelStatus,
  premiereStubSource,
  readDebugMode,
  uninstallPremierePanel,
} from "../src/premiere/install.js";
import { readFileSync } from "node:fs";

let tmp: string;
let opts: { platform: "win32"; env: NodeJS.ProcessEnv; home: string };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-pr-install-"));
  opts = { platform: "win32", env: { APPDATA: path.join(tmp, "AppData", "Roaming") }, home: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PKG_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("where the panel goes", () => {
  it("is the user's CEP extensions folder, no administrator rights needed", () => {
    expect(
      cepExtensionsDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"),
    ).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "Adobe", "CEP", "extensions"));
    expect(cepExtensionsDir("darwin", {}, "/Users/me")).toBe(
      path.join("/Users/me", "Library", "Application Support", "Adobe", "CEP", "extensions"),
    );
    expect(premierePanelDir(opts)).toBe(
      path.join(tmp, "AppData", "Roaming", "Adobe", "CEP", "extensions", CEP_BUNDLE_ID),
    );
  });
});

describe("installing", () => {
  it("writes the page, the manifest with the package version, the pictures and the stub", async () => {
    const report = await installPremierePanel(opts);
    const dir = premierePanelDir(opts);
    const rel = report.written.map((p) => path.relative(dir, p).replace(/\\/g, "/")).sort();
    expect(rel).toContain("index.html");
    expect(rel).toContain("panel.js");
    expect(rel).toContain("panel.css");
    expect(rel).toContain("CSXS/manifest.xml");
    expect(rel).toContain("host/parlez-stub.jsx");
    expect(rel).toContain("images/off.png");
    expect(rel).toContain("images/on-over.png");
    // the After Effects panel's small pictures and signature are not needed
    expect(rel.some((r) => r.includes("small") || r.includes("firma"))).toBe(false);

    const manifest = await fs.readFile(path.join(dir, "CSXS", "manifest.xml"), "utf8");
    expect(manifest).toContain(`ExtensionBundleVersion="${PKG_VERSION}"`);
    expect(manifest).not.toContain("PARLEZ_VERSION");
    expect(manifest).toContain('<Host Name="PPRO"');
    // no Node.js inside the panel: nothing in it can touch files or the network on its own
    expect(manifest).not.toContain("--enable-nodejs");

    const stub = await fs.readFile(path.join(dir, CEP_STUB_RELATIVE), "utf8");
    expect(stub.startsWith(PREMIERE_STUB_MARKER)).toBe(true);
    expect(stub).toContain(PREMIERE_AGENT_JSX.replace(/\\/g, "/"));
    expect(stub).toContain("$.global.PARLEZ_PR_MAILBOX");
  });

  it("is current right after installing, stale after a file changes, current again after reinstalling", async () => {
    await installPremierePanel(opts);
    expect(await premierePanelStatus(opts)).toMatchObject({
      installed: true,
      current: true,
      stale: [],
    });

    await fs.writeFile(path.join(premierePanelDir(opts), "panel.js"), "// old", "utf8");
    const stale = await premierePanelStatus(opts);
    expect(stale.current).toBe(false);
    expect(stale.stale).toEqual(["panel.js"]);

    const again = await installPremierePanel(opts);
    expect(again.written.map((p) => path.basename(p))).toEqual(["panel.js"]);
    expect((await premierePanelStatus(opts)).current).toBe(true);
  });

  it("a dry run writes nothing", async () => {
    const report = await installPremierePanel({ ...opts, dryRun: true });
    expect(report.written.length).toBeGreaterThan(5);
    await expect(fs.access(premierePanelDir(opts))).rejects.toThrow();
    expect((await premierePanelStatus(opts)).installed).toBe(false);
  });

  it("the stub pins the mailbox it was given", () => {
    const stub = premiereStubSource(
      "/pkg/jsx/premiere-agent.jsx",
      "C:\\Temp\\mcp-aftereffects\\runtime",
    );
    expect(stub).toContain("$.global.PARLEZ_PR_MAILBOX = 'C:/Temp/mcp-aftereffects/runtime';");
    expect(stub).toContain("new File('/pkg/jsx/premiere-agent.jsx')");
  });
});

describe("uninstalling", () => {
  it("removes our folder", async () => {
    await installPremierePanel(opts);
    const report = await uninstallPremierePanel(opts);
    expect(report).toMatchObject({ removed: true, foreign: false });
    await expect(fs.access(premierePanelDir(opts))).rejects.toThrow();
  });

  it("leaves alone a folder with the same name that Parlez! did not write", async () => {
    const dir = premierePanelDir(opts);
    await fs.mkdir(path.join(dir, "host"), { recursive: true });
    await fs.writeFile(path.join(dir, CEP_STUB_RELATIVE), "// someone else's", "utf8");
    expect(await uninstallPremierePanel(opts)).toMatchObject({ removed: false, foreign: true });
    await expect(fs.access(path.join(dir, CEP_STUB_RELATIVE))).resolves.toBeUndefined();
  });

  it("says there is nothing to remove when nothing is installed", async () => {
    expect(await uninstallPremierePanel(opts)).toMatchObject({ removed: false, foreign: false });
  });
});

describe("finding Premiere Pro", () => {
  it("lists the installed years newest first and marks the ones Parlez! does not support", async () => {
    const apps = path.join(tmp, "Program Files", "Adobe");
    for (const year of [2023, 2026]) {
      const dir = path.join(apps, `Adobe Premiere Pro ${year}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "Adobe Premiere Pro.exe"), "", "utf8");
    }
    // a folder without the program is not an installation
    await fs.mkdir(path.join(apps, "Adobe Premiere Pro 2025"), { recursive: true });
    const found = await findPremiere({ platform: "win32", applicationsDir: apps });
    expect(found.map((p) => [p.year, p.supported])).toEqual([
      [2026, true],
      [2023, false],
    ]);
  });
});

describe("CEP debug mode", () => {
  it("reads it from the registry on Windows, without writing", async () => {
    const calls: string[][] = [];
    const on = await readDebugMode(12, "win32", async (cmd, args) => {
      calls.push([cmd, ...args]);
      return "\r\nHKEY_CURRENT_USER\\Software\\Adobe\\CSXS.12\r\n    PlayerDebugMode    REG_SZ    1\r\n";
    });
    expect(on).toBe("on");
    expect(calls).toEqual([
      ["reg", "query", "HKCU\\Software\\Adobe\\CSXS.12", "/v", "PlayerDebugMode"],
    ]);
    expect(await readDebugMode(12, "win32", async () => null)).toBe("off");
    expect(
      await readDebugMode(12, "win32", async () => "    PlayerDebugMode    REG_SZ    0\r\n"),
    ).toBe("off");
  });

  it("reads it with defaults on macOS", async () => {
    expect(await readDebugMode(12, "darwin", async () => "1\n")).toBe("on");
    expect(await readDebugMode(12, "darwin", async () => null)).toBe("off");
  });

  it("prints the command that switches it on", () => {
    expect(debugModeCommand(12, "win32")).toBe(
      "reg add HKCU\\Software\\Adobe\\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f",
    );
    expect(debugModeCommand(12, "darwin")).toBe(
      "defaults write com.adobe.CSXS.12 PlayerDebugMode 1",
    );
  });
});
