// Running one registered operation from the Node side (recipe.run).
//
// The gates are exactly those of ae_do (src/tools/do.ts), in the same order:
// capability policy, argument validation, app-configuration consent, the
// confirm gate. A recipe must not be a way around any of them — and batch.run
// re-applies all four to every child it inlines (src/operations/batch.ts).

import { denyUnconfirmed } from "../confirm-policy.js";
import { validateOpArgs } from "../opschema.js";
import { denyOperation } from "../policy.js";
import { denyAppConfig, getOp, wantsDialogSuppression, wantsUndoGroup } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";

export type ExecOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; errorCode?: string; result?: unknown };

export async function executeOp(
  transport: AeTransport,
  name: string,
  args: Record<string, unknown>,
  opts: { label?: string; timeoutMs?: number } = {},
): Promise<ExecOutcome> {
  const op = getOp(name);
  if (!op) return { ok: false, error: `operazione «${name}» non disponibile` };
  const denial = denyOperation(op);
  if (denial) return { ok: false, error: denial.message, errorCode: "FORBIDDEN" };
  const validated = validateOpArgs(op, args);
  if (!validated.ok) {
    return {
      ok: false,
      error: `argomenti non validi per «${name}»: ${validated.issues.map((i) => `${i.path} — ${i.message}`).join("; ")}`,
      errorCode: "INVALID_ARGS",
    };
  }
  const consent = denyAppConfig(op, validated.value);
  if (consent) return { ok: false, error: consent, errorCode: "FORBIDDEN" };
  const unconfirmed = denyUnconfirmed(op, validated.value);
  if (unconfirmed) return { ok: false, error: unconfirmed.message, errorCode: "FORBIDDEN" };

  const jsx = op.toJsx(validated.value);
  const code = `
        var _opResult = (function() {
            ${jsx}
        })();
        return { result: _opResult };
    `;
  const res = await transport.execute({
    code,
    label: opts.label ?? name,
    undoGroup: wantsUndoGroup(op, validated.value),
    suppressDialogs: wantsDialogSuppression(op, validated.value),
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (!res.ok)
    return {
      ok: false,
      error: res.error ?? "errore di collegamento",
      errorCode: res.errorCode ?? "TRANSPORT",
    };
  const result = (res.result as { result?: unknown } | null)?.result;
  return { ok: true, result };
}
