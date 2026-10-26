// Discovery and selection of After Effects instances on the pull path.
//
// Every instance running the resident agent (jsx/agent.jsx) keeps
// <runtime>/instances/<id>/heartbeat.json fresh — every second while idle,
// flagged `busy` around a request (ticks do not fire while a script runs, so a
// long call silences the heartbeat legitimately). This module reads those
// files and turns "which AE should this call go to" into a decision the
// transport can act on without touching AE.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  AGENT_GRACE_MS,
  HEARTBEAT_BUSY_STALE_MS,
  HEARTBEAT_FILENAME,
  HEARTBEAT_STALE_MS,
  INSTANCE_DIR_SWEEP_MS,
  INSTANCES_DIR,
  NEVER_TICKED_MS,
  sanitizeInstanceId,
} from "../config.js";

/** What jsx/agent.jsx writes. Every field but `id`/`ts` is best-effort. */
export interface Heartbeat {
  id: string;
  idSource?: "env" | "random";
  agentVersion?: number;
  aeVersion?: string;
  project: string | null;
  projectName: string | null;
  dirty?: boolean;
  numItems?: number;
  startedAt?: number;
  ticks?: number;
  served?: number;
  /** Requests answered `paused` instead of run (agent version 2+). */
  refused?: number;
  /** The user stopped Claude with the panel's switch (agent version 2+). */
  paused?: boolean;
  /** The panel's "Sola lettura" switch: only non-mutating requests run (agent version 3+). */
  readOnly?: boolean;
  /** Epoch ms of the last request the agent took off its queue (agent version 3+). */
  lastRequestAt?: number | null;
  /**
   * The last few requests, newest last (agent version 3+): when, the
   * request's label (an operation or tool name — never code or project data)
   * and how it ended. For the panel; the server only passes it on.
   */
  recent?: Array<{ t: number; label: string; outcome: string }>;
  busy?: boolean;
  busySince?: number | null;
  lastError?: string | null;
  /** True when the agent runs inside the render engine; such a process is never an instance. */
  renderEngine?: boolean;
  /** Epoch milliseconds, AE's clock — same machine as ours. */
  ts: number;
}

export interface InstanceInfo {
  id: string;
  dir: string;
  heartbeat: Heartbeat | null;
  /** Milliseconds since the last heartbeat, or null without one. */
  ageMs: number | null;
  alive: boolean;
}

/**
 * Could this heartbeat belong to an After Effects someone works in? Not when
 * it says it runs in the render engine, and not when it never got past its
 * first tick: that is what the agent inside aerender looks like (one
 * heartbeat with `ticks: 1`, then silence, because the render engine never
 * runs scheduled tasks). Heartbeats from agents that predate `ticks` pass.
 */
function canBeInstance(heartbeat: Heartbeat, now: number): boolean {
  if (heartbeat.renderEngine === true) return false;
  if (!heartbeat.busy && typeof heartbeat.ticks === "number" && heartbeat.ticks <= 1) {
    return now - heartbeat.ts < NEVER_TICKED_MS;
  }
  return true;
}

export function isAlive(heartbeat: Heartbeat | null, now: number = Date.now()): boolean {
  if (heartbeat === null || typeof heartbeat.ts !== "number") return false;
  if (!canBeInstance(heartbeat, now)) return false;
  const age = now - heartbeat.ts;
  return age < (heartbeat.busy ? HEARTBEAT_BUSY_STALE_MS : HEARTBEAT_STALE_MS);
}

async function tryReadHeartbeat(file: string): Promise<Partial<Heartbeat> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<Heartbeat>;
    return parsed && typeof parsed.ts === "number" ? parsed : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The agent replaces heartbeat.json the way ExtendScript must on Windows:
 * write heartbeat.json.tmp, REMOVE heartbeat.json, rename the tmp over it. A
 * read that lands between the remove and the rename finds no file, and a
 * missing heartbeat used to mean "no agent", which sent the call down the
 * push path (2026-10-25: 60 s timeouts in an E2E run with the agent alive).
 * So: the file, else the complete .tmp next to it, else the file again a
 * moment later, once the rename has landed.
 */
async function readHeartbeatFile(dir: string): Promise<Partial<Heartbeat> | null> {
  const file = path.join(dir, HEARTBEAT_FILENAME);
  const first = (await tryReadHeartbeat(file)) ?? (await tryReadHeartbeat(`${file}.tmp`));
  if (first !== null) return first;
  await sleep(30);
  return tryReadHeartbeat(file);
}

/** Describe one instance directory. Never throws; a heartbeat that cannot be read reads as dead. */
export async function readInstance(dir: string, now: number = Date.now()): Promise<InstanceInfo> {
  const id = path.basename(dir);
  let heartbeat: Heartbeat | null = null;
  const parsed = await readHeartbeatFile(dir);
  if (parsed !== null && typeof parsed.ts === "number") {
    heartbeat = {
      ...parsed,
      id: typeof parsed.id === "string" ? parsed.id : id,
      project: typeof parsed.project === "string" ? parsed.project : null,
      projectName: typeof parsed.projectName === "string" ? parsed.projectName : null,
      ts: parsed.ts,
    };
  }
  return {
    id,
    dir,
    heartbeat,
    ageMs: heartbeat ? now - heartbeat.ts : null,
    alive: isAlive(heartbeat, now),
  };
}

