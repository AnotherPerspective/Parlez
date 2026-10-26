// A small stand-in for the parts of ExtendScript and After Effects that
// jsx/agent.jsx, jsx/serve.jsx and jsx/panel.jsx touch, backed by the real
// filesystem (a temp directory). It lets those files run unchanged in Node so
// the pause switch can be exercised end to end without After Effects.
//
// Deliberately minimal: only the members those three files use. Anything else
// is absent, so a new dependency on an unshimmed API fails loudly here
// instead of passing by accident.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
} from "node:fs";
import * as path from "node:path";

function norm(p: string): string {
  return String(p).replace(/\\/g, "/");
}

export class EsFile {
  readonly path: string;
  encoding = "UTF-8";
  error = "";
  private mode: "r" | "w" | "a" | null = null;
  private buffer = "";

  constructor(p: string) {
    this.path = norm(p);
  }
  get name(): string {
    return encodeURI(path.posix.basename(this.path));
  }
  get displayName(): string {
    return path.posix.basename(this.path);
  }
  get fsName(): string {
    return this.path;
  }
  get exists(): boolean {
    return existsSync(this.path) && statSync(this.path).isFile();
  }
  get modified(): Date {
    return statSync(this.path).mtime;
  }
  open(mode: string): boolean {
    if (mode === "r") {
      if (!this.exists) return false;
      this.buffer = readFileSync(this.path, "utf8");
    } else {
      if (!existsSync(path.posix.dirname(this.path))) return false;
      this.buffer = "";
    }
    this.mode = mode as "r" | "w" | "a";
    return true;
  }
  read(): string {
    return this.buffer;
  }
  write(s: string): boolean {
    this.buffer += String(s);
    return true;
  }
  writeln(s: string): boolean {
    return this.write(`${String(s)}\n`);
  }
  close(): boolean {
    if (this.mode === "w") writeFileSync(this.path, this.buffer, "utf8");
    else if (this.mode === "a") appendFileSync(this.path, this.buffer, "utf8");
    this.mode = null;
    this.buffer = "";
    return true;
  }
  remove(): boolean {
    try {
      unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }
  get parent(): EsFolder {
    return new EsFolder(path.posix.dirname(this.path));
  }
  /** Size in bytes, -1 when the file is missing (as ExtendScript reports it). */
  get length(): number {
    return this.exists ? statSync(this.path).size : -1;
  }
  /** ExtendScript's File#copy overwrites an existing target. */
  copy(target: string | EsFile): boolean {
    try {
      copyFileSync(this.path, typeof target === "string" ? norm(target) : target.path);
      return true;
    } catch {
      return false;
    }
  }
  /** ExtendScript renames within the same folder: the argument is a name. */
  rename(newName: string): boolean {
    try {
      renameSync(this.path, path.posix.join(path.posix.dirname(this.path), newName));
      return true;
    } catch {
      return false;
    }
  }
}

export class EsFolder {
  static temp: EsFolder;
  readonly path: string;
  /** Folders handed to Folder#execute (the "open in Explorer/Finder" call). */
  static executed: string[] = [];

