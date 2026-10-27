// Installing the Parlez! panel: where it goes per
// platform and After Effects version, that it is a byte-for-byte copy of
// jsx/panel.jsx, and that install / status / uninstall agree. Everything runs
// against temp directories — the real After Effects profile is never touched.

import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aeProfileRoot } from "../src/agent-install.js";
import { runCli } from "../src/cli.js";
import {
  LEGACY_PANEL_FILENAMES,
  PANEL_FILENAME,
  PANEL_IMAGES_DIR,
  PANEL_JSX,
} from "../src/config.js";
import {
  PANEL_IMAGE_DIR_LINE,
  PANEL_MARKER,
  installPanel,
  panelSource,
  panelInstallStatus,
  scriptUiPanelsDirFor,
  uninstallPanel,
} from "../src/panel-install.js";

/** The first line of the build that installed «Parlez (provvisorio).jsx». */
const LEGACY_MARKER = "// Parlez! (nome provvisorio) - the switch inside After Effects.";

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

  it("is called Parlez!.jsx, which becomes its entry under Window", () => {
    expect(PANEL_FILENAME).toBe("Parlez!.jsx");
    expect(LEGACY_PANEL_FILENAMES).toEqual(["Parlez (provvisorio).jsx"]);
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
    expect(first).toEqual({ written: [target], unchanged: [], removedLegacy: [] });
    const written = await fs.readFile(target, "utf8");
    expect(written).toBe(await panelSource());
    // jsx/panel.jsx with the pictures' folder filled in, nothing else changed.
    expect(written).toContain(`var IMAGE_DIR = '${PANEL_IMAGES_DIR.replace(/\\/g, "/")}';`);
    expect(written.replace(/^ {4}var IMAGE_DIR = .*$/m, PANEL_IMAGE_DIR_LINE)).toBe(PANEL_SRC);

    expect(await installPanel({ ...base(), version: "26.5" })).toEqual({
      written: [],
      unchanged: [target],
      removedLegacy: [],
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

    expect(await uninstallPanel(base())).toEqual({
      removed: [target],
      removedLegacy: [],
      foreign: [],
    });
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("leaves a file with the same name that it did not write", async () => {
    const dir = path.join(tmp, "panels");
    await fs.mkdir(dir);
    const theirs = path.join(dir, PANEL_FILENAME);
    await fs.writeFile(theirs, "// someone else's script\n", "utf8");
    expect(await uninstallPanel({ dir })).toEqual({
      removed: [],
      removedLegacy: [],
      foreign: [theirs],
    });
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

  it("writes and finds a name with «!» in it", async () => {
    const dir = path.join(tmp, "ScriptUI Panels");
    await installPanel({ dir });
    expect(await fs.readdir(dir)).toEqual(["Parlez!.jsx"]);
    expect((await panelInstallStatus({ dir }))[0]).toMatchObject({
      installed: true,
      current: true,
    });
  });

  it("replaces a copy under the old name, and says so", async () => {
    const dir = path.join(tmp, "ScriptUI Panels");
    await fs.mkdir(dir);
    const old = path.join(dir, LEGACY_PANEL_FILENAMES[0]);
    await fs.writeFile(old, `${LEGACY_MARKER}\n// the first build\n`, "utf8");
    expect((await panelInstallStatus({ dir }))[0]).toMatchObject({
      installed: false,
      legacy: [old],
    });

    const dry = await installPanel({ dir, dryRun: true });
    expect(dry.removedLegacy).toEqual([old]);
    await expect(fs.access(old)).resolves.toBeUndefined();

    const report = await installPanel({ dir });
    expect(report.written).toEqual([path.join(dir, PANEL_FILENAME)]);
    expect(report.removedLegacy).toEqual([old]);
    expect(await fs.readdir(dir)).toEqual(["Parlez!.jsx"]);
  });

  it("uninstall removes the old name too, and leaves an old-named file that is not ours", async () => {
    const dir = path.join(tmp, "ScriptUI Panels");
    await installPanel({ dir });
    const old = path.join(dir, LEGACY_PANEL_FILENAMES[0]);
    await fs.writeFile(old, `${LEGACY_MARKER}\n`, "utf8");
    expect(await uninstallPanel({ dir })).toEqual({
      removed: [path.join(dir, PANEL_FILENAME)],
      removedLegacy: [old],
      foreign: [],
    });
    expect(await fs.readdir(dir)).toEqual([]);

    await fs.writeFile(old, "// someone else's\n", "utf8");
    expect(await uninstallPanel({ dir })).toEqual({
      removed: [],
      removedLegacy: [],
      foreign: [old],
    });
    await expect(fs.access(old)).resolves.toBeUndefined();
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

  it("tells about the old name in status and install", async () => {
    const dir = path.join(tmp, "ScriptUI Panels");
    await fs.mkdir(dir);
    const old = path.join(dir, LEGACY_PANEL_FILENAMES[0]);
    await fs.writeFile(old, `${LEGACY_MARKER}\n`, "utf8");
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);

    expect(await runCli(["panel-status", "--dir", dir], out)).toBe(0);
    expect(lines.join("\n")).toContain(`old name still present: ${old}`);

    lines.length = 0;
    expect(await runCli(["install-panel", "--dir", dir], out)).toBe(0);
    expect(lines.join("\n")).toContain(`removed  ${old} (old name)`);
    expect(lines.join("\n")).toContain("Window > Parlez!");
  });

  it("reports a folder that does not exist as not installed", async () => {
    const lines: string[] = [];
    const empty = path.join(tmp, "nowhere");
    expect(await runCli(["panel-status", "--dir", empty], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("not installed");
  });
});
