#!/usr/bin/env python3
"""SEO wave 1: static, JS-free pages for crawlers, written straight into the build output (not into git).

  <out>/t/<id>.html   one page per tablet with any English we may show: publishable human English (per the policy
                      file) and/or machine English (>= --machine-min-lines lines; --human-only restores the old set).
                      Pages with fewer than --index-min-lines lines of English (default 10) carry
                      <meta name="robots" content="noindex,follow"> and are left out of the sitemaps.
                      The 49 hand-curated pages already in <out>/t/ are left untouched (always indexable).
  <out>/s/<slug>.html one page per sign in assets/signs/signs_index.json (2,493)
  <out>/assets/tablet-index/00.txt … ff.txt   indexable page slugs, sharded by tablet_shard(slug) (~5 KB each);
                      map.html computes slug + shard from ?id= and fetches one shard to set its canonical
  <out>/assets/signs/sign-pages.json   sign id -> page map (signs.html canonicals)
  <out>/sitemap.xml   sitemap index -> sitemap-core.xml (the old web/sitemap.xml), sitemap-signs.xml,
                      sitemap-tablets-N.xml (<= 50,000 URLs each)

Tablet data comes from the public search export (aws-cunei-search/out/unread-atlas-search.sqlite): the same
filtered data the live API serves, so licence rules (eBL ATF and eBL human English withheld, ATF only where
atf_public=1) are already applied there.

Human English is shown only for sources whose web/assets/translation-policy.json entry has show_human=true
(the same table the reader's translation tabs use); machine English is always included as page text.

Lines of English for the index threshold = max(publishable human lines, machine lines shown) on the page.
Machine lines the model flags (tr.conf_level 1..3) are dimmed and labelled like the reader's tooltips.

Usage: build_seo_pages.py OUT_DIR [--search-db PATH] [--base-url URL] [--limit N] [--ids ID,ID]
                          [--human-only] [--machine-min-lines N] [--index-min-lines N] [--export-date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse, datetime as dt, html, json, os, re, sqlite3, sys, time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fix_catalog_sites import usable_site  # noqa: E402

DEFAULT_DB = ROOT.parent / "aws-cunei-search" / "out" / "unread-atlas-search.sqlite"
SITE = json.loads((WEB / "site.json").read_text())
CONF_TITLES = {1: "lower confidence: line is broken", 2: "low confidence: few signs survive", 3: "very low confidence: a guess"}
TR_POLICY = json.loads((WEB / "assets" / "translation-policy.json").read_text()).get("sources", {})


def human_ok(src: str) -> bool:
    """May this source's human English appear on a public page? Unknown sources: no."""
    return (TR_POLICY.get(src) or TR_POLICY.get("unknown") or {}).get("show_human") is True
OG_IMAGE = "https://unreadatlas.com/og.jpg"
MAX_LINES = 600          # per page; longer tablets link to the reader for the rest
SITEMAP_MAX = 45000      # URLs per tablet sitemap (protocol limit 50,000)
e = html.escape

# approximate date ranges (BCE negative) for schema.org temporalCoverage; first match wins
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


def period_range(p):
    for rx, a, b in PERIOD_RANGES:
        if p and rx.search(p):
            return a, b
    return None


def fmt_year(y):  # ISO 8601 extended years for schema.org: -2100 BCE -> "-2099"? keep astronomical-ish simple form
    return f"-{abs(y):04d}" if y < 0 else f"{y:04d}"


def human_years(r):
    a, b = r
    f = lambda y: f"{-y} BCE" if y < 0 else f"{y} CE"  # noqa: E731
    return f"c. {f(a)}–{f(b)}"


LANG_CODE = {"sumerian": "sux", "akkadian": "akk", "hittite": "hit", "elamite": "elx", "hurrian": "xhu", "urartian": "xur",
             "ugaritic": "uga", "aramaic": "arc", "greek": "grc", "eblaite": "xeb", "luwian": "xlu"}


def clean_author(a):
    a = re.sub(r"\s*\((CDLI )?translation_source\)|\s*\(see CDLI record\)", "", a or "").strip()
    return None if not a or re.search(r"^(uncertain|unknown|cdli contributor|no translator|translator not named)", a, re.I) else a


def slug(text_id: str) -> str:
    # mirrored in web/map.html (JS: id.replace(/[^A-Za-z0-9._-]/gu, "_")); keep the two in sync
    return re.sub(r"[^A-Za-z0-9._-]", "_", text_id)


TABLET_SHARDS = 256


