// `parlez setup` and `parlez doctor` (nomi provvisori): the one command a
// motion designer runs after installing the package, and the check that
// tells them what is still missing.
//
// setup, in order: find the After Effects installed on this machine, install
// the resident agent (Scripts/Startup) and the Parlez! panel (Scripts/ScriptUI
// Panels) for the chosen version(s), read the "Allow Scripts to Write Files
// and Access Network" checkbox from After Effects' prefs file, print the
// configuration for Claude Code and Claude Desktop, then run the doctor.
//
// It writes ONLY inside After Effects' user-level profile folders, through
// installAgent / installPanel. The Claude configuration is printed, never
// written: those files belong to other programs. The doctor writes nothing.
//
// Language: Italian unless --lang en. Not the system language on purpose:
// the printed menu paths must match After Effects' own language, and on the
// PC Parlez! was tested on Windows reports English (en-150) while After
// Effects runs in Italian. A fixed default plus one flag is predictable.

import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  agentInstallStatus,
  aeProfileRoot,
  anyAgentInstalled,
  installAgent,
  listAeVersionDirs,
  type InstallOptions,
} from "./agent-install.js";
import { INSTANCES_DIR, PACKAGE_ROOT, PULL_ONLY_ENV, pushPathName } from "./config.js";
import { installPanel, panelInstallStatus } from "./panel-install.js";
import { isPaused, isReadOnly, instanceLabel, listInstances } from "./transport/instances.js";

export type Lang = "it" | "en";

/** Oldest After Effects Parlez! supports (decision of 25/10/2026). */
export const MIN_AE_YEAR = 2024;

/** Node major the package declares in `engines` (Node 22 not tried yet). */
export const MIN_NODE_MAJOR = 24;

/** Where the machine's facts come from. Every field defaults to the real one; tests pass fakes. */
export interface SetupEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Folder holding "Adobe After Effects <year>" (Windows: Program Files\Adobe; macOS: /Applications). */
  applicationsDir?: string;
  nodeVersion?: string;
  /** Where this package is installed: decides how Claude should start it. */
  packageRoot?: string;
  /** The Node running this command: Claude is told to start the server with the same one. */
  execPath?: string;
  instancesDir?: string;
  now?: number;
  lang?: Lang;
  /** Asks a yes/no question. Default: on a terminal, ask; otherwise answer no. */
  confirm?: (question: string) => Promise<boolean>;
}

export interface SetupOptions {
  /** One After Effects profile folder, e.g. "26.5". */
  version?: string;
  /** Every supported After Effects found, without asking. */
  all?: boolean;
  dryRun?: boolean;
}

export function detectLang(flag?: string): Lang {
  return flag === "en" ? "en" : "it";
}

// --- Finding After Effects -----------------------------------------------------

export interface AeInstall {
  year: number;
  /** The major version its profile folders start with (2026 → 26). */
  major: number | null;
  appPath: string;
  /** Newest profile folder of that major ("26.5"), or null if it was never launched. */
  profileVersion: string | null;
  supported: boolean;
}

/** After Effects 2022 onwards is numbered after the year; the two before were 17 and 18. */
function majorForYear(year: number): number | null {
  if (year >= 2022) return year - 2000;
  return ({ 2020: 17, 2021: 18 } as Record<number, number>)[year] ?? null;
}

function defaultApplicationsDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return "/Applications";
  return path.join(env.ProgramFiles ?? "C:\\Program Files", "Adobe");
}

