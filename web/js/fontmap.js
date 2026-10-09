/**
 * Cuneiform font choice for the reader. One table: fonts/fonts.json (also read by
 * scripts/font_map.py for the static pages). @font-face rules are injected only for fonts
 * that are actually used, so a page downloads just the face(s) it shows.
 */
const FontMap = (() => {
  let cfg = null;
  let base = "fonts/";
  let loading = null;
  const injected = new Set();
  const SESSION_KEY = "unread.cuneiformFont";

  async function load(url = "fonts/fonts.json") {
    if (cfg) return cfg;
    if (!loading) {
      base = url.replace(/[^/]*$/, "");
      loading = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`fonts.json ${r.status}`);
          return r.json();
        })
        .then((d) => (cfg = d))
        .catch((e) => {
          loading = null;
          throw e;
        });
    }
    return loading;
  }

  const test = (re, v) => !re || new RegExp(re, "i").test(v || "");

  /** Period/language/genre -> font id (first matching rule, else default). */
  function fontFor(item) {
    if (!cfg) return "NotoSansCuneiform";
    const r = cfg.rules.find((r) => test(r.language, item.language) && test(r.period, item.period) && test(r.genre, item.genre));
    return r ? r.font : cfg.default;
  }

  function ruleFor(item) {
    if (!cfg) return null;
    return cfg.rules.find((r) => test(r.language, item.language) && test(r.period, item.period) && test(r.genre, item.genre)) || null;
  }

  function info(id) {
    return (cfg && cfg.fonts[id]) || null;
  }

  function ensure(id) {
    if (!cfg) return;
    for (const fid of [id, cfg.fallback]) {
      const f = cfg.fonts[fid];
      if (!f || injected.has(fid)) continue;
      injected.add(fid);
      const st = document.createElement("style");
      st.dataset.font = fid;
      st.textContent = `@font-face{font-family:"${f.family}";src:url("${base}${f.file}") format("${f.format}");font-display:swap${
        f.unicode_range ? `;unicode-range:${f.unicode_range}` : ""
      }}`;
      document.head.appendChild(st);
    }
  }

  function stack(id) {
    const f = info(id) || info(cfg?.fallback);
    const fb = info(cfg?.fallback);
    if (!f) return "serif";
    return f === fb ? `"${f.family}", serif` : `"${f.family}", "${fb.family}", serif`;
  }

  /** Session-only override from the reader's picker ("" = automatic). */
  function override() {
    try {
      const v = sessionStorage.getItem(SESSION_KEY) || "";
      return v && info(v) ? v : "";
    } catch {
      return "";
    }
  }
  function setOverride(id) {
    try {
      if (id) sessionStorage.setItem(SESSION_KEY, id);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* private mode: keep it in memory only */
    }
  }

  return { load, fontFor, ruleFor, info, ensure, stack, override, setOverride, fonts: () => (cfg ? cfg.fonts : {}) };
})();

if (typeof window !== "undefined") window.FontMap = FontMap;
