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
// Where the panel is installed, the pause switch starts on "stopped": at
// startup, with no choice saved yet, the agent saves "0" itself. Before,
// only the panel did that, the first time it opened — so until someone
// opened it, Claude could work (seen on AE 26.5, 2026-10-25).
//
// The heartbeat also carries the last RECENT_MAX requests (time, label,
// outcome) and when the last one arrived, for the panel's "Ultime azioni".
// Labels are operation or tool names chosen by the server; the request's
// code and payload are never recorded.
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
    // 3: "Sola lettura" (`readOnly`), recent requests (`recent`, `lastRequestAt`), "stopped" by default where the panel is installed.
    var AGENT_VERSION = 3;
    var RECENT_MAX = 8;
    var LABEL_MAX = 60;
    // Mirrored in src/config.ts (PAUSE_SETTINGS_*, PANEL_FILENAME, LEGACY_PANEL_FILENAMES).
    var PANEL_FILENAMES = ["Parlez!.jsx", "Parlez (provvisorio).jsx"];
    var TICK_MS = 250;
    var HEARTBEAT_MS = 1000;

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

    /**
     * This After Effects version's user-level Scripts folder, derived the way
     * src/agent-install.ts derives it (that is where install-panel copies the
     * panel), or null. The version folder is app.version's major.minor
     * ("26.5x87" -> "26.5").
     */
    function userScriptsDir() {
        var m = /^(\d+\.\d+)/.exec(String(app.version));
        if (!m) return null;
        if (String($.os).indexOf("Windows") >= 0) {
            var appData = null;
            try { appData = $.getenv("APPDATA"); } catch (eEnv) { /* no env access */ }
            if (!appData) {
                try { appData = Folder.userData.fsName; } catch (eUd) { /* unknown */ }
            }
            if (!appData) return null;
            return normalizePath(appData) + "/Adobe/After Effects/" + m[1] + "/Scripts";
        }
        return "~/Library/Preferences/Adobe/After Effects/" + m[1] + "/Scripts";
    }

    function panelInstalled() {
        var scripts = userScriptsDir();
        if (scripts === null) return false;
        for (var i = 0; i < PANEL_FILENAMES.length; i++) {
            try {
                if (new File(scripts + "/ScriptUI Panels/" + PANEL_FILENAMES[i]).exists) return true;
            } catch (eExists) { /* keep looking */ }
        }
        return false;
    }

    /** Where the panel is installed and no choice is saved yet, save "stopped". */
    function defaultToStopped() {
        try {
            if (app.settings.haveSetting(AE_MCP.PAUSE_SECTION, AE_MCP.PAUSE_KEY)) return false;
            if (!panelInstalled()) return false;
            app.settings.saveSetting(AE_MCP.PAUSE_SECTION, AE_MCP.PAUSE_KEY, "0");
            return true;
        } catch (eDefault) {
            return false;
        }
    }

    /** A label fit for the panel: one line, bounded, never empty. */
    function cleanLabel(label) {
        if (typeof label !== "string" || label.length === 0) return "(senza nome)";
        var s = label.replace(/[\x00-\x1f\x7f]+/g, " ");
        if (s.length > LABEL_MAX) s = s.substring(0, LABEL_MAX - 3) + "...";
        return s;
    }

    function agentMain() {
        // One agent per process. A second evaluation (a `-r` run of this file,
        // a second stub) must not install a second poller: two tasks would
        // race over the same mailbox.
        if ($.global.AE_MCP_AGENT) return;
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
            pauseDefaulted: false,
            lastRequestAt: null,
            recent: [],
            busy: false,
            busySince: null,
            dir: null,
            taskId: null,
            lastHeartbeatAt: 0,
            lastError: null
        };

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
                recent: state.recent,
                busy: state.busy,
                busySince: state.busySince,
                lastError: state.lastError,
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
        function remember(summary, outcome) {
            try {
                var entry = {
                    t: state.lastRequestAt,
                    label: cleanLabel(summary ? summary.label : null),
                    outcome: outcome,
                    undoable: !!(summary && outcome === "ok" && summary.mutates && summary.undoGroup)
                };
                var next = [];
                var from = state.recent.length - (RECENT_MAX - 1);
                for (var i = (from > 0 ? from : 0); i < state.recent.length; i++) next.push(state.recent[i]);
                next.push(entry);
                state.recent = next;
            } catch (eRemember) { /* the list is a convenience; serving goes on */ }
        }

        function tick() {
            try {
                state.ticks++;
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

                var request = AE_MCP.oldestRequestIn(state.dir);
                if (request === null) return;

                state.busy = true;
                state.busySince = new Date().getTime();
                state.lastRequestAt = state.busySince;
                heartbeat(true);
                var summary = null;
                try {
                    summary = AE_MCP.serveRequest(request, state.dir, state.dir + "/agent.log");
                } finally {
                    state.busy = false;
                    state.busySince = null;
                    var outcome = (summary && typeof summary.outcome === "string") ? summary.outcome : "error";
                    if (outcome === "paused" || outcome === "readonly") state.refused++;
                    else state.served++;
                    remember(summary, outcome);
                    heartbeat(true);
                }
            } catch (eTick) {
                state.lastError = describeError(eTick);
                try {
                    if (state.dir !== null) AE_MCP.appendLog(state.dir + "/agent.log", "tick failed: " + state.lastError);
                } catch (eLog) { /* ignore */ }
            }
        }

        $.global.AE_MCP_AGENT = {
            state: state,
            tick: tick,
            /** Stop polling (mainly for tests and manual recovery). */
            stop: function () {
                try {
                    if (state.taskId !== null) app.cancelTask(state.taskId);
                } catch (eCancel) { /* ignore */ }
                state.taskId = null;
            }
        };
        state.pauseDefaulted = defaultToStopped();
        // Run once now so the instance is registered before the first
        // scheduled tick, then keep going for the life of the process.
        tick();
        state.taskId = app.scheduleTask("$.global.AE_MCP_AGENT.tick()", TICK_MS, true);
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
