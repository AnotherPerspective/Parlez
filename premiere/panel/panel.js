// Parlez! for Premiere Pro - the panel.
//
// It is both the switch and the agent. Every quarter of a second it asks
// Premiere's script engine to run one tick of jsx/premiere-agent.jsx
// (PARLEZ_PR.tick), handing it the two switches; the tick refreshes the
// heartbeat, serves at most one request from Claude, and answers with what
// this panel shows. Closed panel = no ticks = Claude stopped.
//
// The switches live here, in the panel's own storage (Premiere has no
// app.settings): with no choice saved, Claude is OFF.
//
// Same look and words as the After Effects panel (jsx/panel.jsx): the big
// ON/OFF picture is also the traffic light - green waiting, yellow working,
// red OFF, grey not connected.
//
// No Node.js and no network: the manifest does not enable Node, and the only
// thing this page does outside itself is evalScript into Premiere.

(function () {
  "use strict";

  var TICK_MS = 250;
  // A tick that has not come back after this long means Premiere is busy
  // running a request (or something else).
  var SLOW_TICK_MS = 700;
  // A tick whose answer has not come this long after may have been dropped by
  // Premiere (on After Effects a script sent as a modal window opens was
  // dropped with no answer, 2026-11-15): a cheap ping then tells "busy" from
  // "lost". The giro used to restart only from the answer, so one lost answer
  // stopped it for good.
  var LOST_AFTER_MS = 5000;
  var TITLE_CHARS = 30;
  var KEY_ENABLED = "parlez.claudeEnabled";
  var KEY_READ_ONLY = "parlez.readOnly";
  var SITE_URL = "https://www.anotherperspectivepictures.com";
  var OUTCOME_MARK = {
    ok: "✓",
    error: "✗",
    paused: "rifiutata (pausa)",
    readonly: "rifiutata (sola lettura)",
  };

  var cep = window.__adobe_cep__;
  var el = {
    block: document.getElementById("block"),
    img: document.getElementById("block-img"),
    status: document.getElementById("status"),
    readOnly: document.getElementById("read-only"),
    rows: document.getElementById("rows"),
    mailbox: document.getElementById("mailbox"),
    checkpoint: document.getElementById("checkpoint"),
    checkpointFolder: document.getElementById("checkpoint-folder"),
    history: document.getElementById("history"),
    undo: document.getElementById("undo"),
    notice: document.getElementById("notice"),
    counts: document.getElementById("counts"),
    credit: document.getElementById("credit"),
  };

  // --- Switches (the panel's own storage) -----------------------------
  function readFlag(key) {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  function writeFlag(key, on) {
    try {
      window.localStorage.setItem(key, on ? "1" : "0");
      return window.localStorage.getItem(key) === (on ? "1" : "0");
    } catch {
      return false;
    }
  }

  // --- What to show ----------------------------------------------------
  function pad2(n) {
    return (n < 10 ? "0" : "") + String(n);
  }

  function clock(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function seconds(ms) {
    if (typeof ms !== "number" || ms < 0) return "";
    if (ms < 10000) return String(Math.round(ms / 100) / 10).replace(".", ",") + " s";
    return String(Math.round(ms / 1000)) + " s";
  }

  function shorten(value, max) {
    var s = String(value);
    return s.length > max ? s.substring(0, max - 1) + "…" : s;
  }

  function blockFor(enabled, readOnly, agent, slow) {
    var ro = readOnly ? " · sola lettura" : "";
    if (!enabled) {
      return {
        look: "off",
        status: "Claude fermo",
        tip: "Claude non può toccare Premiere Pro: ogni sua richiesta viene rifiutata.",
      };
    }
    if (agent === null) {
      return {
        look: "idle",
        status: "non collegato",
        tip:
          "La parte di Parlez! che lavora dentro Premiere non si è caricata. " +
          "Rilancia parlez setup, poi chiudi e riapri il pannello.",
      };
    }
    if (slow || agent.busy) {
      return {
        look: "busy",
        status: "sta elaborando" + ro,
        tip: "Claude sta eseguendo una richiesta.",
      };
    }
    if (agent.pending > 0) {
      return {
        look: "busy",
        status: "sta ricevendo" + ro,
        tip: "Ci sono richieste di Claude in arrivo.",
      };
    }
    return {
      look: "on",
      status: "in attesa" + ro,
      tip:
        "Claude può lavorare in Premiere Pro" +
        (readOnly ? ", ma solo guardando: non modifica il progetto" : "") +
        ".",
    };
  }

  function historyLines(recent) {
    var lines = [];
    for (var i = recent.length - 1; i >= 0; i--) {
      var e = recent[i];
      if (!e || typeof e.t !== "number") continue;
      var what = typeof e.title === "string" ? e.title : String(e.label);
      var mark = Object.prototype.hasOwnProperty.call(OUTCOME_MARK, e.outcome)
        ? OUTCOME_MARK[e.outcome]
        : String(e.outcome);
      var tail = e.outcome === "ok" || e.outcome === "error" ? "  " + seconds(e.ms) : "";
      if (e.undone === true) {
        mark = "annullata";
        tail = "";
      }
      lines.push(clock(e.t) + "  " + shorten(what, TITLE_CHARS) + "  " + mark + tail);
    }
    return lines;
  }

  // --- Painting: only what changed -------------------------------------
  var shown = {};
  var hover = false;
  var pressed = false;

  function put(key, apply, value) {
    if (Object.prototype.hasOwnProperty.call(shown, key) && shown[key] === value) return;
    shown[key] = value;
    apply(value);
  }

  function paint(state, readOnly, agent) {
    var variant = pressed ? "-down" : hover ? "-over" : "";
    put(
      "img",
      function (v) {
        el.img.src = v;
      },
      // The small set, as in After Effects' panel: the same picture, pixel
      // for pixel, at the same 200 points (2026-11-15).
      "images/" + state.look + variant + "-small.png",
    );
    put(
      "alt",
      function (v) {
        el.img.alt = v;
      },
      state.look === "off" ? "OFF" : "ON",
    );
    put(
      "status",
      function (v) {
        el.status.textContent = v;
      },
      state.status,
    );
    put(
      "tip",
      function (v) {
        el.status.title = v;
      },
      state.tip,
    );
    put(
      "readOnly",
      function (v) {
        el.readOnly.checked = v;
      },
      readOnly,
    );

    var lines = historyLines(agent !== null ? agent.recent || [] : []);
    if (lines.length === 0) lines.push("Nessuna richiesta in questa sessione.");
    put(
      "rows",
      function () {
        el.rows.textContent = "";
        for (var i = 0; i < lines.length; i++) {
          var li = document.createElement("li");
          li.textContent = lines[i];
          el.rows.appendChild(li);
        }
      },
      lines.join("\n"),
    );

    var counts = "";
    if (agent !== null) {
      var since =
        typeof agent.lastRequestAt === "number" && agent.lastRequestAt > 0
          ? "ultima " + Math.round((Date.now() - agent.lastRequestAt) / 1000) + " s fa"
          : "nessuna richiesta";
      counts =
        "eseguite " +
        agent.served +
        " · rifiutate " +
        agent.refused +
        " · " +
        since +
        " · " +
        agent.id +
        " v" +
        agent.agentVersion;
    }
    put(
      "counts",
      function (v) {
        el.counts.textContent = v;
      },
      counts,
    );
    put(
      "mailbox",
      function (v) {
        el.mailbox.disabled = !v;
      },
      agent !== null,
    );
    var undoable = false;
    var recent = agent !== null ? agent.recent || [] : [];
    for (var i = 0; i < recent.length; i++)
      if (recent[i] && recent[i].undoable === true) undoable = true;
    put(
      "undo",
      function (v) {
        el.undo.disabled = !v;
        if (!v) disarmUndo();
      },
      undoable,
    );
  }

  function say(message) {
    el.notice.textContent = message;
  }

  // --- The tick loop ----------------------------------------------------
  var agent = null;
  var waitingSince = 0;

  function parse(text) {
    try {
      var v = JSON.parse(text);
      return v && v.ok === true && typeof v.id === "string" ? v : null;
    } catch {
      return null;
    }
  }

  function refresh() {
    var enabled = readFlag(KEY_ENABLED);
    var readOnly = readFlag(KEY_READ_ONLY);
    var slow = waitingSince > 0 && Date.now() - waitingSince > SLOW_TICK_MS;
    paint(blockFor(enabled, readOnly, agent, slow), readOnly, agent);
  }

  function tick() {
    if (!cep || typeof cep.evalScript !== "function") {
      agent = null;
      refresh();
      say("Questo pannello funziona solo dentro Premiere Pro.");
      return;
    }
    var script =
      "(typeof PARLEZ_PR === 'object' && PARLEZ_PR) ? PARLEZ_PR.tick(" +
      (readFlag(KEY_ENABLED) ? "true" : "false") +
      ", " +
      (readFlag(KEY_READ_ONLY) ? "true" : "false") +
      ") : 'missing'";
    var mine = ++tickGen;
    waitingSince = Date.now();
    cep.evalScript(script, function (result) {
      // An answer that comes after its tick was given up for lost: the new
      // giro is already running, this one ends here.
      if (mine !== tickGen) return;
      waitingSince = 0;
      agent = parse(result);
      if (result === "missing") reloadAgent();
      else missingSince = 0;
      refresh();
      window.setTimeout(tick, TICK_MS);
    });
  }

  // The agent gone from Premiere's script engine (the engine was reset): load
  // the host stub again, as opening the panel does. This replaces a "Riavvia"
  // button: the giro restarts by itself (watchdog below), and so does the
  // agent. At most once every RELOAD_MS.
  var RELOAD_AFTER_MS = 2000;
  var RELOAD_MS = 10000;
  var missingSince = 0;
  var reloadedAt = 0;
  function reloadAgent() {
    var now = Date.now();
    if (missingSince === 0) missingSince = now;
    if (now - missingSince < RELOAD_AFTER_MS || now - reloadedAt < RELOAD_MS) return;
    reloadedAt = now;
    var root = "";
    try {
      root = cep.getSystemPath("extension");
    } catch {
      return;
    }
    if (typeof root !== "string" || root.length === 0) return;
    // A path, not code: JSON.stringify quotes and escapes it.
    // "file:///C:/..." on Windows, "file:///Users/..." on a Mac.
    var folder = decodeURI(root)
      .replace(/^file:\/\//, "")
      .replace(/^\/([A-Za-z]:)/, "$1");
    var stub = JSON.stringify(folder + "/host/parlez-stub.jsx");
    cep.evalScript(
      "try { $.evalFile(new File(" + stub + ")); 'ok'; } catch (e) { 'fail'; }",
      function () {},
    );
  }

  // The watchdog. Premiere runs scripts one at a time, in order: if the ping
  // is answered while the tick is still unanswered, the tick's answer is
  // lost (a long request would have answered first) - start the giro again.
  var tickGen = 0;
  var pingSince = 0;
  function watchdog() {
    var now = Date.now();
    if (waitingSince === 0 || now - waitingSince < LOST_AFTER_MS) return;
    if (pingSince !== 0 && now - pingSince < LOST_AFTER_MS) return;
    if (!cep || typeof cep.evalScript !== "function") return;
    var gen = tickGen;
    pingSince = now;
    cep.evalScript("1", function () {
      pingSince = 0;
      if (gen === tickGen && waitingSince !== 0) tick();
    });
  }
  window.setInterval(watchdog, 1000);

  // While a tick is out, keep the light honest (yellow when Premiere is busy).
  window.setInterval(refresh, 500);

  // --- Controls ---------------------------------------------------------
  el.block.addEventListener("click", function () {
    var on = !readFlag(KEY_ENABLED);
    say(writeFlag(KEY_ENABLED, on) ? "" : "Non riesco a salvare la scelta.");
    el.block.blur();
    refresh();
  });
  el.block.addEventListener("mouseenter", function () {
    hover = true;
    refresh();
  });
  el.block.addEventListener("mouseleave", function () {
    hover = false;
    pressed = false;
    refresh();
  });
  el.block.addEventListener("mousedown", function () {
    pressed = true;
    refresh();
  });
  el.block.addEventListener("mouseup", function () {
    pressed = false;
    refresh();
  });
  el.readOnly.addEventListener("change", function () {
    say(writeFlag(KEY_READ_ONLY, el.readOnly.checked) ? "" : "Non riesco a salvare la scelta.");
    refresh();
  });
  // Annulla: two clicks, the first arms it. A confirm() dialog is not
  // reliable inside a CEP panel, and an undo the user did not mean is
  // exactly what this button must not do.
  var undoArmedUntil = 0;
  var UNDO_ARM_MS = 4000;
  function disarmUndo() {
    undoArmedUntil = 0;
    el.undo.textContent = "Annulla";
  }
  el.undo.addEventListener("click", function () {
    if (!cep) return;
    if (Date.now() > undoArmedUntil) {
      undoArmedUntil = Date.now() + UNDO_ARM_MS;
      el.undo.textContent = "Conferma?";
      say("Clicca di nuovo per annullare l'ultima modifica di Claude (tutta la richiesta).");
      window.setTimeout(function () {
        if (Date.now() > undoArmedUntil) disarmUndo();
      }, UNDO_ARM_MS + 50);
      return;
    }
    disarmUndo();
    cep.evalScript("PARLEZ_PR.undoLast()", function (r) {
      var res = null;
      try {
        res = JSON.parse(r);
      } catch {
        res = null;
      }
      if (res === null) say("Annullamento non riuscito.");
      else if (res.ok !== true) say(String(res.error || "Annullamento non riuscito."));
      else if (res.failed && res.failed.length > 0) {
        say("Annullato in parte: " + res.failed.length + " passi non sono tornati indietro.");
      } else say("Annullata l'ultima modifica di Claude.");
    });
  });
  el.checkpoint.addEventListener("click", function () {
    if (!cep) return;
    cep.evalScript("PARLEZ_PR.checkpoint()", function (r) {
      try {
        var res = JSON.parse(r);
        say(typeof res.message === "string" ? res.message : "Punto di ripristino non riuscito.");
      } catch {
        say("Punto di ripristino non riuscito: aggiorna Parlez! (parlez setup).");
      }
    });
  });
  el.checkpointFolder.addEventListener("click", function () {
    if (!cep) return;
    cep.evalScript("PARLEZ_PR.openCheckpoints()", function (r) {
      if (r === "nosave") say("Il progetto non è ancora stato salvato.");
      else if (r === "missing") say("Nessun punto di ripristino per questo progetto, per ora.");
      else if (r !== "ok") say("Non riesco ad aprire la cartella dei punti di ripristino.");
    });
  });
  el.history.addEventListener("click", function () {
    if (!cep) return;
    cep.evalScript("PARLEZ_PR.openHistory()", function (r) {
      if (r === "missing") say("Nessuna richiesta registrata finora.");
      else if (r !== "ok") say("Non riesco ad aprire lo storico.");
    });
  });
  el.mailbox.addEventListener("click", function () {
    if (!cep) return;
    cep.evalScript("PARLEZ_PR.openMailbox()", function (r) {
      if (r === "missing") say("La cassetta non c'è ancora.");
      else if (r !== "ok") say("Non riesco ad aprire la cassetta.");
    });
  });
  // The user opening a page in their own browser, as a link in any document
  // would: this program connects nowhere.
  el.credit.addEventListener("click", function (event) {
    event.preventDefault();
    try {
      window.cep.util.openURLInDefaultBrowser(SITE_URL);
    } catch {
      /* stays plain text */
    }
  });

  refresh();
  tick();
})();
