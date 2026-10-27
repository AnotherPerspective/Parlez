// Parlez! - diagnostica dello sgancio, variante E (nome provvisorio).
//
// Bisection step 3: variant D plus the whole structure of jsx/panel.jsx -
// the same groups with the same sizes, margins, colours and fonts, the
// read-only checkbox, the history box with its lines, the two rows of three
// buttons, the counters and the signature in its "fill" group - with no
// logic behind any of it. If D undocks correctly and E collapses, the cause
// is in the structure; if E undocks too, it is in the panel's logic.
//
// Keep this file ES3.

(function diagnosticaSgancioE(thisObj) {
    var BLOCK_SIZE = [320, 88];
    var REFRESH_MS = 1500;
    var BUTTON_WIDTH = 100;
    var BG = [0.18, 0.18, 0.18];
    var SECTION_BG = [0.21, 0.21, 0.21];
    var TEXT = [0.86, 0.86, 0.86];
    var DIM = [0.55, 0.55, 0.55];

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

    function setFont(ctrl, style, size) {
        try { ctrl.graphics.font = ScriptUI.newFont("Tahoma", style, size); } catch (eFont) { /* default */ }
    }

    function setTextColor(ctrl, rgb) {
        try {
            ctrl.graphics.foregroundColor = ctrl.graphics.newPen(ctrl.graphics.PenType.SOLID_COLOR, rgb, 1);
        } catch (eColor) { /* default */ }
    }

    function setFill(ctrl, rgb) {
        try {
            ctrl.graphics.backgroundColor = ctrl.graphics.newBrush(ctrl.graphics.BrushType.SOLID_COLOR, [rgb[0], rgb[1], rgb[2], 1]);
        } catch (eFill) { /* no fill */ }
    }

    function text(parent, value, size, color) {
        var t = parent.add("statictext", undefined, value);
        t.alignment = ["fill", "center"];
        setFont(t, "REGULAR", size);
        setTextColor(t, color);
        return t;
    }

    function row(parent) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["fill", "center"];
        g.alignment = ["fill", "top"];
        g.spacing = 4;
        g.minimumSize = [3 * BUTTON_WIDTH + 8, 26];
        return g;
    }

    function button(parent, label) {
        var b = parent.add("button", undefined, label);
        b.alignment = ["fill", "center"];
        b.preferredSize.width = BUTTON_WIDTH;
        return b;
    }

    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var w = isPanel ? thisObj : new Window("palette", "Prova sgancio E", undefined, { resizeable: true });
    setFill(w, BG);
    w.orientation = "column";
    w.alignChildren = ["fill", "top"];
    w.spacing = 8;
    w.margins = 12;
    w.minimumSize = [344, 440];
    w.preferredSize = [344, 440];

    // Block, status, read-only.
    var head = w.add("group");
    head.orientation = "column";
    head.alignChildren = ["fill", "top"];
    head.spacing = 6;
    head.minimumSize = [BLOCK_SIZE[0], BLOCK_SIZE[1] + 52];
    head.preferredSize = [BLOCK_SIZE[0], BLOCK_SIZE[1] + 52];
    var dir = imageDir();
    if (dir !== null && new File(dir + "/on.png").exists) {
        var images = { on: picture(dir, "on"), off: picture(dir, "off") };
        var block = head.add("iconbutton", undefined, images.on, { style: "toolbutton" });
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
        text(head, "Immagini non trovate: installare prima il pannello Parlez!", 11, TEXT);
    }
    var status = head.add("statictext", undefined, "Prova sgancio E: struttura completa");
    status.justify = "center";
    status.alignment = ["fill", "center"];
    setFont(status, "REGULAR", 11);
    setTextColor(status, [0.70, 0.70, 0.70]);
    var readOnlyRow = head.add("group");
    readOnlyRow.orientation = "row";
    readOnlyRow.alignment = ["fill", "top"];
    readOnlyRow.alignChildren = ["left", "center"];
    readOnlyRow.margins = [10, 2, 10, 2];
    readOnlyRow.add("checkbox", undefined, "Sola lettura");

    // History.
    var hist = w.add("group");
    hist.orientation = "column";
    hist.alignChildren = ["fill", "top"];
    hist.spacing = 2;
    hist.margins = [8, 6, 8, 6];
    setFill(hist, SECTION_BG);
    hist.minimumSize = [BLOCK_SIZE[0], 48];
    hist.preferredSize = [BLOCK_SIZE[0], 160];
    text(hist, "Ultime richieste", 11, DIM);
    var sizeText = text(hist, "misura: ?", 11, TEXT);
    for (var r = 1; r < 8; r++) text(hist, "", 11, TEXT);

    // Buttons, counters, signature.
    var tail = w.add("group");
    tail.orientation = "column";
    tail.alignChildren = ["fill", "top"];
    tail.alignment = ["fill", "top"];
    tail.spacing = 6;
    tail.minimumSize = [3 * BUTTON_WIDTH + 8, 2 * 26 + 50];
    tail.preferredSize = [3 * BUTTON_WIDTH + 8, 2 * 26 + 50];
    var rowA = row(tail);
    button(rowA, "Annulla");
    button(rowA, "Ripristino");
    button(rowA, "Elenco");
    var rowB = row(tail);
    button(rowB, "Storico");
    button(rowB, "Cassetta");
    button(rowB, "Vista");
    text(tail, "", 10, DIM);
    var tickText = text(tail, "timer: 0", 9, DIM);
    var foot = w.add("group");
    foot.orientation = "column";
    foot.alignment = ["fill", "fill"];
    foot.alignChildren = ["right", "bottom"];
    foot.margins = 0;
    foot.minimumSize = [200, 22];
    var credit = foot.add("statictext", undefined, "Parlez! by Another Perspective");
    credit.justify = "right";
    credit.alignment = ["right", "bottom"];
    setFont(credit, "REGULAR", 9);
    setTextColor(credit, TEXT);

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

    try {
        var old = $.global.PARLEZ_DIAG_E;
        if (old && old.taskId !== null) app.cancelTask(old.taskId);
    } catch (eOld) { /* nothing to cancel */ }
    var ticks = 0;
    $.global.PARLEZ_DIAG_E = {
        taskId: null,
        tick: function () {
            try {
                ticks++;
                tickText.text = "timer: " + String(ticks);
            } catch (eTick) {
                try { app.cancelTask($.global.PARLEZ_DIAG_E.taskId); } catch (eCancel) { /* gone */ }
            }
        }
    };
    $.global.PARLEZ_DIAG_E.taskId = app.scheduleTask("$.global.PARLEZ_DIAG_E.tick()", REFRESH_MS, true);

    if (!isPanel) {
        w.onClose = function () {
            try { app.cancelTask($.global.PARLEZ_DIAG_E.taskId); } catch (eClose) { /* gone */ }
        };
        w.center();
        w.show();
    }
})(this);
