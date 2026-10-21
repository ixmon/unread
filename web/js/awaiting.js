/* Awaiting-work layer (preview): find-spots coloured by what their tablets still need.
   Data: assets/awaiting_sites.json (scripts/build_awaiting_layer.py) + curated known-but-unpublished sites. */
(function () {
  const ST = [
    ["cat", "Catalogue only (no ATF)", "#d9534f"],
    ["atf", "ATF, no English", "#e0a030"],
    ["mt", "Machine English only", "#5b9bd5"],
    ["hum", "Human English", "#6cbf6c"],
  ];
  const on = { cat: true, atf: true, mt: true, hum: true, known: true };
  let data = null, group = null, ctl = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (n) => n.toLocaleString("en-US");

  function siteMarker(s) {
    const shown = ST.filter(([k]) => on[k]);
    const n = shown.reduce((a, [k]) => a + s[k], 0);
    if (!n) return null;
    // dominant visible state sets the colour; size by visible count
    const [, , col] = shown.reduce((b, x) => (s[x[0]] > s[b[0]] ? x : b), shown[0]);
    const r = Math.max(4, Math.min(22, 2.2 * Math.sqrt(n) ** 0.62));
    const m = L.circleMarker([s.lat, s.lon], { radius: r, color: "#0f1114", weight: 1, fillColor: col, fillOpacity: 0.82 });
    m.bindPopup(() => {
      const tot = ST.reduce((a, [k]) => a + s[k], 0);
      return `<div class="aw-pop"><b>${esc(s.site)}</b><div class="aw-sub">${fmt(tot)} texts</div><table>` +
        ST.map(([k, lab, c]) => `<tr><td><i style="background:${c}"></i>${lab}</td><td>${fmt(s[k])}</td><td>${tot ? Math.round((100 * s[k]) / tot) : 0}%</td></tr>`).join("") +
        `</table></div>`;
    });
    return m;
  }
  function knownMarker(k) {
    const icon = L.divIcon({ className: "aw-known", html: "<span>?</span>", iconSize: [22, 22], iconAnchor: [11, 11] });
    const m = L.marker([k.lat, k.lon], { icon, zIndexOffset: 1000, title: k.site + " — known, unpublished" });
    m.bindPopup(`<div class="aw-pop aw-pop-known"><div class="aw-tag">Known · unpublished</div><b>${esc(k.site)}</b>
      <div class="aw-sub">${esc(k.modern_name || "")}</div>
      <div>~${fmt(k.est_tablets)} tablets · ${esc(k.period || "")}</div>
      <div class="aw-sub">${esc(k.est_note || "")}</div>
      <div>Status: <b>${esc(k.status.replace(/-/g, " "))}</b></div>
      <div>Missing: ${k.missing.map((x) => `<span class="aw-miss">${esc(x === "atf" ? "transliteration" : x)}</span>`).join(" ")}</div>
      <ul>${k.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.citation)}</a></li>`).join("")}</ul>
      <div class="aw-sub">Coordinates: ${esc(k.coord_source)} · last checked ${esc(k.last_checked)}</div></div>`, { maxWidth: 340 });
    m._awKnownId = k.id;
    return m;
  }
  function redraw() {
    document.body.classList.toggle("aw-on", true);
    if (!data || typeof state === "undefined" || !state.map) return;
    if (group) group.remove();
    group = L.layerGroup();
    data.sites.forEach((s) => { const m = siteMarker(s); if (m) m.addTo(group); });
    if (on.known) data.known_sites.forEach((k) => knownMarker(k).addTo(group));
    group.addTo(state.map);
  }
  function addLegend() {
    const Leg = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const d = L.DomUtil.create("div", "leaflet-control aw-legend");
        d.innerHTML = `<div class="aw-h">Awaiting work <span class="aw-pv">preview</span></div>` +
          ST.map(([k, lab, c]) => `<label><input type="checkbox" data-k="${k}" checked><i style="background:${c}"></i>${lab} <em>${fmt(data.totals[k])}</em></label>`).join("") +
          `<label><input type="checkbox" data-k="known" checked><i class="aw-known-sw">?</i>Known, unpublished</label>`;
        d.addEventListener("change", (e) => { const k = e.target.dataset.k; if (k) { on[k] = e.target.checked; redraw(); } });
        L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
        return d;
      },
    });
    ctl = new Leg().addTo(state.map);
  }
  window.awaitingLayer = {
    openKnown(id) { group && group.eachLayer((l) => { if (l._awKnownId === id) { state.map.setView(l.getLatLng(), 6); l.openPopup(); } }); },
  };
  function start() {
    if (typeof state === "undefined" || !state.map) return setTimeout(start, 300);
    fetch("assets/awaiting_sites.json").then((r) => r.json()).then((j) => {
      data = j; addLegend(); redraw();
      const k = new URLSearchParams(location.search).get("known");
      if (k) setTimeout(() => awaitingLayer.openKnown(k), 400);
    });
  }
  if (new URLSearchParams(location.search).get("layer") === "awaiting") start();
})();
