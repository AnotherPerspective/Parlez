// Parlez! - the switch inside After Effects.
//
// A ScriptUI panel: plain ExtendScript, no CEP, no extension. `install-panel`
// copies this file into the user-level Scripts/ScriptUI Panels folder as
// "Parlez!.jsx", and After Effects lists it under the Window menu by that
// name; it docks like any other panel. Run as an ordinary script (File >
// Scripts > Run Script File...) it opens as a floating window instead.
//
// What it shows:
//   - one big ON / OFF block, which is also the traffic light: green ON =
//     Claude may work and is waiting, yellow ON = a request is arriving or
//     running, red OFF = stopped, grey = the resident agent is not there or
//     not answering. One click switches Claude on or off;
//   - "Sola lettura": Claude may look at the project but not change it;
//   - the last requests, in plain Italian, with outcome and duration;
//   - quick buttons: undo Claude's last change, restore point now, restore
//     points folder, history file, mailbox; and the layout switch;
//   - small at the bottom: counters, instance id, agent version.
// Two layouts, switched with "Vista" and remembered: "verticale" for a side
// column, "compatta" (horizontal) to dock under the timeline. Short labels;
// the details are in the tooltips (helpTip).
//
// How it talks to the rest. The switches are app.settings entries in the
// "Parlez" section (claudeEnabled, readOnly; layout is the panel's own).
// Whether Claude may work is decided by ONE function, AE_MCP.isEnabled in
// jsx/serve.jsx, which the agent loads and exports on $.global: the panel
// calls it, and only when it is missing (no agent in this After Effects)
// uses its own copy of the same rule — only "1" means on. Everything else
// comes from the agent: $.global.AE_MCP_AGENT or, failing that, the
// heartbeat file it writes. The agent also calls AE_MCP_PANEL.onAgent()
// right before and after each request, because no scheduled refresh can run
// while a request does.
//
// Drawing. The ON/OFF block is a button drawn by onDraw (a filled rectangle
// and the word). Where custom drawing is not honoured, or throws, the button
// draws itself natively (drawOSControl) and still reads ON / OFF, inside a
// frame coloured with graphics.backgroundColor — so the colour shows either
// way.
//
// Self-contained on purpose: the file is copied, not loaded from the
// package, so it cannot #include anything. Section, keys and the restore
// point folder and naming are mirrored in src/config.ts and
// src/operations/checkpoint.ts (tests keep them in step).
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.
// Strings shown to the user use \u escapes for accented letters, so the file
// reads the same whatever encoding After Effects assumes for it.

