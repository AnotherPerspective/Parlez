// Installing the Parlez! panel into Premiere Pro.
//
// The panel is a CEP extension. CEP loads extensions from a user-level
// folder, so no administrator rights are needed:
//
//   Windows  %APPDATA%\Adobe\CEP\extensions\<bundle id>
//   macOS    ~/Library/Application Support/Adobe/CEP/extensions/<bundle id>
//
// What is written there: the panel's page (index.html, panel.js,
// panel.css), its manifest with the package version filled in, the ON/OFF
// pictures shared with the After Effects panel, and a host stub
// (host/parlez-stub.jsx) that pins the mailbox and loads
// jsx/premiere-agent.jsx from the package - the same arrangement as After
// Effects' Startup stub (src/agent-install.ts): the agent's code is the
// package's, so the panel trusts exactly what the server trusts, and the
// mailbox is fixed at install time, never read from a pointer file.
//
// An unsigned panel loads only when CEP's "debug mode" is on for the user:
// PlayerDebugMode = 1 under CSXS.<n> (Windows registry, HKCU; macOS
// defaults). This module only READS it; the command that sets it is printed
// for the user to run. Verified on Premiere Pro 26.3.2 / Windows, where it
// was already on.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RUNTIME_DIR, RUNTIME_ROOT } from "../config.js";
import { jsxPath } from "../transport/launcher.js";
import {
  CEP_BUNDLE_ID,
  CEP_STUB_RELATIVE,
  MIN_PREMIERE_YEAR,
  PREMIERE_AGENT_JSX,
  PREMIERE_PANEL_IMAGES_SRC,
  PREMIERE_PANEL_SRC,
  csxsMajorForPremiereYear,
} from "./config.js";

export interface PremiereMachine {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Folder holding "Adobe Premiere Pro <year>" (Windows: Program Files\Adobe; macOS: /Applications). */
  applicationsDir?: string;
}

export interface PremiereInstall {
  year: number;
  appPath: string;
  supported: boolean;
}

function defaultApplicationsDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return path.join(env.ProgramFiles ?? "C:\\Program Files", "Adobe");
  return "/Applications";
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Premiere Pro installations found, newest first. */
export async function findPremiere(machine: PremiereMachine = {}): Promise<PremiereInstall[]> {
  const platform = machine.platform ?? process.platform;
  const env = machine.env ?? process.env;
  const dir = machine.applicationsDir ?? defaultApplicationsDir(platform, env);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: PremiereInstall[] = [];
  for (const name of names) {
    const m = /^Adobe Premiere Pro (\d{4})$/.exec(name);
    if (!m) continue;
    const year = Number(m[1]);
    const appPath =
      platform === "win32"
        ? path.join(dir, name, "Adobe Premiere Pro.exe")
        : path.join(dir, name, `${name}.app`);
    if (!(await exists(appPath))) continue;
    found.push({ year, appPath, supported: year >= MIN_PREMIERE_YEAR });
  }
  return found.sort((a, b) => b.year - a.year);
}

export function cepExtensionsDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Adobe", "CEP", "extensions");
  }
  return path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions");
}

export interface PanelInstallOptions extends PremiereMachine {
  /** Install into exactly this folder instead of CEP/extensions/<bundle id>. */
  dir?: string;
  dryRun?: boolean;
  /** Package version for the manifest; defaults to package.json's. */
  version?: string;
  /** Where the panel's sources are (tests). */
  panelSrc?: string;
  imagesSrc?: string;
  agentJsx?: string;
  mailbox?: string;
}

export function premierePanelDir(opts: PanelInstallOptions = {}): string {
  if (opts.dir) return path.resolve(opts.dir);
  return path.join(cepExtensionsDir(opts.platform, opts.env, opts.home), CEP_BUNDLE_ID);
}

/** The first line of the host stub: how uninstall knows a folder is ours. */
export const PREMIERE_STUB_MARKER = "// Parlez! for Premiere Pro - host stub.";

export function premiereStubSource(
  agentJsx: string = PREMIERE_AGENT_JSX,
  mailbox: string = RUNTIME_DIR,
  runtimeRoot: string = RUNTIME_ROOT,
): string {
  return [
    PREMIERE_STUB_MARKER,
    "// Written by `parlez setup`. Loads jsx/premiere-agent.jsx from the package, so a",
    "// package update takes effect the next time the panel opens. The mailbox below",
    "// is fixed here on purpose; run parlez setup again to change it.",
    "(function () {",
    `    var agentFile = new File(${jsxPath(agentJsx)});`,
    `    var runtimeRoot = ${jsxPath(runtimeRoot)};`,
    `    $.global.PARLEZ_PR_MAILBOX = ${jsxPath(mailbox)};`,
    "    if (!agentFile.exists) {",
    '        $.global.PARLEZ_PR_LOAD_ERROR = "missing " + agentFile.fsName;',
    "        return;",
    "    }",
    "    try {",
    "        $.evalFile(agentFile);",
    "    } catch (eLoad) {",
    "        try {",
    '            var why = (eLoad && eLoad.message) ? String(eLoad.message) : "unknown error";',
    '            if (eLoad && eLoad.line) why += " (line " + String(eLoad.line) + ")";',
    "            $.global.PARLEZ_PR_LOAD_ERROR = why;",
    "            var root = new Folder(runtimeRoot);",
    "            if (!root.exists) root.create();",
    '            var log = new File(runtimeRoot + "/premiere-fatal.log");',
    '            log.encoding = "UTF-8";',
    '            if (log.open("a")) {',
    '                log.writeln("[" + new Date().toString() + "] stub: could not load " + agentFile.fsName + ": " + why);',
    "                log.close();",
    "            }",
    "        } catch (eLog) { /* nothing left to try */ }",
    "    }",
    "})();",
    "",
  ].join("\n");
}