function appPathFor(platform: NodeJS.Platform, folder: string, year: number): string {
  return platform === "darwin"
    ? path.join(folder, `Adobe After Effects ${year}.app`)
    : path.join(folder, "Support Files", "AfterFX.exe");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The After Effects installed here, newest first, each with the profile
 * folder it uses. Profile folders outlive uninstalled versions (a PC that had
 * After Effects 2020 still has 17.5), so the install folders decide what is
 * installed and the profile folders only which minor version it runs.
 */
export async function findAfterEffects(machine: SetupEnvironment = {}): Promise<AeInstall[]> {
  const platform = machine.platform ?? process.platform;
  const env = machine.env ?? process.env;
  const home = machine.home ?? os.homedir();
  const appsDir = machine.applicationsDir ?? defaultApplicationsDir(platform, env);

  const byYear = new Map<number, string>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(appsDir);
  } catch {
    /* no such folder: nothing installed there */
  }
  for (const name of entries) {
    const match = /^Adobe After Effects (\d{4})$/.exec(name);
    if (!match) continue;
    const year = Number(match[1]);
    const app = appPathFor(platform, path.join(appsDir, name), year);
    if (await exists(app)) byYear.set(year, app);
  }
  // An install outside the standard folder, named the way the transport is told about it.
  for (const override of [env.AE_MCP_EXE, env.AE_EXE]) {
    const match = override ? /After Effects (\d{4})/.exec(override) : null;
    if (override && match && !byYear.has(Number(match[1])) && (await exists(override))) {
      byYear.set(Number(match[1]), override);
    }
  }

  const profiles = await listAeVersionDirs(aeProfileRoot(platform, env, home));
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, appPath]) => {
      const major = majorForYear(year);
      const profileVersion =
        major === null ? null : (profiles.find((v) => Number(v.split(".")[0]) === major) ?? null);
      return { year, major, appPath, profileVersion, supported: year >= MIN_AE_YEAR };
    });
}

// --- The scripting checkbox ----------------------------------------------------

export type ScriptingPref = "on" | "off" | "unknown";

/**
 * After Effects keeps the checkbox in <profile>/<version>/Adobe After Effects
 * <version> Prefs.txt and rewrites the file as soon as the box is clicked
 * (seen on 26.5 / Windows, 2026-10-25). On macOS the profile folder is
 * ~/Library/Preferences/Adobe/After Effects/<version> (Adobe's preferences
 * page); the file name inside it is assumed the same — not verified.
 */
export function prefsFileFor(profileRoot: string, version: string): string {
  return path.join(profileRoot, version, `Adobe After Effects ${version} Prefs.txt`);
}

const SCRIPTING_PREF = /"Pref_SCRIPTING_FILE_NETWORK_SECURITY"\s*=\s*"?(\d)"?/;

/**
 * The main prefs file first, then the version's other prefs files
 * ("… Prefs-indep-general.txt" and the like): should a Mac build keep the
 * key elsewhere, the doctor still finds it instead of asking for a hand check.
 */
async function prefsFilesFor(profileRoot: string, version: string): Promise<string[]> {
  const main = prefsFileFor(profileRoot, version);
  const dir = path.dirname(main);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    /* no folder: the main file will not be found either */
  }
  const prefix = `Adobe After Effects ${version} Prefs`;
  const others = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".txt") && n !== path.basename(main))
    .map((n) => path.join(dir, n));
  return [main, ...others];
}

export async function readScriptingPref(
  profileRoot: string,
  version: string,
): Promise<ScriptingPref> {
  for (const file of await prefsFilesFor(profileRoot, version)) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const match = SCRIPTING_PREF.exec(text);
    if (match) return match[1] === "1" ? "on" : "off";
  }
  return "unknown";
}

// --- The Claude configuration --------------------------------------------------

export interface ClaudeConfig {
  command: string;
  args: string[];
  /** The `claude mcp add` line for Claude Code. */
  claudeCode: string;
  /** The block for claude_desktop_config.json. */
  desktopJson: string;
  desktopConfigPath: string;
}

/**
 * Homebrew's process.execPath is the versioned Cellar copy
 * (/opt/homebrew/Cellar/node@24/24.11.0/bin/node), which the next
 * `brew upgrade` deletes; the opt link (/opt/homebrew/opt/node@24/bin/node)
 * follows the upgrade, for a linked formula and a keg-only one alike.
 */
