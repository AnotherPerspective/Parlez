// The transport to Premiere Pro: the pull path only.
//
// Premiere has nothing like `AfterFX.exe -r`, so there is no push: a call
// reaches Premiere only through the Parlez! panel, which serves its own
// mailbox (<mailbox>/premiere/<id>/) from jsx/premiere-agent.jsx. The file
// protocol is After Effects' pull path unchanged — request-<id>.json in,
// response-<id>.json out, consume-on-read, the id taken from the file name —
// and so are the heartbeat rules (src/transport/instances.ts), pointed at
// Premiere's own folder.
//
// Kept apart from FileIpcTransport on purpose: After Effects' transport is
// not touched at all, so nothing Premiere adds can change how After Effects
// behaves.

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  AGENT_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  LIVENESS_CHECK_MS,
  POLL_INTERVAL_MS,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  RUNTIME_DIR_MODE,
} from "../config.js";
import type { AeErrorCode } from "../errors.js";
import { describeRequest } from "../request-titles.js";
import type { AeTransport, EvalRequest, EvalResult } from "../transport/AeTransport.js";
import { serializeRequest } from "../transport/FileIpcTransport.js";
import {
  type InstanceInfo,
  type TargetResolution,
  instanceLabel,
  instanceSummary,
  listInstances,
  matchesTarget,
  readInstance,
  sweepDeadInstanceDirs,
} from "../transport/instances.js";
import {
  PREMIERE_INSTANCES_DIR,
  PR_NO_PANEL_HINT,
  PR_NO_PANEL_MESSAGE,
  PR_PAUSED_HINT,
  PR_PAUSED_MESSAGE,
  PR_READ_ONLY_HINT,
  PR_READ_ONLY_MESSAGE,
} from "./config.js";

/** Plain-Italian names of Premiere requests, for the panel's history. */
const PREMIERE_TITLES: Record<string, string> = {
  pr_project_info: "guarda il progetto",
  pr_sequence_info: "guarda la sequenza",
  pr_project_check: "controlla il progetto",
  pr_markers: "marker della sequenza",
  pr_bins: "ordina nei bin",
  pr_rename_items: "nomi ed etichette",
  pr_sequence_create: "crea una sequenza",
  pr_timeline_add: "mette clip in timeline",
  pr_clip_edit: "rifila e sposta clip",
  pr_clip_remove: "toglie clip dalla timeline",
  pr_razor: "taglio con la lametta",
  pr_mogrt_add: "mette un titolo .mogrt",
  pr_frame: "guarda un fotogramma",
  pr_export: "esporta la sequenza",
  pr_save_project: "salva il progetto",
  pr_import: "importa nel progetto",
  pr_sequence_duplicate: "duplica la sequenza",
  pr_sequence_open: "apre la sequenza",
  pr_tracks: "tracce: muto, blocco, destinazione",
  pr_transition: "aggiunge transizioni",
  pr_audio_level: "volume delle clip",
  pr_undo_last: "annulla l'ultima modifica di Claude",
};

function premiereTitle(label: string, steps?: string[]): string {
  return Object.prototype.hasOwnProperty.call(PREMIERE_TITLES, label)
    ? PREMIERE_TITLES[label]!
    : describeRequest(label, steps);
}

/** Env var naming the default Premiere instance (an id or the open project's name). */
export const PREMIERE_INSTANCE_ENV = "PARLEZ_PREMIERE_INSTANCE";

export interface PremiereTransportOptions {
  /** Where Premiere instances heartbeat; defaults to <mailbox>/premiere. */
  instancesDir?: string;
  /** Default target; undefined reads PARLEZ_PREMIERE_INSTANCE at call time. */
  instance?: string | null;
}

