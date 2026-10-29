/**
 * Unread Atlas — browse + reader app (site name lives in web/site.json)
 */

const DATA_BASE = "data";
const TRANSLATOR_PAGE = "translate.html";
/**
 * Corpus API (same one search.html and browse.html use) for every tablet that is not one of the
 * ~50 packaged samples under data/texts/. Same-origin /api on unreadatlas.com; previews served from
 * another host proxy /api themselves (see .preview/serve.py) or pass ?textapi=https://unreadatlas.com/api.
 */
const TEXT_API = (
  new URLSearchParams(location.search).get("textapi") ||
  (location.protocol === "file:" ? "https://unreadatlas.com/api" : `${location.origin}/api`)
).replace(/\/+$/, "");

const OMEN_KIND_LABELS = {
  physiognomy: "Physiognomy",
  extispicy: "Liver",
  birth: "Birth",
  astral: "Astral",
  skin: "Skin",
  moles: "Moles",
  dream: "Dreams",
  series: "Series",
};

const MATH_KIND_LABELS = {
  reciprocal: "Reciprocals",
  multiplication: "× tables",
  metrology: "Metrology",
  coefficient: "Coefficients",
  problem: "Problems",
  math: "Other",
};

const state = {
  catalog: null,
  filtered: [],
  selectedId: null,
  currentText: null,
  view: "explore", // explore | reader | about
  readerPanels: { english: true, atf: true, cuneiform: true, meta: false },
  cdliLiveCache: {}, // id -> fetched CDLI JSON snippet
  font: "Assurbanipal",
  cuneiformCache: new Map(), // atf line -> unicode
  map: null,
  markers: {},
  timelineYear: -2000,
  timeFade: false, // map fading by date; switches on at first slider interaction ("All periods" turns it off)
  markerGroups: {}, // site key -> { lat, lon, site, items }
  markerSig: "",
  omenKind: null, // subtype chip filter when omens mode on
  mathKind: null,
};

// ─── DOM helpers ───
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function toast(msg, ms = 2800) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

// ─── Data loading ───
async function loadCatalog() {
  const res = await fetch(`${DATA_BASE}/catalog.json`);
  if (!res.ok) throw new Error("catalog.json missing — run scripts/build_catalog.py");
  state.catalog = await res.json();
  try {
    await FontMap.load("fonts/fonts.json");
  } catch (e) {
    console.warn("font table:", e);
  }
  for (const it of state.catalog.items) it.font = FontMap.fontFor(it);
  const epicN = state.catalog.epic_hunt?.count || state.catalog.items.filter((i) => i.epic_hunt).length;
  const herbN = state.catalog.herbal_remedies?.count || state.catalog.items.filter((i) => i.herbal_remedy).length;
  const omenN = state.catalog.omens?.count || state.catalog.items.filter((i) => i.omen_hunt).length;
  const mathN = state.catalog.math?.count || state.catalog.items.filter((i) => i.math_hunt).length;
  // Featured-set sizes for the Stats page (corpus figures there come from corpus_stats.json)
  state.featuredCounts = { epic: epicN, remedies: herbN, omens: omenN, math: mathN };
  const items = state.catalog.items || [];
  state.translationListCounts = {
    unread: items.filter((i) => i.translation_status === "no_open_english").length,
    noEnglish: items.filter((i) => !i.open_english).length,
    notOnline: items.filter((i) => i.translation_status === "print_edition").length,
  };
  const fillCount = (key, n) => {
    document.querySelectorAll(`[data-count="${key}"]`).forEach((el) => {
      el.textContent = n ? `(${n.toLocaleString()})` : "";
    });
  };
  fillCount("unread", state.translationListCounts.unread);
  fillCount("no-english", state.translationListCounts.noEnglish);
  fillCount("not-online", state.translationListCounts.notOnline);
  if (state.view === "stats") renderStats();
  // Featured rows
  const featRow = $("#featured-row");
  if (featRow && (state.catalog.epic_hunt?.featured || []).length) {
    featRow.hidden = false;
  }
  const herbRow = $("#featured-herbal-row");
  if (herbRow && (state.catalog.herbal_remedies?.featured || []).length) {
    herbRow.hidden = false;
  }
  const omenRow = $("#featured-omen-row");
  if (omenRow && (state.catalog.omens?.featured || []).length) {
    omenRow.hidden = false;
  }
  const mathRow = $("#featured-math-row");
  if (mathRow && (state.catalog.math?.featured || []).length) {
    mathRow.hidden = false;
  }
  populateFilterOptions();
  renderKindChips();
  // Deep-link mode=epic | remedies | omens | math  (+ optional kind=)
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  const kind = params.get("kind");
  if (mode === "epic") {
    const eh = $("#filter-epic-hunt");
    if (eh) eh.checked = true;
  }
  if (mode === "unread") {
    const ug = $("#filter-open-gap");
    if (ug) ug.checked = true;
  }
  if (mode === "no-english" || mode === "no_english") {
    const ne = $("#filter-no-english");
    if (ne) ne.checked = true;
  }
  if (mode === "not-online" || mode === "not_online" || mode === "print") {
    const no = $("#filter-not-online");
    if (no) no.checked = true;
  }
  if (mode === "remedies" || mode === "herbal") {
    const hr = $("#filter-herbal");
    if (hr) hr.checked = true;
  }
  if (mode === "omens" || mode === "omen") {
    const om = $("#filter-omens");
    if (om) om.checked = true;
    if (kind) state.omenKind = kind;
  }
  if (mode === "math") {
    const mh = $("#filter-math");
    if (mh) mh.checked = true;
    if (kind) state.mathKind = kind;
  }
  applyFilters();
}

function renderKindChips() {
  const omenKinds =
    state.catalog.omens?.kinds ||
    [
      ...new Set(
        (state.catalog.items || [])
          .filter((i) => i.omen_hunt && i.omen_kind)
          .map((i) => i.omen_kind)
      ),
    ].sort();
  const mathKinds =
    state.catalog.math?.kinds ||
    [
      ...new Set(
        (state.catalog.items || [])
          .filter((i) => i.math_hunt && i.math_kind)
          .map((i) => i.math_kind)
      ),
    ].sort();

  const fill = (sel, kinds, labels, activeKey) => {
    const el = $(sel);
    if (!el) return;
    const allActive = !state[activeKey];
    el.innerHTML =
      `<button type="button" class="kind-chip ${allActive ? "active" : ""}" data-kind="">All</button>` +
      kinds
        .map((k) => {
          const active = state[activeKey] === k ? "active" : "";
          return `<button type="button" class="kind-chip ${active}" data-kind="${escapeAttr(
            k
          )}">${escapeHtml(labels[k] || k)}</button>`;
        })
        .join("");
  };
  fill("#omen-kind-chips", omenKinds, OMEN_KIND_LABELS, "omenKind");
  fill("#math-kind-chips", mathKinds, MATH_KIND_LABELS, "mathKind");
}

async function loadText(id) {
  // 1) packaged sample (data/texts/<id>.json, only ~50 of them)
  if (!state._packagedIds?.length || state._packagedIds.includes(id)) {
    try {
      const res = await fetch(`${DATA_BASE}/texts/${encodeURIComponent(id)}.json`);
      if (res.ok) return await res.json();
    } catch (_) {
      /* ignore */
    }
  }
  // 2) the corpus API: every tablet browse.html / search.html can show (ATF + machine/human English)
  try {
    const fromApi = await loadTextFromApi(id);
    if (fromApi) return fromApi;
  } catch (e) {
    console.warn("text API:", e);
  }
  // 3) thin catalog stub
  const item = state.catalog?.items?.find((x) => x.id === id);
  if (!item) return null;
  return {
    ...item,
    atf: null,
    lines: [],
    english: null,
    english_note:
      "Full ATF not packaged for this work yet. Sample texts are pre-bundled; expand with scripts/build_catalog.py.",
    status: "stub",
  };
}

