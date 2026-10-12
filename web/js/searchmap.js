/* Unread Atlas: "search results on the map" layer (index.html).
 * Runs a corpus search against the Unread Atlas API and pins the matching tablets at their find-spots,
 * one circle per site sized by the number of tablets, merged into clusters when circles would overlap.
 *   GET /search/sites?q=&in=&period=&genre=&site=&src=   all matches grouped by find-spot
 *   GET /search?…&at=<site key>                          the results at one find-spot (paged)
 * Deep link: index.html?q=…&in=…&period=…&genre=…&site=…&src=…   (search.html "Show on map" uses this)
 * ?searchapi=URL overrides the API base (?api= is the translate API on this page).
 * Loaded after app.js; uses its globals (state, openReader, timeWeight, TIME_* constants). Leaflet only. */
(() => {
  "use strict";

  const API = (new URLSearchParams(location.search).get("searchapi") || "https://d3qsgtzicfbir4.cloudfront.net").replace(/\/+$/, "");
  const FILTERS = ["period", "genre", "site", "src"];
  const SCOPES = { all: "All", atf: "ATF", en: "English", meta: "Catalogue" };
  const PAGE = 20;
  const SLOW_MS = 1200; // Lambda cold start ≈ 12 s; same UX as search.js
  const TIMEOUT_MS = 35000;
  const CLUSTER_PX = 26; // circles closer than this (centre to centre) merge into one cluster
  const SRC_NAMES = { cdli: "CDLI", oracc: "ORACC", ebl: "eBL", tlhdig: "TLHdig", achemenet: "Achemenet" };

  // Approximate ranges per period name, only used to fade circles with the time browser.
  // Same conventional (middle chronology) bands as the timeline's ERAS in app.js.
  const PERIOD_RANGES = [
    [/uruk\s*(iv|v)\b|proto-cuneiform/i, [-3400, -3100]],
    [/uruk\s*iii|jemdet|proto-elamite/i, [-3100, -2900]],
    [/\bED\s*I-II|early dynastic\s*i/i, [-2900, -2600]],
    [/\bED\s*IIIa|early dynastic\s*iiia/i, [-2600, -2500]],
    [/\bED\s*IIIb|early dynastic\s*iiib|^ebla$|fara/i, [-2500, -2334]],
    [/old akkadian|sargonic/i, [-2334, -2154]],
    [/lagash\s*ii|gutian/i, [-2154, -2112]],
    [/ur\s*iii/i, [-2112, -2004]],
    [/early old babylonian/i, [-2004, -1900]],
    [/old babylonian/i, [-2004, -1595]],
    [/old assyrian/i, [-1950, -1720]],
    [/old hittite/i, [-1650, -1500]],
    [/middle hittite/i, [-1500, -1350]],
    [/new hittite|neo-hittite|hittite/i, [-1350, -1180]],
    [/middle babylonian|kassite/i, [-1595, -1000]],
    [/middle assyrian/i, [-1400, -1000]],
    [/middle elamite/i, [-1500, -1100]],
    [/neo-assyrian/i, [-911, -612]],
    [/neo-babylonian/i, [-626, -539]],
    [/neo-elamite/i, [-1000, -539]],
    [/achaemenid|persian/i, [-539, -331]],
    [/hellenistic|seleucid/i, [-331, -63]],
    [/late babylonian/i, [-539, -63]],
    [/parthian|arsacid/i, [-141, -50]],
    [/first millennium/i, [-1000, -50]],
  ];
  const rangeCache = new Map();
  function periodRange(p) {
    if (rangeCache.has(p)) return rangeCache.get(p);
    let r = null;
    const m = /(\d{3,4})\s*[-–]\s*(\d{1,4})\s*BC/.exec(p || "");
    if (m) r = [-Number(m[1]), -Number(m[2])];
    else for (const [re, rr] of PERIOD_RANGES) if (re.test(p || "")) { r = rr; break; }
    rangeCache.set(p, r);
    return r;
  }

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "?");
  const short = (n) => (n >= 1e5 ? Math.round(n / 1e3) + "k" : n >= 1e4 ? (n / 1e3).toFixed(0) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
  const spin = (msg) => `<span class="spinner" aria-hidden="true"></span><span>${esc(msg)}</span>`;

  const sm = {
    query: null, // { q, in, period, genre, site, src }
    data: null, // /search/sites response
    layer: null, // L.layerGroup in its own pane
    clusters: [],
    visible: true,
    seq: 0,
    warm: false,
    panelSeq: 0,
  };

  // ─── API (same cold-start handling as search.js) ───
  class ApiError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }
  async function fetchOnce(path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(API + path, { signal: ctl.signal, headers: { Accept: "application/json" } });
    } catch (e) {
      throw new ApiError(e.name === "AbortError" ? "timeout" : "network", e.message);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* WAF / CloudFront error page */
    }
    if (res.ok && body) return body;
    if (res.status === 429 || res.status === 403) throw new ApiError("rate", "rate limited");
    if (res.status === 400) throw new ApiError("bad", (body && body.error) || "bad request");
    throw new ApiError(res.status >= 500 ? "server" : "http", (body && body.error) || `HTTP ${res.status}`);
  }
  async function api(path, onSlow) {
    const slow = setTimeout(() => onSlow && onSlow(sm.warm ? "Searching…" : "Waking the archive… (the first search after a quiet spell takes ~15 s)"), SLOW_MS);
    try {
      try {
        const r = await fetchOnce(path);
        sm.warm = true;
        return r;
      } catch (e) {
        if (!["timeout", "network", "server"].includes(e.kind)) throw e;
        onSlow && onSlow("Waking the archive… retrying once");
        await new Promise((r) => setTimeout(r, 1500));
        const r = await fetchOnce(path);
        sm.warm = true;
        return r;
      }
    } finally {
      clearTimeout(slow);
    }
  }
  function errorText(e) {
    switch (e.kind) {
      case "rate":
        return "The archive is rate-limiting requests right now. Wait a minute and try again.";
      case "timeout":
        return "The archive did not answer in time (it may still be waking up). Try again in a few seconds.";
      case "network":
        return "Could not reach the archive. Check your connection, or wait a minute if you have run many searches.";
      case "bad":
        return `The search could not be run: ${e.message}.`;
      default:
        return `The archive returned an error (${e.message}).`;
    }
  }

  // ─── query <-> URL ───
  function queryFromUrl() {
    const p = new URLSearchParams(location.search);
    const s = { q: (p.get("q") || "").trim(), in: (p.get("in") || "all").trim() };
    if (!SCOPES[s.in]) s.in = "all";
    for (const k of FILTERS) s[k] = (p.get(k) || "").trim();
    return s;
  }
  const hasQuery = (s) => !!(s && (s.q || FILTERS.some((k) => s[k])));
  function apiParams(s, extra = {}) {
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    p.set("in", s.in || "all");
    for (const k of FILTERS) if (s[k]) p.set(k, s[k]);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }
  function writeUrl(s) {
    const p = new URLSearchParams(location.search);
    for (const k of ["q", "in", ...FILTERS]) p.delete(k);
    if (s) {
      if (s.q) p.set("q", s.q);
      if (s.in && s.in !== "all") p.set("in", s.in);
      for (const k of FILTERS) if (s[k]) p.set(k, s[k]);
    }
    const qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
  function searchPageUrl(s, extra = {}) {
    const p = new URLSearchParams();
    if (API !== "https://d3qsgtzicfbir4.cloudfront.net") p.set("api", API);
    if (s.q) p.set("q", s.q);
    if (s.in && s.in !== "all") p.set("in", s.in);
    for (const k of FILTERS) if (s[k]) p.set(k, s[k]);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return "search.html?" + p.toString();
  }

  // ─── UI ───
  function setChip(html, cls = "") {
    const chip = $("#smap-chip");
    chip.hidden = false;
    chip.className = "smap-chip" + (cls ? " " + cls : "");
    $("#smap-summary").innerHTML = html;
  }
  function filterChips(s) {
    const out = [];
    if (s.in && s.in !== "all") out.push(["in", `in ${SCOPES[s.in]}`]);
    for (const k of FILTERS) if (s[k]) out.push([k, s[k]]);
    return out
      .map(([k, label]) => `<button type="button" class="smap-filter" data-unfilter="${esc(k)}" title="Remove this filter">${esc(label)} <span aria-hidden="true">×</span></button>`)
      .join("");
  }

  async function run(s, { pushUrl = true } = {}) {
    if (!hasQuery(s)) return clear();
    const my = ++sm.seq;
    sm.query = s;
    if (pushUrl) writeUrl(s);
    $("#smap-q").value = s.q;
    $("#smap-filters").innerHTML = filterChips(s);
    $("#smap-open").href = searchPageUrl(s);
    setChip(spin("Searching the corpus…"), "busy");
    closePanel();
    let d;
    try {
      d = await api("/search/sites?" + apiParams(s), (m) => my === sm.seq && setChip(spin(m), "busy"));
    } catch (e) {
      if (my !== sm.seq) return;
      setChip(`<span>${esc(errorText(e))}</span> <button type="button" class="smap-retry" data-smap-retry>Try again</button>`, "error");
      return;
    }
    if (my !== sm.seq) return;
    sm.data = d;
    const label = s.q ? `“${esc(s.q)}”` : "this filter";
    if (!d.total) {
      setChip(`No tablets match ${label}.`);
      draw();
      return;
    }
    const capped = d.total_is_capped ? "+" : "";
    setChip(
      `<strong>${fmt(d.total)}${capped}</strong> result${d.total === 1 ? "" : "s"} at <strong>${fmt(d.site_count)}</strong> site${d.site_count === 1 ? "" : "s"}` +
        ` <span class="smap-dim">(${fmt(d.unlocated)} without location)</span>`
    );
    $("#smap-chip").title =
      `${fmt(d.total)} distinct tablets (${fmt(d.records)} text records) match; ${fmt(d.located)} have a mappable find-spot, ` +
      `${fmt(d.unlocated)} have none or only an uncertain one. ${d.took_ms} ms.`;
    sm.visible = true;
    $("#smap-toggle").checked = true;
    draw(true);
  }

  function clear() {
    sm.seq++;
    sm.query = null;
    sm.data = null;
    $("#smap-q").value = "";
    $("#smap-filters").innerHTML = "";
    $("#smap-chip").hidden = true;
    closePanel();
    draw();
    writeUrl(null);
  }

  // ─── layer ───
  function radiusFor(n) {
    return Math.max(9, Math.min(30, 8 + 6.5 * Math.log10(n + 1)));
  }

  function draw(fit = false) {
    const map = state.map;
    if (!map) return;
    if (!map.getPane("searchResults")) {
      const pane = map.createPane("searchResults");
      pane.style.zIndex = 590; // under the catalog pins (markerPane 600), over the relief tiles
    }
    if (!sm.layer) sm.layer = L.layerGroup().addTo(map);
    sm.layer.clearLayers();
    sm.clusters = [];
    map.getContainer().classList.toggle("smap-active", !!(sm.data && sm.visible && sm.data.sites.length));
    if (!sm.data || !sm.visible || !sm.data.sites.length) return;
    // greedy pixel clustering at the current zoom: biggest sites first
    const pts = sm.data.sites.map((s) => ({ s, p: map.project([s.lat, s.lon], map.getZoom()) }));
    for (const { s, p } of pts) {
      let best = null;
      for (const c of sm.clusters) {
        const d = c.p.distanceTo(p);
        if (d < Math.max(CLUSTER_PX, c.r * 0.9) && (!best || d < best.d)) best = { c, d };
      }
      if (best) {
        best.c.sites.push(s);
        best.c.count += s.count;
        best.c.r = radiusFor(best.c.count);
      } else {
        sm.clusters.push({ sites: [s], count: s.count, p, lat: s.lat, lon: s.lon, r: radiusFor(s.count) });
      }
    }
    for (const c of sm.clusters) {
      const d = Math.round(c.r * 2);
      const multi = c.sites.length > 1;
      const icon = L.divIcon({
        className: "smap-marker" + (multi ? " smap-cluster" : ""),
        html: `<span class="smap-dot" style="width:${d}px;height:${d}px"><span class="smap-n">${esc(short(c.count))}</span></span>`,
        iconSize: [d, d],
        iconAnchor: [d / 2, d / 2],
      });
      const title = multi
        ? `${fmt(c.count)} results at ${c.sites.length} sites: ${c.sites.slice(0, 4).map((x) => x.site).join(", ")}${c.sites.length > 4 ? "…" : ""}`
        : `${fmt(c.count)} result${c.count === 1 ? "" : "s"} at ${c.sites[0].site}`;
      const m = L.marker([c.lat, c.lon], { icon, pane: "searchResults", title, keyboard: true, riseOnHover: true });
      m.on("click", () => openPanel(c));
      m.addTo(sm.layer);
      c.marker = m;
    }
    styleForTime();
    if (fit) fitToResults();
  }

  /** Frame the result sites. On first load the app pans to the work it auto-selects once the catalog
   *  arrives, so wait for that (max ~4 s) before framing a deep-linked search. */
  async function fitToResults() {
    const my = sm.seq;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let waited = false;
    for (let i = 0; i < 40 && !(state.catalog && state.selectedId); i++) {
      waited = true;
      await wait(100);
    }
    if (waited) await wait(450); // let the app's animated panTo to the selected work finish first
    if (my !== sm.seq || !sm.data || !sm.data.sites.length) return;
    const b = L.latLngBounds(sm.data.sites.map((s) => [s.lat, s.lon]));
    if (!b.isValid()) return;
    state.map.stop();
    state.map.invalidateSize({ pan: false });
    state.map.fitBounds(b.pad(0.15), { maxZoom: 7, animate: false });
  }

  function siteWeight(site, y) {
    let w = null;
    for (const [p] of site.periods || []) {
      const r = periodRange(p);
      if (!r) continue;
      const wi = timeWeight({ _range: r }, y);
      if (wi != null && (w == null || wi > w)) w = wi;
    }
    return w;
  }

  function styleForTime() {
    const fade = state.timeFade;
    const y = state.timelineYear;
    for (const c of sm.clusters) {
      const el = c.marker && c.marker.getElement();
      if (!el) continue;
      let w = null;
      if (fade) for (const s of c.sites) {
        const ws = siteWeight(s, y);
        if (ws != null && (w == null || ws > w)) w = ws;
      }
      let o = 1;
      if (fade) o = w == null ? TIME_UNDATED_OPACITY : TIME_MIN_OPACITY + (1 - TIME_MIN_OPACITY) * w;
      el.style.setProperty("--o", o.toFixed(3));
      el.classList.toggle("undated", fade && w == null);
    }
  }

  // ─── results panel ───
  function closePanel() {
    sm.panelSeq++;
    const p = $("#smap-panel");
    p.hidden = true;
    p.innerHTML = "";
  }

  const inCatalog = (() => {
    let ids = null;
    return (id) => {
      if (!ids) {
        if (!state.catalog || !state.catalog.items) return false;
        ids = new Set(state.catalog.items.map((i) => i.id));
      }
      return ids.has(id);
    };
  })();

  function resultHtml(r) {
    const tp = (r.url || "").replace(/^\/text\//, "") || `${r.src}:${r.id}`;
    const facts = [r.period, r.genre, SRC_NAMES[r.src] || r.src].filter(Boolean).map(esc).join(" · ");
    const sn = (r.snippets || [])[0];
    const snip = sn && sn.kind !== "meta"
      ? `<div class="smap-snip"><span class="smap-snip-kind">${esc(sn.kind === "human_en" ? "Human EN" : sn.kind === "machine_en" ? "Machine draft" : "ATF")}</span> ${esc(sn.text)}</div>`
      : "";
    const readerId = inCatalog(r.id) ? r.id : r.canonical_id && inCatalog(r.canonical_id) ? r.canonical_id : null;
    const reader = readerId ? ` <a href="index.html?id=${encodeURIComponent(readerId)}" class="smap-reader" data-open="${esc(readerId)}">Map reader</a>` : "";
    return `<li class="smap-res"><div><a class="smap-id" href="${esc(searchPageUrl(sm.query, { text: tp }))}" target="_blank" rel="noopener">${esc(r.id)}</a>` +
      `${r.designation && r.designation !== r.id ? ` <span class="smap-desig">${esc(r.designation)}</span>` : ""}${reader}</div>` +
      `<div class="smap-facts">${facts}</div>${snip}</li>`;
  }

  // two find-spots with the same name (e.g. Nineveh records geocoded 1 km apart): add the coordinates
  function siteLabel(s, all) {
    return all.filter((x) => x.site === s.site).length > 1 ? `${s.site} (${s.lat.toFixed(2)}, ${s.lon.toFixed(2)})` : s.site;
  }

  function openPanel(c) {
    const panel = $("#smap-panel");
    panel.hidden = false;
    const sites = [...c.sites].sort((a, b) => b.count - a.count);
    const head = sites.length > 1
      ? `<h3>${fmt(c.count)} results at ${sites.length} sites</h3>`
      : `<h3>${esc(sites[0].site)}</h3><p class="smap-sub">${fmt(sites[0].count)} matching tablet${sites[0].count === 1 ? "" : "s"}</p>`;
    const tabs = sites.length > 1
      ? `<div class="smap-sites" role="tablist">${sites.map((s, i) => `<button type="button" role="tab" data-site-key="${esc(s.key)}" class="${i ? "" : "on"}" title="${esc(s.site)} · ${esc(s.key)}">${esc(siteLabel(s, sites))} <span>${esc(short(s.count))}</span></button>`).join("")}</div>`
      : "";
    panel.innerHTML = `<button type="button" class="smap-close" data-smap-close aria-label="Close">×</button>${head}${tabs}<div id="smap-list"></div>`;
    panel._sites = sites;
    panel.scrollTop = 0;
    loadSite(sites[0], 1);
  }

  async function loadSite(site, page) {
    const my = ++sm.panelSeq;
    const list = $("#smap-list");
    if (!list) return;
    const periods = (site.periods || []).slice(0, 4).map(([p, n]) => `${esc(p)} ${esc(short(n))}`).join(" · ");
    const header = `<p class="smap-sub">${periods}${periods ? "<br>" : ""}<a href="${esc(searchPageUrl(sm.query, { at: site.key }))}" target="_blank" rel="noopener">Open these ${fmt(site.records)} records in Search</a></p>`;
    // instant: the ranked samples that came with /search/sites, then the full paged list
    if (page === 1 && site.sample && site.sample.length) {
      list.innerHTML = header + `<ul class="smap-results">${site.sample.map(resultHtml).join("")}</ul><p class="smap-sub">${spin("Loading results…")}</p>`;
    } else {
      list.innerHTML = header + `<p class="smap-sub">${spin("Loading results…")}</p>`;
    }
    let d;
    try {
      d = await api("/search?" + apiParams(sm.query, { at: site.key, page, limit: PAGE }), (m) => {
        const st = list.querySelector(".smap-sub:last-child");
        if (my === sm.panelSeq && st) st.innerHTML = spin(m);
      });
    } catch (e) {
      if (my !== sm.panelSeq) return;
      list.innerHTML = header + `<p class="smap-sub smap-err">${esc(errorText(e))}</p>`;
      return;
    }
    if (my !== sm.panelSeq) return;
    const pages = d.pages || 1;
    const nav = pages > 1
      ? `<div class="smap-pager">${page > 1 ? `<button type="button" data-site-page="${page - 1}">← Prev</button>` : ""}` +
        `<span>${fmt((page - 1) * PAGE + 1)}–${fmt(Math.min(page * PAGE, d.total))} of ${fmt(d.total)}${d.total_is_capped ? "+" : ""}</span>` +
        `${page < pages ? `<button type="button" data-site-page="${page + 1}">Next →</button>` : ""}</div>`
      : "";
    list.innerHTML = header + `<ul class="smap-results">${d.results.map(resultHtml).join("")}</ul>${nav}`;
    list.dataset.siteKey = site.key;
    $("#smap-panel").scrollTop = page > 1 ? list.offsetTop - 8 : 0;
  }

  // ─── wiring ───
  function init() {
    if (!state.map) return setTimeout(init, 50);
    $("#smap-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const s = { ...(sm.query || queryFromUrl()), q: $("#smap-q").value.trim() };
      if (!hasQuery(s)) return clear();
      run(s);
    });
    $("#smap-clear").addEventListener("click", clear);
    $("#smap-toggle").addEventListener("change", (e) => {
      sm.visible = e.target.checked;
      if (!sm.visible) closePanel();
      draw();
    });
    $(".smap").addEventListener("click", (e) => {
      const f = e.target.closest("[data-unfilter]");
      if (f && sm.query) {
        const s = { ...sm.query };
        if (f.dataset.unfilter === "in") s.in = "all";
        else s[f.dataset.unfilter] = "";
        if (hasQuery(s)) run(s);
        else clear();
      }
      if (e.target.closest("[data-smap-retry]") && sm.query) run(sm.query);
    });
    $("#smap-panel").addEventListener("click", (e) => {
      const panel = $("#smap-panel");
      if (e.target.closest("[data-smap-close]")) return closePanel();
      const tab = e.target.closest("[data-site-key]");
      if (tab) {
        panel.querySelectorAll("[data-site-key]").forEach((b) => b.classList.toggle("on", b === tab));
        const site = (panel._sites || []).find((s) => s.key === tab.dataset.siteKey);
        if (site) loadSite(site, 1);
        return;
      }
      const pg = e.target.closest("[data-site-page]");
      if (pg) {
        const key = $("#smap-list").dataset.siteKey;
        const site = (panel._sites || []).find((s) => s.key === key);
        if (site) loadSite(site, Number(pg.dataset.sitePage));
      }
    });
    // keep the map's own click/scroll from firing through the overlay controls
    for (const el of [$(".smap"), $("#smap-panel")]) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
    state.map.on("zoomend", () => sm.data && draw());
    document.addEventListener("unread:timeline", styleForTime);
    const s = queryFromUrl();
    if (hasQuery(s)) run(s, { pushUrl: false });
  }

  window.UnreadSearchMap = { run: (s) => run({ q: "", in: "all", period: "", genre: "", site: "", src: "", ...s }), clear, state: sm };
  document.addEventListener("DOMContentLoaded", init);
})();
