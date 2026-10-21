#!/usr/bin/env python3
"""Build web/assets/awaiting_sites.json: per find-spot counts of texts by "awaiting work" state.
Read-only on corpus.sqlite. States (unit = canonical_id), same rules as unread-db/awaiting_counts.py:
  cat  = catalogue only (no ATF)
  atf  = ATF, no English
  mt   = ATF + machine English only
  hum  = ATF + human English
Known-but-unpublished sites come from data/known_sites.json and are copied alongside."""
import sqlite3, collections, json, os, re, sys
DB = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/cursor/unread-db/corpus.sqlite")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
PLACEHOLDER = {(51.23, 58.656)}
UNK = re.compile(r"^(uncertain|unclear|unknown)\b", re.I)
T = {}
for cid, prov, lat, lon, has_atf, lc in c.execute(
        "select canonical_id,provenience,lat,lon,has_atf,line_count from texts"):
    d = T.setdefault(cid, {"prov": None, "ll": None, "atf": False})
    if prov and not d["prov"]: d["prov"] = prov
    if lat is not None and lon is not None and d["ll"] is None: d["ll"] = (round(lat, 3), round(lon, 3))
    if has_atf or (lc or 0) > 0: d["atf"] = True
H = {r[0] for r in c.execute("select distinct canonical_id from translations where author_type='human' and lang='en'")}
M = {r[0] for r in c.execute("select distinct canonical_id from translations where author_type='model'")}
def st(k, d):
    if not d["atf"]: return "cat"
    if k in H: return "hum"
    if k in M: return "mt"
    return "atf"
sites = collections.defaultdict(lambda: {"n": collections.Counter(), "ll": collections.Counter()})
tot = collections.Counter(); unpinned = collections.Counter()
for k, d in T.items():
    s = st(k, d); tot[s] += 1
    p = d["prov"]
    if not p or not d["ll"] or UNK.match(p) or "mod. uncertain" in p or d["ll"] in PLACEHOLDER:
        unpinned[s] += 1; continue
    sites[p]["n"][s] += 1; sites[p]["ll"][d["ll"]] += 1
out = []
for p, v in sites.items():
    (lat, lon), _ = v["ll"].most_common(1)[0]
    n = v["n"]; out.append({"site": p, "lat": lat, "lon": lon, "cat": n["cat"], "atf": n["atf"], "mt": n["mt"], "hum": n["hum"]})
out.sort(key=lambda r: -(r["cat"] + r["atf"] + r["mt"] + r["hum"]))
known = json.load(open(os.path.join(ROOT, "data", "known_sites.json")))
res = {"generated_from": "corpus.sqlite (read-only)", "totals": tot, "unpinned": unpinned, "sites": out, "known_sites": known["sites"]}
dst = os.path.join(ROOT, "web", "assets", "awaiting_sites.json")
json.dump(res, open(dst, "w"), separators=(",", ":"), ensure_ascii=False)
print(dst, len(out), "sites", dict(tot), "unpinned", dict(unpinned))
