// Confirmation gate for operations that delete, overwrite or rename
// (Parlez! M3.2 — file name provisional).
//
// Project rule: never delete, overwrite or rename without the user's consent.
// Same contract as the appConfig gate in registry.ts, extended:
//   - `destructive: true`  — the call always needs confirm: true;
//   - `destructive: fn`    — fn(args) returns the reason when THESE arguments
//                            need confirm (a rename via `name`, replace: true…)
//                            and null when they do not;
//   - `forbidden: fn`      — refused even with confirm: true (menu commands
//                            that would block or discard work, see
//                            command-policy.ts).
//
// The rules live in this one table rather than in each operation file so the
// whole list can be reviewed in one place and kumo's files stay close to
// upstream. registerOp applies them, so they hold whatever imports what.
// The check runs on the Node side, before any code is generated, in both
// places an operation can enter: ae_do and every batch.run child.
//
// Denial texts are plain Italian: the model relays them to the user, who is
// the one who must say yes. The 11 appConfig operations keep their own gate
// unchanged; eval.run is deliberately not listed (it stays off by default).

import { ALLOWED_COMMANDS, FORBIDDEN_COMMANDS, commandVerdict } from "./command-policy.js";
import { outputOverwriteReason } from "./operations/aerender-paths.js";
import type { Denial } from "./policy.js";
import type { DestructiveRule, Operation, OperationParam } from "./registry.js";

type Args = Record<string, unknown>;

export interface ConfirmRule {
  destructive: DestructiveRule;
  /**
   * Plain Italian. For `destructive: true`: what the operation does, used in
   * the denial ("'layer.delete' <reason>"). For a function: when confirm is
   * needed, shown by ae_catalog.
   */
  reason: string;
  forbidden?: (args: Args) => string | null;
  /** Extra machine-readable facts for ae_catalog (e.g. command id lists). */
  catalog?: Record<string, unknown>;
}

function hasKey(obj: unknown, key: string): boolean {
  return (
    obj !== null &&
    typeof obj === "object" &&
    Object.prototype.hasOwnProperty.call(obj, key) &&
    (obj as Args)[key] !== undefined
  );
}

const always = (reason: string): ConfirmRule => ({ destructive: true, reason });

