#!/usr/bin/env python3
"""Mockup C data: per find-spot breakdown of tablets by digitization/translation state.

Unit = tablet (texts.canonical_id; one tablet can have records in several sources).
Categories (mutually exclusive, first match wins):
  human     - at least one human English translation in corpus.sqlite (CDLI #tr.en, ORACC, eBL #tr.en,
              or Hayden training pairs derived from CDLI/ORACC). Includes eBL English we cannot republish.
  machine   - no human English, but at least one machine (atf-en v2) English line.
  atf_only  - transliteration (ATF) in at least one source, but no English of any kind.
  catalogue - catalogue record only: no ATF in any source (e.g. CDLI catalogue entries). This is NOT
              "undigitized" in general: it only covers tablets someone has catalogued.
Location = first record with lat/lon (CDLI preferred), rounded to 3 decimals like /search/sites.
"""
import json, sqlite3, sys, collections, time
DB = "/home/darkstar/cursor/unread-db/corpus.sqlite"
OUT = sys.argv[1] if len(sys.argv) > 1 else "web/mockups/data/gap_sites.json"
t0 = time.time()
import re
# placeholder find-spots that carry a dummy coordinate; treated as unlocated
BADPROV = re.compile(r"^(uncertain|unclear|unknown)( \(mod\. uncertain\)| location)?$|^\?$", re.I)
con = sqlite3.connect(DB)
human = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='human' and lang='en'"))
model = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='model' and lang='en'"))
print("human", len(human), "model", len(model), round(time.time()-t0, 1), "s", file=sys.stderr)
tabs = {}
q = """select canonical_id, source_id, has_atf, lat, lon, provenience, period from texts
       order by canonical_id, case source_id when 'cdli' then 0 when 'oracc' then 1 else 2 end"""
for cid, src, atf, lat, lon, prov, per in con.execute(q):
    t = tabs.get(cid)
    if t is None:
        t = tabs[cid] = {"atf": 0, "lat": None, "lon": None, "prov": None, "period": None}
    t["atf"] |= int(atf or 0)
    if t["lat"] is None and lat is not None and not BADPROV.match(prov or ""):
        t["lat"], t["lon"], t["prov"] = lat, lon, prov
    if not t["period"] and per:
        t["period"] = per
def cat(cid, t):
    if cid in human: return "human"
    if cid in model: return "machine"
    if t["atf"]: return "atf_only"
    return "catalogue"
sites = {}
totals = collections.Counter(); unloc = collections.Counter()
for cid, t in tabs.items():
    c = cat(cid, t); totals[c] += 1
    if t["lat"] is None:
        unloc[c] += 1; continue
    key = f"{round(t['lat'],3)},{round(t['lon'],3)}"
    s = sites.get(key)
    if s is None:
        s = sites[key] = {"key": key, "lat": round(t["lat"], 3), "lon": round(t["lon"], 3),
                          "names": collections.Counter(), "human": 0, "machine": 0, "atf_only": 0,
                          "catalogue": 0, "periods": collections.Counter()}
    s[c] += 1
    s["names"][t["prov"] or "?"] += 1
    s["periods"][t["period"] or "unknown"] += 1
out = []
for s in sites.values():
    tot = s["human"] + s["machine"] + s["atf_only"] + s["catalogue"]
    s["total"] = tot
    s["site"] = s["names"].most_common(1)[0][0]
    s["untranslated"] = s["atf_only"] + s["catalogue"]          # no English at all
    s["no_human"] = tot - s["human"]
    s["untranslated_share"] = round(s["untranslated"] / tot, 4)
    s["periods"] = s["periods"].most_common(4)
    del s["names"]
    out.append(s)
out.sort(key=lambda s: -s["total"])
doc = {"built_from": "corpus.sqlite (corpus_built_at " + (con.execute("select value from build_info where key='built_at'").fetchone() or ['?'])[0] + ")",
       "unit": "tablet (canonical_id)",
       "definitions": {"human": "has a human English translation (CDLI, ORACC, eBL, or training pairs derived from CDLI/ORACC)",
                       "machine": "no human English; has machine English (atf-en v2)",
                       "atf_only": "transliterated (ATF) but no English of any kind",
                       "catalogue": "catalogue record only, no ATF in any source we hold (not the same as undigitized: uncatalogued tablets are invisible)"},
       "totals": dict(totals), "unlocated": dict(unloc), "tablets": len(tabs), "site_count": len(out), "sites": out}
json.dump(doc, open(OUT, "w"), separators=(",", ":"))
print(json.dumps({k: doc[k] for k in ("totals", "unlocated", "tablets", "site_count")}), round(time.time()-t0, 1), "s", file=sys.stderr)
