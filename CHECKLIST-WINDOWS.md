# Parlez! su Windows — guida passo per passo

Grazie per la prova! Parlez! fa lavorare Claude dentro After Effects. Su Windows 10 con After Effects 2026 (26.5) funziona: è la combinazione provata. **After Effects 2024 e 2025 sono scritti per funzionare ma non ancora provati**: se li usi, sei tra i primi. Questa guida ti porta passo per passo. Ogni passo dice:

- **Comando**: cosa scrivere in PowerShell (copialo e incollalo così com'è, poi premi Invio);
- **Cosa devi vedere** se va tutto bene;
- **Se non va**: cosa copiare e mandarci. Fermati lì e scrivici: non serve andare avanti a tentativi.

Ci vogliono circa 20–30 minuti.

## Prima di cominciare

- Ti serve: un PC con **Windows 10 o 11**, **After Effects 2024, 2025 o 2026** già aperto almeno una volta, **Claude Code** oppure **Claude Desktop**, e lo **zip scaricato dal sito** (dentro c'è `parlez-0.1.0.tgz`).
- Lavora su una **copia** di un progetto, mai sul lavoro di un cliente.
- **PowerShell** si apre dal menu Start: scrivi «PowerShell» e premi Invio. Ogni comando qui sotto va incollato lì (clic destro incolla).
- Quando un percorso contiene spazi o `!` (per esempio `Parlez!.jsx`) è scritto tra virgolette `"…"`: lasciale, servono.
- Non serve essere amministratore del PC.

---

## 1. Installare Node.js 24

Vai su [nodejs.org](https://nodejs.org), scarica la versione **LTS** per Windows (il file `.msi`, versione 24) e installala come un normale programma: Avanti, Avanti, Installa. Poi **chiudi e riapri PowerShell**.

**Comando**

```powershell
node --version
```

**Cosa devi vedere**: `v24.` seguito da altri numeri (per esempio `v24.11.0`).

**Se non va**: manda quello che PowerShell ha scritto. Se avevi già installato Node con altri strumenti (nvm, Chocolatey, Scoop), dillo e manda anche il risultato di `Get-Command node | Format-List Source`.

Se PowerShell dice che l'esecuzione di script è disabilitata quando lanci `npm` o `parlez`, manda il messaggio: non cambiare impostazioni di sicurezza a tentativi.

## 2. Scompattare lo zip e controllare il file (facoltativo ma consigliato)

Fai clic destro sullo zip → **Estrai tutto…**, e scegli una cartella tua (per esempio dentro Download). Poi apri PowerShell **in quella cartella** (nella cartella, clic destro su uno spazio vuoto → «Apri nel Terminale»; oppure dal menu Start, e poi `cd` con il percorso).

Per controllare che il file non sia stato cambiato:

**Comando**

```powershell
certutil -hashfile parlez-0.1.0.tgz SHA256
```

**Cosa devi vedere**: una lunga sequenza di lettere e numeri. Deve essere **uguale** a quella scritta nel `README.md` del sito di download (sezione «Scarica»).

**Se non va**: se è diversa, non andare avanti e scrivici.

## 3. Installare Parlez!

Con PowerShell aperto nella cartella dove c'è `parlez-0.1.0.tgz`:

**Comandi**

```powershell
npm install -g ./parlez-0.1.0.tgz
```

```powershell
npm list -g parlez
```

**Cosa devi vedere**: dopo il primo comando qualcosa come `added 90 packages` (il numero può cambiare). Può comparire un avviso con `lefthook` o `install-scripts`: è innocuo. Il secondo comando deve mostrare una riga con `parlez@0.1.0`.

Serve internet **solo adesso**, per scaricare due librerie. Dopo, Parlez! non si collega più a internet.

**Se non va**: manda tutto quello che PowerShell ha scritto. In particolare `EACCES` o `permission denied`, oppure `parlez non è riconosciuto come cmdlet` (di solito basta chiudere e riaprire PowerShell; se resta, manda il risultato di `npm prefix -g`).

## 4. Preparare After Effects: `parlez setup`

**Chiudi After Effects** (File → Esci). Poi:

**Comando**

```powershell
parlez setup
```

Se hai una sola versione di After Effects, non devi indicare niente. Se vuoi scegliere tu la versione: `parlez setup --version 26.5` (cambia il numero con quello della tua cartella).

**Cosa devi vedere**, più o meno:

- `NOTA    After Effects 2026 trovato (cartella delle preferenze 26.5)` (anno e numero possono essere diversi);
- `OK      installato lo script di avvio: C:\Users\<tu>\AppData\Roaming\Adobe\After Effects\26.5\Scripts\Startup\mcp-aftereffects-agent.jsx`;
- `OK      installato il pannello: C:\Users\<tu>\AppData\Roaming\Adobe\After Effects\26.5\Scripts\ScriptUI Panels\Parlez!.jsx`;
- una parte «Collegare Parlez! a Claude» con un comando che inizia con `claude mcp add` e un blocco tra parentesi graffe `{ … }`. **Tienili**: servono al passo 8;
- in fondo il «Controllo finale». È normale che ci sia ancora qualche riga `DA FARE` (la casella degli script, After Effects non acceso): le sistemiamo nei prossimi passi.

Se hai più versioni di After Effects, ti chiede `Installo Parlez! in tutti? [s/N]`: scrivi `s` e premi Invio.

**Se non va**: manda **tutto** quello che `parlez setup` ha scritto, dalla prima all'ultima riga. In particolare se dice `Non ho trovato After Effects` oppure `Apri After Effects … una volta` (vuol dire che After Effects non ha ancora creato la sua cartella: aprilo, chiudilo e rilancia).

Nota: `parlez setup` scrive solo dentro `%APPDATA%\Adobe\After Effects\<versione>\Scripts\…`, cioè nelle cartelle del tuo utente. Non tocca il registro di Windows e non serve essere amministratore.

## 5. Accendere la casella degli script in After Effects

Questo è l'unico passo che nessun programma può fare al posto tuo.

Apri After Effects. Nel menu **Modifica → Preferenze → Script ed espressioni** (in inglese: **Edit → Preferences → Scripting & Expressions**) spunta **«Consenti agli script di scrivere file e accedere alla rete»** (_Allow Scripts to Write Files and Access Network_). Premi **OK**: **chiudi la finestra Preferenze**, perché finché è aperta nessuno script può girare.

Poi **chiudi After Effects** (File → Esci) e **riaprilo**: così carica lo script di avvio e il pannello.

**Cosa devi vedere**: After Effects si apre normalmente, **senza finestre di errore** all'avvio.

**Se non va**: se all'avvio compare una finestra di errore o di avviso, fai uno screenshot (tasto Windows + Maiusc + S) e mandalo. Scrivi anche il nome esatto del menu dove hai trovato la casella, se è diverso da quello scritto qui. Se non trovi «Script ed espressioni», cerca la stessa sezione per posizione, dentro le Preferenze.

**Se After Effects mostra «We detected a crash»** (modalità provvisoria) all'avvio, succede dopo una chiusura forzata: scegli di avviare normalmente e prosegui.

## 6. Controllo: `parlez doctor`

Con After Effects **aperto** (e magari con un progetto aperto), aspetta una decina di secondi, poi in PowerShell:

**Comando**

```powershell
parlez doctor
```

**Cosa devi vedere**:

- `OK      Node.js 24…`
- `OK      After Effects 26.5: script di avvio installato e aggiornato`
- `OK      After Effects 26.5: pannello Parlez! installato e aggiornato`
- `OK      After Effects 26.5: la casella «Consenti agli script di scrivere file e accedere alla rete» è accesa`
- `OK      After Effects acceso con l'agente: …`
- `NOTA    … il pannello è su OFF …` (è normale: lo accendi al passo 7).

**Se non va**: manda tutto quello che `parlez doctor` ha scritto. Le righe più importanti per noi:

- `la casella … è spenta` → torna al passo 5. Con la casella spenta After Effects riceve le richieste ma non risponde: Claude vedrebbe solo un timeout senza spiegazione;
- `nessun After Effects acceso con l'agente` anche con After Effects aperto da più di 30 secondi → manda il risultato di:

  ```powershell
  parlez instances
  ```

  e, se esiste, il contenuto di questo file (vedi anche «Dove sono i log»):

  ```powershell
  Get-Content "$env:TEMP\mcp-aftereffects\agent-fatal.log"
  ```

## 7. Il pannello Parlez!

In After Effects apri il menu **Finestra**: in fondo deve esserci **Parlez!**. Cliccalo.

**Cosa devi vedere**: un pannello con un grande bottone **OFF** (rosso). Premilo: deve diventare **ON** e il riquadro verde. Prova anche a trascinare il pannello e agganciarlo vicino agli altri.

**Se non va**:

- se **Parlez!** non c'è nel menu Finestra (dopo aver riavviato After Effects), manda il risultato di:

  ```powershell
  Get-ChildItem "$env:APPDATA\Adobe\After Effects\*\Scripts\ScriptUI Panels"
  ```

- se c'è ma si vede male (scritte tagliate, colori strani), manda uno screenshot (Windows + Maiusc + S).

## 8. Collegare Parlez! a Claude

Usa **quello che `parlez setup` ha stampato al passo 4** (se l'hai perso, rilancia `parlez setup`: non rifà niente e lo ristampa).

**Con Claude Code**: incolla in PowerShell il comando che inizia con `claude mcp add`. In forma corta è questo:

```powershell
claude mcp add parlez -e AE_MCP_PULL_ONLY=1 -- parlez
```

Se il comando stampato da `parlez setup` è diverso (per esempio ha dei percorsi tra virgolette), usa quello: è lui quello giusto per il tuo PC. Poi:

```powershell
claude mcp list
```

**Cosa devi vedere**: una riga `parlez: … - ✓ Connected` (o simile).

**Con Claude Desktop**: apri Claude → Impostazioni → Sviluppatore → **Modifica configurazione**. Si apre il file `claude_desktop_config.json`. Se è vuoto, incolla il blocco così com'è; se c'è già un `"mcpServers"`, aggiungi solo la parte `"parlez": { … }` dentro. Salva, **chiudi del tutto Claude Desktop** (clic destro sull'icona vicino all'orologio → Esci, non solo la X della finestra) e riaprilo.

**Cosa devi vedere**: in Claude Desktop, nella lista degli strumenti (icona dei connettori), compare **parlez**.

**Se non va**: manda il comando o il blocco che hai incollato e il messaggio di errore. Con Claude Desktop manda anche il file di log: `%APPDATA%\Claude\logs\mcp-server-parlez.log` (vedi «Dove sono i log»).

## 9. Prima richiesta

Con After Effects aperto e il pannello su **ON** (verde), scrivi a Claude:

> Con Parlez!, dimmi la versione di After Effects.

**Cosa devi vedere**: Claude risponde con un numero tipo `26.5`. Nel pannello compare la richiesta nell'elenco «ultime richieste».

Su Windows **non devi** dare nessun permesso di sistema (non esiste l'«Automazione» del Mac). Se Windows mostra una finestra di Sicurezza o del firewall, **scrivila nel rapporto**: Parlez! non dovrebbe mai chiederla.

**Se non va**: copia la risposta esatta di Claude (anche se è un errore lungo). Prima controlla, in ordine: After Effects è aperto? Il pannello è su ON? La casella degli script è accesa e la finestra Preferenze è chiusa? C'è una finestra di dialogo aperta in After Effects, magari **nascosta dietro la finestra principale** (guarda la barra delle applicazioni, prova Alt+Tab)? Un progetto con file o font mancanti apre spesso una finestra così. Poi manda il risultato di `parlez doctor`.

## 10. Un fotogramma

Apri una **copia** di un progetto con almeno una composizione e aprila nel pannello Composizione. Scrivi a Claude:

> Con Parlez!, mostrami il fotogramma a 1 secondo della composizione attiva.

**Cosa devi vedere**: l'immagine del fotogramma dentro la chat di Claude.

**Se non va**: risposta esatta di Claude, e uno screenshot di After Effects in quel momento (c'era una finestra di dialogo aperta?).

## 11. Un punto di ripristino

Salva il progetto (Ctrl+S). Poi, dal pannello Parlez!, premi **Ripristino**: deve dire «Ripristino creato: …». Poi premi **Elenco**: si apre la cartella `_parlez-checkpoints`, accanto al tuo progetto, con dentro una copia `.aep`.

Poi chiedi a Claude:

> Con Parlez!, elenca i checkpoint di questo progetto.

**Cosa devi vedere**: Claude elenca il punto di ripristino appena creato.

**Se non va**: il messaggio del pannello o di Claude, e il percorso del progetto (puoi togliere i nomi dei clienti).

## 12. Un Ctrl+Z e una conferma

Chiedi a Claude una piccola modifica sulla copia di prova, per esempio:

> Con Parlez!, crea un livello solido rosso in questa composizione.

Poi premi **Ctrl+Z** una volta sola in After Effects.

**Cosa devi vedere**: il livello compare, e con un solo Ctrl+Z sparisce tutto quello che Claude ha fatto in quella richiesta.

Poi chiedigli di cancellare quel livello (se l'hai già annullato, rifallo prima):

> Con Parlez!, cancella quel livello.

**Cosa devi vedere**: Claude **ti chiede il permesso** prima di cancellare.

**Se non va**: se Ctrl+Z non annulla tutto, o se Claude cancella senza chiedere, **scrivilo nel rapporto**: è una delle promesse di sicurezza che vogliamo controllare.

## 13. Disinstallare tutto

Nell'ordine (prima i comandi di Parlez!, poi la rimozione del programma):

```powershell
parlez uninstall-panel
```

```powershell
parlez uninstall-agent
```

Con Claude Code:

```powershell
claude mcp remove parlez --scope user
```

Con Claude Desktop: apri di nuovo **Modifica configurazione** e togli il blocco `"parlez": { … }`, poi riavvia Claude Desktop.

Infine:

```powershell
npm uninstall -g parlez
```

**Cosa devi vedere**: `removed …` per il pannello e lo script di avvio; `removed 1 package` (o simile) per l'ultimo.

Rimangono, e puoi toglierli a mano da Esplora file (incolla il percorso nella barra degli indirizzi) se vuoi:

- lo storico delle richieste: `%APPDATA%\Parlez`;
- le copie di ripristino accanto ai tuoi progetti: cartelle `_parlez-checkpoints`;
- la cassetta nella cartella temporanea `%TEMP%\mcp-aftereffects`: Windows la ripulisce con le pulizie normali.

---

## Dove sono i log

Quando qualcosa non va, questi file aiutano molto. Per aprire la cartella della cassetta in Esplora file:

```powershell
explorer "$env:TEMP\mcp-aftereffects"
```

Dentro trovi:

| File                                      | Cosa dice                                               | C'è sempre?                     |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| `agent-fatal.log`                         | Lo script di avvio non è riuscito a partire, e perché   | Solo se c'è stato quel problema |
| `runtime\instances\<nome>\agent.log`      | Cosa ha fatto lo script di avvio in quell'After Effects | Sì, dopo la prima richiesta     |
| `runtime\instances\<nome>\heartbeat.json` | Lo stato attuale (acceso, in pausa, ultime richieste)   | Sì, con After Effects aperto    |

Altri due posti:

- **Claude Desktop**: `%APPDATA%\Claude\logs\mcp-server-parlez.log`. Ci interessano le righe che iniziano con `[mcp-aftereffects]`.
- **Storico delle richieste** (lo stesso del bottone **Storico** del pannello): `%APPDATA%\Parlez\storico\`.

Per metterli tutti insieme in un file `parlez-log.zip` sul Desktop:

```powershell
Compress-Archive -Path "$env:TEMP\mcp-aftereffects","$env:APPDATA\Claude\logs\mcp-server-parlez.log","$env:APPDATA\Parlez\storico" -DestinationPath "$HOME\Desktop\parlez-log.zip" -Force
```

(Se uno dei file o delle cartelle non esiste, PowerShell lo dice: togli quel pezzo dal comando e rilancialo. Se il Desktop è dentro OneDrive, cambia `$HOME\Desktop` con il percorso del tuo Desktop.) Questi file contengono **i nomi dei progetti e delle composizioni** su cui hai lavorato, mai il contenuto del progetto: controlla che non ci siano nomi di clienti prima di mandarli.

## Modulo di segnalazione

Copialo in una email a **anthonyfesce@anotherperspectivepictures.com** e rispondi sotto ogni domanda.

```text
1. Computer e versioni: Windows (versione: Win+R, scrivi winver), After Effects (Aiuto →
   Informazioni su After Effects: numero completo, es. 26.5.1) e in che lingua, Node
   (node --version), Claude Code o Claude Desktop.
2. L'installazione è andata? Incolla il risultato di: parlez doctor
   (e a che passo di questa guida ti sei fermato, se ti sei fermato).
3. Cosa hai chiesto a Claude, con le parole esatte, e su che tipo di progetto.
4. Cosa è successo e cosa ti aspettavi (risultato sbagliato, lentezza, errore copiato,
   finestra di dialogo comparsa). Windows ti ha mostrato avvisi di sicurezza o del
   firewall? Uno screenshot aiuta.
5. Il pannello Parlez! era nel menu Finestra? Che stato mostrava (ON verde, giallo,
   grigio, OFF)? Un Ctrl+Z ha annullato tutta la richiesta? Claude ha chiesto conferma
   prima di cancellare? Si è perso o rovinato qualcosa?
6. Quanto ti è stato utile, da 1 a 5, e cosa ti è mancato di più.
(Prima di inviare togli nomi di clienti e percorsi riservati. Allega parlez-log.zip se puoi.)
```
