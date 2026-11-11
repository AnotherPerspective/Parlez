<a id="english"></a>

# Parlez! for Adobe® After Effects®

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-informational)](package.json)

**English** · [Italiano](#italiano)

Parlez! lets **Claude work inside After Effects**. Tell Claude what you want in plain words ("animate this title with a soft bounce", "check this comp for problems") and Claude does it in the open project while you watch.

Free and open source (MIT). It grows out of [mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) by kumo.productions (see [Credits](#credits)).

> [!IMPORTANT]
> **Testing status.** Parlez! is **tested on After Effects 2026 (26.5) / Windows 10**. macOS, After Effects 2024 and After Effects 2025 are **written to work but not tested yet**. Background rendering (aerender) has not yet succeeded from the program. This is a preview (0.1): try it on a copy of a project first, not on real work.
>
> Before using it, read the **[notices](AVVERTENZE.md#english)**: Parlez! is free and experimental, provided as is, and you use it at your own risk.

## Requirements

- **After Effects 2024, 2025 or 2026**, on Windows or macOS
- **Node.js 24 or newer** ([nodejs.org](https://nodejs.org), LTS) — check with `node --version`
- **Claude Code or Claude Desktop**

## Setup in three commands

```bash
npm install -g parlez
parlez setup --lang en
```

Until Parlez! is on npm, install the file you received instead: `npm install -g ./parlez-0.1.1.tgz`. Installing downloads the libraries Parlez! needs once; after that the program never connects to the internet.

The first time, `parlez setup` shows a short version of the **[notices](AVVERTENZE.md#english)** and installs only after you type `I accept`; any other answer stops it without installing anything. It remembers this in `%APPDATA%\Parlez\avvertenze-accettate.json` (on macOS `~/Library/Application Support/Parlez/`), next to the panel's history, and does not ask again. Scripted installs can add `--accept`, which counts as accepting.

Then it finds After Effects, installs the **startup script** (a small agent that stays inside After Effects and receives Claude's requests) and the **Parlez! panel**, checks the scripting checkbox, and prints the third command: the `claude mcp add …` line for Claude Code, or the block for Claude Desktop with where to paste it. It writes only into your user's After Effects folders. With several After Effects versions it asks which ones (or use `--version 26.5`).

Then **restart After Effects**, open **Window → Parlez!** and switch it on.

**One thing to do by hand in After Effects:** Edit → Preferences → Scripting & Expressions → turn on **"Allow Scripts to Write Files and Access Network"**, then close the dialog with OK. On macOS: After Effects → Settings → Scripting & Expressions (as Adobe documents it). With the startup script installed, macOS should not ask to let your terminal or Claude Desktop control After Effects (Automation): only the direct connection needs it. If it asks anyway, allow it.

`parlez doctor --lang en` checks all of the above, including whether and when the notices were accepted, **without changing anything**; every "TO DO" line says what is missing.

## The ON/OFF panel

**Window → Parlez!**: a big switch. **OFF (red)**: Claude is stopped and every request is refused — the panel starts OFF. **ON green**: waiting; **yellow**: working; **grey**: the startup script is not answering (usually a dialog is open). **Read only**: Claude can look but not change. Below: the latest requests with their outcome, a full history on file, and a one-click restore point.

## What it does and does not do

It reads and edits projects, comps, layers, keyframes, effects, masks, text, shapes and expressions; shows frames right in the chat and checks the work (automatic audits, comparison against a reference, motion check); offers named easing curves, staggering, expression presets and "recipes" that build a graphic in one step.

For safety: **no internet access, ever**; **confirmations** before anything is deleted, overwritten or renamed (some dangerous commands are refused outright); **restore points** of the `.aep`; **one Ctrl/Cmd+Z** undoes a whole request; **read-only and pause** from the panel; arbitrary ExtendScript is **off** by default.

What Claude reads from the project (names, text, file paths, frames) goes to the Claude service you use. For NDA work or unreleased client material, check your Claude plan's data terms first. An optional **privacy mode** strips paths and hides the names you list: see [`docs/riservatezza.md`](docs/riservatezza.md) (Italian).

## Troubleshooting

Timeouts: is After Effects open, the panel ON, the scripting checkbox on, and no dialog open (sometimes hidden behind the main window)? Then run `parlez doctor`. After an After Effects update (e.g. 26.5 → 26.6) or a Parlez! update, run `parlez setup` again. Issues: [github.com/AnotherPerspective/Parlez/issues](https://github.com/AnotherPerspective/Parlez/issues).

Developers: advanced options and architecture are in [`docs/TOOLS.md`](docs/TOOLS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). **Default connection:** Parlez! talks to After Effects through the startup script; kumo's direct `AfterFX.exe -r` path remains as a fallback when the startup script is not installed (or with `AE_MCP_PULL_ONLY=0`).

---

<a id="italiano"></a>

# Parlez! per Adobe® After Effects®

[English](#english) · **Italiano**

Parlez! fa lavorare **Claude dentro After Effects**. Scrivi a Claude cosa vuoi, in parole normali («anima questo titolo con un rimbalzo morbido», «controlla se in questa composizione c'è qualcosa che non va»), e Claude lo fa nel progetto aperto, mentre tu guardi.

È gratuito e open source (licenza MIT). Nasce da [mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) di kumo.productions (vedi [Crediti](#crediti)).

> [!IMPORTANT]
> **Stato delle prove.** Parlez! è **provato su After Effects 2026 (26.5) / Windows 10**. Il Mac, After Effects 2024 e After Effects 2025 sono **scritti per funzionare ma non ancora provati**. Il render in sottofondo (aerender) non è ancora riuscito dal programma. È una versione di prova (0.1): usala prima su una copia di un progetto, non sul lavoro vero.
>
> Prima di usarlo leggi le **[avvertenze](AVVERTENZE.md#italiano)**: Parlez! è gratuito e sperimentale, è fornito così com'è e lo usi a tuo rischio.

## Cosa serve

| Cosa                                  | Note                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **After Effects 2024, 2025 o 2026**   | Su Windows o Mac.                                                                                                                                               |
| **Node.js 24 o più recente**          | Il «motore» che fa girare Parlez!. Si scarica da [nodejs.org](https://nodejs.org) (versione LTS). Per controllare: apri il terminale e scrivi `node --version`. |
| **Claude Code oppure Claude Desktop** | Il programma dove scrivi a Claude.                                                                                                                              |

Il terminale su Windows è **PowerShell** (cercalo nel menu Start); sul Mac è **Terminale**.

## Installazione in tre comandi

**1. Installa Parlez!**

```bash
npm install -g parlez
```

> Finché Parlez! non è pubblicato su npm, al posto di questo comando usa il file che hai ricevuto: `npm install -g ./parlez-0.1.1.tgz` (lanciato dalla cartella dove si trova il file). L'installazione scarica una volta le librerie di cui Parlez! ha bisogno; dopo, il programma non si collega più a internet.

**2. Prepara After Effects**

```bash
parlez setup
```

La prima volta ti mostra in breve le **[avvertenze](AVVERTENZE.md#italiano)** e installa solo dopo che hai scritto `accetto`; con qualsiasi altra risposta si ferma senza installare niente. Lo ricorda in `%APPDATA%\Parlez\avvertenze-accettate.json` (sul Mac `~/Library/Application Support/Parlez/`), accanto allo storico del pannello, e non te lo chiede più. Chi installa da uno script può aggiungere `--accept`, che vale come accettazione.

Poi trova After Effects, installa lo **script di avvio** (il piccolo programma che resta dentro After Effects e riceve le richieste di Claude) e il **pannello Parlez!**, controlla la casella degli script e alla fine ti stampa il comando del punto 3. Scrive solo nelle cartelle di After Effects del tuo utente. Se hai più versioni di After Effects ti chiede in quali installare (oppure `parlez setup --version 26.5`). Messaggi in inglese: `parlez setup --lang en`.

**3. Collega Parlez! a Claude**

Copia e incolla il comando `claude mcp add …` che `parlez setup` ha stampato (per Claude Code), oppure il blocco per Claude Desktop, che `parlez setup` stampa insieme al punto preciso dove incollarlo. Il comando ha questa forma:

```bash
claude mcp add --scope user parlez -e AE_MCP_PULL_ONLY=1 -- "<percorso di node>" "<percorso di parlez>/dist/index.js"
```

Poi **riavvia After Effects**, apri il pannello da **Finestra → Parlez!** e accendilo.

### Una sola cosa da fare a mano in After Effects

In **Modifica → Preferenze → Script ed espressioni** accendi **«Consenti agli script di scrivere file e accedere alla rete»** e chiudi la finestra con OK. Nessun programma può accenderla al posto tuo. `parlez setup` ti dice se è già accesa. Sul Mac la casella sta in **After Effects → Impostazioni → Script ed espressioni** (così la indica Adobe: «After Effects > Settings > Scripting & Expressions»).

Sul Mac, con lo script di avvio installato, macOS non deve chiedere il permesso di **controllare After Effects** (Automazione): serve solo al collegamento diretto, che Parlez! in quel caso non usa. Se compare comunque, rispondi Consenti. Guida passo per passo per il Mac: [docs/mac-checklist.md](docs/mac-checklist.md).

### Controllare che sia tutto a posto

```bash
parlez doctor
```

Controlla Node, se e quando hai accettato le avvertenze, lo script di avvio, il pannello, la casella degli script e se c'è un After Effects acceso con lo script di avvio attivo. **Non cambia niente.** Ogni riga «DA FARE» dice cosa manca.

## Il pannello ON/OFF

Dentro After Effects, **Finestra → Parlez!** apre un pannello con un grande interruttore:

- **OFF (rosso)**: Claude è fermo. Ogni sua richiesta viene rifiutata. Alla prima apertura il pannello parte su OFF.
- **ON verde**: Claude può lavorare ed è in attesa. **Giallo**: sta lavorando. **Grigio**: lo script di avvio non risponde (di solito c'è una finestra di dialogo aperta in After Effects).
- **Sola lettura**: Claude può guardare il progetto ma non modificarlo.
- Sotto, le **ultime richieste** in italiano semplice, con l'esito. Lo storico completo è su file (bottone «Storico»).
- **Ripristino** fa un punto di ripristino del progetto con un clic.

## Cosa fa e cosa non fa

**Fa:**

- legge il progetto, le composizioni e i livelli; crea e modifica livelli, keyframe, effetti, maschere, testi, forme, espressioni;
- ti mostra i fotogrammi direttamente nella chat e controlla il lavoro (controlli automatici, confronto con una reference, controllo del movimento);
- usa curve con nome, sfalsamenti e modelli di espressione pronti; costruisce pezzi grafici da «ricette» (per esempio un lower third) in un solo passo.

**Per sicurezza:**

- **Niente internet.** Parlez! non si collega mai a internet: né per font, né per aggiornamenti, né per altro. Parla solo con After Effects, sul tuo computer.
- **Conferme.** Prima di cancellare, sovrascrivere o rinominare qualcosa, Claude deve chiederti il permesso. Alcuni comandi pericolosi sono vietati del tutto.
- **Punti di ripristino.** Prima di un lavoro rischioso Claude può fare una copia datata del file `.aep`, per tornare indietro.
- **Un solo Ctrl+Z.** Ogni richiesta di Claude si annulla con un solo Ctrl+Z (Cmd+Z sul Mac).
- **Sola lettura e pausa** dal pannello, in ogni momento.
- **Il codice libero è spento.** La possibilità di far eseguire a Claude script scritti da lui (che potrebbero toccare il resto del computer) è spenta di serie.

**Attenzione a cosa vede Claude.** Quello che Claude legge dal progetto (nomi di composizioni e livelli, testi, percorsi dei file, fotogrammi) arriva al servizio Claude che usi. Per progetti sotto NDA o con materiali di clienti non ancora pubblici, controlla prima le regole del tuo piano Claude. Parlez! ha una **modalità riservata** (spenta di serie) che toglie i percorsi e nasconde i nomi che scegli: vedi [`docs/riservatezza.md`](docs/riservatezza.md).

## Se qualcosa non va

- **Claude va in timeout**: controlla che After Effects sia aperto, che il pannello sia su ON, che la casella degli script sia accesa e che non ci sia una finestra di dialogo aperta (a volte resta nascosta dietro la finestra principale). Poi `parlez doctor`.
- **«Claude è in pausa»**: il pannello è su OFF. Portalo su ON.
- **Dopo un aggiornamento di After Effects** (per esempio da 26.5 a 26.6) rilancia `parlez setup`: ogni versione ha la sua cartella.
- **Dopo un aggiornamento di Parlez!** rilancia `parlez setup` per aggiornare il pannello.

Per segnalare un problema: [github.com/AnotherPerspective/Parlez/issues](https://github.com/AnotherPerspective/Parlez/issues).

## Per chi sviluppa

Le opzioni avanzate (sola lettura `AE_MCP_READONLY=1`, categorie consentite `AE_MCP_ALLOW_CATEGORIES`, più After Effects aperti con `AE_MCP_INSTANCE`, percorso di After Effects `AE_MCP_EXE`, collegamento diretto `AE_MCP_PULL_ONLY=0`) e l'architettura sono in [`docs/TOOLS.md`](docs/TOOLS.md) e [`CONTRIBUTING.md`](CONTRIBUTING.md). Le novità di ogni versione sono nel [`CHANGELOG.md`](CHANGELOG.md).

**Collegamento predefinito.** Parlez! parla con After Effects tramite lo script di avvio. Il collegamento «diretto» di kumo (`AfterFX.exe -r`) resta come ripiego per chi non installa lo script di avvio; quando lo script è installato il server non lo usa, salvo `AE_MCP_PULL_ONLY=0`.

---

## Credits

Parlez! for Adobe® After Effects® builds on the work of others, released under the MIT License. Thank you. The full license texts are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

- **[mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects)** by kumo.productions, Inc. ([@kumoproductions](https://github.com/kumoproductions)) — Copyright (c) 2026 kumo.productions, Inc. Parlez! is a fork of this project: the engine that talks to After Effects comes from here.
- **[After-Effects-mcp-pro](https://github.com/malkawi06/After-Effects-mcp-pro)** by Mohammad Malkawi ([@malkawi06](https://github.com/malkawi06)) — Copyright (c) 2026 Mohammad Malkawi. We draw ideas, and possibly code, from it for the "eyes" (seeing and checking the work), checkpoints, background rendering and the AEH helper library.
- **[after-effects-mcp](https://github.com/ishu86/after-effects-mcp)** by Ishant Kohar ([@ishu86](https://github.com/ishu86)) — Copyright (c) 2024 Ishant Kohar. We draw on its ideas for ready-made templates and its expression presets.

## Crediti

Parlez! per Adobe® After Effects® nasce dal lavoro di altri, pubblicato con licenza MIT. Li ringraziamo. I testi completi delle licenze sono in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

- **[mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects)** di kumo.productions, Inc. ([@kumoproductions](https://github.com/kumoproductions)) — Copyright (c) 2026 kumo.productions, Inc. Parlez! è un fork di questo progetto: il motore che parla con After Effects viene da qui.
- **[After-Effects-mcp-pro](https://github.com/malkawi06/After-Effects-mcp-pro)** di Mohammad Malkawi ([@malkawi06](https://github.com/malkawi06)) — Copyright (c) 2026 Mohammad Malkawi. Ne riprendiamo idee ed eventuale codice per gli «occhi» (vedere e controllare il lavoro), i checkpoint, il render in sottofondo e la libreria di aiuti AEH.
- **[after-effects-mcp](https://github.com/ishu86/after-effects-mcp)** di Ishant Kohar ([@ishu86](https://github.com/ishu86)) — Copyright (c) 2024 Ishant Kohar. Ne riprendiamo le idee dei modelli pronti e i modelli di espressione.

## License / Licenza

MIT — Copyright (c) 2026 kumo.productions, Inc.; Copyright (c) 2026 Another Perspective Pictures SRL. See / vedi [`LICENSE`](LICENSE).

## Trademarks

"Parlez! for Adobe® After Effects®". Adobe and After Effects are trademarks of Adobe Inc. Parlez! is an independent project, not affiliated with, endorsed by or sponsored by Adobe.

## Marchi

«Parlez! per Adobe® After Effects®». Adobe e After Effects sono marchi di Adobe Inc. Parlez! è un progetto indipendente, non affiliato ad Adobe, né approvato o sponsorizzato da Adobe.
