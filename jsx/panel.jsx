// Parlez! (nome provvisorio) - the switch inside After Effects.
//
// A ScriptUI panel: plain ExtendScript, no CEP, no extension. `install-panel`
// copies this file into the user-level Scripts/ScriptUI Panels folder, and
// After Effects lists it under the Window menu by its file name; it docks
// like any other panel. Run as an ordinary script (File > Scripts > Run
// Script File...) it opens as a floating window instead.
//
// What it does:
//   - one switch, "Claude puo lavorare" / "Claude fermo", saved with
//     app.settings in the "Parlez" section. jsx/serve.jsx reads that same
//     entry before every request, on the pull path (the resident agent) and
//     the push path alike, and refuses the request while it says "0"; the
//     agent also publishes it as `paused` in its heartbeat, which is how the
//     server answers PAUSED without even sending. A change takes effect on
//     the agent's next tick (250 ms); nothing needs restarting. app.settings
//     is kept between sessions, so the choice is remembered.
//   - the first time the panel opens and finds no choice saved, it saves
//     "Claude fermo": whoever installs the switch starts with Claude
//     stopped. (Without the panel nothing is saved and nothing changes.)
//   - a status line: is the resident agent (the startup script) running in
//     THIS After Effects, under which instance id, and how many requests it
//     ran or refused. Read from $.global.AE_MCP_AGENT, which the agent sets
//     in the same scripting engine, and from the heartbeat file it writes.
//   - "Apri la cassetta": opens that instance's mailbox folder.
//
// Self-contained on purpose: the file is copied, not loaded from the
// package, so it cannot #include anything. Section and key are mirrored in
// jsx/serve.jsx and src/config.ts (tests keep them in step).
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.
// Strings shown to the user use \u escapes for accented letters, so the file
// reads the same whatever encoding After Effects assumes for it.

