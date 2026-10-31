/*! Canonical top nav (keep in sync with scripts/site_nav.py). No Reader. */
(function (global) {
  const ITEMS = [
    { href: "map.html", label: "Search", keys: ["search", "map", "list", "explore"] },
    { href: "signs.html", label: "Signs", keys: ["signs"] },
    { href: "t/index.html", label: "Research", keys: ["research", "t"] },
    { href: "translate.html", label: "Translator", keys: ["translate", "translator"] },
    { href: "map.html?view=stats", label: "Stats", keys: ["stats"] },
    { href: "credits.html", label: "Credits", keys: ["credits"] },
    { href: "map.html?view=about", label: "About", keys: ["about"] },
  ];

  function depthFrom(el) {
    const d = el.getAttribute("data-ua-nav-depth");
    if (d != null) return d;
    const path = location.pathname.replace(/\/+$/, "");
    if (/\/t(\/|$)/.test(path)) return "../";
    return "";
  }

  function activeKey(el) {
    return (el.getAttribute("data-ua-nav-active") || "").toLowerCase();
  }

  function fill(nav) {
    const depth = depthFrom(nav);
    const active = activeKey(nav);
    nav.setAttribute("aria-label", nav.getAttribute("aria-label") || "Main");
    nav.innerHTML = ITEMS.map((it) => {
      const href = /^(https?:|#|\?)/.test(it.href) ? it.href : depth + it.href;
      const on = active && it.keys.includes(active);
      return '<a class="nav-link' + (on ? ' active' : '') + '" href="' + href + '"' + (on ? ' aria-current="page"' : '') + '>' + it.label + '</a>';
    }).join("\n");
  }

  function boot() {
    document.querySelectorAll("nav[data-ua-nav]").forEach(fill);
  }

  global.UA_SITE_NAV = { ITEMS, fill, boot };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof window !== "undefined" ? window : globalThis);
