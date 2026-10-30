#!/usr/bin/env python3
"""Shared Unread Atlas /t/ tablet page renderer.

Used by scripts/build_seo_pages.py (static HTML) and the unread-atlas-tpages-preview
Lambda (on-request HTML). Reads the public search export SQLite — the same filtered
corpus the live /api serves — so eBL ATF and eBL human English stay withheld
(atf_public=0 / human_en_public=0 in the export).
"""
from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import quote

e = html.escape

# ---------------------------------------------------------------------------
# Optional on-disk site assets (static build). Lambda passes these via kwargs
# or embeds compact copies next to this module.
# ---------------------------------------------------------------------------
_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_WEB = _ROOT / "web"

def _load_site() -> dict:
    for p in (
        _WEB / "site.json",
        _HERE / "site.json",  # Lambda package layout
    ):
        if p.is_file():
            return json.loads(p.read_text())
    return {"name": "Unread Atlas"}

def _load_tr_policy() -> dict:
    for p in (
        _WEB / "assets" / "translation-policy.json",
        _HERE / "translation-policy.json",
    ):
        if p.is_file():
            return json.loads(p.read_text()).get("sources", {})
    return {}

SITE = _load_site()
TR_POLICY = _load_tr_policy()
CONF_TITLES = {
    1: "lower confidence: line is broken",
    2: "low confidence: few signs survive",
    3: "very low confidence: a guess",
}
OG_IMAGE = "https://unreadatlas.com/og.jpg"
MAX_LINES = 600
STATIC_META = '<meta name="unread-static" content="1">'

NAV = [
    ("map.html", "Explore"),
    ("browse.html", "Browse"),
    ("signs.html", "Signs"),
    ("t/index.html", "Curated"),
    ("translate.html", "Translator"),
    ("search.html", "Search"),
    ("credits.html", "Credits"),
]

PERIOD_RANGES = [(re.compile(p, re.I), a, b) for p, a, b in [
    (r"uruk v\b", -3500, -3350), (r"uruk iv", -3350, -3200), (r"uruk iii|proto-elamite|archaic|jemdet", -3200, -2900),
    (r"ed i-ii|early dynastic i-ii", -2900, -2600), (r"ed iiia|fara", -2600, -2500), (r"ed iiib|presargonic|ebla", -2500, -2340),
    (r"early dynastic", -2900, -2340), (r"old akkadian|sargonic", -2340, -2200), (r"lagas|lagaš ii", -2200, -2100),
    (r"ur iii", -2100, -2000), (r"early old babylonian", -2000, -1900), (r"old assyrian", -1950, -1850),
    (r"old babylonian", -1900, -1600), (r"old elamite", -2100, -1500), (r"middle hittite|hittite", -1500, -1180),
    (r"middle babylonian|kassite|sealand", -1400, -1100), (r"middle assyrian", -1400, -1000), (r"middle elamite", -1500, -1100),
    (r"early neo-babylonian", -1000, -730), (r"neo-?assyrian|9th|8th", -911, -612), (r"neo-?elamite", -1000, -539),
    (r"neo-?babylonian", -626, -539), (r"achaemenid|persian", -539, -330), (r"hellenistic|seleucid", -330, -141),
    (r"parthian|arsacid", -141, 224), (r"late babylonian", -626, -100)]]

LANG_CODE = {"sumerian": "sux", "akkadian": "akk", "hittite": "hit", "elamite": "elx", "hurrian": "xhu", "urartian": "xur",
             "ugaritic": "uga", "aramaic": "arc", "greek": "grc", "eblaite": "xeb", "luwian": "xlu"}

# find-spot rules (same as fix_catalog_sites.usable_site / search Lambda)
_PLACEHOLDER_COORDS = [(51.2297, 58.6555)]
_REGIONS = re.compile(r"^(northern |southern |central )?(babylonia|assyria|mesopotamia|iran|syria|anatolia)$", re.I)
_UNKNOWN = re.compile(r"^(uncertain|unclear|unknown)$", re.I)


