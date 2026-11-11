// Parlez! - diagnostica dello sgancio, variante A.
//
// The smallest dockable panel there is: the root (the Panel After Effects
// hands over, or a palette window when run as a script), a preferred and a
// minimum size, two statictexts and the usual resize handlers. If this one
// also collapses to its close button when undocked, the cause is in After
// Effects, not in what the Parlez! panel puts inside. Variant B
// (diagnostica-sgancio-b.jsx) adds only a group with alignment "fill" and no
// size of its own - the suspect.
//
// The second line shows the panel's size, refreshed on every resize, so the
// result can be read off the screen.
//
// Keep this file ES3.

(function diagnosticaSgancioA(thisObj) {
    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var w = isPanel ? thisObj : new Window("palette", "Prova sgancio A", undefined, { resizeable: true });
    w.orientation = "column";
    w.alignChildren = ["left", "top"];
    w.margins = 12;
    w.preferredSize = [300, 200];
    w.minimumSize = [300, 200];
    w.add("statictext", undefined, "Prova sgancio A: solo testo");
    var sizeText = w.add("statictext", undefined, "misura: ?");
    sizeText.preferredSize = [260, 20];

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
