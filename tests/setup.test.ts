// `parlez setup` and `parlez doctor`: finding After Effects, installing the
// agent and the panel, reading the scripting checkbox from the prefs file,
// printing the Claude configuration, and checking everything without writing.
// Everything runs against temp directories standing in for Program Files /
// Applications, the AE profile and the mailbox — the real ones are never
// read or touched.

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { anyAgentInstalled, stubSource } from "../src/agent-install.js";
import { parseCliArgs } from "../src/cli.js";
import {
  AGENT_STUB_FILENAME,
  PACKAGE_ROOT,
  PANEL_FILENAME,
  pullOnlySetting,
  resolvePullOnlyDefault,
} from "../src/config.js";
import { panelSource } from "../src/panel-install.js";
import {
  ACCEPTANCE_FILENAME,
  BUILTIN_NOTICES_SUMMARY,
  type SetupEnvironment,
  claudeConfig,
  detectLang,
  findAfterEffects,
  isAcceptance,
  noticesSummary,
  parlezDataDir,
  prefsFileFor,
  readScriptingPref,
  runDoctor,
  runSetup,
} from "../src/setup.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-setup-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake Windows machine under `tmp`: Program Files\Adobe, %APPDATA%, the mailbox. */
interface FakeMachine {
  env: SetupEnvironment;
  profileRoot: string;
  appsRoot: string;
  instancesDir: string;
}

function fakeWindows(extra: Partial<SetupEnvironment> = {}): FakeMachine {
  const appData = path.join(tmp, "AppData", "Roaming");
  const appsRoot = path.join(tmp, "Program Files", "Adobe");
  const instancesDir = path.join(tmp, "mailbox", "instances");
  return {
    env: {
      platform: "win32",
      env: { APPDATA: appData, ProgramFiles: path.join(tmp, "Program Files") },
      home: tmp,
      nodeVersion: "24.3.0",
      packageRoot: path.join(tmp, "npm", "node_modules", "parlez"),
      execPath: path.join(tmp, "nodejs", "node.exe"),
      instancesDir,
      lang: "it",
      // The notices are accepted at the prompt unless a test says otherwise.
      askLine: async () => "accetto",
      ...extra,
    },
    profileRoot: path.join(appData, "Adobe", "After Effects"),
    appsRoot,
    instancesDir,
  };
}

async function addWindowsApp(m: FakeMachine, year: number): Promise<void> {
  const dir = path.join(m.appsRoot, `Adobe After Effects ${year}`, "Support Files");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "AfterFX.exe"), "", "utf8");
}

async function addProfile(m: FakeMachine, version: string, pref?: "0" | "1"): Promise<void> {
  const dir = path.join(m.profileRoot, version);
  await fs.mkdir(dir, { recursive: true });
  if (pref !== undefined) {
    await fs.writeFile(
      prefsFileFor(m.profileRoot, version),
      `["Main Pref Section v2"]\n\t"Pref_JAVASCRIPT_DEBUGGER" = "0"\n\t"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "${pref}"\n`,
      "utf8",
    );
  }
}