/** Fetch /api/text/<id> and adapt its best edition to the reader's packaged-text shape. */
async function loadTextFromApi(id) {
  const res = await fetch(`${TEXT_API}/text/${encodeURIComponent(id).replace(/%3A/gi, ":")}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const [json] = await Promise.all([res.json(), loadTrPolicy()]);
  return apiTextToReader(json, id);
}

// graded machine-English confidence (API field `conf`, 1..3; absent/0 = normal). Generic: any confidence source can set it.
const CONF_TITLES = { 1: "Lower confidence: line is broken", 2: "Low confidence: few signs survive", 3: "Very low confidence: a guess" };
const confLevel = (c) => (c === 1 || c === 2 || c === 3 ? c : 0);

// ─── Translation tabs (human editions + machine draft) ───
// Per-source rules live in assets/translation-policy.json: show_human (may we display that source's human
// English?) and default ('human' | 'machine': which tab opens first). Unknown sources: human hidden, machine shown.
const TR_POLICY_FALLBACK = { machine_label: "Machine", sources: { unknown: { name: "Other source", show_human: false, default: "machine" } } };
let _trPolicyP = null;
function loadTrPolicy() {
  return (_trPolicyP ||= fetch("assets/translation-policy.json")
    .then((r) => (r.ok ? r.json() : TR_POLICY_FALLBACK))
    .catch(() => TR_POLICY_FALLBACK)
    .then((p) => (state.trPolicy = p)));
}
function trPolicyFor(src) {
  const all = (state.trPolicy || TR_POLICY_FALLBACK).sources || {};
  return all[src] || all.unknown || TR_POLICY_FALLBACK.sources.unknown;
}
/** Translator name fit for a credit line, or null for placeholders ("uncertain", "ORACC project x/y", …). */
function cleanTranslator(a) {
  a = String(a || "").replace(/\s*\((CDLI )?translation_source\)|\s*\(see CDLI record\)/g, "").trim();
  return !a || /^(uncertain|unknown|check|cdli contributor|no translat|translator not named|oracc project\b)/i.test(a) ? null : a;
}
const modelShort = (label) => String(label || "").replace(/^atf-en-(t5base-)?/, "") || "model";

/**
 * The text API returns ATF-less mt_lines (eBL) in database row order, not line order (Asb.h came back 6,3,2,4,7,1,5).
 * Sort them by a natural line key: surface order (obv, rev, edges…), column, then the numeric line number (3' / 10a ok).
 * Stable, so lines with unparseable labels keep their relative order.
 */
const SURF_ORDER = ["", "o", "e", "be", "r", "te", "le", "re"];
function mtLineSortKey(label) {
  const parts = String(label || "").trim().split(/\s+/);
  const last = parts.pop() || "";
  const m = /^(\d+)(\D*)$/.exec(last.replace(/[′’ʼ]/g, "'"));
  if (!m) return null;
  const surf = normSurf(parts.join(" "));
  const [side, col] = surf.split(":");
  let si = SURF_ORDER.indexOf(side || "");
  if (si < 0) si = SURF_ORDER.length;
  return [si, parseInt(col || "0", 10) || 0, parseInt(m[1], 10), m[2]];
}
function sortMtLines(ml) {
  const keyed = ml.map((l, i) => ({ l, i, k: mtLineSortKey(l.line) }));
  if (keyed.some((x) => !x.k)) return ml; // can't parse every label: leave the API order alone
  keyed.sort((a, b) => {
    for (let j = 0; j < 4; j++) {
      const x = a.k[j], y = b.k[j];
      if (x !== y) return x < y ? -1 : 1;
    }
    return a.i - b.i;
  });
  return keyed.map((x) => x.l);
}

function apiTextToReader(d, requestedId) {
  const eds = (d && d.editions) || [];
  if (!eds.length) return null;
  const hasHum = (e) => Array.isArray(e.human_en) && e.human_en.some((h) => h && h.en);
  const hasMt = (e) => (Array.isArray(e.lines) && e.lines.some((l) => l.mt)) || (Array.isArray(e.mt_lines) && e.mt_lines.length);
  const hasAtf = (e) => Array.isArray(e.lines) && e.lines.some((l) => l.atf);
  // human English only from sources the policy lets us show (eBL never, unknown sources not until reviewed)
  const humEds = eds.filter((e) => hasHum(e) && trPolicyFor(e.src).show_human === true);
  const mtEd = eds.find((e) => hasMt(e) && hasAtf(e)) || eds.find(hasMt);
  // ATF column: the machine draft's edition when it has ATF (so MT rows line up), else a human edition, else any ATF
  const ed = (mtEd && hasAtf(mtEd) && mtEd) || humEds.find(hasAtf) || eds.find(hasAtf) || humEds[0] || mtEd || eds[0];
  const lines = (ed.lines || []).map((l) => ({
    type: "line",
    n: l.n != null ? String(l.n) : "",
    atf: l.atf || "",
    surface: l.surface || "",
    column: "",
    english: l.mt || null,
    conf: l.mt ? confLevel(l.conf) : 0, // optional per-line confidence level from the API: 1|2|3 = progressively lower; 0 = normal
  }));
  const text = {
    id: requestedId || d.id || ed.id,
    canonical_id: d.canonical_id || ed.canonical_id,
    designation: ed.designation,
    genre: ed.genre,
    language: ed.language,
    period: ed.period,
    site: ed.site && ed.site !== "unclear" ? ed.site : null,
    provenience: ed.site && ed.site !== "unclear" ? ed.site : null,
    lat: ed.lat,
    lon: ed.lon,
    museum_no: ed.museum_no,
    collection: ed.collection,
    content_lines: lines.length,
    atf_source: ed.source ? ed.source.name : ed.src,
    lines,
    atf: lines.length
      ? null
      : [...new Set(eds.map((e) => e.atf_withheld && `${e.source?.name || e.src}: ${e.atf_withheld}`).filter(Boolean))].join(" ") || null,
    english: null,
    status: "api",
    api_source: ed.src,
  };
  if (ed.src === "cdli" && /^P\d+$/.test(ed.id || "")) text.cdli_url = `https://cdli.earth/artifacts/${parseInt(ed.id.slice(1), 10)}`;

  const options = [];
  const used = new Set();
  for (const he of humEds) {
    const pol = trPolicyFor(he.src);
    const groups = new Map(); // one tab per edition/project within a source
    for (const h of he.human_en) {
      if (!h || !h.en) continue;
      const k = h.edition || he.project || "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    }
    for (const [edn, hs] of groups) {
      let key = he.src;
      if (used.has(key)) key = `${he.src}-${(edn || String(used.size)).replace(/[^A-Za-z0-9]+/g, "-")}`;
      used.add(key);
      const recordUrl =
        he.src === "cdli" && /^P\d+$/.test(he.id || "")
          ? `https://cdli.earth/artifacts/${parseInt(he.id.slice(1), 10)}`
          : he.src === "oracc" && (edn || he.project)
            ? `https://oracc.museum.upenn.edu/${edn || he.project}/${he.id}`
            : he.url || he.source?.url || null;
      options.push({
        key,
        kind: "human",
        src: he.src,
        label: `${pol.name || he.src.toUpperCase()}${edn ? ` · ${edn}` : ""}`,
        english: hs.map((h) => h.en),
        labels: hs.map((h) => h.line || ""),
        conf: null,
        translators: [...new Set(hs.map((h) => cleanTranslator(h.author)).filter(Boolean))],
        source_name: pol.full_name || he.source?.name || pol.name || he.src,
        edition: edn || null,
        record_url: recordUrl,
        src_lines: (he.lines || []).map((l) => ({ surface: l.surface || "", n: l.n != null ? String(l.n) : "" })),
        license: pol.license || hs.find((h) => h.license)?.license || he.source?.license || "",
        license_url: pol.license_url || pol.terms_url || null,
        note: `Human translation (${hs.length} lines)`,
      });
    }
  }
  if (mtEd) {
    const m = mtEd.model || {};
    const aligned = mtEd === ed && lines.some((l) => l.english);
    let english, labels = null, conf;
    if (aligned) {
      english = lines.map((l) => l.english || "");
      conf = lines.map((l) => l.conf);
    } else {
      const ml = Array.isArray(mtEd.mt_lines) && mtEd.mt_lines.length
        ? sortMtLines(mtEd.mt_lines)
        : (mtEd.lines || []).filter((l) => l.mt).map((l) => ({ line: [l.surface, l.n].filter(Boolean).join(" "), mt: l.mt, conf: l.conf }));
      english = ml.map((l) => l.mt || "");
      labels = ml.map((l) => l.line || "");
      conf = ml.map((l) => confLevel(l.conf));
    }
    const rev = /^[0-9a-f]{12,}$/.test(m.revision || "") ? m.revision.slice(0, 7) : m.revision || ""; // git sha -> short; tags like t5base-H2 kept whole
    options.push({
      key: "machine",
      kind: "machine",
      src: mtEd.src,
      label: `${(state.trPolicy || TR_POLICY_FALLBACK).machine_label || "Machine"} (${modelShort(m.label)})`,
      english,
      labels,
      conf: conf.some(Boolean) ? conf : null,
      n: english.filter(Boolean).length,
      note: m.repo
        ? `Machine translation · ${modelShort(m.label) || m.label || "model"}${m.translated_on ? ` · ${m.translated_on}` : ""}`
        : "Machine translation",
      meta: { kind: "machine_draft", model: m.label, model_repo: m.repo, translated_on: m.translated_on },
      model_label: m.label || "",
      translated_on: m.translated_on || "",
      src_lines: (mtEd.lines || []).map((l) => ({ surface: l.surface || "", n: l.n != null ? String(l.n) : "" })),
    });
  }
  text.translations = options;
  const defHuman = options.find((o) => o.kind === "human" && trPolicyFor(o.src).default === "human");
  text.tr_default = (defHuman || options.find((o) => o.kind === "machine") || options[0])?.key || null;
  text._notes_common = ed.truncated ? ["Long text: only the first 3,000 lines are included."] : [];
  applyTranslation(text, new URLSearchParams(location.search).get("tr"));

  // tablets outside the curated catalog have no translation-status assessment; say so instead of a raw key
  const inCatalog = state.catalog?.items?.some((x) => x.id === text.id);
  if (!inCatalog) {
    if (options.some((o) => o.kind === "human")) {
      const h = options.find((o) => o.kind === "human");
      text.translation_status = "open_project";
      text.translation_short = `Open: ${h.src.toUpperCase()}`;
    } else {
      text.translation_status = "unknown";
      text.translation_short = "Corpus text";
    }
    text.translation_detail = "From the full corpus (not in the curated catalog); translation status not assessed.";
  }
  return text;
}

/** Resolve a URL/tab token ("machine", "human", "oracc", "oracc-<edition>"…) to an option key, or null. */
function resolveTrKey(text, k) {
  const opts = text.translations || [];
  const o =
    opts.find((x) => x.key === k) ||
    (k === "human" ? opts.find((x) => x.kind === "human") : null) ||
    (k === "machine" ? opts.find((x) => x.kind === "machine") : null);
  return o ? o.key : null;
}

/**
 * Choose which translations are shown. `want` is a key, a comma list ("machine,oracc") or an array; the first
 * one drives the badges/chips. Anything unknown (or not allowed by the policy) falls back to the policy default.
 */
function applyTranslation(text, want) {
  const opts = text.translations || [];
  if (!opts.length) {
    text.english_note = (text._notes_common || []).join(" · ") || null;
    return;
  }
  const list = Array.isArray(want) ? want : String(want || "").split(",");
  let cols = [...new Set(list.map((k) => resolveTrKey(text, String(k).trim())).filter(Boolean))];
  if (!cols.length) cols = [text.tr_default || opts[0].key];
  text.tr_cols = cols;
  const o = opts.find((x) => x.key === cols[0]);
  text.tr_active = o.key;
  text.english = o.english;
  text.english_labels = o.labels || undefined;
  text.english_conf = o.conf || undefined;
  text.english_complete = true;
  text.english_kind = o.kind === "human" ? "human" : undefined;
  text.has_machine_draft = o.kind === "machine";
  text.machine_draft_lines = o.kind === "machine" ? o.n : undefined;
  text.translation_meta = o.kind === "machine" ? o.meta : undefined;
  text.english_note = [o.note, ...(text._notes_common || [])].filter(Boolean).join(" · ") || null;
}

/**
 * Keep the column choice in the URL (&tr=machine,oracc) so shared links and reloads open the same view; the
 * policy default drops the param. Each user change is a history entry, so Back/Forward step through views
 * (popstate below re-applies the URL).
 */
function setTrParam(text) {
  try {
    const cols = text.tr_cols || [];
    const u = new URL(location.href);
    u.searchParams.delete("tr");
    if (cols.length && !(cols.length === 1 && cols[0] === text.tr_default)) u.searchParams.set("tr", cols.join(","));
    const next = u.toString().replace(/%2C/gi, ",");
    if (next !== location.href) history.pushState({ tr: cols.join(",") }, "", next);
  } catch (_) {
    /* ignore */
  }
}
/**
 * Routing: the URL is the source of truth for the view. ?id=<tablet>[&tr=…][&find=…] = reader on that tablet;
 * ?view=about | ?view=reader (no tablet) = those views; neither = Explore. Every user view switch pushes an entry
 * (setView/openReader), and popstate re-renders from the URL, so Back/Forward walk About ⇄ Reader ⇄ Explore.
 */
const READER_PARAMS = ["id", "tr", "find", "mode"];
function viewUrl(view, id) {
  const u = new URL(location.href);
  u.searchParams.delete("view");
  if (view === "reader" && id) {
    if (u.searchParams.get("id") !== id) for (const k of READER_PARAMS) u.searchParams.delete(k);
    u.searchParams.set("id", id);
  } else {
    for (const k of READER_PARAMS) u.searchParams.delete(k);
    if (view === "about" || view === "reader" || view === "stats") u.searchParams.set("view", view);
  }
  return u.toString().replace(/%2C/gi, ",");
}
function syncUrl(view, id, mode) {
  if (mode === "none") return;
  const next = viewUrl(view, id);
  if (next === location.href) return;
  try {
    if (mode === "replace") history.replaceState({ view, id: id || null }, "", next);
    else history.pushState({ view, id: id || null }, "", next);
  } catch (_) {
    /* ignore */
  }
}
function routeFromUrl() {
  const q = new URLSearchParams(location.search);
  const id = q.get("id");
  if (id) {
    const text = state.currentText;
    if (text && text.id === id && !state.readerPending) {
      if (text.translations) applyTranslation(text, q.get("tr"));
      setView("reader", "none");
    } else {
      openReader(id, "none");
    }
    return;
  }
  const v = q.get("view");
  setView(v === "about" || v === "reader" || v === "stats" ? v : "explore", "none");
}
window.addEventListener("popstate", routeFromUrl);

// ─── Aligned lines view: ATF | English (one or more versions side by side), one grid row per ATF line ───
const NARROW_Q = window.matchMedia("(max-width: 760px)");
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
/** "obverse col 1" | "o i" | "Obverse Column i" -> "o:1"; "surface a" -> "sa"; "left edge" -> "le"; "" -> "" */
function normSurf(s) {
  const t = String(s || "").toLowerCase().replace(/[.,@()]/g, " ").split(/\s+/).filter(Boolean);
  let side = "", col = "";
  for (let i = 0; i < t.length; i++) {
    const w = t[i], nx = t[i + 1] || "";
    if (/^(obverse|obv|o)$/.test(w)) side = "o";
    else if (/^(reverse|rev|r)$/.test(w)) side = "r";
    else if (/^(left|right|top|bottom|lower|upper)$/.test(w) && /^(edge|e)$/.test(nx)) {
      side = { left: "le", right: "re", top: "te", upper: "te", bottom: "be", lower: "be" }[w];
      i++;
    } else if (/^(edge|e|le|re|te|be)$/.test(w)) side = w === "edge" ? "e" : w;
    else if ((w === "surface" || w === "seal") && nx) {
      side = w[0] + nx;
      i++;
    } else if ((w === "col" || w === "column") && nx) {
      col = String(ROMAN[nx] || parseInt(nx, 10) || nx);
      i++;
    } else if (!col && side && (ROMAN[w] || /^\d+$/.test(w))) col = String(ROMAN[w] || parseInt(w, 10));
  }
  return side + (col ? ":" + col : "");
}
const normN = (n) => String(n || "").replace(/[′’ʼ]/g, "'").replace(/\s+/g, "").toLowerCase();
const rowKey = (surface, n) => normSurf(surface) + "|" + normN(n);
/** "obverse col 1 3'" -> rowKey("obverse col 1", "3'") */
function rowKeyFromLabel(lab) {
  const parts = String(lab || "").trim().split(/\s+/);
  const n = parts.pop() || "";
  return rowKey(parts.join(" "), n);
}

/**
 * Place one translation on the grid rows. Returns { blocks: [{s, e, items}], rate } where s..e are row indices.
 * - machine aligned to the ATF: one block per row
 * - CDLI-style labels ("obverse col 1 3'"): matched by surface + line number (works across CDLI/ORACC naming)
 * - ORACC passages ("Obverse Column i [0:5] …"): lines 0..4 of that surface in the ORACC edition, so a
 *   paragraph spans the ATF rows it translates
 * Lines that can't be placed join the passage before them; a column with < 50% placed is shown unaligned.
 */
function mapTranslationToRows(o, keyIndex) {
  if (!o.labels) {
    const blocks = [];
    o.english.forEach((t, i) => {
      if (t) blocks.push({ s: i, e: i, items: [{ t, conf: (o.conf && o.conf[i]) || 0 }] });
    });
    return { blocks, rate: 1 };
  }
  let groups = null;
  const blocks = [], orphans = [];
  let last = null, placed = 0;
  o.english.forEach((t, j) => {
    const label = o.labels[j] || "";
    const item = { t, label, conf: (o.conf && o.conf[j]) || 0 };
    let idxs = [];
    const m = label.match(/^(.*?)\[(\d+):(\d+)\]/);
    if (m && o.src_lines && o.src_lines.length) {
      if (!groups) {
        groups = new Map();
        for (const l of o.src_lines) {
          const k = normSurf(l.surface);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(l);
        }
      }
      const list = groups.get(normSurf(m[1])) || (groups.size === 1 ? [...groups.values()][0] : null);
      if (list) idxs = list.slice(+m[2], +m[3]).map((l) => keyIndex.get(rowKey(l.surface, l.n))).filter((x) => x != null);
    } else if (keyIndex.has(rowKeyFromLabel(label))) idxs = [keyIndex.get(rowKeyFromLabel(label))];
    if (idxs.length) {
      placed++;
      last = { s: Math.min(...idxs), e: Math.max(...idxs), items: [item] };
      blocks.push(last);
    } else if (last) last.items.push({ ...item, orphan: true });
    else orphans.push({ ...item, orphan: true });
  });
  blocks.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && b.s <= prev.e) {
      prev.e = Math.max(prev.e, b.e);
      prev.items.push(...b.items);
    } else merged.push(b);
  }
  if (orphans.length && merged.length) merged[0].items.unshift(...orphans);
  return { blocks: merged, rate: o.english.length ? placed / o.english.length : 0 };
}

const isAlignedText = (text) => !!(text && text.status === "api" && (text.translations || []).length);
/** Index into tr_cols of the translation a narrow screen is showing while comparing. */
function trFocus(text) {
  const n = (text.tr_cols || []).length;
  const i = text.tr_focus | 0;
  return i >= 0 && i < n ? i : 0;
}
/**
 * Columns drawn in the grid. Desktop shows every compared column. A narrow screen keeps one
 * translation beside the ATF and moves between the others with tabs or a swipe, so compare is
 * never dropped just because the viewport is small.
 */
const visibleTrCols = (text) => {
  const cols = text.tr_cols || [];
  if (!NARROW_Q.matches) return cols;
  return cols.slice(0, 1); // the rest become their own slides (renderTrSlides)
};
/** Side-by-side pair opened by "Compare translations": machine draft, then the first human edition the policy allows. */
function defaultCompareCols(text) {
  const opts = text.translations || [];
  const machine = opts.find((o) => o.kind === "machine");
  const human = opts.find((o) => o.kind === "human");
  if (machine && human && machine.key !== human.key) return [machine.key, human.key];
  return opts.slice(0, 2).map((o) => o.key);
}
/** Drop legacy disclaimer / teaser phrases from machine-translation notes. */
function scrubMtNote(s) {
  if (!s) return s;
  let t = String(s);
  t = t.replace(/\s*Unreviewed machine output,?\s*/gi, " ");
  t = t.replace(/\s*not a scholarly translation[^.]*\.?/gi, "");
  t = t.replace(/\s*verify against a published edition\.?/gi, "");
  t = t.replace(/\s*The first \d+ machine lines are in the HTML for search engines;?\s*the rest load from the corpus API in your browser\.?/gi, "");
  t = t.replace(/\s*Machine English on this page loads from the corpus API in your browser\.?/gi, "");
  t = t.replace(/\bMachine draft\b/g, "Machine translation");
  return t.replace(/\s{2,}/g, " ").replace(/\s·\s*$/,"").trim();
}

const trOptLabel = (o) => (o.kind === "human" && o.translators && o.translators.length ? `${o.label} — ${o.translators[0]}` : o.label);
const trTabLabel = (o) => (o.kind === "machine" ? "Machine" : String(o.label || "Translation").split(" · ")[0]);

