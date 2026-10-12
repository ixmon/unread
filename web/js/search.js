/* Unread Atlas corpus search (search.html).
 * Talks to the Unread Atlas search API (aws-cunei-search, Lambda behind CloudFront):
 *   GET /search?q=&period=&genre=&site=&src=&in=all|en|atf|meta&page=&limit=&at=
 *       (at = one find-spot key from /search/sites; set by the map layer's "Open in Search" link)
 *   GET /text/<id | src:id>
 *   GET /stats   (tablets = distinct tablets, texts = per-source records)
 * Everything (query, filters, page, open text) lives in the URL so searches can be shared.
 * No dependencies. */
(() => {
  "use strict";

  const API = (new URLSearchParams(location.search).get("api") || "https://d3qsgtzicfbir4.cloudfront.net").replace(/\/+$/, "");
  const LIMIT = 20;
  const SLOW_MS = 1200; // after this, say we're waking the archive (Lambda cold start ≈ 12 s)
  const TIMEOUT_MS = 35000; // CloudFront origin timeout is 30 s
  const SRC_NAMES = { cdli: "CDLI", oracc: "ORACC", ebl: "eBL", tlhdig: "TLHdig", achemenet: "Achemenet" };
  const SRC_LINKS = {
    cdli: (id) => (/^P\d+$/.test(id) ? `https://cdli.earth/artifacts/${parseInt(id.slice(1), 10)}` : null),
    ebl: (id) => `https://www.ebl.lmu.de/library/${encodeURIComponent(id)}`,
    oracc: (id, ed) => (ed.project ? `https://oracc.museum.upenn.edu/${ed.project}/${encodeURIComponent(id)}` : `https://oracc.museum.upenn.edu/`),
  };
  const PARAMS = ["q", "in", "period", "genre", "site", "src", "page", "at"];

  const $ = (s) => document.querySelector(s);
  const form = $("#search-form");
  const statusEl = $("#status");
  const resultsEl = $("#results");
  const pagerEl = $("#pager");
  const textEl = $("#text-view");
  let links = { reader: new Set(), pages: {} };
  let seq = 0; // latest render wins
  let warm = false;

  // ─── helpers ───
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "?");
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : fmt(n));
  const known = (v) => v && !/^(unknown|uncertain|—|-)$/i.test(String(v).trim());

  function readState() {
    const p = new URLSearchParams(location.search);
    const s = {};
    for (const k of PARAMS) s[k] = (p.get(k) || "").trim();
    s.in = ["all", "atf", "en", "meta"].includes(s.in) ? s.in : "all";
    s.page = Math.max(1, parseInt(s.page, 10) || 1);
    s.text = (p.get("text") || "").trim();
    return s;
  }

  function urlFor(s) {
    const p = new URLSearchParams();
    if (API !== "https://d3qsgtzicfbir4.cloudfront.net") p.set("api", API);
    if (s.q) p.set("q", s.q);
    if (s.in && s.in !== "all") p.set("in", s.in);
    for (const k of ["period", "genre", "site", "src", "at"]) if (s[k]) p.set(k, s[k]);
    if (s.page > 1) p.set("page", s.page);
    if (s.text) p.set("text", s.text);
    const qs = p.toString();
    return location.pathname + (qs ? "?" + qs : "");
  }

  function go(s, replace = false) {
    const u = urlFor(s);
    if (replace) history.replaceState(null, "", u);
    else history.pushState(null, "", u);
    render();
  }

  function setStatus(html, cls = "") {
    statusEl.className = "search-status" + (cls ? " " + cls : "");
    statusEl.innerHTML = html;
  }
  const spin = (msg) => `<span class="spinner" aria-hidden="true"></span><span>${esc(msg)}</span>`;

  class ApiError extends Error {
    constructor(kind, message, status) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  }

  async function fetchOnce(path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(API + path, { signal: ctl.signal, headers: { Accept: "application/json" } });
    } catch (e) {
      // CORS-less responses (CloudFront WAF 403, throttled 429) also land here: the browser hides them.
      throw new ApiError(e.name === "AbortError" ? "timeout" : "network", e.message);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* non-JSON (CloudFront/WAF error page) */
    }
    if (res.ok && body) return body;
    if (res.status === 429) throw new ApiError("rate", "Too many requests", 429);
    if (res.status === 403) throw new ApiError("blocked", "Request blocked", 403);
    if (res.status === 404) throw new ApiError("notfound", (body && body.error) || "Not found", 404);
    if (res.status === 400) throw new ApiError("bad", (body && (body.error + (body.detail ? `: ${body.detail}` : ""))) || "Bad request", 400);
    throw new ApiError(res.status >= 500 ? "server" : "http", (body && body.error) || `HTTP ${res.status}`, res.status);
  }

  /** GET with cold-start UX: a "waking the archive" spinner when slow, one retry on timeout/network/5xx. */
  async function api(path, { onSlow } = {}) {
    const slow = setTimeout(() => onSlow && onSlow(warm ? "Searching…" : "Waking the archive… (the first search after a quiet spell takes ~15 s)"), SLOW_MS);
    try {
      try {
        const r = await fetchOnce(path);
        warm = true;
        return r;
      } catch (e) {
        if (!["timeout", "network", "server"].includes(e.kind)) throw e;
        onSlow && onSlow("Waking the archive… retrying once");
        await new Promise((r) => setTimeout(r, 1500));
        const r = await fetchOnce(path);
        warm = true;
        return r;
      }
    } finally {
      clearTimeout(slow);
    }
  }

  function errorHtml(e, retryable = true) {
    let msg;
    switch (e.kind) {
      case "rate":
      case "blocked":
        msg = "The archive is getting more requests than it can take right now (searches are rate-limited per visitor). Please wait a minute and try again.";
        break;
      case "timeout":
        msg = "The archive did not answer in time. It may still be waking up; try again in a few seconds.";
        break;
      case "network":
        msg = "Could not reach the archive. Check your connection; if you have run many searches in a few minutes, the rate limit may be blocking you for a little while.";
        break;
      case "bad":
        msg = `The search could not be run: ${e.message}.`;
        retryable = false;
        break;
      case "notfound":
        msg = "No text with that ID in the searchable corpus.";
        retryable = false;
        break;
      default:
        msg = `The archive returned an error (${e.message}).`;
    }
    return `<span>${esc(msg)}</span>${retryable ? ' <button type="button" class="btn retry" data-retry>Try again</button>' : ""}`;
  }

  // ─── highlighting ───
  const ATF_MAP = { š: "sz", ṣ: "s,", ṭ: "t,", ḫ: "h", ŋ: "j", ĝ: "j", "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
  const atfAscii = (s) => s.replace(/[šṣṭḫŋĝ₀-₉]/gi, (c) => {
    const m = ATF_MAP[c.toLowerCase()];
    return c === c.toLowerCase() ? m : m.toUpperCase();
  });
  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "");

  function termsFor(q) {
    const out = new Map(); // word -> prefix?
    for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
      const raw = m[1] ?? m[2];
      if (m[1] == null && /^(AND|OR|NOT|NEAR)$/.test(raw)) continue;
      const words = raw.match(/[\p{L}\p{N}_]+/gu) || [];
      const prefix = words.length === 1 && raw.endsWith("*");
      for (const w of words) {
        for (const v of new Set([w, atfAscii(w), fold(w), fold(atfAscii(w))])) if (v) out.set(v.toLowerCase(), prefix || out.get(v.toLowerCase()));
      }
    }
    return out;
  }

  function highlight(text, terms) {
    if (!terms.size) return esc(text);
    const words = [...terms.keys()].sort((a, b) => b.length - a.length);
    const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${alt})([\\p{L}\\p{N}_]*)`, "giu");
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      const word = m[1].toLowerCase();
      const isPrefix = terms.get(word);
      if (m[2] && !isPrefix) continue; // whole-word match only unless word*
      out += esc(text.slice(last, m.index)) + "<mark>" + esc(m[0]) + "</mark>";
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  // ─── links to the rest of the site ───
  function siteLinks(id, canon) {
    const out = [];
    const page = links.pages[id] || (canon && links.pages[canon]);
    if (page) out.push(`<a href="${esc(page)}">Curated page</a>`);
    const rid = links.reader.has(id) ? id : canon && links.reader.has(canon) ? canon : null;
    if (rid) out.push(`<a href="index.html?id=${encodeURIComponent(rid)}">Open in map &amp; reader</a>`);
    return out;
  }

  function sourceLink(ed) {
    const f = SRC_LINKS[ed.src];
    const u = f && f(ed.id, ed);
    const name = (ed.source && ed.source.name) || SRC_NAMES[ed.src] || ed.src;
    if (u) return `<a href="${esc(u)}" target="_blank" rel="noopener">View at ${esc(SRC_NAMES[ed.src] || name)}</a>`;
    if (ed.source && ed.source.url) return `<a href="${esc(ed.source.url)}" target="_blank" rel="noopener">${esc(name)}</a>`;
    return "";
  }

  const textParam = (r) => (r.url || "").replace(/^\/text\//, "") || `${r.src}:${r.id}`;

  // ─── stats + filters ───
  function fillSelect(sel, pairs, current) {
    const first = sel.options[0];
    sel.innerHTML = "";
    sel.appendChild(first);
    const vals = new Set();
    for (const [value, label] of pairs) {
      vals.add(value);
      sel.add(new Option(label, value));
    }
    if (current && !vals.has(current)) sel.add(new Option(current, current));
    sel.value = current || "";
  }

  async function loadStats() {
    try {
      const st = await api("/stats", { onSlow: (m) => ($("#stats-line").innerHTML = spin(m)) });
      const n = st.texts;
      const srcs = (st.by_source || []).map((s) => SRC_NAMES[s.src] || s.src).join(", ");
      const model = (st.models || [])[0];
      const tablets = typeof st.tablets === "number" ? st.tablets : null;
      const lead = tablets
        ? `Search <strong>${esc(short(tablets))}</strong> tablets (${esc(short(n))} text records from ${esc(srcs)}): `
        : `Search <strong>${esc(short(n))}</strong> text records from ${esc(srcs)}: `;
      $("#stats-line").innerHTML =
        lead +
        `${esc(short(st.atf_lines))} transliteration lines, ${esc(short(st.mt_lines))} lines of machine-draft English` +
        (model ? ` (${esc(model.label)}, ${esc(model.translated_on)})` : "") +
        ` and ${esc(short(st.human_en_lines))} lines of open human translation.`;
      $("#stats-line").title = (tablets ? `${fmt(tablets)} distinct tablets in ` : "") +
        `${fmt(n)} records (the same tablet can appear in more than one source), ${fmt(st.texts_with_public_atf)} with republishable ATF; index built ${st.built_at}`;
      const s = readState();
      fillSelect($("#f-period"), (st.top_periods || []).map(([v, c]) => [v, `${v} (${short(c)})`]), s.period);
      fillSelect($("#f-genre"), (st.top_genres || []).map(([v, c]) => [v, `${v} (${short(c)})`]), s.genre);
      // Sites come as "Nippur (mod. Nuffar)" and "Nippur"; the API filter is a substring match, so offer the ancient name once.
      const sites = new Map();
      for (const [v, c] of st.top_sites || []) {
        const base = v.replace(/\s*\(.*\)\s*$/, "").trim();
        if (!known(base)) continue;
        sites.set(base, (sites.get(base) || 0) + c);
      }
      fillSelect($("#f-site"), [...sites].sort((a, b) => b[1] - a[1]).map(([v, c]) => [v, `${v} (${short(c)})`]), s.site);
      fillSelect($("#f-src"), (st.by_source || []).map((x) => [x.src, `${SRC_NAMES[x.src] || x.src} (${short(x.texts)})`]), s.src);
    } catch (e) {
      $("#stats-line").textContent = "Full-text search over transliterations, machine-draft English and open human translations.";
      console.warn("stats failed", e);
    }
  }

  async function loadLinks() {
    try {
      const r = await fetch("data-curated/search-links.json");
      if (!r.ok) return;
      const j = await r.json();
      links = { reader: new Set(j.reader || []), pages: j.pages || {} };
    } catch (_) {
      /* links are optional */
    }
  }

  function syncForm(s) {
    $("#q").value = s.q;
    for (const r of form.querySelectorAll('input[name="in"]')) r.checked = r.value === (s.in === "meta" ? "all" : s.in);
    for (const k of ["period", "genre", "site", "src"]) {
      const sel = $(`#f-${k}`);
      if (s[k] && ![...sel.options].some((o) => o.value === s[k])) sel.add(new Option(s[k], s[k]));
      sel.value = s[k];
    }
  }

  // ─── search results ───
  function snippetHtml(sn, terms) {
    const kinds = {
      human_en: `Human EN${sn.author ? " · " + sn.author.replace(/\s*\(.*\)$/, "") : ""}`,
      machine_en: "Machine draft",
      atf: "ATF",
      meta: "Catalogue",
    };
    const line = sn.line ? `<span class="snip-line">${esc(sn.line)}</span>` : "";
    return `<li class="snip"><span class="snip-kind" title="${esc(sn.author || sn.model || "")}">${esc(kinds[sn.kind] || sn.kind)}</span>` +
      `<span class="snip-text ${esc(sn.kind)}">${line}${highlight(sn.text || "", terms)}</span></li>`;
  }

  function resultHtml(r, terms, s) {
    const href = urlFor({ ...s, text: textParam(r) });
    const facts = [r.period, known(r.site) ? r.site : "find-spot unknown", r.genre, r.language, known(r.museum_no) ? r.museum_no : null]
      .filter(Boolean)
      .map(esc)
      .join('<span class="sep">·</span>');
    const badges = [`<span class="badge">${esc(SRC_NAMES[r.src] || r.src)}</span>`];
    if (r.n_human_en_lines) badges.push(`<span class="badge badge-human">human EN · ${fmt(r.n_human_en_lines)} lines</span>`);
    if (r.n_mt_lines) badges.push(`<span class="badge badge-draft">machine draft · ${fmt(r.n_mt_lines)} lines</span>`);
    if (!r.atf_public) badges.push(`<span class="badge badge-withheld">no ATF shown</span>`);
    const extra = siteLinks(r.id, r.canonical_id);
    return `<div class="result">
      <div class="result-head"><a class="result-id" href="${esc(href)}" data-text="${esc(textParam(r))}">${esc(r.id)}</a>
        ${r.designation && r.designation !== r.id ? `<a class="result-title" href="${esc(href)}" data-text="${esc(textParam(r))}">${esc(r.designation)}</a>` : ""} ${badges.join(" ")}</div>
      <div class="result-facts">${facts}</div>
      ${r.snippets && r.snippets.length ? `<ul class="snips">${r.snippets.map((x) => snippetHtml(x, terms)).join("")}</ul>` : ""}
      ${extra.length ? `<div class="result-links">${extra.join("")}</div>` : ""}
    </div>`;
  }

  function pagerHtml(s, pages) {
    if (pages <= 1) return "";
    const cur = s.page;
    const want = new Set([1, pages, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((p) => p >= 1 && p <= pages));
    const nums = [...want].sort((a, b) => a - b);
    let out = cur > 1 ? `<a href="${esc(urlFor({ ...s, page: cur - 1 }))}" data-page="${cur - 1}" rel="prev">← Prev</a>` : "";
    let prev = 0;
    for (const p of nums) {
      if (p - prev > 1) out += '<span class="gap">…</span>';
      out += p === cur ? `<span class="cur" aria-current="page">${p}</span>` : `<a href="${esc(urlFor({ ...s, page: p }))}" data-page="${p}">${p}</a>`;
      prev = p;
    }
    if (cur < pages) out += `<a href="${esc(urlFor({ ...s, page: cur + 1 }))}" data-page="${cur + 1}" rel="next">Next →</a>`;
    return out;
  }

  /** index.html deep link for the map's search-results layer (same query and filters). */
  function mapUrl(s) {
    const p = new URLSearchParams();
    if (API !== "https://d3qsgtzicfbir4.cloudfront.net") p.set("searchapi", API);
    if (s.q) p.set("q", s.q);
    if (s.in && s.in !== "all") p.set("in", s.in);
    for (const k of ["period", "genre", "site", "src"]) if (s[k]) p.set(k, s[k]);
    return "index.html?" + p.toString();
  }

  async function runSearch(s, my) {
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    p.set("in", s.in);
    for (const k of ["period", "genre", "site", "src", "at"]) if (s[k]) p.set(k, s[k]);
    p.set("page", s.page);
    p.set("limit", LIMIT);
    resultsEl.innerHTML = "";
    pagerEl.innerHTML = "";
    setStatus(spin("Searching…"));
    let d;
    try {
      d = await api("/search?" + p.toString(), { onSlow: (m) => my === seq && setStatus(spin(m)) });
    } catch (e) {
      if (my === seq) setStatus(errorHtml(e), "error");
      return;
    }
    if (my !== seq) return;
    const terms = termsFor(s.q);
    const total = d.total || 0;
    if (!total) {
      setStatus(`No texts match${s.q ? ` <strong>${esc(s.q)}</strong>` : ""}. Try fewer words, another scope or fewer filters.`);
      return;
    }
    const from = (d.page - 1) * d.limit + 1;
    const to = Math.min(from + d.results.length - 1, total);
    const capped = d.total_is_capped ? "+" : "";
    const reachable = d.pages * d.limit < total ? ` · only the first ${fmt(d.pages * d.limit)} can be paged; narrow the search with filters` : "";
    const at = s.at
      ? ` · at one find-spot${d.results[0] && known(d.results[0].site) ? ` (${esc(d.results[0].site)})` : ""} <a href="${esc(urlFor({ ...s, at: "", page: 1 }))}" data-text-free>all sites</a>`
      : "";
    setStatus(`<span><strong>${fmt(total)}${capped}</strong> text${total === 1 ? "" : "s"}${at} · showing ${fmt(from)}–${fmt(to)} · ${fmt(d.took_ms)} ms${reachable}</span>` +
      ` <a class="btn map-btn" href="${esc(mapUrl(s))}" title="Pin every match at its find-spot on the map">Show on map</a>`);
    resultsEl.innerHTML = d.results.map((r) => resultHtml(r, terms, s)).join("");
    pagerEl.innerHTML = pagerHtml(s, d.pages);
  }

  // ─── text view ───
  function linesTable(ed) {
    let lastSurface = null;
    const rows = [];
    for (const l of ed.lines) {
      if (l.surface && l.surface !== lastSurface) {
        rows.push(`<tr class="surface-row"><td colspan="3">${esc(l.surface)}</td></tr>`);
        lastSurface = l.surface;
      }
      rows.push(`<tr><td class="ln">${esc(l.n)}</td><td class="atf">${esc(l.atf)}</td>` +
        `<td class="mt${l.mt ? "" : " none"}">${l.mt ? esc(l.mt) : ed.model ? "—" : ""}</td></tr>`);
    }
    return `<table class="lines-table"><thead><tr><th>Line</th><th>ATF (transliteration)</th><th>English (machine draft)</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  function modelLabel(m) {
    if (!m) return "";
    const rev = (m.revision || "").slice(0, 7);
    return `<p class="machine-draft"><strong>Machine draft, ${esc(m.label || "atf-en-best-v2")}</strong> · ` +
      `<a href="https://huggingface.co/${esc(m.repo)}" target="_blank" rel="noopener">${esc(m.repo)}</a>${rev ? "@" + esc(rev) : ""}, translated ${esc(m.translated_on || "?")}. ` +
      `Unreviewed machine output, not a scholarly translation.</p>`;
  }

  function humanBlock(ed) {
    if (!ed.human_en || !ed.human_en.length) return "";
    const credits = new Map();
    for (const h of ed.human_en) {
      const k = [h.author, h.edition, h.license].map((x) => x || "").join("|");
      credits.set(k, h);
    }
    const credit = [...credits.values()]
      .map((h) => [h.author && `Translation: ${esc(h.author)}`, h.edition && `edition ${esc(h.edition)}`, h.license && `licence: ${esc(h.license)}`].filter(Boolean).join(" · "))
      .join("<br>");
    const src = ed.source && ed.source.citation ? `<br>Via ${esc(ed.source.citation)}` : "";
    return `<section class="human-block"><h3>Human translation (${fmt(ed.human_en.length)} lines)</h3>` +
      ed.human_en.map((h) => `<div class="human-line"><span class="ln">${esc(h.line || "")}</span><span>${esc(h.en)}</span></div>`).join("") +
      `<div class="human-credit">${credit}${src}</div></section>`;
  }

  function editionHtml(ed, idx) {
    const meta = [
      ["ID", ed.id + (ed.canonical_id && ed.canonical_id !== ed.id ? ` (= ${ed.canonical_id})` : "")],
      ["Source", (ed.source && ed.source.name) || ed.src],
      ["Period", ed.period],
      ["Find-spot", known(ed.site) ? ed.site : "unknown"],
      ["Genre", ed.genre],
      ["Language", ed.language],
      ["Museum no.", known(ed.museum_no) ? ed.museum_no : null],
      ["Collection", ed.collection],
      ["Object", ed.object_type],
      ["Project", ed.project],
      ["Source licence", ed.source && ed.source.license],
    ].filter(([, v]) => v);
    const lk = [sourceLink(ed), ...siteLinks(ed.id, ed.canonical_id)].filter(Boolean);
    let body = "";
    if (ed.atf_withheld) {
      const ebl = ed.src === "ebl" || (ed.source && ed.source.atf_public === false);
      body += `<p class="withheld">${ebl ? "<strong>Transliteration not republishable.</strong> " : ""}${esc(ed.atf_withheld)}</p>`;
    }
    const hasMt = (ed.lines || []).some((l) => l.mt) || (ed.mt_lines || []).length;
    if (hasMt) body += modelLabel(ed.model);
    if (ed.lines && ed.lines.length) body += linesTable(ed);
    if (ed.mt_lines && ed.mt_lines.length) {
      body += `<section class="mt-block"><h3>English (machine draft${ed.lines && ed.lines.length ? ", lines not aligned to the ATF above" : ""})</h3>` +
        `<table class="lines-table"><thead><tr><th>Line</th><th>English (machine draft)</th></tr></thead><tbody>` +
        ed.mt_lines.map((l) => `<tr><td class="ln">${esc(l.line || "")}</td><td class="mt">${esc(l.mt)}</td></tr>`).join("") +
        `</tbody></table></section>`;
    }
    body += humanBlock(ed);
    if (ed.truncated) body += `<p class="withheld">Long text: only the first 3,000 lines are shown here. See the source for the rest.</p>`;
    if (!body) body = `<p class="withheld">Catalogue record only: no transliteration or English in this source.</p>`;
    return `<section class="edition" id="ed-${idx}">
      <h2>${esc(ed.designation || ed.id)}<span class="ed-src">${esc(SRC_NAMES[ed.src] || ed.src)}</span></h2>
      ${lk.length ? `<div class="ed-links">${lk.join("")}</div>` : ""}
      <table class="meta-table">${meta.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
      ${body}
    </section>`;
  }

  async function showText(s, my) {
    textEl.hidden = false;
    const back = urlFor({ ...s, text: "" });
    const hasSearch = s.q || s.period || s.genre || s.site || s.src || s.at;
    const backLink = `<p class="back"><a href="${esc(back)}" data-back>← ${hasSearch ? "Back to results" : "Search"}</a></p>`;
    textEl.innerHTML = backLink;
    setStatus(spin("Loading text…"));
    let d;
    try {
      d = await api("/text/" + encodeURIComponent(s.text).replace(/%3A/gi, ":"), { onSlow: (m) => my === seq && setStatus(spin(m)) });
    } catch (e) {
      if (my === seq) setStatus(errorHtml(e), "error");
      return;
    }
    if (my !== seq) return;
    setStatus("");
    const eds = d.editions || [];
    // Editions sharing a canonical id: the requested one first, then the rest, each with its own licence rules.
    const main = eds[0] || {};
    document.title = `${main.designation || d.id} · Search · Unread Atlas`;
    const others = eds.length > 1
      ? `<p class="other-eds">Also in: ${eds.slice(1).map((e, i) => `<a href="#ed-${i + 1}">${esc(SRC_NAMES[e.src] || e.src)} ${esc(e.id)}</a>`).join(", ")}</p>`
      : "";
    textEl.innerHTML = backLink + others + eds.map(editionHtml).join("") +
      `<p class="sub">${esc(d.notice || "")}</p>`;
    window.scrollTo(0, 0);
  }

  // ─── router ───
  async function render() {
    const my = ++seq;
    const s = readState();
    syncForm(s);
    if (s.text) {
      form.hidden = true;
      resultsEl.innerHTML = "";
      pagerEl.innerHTML = "";
      await showText(s, my);
      return;
    }
    form.hidden = false;
    textEl.hidden = true;
    textEl.innerHTML = "";
    document.title = s.q ? `${s.q} · Search · Unread Atlas` : "Search the corpus · Unread Atlas";
    if (!s.q && !s.period && !s.genre && !s.site && !s.src) {
      setStatus("");
      resultsEl.innerHTML = `<p class="sub">Try <a href="?q=Gilgamesh">Gilgamesh</a>, <a href="?q=sza3-zi-ga&amp;in=atf">sza3-zi-ga</a> (ATF), ` +
        `<a href="?q=%22barley%20rations%22&amp;in=en">"barley rations"</a>, <a href="?q=P262784">P262784</a>, ` +
        `or pick a filter, e.g. <a href="?genre=Medical&amp;period=Neo-Assyrian">Neo-Assyrian medical texts</a>.</p>`;
      pagerEl.innerHTML = "";
      return;
    }
    await runSearch(s, my);
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    go({
      q: String(fd.get("q") || "").trim(),
      in: String(fd.get("in") || "all"),
      period: String(fd.get("period") || ""),
      genre: String(fd.get("genre") || ""),
      site: String(fd.get("site") || ""),
      src: String(fd.get("src") || ""),
      page: 1,
      text: "",
    });
  });
  // changing a filter or the scope re-runs the search right away when there is something to search
  form.addEventListener("change", (ev) => {
    if (ev.target.matches("select, input[type=radio]") && ($("#q").value.trim() || [...form.querySelectorAll("select")].some((x) => x.value))) {
      form.requestSubmit();
    }
  });

  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-page], a[data-text], a[data-back], a[data-text-free], .search-results .sub a, button[data-retry]");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return;
    if (a.matches("button[data-retry]")) {
      render();
      return;
    }
    if (a.origin && a.origin !== location.origin) return;
    ev.preventDefault();
    history.pushState(null, "", a.getAttribute("href").startsWith("?") ? location.pathname + a.getAttribute("href") : a.getAttribute("href"));
    render();
    if (a.matches("[data-page]")) window.scrollTo(0, 0);
  });
  window.addEventListener("popstate", render);

  loadStats();
  loadLinks().then(render);
})();
