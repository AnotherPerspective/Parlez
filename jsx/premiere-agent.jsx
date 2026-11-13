// Parlez! for Premiere Pro - the resident agent (pull path).
//
// Premiere has no Startup-scripts folder with timers the way After Effects
// does, so nothing can sit inside it and poll on its own. What can stay open
// is a CEP panel: the Parlez! panel (premiere/panel/) loads this file through
// its host stub when it opens, then calls PARLEZ_PR.tick(enabled, readOnly)
// every quarter of a second. Each tick refreshes this instance's heartbeat
// and serves at most ONE request from its mailbox, through the same
// AE_MCP.serveRequest (jsx/serve.jsx) that After Effects uses.
//
// So in Premiere the panel IS the agent: panel closed = no ticks = the
// heartbeat goes stale and the server stops sending. That is the project's
// rule ("without the panel on, Claude is stopped") with nothing added.
//
// Where. <mailbox>/premiere/<id>/ - a sibling of After Effects'
// <mailbox>/instances/, never inside it, so After Effects' instance
// discovery cannot see a Premiere instance and no After Effects call can be
// routed here by mistake. The mailbox is pinned by the stub the installer
// writes ($.global.PARLEZ_PR_MAILBOX) and runtime-dir.txt is never followed,
// for the same reason as jsx/agent.jsx: a resident poller that followed a
// pointer would let any local writer redirect it.
//
// The switches. The panel keeps ON/OFF and "Sola lettura" itself (Premiere
// has no app.settings) and hands them to every tick. The rule is the same
// as in After Effects: Claude may work only when the panel says exactly
// `true`. serve.jsx asks AE_MCP.isPaused / isReadOnly at serving time; they
// are replaced below so they answer from what the last tick said.
//
// Undo. Premiere's scripting has no undo groups: requests from the server
// arrive with undoGroup: false and suppressDialogs: false, so serve.jsx
// never calls the After Effects-only app.beginUndoGroup or
// app.beginSuppressDialogs here.
//
// The agent never calls into the panel; the panel reads what tick returns.
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.

#include "json2.jsx"
#include "serve.jsx"
#include "premiere-helpers.jsx"