function stableNodePath(platform: NodeJS.Platform, execPath: string): string {
  if (platform !== "darwin") return execPath;
  const brew = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  return brew ? `${brew[1]}/opt/${brew[2]}/bin/node` : execPath;
}

/** One argument for the user's shell: cmd/PowerShell on Windows, zsh on macOS. */
function shellArg(platform: NodeJS.Platform, arg: string): string {
  // In zsh a ! inside double quotes is history expansion and $ is expanded;
  // single quotes keep both literal.
  return platform === "win32" ? `"${arg}"` : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** macOS's own tool folders, for the PATH handed to Claude Desktop. */
const DARWIN_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * How Claude should start the server. Installed with `npm i -g` (or from a
 * .tgz), the absolute Node and dist/index.js: no download, no PATH lookup,
 * none of the `cmd /c` wrapping Claude Code needs for npx on Windows. Run
 * through npx, the package lives in a cache that can be emptied, so npx it is.
 * On macOS Claude Desktop starts servers with the system's short PATH, where
 * neither npx nor the node its first line asks for is found when Node came
 * from nodejs.org or Homebrew: so the full path of npx, and a PATH with node.
 */
export function claudeConfig(machine: SetupEnvironment = {}): ClaudeConfig {
  const platform = machine.platform ?? process.platform;
  const env = machine.env ?? process.env;
  const home = machine.home ?? os.homedir();
  const packageRoot = machine.packageRoot ?? PACKAGE_ROOT;
  const viaNpx = packageRoot.split(/[\\/]/).includes("_npx");
  const node = stableNodePath(platform, machine.execPath ?? process.execPath);
  const join = platform === "darwin" ? path.posix.join : path.join;

  const command = viaNpx ? "npx" : node;
  const args = viaNpx ? ["-y", "parlez"] : [join(packageRoot, "dist", "index.js")];
  const prefix = `claude mcp add --scope user parlez -e ${PULL_ONLY_ENV}=1 --`;
  const claudeCode = viaNpx
    ? `${prefix} ${platform === "win32" ? "cmd /c " : ""}npx -y parlez`
    : `${prefix} ${[command, ...args].map((a) => shellArg(platform, a)).join(" ")}`;
  const nodeDir = path.posix.dirname(node);
  const desktop =
    viaNpx && platform === "darwin"
      ? {
          command: `${nodeDir}/npx`,
          args,
          env: { [PULL_ONLY_ENV]: "1", PATH: `${nodeDir}:${DARWIN_SYSTEM_PATH}` },
        }
      : { command, args, env: { [PULL_ONLY_ENV]: "1" } };
  const desktopJson = JSON.stringify({ mcpServers: { parlez: desktop } }, null, 2);
  const desktopConfigPath =
    platform === "win32"
      ? path.join(
          env.APPDATA ?? path.join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        )
      : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return { command, args, claudeCode, desktopJson, desktopConfigPath };
}

// --- Messages --------------------------------------------------------------------

/**
 * Where the scripting checkbox is. macOS: Adobe's scripting page gives
 * "After Effects > Settings > Scripting & Expressions"; the Italian names are
 * the Windows ones' translation, so the English path rides along.
 */
const SCRIPTING_MENU = {
  it: (mac: boolean) =>
    mac
      ? "After Effects → Impostazioni → Script ed espressioni (nei menu in inglese: After Effects → Settings → Scripting & Expressions)"
      : "Modifica → Preferenze → Script ed espressioni",
  en: (mac: boolean) =>
    mac
      ? "After Effects → Settings → Scripting & Expressions"
      : "Edit → Preferences → Scripting & Expressions",
};

const TEXT = {
  it: {
    ok: "OK      ",
    todo: "DA FARE ",
    note: "NOTA    ",
    setupTitle: (v: string) => `Parlez! ${v} — installazione`,
    doctorTitle: (v: string) => `Parlez! ${v} — controllo (non cambia niente)`,
    found: (y: number, v: string | null) =>
      `After Effects ${y} trovato${v ? ` (cartella delle preferenze ${v})` : ", mai aperto su questo computer"}`,
    unsupported: (y: number) =>
      `After Effects ${y} trovato ma non supportato: Parlez! funziona dal ${MIN_AE_YEAR}. Lo salto.`,
    noAe:
      `Non ho trovato After Effects ${MIN_AE_YEAR} o più recente. Se è installato in una cartella non standard, ` +
      "imposta AE_MCP_EXE con il percorso completo di AfterFX.exe (su Mac: del file .app) e rilancia; " +
      "oppure indica la cartella delle preferenze con --version, per esempio --version 26.5.",
    neverLaunched: (y: number) =>
      `Apri After Effects ${y} una volta e chiudilo: così crea la sua cartella delle preferenze. Poi rilancia parlez setup.`,
    noProfileFolder: (v: string, root: string) =>
      `La cartella ${path.join(root, v)} non esiste: After Effects ${v} non è mai stato aperto su questo computer.`,
    askAll: (list: string) =>
      `Ho trovato più After Effects: ${list}. Installo Parlez! in tutti? [s/N] `,
    chooseOne: (example: string) =>
      `Non ho installato niente. Scegli una versione, per esempio: parlez setup --version ${example}` +
      " (oppure parlez setup --all per tutte).",
    wroteAgent: (p: string, dry: boolean) =>
      `${dry ? "scriverei" : "installato"} lo script di avvio: ${p}`,
    sameAgent: (p: string) => `script di avvio già aggiornato: ${p}`,
    wrotePanel: (p: string, dry: boolean) =>
      `${dry ? "scriverei" : "installato"} il pannello: ${p}`,
    samePanel: (p: string) => `pannello già aggiornato: ${p}`,
    removedOld: (p: string, dry: boolean) =>
      `${dry ? "toglierei" : "tolto"} il pannello con il vecchio nome: ${p}`,
    restart:
      "Riavvia After Effects per caricare lo script di avvio e il pannello (menu Finestra → Parlez!). " +
      "Il pannello parte su OFF: Claude lavora solo dopo che lo accendi.",
    dryRun: "Prova a vuoto (--dry-run): non ho scritto niente.",
    prefOn: (v: string) =>
      `After Effects ${v}: la casella «Consenti agli script di scrivere file e accedere alla rete» è accesa`,
    prefOff: (v: string, mac: boolean) =>
      `After Effects ${v}: accendi la casella «Consenti agli script di scrivere file e accedere alla rete» in ` +
      SCRIPTING_MENU.it(mac) +
      ", poi chiudi la finestra con OK. Senza, Claude va in timeout senza spiegazioni.",
    prefUnknown: (v: string, file: string, mac: boolean) =>
      `After Effects ${v}: non riesco a leggere la casella degli script (${file}). Controllala a mano: ` +
      `${SCRIPTING_MENU.it(mac)} → «Consenti agli script di scrivere file e accedere alla rete».`,
    claudeTitle: "Collegare Parlez! a Claude",
    claudeCodeIntro: "Claude Code: incolla questo comando nel terminale.",
    claudeDesktopIntro: (file: string) =>
      "Claude Desktop: apri Claude → Impostazioni → Sviluppatore → Modifica configurazione " +
      `(il file è ${file}) e aggiungi questo blocco dentro "mcpServers" (se il file è vuoto, incollalo così com'è). ` +
      "Poi chiudi e riapri Claude Desktop.",
    finalCheck: "Controllo finale (lo stesso di parlez doctor):",
    node: (v: string, ok: boolean) =>
      ok
        ? `Node.js ${v}`
        : `Node.js ${v}: serve Node.js ${MIN_NODE_MAJOR} o più recente. Scaricalo da nodejs.org (versione LTS) e rilancia.`,
    agentOk: (v: string) => `After Effects ${v}: script di avvio installato e aggiornato`,
    agentMissing: (v: string) =>
      `After Effects ${v}: script di avvio non installato. Lancia parlez setup`,
    agentStale: (v: string) =>
      `After Effects ${v}: script di avvio da aggiornare. Lancia parlez setup`,
    panelOk: (v: string) => `After Effects ${v}: pannello Parlez! installato e aggiornato`,
    panelMissing: (v: string) =>
      `After Effects ${v}: pannello Parlez! non installato. Lancia parlez setup`,
    panelStale: (v: string) =>
      `After Effects ${v}: pannello Parlez! da aggiornare. Lancia parlez setup`,
    live: (label: string) => `After Effects acceso con l'agente: ${label}`,
    livePaused: (label: string) =>
      `${label}: il pannello è su OFF, Claude è fermo finché non lo accendi`,
    liveReadOnly: (label: string) =>
      `${label}: il pannello è in «Sola lettura», Claude può solo guardare`,
    noLive:
      "nessun After Effects acceso con l'agente in questo momento. È normale se After Effects è chiuso; " +
      "se è aperto, riavvialo dopo l'installazione e aspetta una decina di secondi.",
    pullAuto: (push: string, mac: boolean) =>
      `collegamento: lo script di avvio è installato, quindi il server userà solo quello (non prova ${push}). ` +
      `Per riaccendere il collegamento diretto: ${PULL_ONLY_ENV}=0.` +
      (mac
        ? " Così macOS non chiede il permesso di Automazione: serve solo al collegamento diretto."
        : ""),
    pullNone: (push: string, mac: boolean) =>
      `collegamento: script di avvio non installato, il server proverà il collegamento diretto (${push}). ` +
      (mac
        ? "La prima volta macOS chiede il permesso di Automazione per controllare After Effects: rispondi Consenti. "
        : "") +
      "Su alcuni computer non funziona: per questo parlez setup installa lo script di avvio.",
    mailbox: (dir: string) =>
      `cassetta (la cartella dove Claude e After Effects si scambiano le richieste, con i log): ${dir}`,
    allGood: "Tutto pronto.",
    someTodo: "C'è ancora qualcosa da fare (righe DA FARE qui sopra).",
  },
  en: {
    ok: "OK      ",
    todo: "TO DO   ",
    note: "NOTE    ",
    setupTitle: (v: string) => `Parlez! ${v} — setup`,
    doctorTitle: (v: string) => `Parlez! ${v} — check (changes nothing)`,
    found: (y: number, v: string | null) =>
      `After Effects ${y} found${v ? ` (preferences folder ${v})` : ", never launched on this computer"}`,
    unsupported: (y: number) =>
      `After Effects ${y} found but not supported: Parlez! works from ${MIN_AE_YEAR} on. Skipping it.`,
    noAe:
      `No After Effects ${MIN_AE_YEAR} or newer found. If it is installed in a non-standard folder, set ` +
      "AE_MCP_EXE to the full path of AfterFX.exe (on a Mac: of the .app) and run again; or name the " +
      "preferences folder with --version, e.g. --version 26.5.",
    neverLaunched: (y: number) =>
      `Open After Effects ${y} once and quit it, so it creates its preferences folder. Then run parlez setup again.`,
    noProfileFolder: (v: string, root: string) =>
      `The folder ${path.join(root, v)} does not exist: After Effects ${v} has never been opened on this computer.`,
    askAll: (list: string) =>
      `Found several After Effects: ${list}. Install Parlez! into all of them? [y/N] `,
    chooseOne: (example: string) =>
      `Nothing installed. Pick a version, e.g.: parlez setup --version ${example}` +
      " (or parlez setup --all for every one).",
    wroteAgent: (p: string, dry: boolean) =>
      `${dry ? "would install" : "installed"} the startup script: ${p}`,
    sameAgent: (p: string) => `startup script already up to date: ${p}`,
    wrotePanel: (p: string, dry: boolean) =>
      `${dry ? "would install" : "installed"} the panel: ${p}`,
    samePanel: (p: string) => `panel already up to date: ${p}`,
    removedOld: (p: string, dry: boolean) =>
      `${dry ? "would remove" : "removed"} the panel under its old name: ${p}`,
    restart:
      "Restart After Effects to load the startup script and the panel (Window → Parlez!). " +
      "The panel starts OFF: Claude works only after you switch it on.",
    dryRun: "Dry run (--dry-run): nothing was written.",
    prefOn: (v: string) =>
      `After Effects ${v}: "Allow Scripts to Write Files and Access Network" is on`,
    prefOff: (v: string, mac: boolean) =>
      `After Effects ${v}: turn on "Allow Scripts to Write Files and Access Network" in ` +
      SCRIPTING_MENU.en(mac) +
      ", then close the dialog with OK. Without it, Claude times out with no explanation.",
    prefUnknown: (v: string, file: string, mac: boolean) =>
      `After Effects ${v}: cannot read the scripting checkbox (${file}). Check it by hand: ` +
      `${SCRIPTING_MENU.en(mac)} → "Allow Scripts to Write Files and Access Network".`,
    claudeTitle: "Connecting Parlez! to Claude",
    claudeCodeIntro: "Claude Code: paste this command into the terminal.",
    claudeDesktopIntro: (file: string) =>
      "Claude Desktop: open Claude → Settings → Developer → Edit Config " +
      `(the file is ${file}) and add this block inside "mcpServers" (if the file is empty, paste it as is). ` +
      "Then quit and reopen Claude Desktop.",
    finalCheck: "Final check (same as parlez doctor):",
    node: (v: string, ok: boolean) =>
      ok
        ? `Node.js ${v}`
        : `Node.js ${v}: Node.js ${MIN_NODE_MAJOR} or newer is needed. Get it from nodejs.org (LTS) and run again.`,
    agentOk: (v: string) => `After Effects ${v}: startup script installed and up to date`,
    agentMissing: (v: string) =>
      `After Effects ${v}: startup script not installed. Run parlez setup`,
    agentStale: (v: string) => `After Effects ${v}: startup script out of date. Run parlez setup`,
    panelOk: (v: string) => `After Effects ${v}: Parlez! panel installed and up to date`,
    panelMissing: (v: string) =>
      `After Effects ${v}: Parlez! panel not installed. Run parlez setup`,
    panelStale: (v: string) => `After Effects ${v}: Parlez! panel out of date. Run parlez setup`,
    live: (label: string) => `After Effects running with the agent: ${label}`,
    livePaused: (label: string) =>
      `${label}: the panel is OFF, Claude is stopped until you switch it on`,
    liveReadOnly: (label: string) => `${label}: the panel is on "read only", Claude can only look`,
    noLive:
      "no After Effects running with the agent right now. That is normal if After Effects is closed; " +
      "if it is open, restart it after setup and wait about ten seconds.",
    pullAuto: (push: string, mac: boolean) =>
      `connection: the startup script is installed, so the server uses only that (it does not try ${push}). ` +
      `To bring the direct connection back: ${PULL_ONLY_ENV}=0.` +
      (mac
        ? " So macOS does not ask for the Automation permission: only the direct connection needs it."
        : ""),
    pullNone: (push: string, mac: boolean) =>
      `connection: no startup script, so the server tries the direct connection (${push}). ` +
      (mac
        ? "The first time, macOS asks for the Automation permission to control After Effects: answer Allow. "
        : "") +
      "On some computers it does not work: that is why parlez setup installs the startup script.",
    mailbox: (dir: string) =>
      `mailbox (the folder where Claude and After Effects exchange requests, with the logs): ${dir}`,
    allGood: "All set.",
    someTodo: "Something is still left to do (the TO DO lines above).",
  },
} as const;

type Messages = (typeof TEXT)[Lang];

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

async function askOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return ["s", "si", "sì", "y", "yes"].includes(answer);
  } finally {
    rl.close();
  }
}

