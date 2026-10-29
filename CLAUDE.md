# CLAUDE.md — Regole per chi lavora sul codice di Parlez!

Parlez! _(nome provvisorio)_ è un server MCP gratuito e open source (licenza MIT) che fa lavorare Claude dentro Adobe® After Effects® 2024–2026, su Windows e Mac. Il motore è un fork di `kumoproductions/mcp-aftereffects`.
Il proprietario è Anthony (Another Perspective Pictures SRL). Queste regole valgono per ogni sessione, sottosessione e agente che tocca questo repository.

## 1. Come parlare con Anthony

- Scrivi **in italiano semplice**: frasi corte, niente gergo. Se una parola tecnica serve, spiegala la prima volta.
- Prima spiega **cosa stai costruendo e a cosa serve**, poi i dettagli.
- Quando serve una scelta, fai una domanda vera e dai una raccomandazione. Non fare elenchi di opzioni senza dire quale preferisci.
- Il rapporto finale dice tre cose: cosa hai fatto, cosa hai verificato, **cosa non hai verificato**.

## 2. Regole fisse del progetto

1. **Leggi prima di usare.** Prima di installare o usare codice di terzi, leggilo e di' cosa tocca sul computer (file, registro di Windows, cartelle di sistema, rete).
2. **Niente a pagamento.** Non usare servizi che costano e non fare nulla che possa spendere crediti da solo.
3. **Niente internet.** Il programma non si collega mai a internet: non aggiungere chiamate http, fetch, socket o DNS. Nemmeno per font, musica o aggiornamenti. Se un giorno servisse, sarà un modulo separato, spento di default, con un solo interruttore: lo decide Anthony.
4. **Mai rinominare senza chiedere.** Livelli, composizioni, file e metadati non si rinominano senza il permesso di Anthony.
5. **Mai cancellare senza conferma.** Vale per il codice che scrivi (le operazioni che cancellano o sostituiscono devono chiedere `confirm: true`) e per il tuo lavoro sul disco.
6. **Gli originali dei clienti si leggono soltanto.** Non modificarli, non spostarli, non copiarli nel repository.
7. **I nomi li decide Anthony.** Nomi di funzioni, moduli, cartelle, sezioni, etichette e del pacchetto: usa quelli del brief e scrivi «(nome provvisorio)» dove ne serve uno che non c'è. Non inventarne di nuovi.
8. **Niente controllo del computer.** Non guidare il mouse o la tastiera di Anthony. Se devi vedere After Effects, chiedi uno screenshot.
9. **Niente GitHub senza ok.** Nessun push, nessuna pull request, nessuna pubblicazione (nemmeno su npm) senza l'ok esplicito di Anthony. Il lavoro resta in una cartella locale.
10. **Clean room.** Dai prodotti chiusi (prodotti chiusi) si riprendono solo idee descritte pubblicamente, **mai codice**. Il codice MIT degli altri progetti si può riusare **mantenendo le loro note di copyright** (vedi `THIRD_PARTY_NOTICES.md`).
11. **Marchi Adobe.** Il nome del progetto non contiene mai «Adobe», «After Effects» né «AE». Forma corretta: «Parlez! per Adobe® After Effects®».
12. **Mai addestrare modelli** su progetti o render di After Effects.

## 3. Regole per le sottosessioni

1. **Solo i file della tua attività.** Lavora nella tua cartella o branch, non toccare altro e non fare commit sulla linea principale: Fable integra dopo la revisione.
2. **Prima i test, poi il codice.** Scrivi i test offline (quelli che girano senza After Effects), poi il codice. Nel rapporto dì quali test hai fatto girare e con che risultato.
3. **Niente After Effects, niente installazioni.** Non collegarti ad After Effects e non installare nulla (nemmeno `npm install`) se il brief non lo autorizza. I test E2E li lancia Anthony, o Fable con il suo ok.
4. **Nomi provvisori.** Usa i nomi del brief e segnala dove serve un nome definitivo.
5. **Rapporto in italiano semplice**, come al punto 1.
6. **Niente `archivio-privato/`.** Non leggere e non modificare quella cartella, e non metterci niente.
7. Niente GitHub e niente internet (come al §2).

## 4. Decisioni già prese da Anthony (25/10/2026)

