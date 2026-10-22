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
}

ap = argparse.ArgumentParser()
ap.add_argument("--db", default=os.path.expanduser("~/cursor/unread-db/corpus.sqlite"))
a = ap.parse_args()
con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
out = {k: con.execute(q).fetchone()[0] for k, q in Q.items()}
row = con.execute("SELECT value FROM build_info WHERE key='built_at'").fetchone()
out["corpus_built_at"] = row[0] if row else None
out["queries"] = Q
p = Path(__file__).resolve().parent.parent / "web" / "corpus_stats.json"
p.write_text(json.dumps(out, indent=1) + "\n")
print(p, {k: v for k, v in out.items() if k != "queries"})