(function premiereAgentEntry() {
    // 2: undo journal (undoable entries in the history, undoLast for the panel).
    var AGENT_VERSION = 2;
    var RECENT_MAX = 8;
    var LABEL_MAX = 60;
    var TITLE_MAX = 120;
    var HEARTBEAT_MS = 1000;
    var INSTANCES_SUBDIR = "premiere";

    function now() {
        return new Date().getTime();
    }

    function describeError(e) {
        try {
            if (e === null || e === undefined) return "unknown error";
            if (typeof e === "string") return e;
            var msg = (e.message === undefined || e.message === null) ? "" : String(e.message);
            if (msg.length === 0) msg = "error";
            if (e.line !== undefined && e.line !== null) msg += " (line " + String(e.line) + ")";
            return msg;
        } catch (eFmt) {
            return "unformattable error";
        }
    }

    function normalizePath(p) {
        return String(p).replace(/\\/g, "/");
    }

    function randomId() {
        var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        var out = "pr-";
        for (var i = 0; i < 6; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        return out;
    }

    function ensureDir(dir) {
        var parts = normalizePath(dir).split("/");
        var cur = "";
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].length === 0 && i > 0) continue;
            cur = (i === 0) ? parts[i] : cur + "/" + parts[i];
            if (cur.length === 0 || /^[A-Za-z]:$/.test(cur)) continue;
            var f = new Folder(cur);
            if (!f.exists) f.create();
        }
        return new Folder(dir).exists;
    }

    function writeAtomic(p, text) {
        var dest = new File(p);
        var tmp = new File(p + ".tmp");
        tmp.encoding = "UTF-8";
        if (!tmp.open("w")) return false;
        tmp.write(text);
        tmp.close();
        if (dest.exists) {
            try { dest.remove(); } catch (eRm) { /* ignore */ }
        }
        return tmp.rename(dest.name);
    }

    function mailboxDir() {
        try {
            var pinned = $.global.PARLEZ_PR_MAILBOX;
            if (pinned) return normalizePath(String(pinned));
        } catch (ePinned) { /* not pinned */ }
        return normalizePath(Folder.temp.fsName) + "/mcp-aftereffects/runtime";
    }

    function shorten(value, max) {
        var s = String(value);
        return (s.length > max) ? s.substring(0, max) : s;
    }

    // State survives the panel being closed and opened again in the same
    // Premiere session ($.global lives as long as Premiere's script engine),
    // so the instance keeps its id and its counters.
    var state = $.global.PARLEZ_PR_STATE;
    if (!state || typeof state.id !== "string") {
        state = {
            id: randomId(),
            startedAt: now(),
            ticks: 0,
            served: 0,
            refused: 0,
            enabled: false,
            readOnly: false,
            busy: false,
            busySince: null,
            pending: 0,
            lastRequestAt: null,
            lastHeartbeatAt: 0,
            lastError: null,
            recent: []
        };
        $.global.PARLEZ_PR_STATE = state;
    }

    function instanceDir() {
        return mailboxDir() + "/" + INSTANCES_SUBDIR + "/" + state.id;
    }

    function projectFacts() {
        var facts = { project: null, projectName: null };
        try {
            if (app.project) {
                if (app.project.path) facts.project = normalizePath(String(app.project.path));
                if (app.project.name) facts.projectName = String(app.project.name);
            }
        } catch (eProj) { /* no project open */ }
        return facts;
    }

    function appVersion() {
        try {
            return String(app.version);
        } catch (eVer) {
            return null;
        }
    }

    function countPending(dir) {
        try {
            var files = new Folder(dir).getFiles("request-*.json");
            return files ? files.length : 0;
        } catch (eCount) {
            return 0;
        }
    }

    function writeHeartbeat(dir) {
        var facts = projectFacts();
        var hb = {
            id: state.id,
            host: "premiere",
            idSource: "random",
            agentVersion: AGENT_VERSION,
            appVersion: appVersion(),
            project: facts.project,
            projectName: facts.projectName,
            startedAt: state.startedAt,
            ticks: state.ticks,
            served: state.served,
            refused: state.refused,
            paused: state.enabled !== true,
            readOnly: state.readOnly === true,
            pending: state.pending,
            lastRequestAt: state.lastRequestAt,
            recent: state.recent,
            busy: state.busy,
            busySince: state.busySince,
            lastError: state.lastError,
            ts: now()
        };
        try {
            writeAtomic(dir + "/heartbeat.json", JSON.stringify(hb));
            state.lastHeartbeatAt = hb.ts;
        } catch (eHb) {
            state.lastError = "heartbeat: " + describeError(eHb);
        }
    }

    function undoCount() {
        try {
            return PR.undoCount();
        } catch (eCount) {
            return 0;
        }
    }

    /** The newest change still undoable is now taken back: say so in the history. */
    function markUndone() {
        for (var i = state.recent.length - 1; i >= 0; i--) {
            if (state.recent[i].undoable === true) {
                state.recent[i].undoable = false;
                state.recent[i].undone = true;
                return;
            }
        }
    }

    function record(summary, ms, undoable) {
        var outcome = (summary && typeof summary.outcome === "string") ? summary.outcome : "error";
        var label = (summary && typeof summary.label === "string") ? shorten(summary.label, LABEL_MAX) : "?";
        var entry = { t: now(), label: label, outcome: outcome, ms: ms, undoable: undoable === true };
        if (summary && typeof summary.title === "string") entry.title = shorten(summary.title, TITLE_MAX);
        state.recent.push(entry);
        while (state.recent.length > RECENT_MAX) state.recent.shift();
        if (outcome === "paused" || outcome === "readonly") state.refused++;
        else state.served++;
        state.lastRequestAt = entry.t;
    }

    /** What the panel shows; also returned (as JSON text) by every tick. */
    function status(dir) {
        var facts = projectFacts();
        return {
            ok: true,
            id: state.id,
            agentVersion: AGENT_VERSION,
            appVersion: appVersion(),
            projectName: facts.projectName,
            enabled: state.enabled === true,
            readOnly: state.readOnly === true,
            served: state.served,
            refused: state.refused,
            pending: state.pending,
            busy: state.busy,
            lastRequestAt: state.lastRequestAt,
            lastHeartbeatAt: state.lastHeartbeatAt,
            lastError: state.lastError,
            recent: state.recent,
            dir: dir
        };
    }

    // serve.jsx reads the switches through these at serving time.
    AE_MCP.isEnabled = function () {
        return state.enabled === true;
    };
    AE_MCP.isPaused = function () {
        return state.enabled !== true;
    };
    AE_MCP.isReadOnly = function () {
        return state.readOnly === true;
    };
    AE_MCP.PAUSED_MESSAGE = "Claude \u00e8 in pausa in Premiere Pro: accendi l'interruttore nel pannello Parlez!";
    AE_MCP.READ_ONLY_MESSAGE = "Claude \u00e8 in sola lettura in Premiere Pro: spegni \u00abSola lettura\u00bb nel pannello Parlez! per lasciarlo modificare.";

    /**
     * One beat: take the panel's switches, refresh the heartbeat when due (or
     * at once when a switch changed), serve at most one request. Returns the
     * panel's status as JSON text; never throws.
     */
    function tick(enabled, readOnly) {
        var dir = null;
        try {
            var wantEnabled = (enabled === true);
            var wantReadOnly = (readOnly === true);
            var changed = (wantEnabled !== state.enabled) || (wantReadOnly !== state.readOnly);
            state.enabled = wantEnabled;
            state.readOnly = wantReadOnly;
            state.ticks++;

            dir = instanceDir();
            if (!ensureDir(dir)) {
                state.lastError = "cannot create " + dir;
                return JSON.stringify(status(dir));
            }
            state.pending = countPending(dir);
            if (changed || now() - state.lastHeartbeatAt >= HEARTBEAT_MS) writeHeartbeat(dir);

            var request = AE_MCP.oldestRequestIn(dir);
            if (request !== null) {
                state.busy = true;
                state.busySince = now();
                writeHeartbeat(dir);
                var started = now();
                var undoBefore = undoCount();
                var summary = null;
                try {
                    summary = AE_MCP.serveRequest(request, dir, dir + "/agent.log");
                } catch (eServe) {
                    state.lastError = "serve: " + describeError(eServe);
                }
                var undoAfter = undoCount();
                // pr_undo_last took a change back through this request.
                if (undoAfter < undoBefore) markUndone();
                record(summary, now() - started, undoAfter > undoBefore);
                state.busy = false;
                state.busySince = null;
                state.pending = countPending(dir);
                writeHeartbeat(dir);
            }
            return JSON.stringify(status(dir));
        } catch (eTick) {
            state.busy = false;
            state.lastError = "tick: " + describeError(eTick);
            try {
                return JSON.stringify(status(dir));
            } catch (eStatus) {
                return "{\"ok\":false}";
            }
        }
    }

    /** Open the mailbox folder in Explorer / Finder (the panel's "Cassetta" button). */
    function openMailbox() {
        try {
            var folder = new Folder(instanceDir());
            if (folder.exists) return folder.execute() ? "ok" : "fail";
            return "missing";
        } catch (eOpen) {
            return "fail";
        }
    }

    /**
     * The panel's Annulla button: take back Claude's last change (PR.undoLast)
     * and say so in the history. Returns JSON text; never throws.
     */
    function undoLast() {
        var started = now();
        var result;
        try {
            result = PR.undoLast();
        } catch (eUndo) {
            result = { ok: false, error: describeError(eUndo) };
        }
        if (result.ok === true) markUndone();
        record({ outcome: result.ok === true ? "ok" : "error", label: "pr_undo_last",
            title: "annulla l'ultima modifica di Claude" }, now() - started, false);
        return JSON.stringify(result);
    }

    $.global.PARLEZ_PR = {
        version: AGENT_VERSION,
        state: state,
        tick: tick,
        openMailbox: openMailbox,
        undoLast: undoLast,
        undoCount: undoCount
    };
})();
