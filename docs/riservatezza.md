# Modalità riservata

25/10/2026.

## A cosa serve

Quando Claude lavora in After Effects, ogni risposta del programma (nomi delle composizioni, testi dei livelli, percorsi dei file…) arriva al servizio Claude. Con i materiali dei clienti questo può essere troppo: un percorso come `C:/Clienti/Rossi Spa/2026/spot.aep` dice già per chi stai lavorando.

La **modalità riservata** è un filtro che si mette in mezzo: prima che una risposta parta verso Claude, toglie o nasconde le informazioni che non servono a Claude per lavorare. Tutto avviene sul tuo computer. È **spenta di serie**: se non la accendi, non cambia nulla, nemmeno una virgola.

## Cosa fa, in pratica

| Cosa                              | Senza filtro                                     | Con la modalità riservata                                                                                        |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Percorsi dei file**             | `C:/Clienti/Rossi Spa/2026/spot.aep`             | `spot.aep` (solo il nome del file, le cartelle spariscono). Vale anche per i percorsi dentro i messaggi d'errore |
| **Parole che vuoi nascondere**    | `Rossi_Main`, «per Rossi»                        | `[CLIENTE-1]_Main`, «per [CLIENTE-1]»: ogni parola della tua lista diventa un'etichetta, sempre la stessa        |
| **Testi del progetto**            | il testo dei livelli, le espressioni, i commenti | `{ redatto: true, lunghezza: 42 }`: Claude sa che c'è un testo e quanto è lungo, ma non lo legge                 |
| **Finestre di dialogo**           | il testo dell'avviso e il titolo della finestra  | nascosti                                                                                                         |
| **Immagini** (quando arriveranno) | il fotogramma                                    | non spedito: resta sul disco, a Claude arriva solo il nome del file                                              |

**Le etichette funzionano anche al ritorno.** Se Claude scrive `[CLIENTE-1]_Main` per indicare una composizione, il programma rimette la parola vera prima di eseguire, quindi la composizione viene trovata. Lo stesso vale per un testo che Claude scrive in un livello: «Scopri [PRODOTTO-1]» diventa «Scopri Modello X» dentro After Effects. Anche quando Claude rimanda indietro un testo nascosto così com'era (per esempio per riattivare le espressioni che aveva spento), il programma rimette il testo vero.

**Testi nascosti di serie**: testo dei livelli (anche riga per riga), espressioni, commenti degli elementi e dei marker, metadati XMP, voci dei menu a tendina e la voce scelta.

**Tre cose che in modalità riservata non si possono fare:**

- esportare tutto il progetto **dentro la risposta**: l'esportazione JSON funziona solo scrivendo un file sul disco (Claude riceve solo nome e dimensione);
- leggere i **metadati XMP** del progetto (contengono autori e cronologia);
- usare `eval.run` (codice libero), che resta spento anche se è stato acceso.

## Come si accende

Si accende con le **variabili d'ambiente**, nello stesso punto dove si configurano le altre opzioni del programma. Le decidi tu dal file di configurazione: **Claude non le può cambiare** con le sue richieste.

| Variabile                     | Valore                            | Effetto                                                                           |
| ----------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `AE_MCP_PRIVACY`              | `1`                               | accende la modalità riservata (qualsiasi altro valore la lascia spenta)           |
| `AE_MCP_PRIVACY_WORDS`        | percorso di un file di testo      | la lista delle parole da nascondere (facoltativa)                                 |
| `AE_MCP_PRIVACY_ALLOW_FIELDS` | nomi di campi separati da virgole | rimostra a Claude alcuni testi nascosti, per esempio `text,comment` (facoltativa) |

Esempio per Claude Desktop (file `claude_desktop_config.json`, nella parte del server di Parlez!):

```json
"env": {
  "AE_MCP_PRIVACY": "1",
  "AE_MCP_PRIVACY_WORDS": "C:\\Users\\<tuo nome>\\Documenti\\parlez-parole.txt"
}
```

