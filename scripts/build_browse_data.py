#!/usr/bin/env python3
"""Browse page (/browse.html) full-corpus data. Every tablet (canonical_id) as a dot, in a compact
columnar binary, plus related-term ("Appears with:") tables and a cuneiform glyph -> reading map.

Outputs (web/assets/):
  browse_all.dat      little-endian columns, N rows sorted by canonical id:
                      lon u16[N] (0xFFFF = no find-spot; lon = -20 + v/65534*100)
                      lat u16[N] (0xFFFF = none;           lat =   0 + v/65534*60)
                      year i16[N] (-32768 = undated)  genre u8[N]  state u8[N]  site u16[N] (0xFFFF none)
  browse_ids.txt      N canonical ids, one per line, same order (search results map by id)
  browse_meta.json    {n, genres, states, sites, built_at, note}
  browse_related.json {"en": {word: [neighbors]}, "atf": {token: [neighbors]}}  NPMI over tablet co-occurrence
  sign_readings.json  {glyph: [readings by corpus frequency]} (from data/atf_unicode_readings.json)
No ATF lines or English sentences are copied (only single words / sign readings).
"""
import json, sqlite3, sys, re, collections, time, struct, math, importlib.util
from array import array
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parent.parent
DB = str(ROOT.parent / "unread-db" / "corpus.sqlite")
OUT = ROOT / "web" / "assets"
src = (ROOT / "scripts" / "build_map_of_maps.py").read_text()
ns = {}
exec(src[src.index("BADPROV"):src.index("t0 = time.time()")], {"re": re, "collections": collections}, ns)  # shared PERIODS/genre()/STATES
BADPROV, PERIODS, GENRES, genre, STATES = ns["BADPROV"], ns["PERIODS"], ns["GENRES"], ns["genre"], ns["STATES"]
t0 = time.time()
def log(*a): print(*a, round(time.time() - t0), "s", file=sys.stderr, flush=True)
con = sqlite3.connect(DB)
human = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='human' and lang='en'"))
model = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='model' and lang='en'"))
tabs, t2c = {}, {}
for cid, sid, tid, atf, lat, lon, prov, per, gen in con.execute("""select canonical_id, source_id, id, has_atf, lat, lon, provenience, period, genre from texts
        where canonical_id is not null order by canonical_id, case source_id when 'cdli' then 0 when 'oracc' then 1 else 2 end"""):
    t2c[(sid, tid)] = cid
    t = tabs.get(cid)
    if t is None: t = tabs[cid] = {"atf": 0, "lat": None, "lon": None, "prov": None, "per": None, "gen": None}
    t["atf"] |= int(atf or 0)
    if t["lat"] is None and lat is not None and not BADPROV.match(prov or ""): t["lat"], t["lon"], t["prov"] = lat, lon, prov
    t["per"] = t["per"] or per; t["gen"] = t["gen"] or gen
ids = sorted(tabs); N = len(ids); log("tablets", N)
cols = {k: array(c, [0]) * N for k, c in (("lon", "H"), ("lat", "H"), ("yr", "h"), ("g", "B"), ("s", "B"), ("site", "H"))}
sites, site_idx = [], {}
for i, cid in enumerate(ids):
    t = tabs[cid]
    cols["s"][i] = 0 if cid in human else 1 if cid in model else 2 if t["atf"] else 3
    y = -32768
    if t["per"]:
        for rx, yy in PERIODS:
            if rx.search(t["per"]): y = yy; break
    cols["yr"][i] = y; cols["g"][i] = genre(t["gen"])
    if t["lat"] is not None and -20 <= t["lon"] <= 80 and 0 <= t["lat"] <= 60:
        cols["lon"][i] = round((t["lon"] + 20) / 100 * 65534); cols["lat"][i] = round(t["lat"] / 60 * 65534)
        p = t["prov"] or "?"
        if p not in site_idx: site_idx[p] = len(sites); sites.append(p)
        cols["site"][i] = site_idx[p]
    else:
        cols["lon"][i] = cols["lat"][i] = cols["site"][i] = 0xFFFF
with open(OUT / "browse_all.dat", "wb") as f:
    for k in ("lon", "lat", "yr", "g", "s", "site"):
        a = cols[k]
        if sys.byteorder != "little": a.byteswap()
        f.write(a.tobytes())
(OUT / "browse_ids.txt").write_text("\n".join(ids))
json.dump({"n": N, "genres": GENRES, "states": STATES, "sites": sites, "built_at": time.strftime("%Y-%m-%d"),
           "note": "every tablet in the corpus; date = approximate period midpoint; genre bands are coarse"},
          open(OUT / "browse_meta.json", "w"), separators=(",", ":"))
log("dots written")
cidx = {c: i for i, c in enumerate(ids)}

