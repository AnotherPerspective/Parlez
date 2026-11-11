// Offline guard for the copyright notices the MIT License obliges us to keep
// Reads THIRD_PARTY_NOTICES.md and
// LICENSE from the repository root; never touches After Effects or the network.
// Messages are in Italian on purpose: the owner reads them.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const NOTICES = "THIRD_PARTY_NOTICES.md";
const LICENSE = "LICENSE";

const APP_LINE = "Copyright (c) 2026 Another Perspective Pictures SRL";

const UPSTREAM = [
  { name: "mcp-aftereffects (kumoproductions)", line: "Copyright (c) 2026 kumo.productions, Inc." },
  { name: "After-Effects-mcp-pro (Mohammad Malkawi)", line: "Copyright (c) 2026 Mohammad Malkawi" },
  { name: "after-effects-mcp (ishu86)", line: "Copyright (c) 2024 Ishant Kohar" },
];

const MIT_PHRASES = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
];

const ALL_COPYRIGHT_LINES = [APP_LINE, ...UPSTREAM.map((u) => u.line)];

/** Lines with CRLF folded to LF and trailing blanks dropped, or null if the file is missing. */
function readLines(file: string): string[] | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
}

// Whole-line equality, not substring: a wrong year or a stray space must count as missing.
function checkLineOnce(
  problems: string[],
  fileName: string,
  lines: string[],
  expected: string,
): void {
  const count = lines.filter((l) => l === expected).length;
  if (count === 0) {
    problems.push(`In ${fileName} manca la riga: ${expected}`);
  } else if (count > 1) {
    problems.push(
      `In ${fileName} la riga «${expected}» compare ${count} volte, deve comparire una sola volta.`,
    );
  }
}

// A project's license text runs from its copyright line to the next different
// known copyright line (or the end of the file), so the order of sections is
// free. A repeat of the same line is reported as a duplicate, not as a cut.
function sectionAfter(lines: string[], start: number): string[] {
  const nextStarts = lines
    .map((l, i) => (i > start && l !== lines[start] && ALL_COPYRIGHT_LINES.includes(l) ? i : -1))
    .filter((i) => i !== -1);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : lines.length;
  return lines.slice(start + 1, end);
}

/** Every problem found under `root`, in plain Italian; empty when all is in order. */
function checkNotices(root: string): string[] {
  const problems: string[] = [];
  const notices = readLines(join(root, NOTICES));
  const license = readLines(join(root, LICENSE));

  if (notices === null) {
    problems.push(`Manca il file ${NOTICES} nella radice.`);
  } else {
    for (const line of ALL_COPYRIGHT_LINES) checkLineOnce(problems, NOTICES, notices, line);

    for (const project of UPSTREAM) {
      const start = notices.indexOf(project.line);
      // A missing copyright line is already reported above.
      if (start === -1) continue;
      const section = sectionAfter(notices, start);
      for (const phrase of MIT_PHRASES) {
        if (!section.some((l) => l.includes(phrase))) {
          problems.push(
            `Il testo della licenza MIT di ${project.name} è incompleto: manca «${phrase}».`,
          );
        }
      }
    }

    for (const phrase of MIT_PHRASES) {
      const count = notices.filter((l) => l.includes(phrase)).length;
      if (count < UPSTREAM.length) {
        problems.push(
          `In ${NOTICES} la frase «${phrase}» compare ${count} volte: ne servono ${UPSTREAM.length}, una per progetto.`,
        );
      }
    }
  }

  if (license === null) {
    problems.push(`Manca il file ${LICENSE} nella radice.`);
  } else {
    checkLineOnce(problems, LICENSE, license, APP_LINE);
    const firstLine = license.find((l) => l.trim() !== "");
    if (firstLine?.trim() !== "MIT License") {
      problems.push(`In ${LICENSE} manca la dicitura «MIT License» in testa.`);
    }
    if (!license.some((l) => l.includes("Permission is hereby granted"))) {
      problems.push(`In ${LICENSE} manca la frase «Permission is hereby granted».`);
    }
  }

  return problems;
}

function withoutLine(text: string, line: string): string {
  return text
    .split("\n")
    .filter((l) => l.trimEnd() !== line)
    .join("\n");
}

function replaceLine(text: string, line: string, replacement: string): string {
  return text
    .split("\n")
    .map((l) => (l.trimEnd() === line ? replacement : l))
    .join("\n");
}

function toCrlf(text: string): string {
  return text.replace(/\n/g, "\r\n");
}

function withTrailingSpaces(text: string): string {
  return text.replace(/\n/g, "   \n");
}

function withExtraLines(text: string): string {
  return `Riga aggiunta in testa.\n\n${text}\n\nRiga aggiunta in fondo.\n`;
}

// Moves the last project section (ishu86) in front of the first (kumo).
function withReorderedSections(text: string): string {
  const parts = text.split("\n---\n");
  const [ishu] = parts.splice(3, 1);
  parts.splice(1, 0, ishu ?? "");
  return parts.join("\n---\n");
}