function trCreditHtml(o) {
  const link = (label, href) => (href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label));
  if (o.kind === "human") {
    return [
      o.translators.length ? `Translation: ${escapeHtml(o.translators.join("; "))}` : "Human translation",
      `via ${link(o.source_name + (o.edition ? ` (${o.edition})` : ""), o.record_url)}`,
      o.license ? `licence: ${link(o.license, o.license_url)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const short = `Machine translation · ${o.model_label || "model"}${o.translated_on ? ` · ${o.translated_on}` : ""}`;
  const full = scrubMtNote(o.note || short);
  // Full provenance is shown via the header ⓘ popover (lg-credit); keep a short summary for the rare inline-preamble mode.
  return `<span class="mt-credit-full">${escapeHtml(full)}</span><span class="mt-credit-short" hidden>${escapeHtml(short)}</span>`;
}

/** Short source / licence line for a translation chip, e.g. "ORACC · CC BY-SA 3.0" or "machine draft". */
function trChipSub(o) {
  if (o.kind === "machine") return "machine translation";
  return o.license ? `human · ${o.license}` : "human";
}

function renderLinesCol(text) {
  // Wide screens: ATF plus every chosen translation side by side in one aligned grid. Narrow screens:
  // ATF plus the first translation here; each further translation gets its own slide (renderTrSlides).
  const keys = state.readerPanels.english ? visibleTrCols(text) : [];
  renderLinesGrid($("#lines-body"), text, keys, state.readerPanels.atf);
}

function renderLinesGrid(body, text, keys, wantAtf) {
  const opts = text.translations || [];
  const cols = keys.map((k) => opts.find((o) => o.key === k)).filter(Boolean);
  const content = (text.lines || []).filter((l) => l.type === "line");
  const atfOn = wantAtf && content.length > 0;
  // rows: the ATF lines; with no public ATF (eBL), the first column's own line labels
  let rows;
  if (content.length) rows = content.map((l) => ({ n: l.n, surface: l.surface, atf: l.atf, key: rowKey(l.surface, l.n) }));
  else {
    const first = cols[0] || opts[0];
    rows = (first.labels || first.english.map((_, i) => String(i + 1))).map((lab) => ({ n: lab, surface: "", atf: null, key: rowKeyFromLabel(lab) }));
  }
  const keyIndex = new Map();
  rows.forEach((r, i) => {
    if (!keyIndex.has(r.key)) keyIndex.set(r.key, i);
  });

  const k = cols.length;
  const atfW = k <= 1 ? 1 : k === 2 ? 0.8 : 0.62;
  const tmpl = [content.length ? "2.6rem" : "6.5rem", atfOn ? `minmax(0,${atfW}fr)` : null, ...cols.map(() => "minmax(0,1fr)")].filter(Boolean).join(" ");
  const atfCol = 2, enCol0 = atfOn ? 3 : 2;
  const html = [];

  // row 1: the gray header bar (sticky) naming each column; row 2: per-column credit / licence
  html.push(`<div class="lg-head" style="grid-row:1;grid-column:1"></div>`);
  if (atfOn) html.push(`<div class="lg-head" style="grid-row:1;grid-column:${atfCol}"><span>ATF</span><span class="lg-head-sub">transliteration</span><button type="button" class="lg-info" data-info="atf" aria-label="About this column" title="Source, licence and notes">ⓘ</button></div>`);
  if (atfOn) html.push(`<div class="lg-credit" data-for="atf" style="grid-row:2;grid-column:1 / ${atfCol + 1}">${escapeHtml(`From ${text.atf_source || "source"}`)}${(text._notes_common || []).length ? " · " + escapeHtml(text._notes_common.join(" · ")) : ""}</div>`);
  else html.push(`<div class="lg-credit" style="grid-row:2;grid-column:1"></div>`);
  const maps = cols.map((o) => mapTranslationToRows(o, keyIndex));
  cols.forEach((o, vi) => {
    const c = enCol0 + vi;
    html.push(`<div class="lg-head lg-head-en" data-key="${escapeAttr(o.key)}" style="grid-row:1;grid-column:${c}"><span class="tr-only">${escapeHtml((o.kind === "machine" ? "⚙ " : "") + trOptLabel(o))}</span><button type="button" class="lg-info" data-info="${escapeAttr(o.key)}" aria-label="About this column" title="Source, licence and notes">ⓘ</button></div>`);
    const mp = maps[vi];
    const how =
      o.labels && mp.rate < 0.5
        ? " · not line-aligned in the source, shown as one block"
        : mp.blocks.some((b) => b.e > b.s)
          ? " · paragraph translation: each passage spans the lines it covers"
          : "";
    const withheld = vi === 0 && !content.length && text.atf ? `<br>Transliteration not shown: ${escapeHtml(text.atf)}` : "";
    html.push(`<div class="lg-credit lg-credit-en" data-for="${escapeAttr(o.key)}" style="grid-row:2;grid-column:${c}">${trCreditHtml(o)}${how}${withheld}</div>`);
  });

  // content rows (surface headings get their own row across the line-number + ATF columns)
  // Surface changes (obverse → reverse …) are NOT their own grid rows: an extra row exists only in the
  // line-number + ATF columns, so it pushed every translation column down (the stray "O" + dashed rule at the top).
  // Instead the first line of each surface carries a small tag in its line-number cell, and later surfaces
  // get a dashed rule on top of that row in every column, so all columns stay level.
  const rowG = [];
  const surfStart = new Set();
  let g = 3, lastSurf = null;
  rows.forEach((r, i) => {
    let tag = "";
    if (content.length && r.surface && r.surface !== lastSurf) {
      tag = `<span class="lg-surf" title="${escapeAttr(surfaceLabel(r.surface))}">${escapeHtml(surfaceShort(r.surface))}</span>`;
      if (lastSurf !== null) surfStart.add(i);
    }
    lastSurf = r.surface;
    rowG[i] = g;
    const sc = surfStart.has(i) ? " lg-surf-start" : "";
    html.push(`<div class="lg-cell lg-ln${sc}" data-i="${i}" style="grid-row:${g};grid-column:1">${tag}${escapeHtml(r.n)}</div>`);
    if (atfOn) html.push(`<div class="lg-cell lg-atf${sc}" data-i="${i}" style="grid-row:${g};grid-column:${atfCol}">${escapeHtml(r.atf)}</div>`);
    g++;
  });
  const itemHtml = (it, showLabel) =>
    `${showLabel && it.label ? `<span class="lg-range">${escapeHtml(it.label)}</span>` : ""}<span class="en-text">${escapeHtml(it.t)}</span>`;
  cols.forEach((o, ci) => {
    const c = enCol0 + ci;
    const mp = maps[ci];
    if (!rows.length) return;
    if (o.labels && mp.rate < 0.5) {
      html.push(`<div class="lg-cell lg-en lg-free" style="grid-row:${rowG[0]} / ${rowG[rows.length - 1] + 1};grid-column:${c}">${o.english
        .map((t, j) => `<div class="lg-free-item">${itemHtml({ t, label: o.labels[j] }, true)}</div>`)
        .join("")}</div>`);
      return;
    }
    for (const b of mp.blocks) {
      const lv = o.kind === "machine" ? Math.max(...b.items.map((it) => confLevel(it.conf))) : 0;
      const span = b.e > b.s;
      const range = span ? `<span class="lg-range">${escapeHtml(`${rows[b.s].n}–${rows[b.e].n}`)}</span>` : "";
      html.push(
        `<div class="lg-cell lg-en lg-${o.kind}${span ? " lg-span" : ""}${surfStart.has(b.s) ? " lg-surf-start" : ""}${lv ? ` conf-${lv}` : ""}"${span ? ` data-s="${b.s}" data-e="${b.e}"` : ` data-i="${b.s}"`}${lv ? ` title="${escapeAttr(CONF_TITLES[lv])}"` : ""} style="grid-row:${rowG[b.s]} / ${rowG[b.e] + 1};grid-column:${c}">${range}${b.items
          .map((it) => itemHtml(it, !!it.orphan))
          .join(" ")}</div>`
      );
    }
  });
  if (!cols.length && !atfOn) html.push(`<p style="grid-row:3;grid-column:1 / -1;color:var(--text-faint);padding:1rem">Nothing to show.</p>`);
  body.innerHTML = `<div class="lines-grid${k > 1 ? " lg-compare" : ""}" style="grid-template-columns:${tmpl}">${html.join("")}</div>`;
  bindLineHover(body);
}

/** Narrow screens: one extra slide per additional translation chip that is on (line numbers + that translation). */
function renderTrSlides(text) {
  $$("#reader-body .tr-slide").forEach((el) => el.remove());
  if (!NARROW_Q.matches || !isAlignedText(text) || !state.readerPanels.english) return;
  let after = $("#col-lines");
  (text.tr_cols || []).slice(1).forEach((key, j) => {
    const col = document.createElement("div");
    col.className = "reader-col tr-slide";
    col.id = `col-tr-${j + 1}`;
    col.style.display = "flex";
    col.innerHTML = `<div class="col-body lines-body-extra"></div>`;
    after.insertAdjacentElement("afterend", col);
    after = col;
    renderLinesGrid(col.firstElementChild, text, [key], false);
  });
}

/** Chip row: one chip per available translation (aligned tablets) or one English chip, then ATF, Cuneiform, Meta. */
function renderReaderChips(text) {
  const host = $("#reader-chips");
  if (!host) return;
  const panels = state.readerPanels;
  const content = (text.lines || []).filter((l) => l.type === "line");
  const aligned = isAlignedText(text);
  host.querySelectorAll(".pchip-tr").forEach((el) => el.remove());
  const enChip = host.querySelector('[data-panel="english"]');
  const status = text.translation_short || "";
  if (aligned) {
    enChip.hidden = true;
    const on = panels.english ? text.tr_cols || [] : [];
    const frag = (text.translations || [])
      .map((o) => {
        const i = on.indexOf(o.key);
        return `<button type="button" class="pchip pchip-tr${i >= 0 ? " on" : ""} pchip-${o.kind}" data-tr="${escapeAttr(o.key)}" data-slide="${i <= 0 ? "col-lines" : `col-tr-${i}`}" aria-pressed="${i >= 0}" title="${escapeAttr(trOptLabel(o))}"><span class="pchip-name">${escapeHtml(o.kind === "machine" ? "⚙ Machine" : trTabLabel(o))}</span><span class="pchip-sub">${escapeHtml(trChipSub(o))}</span></button>`;
      })
      .join("");
    enChip.insertAdjacentHTML("beforebegin", frag);
  } else {
    const has = !!(Array.isArray(text.english) ? text.english.length : text.english);
    enChip.hidden = false;
    enChip.disabled = !has;
    enChip.dataset.slide = "col-english";
    enChip.querySelector(".pchip-sub").textContent = has ? (text.english_kind === "human" ? "human" : "machine translation") + (status ? ` · ${status}` : "") : status || "none yet";
  }
  const atfChip = host.querySelector('[data-panel="atf"]');
  atfChip.disabled = !content.length;
  atfChip.dataset.slide = aligned ? "col-lines" : "col-atf";
  atfChip.querySelector(".pchip-sub").textContent = content.length ? "transliteration" : text.atf ? "withheld" : "none";
  const cuChip = host.querySelector('[data-panel="cuneiform"]');
  cuChip.disabled = !content.length;
  cuChip.dataset.slide = "col-cuneiform";
  cuChip.querySelector(".pchip-sub").textContent = content.length ? "Unicode" : "none";
  host.querySelector('[data-panel="meta"]').dataset.slide = "col-meta";
  host.querySelectorAll("[data-panel]").forEach((b) => {
    const v = !!panels[b.dataset.panel] && !b.disabled;
    b.classList.toggle("on", v);
    b.setAttribute("aria-pressed", String(v));
  });
  host.querySelectorAll(".pchip-tr").forEach((b) => b.addEventListener("click", () => onChip(b)));
  syncSlideChip();
}

/** Turn a chip's panel / translation on or off. Narrow: a tap on an off chip turns it on and slides to it,
 *  a tap on an on chip slides to it, and a tap on the chip already in view turns it off. */
function onChip(btn) {
  const text = state.currentText;
  if (!text || btn.disabled) return;
  const panels = state.readerPanels;
  const on = btn.classList.contains("on");
  if (NARROW_Q.matches && on && !btn.classList.contains("current")) {
    scrollToSlide(btn.dataset.slide);
    return;
  }
  const wouldBeEmpty = (nextPanels) => !Object.values(nextPanels).some(Boolean);
  if (btn.dataset.tr) {
    const key = btn.dataset.tr;
    let cols = panels.english ? [...(text.tr_cols || [])] : [];
    cols = on ? cols.filter((k) => k !== key) : [...cols, key];
    if (!cols.length) {
      if (wouldBeEmpty({ ...panels, english: false })) return;
      panels.english = false;
    } else {
      panels.english = true;
      applyTranslation(text, cols);
      setTrParam(text);
    }
  } else {
    const key = btn.dataset.panel;
    if (wouldBeEmpty({ ...panels, [key]: !on })) return;
    panels[key] = !on;
  }
  renderReader();
  if (!on) {
    const slide = btn.dataset.tr ? $(`#reader-chips [data-tr="${CSS.escape(btn.dataset.tr)}"]`)?.dataset.slide : btn.dataset.slide;
    scrollToSlide(slide);
  }
}

function scrollToSlide(id) {
  if (!NARROW_Q.matches || !id) return;
  const body = $("#reader-body");
  const el = document.getElementById(id);
  if (!el || el.style.display === "none") return;
  body.scrollTo({ left: el.offsetLeft - body.offsetLeft, behavior: "smooth" });
}