# ---------------------------------------------------------------- related terms (NPMI, tablet level)
STOP = set("""a an the and or of to in on for by with from at as is are was were be been being it its this that these those he she they them his her their
him we our you your i me my not no but if so than then there here which who whom what when where why how all any each one two three four five six seven
ten into out up down over under about after before also too very can will shall may might must do does did done has have had having let o oh unto upon
x xx etc ii iii iv v vi vii viii ix said say says against before shall thou thee thy ye such just only other own same more most some s t""".split())
WORD = re.compile(r"[a-z][a-z'\-]{1,24}")
ATF_MAP = str.maketrans({"š": "sz", "ṣ": "s,", "ṭ": "t,", "ḫ": "h", "ŋ": "j", "ĝ": "j", **{chr(0x2080 + i): str(i) for i in range(10)}})
ATF_TOK = re.compile(r"[a-z{][a-z0-9{}\-.,']*")
def atf_tokens(s):
    s = s.lower().translate(ATF_MAP)
    s = re.sub(r"[#!?*\[\]<>⸢⸣˹˺()]", "", s)
    out = set()
    for w in s.split():
        if not ATF_TOK.fullmatch(w) or w in ("x", "...") or not re.search(r"[a-z]{2}", w) or w.startswith(("$", "@", "&")): continue
        out.add(w.strip("-."))
    return out
def related(name, per_tab, vocab_n=5000, min_df=15, topk=8, max_words=120):
    df = collections.Counter()
    for ws in per_tab.values(): df.update(ws)
    vocab = [w for w, c in df.most_common() if c >= min_df][:vocab_n]; V = len(vocab); vi = {w: i for i, w in enumerate(vocab)}
    T = len(per_tab); log(name, "tablets", T, "vocab", V)
    co = np.zeros(V * V, dtype=np.int64); chunk = []; rng = np.random.default_rng(7); size = 0
    def flush():
        nonlocal chunk, size
        if chunk: c = np.concatenate(chunk); co[:] += np.bincount(c, minlength=V * V); chunk = []; size = 0
    for ws in per_tab.values():
        a = np.array(sorted(vi[w] for w in ws if w in vi), dtype=np.int64)
        if len(a) < 2: continue
        if len(a) > max_words: a = np.sort(rng.choice(a, max_words, replace=False))
        x, y = np.triu_indices(len(a), 1); p = a[x] * V + a[y]; chunk.append(p); size += len(p)
        if size > 30_000_000: flush()
    flush()
    co = co.reshape(V, V); co = co + co.T
    dfa = np.array([df[w] for w in vocab], dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        pxy = co / T; pmi = np.log(pxy / np.outer(dfa / T, dfa / T)); npmi = pmi / -np.log(pxy)
    npmi[co < 5] = -1; np.fill_diagonal(npmi, -1)
    score = npmi * np.log1p(co) ** 0.5  # NPMI, mildly weighted so 5-tablet flukes don't dominate
    out = {}
    for i, w in enumerate(vocab[:4000]):
        top = np.argsort(-score[i])[:topk]
        out[w] = [vocab[j] for j in top if npmi[i, j] > 0.05]
    return out
en = collections.defaultdict(set)
for cid, content in con.execute("select canonical_id, content from translations where lang='en' and canonical_id is not null"):
    if content and cid in cidx:
        en[cid].update(w for w in WORD.findall(content.lower()) if w not in STOP and len(w) > 2)
log("en tokenized", len(en))
rel_en = related("en", en); del en
atf = collections.defaultdict(set)
for sid, tid, a in con.execute("select source_id, text_id, atf from lines where atf is not null"):
    cid = t2c.get((sid, tid))
    if cid: atf[cid] |= atf_tokens(a)
log("atf tokenized", len(atf))
atf_df = collections.Counter(); [atf_df.update(v) for v in atf.values()]
rel_atf = related("atf", atf); del atf
json.dump({"method": "NPMI over tablet co-occurrence, top 8, most common 4000 terms", "en": rel_en, "atf": rel_atf},
          open(OUT / "browse_related.json", "w"), ensure_ascii=False, separators=(",", ":"))

# ---------------------------------------------------------------- glyph -> readings (most used in the corpus first)
rd = json.load(open(ROOT / "data" / "atf_unicode_readings.json"))["readings"]
syl = collections.Counter()
for tok, c in atf_df.items():
    for part in re.split(r"[-.{}]", tok):
        if part: syl[part] += c
g2r = collections.defaultdict(list)
for r, cps in rd.items():
    if len(cps) == 1: g2r[chr(cps[0])].append(r)
signs = {}
for g, rs in g2r.items():
    rs.sort(key=lambda r: -syl[r.translate(ATF_MAP)])
    signs[g] = rs[:4]
json.dump(signs, open(OUT / "sign_readings.json", "w"), ensure_ascii=False, separators=(",", ":"))
log("done", {"en_terms": len(rel_en), "atf_terms": len(rel_atf), "glyphs": len(signs)})
