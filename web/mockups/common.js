/* Unread Atlas UI mockups: shared helpers. Exploratory prototypes; the live site does not load this. */
(() => {
  "use strict";
  const qs = new URLSearchParams(location.search);
  const API = (qs.get("searchapi") || "https://d3qsgtzicfbir4.cloudfront.net").replace(/\/+$/, "");
  // Same conventional (middle chronology) bands as js/searchmap.js PERIOD_RANGES.
  const PERIOD_RANGES = [
    [/uruk\s*(iv|v)\b|proto-cuneiform/i, [-3400, -3100]], [/uruk\s*iii|jemdet|proto-elamite/i, [-3100, -2900]],
    [/\bED\s*I-II|early dynastic\s*i\b/i, [-2900, -2600]], [/\bED\s*IIIa|early dynastic\s*iiia/i, [-2600, -2500]],
    [/\bED\s*IIIb|early dynastic\s*iiib|^ebla$|fara/i, [-2500, -2334]], [/old akkadian|sargonic/i, [-2334, -2154]],
    [/lagash\s*ii|gutian/i, [-2154, -2112]], [/ur\s*iii/i, [-2112, -2004]], [/early old babylonian/i, [-2004, -1900]],
    [/old babylonian/i, [-2004, -1595]], [/old assyrian/i, [-1950, -1720]], [/old hittite/i, [-1650, -1500]],
    [/middle hittite/i, [-1500, -1350]], [/new hittite|neo-hittite|hittite/i, [-1350, -1180]],
    [/middle babylonian|kassite/i, [-1595, -1000]], [/middle assyrian/i, [-1400, -1000]], [/middle elamite/i, [-1500, -1100]],
    [/neo-assyrian/i, [-911, -612]], [/neo-babylonian/i, [-626, -539]], [/neo-elamite/i, [-1000, -539]],
    [/achaemenid|persian/i, [-539, -331]], [/hellenistic|seleucid/i, [-331, -63]], [/late babylonian/i, [-539, -63]],
    [/parthian|arsacid/i, [-141, -50]], [/first millennium/i, [-1000, -50]],
  ];
  const cache = new Map();
  function periodRange(p) {
    if (cache.has(p)) return cache.get(p);
    let r = null;
    const m = /(\d{3,4})\s*[-–]\s*(\d{1,4})\s*BC/.exec(p || "");
    if (m) r = [-Number(m[1]), -Number(m[2])];
    else for (const [re, rr] of PERIOD_RANGES) if (re.test(p || "")) { r = rr; break; }
    cache.set(p, r);
    return r;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (typeof n === "number" ? Math.round(n).toLocaleString("en-US") : "?");
  const short = (n) => (n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n)));
  const siteName = (s) => String(s || "").replace(/\s*\(mod\.[^)]*\)/, "");
  const yr = (y) => (y < 0 ? `${-y} BCE` : y === 0 ? "1 CE" : `${y} CE`);

  async function api(path, onSlow) {
    const slow = setTimeout(() => onSlow && onSlow("Waking the archive… (first search after a quiet spell takes ~15 s)"), 1200);
    try {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await fetch(API + path, { headers: { Accept: "application/json" } });
          const b = await r.json();
          if (r.ok) return b;
          throw new Error(b.error || "HTTP " + r.status);
        } catch (e) {
          if (i) throw e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } finally {
      clearTimeout(slow);
    }
  }

  function initMap(id, opts = {}) {
    const map = L.map(id, { zoomControl: false, fadeAnimation: false, zoomAnimation: !new URLSearchParams(location.search).get("shot"), minZoom: 2, maxZoom: 10, worldCopyJump: false,
      maxBounds: [[-85.06, -200], [85.06, 200]], maxBoundsViscosity: 0.8, ...opts }).setView(opts.center || [33.5, 44.0], opts.zoom || 5);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    const URL = "../tiles/relief/{z}/{x}/{y}.webp";
    const ATTR = 'Relief: <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model">NOAA ETOPO 2022</a> &middot; <a href="https://www.naturalearthdata.com/">Natural Earth</a>';
    L.tileLayer(URL, { attribution: ATTR, minZoom: 0, maxZoom: 10, minNativeZoom: 0, maxNativeZoom: 7, bounds: [[-85.0511, -180], [85.0511, 180]], noWrap: true }).addTo(map);
    L.tileLayer(URL, { minZoom: 7, maxZoom: 10, minNativeZoom: 7, maxNativeZoom: 8, bounds: [[22, 24], [46, 62]], noWrap: true }).addTo(map);
    const v = qs.get("view"); // lat,lon,zoom (for screenshots / deep links)
    if (v) { const [a, b, z] = v.split(",").map(Number); if (isFinite(a) && isFinite(b)) map.setView([a, b], z || map.getZoom()); }
    return map;
  }
  const radius = (n, k = 0.8, min = 3, max = 38) => Math.min(max, Math.max(min, k * Math.pow(n, 0.42)));

  window.MU = { API, qs, api, esc, fmt, short, siteName, yr, periodRange, initMap, radius };
})();
