// The sveglia's part of `parlez setup` and `parlez doctor` (name provisional;
// src/sveglia-install.ts and cep/sveglia/sveglia.js say what it is).
//
// setup: copy it into the user's CEP extensions folder, next to the After
// Effects agent and panel. CEP's debug mode, which an unsigned extension
// needs, is only read; the command that switches it on is printed.
// doctor: report whether it is installed and current, and the debug mode.

import type { CommandRunner } from "./premiere/install.js";
import { installSveglia, svegliaDebugMode, svegliaStatus } from "./sveglia-install.js";

export interface SvegliaMachine {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  runCommand?: CommandRunner;
}

type Lang = "it" | "en";

const TEXT = {
  it: {
    wrote: (n: number, dir: string, dry: boolean) =>
      `${dry ? "scriverei" : "installata"} la sveglia di Parlez! per After Effects (${n} file): ${dir}`,
    same: (dir: string) => `sveglia di Parlez! già aggiornata: ${dir}`,
    why:
      "La sveglia è un'estensione invisibile: tiene vivo Parlez! quando After Effects apre una finestra " +
      "di attesa (caricamento di un progetto, Home, Salva con nome). Parte al prossimo avvio di After Effects.",
    ok: "sveglia di Parlez! installata e aggiornata",
    missing:
      "sveglia di Parlez! non installata: senza, Parlez! può fermarsi all'apertura dei progetti. Lancia parlez setup",
    stale: "sveglia di Parlez! da aggiornare. Lancia parlez setup",
    debugOn: (major: number) => `la sveglia può caricarsi (CSXS.${major} PlayerDebugMode = 1)`,
    debugOff: (major: number, cmd: string) =>
      `la sveglia è bloccata (CSXS.${major} PlayerDebugMode spento). Per accenderlo lancia, una volta sola, ` +
      `questo comando, poi riavvia After Effects: ${cmd}`,
    debugUnknown: (major: number, cmd: string) =>
      `non riesco a leggere CSXS.${major} PlayerDebugMode. Se Parlez! si ferma all'apertura dei progetti, lancia: ${cmd}`,
  },
  en: {
    wrote: (n: number, dir: string, dry: boolean) =>
      `${dry ? "would install" : "installed"} the Parlez! sveglia for After Effects (${n} files): ${dir}`,
    same: (dir: string) => `Parlez! sveglia already up to date: ${dir}`,
    why:
      "The sveglia is an invisible extension: it keeps Parlez! alive while After Effects shows a modal " +
      "window (loading a project, Home, Save As). It starts at the next launch of After Effects.",
    ok: "Parlez! sveglia installed and up to date",
    missing:
      "Parlez! sveglia not installed: without it Parlez! can stop when projects open. Run parlez setup",
    stale: "Parlez! sveglia needs updating. Run parlez setup",
    debugOn: (major: number) => `the sveglia can load (CSXS.${major} PlayerDebugMode = 1)`,
    debugOff: (major: number, cmd: string) =>
      `the sveglia is blocked (CSXS.${major} PlayerDebugMode off). Run this once, then restart After Effects: ${cmd}`,
    debugUnknown: (major: number, cmd: string) =>
      `cannot read CSXS.${major} PlayerDebugMode. If Parlez! stops when projects open, run: ${cmd}`,
  },
};

interface Marks {
  ok: string;
  note: string;
}

/** The setup step. Returns whether anything was (or would be) written. */
export async function svegliaSetupStep(
  machine: SvegliaMachine,
  lang: Lang,
  dryRun: boolean,
  out: (line: string) => void,
  marks: Marks,
): Promise<boolean> {
  const t = TEXT[lang];
  const report = await installSveglia({
    platform: machine.platform,
    env: machine.env,
    home: machine.home,
    dryRun,
  });
  if (report.written.length > 0) {
    out(`${marks.ok}${t.wrote(report.written.length, report.dir, dryRun)}`);
    out(`${marks.note}${t.why}`);
  } else {
    out(`${marks.ok}${t.same(report.dir)}`);
  }
  const debug = await svegliaDebugMode(machine.platform, machine.runCommand);
  if (debug.mode === "off") out(`${marks.note}${t.debugOff(debug.major, debug.command)}`);
  return report.written.length > 0;
}

/**
 * The doctor lines; `line(false, …)` counts as something to do. The debug
 * mode counts only on Windows, where the sveglia was needed and tested; on a
 * Mac it is a note (the sveglia there is written to work, not yet tried).
 */
export async function svegliaDoctorChecks(
  machine: SvegliaMachine,
  lang: Lang,
  line: (ok: boolean, text: string) => void,
  out: (text: string) => void,
  marks: Marks,
): Promise<void> {
  const t = TEXT[lang];
  const status = await svegliaStatus({
    platform: machine.platform,
    env: machine.env,
    home: machine.home,
  });
  if (status.current) line(true, t.ok);
  else line(false, status.installed ? t.stale : t.missing);
  const platform = machine.platform ?? process.platform;
  const debug = await svegliaDebugMode(platform, machine.runCommand);
  if (debug.mode === "on") line(true, t.debugOn(debug.major));
  else {
    const text =
      debug.mode === "off"
        ? t.debugOff(debug.major, debug.command)
        : t.debugUnknown(debug.major, debug.command);
    if (platform === "win32") line(false, text);
    else out(`${marks.note}${text}`);
  }
}