/** Mark the chip(s) whose slide is in view (narrow); chips are the slider's tab indicator. */
function syncSlideChip() {
  const host = $("#reader-chips");
  const body = $("#reader-body");
  if (!host || !body) return;
  let cur = null;
  if (NARROW_Q.matches) {
    const mid = body.scrollLeft + body.clientWidth / 2;
    for (const el of body.children) {
      if (el.style.display === "none" || !el.offsetWidth) continue;
      const x = el.offsetLeft - body.offsetLeft;
      if (mid >= x && mid < x + el.offsetWidth) cur = el.id;
    }
  }
  host.querySelectorAll(".pchip").forEach((b) => {
    const c = !!cur && b.classList.contains("on") && b.dataset.slide === cur;
    b.classList.toggle("current", c);
    if (c) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  const curChip = host.querySelector(".pchip.current");
  if (curChip && host.scrollWidth > host.clientWidth) curChip.scrollIntoView({ block: "nearest", inline: "nearest" });
}
NARROW_Q.addEventListener?.("change", () => {
  if (state.currentText) renderReader();
});

/** Content lines still without English (0 when the English is complete or not line-aligned). */
function englishRemaining(text) {
  if (!text || text.english_complete) return 0;
  const total = (text.lines || []).filter((l) => l.type === "line").length;
  const have = Array.isArray(text.english) ? text.english.length : 0;
  return Math.max(0, total - have);
}

// ─── Filters ───
function populateFilterOptions() {
  const items = state.catalog.items;
  const genres = uniqueSorted(items.map((i) => i.genre).filter(Boolean));
  const periods = uniqueSorted(items.map((i) => i.period).filter(Boolean));
  const langs = uniqueSorted(items.map((i) => i.language).filter(Boolean));
  const sites = uniqueSorted(items.map((i) => i.site || i.provenience).filter(Boolean));

  fillSelect("#filter-genre", genres);
  fillSelect("#filter-period", periods.slice(0, 40));
  fillSelect("#filter-language", langs);
  fillSelect("#filter-site", sites.slice(0, 60));
}

function fillSelect(sel, values) {
  const el = $(sel);
  const cur = el.value;
  el.innerHTML = `<option value="">All</option>` + values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
  if (values.includes(cur)) el.value = cur;
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

function applyFilters() {
  const q = ($("#search").value || "").trim().toLowerCase();
  const genre = $("#filter-genre").value;
  const period = $("#filter-period").value;
  const language = $("#filter-language").value;
  const site = $("#filter-site").value;
  const minLines = Number($("#filter-min-lines").value) || 0;
  const hideOpenEnglish = $("#filter-hide-known").checked;
  const onlyOpenGap = $("#filter-open-gap")?.checked; // Unread list
  const onlyNoEnglish = $("#filter-no-english")?.checked;
  const onlyNotOnline = $("#filter-not-online")?.checked;
  const onlyPackaged = $("#filter-packaged").checked;
  const epicHunt = $("#filter-epic-hunt")?.checked;
  const herbalMode = $("#filter-herbal")?.checked;
  const omenMode = $("#filter-omens")?.checked;
  const mathMode = $("#filter-math")?.checked;
  const year = state.timelineYear;

  const packaged = new Set(state._packagedIds || []);

  // Mode body classes + intro panels
  document.body.classList.toggle("mode-epic", !!epicHunt);
  document.body.classList.toggle("mode-herbal", !!herbalMode);
  document.body.classList.toggle("mode-omen", !!omenMode);
  document.body.classList.toggle("mode-math", !!mathMode);
  const omenIntro = $("#mode-intro-omens");
  const mathIntro = $("#mode-intro-math");
  if (omenIntro) omenIntro.hidden = !omenMode;
  if (mathIntro) mathIntro.hidden = !mathMode;
  if (!omenMode) state.omenKind = null;
  if (!mathMode) state.mathKind = null;
  // Refresh active chip styling when modes toggle
  renderKindChips();

  // Short tables / omen fragments are valid in specialty modes
  const lineFloor =
    omenMode || mathMode ? Math.min(minLines, 15) : minLines;

  state.filtered = state.catalog.items.filter((item) => {
    if (epicHunt && !item.epic_hunt) return false;
    if (herbalMode && !item.herbal_remedy) return false;
    if (omenMode && !item.omen_hunt) return false;
    if (mathMode && !item.math_hunt) return false;
    if (omenMode && state.omenKind && item.omen_kind !== state.omenKind) return false;
    if (mathMode && state.mathKind && item.math_kind !== state.mathKind) return false;
    if (genre && item.genre !== genre) return false;
    if (period && item.period !== period) return false;
    if (language && item.language !== language) return false;
    if (site && item.site !== site && item.provenience !== site) return false;
    if (item.content_lines < lineFloor) return false;
    // Hide works that already have open digital English (RINAP/ETCSL/CDLI…)
    // In epic hunt, still hide open_project ETCSLish when this is checked
    if (hideOpenEnglish && item.open_english) return false;
    // Unread: translation_status === no_open_english (no CDLI English, no open-project/series hit)
    if (onlyOpenGap && item.translation_status !== "no_open_english") return false;
    // No English: open_english === false (Unread ∪ Not online ∪ other unknowns)
    if (onlyNoEnglish && item.open_english) return false;
    // Not online: print_edition (human English in print scholarship, not found as open digital)
    if (onlyNotOnline && item.translation_status !== "print_edition") return false;
    if (onlyPackaged && !packaged.has(item.id)) return false;
    if (q) {
      const markers = item.epic_markers ? Object.keys(item.epic_markers).join(" ") : "";
      const hay = `${item.id} ${item.designation} ${item.genre} ${item.subgenre} ${item.language} ${item.period} ${item.provenience} ${item.site || ""} ${markers} ${item.omen_blurb || ""} ${item.math_blurb || ""} ${item.omen_kind || ""} ${item.math_kind || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  state.filtered.sort((a, b) => {
    if (mathMode) {
      const ma = a.math_score || 0;
      const mb = b.math_score || 0;
      if (mb !== ma) return mb - ma;
    }
    if (omenMode) {
      const oa = a.omen_score || 0;
      const ob = b.omen_score || 0;
      if (ob !== oa) return ob - oa;
    }
    if (herbalMode) {
      const ha = a.herbal_score || a.plant_hits || 0;
      const hb = b.herbal_score || b.plant_hits || 0;
      if (hb !== ha) return hb - ha;
    }
    if (epicHunt) {
      const ea = a.epic_score || 0;
      const eb = b.epic_score || 0;
      if (eb !== ea) return eb - ea;
    }
    const da = a.year == null ? 9999 : Math.abs(a.year - year);
    const db = b.year == null ? 9999 : Math.abs(b.year - year);
    if (
      da !== db &&
      (a.year != null || b.year != null) &&
      !epicHunt &&
      !herbalMode &&
      !omenMode &&
      !mathMode
    )
      return da - db;
    return (b.score || 0) - (a.score || 0);
  });

  renderCatalogList();
  updateMapMarkers();
  updateTimelineDots();
  const modes = [];
  if (epicHunt) modes.push("epic hunt");
  if (herbalMode) modes.push("remedies");
  if (omenMode) {
    modes.push(
      state.omenKind
        ? `omens · ${OMEN_KIND_LABELS[state.omenKind] || state.omenKind}`
        : "omens"
    );
  }
  if (mathMode) {
    modes.push(
      state.mathKind
        ? `math · ${MATH_KIND_LABELS[state.mathKind] || state.mathKind}`
        : "math"
    );
  }
  const mode = modes.length ? ` · ${modes.join(" + ")}` : "";
  $("#results-count").textContent = `${state.filtered.length} works${mode}`;
}

function statusChip(item) {
  const st = item.translation_status || (item.open_english ? "open_project" : item.known_elsewhere ? "open_project" : "no_open_english");
  const short = item.translation_short || item.translation_label || st;
  const cls = {
    cdli_english: "status-cdli",
    open_project: "status-open",
    print_edition: "status-print",
    no_open_english: "status-fresh",
  }[st] || "status-unknown";
  return `<span class="chip ${cls}" title="${escapeAttr(item.translation_detail || short)}">${escapeHtml(short)}</span>`;
}

function machineChip(text) {
  if (!text) return "";
  if (text.english_kind === "human") return `<span class="chip status-cdli" title="Human translation from the source edition">Human English</span>`;
  const eng = text.english;
  let n = Array.isArray(eng) ? eng.length : eng ? 1 : 0;
  if (!n) return "";
  const total = (text.lines || []).filter((l) => l.type === "line").length;
  if (text.machine_draft_lines != null) n = text.machine_draft_lines;
  const label = total && n < total ? `Machine translation ${n}/${total}` : `Machine translation (${n})`;
  const tm = text.translation_meta || {};
  const stamp = tm.model ? ` · ${tm.model}${tm.translated_on ? ` · ${tm.translated_on}` : ""}` : "";
  return `<span class="chip status-machine" title="Machine translation${escapeAttr(stamp)}">${label}</span>`;
}

function markerChips(item) {
  const hits = item.epic_markers;
  if (!hits || !Object.keys(hits).length) return "";
  const top = Object.entries(hits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return top
    .map(
      ([k, v]) =>
        `<span class="chip status-epic" title="Literary marker hits in ATF">${escapeHtml(k)}×${v}</span>`
    )
    .join("");
}

function renderCatalogList() {
  const list = $("#catalog-list");
  const packaged = new Set(state._packagedIds || []);
  const epicMode = $("#filter-epic-hunt")?.checked;
  const max = 200;
  const slice = state.filtered.slice(0, max);

  list.innerHTML = slice
    .map((item) => {
      const active = item.id === state.selectedId ? "active" : "";
      const epicBit =
        item.epic_hunt && item.epic_score != null
          ? `<span class="chip status-epic" title="Epic-hunt score">★ ${item.epic_score}</span>`
          : "";
      const herbBit = item.herbal_remedy
        ? `<span class="chip status-herbal" title="${escapeAttr(item.herbal_blurb || "Therapeutic plant recipes")}">${
            item.plant_hits != null ? `plants≈${item.plant_hits}` : "Remedy"
          }</span>`
        : "";
      const omenBit = item.omen_hunt
        ? `<span class="chip status-omen" title="${escapeAttr(item.omen_blurb || "Omen series")}">${escapeHtml(
            OMEN_KIND_LABELS[item.omen_kind] || item.omen_blurb || "Omen"
          )}</span>`
        : "";
      const mathBit = item.math_hunt
        ? `<span class="chip status-math" title="${escapeAttr(item.math_blurb || "Mathematical tablet")}">${escapeHtml(
            MATH_KIND_LABELS[item.math_kind] || item.math_blurb || "Math"
          )}</span>`
        : "";
      const labelExtra =
        item.id === "P262784"
          ? " · Gilg. II"
          : item.herbal_remedy && packaged.has(item.id)
            ? " · remedy"
            : item.omen_hunt && packaged.has(item.id)
              ? " · omen"
              : item.math_hunt && packaged.has(item.id)
                ? " · math"
                : "";
      return `
      <button type="button" class="catalog-card ${active}" data-id="${item.id}">
        <span class="id">${item.id}${packaged.has(item.id) ? " · ready" : ""}${labelExtra}</span>
        <span class="title">${escapeHtml(item.designation || item.id)}</span>
        <span class="meta">
          ${item.genre ? `<span class="chip genre">${escapeHtml(item.genre)}</span>` : ""}
          <span class="chip">${item.content_lines} lines</span>
          ${statusChip(item)}
          ${epicBit}
          ${herbBit}
          ${omenBit}
          ${mathBit}
          ${epicMode ? markerChips(item) : ""}
        </span>
      </button>`;
    })
    .join("");

  if (state.filtered.length > max) {
    list.innerHTML += `<div style="padding:0.75rem;color:var(--text-faint);font-size:0.8rem">Showing ${max} of ${state.filtered.length}. Refine filters to narrow.</div>`;
  }
}

// ─── Preview / selection ───
async function selectWork(id) {
  state.selectedId = id;
  renderCatalogList();
  const item = state.catalog.items.find((x) => x.id === id);
  if (!item) return;

  highlightMapSite(item);
  renderPreview(item, true);

  // Lazy-load packaged text for snip
  const text = await loadText(id);
  state._previewText = text;
  renderPreview(item, false, text);
}

function renderPreview(item, loading, text) {
  const el = $("#preview-panel");
  const yearLabel = item.year != null ? formatYear(item.year) : "—";
  const snip =
    text && text.atf
      ? text.atf
          .split("\n")
          .filter((l) => /^\d/.test(l.trim()))
          .slice(0, 6)
          .join("\n")
      : loading
        ? "Loading…"
        : text && text.status === "stub"
          ? "(ATF not packaged — open reader for metadata only)"
          : "";

  // Merge package status fields if present
  const statusSrc = { ...item, ...(text || {}) };
  const detail = statusSrc.translation_detail || "";
  const label = statusSrc.translation_label || "Translation status unknown";
  const epicNote =
    item.epic_hunt && item.epic_markers && Object.keys(item.epic_markers).length
      ? `Epic-hunt score ${item.epic_score ?? "—"}. Markers: ${Object.entries(item.epic_markers)
          .map(([k, v]) => `${k}×${v}`)
          .join(", ")}.`
      : item.epic_hunt
        ? `Epic-hunt score ${item.epic_score ?? "—"} (size / literary heuristics).`
        : "";
  const herbNote = item.herbal_remedy
    ? item.herbal_blurb ||
      `Therapeutic / plant-recipe text${item.plant_hits != null ? ` (≈${item.plant_hits} plant markers in ATF)` : ""}.`
    : "";
  const omenNote = item.omen_hunt
    ? item.omen_blurb || "Omen series (physiognomy, extispicy, birth, astral…)."
    : "";
  const mathNote = item.math_hunt
    ? item.math_blurb || "Mathematical / metrological tablet."
    : "";

  el.innerHTML = `
    <div class="preview-head">
      <div>
        <div class="preview-id">${item.id}</div>
        <h2>${escapeHtml(item.designation || item.id)}</h2>
        <div class="status-row">
          ${statusChip(statusSrc)}
          ${machineChip(text)}
          ${item.epic_hunt ? `<span class="chip status-epic">Epic hunt</span>` : ""}
          ${item.herbal_remedy ? `<span class="chip status-herbal">Remedy</span>` : ""}
          ${item.omen_hunt ? `<span class="chip status-omen">${escapeHtml(OMEN_KIND_LABELS[item.omen_kind] || "Omen")}</span>` : ""}
          ${item.math_hunt ? `<span class="chip status-math">${escapeHtml(MATH_KIND_LABELS[item.math_kind] || "Math")}</span>` : ""}
          ${markerChips(item)}
        </div>
      </div>
      <div class="preview-actions">
        <button type="button" class="btn primary" id="btn-open-reader">Open reader</button>
        <a class="btn" href="${item.cdli_url}" target="_blank" rel="noopener">CDLI ↗</a>
      </div>
    </div>
    <p class="status-detail">${escapeHtml([detail || label, epicNote, herbNote, omenNote, mathNote].filter(Boolean).join(" "))}</p>
    <dl class="preview-facts">
      <div class="fact"><dt>Genre</dt><dd>${escapeHtml(item.genre || "—")}</dd></div>
      <div class="fact"><dt>Language</dt><dd>${escapeHtml(item.language || "—")}</dd></div>
      <div class="fact"><dt>Period</dt><dd>${escapeHtml(shortPeriod(item.period) || "—")}</dd></div>
      <div class="fact"><dt>~Year</dt><dd>${yearLabel}</dd></div>
      <div class="fact"><dt>Site</dt><dd>${escapeHtml(item.site || item.provenience || "—")}</dd></div>
      <div class="fact"><dt>ATF size</dt><dd>${item.content_lines} lines · ${item.chars} chars</dd></div>
      <div class="fact"><dt>Font</dt><dd title="${escapeAttr(FontMap.info(item.font)?.label || "")}">${escapeHtml(item.font || "—")}</dd></div>
      <div class="fact"><dt>Open English?</dt><dd>${statusSrc.open_english ? "Yes (known digital)" : "No open English found"}</dd></div>
    </dl>
    ${snip ? `<pre class="preview-atf-snip">${escapeHtml(snip)}</pre>` : ""}
  `;
  $("#btn-open-reader")?.addEventListener("click", () => openReader(item.id));
}

// ─── Reader ───
// Search opens the reader as map.html?id=<text>&find=<query>. `find` (not `q`: that drives the
// map search layer) highlights the same words search.js marks and scrolls the first hit into view.
let findLineIdx = new Set();

const FIND_ATF = { š: "sz", ṣ: "s,", ṭ: "t,", ḫ: "h", ŋ: "j", ĝ: "j", "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
const findAtfAscii = (s) => s.replace(/[šṣṭḫŋĝ₀-₉]/gi, (c) => {
  const m = FIND_ATF[c.toLowerCase()];
  return c === c.toLowerCase() ? m : m.toUpperCase();
});
const findFold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "");

/** Same term rules as search.js `termsFor`: phrases, word*, š/sz, accents. */
function findTerms(q) {
  const out = new Map();
  for (const m of String(q || "").matchAll(/"([^"]*)"|(\S+)/g)) {
    const raw = m[1] ?? m[2];
    if (m[1] == null && /^(AND|OR|NOT|NEAR)$/.test(raw)) continue;
    const words = raw.match(/[\p{L}\p{N}_]+/gu) || [];
    const prefix = words.length === 1 && raw.endsWith("*");
    for (const w of words) {
      for (const v of new Set([w, findAtfAscii(w), findFold(w), findFold(findAtfAscii(w))])) {
        if (v) out.set(v.toLowerCase(), prefix || out.get(v.toLowerCase()));
      }
    }
  }
  return out;
}

function compileFind(q) {
  const terms = findTerms(q);
  if (!terms.size) return null;
  const words = [...terms.keys()].sort((a, b) => b.length - a.length);
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return { terms, re: new RegExp(`(?<![\\p{L}\\p{N}_])(${alt})([\\p{L}\\p{N}_]*)`, "giu") };
}

/** null, or a list of {text, mark} covering `text`. */
function findSpans(text, find) {
  if (!text || !find) return null;
  find.re.lastIndex = 0;
  const parts = [];
  let last = 0;
  let hit = false;
  for (const m of String(text).matchAll(find.re)) {
    if (m[2] && !find.terms.get(m[1].toLowerCase())) continue;
    hit = true;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), mark: false });
    parts.push({ text: m[0], mark: true });
    last = m.index + m[0].length;
  }
  if (!hit) return null;
  if (last < text.length) parts.push({ text: text.slice(last), mark: false });
  return parts;
}

function lineHits(text, find) {
  return !!findSpans(text, find);
}

/** If the open column doesn't contain the search term but another translation does, show that one. */
function maybePreferFindColumn(text) {
  const params = new URLSearchParams(location.search);
  const q = (params.get("find") || "").trim();
  if (!q || params.get("tr") || !text || !(text.translations || []).length) return;
  const find = compileFind(q);
  if (!find) return;
  const cur = text.translations.find((o) => o.key === text.tr_active);
  if (cur && (cur.english || []).some((t) => lineHits(t, find))) return;
  if ((text.lines || []).some((l) => l.atf && lineHits(l.atf, find))) return;
  const alt = text.translations.find((o) => o.key !== text.tr_active && (o.english || []).some((t) => lineHits(t, find)));
  if (alt) applyTranslation(text, [alt.key]);
}

function highlightElement(el, find) {
  const existing = el.querySelector("mark.find-hit");
  if (existing) return existing;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement && node.parentElement.closest("mark")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let first = null;
  for (const node of nodes) {
    const spans = findSpans(node.nodeValue, find);
    if (!spans) continue;
    const frag = document.createDocumentFragment();
    for (const s of spans) {
      if (!s.mark) {
        frag.appendChild(document.createTextNode(s.text));
        continue;
      }
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = s.text;
      frag.appendChild(mark);
      if (!first) first = mark;
    }
    node.parentNode.replaceChild(frag, node);
  }
  return first;
}

function paintFindLines() {
  document.querySelectorAll(".find-line").forEach((el) => el.classList.remove("find-line"));
  for (const i of findLineIdx) {
    let sel = `[data-i="${i}"]`;
    try { sel = `[data-i="${CSS.escape(i)}"]`; } catch (_) { /* keep the raw selector */ }
    document.querySelectorAll(sel).forEach((el) => el.classList.add("find-line"));
  }
}

/** Scroll only this column's own scroller, so a sibling column (cuneiform) stays put on a phone. */
function scrollColBody(el) {
  const col = el.closest(".col-body");
  if (!col || col.scrollHeight <= col.clientHeight + 4) return;
  const er = el.getBoundingClientRect();
  const sr = col.getBoundingClientRect();
  col.scrollTop += er.top - sr.top - (col.clientHeight - er.height) / 2;
}

function scrollFindTarget(el) {
  scrollColBody(el);
  const col = el.closest(".col-body");
  if (col && col.scrollHeight > col.clientHeight + 4) return;
  const outer = el.closest(".reader-body");
  if (!outer || outer.scrollHeight <= outer.clientHeight + 4) return;
  const er = el.getBoundingClientRect();
  const sr = outer.getBoundingClientRect();
  outer.scrollTop += er.top - sr.top - (outer.clientHeight - er.height) / 2;
}

function applySearchFind() {
  const q = (new URLSearchParams(location.search).get("find") || "").trim();
  findLineIdx = new Set();
  const note = document.getElementById("find-note");
  if (!q) {
    if (note) note.hidden = true;
    paintFindLines();
    return;
  }
  const find = compileFind(q);
  let first = null;
  if (find) {
    const sel = "#lines-body .lg-atf, #lines-body .en-text, #atf-body .line-row .atf, #english-body .en-text";
    for (const el of document.querySelectorAll(sel)) {
      const col = el.closest(".reader-col");
      if (col && col.style.display === "none") continue;
      const mark = highlightElement(el, find);
      if (!mark) continue;
      const row = mark.closest("[data-i]") || el.closest("[data-i]");
      if (row && row.dataset.i != null) findLineIdx.add(row.dataset.i);
      if (!first) first = mark;
    }
  }
  paintFindLines();
  if (note) {
    note.hidden = false;
    const n = findLineIdx.size;
    note.textContent = first
      ? (n ? `${n} line${n === 1 ? "" : "s"} match “${q}”` : `Matches for “${q}” are highlighted`)
      : `No lines shown here match “${q}”`;
  }
  if (first) scrollFindTarget(first);
  const cHit = document.querySelector("#cuneiform-body .find-line");
  if (cHit) scrollColBody(cHit);
}

async function openReader(id, hist = "push") {
  syncUrl("reader", id, hist);
  // While the text loads (the /api Lambda can take seconds on a cold start) the reader shows
  // "Loading tablet <id>…" instead of its "No work open" empty state; on failure, a retry.
  const token = (state._readerToken = (state._readerToken || 0) + 1);
  state.readerPending = { id, failed: false };
  setView("reader", "none");
  const text = await loadText(id);
  if (token !== state._readerToken) return; // a newer openReader() superseded this one
  if (!text) {
    state.readerPending = { id, failed: true };
    renderReader();
    return;
  }
  state.readerPending = null;
  state.currentText = text;
  state.selectedId = id;
  // Font: period/language rule from fonts/fonts.json, unless the reader picked one this session
  const catItem = state.catalog?.items?.find((x) => x.id === id) || {};
  const pick = (k) => text[k] || catItem[k] || "";
  const fontItem = { language: pick("language"), period: pick("period"), genre: pick("genre") };
  state.fontAuto = FontMap.fontFor(fontItem);
  state.fontRule = FontMap.ruleFor(fontItem);
  state.font = FontMap.override() || state.fontAuto;
  text.font = state.font;
  $("#font-select").value = FontMap.override();
  maybePreferFindColumn(text);
  renderReader();
}

function renderReader() {
  const text = state.currentText;
  const empty = $("#reader-empty");
  const shell = $("#reader-shell");
  const pending = $("#reader-pending");
  const p = state.readerPending;

  pending.style.display = p ? "flex" : "none";
  const hideFindNote = () => {
    const note = document.getElementById("find-note");
    if (note) note.hidden = true;
  };
  if (p) {
    hideFindNote();
    empty.style.display = "none";
    shell.style.display = "none";
    pending.classList.toggle("failed", !!p.failed);
    $("#reader-pending-title span:last-child").textContent = p.failed
      ? `Couldn't load ${p.id}`
      : `Loading tablet ${p.id}…`;
    $("#reader-pending-msg").textContent = p.failed
      ? "The tablet may not exist, or the server didn't respond. Check the ID, or try again."
      : "";
    $("#reader-pending-actions").hidden = !p.failed;
    return;
  }
  if (!text) {
    hideFindNote();
    empty.style.display = "flex";
    shell.style.display = "none";
    return;
  }
  empty.style.display = "none";
  shell.style.display = "flex";

  $("#reader-title").textContent = text.designation || text.id;
  // Merge catalog fields onto text for meta + badges
  const catItem = state.catalog?.items?.find((x) => x.id === text.id);
  if (catItem) {
    for (const k of Object.keys(catItem)) {
      if (text[k] == null || text[k] === "") text[k] = catItem[k];
    }
  }
  $("#reader-meta").innerHTML = [
    escapeHtml(text.id),
    escapeHtml(text.genre),
    escapeHtml(shortPeriod(text.period)),
    escapeHtml(text.site || text.provenience),
    escapeHtml(text.language),
  ]
    .filter(Boolean)
    .join(" · ");
  const findQ = (new URLSearchParams(location.search).get("find") || "").trim();
  let findNote = document.getElementById("find-note");
  if (findQ) {
    if (!findNote) {
      findNote = document.createElement("div");
      findNote.id = "find-note";
      findNote.className = "find-note";
      $("#reader-meta").insertAdjacentElement("afterend", findNote);
    }
    findNote.hidden = false;
    findNote.textContent = `Matches for “${findQ}”`;
  } else if (findNote) findNote.hidden = true;
  const badgeHost = $("#reader-status-badges");
  if (badgeHost) {
    badgeHost.innerHTML = [
      text.epic_hunt ? `<span class="chip status-epic">Epic</span>` : "",
      text.herbal_remedy ? `<span class="chip status-herbal">Remedy</span>` : "",
      text.omen_hunt ? `<span class="chip status-omen">${escapeHtml(OMEN_KIND_LABELS[text.omen_kind] || "Omen")}</span>` : "",
      text.math_hunt ? `<span class="chip status-math">${escapeHtml(MATH_KIND_LABELS[text.math_kind] || "Math")}</span>` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  // Panel visibility
  const panels = state.readerPanels;
  const n = [panels.english, panels.atf, panels.cuneiform, panels.meta].filter(Boolean).length;
  const body = $("#reader-body");
  body.classList.remove("cols-2", "cols-3", "cols-4");
  if (n === 2) body.classList.add("cols-2");
  if (n === 3) body.classList.add("cols-3");
  if (n >= 4) body.classList.add("cols-4");

  // API tablets: one aligned "lines" column (ATF | English versions) instead of separate English + ATF columns
  const aligned = isAlignedText(text) && (panels.english || panels.atf);
  $("#col-lines").style.display = aligned ? "flex" : "none";
  $("#col-english").style.display = !aligned && panels.english ? "flex" : "none";
  $("#col-atf").style.display = !aligned && panels.atf ? "flex" : "none";
  body.classList.toggle("custom-cols", aligned);
  if (aligned) {
    const k = panels.english ? visibleTrCols(text).length : 0;
    const hasAtf = panels.atf && (text.lines || []).some((l) => l.type === "line");
    const w = [`minmax(0,${(hasAtf ? (k <= 1 ? 1 : k === 2 ? 0.8 : 0.62) : 0) + Math.max(k, 0) || 1}fr)`];
    if (panels.cuneiform) w.push(`minmax(0,${k >= 2 ? 0.6 : 1}fr)`);
    if (panels.meta) w.push("minmax(0,0.9fr)");
    body.style.setProperty("--reader-cols", w.join(" "));
  }
  $("#col-cuneiform").style.display = panels.cuneiform ? "flex" : "none";
  $("#col-meta").style.display = panels.meta ? "flex" : "none";

  renderEnglishCol(text); // aligned API tablets: renders the lines column instead
  renderTrSlides(text);
  renderReaderChips(text);
  if (!aligned) renderAtfCol(text);
  renderCuneiformCol(text);
  if (panels.meta) {
    renderMetaCol(text);
    maybeFetchCdliMeta(text);
  }
  applySearchFind();
  // Let the reader-model module (cog / live MT) sync after each paint.
  try {
    document.dispatchEvent(new CustomEvent("unread:reader-rendered", { detail: { id: text && text.id } }));
  } catch (_) { /* ignore */ }
}


function metaRow(label, value, { html = false } = {}) {
  if (value == null || value === "" || value === false) return "";
  if (Array.isArray(value) && !value.length) return "";
  let display;
  if (html) display = value;
  else if (typeof value === "object") display = escapeHtml(JSON.stringify(value));
  else display = escapeHtml(String(value));
  return `<div class="meta-row"><dt>${escapeHtml(label)}</dt><dd>${display}</dd></div>`;
}

function renderMetaCol(text) {
  const body = $("#meta-body");
  if (!body) return;

  const yearLabel = text.year != null ? formatYear(text.year) : null;
  const cdliUrl = text.cdli_url || (text.id ? `https://cdli.earth/artifacts/${parseInt(String(text.id).replace(/^P/i, ""), 10)}` : null);
  const pubNote =
    text.designation && /memoirs|BAM|STT|SpTU|Iraq|CT |YOS|KAR|RIMA|RINAP|BiMes|Manchester/i.test(text.designation)
      ? `“${text.designation}” is usually a modern publication label (journal/book + plates), not an ancient title.`
      : null;

  const chips = [
    text.translation_short
      ? `<span class="chip ${{ no_open_english: "status-fresh", print_edition: "status-print", open_project: "status-open", cdli_english: "status-cdli" }[text.translation_status] || ""}">${escapeHtml(text.translation_short)}</span>`
      : "",
    text.herbal_remedy ? `<span class="chip status-herbal">Remedy</span>` : "",
    text.epic_hunt ? `<span class="chip status-epic">Epic hunt</span>` : "",
    text.omen_hunt ? `<span class="chip status-omen">${escapeHtml(OMEN_KIND_LABELS[text.omen_kind] || "Omen")}</span>` : "",
    text.math_hunt ? `<span class="chip status-math">${escapeHtml(MATH_KIND_LABELS[text.math_kind] || "Math")}</span>` : "",
    text.has_machine_draft || (Array.isArray(text.english) && text.english.length)
      ? `<span class="chip status-machine">Machine translation</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const markers =
    text.epic_markers && Object.keys(text.epic_markers).length
      ? Object.entries(text.epic_markers)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `<span class="chip status-epic">${escapeHtml(k)}×${v}</span>`)
          .join("")
      : "";

  const live = state.cdliLiveCache[text.id];
  let liveHtml = "";
  if (live === "loading") {
    liveHtml = `<p class="meta-live-status">Fetching live CDLI record…</p>`;
  } else if (live && live.error) {
    liveHtml = `<p class="meta-live-status">Live CDLI fetch unavailable (${escapeHtml(live.error)}).</p>`;
  } else if (live && live.fields) {
    const rows = Object.entries(live.fields)
      .map(([k, v]) => metaRow(k, v))
      .join("");
    liveHtml = rows
      ? `<h3>From CDLI API</h3><dl class="meta-dl">${rows}</dl>`
      : `<p class="meta-live-status">CDLI API returned no extra fields.</p>`;
  } else {
    liveHtml = `<p class="meta-live-status"><button type="button" class="btn" id="btn-fetch-cdli-meta">Fetch live CDLI metadata</button></p>`;
  }

  const tm = text.translation_meta || {};
  body.innerHTML = `
    <div class="meta-panel">
      ${pubNote ? `<p class="meta-blurb">${escapeHtml(pubNote)}</p>` : ""}
      ${text.herbal_blurb ? `<p class="meta-blurb">${escapeHtml(text.herbal_blurb)}</p>` : ""}
      ${text.omen_blurb ? `<p class="meta-blurb">${escapeHtml(text.omen_blurb)}</p>` : ""}
      ${text.math_blurb ? `<p class="meta-blurb">${escapeHtml(text.math_blurb)}</p>` : ""}
      ${text.translation_detail ? `<p class="meta-blurb">${escapeHtml(text.translation_detail)}</p>` : ""}
      <div class="meta-chips">${chips}${markers}</div>

      <h3>Identity</h3>
      <dl class="meta-dl">
        ${metaRow("CDLI ID", text.id)}
        ${metaRow("Designation", text.designation)}
        ${metaRow(
          "CDLI page",
          cdliUrl ? `<a href="${escapeAttr(cdliUrl)}" target="_blank" rel="noopener">${escapeHtml(cdliUrl)}</a>` : null,
          { html: true }
        )}
        ${metaRow("Museum no.", text.museum_no)}
        ${metaRow("Collection", text.collection)}
      </dl>

      <h3>Classification</h3>
      <dl class="meta-dl">
        ${metaRow("Genre", text.genre)}
        ${metaRow("Subgenre", text.subgenre)}
        ${metaRow("Language", text.language)}
        ${metaRow("Period", text.period)}
        ${metaRow("Approx. year", yearLabel)}
        ${metaRow("Provenience", text.provenience || text.site)}
        ${metaRow("Site (normalized)", text.site && text.site !== text.provenience ? text.site : null)}
        ${metaRow("Coordinates", hasKnownFindspot(text) ? `${text.lat}, ${text.lon}` : "find-spot unknown")}
      </dl>

      <h3>Publication</h3>
      <dl class="meta-dl">
        ${metaRow("Primary publication", text.primary_publication)}
        ${metaRow("Publication history", text.publication_history)}
        ${metaRow("Publication date", text.publication_date)}
        ${metaRow("Author (edition)", text.author)}
        ${metaRow("ATF source", text.atf_source)}
        ${metaRow("Translation source (CDLI)", text.translation_source)}
      </dl>

      <h3>This reader</h3>
      <dl class="meta-dl">
        ${metaRow("Package status", text.status)}
        ${metaRow("Open English?", text.open_english ? "Yes (known digital project)" : "No open English found")}
        ${metaRow("Print edition likely?", text.print_edition_likely ? "Yes" : "No / unknown")}
        ${metaRow("Font face", fontDescription())}
        ${metaRow("ATF content lines", text.content_lines)}
        ${metaRow("ATF chars (approx.)", text.chars)}
        ${metaRow(
          "English lines",
          Array.isArray(text.english) ? `${text.english.length}${text.content_lines ? ` / ${text.content_lines}` : ""}` : text.english ? "prose" : "none"
        )}
        ${metaRow("Plant markers", text.plant_hits)}
        ${metaRow("Recipe score", text.recipe_score ?? text.recipe)}
        ${metaRow("Epic score", text.epic_score)}
        ${metaRow("Omen score", text.omen_score)}
        ${metaRow("Math score", text.math_score)}
        ${metaRow("Model", tm.model)}
        ${metaRow("Translate device", tm.device)}
        ${metaRow("English note", text.english_note)}
      </dl>

      <h3>Live lookup</h3>
      ${liveHtml}
    </div>
  `;

  $("#btn-fetch-cdli-meta")?.addEventListener("click", () => {
    maybeFetchCdliMeta(text, true);
  });
}

async function maybeFetchCdliMeta(text, force = false) {
  if (!text?.id) return;
  if (!force && state.cdliLiveCache[text.id] && state.cdliLiveCache[text.id] !== "loading") {
    return;
  }
  if (!force && state.cdliLiveCache[text.id] === "loading") return;

  state.cdliLiveCache[text.id] = "loading";
  if (state.readerPanels.meta) renderMetaCol(text);

  const num = parseInt(String(text.id).replace(/^P/i, ""), 10);
  if (!Number.isFinite(num)) {
    state.cdliLiveCache[text.id] = { error: "bad id" };
    if (state.readerPanels.meta) renderMetaCol(text);
    return;
  }

  try {
    const res = await fetch(`https://cdli.earth/artifacts/${num}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    if (Array.isArray(data)) data = data[0] || {};
    const period =
      data.period && typeof data.period === "object"
        ? data.period.period || data.period.name
        : data.period;
    const provenience =
      data.provenience && typeof data.provenience === "object"
        ? data.provenience.provenience
        : data.provenience;
    const genres = Array.isArray(data.genres)
      ? data.genres
          .map((g) => {
            if (!g) return "";
            if (typeof g === "string") return g;
            const gg = g.genre;
            if (typeof gg === "string") return gg;
            return gg?.genre || g.comments || "";
          })
          .filter(Boolean)
          .join("; ")
      : null;
    const langs = Array.isArray(data.languages)
      ? data.languages
          .map((l) => (typeof l === "string" ? l : l.language?.language || l.language || ""))
          .filter(Boolean)
          .join("; ")
      : null;
    const collections = Array.isArray(data.collections)
      ? data.collections
          .map((c) => c.collection?.collection || c.collection || "")
          .filter(Boolean)
          .join("; ")
      : null;

    state.cdliLiveCache[text.id] = {
      fields: {
        Designation: data.designation,
        "Museum no.": data.museum_no,
        Period: period,
        Provenience: provenience,
        Genres: genres,
        Languages: langs,
        Collections: collections,
        "Artifact type":
          data.artifact_type?.artifact_type || data.artifact_type || null,
        "Has ATF": data.inscription?.atf
          ? `yes (${data.inscription.atf.length} chars)`
          : "no / empty in API",
        "API id": data.id,
      },
    };
  } catch (e) {
    state.cdliLiveCache[text.id] = { error: e.message || String(e) };
  }
  if (state.readerPanels.meta && state.currentText?.id === text.id) {
    renderMetaCol(state.currentText);
  }
}


/** Full Machine/English provenance for the header ⓘ popover (not inlined in the column body). */
function englishProvenanceText(text) {
  if (!text) return "";
  // Machine column ⓘ: short stamp only (model · date), no disclaimer / status essay.
  const machine = (text.translations || []).find((o) => o.key === "machine" || o.kind === "machine");
  if (machine && text.english_kind !== "human") {
    const label = machine.model_label || (text.translation_meta && text.translation_meta.model) || "B2c";
    const on = machine.translated_on || (text.translation_meta && text.translation_meta.translated_on) || "";
    return scrubMtNote(`Machine translation · ${label}${on ? ` · ${on}` : ""}`);
  }
  const bits = [];
  if (text.english_note) bits.push(scrubMtNote(text.english_note));
  if (text.english_kind === "human") {
    /* credit lives in english_note */
  } else if (text.translation_status === "print_edition") {
    bits.push("Scholars translated this in print — this English is a machine translation for comparison.");
  } else if (text.translation_status === "no_open_english") {
    bits.push("No open English found in our heuristics — possible first open digital reading (verify literature).");
  } else if (text.open_english) {
    bits.push("Open English may already exist elsewhere — use for comparison, not discovery claims.");
  } else if (text.translation_label) {
    bits.push(text.translation_label);
  }
  // Dedup while preserving order
  const seen = new Set();
  const out = [];
  for (const b of bits) {
    const t = String(b || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(" · ");
}

function renderEnglishCol(text) {
  const body = $("#english-body");
  const contentLines = (text.lines || []).filter((l) => l.type === "line");
  if (isAlignedText(text) && (state.readerPanels.english || state.readerPanels.atf)) {
    text._englishProvenance = englishProvenanceText(text);
    // Enrich machine lg-credit with catalog status bits when the option note is short.
    const mach = (text.translations || []).find((o) => o.kind === "machine");
    if (mach && text._englishProvenance && (!mach.note || mach.note.length < text._englishProvenance.length)) {
      mach.note = text._englishProvenance;
    }
    renderLinesCol(text);
    return;
  }

  if (text.english && Array.isArray(text.english) && text.english.length) {
    // Provenance lives on the column-header ⓘ (next to the cog), not in the body — keeps lines level.
    text._englishProvenance = englishProvenanceText(text);
    const labels = text.english_labels; // own labels => not index-aligned to the ATF rows
    const rows = text.english
      .map((line, i) => {
        const n = labels ? labels[i] || "" : contentLines[i]?.n ?? String(i + 1);
        const lv = line && Array.isArray(text.english_conf) ? text.english_conf[i] || 0 : 0;
        return `<div class="line-en${lv ? ` conf-${lv}` : ""}"${labels ? "" : ` data-i="${i}"`}${lv ? ` title="${escapeAttr(CONF_TITLES[lv])}"` : ""}>
          <span class="en-ln">${escapeHtml(n)}</span>
          <span class="en-text">${line ? escapeHtml(line) : `<span style="color:var(--text-faint)">—</span>`}</span>
        </div>`;
      })
      .join("");
    const remaining = englishRemaining(text);
    const more =
      remaining > 0
        ? `<p class="english-more-note">${remaining} further ATF lines not yet translated.
             <a class="btn" style="margin-left:0.5rem" href="${escapeAttr(translatorUrl(text, text.english.length))}">Translate the rest in your browser</a>
           </p>`
        : "";
    body.innerHTML = `<div class="english-prose">${rows}</div>${more}`;

  } else if (typeof text.english === "string" && text.english.trim()) {
    body.innerHTML = `<div class="english-prose"><p class="en-text">${escapeHtml(text.english)}</p></div>`;
  } else if (text.status === "api" && !contentLines.length) {
    body.innerHTML = `
      <div class="english-placeholder">
        <div class="badge">Nothing to show here</div>
        <p>No transliteration or English for this tablet can be shown on this site.</p>
        ${text.atf ? `<p style="margin-top:1rem;font-size:0.9rem;color:var(--text-faint)">${escapeHtml(text.atf)}</p>` : ""}
        <p style="margin-top:1rem"><a class="btn" href="search.html?text=${encodeURIComponent(text.id)}">Catalogue record in Search</a></p>
      </div>`;
    return;
  } else {
    const lineCount = contentLines.length;
    body.innerHTML = `
      <div class="english-placeholder">
        <div class="badge">Awaiting first English</div>
        <p>No machine translation is published for this text yet.</p>
        <p style="margin-top:1rem;font-size:0.9rem;color:var(--text-faint)">
          ${lineCount} ATF content lines ready. You can draft English yourself with the in-browser
          translator (B2c ~810 MB or Compact v4e ~94 MB; choose on first use, runs on your device).
        </p>
        <p style="margin-top:1rem">
          ${lineCount ? `<a class="btn primary" href="${escapeAttr(translatorUrl(text, 0))}">Open in the in-browser translator</a>` : ""}
        </p>
      </div>`;
  }
  bindLineHover(body);
}

// ─── In-browser translator link ───
/** Link to translate.html prefilled with this text's ATF lines (starting at line index `from`). */
function translatorUrl(text, from = 0) {
  const q = new URLSearchParams({ id: text.id });
  if (from > 0) q.set("from", String(from));
  // Carry the visitor's saved in-browser model choice (set from the reader cog or translate modal).
  try {
    const pref = localStorage.getItem("unread.translator.model");
    if (pref === "v4e") q.set("revision", "v4e-2026-10-11");
    else if (pref === "b2c") q.set("revision", "cb93faed82ce9440a03755ae0a8b12eba0db3bbb");
    // pref === "cached" → no revision; translate.html will prompt for an in-browser model
  } catch (_) { /* private mode */ }
  return `${TRANSLATOR_PAGE}?${q}`;
}

const SURF_NAMES = [
  [/^(obverse|obv\.?|o)$/, "obv.", "Obverse"], [/^(reverse|rev\.?|r)$/, "rev.", "Reverse"],
  [/^(left edge|le)$/, "l.e.", "Left edge"], [/^(right edge|re)$/, "r.e.", "Right edge"],
  [/^(top edge|upper edge|te|ue)$/, "t.e.", "Top edge"], [/^(bottom edge|lower edge|be|lo\.? ?e\.?)$/, "b.e.", "Bottom edge"],
  [/^(edge|e)$/, "edge", "Edge"],
];
/** ATF surface ("o", "obverse col 1", "o i", "left edge") -> short tag ("obv. 1") and full label ("Obverse, column 1"). */
function parseSurface(s) {
  const raw = String(s || "").trim();
  const m = raw.toLowerCase().match(/^(.*?)(?:\s+(?:col(?:umn)?\.?\s*)?([ivx]+|\d+))?$/);
  const side = (m && m[1]) || raw.toLowerCase(), col = m && m[2];
  const hit = SURF_NAMES.find(([re]) => re.test(side));
  const short = hit ? hit[1] : side.length > 6 ? side.slice(0, 5) + "." : side;
  return { short: col ? `${short} ${col}` : short, label: hit ? hit[2] + (col ? `, column ${col}` : "") : raw };
}
const surfaceShort = (s) => parseSurface(s).short;
const surfaceLabel = (s) => parseSurface(s).label;

function renderAtfCol(text) {
  const body = $("#atf-body");
  const lines = text.lines || [];
  if (!lines.length) {
    body.innerHTML = `<p style="color:var(--text-faint)">${text.atf ? escapeHtml(text.atf.slice(0, 2000)) : "No ATF available in package."}</p>`;
    return;
  }

  let html = "";
  let lastSurface = "";
  let lastCol = "";
  let i = 0;
  for (const line of lines) {
    if (line.type === "line") {
      const surf = [line.surface, line.column].filter(Boolean).join(" · ");
      // surface/column change: a tag in the line-number cell (not a separate row, which offset the first line)
      let tag = "", sc = "";
      if (surf && (line.surface !== lastSurface || line.column !== lastCol)) {
        tag = `<span class="lg-surf" title="${escapeAttr(surf)}">${escapeHtml(surfaceShort(line.surface) + (line.column ? " " + line.column : ""))}</span>`;
        if (i > 0) sc = " lg-surf-start";
        lastSurface = line.surface;
        lastCol = line.column;
      }
      html += `<div class="line-row${sc}" data-i="${i}" data-atf="${escapeAttr(line.atf)}">
        <span class="ln">${tag}${escapeHtml(line.n)}</span>
        <span class="atf">${escapeHtml(line.atf)}</span>
      </div>`;
      i += 1;
    } else if (line.type === "note") {
      html += `<div class="line-row note">${escapeHtml(line.text)}</div>`;
    }
  }
  body.innerHTML = `<div class="atf-lines">${html}</div>`;
  bindLineHover(body);
}

function fontDescription() {
  const f = FontMap.info(state.font);
  if (!f) return state.font || null;
  const auto = FontMap.info(state.fontAuto);
  const why = FontMap.override()
    ? `your choice for this session (period default: ${auto ? auto.family : state.fontAuto})`
    : state.fontRule
      ? `by period: ${state.fontRule.basis}`
      : "default (no period-specific face)";
  return `${f.family} (${f.label}) by ${f.author}; ${why}`;
}

function fillFontPicker() {
  const sel = $("#font-select");
  if (!sel) return;
  const opts = [`<option value="">Auto (by period)</option>`].concat(
    Object.entries(FontMap.fonts()).map(([id, f]) => `<option value="${escapeAttr(id)}">${escapeHtml(f.family)}: ${escapeHtml(f.label)}</option>`)
  );
  sel.innerHTML = opts.join("");
  sel.value = FontMap.override();
}

async function renderCuneiformCol(text) {
  const body = $("#cuneiform-body");
  const lines = (text.lines || []).filter((l) => l.type === "line");
  FontMap.ensure(state.font);
  const fontStyle = `font-family:${FontMap.stack(state.font)}`;

  if (!lines.length) {
    body.innerHTML = `<p style="color:var(--text-faint)">No lines to render.</p>`;
    return;
  }

  body.innerHTML = `<div class="cuneiform-lines" id="cunei-root" data-font="${escapeAttr(state.font)}" style='${fontStyle}'><div style="color:var(--text-faint);font-family:var(--font-ui);font-size:0.85rem">Converting ATF → Unicode…</div></div>`;

  try {
    await Atf2Unicode.load(`${DATA_BASE}/atf_unicode_readings.json`);
  } catch (e) {
    body.innerHTML = `<p style="color:var(--danger)">Could not load reading map: ${escapeHtml(e.message)}</p>`;
    return;
  }

  const root = $("#cunei-root");
  let html = "";
  let i = 0;
  for (const line of lines) {
    const cached = state.cuneiformCache.get(line.atf);
    let result = cached;
    if (!result) {
      result = Atf2Unicode.convertLine(line.atf); // offline sign-reading map (data/atf_unicode_readings.json)
      state.cuneiformCache.set(line.atf, result);
    }
    const dim = result.coverage < 0.4 ? "opacity:0.55" : "";
    html += `<div class="line-row" data-i="${i}" style="${dim}">
      <span class="ln">${escapeHtml(line.n)}</span>
      <span class="cunei" title="${escapeAttr(`${Math.round(result.coverage * 100)}% mapped`)}">${escapeHtml(result.text || "·")}</span>
    </div>`;
    i += 1;
    // yield occasionally for large texts
    if (i % 80 === 0) {
      root.innerHTML = html;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  root.innerHTML = html;
  root.className = "cuneiform-lines";
  bindLineHover(body);
  paintFindLines();
  const cHit = document.querySelector("#cuneiform-body .find-line");
  if (cHit) scrollColBody(cHit);
}

function bindLineHover(container) {
  container.querySelectorAll(".line-row[data-i], .line-en[data-i], .lg-cell[data-i], .lg-cell[data-s]").forEach((el) => {
    el.addEventListener("mouseenter", () => (el.dataset.s != null ? highlightLine(+el.dataset.s, +el.dataset.e) : highlightLine(el.dataset.i)));
    el.addEventListener("mouseleave", () => highlightLine(null));
  });
  bindColumnInfo(container);
}

/**
 * Highlight row i (or rows i..e) in every column. Passage cells (ORACC paragraphs spanning rows s..e) light up
 * whenever any row they cover is hovered, and hovering a passage lights every row it covers.
 */
function highlightLine(i, e) {
  $$(".line-row.hl, .line-en.hl, .lg-cell.hl").forEach((el) => el.classList.remove("hl"));
  if (i == null) return;
  const s = +i, end = e == null ? s : +e;
  for (let k = s; k <= end; k++) $$(`[data-i="${k}"]`).forEach((el) => el.classList.add("hl"));
  $$(".lg-cell[data-s]").forEach((el) => {
    if (+el.dataset.s <= end && +el.dataset.e >= s) el.classList.add("hl");
  });
}

// ─── Column preambles: ⓘ popover per column + one global "show inline" toggle (localStorage, default hidden) ───
const PREAMBLE_KEY = "unread.showPreambles";
function applyPreambles() {
  const on = localStorage.getItem(PREAMBLE_KEY) === "1";
  document.body.classList.toggle("show-preambles", on);
  $$(".preamble-toggle").forEach((b) => {
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("on", on);
  });
}
function setPreambles(on) {
  localStorage.setItem(PREAMBLE_KEY, on ? "1" : "0");
  applyPreambles();
}
function closeColumnInfo() {
  const pop = $("#lg-pop");
  if (pop) pop.remove();
}
function bindColumnInfo(container) {
  container.querySelectorAll(".lg-info").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = $("#lg-pop");
      if (open && open._btn === btn) return closeColumnInfo();
      closeColumnInfo();
      const src = [...container.querySelectorAll(".lg-credit[data-for]")].find((c) => c.dataset.for === btn.dataset.info);
      if (!src) return;
      const pop = document.createElement("div");
      pop.id = "lg-pop";
      pop.className = "lg-pop";
      pop._btn = btn;
      pop.setAttribute("role", "dialog");
      pop.innerHTML = src.innerHTML + `<label class="lg-pop-opt"><input type="checkbox" class="lg-pop-inline"${localStorage.getItem(PREAMBLE_KEY) === "1" ? " checked" : ""}> Show these notes at the top of every column</label>`;
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect();
      const w = Math.min(340, window.innerWidth - 16);
      pop.style.width = w + "px";
      pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
      pop.style.top = r.bottom + 6 + "px";
      pop.addEventListener("click", (e) => e.stopPropagation());
      pop.querySelector(".lg-pop-inline").addEventListener("change", (e) => setPreambles(e.target.checked));
    });
  });
}
document.addEventListener("click", closeColumnInfo);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeColumnInfo());
window.addEventListener("scroll", (e) => { if (!(e.target.closest && e.target.closest("#lg-pop"))) closeColumnInfo(); }, true);
function initPreambles() {
  applyPreambles();
  $$(".preamble-toggle").forEach((b) => b.addEventListener("click", () => setPreambles(localStorage.getItem(PREAMBLE_KEY) !== "1")));
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPreambles);
else initPreambles();

// ─── Map ───
function initMap() {
  if (state.map) return;
  state.map = L.map("map", {
    zoomControl: true,
    attributionControl: false, // basemap is our own public-domain relief: no on-map credit required (see credits.html)
    minZoom: 2,
    maxZoom: 10,
    maxBounds: [[-85.06, -200], [85.06, 200]],
    maxBoundsViscosity: 0.8,
  }).setView([33.5, 44.0], 5);

  // Self-hosted, label-free shaded relief (NOAA ETOPO 2022 + Natural Earth, both public domain).
  // Built by scripts/basemap/render_relief.py; see web/tiles/relief/ATTRIBUTION.md.
  // z0-7 cover the whole world (ETOPO 60"); Near East z7-8 come from ETOPO 15" (the z7 files there replace
  // the 60" ones in the same folder); above that tiles are upscaled.
  // Default: the dark "computer map" (same renderer, --style dark): world z0-5 from ETOPO 60", Near East z6-8
  // from ETOPO 15" (scripts/basemap/render_relief.py; /mnt/alpaca/unread-basemap/run_dark.sh).
  // ?style=relief (or =default / =light) brings back the earlier shaded relief.
  const dark = !["relief", "default", "light"].includes(new URLSearchParams(location.search).get("style"));
  const BASE = dark
    ? { url: "tiles/dark/{z}/{x}/{y}.webp", worldMax: 5, near: 6 }
    : { url: "tiles/relief/{z}/{x}/{y}.webp", worldMax: 7, near: 7 };
  if (dark) state.map.getContainer().classList.add("map-dark");
  L.tileLayer(BASE.url, {
    minZoom: 0,
    maxZoom: 10,
    minNativeZoom: 0,
    maxNativeZoom: BASE.worldMax,
    bounds: [[-85.0511, -180], [85.0511, 180]],
    noWrap: true,
  }).addTo(state.map);
  L.tileLayer(BASE.url, {
    minZoom: BASE.near,
    maxZoom: 10,
    minNativeZoom: BASE.near,
    maxNativeZoom: 8,
    bounds: [[22, 24], [46, 62]],
    noWrap: true,
  }).addTo(state.map);

  // The map panel's height settles after the catalog and preview render (grid layout); keep Leaflet's
  // cached size in sync, or fitBounds/panTo work against a stale (taller) viewport.
  if (window.ResizeObserver) new ResizeObserver(() => state.map.invalidateSize({ pan: false })).observe(state.map.getContainer());

  // Tiny credits link instead of a tile attribution (nothing on the map is legally required).
  const Credits = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const d = L.DomUtil.create("div", "leaflet-control map-credits");
      d.innerHTML = '<a href="credits.html#basemap" title="Map data, software and thanks">Credits</a>';
      L.DomEvent.disableClickPropagation(d);
      return d;
    },
  });
  new Credits().addTo(state.map);

  // Fit Mesopotamia + Anatolia
  state.map.fitBounds([
    [28, 34],
    [42, 52],
  ]);
}

// Find-spots we should not pin: placeholder coordinates from upstream metadata, or no usable
// site at all ("uncertain (mod. uncertain)", "Irisagrig (mod. uncertain)", a region such as
// "uncertain (mod. Babylonia)"). "uncertain (mod. Abu Salabikh)" etc. are pinned at the named
// modern site. Same rule as scripts/fix_catalog_sites.py usable_site(). Unpinned works stay in the list.
const PLACEHOLDER_COORDS = [[51.2297, 58.6555]];
const FS_UNKNOWN = /^(uncertain|unclear|unknown)$/i;
const FS_REGION = /^(northern |southern |central )?(babylonia|assyria|mesopotamia|iran|syria|anatolia)$/i;
function hasKnownFindspot(item) {
  if (!item || item.lat == null || item.lon == null) return false;
  const lat = Number(item.lat), lon = Number(item.lon);
  if (PLACEHOLDER_COORDS.some(([a, b]) => Math.abs(lat - a) < 1e-3 && Math.abs(lon - b) < 1e-3)) return false;
  const prov = String(item.provenience || item.site || "").trim().replace(/\s*\?$/, "").trim();
  const m = prov.match(/^(.*?)\s*\(mod\.\s*(.*?)\)$/);
  const ancient = (m ? m[1] : prov).trim(), modern = m ? m[2].trim() : "";
  if (!ancient && !modern) return false;
  if (modern && FS_UNKNOWN.test(modern)) return false;
  if (FS_UNKNOWN.test(ancient) && (!modern || FS_REGION.test(modern))) return false;
  if (FS_REGION.test(ancient) && !modern) return false;
  return true;
}

function updateMapMarkers() {
  if (!state.map) return;

  // Aggregate filtered items by site
  const bySite = new Map();
  for (const item of state.filtered) {
    if (!hasKnownFindspot(item)) continue;
    const key = item.site || `${item.lat},${item.lon}`;
    if (!bySite.has(key)) bySite.set(key, { lat: item.lat, lon: item.lon, site: item.site, items: [] });
    bySite.get(key).items.push(item);
  }

  // Same set of works as last time (e.g. only the timeline sort changed)? Keep the layers, just restyle.
  const sig = [...bySite.entries()]
    .map(([k, g]) => k + ":" + g.items.map((i) => i.id).sort().join(","))
    .sort()
    .join("|");
  if (sig === state.markerSig && Object.keys(state.markers).length === bySite.size) {
    for (const [key, group] of bySite) state.markerGroups[key] = group;
    styleMarkersForTime();
    return;
  }
  state.markerSig = sig;

  // Clear old
  Object.values(state.markers).forEach((m) => state.map.removeLayer(m));
  state.markers = {};
  state.markerGroups = {};

  for (const [key, group] of bySite) {
    const icon = L.divIcon({
      className: "site-marker",
      html: '<span class="site-dot"></span>',
      iconSize: [12, 12],
    });
    const marker = L.marker([group.lat, group.lon], { icon }).addTo(state.map);
    marker.bindPopup(() => {
      // nearest-dated works first when the time browser is active
      const items = [...(state.markerGroups[key] || group).items];
      if (state.timeFade) items.sort((a, b) => timeDistance(a, state.timelineYear) - timeDistance(b, state.timelineYear));
      const top = items.slice(0, 5);
      return `<strong>${escapeHtml(group.site || "Site")}</strong>
       ${items.length} work(s) in filter<br/>
       ${top.map((t) => `<a href="#" data-open="${t.id}">${escapeHtml(t.id)}</a>`).join(" · ")}`;
    });
    marker.on("click", () => {
      // select the nearest-dated item at the site when the time browser is active
      const items = [...(state.markerGroups[key] || group).items];
      if (state.timeFade) items.sort((a, b) => timeDistance(a, state.timelineYear) - timeDistance(b, state.timelineYear));
      if (items[0]) selectWork(items[0].id);
    });
    state.markers[key] = marker;
    state.markerGroups[key] = group;
  }

  $("#map-empty").style.display = bySite.size ? "none" : "flex";
  styleMarkersForTime();
}

function highlightMapSite(item) {
  Object.entries(state.markers).forEach(([key, marker]) => {
    const el = marker.getElement();
    if (!el) return;
    const match =
      item.site && key === item.site
        ? true
        : item.lat != null && Math.abs(marker.getLatLng().lat - item.lat) < 0.01;
    el.classList.toggle("active", !!match && hasKnownFindspot(item));
  });
  if (hasKnownFindspot(item)) {
    state.map?.panTo([item.lat, item.lon], { animate: true });
  }
}

// ─── Timeline ───
const YEAR_MIN = -3400;
const YEAR_MAX = -50;
const YEAR_STEP = 25;

/**
 * Conventional era bands (approximate; middle chronology, years BCE as negatives).
 * Bands are contiguous for the track; `dates` gives the conventional label where it differs
 * from the band edges (e.g. the Neo-Babylonian dynasty begins 626 while Assyria falls 612).
 */
const ERAS = [
  { id: "uruk", short: "Uruk", label: "Uruk IV–III / Jemdet Nasr", start: -3400, end: -2900 },
  { id: "ed", short: "ED", label: "Early Dynastic I–III", start: -2900, end: -2334 },
  { id: "akk", short: "Akk", label: "Old Akkadian (Sargonic)", start: -2334, end: -2154 },
  { id: "lagash2", short: "Lg II", label: "Gutian / Lagash II", start: -2154, end: -2112 },
  { id: "ur3", short: "Ur III", label: "Ur III", start: -2112, end: -2004 },
  { id: "ob", short: "OB / OA", label: "Old Babylonian / Old Assyrian", start: -2004, end: -1595 },
  { id: "mb", short: "MB / MA", label: "Middle Babylonian (Kassite) / Middle Assyrian", start: -1595, end: -911 },
  { id: "na", short: "NA", label: "Neo-Assyrian", start: -911, end: -612 },
  { id: "nb", short: "NB", label: "Neo-Babylonian", start: -612, end: -539, dates: "626–539 BCE" },
  { id: "ach", short: "Ach", label: "Achaemenid", start: -539, end: -331 },
  { id: "hel", short: "Hell", label: "Hellenistic (Seleucid)", start: -331, end: -63 },
];

// Map fading: full strength within TIME_FULL years of a work's date range, smooth fade to
// TIME_MIN_OPACITY at TIME_FAINT years and beyond (never hidden). Undated works stay neutral/dim.
const TIME_FULL = 150;
const TIME_FAINT = 600;
const TIME_MIN_OPACITY = 0.3;
const TIME_UNDATED_OPACITY = 0.45;

function eraFor(y) {
  return ERAS.find((e) => y >= e.start && y < e.end) || (y >= ERAS[ERAS.length - 1].end ? ERAS[ERAS.length - 1] : null);
}

function eraDates(e) {
  return e.dates || `${Math.abs(e.start)}–${Math.abs(e.end)} BCE`;
}

/** [from, to] years for a work: its period's conventional range when given, else year ± 50. */
function itemRange(item) {
  if (item._range !== undefined) return item._range;
  let r = null;
  const m = /(\d{3,4})\s*[-–]\s*(\d{1,4})\s*BC/.exec(item.period || "");
  if (m) r = [-Number(m[1]), -Number(m[2])];
  else if (item.year != null) r = [item.year - 50, item.year + 50];
  item._range = r;
  return r;
}

function timeDistance(item, y) {
  const r = itemRange(item);
  if (!r) return Infinity;
  return y < r[0] ? r[0] - y : y > r[1] ? y - r[1] : 0;
}

/** 1 = in period, 0 = far; null = undated */
function timeWeight(item, y) {
  const d = timeDistance(item, y);
  if (d === Infinity) return null;
  if (d <= TIME_FULL) return 1;
  if (d >= TIME_FAINT) return 0;
  const t = (d - TIME_FULL) / (TIME_FAINT - TIME_FULL);
  return 1 - t * t * (3 - 2 * t); // smoothstep
}

function styleMarkersForTime() {
  const y = state.timelineYear;
  const fade = state.timeFade;
  for (const [key, marker] of Object.entries(state.markers)) {
    const el = marker.getElement();
    if (!el) continue;
    const group = state.markerGroups[key];
    // nearest-dated work at this site decides the marker's strength
    let w = null;
    let best = null;
    if (fade && group) {
      for (const it of group.items) {
        const wi = timeWeight(it, y);
        if (wi != null && (w == null || wi > w || (wi === w && timeDistance(it, y) < timeDistance(best, y)))) {
          w = wi;
          best = it;
        }
      }
    }
    let o = 1;
    let sc = 1;
    if (fade) {
      if (w == null) {
        o = TIME_UNDATED_OPACITY;
        sc = 0.75;
      } else {
        o = TIME_MIN_OPACITY + (1 - TIME_MIN_OPACITY) * w;
        sc = 0.6 + 0.4 * w;
      }
    }
    el.style.setProperty("--o", o.toFixed(3));
    el.style.setProperty("--s", sc.toFixed(3));
    el.classList.toggle("undated", fade && w == null);
    el.title = group ? `${group.site || "Site"}${best ? " · nearest: " + (shortPeriod(best.period) || formatYear(best.year)) : ""}` : "";
    const z = fade ? Math.round((w ?? 0.3) * 1000) : 0;
    if (marker.options.zIndexOffset !== z) marker.setZIndexOffset(z);
  }
}

// Hook for other layers (e.g. a future coastline / sea-level layer):
//   const off = onTimelineChange((year, { fading, era }) => { ... });
// Also dispatched as a DOM event: document.addEventListener("unread:timeline", (e) => e.detail.year)
const timelineListeners = new Set();
function onTimelineChange(fn) {
  timelineListeners.add(fn);
  return () => timelineListeners.delete(fn);
}
function emitTimelineChange() {
  const detail = { year: state.timelineYear, fading: state.timeFade, era: eraFor(state.timelineYear) };
  for (const fn of timelineListeners) {
    try {
      fn(detail.year, detail);
    } catch (e) {
      console.error("timeline listener failed", e);
    }
  }
  document.dispatchEvent(new CustomEvent("unread:timeline", { detail }));
}
window.UnreadTimeline = {
  onTimelineChange,
  ERAS,
  eraFor,
  setYear: (y) => setTimelineYear(y),
  setFading: (on) => setTimeFade(on),
  get year() {
    return state.timelineYear;
  },
  get fading() {
    return state.timeFade;
  },
};

let timelineRaf = 0;
let timelineSortTimer = 0;
function scheduleTimelineFrame() {
  if (timelineRaf) return;
  timelineRaf = requestAnimationFrame(() => {
    timelineRaf = 0;
    updateTimelineUI();
    styleMarkersForTime();
    emitTimelineChange();
  });
}

function setTimelineYear(y, { activate = true } = {}) {
  y = Math.max(YEAR_MIN, Math.min(YEAR_MAX, Math.round(y / YEAR_STEP) * YEAR_STEP));
  state.timelineYear = y;
  if (activate) state.timeFade = true;
  const input = $("#timeline-range");
  if (input && Number(input.value) !== y) input.value = y;
  scheduleTimelineFrame();
  // re-sort the catalog list once dragging settles (markers are restyled per frame, not rebuilt)
  clearTimeout(timelineSortTimer);
  timelineSortTimer = setTimeout(applyFilters, 180);
}

function setTimeFade(on) {
  state.timeFade = !!on;
  scheduleTimelineFrame();
}

const yearPct = (y) => ((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;

function initTimeline() {
  const input = $("#timeline-range");
  input.min = YEAR_MIN;
  input.max = YEAR_MAX;
  input.step = YEAR_STEP;
  input.value = state.timelineYear;

  // era segments on the track + clickable era buttons below it
  const band = $("#timeline-eraband");
  const eras = $("#timeline-eras");
  band.innerHTML = ERAS.map(
    (e, i) =>
      `<span class="era-seg era-${i % 2 ? "odd" : "even"}" data-era="${e.id}" style="left:${yearPct(e.start)}%;width:${yearPct(Math.min(e.end, YEAR_MAX)) - yearPct(e.start)}%"></span>`
  ).join("");
  eras.innerHTML =
    ERAS.map((e) => {
      const w = yearPct(Math.min(e.end, YEAR_MAX)) - yearPct(e.start);
      return `<button type="button" class="era-btn${w < 3.2 ? " narrow" : ""}" data-era="${e.id}" style="left:${yearPct(e.start)}%;width:${w}%"
        title="${escapeAttr(e.label + " · c. " + eraDates(e) + " (approx.)")}">${escapeHtml(e.short)}</button>`;
    }).join("");
  eras.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    const e = ERAS.find((x) => x.id === b.dataset.era);
    if (e) setTimelineYear((e.start + Math.min(e.end, YEAR_MAX)) / 2);
  });

  input.addEventListener("input", () => setTimelineYear(Number(input.value)));
  input.addEventListener("keydown", (ev) => {
    // native arrows step 25 years (input.step); Shift+arrow = 100 years
    if (ev.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) {
      ev.preventDefault();
      const dir = ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : 1;
      setTimelineYear(state.timelineYear + dir * 100);
    }
  });
  $("#timeline-all").addEventListener("click", () => setTimeFade(!state.timeFade));
  updateTimelineUI();
}

function updateTimelineUI() {
  const y = state.timelineYear;
  $("#timeline-fill").style.width = `${yearPct(y)}%`;
  $("#timeline-year").textContent = formatYear(y);
  const era = eraFor(y);
  const eraEl = $("#timeline-era");
  eraEl.textContent = era ? `${era.label} · c. ${eraDates(era)}` : "";
  eraEl.title = "Conventional dates, approximate (middle chronology)";
  $$("#timeline-eraband .era-seg, #timeline-eras .era-btn").forEach((el) =>
    el.classList.toggle("active", !!era && el.dataset.era === era.id)
  );
  const panel = $(".timeline-panel");
  panel.classList.toggle("fading", state.timeFade);
  const all = $("#timeline-all");
  all.setAttribute("aria-pressed", String(!state.timeFade));
  all.title = state.timeFade
    ? "Show all works at full strength"
    : "All periods shown — drag the slider (or click an era) to fade works far from the chosen date";
  $("#timeline-range").setAttribute("aria-valuetext", `${formatYear(y)}${era ? ", " + era.label : ""}`);
}

function updateTimelineDots() {
  const host = $("#timeline-dots");
  // sample up to 80 filtered items with years
  const withYear = state.filtered.filter((i) => i.year != null).slice(0, 80);
  host.innerHTML = withYear
    .map((item) => {
      const pct = yearPct(item.year);
      return `<span class="timeline-dot" style="left:${pct}%" title="${escapeAttr(item.id + " " + formatYear(item.year))}"></span>`;
    })
    .join("");
}

function formatYear(y) {
  if (y == null) return "—";
  const abs = Math.abs(y);
  return y < 0 ? `${abs} BCE` : `${abs} CE`;
}

function shortPeriod(p) {
  if (!p) return "";
  return p.replace(/\s*\(ca\.[^)]+\)/, "").replace(/\s*\([^)]*BC[^)]*\)/, "").trim() || p;
}

