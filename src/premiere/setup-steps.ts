// The Premiere Pro part of `parlez setup` and `parlez doctor`.
//
// setup: when a supported Premiere Pro is installed, copy the Parlez! panel
// into the user's CEP extensions folder (no administrator rights). Nothing
// else is written: CEP's debug mode, which an unsigned panel needs, is only
// read, and the command that switches it on is printed for the user.
// doctor: report the panel, the debug mode and the connected Premieres.
//
// Machines without Premiere see no Premiere lines at all, so After Effects'
// setup reads exactly as before.

import * as os from "node:os";

import { instanceLabel } from "../transport/instances.js";
import { MIN_PREMIERE_YEAR, PREMIERE_INSTANCES_DIR } from "./config.js";
import {
  type CommandRunner,
  type PremiereInstall,
  csxsMajorForPremiereYear,
  debugModeCommand,
  findPremiere,
  installPremierePanel,
  premierePanelStatus,
  readDebugMode,
} from "./install.js";
import { isPremierePaused, isPremiereReadOnly, livePremiereInstances } from "./transport.js";

export interface PremiereSetupMachine {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  applicationsDir?: string;
  premiereInstancesDir?: string;
  now?: number;
  /** Runs `reg` / `defaults` to read the debug mode; tests pass a fake. */
  runCommand?: CommandRunner;
}

type Lang = "it" | "en";

const TEXT = {
  it: {
    found: (y: number) => `Premiere Pro ${y} trovato`,
    unsupported: (y: number) =>
      `Premiere Pro ${y} trovato ma non supportato: Parlez! per Premiere funziona dal ${MIN_PREMIERE_YEAR}. Lo salto.`,
    wrote: (n: number, dir: string, dry: boolean) =>
      `${dry ? "scriverei" : "installato"} il pannello Parlez! per Premiere (${n} file): ${dir}`,
    same: (dir: string) => `pannello Parlez! per Premiere già aggiornato: ${dir}`,
    restart:
      "Riavvia Premiere Pro e apri il pannello dal menu Finestra → Estensioni → Parlez! " +
      "(in Premiere 2026: Finestra → Estensioni (versione precedente) → Parlez!). Parte su OFF: " +
      "Claude lavora solo dopo che lo accendi, e solo finché il pannello resta aperto.",
    panelOk: "Premiere Pro: pannello Parlez! installato e aggiornato",
    panelMissing: "Premiere Pro: pannello Parlez! non installato. Lancia parlez setup",
    panelStale: "Premiere Pro: pannello Parlez! da aggiornare. Lancia parlez setup",
    debugOn: (major: number) =>
      `Premiere Pro: i pannelli non firmati possono caricarsi (CSXS.${major} PlayerDebugMode = 1)`,
    debugOff: (major: number, cmd: string) =>
      `Premiere Pro: i pannelli non firmati sono bloccati (CSXS.${major} PlayerDebugMode spento). ` +
      `Per accenderlo lancia, una volta sola, questo comando, poi riavvia Premiere: ${cmd}`,
    debugUnknown: (major: number, cmd: string) =>
      `Premiere Pro: non riesco a leggere CSXS.${major} PlayerDebugMode. Se il pannello non compare nel menu, lancia: ${cmd}`,
    live: (label: string) => `Premiere Pro collegato con il pannello: ${label}`,
    livePaused: (label: string) =>
      `${label}: il pannello è su OFF, Claude è fermo finché non lo accendi`,
    liveReadOnly: (label: string) =>
      `${label}: il pannello è in «Sola lettura», Claude può solo guardare`,
    noLive:
      "nessun Premiere Pro collegato in questo momento. È normale se Premiere è chiuso o il pannello Parlez! non è aperto.",
  },
  en: {
    found: (y: number) => `Premiere Pro ${y} found`,
    unsupported: (y: number) =>
      `Premiere Pro ${y} found but not supported: Parlez! for Premiere needs ${MIN_PREMIERE_YEAR} or later. Skipping it.`,
    wrote: (n: number, dir: string, dry: boolean) =>
      `${dry ? "would install" : "installed"} the Parlez! panel for Premiere (${n} files): ${dir}`,
    same: (dir: string) => `Parlez! panel for Premiere already up to date: ${dir}`,
    restart:
      "Restart Premiere Pro and open the panel from Window → Extensions → Parlez! " +
      "(in Premiere 2026: Window → Extensions (Legacy) → Parlez!). It starts OFF: Claude works " +
      "only after you switch it on, and only while the panel stays open.",
    panelOk: "Premiere Pro: Parlez! panel installed and up to date",
    panelMissing: "Premiere Pro: Parlez! panel not installed. Run parlez setup",
    panelStale: "Premiere Pro: Parlez! panel needs updating. Run parlez setup",
    debugOn: (major: number) =>
      `Premiere Pro: unsigned panels can load (CSXS.${major} PlayerDebugMode = 1)`,
    debugOff: (major: number, cmd: string) =>
      `Premiere Pro: unsigned panels are blocked (CSXS.${major} PlayerDebugMode off). ` +
      `Run this once, then restart Premiere: ${cmd}`,
    debugUnknown: (major: number, cmd: string) =>
      `Premiere Pro: cannot read CSXS.${major} PlayerDebugMode. If the panel is not in the menu, run: ${cmd}`,
    live: (label: string) => `Premiere Pro connected through the panel: ${label}`,
    livePaused: (label: string) =>
      `${label}: the panel is OFF, Claude is stopped until you switch it on`,
    liveReadOnly: (label: string) =>
      `${label}: the panel says "Sola lettura", Claude can only look`,
    noLive:
      "no Premiere Pro connected right now. That is normal when Premiere is closed or the Parlez! panel is not open.",
  },
};

