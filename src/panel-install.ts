// Installing the switch panel (Parlez!, nome provvisorio) into After Effects.
//
// After Effects lists every script in a "ScriptUI Panels" folder under its
// Window menu and lets it dock. The user-level folder sits next to the
// Startup folder install-agent uses (src/agent-install.ts), so it needs no
// admin rights either:
//
//   Windows  %APPDATA%\Adobe\After Effects\<major.minor>\Scripts\ScriptUI Panels
//   macOS    ~/Library/Preferences/Adobe/After Effects/<major.minor>/Scripts/ScriptUI Panels
//
// Derived the same way as the Startup folder, which kumo verified (Windows on
// AE 26.3, macOS on AE 26.5); that After Effects also reads ScriptUI Panels
// from there is not yet verified on a real installation.
//
// Unlike the agent, the panel is COPIED rather than loaded through a stub: a
// panel receives its dockable `Panel` as `this`, which `$.evalFile` from a
// stub would not pass on, and the panel needs nothing from the package at
// run time (it talks to the agent through $.global and app.settings). So a
// package update means running install-panel again; panel-status reports a
// copy that differs from this package's as stale.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { PANEL_FILENAME, PANEL_JSX } from "./config.js";
import {
  type InstallOptions,
  type InstallReport,
  type StubStatus,
  aeProfileRoot,
  listAeVersionDirs,
} from "./agent-install.js";

/**
 * A line every version of jsx/panel.jsx starts with. uninstall-panel removes
 * a file only when it carries it, so a user's own script that happens to
 * have the same name is left alone.
 */
export const PANEL_MARKER = "// Parlez! (nome provvisorio) - the switch inside After Effects.";

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

/** Same shape as the agent's: `stubPath` is where the panel file is (or would be). */
export async function panelInstallStatus(opts: InstallOptions = {}): Promise<StubStatus[]> {
  const expected = await panelSource();
  const statuses: StubStatus[] = [];
  for (const { version, dir } of await targetPanelDirs(opts)) {
    const stubPath = path.join(dir, PANEL_FILENAME);
    let installed = false;
    let current = false;
    try {
      const actual = await fs.readFile(stubPath, "utf8");
      installed = true;
      current = actual === expected;
    } catch {
      /* not installed */
    }
    statuses.push({ version, stubPath, installed, current });
  }
  return statuses;
}

/**
 * Copy jsx/panel.jsx into every target ScriptUI Panels folder, creating
 * Scripts/ScriptUI Panels where missing. As with the agent, a version folder
 * After Effects never created is not created here.
 */
export async function installPanel(opts: InstallOptions = {}): Promise<InstallReport> {
  const report: InstallReport = { written: [], unchanged: [] };
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
    try {
      if ((await fs.readFile(panelPath, "utf8")) === source) {
        report.unchanged.push(panelPath);
        continue;
      }
    } catch {
      /* absent — write it */
    }
    report.written.push(panelPath);
    if (opts.dryRun) continue;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(panelPath, source, "utf8");
  }
  return report;
}

export interface PanelUninstallReport {
  removed: string[];
  /** Files with the panel's name that this package did not write; left in place. */
  foreign: string[];
}

export async function uninstallPanel(opts: InstallOptions = {}): Promise<PanelUninstallReport> {
  const report: PanelUninstallReport = { removed: [], foreign: [] };
  for (const { dir } of await targetPanelDirs(opts)) {
    const panelPath = path.join(dir, PANEL_FILENAME);
    let text: string;
    try {
      text = await fs.readFile(panelPath, "utf8");
    } catch {
      continue;
    }
    if (!text.startsWith(PANEL_MARKER)) {
      report.foreign.push(panelPath);
      continue;
    }
    report.removed.push(panelPath);
    if (!opts.dryRun) await fs.unlink(panelPath);
  }
  return report;
}