// ─── View routing ───
function setView(name, hist = "push") {
  if (hist !== "none") {
    const id = name === "reader" ? state.readerPending?.id || state.currentText?.id : null;
    syncUrl(name, id, hist);
  }
  state.view = name;
  $$(".view").forEach((v) => v.classList.remove("active"));
  $$(`.nav-btn`).forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $(`#view-${name}`)?.classList.add("active");
  if (name === "explore") {
    setTimeout(() => state.map?.invalidateSize(), 50);
  }
  if (name === "reader") {
    renderReader();
  }
  if (name === "stats") renderStats();
}

// ─── Utils ───
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

// ─── Events ───
function bindEvents() {
  $("#btn-reader-retry")?.addEventListener("click", () => state.readerPending && openReader(state.readerPending.id));
  $("#btn-reader-pending-explore")?.addEventListener("click", () => {
    state._readerToken = (state._readerToken || 0) + 1;
    state.readerPending = null;
    setView("explore");
  });
  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  // in-page links to another view (About → Stats) switch views without a reload
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[data-goto-view]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    setView(a.dataset.gotoView);
    $("#view-" + a.dataset.gotoView)?.scrollTo?.(0, 0);
  });

  $("#search").addEventListener("input", debounce(applyFilters, 150));
  ["filter-genre", "filter-period", "filter-language", "filter-site"].forEach((id) => {
    $(`#${id}`).addEventListener("change", applyFilters);
  });
  $("#filter-min-lines").addEventListener("input", () => {
    $("#min-lines-val").textContent = $("#filter-min-lines").value;
    applyFilters();
  });
  $("#filter-hide-known").addEventListener("change", applyFilters);
  $("#filter-open-gap")?.addEventListener("change", applyFilters);
  $("#filter-packaged").addEventListener("change", applyFilters);
  $("#filter-no-english")?.addEventListener("change", applyFilters);
  $("#filter-not-online")?.addEventListener("change", applyFilters);
  $("#filter-epic-hunt")?.addEventListener("change", applyFilters);
  $("#filter-herbal")?.addEventListener("change", applyFilters);
  $("#filter-omens")?.addEventListener("change", applyFilters);
  $("#filter-math")?.addEventListener("change", applyFilters);

  $("#omen-kind-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kind]");
    if (!btn) return;
    state.omenKind = btn.dataset.kind || null;
    applyFilters();
  });
  $("#math-kind-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kind]");
    if (!btn) return;
    state.mathKind = btn.dataset.kind || null;
    applyFilters();
  });

  const MODE_FILTERS = {
    epic: "filter-epic-hunt",
    herbal: "filter-herbal",
    omens: "filter-omens",
    math: "filter-math",
  };

  const openFeatured = (id, mode) => {
    // Exclusive specialty modes when opening a featured pick
    for (const [m, fid] of Object.entries(MODE_FILTERS)) {
      const el = $(`#${fid}`);
      if (el) el.checked = m === mode;
    }
    if (mode === "omens") {
      const item = state.catalog?.items?.find((x) => x.id === id);
      state.omenKind = item?.omen_kind || null;
      state.mathKind = null;
    } else if (mode === "math") {
      const item = state.catalog?.items?.find((x) => x.id === id);
      state.mathKind = item?.math_kind || null;
      state.omenKind = null;
    } else {
      state.omenKind = null;
      state.mathKind = null;
    }
    applyFilters();
    openReader(id);
  };

  $("#featured-row")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-featured]");
    if (!btn) return;
    openFeatured(btn.dataset.featured, "epic");
  });

  $("#featured-herbal-row")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-featured]");
    if (!btn) return;
    openFeatured(btn.dataset.featured, "herbal");
  });

  $("#featured-omen-row")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-featured]");
    if (!btn) return;
    openFeatured(btn.dataset.featured, "omens");
  });

  $("#featured-math-row")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-featured]");
    if (!btn) return;
    openFeatured(btn.dataset.featured, "math");
  });

  $("#catalog-list").addEventListener("click", (e) => {
    const card = e.target.closest(".catalog-card");
    if (card) selectWork(card.dataset.id);
  });

  // popup links
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]");
    if (a) {
      e.preventDefault();
      openReader(a.dataset.open);
    }
  });

  $("#font-select").addEventListener("change", (e) => {
    FontMap.setOverride(e.target.value); // session only
    state.font = e.target.value || state.fontAuto || "NotoSansCuneiform";
    if (state.currentText) {
      state.currentText.font = state.font;
      renderCuneiformCol(state.currentText);
      if (state.readerPanels.meta) renderMetaCol(state.currentText);
    }
  });

  $$("#reader-chips [data-panel]").forEach((btn) => btn.addEventListener("click", () => onChip(btn)));
  let slideRaf = 0;
  $("#reader-body")?.addEventListener("scroll", () => {
    cancelAnimationFrame(slideRaf);
    slideRaf = requestAnimationFrame(syncSlideChip);
  }, { passive: true });
  initNavToggle();

  $("#btn-back-explore")?.addEventListener("click", () => setView("explore"));

}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Header nav: a Menu button below 760px (aria-expanded; closes on link click, Esc, or a tap outside). */
function initNavToggle() {
  const btn = $("#nav-toggle");
  const nav = $("#header-nav");
  if (!btn || !nav) return;
  const set = (open) => {
    btn.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("open", open);
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = btn.getAttribute("aria-expanded") !== "true";
    set(open);
    if (open) nav.querySelector(".nav-btn, .nav-link")?.focus();
  });
  nav.addEventListener("click", (e) => {
    if (e.target.closest(".nav-btn, .nav-link")) set(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
      set(false);
      btn.focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (btn.getAttribute("aria-expanded") === "true" && !nav.contains(e.target) && !btn.contains(e.target)) set(false);
  });
  NARROW_Q.addEventListener?.("change", () => set(false));
}

