// comp.audit (provisional name) — read-only checks on a comp: 14 rules taken
// as a list from malkawi06/After-Effects-mcp-pro and rewritten on kumo's
// helpers. Returns findings in plain Italian with a one-line fix each, plus a
// summary with counts. The ES3 rule code lives in audit-rules.ts.

import { jsxCompPreamble, jsxFail, jsxVal, registerOp } from "../registry.js";
import { AUDIT_CORE, AUDIT_DEFAULTS, AUDIT_RULE_IDS, AUDIT_RULES } from "./audit-rules.js";

export interface AuditConfig {
  regole: string[];
  margineAreaSicura: number;
  durataMinimaLineare: number;
  profondita: number;
}

/**
 * Normalize and check the arguments. Returns the config, or a message for a
 * failure decided on the Node side (reported through jsxFail).
 */
export function auditConfig(args: Record<string, unknown>): AuditConfig | string {
  let regole = AUDIT_RULE_IDS;
  if (args.regole !== undefined) {
    if (!Array.isArray(args.regole) || args.regole.some((r) => typeof r !== "string")) {
      return "regole must be an array of rule ids";
    }
    const unknown = (args.regole as string[]).filter((r) => !AUDIT_RULE_IDS.includes(r));
    if (unknown.length > 0) {
      return `unknown rule id(s): ${unknown.join(", ")}. Known: ${AUDIT_RULE_IDS.join(", ")}`;
    }
    if (args.regole.length === 0)
      return "regole is empty: name at least one rule, or omit it for all";
    const wanted = new Set(args.regole as string[]);
    // Report order stays the table's, whatever order the caller listed.
    regole = AUDIT_RULE_IDS.filter((id) => wanted.has(id));
  }
  const margin = args.margineAreaSicura ?? AUDIT_DEFAULTS.margineAreaSicura;
  if (typeof margin !== "number" || !(margin >= 0 && margin < 0.5)) {
    return "margineAreaSicura must be a fraction from 0 to below 0.5 (0.05 = 5%)";
  }
  const minDur = args.durataMinimaLineare ?? AUDIT_DEFAULTS.durataMinimaLineare;
  if (typeof minDur !== "number" || !(minDur >= 0)) {
    return "durataMinimaLineare must be a number of seconds, 0 or more";
  }
  const depth = args.profondita ?? AUDIT_DEFAULTS.profondita;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 10) {
    return "profondita must be a whole number from 0 to 10";
  }
  return { regole, margineAreaSicura: margin, durataMinimaLineare: minDur, profondita: depth };
}

/** The generated body: core, only the selected rules' functions, their table, the run. */
export function buildAuditJsx(args: Record<string, unknown>): string {
  const cfg = auditConfig(args);
  if (typeof cfg === "string") return jsxFail(cfg);
  const selected = AUDIT_RULES.filter((r) => cfg.regole.includes(r.id));
  // Identifiers and severities are this file's own literals, not arguments;
  // still encoded through jsxVal so the table reads like every other value.
  const table = selected
    .map(
      (r) =>
        `{ id: ${jsxVal(r.id)}, gravita: ${jsxVal(r.gravita)}, soloPrincipale: ${jsxVal(r.soloPrincipale === true)}, fn: ${r.fn} }`,
    )
    .join(",\n            ");
  return `
            ${AUDIT_CORE}
            ${selected.map((r) => r.code).join("\n")}
            var _auCfg = ${jsxVal({
              margineAreaSicura: cfg.margineAreaSicura,
              durataMinimaLineare: cfg.durataMinimaLineare,
              profondita: cfg.profondita,
            })};
            var _auRules = [
            ${table}
            ];
            ${jsxCompPreamble(args)}
            return _auRun(_comp, _auCfg, _auRules);
        `;
}

registerOp({
  name: "comp.audit",
  category: "comp",
  readOnly: true,
  description:
    "Read-only quality check of a comp (provisional name): 14 rules — expression errors, keyframes past the end, linear keyframes on motion, moving layers without motion blur, layers outside the comp time, missing footage, CC Radial Blur, blur on adjustment layers without CC RepeTile, layers over 30,000 px, near-coplanar 3D siblings, 2D text under 3D layers, resting elements outside the 5% safe area, comp motion blur off while layers move, empty comp. " +
    "Returns segnalazioni [{ regola, gravita: errore|avviso|nota, composizione, livello, indice, tempo, messaggio, comeCorreggere }] in Italian plus riepilogo with counts. Changes nothing and creates nothing temporary. " +
    `Rule ids for 'regole': ${AUDIT_RULE_IDS.join(", ")}.`,
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "regole",
      type: "array",
      description: "Rule ids to run (default: all 14)",
      required: false,
    },
    {
      name: "profondita",
      type: "number",
      description:
        "Precomp levels to check as well (default 0 = only this comp). The safe-area rule runs on the top comp only.",
      required: false,
      default: AUDIT_DEFAULTS.profondita,
    },
    {
      name: "margineAreaSicura",
      type: "number",
      description: "Safe-area margin as a fraction of the frame (default 0.05 = 5%)",
      required: false,
      default: AUDIT_DEFAULTS.margineAreaSicura,
    },
    {
      name: "durataMinimaLineare",
      type: "number",
      description:
        "Shortest linear keyframe segment (seconds, visible part) to report (default 0.2)",
      required: false,
      default: AUDIT_DEFAULTS.durataMinimaLineare,
    },
  ],
  toJsx: buildAuditJsx,
});
