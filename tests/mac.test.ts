// The macOS side, without a Mac. Every check here runs on Windows too: the
// platform is passed in (as kumo already does for buildLaunchPlan), and the
// Mac's folders — /Applications, ~/Library/Preferences, the mailbox — are temp
// directories laid out the way macOS lays them out. What only a real Mac can
// show (After Effects reading those folders, the permissions macOS asks for)
// is in docs/mac-checklist.md.

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stubSource } from "../src/agent-install.js";
import { AGENT_STUB_FILENAME, PANEL_FILENAME, pushPathName, systemTempDir } from "../src/config.js";
import { aerenderLaunchMode, aerenderLaunchModes } from "../src/operations/aerender-paths.js";
import { panelSource } from "../src/panel-install.js";
import {
  type SetupEnvironment,
  claudeConfig,
  prefsFileFor,
  readScriptingPref,
  runDoctor,
  runSetup,
} from "../src/setup.js";

let tmp: string;

const never = () => {
  throw new Error("must not be asked");
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "parlez-mac-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the mailbox's temp folder on macOS", () => {
  // MCP clients built on the SDK's default environment hand the server only
  // HOME, LOGNAME, PATH, SHELL, TERM and USER. Without TMPDIR, os.tmpdir() is
  // /tmp, while the Terminal that ran `parlez setup` pinned /var/folders/…/T
  // into the startup script: the agent and the server would never meet.
  it("asks the system for the per-user temp folder when TMPDIR is missing", () => {
    let asked = 0;
    const dir = systemTempDir("darwin", { HOME: "/Users/me" }, () => {
      asked++;
      return "/var/folders/ab/cd1234/T/";
    });
    expect(asked).toBe(1);
    expect(dir).toBe("/var/folders/ab/cd1234/T");
  });

  it("treats an empty TMPDIR as missing", () => {
    expect(systemTempDir("darwin", { TMPDIR: "  " }, () => "/var/folders/ab/cd1234/T/")).toBe(
      "/var/folders/ab/cd1234/T",
    );
  });

  it("keeps Node's answer when TMPDIR is set, or when the system has none to give", () => {
    expect(systemTempDir("darwin", { TMPDIR: "/var/folders/ab/cd1234/T/" }, never)).toBe(
      os.tmpdir(),
    );
    expect(systemTempDir("darwin", {}, () => null)).toBe(os.tmpdir());
    expect(systemTempDir("darwin", {}, () => "relative/T")).toBe(os.tmpdir());
  });

  it("never asks on Windows", () => {
    expect(systemTempDir("win32", {}, never)).toBe(os.tmpdir());
  });

  it("pins exactly that folder into the startup script", () => {
    const src = stubSource(
      "/usr/local/lib/node_modules/parlez/jsx/agent.jsx",
      "/var/folders/ab/cd1234/T/mcp-aftereffects",
      "/var/folders/ab/cd1234/T/mcp-aftereffects/runtime",
    );
    expect(src).toContain(
      "$.global.AE_MCP_AGENT_MAILBOX = '/var/folders/ab/cd1234/T/mcp-aftereffects/runtime';",
    );
    expect(src).toContain("var runtimeRoot = '/var/folders/ab/cd1234/T/mcp-aftereffects';");
  });
});

describe("messages that name the push path", () => {
  it("say osascript on macOS and AfterFX.exe -r on Windows", () => {
    expect(pushPathName("darwin")).toBe("osascript (DoScript)");
    expect(pushPathName("win32")).toBe("AfterFX.exe -r");
  });
});

describe("aerender on macOS", () => {
  it("has no shell mode: that one is cmd.exe", () => {
    expect(aerenderLaunchModes("darwin")).toEqual(["attached", "detached"]);
    expect(aerenderLaunchModes("win32")).toEqual(["attached", "shell", "detached"]);
    expect(aerenderLaunchMode("darwin", { AE_MCP_AERENDER_LAUNCH: "shell" })).toEqual({
      mode: "detached",
      ignored: "shell",
    });
    expect(aerenderLaunchMode("darwin", { AE_MCP_AERENDER_LAUNCH: "attached" })).toEqual({
      mode: "attached",
      ignored: null,
    });
  });
});

