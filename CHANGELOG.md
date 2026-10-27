# Changelog

Tutte le modifiche importanti di Parlez! per Adobe® After Effects® sono scritte qui.

Il formato segue [Keep a Changelog](https://keepachangelog.com/it-IT/1.1.0/) e i numeri di versione seguono il [Semantic Versioning](https://semver.org/lang/it/). La storia di mcp-aftereffects di kumo.productions, da cui Parlez! deriva, è in [`docs/CHANGELOG-kumo.md`](docs/CHANGELOG-kumo.md).

## [Unreleased]

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
- **Collegamento solo tramite lo script di avvio** (`AE_MCP_PULL_ONLY=1`, nome provvisorio): per i computer dove il collegamento diretto `AfterFX.exe -r` non consegna i comandi, come il PC su cui Parlez! è stato provato.

### Cambiato

- Il pacchetto si chiama `parlez` e il comando `parlez`; il vecchio comando `mcp-aftereffects` resta come secondo nome.
- **Quando lo script di avvio è installato, il server usa solo quello** e non prova più `AfterFX.exe -r`, a meno che `AE_MCP_PULL_ONLY=0` lo chieda. Chi non installa lo script di avvio ha lo stesso comportamento di kumo.
- Il server si presenta ai programmi di Claude con il nome `parlez`.

### Corretto

- L'agente non parte più dentro il motore di render (aerender) e il server ignora le istanze che non hanno mai lavorato davvero.
- Un agente che smette di rispondere per qualche secondo (After Effects occupato) viene aspettato invece di passare al collegamento diretto.
- Le guide create su After Effects 26.5 hanno di nuovo l'orientamento giusto.
- La lettura dei metadati XMP del progetto è più robusta e dice che tipo di valore riceve.

[0.1.0]: https://github.com/anthonyfesce/parlez/releases/tag/v0.1.0