- **Licenza MIT.**
- **After Effects dal 2024.** Il 2023 è fuori dal piano. Le funzioni più recenti si controllano al momento («esiste?»), mai dal numero di versione.
- **Pannello «Parlez!»** (ScriptUI, `jsx/panel.jsx`, installato da `install-panel`): interruttore ON/OFF, sola lettura, storico. Deciso il 26/10/2026, sostituisce la scelta «nessun pannello» del 25/10. Niente CEP, niente UXP, niente modalità debug. Il collegamento veloce resta l'agente di avvio (`install-agent`); senza pannello Claude è fermo (regola unica della pausa).
- **Il programma non si collega mai a internet.**
- **Si prova solo su After Effects 2026 / Windows.** Mac, 2024 e 2025 sono «scritti per funzionare, non ancora provati»: non dichiararli provati.
- **Prima lo strumento, poi l'archivio stilistico** (M1–M7, poi M8).
- **Restano aperti, non decidere tu:** Node 22 o 24 (dopo la prova M1.4), i nomi dei moduli (dopo M1), il modello locale per i video, il piano Claude per i clienti.
- **Nel codice usa i nomi di kumo** (così le loro modifiche si possono ancora ricevere); nomi italiani solo in documenti e skill.

## 5. Vincoli tecnici ereditati da kumo

**ExtendScript (tutto ciò che gira dentro After Effects)** — vale per i file in `jsx/` **e** per le stringhe di codice generate in TypeScript. Il linguaggio è ES3, un JavaScript molto vecchio:

- Solo `var`. Vietati `let`, `const`, funzioni freccia (`=>`), classi, destrutturazione, template string con apici inversi.
- Scrivi `function() {}`, cicli `for` classici, stringhe unite con `+`.
- Niente `map`, `filter`, `forEach`, `indexOf` sugli array, né `includes`, `startsWith`, `Object.keys`: usa cicli `for`.
- Niente virgole finali, niente ternari concatenati.
- **Mai** scrivere `"errore: " + e` né `String(e)` su un errore: in ExtendScript fa fallire proprio il messaggio. Usa `AE.errText(e)`.
- Per testare se una chiave dinamica esiste in un oggetto, controlla il tipo atteso o usa `hasOwnProperty`, non la «verità» del valore.
- **Ogni valore che arriva dagli argomenti e finisce nel codice generato passa da `jsxVal(...)`**, mai incollato a mano. Altrimenti si aggira la sola lettura.
- **Ogni chiamata è un solo gruppo di annullamento**: un Ctrl/Cmd+Z annulla tutto. Non aprire gruppi di annullamento a mano. Le operazioni di annulla/ripeti stanno fuori dal gruppo.
- Il codice generato è il corpo di una funzione e termina con `return { ok: true, ... };` (o `{ ok: false, error: "..." }` per i fallimenti previsti).

**Sicurezza lato Node.** La policy (`src/policy.ts`) vive solo lato Node e non va aggirata:

- `AE_MCP_READONLY=1` toglie gli strumenti di scrittura; `AE_MCP_ALLOW_CATEGORIES` limita le categorie; `eval.run` (codice libero) esiste solo con `AE_MCP_ENABLE_EVAL=1` e mai in sola lettura.
- Le modifiche alle preferenze di After Effects richiedono `confirm: true`.
- La «cassetta» (cartella temporanea dove Node e After Effects si scambiano i file) è per utente, con permessi 0700. Non spostarla in cartelle condivise o sincronizzate (OneDrive, Dropbox).
- Il codice nel repository non deve contenere dati di clienti, percorsi personali o file degli SDK Adobe.

**Comandi che devono restare verdi** (da lanciare dopo aver avuto il permesso di installare):

```
npm run check
npm test
```

`npm test` è sicuro: i test offline girano senza After Effects, quelli E2E si saltano da soli. Non aggiungere nulla che li rompa.

**Test E2E (su After Effects vero).** Solo con ok esplicito di Anthony, mai mentre in After Effects c'è lavoro vero aperto. I livelli si accendono con `AE_MCP_E2E=1`; `AE_MCP_E2E_MULTI=1` e `AE_MCP_E2E_DESTRUCTIVE=1` sono ancora più delicati (il secondo chiude processi di After Effects). Non lanciarli da solo.

**Stile.** TypeScript rigoroso (import con estensione `.js`), 2 spazi, fine riga LF. I commenti dicono il _perché_, non il _cosa_.

## 6. Prima di dire «fatto»

- `npm run check` e `npm test` verdi (o dì chiaramente che non li hai potuti lanciare).
- Nessun file toccato fuori dalla tua attività.
- Le note di copyright dei file riusati sono a posto.
- Il rapporto corrisponde a quello che hai davvero cambiato.

<!--
**Fonti di queste informazioni:** `the plan` §1 (regole fisse) e §2.3–2.4 (marchi, addestramento, licenza); `the planning notes` §0, §4 (regole delle sottosessioni), §8–§9 (decisioni, rischi), §1.1 (policy, cassetta, test di kumo); `mcp-aftereffects/CONTRIBUTING.md` (regole ES3, `jsxVal`, gruppo di annullamento, livelli di test, comandi, stile); `mcp-aftereffects/tests/helpers/lint-jsx.ts` (elenco delle costruzioni vietate).
-->
