/**
 * Unread Atlas — browse + reader app (site name lives in web/site.json)
 */

const DATA_BASE = "data";
const API_PARAM = new URLSearchParams(location.search).get("api");
/** Local translate API (same host as the page, port 42226). Override with ?api=http://host:port */
const TRANSLATE_API = API_PARAM || `${location.protocol}//${location.hostname}:42226`;
/**
 * Static mode (public GitHub Pages build): no local translate API is probed; "Translate" opens the
 * in-browser translator instead. On when the page carries <meta name="unread-static" content="1">
 * (added by scripts/build_site.sh) or is not served from a local/LAN host. ?api=… always re-enables the API.
 */
const IS_LOCAL_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)/.test(location.hostname) ||
  location.hostname.endsWith(".local");
const STATIC_MODE =
  !API_PARAM && (!!document.querySelector('meta[name="unread-static"][content="1"]') || !IS_LOCAL_HOST);
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
const TRANSLATE_CHUNK = 12; // lines per request (server max default 64)
const TRANSLATE_DEFAULT_LIMIT = 48; // first-pass default; "continue" fills the rest

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
  useOnlineCuneiform: false,
  translating: false,
  apiOk: null,
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
  $("#header-count").textContent = `${state.catalog.count} works · ${epicN} epic · ${herbN} remedies · ${omenN} omens · ${mathN} math`;
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
        ? mtEd.mt_lines
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
        ? `Machine draft · model ${m.label || "atf-en"} (${m.repo}${rev ? " @ " + rev : ""}) · translated ${m.translated_on || "?"}. Unreviewed machine output, not a scholarly translation.`
        : "Machine draft. Unreviewed machine output, not a scholarly translation.",
      meta: { kind: "machine_draft", model: m.label, model_repo: m.repo, translated_on: m.translated_on },
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

/**
 * Make one translation option the active English. `want` is a tab key ("machine", "oracc", "cdli",
 * "oracc-<edition>"…) or "human" (first human tab); anything unknown falls back to the policy default.
 */
