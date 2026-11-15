#!/usr/bin/env node
// Costruisce l'installatore Windows di Parlez! (nome provvisorio del file).
//
//   node costruisci.mjs --tgz <parlez-X.Y.Z.tgz> --node-zip <node-vNN-win-x64.zip> [--iscc <ISCC.exe>]
//
// 1. prende node.exe e LICENSE dallo zip ufficiale di Node.js;
// 2. installa il pacchetto parlez (.tgz) con le sue librerie in una cartella
//    a parte, senza script e senza le librerie di sviluppo;
// 3. scrive parlez.cmd e le avvertenze in due file di testo (inglese, italiano);
// 4. lancia ISCC (Inno Setup) se c'è, e scrive le impronte SHA-256.
//
// Scrive solo dentro build\ accanto a questo file. L'unico accesso a
// internet è quello di npm al punto 2, per scaricare le librerie del pacchetto.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build");
const STAGE = path.join(BUILD, "stage");
const OUT = path.join(BUILD, "out");
const TMP = path.join(BUILD, "tmp");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const tgz = path.resolve(arg("tgz", ""));
const nodeZip = path.resolve(arg("node-zip", ""));
// Inno Setup: --iscc, poi la variabile ISCC, poi dove lo mette il suo installatore
// (per tutti gli utenti, o solo per l'utente con /CURRENTUSER).
const iscc =
  arg("iscc") ??
  [
    process.env.ISCC,
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Inno Setup 6",
      "ISCC.exe",
    ),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
  ].find((p) => p && existsSync(p));
if (!existsSync(tgz) || !existsSync(nodeZip)) {
  console.error("Servono --tgz <parlez-X.Y.Z.tgz> e --node-zip <node-vNN-win-x64.zip> esistenti.");
  process.exit(2);
}
const version = /parlez-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz$/.exec(tgz)?.[1];
if (!version) {
  console.error(`Non riesco a leggere la versione dal nome ${path.basename(tgz)}.`);
  process.exit(2);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

rmSync(BUILD, { recursive: true, force: true });
for (const d of [STAGE, OUT, TMP]) mkdirSync(d, { recursive: true });

// 1. Node portatile: solo node.exe e la sua licenza (npm non serve, le librerie sono già dentro).
const nodeDir = path.basename(nodeZip, ".zip");
// tar di Windows (bsdtar) legge gli zip; quello di Git Bash no.
const tar =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
run(tar, ["-xf", nodeZip, "-C", TMP, `${nodeDir}/node.exe`, `${nodeDir}/LICENSE`]);
mkdirSync(path.join(STAGE, "node"));
cpSync(path.join(TMP, nodeDir, "node.exe"), path.join(STAGE, "node", "node.exe"));
cpSync(path.join(TMP, nodeDir, "LICENSE"), path.join(STAGE, "node", "LICENSE"));

// 2. Il pacchetto con le sue librerie. --ignore-scripts: lo script «prepare»
//    serve solo a chi sviluppa.
const prefix = path.join(TMP, "prefix");
// npm su Windows è un .cmd: serve la shell, quindi i percorsi con spazi vanno tra virgolette.
run(
  "npm",
  [
    "install",
    "-g",
    "--prefix",
    `"${prefix}"`,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `"${tgz}"`,
  ],
  { shell: true },
);
cpSync(path.join(prefix, "node_modules", "parlez"), path.join(STAGE, "app"), { recursive: true });

// 3. Il comando «parlez» per il terminale: usa il Node portatile, mai quello di sistema.
writeFileSync(
  path.join(STAGE, "parlez.cmd"),
  '@echo off\r\n"%~dp0node\\node.exe" "%~dp0app\\dist\\index.js" %*\r\n',
  "utf8",
);

// Le avvertenze: AVVERTENZE.md ha l'inglese prima e l'italiano dopo, separati
// dagli ancoraggi «english» / «italiano». Inno Setup mostra testo semplice.
const notices = readFileSync(path.join(STAGE, "app", "AVVERTENZE.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const split = notices.indexOf('<a id="italiano"></a>');
if (split < 0) throw new Error("AVVERTENZE.md senza la sezione italiana");
const plain = (md) =>
  md
    .replace(/<a id="[^"]*"><\/a>\n?/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^---\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\n/g, "\r\n") + "\r\n";
// Il BOM fa leggere a Inno Setup le lettere accentate come UTF-8.
writeFileSync(
  path.join(STAGE, "AVVERTENZE-en.txt"),
  "\ufeff" + plain(notices.slice(0, split)),
  "utf8",
);
writeFileSync(
  path.join(STAGE, "AVVERTENZE-it.txt"),
  "\ufeff" + plain(notices.slice(split)),
  "utf8",
);

rmSync(TMP, { recursive: true, force: true });

// 4. L'installatore.
const exeName = `Parlez-${version}-setup.exe`;
if (iscc && existsSync(iscc)) {
  run(iscc, [
    `/DAppVersion=${version}`,
    `/DStageDir=${STAGE}`,
    `/DOutputDir=${OUT}`,
    path.join(HERE, "parlez.iss"),
  ]);
} else {
  console.log(
    "\nISCC.exe (Inno Setup 6) non trovato: la cartella build\\stage è pronta, l'installatore no.",
  );
}

const lines = [];
for (const f of readdirSync(OUT)) lines.push(`${sha256(path.join(OUT, f))}  ${f}`);
lines.push(
  `${sha256(path.join(STAGE, "node", "node.exe"))}  node\\node.exe (dentro l'installatore)`,
);
writeFileSync(path.join(BUILD, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
console.log(
  `\nFatto. ${existsSync(path.join(OUT, exeName)) ? exeName : "(nessun .exe)"}\n${lines.join("\n")}`,
);
