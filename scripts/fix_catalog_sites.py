#!/usr/bin/env python3
"""Repair find-spots in data/catalog.json and data/texts/<id>.json from the corpus DB.

Run after scripts/build_catalog.py (idempotent). Two fixes:

1. "uncertain (mod. X)" proveniences. build_catalog.normalize_site used to prefix-match every
   "uncertain …" provenience onto the "uncertain (mod. Behistun)" site, so they all got pinned
   at Behistun. Now:
     * X is a named modern site and the corpus DB has real coordinates for it -> pin there
       (site = the provenience, e.g. "uncertain (mod. Abu Salabikh)");
     * X is uncertain/unclear, a region (Babylonia, northern Babylonia), or the DB only has the
       placeholder coordinates -> no coordinates (the map shows no pin; reader says
       "find-spot unknown").
2. Curated texts (web/data-curated/curated.json) get the corpus DB's provenience and coordinates
   (rounded to 4 dp) so the map/reader and the static t/<id>.html page agree.

Usage: python3 scripts/fix_catalog_sites.py [--db PATH] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
TEXTS = ROOT / "data" / "texts"
CURATED = ROOT / "web" / "data-curated" / "curated.json"
DEFAULT_DB = ROOT.parent / "unread-db" / "corpus.sqlite"
PLACEHOLDER_COORDS = [(51.2297, 58.6555)]
REGIONS = re.compile(r"^(northern |southern |central )?(babylonia|assyria|mesopotamia|iran|syria|anatolia)$", re.I)
UNKNOWN = re.compile(r"^(uncertain|unclear|unknown)$", re.I)


def is_placeholder(lat, lon) -> bool:
    return any(abs(lat - a) < 1e-3 and abs(lon - b) < 1e-3 for a, b in PLACEHOLDER_COORDS)


def parse(prov: str):
    """'Ancient (mod. Modern) ?' -> (ancient, modern)"""
    p = (prov or "").strip().rstrip(" ?").strip()
    m = re.match(r"^(.*?)\s*\(mod\.\s*(.*?)\)$", p)
    return (m.group(1).strip(), m.group(2).strip()) if m else (p, "")


def usable_site(prov: str, lat, lon) -> bool:
    """A find-spot we can pin: real coordinates and a named modern site (or a named ancient city)."""
    if lat is None or lon is None or is_placeholder(lat, lon):
        return False
    ancient, modern = parse(prov)
    if not ancient and not modern:
        return False
    if modern and UNKNOWN.match(modern):  # e.g. "Irisagrig (mod. uncertain)": modern location unknown
        return False
    if UNKNOWN.match(ancient) and (not modern or REGIONS.match(modern)):
        return False
    if REGIONS.match(ancient) and not modern:
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    db = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    cat = json.loads(CATALOG.read_text())
    cur = json.loads(CURATED.read_text())
    curated_ids = set()
    for t in cur["texts"]:
        if t["source_id"] == "cdli":
            curated_ids.add(t["id"])
        else:
            r = db.execute("SELECT canonical_id FROM texts WHERE id=? AND source_id=?", (t["id"], t["source_id"])).fetchone()
            if r and r[0]:
                curated_ids.add(r[0])

    def dbrow(pid):
        return db.execute("SELECT provenience, lat, lon FROM texts WHERE id=? AND source_id='cdli'", (pid,)).fetchone()

    site_keys = list(cat.get("sites", {})) + sorted({i.get("site") for i in cat["items"] if i.get("site") and i.get("lat") is not None})
    changes = []
    for it in cat["items"]:
        pid = it["id"]
        prov = it.get("provenience") or ""
        before = (it.get("provenience"), it.get("site"), it.get("lat"), it.get("lon"))
        if pid in curated_ids:
            r = dbrow(pid)
            if r:
                dprov, dlat, dlon = r
                # keep CDLI's trailing "?" (uncertain attribution) when it is the only difference
                if dprov and not (prov.rstrip(" ?") == dprov and prov.endswith("?")):
                    it["provenience"] = dprov
                if dlat is not None and dlon is not None and usable_site(it["provenience"], dlat, dlon):
                    it["lat"], it["lon"] = round(dlat, 4), round(dlon, 4)
                    if not it.get("site") or parse(it["site"])[0].lower() != parse(dprov)[0].lower():
                        # group with an existing map site of the same ancient name, if any
                        anc = parse(dprov)[0].lower()
                        it["site"] = next((k for k in site_keys if parse(k)[0].lower() == anc), dprov)
                else:
                    it["lat"] = it["lon"] = None
                    it["site"] = it["provenience"] or None
        elif re.search(r"uncertain|unclear", prov + " " + (it.get("site") or ""), re.I):
            r = dbrow(pid)
            dlat, dlon = (r[1], r[2]) if r else (None, None)
            if usable_site(prov, dlat, dlon):
                it["lat"], it["lon"] = round(dlat, 4), round(dlon, 4)
                it["site"] = prov.rstrip(" ?").strip()
            else:
                it["lat"] = it["lon"] = None
                it["site"] = prov.rstrip(" ?").strip() or None
        after = (it.get("provenience"), it.get("site"), it.get("lat"), it.get("lon"))
        if after != before:
            changes.append((pid, before, after))
            p = TEXTS / f"{pid}.json"
            if p.exists() and not a.dry_run:
                tx = json.loads(p.read_text())
                for k, v in zip(("provenience", "site", "lat", "lon"), after):
                    if k in tx or v is not None:
                        tx[k] = v
                p.write_text(json.dumps(tx, ensure_ascii=False, indent=2) + "\n")
    for pid, b, aft in changes:
        print(f"{pid}: {b} -> {aft}")
    print(f"{len(changes)} catalog items changed")
    if not a.dry_run:
        CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
