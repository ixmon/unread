/**
 * Quiet browser-check token for Unread Atlas full-text API.
 * No visible UI. Collects light browser signals, POSTs /api/token, caches a
 * short-lived Bearer token, and exposes headers for /api/text fetches.
 * Shadow mode on the API: missing tokens are logged, never blocked (preview).
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "unread_browser_token_v1";
  var MIN_ENTROPY_WAIT_MS = 400;
  var _inflight = null;
  var _token = null;
  var _exp = 0;
  var _entropy = 0;
  var _listenersBound = false;

  function apiBase() {
    var q = new URLSearchParams(location.search).get("textapi")
      || new URLSearchParams(location.search).get("api");
    if (q) return String(q).replace(/\/+$/, "");
    if (location.protocol === "file:") return "https://unreadatlas.com/api";
    if (/(^|\.)unreadatlas\.(com|org)$/.test(location.hostname)) return location.origin + "/api";
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      // Prefer same-origin /api when a preview proxy is present.
      return location.origin + "/api";
    }
    return location.origin + "/api";
  }

  function bumpEntropy(n) {
    _entropy = Math.min(1, _entropy + (n || 0.15));
  }

  function bindEntropy() {
    if (_listenersBound) return;
    _listenersBound = true;
    var once = function (w) {
      return function () { bumpEntropy(w); };
    };
    ["pointerdown", "mousedown", "touchstart", "keydown", "scroll", "mousemove"].forEach(function (ev) {
      global.addEventListener(ev, once(ev === "mousemove" || ev === "scroll" ? 0.05 : 0.2), {
        passive: true,
        once: ev !== "mousemove" && ev !== "scroll",
      });
    });
    // Passive time-on-page still counts a little.
    setTimeout(function () { bumpEntropy(0.1); }, 300);
  }

  function collectSignals() {
    var s = global.screen || {};
    var nav = global.navigator || {};
    return {
      v: 1,
      screen: {
        w: s.width || 0,
        h: s.height || 0,
        aw: s.availWidth || 0,
        ah: s.availHeight || 0,
        dpr: global.devicePixelRatio || 1,
      },
      viewport: {
        w: global.innerWidth || 0,
        h: global.innerHeight || 0,
        ow: global.outerWidth || 0,
        oh: global.outerHeight || 0,
      },
      webdriver: !!(nav.webdriver),
      lang: nav.language || "",
      langs: nav.languages ? Array.prototype.slice.call(nav.languages, 0, 8) : [],
      tz: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
        catch (e) { return ""; }
      })(),
      hc: nav.hardwareConcurrency || 0,
      touch: nav.maxTouchPoints || 0,
      perf: (function () {
        try { return Math.round((performance.now() + performance.timeOrigin) % 1e9); }
        catch (e) { return Date.now() % 1e9; }
      })(),
      entropy: Math.round(_entropy * 100) / 100,
      ts: Math.floor(Date.now() / 1000),
    };
  }

  function readCached() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.token && o.exp && o.exp * 1000 > Date.now() + 5000) return o;
    } catch (e) {}
    return null;
  }

  function writeCached(token, expiresIn) {
    var exp = Math.floor(Date.now() / 1000) + (expiresIn || 900) - 30;
    _token = token;
    _exp = exp;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: token, exp: exp }));
    } catch (e) {}
  }

  function mint() {
    if (_inflight) return _inflight;
    bindEntropy();
    _inflight = new Promise(function (resolve) {
      var wait = Math.max(0, MIN_ENTROPY_WAIT_MS);
      setTimeout(function () {
        var body = JSON.stringify(collectSignals());
        fetch(apiBase() + "/token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: body,
          credentials: "omit",
          cache: "no-store",
        })
          .then(function (res) {
            if (!res.ok) throw new Error("token HTTP " + res.status);
            return res.json();
          })
          .then(function (data) {
            if (!data || !data.token) throw new Error("no token");
            writeCached(data.token, data.expires_in || 900);
            resolve(data.token);
          })
          .catch(function () {
            // Fail open in shadow mode: callers still fetch /text without a token.
            resolve(null);
          })
          .finally(function () { _inflight = null; });
      }, wait);
    });
    return _inflight;
  }

  function getToken() {
    if (_token && _exp * 1000 > Date.now() + 5000) return Promise.resolve(_token);
    var cached = readCached();
    if (cached) {
      _token = cached.token;
      _exp = cached.exp;
      return Promise.resolve(_token);
    }
    return mint();
  }

  function authHeaders() {
    return getToken().then(function (tok) {
      var h = { Accept: "application/json" };
      if (tok) {
        h.Authorization = "Bearer " + tok;
        h["X-Unread-Token"] = tok;
      }
      return h;
    });
  }

  // Warm the token quietly after load; do not block rendering.
  function boot() {
    bindEntropy();
    setTimeout(function () { getToken(); }, 50);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  global.UnreadToken = {
    get: getToken,
    headers: authHeaders,
    apiBase: apiBase,
    collectSignals: collectSignals,
  };
})(typeof window !== "undefined" ? window : globalThis);
