// Installing the Parlez! panel into After Effects.
//
// After Effects lists every script in a "ScriptUI Panels" folder under its
// Window menu and lets it dock. The user-level folder sits next to the
// Startup folder install-agent uses (src/agent-install.ts), so it needs no
// admin rights either:
//
//   Windows  %APPDATA%\Adobe\After Effects\<major.minor>\Scripts\ScriptUI Panels
//   macOS    ~/Library/Preferences/Adobe/After Effects/<major.minor>/Scripts/ScriptUI Panels
//
// Derived the same way as the Startup folder. Verified on AE 26.5 / Windows
// (2026-10-25: the panel shows under Window); macOS not yet.
//
// Unlike the agent, the panel is COPIED rather than loaded through a stub: a
// panel receives its dockable `Panel` as `this`, which `$.evalFile` from a
// stub would not pass on, and the panel needs nothing from the package at
// run time (it talks to the agent through $.global and app.settings). So a
// package update means running install-panel again; panel-status reports a
// copy that differs from this package's as stale.
//
// The file name is what After Effects shows under Window. Earlier builds used
// another one (LEGACY_PANEL_FILENAMES); install-panel and uninstall-panel
// remove such a copy — only when it is ours, by its first line — so the menu
// does not list the panel twice.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { LEGACY_PANEL_FILENAMES, PANEL_FILENAME, PANEL_JSX } from "./config.js";
import {
  type InstallOptions,
  type StubStatus,
  aeProfileRoot,
  listAeVersionDirs,
} from "./agent-install.js";

/**
 * The line jsx/panel.jsx starts with. A file is removed only when it starts
 * with this or an earlier build's marker, so a user's own script that
 * happens to have the same name is left alone.
 */
export const PANEL_MARKER = "// Parlez! - the switch inside After Effects.";
const LEGACY_PANEL_MARKERS = ["// Parlez! (nome provvisorio) - the switch inside After Effects."];

function isOurPanel(text: string): boolean {
  return [PANEL_MARKER, ...LEGACY_PANEL_MARKERS].some((marker) => text.startsWith(marker));
}

export function scriptUiPanelsDirFor(root: string, version: string): string {
  return path.join(root, version, "Scripts", "ScriptUI Panels");
}

export async function panelSource(panelJsx: string = PANEL_JSX): Promise<string> {
  return fs.readFile(panelJsx, "utf8");
}

async function targetPanelDirs(
  opts: InstallOptions,
): Promise<Array<{ version: string; dir: string }>> {
  if (opts.dir) return [{ version: "custom", dir: path.resolve(opts.dir) }];
  const root = aeProfileRoot(opts.platform, opts.env, opts.home);
  const versions = opts.version ? [opts.version] : await listAeVersionDirs(root);
  return versions.map((version) => ({ version, dir: scriptUiPanelsDirFor(root, version) }));
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Copies under an earlier name in `dir`: ours (removable) and not ours (left alone). */
async function legacyCopies(dir: string): Promise<{ ours: string[]; foreign: string[] }> {
  const found = { ours: [] as string[], foreign: [] as string[] };
  for (const name of LEGACY_PANEL_FILENAMES) {
    const file = path.join(dir, name);
    const text = await readOrNull(file);
    if (text === null) continue;
    (isOurPanel(text) ? found.ours : found.foreign).push(file);
  }
  return found;
}

export interface PanelStatus extends StubStatus {
  /** Copies under an earlier file name still in that folder (install-panel removes them). */
  legacy: string[];
}

/** Same shape as the agent's: `stubPath` is where the panel file is (or would be). */
export async function panelInstallStatus(opts: InstallOptions = {}): Promise<PanelStatus[]> {
  const expected = await panelSource();
  const statuses: PanelStatus[] = [];
  for (const { version, dir } of await targetPanelDirs(opts)) {
    const stubPath = path.join(dir, PANEL_FILENAME);
    const actual = await readOrNull(stubPath);
    statuses.push({
      version,
      stubPath,
      installed: actual !== null,
      current: actual === expected,
      legacy: (await legacyCopies(dir)).ours,
    });
  }
  return statuses;
}

export interface PanelInstallReport {
  /** Panel paths written (or that would be, on a dry run). */
  written: string[];
  /** Panel paths already up to date. */
  unchanged: string[];
  /** Copies under an earlier file name removed (or that would be). */
  removedLegacy: string[];
}

/**
 * Copy jsx/panel.jsx into every target ScriptUI Panels folder, creating
 * Scripts/ScriptUI Panels where missing, and remove our copies under an
 * earlier name. As with the agent, a version folder After Effects never
 * created is not created here.
 */
export async function installPanel(opts: InstallOptions = {}): Promise<PanelInstallReport> {
  const report: PanelInstallReport = { written: [], unchanged: [], removedLegacy: [] };
  const targets = await targetPanelDirs(opts);
  if (targets.length === 0) {
    throw new Error(
      `no After Effects version folder found under ${aeProfileRoot(opts.platform, opts.env, opts.home)} — ` +
        "launch After Effects once so it creates its profile, or pass --dir <Scripts/ScriptUI Panels folder>",
    );
  }
  const source = await panelSource();
  for (const { dir } of targets) {
    const panelPath = path.join(dir, PANEL_FILENAME);
    if ((await readOrNull(panelPath)) === source) {
      report.unchanged.push(panelPath);
    } else {
      report.written.push(panelPath);
      if (!opts.dryRun) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(panelPath, source, "utf8");
      }
    }
    for (const old of (await legacyCopies(dir)).ours) {
      report.removedLegacy.push(old);
      if (!opts.dryRun) await fs.unlink(old);
    }
  }
  return report;
}

export interface PanelUninstallReport {
  /** Panel files removed (current name). */
  removed: string[];
  /** Copies under an earlier file name removed. */
  removedLegacy: string[];
  /** Files with one of the panel's names that this package did not write; left in place. */
  foreign: string[];
}

export async function uninstallPanel(opts: InstallOptions = {}): Promise<PanelUninstallReport> {
  const report: PanelUninstallReport = { removed: [], removedLegacy: [], foreign: [] };
  for (const { dir } of await targetPanelDirs(opts)) {
    const panelPath = path.join(dir, PANEL_FILENAME);
    const text = await readOrNull(panelPath);
    if (text !== null) {
      if (isOurPanel(text)) {
        report.removed.push(panelPath);
        if (!opts.dryRun) await fs.unlink(panelPath);
      } else {
        report.foreign.push(panelPath);
      }
    }
    const legacy = await legacyCopies(dir);
    report.foreign.push(...legacy.foreign);
    for (const old of legacy.ours) {
      report.removedLegacy.push(old);
      if (!opts.dryRun) await fs.unlink(old);
    }
  }
  return report;
}
