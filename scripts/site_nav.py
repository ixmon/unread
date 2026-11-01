"""Canonical top nav for Unread Atlas (no bare Reader — open via Map/List/Explore or ?id=).

Single source for scripts/build_static.py and scripts/tablet_page.py.
Keep web/js/site-nav.js ITEMS in sync with NAV below.
"""
from __future__ import annotations

# (href_from_web_root, label, active_keys)
# active_keys: page stems / view names that mark this item current
NAV: list[tuple[str, str, tuple[str, ...]]] = [
    ("map.html", "Search", ("search", "map", "list", "explore")),
    ("signs.html", "Signs", ("signs",)),
    ("t/index.html", "Research", ("research", "t")),
    ("translate.html", "Translator", ("translate", "translator")),
    ("map.html?view=stats", "Stats", ("stats",)),
    ("credits.html", "Credits", ("credits",)),
    ("map.html?view=about", "About", ("about",)),
]


def nav_items_for_depth(depth: str = "") -> list[tuple[str, str]]:
    """Return (href, label) with depth prefix applied to paths (not query-only)."""
    out = []
    for href, label, _keys in NAV:
        if href.startswith(("http://", "https://", "#", "?")):
            out.append((href, label))
        else:
            out.append((f"{depth}{href}", label))
    return out


def nav_html(depth: str = "", active: str = "") -> str:
    """Render <a class=nav-link>… for a static header. active is a key from NAV keys."""
    active = (active or "").lower()
    parts = []
    for href, label, keys in NAV:
        full = href if href.startswith(("http://", "https://", "#", "?")) else f"{depth}{href}"
        is_on = active in keys
        cls = "nav-link active" if is_on else "nav-link"
        cur = ' aria-current="page"' if is_on else ""
        parts.append(f'<a class="{cls}" href="{full}"{cur}>{label}</a>')
    return "\n".join(parts)


# Keep in sync with web/site.json and web/js/site-nav.js
SITE_NAME = "Unread Atlas"
SITE_TAGLINE = "first readings · open corpus"


def brand_html(*, href: str = "./", logo_src: str = "assets/logo/logo.svg", name: str | None = None, tagline: str | None = None) -> str:
    """Canonical header brand: logo + name + tagline (matches map.html)."""
    n = name if name is not None else SITE_NAME
    tl = tagline if tagline is not None else SITE_TAGLINE
    return (
        f'<a class="brand" href="{href}" title="Unread Atlas home">'
        f'<img class="brand-mark" src="{logo_src}" width="58" height="28" alt="" />'
        f"<h1><!--site:name-->{n}<!--/site:name--> "
        f'<span class="sub"><!--site:tagline-->{tl}<!--/site:tagline--></span></h1></a>'
    )

