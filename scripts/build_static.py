#!/usr/bin/env python3
"""Build pre-rendered static pages for curated texts.

Reads web/data-curated/curated.json, pulls metadata/ATF from the Unread corpus
(corpus.sqlite, opened read-only) and machine English either from the site's
web/data/texts/<id>.json or from the corpus translations table, then writes:

  web/t/<id>.html   one page per curated text (plain HTML, no JS required)
  web/t/index.html  list of curated texts
  web/sitemap.xml

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
            "SELECT line_ref, content FROM translations WHERE text_id=? AND source_id=? AND lang='en' AND author_type='model'",
            (tid, src),
        )
    }
    cur = None
    for seq, line_no, surface, atf in db.execute(
        "SELECT seq, line_no, surface, atf FROM lines WHERE text_id=? AND source_id=? ORDER BY seq", (tid, src)
    ):
        if surface and surface != cur:
            rows.append({"kind": "surface", "label": surface})
            cur = surface
        rows.append({"kind": "line", "n": line_no or str(seq), "atf": atf or "", "english": tr.get(line_no, "")})
    return rows


def page(title: str, desc: str, body: str, canonical: str, depth: str = "../") -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} · {e(SITE["name"])}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(canonical)}">
<link rel="stylesheet" href="{depth}css/styles.css">
<link rel="stylesheet" href="{depth}css/static.css">
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
<footer class="static-footer"><div class="footer-links">{site_links_html()}</div>English on these pages is machine-generated (draft) and is not a scholarly edition.
Generated by scripts/build_static.py on {dt.date.today().isoformat()}.</footer>
</body>
</html>
"""


def build_text(db, item, sources, base_url) -> tuple[str, str]:
    tid, src = item["id"], item["source_id"]
    t = db.execute(
        "SELECT designation, language, period, genre, provenience, museum_no, collection, canonical_id, lat, lon, extra_json "
        "FROM texts WHERE id=? AND source_id=?",
        (tid, src),
    ).fetchone()
    if not t:
        raise SystemExit(f"curated text {src}:{tid} not found in corpus")
    designation, language, period, genre, prov, museum, coll, canon, lat, lon, _extra = t
    s = sources.get(src, {})
    can_atf = bool(s.get("can_republish_atf"))
    rows = load_lines(db, item)
    n_lines = sum(1 for r in rows if r["kind"] == "line")
    n_en = sum(1 for r in rows if r["kind"] == "line" and r["english"])

    meta = [
        ("Designation", designation), ("Museum no.", museum), ("Collection", coll), ("Language", language),
        ("Period", period), ("Genre", genre), ("Provenience", prov),
        ("Findspot", f"{lat:.4f}, {lon:.4f}" if lat is not None and lon is not None else None),
        ("CDLI no.", canon if canon and canon.startswith("P") else None),
        ("Source", f"{s.get('name', src)} — {s.get('license', '')}"),
        ("Lines", f"{n_lines} ({n_en} with machine English)"),
    ]
    meta_html = "".join(f"<tr><th>{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in meta if v)
    links = []
    sl = source_link(src, tid)
    if sl:
        links.append(f'<a href="{e(sl)}" rel="noopener">View at {e(s.get("name", src))}</a>')
    if canon and canon.startswith("P") and src != "cdli":
        links.append(f'<a href="https://cdli.earth/artifacts/{e(canon.lstrip("P").lstrip("0"))}" rel="noopener">CDLI {e(canon)}</a>')
    map_id = tid if src == "cdli" else (canon or tid)
    links.append(f'<a href="../index.html?id={quote(map_id)}">Open in the reader &amp; map</a>')
    links.append('<a href="../translate.html">Try the in-browser translator</a>')

    draft = (
        f'<p class="machine-draft"><strong>Machine draft.</strong> English generated by model '
        f'<code>{e(item["model"])}</code> (version {e(item["model_version"])}) on {e(item["translated_on"])}, '
        f'line by line from the ATF. Not a scholarly translation.</p>'
    )
    trs = []
    for r in rows:
        if r["kind"] == "surface":
            trs.append(f'<tr class="surface-row"><td colspan="3">{e(r["label"])}</td></tr>')
            continue
        atf_cell = f'<td class="atf">{e(r["atf"])}</td>' if can_atf else ""
        trs.append(f'<tr><td class="ln">{e(r["n"])}</td>{atf_cell}<td>{e(r["english"])}</td></tr>')
    atf_head = "<th>ATF</th>" if can_atf else ""
    withheld = (
        ""
        if can_atf
        else f'<p class="withheld">The transliteration is not reproduced here because the source ({e(s.get("name", src))}) '
        f'is not marked as republishable; read it at the source link above.</p>'
    )
    body = f"""<article>
<h1>{e(item["title"])}</h1>
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
    return page(item["title"], item.get("blurb", ""), body, url), url


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
    OUT.mkdir(parents=True, exist_ok=True)
    urls = [base, f"{base}translate.html", f"{base}t/index.html"]
    items_html = []
    for item in cur["texts"]:
        html_text, url = build_text(db, item, sources, base)
        (OUT / f"{slug(item['id'])}.html").write_text(html_text)
        urls.append(url)
        items_html.append(
            f'<li><a href="{e(slug(item["id"]))}.html"><strong>{e(item["title"])}</strong></a>'
            f'<div class="sub">{e(item.get("blurb", ""))}</div>'
            f'<div class="sub">Machine draft · {e(item["model"])} · {e(item["translated_on"])}</div></li>'
        )
        print("wrote", OUT / f"{slug(item['id'])}.html")
    idx = page(
        "Curated texts",
        "Hand-picked cuneiform texts with machine-draft English translations.",
        "<h1>Curated texts</h1><p class=\"lede\">Hand-picked texts with machine-draft English. "
        "Each page is plain HTML: transliteration (where licensing allows), line-by-line machine English, and metadata.</p>"
        f'<ul class="card-list">{"".join(items_html)}</ul>',
        f"{base}t/index.html",
    )
    (OUT / "index.html").write_text(idx)
    today = dt.date.today().isoformat()
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sm += [f"  <url><loc>{e(u)}</loc><lastmod>{today}</lastmod></url>" for u in urls]
    sm.append("</urlset>")
    (WEB / "sitemap.xml").write_text("\n".join(sm) + "\n")
    for pth in (WEB / "index.html", WEB / "translate.html"):
        apply_site_config(pth)
    print("wrote", OUT / "index.html", "and", WEB / "sitemap.xml", f"({len(urls)} urls)")


if __name__ == "__main__":
    main()
