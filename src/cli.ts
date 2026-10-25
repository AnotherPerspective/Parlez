// Command-line subcommands of the `mcp-aftereffects` binary. Without
// arguments the binary is the MCP server (stdio); with one it is a small
// maintenance tool for the pull path — installing the resident agent into
// After Effects' Startup folders, the switch panel (Parlez!, nome provvisorio)
// into its ScriptUI Panels folders, and looking at which instances are live.

import { INSTANCES_DIR, RUNTIME_DIR } from "./config.js";
import {
  type StubStatus,
  aeProfileRoot,
  agentInstallStatus,
  installAgent,
  uninstallAgent,
} from "./agent-install.js";
import { installPanel, panelInstallStatus, uninstallPanel } from "./panel-install.js";
import { describeInstance, listInstances } from "./transport/instances.js";

export const USAGE = `mcp-aftereffects — MCP server for Adobe After Effects

  mcp-aftereffects                    start the MCP server on stdio (what MCP clients run)
  mcp-aftereffects install-agent      install the resident agent into After Effects' user-level
                                      Scripts/Startup folder(s); needed to drive instances started
                                      with \`AfterFX.exe -m\`. Restart After Effects afterwards.
  mcp-aftereffects uninstall-agent    remove it again
  mcp-aftereffects agent-status       show where the agent is installed and whether it is current
  mcp-aftereffects install-panel      install the switch panel ("Claude can work" / "Claude stopped")
                                      into the user-level Scripts/ScriptUI Panels folder(s); it shows
                                      under Window after restarting After Effects
  mcp-aftereffects uninstall-panel    remove it again
  mcp-aftereffects panel-status       show where the panel is installed and whether it is current
  mcp-aftereffects instances          list the After Effects instances whose agent is live
  mcp-aftereffects help               this text

Options for install-/uninstall-/…-status of the agent and the panel:
  --version <major.minor>   only that After Effects version folder (e.g. 26.3); default: all present
  --dir <path>              an explicit Scripts/Startup (agent) or Scripts/ScriptUI Panels (panel)
                            folder instead of the profile-derived ones
  --dry-run                 report what would change without writing

Address an instance from the server side with AE_MCP_INSTANCE=<id or project file name>; name an
instance at launch by setting AE_MCP_INSTANCE in the environment that starts AfterFX.exe.
`;

interface ParsedArgs {
  command: string;
  version?: string;
  dir?: string;
  dryRun: boolean;
  unknown: string[];
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const parsed: ParsedArgs = { command, dryRun: false, unknown: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--version" && rest[i + 1]) parsed.version = rest[++i];
    else if (arg === "--dir" && rest[i + 1]) parsed.dir = rest[++i];
    else parsed.unknown.push(arg);
  }
  return parsed;
}

/** Run one subcommand; returns the process exit code. Never throws. */
export async function runCli(
  argv: string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.unknown.length > 0) {
    out(`unknown argument(s): ${args.unknown.join(" ")}\n`);
    out(USAGE);
    return 2;
  }
  const opts = { version: args.version, dir: args.dir, dryRun: args.dryRun };
  try {
    switch (args.command) {
      case "help":
      case "--help":
      case "-h":
        out(USAGE);
        return 0;

      case "install-agent": {
        const report = await installAgent(opts);
        for (const p of report.written) out(`${args.dryRun ? "would write" : "wrote"}    ${p}`);
        for (const p of report.unchanged) out(`up to date  ${p}`);
        if (report.written.length > 0 && !args.dryRun) {
          out("");
          out(
            "Restart After Effects for the agent to load. Then `mcp-aftereffects instances` lists it.",
          );
        }
        return 0;
      }

      case "uninstall-agent": {
        const report = await uninstallAgent(opts);
        if (report.removed.length === 0) out("nothing to remove");
        for (const p of report.removed) out(`${args.dryRun ? "would remove" : "removed"}  ${p}`);
        return 0;
      }

      case "agent-status":
        return printStatus(await agentInstallStatus(opts), "install-agent", out);

      case "install-panel": {
        const report = await installPanel(opts);
        for (const p of report.written) out(`${args.dryRun ? "would write" : "wrote"}    ${p}`);
        for (const p of report.unchanged) out(`up to date  ${p}`);
        if (report.written.length > 0 && !args.dryRun) {
          out("");
          out(
            "Restart After Effects, then open the panel from the Window menu. It starts on " +
              '"Claude fermo" (Claude stopped) until you switch it on.',
          );
        }
        return 0;
      }

      case "uninstall-panel": {
        const report = await uninstallPanel(opts);
        if (report.removed.length === 0 && report.foreign.length === 0) out("nothing to remove");
        for (const p of report.removed) out(`${args.dryRun ? "would remove" : "removed"}  ${p}`);
        for (const p of report.foreign) out(`left alone  ${p} (not written by install-panel)`);
        return 0;
      }

      case "panel-status":
        return printStatus(await panelInstallStatus(opts), "install-panel", out);

      case "instances": {
        const instances = await listInstances();
        out(`mailbox: ${RUNTIME_DIR}`);
        if (instances.length === 0) {
          out(
            `no instances registered under ${INSTANCES_DIR} — is the agent installed and After Effects running?`,
          );
          return 0;
        }
        for (const i of instances) out(`${i.alive ? "live " : "stale"}  ${describeInstance(i)}`);
        return 0;
      }

      default:
        out(`unknown command: ${args.command}\n`);
        out(USAGE);
        return 2;
    }
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** agent-status / panel-status: one line per After Effects version folder. */
function printStatus(statuses: StubStatus[], installCommand: string, out: (line: string) => void) {
  if (statuses.length === 0) {
    out(`no After Effects version folder under ${aeProfileRoot()}`);
    return 1;
  }
  for (const s of statuses) {
    const state = !s.installed
      ? "not installed"
      : s.current
        ? "installed"
        : `installed (stale — run ${installCommand})`;
    out(`${s.version.padEnd(8)} ${state.padEnd(40)} ${s.stubPath}`);
  }
  return 0;
}