async function packageVersion(): Promise<string> {
  const pkg = path.join(PREMIERE_PANEL_SRC, "..", "..", "package.json");
  return (JSON.parse(await fs.readFile(pkg, "utf8")) as { version: string }).version;
}

/** The ON/OFF pictures the panel uses (the full-size set; the After Effects panel's small ones are not needed). */
const IMAGE_RE = /^(off|on|busy|idle)(-over|-down)?\.png$/;

/** Every file the installed panel consists of: relative path → content. */
export async function premierePanelFiles(
  opts: PanelInstallOptions = {},
): Promise<Map<string, Buffer>> {
  const src = opts.panelSrc ?? PREMIERE_PANEL_SRC;
  const images = opts.imagesSrc ?? PREMIERE_PANEL_IMAGES_SRC;
  const version = opts.version ?? (await packageVersion());
  const files = new Map<string, Buffer>();
  for (const name of ["index.html", "panel.css", "panel.js"]) {
    files.set(name, await fs.readFile(path.join(src, name)));
  }
  const manifest = (await fs.readFile(path.join(src, "CSXS", "manifest.xml"), "utf8")).replace(
    /PARLEZ_VERSION/g,
    version,
  );
  files.set(path.join("CSXS", "manifest.xml"), Buffer.from(manifest, "utf8"));
  for (const name of (await fs.readdir(images)).sort()) {
    if (IMAGE_RE.test(name))
      files.set(path.join("images", name), await fs.readFile(path.join(images, name)));
  }
  files.set(
    CEP_STUB_RELATIVE,
    Buffer.from(premiereStubSource(opts.agentJsx, opts.mailbox ?? RUNTIME_DIR), "utf8"),
  );
  return files;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export interface PremierePanelStatus {
  dir: string;
  installed: boolean;
  /** Every file matches this package's version of it. */
  current: boolean;
  /** Files that differ or are missing. */
  stale: string[];
}

export async function premierePanelStatus(
  opts: PanelInstallOptions = {},
): Promise<PremierePanelStatus> {
  const dir = premierePanelDir(opts);
  const files = await premierePanelFiles(opts);
  const stale: string[] = [];
  for (const [rel, content] of files) {
    const actual = await readOrNull(path.join(dir, rel));
    if (actual === null || !actual.equals(content)) stale.push(rel);
  }
  const installed = (await readOrNull(path.join(dir, "CSXS", "manifest.xml"))) !== null;
  return { dir, installed, current: installed && stale.length === 0, stale };
}

export interface PremierePanelInstallReport {
  dir: string;
  written: string[];
  unchanged: string[];
}

/** Write (or, on a dry run, list) every file of the panel that differs. */
export async function installPremierePanel(
  opts: PanelInstallOptions = {},
): Promise<PremierePanelInstallReport> {
  const dir = premierePanelDir(opts);
  const report: PremierePanelInstallReport = { dir, written: [], unchanged: [] };
  for (const [rel, content] of await premierePanelFiles(opts)) {
    const target = path.join(dir, rel);
    const actual = await readOrNull(target);
    if (actual !== null && actual.equals(content)) {
      report.unchanged.push(target);
      continue;
    }
    report.written.push(target);
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  return report;
}

export interface PremierePanelUninstallReport {
  dir: string;
  removed: boolean;
  /** The folder exists but is not ours (no Parlez! stub): left alone. */
  foreign: boolean;
}

/** Remove the installed panel folder - only when its host stub says it is ours. */
export async function uninstallPremierePanel(
  opts: PanelInstallOptions = {},
): Promise<PremierePanelUninstallReport> {
  const dir = premierePanelDir(opts);
  const stub = await readOrNull(path.join(dir, CEP_STUB_RELATIVE));
  if (stub === null) {
    const there = await exists(dir);
    return { dir, removed: false, foreign: there };
  }
  if (!stub.toString("utf8").startsWith(PREMIERE_STUB_MARKER)) {
    return { dir, removed: false, foreign: true };
  }
  if (!opts.dryRun) await fs.rm(dir, { recursive: true, force: true });
  return { dir, removed: true, foreign: false };
}

// --- CEP debug mode (lets the unsigned panel load) ------------------------

export type DebugMode = "on" | "off" | "unknown";

export type CommandRunner = (command: string, args: string[]) => Promise<string | null>;

const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });

/** Read PlayerDebugMode for CSXS.<major>. Never writes. */
export async function readDebugMode(
  major: number,
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = defaultRunner,
): Promise<DebugMode> {
  if (platform === "win32") {
    const out = await run("reg", [
      "query",
      `HKCU\\Software\\Adobe\\CSXS.${major}`,
      "/v",
      "PlayerDebugMode",
    ]);
    if (out === null) return "off";
    const m = /PlayerDebugMode\s+REG_\w+\s+(\S+)/i.exec(out);
    if (!m) return "off";
    return m[1] === "1" || m[1] === "0x1" ? "on" : "off";
  }
  if (platform === "darwin") {
    const out = await run("defaults", ["read", `com.adobe.CSXS.${major}`, "PlayerDebugMode"]);
    if (out === null) return "off";
    return out.trim() === "1" ? "on" : "off";
  }
  return "unknown";
}

/** The command the user runs to switch it on (printed, never run by Parlez!). */
export function debugModeCommand(
  major: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `reg add HKCU\\Software\\Adobe\\CSXS.${major} /v PlayerDebugMode /t REG_SZ /d 1 /f`;
  }
  return `defaults write com.adobe.CSXS.${major} PlayerDebugMode 1`;
}

export { csxsMajorForPremiereYear };