def tablet_shard(sl: str) -> str:
    """FNV-1a 32-bit over the (ASCII) slug, low byte as 2 hex digits; mirrored in web/map.html."""
    h = 0x811C9DC5
    for ch in sl:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h & 0xFF:02x}"


def jsonld(obj) -> str:
    return '<script type="application/ld+json">' + json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/") + "</script>"


def site_short(p):
    return re.sub(r"\s*\(mod\..*?\)", "", p or "").strip(" ?")


def clip(t, n):
    t = re.sub(r"\s+", " ", t or "").strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


NAV = [("map.html", "Explore &amp; map"), ("browse.html", "Browse"), ("signs.html", "Signs"), ("t/index.html", "Curated texts"),
       ("translate.html", "Translator"), ("search.html", "Search"), ("credits.html", "Credits")]


def page(*, title, desc, canonical, body, ld, active="", og_type="article", head_extra="", noindex=False):
    nav = "\n".join(f'<a class="nav-link{" active" if h == active else ""}" href="../{h}">{l}</a>' for h, l in NAV)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)} · {e(SITE["name"])}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(canonical)}">{chr(10) + '<meta name="robots" content="noindex,follow">' if noindex else ""}
<link rel="icon" href="../favicon.ico" sizes="any">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
<link rel="manifest" href="../site.webmanifest">
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
<link rel="stylesheet" href="../css/styles.css">
<link rel="stylesheet" href="../css/static.css">
<style>.crumbs{{font-size:.85rem;color:var(--text-dim)}}.crumbs a{{color:var(--text-dim)}}.lines-table td.atf{{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85rem}}
.src-note{{font-size:.85rem;color:var(--text-dim)}}.cta a{{margin-right:1rem}}.gl-table td{{padding:.2rem .8rem .2rem 0}}.vals span{{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:.85rem;border:1px solid var(--border);border-radius:5px;padding:0 .4rem;margin:.1rem}}
.lines-table td.conf-1{{opacity:.82}}.lines-table td.conf-2{{opacity:.66;font-style:italic}}.lines-table td.conf-3{{opacity:.52;font-style:italic}}.conf-note{{display:block;font-size:.72rem;font-style:normal;color:var(--text-faint)}}</style>{head_extra}
{jsonld(ld)}
</head>
<body class="static-page">
<header class="static-header">
<a class="brand" href="../">{e(SITE["name"])}</a>
<nav aria-label="Main">
{nav}
</nav>
</header>
<main class="static-main">
{body}
</main>
<footer class="static-footer">{e(SITE["name"])} · <a href="../">Home</a> · <a href="../browse.html">Browse</a> · <a href="../signs.html">Signs</a> · <a href="../t/index.html">Curated texts</a> · <a href="../credits.html">Credits &amp; thanks</a></footer>
</body>
</html>
"""


def crumbs_ld(items):
    return {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": n, "item": u} for i, (n, u) in enumerate(items)]}


# ------------------------------------------------------------------ tablets
def mt_td(m, cf):
    """Machine-English cell; lines the model flags are dimmed and labelled (same levels as the reader)."""
    if cf in CONF_TITLES and m:
        return f'<td class="conf-{cf}" title="{e(CONF_TITLES[cf].capitalize())}">{e(m)}<span class="conf-note">({e(CONF_TITLES[cf])})</span></td>'
    return f"<td>{e(m or '')}</td>"


def build_tablets(out: Path, db_path: Path, base: str, limit: int | None,
                  machine_only: bool = True, machine_min: int = 1, ids: list[str] | None = None,
                  index_min: int = 10, export_date: str | None = None):
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    built_full = json.loads(c.execute("SELECT value FROM meta WHERE key='built_at'").fetchone()[0])
    if export_date:  # the export's meta.built_at is inherited from its base build; the deploy date is more honest
        built_full = f"{export_date}T00:00:00Z"
    built = built_full[:10]
    stamp = dt.datetime.fromisoformat(built_full.replace("Z", "+00:00")).timestamp()
    conf_col = "tr.conf_level" if any(r[1] == "conf_level" for r in c.execute("PRAGMA table_info(tr)")) else "NULL"
    sources = {r["id"]: dict(r) for r in c.execute("SELECT * FROM source")}
    hok = [s for s in sources if human_ok(s)] or ["-"]
    cond = f"(n_human_en>0 AND src IN ({','.join('?' * len(hok))}))" + (" OR n_mt>=?" if machine_only else "")
    keys = [r[0] for r in c.execute(
        f"SELECT DISTINCT coalesce(canonical_id, src||':'||id) FROM text WHERE {cond} ORDER BY 1",
        (*hok, *([machine_min] if machine_only else [])))]
    if ids:
        want = set(ids)
        keys = [k for k in keys if k in want or k.split(":", 1)[-1] in want]
    if limit:
        keys = keys[:limit]
    tdir = out / "t"
    tdir.mkdir(parents=True, exist_ok=True)
    curated = {p.stem for p in tdir.glob("*.html")}
    urls, skipped, n_noindex, n_index = [], 0, 0, 0
    indexable = set(curated)  # hand-written pages are always indexable
    for key in keys:
        sl = slug(key)
        url = f"{base}t/{sl}.html"
        if sl in curated:           # hand-curated page wins, unchanged
            skipped += 1
            urls.append(url)
            continue
        # canonical ids can contain ':' themselves (TLHdig: "tlh:1029_u"), so try the canonical id first
        rows = [r for r in c.execute("SELECT * FROM text WHERE canonical_id=? COLLATE NOCASE", (key,)) if r["canonical_id"] == key]
        by_canonical = bool(rows)
        if not rows and ":" in key:
            src, i = key.split(":", 1)
            rows = c.execute("SELECT * FROM text WHERE src=? AND id=?", (src, i)).fetchall()
        order = {"cdli": 0, "oracc": 1, "tlhdig": 2, "achemenet": 3, "ebl": 4}
        rows = sorted(rows, key=lambda r: order.get(r["src"], 9))
        if not rows:
            continue
        first = lambda k: next((r[k] for r in rows if r[k]), None)  # noqa: E731
        designation = first("designation") or key
        period, genre, lang = first("period"), first("genre"), first("language")
        museum, coll = first("museum_no"), first("collection")
        geo = next((r for r in rows if r["lat"] is not None and usable_site(r["provenience"] or "", r["lat"], r["lon"])), None)
        prov = (geo["provenience"] if geo else None) or first("provenience")
        # human English: every edition that has it, grouped by translator
        hum_rows = [r for r in rows if r["n_human_en"] and human_ok(r["src"])]
        hum = []
        for r in hum_rows:
            for x in c.execute("""SELECT tr.line_ref, tr.content, ts.author, ts.license, ts.edition FROM tr JOIN tr_source ts ON ts.tsid=tr.tsid
                                  WHERE tr.rid=? AND tr.human=1 ORDER BY tr.trid LIMIT ?""", (r["rid"], MAX_LINES)):
                hum.append((r["src"], x))
        if not hum and not machine_only:
            continue
        # transliteration + machine English: first edition whose ATF is public
        atf_row = next((r for r in rows if r["atf_public"] and r["n_lines"]), None)
        lines, mt_meta = [], None
        if atf_row:
            mt = {}
            for x in c.execute(f"""SELECT tr.lid, tr.content, {conf_col} AS conf, ts.author, ts.version, ts.model_label, tr.created FROM tr
                                  JOIN tr_source ts ON ts.tsid=tr.tsid WHERE tr.rid=? AND tr.human=0""", (atf_row["rid"],)):
                if x["lid"] is not None:
                    mt[x["lid"]] = (x["content"], x["conf"] or 0)
                mt_meta = mt_meta or {"repo": x["author"], "label": x["model_label"], "on": (x["created"] or "")[:10], "rev": (x["version"] or "")[:8]}
            for l in c.execute("SELECT lid, line_no, surface, atf FROM line WHERE rid=? ORDER BY seq LIMIT ?", (atf_row["rid"], MAX_LINES)):
                m_, cf = mt.get(l["lid"], (None, 0))
                lines.append((l["surface"], l["line_no"], l["atf"], m_, cf))
        mt_free, mt_free_meta = [], None
        mt_row = next((r for r in rows if r["n_mt"]), None)
        if mt_row is not None and (mt_row is not atf_row or not any(ln[3] for ln in lines)):
            for x in c.execute(f"""SELECT tr.line_ref, tr.content, {conf_col} AS conf, ts.author, ts.version, ts.model_label, tr.created FROM tr
                                  JOIN tr_source ts ON ts.tsid=tr.tsid WHERE tr.rid=? AND tr.human=0 ORDER BY tr.trid LIMIT ?""",
                               (mt_row["rid"], MAX_LINES)):
                mt_free.append((x["line_ref"], x["content"], x["conf"] or 0))
                mt_free_meta = mt_free_meta or {"repo": x["author"], "label": x["model_label"], "on": (x["created"] or "")[:10], "rev": (x["version"] or "")[:8]}
        n_mt_shown = sum(1 for ln in lines if ln[3]) + sum(1 for f in mt_free if f[1])
        if not hum and not n_mt_shown:
            continue
        noindex = max(len(hum), n_mt_shown) < index_min
        rng = period_range(period)
        site = site_short(prov) if prov and (geo or not re.search(r"uncertain|unknown", prov, re.I)) else None
        reader_id = key if by_canonical else key.split(":", 1)[1]
        en_bits, n_ch = [], 0
        en_src = [x["content"] for _, x in hum] or [ln[3] for ln in lines if ln[3]] or [f[1] for f in mt_free]
        for content in en_src:
            t_ = re.sub(r"\s+", " ", content or "").strip()
            if len(t_) > 1 and not re.fullmatch(r"[\W\d.…x]+", t_):
                en_bits.append(t_); n_ch += len(t_) + 1
            if n_ch > 110:
                break
        first_en = clip(" ".join(en_bits), 120)
        title = designation if designation == key else f"{designation} ({key})"
        sub = ", ".join(x for x in [genre, period, site] if x)
        if sub:
            title = f"{title}: {sub}"
        desc = clip(f"{genre or 'Cuneiform'} tablet{(' from ' + site) if site else ''}{(', ' + period) if period else ''}"
                    f"{(' (' + human_years(rng) + ')') if rng else ''}, with {'English translation' if hum else 'machine English draft'}: “{first_en}”", 157)
        if desc.count("“") > desc.count("”"):
            desc += "”"
        # ---- body
        meta = [("Designation", designation), ("ID", key), ("Museum no.", museum), ("Collection", coll), ("Language", lang),
                ("Period", f"{period}{(' · ' + human_years(rng)) if rng else ''}" if period else None), ("Genre", genre),
                ("Find spot", prov), ("Coordinates", f"{geo['lat']:.4f}, {geo['lon']:.4f}" if geo else None)]
        meta_html = "".join(f"<tr><th>{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in meta if v)
        srcs = []
        for r in rows:
            s = sources.get(r["src"], {})
            link = f"https://cdli.earth/{quote(r['id'])}" if r["src"] == "cdli" else (
                f"https://oracc.museum.upenn.edu/{quote(r['project'] or '')}/{quote(r['id'])}" if r["src"] == "oracc" and r["project"] else s.get("url"))
            srcs.append((s.get("name", r["src"]), link, s.get("license", ""), s.get("citation", "")))
        by_tr = {}
        for src, x in hum:
            by_tr.setdefault((x["author"] or "translator not named", x["license"] or sources.get(src, {}).get("license", ""), src), []).append(x)
        hum_html = []
        for (author, lic, src), xs in by_tr.items():
            more = len(xs) - 0
            hum_html.append(f'<h2>English translation</h2><p class="src-note">{("By " + e(clean_author(author)) + " · ") if clean_author(author) else ""}Via {e(sources.get(src, {}).get("name", src))} · {e(lic)}</p>'
                            '<table class="lines-table"><thead><tr><th>Line</th><th>English</th></tr></thead><tbody>'
                            + "".join(f'<tr><td class="ln">{e(x["line_ref"] or "")}</td><td>{e(x["content"] or "")}</td></tr>' for x in xs)
                            + "</tbody></table>")
        atf_html = ""
        if lines:
            rows_h, cur = [], None
            for surf, n, atf, m, cf in lines:
                if surf and surf != cur:
                    rows_h.append(f'<tr class="surface-row"><td colspan="3">{e(surf)}</td></tr>')
                    cur = surf
                rows_h.append(f'<tr><td class="ln">{e(n or "")}</td><td class="atf">{e(atf or "")}</td>{mt_td(m, cf)}</tr>')
            s = sources.get(atf_row["src"], {})
            mt_note = (f'<p class="machine-draft"><strong>Machine draft.</strong> The right-hand column is machine English from '
                       f'<code>{e(mt_meta["repo"] or "")}</code> ({e(mt_meta["label"] or mt_meta["rev"])}, {e(mt_meta["on"])}), '
                       'generated line by line from the transliteration. It is unreviewed and is not a scholarly translation.</p>') if mt_meta else ""
            atf_html = (f'<h2>Transliteration (ATF)</h2><p class="src-note">From {e(s.get("name", atf_row["src"]))} · {e(s.get("license", ""))}</p>{mt_note}'
                        '<table class="lines-table"><thead><tr><th>Line</th><th>ATF</th><th>Machine English (draft)</th></tr></thead><tbody>'
                        + "\n".join(rows_h) + "</tbody></table>"
                        + (f'<p class="src-note">Showing the first {MAX_LINES} lines; <a href="../map.html?id={quote(reader_id)}">open the reader</a> for the rest.</p>'
                           if atf_row["n_lines"] and atf_row["n_lines"] > MAX_LINES else ""))
        if mt_free:
            mm = mt_free_meta
            atf_html += (f'<h2>Machine English (draft)</h2><p class="machine-draft"><strong>Machine draft.</strong> Machine English from '
                         f'<code>{e(mm["repo"] or "")}</code> ({e(mm["label"] or mm["rev"])}, {e(mm["on"])}), generated line by line from the '
                         'source transliteration (not reproduced here). It is unreviewed and is not a scholarly translation.</p>'
                         '<table class="lines-table"><thead><tr><th>Line</th><th>Machine English (draft)</th></tr></thead><tbody>'
                         + "".join(f'<tr><td class="ln">{e(ln or "")}</td>{mt_td(m, cf)}</tr>' for ln, m, cf in mt_free)
                         + "</tbody></table>")
        def _li(n, l, lic, cit):
            nm = f'<a href="{e(l)}" rel="noopener">{e(n)}</a>' if l else e(n)
            return f"<li>{nm} · {e(lic)}" + (" · " + e(cit) if cit else "") + "</li>"
        src_html = "<ul>" + "".join(_li(*x) for x in srcs) + "</ul>"
        browse_q = f"../browse.html?id={quote(reader_id)}"
        body = f"""<article>
