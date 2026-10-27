# Parlez! per Adobe® After Effects® — Scarica la beta

**Italiano** · [English](#english)

**Parlez!** fa lavorare **Claude dentro After Effects**. Scrivi a Claude cosa vuoi, in parole normali («anima questo titolo con un rimbalzo morbido», «controlla se in questa composizione c'è qualcosa che non va»). Lui lo fa nel progetto aperto, e tu guardi.

- **Gratuito.** Versione di prova (beta 0.1.0).
- **Sotto il tuo controllo.** Prima di cancellare o sovrascrivere qualcosa, Claude deve chiederti il permesso.
- **Punti di ripristino.** Prima di un lavoro rischioso si può salvare una copia del progetto.
- **Un solo Ctrl+Z.** Ogni richiesta di Claude si annulla con un solo Ctrl+Z (Cmd+Z sul Mac).
- **Interruttore ON/OFF** nel pannello «Parlez!» dentro After Effects: su OFF, Claude è fermo. **Niente internet:** Parlez! parla solo con After Effects, sul tuo computer.

> [!IMPORTANT]
> **Stato della beta, detto chiaro.**
> - **Provato:** Windows 10 con After Effects 2026 (26.5).
> - **Scritto per funzionare, ma non ancora provato:** Mac, After Effects 2024 e After Effects 2025.
> - **Non ancora riuscito:** il render in sottofondo (aerender) lanciato dal programma.
>
> Usala su **una copia** di un progetto, mai sul lavoro vero di un cliente.

## Cosa serve

| Cosa | Note |
| --- | --- |
| **After Effects 2024, 2025 o 2026** | Su Windows o Mac. |
| **Node.js 24 o più recente** | Il «motore» che fa girare Parlez!. Si scarica da [nodejs.org](https://nodejs.org) (versione LTS). Per controllare, apri il terminale e scrivi `node --version`. |
| **Claude Code oppure Claude Desktop** | Il programma dove scrivi a Claude. |

Il terminale su Windows è **PowerShell** (cercalo nel menu Start). Sul Mac è **Terminale** (Applicazioni → Utility).

## Scarica

**[⬇ Scarica Parlez! beta (file zip)](https://github.com/AnotherPerspective/Parlez/releases/latest/download/Parlez-beta.zip)**

Dentro lo zip trovi il pacchetto `parlez-0.1.0.tgz`, le due guide passo passo (Windows e Mac) e un file `LEGGIMI.txt`.

**Controllo del file (facoltativo).** Se vuoi essere sicuro che il file non sia stato cambiato, confronta la sua impronta con questa:

```text
8687b74d67b123ff33d9f1b222fbe1e2a44543907e8c2b14a7965db189f44042
```

- Windows (PowerShell): `certutil -hashfile parlez-0.1.0.tgz SHA256`
- Mac (Terminale): `shasum -a 256 parlez-0.1.0.tgz`

Le due sequenze di lettere e numeri devono essere uguali.

## Installa in tre passi

**1. Scompatta lo zip.** Fai doppio clic sullo zip (Windows: «Estrai tutto…»). Apri il terminale **dentro la cartella scompattata**, quella dove c'è `parlez-0.1.0.tgz`. Su Windows: nella cartella, clic destro in uno spazio vuoto → «Apri nel Terminale» (o «Apri finestra PowerShell qui»).

**2. Installa il pacchetto.**

```bash
npm install -g ./parlez-0.1.0.tgz
```

Serve internet **solo in questo momento**, per scaricare due librerie. Dopo, Parlez! non si collega più a internet. Può comparire un avviso con `lefthook` o `install-scripts`: è innocuo.

**3. Prepara After Effects.**

```bash
parlez setup
```

Trova After Effects e installa due cose, solo nelle cartelle del tuo utente: lo **script di avvio** (il piccolo programma che resta dentro After Effects e riceve le richieste di Claude) e il **pannello Parlez!**. Alla fine stampa il comando per collegare Claude (vedi sotto). Se hai più versioni di After Effects, ti chiede in quali installare.

Poi:

- **accendi a mano una casella in After Effects** (nessun programma può farlo al posto tuo): **Modifica → Preferenze → Script ed espressioni** → spunta **«Consenti agli script di scrivere file e accedere alla rete»** → OK. Sul Mac: **After Effects → Impostazioni → Script ed espressioni**;
- **riavvia After Effects**;
- apri **Finestra → Parlez!** e porta l'interruttore su **ON**;
- controlla che sia tutto a posto:

```bash
parlez doctor
```

`parlez doctor` **non cambia niente**: guarda soltanto. Ogni riga «DA FARE» dice cosa manca. Nessuna riga «DA FARE» = pronto.

Guide complete, con «cosa devi vedere» e «se non va» a ogni passo: **[CHECKLIST-WINDOWS.md](CHECKLIST-WINDOWS.md)** · **[CHECKLIST-MAC.md](CHECKLIST-MAC.md)**.

## Collega a Claude

**Con Claude Code.** `parlez setup` ha stampato un comando che inizia con `claude mcp add`: copialo e incollalo nel terminale. In forma corta è questo:

```bash
claude mcp add parlez -e AE_MCP_PULL_ONLY=1 -- parlez
```

Per controllare: `claude mcp list` deve mostrare `parlez` con «Connected».

**Con Claude Desktop.** `parlez setup` stampa anche un blocco di testo da incollare nel file di configurazione di Claude Desktop (Impostazioni → Sviluppatore → Modifica configurazione), e ti dice dove. Poi chiudi del tutto Claude Desktop e riaprilo.

Prima richiesta di prova, con After Effects aperto e il pannello su ON:

> Con Parlez!, dimmi la versione di After Effects.

## Il pannello ON/OFF

In After Effects, **Finestra → Parlez!** apre un pannello con un grande interruttore.

- **OFF (rosso):** Claude è fermo e ogni sua richiesta viene rifiutata. Alla prima apertura il pannello parte su OFF.
- **ON verde:** Claude può lavorare ed è in attesa. **Giallo:** sta lavorando. **Grigio:** lo script di avvio non risponde (di solito c'è una finestra di dialogo aperta in After Effects).
- **Sola lettura:** Claude può guardare il progetto, ma non modificarlo.
- **Ripristino:** fa un punto di ripristino del progetto con un clic.

## Cosa vede Claude

Quello che Claude legge dal progetto (nomi di composizioni e livelli, testi, percorsi dei file, fotogrammi) arriva al servizio Claude che usi. Per lavori sotto NDA o con materiali di clienti non ancora pubblici, controlla prima le regole del tuo piano Claude.

## Se qualcosa non va

1. **Claude va in timeout?** Controlla in ordine: After Effects è aperto? Il pannello è su ON? La casella degli script è accesa (e la finestra Preferenze chiusa con OK)? C'è una finestra di dialogo aperta, magari nascosta dietro la finestra principale? Poi lancia `parlez doctor`.
2. **Dopo un aggiornamento di After Effects o di Parlez!** lancia di nuovo `parlez setup`.
3. **Ancora niente?** Scrivici all'indirizzo **anthonyfesce@anotherperspectivepictures.com** con le risposte a queste sei domande (togli prima i nomi dei clienti e i percorsi riservati):

```text
1. Computer e versioni: Windows o Mac (versione), After Effects (Aiuto → Informazioni
   su After Effects: numero completo, es. 26.5.1) e in che lingua, Node
   (node --version), Claude Code o Claude Desktop.
2. L'installazione è andata? Incolla il risultato di: parlez doctor
   (e a che passo della guida ti sei fermato, se ti sei fermato).
3. Cosa hai chiesto a Claude, con le parole esatte, e su che tipo di progetto.
4. Cosa è successo e cosa ti aspettavi (risultato sbagliato, lentezza, errore
   copiato, finestra di dialogo comparsa). Uno screenshot aiuta.
5. Il pannello Parlez! che stato mostrava (ON verde, giallo, grigio, OFF)? Un
   Ctrl+Z (Cmd+Z sul Mac) ha annullato tutta la richiesta? Claude ha chiesto
   conferma prima di cancellare? Si è perso o rovinato qualcosa?
6. Quanto ti è stato utile, da 1 a 5, e cosa ti è mancato di più.
```

Anche «funziona tutto» è un'informazione utile: scrivicelo.

## Disinstallare

Nell'ordine: `parlez uninstall-panel`, `parlez uninstall-agent`, poi `claude mcp remove parlez --scope user` (se usi Claude Code; con Claude Desktop togli il blocco `"parlez"` dal file di configurazione), infine `npm uninstall -g parlez`. I passi con i dettagli sono in fondo alle guide.

## Crediti e marchi

Parlez! nasce dal lavoro di altri, pubblicato con licenza MIT. Li ringraziamo.

- **[mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects)** di kumo.productions, Inc. — Copyright (c) 2026 kumo.productions, Inc. (licenza MIT). Parlez! è un fork di questo progetto: il motore che parla con After Effects viene da qui.
- Altre idee e parti di codice MIT arrivano da **After-Effects-mcp-pro** (Mohammad Malkawi) e **after-effects-mcp** (Ishant Kohar). Le loro note di copyright e i testi completi delle licenze sono dentro il pacchetto, nel file `THIRD_PARTY_NOTICES.md`.

**Parlez! per Adobe® After Effects®.** Adobe e After Effects sono marchi di Adobe Inc. Parlez! è un progetto indipendente, non affiliato ad Adobe, né approvato o sponsorizzato da Adobe.

## Licenza

**Gratuito.** Il pacchetto include componenti con licenza MIT, con le loro note di copyright. Il codice sorgente di Parlez! non è pubblicato in questa fase.

© 2026 Another Perspective Pictures, Milano.

---

<a id="english"></a>

# Parlez! for Adobe® After Effects® — Beta download

[Italiano](#parlez-per-adobe-after-effects--scarica-la-beta) · **English**

**Parlez!** lets **Claude work inside After Effects**. Tell Claude what you want in plain words ("animate this title with a soft bounce", "check this comp for problems"). Claude does it in the open project while you watch.

- **Free.** Preview release (beta 0.1.0).
- **You stay in control.** Before anything is deleted or overwritten, Claude has to ask you.
- **Restore points.** Before risky work, a dated copy of the project can be saved.
- **One undo.** Each Claude request is undone with a single Ctrl+Z (Cmd+Z on Mac).
- **ON/OFF switch** in the "Parlez!" panel inside After Effects: when it is OFF, Claude is stopped. **No internet:** Parlez! only talks to After Effects, on your own computer.

> [!IMPORTANT]
> **Beta status, plainly.**
> - **Tested:** Windows 10 with After Effects 2026 (26.5).
> - **Written to work, but not tested yet:** macOS, After Effects 2024 and After Effects 2025.
> - **Not working yet:** background rendering (aerender) started by the program.
>
> Use it on **a copy** of a project, never on a client's real work.

## Requirements

- **After Effects 2024, 2025 or 2026**, on Windows or macOS
- **Node.js 24 or newer** ([nodejs.org](https://nodejs.org), LTS). Check with `node --version`.
- **Claude Code or Claude Desktop**

The terminal is **PowerShell** on Windows (search the Start menu) and **Terminal** on Mac.

## Download

**[⬇ Download Parlez! beta (zip file)](https://github.com/AnotherPerspective/Parlez/releases/latest/download/Parlez-beta.zip)**

The zip holds the package `parlez-0.1.0.tgz`, the two step-by-step guides (Windows and Mac, in Italian) and a `LEGGIMI.txt` file.

**Checking the file (optional).** To make sure the file was not changed on the way, compare its fingerprint with this one:

```text
8687b74d67b123ff33d9f1b222fbe1e2a44543907e8c2b14a7965db189f44042
```

- Windows (PowerShell): `certutil -hashfile parlez-0.1.0.tgz SHA256`
- Mac (Terminal): `shasum -a 256 parlez-0.1.0.tgz`

## Install in three steps

**1. Unzip.** Open a terminal **inside the unzipped folder**, the one that holds `parlez-0.1.0.tgz`.

**2. Install the package.**

```bash
npm install -g ./parlez-0.1.0.tgz
```

Internet is needed **only now**, to download two libraries. After that Parlez! never connects to the internet.

**3. Set up After Effects.**

```bash
parlez setup --lang en
```

It finds After Effects and installs the **startup script** (a small agent that stays inside After Effects and receives Claude's requests) and the **Parlez! panel**, only in your user's folders. At the end it prints the command that connects Claude.

Then:

- **turn on one checkbox by hand in After Effects** (no program can do it for you): **Edit → Preferences → Scripting & Expressions → "Allow Scripts to Write Files and Access Network"** → OK. On Mac: **After Effects → Settings → Scripting & Expressions**;
- **restart After Effects**;
- open **Window → Parlez!** and switch it **ON**;
- check everything: `parlez doctor --lang en`. It **changes nothing**. No "TO DO" line means you are ready.

The detailed step-by-step guides are in Italian: [CHECKLIST-WINDOWS.md](CHECKLIST-WINDOWS.md) · [CHECKLIST-MAC.md](CHECKLIST-MAC.md).

## Connect to Claude

**Claude Code:** paste the `claude mcp add …` line that `parlez setup` printed. Short form:

```bash
claude mcp add parlez -e AE_MCP_PULL_ONLY=1 -- parlez
```

**Claude Desktop:** `parlez setup` also prints a block to paste into Claude Desktop's configuration file (Settings → Developer → Edit Config) and tells you where. Then quit Claude Desktop completely and reopen it.

First test, with After Effects open and the panel ON: "Using Parlez!, tell me the After Effects version."

## What Claude sees

What Claude reads from the project (names of comps and layers, text, file paths, frames) goes to the Claude service you use. For NDA work or unreleased client material, check your Claude plan's data terms first.

## If something goes wrong

Timeouts: is After Effects open, the panel ON, the scripting checkbox on (and the Preferences window closed with OK), and no dialog open (sometimes hidden behind the main window)? Then run `parlez doctor`. After an After Effects or Parlez! update, run `parlez setup` again.

Still stuck? Write to **anthonyfesce@anotherperspectivepictures.com** with answers to the six questions above (remove client names and private paths): computer and versions; did the install work (paste `parlez doctor`); what you asked Claude; what happened vs. what you expected; panel state, undo and confirmation behaviour; usefulness from 1 to 5. "Everything works" is useful to know too.

## Credits and trademarks

Parlez! builds on work by others, released under the MIT License. Thank you.

- **[mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects)** by kumo.productions, Inc. — Copyright (c) 2026 kumo.productions, Inc. (MIT License). Parlez! is a fork of this project: the engine that talks to After Effects comes from here.
- Further ideas and MIT-licensed code come from **After-Effects-mcp-pro** (Mohammad Malkawi) and **after-effects-mcp** (Ishant Kohar). Their copyright notices and the full license texts are inside the package, in `THIRD_PARTY_NOTICES.md`.

**"Parlez! for Adobe® After Effects®".** Adobe and After Effects are trademarks of Adobe Inc. Parlez! is an independent project, not affiliated with, endorsed by or sponsored by Adobe.

## License

**Free of charge.** The package includes MIT-licensed components, with their notices. Parlez!'s own source code is not published at this stage.

© 2026 Another Perspective Pictures, Milan.