function installOptions(
  machine: SetupEnvironment,
  version: string,
  dryRun = false,
): InstallOptions {
  return {
    version,
    dryRun,
    platform: machine.platform ?? process.platform,
    env: machine.env ?? process.env,
    home: machine.home ?? os.homedir(),
  };
}

function profileRootOf(machine: SetupEnvironment): string {
  return aeProfileRoot(
    machine.platform ?? process.platform,
    machine.env ?? process.env,
    machine.home ?? os.homedir(),
  );
}

interface Targets {
  versions: string[];
  /** Exit code when there is nothing to work on (versions empty). */
  failure?: number;
}

/**
 * Which profile folders to work on. `ask` is setup's confirmation before it
 * writes into several; the doctor passes none and simply checks them all.
 */
async function chooseTargets(
  opts: SetupOptions,
  machine: SetupEnvironment,
  t: Messages,
  out: (line: string) => void,
  ask?: (question: string) => Promise<boolean>,
): Promise<Targets> {
  const root = profileRootOf(machine);
  const installs = await findAfterEffects(machine);
  for (const a of installs)
    out(
      a.supported
        ? `${t.note}${t.found(a.year, a.profileVersion)}`
        : `${t.note}${t.unsupported(a.year)}`,
    );

  if (opts.version) {
    if (!(await exists(path.join(root, opts.version)))) {
      out(`${t.todo}${t.noProfileFolder(opts.version, root)}`);
      return { versions: [], failure: 1 };
    }
    return { versions: [opts.version] };
  }

  const supported = installs.filter((a) => a.supported);
  if (supported.length === 0) {
    out(`${t.todo}${t.noAe}`);
    return { versions: [], failure: 1 };
  }
  for (const a of supported)
    if (a.profileVersion === null) out(`${t.todo}${t.neverLaunched(a.year)}`);
  const ready = supported.filter(
    (a): a is AeInstall & { profileVersion: string } => a.profileVersion !== null,
  );
  if (ready.length === 0) return { versions: [], failure: 1 };
  if (ready.length > 1 && ask && !opts.all) {
    const list = ready.map((a) => `${a.year} (${a.profileVersion})`).join(", ");
    if (!(await ask(t.askAll(list)))) {
      out(t.chooseOne(ready[0].profileVersion));
      return { versions: [], failure: 2 };
    }
  }
  return { versions: ready.map((a) => a.profileVersion) };
}