def usable_site(prov: str, lat, lon) -> bool:
    if lat is None or lon is None:
        return False
    if any(abs(lat - a) < 1e-3 and abs(lon - b) < 1e-3 for a, b in _PLACEHOLDER_COORDS):
        return False
    p = (prov or "").strip().rstrip(" ?").strip()
    m = re.match(r"^(.*?)\s*\(mod\.\s*(.*?)\)$", p)
    ancient, modern = (m.group(1).strip(), m.group(2).strip()) if m else (p, "")
    if not ancient and not modern:
        return False
    if modern and _UNKNOWN.match(modern):
        return False
    if _UNKNOWN.match(ancient) and (not modern or _REGIONS.match(modern)):
        return False
    if _REGIONS.match(ancient) and not modern:
        return False
    return True


def surface_short_label(surf: str) -> tuple[str, str]:
    """Return (short, full) Assyriological surface label for static page gutters."""
    raw = " ".join(str(surf or "").replace("·", " ").replace("|", " ").split())
    if not raw:
        return "", ""
    low = raw.lower()
    to_roman = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
                "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"]

    def roman(col: str) -> str:
        s = (col or "").lower().rstrip(".")
        if not s:
            return ""
        if re.fullmatch(r"[ivxlcdm]+", s):
            return s
        try:
            n = int(s)
        except ValueError:
            return s
        return to_roman[n] if 1 <= n < len(to_roman) else s

    names = [
        (r"^(obverse|obv\.?|o)$", "o", "Obverse"),
        (r"^(reverse|rev\.?|r)$", "r", "Reverse"),
        (r"^(left[ -]?edge|le\.e\.?|le)$", "le.e", "Left edge"),
        (r"^(right[ -]?edge|re\.e\.?|re)$", "re.e", "Right edge"),
        (r"^(top[ -]?edge|t\.e\.?|te)$", "t.e", "Top edge"),
        (r"^(upper[ -]?edge|u\.e\.?|ue)$", "u.e", "Upper edge"),
        (r"^(bottom[ -]?edge|b\.e\.?|be)$", "b.e", "Bottom edge"),
        (r"^(lower[ -]?edge|lo\.e\.?|loe)$", "lo.e", "Lower edge"),
        (r"^(edge|e)$", "e", "Edge"),
        (r"^(seal)$", "seal", "Seal"),
        (r"^(fragment|frag\.?)$", "frag", "Fragment"),
    ]
    m = re.match(r"^surface\s+([a-z0-9]+)\b(?:\s+(?:col(?:umn)?\.?\s*)?([ivx]+|\d+))?$", low)
    if m:
        col = roman(m.group(2) or "")
        short = f"surf. {m.group(1)}" + (f" {col}" if col else "")
        lab = f"Surface {m.group(1)}" + (f", column {col}" if col else "")
        return short, lab
    m = re.match(r"^(.*?)(?:\s+(?:col(?:umn)?\.?\s*)?([ivx]+|\d+))?$", low)
    side = (m.group(1) if m else low).strip()
    col = roman(m.group(2) if m else "")
    for pat, short_s, lab_s in names:
        if re.match(pat, side):
            short = f"{short_s} {col}".strip() if col else short_s
            lab = lab_s + (f", column {col}" if col else "")
            return short, lab
    short_s = side if len(side) <= 6 else side[:5] + "."
    short = f"{short_s} {col}".strip() if col else short_s
    return short, raw


def human_ok(src: str) -> bool:
    return (TR_POLICY.get(src) or TR_POLICY.get("unknown") or {}).get("show_human") is True


def period_range(p):
    for rx, a, b in PERIOD_RANGES:
        if p and rx.search(p):
            return a, b
    return None


def fmt_year(y):
    return f"-{abs(y):04d}" if y < 0 else f"{y:04d}"


def human_years(r):
    a, b = r
    f = lambda y: f"{-y} BCE" if y < 0 else f"{y} CE"  # noqa: E731
    return f"c. {f(a)}–{f(b)}"