function applyTranslation(text, want) {
  const opts = text.translations || [];
  if (!opts.length) {
    text.english_note = (text._notes_common || []).join(" · ") || null;
    return;
  }
  const o =
    opts.find((x) => x.key === want) ||
    (want === "human" ? opts.find((x) => x.kind === "human") : null) ||
    opts.find((x) => x.key === text.tr_default) ||
    opts[0];
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

/** Keep the tab choice in the URL (&tr=…) so shared links open the same tab; the default tab drops the param. */
function setTrParam(key, isDefault) {
  try {
    const u = new URL(location.href);
    if (!key || isDefault) u.searchParams.delete("tr");
    else u.searchParams.set("tr", key);
    history.replaceState(history.state, "", u);
  } catch (_) {
    /* ignore */
  }
}

function trTabsHtml(text) {
  const opts = text.translations || [];
  if (opts.length < 2) return "";
  return `<div class="tr-tabs" role="tablist" aria-label="Choose a translation">${opts
    .map(
      (o) =>
        `<button type="button" role="tab" class="tr-tab tr-${o.kind}${o.key === text.tr_active ? " on" : ""}" aria-selected="${o.key === text.tr_active}" data-tr="${escapeAttr(o.key)}" title="${escapeAttr(
          o.kind === "human" ? `Human translation via ${o.source_name}${o.license ? " · " + o.license : ""}` : "Machine draft from our model (unreviewed)"
        )}">${escapeHtml(o.label)}</button>`
    )
    .join("")}</div>`;
}

/** Credit + licence line for the active human tab (HTML; every value escaped). */
function trCreditHtml(text) {
  const o = (text.translations || []).find((x) => x.key === text.tr_active);
  if (!o || o.kind !== "human") return "";
  const link = (label, href) => (href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label));
  const bits = [
    o.translators.length ? `Translation: ${escapeHtml(o.translators.join("; "))}` : "Human translation",
    `via ${link(o.source_name + (o.edition ? ` (${o.edition})` : ""), o.record_url)}`,
    o.license ? `licence: ${link(o.license, o.license_url)}` : "",
    `${o.english.length} lines`,
  ].filter(Boolean);
  return `<p class="english-draft-note tr-credit">${bits.join(" · ")}</p>`;
}

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
  const onlyOpenGap = $("#filter-open-gap")?.checked;
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
    if (onlyOpenGap && item.translation_status !== "no_open_english") return false;
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
  const label = total && n < total ? `Machine draft ${n}/${total}` : `Machine draft (${n})`;
  const tm = text.translation_meta || {};
  const stamp = tm.model ? ` · ${tm.model}${tm.translated_on ? ` · ${tm.translated_on}` : ""}` : "";
  return `<span class="chip status-machine" title="Machine English${escapeAttr(stamp)} — not a scholarly translation">${label}</span>`;
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
async function openReader(id) {
  // While the text loads (the /api Lambda can take seconds on a cold start) the reader shows
  // "Loading tablet <id>…" instead of its "No work open" empty state; on failure, a retry.
  const token = (state._readerToken = (state._readerToken || 0) + 1);
  state.readerPending = { id, failed: false };
  setView("reader");
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
  renderReader();
}

function renderReader() {
  const text = state.currentText;
  const empty = $("#reader-empty");
  const shell = $("#reader-shell");
  const pending = $("#reader-pending");
  const p = state.readerPending;

  pending.style.display = p ? "flex" : "none";
  if (p) {
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
  const badgeHost = $("#reader-status-badges");
  if (badgeHost) {
    badgeHost.innerHTML = [
      statusChip(text),
      machineChip(text),
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

  $("#col-english").style.display = panels.english ? "flex" : "none";
  $("#col-atf").style.display = panels.atf ? "flex" : "none";
  $("#col-cuneiform").style.display = panels.cuneiform ? "flex" : "none";
  $("#col-meta").style.display = panels.meta ? "flex" : "none";

  renderEnglishCol(text);
  renderAtfCol(text);
  renderCuneiformCol(text);
  if (panels.meta) {
    renderMetaCol(text);
    maybeFetchCdliMeta(text);
  }
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
      ? `<span class="chip status-machine">Machine draft</span>`
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

function renderEnglishCol(text) {
  const body = $("#english-body");
  const contentLines = (text.lines || []).filter((l) => l.type === "line");
  updateTranslateButton();
  const colHead = $("#col-english .col-head span:last-child");
  if (colHead) colHead.textContent = "model / draft";

  if (text.english && Array.isArray(text.english) && text.english.length) {
    const statusBits = [];
    if (text.translation_label) statusBits.push(text.translation_label);
    if (text.english_kind === "human") {
      /* human translation: credit is in english_note */
    } else if (text.translation_status === "print_edition") {
      statusBits.push("Scholars translated this in print — this English is a machine draft, not the first human reading.");
    } else if (text.translation_status === "no_open_english") {
      statusBits.push("No open English found in our heuristics — possible first open digital reading (verify literature).");
    } else if (text.open_english) {
      statusBits.push("Open English may already exist elsewhere — use for comparison, not discovery claims.");
    }
    const noteBits = [text.english_kind === "human" && text.translations ? (text._notes_common || []).join(" · ") : text.english_note, ...statusBits].filter(Boolean);
    const note =
      trTabsHtml(text) +
      trCreditHtml(text) +
      (noteBits.length ? `<p class="english-draft-note">${escapeHtml(noteBits.join(" · "))}</p>` : "");
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
        ? STATIC_MODE
          ? `<p class="english-draft-note">${remaining} further ATF lines not yet translated.
               <a class="btn" style="margin-left:0.5rem" href="${escapeAttr(translatorUrl(text, text.english.length))}">Translate the rest in your browser</a>
             </p>`
          : `<p class="english-draft-note">${remaining} further ATF lines not yet translated.
             <button type="button" class="btn" id="btn-continue-translate" style="margin-left:0.5rem">Continue</button>
           </p>`
        : "";
    body.innerHTML = `${note}<div class="english-prose">${rows}</div>${more}`;
    $("#btn-continue-translate")?.addEventListener("click", () => startTranslate({ continue: true }));
    body.querySelectorAll(".tr-tab").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.tr === text.tr_active) return;
        applyTranslation(text, b.dataset.tr);
        setTrParam(text.tr_active, text.tr_active === text.tr_default);
        renderReader(); // badges + English column (ATF/cuneiform unchanged)
      })
    );
    if (colHead) colHead.textContent = text.english_kind === "human" ? "human translation" : "model / draft";
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
    if (STATIC_MODE) {
      body.innerHTML = `
      <div class="english-placeholder">
        <div class="badge">Awaiting first English</div>
        <p>No machine draft is published for this text yet.</p>
        <p style="margin-top:1rem;font-size:0.9rem;color:var(--text-faint)">
          ${lineCount} ATF content lines ready. You can draft English yourself with the in-browser
          translator (model atf-en-best-v2, ≈95 MB download on first use, runs on your device).
        </p>
        <p style="margin-top:1rem">
          ${lineCount ? `<a class="btn primary" href="${escapeAttr(translatorUrl(text, 0))}">Open in the in-browser translator</a>` : ""}
        </p>
      </div>`;
      bindLineHover(body);
      return;
    }
    body.innerHTML = `
      <div class="english-placeholder">
        <div class="badge">Awaiting first English</div>
        <p>${escapeHtml(text.english_note || "No model translation yet.")}</p>
        <p style="margin-top:1rem;font-size:0.9rem;color:var(--text-faint)">
          ${lineCount} ATF content lines ready.
          Uses the local translate API at <code>${escapeHtml(TRANSLATE_API)}</code>
          (model: atf-en-best-v2).
        </p>
        <p style="margin-top:1rem">
          <button type="button" class="btn primary" id="btn-translate-stub">Translate with local model</button>
        </p>
      </div>`;
    $("#btn-translate-stub")?.addEventListener("click", () => startTranslate());
  }
  bindLineHover(body);
}

// ─── Translate API ───
/** Link to translate.html prefilled with this text's ATF lines (starting at line index `from`). */
function translatorUrl(text, from = 0) {
  const q = new URLSearchParams({ id: text.id });
  if (from > 0) q.set("from", String(from));
  return `${TRANSLATOR_PAGE}?${q}`;
}

async function checkTranslateApi() {
  const el = $("#api-status");
  if (!el) return;
  if (STATIC_MODE) {
    el.textContent = "In-browser model";
    el.className = "api-status static";
    el.title = "Translate opens the in-browser translator (no server)";
    updateTranslateButton();
    return;
  }
  try {
    const res = await fetch(`${TRANSLATE_API}/api/health`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    state.apiOk = !!data.ok;
    el.textContent = data.model_loaded
      ? `API · ${data.device || "ready"}`
      : "API · idle";
    el.className = "api-status up";
    el.title = data.model_path || TRANSLATE_API;
  } catch {
    state.apiOk = false;
    el.textContent = "API · offline";
    el.className = "api-status down";
    el.title = `Cannot reach ${TRANSLATE_API} — run ./scripts/serve_api.sh`;
  }
  updateTranslateButton();
}

function updateTranslateButton() {
  const btn = $("#btn-translate");
  if (!btn) return;
  const text = state.currentText;
  const lines = (text?.lines || []).filter((l) => l.type === "line");
  const have = Array.isArray(text?.english) ? text.english.length : 0;
  const remaining = englishRemaining(text);

  if (state.translating) {
    btn.disabled = true;
    btn.textContent = "Translating…";
    return;
  }
  btn.disabled = !text || lines.length === 0 || remaining === 0;
  if (STATIC_MODE) {
    btn.title = "Open these ATF lines in the in-browser translator";
    btn.textContent = !text || lines.length === 0 ? "Translate" : remaining === 0 ? "Done" : "Translate in browser";
    return;
  }
  if (!text || lines.length === 0) {
    btn.textContent = "Translate";
  } else if (remaining === 0) {
    btn.textContent = "Done";
  } else if (have > 0) {
    btn.textContent = `Continue (${remaining})`;
  } else {
    btn.textContent = `Translate (${Math.min(TRANSLATE_DEFAULT_LIMIT, lines.length)})`;
  }
}

function setProgress(done, total, label) {
  const wrap = $("#translate-progress");
  const fill = $("#translate-progress-fill");
  const lab = $("#translate-progress-label");
  if (!wrap) return;
  if (total <= 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const pct = Math.round((done / total) * 100);
  fill.style.width = `${pct}%`;
  lab.textContent = label || `${done} / ${total}`;
}

async function startTranslate(opts = {}) {
  const text = state.currentText;
  if (!text || state.translating) return;
  if (STATIC_MODE) {
    location.href = translatorUrl(text, Array.isArray(text.english) ? text.english.length : 0);
    return;
  }

  const contentLines = (text.lines || []).filter((l) => l.type === "line");
  if (!contentLines.length) {
    toast("No ATF lines to translate");
    return;
  }

  // health check
  try {
    const h = await fetch(`${TRANSLATE_API}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error("health failed");
    state.apiOk = true;
    $("#api-status").className = "api-status busy";
    $("#api-status").textContent = "API · working";
  } catch {
    state.apiOk = false;
    toast(`Translate API offline at ${TRANSLATE_API}. Run ./scripts/serve_api.sh on the host.`);
    checkTranslateApi();
    return;
  }

  const existing = Array.isArray(text.english) ? [...text.english] : [];
  const startIdx = opts.continue || opts.full ? existing.length : existing.length;
  // first click: translate up to DEFAULT_LIMIT total; continue: rest (or +DEFAULT_LIMIT chunks)
  let endIdx;
  if (opts.full) {
    endIdx = contentLines.length;
  } else if (opts.continue || existing.length > 0) {
    endIdx = contentLines.length; // finish remaining
  } else {
    endIdx = Math.min(contentLines.length, TRANSLATE_DEFAULT_LIMIT);
  }

  if (startIdx >= endIdx) {
    toast("Already translated");
    updateTranslateButton();
    return;
  }

  state.translating = true;
  updateTranslateButton();
  const total = endIdx - startIdx;
  let done = 0;
  setProgress(0, total, `Starting… 0 / ${total}`);

  const english = existing.slice(0, startIdx);
  // pad if somehow shorter
  while (english.length < startIdx) english.push("");

  try {
    for (let i = startIdx; i < endIdx; i += TRANSLATE_CHUNK) {
      const chunk = contentLines.slice(i, Math.min(i + TRANSLATE_CHUNK, endIdx));
      const lines = chunk.map((l) => l.atf);
      const res = await fetch(`${TRANSLATE_API}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const tr = data.translations || [];
      for (let j = 0; j < tr.length; j++) {
        english.push(tr[j]);
        if (contentLines[i + j]) contentLines[i + j].english = tr[j];
      }
      done += tr.length;
      text.english = [...english];
      text.status = english.length >= contentLines.length ? "english" : "partial_english";
      const modelName = String(data.model || "T5").split("/").filter(Boolean).pop(); // never store local paths
      const today = new Date().toISOString().slice(0, 10);
      text.english_note = `Machine draft · model ${modelName} · translated ${today} (local API). Not a scholarly translation; verify against a published edition.`;
      text.translation_meta = {
        kind: "machine_draft",
        model: modelName,
        translated_on: today,
        prompt: data.prompt,
        lines_translated: english.length,
        lines_total: contentLines.length,
        source: "local_api",
      };
      setProgress(done, total, `Translated ${english.length} / ${contentLines.length} lines`);
      // live update English column without wiping ATF scroll too hard
      renderEnglishCol(text);
    }

    // persist if packaged
    try {
      const save = await fetch(`${TRANSLATE_API}/api/translate/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: text.id,
          english: text.english,
          english_note: text.english_note,
          status: text.status,
          meta: text.translation_meta,
        }),
      });
      const saveData = await save.json();
      if (save.ok && saveData.ok) {
        toast(`Saved ${saveData.count} lines → data/texts/${text.id}.json`);
      } else if (save.status === 404) {
        toast(`Translated ${english.length} lines (not packaged — not saved to disk)`);
      } else {
        toast(`Translated ${english.length} lines (save: ${saveData.error || "failed"})`);
      }
    } catch {
      toast(`Translated ${english.length} lines (could not save)`);
    }
  } catch (e) {
    console.error(e);
    toast(`Translate failed: ${e.message || e}`);
  } finally {
    state.translating = false;
    setProgress(0, 0);
    updateTranslateButton();
    checkTranslateApi();
    renderEnglishCol(text);
  }
}

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
      if (surf && surf !== `${lastSurface} · ${lastCol}`.replace(/^ · | · $/g, "")) {
        if (line.surface !== lastSurface || line.column !== lastCol) {
          html += `<div class="surface-break">${escapeHtml(surf)}</div>`;
          lastSurface = line.surface;
          lastCol = line.column;
        }
      }
      html += `<div class="line-row" data-i="${i}" data-atf="${escapeAttr(line.atf)}">
        <span class="ln">${escapeHtml(line.n)}</span>
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
      if (state.useOnlineCuneiform) {
        try {
          result = await Atf2Unicode.convertLineOnline(line.atf);
        } catch {
          result = Atf2Unicode.convertLine(line.atf);
        }
      } else {
        result = Atf2Unicode.convertLine(line.atf);
      }
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
}

function bindLineHover(container) {
  container.querySelectorAll(".line-row[data-i], .line-en[data-i]").forEach((el) => {
    el.addEventListener("mouseenter", () => highlightLine(el.dataset.i));
    el.addEventListener("mouseleave", () => highlightLine(null));
  });
}

function highlightLine(i) {
  $$(".line-row.hl, .line-en.hl").forEach((el) => el.classList.remove("hl"));
  if (i == null) return;
  $$(`[data-i="${i}"]`).forEach((el) => el.classList.add("hl"));
}

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
  const RELIEF_URL = "tiles/relief/{z}/{x}/{y}.webp";
  L.tileLayer(RELIEF_URL, {
    minZoom: 0,
    maxZoom: 10,
    minNativeZoom: 0,
    maxNativeZoom: 7,
    bounds: [[-85.0511, -180], [85.0511, 180]],
    noWrap: true,
  }).addTo(state.map);
  L.tileLayer(RELIEF_URL, {
    minZoom: 7,
    maxZoom: 10,
    minNativeZoom: 7,
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
function setView(name) {
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

  $$(".view-toggles button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.panel;
      // keep at least one panel
      const next = !state.readerPanels[key];
      const count = Object.values({ ...state.readerPanels, [key]: next }).filter(Boolean).length;
      if (count === 0) return;
      state.readerPanels[key] = next;
      btn.classList.toggle("on", next);
      renderReader();
    });
  });

  $("#btn-back-explore")?.addEventListener("click", () => setView("explore"));

  $("#btn-translate")?.addEventListener("click", () => {
    const text = state.currentText;
    const have = Array.isArray(text?.english) ? text.english.length : 0;
    startTranslate({ continue: have > 0 });
  });

  $("#toggle-online-cunei")?.addEventListener("change", (e) => {
    state.useOnlineCuneiform = e.target.checked;
    state.cuneiformCache.clear();
    if (state.currentText) renderCuneiformCol(state.currentText);
    toast(e.target.checked ? "Using live eBL sign API when possible" : "Offline reading map only");
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ─── Boot ───
async function main() {
  bindEvents();
  initTimeline();
  initMap();
  checkTranslateApi();
  if (!STATIC_MODE) setInterval(checkTranslateApi, 30000);

  // Deep link ?id=…: show the reader's loading state right away, not the map then "No work open"
  const deepId = new URLSearchParams(location.search).get("id");
  if (deepId) {
    state.readerPending = { id: deepId, failed: false };
    setView("reader");
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
      await openReader(deepId);
    } else {
      const first =
        state.filtered.find((i) => state._packagedIds.includes(i.id)) || state.filtered[0];
      if (first) await selectWork(first.id);
    }
  } catch (e) {
    console.error(e);
    toast(e.message || "Failed to load catalog");
    $("#catalog-list").innerHTML = `<p style="padding:1rem;color:var(--danger)">${escapeHtml(e.message)}</p>`;
    if (deepId) openReader(deepId); // the text API doesn't need the catalog
  }
}

document.addEventListener("DOMContentLoaded", main);

// ─── Collapsible left bar (state: html.sidebar-collapsed, set early in map.html's head) ───
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("filters-toggle");
  if (!btn) return;
  const root = document.documentElement;
  const sync = () => {
    const open = !root.classList.contains("sidebar-collapsed");
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("on", open);
  };
  const setOpen = (open, remember = true) => {
    root.classList.toggle("sidebar-collapsed", !open);
    if (remember) try { localStorage.setItem("ua.sidebar", open ? "open" : "closed"); } catch (_) {}
    sync();
    // Leaflet caches the container size; the map widens/narrows with the bar
    if (state.map) requestAnimationFrame(() => state.map.invalidateSize({ pan: false }));
  };
  btn.addEventListener("click", () => setOpen(root.classList.contains("sidebar-collapsed")));
  // a mode chip/featured deep link opened later should reveal its featured row
  document.querySelectorAll("#filter-epic-hunt,#filter-herbal,#filter-omens,#filter-math").forEach((el) =>
    el.addEventListener("change", () => el.checked && setOpen(true, false)));
  sync();
});
