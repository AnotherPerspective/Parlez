// Menu-command policy for `command.execute` (Parlez! M3.3).
//
// `command.execute` runs ANY After Effects menu command by numeric id, so a
// plain "confirm: true" on it would be a blind gate: the user would be asked
// to approve a number. Three lists make the decision readable instead:
//
//   - forbidden: refused even with confirm: true. Either a dedicated operation
//     does the same job with its own safeguards, or the command opens a modal
//     dialog that would block the script (the call hangs until a human closes
//     it), or it throws away work.
//   - allowed:   harmless (view, selection, fit/align, simple creations that
//     open no dialog) — runs without confirm.
//   - everything else: runs only with confirm: true.
//
// Only ids that appear in this repository are listed (the internal
// `command.list` in src/operations/command.ts and the 3973 fallback in
// src/operations/shape-contents.ts). Ids for Quit, Save, Close Project, New /
// Open Project and Preferences do not appear anywhere in the code, so they are
// NOT listed by number — guessing them would be worse than not listing them.
// They fall into "everything else" (confirm required) and are additionally
// refused inside After Effects by menu NAME (FORBIDDEN_MENU_NAMES below).
//
// Undo (16) and Redo (2035) stay exactly as before: allowed, and run outside
// the undo group (see Operation.undoGroup in command.ts). Their ids are
// repeated here as literals because importing command.ts from this file would
// create an import cycle through the registry; tests/command-policy.test.ts
// checks that they still match UNDO_COMMAND_ID / REDO_COMMAND_ID.

export interface MenuCommandEntry {
  /** English menu name, as in `command.list`. */
  name: string;
  /** One plain-Italian line: why the command sits in this list. */
  reason: string;
}

export const FORBIDDEN_COMMANDS: Readonly<Record<number, MenuCommandEntry>> = {
  2004: {
    name: "New Composition",
    reason:
      "apre la finestra «Impostazioni composizione», che blocca lo script finché qualcuno non la chiude; usa l'operazione comp.create",
  },
  2019: {
    name: "New Solid",
    reason:
      "apre la finestra «Impostazioni solido», che blocca lo script; usa l'operazione layer.create_solid",
  },
  2030: {
    name: "New Camera",
    reason:
      "apre la finestra «Impostazioni videocamera», che blocca lo script; usa l'operazione layer.create_camera",
  },
  2031: {
    name: "New Light",
    reason:
      "apre la finestra «Impostazioni luce», che blocca lo script; usa l'operazione layer.create_light",
  },
  2071: {
    name: "Pre-compose",
    reason:
      "apre la finestra «Pre-componi», che blocca lo script; usa l'operazione comp.precompose",
  },
  2055: {
    name: "Purge Image Caches",
    reason: "svuota la cache in memoria di After Effects; usa l'operazione project.purge",
  },
  3101: {
    name: "Purge All Memory & Disk Cache",
    reason:
      "svuota memoria e cache su disco (e può aprire una finestra di avviso che blocca lo script); usa l'operazione project.purge",
  },
};

export const ALLOWED_COMMANDS: Readonly<Record<number, MenuCommandEntry>> = {
  16: {
    name: "Undo",
    reason: "annulla l'ultima azione; resta come prima (gira fuori dal gruppo di annullamento)",
  },
  2035: {
    name: "Redo",
    reason: "ripete l'azione annullata; resta come prima (gira fuori dal gruppo di annullamento)",
  },
  2005: { name: "New Folder", reason: "crea una cartella vuota, senza finestre" },
  2025: { name: "New Adjustment Layer", reason: "crea un livello di regolazione, senza finestre" },
  2028: { name: "New Null Object", reason: "crea un oggetto nullo, senza finestre" },
  2040: { name: "Deselect All", reason: "cambia solo la selezione" },
  2156: {
    name: "Fit to Comp",
    reason: "adatta il livello alla composizione; si annulla con Ctrl+Z",
  },
  2157: {
    name: "Fit to Comp Width",
    reason: "adatta il livello alla larghezza della composizione; si annulla con Ctrl+Z",
  },
  2158: {
    name: "Fit to Comp Height",
    reason: "adatta il livello all'altezza della composizione; si annulla con Ctrl+Z",
  },
  2450: { name: "Fit to Screen", reason: "cambia solo lo zoom della vista" },
  2501: { name: "Snap to Grid", reason: "accende o spegne l'aggancio alla griglia nella vista" },
  2691: { name: "Render Queue", reason: "mostra il pannello della coda di render" },
  10312: {
    name: "Align Layers to Composition",
    reason: "allinea i livelli alla composizione; si annulla con Ctrl+Z",
  },
};

/**
 * Commands refused INSIDE After Effects by menu name, whatever their id:
 * `command.execute` resolves each name with app.findMenuCommandId and refuses
 * when it matches the requested id. A second net for the commands whose ids
 * are not known here (see the header). Limits, stated plainly: the names are
 * the English menu names and were not verified on a running After Effects; on
 * a localized After Effects findMenuCommandId finds nothing and only the
 * confirm gate protects. Every entry is refused, never allowed, so a wrong
 * name can only fail to block — it cannot open anything up.
 */
export const FORBIDDEN_MENU_NAMES: readonly MenuCommandEntry[] = [
  { name: "New Project", reason: "chiude il progetto aperto; usa l'operazione project.new" },
  { name: "Open Project...", reason: "chiude il progetto aperto; usa l'operazione project.open" },
  { name: "Close Project", reason: "chiude il progetto aperto e può perdere le modifiche" },
  { name: "Save", reason: "sovrascrive il file del progetto; usa lo strumento ae_save_project" },
  { name: "Save As...", reason: "apre la finestra «Salva con nome», che blocca lo script" },
  { name: "Save a Copy...", reason: "apre una finestra di salvataggio, che blocca lo script" },
  { name: "Increment and Save", reason: "scrive un nuovo file del progetto su disco" },
  { name: "Revert", reason: "butta tutte le modifiche dall'ultimo salvataggio" },
  { name: "Exit", reason: "chiude After Effects" },
  { name: "Quit After Effects", reason: "chiude After Effects" },
  {
    name: "General...",
    reason: "apre le preferenze di After Effects in una finestra che blocca lo script",
  },
  {
    name: "Remove Unused Footage",
    reason: "cancella filmati dal progetto; usa l'operazione project.remove_unused_footage",
  },
  {
    name: "Reduce Project",
    reason: "cancella elementi dal progetto; usa l'operazione project.reduce",
  },
  {
    name: "Consolidate All Footage",
    reason: "elimina filmati doppi; usa l'operazione project.consolidate_footage",
  },
];

export type CommandVerdict =
  | { kind: "forbidden"; reason: string }
  | { kind: "allowed" }
  | { kind: "confirm"; reason: string };

function own<T>(table: Readonly<Record<number, T>>, id: number): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
}

/** What `command.execute` may do with this id, decided on the Node side. */
export function commandVerdict(id: unknown): CommandVerdict {
  if (typeof id === "number") {
    const forbidden = own(FORBIDDEN_COMMANDS, id);
    if (forbidden) {
      return {
        kind: "forbidden",
        reason: `il comando di menu ${id} («${forbidden.name}») è vietato: ${forbidden.reason}`,
      };
    }
    if (own(ALLOWED_COMMANDS, id)) return { kind: "allowed" };
  }
  return {
    kind: "confirm",
    reason: `esegue il comando di menu ${String(id)}, che non è nella lista dei comandi innocui: può cambiare o cancellare qualcosa senza che si veda prima cosa`,
  };
}
