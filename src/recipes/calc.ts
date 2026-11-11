// The small calculator behind "= …" values (recipe format §3.3).
//
// Recipes come from other people too (the repository is public), so a recipe
// must never be able to run code: this is a closed interpreter that knows
// numbers, unit literals, names, the four operations, vectors and five
// functions — nothing else, and no eval anywhere. Times evaluate to FRAMES and
// lengths to PIXELS (see units.ts), so `end - 12f` and `safe.title.left + 24u`
// mean what a motion designer reads.

import { lengthToPx, timeToFrames } from "./units.js";

export type CalcNode =
  | { k: "num"; v: number }
  | { k: "unit"; text: string; unit: "f" | "s" | "u" | "px" }
  | { k: "id"; name: string }
  | { k: "member"; obj: CalcNode; prop: string }
  | { k: "neg"; e: CalcNode }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; l: CalcNode; r: CalcNode }
  | { k: "arr"; items: CalcNode[] }
  | { k: "call"; fn: string; args: CalcNode[] };

export const CALC_FUNCTIONS = ["min", "max", "round", "abs", "if"] as const;

export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalcError";
  }
}

type Tok =
  | { t: "num"; text: string; unit: "f" | "s" | "u" | "px" | null }
  | { t: "id"; text: string }
  | { t: "op"; text: string }
  | { t: "end" };

const NUM_RE = /^(\d+(?:\.\d+)?)(?:(px|f|s|u)(@\d+(?:\.\d+)?)?)?/;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = NUM_RE.exec(rest);
    if (num && /\d/.test(ch)) {
      const full = num[0];
      if (ID_RE.test(rest.slice(full.length))) {
        throw new CalcError(
          `«${rest.slice(0, full.length + 1)}…» non è un numero né una unità valida`,
        );
      }
      const unit = (num[2] ?? null) as "f" | "s" | "u" | "px" | null;
      if (num[3] && unit !== "f")
        throw new CalcError(`«${full}»: la frequenza @ si usa solo con i fotogrammi (es. 12f@25)`);
      out.push({ t: "num", text: full, unit });
      i += full.length;
      continue;
    }
    const id = ID_RE.exec(rest);
    if (id) {
      out.push({ t: "id", text: id[0] });
      i += id[0].length;
      continue;
    }
    if ("+-*/()[],.".includes(ch)) {
      out.push({ t: "op", text: ch });
      i++;
      continue;
    }
    throw new CalcError(`carattere inatteso «${ch}»`);
  }
  out.push({ t: "end" });
  return out;
}

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): CalcNode {
    const node = this.expr();
    const t = this.peek();
    if (t.t !== "end")
      throw new CalcError(`qualcosa avanza alla fine: «${"text" in t ? t.text : ""}»`);
    return node;
  }

  private peek(): Tok {
    return this.toks[this.pos];
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.text === text;
  }

  private expect(text: string): void {
    if (!this.isOp(text)) throw new CalcError(`manca «${text}»`);
    this.pos++;
  }

  private expr(): CalcNode {
    let l = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.toks[this.pos++] as { text: "+" | "-" }).text;
      l = { k: "bin", op, l, r: this.term() };
    }
    return l;
  }

  private term(): CalcNode {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = (this.toks[this.pos++] as { text: "*" | "/" }).text;
      l = { k: "bin", op, l, r: this.unary() };
    }
    return l;
  }

  private unary(): CalcNode {
    if (this.isOp("-")) {
      this.pos++;
      return { k: "neg", e: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): CalcNode {
    let node = this.primary();
    while (this.isOp(".")) {
      this.pos++;
      const t = this.peek();
      if (t.t !== "id") throw new CalcError("dopo il punto serve un nome");
      this.pos++;
      node = { k: "member", obj: node, prop: t.text };
    }
    return node;
  }

  private primary(): CalcNode {
    const t = this.peek();
    if (t.t === "num") {
      this.pos++;
      return t.unit === null
        ? { k: "num", v: Number(t.text) }
        : { k: "unit", text: t.text, unit: t.unit };
    }
    if (t.t === "id") {
      this.pos++;
      if (this.isOp("(")) {
        if (!(CALC_FUNCTIONS as readonly string[]).includes(t.text)) {
          throw new CalcError(
            `funzione sconosciuta «${t.text}» (ci sono: ${CALC_FUNCTIONS.join(", ")})`,
          );
        }
        this.pos++;
        const args: CalcNode[] = [];
        if (!this.isOp(")")) {
          args.push(this.expr());
          while (this.isOp(",")) {
            this.pos++;
            args.push(this.expr());
          }
        }
        this.expect(")");
        return { k: "call", fn: t.text, args };
      }
      return { k: "id", name: t.text };
    }
    if (this.isOp("(")) {
      this.pos++;
      const e = this.expr();
      this.expect(")");
      return e;
    }
    if (this.isOp("[")) {
      this.pos++;
      const items: CalcNode[] = [];
      if (!this.isOp("]")) {
        items.push(this.expr());
        while (this.isOp(",")) {
          this.pos++;
          items.push(this.expr());
        }
      }
      this.expect("]");
      return { k: "arr", items };
    }
    throw new CalcError("calcolo incompleto");
  }
}

/** True when a recipe value is a calc ("= …"). */
export function isCalc(v: unknown): v is string {
  return typeof v === "string" && v.trimStart().startsWith("=");
}

/** Parse the text after "=". Throws CalcError with a plain-Italian message. */
export function parseCalc(src: string): CalcNode {
  const body = src.trimStart().startsWith("=") ? src.trimStart().slice(1) : src;
  return new Parser(tokenize(body)).parse();
}

/** Root names a calc reads (not function names, not member properties). */
export function calcNames(node: CalcNode, out: Set<string> = new Set()): Set<string> {
  switch (node.k) {
    case "id":
      out.add(node.name);
      break;
    case "member":
      calcNames(node.obj, out);
      break;
    case "neg":
      calcNames(node.e, out);
      break;
    case "bin":
      calcNames(node.l, out);
      calcNames(node.r, out);
      break;
    case "arr":
      for (const i of node.items) calcNames(i, out);
      break;
    case "call":
      for (const a of node.args) calcNames(a, out);
      break;
    default:
      break;
  }
  return out;
}

export interface CalcContext {
  fps: number;
  /** Pixels per u. */
  unit: number;
  lookup(name: string): unknown;
}

/** Empty text, 0, false and null read as "no" in if(); everything else as "yes". */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  return true;
}

function toNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new CalcError(`${what} deve essere un numero, invece è ${JSON.stringify(v)}`);
  }
  return v;
}

export function evaluate(node: CalcNode, ctx: CalcContext): unknown {
  switch (node.k) {
    case "num":
      return node.v;
    case "unit":
      return node.unit === "f" || node.unit === "s"
        ? timeToFrames(node.text, ctx.fps)
        : lengthToPx(node.text, ctx.unit);
    case "id":
      return ctx.lookup(node.name);
    case "member": {
      const obj = evaluate(node.obj, ctx);
      if (obj === null || typeof obj !== "object" || !Object.hasOwn(obj, node.prop)) {
        throw new CalcError(`«${node.prop}» non c'è in questo valore`);
      }
      return (obj as Record<string, unknown>)[node.prop];
    }
    case "neg":
      return -toNumber(evaluate(node.e, ctx), "il valore dopo il meno");
    case "bin": {
      const l = toNumber(evaluate(node.l, ctx), `il primo termine di «${node.op}»`);
      const r = toNumber(evaluate(node.r, ctx), `il secondo termine di «${node.op}»`);
      if (node.op === "+") return l + r;
      if (node.op === "-") return l - r;
      if (node.op === "*") return l * r;
      if (r === 0) throw new CalcError("divisione per zero");
      return l / r;
    }
    case "arr":
      return node.items.map((i) => evaluate(i, ctx));
    case "call": {
      if (node.fn === "if") {
        if (node.args.length !== 3)
          throw new CalcError("if vuole tre parti: if(condizione, sì, no)");
        return truthy(evaluate(node.args[0], ctx))
          ? evaluate(node.args[1], ctx)
          : evaluate(node.args[2], ctx);
      }
      const args = node.args.map((a, i) =>
        toNumber(evaluate(a, ctx), `l'argomento ${i + 1} di ${node.fn}`),
      );
      if (node.fn === "round") {
        if (args.length !== 1) throw new CalcError("round vuole un solo valore");
        return Math.round(args[0]);
      }
      if (node.fn === "abs") {
        if (args.length !== 1) throw new CalcError("abs vuole un solo valore");
        return Math.abs(args[0]);
      }
      if (args.length === 0) throw new CalcError(`${node.fn} vuole almeno un valore`);
      return node.fn === "min" ? Math.min(...args) : Math.max(...args);
    }
    default:
      throw new CalcError("calcolo non riconosciuto");
  }
}