(function aeMcpPanel(thisObj) {
    var SECTION = "Parlez";
    var KEY = "claudeEnabled";
    var TITLE = "Parlez (provvisorio)";
    var REFRESH_MS = 2000;
    // The agent refreshes its heartbeat every second; the server presumes it
    // gone after five (HEARTBEAT_STALE_MS in src/config.ts).
    var STALE_MS = 5000;
    // First agent version that reads the switch (jsx/agent.jsx AGENT_VERSION).
    var SWITCH_AGENT_VERSION = 2;

    var TXT_ON = "Claude può lavorare";
    var TXT_OFF = "Claude fermo";

    // --- The switch ----------------------------------------------------
    // Anything but "0" counts as allowed, exactly as serve.jsx reads it.
    function readEnabled() {
        try {
            if (!app.settings.haveSetting(SECTION, KEY)) return null;
            return String(app.settings.getSetting(SECTION, KEY)) !== "0";
        } catch (eRead) {
            return null;
        }
    }

    function writeEnabled(on) {
        try {
            app.settings.saveSetting(SECTION, KEY, on ? "1" : "0");
        } catch (eWrite) { /* the next refresh shows what is really saved */ }
    }

    // --- What the agent says -------------------------------------------
    function agentState() {
        try {
            var agent = $.global.AE_MCP_AGENT;
            if (agent && agent.state) return agent.state;
        } catch (eAgent) { /* no agent in this engine */ }
        return null;
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

    function numberOr(value, fallback) {
        return (typeof value === "number") ? value : fallback;
    }

    /** { agent, counts, folder } - the two status lines and the folder to open, or null. */
    function describeAgent() {
        var state = agentState();
        if (state === null) {
            return {
                agent: "Script di avvio non attivo in questo After Effects: Claude non riesce a collegarsi. " +
                    "Installalo (install-agent) e riavvia After Effects.",
                counts: "",
                folder: null
            };
        }
        var dir = (typeof state.dir === "string") ? state.dir : null;
        var hb = (dir !== null) ? readHeartbeat(dir) : null;
        var source = (hb !== null) ? hb : state;
        var ts = numberOr(hb !== null ? hb.ts : state.lastHeartbeatAt, 0);
        var age = new Date().getTime() - ts;
        var line;
        if (numberOr(state.agentVersion, 1) < SWITCH_AGENT_VERSION) {
            line = "Script di avvio attivo (istanza " + state.id + "), ma è una versione vecchia " +
                "che non conosce l'interruttore: riavvia After Effects.";
        } else if (ts === 0 || age > STALE_MS) {
            line = "Script di avvio caricato (istanza " + state.id + "), ma il battito non si aggiorna" +
                (ts === 0 ? "." : " da " + Math.round(age / 1000) + " s.");
        } else {
            line = "Script di avvio attivo · istanza " + state.id;
        }
        return {
            agent: line,
            counts: "Richieste eseguite: " + numberOr(source.served, 0) +
                " · rifiutate in pausa: " + numberOr(source.refused, 0),
            folder: dir
        };
    }

    // --- The panel -----------------------------------------------------
    function setFont(ctrl, size) {
        try { ctrl.graphics.font = ScriptUI.newFont("dialog", "BOLD", size); } catch (eFont) { /* default font */ }
    }

    function setColor(ctrl, rgb) {
        try {
            ctrl.graphics.foregroundColor = ctrl.graphics.newPen(ctrl.graphics.PenType.SOLID_COLOR, rgb, 1);
        } catch (eColor) { /* default colour */ }
    }

    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var win = isPanel ? thisObj : new Window("palette", TITLE, undefined, { resizeable: true });
    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 8;
    win.margins = 10;

    var box = win.add("panel", undefined, "Controllo di Claude");
    box.orientation = "column";
    box.alignChildren = ["left", "top"];
    box.margins = [12, 16, 12, 12];
    box.spacing = 6;
    var onBtn = box.add("radiobutton", undefined, TXT_ON);
    var offBtn = box.add("radiobutton", undefined, TXT_OFF);
    setFont(onBtn, 16);
    setFont(offBtn, 16);
    var modeText = box.add("statictext", undefined, "", { multiline: true });
    modeText.alignment = ["fill", "top"];
    modeText.preferredSize.width = 260;
    modeText.preferredSize.height = 34;

    var agentText = win.add("statictext", undefined, "", { multiline: true });
    agentText.alignment = ["fill", "top"];
    agentText.preferredSize.width = 260;
    agentText.preferredSize.height = 48;
    var countText = win.add("statictext", undefined, "");
    countText.alignment = ["fill", "top"];

    var row = win.add("group");
    row.orientation = "row";
    row.alignChildren = ["left", "center"];
    var openBtn = row.add("button", undefined, "Apri la cassetta");
    var refreshBtn = row.add("button", undefined, "Aggiorna");

    var shownFolder = null;

    function refresh() {
        var enabled = readEnabled();
        onBtn.value = (enabled === true);
        offBtn.value = (enabled !== true);
        if (enabled === true) {
            modeText.text = "Claude può usare After Effects.";
            setColor(modeText, [0.2, 0.7, 0.3]);
        } else {
            modeText.text = "Claude non può toccare After Effects: ogni sua richiesta viene rifiutata.";
            setColor(modeText, [0.9, 0.3, 0.25]);
        }
        var status = describeAgent();
        agentText.text = status.agent;
        countText.text = status.counts;
        shownFolder = status.folder;
        openBtn.enabled = (shownFolder !== null);
    }

    onBtn.onClick = function () {
        writeEnabled(true);
        refresh();
    };
    offBtn.onClick = function () {
        writeEnabled(false);
        refresh();
    };
    openBtn.onClick = function () {
        if (shownFolder === null) return;
        var folder = new Folder(shownFolder);
        if (folder.exists) folder.execute();
    };
    refreshBtn.onClick = function () {
        refresh();
    };

    // Safe by default: no choice saved yet means the switch was just
    // installed, and it starts on "Claude fermo".
    if (readEnabled() === null) writeEnabled(false);
    refresh();

    // --- Keeping the status line current -------------------------------
    // One timer per After Effects session: rebuilding the panel (closing and
    // reopening it, a workspace switch) replaces the previous one rather
    // than adding another. A refresh that throws means the controls are gone
    // - a docked panel that was closed - and stops the timer for good.
    function stopTimer() {
        try {
            var current = $.global.AE_MCP_PANEL;
            if (current && current.taskId !== null && current.taskId !== undefined) {
                app.cancelTask(current.taskId);
                current.taskId = null;
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
    } catch (eSchedule) { /* refreshed by the button only */ }

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
