/**
 * Fill deferred machine-English cells on /t/ pages from /api/text/<id>.
 * Real browsers load the full translation automatically; a retry control remains
 * on failure. No teaser/API copy in the UI.
 */
(function () {
  "use strict";

  var CONF_TITLES = {
    1: "lower confidence: line is broken",
    2: "low confidence: few signs survive",
    3: "very low confidence: a guess",
  };

  function apiBase() {
    var q = new URLSearchParams(location.search).get("textapi");
    if (q) return q.replace(/\/+$/, "");
    if (location.protocol === "file:") return "https://unreadatlas.com/api";
    if (/(^|\.)unreadatlas\.(com|org)$/.test(location.hostname)) return location.origin + "/api";
    // Local preview of dist/ without an /api proxy: hit production API (CORS allows localhost).
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "https://unreadatlas.com/api";
    return location.origin + "/api";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function confLevel(c) {
    c = Number(c);
    return c === 1 || c === 2 || c === 3 ? c : 0;
  }

  function fillCell(td, text, conf) {
    var c = confLevel(conf);
    td.className = "mt";
    if (c) td.classList.add("conf-" + c);
    td.removeAttribute("aria-hidden");
    if (c && CONF_TITLES[c] && text) {
      td.title = CONF_TITLES[c].replace(/^\w/, function (ch) { return ch.toUpperCase(); });
      td.innerHTML = esc(text) + '<span class="conf-note">(' + esc(CONF_TITLES[c]) + ")</span>";
    } else {
      td.removeAttribute("title");
      td.textContent = text || "";
    }
  }

  /** Prefer an edition with aligned lines[].mt; else mt_lines (eBL / ATF-withheld).
   *  /api/text mt_lines use {line, mt} (same as the Reader); accept legacy {line_ref|n, content} too. */
  function mtFreeN(l) {
    if (!l) return null;
    var n = l.line != null ? l.line : (l.line_ref != null ? l.line_ref : l.n);
    return n != null && n !== "" ? String(n) : null;
  }
  function mtFreeEn(l) {
    if (!l) return null;
    var en = l.mt != null ? l.mt : l.content;
    return en != null && en !== "" ? en : null;
  }
  function pickMt(data) {
    var eds = (data && data.editions) || [];
    var withLines = eds.find(function (ed) {
      return Array.isArray(ed.lines) && ed.lines.some(function (l) { return l && l.mt; });
    });
    if (withLines) {
      return {
        byN: withLines.lines.reduce(function (acc, l) {
          if (l && l.mt && l.n != null && l.n !== "") acc[String(l.n)] = { en: l.mt, conf: l.conf };
          return acc;
        }, {}),
        ordered: withLines.lines
          .filter(function (l) { return l && l.mt; })
          .map(function (l) { return { n: l.n, en: l.mt, conf: l.conf }; }),
        model: withLines.model || data.model,
      };
    }
    var withFree = eds.find(function (ed) {
      return Array.isArray(ed.mt_lines) && ed.mt_lines.some(function (l) { return mtFreeEn(l); });
    });
    if (withFree) {
      return {
        byN: withFree.mt_lines.reduce(function (acc, l) {
          var n = mtFreeN(l);
          var en = mtFreeEn(l);
          if (n && en) acc[n] = { en: en, conf: l.conf };
          return acc;
        }, {}),
        ordered: withFree.mt_lines
          .map(function (l) { return { n: mtFreeN(l), en: mtFreeEn(l), conf: l.conf }; })
          .filter(function (x) { return x.en; }),
        model: withFree.model || data.model,
      };
    }
    return null;
  }

  function applyToTable(table, mt) {
    var pending = table.querySelectorAll("td.mt-pending");
    var filled = 0;
    pending.forEach(function (td) {
      var tr = td.closest("tr");
      var n = tr && tr.getAttribute("data-line-n");
      var hit = n != null ? mt.byN[String(n)] : null;
      if (!hit) return;
      fillCell(td, hit.en, hit.conf);
      filled += 1;
    });
    // Fallback: fill pending cells in document order from ordered list when line numbers miss.
    if (filled === 0 && pending.length && mt.ordered && mt.ordered.length) {
      var teaser = Number(table.getAttribute("data-mt-teaser") || "0");
      var rest = mt.ordered.slice(Math.max(0, teaser));
      pending.forEach(function (td, i) {
        if (rest[i]) fillCell(td, rest[i].en, rest[i].conf);
      });
      filled = Math.min(pending.length, rest.length);
    }
    return filled;
  }

  function setStatus(bar, html, isErr) {
    var el = bar.querySelector(".mt-load-status");
    if (!el) return;
    el.classList.toggle("mt-load-error", !!isErr);
    el.innerHTML = html;
  }

  function readerLink(id) {
    return '<a href="../map.html?id=' + encodeURIComponent(id) + '">Open in Reader</a>';
  }

  function offerRetry(bar, id) {
    setStatus(
      bar,
      '<button type="button" class="btn mt-retry">Show full translation</button> · '
        + readerLink(id),
      true
    );
    var btn = bar.querySelector(".mt-retry");
    if (btn) btn.addEventListener("click", function () { loadBar(bar); });
  }

  async function loadBar(bar) {
    var id = bar.getAttribute("data-text-id");
    if (!id) return;
    bar.hidden = false;
    setStatus(bar, "Loading full translation…");
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      var hdrs = { Accept: "application/json" };
      if (window.UnreadToken && window.UnreadToken.headers) {
        try { hdrs = await window.UnreadToken.headers(); } catch (e) {}
      }
      var res = await fetch(
        apiBase() + "/text/" + encodeURIComponent(id).replace(/%3A/gi, ":"),
        {
          headers: hdrs,
          signal: ctl && ctl.signal,
        }
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var mt = pickMt(data);
      if (!mt) throw new Error("no machine English");
      var tables = Array.prototype.slice.call(document.querySelectorAll("table.lines-table[data-mt-lazy]")).filter(function (t) {
        return (t.getAttribute("data-text-id") || id) === id;
      });
      var filled = 0;
      tables.forEach(function (t) { filled += applyToTable(t, mt); });
      if (!filled && !(mt.ordered && mt.ordered.length)) throw new Error("no machine English");
      if (!filled) throw new Error("line labels did not match");
      bar.setAttribute("data-mt-loaded", "1");
      bar.hidden = true;
    } catch (err) {
      offerRetry(bar, id);
    }
  }

  function likelyAutomated() {
    try {
      return !!(navigator && navigator.webdriver);
    } catch (e) {
      return false;
    }
  }

  function offerButton(bar) {
    if (bar.getAttribute("data-mt-loaded") === "1") return;
    var id = bar.getAttribute("data-text-id") || "";
    setStatus(bar, '<button type="button" class="btn mt-retry">Show full translation</button>');
    var btn = bar.querySelector(".mt-retry");
    if (btn) btn.addEventListener("click", function () { loadBar(bar); });
  }

  function boot() {
    document.querySelectorAll(".mt-load-bar[data-text-id]").forEach(function (bar) {
      if (bar.getAttribute("data-mt-loaded") === "1") return;
      if (likelyAutomated()) {
        offerButton(bar);
        return;
      }
      loadBar(bar);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
