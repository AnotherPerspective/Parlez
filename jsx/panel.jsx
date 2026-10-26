// Parlez! - the switch inside After Effects.
//
// A ScriptUI panel: plain ExtendScript, no CEP, no extension. `install-panel`
// copies this file into the user-level Scripts/ScriptUI Panels folder as
// "Parlez!.jsx", and After Effects lists it under the Window menu by that
// name; it docks like any other panel and takes After Effects' dark look.
// Run as an ordinary script (File > Scripts > Run Script File...) it opens as
// a floating window instead.
//
// What it shows, top to bottom:
//   - a traffic light: green "Claude puo lavorare", red "Claude fermo",
//     yellow "Claude sta lavorando" (a request in the last few seconds),
//     grey when the resident agent is not there or not answering;
//   - one button that switches Claude on or off (one click), and a "Sola
//     lettura" box: Claude may look but not change the project;
//   - the last 8 requests the agent took, with time and operation name;
//   - counters: run, refused, seconds since the last request, instance id,
//     agent version;
//   - quick buttons: undo Claude's last change, make a restore point now,
//     open the restore points folder, open the instance's mailbox.
//
// How it talks to the rest. The two switches are app.settings entries in the
// "Parlez" section (claudeEnabled "1"/"0", readOnly "1"/"0"); jsx/serve.jsx
// reads them before every request, on the pull path (the resident agent) and
// the push path alike, and the agent publishes them in its heartbeat, which
// is how the server answers PAUSED / READ_ONLY without even sending. A change
// takes effect on the agent's next tick (250 ms); nothing needs restarting,
// and app.settings is kept between sessions. Everything else comes from the
// agent: $.global.AE_MCP_AGENT (same scripting engine) or, failing that, the
// heartbeat file it writes.
//
// "Claude fermo" by default: with no choice saved, the agent saves "0" at
// startup where this panel is installed, and the panel does the same the
// first time it opens.
//
// Limits, by After Effects' design:
//   - while Claude's request runs, After Effects runs no other script, this
//     panel included; so "sta lavorando" shows between requests (the last
//     few seconds), never in the middle of one;
//   - scripts cannot read the undo history, so "Annulla" cannot check that
//     the step on top is Claude's: it says which action it means and asks.
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
    var TITLE = "Parlez!";
    var REFRESH_MS = 1500;
    // The agent refreshes its heartbeat every second; the server presumes it
    // gone after five (HEARTBEAT_STALE_MS in src/config.ts).
    var STALE_MS = 5000;
    // "Sta lavorando": a request arrived this recently.
    var ACTIVE_MS = 5000;
    var RECENT_ROWS = 8;
    // First agent versions that know each switch (jsx/agent.jsx AGENT_VERSION).
    var PAUSE_AGENT_VERSION = 2;
    var READ_ONLY_AGENT_VERSION = 3;
    // Same folder and naming as checkpoint.create (src/operations/checkpoint.ts).
    var CHECKPOINT_SUBDIR = "_parlez-checkpoints";
    var CHECKPOINT_LABEL = "pannello";
    var CHECKPOINT_MAX_COPY = 999;
    // Edit > Undo.
    var UNDO_COMMAND = 16;

    var GREEN = [0.24, 0.74, 0.38];
    var RED = [0.88, 0.26, 0.22];
    var YELLOW = [0.96, 0.74, 0.16];
    var GREY = [0.45, 0.45, 0.45];

    // --- Switches -------------------------------------------------------
    function readSwitch(key) {
        try {
            if (!app.settings.haveSetting(SECTION, key)) return null;
            return String(app.settings.getSetting(SECTION, key));
        } catch (eRead) {
            return null;
        }
    }

    function writeSwitch(key, value) {
        try {
            app.settings.saveSetting(SECTION, key, value);
        } catch (eWrite) { /* the next refresh shows what is really saved */ }
    }

    /** Anything but "0" counts as allowed, exactly as serve.jsx reads it. */
    function readEnabled() {
        var v = readSwitch(KEY_ENABLED);
        return (v === null) ? null : (v !== "0");
    }

    function readReadOnly() {
        return readSwitch(KEY_READ_ONLY) === "1";
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
        var ts = numberOr(hb !== null ? hb.ts : state.lastHeartbeatAt, 0);
        var recent = pick("recent", []);
        return {
            id: String(state.id),
            version: numberOr(state.agentVersion, 1),
            dir: dir,
            served: numberOr(pick("served", 0), 0),
            refused: numberOr(pick("refused", 0), 0),
            busy: pick("busy", false) === true,
            lastRequestAt: numberOr(pick("lastRequestAt", null), 0),
            recent: (recent && typeof recent.length === "number") ? recent : [],
            heartbeatAt: ts
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

    /** Traffic light: { color, title, detail }. The switch decides first. */
    function lightFor(enabled, readOnly, agent, now) {
        if (enabled !== true) {
            return {
                color: RED,
                title: "CLAUDE FERMO",
                detail: "Claude non pu\u00f2 toccare After Effects: ogni sua richiesta viene rifiutata."
            };
        }
        if (agent === null) {
            return {
                color: GREY,
                title: "NON COLLEGATO",
                detail: "Script di avvio non attivo in questo After Effects: Claude non riesce a collegarsi. " +
                    "Installalo (install-agent) e riavvia After Effects."
            };
        }
        if (agent.version < PAUSE_AGENT_VERSION) {
            return {
                color: GREY,
                title: "AGENTE VECCHIO",
                detail: "Lo script di avvio \u00e8 una versione che non conosce l'interruttore: riavvia After Effects."
            };
        }
        if (agent.heartbeatAt === 0 || now - agent.heartbeatAt > STALE_MS) {
            return {
                color: GREY,
                title: "NON RISPONDE",
                detail: "Lo script di avvio \u00e8 caricato ma il battito non si aggiorna" +
                    (agent.heartbeatAt === 0 ? "." : " da " + Math.round((now - agent.heartbeatAt) / 1000) + " s.")
            };
        }
        var tail = readOnly ? " Sola lettura: pu\u00f2 guardare il progetto, non modificarlo." : "";
        if (agent.busy || (agent.lastRequestAt > 0 && now - agent.lastRequestAt < ACTIVE_MS)) {
            return { color: YELLOW, title: "CLAUDE STA LAVORANDO", detail: "Richieste in arrivo in questo momento." + tail };
        }
        return { color: GREEN, title: "CLAUDE PU\u00d2 LAVORARE", detail: "Claude pu\u00f2 usare After Effects." + tail };
    }

    var OUTCOME_TEXT = {
        ok: "",
        error: "  (errore)",
        paused: "  (rifiutata: pausa)",
        readonly: "  (rifiutata: sola lettura)"
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

    /** Newest first, one line each. */
    function recentLines(recent) {
        var lines = [];
        for (var i = recent.length - 1; i >= 0 && lines.length < RECENT_ROWS; i--) {
            var e = recent[i];
            if (!e || typeof e.t !== "number") continue;
            var outcome = (typeof e.outcome === "string" && OUTCOME_TEXT.hasOwnProperty(e.outcome))
                ? OUTCOME_TEXT[e.outcome] : "";
            if (isUndone(e)) outcome = "  (annullata)";
            lines.push(clock(e.t) + "   " + String(e.label) + outcome);
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

    function projectFileName(file) {
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
        var name = projectFileName(file);
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
        return { ok: true, message: "Punto di ripristino creato: " + projectFileName(dest) };
    }

    // --- The panel ------------------------------------------------------
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
        } catch (eFill) { /* no fill: the title still says it */ }
    }

    function multiline(parent, width, height) {
        var t = parent.add("statictext", undefined, "", { multiline: true });
        t.alignment = ["fill", "top"];
        t.preferredSize.width = width;
        if (height) t.preferredSize.height = height;
        return t;
    }

    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var win = isPanel ? thisObj : new Window("palette", TITLE, undefined, { resizeable: true });
    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 6;
    win.margins = 10;

    // Traffic light.
    var head = win.add("group");
    head.orientation = "row";
    head.alignChildren = ["left", "center"];
    head.spacing = 10;
    var lamp = head.add("group");
    lamp.preferredSize = [30, 30];
    var titleText = head.add("statictext", undefined, "CLAUDE PU\u00d2 LAVORARE");
    titleText.alignment = ["fill", "center"];
    setFont(titleText, "BOLD", 17);
    var detailText = multiline(win, 270, 32);

    // Switches.
    var toggleBtn = win.add("button", undefined, "Ferma Claude");
    toggleBtn.alignment = ["fill", "top"];
    toggleBtn.preferredSize.height = 34;
    setFont(toggleBtn, "BOLD", 14);
    var readOnlyBox = win.add("checkbox", undefined, "Sola lettura: Claude guarda, non modifica");

    // Last actions.
    var recentBox = win.add("panel", undefined, "Ultime azioni");
    recentBox.orientation = "column";
    recentBox.alignChildren = ["fill", "top"];
    recentBox.margins = [10, 14, 10, 8];
    recentBox.spacing = 1;
    var recentRows = [];
    for (var r = 0; r < RECENT_ROWS; r++) {
        var row = recentBox.add("statictext", undefined, "");
        row.alignment = ["fill", "top"];
        row.preferredSize.width = 250;
        recentRows.push(row);
    }

    // Counters.
    var countText = win.add("statictext", undefined, "");
    countText.alignment = ["fill", "top"];
    var instanceText = win.add("statictext", undefined, "");
    instanceText.alignment = ["fill", "top"];

    // Quick buttons.
    var row1 = win.add("group");
    row1.orientation = "row";
    row1.alignChildren = ["fill", "center"];
    var undoBtn = row1.add("button", undefined, "Annulla ultima di Claude");
    var checkpointBtn = row1.add("button", undefined, "Punto di ripristino");
    var row2 = win.add("group");
    row2.orientation = "row";
    row2.alignChildren = ["fill", "center"];
    var checkpointFolderBtn = row2.add("button", undefined, "Cartella ripristini");
    var mailboxBtn = row2.add("button", undefined, "Apri la cassetta");
    var noticeText = multiline(win, 270, 30);

    var current = { enabled: null, agent: null, target: null, lampKey: "" };

    function refresh() {
        var now = new Date().getTime();
        var enabled = readEnabled();
        var readOnly = readReadOnly();
        var agent = readAgent();
        current.enabled = enabled;
        current.agent = agent;

        var light = lightFor(enabled, readOnly, agent, now);
        var lampKey = light.color.join(",");
        if (lampKey !== current.lampKey) {
            setFill(lamp, light.color);
            setTextColor(titleText, light.color);
            current.lampKey = lampKey;
        }
        titleText.text = light.title;
        detailText.text = light.detail;

        toggleBtn.text = (enabled === true) ? "Ferma Claude" : "Lascia lavorare Claude";
        readOnlyBox.value = readOnly;
        readOnlyBox.enabled = (agent === null) || (agent.version >= READ_ONLY_AGENT_VERSION);

        var recent = (agent !== null) ? agent.recent : [];
        var lines = recentLines(recent);
        for (var i = 0; i < recentRows.length; i++) {
            recentRows[i].text = (i < lines.length) ? lines[i] : "";
        }
        if (lines.length === 0) recentRows[0].text = "Nessuna azione in questa sessione.";

        if (agent === null) {
            countText.text = "";
            instanceText.text = "";
        } else {
            var since = (agent.lastRequestAt > 0)
                ? "ultima " + Math.round((now - agent.lastRequestAt) / 1000) + " s fa"
                : "nessuna richiesta ancora";
            countText.text = "Eseguite " + agent.served + " \u00b7 rifiutate " + agent.refused + " \u00b7 " + since;
            instanceText.text = "Istanza " + agent.id + " \u00b7 agente v" + agent.version +
                (agent.version < READ_ONLY_AGENT_VERSION ? " (riavvia After Effects per la sola lettura)" : "");
        }

        current.target = undoTarget(recent);
        undoBtn.enabled = (current.target !== null);
        mailboxBtn.enabled = (agent !== null && agent.dir !== null);
        checkpointFolderBtn.enabled = !!app.project.file;
        checkpointBtn.enabled = !!app.project.file;
    }

    toggleBtn.onClick = function () {
        writeSwitch(KEY_ENABLED, (readEnabled() === true) ? "0" : "1");
        refresh();
    };
    readOnlyBox.onClick = function () {
        writeSwitch(KEY_READ_ONLY, readOnlyBox.value ? "1" : "0");
        refresh();
    };
    undoBtn.onClick = function () {
        var target = current.target;
        if (target === null) return;
        var ok = confirm(
            "Annullo l'ultima modifica di Claude?\n\n" +
            "\u00ab" + target.label + "\u00bb delle " + clock(target.t) + "\n\n" +
            "After Effects non permette di leggere la cronologia degli annullamenti: " +
            "se dopo hai fatto tu altre modifiche, verr\u00e0 annullata la tua ultima modifica, non quella di Claude."
        );
        if (!ok) return;
        try {
            app.executeCommand(UNDO_COMMAND);
            undoneMarks()[entryKey(target)] = true;
            noticeText.text = "Annullato: " + target.label + ".";
        } catch (eUndo) {
            noticeText.text = "Annullamento non riuscito.";
        }
        refresh();
    };
    checkpointBtn.onClick = function () {
        var result = makeCheckpoint();
        noticeText.text = result.message;
        refresh();
    };
    checkpointFolderBtn.onClick = function () {
        var folder = checkpointFolder();
        if (folder === null) {
            noticeText.text = "Il progetto non \u00e8 ancora stato salvato.";
        } else if (!folder.exists) {
            noticeText.text = "Nessun punto di ripristino per questo progetto, per ora.";
        } else {
            folder.execute();
        }
    };
    mailboxBtn.onClick = function () {
        var agent = current.agent;
        if (agent === null || agent.dir === null) return;
        var folder = new Folder(agent.dir);
        if (folder.exists) folder.execute();
    };

    // Safe by default: no choice saved yet means the switch was just
    // installed, and it starts on "Claude fermo".
    if (readEnabled() === null) writeSwitch(KEY_ENABLED, "0");
    refresh();

    // --- Keeping it current -----------------------------------------------
    // One timer per After Effects session: rebuilding the panel (closing and
    // reopening it, a workspace switch) replaces the previous one rather
    // than adding another. A refresh that throws means the controls are gone
    // - a docked panel that was closed - and stops the timer for good.
    function stopTimer() {
        try {
            var registered = $.global.AE_MCP_PANEL;
            if (registered && registered.taskId !== null && registered.taskId !== undefined) {
                app.cancelTask(registered.taskId);
                registered.taskId = null;
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
        }
    };
    try {
        $.global.AE_MCP_PANEL.taskId = app.scheduleTask("$.global.AE_MCP_PANEL.refresh()", REFRESH_MS, true);
    } catch (eSchedule) { /* refreshed by the buttons only */ }

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