def clean_author(a):
    a = re.sub(r"\s*\((CDLI )?translation_source\)|\s*\(see CDLI record\)", "", a or "").strip()
    return None if not a or re.search(r"^(uncertain|unknown|cdli contributor|no translator|translator not named)", a, re.I) else a


def slug(text_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", text_id)


def jsonld(obj) -> str:
    return ('<script type="application/ld+json">'
            + json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
            + "</script>")


def site_short(p):
    return re.sub(r"\s*\(mod\..*?\)", "", p or "").strip(" ?")


def clip(t, n):
    t = re.sub(r"\s+", " ", t or "").strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def mt_teaser_lines(n_mt: int, cap: int = 5) -> int:
    n = max(0, int(n_mt or 0))
    if n <= 1:
        return 0
    c = int(cap)
    if c <= 0:
        return n
    return max(1, min(c, n // 2))


def mt_td(m, cf, pending=False):
    if pending:
        return '<td class="mt mt-pending" aria-hidden="true"></td>'
    if cf in CONF_TITLES and m:
        return (f'<td class="mt conf-{cf}" title="{e(CONF_TITLES[cf].capitalize())}">'
                f'{e(m)}<span class="conf-note">({e(CONF_TITLES[cf])})</span></td>')
    return f'<td class="mt">{e(m or "")}</td>'


def crumbs_ld(items):
    return {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": n, "item": u}
        for i, (n, u) in enumerate(items)]}


def _asset(href: str, asset_prefix: str) -> str:
    """Rewrite root-relative site asset paths. asset_prefix is '../' for /t/*.html
    or 'https://unreadatlas.com/' for Function URL preview."""
    if href.startswith(("http://", "https://", "//", "data:")):
        return href
    return asset_prefix + href.lstrip("/")


def page_shell(*, title, desc, canonical, body, ld, active="", og_type="article",
               head_extra="", noindex=False, scripts="", asset_prefix="../",
               include_static_meta=True, beacon_token: str | None = None) -> str:
    ap = asset_prefix
    nav = "\n".join(
        f'<a class="nav-link{" active" if h == active else ""}" href="{e(_asset(h, ap))}">{l}</a>'
        for h, l in NAV)
    meta_static = ("\n" + STATIC_META) if include_static_meta else ""
    robots = '\n<meta name="robots" content="noindex,follow">' if noindex else ""
    beacon = ""
    if beacon_token:
        beacon = (f'<script defer src="https://static.cloudflareinsights.com/beacon.min.js" '
                  f"data-cf-beacon='{{\"token\": \"{beacon_token}\"}}'></script>\n")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">{meta_static}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} · {e(SITE["name"])}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(canonical)}">{robots}
<link rel="icon" href="{e(_asset('favicon.ico', ap))}" sizes="any">
<link rel="icon" href="{e(_asset('favicon.svg', ap))}" type="image/svg+xml">
<link rel="apple-touch-icon" href="{e(_asset('apple-touch-icon.png', ap))}">
<link rel="manifest" href="{e(_asset('site.webmanifest', ap))}">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="{e(SITE["name"])}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{e(canonical)}">
<meta property="og:image" content="{OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{e(title)}">
<meta name="twitter:description" content="{e(desc)}">
<meta name="twitter:image" content="{OG_IMAGE}">
<meta name="theme-color" content="#0f1114">
<link rel="preload" href="{e(_asset('fonts/ui/ibm-plex-sans-normal-latin.woff2', ap))}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="{e(_asset('fonts/ui/source-serif-4-normal-latin.woff2', ap))}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="{e(_asset('css/ui-fonts.css', ap))}">
<link rel="stylesheet" href="{e(_asset('css/styles.css', ap))}">
<link rel="stylesheet" href="{e(_asset('css/static.css', ap))}">
<style>.crumbs{{font-size:.85rem;color:var(--text-dim)}}.crumbs a{{color:var(--text-dim)}}.lines-table td.atf{{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85rem}}
.src-note{{font-size:.85rem;color:var(--text-dim)}}.cta a{{margin-right:1rem}}.gl-table td{{padding:.2rem .8rem .2rem 0}}.vals span{{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:.85rem;border:1px solid var(--border);border-radius:5px;padding:0 .4rem;margin:.1rem}}
.lines-table td.conf-1{{opacity:.82}}.lines-table td.conf-2{{opacity:.66;font-style:italic}}.lines-table td.conf-3{{opacity:.52;font-style:italic}}.conf-note{{display:block;font-size:.72rem;font-style:normal;color:var(--text-faint)}}</style>{head_extra}
{jsonld(ld)}
</head>
<body class="static-page">
<header class="static-header">
<a class="brand" href="{e(_asset('', ap) or _asset('index.html', ap))}" title="Unread Atlas home"><img class="brand-mark" src="{e(_asset('assets/logo/logo.svg', ap))}" width="58" height="28" alt="" />{e(SITE["name"])}</a>
<nav aria-label="Main">
{nav}
</nav>
</header>
<main class="static-main">
{body}
</main>
<footer class="static-footer">{e(SITE["name"])} · <a href="{e(_asset('', ap))}">Home</a> · <a href="{e(_asset('browse.html', ap))}">Browse</a> · <a href="{e(_asset('signs.html', ap))}">Signs</a> · <a href="{e(_asset('t/index.html', ap))}">Curated texts</a> · <a href="{e(_asset('credits.html', ap))}">Credits &amp; thanks</a></footer>
{scripts}
{beacon}</body>
</html>
"""


def resolve_rows(c: sqlite3.Connection, key: str) -> list[sqlite3.Row]:
    """Resolve a tablet key (canonical_id or src:id) to text rows, CDLI-first.

    Also accepts SEO filename stems from slug(): ebl:Asb.h -> ebl_Asb.h.
    """
    candidates = [key]
    if ":" not in key and "_" in key:
        for src in ("ebl", "oracc", "tlhdig", "achemenet", "cdli"):
            prefix = src + "_"
            if key.startswith(prefix):
                candidates.append(f"{src}:{key[len(prefix):]}")
                break
    rows: list[sqlite3.Row] = []
    for cand in candidates:
        rows = [r for r in c.execute("SELECT * FROM text WHERE canonical_id=? COLLATE NOCASE", (cand,))
                if r["canonical_id"] == cand]
        if not rows and ":" in cand:
            src, i = cand.split(":", 1)
            rows = list(c.execute("SELECT * FROM text WHERE src=? AND id=?", (src, i)))
        if not rows:
            # bare P-number / id match
            rows = list(c.execute("SELECT * FROM text WHERE id=? COLLATE NOCASE", (cand,)))
        if rows:
            break
    order = {"cdli": 0, "oracc": 1, "tlhdig": 2, "achemenet": 3, "ebl": 4}
    return sorted(rows, key=lambda r: order.get(r["src"], 9))


def render_tablet_html(
    c: sqlite3.Connection,
    key: str,
    *,
    base: str = "https://unreadatlas.com/",
    mt_html_lines: int = 5,
    index_min: int = 10,
    export_date: str | None = None,
    asset_prefix: str = "../",
    include_static_meta: bool = True,
    beacon_token: str | None = None,
    sources: dict | None = None,
    conf_col: str | None = None,
    built_full: str | None = None,
) -> dict[str, Any] | None:
    """Render one tablet page. Returns None if the id is unknown or has nothing we may show.

    Result keys: html, slug, url, indexable, n_english, designation, key
    """
    if not base.endswith("/"):
        base += "/"
    if sources is None:
        sources = {r["id"]: dict(r) for r in c.execute("SELECT * FROM source")}
    if conf_col is None:
        conf_col = ("tr.conf_level" if any(r[1] == "conf_level" for r in c.execute("PRAGMA table_info(tr)"))
                    else "NULL")
    if built_full is None:
        raw = c.execute("SELECT value FROM meta WHERE key='built_at'").fetchone()
        built_full = json.loads(raw[0]) if raw else dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    if export_date:
        built_full = f"{export_date}T00:00:00Z"
    built = built_full[:10]

    rows = resolve_rows(c, key)
    if not rows:
        return None

    # Prefer the canonical key form for URLs
    key = rows[0]["canonical_id"] or f"{rows[0]['src']}:{rows[0]['id']}"
    sl = slug(key)
    url = f"{base}t/{sl}.html"

    first = lambda k: next((r[k] for r in rows if r[k]), None)  # noqa: E731
    designation = first("designation") or key
    period, genre, lang = first("period"), first("genre"), first("language")
    museum, coll = first("museum_no"), first("collection")
    geo = next((r for r in rows if r["lat"] is not None and usable_site(r["provenience"] or "", r["lat"], r["lon"])), None)
    prov = (geo["provenience"] if geo else None) or first("provenience")

    hum_rows = [r for r in rows if r["n_human_en"] and human_ok(r["src"])]
    hum = []
    for r in hum_rows:
        for x in c.execute("""SELECT tr.line_ref, tr.content, ts.author, ts.license, ts.edition
                              FROM tr JOIN tr_source ts ON ts.tsid=tr.tsid
                              WHERE tr.rid=? AND tr.human=1 ORDER BY tr.trid LIMIT ?""",
                           (r["rid"], MAX_LINES)):
            hum.append((r["src"], x))

    # ATF only where atf_public=1 (export already sets eBL to 0)
    atf_row = next((r for r in rows if r["atf_public"] and r["n_lines"]), None)
    lines, mt_meta = [], None
    if atf_row:
        mt = {}
        for x in c.execute(f"""SELECT tr.lid, tr.content, {conf_col} AS conf, ts.author, ts.version,
                                      ts.model_label, tr.created FROM tr
                               JOIN tr_source ts ON ts.tsid=tr.tsid
                               WHERE tr.rid=? AND tr.human=0""", (atf_row["rid"],)):
            if x["lid"] is not None:
                mt[x["lid"]] = (x["content"], x["conf"] or 0)
            mt_meta = mt_meta or {
                "repo": x["author"], "label": x["model_label"],
                "on": (x["created"] or "")[:10], "rev": (x["version"] or "")[:8],
            }
        for l in c.execute("SELECT lid, line_no, surface, atf FROM line WHERE rid=? ORDER BY seq LIMIT ?",
                           (atf_row["rid"], MAX_LINES)):
            m_, cf = mt.get(l["lid"], (None, 0))
            lines.append((l["surface"], l["line_no"], l["atf"], m_, cf))

    mt_free, mt_free_meta = [], None
    mt_row = next((r for r in rows if r["n_mt"]), None)
    if mt_row is not None and (mt_row is not atf_row or not any(ln[3] for ln in lines)):
        for x in c.execute(f"""SELECT tr.line_ref, tr.content, {conf_col} AS conf, ts.author, ts.version,
                                      ts.model_label, tr.created FROM tr
                               JOIN tr_source ts ON ts.tsid=tr.tsid
                               WHERE tr.rid=? AND tr.human=0 ORDER BY tr.trid LIMIT ?""",
                           (mt_row["rid"], MAX_LINES)):
            mt_free.append((x["line_ref"], x["content"], x["conf"] or 0))
            mt_free_meta = mt_free_meta or {
                "repo": x["author"], "label": x["model_label"],
                "on": (x["created"] or "")[:10], "rev": (x["version"] or "")[:8],
            }

    n_mt_shown = sum(1 for *_, m, _cf in lines if m) + sum(1 for _, m, _ in mt_free if m)
    n_hum = len(hum)
    n_english = max(n_hum, n_mt_shown)
    if n_english < 1 and not lines:
        # nothing publishable
        return None

    # Sources list (skip eBL ATF link content — metadata URL is fine; ATF already withheld)
    srcs = []
    seen_src = set()
    for r in rows:
        if r["src"] in seen_src:
            continue
        seen_src.add(r["src"])
        s = sources.get(r["src"], {})
        link = ""
        if r["src"] == "cdli" and re.match(r"^P\d+$", r["id"] or ""):
            link = f"https://cdli.earth/artifacts/{int(r['id'][1:])}"
        elif r["src"] == "oracc" and r["id"]:
            link = f"http://oracc.org/{quote(r['project'] or 'epsd2')}/{quote(r['id'])}"
        elif r["src"] == "ebl":
            link = f"https://www.ebl.lmu.de/library/{quote(r['id'])}"
        elif s.get("url"):
            link = s["url"]
        srcs.append((s.get("name", r["src"]), link, s.get("license", ""), s.get("citation", "")))

    reader_id = rows[0]["canonical_id"] or rows[0]["id"]
    rng = period_range(period)
    sub = ", ".join(x for x in (genre, period, site_short(prov) if prov else None) if x)
    desc = clip(f"{designation}" + (f": {sub}" if sub else "") +
                (f". Machine English draft." if n_mt_shown else ""), 160)
    title = f"{designation} ({key}): {sub}" if sub else designation

    source_html = " · ".join(
        (f'<a class="meta-ext" href="{e(l)}" rel="noopener">{e(n)}</a> <span class="ext-label">(external)</span>'
         if l else e(n))
        for n, l, _, _ in srcs
    )
    meta = [
        ("Designation", designation, False),
        ("Museum no.", museum, False),
        ("Collection", coll, False),
        ("Language", lang, False),
        ("Period", f"{period}{(' · ' + human_years(rng)) if rng else ''}" if period else None, False),
        ("Genre", genre, False),
        ("Find spot", prov, False),
        ("Coordinates", f"{geo['lat']:.4f}, {geo['lon']:.4f}" if geo else None, False),
        ("Source", source_html, True),
    ]
    meta_rows = []
    for k, v, raw in meta:
        if not v:
            continue
        cell = v if raw else e(str(v))
        cls = ' class="meta-source"' if k == "Source" else ""
        meta_rows.append(f"<tr{cls}><th>{e(k)}</th><td>{cell}</td></tr>")
    meta_html = "".join(meta_rows)

    by_tr: dict = {}
    for src, x in hum:
        by_tr.setdefault(
            (x["author"] or "translator not named",
             x["license"] or sources.get(src, {}).get("license", ""),
             src),
            [],
        ).append(x)
    hum_html = []
    for (author, lic, src), xs in by_tr.items():
        hum_html.append(
            f'<h2>English translation</h2><p class="src-note">'
            f'{("By " + e(clean_author(author)) + " · ") if clean_author(author) else ""}'
            f'Via {e(sources.get(src, {}).get("name", src))} · {e(lic)}</p>'
            '<table class="lines-table"><thead><tr><th>Line</th><th>English</th></tr></thead><tbody>'
            + "".join(f'<tr><td class="ln">{e(x["line_ref"] or "")}</td><td>{e(x["content"] or "")}</td></tr>'
                      for x in xs)
            + "</tbody></table>"
        )

    ap = asset_prefix
    atf_html = ""
    mt_lazy = False
    mt_teaser_cap = mt_teaser_lines(n_mt_shown, mt_html_lines)
    mt_seen = 0
    if lines:
        rows_h, cur = [], None
        for surf, n, atf, m, cf in lines:
            if surf and surf != cur:
                short, full = surface_short_label(surf)
                rows_h.append(f'<tr class="surface-row"><td colspan="3" title="{e(full)}">{e(short)}</td></tr>')
                cur = surf
            pending = False
            if m:
                mt_seen += 1
                pending = mt_seen > mt_teaser_cap
            cell = mt_td(None, 0, pending=True) if pending else mt_td(m, cf)
            if pending:
                mt_lazy = True
            rows_h.append(
                f'<tr data-line-n="{e(n or "")}"><td class="ln">{e(n or "")}</td>'
                f'<td class="atf">{e(atf or "")}</td>{cell}</tr>'
            )
        s = sources.get(atf_row["src"], {})
        mt_note = (
            f'<p class="machine-draft"><strong>Machine translation · '
            f'{e(mt_meta["label"] or mt_meta["rev"] or "model")} · {e(mt_meta["on"])}</strong></p>'
        ) if mt_meta else ""
        tbl_attrs = (
            f' class="lines-table" data-mt-lazy="1" data-text-id="{e(reader_id)}" '
            f'data-mt-teaser="{mt_teaser_cap}"'
        ) if mt_lazy else ' class="lines-table"'
        _load_bar = (
            f'<p class="mt-load-bar" data-text-id="{e(reader_id)}" data-rest="{max(0, n_mt_shown - mt_teaser_cap)}">'
            f'<span class="mt-load-status"></span></p>'
        ) if mt_lazy else ""
        atf_html = (
            f'<h2>Transliteration (ATF)</h2>'
            f'<p class="src-note">From {e(s.get("name", atf_row["src"]))} · {e(s.get("license", ""))}</p>{mt_note}'
            f'{_load_bar}'
            f'<table{tbl_attrs}><thead><tr><th>Line</th><th>ATF</th><th>Machine translation</th></tr></thead><tbody>'
            + "\n".join(rows_h) + "</tbody></table>"
            + (f'<p class="src-note"><a href="{e(_asset(f"map.html?id={quote(reader_id)}", ap))}">'
               f'Open in Reader</a> for the full tablet.</p>'
               if atf_row["n_lines"] and atf_row["n_lines"] > MAX_LINES else "")
        )
    if mt_free:
        mm = mt_free_meta
        free_rows = []
        for ln, m, cf in mt_free:
            pending = False
            if m:
                mt_seen += 1
                pending = mt_seen > mt_teaser_cap
            if pending:
                mt_lazy = True
            cell = mt_td(None, 0, pending=True) if pending else mt_td(m, cf)
            free_rows.append(f'<tr data-line-n="{e(ln or "")}"><td class="ln">{e(ln or "")}</td>{cell}</tr>')
        tbl_attrs = (
            f' class="lines-table" data-mt-lazy="1" data-text-id="{e(reader_id)}" '
            f'data-mt-teaser="{mt_teaser_cap}"'
        ) if mt_lazy else ' class="lines-table"'
        _load_bar_free = (
            f'<p class="mt-load-bar" data-text-id="{e(reader_id)}" data-rest="{max(0, n_mt_shown - mt_teaser_cap)}">'
            f'<span class="mt-load-status"></span></p>'
        ) if mt_lazy and '<p class="mt-load-bar"' not in atf_html else ""
        atf_html += (
            f'<h2>Machine translation</h2>'
            f'<p class="machine-draft"><strong>Machine translation · '
            f'{e(mm["label"] or mm["rev"] or "model")} · {e(mm["on"])}</strong></p>'
            f'{_load_bar_free}'
            f'<table{tbl_attrs}><thead><tr><th>Line</th><th>Machine translation</th></tr></thead><tbody>'
            + "".join(free_rows) + "</tbody></table>"
        )
    rest_mt = max(0, n_mt_shown - mt_teaser_cap)
    if mt_lazy and rest_mt:
        # Status sits above the lines table (injected when the table is built). Noscript fallback:
        if '<p class="mt-load-bar"' not in atf_html:
            atf_html = (
                f'<p class="mt-load-bar" data-text-id="{e(reader_id)}" data-rest="{rest_mt}">'
                f'<span class="mt-load-status"></span></p>'
            ) + atf_html
        atf_html += (
            f'<noscript><p class="src-note"><a href="{e(_asset(f"map.html?id={quote(reader_id)}", ap))}">'
            f'Open in Reader</a></p></noscript>'
        )

    def _li(n, l, lic, cit):
        nm = f'<a href="{e(l)}" rel="noopener">{e(n)}</a>' if l else e(n)
        return f"<li>{nm} · {e(lic)}" + (" · " + e(cit) if cit else "") + "</li>"

    src_html = "<ul>" + "".join(_li(*x) for x in srcs) + "</ul>"
    browse_q = _asset(f"browse.html?id={quote(reader_id)}", ap)
    body = f"""<article>
<p class="crumbs"><a href="{e(_asset('', ap))}">Home</a> › <a href="{e(_asset('browse.html', ap))}">Tablets</a> › {e(key)}</p>
<h1>{e(designation)}{(' <small class="faint">(' + e(key) + ')</small>') if designation != key else ''}</h1>
<p class="lede">{e(sub)}{(' · ' + e(human_years(rng))) if rng else ''}</p>
<p class="page-actions"><a class="btn primary" href="{e(_asset(f'map.html?id={quote(reader_id)}', ap))}">Open in Reader</a><a class="btn" href="{e(browse_q)}">Open in Map</a><a class="btn" href="{e(_asset(f'translate.html?id={quote(reader_id)}', ap))}">In-Browser Translator</a></p>
<table class="meta-table">{meta_html}</table>
{"".join(hum_html)}
{atf_html}
<h2>Sources &amp; licences</h2>{src_html}
<p class="src-note">Cite the original edition and translator. Page generated by Unread Atlas from the public corpus export of {e(built)}.</p>
</article>"""

    cw = {
        "@type": "ArchiveComponent", "@id": url + "#tablet", "name": designation, "url": url,
        "identifier": key, "description": desc, "genre": genre,
        "inLanguage": LANG_CODE.get((lang or "").lower(), lang), "dateModified": built,
        "isBasedOn": [l for _, l, _, _ in srcs if l] or None,
        "license": next((lic for _, _, lic, _ in srcs if lic), None),
        "creditText": "; ".join(
            re.sub(r"\s*\(see [^)]*\)", "", cit) for _, _, _, cit in dict.fromkeys(srcs) if cit
        ) or None,
        "isPartOf": {"@type": "WebSite", "name": SITE["name"], "url": base},
    }
    if museum or coll:
        cw["holdingArchive"] = {"@type": "ArchiveOrganization", "name": coll or museum}
        if museum:
            cw["alternateName"] = museum
    if rng:
        cw["temporalCoverage"] = f"{fmt_year(rng[0])}/{fmt_year(rng[1])}"
    if prov and (geo or not re.search(r"uncertain|unknown", prov, re.I)):
        place = {"@type": "Place", "name": prov}
        if geo:
            place["geo"] = {
                "@type": "GeoCoordinates",
                "latitude": round(geo["lat"], 4),
                "longitude": round(geo["lon"], 4),
            }
        cw["locationCreated"] = place
    if by_tr:
        cw["workTranslation"] = {
            "@type": "CreativeWork", "inLanguage": "en",
            "name": f"English translation of {designation}",
            "author": [
                {"@type": "Person", "name": a}
                for a in dict.fromkeys(clean_author(a) for (a, _, _) in by_tr) if a
            ] or None,
        }
    cw = {k: v for k, v in cw.items() if v not in (None, [], "")}
    ld = {"@context": "https://schema.org",
          "@graph": [cw, crumbs_ld([("Home", base), ("Tablets", base + "browse.html"), (key, url)])]}

    mt_scripts = ""
    if mt_lazy:
        mt_scripts = (
            f'<script defer src="{e(_asset("js/static-mt.js", ap))}"></script>'
        )

    indexable = n_english >= index_min
    html_out = page_shell(
        title=title, desc=desc, canonical=url, body=body, ld=ld,
        noindex=not indexable, scripts=mt_scripts, asset_prefix=ap,
        include_static_meta=include_static_meta, beacon_token=beacon_token,
    )
    # Guard: never ship eBL ATF (export should already prevent this; belt-and-braces)
    if atf_row and atf_row["src"] == "ebl":
        raise RuntimeError(f"refusing to render eBL ATF for {key}")
    if "not a scholarly translation" in html_out.lower():
        raise RuntimeError("disclaimer text leaked into page HTML")
    if "first" in html_out.lower() and "machine lines are in the html" in html_out.lower():
        raise RuntimeError("teaser-mechanism copy leaked into page HTML")

    return {
        "html": html_out,
        "slug": sl,
        "url": url,
        "key": key,
        "designation": designation,
        "indexable": indexable,
        "n_english": n_english,
        "n_mt": n_mt_shown,
        "n_human": n_hum,
    }
