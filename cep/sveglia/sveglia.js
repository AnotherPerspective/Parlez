// Parlez! "sveglia" (name provisional): the clock that After Effects' modal
// windows cannot stop.
//
// Why it exists. On After Effects 26.5 / Windows a scripting timer
// (app.scheduleTask) that comes due while certain modal windows are up - the
// project-loading window, the Home screen at startup, Open / Import File -
// fails with "Cannot run a script while a modal dialog is waiting for
// response", and After Effects then drops every scripting timer of the
// session. The Parlez! agent and panel run on those timers, so they stopped
// for good; inside After Effects only an event in the panel (a click, a
// resize) brought them back. See "Staying alive" in jsx/agent.jsx.
//
// This page runs in CEP's own browser engine, whose timers After Effects does
// not touch. Once a second it looks - from outside After Effects - at the
// agent's heartbeat file. Only when the heartbeat has stopped, and After
// Effects' main window is not held by a modal window, does it ask the agent
// (and the panel's timer) to restart: AE_MCP_AGENT.watch() and
// AE_MCP_PANEL.watch(), which do nothing when they are alive.
//
// Why so careful: every script After Effects refuses because of a modal
// window becomes an error popup. A first build asked every second and, with
// the Home screen open, the user got a popup every three seconds
// (2026-11-15). So: never ask while the agent beats; never ask while the main
// window is disabled (that is what a modal window does to it, on Windows);
// and after a refusal wait longer each time (2, 4, 8 ... 60 s).
//
// What it touches: reads heartbeat.json in Parlez!'s mailbox, runs one
// PowerShell line that reads whether After Effects' window is enabled (Windows
// only, read-only), and sends After Effects the fixed lines in CHECK. No
// window, no network, no other files, never the project.

(function () {
  var PERIOD_MS = 1000;
  // The agent writes its heartbeat every second.
  var STALE_MS = 3000;
  var BACKOFF_MIN_MS = 2000;
  var BACKOFF_MAX_MS = 60000;
  // A call whose answer never came (After Effects stuck) is given up after this.
  var GIVE_UP_MS = 15000;

  // Fixed ExtendScript, the same every time: nothing variable is spliced in.
  // Answers "<state>|<agent id>".
  var CHECK =
    "(function () {" +
    "  var out = 'assente', id = '';" +
    "  try {" +
    "    var a = $.global.AE_MCP_AGENT;" +
    "    if (a && a.state) id = String(a.state.id);" +
    "    if (a && typeof a.watch === 'function') out = a.watch('sveglia') === true ? 'riavviato' : 'vivo';" +
    "    else if (a) out = 'vecchio';" +
    "  } catch (e1) { out = 'errore'; }" +
    "  try {" +
    "    var p = $.global.AE_MCP_PANEL;" +
    "    if (p && typeof p.watch === 'function') p.watch('sveglia');" +
    "  } catch (e2) { /* a panel that is closing */ }" +
    "  return out + '|' + id;" +
    "}())";

  var cep = window.__adobe_cep__;
  if (!cep || typeof cep.evalScript !== "function") return;
  if (typeof require !== "function") return;

  var fs = require("fs");
  var path = require("path");
  var os = require("os");
  var childProcess = require("child_process");

  var MAILBOX = path.join(os.tmpdir(), "mcp-aftereffects", "runtime", "instances");
  var isWindows = process.platform === "win32";

  var agentId = null;
  var busyUntil = 0; // a call or a check in flight
  var nextTryAt = 0;
  var backoff = BACKOFF_MIN_MS;
  var aePid = null;

  /** Age of our agent's heartbeat in ms, or -1 when unknown; busy counts as fresh. */
  function heartbeatAge() {
    if (agentId === null) return -1;
    try {
      var hb = JSON.parse(fs.readFileSync(path.join(MAILBOX, agentId, "heartbeat.json"), "utf8"));
      if (hb.busy === true) return 0;
      return Date.now() - Number(hb.ts);
    } catch {
      return -1;
    }
  }

  /**
   * After Effects' own pid: this page's process is a child of the CEP engine,
   * itself a child of AfterFX.exe. Looked up once. Windows only.
   */
  function findAePid(done) {
    if (aePid !== null || !isWindows) return done();
    var ps =
      "$p=(Get-CimInstance Win32_Process -Filter 'ProcessId=" +
      Number(process.ppid) +
      "').ParentProcessId; " +
      "if ((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName -eq 'AfterFX') { $p }";
    childProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 10000 },
      function (err, out) {
        var n = parseInt(String(out || "").trim(), 10);
        if (!err && n > 0) aePid = n;
        done();
      },
    );
  }

  /** done(true) when After Effects' main window takes input (no modal window over it). */
  function windowFree(done) {
    if (!isWindows || aePid === null) return done(true);
    var ps =
      "Add-Type -Namespace PZ -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowEnabled(System.IntPtr h);'; " +
      "$h=(Get-Process -Id " +
      Number(aePid) +
      " -ErrorAction SilentlyContinue).MainWindowHandle; " +
      "if ($h -and $h -ne 0) { [PZ.U]::IsWindowEnabled($h) } else { 'False' }";
    childProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 10000 },
      function (err, out) {
        done(!err && String(out || "").trim() === "True");
      },
    );
  }

  function ask() {
    busyUntil = Date.now() + GIVE_UP_MS;
    cep.evalScript(CHECK, function (answer) {
      busyUntil = 0;
      var text = String(answer || "");
      var bar = text.indexOf("|");
      if (bar < 0) {
        // Refused (a modal window after all): wait longer each time.
        nextTryAt = Date.now() + backoff;
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        return;
      }
      backoff = BACKOFF_MIN_MS;
      var id = text.substring(bar + 1);
      if (id.length > 0) agentId = id;
      // No agent yet (the startup script still loading): look again later.
      if (text.substring(0, bar) === "assente") nextTryAt = Date.now() + 5000;
    });
  }

  function tick() {
    var now = Date.now();
    if (now < busyUntil || now < nextTryAt) return;
    var age = heartbeatAge();
    if (age >= 0 && age < STALE_MS) return;
    busyUntil = now + GIVE_UP_MS;
    findAePid(function () {
      windowFree(function (free) {
        busyUntil = 0;
        if (free) ask();
      });
    });
  }

  setInterval(tick, PERIOD_MS);
})();