(function aeMcpPanel(thisObj) {
    var SECTION = "Parlez";
    var KEY_ENABLED = "claudeEnabled";
    var KEY_READ_ONLY = "readOnly";
    var KEY_LAYOUT = "layout";
    var TITLE = "Parlez!";
    var REFRESH_MS = 1500;
    // The agent refreshes its heartbeat every second; the server presumes it
    // gone after five (HEARTBEAT_STALE_MS in src/config.ts).
    var STALE_MS = 5000;
    // First agent versions that know each switch (jsx/agent.jsx AGENT_VERSION).
    var PAUSE_AGENT_VERSION = 2;
    var READ_ONLY_AGENT_VERSION = 3;
    // Same folder and naming as checkpoint.create (src/operations/checkpoint.ts).
    var CHECKPOINT_SUBDIR = "_parlez-checkpoints";
    var CHECKPOINT_LABEL = "pannello";
    var CHECKPOINT_MAX_COPY = 999;
    // Edit > Undo.
    var UNDO_COMMAND = 16;
    var TITLE_CHARS = 30;

    var GREEN = [0.20, 0.72, 0.36];
    var RED = [0.86, 0.24, 0.20];
    var YELLOW = [0.95, 0.72, 0.12];
    var GREY = [0.42, 0.42, 0.42];
    var BG = [0.18, 0.18, 0.18];
    var SECTION_BG = [0.21, 0.21, 0.21];
    var LINE = [0.30, 0.30, 0.30];
    var TEXT = [0.86, 0.86, 0.86];
    var DIM = [0.55, 0.55, 0.55];

    // --- Switches -------------------------------------------------------
    function readSwitch(key) {
        try {
            if (!app.settings.haveSetting(SECTION, key)) return null;
            return String(app.settings.getSetting(SECTION, key));
        } catch (eRead) {
            return null;
        }
    }

    /** Save, then read back: true only when After Effects kept the value. */
    function writeSwitch(key, value) {
        try {
            app.settings.saveSetting(SECTION, key, value);
        } catch (eWrite) { /* told by the read-back */ }
        return readSwitch(key) === value;
    }

    /** The one rule (AE_MCP.isEnabled, jsx/serve.jsx); its copy when there is no agent. */
    function readEnabled() {
        try {
            var shared = $.global.AE_MCP;
            if (shared && typeof shared.isEnabled === "function") return shared.isEnabled() === true;
        } catch (eShared) { /* fall back to the copy */ }
        return readSwitch(KEY_ENABLED) === "1";
    }

    function readReadOnly() {
        return readSwitch(KEY_READ_ONLY) === "1";
    }

    function readLayout() {
        return (readSwitch(KEY_LAYOUT) === "compatta") ? "compatta" : "verticale";
    }

    // --- What the agent says --------------------------------------------
    function numberOr(value, fallback) {
        return (typeof value === "number") ? value : fallback;
    }

    function readHeartbeat(dir) {
        try {
            if (typeof JSON === "undefined" || typeof JSON.parse !== "function") return null;
            var f = new File(dir + "/heartbeat.json");
            if (!f.exists) return null;
            f.encoding = "UTF-8";
            if (!f.open("r")) return null;
            var raw = f.read();
            f.close();
            return JSON.parse(raw);
        } catch (eHb) {
            return null;
        }
    }

    /** Everything the panel shows about the agent, or null when there is none. */
    function readAgent() {
        var state = null;
        try {
            var agent = $.global.AE_MCP_AGENT;
            if (agent && agent.state) state = agent.state;
        } catch (eAgent) { /* no agent in this engine */ }
        if (state === null) return null;
        var dir = (typeof state.dir === "string") ? state.dir : null;
        var hb = (dir !== null) ? readHeartbeat(dir) : null;
        // Live memory first (same engine); the heartbeat file when a field
        // is missing there.
        function pick(name, fallback) {
            if (state[name] !== undefined && state[name] !== null) return state[name];
            if (hb !== null && hb[name] !== undefined && hb[name] !== null) return hb[name];
            return fallback;
        }
        var recent = pick("recent", []);
        return {
            id: String(state.id),
            version: numberOr(state.agentVersion, 1),
            dir: dir,
            served: numberOr(pick("served", 0), 0),
            refused: numberOr(pick("refused", 0), 0),
            busy: pick("busy", false) === true,
            pending: numberOr(pick("pending", 0), 0),
            lastRequestAt: numberOr(pick("lastRequestAt", null), 0),
            recent: (recent && typeof recent.length === "number") ? recent : [],
            historyPath: (typeof state.historyPath === "string") ? state.historyPath : null,
            // While a request runs the heartbeat is not refreshed, and that is fine.
            heartbeatAt: state.busy ? new Date().getTime() : numberOr(hb !== null ? hb.ts : state.lastHeartbeatAt, 0)
        };
    }

    // --- What to show ---------------------------------------------------
    function pad2(n) {
        return (n < 10 ? "0" : "") + String(n);
    }

    function clock(ms) {
        var d = new Date(ms);
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function seconds(ms) {
        if (typeof ms !== "number" || ms < 0) return "";
        if (ms < 10000) return (Math.round(ms / 100) / 10).toString().replace(".", ",") + " s";
        return String(Math.round(ms / 1000)) + " s";
    }

    function shorten(text, max) {
        var s = String(text);
        return (s.length > max) ? s.substring(0, max - 1) + "\u2026" : s;
    }

    /**
     * The block: { label, color, status, tip }. The switch decides first;
     * then whether the agent can be reached; then what it is doing.
     */
    function blockFor(enabled, readOnly, agent, now) {
        var ro = readOnly ? " \u00b7 sola lettura" : "";
        if (enabled !== true) {
            return { label: "OFF", color: RED, status: "Claude fermo",
                tip: "Claude non pu\u00f2 toccare After Effects: ogni sua richiesta viene rifiutata. Clic per accenderlo." };
        }
        if (agent === null) {
            return { label: "ON", color: GREY, status: "non collegato",
                tip: "Lo script di avvio non \u00e8 attivo in questo After Effects: Claude non riesce a collegarsi. " +
                    "Installalo (install-agent) e riavvia After Effects. Clic per spegnere Claude." };
        }
        if (agent.version < PAUSE_AGENT_VERSION) {
            return { label: "ON", color: GREY, status: "riavvia After Effects",
                tip: "Lo script di avvio caricato \u00e8 una versione vecchia che non conosce l'interruttore." };
        }
        if (agent.heartbeatAt === 0 || now - agent.heartbeatAt > STALE_MS) {
            return { label: "ON", color: GREY, status: "non risponde",
                tip: "Lo script di avvio \u00e8 caricato ma il battito non si aggiorna: una finestra di dialogo aperta? " +
                    "Clic per spegnere Claude." };
        }
        if (agent.busy) {
            return { label: "ON", color: YELLOW, status: "sta elaborando" + ro,
                tip: "Claude sta eseguendo una richiesta adesso. Clic per spegnerlo: la richiesta in corso finisce, le prossime vengono rifiutate." };
        }
        if (agent.pending > 0) {
            return { label: "ON", color: YELLOW, status: "sta ricevendo" + ro,
                tip: "Ci sono richieste di Claude in arrivo. Clic per spegnerlo." };
        }
        return { label: "ON", color: GREEN, status: "in attesa" + ro,
            tip: "Claude pu\u00f2 lavorare in After Effects" + (readOnly ? ", ma solo guardando: non modifica il progetto" : "") +
                ". Clic per spegnerlo." };
    }

    var OUTCOME_MARK = {
        ok: "\u2713",
        error: "\u2717",
        paused: "rifiutata (pausa)",
        readonly: "rifiutata (sola lettura)"
    };

    function undoneMarks() {
        try {
            if (!$.global.AE_MCP_PANEL_UNDONE) $.global.AE_MCP_PANEL_UNDONE = {};
            return $.global.AE_MCP_PANEL_UNDONE;
        } catch (eMarks) {
            return {};
        }
    }

    function entryKey(entry) {
        return String(entry.t) + "|" + String(entry.label);
    }

    function isUndone(entry) {
        var marks = undoneMarks();
        return marks.hasOwnProperty(entryKey(entry)) && marks[entryKey(entry)] === true;
    }

    /** Newest first, one line each: time, what, outcome, duration. */
    function historyLines(recent, rows) {
        var lines = [];
        for (var i = recent.length - 1; i >= 0 && lines.length < rows; i--) {
            var e = recent[i];
            if (!e || typeof e.t !== "number") continue;
            var what = (typeof e.title === "string") ? e.title : String(e.label);
            var mark = (typeof e.outcome === "string" && OUTCOME_MARK.hasOwnProperty(e.outcome))
                ? OUTCOME_MARK[e.outcome] : String(e.outcome);
            var tail = (e.outcome === "ok" || e.outcome === "error") ? "  " + seconds(e.ms) : "";
            if (isUndone(e)) {
                mark = "annullata";
                tail = "";
            }
            lines.push(clock(e.t).substring(0, 5) + "  " + shorten(what, TITLE_CHARS) + "  " + mark + tail);
        }
        return lines;
    }

    /** The newest change of Claude's that one Undo would revert, or null. */
    function undoTarget(recent) {
        for (var i = recent.length - 1; i >= 0; i--) {
            var e = recent[i];
            if (e && e.undoable === true && !isUndone(e)) return e;
        }
        return null;
    }

    // --- Restore point (mirrors checkpoint.create) ----------------------
    function stampOf(d) {
        return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" +
            pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    function decodedName(file) {
        var name = String(file.name);
        try { name = decodeURI(name); } catch (eDec) { /* keep raw */ }
        return name;
    }

    function checkpointFolder() {
        var file = app.project.file;
        if (!file) return null;
        return new Folder(file.parent.fsName + "/" + CHECKPOINT_SUBDIR);
    }

    /** { ok, message }. Saves the project, then copies its file; never overwrites. */
    function makeCheckpoint() {
        var file = app.project.file;
        if (!file) {
            return { ok: false, message: "Salva prima il progetto: un progetto mai salvato non ha un file da copiare." };
        }
        var name = decodedName(file);
        var dot = name.lastIndexOf(".");
        if (dot <= 0 || name.substring(dot).toLowerCase() !== ".aep") {
            return { ok: false, message: "Il punto di ripristino dal pannello funziona solo con progetti .aep." };
        }
        var stem = name.substring(0, dot);
        try {
            app.project.save();
        } catch (eSave) {
            return { ok: false, message: "Salvataggio non riuscito: il punto di ripristino non \u00e8 stato creato." };
        }
        file = app.project.file;
        var folder = checkpointFolder();
        if (folder === null) return { ok: false, message: "Il progetto non ha pi\u00f9 un file." };
        if (!folder.exists && !folder.create()) {
            return { ok: false, message: "Non riesco a creare la cartella " + CHECKPOINT_SUBDIR + "." };
        }
        var base = stem + "__" + stampOf(new Date()) + "__" + CHECKPOINT_LABEL;
        var dest = null;
        for (var copy = 1; copy <= CHECKPOINT_MAX_COPY; copy++) {
            var candidate = new File(folder.fsName + "/" + base + (copy > 1 ? " (" + copy + ")" : "") + ".aep");
            if (!candidate.exists) {
                dest = candidate;
                break;
            }
        }
        if (dest === null) return { ok: false, message: "Troppi punti di ripristino con lo stesso nome." };
        if (!file.copy(dest.fsName)) return { ok: false, message: "Copia non riuscita." };
        if (dest.length !== file.length) {
            try { dest.remove(); } catch (eRm) { /* leave it */ }
            return { ok: false, message: "Copia incompleta: il punto di ripristino \u00e8 stato scartato." };
        }
        return { ok: true, message: "Ripristino creato: " + decodedName(dest) };
    }

    function historyFolder() {
        try {
            return new Folder(Folder.userData.fsName + "/Parlez/storico");
        } catch (eFolder) {
            return null;
        }
    }

    // --- Look -----------------------------------------------------------
    function setFont(ctrl, style, size) {
        try { ctrl.graphics.font = ScriptUI.newFont("dialog", style, size); } catch (eFont) { /* default font */ }
    }

    function setTextColor(ctrl, rgb) {
        try {
            ctrl.graphics.foregroundColor = ctrl.graphics.newPen(ctrl.graphics.PenType.SOLID_COLOR, rgb, 1);
        } catch (eColor) { /* some versions ignore it: default colour */ }
    }

    function setFill(ctrl, rgb) {
        try {
            ctrl.graphics.backgroundColor = ctrl.graphics.newBrush(
                ctrl.graphics.BrushType.SOLID_COLOR,
                [rgb[0], rgb[1], rgb[2], 1]
            );
        } catch (eFill) { /* no fill */ }
    }

    function text(parent, value, size, color) {
        var t = parent.add("statictext", undefined, value);
        t.alignment = ["fill", "center"];
        if (size) setFont(t, "REGULAR", size);
        setTextColor(t, color || TEXT);
        return t;
    }

    function line(parent) {
        var l = parent.add("group");
        l.alignment = ["fill", "top"];
        l.preferredSize.height = 1;
        l.margins = 0;
        setFill(l, LINE);
        return l;
    }

    function button(parent, label, tip) {
        var b = parent.add("button", undefined, label);
        b.helpTip = tip;
        return b;
    }

    /** onDraw for the ON/OFF block: fill, then the word, centred. */
    function drawBlock() {
        var g = this.graphics;
        try {
            var w = this.size[0];
            var h = this.size[1];
            var c = this.fillColor || GREY;
            g.newPath();
            g.rectPath(0, 0, w, h);
            g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [c[0], c[1], c[2], 1]));
            var word = this.word || "";
            var font = this.wordFont || g.font;
            var dim = g.measureString(word, font);
            g.drawString(word, g.newPen(g.PenType.SOLID_COLOR, [1, 1, 1, 1], 1), (w - dim[0]) / 2, (h - dim[1]) / 2, font);
        } catch (eDraw) {
            try { g.drawOSControl(); } catch (eOs) { /* nothing left to draw with */ }
        }
    }

    // --- Building the two layouts ---------------------------------------
    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var win = isPanel ? thisObj : new Window("palette", TITLE, undefined, { resizeable: true });
    var ui = null;
    var notice = "";

    function buildBlock(parent, width, height) {
        var frame = parent.add("group");
        frame.margins = 3;
        frame.alignment = ["fill", "top"];
        var block = frame.add("button", undefined, "OFF");
        block.preferredSize = [width, height];
        block.alignment = ["fill", "fill"];
        try { block.wordFont = ScriptUI.newFont("dialog", "BOLD", Math.round(height * 0.5)); } catch (eBf) { /* default */ }
        setFont(block, "BOLD", 18);
        block.onDraw = drawBlock;
        return { frame: frame, block: block };
    }

    function buildButtons(parent, compact) {
        var b = {};
        var rowA = parent.add("group");
        rowA.orientation = "row";
        rowA.alignChildren = ["fill", "center"];
        rowA.spacing = 4;
        b.undo = button(rowA, "Annulla", "Annulla l'ultima modifica di Claude (Modifica \u203a Annulla, una volta). Chiede conferma.");
        b.checkpoint = button(rowA, "Ripristino", "Salva il progetto e ne fa una copia in " + CHECKPOINT_SUBDIR + ", accanto al progetto.");
        var rowB = compact ? rowA : parent.add("group");
        if (!compact) {
            rowB.orientation = "row";
            rowB.alignChildren = ["fill", "center"];
            rowB.spacing = 4;
        }
        var rowC = compact ? parent.add("group") : rowB;
        if (compact) {
            rowC.orientation = "row";
            rowC.alignChildren = ["fill", "center"];
            rowC.spacing = 4;
        }
        b.checkpointFolder = button(rowC, "Ripristini", "Apre la cartella dei punti di ripristino di questo progetto.");
        b.history = button(rowC, "Storico", "Apre lo storico completo delle richieste di questa sessione (file di testo).");
        b.mailbox = button(rowC, "Cassetta", "Apre la cartella dove Claude e After Effects si scambiano le richieste.");
        b.layout = button(rowC, "Vista", "Passa alla vista " + (compact ? "verticale (colonna laterale)." : "compatta (sotto la timeline)."));
        return b;
    }

    function build(layout) {
        var compact = (layout === "compatta");
        setFill(win, BG);
        win.orientation = compact ? "row" : "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = compact ? 12 : 8;
        win.margins = compact ? [10, 8, 10, 8] : 12;
        var u = { layout: layout, rows: [], lampKey: "", flip: false };

        // Left (compact) or top (vertical): title, block, status, read-only.
        var head = win.add("group");
        head.orientation = "column";
        head.alignChildren = ["fill", "top"];
        head.spacing = 6;
        if (compact) head.preferredSize.width = 150;
        var titleRow = head.add("group");
        titleRow.orientation = "row";
        titleRow.alignChildren = ["left", "center"];
        u.title = titleRow.add("statictext", undefined, TITLE);
        setFont(u.title, "BOLD", compact ? 16 : 22);
        setTextColor(u.title, TEXT);
        var blk = buildBlock(head, compact ? 140 : 220, compact ? 54 : 72);
        u.frame = blk.frame;
        u.block = blk.block;
        u.status = text(head, "", 12);
        u.readOnly = head.add("checkbox", undefined, "Sola lettura");
        u.readOnly.helpTip = "Claude pu\u00f2 guardare il progetto ma non modificarlo: le richieste che cambierebbero qualcosa vengono rifiutate.";
        setTextColor(u.readOnly, TEXT);

        if (!compact) line(win);

        // History.
        var hist = win.add("group");
        hist.orientation = "column";
        hist.alignChildren = ["fill", "top"];
        hist.spacing = 2;
        hist.margins = [8, 6, 8, 6];
        setFill(hist, SECTION_BG);
        if (compact) hist.preferredSize.width = 300;
        var histTitle = text(hist, "Ultime richieste", 11, DIM);
        histTitle.helpTip = "Le richieste pi\u00f9 recenti di Claude in questa sessione: ora, cosa, esito, durata. Lo storico completo \u00e8 nel bottone Storico.";
        var rows = compact ? 5 : 8;
        for (var r = 0; r < rows; r++) u.rows.push(text(hist, "", 11));

        if (!compact) line(win);

        // Buttons, then the small print.
        var tail = win.add("group");
        tail.orientation = "column";
        tail.alignChildren = ["fill", "top"];
        tail.spacing = 4;
        u.buttons = buildButtons(tail, compact);
        u.notice = text(tail, "", 10, DIM);
        u.counts = text(tail, "", 9, DIM);
        u.instance = text(tail, "", 9, DIM);

        wire(u);
        return u;
    }

    function clearWindow() {
        while (win.children.length > 0) win.remove(win.children[0]);
    }

    // --- Behaviour ------------------------------------------------------
    var current = { agent: null, target: null };

    function say(message) {
        notice = message;
        if (ui !== null) ui.notice.text = message;
    }

    function refresh() {
        var now = new Date().getTime();
        var enabled = readEnabled();
        var readOnly = readReadOnly();
        var agent = readAgent();
        current.agent = agent;

        var state = blockFor(enabled, readOnly, agent, now);
        var key = state.label + state.color.join(",");
        ui.block.word = state.label;
        ui.block.fillColor = state.color;
        ui.block.helpTip = state.tip;
        if (key !== ui.lampKey) {
            // A different text is what makes ScriptUI redraw the button; the
            // trailing space alternates so a colour change alone redraws too.
            ui.flip = !ui.flip;
            ui.block.text = state.label + (ui.flip ? " " : "");
            setFill(ui.frame, state.color);
            ui.lampKey = key;
        }
        ui.status.text = state.status;
        ui.status.helpTip = state.tip;

        ui.readOnly.value = readOnly;
        ui.readOnly.enabled = (agent === null) || (agent.version >= READ_ONLY_AGENT_VERSION);

        var recent = (agent !== null) ? agent.recent : [];
        var lines = historyLines(recent, ui.rows.length);
        for (var i = 0; i < ui.rows.length; i++) ui.rows[i].text = (i < lines.length) ? lines[i] : "";
        if (lines.length === 0) ui.rows[0].text = "Nessuna richiesta in questa sessione.";

        if (agent === null) {
            ui.counts.text = "";
            ui.instance.text = "";
        } else {
            var since = (agent.lastRequestAt > 0)
                ? "ultima " + Math.round((now - agent.lastRequestAt) / 1000) + " s fa"
                : "nessuna richiesta";
            ui.counts.text = "eseguite " + agent.served + " \u00b7 rifiutate " + agent.refused + " \u00b7 " + since;
            ui.instance.text = agent.id + " \u00b7 agente v" + agent.version;
        }
        ui.notice.text = notice;

        current.target = undoTarget(recent);
        var b = ui.buttons;
        b.undo.enabled = (current.target !== null);
        b.mailbox.enabled = (agent !== null && agent.dir !== null);
        b.checkpointFolder.enabled = !!app.project.file;
        b.checkpoint.enabled = !!app.project.file;
    }

    function wire(u) {
        var b = u.buttons;
        u.block.onClick = function () {
            var want = readEnabled() ? "0" : "1";
            if (!writeSwitch(KEY_ENABLED, want)) {
                say("Non riesco a salvare la scelta nelle preferenze di After Effects.");
            } else {
                say("");
            }
            refresh();
        };
        u.readOnly.onClick = function () {
            if (!writeSwitch(KEY_READ_ONLY, u.readOnly.value ? "1" : "0")) {
                say("Non riesco a salvare la scelta nelle preferenze di After Effects.");
            }
            refresh();
        };
        b.undo.onClick = function () {
            var target = current.target;
            if (target === null) return;
            var what = (typeof target.title === "string") ? target.title : target.label;
            var ok = confirm(
                "Annullo l'ultima modifica di Claude?\n\n" +
                "\u00ab" + what + "\u00bb delle " + clock(target.t) + "\n\n" +
                "After Effects non permette di leggere la cronologia degli annullamenti: " +
                "se dopo hai fatto tu altre modifiche, verr\u00e0 annullata la tua ultima modifica, non quella di Claude."
            );
            if (!ok) return;
            try {
                app.executeCommand(UNDO_COMMAND);
                undoneMarks()[entryKey(target)] = true;
                say("Annullato: " + what + ".");
            } catch (eUndo) {
                say("Annullamento non riuscito.");
            }
            refresh();
        };
        b.checkpoint.onClick = function () {
            say(makeCheckpoint().message);
            refresh();
        };
        b.checkpointFolder.onClick = function () {
            var folder = checkpointFolder();
            if (folder === null) say("Il progetto non \u00e8 ancora stato salvato.");
            else if (!folder.exists) say("Nessun punto di ripristino per questo progetto, per ora.");
            else folder.execute();
        };
        b.history.onClick = function () {
            var agent = current.agent;
            if (agent !== null && agent.historyPath !== null && new File(agent.historyPath).exists) {
                new File(agent.historyPath).execute();
                return;
            }
            var folder = historyFolder();
            if (folder !== null && folder.exists) folder.execute();
            else say("Nessuna richiesta registrata finora.");
        };
        b.mailbox.onClick = function () {
            var agent = current.agent;
            if (agent === null || agent.dir === null) return;
            var folder = new Folder(agent.dir);
            if (folder.exists) folder.execute();
        };
        b.layout.onClick = function () {
            var next = (ui.layout === "compatta") ? "verticale" : "compatta";
            writeSwitch(KEY_LAYOUT, next);
            clearWindow();
            ui = build(next);
            refresh();
            try { win.layout.layout(true); } catch (eLay) { /* next resize lays it out */ }
        };
    }

    // Safe by default: with no choice saved yet, save "Claude fermo" — the
    // rule already reads "absent" as stopped; saving makes the choice
    // explicit and shows at once whether After Effects keeps it.
    if (readSwitch(KEY_ENABLED) === null && !writeSwitch(KEY_ENABLED, "0")) {
        notice = "Non riesco a salvare la scelta nelle preferenze di After Effects.";
    }
    ui = build(readLayout());
    refresh();

    // --- Keeping it current -----------------------------------------------
    // One timer per After Effects session: rebuilding the panel (closing and
    // reopening it, a workspace switch) replaces the previous one rather
    // than adding another. A refresh that throws means the controls are gone
    // - a docked panel that was closed - and stops the timer for good.
    function stopTimer() {
        try {
            var registered = $.global.AE_MCP_PANEL;
            if (registered) {
                registered.onAgent = null;
                if (registered.taskId !== null && registered.taskId !== undefined) {
                    app.cancelTask(registered.taskId);
                    registered.taskId = null;
                }
            }
        } catch (eStop) { /* nothing scheduled */ }
    }

    stopTimer();
    $.global.AE_MCP_PANEL = {
        taskId: null,
        refresh: function () {
            try {
                refresh();
            } catch (eRefresh) {
                stopTimer();
            }
        },
        // Called by the agent right before and after each request: the only
        // moment "sta elaborando" can show. update() asks ScriptUI to paint
        // now, while the request still holds the scripting engine.
        onAgent: function () {
            try {
                refresh();
                if (typeof win.update === "function") win.update();
            } catch (eAgentRefresh) {
                stopTimer();
            }
        }
    };
    try {
        $.global.AE_MCP_PANEL.taskId = app.scheduleTask("$.global.AE_MCP_PANEL.refresh()", REFRESH_MS, true);
    } catch (eSchedule) { /* refreshed by the buttons and the agent only */ }

    win.onResizing = win.onResize = function () {
        try { this.layout.resize(); } catch (eResize) { /* ignore */ }
    };

    if (isPanel) {
        win.layout.layout(true);
    } else {
        win.onClose = function () {
            stopTimer();
        };
        win.center();
        win.show();
    }
})(this);
