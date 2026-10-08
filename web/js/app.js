/**
 * Unread Atlas — browse + reader app (site name lives in web/site.json)
 */

const DATA_BASE = "data";
/** Local translate API (same host as the page, port 42226). Override with ?api=http://host:port */
const TRANSLATE_API =
  new URLSearchParams(location.search).get("api") ||
  `${location.protocol}//${location.hostname}:42226`;
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
  // Prefer packaged sample; fall back to thin catalog stub
  try {
    const res = await fetch(`${DATA_BASE}/texts/${id}.json`);
    if (res.ok) return await res.json();
  } catch (_) {
    /* ignore */
  }
  const item = state.catalog.items.find((x) => x.id === id);
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
  const eng = text.english;
  const n = Array.isArray(eng) ? eng.length : eng ? 1 : 0;
  if (!n) return "";
  const total = (text.lines || []).filter((l) => l.type === "line").length;
  const label = total && n < total ? `Machine draft ${n}/${total}` : `Machine draft (${n})`;
  return `<span class="chip status-machine" title="Local model English — not a scholarly edition">${label}</span>`;
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
      <div class="fact"><dt>Font</dt><dd>${escapeHtml(item.font || "—")}</dd></div>
      <div class="fact"><dt>Open English?</dt><dd>${statusSrc.open_english ? "Yes (known digital)" : "No open English found"}</dd></div>
    </dl>
    ${snip ? `<pre class="preview-atf-snip">${escapeHtml(snip)}</pre>` : ""}
  `;
  $("#btn-open-reader")?.addEventListener("click", () => openReader(item.id));
}

// ─── Reader ───
async function openReader(id) {
  setView("reader");
  const text = await loadText(id);
  if (!text) {
    toast("Could not load work");
    return;
  }
  state.currentText = text;
  state.selectedId = id;
  state.font = text.font || "Assurbanipal";
  $("#font-select").value = state.font;
  renderReader();
}

function renderReader() {
  const text = state.currentText;
  const empty = $("#reader-empty");
  const shell = $("#reader-shell");

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
        ${metaRow("Coordinates", text.lat != null && text.lon != null ? `${text.lat}, ${text.lon}` : null)}
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
        ${metaRow("Font face", text.font)}
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

  if (text.english && Array.isArray(text.english) && text.english.length) {
    const statusBits = [];
    if (text.translation_label) statusBits.push(text.translation_label);
    if (text.translation_status === "print_edition") {
      statusBits.push("Scholars translated this in print — this English is a machine draft, not the first human reading.");
    } else if (text.translation_status === "no_open_english") {
      statusBits.push("No open English found in our heuristics — possible first open digital reading (verify literature).");
    } else if (text.open_english) {
      statusBits.push("Open English may already exist elsewhere — use for comparison, not discovery claims.");
    }
    const note = [text.english_note, ...statusBits].filter(Boolean).length
      ? `<p class="english-draft-note">${escapeHtml([text.english_note, ...statusBits].filter(Boolean).join(" · "))}</p>`
      : "";
    const rows = text.english
      .map((line, i) => {
        const n = contentLines[i]?.n ?? String(i + 1);
        return `<div class="line-en" data-i="${i}">
          <span class="en-ln">${escapeHtml(n)}</span>
          <span class="en-text">${escapeHtml(line)}</span>
        </div>`;
      })
      .join("");
    const remaining = contentLines.length - text.english.length;
    const more =
      remaining > 0
        ? `<p class="english-draft-note">${remaining} further ATF lines not yet translated.
             <button type="button" class="btn" id="btn-continue-translate" style="margin-left:0.5rem">Continue</button>
           </p>`
        : "";
    body.innerHTML = `${note}<div class="english-prose">${rows}</div>${more}`;
    $("#btn-continue-translate")?.addEventListener("click", () => startTranslate({ continue: true }));
  } else if (typeof text.english === "string" && text.english.trim()) {
    body.innerHTML = `<div class="english-prose"><p class="en-text">${escapeHtml(text.english)}</p></div>`;
  } else {
    const lineCount = contentLines.length;
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
async function checkTranslateApi() {
  const el = $("#api-status");
  if (!el) return;
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
  const remaining = Math.max(0, lines.length - have);

  if (state.translating) {
    btn.disabled = true;
    btn.textContent = "Translating…";
    return;
  }
  btn.disabled = !text || lines.length === 0 || remaining === 0;
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
      text.english_note = `Model draft via local API (${data.model || "T5"} · ${data.device || "?"}). Not a scholarly edition.`;
      text.translation_meta = {
        model: data.model,
        device: data.device,
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

async function renderCuneiformCol(text) {
  const body = $("#cuneiform-body");
  const lines = (text.lines || []).filter((l) => l.type === "line");
  const fontClass = `font-${state.font}`;

  if (!lines.length) {
    body.innerHTML = `<p style="color:var(--text-faint)">No lines to render.</p>`;
    return;
  }

  body.innerHTML = `<div class="cuneiform-lines ${fontClass}" id="cunei-root"><div style="color:var(--text-faint);font-family:var(--font-ui);font-size:0.85rem">Converting ATF → Unicode…</div></div>`;

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
  root.className = `cuneiform-lines ${fontClass}`;
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
    attributionControl: true,
    minZoom: 2,
    maxZoom: 10,
    maxBounds: [[-85.06, -200], [85.06, 200]],
    maxBoundsViscosity: 0.8,
  }).setView([33.5, 44.0], 5);

  // Self-hosted, label-free shaded relief (NOAA ETOPO 2022 + Natural Earth, both public domain).
  // Built by scripts/basemap/render_relief.py; see web/tiles/relief/ATTRIBUTION.md.
  // z0-6 cover the whole world (ETOPO 60"); z7-8 add Near East detail (ETOPO 15"); above that tiles are upscaled.
  const RELIEF_URL = "tiles/relief/{z}/{x}/{y}.webp";
  const RELIEF_ATTR =
    'Relief: <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model">NOAA ETOPO 2022</a>' +
    ' &middot; <a href="https://www.naturalearthdata.com/">Natural Earth</a>';
  L.tileLayer(RELIEF_URL, {
    attribution: RELIEF_ATTR,
    minZoom: 0,
    maxZoom: 10,
    minNativeZoom: 0,
    maxNativeZoom: 6,
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

  // Fallback: CARTO dark basemap (now requires a free API key: https://carto.com/basemaps/apikey)
  // L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=YOUR_KEY", {
  //   attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  //   subdomains: "abcd",
  //   maxZoom: 18,
  // }).addTo(state.map);

  // Fit Mesopotamia + Anatolia
  state.map.fitBounds([
    [28, 34],
    [42, 52],
  ]);
}

function updateMapMarkers() {
  if (!state.map) return;
  // Clear old
  Object.values(state.markers).forEach((m) => state.map.removeLayer(m));
  state.markers = {};

  // Aggregate filtered items by site
  const bySite = new Map();
  for (const item of state.filtered) {
    if (item.lat == null || item.lon == null) continue;
    const key = item.site || `${item.lat},${item.lon}`;
    if (!bySite.has(key)) bySite.set(key, { lat: item.lat, lon: item.lon, site: item.site, items: [] });
    bySite.get(key).items.push(item);
  }

  for (const [key, group] of bySite) {
    const icon = L.divIcon({
      className: "site-marker",
      iconSize: [12, 12],
    });
    const marker = L.marker([group.lat, group.lon], { icon }).addTo(state.map);
    const top = group.items.slice(0, 5);
    marker.bindPopup(
      `<strong>${escapeHtml(group.site || "Site")}</strong>
       ${group.items.length} work(s) in filter<br/>
       ${top.map((t) => `<a href="#" data-open="${t.id}">${escapeHtml(t.id)}</a>`).join(" · ")}`
    );
    marker.on("click", () => {
      // select first item at site
      if (group.items[0]) selectWork(group.items[0].id);
    });
    state.markers[key] = marker;
  }

  $("#map-empty").style.display = bySite.size ? "none" : "flex";
}

function highlightMapSite(item) {
  Object.entries(state.markers).forEach(([key, marker]) => {
    const el = marker.getElement();
    if (!el) return;
    const match =
      item.site && key === item.site
        ? true
        : item.lat != null && Math.abs(marker.getLatLng().lat - item.lat) < 0.01;
    el.classList.toggle("active", !!match);
  });
  if (item.lat != null && item.lon != null) {
    state.map?.panTo([item.lat, item.lon], { animate: true });
  }
}

// ─── Timeline ───
const YEAR_MIN = -3400;
const YEAR_MAX = -300;

function initTimeline() {
  const input = $("#timeline-range");
  input.min = YEAR_MIN;
  input.max = YEAR_MAX;
  input.value = state.timelineYear;
  updateTimelineUI();
  input.addEventListener("input", () => {
    state.timelineYear = Number(input.value);
    updateTimelineUI();
    applyFilters();
  });
}

function updateTimelineUI() {
  const y = state.timelineYear;
  const pct = ((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;
  $("#timeline-fill").style.width = `${pct}%`;
  $("#timeline-year").textContent = formatYear(y);
}

function updateTimelineDots() {
  const host = $("#timeline-dots");
  // sample up to 80 filtered items with years
  const withYear = state.filtered.filter((i) => i.year != null).slice(0, 80);
  host.innerHTML = withYear
    .map((item) => {
      const pct = ((item.year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;
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
    state.font = e.target.value;
    if (state.currentText) {
      state.currentText.font = state.font;
      renderCuneiformCol(state.currentText);
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
  setInterval(checkTranslateApi, 30000);

  try {
    const man = await fetch(`${DATA_BASE}/texts/manifest.json`).then((r) => (r.ok ? r.json() : []));
    state._packagedIds = man.map((m) => m.id);
  } catch {
    state._packagedIds = [];
  }

  try {
    await loadCatalog();
    toast(`Loaded ${state.catalog.count} catalog works`);
    // Deep link ?id=P285108
    const params = new URLSearchParams(location.search);
    const deepId = params.get("id");
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
  }
}

document.addEventListener("DOMContentLoaded", main);
