// Pure state for the browse page "map of maps" ring. No DOM.
// Classic script: window.BrowseState. Unit-tested from scripts/test_browse_state.mjs.
(function (root) {
  "use strict";
  var ZMAX = 400;

  function finite(v) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  }

  // Ring position in [0, n). A missing or non-finite saved value (URL ?t=NaN,
  // "foo", Infinity) falls back to 0, the Geography stop at the top of the ring.
  // Otherwise blend() does MAPS[NaN].x and the draw throws.
  function sanitizeNavT(raw, n) {
    var t = finite(raw);
    if (!Number.isFinite(t) || !(n > 0)) return 0;
    return ((t % n) + n) % n;
  }

  // Keep a camera inside the plot. Non-finite components fall back to the
  // full view (center, 1x) rather than becoming NaN uniforms, which draw nothing.
  function clampCamera(z, x, y, zmax) {
    var lim = zmax > 1 ? zmax : ZMAX;
    var zz = Number.isFinite(z) ? Math.min(lim, Math.max(1, z)) : 1;
    var h = 0.5 / zz;
    var xx = Number.isFinite(x) ? x : 0.5;
    var yy = Number.isFinite(y) ? y : 0.5;
    return {
      cx: Math.min(1 - h, Math.max(h, xx)),
      cy: Math.min(1 - h, Math.max(h, yy)),
      z: zz
    };
  }

  // Saved ?z=&x=&y=. Non-finite, z above the zoom cap, or an x/y outside the
  // plot is not a camera we can show: fall back to the full view (or to center
  // on just the bad axis) so the page never opens on an empty sliver.
  function sanitizeView(zRaw, xRaw, yRaw, zmax) {
    var lim = zmax > 1 ? zmax : ZMAX;
    var z = finite(zRaw), x = finite(xRaw), y = finite(yRaw);
    if (!(z > 1) || z > lim) return { cx: 0.5, cy: 0.5, z: 1 };
    if (!(x >= 0 && x <= 1)) x = 0.5;
    if (!(y >= 0 && y <= 1)) y = 0.5;
    return clampCamera(z, x, y, lim);
  }

  function blendFromNav(navT, maps) {
    var n = maps && maps.length ? maps.length : 0;
    if (!n) return { i: 0, j: 0, e: 0, wx: [1, 0, 0, 0, 0], wy: [0, 1, 0, 0, 0], t: 0 };
    var t = sanitizeNavT(navT, n);
    var i = Math.min(n - 1, Math.floor(t));
    var f = t - i;
    var j = (i + 1) % n;
    var e = f * f * (3 - 2 * f);
    var wx = [0, 0, 0, 0, 0], wy = [0, 0, 0, 0, 0];
    var mi = maps[i], mj = maps[j];
    if (!mi || !mj) return { i: 0, j: Math.min(1, n - 1), e: 0, wx: [1, 0, 0, 0, 0], wy: [0, 1, 0, 0, 0], t: 0 };
    wx[mi.x] += 1 - e;
    wy[mi.y] += 1 - e;
    wx[mj.x] += e;
    wy[mj.y] += e;
    return { i: i, j: j, e: e, wx: wx, wy: wy, t: t };
  }

  // Handle center in the nav element's coordinate space. A 0 or NaN radius
  // (circle measured before layout) cannot produce NaN left/top — the browser
  // would ignore that and leave the dot at its static top-left, outside the ring.
  // The result is always inside the circle when the circle radius is known.
  function handleCenter(navT, count, cx, cy, radius, circleRadius) {
    var n = count > 0 ? count : 1;
    var t = sanitizeNavT(navT, n);
    var CX = Number.isFinite(cx) ? cx : 0;
    var CY = Number.isFinite(cy) ? cy : 0;
    var limit = Number.isFinite(circleRadius) && circleRadius > 0 ? circleRadius : 0;
    var R = Number.isFinite(radius) ? radius : NaN;
    if (!(R > 0)) R = limit > 16 ? limit * (112 / 150) : 0;
    if (limit > 0) R = Math.min(R, Math.max(0, limit - 10));
    if (!(R > 0)) return { x: CX, y: CY, t: t };
    var a = -Math.PI / 2 + (t / n) * 2 * Math.PI;
    return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a), t: t };
  }

  root.BrowseState = {
    ZMAX: ZMAX,
    sanitizeNavT: sanitizeNavT,
    sanitizeView: sanitizeView,
    clampCamera: clampCamera,
    blendFromNav: blendFromNav,
    handleCenter: handleCenter
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
