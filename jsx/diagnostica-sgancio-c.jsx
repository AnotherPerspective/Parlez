// Parlez! - diagnostica dello sgancio, variante C (nome provvisorio).
//
// Bisection step 1: variant A (which undocks correctly on AE 26.5) plus the
// Parlez! ON/OFF picture button - an iconbutton in "toolbutton" style with
// fixed preferred, minimum and maximum size, as in jsx/panel.jsx. A click
// swaps ON and OFF. Nothing else.
//
// The pictures are found through the installed Parlez!.jsx next to this
// file (its IMAGE_DIR line, written by install-panel), or in panel-images/
// next to this file when it is run from the package.
//
// Keep this file ES3.

(function diagnosticaSgancioC(thisObj) {
    var BLOCK_SIZE = [320, 88];

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
    var w = isPanel ? thisObj : new Window("palette", "Prova sgancio C", undefined, { resizeable: true });
    w.orientation = "column";
    w.alignChildren = ["left", "top"];
    w.margins = 12;
    w.preferredSize = [344, 200];
    w.minimumSize = [344, 200];
    w.add("statictext", undefined, "Prova sgancio C: A + riquadro immagine");
    var sizeText = w.add("statictext", undefined, "misura: ?");
    sizeText.preferredSize = [260, 20];

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
    if (!isPanel) {
        w.center();
        w.show();
    }
})(this);