describe("note di terze parti (THIRD_PARTY_NOTICES.md e LICENSE)", () => {
  it("i file del repository contengono tutte le note di copyright", () => {
    const problems = checkNotices(REPO_ROOT);
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

// The guard must go red for real: each case below runs it on doctored copies
// of the two files in a temporary folder, never on the files in the repository.
describe("prove del test stesso (copie finte in una cartella temporanea)", () => {
  const realNotices = readFileSync(join(REPO_ROOT, NOTICES), "utf8").replace(/\r\n?/g, "\n");
  const realLicense = readFileSync(join(REPO_ROOT, LICENSE), "utf8").replace(/\r\n?/g, "\n");
  const base = mkdtempSync(join(tmpdir(), "parlez-notices-"));
  let caseNo = 0;

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Writes a fake repository root; null leaves that file out. */
  function fakeRoot(notices: string | null, license: string | null): string {
    caseNo += 1;
    const root = mkdtempSync(join(base, `caso-${caseNo}-`));
    if (notices !== null) writeFileSync(join(root, NOTICES), notices, "utf8");
    if (license !== null) writeFileSync(join(root, LICENSE), license, "utf8");
    return root;
  }

  it("le copie intatte passano", () => {
    expect(checkNotices(fakeRoot(realNotices, realLicense))).toEqual([]);
  });

  it("non fallisce per CRLF, spazi a fine riga, righe in più o sezioni in altro ordine", () => {
    const reordered = withReorderedSections(realNotices);
    expect(reordered).not.toBe(realNotices);
    expect(checkNotices(fakeRoot(reordered, realLicense))).toEqual([]);
    expect(checkNotices(fakeRoot(toCrlf(realNotices), toCrlf(realLicense)))).toEqual([]);
    expect(
      checkNotices(fakeRoot(withTrailingSpaces(realNotices), withTrailingSpaces(realLicense))),
    ).toEqual([]);
    expect(checkNotices(fakeRoot(withExtraLines(realNotices), realLicense))).toEqual([]);
  });

  it.each(ALL_COPYRIGHT_LINES)("fallisce se in THIRD_PARTY_NOTICES.md manca «%s»", (line) => {
    const problems = checkNotices(fakeRoot(withoutLine(realNotices, line), realLicense));
    expect(problems).toContain(`In ${NOTICES} manca la riga: ${line}`);
  });

  it("fallisce se in LICENSE manca la riga di APP", () => {
    const problems = checkNotices(fakeRoot(realNotices, withoutLine(realLicense, APP_LINE)));
    expect(problems).toEqual([`In ${LICENSE} manca la riga: ${APP_LINE}`]);
  });

  it("fallisce se manca THIRD_PARTY_NOTICES.md", () => {
    expect(checkNotices(fakeRoot(null, realLicense))).toEqual([
      `Manca il file ${NOTICES} nella radice.`,
    ]);
  });

  it("fallisce se manca LICENSE", () => {
    expect(checkNotices(fakeRoot(realNotices, null))).toEqual([
      `Manca il file ${LICENSE} nella radice.`,
    ]);
  });

  it.each([
    ["anno diverso", "Copyright (c) 2025 Ishant Kohar"],
    ["nome diverso", "Copyright (c) 2024 Ishant Kohr"],
    ["spazio in più", "Copyright (c)  2024 Ishant Kohar"],
    ["spazio in testa", " Copyright (c) 2024 Ishant Kohar"],
    ["riga spezzata", "Copyright (c) 2024\nIshant Kohar"],
  ])("una riga sbagliata (%s) conta come mancante", (_label, wrong) => {
    const line = "Copyright (c) 2024 Ishant Kohar";
    const problems = checkNotices(fakeRoot(replaceLine(realNotices, line, wrong), realLicense));
    expect(problems).toContain(`In ${NOTICES} manca la riga: ${line}`);
  });

  it("fallisce se una riga compare due volte", () => {
    const line = "Copyright (c) 2026 Mohammad Malkawi";
    const doubled = replaceLine(realNotices, line, `${line}\n${line}`);
    expect(checkNotices(fakeRoot(doubled, realLicense))).toEqual([
      `In ${NOTICES} la riga «${line}» compare 2 volte, deve comparire una sola volta.`,
    ]);
  });

  it("fallisce se il testo della licenza di un progetto è tagliato", () => {
    // Cut only the disclaimer that follows Malkawi's copyright line.
    const lines = realNotices.split("\n");
    const start = lines.findIndex((l) => l.trimEnd() === "Copyright (c) 2026 Mohammad Malkawi");
    const cut = lines.findIndex((l, i) => i > start && l.includes(MIT_PHRASES[1]));
    lines.splice(cut, 1);
    const problems = checkNotices(fakeRoot(lines.join("\n"), realLicense));
    expect(problems).toContain(
      `Il testo della licenza MIT di After-Effects-mcp-pro (Mohammad Malkawi) è incompleto: manca «${MIT_PHRASES[1]}».`,
    );
    expect(problems).toContain(
      `In ${NOTICES} la frase «${MIT_PHRASES[1]}» compare 2 volte: ne servono 3, una per progetto.`,
    );
  });

  it("fallisce se LICENSE non comincia con «MIT License»", () => {
    const problems = checkNotices(fakeRoot(realNotices, withoutLine(realLicense, "MIT License")));
    expect(problems).toEqual([`In ${LICENSE} manca la dicitura «MIT License» in testa.`]);
  });
});