export const CONFIRM_RULES: Readonly<Record<string, ConfirmRule>> = {
  // --- The 19 identified by Fable (project.rename and command.execute are
  // conditional in practice: dryRun / the command lists). ---
  "comp.delete": always("cancella una composizione dal progetto"),
  "layer.delete": always("cancella uno o più livelli"),
  "project.clear": always("cancella tutti gli elementi del progetto"),
  "project.delete_item": always("cancella un elemento del progetto"),
  "project.new": always(
    "chiude il progetto aperto (senza salvarlo, se non chiedi save) e ne apre uno nuovo: le modifiche non salvate vanno perse",
  ),
  "project.open": always(
    "chiude il progetto aperto (senza salvarlo, se non chiedi save) e ne apre un altro: le modifiche non salvate vanno perse",
  ),
  "project.reduce": always("toglie dal progetto tutto ciò che non serve alle composizioni scelte"),
  "project.remove_unused_footage": always("cancella dal progetto i filmati che non sono usati"),
  "project.consolidate_footage": always(
    "elimina i filmati doppi del progetto e li sostituisce con uno solo",
  ),
  "render.clear_queue": always("svuota la coda di render"),
  "render.remove_item": always("toglie un elemento dalla coda di render"),
  "effect.remove": always("cancella un effetto da un livello"),
  "mask.remove": always("cancella una maschera"),
  "keyframe.remove": always("cancella dei keyframe"),
  "marker.remove": always("cancella dei marcatori"),
  "expression.remove": always("cancella un'espressione"),
  "property.remove": always(
    "cancella una proprietà (per esempio un gruppo di una forma o un animatore di testo)",
  ),
  "project.rename": {
    destructive: (args) =>
      args.dryRun === true
        ? null
        : "rinomina in blocco elementi e livelli del progetto (con dryRun: true mostra soltanto cosa cambierebbe)",
    reason: "sempre, tranne con dryRun: true (che mostra soltanto cosa cambierebbe)",
  },
  "command.execute": {
    destructive: (args) => {
      const verdict = commandVerdict(args.id);
      return verdict.kind === "confirm" ? verdict.reason : null;
    },
    forbidden: (args) => {
      const verdict = commandVerdict(args.id);
      return verdict.kind === "forbidden" ? verdict.reason : null;
    },
    reason:
      "dipende dal comando: quelli in allowedIds passano senza conferma, quelli in forbiddenIds sono vietati anche con confirm: true, tutti gli altri chiedono confirm: true",
    catalog: {
      allowedIds: Object.keys(ALLOWED_COMMANDS).map(Number),
      forbiddenIds: Object.keys(FORBIDDEN_COMMANDS).map(Number),
    },
  },

  // --- The 10 added by the inventory (eval.run excluded on purpose: it stays
  // off by default and a confirm would only be a doorbell, not a lock). ---
  "comp.remove_guide": always("cancella una guida della composizione"),
  "egp.export_mogrt": always(
    "scrive un file .mogrt su disco e, se esiste già un file con lo stesso nome, lo sovrascrive",
  ),
  "footage.replace": always("cambia il file a cui il filmato è collegato"),
  "footage.replace_with_solid": always(
    "sostituisce il filmato con un solido: il collegamento al file originale si perde",
  ),
  "footage.replace_with_placeholder": always(
    "sostituisce il filmato con un segnaposto: il collegamento al file originale si perde",
  ),
  "instance.start": always(
    "avvia un altro After Effects; con copyFrom/copyTo copia un progetto e può sovrascrivere il file di destinazione",
  ),
  "instance.stop": always(
    "chiude un After Effects in esecuzione (anche quello principale); con discardChanges butta le modifiche non salvate",
  ),
  "layer.remove_guide": always("cancella una guida"),
  "project.auto_fix_expressions": always(
    "riscrive molte espressioni del progetto in un colpo solo, senza mostrare prima cosa cambia",
  ),

  // --- Fable's decisions on the inventory's doubts (§4): the six that
  // "replace" become mandatory. ---
  "effect.set_dropdown_items": always("sostituisce le voci di un menu a discesa di un effetto"),
  "egp.set_alternate_source": always(
    "sostituisce la sorgente di un livello nel template di grafica essenziale",
  ),
  "layer.replace_source": always("sostituisce ciò che il livello mostra con un altro elemento"),
  "project.replace_font": always("sostituisce un font in tutto il progetto"),
  "project.set_xmp": always("sostituisce tutti i metadati XMP del progetto"),
  "text.paste_range": always("sostituisce testo e stile di una parte del testo"),

  // --- Checkpoints (M3.1): restore replaces the project file, delete removes
  // a file from disk. ---
  "checkpoint.restore": always(
    "sostituisce il file del progetto con il checkpoint scelto e lo riapre (prima salva lo stato attuale in un checkpoint «prima-del-ripristino»)",
  ),
  "checkpoint.delete": always("cancella per sempre un file di checkpoint dal disco"),

  // --- Conditional: only some arguments delete, overwrite or rename.
  // validateOpArgs does not fill defaults, so an omitted argument is read
  // here exactly as the operation's toJsx reads it. ---
  "comp.set_props": {
    destructive: (args) =>
      hasKey(args.props, "name") ? "rinomina la composizione (props contiene name)" : null,
    reason: "solo se props contiene name (rinomina la composizione)",
  },
  "layer.set_props": {
    destructive: (args) =>
      hasKey(args.props, "name") ? "rinomina uno o più livelli (props contiene name)" : null,
    reason: "solo se props contiene name (rinomina i livelli)",
  },
  "item.set_props": {
    destructive: (args) =>
      args.name !== undefined ? "rinomina un elemento del progetto (è indicato name)" : null,
    reason: "solo se è indicato name (rinomina l'elemento)",
  },
  "keyframe.apply": {
    destructive: (args) =>
      args.replace === true
        ? "cancella i keyframe che la proprietà ha già prima di scrivere quelli nuovi (replace: true)"
        : null,
    reason: "solo con replace: true (cancella i keyframe esistenti)",
  },
  // M6.3: same replace switch as keyframe.apply.
  "keyframe.apply_ease": {
    destructive: (args) =>
      args.replace === true
        ? "cancella i keyframe che la proprietà ha già prima di scrivere quelli nuovi (replace: true)"
        : null,
    reason: "solo con replace: true (cancella i keyframe esistenti)",
  },
  "layer.set_visibility_schedule": {
    // toJsx: `args.mode ?? "opacity"`; any other value is rejected there.
    destructive: (args) =>
      args.mode === undefined || args.mode === "opacity"
        ? "sostituisce i keyframe di opacità che i livelli hanno già (mode opacity, il predefinito)"
        : null,
    reason: "solo con mode opacity, il predefinito (sostituisce i keyframe di opacità)",
  },
  "layer.split_groups": {
    destructive: (args) =>
      args.keepOriginal === true
        ? null
        : "cancella il livello originale dopo averlo diviso (keepOriginal non è true)",
    reason: "sempre, tranne con keepOriginal: true (altrimenti cancella il livello originale)",
  },
  "layer.convert_to_shapes": {
    destructive: (args) =>
      args.removeSource === true || args.removeFootage === true
        ? "cancella i livelli vettoriali originali (removeSource) e, con removeFootage, anche i loro filmati"
        : null,
    reason: "solo con removeSource o removeFootage (cancella livelli o filmati originali)",
  },
  "project.purge": {
    // toJsx treats every target except "image" as a purge that includes undo.
    destructive: (args) =>
      args.target === "image"
        ? null
        : "svuota anche la cronologia di annullamento: dopo non si può più tornare indietro con Ctrl+Z",
    reason: "sempre, tranne con target: 'image' (altrimenti svuota la cronologia di annullamento)",
  },
  "footage.set_proxy": {
    // Same order as toJsx: a solid or placeholder proxy wins over `path`.
    destructive: (args) =>
      args.solidColor === undefined && args.placeholder !== true && args.path === undefined
        ? "toglie il proxy dal filmato (non è indicato path, solidColor né placeholder)"
        : null,
    reason: "solo senza path, solidColor e placeholder (toglie il proxy)",
  },
  "aerender.start": {
    // Reads the disk: the same file (or frames of a [#####] sequence) aerender would write.
    destructive: (args) => outputOverwriteReason(args),
    reason:
      "solo se il file di uscita (o i fotogrammi della sequenza) esiste già: verrebbe sovrascritto",
  },
};

