// Installing the switch panel (Parlez!, nome provvisorio): where it goes per
// platform and After Effects version, that it is a byte-for-byte copy of
// jsx/panel.jsx, and that install / status / uninstall agree. Everything runs
// against temp directories — the real After Effects profile is never touched.

import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aeProfileRoot } from "../src/agent-install.js";
import { runCli } from "../src/cli.js";
import { PANEL_FILENAME, PANEL_JSX } from "../src/config.js";
import {
  PANEL_MARKER,
  installPanel,
  panelInstallStatus,
  scriptUiPanelsDirFor,
  uninstallPanel,
} from "../src/panel-install.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-panel-install-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PANEL_SRC = readFileSync(PANEL_JSX, "utf8");

describe("where the panel goes", () => {
  it("targets <version>/Scripts/ScriptUI Panels next to the agent's Startup folder", () => {
    expect(scriptUiPanelsDirFor("/p", "26.5")).toBe(
      path.join("/p", "26.5", "Scripts", "ScriptUI Panels"),
    );
    const win = aeProfileRoot(
      "win32",
      { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      "C:\\Users\\me",
    );
    expect(scriptUiPanelsDirFor(win, "26.5")).toBe(
      path.join(
        "C:\\Users\\me\\AppData\\Roaming",
        "Adobe",
        "After Effects",
        "26.5",
        "Scripts",
        "ScriptUI Panels",
      ),
    );
    const mac = aeProfileRoot("darwin", {}, "/Users/me");
    expect(scriptUiPanelsDirFor(mac, "26.5")).toBe(
      path.join(
        "/Users/me",
        "Library",
        "Preferences",
        "Adobe",
        "After Effects",
        "26.5",
        "Scripts",
        "ScriptUI Panels",
      ),
    );
  });

  it("uses a provisional file name, which becomes its entry under Window", () => {
    expect(PANEL_FILENAME).toBe("Parlez (provvisorio).jsx");
  });

  it("starts with the marker uninstall-panel looks for", () => {
    expect(PANEL_SRC.startsWith(PANEL_MARKER)).toBe(true);
  });
});

/** A Windows profile rooted in this test's temp directory. */
const base = () => ({ platform: "win32" as const, env: { APPDATA: tmp }, home: tmp });
const root = () => aeProfileRoot("win32", { APPDATA: tmp }, tmp);

describe("install / status / uninstall", () => {
  it("copies jsx/panel.jsx into one version, then reports it up to date", async () => {
    await fs.mkdir(path.join(root(), "26.5"), { recursive: true });
    await fs.mkdir(path.join(root(), "25.0"), { recursive: true });

    const first = await installPanel({ ...base(), version: "26.5" });
    const target = path.join(scriptUiPanelsDirFor(root(), "26.5"), PANEL_FILENAME);
    expect(first).toEqual({ written: [target], unchanged: [] });
    expect(await fs.readFile(target, "utf8")).toBe(PANEL_SRC);

    expect(await installPanel({ ...base(), version: "26.5" })).toEqual({
      written: [],
      unchanged: [target],
    });

    const status = await panelInstallStatus(base());
    expect(status.map((s) => [s.version, s.installed, s.current])).toEqual([
      ["26.5", true, true],
      ["25.0", false, false],
    ]);

    // A copy from an older package is installed but stale.
    await fs.writeFile(target, `${PANEL_MARKER}\n// older\n`, "utf8");
    expect((await panelInstallStatus({ ...base(), version: "26.5" }))[0]).toMatchObject({
      installed: true,
      current: false,
    });

    expect(await uninstallPanel(base())).toEqual({ removed: [target], foreign: [] });
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("leaves a file with the same name that it did not write", async () => {
    const dir = path.join(tmp, "panels");
    await fs.mkdir(dir);
    const theirs = path.join(dir, PANEL_FILENAME);
    await fs.writeFile(theirs, "// someone else's script\n", "utf8");
    expect(await uninstallPanel({ dir })).toEqual({ removed: [], foreign: [theirs] });
    await expect(fs.readFile(theirs, "utf8")).resolves.toContain("someone else");
  });

  it("honours --dry-run and writes nothing", async () => {
    const dir = path.join(tmp, "custom-panels");
    const dry = await installPanel({ dir, dryRun: true });
    expect(dry.written).toEqual([path.join(dir, PANEL_FILENAME)]);
    await expect(fs.access(dir)).rejects.toThrow();

    await installPanel({ dir });
    const keep = await uninstallPanel({ dir, dryRun: true });
    expect(keep.removed).toHaveLength(1);
    await expect(fs.access(path.join(dir, PANEL_FILENAME))).resolves.toBeUndefined();
  });

  it("refuses to install where After Effects has never run", async () => {
    await expect(installPanel(base())).rejects.toThrow(/no After Effects version folder/);
  });
});

describe("cli", () => {
  it("lists the panel commands in its help", async () => {
    const lines: string[] = [];
    expect(await runCli(["help"], (l) => lines.push(l))).toBe(0);
    const help = lines.join("\n");
    for (const cmd of ["install-panel", "uninstall-panel", "panel-status"]) {
      expect(help).toContain(cmd);
    }
  });

  it("installs, reports, and removes through the three commands", async () => {
    const dir = path.join(tmp, "ScriptUI Panels");
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);

    expect(await runCli(["install-panel", "--dir", dir], out)).toBe(0);
    expect(lines[0]).toContain("wrote");
    expect(lines.join("\n")).toContain("Claude fermo");
    await expect(fs.access(path.join(dir, PANEL_FILENAME))).resolves.toBeUndefined();

    lines.length = 0;
    expect(await runCli(["panel-status", "--dir", dir], out)).toBe(0);
    expect(lines[0]).toMatch(/custom\s+installed\s/);

    lines.length = 0;
    expect(await runCli(["uninstall-panel", "--dir", dir], out)).toBe(0);
    expect(lines[0]).toContain("removed");

    lines.length = 0;
    expect(await runCli(["panel-status", "--dir", dir], out)).toBe(0);
    expect(lines[0]).toContain("not installed");

    lines.length = 0;
    expect(await runCli(["uninstall-panel", "--dir", dir], out)).toBe(0);
    expect(lines[0]).toBe("nothing to remove");
  });

  it("reports a folder that does not exist as not installed", async () => {
    const lines: string[] = [];
    const empty = path.join(tmp, "nowhere");
    expect(await runCli(["panel-status", "--dir", empty], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("not installed");
  });
});
