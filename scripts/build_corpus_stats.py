#!/usr/bin/env python3
"""Write web/corpus_stats.json: whole-corpus counts for the map header.

Counts are distinct tablets (canonical_id) in the corpus DB, not per-source records.
Usage: python3 scripts/build_corpus_stats.py [--db ~/cursor/unread-db/corpus.sqlite]
"""
import argparse, json, os, sqlite3
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
out["queries"] = Q
p = Path(__file__).resolve().parent.parent / "web" / "corpus_stats.json"
p.write_text(json.dumps(out, indent=1) + "\n")
print(p, {k: v for k, v in out.items() if k != "queries"})