interface PanelResponse {
  id: string | null;
  ok: boolean;
  phase?: "dispatch" | "execute";
  result: unknown;
  error: string | null;
  line?: number | null;
  stack: string | null;
  logs: string[];
  paused?: boolean;
  readOnly?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failure(
  code: AeErrorCode,
  message: string,
  durationMs: number,
  hint?: string,
): EvalResult {
  return {
    ok: false,
    result: null,
    error: hint ? `${message}\n${hint}` : message,
    errorCode: code,
    stack: null,
    logs: [],
    durationMs,
  };
}

/** Only Premiere heartbeats count; a stray After Effects one in this folder is ignored. */
function isPremiere(instance: InstanceInfo): boolean {
  const host = (instance.heartbeat as { host?: unknown } | null)?.host;
  return host === undefined || host === "premiere";
}

export function isPremierePaused(instance: InstanceInfo): boolean {
  return instance.alive && instance.heartbeat?.paused === true;
}

export function isPremiereReadOnly(instance: InstanceInfo): boolean {
  return instance.alive && instance.heartbeat?.readOnly === true;
}

/** Live Premiere instances, for pr_context and the doctor. */
export async function livePremiereInstances(
  instancesDir: string = PREMIERE_INSTANCES_DIR,
  now: number = Date.now(),
): Promise<InstanceInfo[]> {
  return (await listInstances(instancesDir, now)).filter((i) => i.alive && isPremiere(i));
}

/**
 * Which Premiere a call goes to. One live panel: that one. None: an error
 * that tells the user to open the panel. Several: the named one, else an
 * error listing them.
 */
export async function resolvePremiereTarget(
  target: string | null,
  instancesDir: string = PREMIERE_INSTANCES_DIR,
  now: number = Date.now(),
): Promise<TargetResolution> {
  const live = await livePremiereInstances(instancesDir, now);
  if (target === null) {
    if (live.length === 1) return { mode: "pull", instance: live[0] };
    if (live.length === 0) {
      return {
        mode: "error",
        kind: "unmatched",
        message: PR_NO_PANEL_MESSAGE,
        hint: PR_NO_PANEL_HINT,
      };
    }
    return {
      mode: "error",
      kind: "ambiguous",
      message:
        `${live.length} Premiere Pro sono collegati e nessuno è stato indicato: ` +
        live.map(instanceLabel).join(", "),
      hint:
        "Indica il Premiere con l'argomento `instance` (il suo id o il nome del progetto aperto), " +
        `oppure imposta ${PREMIERE_INSTANCE_ENV}. Collegati: ${instanceSummary(live)}.`,
    };
  }
  const matches = live.filter((i) => matchesTarget(i, target));
  if (matches.length === 1) return { mode: "pull", instance: matches[0] };
  if (matches.length > 1) {
    return {
      mode: "error",
      kind: "ambiguous",
      message: `'${target}' corrisponde a ${matches.length} Premiere Pro: ${matches.map(instanceLabel).join(", ")}`,
      hint: `Indica l'id. Collegati: ${instanceSummary(live)}.`,
    };
  }
  return {
    mode: "error",
    kind: "unmatched",
    message:
      `nessun Premiere Pro collegato corrisponde a '${target}'` +
      (live.length > 0 ? `; collegati: ${instanceSummary(live)}` : ""),
    hint: PR_NO_PANEL_HINT,
  };
}

export class PremiereTransport implements AeTransport {
  private inflight: Promise<unknown> = Promise.resolve();
  private readonly instancesDir: string;
  private readonly instanceOption: string | null | undefined;

  constructor(options: PremiereTransportOptions = {}) {
    this.instancesDir = options.instancesDir ?? PREMIERE_INSTANCES_DIR;
    this.instanceOption = options.instance;
    void sweepDeadInstanceDirs(this.instancesDir).catch(() => undefined);
  }

  private targetName(explicit?: string): string | null {
    const named = explicit?.trim();
    if (named) return named;
    if (this.instanceOption !== undefined) return this.instanceOption;
    const fromEnv = process.env[PREMIERE_INSTANCE_ENV]?.trim();
    return fromEnv ? fromEnv : null;
  }

  async describeTarget(instance?: string): Promise<TargetResolution> {
    return resolvePremiereTarget(this.targetName(instance), this.instancesDir);
  }