<p class="crumbs"><a href="../">Home</a> › <a href="../browse.html">Tablets</a> › {e(key)}</p>
<h1>{e(designation)}{(' <small class="faint">(' + e(key) + ')</small>') if designation != key else ''}</h1>
<p class="lede">{e(sub)}{(' · ' + e(human_years(rng))) if rng else ''}</p>
<p class="cta"><a href="../map.html?id={quote(reader_id)}">Open in the reader &amp; map →</a><a href="{browse_q}">See it among all tablets</a></p>
<table class="meta-table">{meta_html}</table>
{"".join(hum_html)}
{atf_html}
<h2>Sources &amp; licences</h2>{src_html}
<p class="src-note">Cite the original edition and translator. Page generated by Unread Atlas from the public corpus export of {e(built)}.</p>
</article>"""
        cw = {"@type": "ArchiveComponent", "@id": url + "#tablet", "name": designation, "url": url, "identifier": key,
              "description": desc, "genre": genre, "inLanguage": LANG_CODE.get((lang or "").lower(), lang), "dateModified": built,
              "isBasedOn": [l for _, l, _, _ in srcs if l] or None,
              "license": next((lic for _, _, lic, _ in srcs if lic), None),
              "creditText": "; ".join(re.sub(r"\s*\(see [^)]*\)", "", cit) for _, _, _, cit in dict.fromkeys(srcs) if cit) or None,
              "isPartOf": {"@type": "WebSite", "name": SITE["name"], "url": base}}
        if museum or coll:
            cw["holdingArchive"] = {"@type": "ArchiveOrganization", "name": coll or museum}
            if museum:
                cw["alternateName"] = museum
        if rng:
            cw["temporalCoverage"] = f"{fmt_year(rng[0])}/{fmt_year(rng[1])}"
        if prov and (geo or not re.search(r"uncertain|unknown", prov, re.I)):
            place = {"@type": "Place", "name": prov}
            if geo:
                place["geo"] = {"@type": "GeoCoordinates", "latitude": round(geo["lat"], 4), "longitude": round(geo["lon"], 4)}
            cw["locationCreated"] = place
        if by_tr:
            cw["workTranslation"] = {"@type": "CreativeWork", "inLanguage": "en", "name": f"English translation of {designation}",
                                     "author": [{"@type": "Person", "name": a} for a in dict.fromkeys(clean_author(a) for (a, _, _) in by_tr) if a] or None}
        cw = {k: v for k, v in cw.items() if v not in (None, [], "")}
        ld = {"@context": "https://schema.org", "@graph": [cw, crumbs_ld([("Home", base), ("Tablets", base + "browse.html"), (key, url)])]}
        fp = tdir / f"{sl}.html"
        fp.write_text(page(title=title, desc=desc, canonical=url, body=body, ld=ld, noindex=noindex), encoding="utf-8")
        os.utime(fp, (stamp, stamp))  # deterministic mtime: `aws s3 sync` re-uploads only pages whose size changed or a newer export
        if noindex:
            n_noindex += 1
        else:
            n_index += 1
            indexable.add(sl)
            urls.append(url)  # sitemaps carry indexable pages only
    # canonical lookup for the reader: indexable slugs in 256 small shards (one ~5 KB fetch per tablet view)
    idir = out / "assets" / "tablet-index"
    idir.mkdir(parents=True, exist_ok=True)
    shards = {f"{i:02x}": [] for i in range(TABLET_SHARDS)}
    for sl in indexable:
        shards[tablet_shard(sl)].append(sl)
    for name, sls in shards.items():
        (idir / f"{name}.txt").write_text("\n".join(sorted(sls)) + ("\n" if sls else ""))
    (out / "assets" / "tablet-pages.json").unlink(missing_ok=True)
    build_tablets.counts = {"generated": n_index + n_noindex, "indexable": n_index, "noindex": n_noindex, "curated_kept": skipped}
    return urls, built, skipped


# ------------------------------------------------------------------ signs
GLOSS_SRC = {"epsd2": ("ORACC ePSD2 glossary", "CC0"), "epsd2-ogsl": ("ORACC ePSD2 via OGSL", "CC0"),
             "epsd2-ogsl-direct": ("ORACC ePSD2 via OGSL", "CC0"), "oracc-akk": ("ORACC Akkadian glossaries", "CC0"),
             "wiktionary": ("Wiktionary", "CC BY-SA 4.0"), "ebl": ("eBL dictionary", "attributed"), "cooc": ("inferred from CDLI co-occurrence", "derived")}


def pretty(v):
    return v.replace("sz", "š").replace("SZ", "Š").replace("s,", "ṣ").replace("t,", "ṭ").replace("S,", "Ṣ").replace("T,", "Ṭ")


def sign_slug(a):
    s = a.replace("|", "").replace("×", "x").replace("@", "at").replace("~", "-").replace("&", "and").replace("+", "plus").replace("%", "pct")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_") or "sign"


def main_reading(s):
    nm = s["id"].lower().replace("š", "sz").replace("|", "")
    nm = re.sub(r"[₀-₉]", lambda m: str("₀₁₂₃₄₅₆₇₈₉".index(m.group())), nm)
    return nm if nm in s["v"] else next((v for v in s["v"] if "ₓ" not in v and not v.endswith("x")), s["v"][0] if s["v"] else "")


def build_signs(out: Path, base: str):
    idx = json.loads((WEB / "assets" / "signs" / "signs_index.json").read_text())
    det = json.loads((WEB / "assets" / "signs" / "signs_detail.json").read_text())["detail"]
    signs, periods = idx["signs"], idx["meta"]["periods"]
    stamp = (WEB / "assets" / "signs" / "signs_index.json").stat().st_mtime
    lastmod = dt.date.fromtimestamp(stamp).isoformat()
    sdir = out / "s"
    sdir.mkdir(parents=True, exist_ok=True)
    used, pagemap, urls = set(), {}, []
    for s in signs:
        sl = sign_slug(s["a"])
        k = 2
        while sl.lower() in used:
            sl = f"{sign_slug(s['a'])}-{k}"; k += 1
        used.add(sl.lower())
        pagemap[s["a"]] = f"s/{sl}.html"
    for s in signs:
        sl = pagemap[s["a"]][2:-5]
        url = f"{base}s/{sl}.html"
        U = s.get("u") or ""
        name = (det.get(s["a"]) or {}).get("display") or s["id"]
        gsrc = GLOSS_SRC.get(s.get("gs") or "", None)
        gloss = s.get("g")
        readings = [pretty(v) for v in s["v"]]
        mr = main_reading(s)
        title = f"{name} {U} cuneiform sign" + (f": “{gloss}”" if gloss and s.get("gs") != "cooc" else "")
        desc = clip(f"The cuneiform sign {name}{(' (' + U + ', ' + ' '.join(s['cp']) + ')') if s['cp'] else ''}"
                    f"{(': ' + gloss + ' (' + gsrc[0] + ')') if gloss and gsrc else ''}. Readings: {', '.join(readings[:10]) or 'none listed'}. "
                    f"{s['n']:,} uses across the Unread Atlas corpus.", 158)
        gl_rows = ""
        if s.get("gl"):
            if s.get("gs") == "cooc":
                gl_rows = "".join(f"<tr><td><b>{e(g['gw'])}</b></td><td class='faint'>{g.get('n', 0):,} aligned lines · {g.get('lift', '')}× usual rate</td></tr>" for g in s["gl"])
            else:
                gl_rows = "".join(f"<tr><td class='mono'>{e(g.get('cf', ''))}[{e(g['gw'])}]{e(g.get('pos', ''))}</td><td><b>{e(g['gw'])}</b></td>"
                                  f"<td class='faint'>{(str(g['n']) + ' attestations') if g.get('n') else ''}</td></tr>" for g in s["gl"])
        mx = max(s["pb"]) or 1
        bars = "".join(f"<tr><td>{e(p)}</td><td><span style='display:inline-block;height:10px;width:{max(1, round(240 * v / mx))}px;background:#2f4f86;border-radius:2px'></span></td><td class='faint'>{v:,}</td></tr>"
                       for p, v in zip(periods, s["pb"]))
        lists = " · ".join(f"{k} {v}" for k, v in (s.get("lists") or {}).items())
        live = (f'<p class="cta"><a id="live" href="../browse.html?q={quote(mr)}&amp;in=atf">Browse tablets with “{e(pretty(mr))}” →</a>'
                f'<a href="../signs.html?sign={quote(s["a"])}">Interactive view</a><a href="../search.html?q={quote(mr)}">Search “{e(pretty(mr))}”</a></p>') if mr else ""
        font = "UnreadCun" if s.get("uc") else "NotoCun"
        head_extra = (f'\n<style>@font-face{{font-family:{font};src:url(../fonts/{"UnreadCuneiform.woff2" if s.get("uc") else "NotoSansCuneiform.woff2"}) format("woff2")}}'
                      f'.big-sign{{font-family:{font};font-size:96px;line-height:1.1;color:#f3e3c3}}</style>')
        body = f"""<article>
