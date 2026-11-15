// Installing the "sveglia" (name provisional): the invisible CEP extension
// that gives the After Effects agent its beat from outside After Effects'
// scripting engine (cep/sveglia/sveglia.js says why).
//
// Like the Premiere panel it goes to the user-level CEP folder, so no
// administrator rights are needed:
//
//   Windows  %APPDATA%\Adobe\CEP\extensions\<bundle id>
//   macOS    ~/Library/Application Support/Adobe/CEP/extensions/<bundle id>
//
// Three files: the manifest (package version filled in), index.html and
// sveglia.js. An unsigned extension loads only with CEP's debug mode on
// (PlayerDebugMode = 1 under CSXS.<n>); this module only READS it and prints
// the command that switches it on. jsx/agent.jsx and jsx/panel.jsx look for
// this folder: with it they book no timer of their own at load.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { PACKAGE_ROOT } from "./config.js";
import {
  type CommandRunner,
  type DebugMode,
  cepExtensionsDir,
  debugModeCommand,
  readDebugMode,
} from "./premiere/install.js";

/** The folder name and bundle id (also written in jsx/agent.jsx and jsx/panel.jsx). */
export const SVEGLIA_BUNDLE_ID = "com.anotherperspective.parlez.sveglia";
export const SVEGLIA_SRC = path.join(PACKAGE_ROOT, "cep", "sveglia");
/** In the manifest: how uninstall knows a folder is ours. */
export const SVEGLIA_MARKER = 'ExtensionBundleId="com.anotherperspective.parlez.sveglia"';
/** CEP runtime of After Effects 2025 and 2026 (2024: 11). */
export const SVEGLIA_CSXS_MAJORS = [12, 11];

export interface SvegliaOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Install into exactly this folder instead of CEP/extensions/<bundle id>. */
  dir?: string;
  dryRun?: boolean;
  version?: string;
  src?: string;
}

async function packageVersion(): Promise<string> {
  const pkg = path.join(PACKAGE_ROOT, "package.json");
  return (JSON.parse(await fs.readFile(pkg, "utf8")) as { version: string }).version;
}

export function svegliaDir(opts: SvegliaOptions = {}): string {
  if (opts.dir) return path.resolve(opts.dir);
  return path.join(cepExtensionsDir(opts.platform, opts.env, opts.home), SVEGLIA_BUNDLE_ID);
}

/** Every file of the installed sveglia: relative path → content. */
export async function svegliaFiles(opts: SvegliaOptions = {}): Promise<Map<string, Buffer>> {
  const src = opts.src ?? SVEGLIA_SRC;
  const version = opts.version ?? (await packageVersion());
  const files = new Map<string, Buffer>();
  const manifest = (await fs.readFile(path.join(src, "CSXS", "manifest.xml"), "utf8")).replace(
    /PARLEZ_VERSION/g,
    version,
  );
  files.set(path.join("CSXS", "manifest.xml"), Buffer.from(manifest, "utf8"));
  for (const name of ["index.html", "sveglia.js"]) {
    files.set(name, await fs.readFile(path.join(src, name)));
  }
  return files;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export interface SvegliaStatus {
  dir: string;
  installed: boolean;
  current: boolean;
  stale: string[];
}

export async function svegliaStatus(opts: SvegliaOptions = {}): Promise<SvegliaStatus> {
  const dir = svegliaDir(opts);
  const stale: string[] = [];
  for (const [rel, content] of await svegliaFiles(opts)) {
    const actual = await readOrNull(path.join(dir, rel));
    if (actual === null || !actual.equals(content)) stale.push(rel);
  }
  const installed = (await readOrNull(path.join(dir, "CSXS", "manifest.xml"))) !== null;
  return { dir, installed, current: installed && stale.length === 0, stale };
}

export interface SvegliaInstallReport {
  dir: string;
  written: string[];
  unchanged: string[];
}

/** Write (or, on a dry run, list) every file that differs. */
export async function installSveglia(opts: SvegliaOptions = {}): Promise<SvegliaInstallReport> {
  const dir = svegliaDir(opts);
  const report: SvegliaInstallReport = { dir, written: [], unchanged: [] };
  for (const [rel, content] of await svegliaFiles(opts)) {
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

export interface SvegliaUninstallReport {
  dir: string;
  removed: boolean;
  /** The folder exists but its manifest is not ours: left alone. */
  foreign: boolean;
}

/** Remove the installed folder - only when its manifest says it is ours. */
export async function uninstallSveglia(opts: SvegliaOptions = {}): Promise<SvegliaUninstallReport> {
  const dir = svegliaDir(opts);
  const manifest = await readOrNull(path.join(dir, "CSXS", "manifest.xml"));
  if (manifest === null) {
    const there = (await fs.stat(dir).catch(() => null)) !== null;
    return { dir, removed: false, foreign: there };
  }
  if (!manifest.toString("utf8").includes(SVEGLIA_MARKER))
    return { dir, removed: false, foreign: true };
  if (!opts.dryRun) await fs.rm(dir, { recursive: true, force: true });
  return { dir, removed: true, foreign: false };
}

/** CEP's debug mode for After Effects 2025/2026 (CSXS.12), then 2024 (CSXS.11). */
export async function svegliaDebugMode(
  platform: NodeJS.Platform = process.platform,
  run?: CommandRunner,
): Promise<{ major: number; mode: DebugMode; command: string }> {
  const major = SVEGLIA_CSXS_MAJORS[0];
  const mode = await readDebugMode(major, platform, run);
  return { major, mode, command: debugModeCommand(major, platform) };
}