async function supportedPremiere(
  machine: PremiereSetupMachine,
  out: (line: string) => void,
  note: string,
  t: (typeof TEXT)["it"],
): Promise<PremiereInstall | null> {
  const found = await findPremiere(machine);
  for (const p of found) if (!p.supported) out(`${note}${t.unsupported(p.year)}`);
  return found.find((p) => p.supported) ?? null;
}

/** A supported Premiere Pro is installed (for `setup --only premiere`). */
export async function premiereInstalled(machine: PremiereSetupMachine): Promise<boolean> {
  return (await findPremiere(machine)).some((p) => p.supported);
}

/**
 * The setup step. Returns whether anything was (or would be) written; prints
 * nothing when no Premiere Pro is installed.
 */
export async function premiereSetupStep(
  machine: PremiereSetupMachine,
  lang: Lang,
  dryRun: boolean,
  out: (line: string) => void,
  marks: { ok: string; note: string },
): Promise<boolean> {
  const t = TEXT[lang];
  const premiere = await supportedPremiere(machine, out, marks.note, t);
  if (premiere === null) return false;
  out(`${marks.ok}${t.found(premiere.year)}`);
  const report = await installPremierePanel({
    platform: machine.platform,
    env: machine.env,
    home: machine.home ?? os.homedir(),
    dryRun,
  });
  if (report.written.length > 0) {
    out(`${marks.ok}${t.wrote(report.written.length, report.dir, dryRun)}`);
    if (!dryRun) out(t.restart);
    return true;
  }
  out(`${marks.ok}${t.same(report.dir)}`);
  return false;
}

/** The doctor's Premiere lines. `line(ok, text)` counts what is left to do. */
export async function premiereDoctorChecks(
  machine: PremiereSetupMachine,
  lang: Lang,
  line: (ok: boolean, text: string) => void,
  out: (line: string) => void,
  marks: { ok: string; note: string },
): Promise<void> {
  const t = TEXT[lang];
  const premiere = await supportedPremiere(machine, out, marks.note, t);
  if (premiere === null) return;
  const platform = machine.platform ?? process.platform;

  const status = await premierePanelStatus({
    platform,
    env: machine.env,
    home: machine.home ?? os.homedir(),
  });
  line(
    status.current,
    !status.installed ? t.panelMissing : status.current ? t.panelOk : t.panelStale,
  );

  const major = csxsMajorForPremiereYear(premiere.year);
  const mode = await readDebugMode(major, platform, machine.runCommand);
  const cmd = debugModeCommand(major, platform);
  if (mode === "on") line(true, t.debugOn(major));
  else if (mode === "off") line(false, t.debugOff(major, cmd));
  else out(`${marks.note}${t.debugUnknown(major, cmd)}`);

  const live = await livePremiereInstances(
    machine.premiereInstancesDir ?? PREMIERE_INSTANCES_DIR,
    machine.now ?? Date.now(),
  );
  if (live.length === 0) out(`${marks.note}${t.noLive}`);
  for (const instance of live) {
    const label = instanceLabel(instance);
    out(`${marks.ok}${t.live(label)}`);
    if (isPremierePaused(instance)) out(`${marks.note}${t.livePaused(label)}`);
    else if (isPremiereReadOnly(instance)) out(`${marks.note}${t.liveReadOnly(label)}`);
  }
}
