// Background renders with aerender (Parlez! M6.4 — names provisional).
//
// render.start renders inside After Effects and blocks it until the render
// ends. These operations hand the job to aerender, Adobe's command-line
// renderer, as a separate process: After Effects stays usable, the call
// returns at once with an id, and aerender.status / aerender.cancel follow it.
//
// Everything runs on the Node side (Operation.run). After Effects is asked
// one thing, before the start: which file the project is, whether it has
// unsaved changes, the comp's name and timing, and the output-module
// templates. aerender reads the project from DISK, so a project with unsaved
// changes is refused: rendering it would silently render something other
// than what is on screen, and saving is the user's call (ae_save_project or
// checkpoint.create), never a side effect of rendering.
//
// What it writes: the output (file or image sequence) where the caller says,
// and the log `<name>.aerender.log` next to it — aerender's own stdout and
// stderr, appended, never inside the IPC mailbox. Nothing else.
//
// Ideas from malkawi06/After-Effects-mcp-pro (MIT: job table, PROGRESS
// parsing, first "H.264" output template, aerender next to AfterFX.exe or
// beside the .app); the code is written from scratch.

import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { promises as fs, closeSync, openSync, writeSync } from "node:fs";
import * as path from "node:path";

import { AGENT_DISABLE_ENV, rejectedOutputPath, resolveAfterFxPath } from "../config.js";
import { jsxFail, jsxVal, registerOp } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import {
  AERENDER_ENV,
  AERENDER_LAUNCH_ENV,
  type AerenderLaunchMode,
  aerenderLaunchMode,
  aerenderLaunchPlan,
  aerenderCandidates,
  existingOutputFiles,
  outputUnderOtherExtension,
  isFile,
  lastLines,
  logPathFor,
  normalizeOutputPath,
  outputOverwriteReason,
  parseProgress,
} from "./aerender-paths.js";

// --- Seams for the tests -------------------------------------------------------
//
// kumo injects `spawn` into FileIpcTransport the same way: the offline tests
// replace it with a fake aerender (a Node script) and never start a real one.

export interface AerenderHooks {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  /** resolveAfterFxPath(): AfterFX.exe on Windows, the .app bundle on macOS. Throws when not found. */
  afterFxPath(): string;
  platform: NodeJS.Platform;
  /** Stop the render and everything it started (see killProcessTree). */
  killTree(child: ChildProcess): Promise<void>;
  now(): number;
}

/**
 * Windows: `taskkill /T /F` ends the whole tree. aerender.exe starts After
 * Effects' render engine as a child process; killing aerender alone can
 * leave that engine running (and rendering, and holding the output file).
 * Elsewhere: the child was started detached, so it leads its own process
 * group, and a signal to the group reaches the engine too.
 */
