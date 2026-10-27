// Parlez! - diagnostica dello sgancio, variante D (nome provvisorio).
//
// Bisection step 2: variant C plus a repeating timer (app.scheduleTask every
// 1.5 s, like jsx/panel.jsx) that changes ONE text and nothing else - no
// layout, no size. If C undocks correctly and D collapses, the timer is the
// cause.
//
// Keep this file ES3.

(function diagnosticaSgancioD(thisObj) {
    var BLOCK_SIZE = [320, 88];
    var REFRESH_MS = 1500;

    function imageDir() {
        try {
            var here = new File($.fileName).parent;
            var installed = new File(here.fsName + "/Parlez!.jsx");
            if (installed.exists && installed.open("r")) {
                var src = installed.read();
                installed.close();
                var m = /var IMAGE_DIR = '([^']*)'/.exec(src);
                if (m) return m[1];
            }
            return here.fsName + "/panel-images";
        } catch (eDir) {
            return null;
        }
    }

    function picture(dir, look) {
        var base = dir + "/" + look;
        return ScriptUI.newImage(base + ".png", base + ".png", base + "-down.png", base + "-over.png");
    }

    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var w = isPanel ? thisObj : new Window("palette", "Prova sgancio D", undefined, { resizeable: true });
    w.orientation = "column";
    w.alignChildren = ["left", "top"];
    w.margins = 12;
    w.preferredSize = [344, 220];
    w.minimumSize = [344, 220];
    w.add("statictext", undefined, "Prova sgancio D: C + timer");
    var sizeText = w.add("statictext", undefined, "misura: ?");
    sizeText.preferredSize = [260, 20];
    var tickText = w.add("statictext", undefined, "timer: 0");
    tickText.preferredSize = [260, 20];

    var dir = imageDir();
    if (dir !== null && new File(dir + "/on.png").exists) {
        var images = { on: picture(dir, "on"), off: picture(dir, "off") };
        var block = w.add("iconbutton", undefined, images.on, { style: "toolbutton" });
        block.alignment = ["center", "top"];
        block.preferredSize = BLOCK_SIZE;
        block.minimumSize = BLOCK_SIZE;
        block.maximumSize = BLOCK_SIZE;
        var showingOn = true;
        block.onClick = function () {
            showingOn = !showingOn;
            block.image = showingOn ? images.on : images.off;
        };
    } else {
        w.add("statictext", undefined, "Immagini non trovate: installare prima il pannello Parlez!");
    }

    function showSize() {
        try {
            sizeText.text = "misura: " + String(w.size[0]) + " x " + String(w.size[1]);
        } catch (eSize) { /* not laid out yet */ }
    }

    w.onResizing = w.onResize = function () {
        this.layout.resize();
        showSize();
    };
    w.layout.layout(true);
    showSize();

    // One timer per session; it stops itself once the text is gone.
    try {
        var old = $.global.PARLEZ_DIAG_D;
        if (old && old.taskId !== null) app.cancelTask(old.taskId);
    } catch (eOld) { /* nothing to cancel */ }
    var ticks = 0;
    $.global.PARLEZ_DIAG_D = {
        taskId: null,
        tick: function () {
            try {
                ticks++;
                tickText.text = "timer: " + String(ticks);
            } catch (eTick) {
                try { app.cancelTask($.global.PARLEZ_DIAG_D.taskId); } catch (eCancel) { /* gone */ }
            }
        }
    };
    $.global.PARLEZ_DIAG_D.taskId = app.scheduleTask("$.global.PARLEZ_DIAG_D.tick()", REFRESH_MS, true);

    if (!isPanel) {
        w.onClose = function () {
            try { app.cancelTask($.global.PARLEZ_DIAG_D.taskId); } catch (eClose) { /* gone */ }
        };
        w.center();
        w.show();
    }
})(this);
