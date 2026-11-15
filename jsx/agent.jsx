// mcp-aftereffects resident agent — the PULL path.
//
// Lives inside one After Effects instance for the whole session and serves
// that instance's own mailbox, <runtime>/instances/<id>/, from a scheduled
// task. It gets there through the user-level Scripts/Startup folder: the
// stub that `mcp-aftereffects install-agent` drops there $.evalFile's this
// file at startup, in EVERY instance — including the ones started with
// `AfterFX.exe -m`, which the push path (`-r`) can never reach: `-r` is handed
// to whichever AE registered as THE running instance, `-m` instances never
// register, and with none registered the launched AfterFX.exe boots a
// throwaway instance of its own, runs the script on an empty project and
// quits. (Verified on AE 26.3.)
//
// Identity. The instance id is, in order:
//   1. AE_MCP_INSTANCE from the AE process's own environment — `$.getenv`
//      reads the launching shell's variable, so `set AE_MCP_INSTANCE=shotA`
//      before `AfterFX.exe -m` names the instance deterministically;
//   2. otherwise a random `ae-xxxxxx`. The heartbeat carries the open
//      project's path, so the Node side can still address such an instance
//      by project name.
//
// Each tick (250 ms): refresh the heartbeat (every second, or on any state
// change), then serve at most ONE pending request through AE_MCP.serveRequest
// (jsx/serve.jsx — the same code the dispatcher uses). The heartbeat is
// flagged `busy` around a request so a stale timestamp during a long call
// (ticks do not fire while a script runs) is not mistaken for a dead instance.
//
// The Parlez! panel's switches. Each tick also reads the two switches the
// panel writes (AE_MCP.isPaused / isReadOnly, jsx/serve.jsx) and publishes
// them as `paused` / `readOnly` in the heartbeat — at once when one changes,
// so the server stops sending within a tick. While paused the agent keeps
// ticking and heartbeating; requests that still arrive are consumed and
// answered `paused` by serveRequest without running, and counted as
// `refused`, not `served` (the same for `readOnly` and a request that may
// change the project).
//
// With no choice saved the switch reads as "stopped" (the one rule lives in
// AE_MCP.isEnabled, jsx/serve.jsx, and the panel uses it too).
//
// For the panel, the heartbeat also carries: the last RECENT_MAX requests
// (time, label, the server's plain-Italian title, outcome, duration), when
// the last one arrived, and how many are waiting (`pending`, "sta
// ricevendo"). Every request also gets one line in a history file, one file
// per After Effects session, in the user's application data folder (see
// historyFile). Labels and titles are operation or tool names chosen by the
// server; the request's code and payload are never recorded.
//
// The agent never touches the panel's user interface: doing that from inside
// this scheduled task, while a request runs, is asking for trouble (an
// earlier build did, to redraw the panel). The panel reads the agent. The one
// thing the agent may call is the panel's `watch`, which only re-books the
// panel's own timer and touches no control (see "Staying alive" below).
//
// Staying alive (Parlez! 0.2, AE 26.5 / Windows, 2026-11-14/15). After
// Effects can drop every pending app.scheduleTask of the session at once:
// when a task comes due while certain modal windows are up (opening a project,
// Import File), the task fails with "Cannot run a script while a modal dialog
// is waiting for response", app.onError hears it once, and from then on no
// task booked before (nor from inside onError) ever runs again - with no error
// anywhere we could log. A task booked LATER, from a fresh start (a script run
// by hand, a click in a panel), runs normally. So:
//   - no repeating task: each step books the next one-shot step, tagged with
//     the chain's generation (`state.gen`); revive() starts a new generation
//     and a step of an older one ends on arrival, so there is never more than
//     one chain, whoever revives and however often;
//   - watch(source): revive when no step has run for STALE_TICK_MS and no
//     request is running. The panel calls it from its own timer and from
//     every click; a second evaluation of this file calls it too, and the
//     agent watches the panel's timer the same way. Two timers keep each
//     other going when only one is lost; when After Effects drops both, the
//     next click in the panel brings both back;
//   - the restart is told where the user looks: one line in `recent` (the
//     panel's list) and in the history file, written when the new chain has
//     really ticked, with the time it was silent and the likely cause.
//
// SECURITY: same trust boundary as the shared mailbox — whoever can write
// into <runtime>/instances/<id>/ executes code inside this AE. The directory
// sits under the per-user temp dir like the rest of the runtime. Two things
// differ from the dispatcher, and both come from being resident:
//   - this code runs for the whole session, server or no server, so the
//     directory is live the entire time After Effects is, not just while a
//     call is in flight;
//   - the mailbox is PINNED by the install stub and runtime-dir.txt is never
//     followed. The dispatcher follows that pointer because the server that
//     launched it wrote it moments before; a resident poller following it
//     would let any local writer plant a pointer and redirect every instance
//     to a mailbox of their own, silently, for the rest of the session.
//
// Keep this file ES3: var only, no arrow functions, no Array.prototype.map.

