/**
 * Offline ATF transliteration → Unicode cuneiform.
 * Uses eBL-style reading maps (vendored from eBL signs + multi-glyph table).
 * Live eBL API is an optional enhancement when online.
 */

const Atf2Unicode = (() => {
  let map = null; // { readings: {}, multi: {} }
  let loadPromise = null;

  async function load(url = "data/atf_unicode_readings.json") {
    if (map) return map;
    if (loadPromise) return loadPromise;
    loadPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load reading map: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        map = data;
        return map;
      })
      .catch((err) => {
        loadPromise = null;
        throw err;
      });
    return loadPromise;
  }

  function cpsToString(cps) {
    if (!cps || !cps.length) return "";
    return cps.map((cp) => String.fromCodePoint(cp)).join("");
  }

  /** Normalize a single ATF token for lookup */
  function normalizeToken(tok) {
    let t = tok.trim();
    if (!t) return "";
    // strip damage / uncertainty markers commonly attached
    t = t.replace(/[#?!*]+$/g, "");
    t = t.replace(/^[#?!*]+/g, "");
    // determinatives {d}an → keep inner for now as separate; strip braces loosely
    t = t.replace(/[{}]/g, "");
    // half-brackets
    t = t.replace(/[⸢⸣⌜⌝]/g, "");
    // logogram underscores _lugal_ → lugal
    t = t.replace(/^_+|_+$/g, "");
    // x broken sign
    if (/^x+$/i.test(t) || t === "X") return null; // unknown
    // numbers like 1(disz) — leave as-is for multi/reading lookup
    return t.toLowerCase();
  }

  /**
   * Convert one ATF line (transliteration portion) to cuneiform.
   * Returns { text, coverage } where coverage is fraction of tokens mapped.
   */
  function convertLine(atfLine) {
    if (!map) return { text: "", coverage: 0, tokens: [] };
    if (!atfLine || !atfLine.trim()) return { text: "", coverage: 1, tokens: [] };

    // Split on whitespace and hyphens (syllable separators) but keep structure
    // Also handle · or · mid-dot
    const rawParts = atfLine.split(/(\s+|-|\.|:)/);
    let mapped = 0;
    let total = 0;
    const out = [];
    const tokenInfo = [];

    for (const part of rawParts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        out.push(" ");
        continue;
      }
      if (part === "-" || part === "." || part === ":") {
        // syllable joiners → no space in cuneiform (juxtaposition)
        continue;
      }

      const key = normalizeToken(part);
      if (key === null) {
        // damaged / x
        out.push("×");
        tokenInfo.push({ atf: part, unicode: "×", ok: false });
        continue;
      }
      if (!key) continue;

      // skip pure punctuation / brackets leftovers
      if (/^[\[\]()<>|\\/,;='"+]+$/.test(key)) {
        continue;
      }

      total += 1;
      let cps = null;

      // multi-glyph compounds first (e3, am3, ki-e3-bi style whole tokens)
      if (map.multi && map.multi[key]) {
        cps = map.multi[key];
      } else if (map.readings && map.readings[key]) {
        cps = map.readings[key];
      } else {
        // try without trailing digits index: ba2 → ba, u4 already in map
        const stripped = key.replace(/[₀-₉]+$/g, "").replace(/\d+$/g, "");
        if (stripped !== key) {
          if (map.multi && map.multi[stripped]) cps = map.multi[stripped];
          else if (map.readings && map.readings[stripped]) cps = map.readings[stripped];
        }
        // subscript digits already lowercased as regular in our normalize? ATF often uses ₂ as 2
        // try sign names in uppercase form already lowercased
      }

      if (cps && cps.length) {
        mapped += 1;
        const s = cpsToString(cps);
        out.push(s);
        tokenInfo.push({ atf: part, unicode: s, ok: true });
      } else {
        // leave a middle-dot placeholder so layout stays readable
        out.push("·");
        tokenInfo.push({ atf: part, unicode: "·", ok: false });
      }
    }

    // collapse multiple spaces
    const text = out.join("").replace(/ +/g, " ").trim();
    return {
      text,
      coverage: total ? mapped / total : 1,
      tokens: tokenInfo,
    };
  }

  return {
    load,
    convertLine,
    ready: () => !!map,
  };
})();

// export for modules / non-module
if (typeof window !== "undefined") {
  window.Atf2Unicode = Atf2Unicode;
}
