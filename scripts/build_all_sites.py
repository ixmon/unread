#!/usr/bin/env python3
"""Build web/assets/all-sites.json: every located find-spot in the public search export, with
tablet counts and top periods only (no text, no samples). Same shape and site keys as the API's
/search/sites, so the map can show the whole corpus by default and click through to /search?at=<key>.

  python3 scripts/build_all_sites.py [--db ../aws-cunei-search/out/unread-atlas-search.sqlite]
          [--app ../aws-cunei-search/lambda/app.py]
Reuses the Lambda's own sites() aggregation (and its usable_site rule) with an "everything" filter."""
import argparse, importlib.util, json, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("--db", default=str(ROOT.parent / "aws-cunei-search/out/unread-atlas-search.sqlite"))
ap.add_argument("--app", default=str(ROOT.parent / "aws-cunei-search/lambda/app.py"))
ap.add_argument("--out", default=str(ROOT / "web/assets/all-sites.json"))
a = ap.parse_args()
os.environ["LOCAL_DB"] = a.db
spec = importlib.util.spec_from_file_location("ua_api", a.app)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app._filters = lambda params: (["1=1"], [])  # all texts
app._fetch_texts = lambda c, rids: []         # no samples / text in the static file
st, d = app.sites({"in": "all"})
assert st == 200, d
sites = [{k: s[k] for k in ("key", "site", "lat", "lon", "count", "records", "periods")} for s in d["sites"]]
out = {"q": "", "in": "all", "filters": {}, "all": True, "total": d["total"], "records": d["records"],
       "located": d["located"], "unlocated": d["unlocated"], "site_count": len(sites),
       "total_is_capped": False, "sites": sites, "took_ms": 0}
pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
print(a.out, out["total"], "tablets,", out["located"], "located at", len(sites), "sites,",
      pathlib.Path(a.out).stat().st_size, "bytes")
