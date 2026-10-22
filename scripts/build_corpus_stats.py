#!/usr/bin/env python3
"""Write web/corpus_stats.json, the single source of truth for every corpus number on the site,
then stamp those numbers into the static HTML (so crawlers / og cards / no-JS see the same figures).

Rebuild after ANY corpus or translation update (new corpus.sqlite, new machine English, new source):
    python3 scripts/build_corpus_stats.py [--db ~/cursor/unread-db/corpus.sqlite] [--no-stamp]
scripts/build_site.sh runs it automatically before building dist/.

Counts are distinct tablets (COALESCE(canonical_id,id)) unless the key says "records"
(one row per source project listing; a tablet listed by CDLI and ORACC is 2 records, 1 tablet).

Stamping: in web/*.html and web/t/index.html,
  <span data-stat="tablets">462,298</span>          -> inner text = formatted value (dotted keys ok: sources.cdli.tablets)
  <meta data-stat-tpl="Explore {tablets} ..." content="...">  -> content regenerated from template
  <title data-stat-tpl="Map of {tablets} ..." data-site-title="..."> -> data-site-title + text regenerated
The browser also refills data-stat spans from corpus_stats.json at runtime (web/js/app.js, index.html).
"""
import argparse, datetime, json, os, re, sqlite3
from pathlib import Path

Q = {
    "tablets": "SELECT COUNT(DISTINCT COALESCE(canonical_id,id)) FROM texts",
    "with_text": "SELECT COUNT(DISTINCT COALESCE(canonical_id,id)) FROM texts WHERE has_atf=1",
    "human_en": "SELECT COUNT(DISTINCT canonical_id) FROM translations WHERE lang='en' AND author_type='human'",
    "machine_en": "SELECT COUNT(DISTINCT canonical_id) FROM translations WHERE lang='en' AND author_type='model'",
    "any_en": "SELECT COUNT(DISTINCT canonical_id) FROM translations WHERE lang='en'",
    "text_no_en": "SELECT COUNT(*) FROM (SELECT COALESCE(canonical_id,id) c FROM texts GROUP BY c HAVING MAX(has_atf)=1) "
                  "WHERE c NOT IN (SELECT canonical_id FROM translations WHERE lang='en' AND canonical_id IS NOT NULL)",
    "with_coords": "SELECT COUNT(DISTINCT COALESCE(canonical_id,id)) FROM texts WHERE lat IS NOT NULL",
    "place_names": "SELECT COUNT(DISTINCT provenience) FROM texts WHERE lat IS NOT NULL",
    # Map rule (same as the search API's sites() / usable_site): a named find-spot, not
    # "uncertain"/"unknown"/a bare region or a placeholder coordinate; points grouped at 3-decimal lat,lon.
    "mapped": "SELECT COUNT(DISTINCT COALESCE(canonical_id,id)) FROM texts WHERE usable_site(provenience,lat,lon)=1",
    "map_points": "SELECT COUNT(DISTINCT printf('%.3f,%.3f',lat,lon)) FROM texts WHERE usable_site(provenience,lat,lon)=1",
}

