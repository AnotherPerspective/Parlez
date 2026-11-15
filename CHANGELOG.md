# Changelog

Tutte le modifiche importanti di Parlez! per Adobe® After Effects® sono scritte qui.

Il formato segue [Keep a Changelog](https://keepachangelog.com/it-IT/1.1.0/) e i numeri di versione seguono il [Semantic Versioning](https://semver.org/lang/it/). La storia di mcp-aftereffects di kumo.productions, da cui Parlez! deriva, è in [`docs/CHANGELOG-kumo.md`](docs/CHANGELOG-kumo.md).

## [0.2.0] - 2026-11-15

Il salto da 0.1 a 0.2 è voluto: questa versione cambia il modo in cui Parlez! resta vivo dentro After Effects. La 0.1.1 funziona; la 0.1.2 (solo locale, con Premiere Pro) ha lo stesso codice After Effects e con buona probabilità funzionava anche lei, ma non è stato verificato.

### Corretto

- **Parlez! non si blocca più all'apertura dei progetti pesanti, e niente più popup d'errore.** Su After Effects 26.5 / Windows un timer di script (`app.scheduleTask`) che scade mentre è aperta una finestra modale (caricamento di un progetto, schermata Home all'avvio, Apri, Importa, Salva con nome) fa comparire l'errore «Cannot run a script while a modal dialog is waiting for response» e After Effects butta via tutti i timer di script della sessione: agente e pannello si fermavano fino al riavvio di After Effects. Il blocco «seguiva il progetto» solo perché i progetti pesanti si caricano per qualche secondo. Ora:
  - **la sveglia** (nome provvisorio): una piccola estensione CEP invisibile, senza finestre, dà il ritmo all'agente da fuori, quattro volte al secondo, e solo quando la finestra di After Effects è libera da finestre modali. Dentro After Effects non resta prenotato nessun timer, quindi nessuno può scadere sotto una finestra modale. `parlez setup` la installa nella cartella CEP dell'utente; serve la stessa impostazione di CEP (`PlayerDebugMode`) del pannello di Premiere;
  - senza la sveglia (per esempio sul Mac, non ancora provato) l'agente usa la sua catena di passi, con agente e pannello che si fanno da guardia a vicenda; se After Effects li ferma tutti e due, il primo clic nel pannello li fa ripartire;
  - ogni ripartenza dopo un silenzio lungo compare tra le ultime richieste del pannello e nello storico, con la causa probabile («dopo apertura progetto», «dopo una finestra di dialogo»);
  - bottone **Riavvia** nel pannello, sempre visibile, come ultima risorsa: ricarica anche il codice di Parlez!, quindi dopo un aggiornamento fatto con After Effects aperto basta un clic. Dopo il clic il pannello mostra una barra con i secondi che mancano (al massimo 10) e poi dice sempre com'è finita: «Parlez! è ripartito» oppure «non è ripartito: chiudi e riapri After Effects». Se il server nuovo trova un After Effects (o un Premiere) con il codice vecchio, lo dice in italiano e spiega cosa fare, invece di dare un errore tecnico: «premi Riavvia» solo se il pannello aperto sa ricaricare il codice, altrimenti «chiudi e riapri After Effects».
  - il pannello non si ferma più per sempre se un aggiornamento dà errore mentre After Effects è occupato (per esempio mentre carica un progetto): dice cosa non va e riprende da solo.
- **Premiere Pro**: se una risposta di Premiere al pannello va persa, il giro del pannello riparte da solo invece di fermarsi; se lo script di Parlez! sparisce da Premiere, il pannello lo ricarica da solo.

### Cambiato

- **Pannello di Premiere Pro come quello di After Effects**: bottoni larghi quanto il riquadro ON/OFF («Annulla» sopra, poi due righe da due), con in più **Ripristino** (salva il progetto e ne fa una copia in `_parlez-checkpoints`), **Elenco** (la cartella dei punti di ripristino) e **Storico** (lo storico delle richieste, ora scritto anche per Premiere in `%APPDATA%\Parlez\storico`); firma piccola come in After Effects.
- **After Effects: ogni tempo su un fotogramma intero, e in timecode.** Ogni tempo che Parlez! scrive in una composizione (keyframe, anche di ricette, copie, spostamenti e cascate; inizio, ingresso e uscita dei livelli; taglio; marker; area di lavoro; testina; intervallo di render) cade sempre su un fotogramma intero della composizione, anche quando arriva in secondi: niente più keyframe a metà tra due fotogrammi. Ogni tempo si può dare come timecode della composizione `HH:MM:SS:FF`, contato dal suo timecode iniziale. `ae_comp_info`, `ae_layer_info` e `comp.sample` riportano timecode e fotogramma accanto ai secondi. Nuova regola di `comp.audit`: **fuori-fotogramma**, segnala keyframe e tempi dei livelli tra due fotogrammi e dice come rimetterli a posto.
- **Premiere Pro lavora in timecode.** Ogni tempo degli strumenti `pr_*` (posizioni, inizio e fine, spostamenti, pezzo di sorgente, lametta, fotogramma, marker, transizioni, titoli, sottotitoli) accetta il timecode della sequenza `HH:MM:SS:FF` (`;` prima dei fotogrammi in drop-frame), contato dal timecode iniziale della sequenza come in timeline. Il timecode diventa numero di fotogramma e poi ticks, senza passare dai secondi; le risposte riportano timecode e fotogramma accanto ai secondi. I numeri in secondi restano accettati e finiscono sui fotogrammi della sequenza.
- **Test**: i test che parlano con un After Effects vero partono solo con `AE_MCP_E2E=1`, anche quelli di sola lettura; prima `npm test` li mandava all'After Effects aperto, anche mentre qualcuno ci lavorava.
- **Pannello di After Effects più stretto**: bottoni su tre righe da due, riquadro ON/OFF piccolo anche nella vista verticale; il pannello scende fino a circa 224 pixel di larghezza. Angoli del riquadro arrotondati come il contorno blu che After Effects disegna dopo un clic.

## [0.1.2] - 2026-11-13

### Aggiunto

- **Parlez! per Adobe® Premiere Pro®** (prima versione, provata solo su Premiere Pro 2026 / Windows). Lo stesso programma `parlez` fa lavorare Claude anche dentro Premiere, con le stesse regole di After Effects: interruttore ON/OFF, «Sola lettura», conferma prima di cancellare o sovrascrivere, niente rete.
  - **Pannello Parlez!** per Premiere (Finestra › Estensioni (versione precedente) › Parlez!), con lo stesso aspetto di quello di After Effects. È anche il collegamento: se il pannello è chiuso o su OFF, Claude è fermo. `parlez setup` lo installa nella cartella CEP dell'utente, senza permessi da amministratore; `parlez doctor` lo controlla. Nuovi comandi: `install-premiere-panel`, `uninstall-premiere-panel`, `premiere-status`.
  - **26 strumenti `pr_*`**: leggere progetto e sequenze (`pr_context`, `pr_project_info`, `pr_sequence_info`), controllare il progetto (`pr_project_check`), vedere un fotogramma (`pr_frame`), importare file e composizioni di After Effects (`pr_import`), marker (`pr_markers`), bin (`pr_bins`), nomi ed etichette (`pr_rename_items`), creare, duplicare e aprire sequenze (`pr_sequence_create`, `pr_sequence_duplicate`, `pr_sequence_open`), clip in timeline, anche solo un pezzo (`pr_timeline_add`), rifilare e spostare (`pr_clip_edit`), togliere (`pr_clip_remove`), lametta (`pr_razor`), transizioni (`pr_transition`), volume (`pr_audio_level`), tracce mute, bloccate o di destinazione (`pr_tracks`), titoli .mogrt (`pr_mogrt_add`), sottotitoli da un file .srt (`pr_captions`), copia riformattata 9:16, 1:1 o 4:5 (`pr_auto_reframe`), esportazione (`pr_export`), XML, AAF e OMF per altri programmi (`pr_export_interchange`), salvataggio su richiesta (`pr_save_project`).
  - **Annulla di Parlez!**: in Premiere Ctrl+Z non annulla le modifiche fatte da script, quindi ogni modifica registra come si disfa; `pr_undo_last`, o il bottone «Annulla» del pannello, disfa tutta l'ultima richiesta. Prima di ogni modifica il progetto salvato viene copiato in `_parlez-checkpoints`, accanto al progetto.

### Cambiato

- After Effects funziona come prima: il suo collegamento e i suoi strumenti non sono cambiati.

## [0.1.1] - 2026-11-11

### Aggiunto

- **Avvertenze** (`AVVERTENZE.md`, bozza da far leggere a un legale): in italiano e in inglese dicono che Parlez! è gratuito, sperimentale e open source (MIT), fornito così com'è e usato a proprio rischio, e dove vanno i dati letti dai progetti. Entrano nel pacchetto npm. Integrano la licenza MIT, non la sostituiscono.
- **Accettazione in `parlez setup`**: la prima volta, prima di installare qualsiasi cosa, `setup` mostra un riassunto delle avvertenze e chiede di scrivere `accetto` (`I accept` con `--lang en`). Con qualsiasi altra risposta, o senza un terminale, si ferma senza installare. Data, ora e versione dell'accettazione restano in `avvertenze-accettate.json` nella cartella dei dati di Parlez! (`%APPDATA%\Parlez`, sul Mac `~/Library/Application Support/Parlez`), e non viene più chiesta finché il file c'è. `--accept` accetta senza domanda, per chi installa da uno script; `--dry-run` non chiede e non scrive. `parlez doctor` mostra se e quando le avvertenze sono state accettate.

### Cambiato

- **Codice pubblico.** Il codice sorgente è pubblico su [github.com/AnotherPerspective/Parlez](https://github.com/AnotherPerspective/Parlez) (licenza MIT); lo zip della beta si scarica da [AnotherPerspective/Parlez-download](https://github.com/AnotherPerspective/Parlez-download). Tutti i link nel pacchetto, nel README e nel registro MCP puntano lì.
- README e avvertenze mettono l'inglese prima e l'italiano dopo.

### Corretto

- **Metadati XMP del progetto**: `project.get_xmp` restituisce di nuovo il testo XMP intero, invece di una lista di valori vuoti.
- **Fotogrammi nei progetti a 32 bit senza gestione colore**: i fotogrammi che Claude vede (`ae_render_frame`, `render.frame` e i controlli delle ricette) non escono più dieci volte più scuri. 8 e 16 bit non cambiano.

## [0.1.0] - 2026-10-26

Prima versione di Parlez!. Parte da mcp-aftereffects 0.3.2 di kumo.productions (licenza MIT) e aggiunge quello che segue. Provata solo su After Effects 2026 (26.5) / Windows 10; Mac, After Effects 2024 e 2025 sono scritti per funzionare ma non ancora provati.

### Aggiunto

- **Installazione in un comando**: `parlez setup` trova After Effects, installa lo script di avvio e il pannello, controlla la casella «Consenti agli script di scrivere file e accedere alla rete» e stampa la configurazione per Claude Code e Claude Desktop. `parlez doctor` controlla tutto senza cambiare niente. Messaggi in italiano, o in inglese con `--lang en`.
- **Pannello «Parlez!» dentro After Effects** (Finestra → Parlez!): un grande interruttore ON/OFF per fermare Claude, la modalità «sola lettura» (Claude guarda ma non modifica) e lo storico delle ultime richieste, anche su file. Si installa con `parlez setup` o `parlez install-panel`. Con nessuna scelta salvata Claude parte **fermo**.
- **Conferme**: le operazioni che cancellano, sovrascrivono o rinominano si fermano, spiegano in italiano cosa farebbero e partono solo con `confirm: true`. I comandi di menu pericolosi sono vietati anche con la conferma.
- **Punti di ripristino** (`checkpoint.create`, `checkpoint.list`, `checkpoint.restore`, `checkpoint.delete`): una copia datata del file `.aep` prima di un lavoro rischioso, per poter tornare indietro.
- **Modalità riservata** (spenta di serie): prima che una risposta parta verso Claude toglie le cartelle dai percorsi, sostituisce i nomi di una lista con etichette come `[CLIENTE-1]` e può nascondere testi e immagini.
- **Fotogrammi dentro la chat**: `ae_render_frame` restituisce l'immagine nella risposta, così Claude la vede subito; in più la «striscia della linea del tempo» (durata, keyframe, quanto si muove l'immagine).
- **Controlli automatici** (`comp.audit`): segnala in italiano errori, avvisi e note di una composizione, con il modo di correggerli.
- **Misure** (`reference.measure`, `frame.compare`, `comp.audit_motion`): misura un'immagine di riferimento, confronta un fotogramma con la reference zona per zona (ΔE) e dice quali livelli si muovono davvero.
- **Aiuti di animazione**: 41 curve con nome (`keyframe.list_eases`, `keyframe.apply_ease`), sfalsamento dei livelli (`layer.stagger`) e 22 modelli di espressione (`expression.list_templates`, `expression.apply_template`).
- **Render in sottofondo con aerender** (`aerender.info`, `aerender.start`, `aerender.status`, `aerender.cancel`): After Effects resta libero mentre il render va avanti. Scritto e provato offline, non ancora riuscito da Parlez! su un After Effects vero.
- **Ricette** (`recipe.list`, `recipe.plan`, `recipe.run`): un pezzo grafico descritto in un file di dati diventa una sola chiamata, annullabile con un solo Ctrl+Z. Due ricette incluse: un lower third e un titolo in dissolvenza.
- **Collegamento solo tramite lo script di avvio** (`AE_MCP_PULL_ONLY=1`): per i computer dove il collegamento diretto `AfterFX.exe -r` non consegna i comandi, come il PC su cui Parlez! è stato provato.

### Cambiato

- Il pacchetto si chiama `parlez` e il comando `parlez`; il vecchio comando `mcp-aftereffects` resta come secondo nome.
- **Quando lo script di avvio è installato, il server usa solo quello** e non prova più `AfterFX.exe -r`, a meno che `AE_MCP_PULL_ONLY=0` lo chieda. Chi non installa lo script di avvio ha lo stesso comportamento di kumo.
- Il server si presenta ai programmi di Claude con il nome `parlez`.

### Corretto

- L'agente non parte più dentro il motore di render (aerender) e il server ignora le istanze che non hanno mai lavorato davvero.
- Un agente che smette di rispondere per qualche secondo (After Effects occupato) viene aspettato invece di passare al collegamento diretto.
- Le guide create su After Effects 26.5 hanno di nuovo l'orientamento giusto.
- La lettura dei metadati XMP del progetto è più robusta e dice che tipo di valore riceve.

[0.2.0]: https://github.com/AnotherPerspective/Parlez-download/releases/tag/v0.2.0-beta
[0.1.2]: https://github.com/AnotherPerspective/Parlez-download/releases/tag/v0.1.2-beta
[0.1.1]: https://github.com/AnotherPerspective/Parlez-download/releases/tag/v0.1.1-beta
[0.1.0]: https://github.com/AnotherPerspective/Parlez-download/releases/tag/v0.1.0-beta
