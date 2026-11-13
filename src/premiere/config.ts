// Parlez! for Premiere Pro: where things are and what they are called.
//
// Premiere shares the mailbox with After Effects (same per-user folder, same
// trust boundary, same request/response files) but its instances live in
// their own subfolder, <mailbox>/premiere/<id>/, next to After Effects'
// <mailbox>/instances/. After Effects' discovery reads only `instances/`,
// so it cannot see a Premiere instance and nothing After Effects does
// changes because Premiere is connected.

import * as path from "node:path";

import { PACKAGE_ROOT, RUNTIME_DIR } from "../config.js";

export const PREMIERE_INSTANCES_DIRNAME = "premiere";
export const PREMIERE_INSTANCES_DIR = path.join(RUNTIME_DIR, PREMIERE_INSTANCES_DIRNAME);

/** The ExtendScript agent the panel's host stub loads from the package. */
export const PREMIERE_AGENT_JSX = path.join(PACKAGE_ROOT, "jsx", "premiere-agent.jsx");

/** The CEP panel's files in the package (HTML, script, manifest). */
export const PREMIERE_PANEL_SRC = path.join(PACKAGE_ROOT, "premiere", "panel");

/** The ON/OFF pictures, shared with the After Effects panel. */
export const PREMIERE_PANEL_IMAGES_SRC = path.join(PACKAGE_ROOT, "jsx", "panel-images");

/** CEP extension bundle id; also the folder name under CEP/extensions. (nome provvisorio) */
export const CEP_BUNDLE_ID = "com.anotherperspective.parlez";

/** The host stub the installer writes into the installed panel. */
export const CEP_STUB_RELATIVE = path.join("host", "parlez-stub.jsx");

/** Oldest Premiere Parlez! supports; only 2026 has been tried. */
export const MIN_PREMIERE_YEAR = 2024;

/**
 * CEP runtime major ("CSXS.<n>") per Premiere year: the registry/defaults key
 * that holds PlayerDebugMode, which lets an unsigned panel load.
 */
export function csxsMajorForPremiereYear(year: number): number {
  return year >= 2025 ? 12 : 11;
}

export const PR_PAUSED_MESSAGE =
  "Claude è in pausa in Premiere Pro: accendi l'interruttore nel pannello Parlez!";
export const PR_PAUSED_HINT =
  "L'utente ha fermato Claude dal pannello Parlez! in Premiere Pro. Non riprovare e non cercare " +
  "altre strade: chiedi all'utente di mettere su ON il grande interruttore del pannello e riprova " +
  "solo quando lo dice.";

export const PR_READ_ONLY_MESSAGE =
  "Claude è in sola lettura in Premiere Pro: può guardare il progetto ma non modificarlo. " +
  "Per lasciarlo modificare, spegni «Sola lettura» nel pannello Parlez!";
export const PR_READ_ONLY_HINT =
  "L'utente ha scelto «Sola lettura» nel pannello Parlez! di Premiere: le letture funzionano, " +
  "le modifiche no. Continua con le sole letture, oppure chiedi all'utente di spegnere «Sola lettura».";

export const PR_NO_PANEL_MESSAGE =
  "Premiere Pro non risponde: il pannello Parlez! non è aperto (o Premiere è chiuso).";
export const PR_NO_PANEL_HINT =
  "Chiedi all'utente di aprire Premiere Pro e il pannello Parlez! (menu Finestra › Estensioni › Parlez!, " +
  "nelle versioni recenti Finestra › Estensioni (versione precedente) › Parlez!). Il pannello deve " +
  "restare aperto: chiuso, Claude è fermo. Se il pannello non c'è nel menu, va installato con " +
  "`parlez setup` e Premiere va riavviato.";