<p class="crumbs"><a href="../">Home</a> › <a href="../signs.html">Signs</a> › {e(name)}</p>
<div class="big-sign" lang="und-Xsux">{e(U) or "—"}</div>
<h1>{e(name)}{(' <small class="faint">' + e(s['id']) + '</small>') if name != s['id'] else ''}</h1>
<p class="lede">{('English: <b>' + e(gloss) + '</b> <span class="src-note">(' + e(gsrc[0]) + ', ' + e(gsrc[1]) + ')</span>') if gloss and gsrc else 'No English gloss in our sources yet.'}</p>
{live}
<table class="meta-table">
<tr><th>eBL name</th><td>{e(s['id'])}</td></tr>
<tr><th>Unicode</th><td>{e(' '.join(s['cp'])) if s['cp'] else ('none (composed in Unread Cuneiform)' if s.get('uc') else 'none')} {e(s.get('uname') or '')}</td></tr>
<tr><th>Sign lists</th><td>{e(lists) or '—'}</td></tr>
<tr><th>Corpus uses</th><td>{s['n']:,} tokens</td></tr>
<tr><th>Live count</th><td id="livecount">{('<a href="../browse.html?q=' + quote(mr) + '&amp;in=atf">tablets with “' + e(pretty(mr)) + '”</a>') if mr else '—'}</td></tr>
</table>
{('<h2>English gloss</h2><table class="gl-table">' + gl_rows + '</table><p class="src-note">' + ('Inferred: English words over-represented in CDLI human translations of lines with this sign; not a dictionary meaning.' if s.get('gs') == 'cooc' else 'Source: ' + e(gsrc[0]) + ' (' + e(gsrc[1]) + ').') + '</p>') if gl_rows and gsrc else ''}
<h2>Readings</h2><div class="vals">{"".join(f"<span>{e(v)}</span>" for v in readings) or '<span>none listed</span>'}</div>
{('<p class="src-note">Also in OGSL: ' + e(', '.join(pretty(v) for v in s['ov'])) + '</p>') if s.get('ov') else ''}
<h2>Use by period</h2><table class="gl-table">{bars}</table>
<p class="src-note">Sign list: eBL (LMU Munich), with OGSL readings and Unicode (ORACC, CC0). Counts: Unread Atlas corpus. <a href="../credits.html#signs">Credits</a>.</p>
</article>
<script>(function(){{var r={json.dumps(mr)};if(!r)return;var A=/^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname)?"https://unreadatlas.com/api":"/api";
fetch(A+"/search/ids?q="+encodeURIComponent(r)+"&in=atf").then(function(x){{return x.json()}}).then(function(j){{if(j&&j.total!=null){{var el=document.getElementById("livecount");el.firstChild.textContent=j.total.toLocaleString()+" tablets have \\u201c"+{json.dumps(pretty(mr))}+"\\u201d in their transliteration"}}}}).catch(function(){{}})}})();</script>"""
        term = {"@type": "DefinedTerm", "@id": url + "#sign", "name": name, "url": url, "termCode": " ".join(s["cp"]) or s["id"],
                "alternateName": [s["id"]] + readings[:20] + ([U] if U else []),
                "description": desc,
                "inDefinedTermSet": {"@type": "DefinedTermSet", "@id": base + "signs.html#set", "name": "Unread Atlas cuneiform sign list", "url": base + "signs.html"}}
        ld = {"@context": "https://schema.org", "@graph": [term, crumbs_ld([("Home", base), ("Signs", base + "signs.html"), (name, url)])]}
        fp = sdir / f"{sl}.html"
        fp.write_text(page(title=title, desc=desc, canonical=url, body=body, ld=ld, active="signs.html", head_extra=head_extra), encoding="utf-8")
        os.utime(fp, (stamp, stamp))
        urls.append(url)
    (out / "assets" / "signs" / "sign-pages.json").write_text(json.dumps(pagemap, ensure_ascii=False, separators=(",", ":")))
    return urls, lastmod


# ------------------------------------------------------------------ sitemaps
def write_urlset(path: Path, urls, lastmod):
    with open(path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u in urls:
            f.write(f"  <url><loc>{html.escape(u)}</loc><lastmod>{lastmod}</lastmod></url>\n")
        f.write("</urlset>\n")


def main_for(out: Path):
    sys.argv = [sys.argv[0], str(out)]
    return main()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--search-db", default=os.environ.get("SEARCH_DB", str(DEFAULT_DB)))
    ap.add_argument("--base-url", default="https://unreadatlas.com/")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--ids", help="comma-separated tablet ids (testing)")
    ap.add_argument("--human-only", action="store_true", default=os.environ.get("SEO_HUMAN_ONLY") == "1",
                    help="old behaviour: pages only for tablets with publishable human English")
    ap.add_argument("--machine-min-lines", type=int, default=int(os.environ.get("SEO_MACHINE_MIN_LINES", "1")),
                    help="machine-only tablets need at least this many machine lines to get a page")
    ap.add_argument("--index-min-lines", type=int, default=int(os.environ.get("SEO_INDEX_MIN_LINES", "10")),
                    help="pages with fewer lines of English are noindex,follow and left out of the sitemaps")
    ap.add_argument("--export-date", default=os.environ.get("SEO_EXPORT_DATE"),
                    help="date shown on pages / sitemap lastmod (default: the export's meta.built_at)")
    a = ap.parse_args()
    out, base = Path(a.out), a.base_url
    t0 = time.time()
    if not Path(a.search_db).exists():
        sys.exit(f"build_seo_pages: search export not found: {a.search_db} (set SEARCH_DB)")
    turls, tmod, skipped = build_tablets(out, Path(a.search_db), base, a.limit, not a.human_only, a.machine_min_lines,
                                         a.ids.split(",") if a.ids else None, a.index_min_lines, a.export_date)
    t1 = time.time()
    surls, smod = build_signs(out, base)
    t2 = time.time()
    # core sitemap = the curated/static list; drop t/ urls that the tablet sitemaps carry
    core = out / "sitemap.xml"
    core_xml = core.read_text()
    tset = set(turls)
    entries = re.findall(r"<url>.*?</url>", core_xml, re.S)
    keep = [x for x in entries if re.search(r"<loc>(.*?)</loc>", x).group(1) not in tset]
    (out / "sitemap-core.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                          + "\n".join("  " + x for x in keep) + "\n</urlset>\n")
    core_mod = max(re.findall(r"<lastmod>(.*?)</lastmod>", core_xml) or [tmod])
    write_urlset(out / "sitemap-signs.xml", surls, smod)
    parts = []
    for i in range(0, len(turls), SITEMAP_MAX):
        name = f"sitemap-tablets-{i // SITEMAP_MAX + 1}.xml"
        write_urlset(out / name, turls[i:i + SITEMAP_MAX], tmod)
        parts.append((name, tmod))
    idx = [("sitemap-core.xml", core_mod), ("sitemap-signs.xml", smod)] + parts
    core.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                    + "".join(f"  <sitemap><loc>{base}{n}</loc><lastmod>{m}</lastmod></sitemap>\n" for n, m in idx) + "</sitemapindex>\n")
    rep = {"tablet_pages": build_tablets.counts, "tablet_sitemap_urls": len(turls), "index_min_lines": a.index_min_lines,
           "sign_pages": len(surls),
           "sitemaps": [n for n, _ in idx], "core_urls": len(keep), "secs": {"tablets": round(t1 - t0, 1), "signs": round(t2 - t1, 1)}}
    print("build_seo_pages:", json.dumps(rep))
    return rep


if __name__ == "__main__":
    main()
