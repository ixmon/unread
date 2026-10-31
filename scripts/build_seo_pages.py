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
atf_public=1) are already applied there. Rendering is shared with the tpages Lambda via scripts/tablet_page.py.

Human English is shown only for sources whose web/assets/translation-policy.json entry has show_human=true
(the same table the reader's translation tabs use). Machine English teaser in HTML: min(--mt-html-lines, floor(n_mt/2)), at least 1 when
n_mt >= 2, and 0 when n_mt <= 1 (see tablet_page.mt_teaser_lines). The rest load client-side from the
rate-limited /api/text/<id> endpoint (docs/moat.md, web/js/static-mt.js). ATF stays in HTML
when atf_public=1.

Lines of English for the index threshold = max(publishable human lines, machine lines shown) on the page.
Machine lines the model flags (tr.conf_level 1..3) are dimmed and labelled like the reader's tooltips.

Usage: build_seo_pages.py OUT_DIR [--search-db PATH] [--base-url URL] [--limit N] [--ids ID,ID]
                          [--human-only] [--machine-min-lines N] [--index-min-lines N]
                          [--mt-html-lines N] [--export-date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse, datetime as dt, html, json, os, re, sqlite3, sys, time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tablet_page import (  # noqa: E402
    SITE, OG_IMAGE, MAX_LINES, NAV, e, slug, human_ok, period_range, fmt_year, human_years, clean_author, jsonld, site_short, clip,
    crumbs_ld, page_shell, render_tablet_html, usable_site, surface_short_label,
    mt_teaser_lines, mt_td, LANG_CODE, CONF_TITLES, TR_POLICY,
)

# re-export tablet_shard locally (kept for sign/index builders below)
def tablet_shard(sl: str) -> str:
    """FNV-1a 32-bit over the (ASCII) slug, low byte as 2 hex digits; mirrored in web/map.html."""
    h = 0x811C9DC5
    for ch in sl:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h & 0xFF:02x}"

DEFAULT_DB = ROOT.parent / "aws-cunei-search" / "out" / "unread-atlas-search.sqlite"
SITEMAP_MAX = 45000          # URLs per tablet sitemap (protocol limit 50,000)
TABLET_SHARDS = 256


def build_tablets(out: Path, db_path: Path, base: str, limit: int | None,
                  machine_only: bool = True, machine_min: int = 1, ids: list[str] | None = None,
                  index_min: int = 10, export_date: str | None = None, mt_html_lines: int = 5):
    """Write /t/<slug>.html via the shared tablet_page renderer (same HTML as the tpages Lambda)."""
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    built_full = json.loads(c.execute("SELECT value FROM meta WHERE key='built_at'").fetchone()[0])
    if export_date:
        built_full = f"{export_date}T00:00:00Z"
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
    indexable = set(curated)
    beacon = None  # build_site.py stamps the Cloudflare beacon after SEO pages are written
    for key in keys:
        sl = slug(key)
        url = f"{base}t/{sl}.html"
        if sl in curated:
            skipped += 1
            urls.append(url)
            continue
        result = render_tablet_html(
            c, key, base=base, mt_html_lines=mt_html_lines, index_min=index_min,
            export_date=export_date, asset_prefix="../", include_static_meta=True,
            beacon_token=beacon, sources=sources, conf_col=conf_col, built_full=built_full,
        )
        if not result:
            continue
        fp = tdir / f"{result['slug']}.html"
        fp.write_text(result["html"], encoding="utf-8")
        os.utime(fp, (stamp, stamp))
        if result["indexable"]:
            indexable.add(result["slug"])
            n_index += 1
            urls.append(result["url"])  # sitemaps carry indexable pages only
        else:
            n_noindex += 1
    # canonical lookup for the reader: indexable slugs in 256 small shards
    idir = out / "assets" / "tablet-index"
    idir.mkdir(parents=True, exist_ok=True)
    shards = {f"{i:02x}": [] for i in range(TABLET_SHARDS)}
    for sl in indexable:
        shards[tablet_shard(sl)].append(sl)
    for name, sls in shards.items():
        (idir / f"{name}.txt").write_text('\n'.join(sorted(sls)) + ('\n' if sls else ""))
    (out / "assets" / "tablet-pages.json").unlink(missing_ok=True)
    built = built_full[:10]
    build_tablets.counts = {"generated": n_index + n_noindex, "indexable": n_index, "noindex": n_noindex,
                            "curated_kept": skipped, "mt_html_lines_cap": mt_html_lines}
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
        fp.write_text(page_shell(title=title, desc=desc, canonical=url, body=body, ld=ld, active="signs.html", head_extra=head_extra), encoding="utf-8")
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
    ap.add_argument("--mt-html-lines", type=int, default=int(os.environ.get("SEO_MT_HTML_LINES", "5")),
                    help="max machine-English lines in HTML (actual = min(this, floor(n_mt/2)), >=1 if n_mt>=2, 0 if n_mt<=1); 0 = all in HTML")
    a = ap.parse_args()
    out, base = Path(a.out), a.base_url
    t0 = time.time()
    if not Path(a.search_db).exists():
        sys.exit(f"build_seo_pages: search export not found: {a.search_db} (set SEARCH_DB)")
    turls, tmod, skipped = build_tablets(out, Path(a.search_db), base, a.limit, not a.human_only, a.machine_min_lines,
                                         a.ids.split(",") if a.ids else None, a.index_min_lines, a.export_date,
                                         a.mt_html_lines)
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
