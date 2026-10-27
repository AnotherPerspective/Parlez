// Parlez! - diagnostica dello sgancio, variante B (nome provvisorio).
//
// Identical to variant A (diagnostica-sgancio-a.jsx) but for one thing: the
// texts sit in a child group with alignment ["fill", "fill"] and no size of
// its own, the shape suspected of making the undocked panel collapse. If A
// keeps its size and B collapses, that is the cause; if both collapse, it is
// not.
//
// Keep this file ES3.

(function diagnosticaSgancioB(thisObj) {
    var isPanel = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
    var w = isPanel ? thisObj : new Window("palette", "Prova sgancio B", undefined, { resizeable: true });
    w.orientation = "column";
    w.alignChildren = ["left", "top"];
    w.margins = 12;
    w.preferredSize = [300, 200];
    w.minimumSize = [300, 200];
    var g = w.add("group");
    g.orientation = "column";
    g.alignment = ["fill", "fill"];
    g.add("statictext", undefined, "Prova sgancio B: gruppo \"fill\" senza misura");
    var sizeText = g.add("statictext", undefined, "misura: ?");
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
