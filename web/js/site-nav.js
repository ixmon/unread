/*! Canonical top nav + brand tagline (keep in sync with scripts/site_nav.py). No Reader. */
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

  // Mirrors web/site.json — site-nav has no fetch; keep in sync with scripts/site_nav.py BRAND_*.
  const SITE_NAME = "Unread Atlas";
  const SITE_TAGLINE = "first readings · open corpus";

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

  /** Ensure .brand shows name + tagline like map.html (Search/Stats/About). */
  function ensureBrand(root) {
    const brands = (root || document).querySelectorAll("a.brand");
    brands.forEach((brand) => {
      if (brand.querySelector(".sub, [data-ua-tagline]")) return;
      const img = brand.querySelector("img.brand-mark, img");
      // Collect existing name text (ignore img alt)
      let name = "";
      brand.childNodes.forEach((n) => {
        if (n.nodeType === 3) name += n.textContent;
        else if (n.nodeType === 1 && n.tagName === "H1") name += n.textContent;
      });
      name = name.replace(/\s+/g, " ").trim() || SITE_NAME;
      // Strip bare text nodes we'll replace
      [...brand.childNodes].forEach((n) => {
        if (n.nodeType === 3) n.textContent = "";
        else if (n.nodeType === 1 && n.tagName === "H1") n.remove();
      });
      const h1 = document.createElement("h1");
      h1.appendChild(document.createTextNode(name + " "));
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.setAttribute("data-ua-tagline", "1");
      sub.textContent = SITE_TAGLINE;
      h1.appendChild(sub);
      if (img && img.nextSibling) brand.insertBefore(h1, img.nextSibling);
      else if (img) brand.appendChild(h1);
      else brand.insertBefore(h1, brand.firstChild);
    });
  }

  /** Phones (<=760px): a Menu button like map.html's, opening the nav as a dropdown. */
  function addToggle(nav) {
    const header = nav.closest(".static-header");
    if (!header || header.querySelector(".nav-toggle")) return;
    if (!nav.id) nav.id = "header-nav";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-toggle";
    btn.setAttribute("aria-controls", nav.id);
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Menu");
    btn.innerHTML = '<span class="nav-toggle-bars" aria-hidden="true"></span><span class="nav-toggle-label">Menu</span>';
    header.insertBefore(btn, nav);
    header.classList.add("has-nav-toggle");
    const set = (open) => {
      btn.setAttribute("aria-expanded", String(open));
      nav.classList.toggle("open", open);
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = btn.getAttribute("aria-expanded") !== "true";
      set(open);
      if (open) { const a = nav.querySelector(".nav-link"); if (a) a.focus(); }
    });
    nav.addEventListener("click", (e) => { if (e.target.closest(".nav-link")) set(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") { set(false); btn.focus(); }
    });
    document.addEventListener("click", (e) => {
      if (btn.getAttribute("aria-expanded") === "true" && !nav.contains(e.target) && e.target !== btn) set(false);
    });
  }

  function boot() {
    document.querySelectorAll("nav[data-ua-nav]").forEach(fill);
    document.querySelectorAll("nav[data-ua-nav]").forEach(addToggle);
    ensureBrand(document);
  }

  global.UA_SITE_NAV = { ITEMS, SITE_NAME, SITE_TAGLINE, fill, ensureBrand, addToggle, boot };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof window !== "undefined" ? window : globalThis);