ap = argparse.ArgumentParser()
ap.add_argument("--no-stamp", action="store_true", help="only write corpus_stats.json")
ap.add_argument("--db", default=os.path.expanduser("~/cursor/unread-db/corpus.sqlite"))
a = ap.parse_args()
con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
ap_py = Path(__file__).resolve().parent.parent.parent / "aws-cunei-search/lambda/app.py"
os.environ.setdefault("LOCAL_DB", "/nonexistent")  # only the pure usable_site rule is used
import importlib.util
_s = importlib.util.spec_from_file_location("ua_api", ap_py); _m = importlib.util.module_from_spec(_s); _s.loader.exec_module(_m)
con.create_function("usable_site", 3, _m._usable_site, deterministic=True)
out = {k: con.execute(q).fetchone()[0] for k, q in Q.items()}
row = con.execute("SELECT value FROM build_info WHERE key='built_at'").fetchone()
out["catalogue_only"] = out["tablets"] - out["with_text"]
out["corpus_built_at"] = row[0] if row else None
out["unmapped_coords"] = out["with_coords"] - out["mapped"]
out["pct_human_en"] = round(100 * out["human_en"] / out["tablets"])
out["pct_catalogue_only"] = round(100 * out["catalogue_only"] / out["tablets"])
# one-decimal shares of all catalogued tablets (home "What's here", Stats page, hero caption)
out["pct1"] = {k: round(100 * out[k] / out["tablets"], 1) for k in ("with_text", "human_en", "machine_en", "any_en", "text_no_en", "catalogue_only", "with_coords", "mapped")}
T = "COUNT(DISTINCT COALESCE(canonical_id,id))"
out["sources"] = {r[0]: {"records": r[1], "tablets": r[2]} for r in con.execute(
    f"SELECT source_id, COUNT(*), {T} FROM texts GROUP BY 1 ORDER BY 2 DESC")}
def labels(col, n):
    rows = con.execute(f"SELECT {col}, COUNT(*), {T} FROM texts WHERE COALESCE({col},'')<>'' GROUP BY 1 ORDER BY 3 DESC").fetchall()
    return {"labels": len(rows), "unlabelled_records": con.execute(f"SELECT COUNT(*) FROM texts WHERE COALESCE({col},'')=''").fetchone()[0],
            "top": [{"label": r[0], "records": r[1], "tablets": r[2]} for r in rows[:n]]}
out["periods"] = labels("period", 5)
out["languages"] = labels("language", 5)
out["generated_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
out["notes"] = {"tablets": "distinct COALESCE(canonical_id,id)", "records": "rows in texts (one per source listing)",
                "periods/languages tablets": "distinct tablets carrying that label in at least one source; a tablet can carry labels from several sources"}
out["queries"] = Q
web = Path(__file__).resolve().parent.parent / "web"
p = web / "corpus_stats.json"
p.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(p, {k: v for k, v in out.items() if k not in ("queries", "notes")})

def val(key):
    v = out
    for part in key.split("."):
        v = v[int(part)] if isinstance(v, list) else v[part]
    if isinstance(v, int): return f"{v:,}"
    if key == "corpus_built_at": return str(v)[:10]
    return str(v)
def fill(tpl): return re.sub(r"\{([\w.]+)\}", lambda m: val(m.group(1)), tpl)
if not a.no_stamp:
    for f in sorted(list(web.glob("*.html")) + [web / "t" / "index.html"]):
        if not f.exists(): continue
        h0 = h = f.read_text()
        h = re.sub(r'(<(\w+)[^>]*\bdata-stat="([\w.]+)"[^>]*>)[^<]*(</\2>)', lambda m: m.group(1) + val(m.group(3)) + m.group(4), h)
        def meta(m):
            tag = m.group(0); t = fill(m.group(1))
            return re.sub(r'\bcontent="[^"]*"', f'content="{t}"', tag)
        h = re.sub(r'<meta[^>]*\bdata-stat-tpl="([^"]*)"[^>]*>', meta, h)
        def title(m):
            t = fill(m.group(1)); tag = re.sub(r'data-site-title="[^"]*"', f'data-site-title="{t}"', m.group(0))
            return re.sub(r'>[^<]*</title>', f'>{t} · Unread Atlas</title>', tag)
        h = re.sub(r'<title[^>]*\bdata-stat-tpl="([^"]*)"[^>]*>[^<]*</title>', title, h)
        # JSON-LD WebSite description (index.html)
        h = re.sub(r'("description":"A space-and-time browser for )[\d,]+( cuneiform tablets)', lambda m: m.group(1) + val("tablets") + m.group(2), h)
        if h != h0: f.write_text(h); print("stamped", f.relative_to(web.parent))