// ─── Boot ───
async function main() {
  bindEvents();
  initTimeline();
  initMap();

  // Deep link ?id=…: show the reader's loading state right away, not the map then "No work open"
  const deepId = new URLSearchParams(location.search).get("id");
  if (deepId) {
    state.readerPending = { id: deepId, failed: false };
    setView("reader", "none");
  } else {
    const v = new URLSearchParams(location.search).get("view");
    if (v === "about" || v === "reader" || v === "stats") setView(v, "none");
  }

  try {
    const man = await fetch(`${DATA_BASE}/texts/manifest.json`).then((r) => (r.ok ? r.json() : []));
    state._packagedIds = man.map((m) => m.id);
  } catch {
    state._packagedIds = [];
  }

  try {
    await loadCatalog();
    fillFontPicker();
    toast(`Loaded ${state.catalog.count} catalog works`);
    // Deep link ?id=P285108
    if (deepId) {
      await openReader(deepId, "none");
    } else {
      const first =
        state.filtered.find((i) => state._packagedIds.includes(i.id)) || state.filtered[0];
      if (first) await selectWork(first.id);
    }
  } catch (e) {
    console.error(e);
    toast(e.message || "Failed to load catalog");
    $("#catalog-list").innerHTML = `<p style="padding:1rem;color:var(--danger)">${escapeHtml(e.message)}</p>`;
    if (deepId) openReader(deepId, "none"); // the text API doesn't need the catalog
  }
}