/** Every file under `dir` with its contents, to prove a command wrote nothing. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[path.relative(dir, full)] = await fs.readFile(full, "utf8");
    }
  }
  await walk(dir);
  return files;
}

function collect(): { lines: string[]; out: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line), text: () => lines.join("\n") };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

describe("language", () => {
  it("is Italian unless --lang en asks for English", () => {
    expect(detectLang()).toBe("it");
    expect(detectLang("it")).toBe("it");
    expect(detectLang("en")).toBe("en");
  });
});

describe("finding After Effects", () => {
  it("pairs each installed year with the newest profile folder of its major version", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2023);
    await addWindowsApp(m, 2025);
    await addWindowsApp(m, 2026);
    for (const v of ["17.5", "23.4", "25.1", "25.6", "26.3", "26.5"]) await addProfile(m, v);

    const found = await findAfterEffects(m.env);
    expect(found.map((a) => [a.year, a.profileVersion, a.supported])).toEqual([
      [2026, "26.5", true],
      [2025, "25.6", true],
      [2023, "23.4", false],
    ]);
    expect(found[0].appPath).toBe(
      path.join(m.appsRoot, "Adobe After Effects 2026", "Support Files", "AfterFX.exe"),
    );
  });

  it("reports an installed version that has never been launched", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2024);
    const found = await findAfterEffects(m.env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ year: 2024, profileVersion: null, supported: true });
  });

  it("finds the .app bundles on macOS", async () => {
    const apps = path.join(tmp, "Applications");
    await fs.mkdir(
      path.join(apps, "Adobe After Effects 2026", "Adobe After Effects 2026.app", "Contents"),
      { recursive: true },
    );
    const profileRoot = path.join(tmp, "Library", "Preferences", "Adobe", "After Effects");
    await fs.mkdir(path.join(profileRoot, "26.5"), { recursive: true });
    const found = await findAfterEffects({
      platform: "darwin",
      env: {},
      home: tmp,
      applicationsDir: apps,
    });
    expect(found.map((a) => [a.year, a.profileVersion])).toEqual([[2026, "26.5"]]);
  });

  it("honours AE_MCP_EXE for an install outside the standard folder", async () => {
    const m = fakeWindows();
    const exe = path.join(tmp, "D", "Adobe After Effects 2025", "Support Files", "AfterFX.exe");
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, "", "utf8");
    m.env.env = { ...m.env.env, AE_MCP_EXE: exe };
    const found = await findAfterEffects(m.env);
    expect(found.map((a) => [a.year, a.appPath])).toEqual([[2025, exe]]);
  });
});

describe("the scripting checkbox", () => {
  it("reads Pref_SCRIPTING_FILE_NETWORK_SECURITY from the prefs file", async () => {
    const m = fakeWindows();
    await addProfile(m, "26.5", "1");
    await addProfile(m, "25.6", "0");
    await addProfile(m, "26.3");
    expect(await readScriptingPref(m.profileRoot, "26.5")).toBe("on");
    expect(await readScriptingPref(m.profileRoot, "25.6")).toBe("off");
    expect(await readScriptingPref(m.profileRoot, "26.3")).toBe("unknown");
    expect(prefsFileFor(m.profileRoot, "26.5")).toBe(
      path.join(m.profileRoot, "26.5", "Adobe After Effects 26.5 Prefs.txt"),
    );
  });

  it("reads a prefs file without the key as unknown", async () => {
    const m = fakeWindows();
    await addProfile(m, "26.5");
    await fs.writeFile(prefsFileFor(m.profileRoot, "26.5"), '"Pref_OTHER" = "1"\n', "utf8");
    expect(await readScriptingPref(m.profileRoot, "26.5")).toBe("unknown");
  });
});

describe("Claude configuration", () => {
  it("points at the installed package with this Node when installed with npm -g", () => {
    const cfg = claudeConfig({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      home: "C:\\Users\\me",
      packageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\parlez",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(cfg.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(cfg.args).toEqual([
      path.join("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\parlez", "dist", "index.js"),
    ]);
    expect(cfg.claudeCode).toContain("claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 --");
    expect(cfg.claudeCode).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    const desktop = JSON.parse(cfg.desktopJson);
    expect(desktop.mcpServers.parlez).toEqual({
      command: cfg.command,
      args: cfg.args,
      env: { AE_MCP_PULL_ONLY: "1" },
    });
    expect(cfg.desktopConfigPath).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("uses npx when run from the npx cache, with cmd /c for Claude Code on Windows", () => {
    const win = claudeConfig({
      platform: "win32",
      env: {},
      home: "C:\\Users\\me",
      packageRoot: "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\parlez",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(win.command).toBe("npx");
    expect(win.args).toEqual(["-y", "parlez"]);
    expect(win.claudeCode).toBe(
      "claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 -- cmd /c npx -y parlez",
    );

    const mac = claudeConfig({
      platform: "darwin",
      env: {},
      home: "/Users/me",
      packageRoot: "/Users/me/.npm/_npx/1a2b/node_modules/parlez",
      execPath: "/usr/local/bin/node",
    });
    expect(mac.claudeCode).toBe(
      "claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 -- npx -y parlez",
    );
    expect(mac.desktopConfigPath).toBe(
      path.join(
        "/Users/me",
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    );
  });
});

describe("parlez setup", () => {
  it("installs the agent and the panel for the one supported After Effects", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.3");
    await addProfile(m, "26.5", "1");
    const c = collect();

    expect(await runSetup({}, c.out, m.env)).toBe(0);

    const startup = path.join(m.profileRoot, "26.5", "Scripts", "Startup", AGENT_STUB_FILENAME);
    const panel = path.join(m.profileRoot, "26.5", "Scripts", "ScriptUI Panels", PANEL_FILENAME);
    expect(await fs.readFile(startup, "utf8")).toBe(stubSource());
    expect(await fs.readFile(panel, "utf8")).toBe(await panelSource());
    // the older 26.3 folder of the same After Effects is left alone
    expect(await exists(path.join(m.profileRoot, "26.3", "Scripts"))).toBe(false);

    const text = c.text();
    expect(text).toContain("After Effects 2026");
    expect(text).toContain("claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1");
    expect(text).toContain('"mcpServers"');
    expect(text).toContain("Riavvia After Effects");
    // the doctor runs at the end
    expect(text).toContain("parlez doctor");
  });

  it("says how to switch the checkbox on when it is off, and exits non-zero", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.5", "0");
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(1);
    expect(c.text()).toContain("Script ed espressioni");
    expect(c.text()).toContain("Consenti agli script di scrivere file e accedere alla rete");
  });

  it("speaks English with --lang en", async () => {
    const m = fakeWindows({ lang: "en" });
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.5", "0");
    const c = collect();
    await runSetup({}, c.out, m.env);
    expect(c.text()).toContain("Allow Scripts to Write Files and Access Network");
    expect(c.text()).toContain("Restart After Effects");
  });

  it("asks before installing into several After Effects, and installs nothing on no", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2025);
    await addWindowsApp(m, 2026);
    await addProfile(m, "25.6", "1");
    await addProfile(m, "26.5", "1");
    const before = await snapshot(tmp);
    const questions: string[] = [];
    const c = collect();
    const code = await runSetup({}, c.out, {
      ...m.env,
      confirm: async (q) => {
        questions.push(q);
        return false;
      },
    });
    expect(code).toBe(2);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("2025");
    expect(c.text()).toContain("--version");
    // Only the record of the accepted notices (asked first) is new.
    const after = await snapshot(tmp);
    const record = path.join("AppData", "Roaming", "Parlez", ACCEPTANCE_FILENAME);
    expect(Object.keys(after)).toContain(record);
    delete after[record];
    expect(after).toEqual(before);
  });

  it("installs into every supported After Effects on yes, or with --all", async () => {
    for (const mode of ["yes", "all"] as const) {
      rmSync(tmp, { recursive: true, force: true });
      await fs.mkdir(tmp, { recursive: true });
      const m = fakeWindows();
      await addWindowsApp(m, 2023);
      await addWindowsApp(m, 2025);
      await addWindowsApp(m, 2026);
      await addProfile(m, "23.4", "1");
      await addProfile(m, "25.6", "1");
      await addProfile(m, "26.5", "1");
      const c = collect();
      const code = await runSetup(mode === "all" ? { all: true } : {}, c.out, {
        ...m.env,
        confirm: async () => mode === "yes",
      });
      expect(code).toBe(0);
      for (const v of ["25.6", "26.5"]) {
        expect(
          await exists(path.join(m.profileRoot, v, "Scripts", "Startup", AGENT_STUB_FILENAME)),
        ).toBe(true);
      }
      // After Effects 2023 is below the supported minimum: never installed into
      expect(await exists(path.join(m.profileRoot, "23.4", "Scripts"))).toBe(false);
      expect(c.text()).toContain("2023");
    }
  });

  it("installs only the version asked for with --version", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2025);
    await addWindowsApp(m, 2026);
    await addProfile(m, "25.6", "1");
    await addProfile(m, "26.5", "1");
    const c = collect();
    expect(await runSetup({ version: "25.6" }, c.out, m.env)).toBe(0);
    expect(
      await exists(path.join(m.profileRoot, "25.6", "Scripts", "Startup", AGENT_STUB_FILENAME)),
    ).toBe(true);
    expect(await exists(path.join(m.profileRoot, "26.5", "Scripts"))).toBe(false);
  });

  it("refuses a --version folder After Effects never created", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.5", "1");
    const c = collect();
    expect(await runSetup({ version: "24.0" }, c.out, m.env)).toBe(1);
    expect(c.text()).toContain("24.0");
    expect(await exists(path.join(m.profileRoot, "24.0"))).toBe(false);
  });

  it("writes nothing on --dry-run", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.5", "1");
    const before = await snapshot(tmp);
    const c = collect();
    await runSetup({ dryRun: true }, c.out, m.env);
    expect(await snapshot(tmp)).toEqual(before);
    expect(c.text()).toContain(AGENT_STUB_FILENAME);
  });

  it("tells the user to launch After Effects once when it has no profile yet", async () => {
    const m = fakeWindows();
    await addWindowsApp(m, 2026);
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(1);
    expect(c.text()).toContain("Apri After Effects 2026 una volta");
  });

  it("explains what to do when no After Effects is found", async () => {
    const m = fakeWindows();
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(1);
    expect(c.text()).toContain("AE_MCP_EXE");
  });
});

describe("parlez doctor", () => {
  async function readyMachine(): Promise<FakeMachine> {
    const m = fakeWindows();
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.5", "1");
    await runSetup({}, () => {}, m.env);
    return m;
  }

  it("is all green on a machine set up by parlez setup, and writes nothing", async () => {
    const m = await readyMachine();
    const before = await snapshot(tmp);
    const c = collect();
    expect(await runDoctor({}, c.out, m.env)).toBe(0);
    expect(await snapshot(tmp)).toEqual(before);
    expect(c.text()).not.toContain("DA FARE");
    expect(c.text()).toContain("Node.js 24.3.0");
  });

  it("flags a missing agent, an out-of-date panel and an old Node", async () => {
    const m = await readyMachine();
    await fs.unlink(path.join(m.profileRoot, "26.5", "Scripts", "Startup", AGENT_STUB_FILENAME));
    await fs.writeFile(
      path.join(m.profileRoot, "26.5", "Scripts", "ScriptUI Panels", PANEL_FILENAME),
      "// Parlez! - the switch inside After Effects.\n// an older copy\n",
      "utf8",
    );
    const c = collect();
    expect(await runDoctor({}, c.out, { ...m.env, nodeVersion: "22.11.0" })).toBe(1);
    const text = c.text();
    expect(text).toMatch(/DA FARE.*Node\.js 22\.11\.0/);
    expect(text).toMatch(/DA FARE.*script di avvio/);
    expect(text).toMatch(/DA FARE.*pannello/);
  });

  it("reports live instances and a paused panel", async () => {
    const m = await readyMachine();
    const dir = path.join(m.instancesDir, "ae-1");
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    await fs.writeFile(
      path.join(dir, "heartbeat.json"),
      JSON.stringify({
        id: "ae-1",
        project: "C:/prove/spot.aep",
        projectName: "spot.aep",
        ticks: 12,
        paused: true,
        ts: now,
      }),
      "utf8",
    );
    const c = collect();
    expect(await runDoctor({}, c.out, { ...m.env, now })).toBe(0);
    expect(c.text()).toContain("spot.aep");
    expect(c.text()).toContain("OFF");
  });

  it("says when no After Effects is running with the agent, without failing", async () => {
    const m = await readyMachine();
    const c = collect();
    expect(await runDoctor({}, c.out, m.env)).toBe(0);
    expect(c.text()).toContain("nessun After Effects");
  });
});

describe("the default connection", () => {
  it("reads AE_MCP_PULL_ONLY as on, off or automatic", () => {
    expect(pullOnlySetting({ AE_MCP_PULL_ONLY: "1" })).toBe("on");
    expect(pullOnlySetting({ AE_MCP_PULL_ONLY: " 0 " })).toBe("off");
    expect(pullOnlySetting({})).toBe("auto");
    expect(pullOnlySetting({ AE_MCP_PULL_ONLY: "yes" })).toBe("auto");
  });

  it("turns pull-only on by itself only when the agent is installed and nothing was set", () => {
    expect(resolvePullOnlyDefault("auto", true)).toBe(true);
    expect(resolvePullOnlyDefault("auto", false)).toBe(false);
    expect(resolvePullOnlyDefault("off", true)).toBe(false);
    expect(resolvePullOnlyDefault("on", false)).toBe(true);
  });

  it("sees an installed agent in any After Effects version folder", async () => {
    const appData = path.join(tmp, "AppData", "Roaming");
    const opts = { platform: "win32" as const, env: { APPDATA: appData }, home: tmp };
    expect(await anyAgentInstalled(opts)).toBe(false);
    const startup = path.join(appData, "Adobe", "After Effects", "25.6", "Scripts", "Startup");
    await fs.mkdir(startup, { recursive: true });
    expect(await anyAgentInstalled(opts)).toBe(false);
    await fs.writeFile(path.join(startup, AGENT_STUB_FILENAME), "// stub\n", "utf8");
    expect(await anyAgentInstalled(opts)).toBe(true);
  });
});

function agentFile(m: FakeMachine): string {
  return path.join(m.profileRoot, "26.5", "Scripts", "Startup", AGENT_STUB_FILENAME);
}

describe("the notices (avvertenze)", () => {
  async function machine(extra: Partial<SetupEnvironment> = {}): Promise<FakeMachine> {
    const m = fakeWindows({ now: Date.UTC(2026, 10, 11, 13, 30), ...extra });
    await addWindowsApp(m, 2026);
    await addProfile(m, "26.5", "1");
    return m;
  }
  const acceptanceFile = () => path.join(tmp, "AppData", "Roaming", "Parlez", ACCEPTANCE_FILENAME);

  it("keeps the record where the panel keeps its history (%APPDATA%\\Parlez on Windows)", () => {
    const appData = path.join("C:", "Users", "me", "AppData", "Roaming");
    expect(parlezDataDir("win32", { APPDATA: appData }, "/unused")).toBe(
      path.join(appData, "Parlez"),
    );
    expect(parlezDataDir("darwin", {}, "/Users/me")).toBe(
      path.join("/Users/me", "Library", "Application Support", "Parlez"),
    );
  });

  it("asks the first time, and with 'accetto' installs and records date, time and version", async () => {
    const questions: string[] = [];
    const m = await machine({
      askLine: async (q) => {
        questions.push(q);
        return "  Accetto ";
      },
    });
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(0);

    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("accetto");
    const text = c.text();
    // the summary comes before anything is installed
    expect(text.indexOf("gratuito, sperimentale")).toBeGreaterThan(-1);
    expect(text.indexOf("gratuito, sperimentale")).toBeLessThan(text.indexOf(AGENT_STUB_FILENAME));
    expect(text).toContain("così com'è");
    expect(text).toContain("AVVERTENZE.md");
    expect(await exists(agentFile(m))).toBe(true);

    const record = JSON.parse(await fs.readFile(acceptanceFile(), "utf8"));
    expect(record.acceptedAt).toBe("2026-11-11T13:30:00.000Z");
    expect(record.localTime).toMatch(/^2026-11-1\d \d\d:\d\d$/);
    expect(record.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(record.method).toBe("risposta");
    expect(record.lang).toBe("it");
  });

  it("stops without installing anything on any other answer, and says why", async () => {
    for (const answer of ["no", "", "s", "accetto?? forse", null]) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-setup-"));
      const m = await machine({ askLine: async () => answer });
      const before = await snapshot(tmp);
      const c = collect();
      expect(await runSetup({}, c.out, m.env)).toBe(2);
      expect(await snapshot(tmp)).toEqual(before);
      expect(c.text()).toContain("Non ho installato niente");
      expect(c.text()).not.toContain("claude mcp add");
      if (answer === null) expect(c.text()).toContain("--accept");
    }
  });

  it("does not ask again once the record exists", async () => {
    const m = await machine();
    await runSetup({}, () => {}, m.env);
    let asked = 0;
    const c = collect();
    const code = await runSetup({}, c.out, {
      ...m.env,
      askLine: async () => {
        asked++;
        return "no";
      },
    });
    expect(code).toBe(0);
    expect(asked).toBe(0);
    expect(c.text()).not.toContain("gratuito, sperimentale");
  });

  it("takes --accept as the answer, for scripted installs, and records it", async () => {
    const m = await machine({
      askLine: async () => {
        throw new Error("must not ask");
      },
    });
    const c = collect();
    expect(await runSetup({ accept: true }, c.out, m.env)).toBe(0);
    expect(c.text()).toContain("gratuito, sperimentale");
    expect(c.text()).toContain("--accept");
    expect(await exists(agentFile(m))).toBe(true);
    const record = JSON.parse(await fs.readFile(acceptanceFile(), "utf8"));
    expect(record.method).toBe("--accept");
  });

  it("neither asks nor writes on --dry-run", async () => {
    const m = await machine({
      askLine: async () => {
        throw new Error("must not ask");
      },
    });
    const before = await snapshot(tmp);
    const c = collect();
    await runSetup({ dryRun: true, accept: true }, c.out, m.env);
    expect(await snapshot(tmp)).toEqual(before);
    expect(await exists(acceptanceFile())).toBe(false);
    expect(c.text()).toContain("--dry-run");
  });

  it("asks for 'I accept' in English, and takes either word in either language", async () => {
    const questions: string[] = [];
    const m = await machine({
      lang: "en",
      askLine: async (q) => {
        questions.push(q);
        return "I accept";
      },
    });
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(0);
    expect(questions[0]).toContain("I accept");
    expect(c.text()).toContain("free, experimental");
    expect(isAcceptance("accetto")).toBe(true);
    expect(isAcceptance("I ACCEPT.")).toBe(true);
    expect(isAcceptance("«accetto»")).toBe(true);
    expect(isAcceptance("yes")).toBe(false);
    expect(isAcceptance("non accetto")).toBe(false);
  });

  it("doctor says whether and when the notices were accepted", async () => {
    const m = await machine();
    const before = collect();
    await runDoctor({}, before.out, m.env);
    expect(before.text()).toMatch(/DA FARE.*avvertenze non ancora accettate/i);

    await runSetup({}, () => {}, m.env);
    const record = JSON.parse(await fs.readFile(acceptanceFile(), "utf8"));
    const after = collect();
    expect(await runDoctor({}, after.out, m.env)).toBe(0);
    expect(after.text()).toMatch(/OK.*avvertenze accettate/i);
    expect(after.text()).toContain(record.localTime);
    expect(after.text()).toContain(record.packageVersion);
  });

  it("reads the summary from AVVERTENZE.md, and the built-in copy says the same", () => {
    for (const lang of ["it", "en"] as const) {
      const fromFile = noticesSummary(lang, PACKAGE_ROOT);
      expect(fromFile.source).toBe("AVVERTENZE.md");
      expect(fromFile.lines.length).toBeGreaterThanOrEqual(8);
      expect(fromFile.lines.length).toBeLessThanOrEqual(10);
      expect(fromFile.lines).toEqual(BUILTIN_NOTICES_SUMMARY[lang]);
      // without the file, the built-in copy
      const fallback = noticesSummary(lang, path.join(tmp, "nowhere"));
      expect(fallback.source).toBe("built-in");
      expect(fallback.lines).toEqual(BUILTIN_NOTICES_SUMMARY[lang]);
    }
  });

  it("ships AVVERTENZE.md in the npm package", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(pkg.files).toContain("AVVERTENZE.md");
  });
});

describe("cli flags", () => {
  it("parses --accept only when given", () => {
    expect(parseCliArgs(["setup", "--accept"])).toEqual({
      command: "setup",
      accept: true,
      dryRun: false,
      unknown: [],
    });
  });

  it("parses --lang and --all only when given", () => {
    expect(parseCliArgs(["setup", "--lang", "en", "--all"])).toEqual({
      command: "setup",
      lang: "en",
      all: true,
      dryRun: false,
      unknown: [],
    });
    expect(parseCliArgs(["doctor"])).toEqual({ command: "doctor", dryRun: false, unknown: [] });
  });
});