export async function runSetup(
  opts: SetupOptions,
  out: (line: string) => void,
  machine: SetupEnvironment = {},
): Promise<number> {
  const t = TEXT[machine.lang ?? detectLang()];
  out(t.setupTitle(packageVersion()));
  out("");

  const targets = await chooseTargets(opts, machine, t, out, machine.confirm ?? askOnTerminal);
  if (targets.versions.length === 0) return targets.failure ?? 1;

  let changed = false;
  for (const version of targets.versions) {
    const install = installOptions(machine, version, opts.dryRun);
    const agent = await installAgent(install);
    for (const p of agent.written) out(`${t.ok}${t.wroteAgent(p, opts.dryRun === true)}`);
    for (const p of agent.unchanged) out(`${t.ok}${t.sameAgent(p)}`);
    const panel = await installPanel(install);
    for (const p of panel.written) out(`${t.ok}${t.wrotePanel(p, opts.dryRun === true)}`);
    for (const p of panel.unchanged) out(`${t.ok}${t.samePanel(p)}`);
    for (const p of panel.removedLegacy) out(`${t.ok}${t.removedOld(p, opts.dryRun === true)}`);
    changed ||= agent.written.length + panel.written.length + panel.removedLegacy.length > 0;
  }
  out("");
  if (opts.dryRun) out(t.dryRun);
  else if (changed) out(t.restart);

  // The scripting checkbox is reported by the final check below, with the
  // way to switch it on: printing it here too would only say it twice.
  const cfg = claudeConfig(machine);
  out("");
  out(`— ${t.claudeTitle} —`);
  out(t.claudeCodeIntro);
  out("");
  out(`    ${cfg.claudeCode}`);
  out("");
  out(t.claudeDesktopIntro(cfg.desktopConfigPath));
  out("");
  for (const line of cfg.desktopJson.split("\n")) out(`    ${line}`);
  out("");
  out(`— ${t.finalCheck} —`);
  return runDoctorChecks(targets.versions, out, machine, t);
}