document.addEventListener("DOMContentLoaded", main);

// ─── Collapsible left bar (state: html.sidebar-collapsed, set early in map.html's head) ───
// Hidden by default; "☰ Curated & filters" (#sidebar-open, on the map) toggles it, "◂ Hide panel" (#filters-toggle) closes it.
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("filters-toggle");
  const openBtn = document.getElementById("sidebar-open");
  if (!btn && !openBtn) return;
  const root = document.documentElement;
  const sync = () => {
    const open = !root.classList.contains("sidebar-collapsed");
    for (const b of [btn, openBtn]) if (b) { b.setAttribute("aria-expanded", String(open)); b.classList.toggle("on", open); }
  };
  const setOpen = (open, remember = true) => {
    root.classList.toggle("sidebar-collapsed", !open);
    if (remember) try { localStorage.setItem("ua.sidebar.v2", open ? "open" : "closed"); } catch (_) {}
    sync();
    // Leaflet caches the container size; the map widens/narrows with the bar
    if (state.map) requestAnimationFrame(() => state.map.invalidateSize({ pan: false }));
    if (open) document.getElementById("search")?.focus({ preventScroll: true });
  };
  if (btn) btn.addEventListener("click", () => setOpen(false));
  if (openBtn) openBtn.addEventListener("click", () => setOpen(root.classList.contains("sidebar-collapsed")));
  // a mode chip/featured deep link opened later should reveal its featured row
  document.querySelectorAll("#filter-epic-hunt,#filter-herbal,#filter-omens,#filter-math,#filter-open-gap,#filter-no-english,#filter-not-online").forEach((el) =>
    el.addEventListener("change", () => el.checked && setOpen(true, false)));
  sync();
});