/** The consent parameter injected into every operation with a confirm rule. */
export const DESTRUCTIVE_CONFIRM_PARAM: OperationParam = {
  name: "confirm",
  type: "boolean",
  description:
    "Set to true only after the user explicitly agreed to this deletion, overwrite or rename. " +
    "Without it the call is refused (see the operation's `confirm` entry in ae_catalog for when it is needed).",
  required: false,
};

/** Attach the table's rule to `op` (called by registerOp). */
export function applyConfirmRule(op: Operation): void {
  const rule = Object.prototype.hasOwnProperty.call(CONFIRM_RULES, op.name)
    ? CONFIRM_RULES[op.name]
    : undefined;
  if (rule) {
    if (op.destructive === undefined) op.destructive = rule.destructive;
    if (op.destructiveReason === undefined) op.destructiveReason = rule.reason;
    if (op.forbidden === undefined && rule.forbidden) op.forbidden = rule.forbidden;
  }
  // Optional in the schema on purpose: a required param would turn a missing
  // confirm into a generic INVALID_ARGS, and the user would never read the
  // plain explanation below.
  if ((op.destructive || op.forbidden) && !op.params.some((p) => p.name === "confirm")) {
    op.params = [...op.params, DESTRUCTIVE_CONFIRM_PARAM];
  }
}

export interface ConfirmDenial extends Denial {
  /** True when confirm: true would let the call through. */
  confirmable: boolean;
}

const CONFIRM_HINT =
  "Chiedi all'utente se vuole davvero farlo. Passa confirm: true solo se l'utente l'ha chiesto o approvato esplicitamente, mai come effetto collaterale di altro lavoro.";

/** The reason confirm is needed for this call, or null when it is not. */
export function confirmReason(op: Operation, args: Args): string | null {
  if (!op.destructive) return null;
  if (op.destructive === true) return op.destructiveReason ?? "cancella, sovrascrive o rinomina";
  return op.destructive(args);
}

/**
 * Non-null when this call must be refused: always for a forbidden call, and
 * for a destructive one unless confirm === true. Shared by ae_do and
 * batch.run so the two paths say the same thing.
 */
export function denyUnconfirmed(op: Operation, args: Args): ConfirmDenial | null {
  const forbidden = op.forbidden ? op.forbidden(args) : null;
  if (forbidden) {
    return {
      message: `'${op.name}' non si può usare così: ${forbidden}. Non l'ho eseguita, e confirm: true non cambia nulla.`,
      hint: "Usa l'operazione indicata nel messaggio, oppure chiedi all'utente di farlo a mano in After Effects.",
      confirmable: false,
    };
  }
  if (args.confirm === true) return null;
  const reason = confirmReason(op, args);
  if (!reason) return null;
  const dryRun = op.params.some((p) => p.name === "dryRun")
    ? " Per vedere prima cosa cambierebbe, prova con dryRun: true."
    : "";
  return {
    message:
      `'${op.name}' ${reason}. Non l'ho eseguita: serve una conferma. ` +
      `Se l'utente è d'accordo, ripeti la stessa chiamata aggiungendo confirm: true.${dryRun}`,
    hint: CONFIRM_HINT,
    confirmable: true,
  };
}

/** What ae_catalog shows about the gate, or null for an ungated operation. */
export function confirmCatalogInfo(op: Operation): Record<string, unknown> | null {
  if (!op.destructive && !op.forbidden) return null;
  const rule = Object.prototype.hasOwnProperty.call(CONFIRM_RULES, op.name)
    ? CONFIRM_RULES[op.name]
    : undefined;
  return {
    required: op.destructive === true ? "always" : "conditional",
    ...(op.destructiveReason ? { reason: op.destructiveReason } : {}),
    ...rule?.catalog,
  };
}

/** Denial for a fixed tool (ae_save_project, ae_project_import_json). */
export function toolConfirmDenial(tool: string, reason: string): ConfirmDenial {
  return {
    message:
      `'${tool}' ${reason}. Non l'ho eseguito: serve una conferma. ` +
      "Se l'utente è d'accordo, ripeti la stessa chiamata aggiungendo confirm: true.",
    hint: CONFIRM_HINT,
    confirmable: true,
  };
}
