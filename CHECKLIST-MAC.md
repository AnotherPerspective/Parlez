# Parlez! sul Mac — guida passo per passo

Grazie per la prova! Parlez! fa lavorare Claude dentro After Effects. Su Windows funziona; **sul Mac non l'abbiamo ancora provato**: sei tra i primi. Questa guida ti porta passo per passo. Ogni passo dice:

- **Comando**: cosa scrivere nel Terminale (copialo e incollalo così com'è, poi premi Invio);
- **Cosa devi vedere** se va tutto bene;
- **Se non va**: cosa copiare e mandarci (all'indirizzo **anthonyfesce@anotherperspectivepictures.com**). Fermati lì e scrivici: non serve andare avanti a tentativi.

Ci vogliono circa 30–40 minuti.

## Prima di cominciare

- Ti serve: un Mac con **After Effects 2024, 2025 o 2026** già aperto almeno una volta, **Claude Code** oppure **Claude Desktop**, e lo **zip scaricato dal sito** (dentro c'è il file `parlez-0.1.0.tgz`). Scompatta lo zip con doppio clic: ottieni una cartella con dentro `parlez-0.1.0.tgz`. In questa guida si suppone che sia in **Download**; se l'hai messo altrove, cambia i percorsi.
- Lavora su una **copia** di un progetto, mai sul lavoro di un cliente.
- Il **Terminale** è in Applicazioni → Utility → Terminale. Ogni comando qui sotto va incollato lì.
- Quando un percorso contiene spazi o `!` (per esempio `Parlez!.jsx`) è scritto tra apici singoli `'…'`: lasciali, servono.

---

## 1. Installare Node.js 24

Vai su [nodejs.org](https://nodejs.org), scarica la versione **LTS** per macOS (il file `.pkg`, versione 24) e installala come un normale programma. Poi chiudi e riapri il Terminale.

**Comando**

```bash
node --version
```

**Cosa devi vedere**: `v24.` seguito da altri numeri (per esempio `v24.11.0`).

**Se non va**: manda quello che il Terminale ha scritto. Se avevi già installato Node con Homebrew o nvm, dillo (e manda anche il risultato di `which node`).

## 2. Preparare una cartella tua per i programmi di npm

Con il Node ufficiale, installare programmi «per tutto il computer» chiede la password di amministratore e spesso fallisce con `EACCES`. Questi comandi fanno usare a npm una cartella tua, così non serve la password. Incollali uno alla volta.

**Comandi**

```bash
mkdir -p ~/.npm-global
```

```bash
npm config set prefix ~/.npm-global
```

```bash
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zprofile
```

```bash
source ~/.zprofile
```

**Cosa devi vedere**: niente. Nessun messaggio vuol dire che è andato bene.

**Se non va**: manda il messaggio di errore.

## 3. Controllare il file scaricato (facoltativo ma consigliato)

**Comando**

```bash
shasum -a 256 ~/Downloads/parlez-0.1.0.tgz
```

**Cosa devi vedere**: una lunga sequenza di lettere e numeri. Deve essere **uguale** a quella scritta nel `README.md` della pagina di download (sezione «Scarica»).

**Se non va**: se è diversa, non andare avanti e scrivici.

## 4. Installare Parlez!

**Comandi**

```bash
cd ~/Downloads
```

```bash
npm install -g ./parlez-0.1.0.tgz
```

```bash
which parlez
```

**Cosa devi vedere**: dopo il secondo comando qualcosa come `added 90 packages` (il numero può cambiare). Può comparire un avviso con `lefthook` o `install-scripts`: è innocuo. Il terzo comando deve rispondere con un percorso che finisce in `/.npm-global/bin/parlez`.

Serve internet **solo adesso**, per scaricare due librerie. Dopo, Parlez! non si collega più a internet.

**Se non va**: manda tutto quello che il Terminale ha scritto. In particolare `EACCES` o `permission denied` (vuol dire che il passo 2 non ha funzionato) oppure `command not found: parlez`.

## 5. Preparare After Effects: `parlez setup`

**Chiudi After Effects** (After Effects → Esci, oppure Cmd+Q). Poi:

**Comando**

```bash
parlez setup
```

**Cosa devi vedere**, più o meno:

- `NOTA    After Effects 2026 trovato (cartella delle preferenze 26.5)` (anno e numero possono essere diversi);
- `OK      installato lo script di avvio: /Users/<tu>/Library/Preferences/Adobe/After Effects/26.5/Scripts/Startup/mcp-aftereffects-agent.jsx`;
- `OK      installato il pannello: /Users/<tu>/Library/Preferences/Adobe/After Effects/26.5/Scripts/ScriptUI Panels/Parlez!.jsx`;
- una parte «Collegare Parlez! a Claude» con un comando che inizia con `claude mcp add` e un blocco tra parentesi graffe `{ … }`. **Tienili**: servono al passo 9;
- in fondo il «Controllo finale». È normale che ci sia ancora qualche riga `DA FARE` (la casella degli script, After Effects non acceso): le sistemiamo nei prossimi passi.

Se hai più versioni di After Effects, ti chiede `Installo Parlez! in tutti? [s/N]`: scrivi `s` e premi Invio.

**Se non va**: manda **tutto** quello che `parlez setup` ha scritto, dalla prima all'ultima riga. In particolare se dice `Non ho trovato After Effects` oppure `Apri After Effects … una volta`.

## 6. Accendere la casella degli script in After Effects

Apri After Effects. Nel menu **After Effects → Impostazioni → Script ed espressioni** (in inglese: **After Effects → Settings → Scripting & Expressions**; nelle versioni più vecchie «Preferenze» invece di «Impostazioni») spunta **«Consenti agli script di scrivere file e accedere alla rete»** (_Allow Scripts to Write Files and Access Network_). Premi **OK**.

Poi **chiudi After Effects** (Cmd+Q) e **riaprilo**: così carica lo script di avvio e il pannello.

**Cosa devi vedere**: After Effects si apre normalmente, **senza finestre di errore** all'avvio.

**Se non va**: se all'avvio compare una finestra di errore o di avviso, fai uno screenshot (Cmd+Maiusc+4) e mandalo. Scrivi anche il nome esatto del menu dove hai trovato la casella, se è diverso da quello scritto qui.

## 7. Controllo: `parlez doctor`

Con After Effects **aperto**, aspetta una decina di secondi, poi:

**Comando**

```bash
parlez doctor
```

**Cosa devi vedere**:

- `OK      Node.js 24…`
- `OK      After Effects 26.5: script di avvio installato e aggiornato`
- `OK      After Effects 26.5: pannello Parlez! installato e aggiornato`
- `OK      After Effects 26.5: la casella «Consenti agli script di scrivere file e accedere alla rete» è accesa`
- `OK      After Effects acceso con l'agente: …`
- `NOTA    … il pannello è su OFF …` (è normale: lo accendi al passo 8)
- `NOTA    collegamento: lo script di avvio è installato, quindi il server userà solo quello … Così macOS non chiede il permesso di Automazione …`
- `NOTA    cassetta (…): /var/folders/…/mcp-aftereffects/runtime` — **copia questa riga**, serve per il rapporto.

**Se non va**: manda tutto quello che `parlez doctor` ha scritto. Le righe più importanti per noi:

- `non riesco a leggere la casella degli script` → manda anche il risultato di questo comando (elenca i file delle preferenze, non li apre):

  ```bash
  ls ~/Library/Preferences/Adobe/After\ Effects/*/
  ```

- `nessun After Effects acceso con l'agente` anche con After Effects aperto da più di 30 secondi → manda il risultato di:

  ```bash
  parlez instances
  ```

  e, se esiste, il contenuto di questo file (vedi anche «Dove sono i log»):

  ```bash
  cat "$TMPDIR/mcp-aftereffects/agent-fatal.log"
  ```

## 8. Il pannello Parlez!

In After Effects apri il menu **Finestra**: in fondo deve esserci **Parlez!**. Cliccalo.

**Cosa devi vedere**: un pannello con un riquadro colorato e il bottone **Accendi**. Premi **Accendi**: il riquadro deve diventare verde. Prova anche a trascinarlo e agganciarlo vicino agli altri pannelli.

**Se non va**:

- se **Parlez!** non c'è nel menu Finestra, dillo (è una delle cose che vogliamo scoprire) e manda il risultato di:

  ```bash
  ls -la ~/Library/Preferences/Adobe/After\ Effects/*/Scripts/ScriptUI\ Panels/
  ```

- se c'è ma si vede male (scritte tagliate, colori strani), manda uno screenshot (Cmd+Maiusc+4, poi spazio, poi clic sul pannello).

## 9. Collegare Parlez! a Claude

Usa **quello che `parlez setup` ha stampato al passo 5** (se l'hai perso, rilancia `parlez setup`: non rifà niente e lo ristampa).

**Con Claude Code**: incolla nel Terminale il comando che inizia con `claude mcp add --scope user parlez`. I percorsi sono tra apici singoli `'…'`: lasciali. Poi:

```bash
claude mcp list
```

**Cosa devi vedere**: una riga `parlez: … - ✓ Connected` (o simile).

**Con Claude Desktop**: apri Claude → Impostazioni → Sviluppatore → **Modifica configurazione**. Si apre il file `claude_desktop_config.json`. Se è vuoto, incolla il blocco così com'è; se c'è già un `"mcpServers"`, aggiungi solo la parte `"parlez": { … }` dentro. Salva, **chiudi del tutto Claude Desktop (Cmd+Q)** e riaprilo.

**Cosa devi vedere**: in Claude Desktop, nella lista degli strumenti (icona dei connettori), compare **parlez**.

**Se non va**: manda il comando o il blocco che hai incollato e il messaggio di errore. Con Claude Desktop manda anche il file di log: `~/Library/Logs/Claude/mcp-server-parlez.log` (vedi «Dove sono i log»).

## 10. Prima richiesta

Con After Effects aperto e il pannello su **ON** (verde), scrivi a Claude:

> Con Parlez!, dimmi la versione di After Effects.

**Cosa devi vedere**: Claude risponde con un numero tipo `26.5`. Nel pannello compare la richiesta nell'elenco «ultime richieste».

**Una cosa importante da notare**: macOS **non dovrebbe** mostrare nessuna finestra del tipo «"Claude" vuole controllare "Adobe After Effects"» (permesso di Automazione). Se compare, premi **Consenti/OK**, e **scrivilo nel rapporto**: vuol dire che Parlez! sta usando il collegamento diretto invece dello script di avvio.

**Se non va**: copia la risposta esatta di Claude (anche se è un errore lungo) e manda:

- con Claude Desktop, le righe che contengono `mcp-aftereffects` nel log `~/Library/Logs/Claude/mcp-server-parlez.log`. Ci interessa soprattutto la riga `[mcp-aftereffects] mailbox: …`: deve iniziare con `/var/folders/`, **non** con `/tmp/`;
- il risultato di `parlez doctor`.

## 11. Un fotogramma

Apri una **copia** di un progetto con almeno una composizione e aprila nel pannello Composizione. Scrivi a Claude:

> Con Parlez!, mostrami il fotogramma a 1 secondo della composizione attiva.

**Cosa devi vedere**: l'immagine del fotogramma dentro la chat di Claude.

**Se non va**: risposta esatta di Claude, e uno screenshot di After Effects in quel momento (c'era una finestra di dialogo aperta?).

## 12. Un checkpoint (punto di ripristino)

Salva il progetto (Cmd+S). Poi, dal pannello Parlez!, premi **Ripristino**: deve dire «Ripristino creato: …». Poi premi **Elenco**: si apre il Finder sulla cartella `_parlez-checkpoints`, accanto al tuo progetto, con dentro una copia `.aep`.

Poi chiedi a Claude:

> Con Parlez!, elenca i checkpoint di questo progetto.

**Cosa devi vedere**: Claude elenca il punto di ripristino appena creato.

**Se non va**: il messaggio del pannello o di Claude, e il percorso del progetto (puoi togliere i nomi dei clienti).

## 13. Permesso Accessibilità (facoltativo)

Serve solo a una cosa: permettere a Parlez! di **leggere e chiudere** le finestre di dialogo di After Effects che bloccano il lavoro (per esempio «File mancanti»). Senza, Parlez! funziona lo stesso, ma vede meno e non chiude niente.

Impostazioni di Sistema → **Privacy e sicurezza → Accessibilità** → attiva il programma da cui usi Claude (**Claude** per Claude Desktop, **Terminale** per Claude Code). Se non è nell'elenco, aggiungilo con il **+**.

Prova: in After Effects apri una finestra di dialogo che resta aperta (per esempio **File → Impostazioni progetto…**) e, senza chiuderla, chiedi a Claude la versione di After Effects.

**Cosa devi vedere**: dopo un po' (anche mezzo minuto) Claude dice che After Effects ha una finestra di dialogo aperta (e, con il permesso, che cosa c'è scritto).

**Se non va**: la risposta esatta di Claude e uno screenshot.

## 14. Il collegamento diretto (facoltativo, solo se hai tempo)

Serve a provare l'altro modo di collegarsi (osascript), quello che Parlez! usa quando lo script di avvio non c'è. Solo con Claude Code. Quando hai finito, torna come prima con il passo 15 o rilanciando `parlez setup`.

```bash
parlez uninstall-agent
```

Riavvia After Effects (Cmd+Q e riapri). Poi:

```bash
claude mcp remove parlez --scope user
```

Ora rilancia il comando `claude mcp add …` del passo 9, ma con `AE_MCP_PULL_ONLY=0` al posto di `AE_MCP_PULL_ONLY=1`. Chiedi di nuovo la versione di After Effects.

**Cosa devi vedere**: questa volta macOS chiede il permesso di **Automazione** («… vuole controllare "Adobe After Effects 2026"»): premi **Consenti**. Claude risponde con la versione.

**Se non va**: risposta esatta di Claude, e se hai visto o no la richiesta di Automazione. Puoi controllare in Impostazioni di Sistema → Privacy e sicurezza → **Automazione**.

## 15. Disinstallare tutto

Nell'ordine (prima i comandi di Parlez!, poi la rimozione del programma):

```bash
parlez uninstall-panel
```

```bash
parlez uninstall-agent
```

Con Claude Code:

```bash
claude mcp remove parlez --scope user
```

Con Claude Desktop: apri di nuovo **Modifica configurazione** e togli il blocco `"parlez": { … }`, poi riavvia Claude Desktop.

Infine:

```bash
npm uninstall -g parlez
```

**Cosa devi vedere**: `removed …` per il pannello e lo script di avvio; `removed 1 package` (o simile) per l'ultimo.

Rimangono, e puoi toglierli a mano dal Finder se vuoi (menu Vai → **Vai alla cartella…**, incolla il percorso):

- lo storico delle richieste: `~/Library/Application Support/Parlez`;
- le copie di ripristino accanto ai tuoi progetti: cartelle `_parlez-checkpoints`;
- la cassetta nella cartella temporanea: macOS la svuota da solo.

La riga aggiunta al passo 2 in `~/.zprofile` può restare: non dà fastidio.

---

## Dove sono i log

Quando qualcosa non va, questi file aiutano molto. Per aprire la cartella della cassetta nel Finder:

```bash
open "$TMPDIR/mcp-aftereffects"
```

Dentro trovi:

| File                                      | Cosa dice                                               | C'è sempre?                     |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| `agent-fatal.log`                         | Lo script di avvio non è riuscito a partire, e perché   | Solo se c'è stato quel problema |
| `runtime/instances/<nome>/agent.log`      | Cosa ha fatto lo script di avvio in quell'After Effects | Sì, dopo la prima richiesta     |
| `runtime/instances/<nome>/heartbeat.json` | Lo stato attuale (acceso, in pausa, ultime richieste)   | Sì, con After Effects aperto    |
| `runtime/dispatcher.log`                  | Il collegamento diretto (passo 14)                      | Solo se è stato usato           |

Altri due posti:

- **Claude Desktop**: `~/Library/Logs/Claude/mcp-server-parlez.log`. Aprilo con `open ~/Library/Logs/Claude/mcp-server-parlez.log`. Ci interessano le righe che iniziano con `[mcp-aftereffects]`.
- **Storico delle richieste** (lo stesso del bottone **Storico** del pannello): `~/Library/Application Support/Parlez/storico/`.

Per mandarli tutti insieme in un file `parlez-log.zip` sulla Scrivania:

```bash
cd ~/Desktop && zip -r parlez-log.zip "$TMPDIR/mcp-aftereffects" ~/Library/Logs/Claude/mcp-server-parlez.log "$HOME/Library/Application Support/Parlez/storico"
```

(Se uno dei file non esiste, `zip` lo dice e va avanti.) Questi file contengono **i nomi dei progetti e delle composizioni** su cui hai lavorato, mai il contenuto del progetto: controlla che non ci siano nomi di clienti prima di mandarli.

## Modulo di segnalazione

Copialo in una email a **anthonyfesce@anotherperspectivepictures.com** e rispondi sotto ogni domanda.

```text
1. Computer e versioni: modello del Mac e versione di macOS (menu Mela → Informazioni su
   questo Mac), After Effects (Aiuto → Informazioni su After Effects: numero completo, es.
   26.5.1) e in che lingua, Node (node --version), Claude Code o Claude Desktop.
2. L'installazione è andata? Incolla il risultato di: parlez doctor
   (e a che passo di questa guida ti sei fermato, se ti sei fermato).
3. Cosa hai chiesto a Claude, con le parole esatte, e su che tipo di progetto.
4. Cosa è successo e cosa ti aspettavi (risultato sbagliato, lentezza, errore copiato,
   finestra di dialogo comparsa). macOS ti ha chiesto permessi (Automazione,
   Accessibilità)? Quali e quando? Uno screenshot aiuta.
5. Il pannello Parlez! era nel menu Finestra? Che stato mostrava (ON verde, giallo, grigio,
   OFF)? Un Cmd+Z ha annullato tutta la richiesta? Claude ha chiesto conferma prima di
   cancellare? Si è perso o rovinato qualcosa?
6. Quanto ti è stato utile, da 1 a 5, e cosa ti è mancato di più.
(Prima di inviare togli nomi di clienti e percorsi riservati. Allega parlez-log.zip se puoi.)
```