export async function runDoctor(
  opts: Pick<SetupOptions, "version">,
  out: (line: string) => void,
  machine: SetupEnvironment = {},
): Promise<number> {
  const t = TEXT[machine.lang ?? detectLang()];
  out(t.doctorTitle(packageVersion()));
  out("");
  const targets = await chooseTargets(opts, machine, t, out);
  const code = await runDoctorChecks(targets.versions, out, machine, t);
  return targets.versions.length === 0 ? 1 : code;
}

/** The checks themselves; read-only. 1 when anything is left to do. */
async function runDoctorChecks(
  versions: string[],
  out: (line: string) => void,
  machine: SetupEnvironment,
  t: Messages,
): Promise<number> {
  let todo = 0;
  const line = (ok: boolean, text: string) => {
    if (!ok) todo++;
    out(`${ok ? t.ok : t.todo}${text}`);
  };

  const nodeVersion = machine.nodeVersion ?? process.versions.node;
  line(
    Number(nodeVersion.split(".")[0]) >= MIN_NODE_MAJOR,
    t.node(nodeVersion, Number(nodeVersion.split(".")[0]) >= MIN_NODE_MAJOR),
  );

  const root = profileRootOf(machine);
  const platform = machine.platform ?? process.platform;
  for (const version of versions) {
    const install = installOptions(machine, version);
    const [agent] = await agentInstallStatus(install);
    line(
      agent.installed && agent.current,
      !agent.installed
        ? t.agentMissing(version)
        : agent.current
          ? t.agentOk(version)
          : t.agentStale(version),
    );
    const [panel] = await panelInstallStatus(install);
    line(
      panel.installed && panel.current,
      !panel.installed
        ? t.panelMissing(version)
        : panel.current
          ? t.panelOk(version)
          : t.panelStale(version),
    );
    const pref = await readScriptingPref(root, version);
    if (pref === "on") line(true, t.prefOn(version));
    else if (pref === "off") line(false, t.prefOff(version, platform === "darwin"));
    else line(false, t.prefUnknown(version, prefsFileFor(root, version), platform === "darwin"));
  }

  const instances = (
    await listInstances(machine.instancesDir ?? INSTANCES_DIR, machine.now ?? Date.now())
  ).filter((i) => i.alive);
  if (instances.length === 0) out(`${t.note}${t.noLive}`);
  for (const instance of instances) {
    const label = instanceLabel(instance);
    out(`${t.ok}${t.live(label)}`);
    if (isPaused(instance)) out(`${t.note}${t.livePaused(label)}`);
    else if (isReadOnly(instance)) out(`${t.note}${t.liveReadOnly(label)}`);
  }

  const agentInstalled = await anyAgentInstalled({
    platform,
    env: machine.env ?? process.env,
    home: machine.home ?? os.homedir(),
  });
  const push = pushPathName(platform);
  const mac = platform === "darwin";
  out(`${t.note}${agentInstalled ? t.pullAuto(push, mac) : t.pullNone(push, mac)}`);
  out(`${t.note}${t.mailbox(path.dirname(machine.instancesDir ?? INSTANCES_DIR))}`);
  out("");
  out(todo === 0 ? t.allGood : t.someTodo);
  return todo === 0 ? 0 : 1;
}
