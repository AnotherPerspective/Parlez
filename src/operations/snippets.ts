// JSX bodies shared between the read/render TOOLS (ae_comp_info,
// ae_layer_info, ae_render_frame) and their operation twins (comp.info,
// layer.info, render.frame). One body, two surfaces — what a batch.run child
// reports can never drift from what the standalone tool reports.
//
// Lives under src/operations/ so the jsx ES3 lint scans these template
// literals like any other generated code. Each snippet only DEFINES a
// function; the call site supplies the lookup preamble. Inside batch.run
// every child runs in its own IIFE, so two children defining the same
// function never collide.

/** Defines `_compInfo(c)` → the ae_comp_info payload for one comp. */
export const COMP_INFO_FN = `
    function _compInfo(c) {
        var _ciLayers = [];
        for (var _ci = 1; _ci <= c.numLayers; _ci++) {
            _ciLayers.push(AE.serializeLayerSummary(c.layer(_ci)));
        }
        var _ciOut = AE.serializeItemSummary(c);
        _ciOut.ok = true;
        _ciOut.found = true;
        _ciOut.workAreaStart = c.workAreaStart;
        _ciOut.workAreaDuration = c.workAreaDuration;
        _ciOut.pixelAspect = c.pixelAspect;
        _ciOut.shutterAngle = c.shutterAngle;
        _ciOut.shutterPhase = c.shutterPhase;
        _ciOut.motionBlur = c.motionBlur;
        _ciOut.layers = _ciLayers;
        return _ciOut;
    }
`;

/** Defines `_layerFull(l, incl, detail)` → the ae_layer_info payload for one layer. */
export const LAYER_FULL_FN = `
    function _layerFull(l, incl, detail) {
        var _lfOut = AE.serializeLayerFull(l, { includeProperties: incl, detail: detail });
        _lfOut.ok = true;
        _lfOut.found = true;
        return _lfOut;
    }
`;

/** Defines `_renderFrame(c, timeSeconds, absOutPath, useDisplayStartTime)`. */
export const RENDER_FRAME_FN = `
    function _renderFrame(c, t0, outAbs, useDst) {
        var _rfT = t0;
        if (useDst) _rfT = _rfT + c.displayStartTime;
        var _rfFile = AE.ensureParentDir(outAbs);
        try {
            c.saveFrameToPng(_rfT, _rfFile);
            return {
                ok: true,
                writtenTo: _rfFile.fsName.replace(/\\\\/g, "/"),
                time: _rfT,
                compName: c.name,
                size: [c.width, c.height]
            };
        } catch (eRf) {
            return { ok: false, error: "saveFrameToPng failed: " + AE.errText(eRf) };
        }
    }
`;

/**
 * Read-only walk for the timeline strip: per layer, in/out points and the
 * distinct keyframe times of every animatable property (comp seconds;
 * markers are not keyframes and are skipped). Capped so a huge comp cannot
 * flood the response: `maxLayers` layers, `maxKeys` distinct times each,
 * property groups 8 deep.
 */
export const TIMELINE_KEYS_FN = `
    function _tlWalk(g, depth, seen, keys, maxKeys, st) {
        if (depth > 8 || st.truncated) return;
        var _np = 0;
        try { _np = g.numProperties; } catch (eNp) { return; }
        for (var _pi = 1; _pi <= _np; _pi++) {
            var _p = null;
            try { _p = g.property(_pi); } catch (eP) { continue; }
            if (!_p) continue;
            if (_p.propertyType === PropertyType.PROPERTY) {
                if (_p.matchName === "ADBE Marker") continue;
                var _nk = 0;
                try { _nk = _p.numKeys; } catch (eNk) { _nk = 0; }
                for (var _ki = 1; _ki <= _nk; _ki++) {
                    var _kt = _p.keyTime(_ki);
                    var _kk = "k" + Math.round(_kt * 1000);
                    if (seen.hasOwnProperty(_kk)) continue;
                    if (keys.length >= maxKeys) { st.truncated = true; return; }
                    seen[_kk] = true;
                    keys.push(_kt);
                }
            } else {
                _tlWalk(_p, depth + 1, seen, keys, maxKeys, st);
            }
        }
    }
    function _tlCollect(c, maxLayers, maxKeys) {
        var _tl = {
            duration: c.duration,
            frameRate: c.frameRate,
            displayStartTime: c.displayStartTime,
            layers: [],
            layersTruncated: false
        };
        for (var _li = 1; _li <= c.numLayers; _li++) {
            if (_tl.layers.length >= maxLayers) { _tl.layersTruncated = true; break; }
            var _l = c.layer(_li);
            var _keys = [];
            var _st = { truncated: false };
            try { _tlWalk(_l, 0, {}, _keys, maxKeys, _st); } catch (eW) { }
            _tl.layers.push({
                index: _l.index,
                name: _l.name,
                inPoint: _l.inPoint,
                outPoint: _l.outPoint,
                enabled: _l.enabled,
                keys: _keys,
                keysTruncated: _st.truncated
            });
        }
        return _tl;
    }
`;