async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const k = nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      k.on("error", () => {
        child.kill();
        resolve();
      });
      k.on("exit", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

const DEFAULT_HOOKS: AerenderHooks = {
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  afterFxPath: () => resolveAfterFxPath(),
  platform: process.platform,
  killTree: killProcessTree,
  now: () => Date.now(),
};

let hooks: AerenderHooks = DEFAULT_HOOKS;

/** Replace some hooks; returns the function that puts the real ones back. */
export function setAerenderHooksForTests(over: Partial<AerenderHooks>): () => void {
  const before = hooks;
  hooks = { ...hooks, ...over };
  return () => {
    hooks = before;
  };
}

// --- Jobs ------------------------------------------------------------------------

export type JobStatus = "in corso" | "finito" | "fallito" | "fermato";

interface Job {
  id: string;
  comp: string;
  project: string;
  output: string;
  log: string;
  command: string[];
  launch: AerenderLaunchMode;
  child: ChildProcess;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  cancelled: boolean;
  /** Frames this render should make, from the comp (fallback when the log has no Duration line). */
  expectedFrames: number | null;
  expectedFrom: "range" | "workArea";
}

const jobs = new Map<string, Job>();
let jobSeq = 0;

export function resetAerenderJobsForTests(): void {
  jobs.clear();
  jobSeq = 0;
}

// --- Small helpers ----------------------------------------------------------------

type Failure = { ok: false; error: string; errorCode?: string; hint?: string };

function fail(error: string, extra: { errorCode?: string; hint?: string } = {}): Failure {
  return { ok: false, error, ...extra };
}

function isFailure(v: unknown): v is Failure {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const slash = (p: string) => p.replace(/\\/g, "/");

function nodeOnly(name: string): string {
  return jsxFail(
    `${name} runs on the Node side (it starts or follows an aerender process) — call it as its own ae_do, not inside batch.run`,
  );
}

const isWholeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

// --- Finding aerender -------------------------------------------------------------

export interface AerenderLocation {
  path: string | null;
  tried: string[];
  source: "env" | "afterEffects";
  afterEffects: string | null;
  reason?: string;
}

/** AE_MCP_AERENDER if set, else next to the After Effects resolveAfterFxPath() finds. */
export function findAerender(): AerenderLocation {
  const env = process.env[AERENDER_ENV]?.trim();
  if (env) {
    const p = normalizeOutputPath(env);
    return {
      path: isFile(p) ? p : null,
      tried: [slash(p)],
      source: "env",
      afterEffects: null,
      ...(isFile(p) ? {} : { reason: `${AERENDER_ENV} non indica un file esistente` }),
    };
  }
  let afterFx: string;
  try {
    afterFx = hooks.afterFxPath();
  } catch (err) {
    return {
      path: null,
      tried: [],
      source: "afterEffects",
      afterEffects: null,
      reason: `After Effects non trovato: ${errText(err)}`,
    };
  }
  const candidates = aerenderCandidates(afterFx, hooks.platform);
  const found = candidates.find((c) => isFile(c)) ?? null;
  return {
    path: found,
    tried: candidates.map(slash),
    source: "afterEffects",
    afterEffects: slash(afterFx),
    ...(found ? {} : { reason: "aerender non è accanto ad After Effects" }),
  };
}

// --- Asking After Effects ---------------------------------------------------------

interface Prep {
  file: string | null;
  dirty: boolean;
  comp: {
    name: string;
    id: number;
    frameRate: number;
    duration: number;
    workAreaStart: number;
    workAreaDuration: number;
  };
  sameName: number;
  outputTemplates: string[] | null;
  renderTemplates: string[] | null;
}

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

/**
 * Template lists seen during this server session. Output-module and
 * render-settings templates belong to the After Effects application (its
 * preferences), not to a project, so a list read once stays good for later
 * calls whose render queue is empty.
 */
let templateCache: { output: string[]; render: string[] | null } | null = null;

export function resetAerenderTemplateCacheForTests(): void {
  templateCache = null;
}

/**
 * One READ before the start, and nothing else: no save, no change to the
 * render queue. The templates are read from render-queue item 1 when the
 * queue has one (as render.list_templates does).
 *
 * An empty queue is left empty. The first version put the comp in the queue
 * and took it out again to read the templates; on AE 26.5 that marks the
 * project as modified, so the NEXT aerender.start refused it for unsaved
 * changes (E2E, 2026-10-26). Undoing the change (executeCommand 16) runs
 * against the undo group the call itself is inside, and AE still keeps the
 * modified mark; remembering "we dirtied it" cannot tell our change from a
 * user's edit made in between. Not touching the queue is the only way that
 * is safe by construction.
 */
async function aePrep(transport: AeTransport, comp: unknown): Promise<Prep | Failure> {
  const res = await transport.execute({
    label: "aerender.prep",
    code: `
        var _arg = ${jsxVal({ comp })};
        var _file = app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null;
        var _dirty = !!app.project.dirty;
        var _comp = AE.findCompByNameOrId(_arg.comp);
        if (!_comp) return { ok: false, noComp: true, error: "no comp matching " + String(_arg.comp) };
        var _same = 0;
        for (var _i = 1; _i <= app.project.numItems; _i++) {
            var _it = app.project.item(_i);
            if (_it instanceof CompItem && _it.name === _comp.name) _same++;
        }
        var _rq = app.project.renderQueue;
        var _om = null;
        var _rs = null;
        try {
            if (_rq.numItems > 0) {
                _rs = _rq.item(1).templates;
                _om = _rq.item(1).outputModule(1).templates;
            }
        } catch (eTpl) {}
        return {
            ok: true, file: _file, dirty: _dirty, sameName: _same,
            comp: { name: _comp.name, id: _comp.id, frameRate: _comp.frameRate, duration: _comp.duration,
                    workAreaStart: _comp.workAreaStart, workAreaDuration: _comp.workAreaDuration },
            outputTemplates: _om, renderTemplates: _rs
        };
    `,
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    return fail(`After Effects non ha risposto (${res.error ?? "errore sconosciuto"})`, {
      errorCode: res.errorCode ?? "TRANSPORT",
    });
  }
  const r = res.result as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) {
    return fail("risposta inattesa da After Effects", { errorCode: "OPERATION_FAILED" });
  }
  if (r.ok === false) {
    return fail(
      r.noComp === true
        ? `Nessuna composizione corrisponde a ${JSON.stringify(comp)}.`
        : `After Effects: ${String(r.error)}`,
      { errorCode: "OPERATION_FAILED" },
    );
  }
  let outputTemplates = stringList(r.outputTemplates);
  let renderTemplates = stringList(r.renderTemplates);
  if (outputTemplates !== null && outputTemplates.length > 0) {
    templateCache = { output: outputTemplates, render: renderTemplates };
  } else if (templateCache !== null) {
    outputTemplates = templateCache.output;
    renderTemplates = templateCache.render;
  }
  return {
    file: typeof r.file === "string" ? r.file : null,
    dirty: r.dirty === true,
    comp: r.comp as Prep["comp"],
    sameName: typeof r.sameName === "number" ? r.sameName : 1,
    outputTemplates,
    renderTemplates,
  };
}

/** `wanted` as spelled in `list` (case-insensitive), or null. */
function pickTemplate(list: string[], wanted: string): string | null {
  return list.find((t) => t.toLowerCase() === wanted.toLowerCase()) ?? null;
}

// --- Reading a job ------------------------------------------------------------------

/** Whole log when small; head (for Duration / Frame Rate) + tail when large. */
async function readLog(file: string): Promise<string> {
  const HEAD = 64 * 1024;
  const TAIL = 256 * 1024;
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    if (size <= HEAD + TAIL) {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      return buf.toString("utf8");
    }
    const head = Buffer.alloc(HEAD);
    const tail = Buffer.alloc(TAIL);
    await handle.read(head, 0, HEAD, 0);
    await handle.read(tail, 0, TAIL, size - TAIL);
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

const TAIL_LINES = 15;

async function report(job: Job): Promise<Record<string, unknown>> {
  const text = await readLog(job.log);
  const progress = parseProgress(text);
  const total = progress.totalFromLog ?? job.expectedFrames;
  const frame = progress.frame;
  const percent =
    frame !== null && total !== null && total > 0
      ? Math.min(100, Math.round((frame / total) * 1000) / 10)
      : null;
  let out = existingOutputFiles(job.output);
  let actual: string | null = null;
  if (out.files.length === 0 && !job.running) {
    const other = outputUnderOtherExtension(job.output, job.startedAt);
    if (other !== null) {
      out = other;
      actual = other.files[0]!;
    }
  }
  const lastError =
    progress.errors.length > 0 ? progress.errors[progress.errors.length - 1]! : null;
  const now = hooks.now();
  const elapsed = Math.round(((job.endedAt ?? now) - job.startedAt) / 100) / 10;

  let status: JobStatus;
  let message: string;
  const warnings: string[] = [];
  if (job.cancelled) {
    status = "fermato";
    message =
      "Render fermato. Il file parziale non è stato cancellato" +
      (out.files.length > 0 ? `: ${slash(job.output)} (${out.bytes} byte).` : ".");
  } else if (job.running) {
    status = "in corso";
    message =
      percent !== null
        ? `Render in corso: fotogramma ${frame} di ${total} (${percent}%).`
        : "Render in corso: aerender non ha ancora scritto l'avanzamento.";
  } else if (job.spawnError !== null) {
    status = "fallito";
    message = `aerender non è partito: ${job.spawnError}`;
  } else if (job.exitCode !== 0) {
    status = "fallito";
    message =
      `aerender è uscito con un errore (codice ${job.exitCode ?? job.signal ?? "?"}). ` +
      "Le ultime righe del log dicono perché.";
  } else if (out.bytes === 0) {
    status = "fallito";
    // aerender 26.5 exits 0 even after "aerender ERROR …" (E2E, 2026-10-26):
    // the error line is the real reason, so it leads the message.
    message =
      lastError !== null
        ? `aerender è uscito senza file di uscita dopo un errore: «${lastError}».`
        : out.files.length === 0
          ? "aerender ha finito senza errori, ma il file di uscita non c'è."
          : "aerender ha finito senza errori, ma il file di uscita è vuoto.";
  } else {
    status = "finito";
    message = `Render finito: ${slash(actual ?? job.output)} (${out.bytes} byte).`;
    if (actual !== null) {
      warnings.push(
        `Il file è uscito con un'altra estensione (${path.basename(actual)}): il modello di uscita usato produce un formato diverso da quello dell'estensione chiesta.`,
      );
    }
    // aerender can exit 0 after stopping early (malkawi saw it): believe the
    // frames it reported over the exit code.
    if (frame !== null && total !== null && frame < total) {
      warnings.push(
        `aerender ha scritto l'avanzamento fino al fotogramma ${frame} di ${total}: il file potrebbe essere incompleto. Controllalo prima di consegnarlo.`,
      );
    }
  }
  if (progress.errors.length > 0 && status !== "fallito") {
    warnings.push(`Il log contiene ${progress.errors.length} righe di errore: guardale nel log.`);
  }

  return {
    id: job.id,
    status,
    message,
    comp: job.comp,
    output: slash(job.output),
    log: slash(job.log),
    launch: job.launch,
    frame,
    totalFrames: total,
    totalFrom: progress.totalFromLog !== null ? "log" : job.expectedFrom,
    percent,
    elapsedSeconds: elapsed,
    exitCode: job.exitCode,
    outputExists: out.files.length > 0,
    outputBytes: out.bytes,
    ...(actual !== null ? { outputActual: slash(actual) } : {}),
    ...(out.sequence ? { outputFrames: out.files.length } : {}),
    logTail: lastLines(text, TAIL_LINES),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function unknownJob(id: unknown): Failure {
  const known = [...jobs.keys()];
  return fail(
    `Nessun render con id ${JSON.stringify(id)}.` +
      (known.length > 0 ? ` Quelli che conosco: ${known.join(", ")}.` : " Non ne conosco nessuno."),
    {
      errorCode: "INVALID_ARGS",
      hint: "I render si ricordano finché il server resta acceso: dopo un riavvio, controlla il file e il log nella cartella di uscita.",
    },
  );
}

// --- Operations ---------------------------------------------------------------------

registerOp({
  name: "aerender.info",
  category: "render",
  readOnly: true,
  description:
    `Where aerender (Adobe's command-line renderer) is: $${AERENDER_ENV} if set, else next to the After Effects found via AE_MCP_EXE / the default install paths ` +
    "(Windows: Support Files/aerender.exe beside AfterFX.exe; macOS: the aerender in the folder that holds the .app bundle, then inside the bundle). " +
    "Returns found, path and every path tried. Does not contact After Effects.",
  params: [],
  toJsx: () => nodeOnly("aerender.info"),
  async run() {
    const loc = findAerender();
    return {
      ok: true,
      found: loc.path !== null,
      path: loc.path === null ? null : slash(loc.path),
      tried: loc.tried,
      source: loc.source,
      afterEffects: loc.afterEffects,
      platform: hooks.platform,
      message:
        loc.path !== null
          ? `aerender trovato: ${slash(loc.path)}`
          : `aerender non trovato (${loc.reason}). Percorsi provati: ${loc.tried.join(", ") || "nessuno"}. ` +
            `Si può indicare con la variabile ${AERENDER_ENV}.`,
    };
  },
});

registerOp({
  name: "aerender.start",
  category: "render",
  description:
    "Render a comp in the BACKGROUND with aerender, without blocking After Effects; returns at once with an id for aerender.status / aerender.cancel. " +
    "aerender reads the project from disk, so the project must be saved: with unsaved changes the call is refused (ask the user, then ae_save_project or checkpoint.create). " +
    "`output` is required (absolute path; folders are created; image sequences use [#####]). Default output template: the first starting with 'H.264'; if none, the call lists them. " +
    "If the output already exists it needs confirm: true. aerender's stdout goes to <name>.aerender.log next to the output. " +
    `On Windows the render is a child of this server (launch mode 'attached', $${AERENDER_LAUNCH_ENV} changes it): it stops if the server stops.`,
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "output",
      type: "string",
      description: "Output file (absolute). Never inside the server's IPC mailbox.",
      required: true,
    },
    {
      name: "OMtemplate",
      type: "string",
      description: "Output-module template name (default: first starting with 'H.264')",
      required: false,
    },
    {
      name: "RStemplate",
      type: "string",
      description: "Render-settings template name (default: aerender's own)",
      required: false,
    },
    {
      name: "s",
      type: "number",
      description: "First frame to render (aerender -s, a frame number)",
      required: false,
    },
    {
      name: "e",
      type: "number",
      description: "Last frame to render (aerender -e, a frame number)",
      required: false,
    },
    {
      name: "reuse",
      type: "boolean",
      description:
        "aerender -reuse: render in the After Effects already running instead of a new engine (not verified; may interfere with the open project)",
      required: false,
    },
    {
      name: "mfr",
      type: "boolean",
      description:
        "aerender -mfr ON|OFF 100: Multi-Frame Rendering on or off (default: the preference)",
      required: false,
    },
    {
      name: "continueOnMissingFootage",
      type: "boolean",
      description:
        "aerender -continueOnMissingFootage: render even with missing files (default false: stop)",
      required: false,
      default: false,
    },
  ],
  toJsx: () => nodeOnly("aerender.start"),
  async run(args, transport) {
    // --- Input, before anything reaches After Effects or the disk.
    if (typeof args.output !== "string" || args.output.trim() === "") {
      return fail("output mancante: indica il percorso completo del file da creare", {
        errorCode: "INVALID_ARGS",
      });
    }
    const output = normalizeOutputPath(args.output);
    const rejected = rejectedOutputPath(output);
    if (rejected) return fail(rejected, { errorCode: "IO" });
    if (path.extname(output) === "") {
      return fail(`output deve avere un'estensione (.mp4, .mov, .png…): ${slash(output)}`, {
        errorCode: "INVALID_ARGS",
      });
    }
    // The gate in ae_do asks the same question first; asked again here so the
    // operation holds even when called some other way.
    const overwrite = outputOverwriteReason({ output });
    if (overwrite && args.confirm !== true) {
      return fail(
        `aerender.start ${overwrite}. Non l'ho avviato: serve confirm: true, solo se l'utente è d'accordo.`,
        { errorCode: "FORBIDDEN" },
      );
    }
    for (const k of ["s", "e"] as const) {
      if (args[k] !== undefined && !isWholeNonNegative(args[k])) {
        return fail(`${k} deve essere un numero di fotogramma intero, 0 o più`, {
          errorCode: "INVALID_ARGS",
        });
      }
    }
    if (isWholeNonNegative(args.s) && isWholeNonNegative(args.e) && args.e < args.s) {
      return fail("e (ultimo fotogramma) è prima di s (primo fotogramma)", {
        errorCode: "INVALID_ARGS",
      });
    }
    const loc = findAerender();
    if (loc.path === null) {
      return fail(
        `aerender non trovato (${loc.reason}). Percorsi provati: ${loc.tried.join(", ") || "nessuno"}.`,
        { errorCode: "AE_NOT_FOUND", hint: `Indica il percorso con la variabile ${AERENDER_ENV}.` },
      );
    }

    // --- The project, as After Effects sees it.
    const om = typeof args.OMtemplate === "string" ? args.OMtemplate.trim() : "";
    const rs = typeof args.RStemplate === "string" ? args.RStemplate.trim() : "";
    const prep = await aePrep(transport, args.comp);
    if (isFailure(prep)) return prep;
    if (prep.file === null) {
      return fail(
        "Il progetto aperto non è mai stato salvato: aerender legge il progetto dal disco, quindi non c'è niente da renderizzare.",
        {
          errorCode: "OPERATION_FAILED",
          hint: "Chiedi all'utente dove salvarlo, poi ae_save_project con `path`.",
        },
      );
    }
    if (prep.dirty) {
      return fail(
        "Il progetto ha modifiche non salvate: aerender legge il file dal disco e renderizzerebbe la versione vecchia. Non salvo da solo.",
        {
          errorCode: "OPERATION_FAILED",
          hint: "Chiedi all'utente se salvare: ae_save_project, oppure checkpoint.create (salva e tiene una copia). Poi riprova.",
        },
      );
    }

    // null = no -OMtemplate: aerender then uses the output module template
    // the user has set as default (only when the list cannot be read).
    let outputTemplate: string | null;
    const omList = prep.outputTemplates;
    if (om !== "") {
      const hit = omList === null ? om : pickTemplate(omList, om);
      if (hit === null) {
        return fail(
          `Nessun modello di uscita si chiama «${om}». Disponibili: ${omList!.join(" | ")}.`,
          { errorCode: "INVALID_ARGS", hint: "Ripeti con OMtemplate uguale a uno di quelli." },
        );
      }
      outputTemplate = hit;
    } else if (omList === null) {
      // Empty render queue and no list seen yet this session: reading one
      // would mean changing the queue (see aePrep), so aerender picks.
      outputTemplate = null;
    } else {
      const h264 = omList.find((t) => t.startsWith("H.264")) ?? null;
      if (h264 === null) {
        return fail(
          `Nessun modello di uscita inizia con «H.264». Indica OMtemplate, scegliendo tra: ${omList.join(" | ")}.`,
          {
            errorCode: "INVALID_ARGS",
            hint: "render.list_templates elenca i modelli (con almeno una voce nella coda di render).",
          },
        );
      }
      outputTemplate = h264;
    }
    let renderTemplate: string | null = null;
    if (rs !== "") {
      const hit = prep.renderTemplates === null ? rs : pickTemplate(prep.renderTemplates, rs);
      if (hit === null) {
        return fail(
          `Nessun modello di render si chiama «${rs}». Disponibili: ${prep.renderTemplates!.join(" | ")}.`,
          { errorCode: "INVALID_ARGS" },
        );
      }
      renderTemplate = hit;
    }

    // --- Disk: output folder and log.
    try {
      await fs.mkdir(path.dirname(output), { recursive: true });
    } catch (err) {
      return fail(`Non riesco a creare la cartella di uscita: ${errText(err)}`, {
        errorCode: "IO",
      });
    }
    const log = logPathFor(output);

    const aerender = loc.path;
    const argv = ["-project", path.resolve(prep.file), "-comp", prep.comp.name, "-output", output];
    if (outputTemplate !== null) argv.push("-OMtemplate", outputTemplate);
    if (renderTemplate !== null) argv.push("-RStemplate", renderTemplate);
    if (isWholeNonNegative(args.s)) argv.push("-s", String(args.s));
    if (isWholeNonNegative(args.e)) argv.push("-e", String(args.e));
    if (args.reuse === true) argv.push("-reuse");
    if (typeof args.mfr === "boolean") argv.push("-mfr", args.mfr ? "ON" : "OFF", "100");
    if (args.continueOnMissingFootage === true) argv.push("-continueOnMissingFootage");
    const command = [aerender, ...argv].map(slash);
    const launch = aerenderLaunchMode(hooks.platform);
    const plan = aerenderLaunchPlan(launch.mode, aerender, argv);
    if ("error" in plan) return fail(plan.error, { errorCode: "INVALID_ARGS" });

    let fd: number;
    try {
      fd = openSync(log, "a");
      writeSync(
        fd,
        `\n=== Parlez! aerender — ${new Date(hooks.now()).toISOString()} — avvio ${launch.mode} ===\n` +
          `${command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ")}\n`,
      );
    } catch (err) {
      return fail(`Non riesco a scrivere il log ${slash(log)}: ${errText(err)}`, {
        errorCode: "IO",
      });
    }

    // stdout and stderr go straight into the log file, not through pipes to
    // this process: the log is complete whoever reads it, and a busy server
    // never stalls aerender on a full pipe. How the process is started (and
    // whether it outlives the server) is the launch mode, see aerender-paths.
    let child: ChildProcess;
    try {
      child = hooks.spawn(plan.command, plan.argv, {
        detached: plan.detached,
        windowsHide: true,
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
        stdio: ["ignore", fd, fd],
        // The render engine loads Scripts/Startup too; without this the
        // resident agent registers it as a second instance and every unnamed
        // call fails as ambiguous while the render runs (2026-10-25).
        env: { ...process.env, [AGENT_DISABLE_ENV]: "1" },
      });
    } catch (err) {
      closeSync(fd);
      return fail(`aerender non è partito: ${errText(err)}`, { errorCode: "TRANSPORT" });
    }
    closeSync(fd);
    const started = await new Promise<string | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (err) => resolve(errText(err)));
    });
    if (started !== null) {
      return fail(`aerender non è partito: ${started}`, { errorCode: "TRANSPORT" });
    }

    const fps = prep.comp.frameRate;
    let expectedFrames: number;
    let expectedFrom: Job["expectedFrom"];
    if (isWholeNonNegative(args.s) && isWholeNonNegative(args.e)) {
      expectedFrames = args.e - args.s + 1;
      expectedFrom = "range";
    } else {
      // Assumption: without -s/-e aerender renders the comp's work area
      // (the default render settings' time span). The log's "Duration" line,
      // when present, wins over this.
      const startF = isWholeNonNegative(args.s)
        ? args.s
        : Math.round(prep.comp.workAreaStart * fps);
      const endF = isWholeNonNegative(args.e)
        ? args.e + 1
        : Math.round((prep.comp.workAreaStart + prep.comp.workAreaDuration) * fps);
      expectedFrames = Math.max(0, endF - startF);
      expectedFrom = "workArea";
    }

    const id = `aer-${++jobSeq}`;
    const job: Job = {
      id,
      comp: prep.comp.name,
      project: path.resolve(prep.file),
      output,
      log,
      command,
      launch: launch.mode,
      child,
      pid: child.pid ?? null,
      startedAt: hooks.now(),
      endedAt: null,
      running: true,
      exitCode: null,
      signal: null,
      spawnError: null,
      cancelled: false,
      expectedFrames,
      expectedFrom,
    };
    child.on("error", (err) => {
      job.spawnError = errText(err);
    });
    child.on("exit", (code, signal) => {
      job.running = false;
      job.exitCode = code;
      job.signal = signal;
      job.endedAt = hooks.now();
      void fs
        .appendFile(
          log,
          `=== Parlez! aerender: ${job.cancelled ? "fermato" : `uscito con codice ${code ?? signal}`} ===\n`,
        )
        .catch(() => {});
    });
    // The server must never wait for aerender to exit. (Whether aerender
    // outlives the server depends on the launch mode, not on this.)
    child.unref();
    jobs.set(id, job);

    const warnings: string[] = [];
    if (prep.sameName > 1) {
      warnings.push(
        `Nel progetto ci sono ${prep.sameName} composizioni chiamate «${prep.comp.name}»: aerender sceglie per nome e potrebbe renderizzarne un'altra.`,
      );
    }
    if (omList === null && om !== "") {
      warnings.push(
        "Non ho potuto controllare che il modello di uscita esista (la coda di render è vuota): se il nome è sbagliato, aerender si fermerà e il log lo dirà.",
      );
    }
    if (launch.ignored !== null) {
      warnings.push(
        `${AERENDER_LAUNCH_ENV}=${launch.ignored} non è un valore valido (attached, shell, detached): uso ${launch.mode}.`,
      );
    }
    if (outputTemplate === null) {
      warnings.push(
        "La coda di render è vuota, quindi non ho potuto leggere i modelli di uscita senza modificare il progetto: aerender usa il modello di uscita predefinito di After Effects. " +
          "Se il suo formato non è quello dell'estensione indicata, il file può uscire con un'altra estensione (aerender.status lo cerca). Per scegliere il modello, passa OMtemplate.",
      );
    }
    return {
      ok: true,
      id,
      status: "in corso" as JobStatus,
      comp: prep.comp.name,
      project: slash(job.project),
      output: slash(output),
      log: slash(log),
      outputTemplate,
      renderTemplate,
      expectedFrames,
      command,
      launch: launch.mode,
      ...(warnings.length > 0 ? { warnings } : {}),
      message: `Render avviato in sottofondo (${id}). Segui l'avanzamento con aerender.status.`,
    };
  },
});

