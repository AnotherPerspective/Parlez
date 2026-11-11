// Guide orientation across After Effects versions (Parlez! fix for AE 26.5).
//
// Up to 26.4 a guide's orientationType was a bare integer: 0 = horizontal,
// 1 = vertical, and addGuide() took the same integers. Adobe's scripting
// changelog for 26.5 says the integers behind orientationType / positionType
// changed and scripts must compare against the enum constants instead. The
// first real run on 26.5 confirmed it: a guide added as "vertical" came back
// as "horizontal".
//
// The constant's exact name could not be checked here (no After Effects in
// this session), so the code below does not bet on one spelling:
//   - writing: try GuideOrientationType.VERTICAL / .HORIZONTAL when that
//     object exists (the naming pattern of KeyframeInterpolationType & co.),
//     then the old integer, then the other old integer;
//   - reading: compare against the same constants when they exist; otherwise
//     ask After Effects for the constant's NAME (getEnumAsString, AE 24.0+)
//     and look for VERTICAL / HORIZONTAL in it; only if both are unavailable
//     fall back to the old integers;
//   - after each attempt the new guide is read back; if After Effects reports
//     the other orientation it is removed and the next candidate is tried, and
//     if none works the call fails with a plain message — a wrong guide is
//     never left behind silently.
// Every probe is wrapped: a missing name is an undefined global in
// ExtendScript, which would otherwise throw.

/** ES3 helpers spliced into every guide operation's generated body. */
export const GUIDE_ORIENTATION_JSX = `
    function _guideEnum() {
        var E = null;
        try { if (typeof GuideOrientationType !== "undefined" && GuideOrientationType) E = GuideOrientationType; } catch (eE) { E = null; }
        return E;
    }
    function _guideEnumValue(name) {
        var E = _guideEnum();
        if (E === null) return null;
        var v = null;
        try { v = name === "vertical" ? E.VERTICAL : E.HORIZONTAL; } catch (eK) { v = null; }
        return typeof v === "number" ? v : null;
    }
    function _guideEnumText(v) {
        var s = null;
        try { if (typeof app !== "undefined" && app && typeof app.getEnumAsString === "function") s = app.getEnumAsString(v); } catch (eA) { s = null; }
        if (s === null || s === undefined) {
            try { if (typeof getEnumAsString === "function") s = getEnumAsString(v); } catch (eG) { s = null; }
        }
        if (s === null || s === undefined) return null;
        return ("" + s).toUpperCase();
    }
    function _guideOrientKnown(v) {
        var ver = _guideEnumValue("vertical");
        var hor = _guideEnumValue("horizontal");
        if (ver !== null && v === ver) return "vertical";
        if (hor !== null && v === hor) return "horizontal";
        var s = _guideEnumText(v);
        if (s !== null) {
            if (/VERTICAL/.test(s)) return "vertical";
            if (/HORIZONTAL/.test(s)) return "horizontal";
        }
        return null;
    }
    function _guideOrientName(v) {
        var known = _guideOrientKnown(v);
        if (known !== null) return known;
        return v === 1 ? "vertical" : "horizontal";
    }
`;

export const GUIDE_ORIENTATIONS = ["horizontal", "vertical"] as const;

/**
 * Generated tail of comp.add_guide / layer.add_guide: add, read back, and undo
 * the add if After Effects reports the other orientation. `owner` is the
 * generated variable holding the comp or layer (`_comp` / `_layer`).
 */
export function guideAddJsx(
  owner: "_comp" | "_layer",
  orientationLit: string,
  positionLit: string,
): string {
  // Candidates in order: the enum constant (if this AE has it), the old
  // integer, then the other old integer — in case 26.5 only swapped them.
  // Each wrong attempt is removed before the next, all inside this call's one
  // undo group.
  return `
            var _want = ${orientationLit};
            var _cands = [];
            var _ev = _guideEnumValue(_want);
            if (_ev !== null) _cands.push(_ev);
            var _old = _want === "vertical" ? 1 : 0;
            if (_ev !== _old) _cands.push(_old);
            if (_ev !== 1 - _old) _cands.push(1 - _old);
            var _idx = -1;
            var _got = null;
            for (var _ci = 0; _ci < _cands.length; _ci++) {
                _idx = ${owner}.addGuide(_cands[_ci], ${positionLit});
                _got = null;
                try { _got = _guideOrientKnown(${owner}.guides[_idx].orientationType); } catch (eR) { _got = null; }
                // Unknown = this AE cannot tell us (no constants, no enum names): trust the add, as before.
                if (_got === null || _got === _want) {
                    return { ok: true, guideIndex: _idx, numGuides: ${owner}.guides.length, orientation: _want };
                }
                try { ${owner}.removeGuide(_idx); } catch (eU) {}
            }
            return { ok: false, error: "After Effects kept creating a " + _got + " guide instead of a " + _want + " one, so none was left behind: this version's guide orientation constant is not one this server knows (see src/guide-enums.ts)" };
  `;
}
