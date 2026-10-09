#!/usr/bin/env python3
"""Build pre-rendered static pages for curated texts.

Reads web/data-curated/curated.json, pulls metadata/ATF from the Unread corpus
(corpus.sqlite, opened read-only) and machine English either from the site's
web/data/texts/<id>.json or from the corpus translations table, then writes:

  web/t/<id>.html   one page per curated text (plain HTML, no JS required)
  web/t/c/<slug>.html  one page per category (curated.json "categories")
  web/t/index.html  grid of categories (+ uncategorised curated texts)
  web/sitemap.xml

Each text's "hooks" must be verbatim substrings of one line of its machine
English and must not contain known-misread terms; the build fails otherwise.

ATF is only reproduced when the source allows republication
(sources.can_republish_atf = 1); otherwise the page links to the source.

Usage: python3 scripts/build_static.py [--db PATH] [--base-url URL]
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sqlite3
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CURATED = WEB / "data-curated" / "curated.json"
SITE_JSON = WEB / "site.json"  # site name + header/footer links (single source)
SITE = json.loads(SITE_JSON.read_text())

ICONS = {
    "x": '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.9-6.4L6.3 22H3.2l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20z"/></svg>',
    "github": '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
}


def site_links_html() -> str:
    out = []
    for l in SITE.get("links", []):
        out.append(
            f'<a class="social-link" href="{html.escape(l["url"])}" target="_blank" rel="me noopener" '
            f'title="{html.escape(l.get("title", l["label"]))}">{ICONS.get(l["id"], "")}<span>{html.escape(l["label"])}</span></a>'
        )
    return "".join(out)


def apply_site_config(path: Path) -> None:
    """Fill marked regions of a hand-written HTML page from web/site.json.

    <title data-site-title="Prefix">…</title>   -> "Prefix · <name>" (or just <name> if prefix is empty)
    <!--site:name-->…<!--/site:name-->           -> site name
    <!--site:tagline-->…<!--/site:tagline-->     -> tagline
    <!--site:links-->…<!--/site:links-->         -> X / GitHub links
    """
    t = path.read_text()
    name = html.escape(SITE["name"])
    t = re.sub(
        r'<title data-site-title="([^"]*)">.*?</title>',
        lambda m: f'<title data-site-title="{m.group(1)}">{(m.group(1) + " · ") if m.group(1) else ""}{name}</title>',
        t, flags=re.S)
    t = re.sub(r"<!--site:name-->.*?<!--/site:name-->", f"<!--site:name-->{name}<!--/site:name-->", t, flags=re.S)
    t = re.sub(r"<!--site:tagline-->.*?<!--/site:tagline-->",
               f"<!--site:tagline-->{html.escape(SITE.get('tagline', ''))}<!--/site:tagline-->", t, flags=re.S)
    t = re.sub(r"<!--site:links-->.*?<!--/site:links-->", f"<!--site:links-->{site_links_html()}<!--/site:links-->", t, flags=re.S)
    path.write_text(t)
    print("site config applied to", path)
OUT = WEB / "t"
DEFAULT_DB = ROOT.parent / "unread-db" / "corpus.sqlite"

CATALOG = ROOT / "data" / "catalog.json"
import sys as _sys  # noqa: E402
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from fix_catalog_sites import usable_site  # noqa: E402
from font_map import font_face_css, font_for, font_info, font_stack  # noqa: E402

READINGS = ROOT / "data" / "atf_unicode_readings.json"
_RMAP = None


def atf_to_unicode(atf: str) -> tuple[str, float]:
    """Python port of web/js/atf2unicode.js convertLine (offline eBL reading map). -> (text, coverage)"""
    global _RMAP
    if _RMAP is None:
        _RMAP = json.loads(READINGS.read_text())
    if not atf or not atf.strip():
        return "", 1.0
    out, mapped, total = [], 0, 0
    for part in re.split(r"(\s+|-|\.|:)", atf):
        if not part:
            continue
        if re.fullmatch(r"\s+", part):
            out.append(" ")
            continue
        if part in ("-", ".", ":"):
            continue
        t = part.strip()
        t = re.sub(r"[#?!*]+$", "", t)
        t = re.sub(r"^[#?!*]+", "", t)
        t = re.sub(r"[{}]", "", t)
        t = re.sub(r"[⸢⸣⌜⌝]", "", t)
        t = re.sub(r"^_+|_+$", "", t)
        if re.fullmatch(r"x+", t, re.I):
            out.append("×")
            continue
        key = t.lower()
        if not key or re.fullmatch(r"""[\[\]()<>|\\/,;='"+]+""", key):
            continue
        total += 1
        cps = _RMAP["multi"].get(key) or _RMAP["readings"].get(key)
        if not cps:
            stripped = re.sub(r"\d+$", "", re.sub(r"[₀-₉]+$", "", key))
            if stripped != key:
                cps = _RMAP["multi"].get(stripped) or _RMAP["readings"].get(stripped)
        if cps:
            mapped += 1
            out.append("".join(chr(int(c)) for c in cps))
        else:
            out.append("·")
    return re.sub(r" +", " ", "".join(out)).strip(), (mapped / total if total else 1.0)
# Placeholder coordinates seen in upstream metadata (not a real find-spot)
PLACEHOLDER_COORDS = [(51.2297, 58.6555)]
# Hooks must not quote lines that depend on known misreads (see training-bugs.md)
FORBIDDEN_HOOK = re.compile(r"libat|ziggur|oil of a brother|brother", re.I)

SOURCE_URLS = {
    "cdli": "https://cdli.earth/artifacts/{num}",
    "ebl": "https://www.ebl.lmu.de/library/{id}",
}

e = html.escape


def slug(text_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", text_id)


def source_link(src: str, text_id: str) -> str | None:
    tpl = SOURCE_URLS.get(src)
    if not tpl:
        return None
    return tpl.format(id=quote(text_id), num=text_id.lstrip("P").lstrip("0") if text_id.startswith("P") else text_id)


def findspot_known(lat, lon, prov) -> bool:
    """Same rule as fix_catalog_sites.usable_site (placeholder coords / no usable site -> unknown)."""
    return usable_site(prov or "", lat, lon)


def load_catalog() -> dict:
    data = json.loads(CATALOG.read_text())
    items = data["items"] if isinstance(data, dict) else data
    return {i["id"]: i for i in items}


def load_lines(db: sqlite3.Connection, item: dict) -> list[dict]:
    """Return [{kind:'line'|'surface', n, atf, english}]"""
    tid, src = item["id"], item["source_id"]
    rows: list[dict] = []
    if item["english_source"] == "site_json":
        data = json.loads((WEB / "data" / "texts" / f"{tid}.json").read_text())
        cur = None
        for ln in data.get("lines", []):
            if ln.get("type") != "line":
                continue
            surf = " ".join(x for x in (ln.get("surface"), ln.get("column")) if x)
            if surf and surf != cur:
                rows.append({"kind": "surface", "label": surf})
                cur = surf
            rows.append({"kind": "line", "n": ln.get("n", ""), "atf": ln.get("atf", ""), "english": ln.get("english") or ""})
        return rows
    tr = {
        r[0]: r[1]
        for r in db.execute(
            "SELECT line_ref, content FROM translations WHERE text_id=? AND source_id=? AND lang='en' "
            "AND author_type='model' AND version=?",
            (tid, src, item["model_version"]),
        )
    }
    cur = None
    used = set()
    for seq, line_no, surface, atf in db.execute(
        "SELECT seq, line_no, surface, atf FROM lines WHERE text_id=? AND source_id=? ORDER BY seq", (tid, src)
    ):
        if surface and surface != cur:
            rows.append({"kind": "surface", "label": surface})
            cur = surface
        # model line_ref is "<surface> <line_no>" when the line has a surface, else just line_no
        key = f"{surface} {line_no}".strip() if surface else (line_no or "")
        en = tr.get(key, "")
        if en:
            used.add(key)
        rows.append({"kind": "line", "n": line_no or str(seq), "atf": atf or "", "english": en})
    missing = set(tr) - used
    if missing:
        print(f"  note: {tid}: {len(missing)} model line(s) did not match a corpus line (e.g. {sorted(missing)[:3]})")
    return rows


def match_hooks(item: dict, rows: list[dict]) -> list[dict]:
    """Locate each hook verbatim in one line of English; fail the build otherwise."""
    out = []
    for h in item.get("hooks", []):
        if FORBIDDEN_HOOK.search(h):
            raise SystemExit(f"{item['id']}: hook uses a known-misread term: {h!r}")
        hit = next((r for r in rows if r["kind"] == "line" and h in r["english"]), None)
        if not hit:
            raise SystemExit(f"{item['id']}: hook is not a verbatim substring of its machine English: {h!r}")
        line = hit["english"].strip()
        txt = h.strip()
        if not line.startswith(txt):
            txt = "…" + txt
        if not line.endswith(h.strip()):
            txt = txt + "…"
        out.append({"text": txt, "n": hit["n"]})
    return out


# Link-preview image (web/og.jpg, 1200x675); absolute URL so every crawler resolves it
OG_IMAGE = "https://ixmon.github.io/unread/og.jpg"
OG_IMAGE_ALT = "Unread Atlas: Hunt for unread artifacts"


def og_tags(title: str, desc: str, url: str, typ: str = "article") -> str:
    return (
        f'<meta property="og:type" content="{typ}">\n'
        f'<meta property="og:site_name" content="{e(SITE["name"])}">\n'
        f'<meta property="og:title" content="{e(title)}">\n'
        f'<meta property="og:description" content="{e(desc)}">\n'
        f'<meta property="og:url" content="{e(url)}">\n'
        f'<meta property="og:image" content="{e(OG_IMAGE)}">\n'
        f'<meta property="og:image:width" content="1200">\n'
        f'<meta property="og:image:height" content="675">\n'
        f'<meta property="og:image:alt" content="{e(OG_IMAGE_ALT)}">\n'
        '<meta name="twitter:card" content="summary_large_image">\n'
        '<meta name="twitter:creator" content="@roguesamurai">\n'
        f'<meta name="twitter:image" content="{e(OG_IMAGE)}">\n'
        f'<meta name="twitter:image:alt" content="{e(OG_IMAGE_ALT)}">\n'
        '<meta name="theme-color" content="#0f1114">'
    )


def page(title: str, desc: str, body: str, canonical: str, depth: str = "../", typ: str = "article", head_extra: str = "", foot_extra: str = "") -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} · {e(SITE["name"])}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(canonical)}">
<link rel="icon" href="{depth}favicon.svg" type="image/svg+xml">
{og_tags(title, desc, canonical, typ)}
<link rel="stylesheet" href="{depth}css/styles.css">
<link rel="stylesheet" href="{depth}css/static.css">{head_extra}
</head>
<body class="static-page">
<header class="static-header">
<a class="brand" href="{depth}index.html">{e(SITE["name"])}</a>
<nav aria-label="Main">
<a class="nav-link" href="{depth}index.html">Explore &amp; map</a>
<a class="nav-link" href="{depth}t/index.html">Curated texts</a>
<a class="nav-link" href="{depth}translate.html">Translator</a>
</nav>
</header>
<main class="static-main">
{body}
</main>
<footer class="static-footer"><div class="footer-links">{site_links_html()}</div>{foot_extra}English on these pages is machine-generated (draft) and is not a scholarly edition.
Generated by scripts/build_static.py on {dt.date.today().isoformat()}.</footer>
</body>
</html>
"""


def build_text(db, item, sources, base_url, catalog, cats) -> tuple[str, str, dict]:
    tid, src = item["id"], item["source_id"]
    t = db.execute(
        "SELECT designation, language, period, genre, provenience, museum_no, collection, canonical_id, lat, lon, extra_json "
        "FROM texts WHERE id=? AND source_id=?",
        (tid, src),
    ).fetchone()
    if not t:
        raise SystemExit(f"curated text {src}:{tid} not found in corpus")
    designation, language, period, genre, prov, museum, coll, canon, lat, lon, _extra = t
    map_id = tid if src == "cdli" else (canon or tid)
    cat_item = catalog.get(map_id) or catalog.get(tid)
    if not period and cat_item:
        period = cat_item.get("period")
    # keep CDLI's "?" (uncertain attribution) that the map catalog carries, so both views agree
    if cat_item and prov and (cat_item.get("provenience") or "").rstrip(" ?") == prov:
        prov = cat_item["provenience"]
    known = findspot_known(lat, lon, prov)
    # cuneiform face: same rule table and the same fields (catalog first) as the reader
    fpick = lambda k, dbv: (cat_item or {}).get(k) or dbv or ""  # noqa: E731
    font_id = font_for(fpick("language", language), fpick("period", period), fpick("genre", genre))
    finfo = font_info(font_id)
    s = sources.get(src, {})
    can_atf = bool(s.get("can_republish_atf"))
    rows = load_lines(db, item)
    n_lines = sum(1 for r in rows if r["kind"] == "line")
    n_en = sum(1 for r in rows if r["kind"] == "line" and r["english"])
    hooks = match_hooks(item, rows)

    meta = [
        ("Designation", designation), ("Museum no.", museum), ("Collection", coll), ("Language", language),
        ("Period", period), ("Genre", genre), ("Provenience", prov),
        ("Findspot", f"{round(lat, 4)}, {round(lon, 4)}" if known else "find-spot unknown"),
        ("CDLI no.", canon if canon and canon.startswith("P") else None),
        ("Source", f"{s.get('name', src)} — {s.get('license', '')}"),
        ("Lines", f"{n_lines} ({n_en} with machine English)"),
        ("Font", f"{finfo['family']} ({finfo['label']}), by {finfo['author']}" if can_atf else None),
    ]
    meta_html = "".join(f"<tr><th>{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in meta if v)
    links = []
    sl = source_link(src, tid)
    if sl:
        links.append(f'<a href="{e(sl)}" rel="noopener">View at {e(s.get("name", src))}</a>')
    if canon and canon.startswith("P") and src != "cdli":
        links.append(f'<a href="https://cdli.earth/artifacts/{e(canon.lstrip("P").lstrip("0"))}" rel="noopener">CDLI {e(canon)}</a>')
    if cat_item:
        links.append(f'<a href="../index.html?id={quote(cat_item["id"])}">Open in the reader &amp; map</a>')
    links.append('<a href="../translate.html">Try the in-browser translator</a>')

    draft = (
        f'<p class="machine-draft"><strong>Machine draft.</strong> English generated by model '
        f'<code>{e(item["model"])}</code>{(" (" + e(item["model_repo"]) + ")") if item.get("model_repo") else ""} '
        f'(version {e(item["model_version"])}) on {e(item["translated_on"])}, '
        f'line by line from the ATF. Not a scholarly translation.</p>'
    )
    trs = []
    for r in rows:
        if r["kind"] == "surface":
            trs.append(f'<tr class="surface-row"><td colspan="{4 if can_atf else 2}">{e(r["label"])}</td></tr>')
            continue
        atf_cell = ""
        if can_atf:
            cu, cov = atf_to_unicode(r["atf"])
            dim = ' style="opacity:0.55"' if cov < 0.4 else ""
            atf_cell = (f'<td class="atf">{e(r["atf"])}</td>'
                        f'<td class="cunei" lang="und-Xsux"{dim} title="{round(cov * 100)}% of signs mapped">{e(cu or "·")}</td>')
        trs.append(f'<tr><td class="ln">{e(r["n"])}</td>{atf_cell}<td>{e(r["english"])}</td></tr>')
    atf_head = '<th>ATF</th><th>Cuneiform</th>' if can_atf else ""
    withheld = (
        ""
        if can_atf
        else f'<p class="withheld">The transliteration is not reproduced here because the source ({e(s.get("name", src))}) '
        f'is not marked as republishable; read it at the source link above.</p>'
    )
    badge = "" if can_atf else '<span class="badge badge-mt-only">machine English only</span> '
    in_cats = [c for c in cats if c["slug"] in item.get("categories", [])]
    crumbs = (
        '<p class="crumbs">In ' + ", ".join(f'<a href="c/{e(c["slug"])}.html">{e(c["title"])}</a>' for c in in_cats) + "</p>"
        if in_cats else ""
    )
    body = f"""<article>
{crumbs}
<h1>{e(item["title"])}</h1>
<p class="tags"><span class="badge badge-draft">machine draft</span> {badge}</p>
<p class="lede">{e(item.get("blurb", ""))}</p>
<p>{" · ".join(links)}</p>
<table class="meta-table">{meta_html}</table>
{draft}
{withheld}
<table class="lines-table">
<thead><tr><th>Line</th>{atf_head}<th>English (machine draft)</th></tr></thead>
<tbody>
{chr(10).join(trs)}
</tbody>
</table>
</article>"""
    url = f"{base_url}t/{slug(tid)}.html"
    card = {
        "item": item, "designation": designation, "period": period,
        "site": prov if known else "find-spot unknown", "can_atf": can_atf, "hooks": hooks,
        "source_name": s.get("name", src), "n_en": n_en,
    }
    head_extra = foot_extra = ""
    if can_atf:
        head_extra = (f"\n<style>\n{font_face_css([font_id], '../fonts/')}\n"
                      f".lines-table td.cunei{{font-family:{font_stack(font_id)}}}\n</style>")
        foot_extra = (f'<div class="font-credit">Cuneiform: <em>{e(finfo["family"])}</em> by {e(finfo["author"])} '
                      f'({e(finfo["license"])}); converted offline from the ATF with the eBL reading map. '
                      f'<a href="../index.html#font-credits">Font credits</a>.</div>')
    return page(item["title"], item.get("blurb", ""), body, url, head_extra=head_extra, foot_extra=foot_extra), url, card


def first_sentence(t: str) -> str:
    m = re.match(r"(.+?[.!?])(\s|$)", t)
    return m.group(1) if m else t


def text_card(c: dict, href_prefix: str) -> str:
    it = c["item"]
    hooks = "".join(
        f'<blockquote class="hook">\u201c{e(h["text"])}\u201d<span class="hook-ref">line {e(h["n"])}</span></blockquote>'
        for h in c["hooks"][:1]
    )
    badges = '<span class="badge badge-draft">machine draft</span>'
    if not c["can_atf"]:
        badges += ' <span class="badge badge-mt-only" title="The source does not allow republishing the transliteration">machine English only</span>'
    facts = " · ".join(e(x) for x in (c["designation"], c["site"], c["period"] or "period not recorded") if x)
    href = f'{href_prefix}{e(slug(it["id"]))}.html'
    return (
        f'<li class="tcard"><h3><a href="{href}">{e(it["title"])}</a></h3>'
        f'<div class="facts">{facts}</div>{hooks}'
        f'<p class="sub">{e(it.get("blurb", ""))}</p>'
        f'<div class="tags">{badges}</div>'
        f'<a class="more" href="{href}">Read the tablet \u2192</a></li>'
    )


def soon_card(x: dict) -> str:
    link = (
        f' <a href="https://cdli.earth/artifacts/{e(x["cdli"].lstrip("P").lstrip("0"))}" rel="noopener">CDLI {e(x["cdli"])}</a>'
        if x.get("cdli") else ""
    )
    facts = " · ".join(e(v) for v in (x.get("designation"), x.get("site"), x.get("period")) if v)
    return (
        f'<li class="tcard soon"><h3>{e(x["title"])}</h3><div class="facts">{facts}</div>'
        f'<p class="sub">{e(x.get("note", ""))}</p>'
        f'<div class="tags"><span class="badge badge-soon">coming soon</span>{link}</div></li>'
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--base-url", default=None)
    a = ap.parse_args()
    cur = json.loads(CURATED.read_text())
    base = (a.base_url or cur.get("site_base_url", "")).rstrip("/") + "/"
    db = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    db.row_factory = None
    sources = {
        r[0]: {"name": r[1], "license": r[2], "can_republish_atf": r[3]}
        for r in db.execute("SELECT id, name, license, can_republish_atf FROM sources")
    }
    catalog = load_catalog()
    cats = sorted(cur.get("categories", []), key=lambda c: cur["categories"].index(c))
    known_slugs = {c["slug"] for c in cats}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "c").mkdir(exist_ok=True)
    urls = [base, f"{base}translate.html", f"{base}t/index.html"]
    cards = []
    seen = set()
    for item in cur["texts"]:
        if item["id"] in seen:
            raise SystemExit(f"duplicate curated id {item['id']}")
        seen.add(item["id"])
        bad = set(item.get("categories", [])) - known_slugs
        if bad:
            raise SystemExit(f"{item['id']}: unknown categories {bad}")
        html_text, url, card = build_text(db, item, sources, base, catalog, cats)
        (OUT / f"{slug(item['id'])}.html").write_text(html_text)
        urls.append(url)
        cards.append(card)
        print("wrote", OUT / f"{slug(item['id'])}.html")

    # category pages
    tiles = []
    for c in cats:
        mine = [cd for cd in cards if c["slug"] in cd["item"].get("categories", [])]
        soon = c.get("coming_soon", [])
        app_link = (
            f'<p><a href="../../index.html?mode={quote(c["app_mode"])}">Browse more {e(c["title"].lower())} texts in the map &amp; reader</a></p>'
            if c.get("app_mode") else ""
        )
        soon_html = (
            '<h2>Coming soon</h2><p class="lede">These tablets have no transliteration in our corpus yet, '
            "so there is nothing to translate. We list them so you know they are on the way.</p>"
            f'<ul class="tcard-grid">{"".join(soon_card(x) for x in soon)}</ul>'
            if soon else ""
        )
        body = (
            f'<p class="crumbs"><a href="../index.html">Curated texts</a> / {e(c["title"])}</p>'
            f'<h1>{e(c["title"])}</h1><p class="lede">{e(c["blurb"])}</p>'
            '<p class="machine-draft"><strong>Machine drafts.</strong> Every English quotation here is unedited output of an '
            "ATF-to-English model, not a scholarly translation. Each card names its source; cards marked "
            "<em>machine English only</em> come from sources (eBL) whose transliterations we do not republish.</p>"
            f'{c.get("explainer_html", "")}'
            f'<h2>{len(mine)} tablet{"s" if len(mine) != 1 else ""}</h2>'
            f'<ul class="tcard-grid">{"".join(text_card(cd, "../") for cd in mine)}</ul>'
            f"{soon_html}{app_link}"
        )
        curl = f"{base}t/c/{c['slug']}.html"
        desc = f"{first_sentence(c['blurb'])} {len(mine)} tablets with machine-draft English."
        (OUT / "c" / f"{c['slug']}.html").write_text(page(f"{c['title']}: curated cuneiform texts", desc, body, curl, depth="../../", typ="website"))
        urls.append(curl)
        print("wrote", OUT / "c" / f"{c['slug']}.html", f"({len(mine)} texts, {len(soon)} coming soon)")
        extra = f' <span class="soon-count">+{len(soon)} coming soon</span>' if soon else ""
        tiles.append(
            f'<li class="cat-tile"><a href="c/{e(c["slug"])}.html"><h2>{e(c["title"])}</h2>'
            f'<div class="count">{len(mine)} tablet{"s" if len(mine) != 1 else ""}{extra}</div>'
            f'<p class="sub">{e(first_sentence(c["blurb"]))}</p></a></li>'
        )
    other = [cd for cd in cards if not cd["item"].get("categories")]
    other_html = (
        f'<h2>Other curated texts</h2><ul class="tcard-grid">{"".join(text_card(cd, "") for cd in other)}</ul>' if other else ""
    )
    idx = page(
        "Curated texts",
        "Hand-picked cuneiform texts with machine-draft English, grouped into remedies, omens, epics, math, love and music.",
        "<h1>Curated texts</h1><p class=\"lede\">Hand-picked tablets with machine-draft English, grouped by theme. "
        "Each text page is plain HTML: transliteration (where licensing allows), line-by-line machine English, and metadata.</p>"
        f'<ul class="cat-grid">{"".join(tiles)}</ul>{other_html}',
        f"{base}t/index.html",
        typ="website",
    )
    (OUT / "index.html").write_text(idx)
    today = dt.date.today().isoformat()
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sm += [f"  <url><loc>{e(u)}</loc><lastmod>{today}</lastmod></url>" for u in urls]
    sm.append("</urlset>")
    (WEB / "sitemap.xml").write_text("\n".join(sm) + "\n")
    # Note: crawlers only read robots.txt at the host root (ixmon.github.io/robots.txt, i.e. the
    # user-site repo); this copy documents intent and points to the sitemap for anyone who looks.
    (WEB / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {base}sitemap.xml\n")
    for pth in (WEB / "index.html", WEB / "translate.html"):
        apply_site_config(pth)
    total_en = sum(cd["n_en"] for cd in cards)
    print("wrote", OUT / "index.html", "and", WEB / "sitemap.xml", f"({len(urls)} urls); curated MT lines: {total_en}")


if __name__ == "__main__":
    main()
