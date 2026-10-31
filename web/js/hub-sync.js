/* Shared Search hub state (Map | List | Explore). Syncs q + sidebar filters to URL,
 * across view inputs, and to/from the Explore iframe via postMessage.
 * Debounced; only the visible view runs a search; others refresh lazily on tab switch.
 */
(() => {
  "use strict";

  const THEME_KEYS = ["epic", "herbal", "omens", "math"];
  const FLAG_KEYS = ["hideKnown", "openGap", "noEnglish", "notOnline", "packaged"];

  const DEFAULTS = {
    q: "",
    in: "all",
    genre: "",
    period: "",
    language: "",
    site: "",
    minLines: 40,
    hideKnown: true,
    openGap: false,
    noEnglish: false,
    notOnline: false,
    packaged: false,
    epic: false,
    herbal: false,
    omens: false,
    math: false,
  };

  let state = { ...DEFAULTS };
  let seq = 0;
  let applying = false; // suppress feedback loops
  let urlTimer = null;
  const dirty = { map: false, list: false, explore: false };
  const lastApplied = { map: 0, list: 0, explore: 0 };

  const $ = (s, el = document) => el.querySelector(s);
  const clone = (s) => JSON.parse(JSON.stringify(s));

  function readFromDom() {
    const next = { ...state };
    const smap = $("#smap-q");
    const list = $("#ua-list-q");
    // Prefer the focused/visible input's q when reading
    const active = document.activeElement;
    if (active && (active.id === "smap-q" || active.id === "ua-list-q")) {
      next.q = active.value.trim();
    } else if (smap && document.getElementById("view-map")?.classList.contains("active")) {
      next.q = smap.value.trim();
    } else if (list && document.getElementById("view-list")?.classList.contains("active")) {
      next.q = list.value.trim();
    } else if (smap) next.q = smap.value.trim();
    else if (list) next.q = list.value.trim();

    const scope = document.querySelector('#ua-list-form input[name="ua-in"]:checked');
    if (scope) next.in = scope.value || "all";

    next.genre = $("#filter-genre")?.value || "";
    next.period = $("#filter-period")?.value || "";
    next.language = $("#filter-language")?.value || "";
    next.site = $("#filter-site")?.value || "";
    next.minLines = Number($("#filter-min-lines")?.value) || 0;
    next.hideKnown = !!$("#filter-hide-known")?.checked;
    next.openGap = !!$("#filter-open-gap")?.checked;
    next.noEnglish = !!$("#filter-no-english")?.checked;
    next.notOnline = !!$("#filter-not-online")?.checked;
    next.packaged = !!$("#filter-packaged")?.checked;
    next.epic = !!$("#filter-epic-hunt")?.checked;
    next.herbal = !!$("#filter-herbal")?.checked;
    next.omens = !!$("#filter-omens")?.checked;
    next.math = !!$("#filter-math")?.checked;
    return next;
  }

  function writeToDom(s) {
    applying = true;
    try {
      for (const id of ["smap-q", "ua-list-q"]) {
        const el = document.getElementById(id);
        if (el && el.value !== s.q) el.value = s.q;
      }
      const setSel = (id, v) => {
        const el = document.getElementById(id);
        if (el && el.value !== v) el.value = v;
      };
      setSel("filter-genre", s.genre);
      setSel("filter-period", s.period);
      setSel("filter-language", s.language);
      setSel("filter-site", s.site);
      const ml = $("#filter-min-lines");
      if (ml && String(ml.value) !== String(s.minLines)) {
        ml.value = s.minLines;
        const lab = $("#min-lines-val");
        if (lab) lab.textContent = String(s.minLines);
      }
      const setChk = (id, v) => {
        const el = document.getElementById(id);
        if (el && el.checked !== !!v) el.checked = !!v;
      };
      setChk("filter-hide-known", s.hideKnown);
      setChk("filter-open-gap", s.openGap);
      setChk("filter-no-english", s.noEnglish);
      setChk("filter-not-online", s.notOnline);
      setChk("filter-packaged", s.packaged);
      setChk("filter-epic-hunt", s.epic);
      setChk("filter-herbal", s.herbal);
      setChk("filter-omens", s.omens);
      setChk("filter-math", s.math);
      // list scope radios
      const radio = document.querySelector(`#ua-list-form input[name="ua-in"][value="${CSS.escape(s.in || "all")}"]`);
      if (radio) radio.checked = true;
    } finally {
      applying = false;
    }
  }

  function readFromUrl(search = location.search) {
    const p = new URLSearchParams(search);
    const next = { ...DEFAULTS };
    if (p.has("q")) next.q = p.get("q") || "";
    if (p.get("in")) next.in = p.get("in");
    if (p.get("genre")) next.genre = p.get("genre");
    if (p.get("period")) next.period = p.get("period");
    if (p.get("site")) next.site = p.get("site");
    if (p.get("lang")) next.language = p.get("lang");
    if (p.get("language")) next.language = p.get("language");
    if (p.has("min")) next.minLines = Number(p.get("min")) || 0;
    // flags: f=hk|nohk,ug,ne,no,pkg,epic,herbal,omens,math (default hideKnown=true when f omitted)
    if (p.has("f")) {
      const f = new Set((p.get("f") || "").split(",").filter(Boolean));
      next.hideKnown = f.has("hk") || !f.has("nohk");
      if (f.has("nohk")) next.hideKnown = false;
      if (f.has("hk")) next.hideKnown = true;
      next.openGap = f.has("ug");
      next.noEnglish = f.has("ne");
      next.notOnline = f.has("no");
      next.packaged = f.has("pkg");
      next.epic = f.has("epic");
      next.herbal = f.has("herbal");
      next.omens = f.has("omens");
      next.math = f.has("math");
    }
    // legacy individual
    if (p.get("theme") === "epic") next.epic = true;
    if (p.get("theme") === "herbal") next.herbal = true;
    if (p.get("theme") === "omens") next.omens = true;
    if (p.get("theme") === "math") next.math = true;
    return next;
  }

  function writeUrl(s, mode = "replace") {
    const u = new URL(location.href);
    const p = u.searchParams;
    // Preserve view/id/tr/find/mode and browse-only camera if any
    if (s.q) p.set("q", s.q); else p.delete("q");
    if (s.in && s.in !== "all") p.set("in", s.in); else p.delete("in");
    if (s.genre) p.set("genre", s.genre); else p.delete("genre");
    if (s.period) p.set("period", s.period); else p.delete("period");
    if (s.site) p.set("site", s.site); else p.delete("site");
    if (s.language) p.set("lang", s.language); else { p.delete("lang"); p.delete("language"); }
    if (s.minLines !== 40) p.set("min", String(s.minLines)); else p.delete("min");
    const flags = [];
    if (s.hideKnown) flags.push("hk"); else flags.push("nohk");
    if (s.openGap) flags.push("ug");
    if (s.noEnglish) flags.push("ne");
    if (s.notOnline) flags.push("no");
    if (s.packaged) flags.push("pkg");
    if (s.epic) flags.push("epic");
    if (s.herbal) flags.push("herbal");
    if (s.omens) flags.push("omens");
    if (s.math) flags.push("math");
    // Only write f= when non-default (default = hk only)
    const def = flags.length === 1 && flags[0] === "hk";
    if (def) p.delete("f"); else p.set("f", flags.join(","));
    p.delete("src"); // leave src to searchmap if set separately — don't clear here if present? clear unused
    const next = u.toString().replace(/%2C/gi, ",");
    if (next === location.href) return;
    try {
      if (mode === "push") history.pushState({ hub: true }, "", next);
      else history.replaceState({ hub: true }, "", next);
    } catch (_) {}
  }

  function equal(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function visibleView() {
    if (typeof state !== "undefined" && window.state?.view && ["map", "list", "explore"].includes(window.state.view)) {
      return window.state.view;
    }
    if ($("#view-list")?.classList.contains("active")) return "list";
    if ($("#view-explore")?.classList.contains("active")) return "explore";
    return "map";
  }

  function markAllDirty() {
    dirty.map = dirty.list = dirty.explore = true;
  }

  function postToExplore(s) {
    const frame = document.getElementById("explore-frame");
    if (!frame?.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ type: "ua-hub-state", state: clone(s), seq }, "*");
    } catch (_) {}
  }

  function applyMap(s) {
    // Catalog sidebar filters
    if (typeof window.applyFilters === "function") {
      try { window.applyFilters(); } catch (_) {}
    }
    // Corpus search layer
    const USM = window.UnreadSearchMap;
    if (!USM) { lastApplied.map = seq; dirty.map = false; return; }
    const payload = {
      q: s.q || "",
      in: s.in || "all",
      period: s.period || "",
      genre: s.genre || "",
      site: s.site || "",
      src: "",
    };
    const has = !!(payload.q || payload.period || payload.genre || payload.site || payload.src);
    if (has) USM.run(payload, { pushUrl: false });
    else USM.clear({ pushUrl: false });
    lastApplied.map = seq;
    dirty.map = false;
  }

  function applyList(s) {
    const form = $("#ua-list-form");
    const input = $("#ua-list-q");
    if (input) input.value = s.q || "";
    const status = $("#ua-list-status");
    const results = $("#ua-list-results");
    if (!form) { dirty.list = false; return; }
    // Trigger the wired submit handler without doubling URL writes from wireListPanel —
    // call search directly if available
    if (typeof window.UnreadHubListSearch === "function") {
      window.UnreadHubListSearch(s);
    } else {
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
    lastApplied.list = seq;
    dirty.list = false;
  }

  function applyExplore(s) {
    postToExplore(s);
    lastApplied.explore = seq;
    dirty.explore = false;
  }

  function applyVisible(s) {
    const v = visibleView();
    if (v === "map") applyMap(s);
    else if (v === "list") applyList(s);
    else if (v === "explore") applyExplore(s);
    // Always keep explore iframe input in sync even if not visible (cheap postMessage)
    if (v !== "explore") postToExplore(s);
  }

  function set(partial, opts = {}) {
    if (applying && !opts.force) return;
    const next = { ...state, ...partial };
    // normalize
    next.q = (next.q || "").trim();
    if (equal(next, state) && !opts.force) return;
    state = next;
    seq += 1;
    markAllDirty();
    writeToDom(state);
    if (opts.url !== false) {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(() => writeUrl(state, opts.hist || "replace"), opts.debounceUrl ?? 0);
    }
    const delay = opts.debounce ?? 0;
    if (delay) {
      clearTimeout(set._t);
      set._t = setTimeout(() => applyVisible(state), delay);
    } else {
      applyVisible(state);
    }
  }

  function fromQueryTyping(raw) {
    if (applying) return;
    const q = (raw || "").trim();
    // Live-sync inputs + URL; debounce search so only the visible view hits APIs.
    set({ q }, { debounce: 280, debounceUrl: 400, hist: "replace" });
  }

  function fromMapSearch(raw) {
    const q = (raw || "").trim();
    // Tablet ID: let map open reader
    const ID_RE = /^(?:P\d+|Q\d+|X\d+|BM\.?\s*\d+|K\.?\s*\d+|MLC\.?\s*\d+|VAT\s*\d+|AO\s*\d+|Sm\.?\s*\d+)$/i;
    if (ID_RE.test(q) && typeof window.UnreadOpenId === "function" && window.UnreadOpenId(q)) {
      set({ q }, { url: true });
      return;
    }
    set({ q }, { hist: "replace" });
  }

  function fromListSearch(raw, scope) {
    set({ q: (raw || "").trim(), in: scope || state.in || "all" }, { hist: "replace" });
  }

  function fromFilters() {
    if (applying) return;
    set(readFromDom(), { debounce: 120, hist: "replace" });
  }

  function onViewChange(view) {
    if (!["map", "list", "explore"].includes(view)) return;
    // Sync inputs always
    writeToDom(state);
    if (dirty[view] || lastApplied[view] !== seq) {
      if (view === "map") applyMap(state);
      else if (view === "list") applyList(state);
      else applyExplore(state);
    } else if (view === "explore") {
      postToExplore(state); // ensure iframe has latest even if seq matched
    }
  }

  function bootFromUrl() {
    const s = readFromUrl();
    state = s;
    seq += 1;
    markAllDirty();
    writeToDom(s);
    // Don't apply yet — views may not be ready; main/setView will call onViewChange
  }

  // postMessage from Explore
  window.addEventListener("message", (e) => {
    const d = e?.data;
    if (!d || d.type !== "ua-hub-state" || !d.state) return;
    // Ignore our own echoes (iframe may bounce) by checking source
    const frame = document.getElementById("explore-frame");
    if (frame && e.source && e.source !== frame.contentWindow) return;
    if (frame && e.source === window) return;
    if (applying) return;
    const partial = {};
    const st = d.state;
    const keys = ["q", "in", "genre", "period", "language", "site", "minLines",
      "hideKnown", "openGap", "noEnglish", "notOnline", "packaged",
      "epic", "herbal", "omens", "math"];
    for (const k of keys) if (k in st) partial[k] = st[k];
    if (!Object.keys(partial).length) return;
    set(partial, { hist: "replace", debounce: 80 });
  });

  window.addEventListener("popstate", () => {
    const s = readFromUrl();
    if (equal(s, state)) return;
    state = s;
    seq += 1;
    markAllDirty();
    writeToDom(s);
    applyVisible(s);
  });

  window.UnreadHub = {
    get: () => clone(state),
    set,
    fromMapSearch,
    fromListSearch,
    fromQueryTyping,
    fromFilters,
    onViewChange,
    bootFromUrl,
    writeToDom,
    readFromUrl,
    postToExplore,
    DEFAULTS,
    /** Filters that do not map cleanly onto Explore (browse iframe). */
    EXPLORE_UNMAPPED: [
      "language (browse has no language dim)",
      "min ATF lines (no line counts in browse binary)",
      "packaged samples toggle (map/catalog only)",
      "curated themes: epic / herbal / omens / math (catalog flags)",
      "Hide open English / Unread / Not online (only coarse translation-state approx on Explore)",
      "Map layer toggles (corpus circles / curated pins)",
    ],
    /** Filters UnreadSearchMap API accepts beyond q. */
    MAP_API_FILTERS: ["genre", "period", "site", "in", "src"],
  };

  // Early boot if DOM ready; else wait
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootFromUrl);
  } else {
    bootFromUrl();
  }
})();
