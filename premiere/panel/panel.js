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
  var ROWS = 8;
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
    for (var i = recent.length - 1; i >= 0 && lines.length < ROWS; i--) {
      var e = recent[i];
      if (!e || typeof e.t !== "number") continue;
      var what = typeof e.title === "string" ? e.title : String(e.label);
      var mark = Object.prototype.hasOwnProperty.call(OUTCOME_MARK, e.outcome)
        ? OUTCOME_MARK[e.outcome]
        : String(e.outcome);
      var tail = e.outcome === "ok" || e.outcome === "error" ? "  " + seconds(e.ms) : "";
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
      "images/" + state.look + variant + ".png",
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
    waitingSince = Date.now();
    cep.evalScript(script, function (result) {
      waitingSince = 0;
      agent = parse(result);
      refresh();
      window.setTimeout(tick, TICK_MS);
    });
  }

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