  async execute(req: EvalRequest): Promise<EvalResult> {
    const prev = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      return await this.executeOne(req);
    } catch (err) {
      return failure(
        "TRANSPORT",
        `errore del collegamento con Premiere: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    } finally {
      release();
    }
  }

  /**
   * A panel that ticked moments ago and went quiet is most often Premiere
   * busy (rendering, a dialog, a long script): wait for it within the call's
   * own deadline rather than failing at once.
   */
  private async awaitTarget(name: string | null, deadline: number): Promise<TargetResolution> {
    let target = await resolvePremiereTarget(name, this.instancesDir);
    while (target.mode === "error" && target.kind !== "ambiguous" && Date.now() < deadline) {
      const recent = (await listInstances(this.instancesDir)).some(
        (i) =>
          !i.alive &&
          isPremiere(i) &&
          i.heartbeat !== null &&
          Date.now() - i.heartbeat.ts < AGENT_GRACE_MS &&
          (name === null || matchesTarget(i, name)),
      );
      if (!recent) break;
      await sleep(250);
      target = await resolvePremiereTarget(name, this.instancesDir);
    }
    return target;
  }

  private async executeOne(req: EvalRequest): Promise<EvalResult> {
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = started + timeoutMs;

    const target = await this.awaitTarget(this.targetName(req.instance), deadline);
    if (target.mode !== "pull") {
      const message = target.mode === "error" ? target.message : PR_NO_PANEL_MESSAGE;
      const hint = target.mode === "error" ? target.hint : PR_NO_PANEL_HINT;
      return failure("NO_INSTANCE", message, Date.now() - started, hint);
    }
    const instance = target.instance;
    if (isPremierePaused(instance)) {
      return failure("PAUSED", PR_PAUSED_MESSAGE, Date.now() - started, PR_PAUSED_HINT);
    }
    if (req.mutates !== false && isPremiereReadOnly(instance)) {
      return failure("READ_ONLY", PR_READ_ONLY_MESSAGE, Date.now() - started, PR_READ_ONLY_HINT);
    }

    const label = req.label ?? "action";
    const request = {
      id: randomUUID(),
      label,
      code: req.code,
      payload: req.payload ?? null,
      // Premiere's scripting has neither undo groups nor dialog suppression:
      // false keeps serve.jsx away from the After Effects-only calls.
      undoGroup: false,
      suppressDialogs: false,
      mutates: req.mutates !== false,
      title: premiereTitle(label, req.steps),
    };

    const dir = instance.dir;
    const requestPath = path.join(dir, `${REQUEST_PREFIX}${request.id}.json`);
    const responsePath = path.join(dir, `${RESPONSE_PREFIX}${request.id}.json`);
    await fs.mkdir(dir, { recursive: true, mode: RUNTIME_DIR_MODE });
    const tmp = path.join(dir, `.${REQUEST_PREFIX}${request.id}.json.tmp`);
    await fs.writeFile(tmp, serializeRequest(request), "utf8");
    await fs.rename(tmp, requestPath);

    let consumed = false;
    let lastLiveness = started;
    while (Date.now() < deadline) {
      const response = await readResponse(responsePath);
      if (response !== null) {
        await fs.unlink(responsePath).catch(() => undefined);
        return toEvalResult(response, Date.now() - started);
      }
      const now = Date.now();
      if (!consumed && now - lastLiveness >= LIVENESS_CHECK_MS) {
        lastLiveness = now;
        if (!(await exists(requestPath))) {
          consumed = true;
        } else {
          const current = await readInstance(dir, now);
          if (!current.alive) {
            await fs.unlink(requestPath).catch(() => undefined);
            return failure(
              "NO_INSTANCE",
              `Premiere Pro ha smesso di rispondere (${instanceLabel(current)}): la richiesta non è stata presa ed è stata ritirata`,
              Date.now() - started,
              PR_NO_PANEL_HINT,
            );
          }
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    const reclaimed = await fs
      .unlink(requestPath)
      .then(() => true)
      .catch(() => false);
    return failure(
      "TIMEOUT",
      `Premiere Pro non ha risposto entro ${timeoutMs} ms` +
        (reclaimed
          ? " (la richiesta non è stata presa ed è stata ritirata)"
          : " (la richiesta È stata presa: l'operazione potrebbe essere ancora in corso)"),
      Date.now() - started,
      "Premiere è occupato (esportazione, una finestra di dialogo aperta)? Riprova quando è libero.",
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readResponse(p: string): Promise<PanelResponse | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return raw ? (JSON.parse(raw) as PanelResponse) : null;
  } catch {
    return null;
  }
}

function toEvalResult(parsed: PanelResponse, durationMs: number): EvalResult {
  if (!parsed.ok && parsed.paused === true) {
    return failure("PAUSED", PR_PAUSED_MESSAGE, durationMs, PR_PAUSED_HINT);
  }
  if (!parsed.ok && parsed.readOnly === true) {
    return failure("READ_ONLY", PR_READ_ONLY_MESSAGE, durationMs, PR_READ_ONLY_HINT);
  }
  if (parsed.ok) {
    return {
      ok: true,
      result: parsed.result,
      error: null,
      errorCode: null,
      stack: null,
      logs: parsed.logs ?? [],
      durationMs,
    };
  }
  const dispatchFailure = parsed.phase === "dispatch";
  return {
    ok: false,
    result: null,
    error: dispatchFailure ? `errore prima di eseguire: ${parsed.error}` : parsed.error,
    errorCode: dispatchFailure ? "DISPATCHER" : "JSX_THROW",
    line: typeof parsed.line === "number" ? parsed.line : null,
    stack: parsed.stack,
    logs: parsed.logs ?? [],
    durationMs,
  };
}