/** Every instance directory, alive or not, sorted by id. */
export async function listInstances(
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<InstanceInfo[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(instancesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const infos: InstanceInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    infos.push(await readInstance(path.join(instancesDir, entry.name), now));
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

function projectStem(name: string): string {
  return path
    .basename(name)
    .toLowerCase()
    .replace(/\.aepx?$/i, "");
}

/** Case-insensitive, separator-agnostic form of a path for equality checks. */
function projectPathKey(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Does `target` (as the user wrote it) name this instance? Three forms:
 *   - an id, matched exactly or after the same sanitizing the agent applied;
 *   - a project file name, with or without its extension, matched
 *     case-insensitively on the stem — "shotA" and "ShotA.aep" both address
 *     the instance that has ShotA.aep open;
 *   - a project PATH (anything containing a separator), matched on the whole
 *     resolved path — the way to pick one of two instances whose projects
 *     share a file name in different folders.
 */
export function matchesTarget(instance: InstanceInfo, target: string): boolean {
  const wanted = target.trim();
  if (wanted.length === 0) return false;
  if (instance.id === wanted || instance.id === sanitizeInstanceId(wanted)) return true;
  const hb = instance.heartbeat;
  if (/[\\/]/.test(wanted)) {
    return hb?.project ? projectPathKey(hb.project) === projectPathKey(wanted) : false;
  }
  const project = hb?.projectName ?? (hb?.project ? path.basename(hb.project) : null);
  if (!project) return false;
  return projectStem(project) === projectStem(wanted);
}

export type TargetResolution =
  | { mode: "push" }
  | { mode: "pull"; instance: InstanceInfo }
  | {
      mode: "error";
      message: string;
      hint: string;
      /**
       * "ambiguous": several live instances fit, so waiting cannot help.
       * "unmatched": nothing live fits (yet) — an agent may still come back.
       */
      kind?: "ambiguous" | "unmatched";
    };

const INSTALL_HINT =
  "Each instance needs the resident agent: run `parlez install-agent` " +
  "once per After Effects version, then (re)start After Effects — the agent registers about ten " +
  "seconds after launch. To name an instance, set AE_MCP_INSTANCE in the environment that launches it " +
  "(works with `AfterFX.exe -m`); the server-side AE_MCP_INSTANCE can also name the project file it has open.";

/**
 * How an instance is named to people and models: the project it has open
 * first, because that is what anyone actually thinks of it as, then the id
 * in brackets — needed to address it when the project is untitled or open
 * twice. `ShotA.aep [ae-t6s4fl]`, `untitled [ae-9k2p1q]`.
 */
export function instanceLabel(instance: InstanceInfo): string {
  const project = instance.heartbeat?.projectName ?? "untitled";
  return `${project} [${instance.id}]`;
}

/** True only when a live agent says the user switched Claude off. */
export function isPaused(instance: InstanceInfo): boolean {
  return instance.alive && instance.heartbeat?.paused === true;
}

/** True only when a live agent says the user allowed reading only. */
export function isReadOnly(instance: InstanceInfo): boolean {
  return instance.alive && instance.heartbeat?.readOnly === true;
}

/**
 * What a call to a paused instance answers. Italian because it is meant to be
 * relayed to the user as is; the hint tells the model not to work around it.
 */
export const PAUSED_MESSAGE =
  "Claude è in pausa in After Effects: accendi l'interruttore nel pannello Parlez!";
export const PAUSED_HINT =
  "L'utente ha fermato Claude dal pannello in After Effects (menu Finestra › Parlez!). " +
  "Non riprovare e non cercare altre strade: chiedi all'utente di mettere su ON " +
  "il grande interruttore del pannello e riprova solo quando lo dice.";

/** What a mutating call answers while the panel says "Sola lettura". */
export const READ_ONLY_MESSAGE =
  "Claude è in sola lettura in After Effects: può guardare il progetto ma non modificarlo. " +
  "Per lasciarlo modificare, spegni «Sola lettura» nel pannello Parlez!";
export const READ_ONLY_HINT =
  "L'utente ha scelto «Sola lettura» nel pannello Parlez!: le operazioni che leggono funzionano, " +
  "quelle che modificano il progetto no. Non cercare altre strade per modificarlo: continua con " +
  "le sole letture, oppure chiedi all'utente di spegnere «Sola lettura».";

export function describeInstance(instance: InstanceInfo): string {
  const hb = instance.heartbeat;
  const state = instance.alive
    ? hb?.busy
      ? "busy"
      : hb?.paused
        ? "paused"
        : hb?.readOnly
          ? "read-only"
          : "live"
    : "stale";
  const seen =
    instance.ageMs === null ? "never seen" : `seen ${Math.round(instance.ageMs / 1000)}s ago`;
  return `${instanceLabel(instance)} (${state}, ${seen})`;
}

export function instanceSummary(instances: InstanceInfo[]): string {
  return instances.length === 0 ? "none" : instances.map(describeInstance).join("; ");
}

/**
 * Decide where a call goes.
 *
 * With a target: exactly one live instance must match. Without one: pull to
 * the single live instance if there is one, push when there is none — the
 * pre-agent behaviour, so a user who never installed the agent sees no change
 * — and refuse when several are live, because guessing would drive the wrong
 * project.
 */
export async function resolveTarget(
  target: string | null,
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<TargetResolution> {
  const all = await listInstances(instancesDir, now);
  const live = all.filter((i) => i.alive);

  if (target === null) {
    if (live.length === 0) return { mode: "push" };
    if (live.length === 1) return { mode: "pull", instance: live[0] };
    // An instance on its very first heartbeat (one tick) is still starting,
    // or is the agent inside aerender, which never ticks again. When exactly
    // one of the live instances is past that, it is the one being worked in.
    const established = live.filter(
      (i) =>
        typeof i.heartbeat?.ticks !== "number" ||
        i.heartbeat.ticks > 1 ||
        i.heartbeat.busy === true,
    );
    if (established.length === 1) return { mode: "pull", instance: established[0] };
    return {
      mode: "error",
      kind: "ambiguous",
      message:
        `${live.length} After Effects instances are live and none was named — ` +
        `set AE_MCP_INSTANCE to one of: ${live.map(instanceLabel).join(", ")}`,
      hint:
        'Name the instance by its id or by the project file it has open (e.g. "shotA" or "shotA.aep"): ' +
        "AE_MCP_INSTANCE on the server picks its default, and every tool takes an `instance` argument to " +
        `address another for one call. Live instances: ${instanceSummary(live)}.`,
    };
  }

  const matches = live.filter((i) => matchesTarget(i, target));
  if (matches.length === 1) return { mode: "pull", instance: matches[0] };
  if (matches.length > 1) {
    return {
      mode: "error",
      kind: "ambiguous",
      message:
        `'${target}' matches ${matches.length} live After Effects instances: ` +
        matches.map(instanceLabel).join(", "),
      hint: `Address one of them by id instead. Live instances: ${instanceSummary(live)}.`,
    };
  }
  const stale = all.filter((i) => !i.alive && matchesTarget(i, target));
  const why =
    stale.length > 0
      ? ` — it was last seen ${Math.round((stale[0].ageMs ?? 0) / 1000)}s ago and has stopped ticking (After Effects quit, crashed, or is stuck in a modal dialog)`
      : live.length > 0
        ? `; live instances: ${instanceSummary(live)}`
        : "; no instance has a live agent";
  return {
    mode: "error",
    kind: "unmatched",
    message: `no live After Effects instance matches '${target}'${why}`,
    hint: INSTALL_HINT,
  };
}

/**
 * An agent that is not live right now but was a moment ago (heartbeat younger
 * than AGENT_GRACE_MS, and one that can be an instance at all), matching
 * `target` when one is named; null when there is none. The transport waits
 * for such an agent to tick again rather than pushing past it or reporting it
 * gone: After Effects pauses scheduled tasks while it is busy. A machine that
 * never ran the agent has no heartbeat at all, so nothing changes there.
 */
export async function recentlyAliveAgent(
  target: string | null,
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<InstanceInfo | null> {
  const recent = (await listInstances(instancesDir, now)).find((i) => {
    const hb = i.heartbeat;
    if (i.alive || hb === null) return false;
    if (now - hb.ts >= AGENT_GRACE_MS) return false;
    if (hb.renderEngine === true) return false;
    if (!hb.busy && typeof hb.ticks === "number" && hb.ticks <= 1) return false;
    return target === null || matchesTarget(i, target);
  });
  return recent ?? null;
}

/**
 * Remove instance directories nobody can still be using: heartbeat older than
 * INSTANCE_DIR_SWEEP_MS, or no heartbeat at all in a directory that old
 * (an agent creates the directory and heartbeats within the same tick).
 * Returns the ids removed. Best-effort — a directory that vanishes or is
 * held open underneath us is simply left for the next sweep.
 */
export async function sweepDeadInstanceDirs(
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  for (const instance of await listInstances(instancesDir, now)) {
    let lastActivity: number | null = instance.heartbeat?.ts ?? null;
    if (lastActivity === null) {
      try {
        lastActivity = (await fs.stat(instance.dir)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - lastActivity < INSTANCE_DIR_SWEEP_MS) continue;
    try {
      await fs.rm(instance.dir, { recursive: true, force: true });
      removed.push(instance.id);
    } catch {
      /* raced with a returning agent, or locked — next time */
    }
  }
  return removed;
}