describe("the Claude configuration printed on macOS", () => {
  it("quotes for zsh with single quotes, so a ! or $ in a path stays literal", () => {
    const cfg = claudeConfig({
      platform: "darwin",
      env: {},
      home: "/Users/me",
      packageRoot: "/Users/me/Parlez! beta/it's/node_modules/parlez",
      execPath: "/usr/local/bin/node",
    });
    expect(cfg.claudeCode).toBe(
      "claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 -- '/usr/local/bin/node' " +
        "'/Users/me/Parlez! beta/it'\\''s/node_modules/parlez/dist/index.js'",
    );
    expect(cfg.args).toEqual(["/Users/me/Parlez! beta/it's/node_modules/parlez/dist/index.js"]);
  });

  it("points at Homebrew's stable node, not the versioned one a brew upgrade removes", () => {
    const cfg = claudeConfig({
      platform: "darwin",
      env: {},
      home: "/Users/me",
      packageRoot: "/opt/homebrew/lib/node_modules/parlez",
      execPath: "/opt/homebrew/Cellar/node@24/24.11.0/bin/node",
    });
    expect(cfg.command).toBe("/opt/homebrew/opt/node@24/bin/node");
    expect(cfg.claudeCode).toContain("-- '/opt/homebrew/opt/node@24/bin/node' ");
    expect(JSON.parse(cfg.desktopJson).mcpServers.parlez.command).toBe(
      "/opt/homebrew/opt/node@24/bin/node",
    );
  });

  it("gives Claude Desktop the full path of npx and a PATH where node is", () => {
    const cfg = claudeConfig({
      platform: "darwin",
      env: {},
      home: "/Users/me",
      packageRoot: "/Users/me/.npm/_npx/1a2b/node_modules/parlez",
      execPath: "/usr/local/bin/node",
    });
    expect(cfg.claudeCode).toBe(
      "claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 -- npx -y parlez",
    );
    expect(JSON.parse(cfg.desktopJson).mcpServers.parlez).toEqual({
      command: "/usr/local/bin/npx",
      args: ["-y", "parlez"],
      env: { AE_MCP_PULL_ONLY: "1", PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  });

  it("leaves Windows as it was", () => {
    const cfg = claudeConfig({
      platform: "win32",
      env: {},
      home: "C:\\Users\\me",
      packageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\parlez",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(cfg.claudeCode).toContain('-- "C:\\Program Files\\nodejs\\node.exe" "');
    expect(JSON.parse(cfg.desktopJson).mcpServers.parlez.env).toEqual({ AE_MCP_PULL_ONLY: "1" });
  });
});

/** A fake Mac under `tmp`: /Applications, ~/Library/Preferences, the mailbox. */
function fakeMac(extra: Partial<SetupEnvironment> = {}) {
  const home = path.join(tmp, "Users", "me");
  const apps = path.join(tmp, "Applications");
  const profileRoot = path.join(home, "Library", "Preferences", "Adobe", "After Effects");
  const instancesDir = path.join(
    tmp,
    "var",
    "folders",
    "T",
    "mcp-aftereffects",
    "runtime",
    "instances",
  );
  const env: SetupEnvironment = {
    platform: "darwin",
    env: {},
    home,
    applicationsDir: apps,
    nodeVersion: "24.11.0",
    packageRoot: path.join(tmp, "usr", "local", "lib", "node_modules", "parlez"),
    execPath: "/usr/local/bin/node",
    instancesDir,
    lang: "it",
    confirm: async () => false,
    ...extra,
  };
  return { env, home, apps, profileRoot, instancesDir };
}

async function addMacApp(apps: string, year: number): Promise<void> {
  const bundle = path.join(apps, `Adobe After Effects ${year}`, `Adobe After Effects ${year}.app`);
  await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
}

async function addMacProfile(profileRoot: string, version: string, pref?: "0" | "1") {
  await fs.mkdir(path.join(profileRoot, version), { recursive: true });
  if (pref !== undefined) {
    await fs.writeFile(
      prefsFileFor(profileRoot, version),
      `["Main Pref Section v2"]\n\t"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "${pref}"\n`,
      "utf8",
    );
  }
}

function collect() {
  const lines: string[] = [];
  return { out: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("parlez setup and doctor on a Mac", () => {
  it("installs the startup script and the panel under ~/Library/Preferences", async () => {
    const m = fakeMac();
    await addMacApp(m.apps, 2026);
    await addMacProfile(m.profileRoot, "26.5", "1");
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(0);

    const scripts = path.join(m.profileRoot, "26.5", "Scripts");
    expect(await fs.readFile(path.join(scripts, "Startup", AGENT_STUB_FILENAME), "utf8")).toBe(
      stubSource(),
    );
    expect(await fs.readFile(path.join(scripts, "ScriptUI Panels", PANEL_FILENAME), "utf8")).toBe(
      await panelSource(),
    );
    expect(PANEL_FILENAME).toBe("Parlez!.jsx");

    const text = c.text();
    expect(text).toContain("After Effects 2026 trovato (cartella delle preferenze 26.5)");
    expect(text).toContain("-- '/usr/local/bin/node' '");
    expect(text).toContain(
      path.join(m.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    expect(text).toContain("osascript");
    expect(text).not.toContain("AfterFX.exe");
    expect(text).not.toContain("DA FARE");
  });

  it("names the Mac menu Adobe documents when the checkbox is off", async () => {
    const m = fakeMac();
    await addMacApp(m.apps, 2026);
    await addMacProfile(m.profileRoot, "26.5", "0");
    const c = collect();
    await runSetup({}, c.out, m.env);
    const c2 = collect();
    expect(await runDoctor({}, c2.out, m.env)).toBe(1);
    expect(c2.text()).toMatch(
      /DA FARE.*After Effects → Impostazioni → Script ed espressioni.*After Effects → Settings → Scripting & Expressions/,
    );
    expect(c2.text()).not.toContain("non ancora verificato");
  });

  it("says the startup script needs no Automation permission", async () => {
    const m = fakeMac();
    await addMacApp(m.apps, 2026);
    await addMacProfile(m.profileRoot, "26.5", "1");
    await runSetup({}, collect().out, m.env);
    const c = collect();
    expect(await runDoctor({}, c.out, m.env)).toBe(0);
    expect(c.text()).toMatch(/NOTA.*Automazione/);
    expect(c.text()).toContain(path.dirname(m.instancesDir));
  });

  it("tells the user to open After Effects once when ~/Library has no folder for it yet", async () => {
    const m = fakeMac();
    await addMacApp(m.apps, 2025);
    const c = collect();
    expect(await runSetup({}, c.out, m.env)).toBe(1);
    expect(c.text()).toContain("Apri After Effects 2025 una volta");
  });
});

describe("reading the scripting checkbox", () => {
  it("falls back to the other prefs files of the same version", async () => {
    const root = path.join(tmp, "prefs");
    await fs.mkdir(path.join(root, "26.5"), { recursive: true });
    await fs.writeFile(prefsFileFor(root, "26.5"), '"Pref_OTHER" = "1"\n', "utf8");
    await fs.writeFile(
      path.join(root, "26.5", "Adobe After Effects 26.5 Prefs-indep-general.txt"),
      '"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"\n',
      "utf8",
    );
    expect(await readScriptingPref(root, "26.5")).toBe("on");
  });

  it("does not read another version's file", async () => {
    const root = path.join(tmp, "prefs");
    await fs.mkdir(path.join(root, "26.5"), { recursive: true });
    await fs.writeFile(
      path.join(root, "26.5", "Adobe After Effects 26.3 Prefs.txt"),
      '"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"\n',
      "utf8",
    );
    expect(await readScriptingPref(root, "26.5")).toBe("unknown");
  });
});