  constructor(p: string) {
    this.path = norm(p);
  }
  get fsName(): string {
    return this.path;
  }
  get exists(): boolean {
    return existsSync(this.path) && statSync(this.path).isDirectory();
  }
  create(): boolean {
    try {
      mkdirSync(this.path);
      return true;
    } catch {
      return this.exists;
    }
  }
  execute(): boolean {
    EsFolder.executed.push(this.path);
    return this.exists;
  }
  /** Only the `*` wildcard, which is all the jsx/ code uses. */
  getFiles(mask?: string): Array<EsFile | EsFolder> {
    const re = mask
      ? new RegExp(`^${mask.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
      : null;
    return readdirSync(this.path)
      .filter((name) => (re ? re.test(name) : true))
      .map((name) => {
        const full = path.posix.join(this.path, name);
        return statSync(full).isDirectory() ? new EsFolder(full) : new EsFile(full);
      });
  }
}

export interface ScheduledTask {
  id: number;
  code: string;
  delay: number;
  repeat: boolean;
  cancelled: boolean;
}

/** app.settings as After Effects keeps it: section → key → string. */
export class EsSettings {
  readonly store = new Map<string, string>();
  haveSetting(section: string, key: string): boolean {
    return this.store.has(`${section}\u0000${key}`);
  }
  getSetting(section: string, key: string): string {
    const v = this.store.get(`${section}\u0000${key}`);
    if (v === undefined) throw new Error(`no setting ${section}/${key}`);
    return v;
  }
  saveSetting(section: string, key: string, value: string): void {
    this.store.set(`${section}\u0000${key}`, String(value));
  }
  peek(section: string, key: string): string | undefined {
    return this.store.get(`${section}\u0000${key}`);
  }
}

export function makeApp() {
  const tasks: ScheduledTask[] = [];
  const app = {
    version: "26.5x1",
    settings: new EsSettings(),
    project: {
      dirty: false,
      numItems: 0,
      file: null as EsFile | null,
      saves: 0,
      save(): void {
        app.project.saves++;
        app.project.dirty = false;
      },
    },
    undoGroups: 0,
    /** Menu command ids passed to app.executeCommand (16 = Undo). */
    commands: [] as number[],
    executeCommand(id: number): void {
      app.commands.push(id);
    },
    tasks,
    scheduleTask(code: string, delay: number, repeat: boolean): number {
      const task = { id: tasks.length + 1, code, delay, repeat, cancelled: false };
      tasks.push(task);
      return task.id;
    },
    cancelTask(id: number): void {
      const task = tasks.find((t) => t.id === id);
      if (task) task.cancelled = true;
    },
    beginUndoGroup(): void {
      app.undoGroups++;
    },
    endUndoGroup(): void {},
    beginSuppressDialogs(): void {},
    endSuppressDialogs(): void {},
  };
  return app;
}

export type EsApp = ReturnType<typeof makeApp>;

/** One ExtendScript engine: a shared `$.global` that every evaluated file sees. */
export interface EsEngine {
  app: EsApp;
  global: Record<string, unknown>;
  env: Record<string, string>;
  /** What confirm() answers next, and what alert()/confirm() were shown. */
  dialogs: { answer: boolean; shown: string[] };
  run(source: string, thisObj?: unknown, extra?: Record<string, unknown>): unknown;
}

export function makeEngine(tempDir: string): EsEngine {
  EsFolder.temp = new EsFolder(tempDir);
  const app = makeApp();
  const global: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const dollar = {
    global,
    os: "Windows 10.0",
    getenv: (name: string) => (name in env ? env[name] : null),
  };
  const dialogs = { answer: true, shown: [] as string[] };
  const confirm = (text: string) => {
    dialogs.shown.push(String(text));
    return dialogs.answer;
  };
  const alert = (text: string) => {
    dialogs.shown.push(String(text));
  };
  return {
    app,
    global,
    env,
    dialogs,
    run(source, thisObj, extra = {}) {
      const names = ["app", "$", "File", "Folder", "confirm", "alert", ...Object.keys(extra)];
      const values = [app, dollar, EsFile, EsFolder, confirm, alert, ...Object.values(extra)];
      const fn = new Function(...names, source);
      return fn.apply(thisObj, values);
    },
  };
}

/**
 * Resolve `#include "x.jsx"` the way ExtendScript does, relative to `file`.
 * Includes not listed in `keep` are dropped: helpers/export/import/toolkit
 * are AE object-model code the pause switch never reaches, and json2.jsx is
 * redundant next to Node's own JSON.
 */
export function loadJsx(file: string, keep: string[] = []): string {
  const dir = path.dirname(file);
  return readFileSync(file, "utf8").replace(/^#include\s+"([^"]+)"\s*$/gm, (_line, name: string) =>
    keep.includes(name) ? loadJsx(path.join(dir, name), keep) : "",
  );
}
