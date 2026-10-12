#!/usr/bin/env python3
"""Browse page (/browse.html) and landing hero data: 'map of maps'. One row per tablet (canonical_id) with every coordinate the
navigator can put on an axis: lon, lat, date (period midpoint, approx. year; negative = BCE),
genre band, translation state. A random background sample of all tablets plus every tablet
matching the preset terms (English, human or machine, word match).

Compact columnar JSON: tablets[i] = [id, lon|null, lat|null, year|null, genre_idx, state_idx, site_idx]
terms[key] = list of row indices. No ATF or English text is copied (licensing-safe).

After rebuilding, run scripts/build_landing_assets.py (derives web/assets/landing_dots.json).
"""
import json, sqlite3, sys, re, random, collections, time
from pathlib import Path
DB = str(Path(__file__).resolve().parent.parent.parent / "unread-db" / "corpus.sqlite")
OUT = sys.argv[1] if len(sys.argv) > 1 else "web/assets/map_of_maps.json"
SAMPLE = int(sys.argv[2]) if len(sys.argv) > 2 else 60000
TERMS = {"barley": "barley", "silver": "silver", "sheep": "sheep"}
BADPROV = re.compile(r"^(uncertain|unclear|unknown)( \(mod\. uncertain\)| location)?$|^\?$", re.I)
# approximate period midpoints (year; negative = BCE). First regex match wins.
PERIODS = [
 (r"pre-?writing|pre-uruk", -3500), (r"uruk v\b", -3300), (r"uruk iv", -3250), (r"uruk iii|proto-elamite|archaic", -3050),
 (r"ed i-ii|early dynastic i-ii", -2800), (r"ed iiia|early dynastic iiia|fara", -2550), (r"ed iiib|early dynastic iiib|presargonic|ebla", -2400),
 (r"early dynastic", -2600), (r"old akkadian|sargonic", -2250), (r"lagas|lagaš ii", -2150), (r"ur iii", -2060),
 (r"early old babylonian", -1950), (r"old assyrian", -1850), (r"old babylonian", -1750), (r"old elamite", -2000),
 (r"middle hittite|hittite", -1350), (r"mitanni", -1450), (r"middle babylonian|sealand", -1300), (r"middle assyrian", -1200),
 (r"middle elamite", -1250), (r"neo-?assyrian|neo assyrian|9th|8th", -800), (r"neo-?elamite|urartian|7th", -650),
 (r"early neo-babylonian", -800), (r"neo-?babylonian|neo babylonian|neo/late", -600), (r"achaemenid|persian", -450),
 (r"late babylonian|first millennium|standard babylonian", -500), (r"hellenistic|seleucid", -200), (r"parthian", 0), (r"sassanian", 400),
 (r"harappan", -2300), (r"linear elamite", -2200)]
PERIODS = [(re.compile(p, re.I), y) for p, y in PERIODS]
GENRES = ["Administrative", "Legal", "Letter", "Lexical", "Literary", "Royal / display", "Religious", "Scholarly", "Other / unknown"]
def genre(g):
    g = (g or "").lower()
    if not g: return 8
    if re.search(r"admin|account|receipt|archival", g) and "letter" not in g: return 0
    if re.search(r"legal|contract|business", g): return 1
    if "letter" in g: return 2
    if "lexical" in g: return 3
    if re.search(r"literary|canonical > literature|epic|hymn|lament|proverb", g): return 4
    if re.search(r"royal|display|inscription", g): return 5
    if re.search(r"prayer|ritual|incantation|cth|religious|liturg", g): return 6
    if re.search(r"astr|divin|omen|medic|math|scholar|technical|canonical", g): return 7
    return 8
STATES = ["Human English", "Machine only", "ATF only", "Catalogue only"]
t0 = time.time()
con = sqlite3.connect(DB)
human = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='human' and lang='en'"))
model = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='model' and lang='en'"))
tabs = {}
for cid, atf, lat, lon, prov, per, gen in con.execute("""select canonical_id, has_atf, lat, lon, provenience, period, genre from texts
        where canonical_id is not null order by canonical_id, case source_id when 'cdli' then 0 when 'oracc' then 1 else 2 end"""):
    t = tabs.get(cid)
    if t is None: t = tabs[cid] = {"atf": 0, "lat": None, "lon": None, "prov": None, "per": None, "gen": None}
    t["atf"] |= int(atf or 0)
    if t["lat"] is None and lat is not None and not BADPROV.match(prov or ""): t["lat"], t["lon"], t["prov"] = lat, lon, prov
    t["per"] = t["per"] or per; t["gen"] = t["gen"] or gen
print("tablets", len(tabs), round(time.time()-t0), "s", file=sys.stderr)
term_ids = {}
for k, w in TERMS.items():
    rx = re.compile(r"\b" + w + r"\b", re.I)
    ids = set(cid for cid, c in con.execute("select canonical_id, content from translations where lang='en' and content like ?", (f"%{w}%",)) if cid in tabs and c and rx.search(c))
    term_ids[k] = ids; print(k, len(ids), round(time.time()-t0), "s", file=sys.stderr)
random.seed(7)
keys = list(tabs)
chosen = set(random.sample(keys, min(SAMPLE, len(keys))))
for ids in term_ids.values(): chosen |= ids
sites, site_idx = [], {}
rows, idx = [], {}
unk_year = collections.Counter()
for cid in sorted(chosen):
    t = tabs[cid]
    st = 0 if cid in human else 1 if cid in model else 2 if t["atf"] else 3
    y = None
    if t["per"]:
        for rx, yy in PERIODS:
            if rx.search(t["per"]): y = yy; break
    if y is None: unk_year[t["per"] or ""] += 1
    si = -1
    if t["lat"] is not None:
        p = t["prov"] or "?"
        if p not in site_idx: site_idx[p] = len(sites); sites.append(p)
        si = site_idx[p]
    idx[cid] = len(rows)
    rows.append([cid, None if t["lon"] is None else round(t["lon"], 3), None if t["lat"] is None else round(t["lat"], 3), y, genre(t["gen"]), st, si])
doc = {"built_from": "corpus.sqlite", "sample_of_all": SAMPLE, "corpus_tablets": len(tabs),
       "genres": GENRES, "states": STATES, "sites": sites,
       "note": "date = approximate midpoint of the period label; genre bands are a coarse grouping of source genre labels; terms match English (human or machine v2) by whole word",
       "tablets": rows, "terms": {k: sorted(idx[c] for c in v) for k, v in term_ids.items()}}
json.dump(doc, open(OUT, "w"), separators=(",", ":"))
st = collections.Counter(r[5] for r in rows)
print(json.dumps({"rows": len(rows), "terms": {k: len(v) for k, v in term_ids.items()}, "located": sum(r[1] is not None for r in rows),
  "dated": sum(r[3] is not None for r in rows), "states": {STATES[k]: v for k, v in st.items()}, "undated_top": unk_year.most_common(8)}), round(time.time()-t0), "s", file=sys.stderr)