// Single source of truth for corpus numbers: web/corpus_stats.json (scripts/build_corpus_stats.py).
// Fills every [data-stat="key"] (dotted paths ok) so header, About and banners never hardcode figures.
let _corpusStats;
function loadCorpusStats() {
  _corpusStats ||= fetch("corpus_stats.json").then((r) => (r.ok ? r.json() : null)).catch(() => null).then((cs) => {
    if (cs) document.querySelectorAll("[data-stat]").forEach((n) => {
      const key = n.dataset.stat;
      let v = key.split(".").reduce((o, p) => (o == null ? o : o[p]), cs);
      if (v == null) return;
      n.textContent = typeof v === "number" ? (key.startsWith("pct1.") ? v.toFixed(1) : v.toLocaleString("en-US")) : key === "corpus_built_at" ? String(v).slice(0, 10) : String(v);
    });
    return cs;
  });
  return _corpusStats;
}

// ─── Stats view (?view=stats): every corpus figure from corpus_stats.json, labelled by what it counts ───
function renderStats() {
  const body = $("#stats-body");
  if (!body) return;
  loadCorpusStats().then((cs) => {
    if (!cs) {
      body.innerHTML = `<p class="stats-loading">The figures file (corpus_stats.json) could not be loaded.</p>`;
      return;
    }
    const f = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "–");
    const pc = (n) => (cs.tablets ? ((100 * n) / cs.tablets).toFixed(1) + "%" : "");
    const day = (s) => String(s || "").slice(0, 10);
    const row = (n, label, note, share = true) =>
      `<tr><td class="num">${f(n)}</td><td>${label}${note ? `<div class="stats-note">${note}</div>` : ""}</td><td class="pct">${share ? pc(n) : ""}</td></tr>`;
    const bar = (n, max) => `<span class="stats-bar"><i style="width:${max ? Math.max(0.5, (100 * n) / max).toFixed(1) : 0}%"></i></span>`;
    const SRC = { cdli: "CDLI", oracc: "ORACC", ebl: "eBL", tlhdig: "TLHdig (Hittite)", achemenet: "Achemenet" };
    const srcRows = Object.entries(cs.sources || {}).sort((a, b) => b[1].tablets - a[1].tablets);
    const maxSrc = Math.max(...srcRows.map(([, v]) => v.tablets), 1);
    const labelTable = (obj) => {
      const top = obj?.top || [];
      const max = Math.max(...top.map((t) => t.tablets), 1);
      return `<table class="stats-table"><thead><tr><th>Label</th><th class="num">Tablets</th><th class="num">Records</th><th class="barcol" aria-hidden="true"></th></tr></thead><tbody>${top
        .map((t) => `<tr><td>${escapeHtml(t.label)}</td><td class="num">${f(t.tablets)}</td><td class="num">${f(t.records)}</td><td class="barcol">${bar(t.tablets, max)}</td></tr>`)
        .join("")}</tbody></table><p class="stats-note">${f(obj?.labels)} labels in all; ${f(obj?.unlabelled_records)} records carry none. Showing the ${top.length} largest.</p>`;
    };
    const fc = state.featuredCounts;
    body.innerHTML = `
      <h3>The catalogue</h3>
      <p class="stats-note">A <b>tablet</b> is one physical object, counted once even when several projects list it. Percentages are of all ${f(cs.tablets)} catalogued tablets.</p>
      <table class="stats-table stats-main"><tbody>
        ${row(cs.tablets, "<b>tablets catalogued</b>", "every tablet with a record in at least one source", false)}
        ${row(cs.with_text, "with a transliteration (ATF text) online")}
        ${row(cs.any_en, "with English of any kind (human or machine)")}
      </tbody></table>
      <h3>What can be read</h3>
      <p class="stats-note">These four groups do not overlap.</p>
      <div class="stats-stack" role="img" aria-label="Catalogued tablets by what is online">
        <i class="s-h" style="width:${pc(cs.human_en)}"></i><i class="s-m" style="width:${pc(cs.machine_en)}"></i><i class="s-a" style="width:${pc(cs.text_no_en)}"></i><i class="s-c" style="width:${pc(cs.catalogue_only)}"></i>
      </div>
      <table class="stats-table stats-main"><tbody>
        ${row(cs.human_en, '<em class="sw s-h"></em>with English by human scholars', "published translations from the source projects")}
        ${row(cs.machine_en, '<em class="sw s-m"></em>machine English draft only', "no human English online; draft from our ATF-to-English model, labelled as such")}
        ${row(cs.text_no_en, '<em class="sw s-a"></em>transliteration but no English yet')}
        ${row(cs.catalogue_only, '<em class="sw s-c"></em>catalogue entry only', "known from a catalogue record; no transliteration online")}
      </tbody></table>
      <h3>On the map</h3>
      <table class="stats-table stats-main"><tbody>
        ${row(cs.with_coords, "tablets with coordinates in a source", `${f(cs.place_names)} differently spelled place names`)}
        ${row(cs.mapped, "<b>tablets on the map</b> (a named find-spot)", `${f(cs.unmapped_coords)} more are placed only as “uncertain”, “unknown” or a region, so the map leaves them out`)}
        ${row(cs.map_points, "map points", "spellings of the same place share one point", false)}
      </tbody></table>
      <h3>By source project</h3>
      <p class="stats-note"><b>Records</b> are a source's own listings; a project can list one tablet more than once. Many tablets appear in several projects, so the tablet column adds up to more than ${f(cs.tablets)}.</p>
      <table class="stats-table"><thead><tr><th>Source</th><th class="num">Tablets</th><th class="num">Records</th><th class="barcol" aria-hidden="true"></th></tr></thead><tbody>${srcRows
        .map(([k, v]) => `<tr><td>${SRC[k] || escapeHtml(k)}</td><td class="num">${f(v.tablets)}</td><td class="num">${f(v.records)}</td><td class="barcol">${bar(v.tablets, maxSrc)}</td></tr>`)
        .join("")}</tbody></table>
      <h3>Largest periods</h3>
      <p class="stats-note">Tablets carrying the label in at least one source; one tablet can carry different labels in different sources.</p>
      ${labelTable(cs.periods)}
      <h3>Largest languages</h3>
      ${labelTable(cs.languages)}
      ${fc ? `<h3>Featured sets</h3>
      <p class="stats-note">Tablets in the themed sets of the Explore panel (☰ Curated &amp; filters).</p>
      <table class="stats-table"><tbody>
        <tr><td class="num">${f(fc.epic)}</td><td><a href="?mode=epic">Epic hunt</a></td></tr>
        <tr><td class="num">${f(fc.remedies)}</td><td><a href="?mode=remedies">Remedies</a></td></tr>
        <tr><td class="num">${f(fc.omens)}</td><td><a href="?mode=omens">Omens</a></td></tr>
        <tr><td class="num">${f(fc.math)}</td><td><a href="?mode=math">Math</a></td></tr>
      </tbody></table>` : ""}
      <p class="stats-foot">Corpus built ${day(cs.corpus_built_at)} · figures generated ${day(cs.generated_at)} from that build (<a href="corpus_stats.json">corpus_stats.json</a>, with the exact queries).</p>`;
  });
}

// ─── Bridge for js/reader-model.js (ES module): cached vs in-browser Machine column ───
(function () {
  const cachedBackup = new WeakMap(); // text -> { english, note, translationsMachine }

  function snapshotCached(text) {
    if (!text || cachedBackup.has(text)) return;
    const machine = (text.translations || []).find((o) => o.kind === "machine");
    cachedBackup.set(text, {
      english: Array.isArray(text.english) ? text.english.slice() : text.english,
      english_note: text.english_note,
      english_labels: text.english_labels,
      english_conf: text.english_conf,
      machineEnglish: machine && Array.isArray(machine.english) ? machine.english.slice() : null,
      machineNote: machine ? machine.note : null,
      machineLabel: machine ? machine.label : null,
      machineModelLabel: machine ? machine.model_label : null,
      live: false,
    });
  }

  function hasCachedMachine(text) {
    if (!text) return false;
    if ((text.translations || []).some((o) => o.kind === "machine" && (o.english || []).some(Boolean))) return true;
    if (Array.isArray(text.english) && text.english.some(Boolean) && text.english_kind !== "human") return true;
    if (text.has_machine_draft) return true;
    return false;
  }

  function getAtfLines(text) {
    return (text.lines || []).filter((l) => l.type === "line" && l.atf).map((l) => l.atf);
  }

  function setLiveMachineLines(lines, meta = {}) {
    const text = state.currentText;
    if (!text) return;
    snapshotCached(text);
    const bak = cachedBackup.get(text);
    bak.live = true;
    const note =
      meta.label
        ? `Machine translation · in-browser ${meta.label}`
        : text.english_note;
    const machine = (text.translations || []).find((o) => o.kind === "machine");
    if (machine) {
      machine.english = lines.slice();
      machine.n = lines.filter(Boolean).length;
      machine.model_label = meta.label || machine.model_label;
      machine.note = note;
      machine._liveSource = meta.modelId || "b2c";
      if (meta.rerender !== false) applyTranslation(text, "machine");
    } else {
      text.english = lines.slice();
      text.english_note = note;
      text.english_kind = undefined;
      text.has_machine_draft = true;
      text._liveSource = meta.modelId || "b2c";
    }
    if (meta.rerender === false) {
      // Soft DOM update for progressive translate (avoid full reader remount).
      const rows = document.querySelectorAll("#english-body .line-en .en-text, .lg-en.lg-machine .en-text");
      rows.forEach((el, i) => {
        if (i >= lines.length) return;
        const tag = el.querySelector(".mt-line-tag");
        const tagHtml = tag ? tag.outerHTML : "";
        el.innerHTML = tagHtml + (lines[i] ? escapeHtml(lines[i]) : `<span style="color:var(--text-faint)">…</span>`);
      });
      return;
    }
    renderReader();
  }

  function restoreCachedMachine() {
    const text = state.currentText;
    if (!text) return;
    snapshotCached(text);
    const bak = cachedBackup.get(text);
    if (!bak) return;
    bak.live = false;
    const machine = (text.translations || []).find((o) => o.kind === "machine");
    if (machine && bak.machineEnglish) {
      machine.english = bak.machineEnglish.slice();
      machine.n = bak.machineEnglish.filter(Boolean).length;
      machine.note = bak.machineNote;
      machine.label = bak.machineLabel;
      machine.model_label = bak.machineModelLabel;
      delete machine._liveSource;
      applyTranslation(text, text.tr_key || "machine");
    } else if (bak.english != null) {
      text.english = Array.isArray(bak.english) ? bak.english.slice() : bak.english;
      text.english_note = bak.english_note;
      text.english_labels = bak.english_labels;
      text.english_conf = bak.english_conf;
      delete text._liveSource;
    }
    renderReader();
  }

  window.UnreadReader = {
    getText: () => state.currentText,
    getEnglishProvenance: () => {
      const t = state.currentText;
      if (!t) return "";
      return t._englishProvenance || englishProvenanceText(t);
    },
    hasCachedMachine,
    getAtfLines,
    setLiveMachineLines,
    restoreCachedMachine,
    isLiveMachine: () => {
      const text = state.currentText;
      if (!text) return false;
      const bak = cachedBackup.get(text);
      return !!(bak && bak.live);
    },
  };
})();
