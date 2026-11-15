// Parlez! "sveglia" (name provisional): the beat of the Parlez! agent, from
// outside After Effects' scripting engine.
//
// Why it exists. On After Effects 26.5 / Windows a scripting timer
// (app.scheduleTask) that comes due while a modal window is up - the
// project-loading window, the Home screen at startup, Open / Import File,
// Save As - fails with "Cannot run a script while a modal dialog is waiting
// for response": After Effects shows that error and drops every scripting
// timer of the session. The Parlez! agent and panel ran on those timers, so
// the user saw an error at every heavy project opened and Parlez! stopped
// (2026-11-14/15). As long as a timer of ours is booked inside After Effects,
// one will come due under a modal window sooner or later.
//
// So the beat comes from here, and nothing is booked inside After Effects.
// This page runs in CEP's own browser engine, which modal windows do not
// stop. A small PowerShell loop tells it whether After Effects' main window
// takes input (a modal window disables it). While it does, four times a
// second, the page calls AE_MCP_AGENT.pulse(): one step of the agent (serve a
// waiting request, write the heartbeat), which also refreshes the panel.
// While a modal window is up nothing is sent at all. Without the window
// check (not Windows, PowerShell missing) it pulses anyway and backs off
// after a refused call.
//
// What it touches: one PowerShell process that reads, every 50 ms, whether
// After Effects' main window is enabled (read-only, Windows only), and the
// fixed lines in PULSE sent to After Effects. No window, no network, no
// files, never the project.

(function () {
  var PULSE_MS = 250;
  // A pulse may serve a long request (a render): its answer can take minutes.
  // One whose answer never came is given up after this (the server's own
  // limit for a busy agent, HEARTBEAT_BUSY_STALE_MS).
  var GIVE_UP_MS = 15 * 60000;
  var BACKOFF_MAX_MS = 60000;
  // After the main window comes back, let After Effects settle first.
  var SETTLE_MS = 300;

  // Fixed ExtendScript, the same every time: nothing variable is spliced in.
  // An agent of an earlier build (no pulse) is only asked to check itself.
  var PULSE =
    "(function () {" +
    "  try {" +
    "    var a = $.global.AE_MCP_AGENT;" +
    "    if (a && typeof a.pulse === 'function') return a.pulse();" +
    "    if (a && typeof a.watch === 'function') { a.watch('sveglia'); return 'vecchio|'; }" +
    "    return 'assente|';" +
    "  } catch (e) { return 'errore|'; }" +
    "}())";

  var cep = window.__adobe_cep__;
  if (!cep || typeof cep.evalScript !== "function") return;

  // --- Is After Effects' main window free? ------------------------------------
  // null: unknown (no watcher) - pulse and rely on the back-off.
  var free = null;
  var freeSince = 0;

  function startWatcher() {
    if (typeof require !== "function") return;
    var childProcess = require("child_process");
    if (process.platform !== "win32") return;
    // This page's process is a child of the CEP engine, itself a child of
    // AfterFX.exe: that is the window to watch.
    var ps =
      "$ErrorActionPreference='SilentlyContinue'; " +
      "Add-Type -Namespace PZ -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowEnabled(System.IntPtr h);'; " +
      "$ae=(Get-CimInstance Win32_Process -Filter 'ProcessId=" +
      Number(process.ppid) +
      "').ParentProcessId; " +
      "$last=''; $h=[IntPtr]::Zero; $n=0; " +
      "while ($true) { " +
      "  if ($n % 40 -eq 0) { $p=Get-Process -Id $ae; if (-not $p) { exit } $h=$p.MainWindowHandle } " +
      "  $n++; " +
      "  $s = if ($h -ne [IntPtr]::Zero -and [PZ.U]::IsWindowEnabled($h)) { 'free' } else { 'held' }; " +
      "  if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last=$s } " +
      "  Start-Sleep -Milliseconds 50 " +
      "}";
    var child = childProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      {
        windowsHide: true,
      },
    );
    var buffer = "";
    child.stdout.on("data", function (chunk) {
      buffer += String(chunk);
      var lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === "free" && free !== true) {
          free = true;
          freeSince = Date.now();
        } else if (line === "held") {
          free = false;
        }
      }
    });
    child.on("exit", function () {
      free = null;
    });
    window.addEventListener("beforeunload", function () {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
  }

  // --- The beat ---------------------------------------------------------------
  var askedAt = 0;
  var nextTryAt = 0;
  var backoff = PULSE_MS;

  function beat() {
    var now = Date.now();
    if (askedAt !== 0 && now - askedAt < GIVE_UP_MS) return;
    if (now < nextTryAt) return;
    if (free === false) return;
    if (free === true && now - freeSince < SETTLE_MS) return;
    askedAt = now;
    cep.evalScript(PULSE, function (answer) {
      askedAt = 0;
      var text = String(answer || "");
      if (text.indexOf("|") < 0) {
        // Refused: wait longer each time.
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        nextTryAt = Date.now() + backoff;
        return;
      }
      backoff = PULSE_MS;
      // No agent yet (the startup script still loading): look again later.
      if (text.indexOf("assente|") === 0) nextTryAt = Date.now() + 2000;
    });
  }

  try {
    startWatcher();
  } catch {
    free = null;
  }
  setInterval(beat, PULSE_MS);
})();