registerOp({
  name: "aerender.status",
  category: "render",
  readOnly: true,
  description:
    "Progress of background renders started with aerender.start: one by `id`, or all. Per render: status (in corso | finito | fallito | fermato), " +
    "frame / totalFrames / percent read from aerender's PROGRESS lines, elapsed seconds, output size, and the last lines of the log. " +
    "'finito' only when aerender exited 0 AND the output exists and is not empty.",
  params: [
    {
      name: "id",
      type: "string",
      description: "Render id from aerender.start (default: all renders this server started)",
      required: false,
    },
  ],
  toJsx: () => nodeOnly("aerender.status"),
  async run(args) {
    if (args.id !== undefined) {
      const job = jobs.get(String(args.id));
      if (!job) return unknownJob(args.id);
      return { ok: true, ...(await report(job)) };
    }
    const all = [];
    for (const job of jobs.values()) all.push(await report(job));
    return { ok: true, count: all.length, renders: all };
  },
});

registerOp({
  name: "aerender.cancel",
  category: "render",
  description:
    "Stop a background render started with aerender.start (on Windows the whole process tree, so After Effects' render engine stops too). " +
    "The partial output is NOT deleted. A render that already ended is left as it is.",
  params: [
    { name: "id", type: "string", description: "Render id from aerender.start", required: true },
  ],
  toJsx: () => nodeOnly("aerender.cancel"),
  async run(args) {
    const job = jobs.get(String(args.id));
    if (!job) return unknownJob(args.id);
    if (!job.running) {
      const r = await report(job);
      return {
        ok: true,
        ...r,
        message: `Il render ${job.id} era già terminato (${String(r.status)}): non c'era niente da fermare.`,
      };
    }
    job.cancelled = true;
    try {
      await hooks.killTree(job.child);
    } catch (err) {
      job.cancelled = false;
      return fail(`Non sono riuscito a fermare aerender: ${errText(err)}`, {
        errorCode: "TRANSPORT",
      });
    }
    return { ok: true, ...(await report(job)) };
  },
});