Dopo ogni modifica bisogna **riavviare Claude** (il programma legge le impostazioni e la lista all'avvio).

### La lista delle parole

Un file di testo normale, **fuori dal repository**, una parola o frase per riga:

```text
# Clienti
Rossi
Rossi Spa
# Prodotti non ancora annunciati
[PRODOTTO] Modello X
```

- Maiuscole e minuscole non contano: `Rossi`, `ROSSI` e `rossi` diventano tutti `[CLIENTE-1]`.
- Le righe che iniziano con `#` sono note per te e vengono ignorate.
- Di serie l'etichetta è `[CLIENTE-n]`. Con `[PRODOTTO]` davanti diventa `[PRODOTTO-n]` (puoi usare la parola che vuoi tra parentesi quadre).
- Le etichette seguono l'ordine del file: non riordinare le righe a metà lavoro, altrimenti `[CLIENTE-1]` e `[CLIENTE-2]` si scambiano alla sessione dopo.
- La parola viene nascosta anche quando è un pezzo di un'altra: con `Rossi` nella lista, anche «Rossini» diventa «[CLIENTE-1]ni». Meglio nascondere troppo che troppo poco.

**Se il file non si può leggere** (nome sbagliato, file spostato), il programma **blocca tutte le richieste** e lo dice. È voluto: meglio fermarsi che lasciar passare i nomi credendo che siano nascosti.

### Rimostrare un testo

Se in un lavoro ti serve che Claude legga, per esempio, i testi dei livelli, aggiungi `AE_MCP_PRIVACY_ALLOW_FIELDS=text` e riavvia. I nomi possibili sono: `text`, `expression`, `expr`, `comment`, `xmp`, `valueText`, `items`, `propertyParameters`. Anche i testi rimostrati passano comunque dal filtro di percorsi e parole. Il testo delle finestre di dialogo resta sempre nascosto.

## Come capire se è accesa

- Nel registro del programma, la riga `policy:` termina con `privacy=ON (words=…, …)`.
- `ae_catalog` lo riporta nel campo `policy`.
- `ae_context` aggiunge un blocco `privacy` che spiega a Claude come funzionano etichette e testi nascosti.

## Cosa NON può fare

- **I fotogrammi mostrano comunque il contenuto.** Un PNG con il logo e la frase del cliente li mostra, qualunque filtro ci sia sui testi. L'opzione può solo **non mandare** le immagini; non può oscurarne il contenuto.
- **I file su disco restano leggibili.** I PNG renderizzati e il JSON esportato restano dove li ha scritti Claude. Claude Code ha i suoi strumenti per leggere i file del computer, che non passano da questo filtro.
- **Una lista di parole ferma solo le parole che contiene.** Un nome scritto in un modo nuovo, un'abbreviazione, un claim riformulato passano. Il filtro non sa cosa copre un NDA: riconosce solo le parole che gli dai.
- **I nomi che non sono nella lista escono.** Nomi di composizioni, livelli, effetti, font e cartelle del progetto arrivano a Claude come prima, salvo le parole della lista.
- **La struttura resta**: numero di livelli, effetti usati, durate, dimensioni, tempi dei keyframe, colori. Non sono segreti di per sé, ma raccontano il lavoro.
- **Non copre quello che scrivi tu in chat**, né quello che Claude ha già letto prima che tu accendessi l'opzione.
- **Non cambia il regime del servizio Claude.** Quello che Claude riceve è trattato secondo il piano che usi. L'opzione riduce cosa esce; per i lavori sotto NDA con materiali non pubblici resta la regola del piano Team o API.

**Qualche scomodità da sapere:**

- Claude vede solo il nome dei file: se deve riaprire un file o sostituire un footage, il percorso completo glielo devi dare tu.
- Claude non legge i testi nascosti: può scriverne di nuovi, ma non correggere un refuso in un testo che non vede (per quello rimostra `text` con `AE_MCP_PRIVACY_ALLOW_FIELDS`).
- Se nel progetto c'è scritto davvero qualcosa come `[CLIENTE-1]`, il programma lo tradurrebbe nella parola vera quando Claude lo rimanda indietro.