#include "json2.jsx"
#include "helpers.jsx"
#include "export.jsx"
#include "import.jsx"
#include "toolkit.jsx"
#include "serve.jsx"

(function agentEntry() {
    // 2: stays out of the render engine (aerender) and knows the pause switch (`paused` / `refused` in the heartbeat).
    // 3: "Sola lettura" (`readOnly`), recent requests (`recent`, `lastRequestAt`, `pending`), history file.
    // 4: one-shot steps with a generation, watch()/revive(), restarts in `recent` and the heartbeat.
    var AGENT_VERSION = 4;
    var RECENT_MAX = 8;
    var LABEL_MAX = 60;
    var TITLE_MAX = 120;
    var TICK_MS = 250;
    var HEARTBEAT_MS = 1000;
    // Eight missed steps. A false alarm costs nothing but a re-booked step:
    // the old chain, if it was only late, ends on arrival.
    var STALE_TICK_MS = 2000;
    // An agent of an earlier build (no revive) silent this long is replaced by
    // a second evaluation of this file; the server gives up on it after 5 s.
    var TAKEOVER_STALE_MS = 3000;
    // How often a step looks at the panel's timer.
    var PANEL_WATCH_MS = 1000;

    // Own copy of the exception formatter (see serve.jsx): the guard below must
    // be able to report a failure even when an #include did not take.
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

    /**
     * Instance ids become directory names. Keep them to [A-Za-z0-9._-] (the
     * Node side applies the same rule), collapse runs of anything else into
     * one dash, and cap the length. Returns null for an empty result.
     */
    function sanitizeId(raw) {
        if (raw === null || raw === undefined) return null;
        var s = String(raw).replace(/^\s+|\s+$/g, "");
        if (s.length === 0) return null;
        s = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
        if (s.length > 64) s = s.substring(0, 64);
        return s.length > 0 ? s : null;
    }

    function randomId() {
        var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        var out = "ae-";
        for (var i = 0; i < 6; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        return out;
    }

    /** Create every missing segment of `dir` in turn (Folder.create is not mkdir -p). */
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

    // --- Where the mailbox lives ------------------------------------------
    // Pinned by the install stub: $.global.AE_MCP_AGENT_MAILBOX is the
    // server's RUNTIME_DIR at install time (computed from os.tmpdir(), which
    // need not equal Folder.temp on macOS). Without a stub — this file
    // evaluated some other way — the default both sides compute. Never the
    // runtime-dir.txt pointer (see the SECURITY note above): a server running
    // with a custom AE_MCP_RUNTIME_DIR needs `install-agent` re-run, and
    // `agent-status` reports the stub as stale until then.
    function mailboxDir() {
        try {
            var pinned = $.global.AE_MCP_AGENT_MAILBOX;
            if (pinned) return normalizePath(String(pinned));
        } catch (ePinned) { /* not pinned */ }
        return normalizePath(Folder.temp.fsName) + "/mcp-aftereffects/runtime";
    }

    /** Where the stub's own breadcrumbs go (agent-fatal.log). Not a mailbox. */
    function runtimeRoot() {
        try {
            var injected = $.global.AE_MCP_RUNTIME_ROOT_OVERRIDE;
            if (injected) return normalizePath(String(injected));
        } catch (eInjected) { /* not injected */ }
        return normalizePath(Folder.temp.fsName) + "/mcp-aftereffects";
    }

    /**
     * True inside a process that loads Scripts/Startup but is not an After
     * Effects someone works in: the render engine (aerender loads the Startup
     * folder too — on AE 26.5 its agent registered as a second instance and
     * made every unnamed call ambiguous), or a process we started with
     * AE_MCP_AGENT_DISABLE=1. app.isRenderEngine is a documented Application
     * attribute (present in the AE 2020 scripting plug-in already); whether
     * aerender itself reports true is not verified yet, hence the variable.
     */
    function shouldStayOut() {
        try {
            if (app.isRenderEngine === true) return true;
        } catch (eRe) { /* attribute missing: not a render engine we can tell */ }
        try {
            if ($.getenv("AE_MCP_AGENT_DISABLE") === "1") return true;
        } catch (eDis) { /* no env access */ }
        return false;
    }

    function pad2(n) {
        return (n < 10 ? "0" : "") + String(n);
    }

    function stamp(d) {
        return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" +
            pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    function clock(d) {
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    /** "0,4 s", "12 s": the way the panel and the history show a duration. */
    function seconds(ms) {
        if (typeof ms !== "number" || ms < 0) return "";
        if (ms < 10000) return (Math.round(ms / 100) / 10).toString().replace(".", ",") + " s";
        return String(Math.round(ms / 1000)) + " s";
    }

    var OUTCOME_WORDS = {
        ok: "eseguita",
        error: "errore",
        paused: "rifiutata (pausa)",
        readonly: "rifiutata (sola lettura)",
        restart: "ripartito"
    };

    /** A label fit for the panel: one line, bounded, never empty. */
    function cleanLabel(label, max) {
        if (typeof label !== "string" || label.length === 0) return "(senza nome)";
        var limit = max || LABEL_MAX;
        var s = label.replace(/[\x00-\x1f\x7f]+/g, " ");
        if (s.length > limit) s = s.substring(0, limit - 3) + "...";
        return s;
    }

    /**
     * Where this session's history goes: <user data>/Parlez/storico/ —
     * %APPDATA%\Parlez\storico on Windows, ~/Library/Application Support/
     * Parlez/storico on macOS. Not the mailbox (swept an hour after After
     * Effects closes, and a temp folder the system may clear), not next to
     * the project (that would put our files into client folders, and a
     * session spans projects). Null when there is nowhere to write.
     */
    function historyDir() {
        try {
            var dir = normalizePath(Folder.userData.fsName) + "/Parlez/storico";
            return ensureDir(dir) ? dir : null;
        } catch (eDir) {
            return null;
        }
    }

    /**
     * What a second evaluation of this file (the stub run again, a `-r`, a
     * script run by hand) does about the agent already in the process: null
     * to stop here, or the old state to take over from. One agent per
     * process: two chains would race over the same mailbox. An agent that
     * knows revive() is revived when it has stopped (a no-op when it is
     * alive); one of an earlier build is replaced only once it has been
     * silent for TAKEOVER_STALE_MS and is not serving a request.
     */
    function previousAgent() {
        var old = $.global.AE_MCP_AGENT;
        if (!old) return { takeOver: false, state: null };
        try {
            if (typeof old.watch === "function") {
                old.watch("nuovo caricamento dello script di avvio");
                return null;
            }
            var st = old.state;
            if (!st || st.busy === true) return null;
            var last = (typeof st.lastHeartbeatAt === "number") ? st.lastHeartbeatAt : 0;
            if (new Date().getTime() - last < TAKEOVER_STALE_MS) return null;
            try { if (typeof old.stop === "function") old.stop(); } catch (eStop) { /* its task is gone already */ }
            return { takeOver: true, state: st };
        } catch (eOld) {
            return null;
        }
    }

    function agentMain() {
        var previous = previousAgent();
        if (previous === null) return;
        if (shouldStayOut()) return;

        var envId = null;
        try { envId = sanitizeId($.getenv("AE_MCP_INSTANCE")); } catch (eEnv) { /* no env access */ }

        var state = {
            id: envId || randomId(),
            idSource: envId ? "env" : "random",
            agentVersion: AGENT_VERSION,
            startedAt: new Date().getTime(),
            ticks: 0,
            served: 0,
            refused: 0,
            paused: false,
            readOnly: false,
            lastRequestAt: null,
            pending: 0,
            recent: [],
            historyPath: null,
            busy: false,
            busySince: null,
            dir: null,
            taskId: null,
            lastHeartbeatAt: 0,
            lastError: null,
            // Staying alive (see the header).
            gen: 0,
            lastTickAt: 0,
            lastReviveAt: 0,
            lastPanelWatchAt: 0,
            lastProject: null,
            stopped: false,
            restarts: 0,
            lastRestart: null,
            pendingRestart: null
        };

        // Taking over from an agent of an earlier build that stopped ticking:
        // same id (so the same mailbox, and a server pinned to it keeps
        // working), same history file and list, same counters.
        if (previous.takeOver && previous.state) {
            var old = previous.state;
            var oldId = sanitizeId(old.id);
            if (oldId !== null) {
                state.id = oldId;
                state.idSource = (old.idSource === "env") ? "env" : "random";
            }
            if (typeof old.startedAt === "number") state.startedAt = old.startedAt;
            if (typeof old.served === "number") state.served = old.served;
            if (typeof old.refused === "number") state.refused = old.refused;
            if (typeof old.historyPath === "string") state.historyPath = old.historyPath;
            if (old.recent && typeof old.recent.length === "number") {
                for (var r = 0; r < old.recent.length; r++) state.recent.push(old.recent[r]);
            }
            if (typeof old.lastRequestAt === "number") state.lastRequestAt = old.lastRequestAt;
            var lastHb = (typeof old.lastHeartbeatAt === "number") ? old.lastHeartbeatAt : 0;
            state.pendingRestart = {
                source: "nuovo caricamento dello script di avvio",
                since: lastHb,
                project: (typeof old.lastProject === "string") ? old.lastProject : null
            };
        }

        function projectInfo() {
            var info = { project: null, projectName: null, dirty: false, numItems: 0 };
            try {
                var proj = app.project;
                info.dirty = !!proj.dirty;
                info.numItems = proj.numItems;
                if (proj.file) {
                    info.project = normalizePath(proj.file.fsName);
                    info.projectName = String(proj.file.displayName);
                }
            } catch (eProj) { /* project unreadable — report what we have */ }
            return info;
        }

        function heartbeat(force) {
            var now = new Date().getTime();
            if (!force && now - state.lastHeartbeatAt < HEARTBEAT_MS) return;
            if (state.dir === null) return;
            var info = projectInfo();
            state.lastProject = info.project;
            var hb = {
                id: state.id,
                idSource: state.idSource,
                agentVersion: state.agentVersion,
                aeVersion: app.version,
                project: info.project,
                projectName: info.projectName,
                dirty: info.dirty,
                numItems: info.numItems,
                startedAt: state.startedAt,
                ticks: state.ticks,
                served: state.served,
                refused: state.refused,
                paused: state.paused,
                readOnly: state.readOnly,
                lastRequestAt: state.lastRequestAt,
                pending: state.pending,
                recent: state.recent,
                busy: state.busy,
                busySince: state.busySince,
                lastError: state.lastError,
                restarts: state.restarts,
                lastRestart: state.lastRestart,
                modalErrors: state.modalErrors,
                lastModalErrorAt: state.lastModalErrorAt,
                ts: now
            };
            writeAtomic(state.dir + "/heartbeat.json", JSON.stringify(hb));
            state.lastHeartbeatAt = now;
        }

        /**
         * Add a request to `recent`. `undoable`: it ran to completion inside
         * an undo group and may have changed the project — so one Undo right
         * after reverts it (what the panel's "Annulla" button relies on).
         */
        function remember(summary, outcome, ms) {
            try {
                var label = cleanLabel(summary ? summary.label : null);
                var entry = {
                    t: state.lastRequestAt,
                    label: label,
                    title: (summary && typeof summary.title === "string") ? cleanLabel(summary.title, TITLE_MAX) : label,
                    outcome: outcome,
                    ms: ms,
                    undoable: !!(summary && outcome === "ok" && summary.mutates && summary.undoGroup)
                };
                writeHistory(entry);
                var next = [];
                var from = state.recent.length - (RECENT_MAX - 1);
                for (var i = (from > 0 ? from : 0); i < state.recent.length; i++) next.push(state.recent[i]);
                next.push(entry);
                state.recent = next;
            } catch (eRemember) { /* the list is a convenience; serving goes on */ }
        }

        /** One line per request in this session's history file. Never throws. */
        function writeHistory(entry) {
            try {
                if (state.historyPath === null) {
                    var dir = historyDir();
                    if (dir === null) return;
                    state.historyPath = dir + "/storico-" + stamp(new Date(state.startedAt)) + "-" + state.id + ".txt";
                    var head = new File(state.historyPath);
                    head.encoding = "UTF-8";
                    if (head.open("a")) {
                        head.writeln("Parlez! - storico delle richieste di Claude, istanza " + state.id +
                            ", After Effects " + app.version + ", aperto il " + new Date(state.startedAt).toString());
                        head.writeln("ora      | cosa | operazione | esito | durata");
                        head.close();
                    }
                }
                var f = new File(state.historyPath);
                f.encoding = "UTF-8";
                if (!f.open("a")) return;
                var words = OUTCOME_WORDS.hasOwnProperty(entry.outcome) ? OUTCOME_WORDS[entry.outcome] : entry.outcome;
                f.writeln(clock(new Date(entry.t)) + " | " + entry.title + " | " + entry.label + " | " + words +
                    " | " + seconds(entry.ms));
                f.close();
            } catch (eHistory) { /* the history is a convenience; serving goes on */ }
        }

        function countPending() {
            try {
                var files = new Folder(state.dir).getFiles("request-*.json");
                return files ? files.length : 0;
            } catch (eCount) {
                return 0;
            }
        }

        /**
         * Why the agent stopped, as far as it can tell: the project it had
         * open before the silence against the one open now. Anything else is
         * most likely a modal window (Save As, Revert's question, Import File):
         * those are what stop the timers on AE 26.5, and nothing more precise
         * can be read afterwards.
         */
        function restartCause(before, after) {
            if (after !== null && after !== before) return "dopo apertura progetto";
            if (after === null && before !== null) return "dopo chiusura progetto";
            return "dopo una finestra di dialogo";
        }

        /**
         * First step of a revived chain: the restart is real now, so say it -
         * one line in `recent` (the panel's list) and one in the history file.
         */
        function announceRestart(now) {
            var pr = state.pendingRestart;
            state.pendingRestart = null;
            var silentMs = (typeof pr.since === "number" && pr.since > 0) ? now - pr.since : 0;
            var cause = restartCause(pr.project, projectInfo().project);
            state.restarts++;
            state.lastRestart = { t: now, cause: cause, source: pr.source, silentMs: silentMs };
            var entry = {
                t: now,
                label: "riavvio",
                title: cleanLabel("Agente riavviato " + cause, TITLE_MAX),
                outcome: "restart",
                ms: silentMs,
                undoable: false,
                source: cleanLabel(pr.source)
            };
            writeHistory(entry);
            var next = [];
            var from = state.recent.length - (RECENT_MAX - 1);
            for (var i = (from > 0 ? from : 0); i < state.recent.length; i++) next.push(state.recent[i]);
            next.push(entry);
            state.recent = next;
        }

        /** The panel's timer, looked at about once a second. Never throws. */
        function watchPanel(now) {
            if (now - state.lastPanelWatchAt < PANEL_WATCH_MS) return;
            state.lastPanelWatchAt = now;
            try {
                var panel = $.global.AE_MCP_PANEL;
                if (panel && typeof panel.watch === "function") panel.watch("agente");
            } catch (ePanel) { /* the panel is closing; it is not ours to fix */ }
        }

        function tick() {
            // One request at a time, whatever re-enters this task.
            if (state.busy) return;
            try {
                var tickAt = new Date().getTime();
                state.lastTickAt = tickAt;
                state.ticks++;
                if (state.pendingRestart !== null) {
                    try { announceRestart(tickAt); } catch (eAnnounce) { state.pendingRestart = null; }
                    heartbeat(true);
                }
                watchPanel(tickAt);
                var paused = AE_MCP.isPaused();
                var readOnly = AE_MCP.isReadOnly();
                var switchChanged = (paused !== state.paused) || (readOnly !== state.readOnly);
                state.paused = paused;
                state.readOnly = readOnly;
                var dir = mailboxDir() + "/instances/" + state.id;
                if (dir !== state.dir) {
                    if (!ensureDir(dir)) return;
                    state.dir = dir;
                    heartbeat(true);
                }
                heartbeat(switchChanged);

                var pending = countPending();
                if (pending !== state.pending) {
                    state.pending = pending;
                    heartbeat(true);
                }
                var request = AE_MCP.oldestRequestIn(state.dir);
                if (request === null) return;

                state.busy = true;
                state.busySince = new Date().getTime();
                state.lastRequestAt = state.busySince;
                state.pending = (pending > 0) ? pending - 1 : 0;
                heartbeat(true);
                var summary = null;
                try {
                    summary = AE_MCP.serveRequest(request, state.dir, state.dir + "/agent.log");
                } finally {
                    var ms = new Date().getTime() - state.busySince;
                    state.busy = false;
                    state.busySince = null;
                    var outcome = (summary && typeof summary.outcome === "string") ? summary.outcome : "error";
                    if (outcome === "paused" || outcome === "readonly") state.refused++;
                    else state.served++;
                    remember(summary, outcome, ms);
                    heartbeat(true);
                }
            } catch (eTick) {
                state.lastError = describeError(eTick);
                try {
                    if (state.dir !== null) AE_MCP.appendLog(state.dir + "/agent.log", "tick failed: " + state.lastError);
                } catch (eLog) { /* ignore */ }
            }
        }

        /** Book the next step of the current chain. False when After Effects refused. */
        function book(delay) {
            state.taskId = null;
            try {
                state.taskId = app.scheduleTask("$.global.AE_MCP_AGENT.step(" + state.gen + ")", delay, false);
                return true;
            } catch (eBook) {
                state.lastError = "scheduleTask: " + describeError(eBook);
                return false;
            }
        }

        /** One step of chain `gen`: a step of an older chain ends here. */
        function step(gen) {
            if (gen !== state.gen || state.stopped) return;
            state.taskId = null;
            try {
                tick();
            } finally {
                // tick() may have been the one to revive (a request calling
                // in): then the new chain is already booked.
                if (gen === state.gen && !state.stopped) book(TICK_MS);
            }
        }

        /** No step for STALE_TICK_MS (counting from the last revive too), and no request running. */
        function isStale(now) {
            if (state.busy || state.stopped) return false;
            var last = (state.lastTickAt > state.lastReviveAt) ? state.lastTickAt : state.lastReviveAt;
            return now - last > STALE_TICK_MS;
        }

        /**
         * Start a new chain. `force` (the panel's Riavvia button) restarts
         * even a chain that looks alive, and one stopped on purpose; never
         * while a request runs. The restart is announced by its first step.
         */
        function revive(source, force) {
            var now = new Date().getTime();
            if (state.busy) return false;
            if (force !== true && !isStale(now)) return false;
            try { if (state.taskId !== null) app.cancelTask(state.taskId); } catch (eCancel) { /* already dropped */ }
            if (state.pendingRestart === null) {
                state.pendingRestart = {
                    source: (typeof source === "string" && source.length > 0) ? source : "?",
                    since: state.lastTickAt,
                    project: state.lastProject
                };
            }
            state.stopped = false;
            state.gen++;
            state.lastReviveAt = now;
            return book(1);
        }

        $.global.AE_MCP_AGENT = {
            state: state,
            tick: tick,
            step: step,
            revive: revive,
            /** Revive when stopped; a no-op while the agent ticks. True when it revived. */
            watch: function (source) {
                return revive(source, false);
            },
            /** Stop polling (mainly for tests and manual recovery); watch() leaves it stopped. */
            stop: function () {
                state.stopped = true;
                state.gen++;
                try {
                    if (state.taskId !== null) app.cancelTask(state.taskId);
                } catch (eCancel) { /* ignore */ }
                state.taskId = null;
            }
        };
        /**
         * After Effects hands script errors to app.onError when one is set.
         * The one error that is ours to expect - a step that came due under a
         * modal window, "Cannot run a script while a modal dialog is waiting
         * for response" - is noted and kept quiet: it is no news to the user,
         * who saw a popup at every heavy project opened, and the sveglia
         * (cep/sveglia) restarts the chain once the window is gone. Every
         * other error goes on as before: to the handler that was there, or,
         * with none, to an alert, which is what After Effects shows by default.
         */
        function installErrorGuard() {
            try {
                var previous = app.onError;
                if (previous && previous.parlez === true) return;
                var guard = function (errString) {
                    var text = "";
                    try { text = String(errString); } catch (eText) { text = ""; }
                    if (text.indexOf("modal dialog is waiting") >= 0) {
                        state.modalErrors++;
                        state.lastModalErrorAt = new Date().getTime();
                        return;
                    }
                    if (typeof previous === "function") return previous(errString);
                    alert(text);
                };
                guard.parlez = true;
                app.onError = guard;
            } catch (eGuard) { /* this After Effects has no app.onError */ }
        }
        state.modalErrors = 0;
        state.lastModalErrorAt = null;
        installErrorGuard();

        // Run once now so the instance is registered before the first
        // scheduled step, then keep going for the life of the process.
        tick();
        book(TICK_MS);
    }

    // --- Top-level guard ---------------------------------------------------
    // A startup script that throws surfaces as a modal at every launch of
    // every instance. Swallow, leave a breadcrumb where we can.
    try {
        agentMain();
    } catch (eTop) {
        try {
            var crumb = new File(runtimeRoot() + "/agent-fatal.log");
            crumb.encoding = "UTF-8";
            if (crumb.open("a")) {
                crumb.writeln("[" + new Date().toString() + "] FATAL: agent threw: " + describeError(eTop));
                crumb.close();
            }
        } catch (eSilent) { /* deliberately silent */ }
    }
})();
