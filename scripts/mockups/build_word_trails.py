#!/usr/bin/env python3
"""Mockup D data: 'word trail' for a plant word = every tablet whose ATF contains it, where/when,
how human translators render it, and ranked research leads (tablets with the word but no human English).

Lead ranking (heuristic, stated in the UI):
  group 1: ATF only (no English at all); group 2: machine draft only (no human English).
  within a group: score = 3 * (other plant words it shares with the human-translated "anchor" tablets, any site)
                          + occurrences of the word + 5 if an anchor sits at the same find-spot.
eBL ATF/English is never copied into the JSON (not republishable); eBL tablets appear as IDs only.
"""
import sqlite3, re, json, collections, sys
DB = "/home/darkstar/cursor/unread-db/corpus.sqlite"
OUT = sys.argv[1] if len(sys.argv) > 1 else "web/mockups/data/word_trails.json"
TERMS = [
  {"key": "tarmush", "label": "tarmuš (ú.tar-muš)", "atf_like": ["{u2}tar-musz"],
   "render_re": r"tarmu[sš]\w*|lupin\w*", "note": "Some translators render it 'lupin', others leave it as tarmuš."},
  {"key": "aktam", "label": "aktam (ú.ak-tam)", "atf_like": ["{u2}ak-tam"],
   "render_re": r"aktam[\w\-]*", "note": "Unidentified: human translations leave it as 'aktam(-plant)'."},
]
BADPROV = re.compile(r"^(uncertain|unclear|unknown)( \(mod\. uncertain\)| location)?$|^\?$", re.I)
PLANT = re.compile(r"\{(?:u2|szim)\}[^\s\[\]#?!<>]+")
con = sqlite3.connect(DB)
human = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='human' and lang='en'"))
model = set(r[0] for r in con.execute("select distinct canonical_id from translations where author_type='model' and lang='en'"))
def norm(tok):
    t = tok.lower().replace("_", "")
    t = re.sub(r"[⸢⸣]", "", t).replace(".", "-").rstrip("-")
    return t
def meta(cid):
    rows = con.execute("""select source_id,id,designation,period,genre,provenience,lat,lon from texts where canonical_id=?
        order by case source_id when 'cdli' then 0 when 'oracc' then 1 else 2 end""", (cid,)).fetchall()
    m = {"id": cid, "srcs": sorted(set(r[0] for r in rows)), "designation": None, "period": None, "genre": None,
         "site": None, "lat": None, "lon": None, "src": rows[0][0] if rows else None, "text_id": rows[0][1] if rows else cid}
    for s, i, d, p, g, prov, lat, lon in rows:
        m["designation"] = m["designation"] or d
        m["period"] = m["period"] or p
        m["genre"] = m["genre"] or g
        if m["lat"] is None and lat is not None and not BADPROV.match(prov or ""):
            m["site"], m["lat"], m["lon"] = prov, round(lat, 3), round(lon, 3)
    return m
out = {"built_from": "corpus.sqlite", "terms": []}
for T in TERMS:
    where = " or ".join("atf_ascii like ?" for _ in T["atf_like"])
    args = ["%" + a + "%" for a in T["atf_like"]]
    hits = collections.defaultdict(lambda: {"n": 0, "lines": [], "plants": set()})
    textcid = {}
    for src, tid, lno, atf, asc in con.execute(f"select source_id,text_id,line_no,atf,atf_ascii from lines where {where}", args):
        k = (src, tid)
        if k not in textcid:
            r = con.execute("select canonical_id from texts where source_id=? and id=?", k).fetchone()
            textcid[k] = r[0] if r else tid
        h = hits[textcid[k]]
        h["n"] += sum(asc.count(a) for a in T["atf_like"])
        if src != "ebl" and len(h["lines"]) < 2:
            h["lines"].append({"src": src, "line": lno, "atf": atf})
    # co-occurring plant words per tablet (all lines of that tablet's records)
    for cid in hits:
        for (asc,) in con.execute("""select l.atf_ascii from lines l join texts t on t.source_id=l.source_id and t.id=l.text_id
                                     where t.canonical_id=? and (l.atf_ascii like '%{u2}%' or l.atf_ascii like '%{szim}%')""", (cid,)):
            for tok in PLANT.findall(asc):
                n = norm(tok)
                if not any(norm(a) in n for a in T["atf_like"]) and len(n.split("}", 1)[1]) >= 3 and "x" not in n.split("}", 1)[1].split("-"):
                    hits[cid]["plants"].add(n)
    rre = re.compile(T["render_re"], re.I)
    renders = collections.Counter()
    tabs = []
    for cid, h in hits.items():
        m = meta(cid)
        cat = "human" if cid in human else ("machine" if cid in model else "atf_only")
        m.update({"cat": cat, "hits": h["n"], "atf": h["lines"], "plants": sorted(h["plants"])})
        if cat == "human":
            eng = []
            for src, c in con.execute("""select source_id, content from translations where canonical_id=? and author_type='human'
                                          and lang='en' and can_republish=1""", (cid,)):
                if c and rre.search(c):
                    for x in rre.findall(c): renders[x.lower().strip("-'’")] += 1
                    if len(eng) < 2: eng.append({"src": src, "en": c[:240]})
            m["en"] = eng
            m["human_srcs"] = sorted(set(r[0] for r in con.execute("select distinct source_id from translations where canonical_id=? and author_type='human' and lang='en'", (cid,))))
        tabs.append(m)
    # sites
    sites = {}
    for m in tabs:
        if m["lat"] is None: continue
        key = f'{m["lat"]},{m["lon"]}'
        s = sites.setdefault(key, {"key": key, "site": m["site"], "lat": m["lat"], "lon": m["lon"], "human": 0, "machine": 0, "atf_only": 0,
                                   "anchor_plants": set()})
        s[m["cat"]] += 1
        if m["cat"] == "human": s["anchor_plants"] |= set(m["plants"])
        m["site_key"] = key
    anchor_plants_all = set().union(*[set(m["plants"]) for m in tabs if m["cat"] == "human"]) if any(m["cat"] == "human" for m in tabs) else set()
    leads = []
    for m in tabs:
        if m["cat"] == "human": continue
        s = sites.get(m.get("site_key"))
        shared = sorted(set(m["plants"]) & anchor_plants_all)
        same_site = bool(s and s["human"] > 0)
        tier = 1 if m["cat"] == "atf_only" else 2
        leads.append({"id": m["id"], "designation": m["designation"], "site": m["site"], "period": m["period"], "genre": m["genre"],
                      "cat": m["cat"], "srcs": m["srcs"], "hits": m["hits"], "tier": tier, "shared": shared[:12], "n_shared": len(shared),
                      "atf": m["atf"][:1], "score": 3 * len(shared) + m["hits"] + (5 if same_site else 0), "anchors_at_site": s["human"] if s else 0})
    leads.sort(key=lambda l: (l["tier"], -l["score"], l["id"]))
    for s in sites.values(): s["anchor_plants"] = len(s["anchor_plants"])
    periods = collections.Counter(m["period"] or "unknown" for m in tabs)
    cats = collections.Counter(m["cat"] for m in tabs)
    out["terms"].append({k: T[k] for k in ("key", "label", "atf_like", "note")} | {
        "tablets": len(tabs), "by_cat": dict(cats), "unlocated": sum(1 for m in tabs if m["lat"] is None),
        "periods": periods.most_common(), "renderings": renders.most_common(8),
        "sites": sorted(sites.values(), key=lambda s: -(s["human"] + s["machine"] + s["atf_only"])),
        "anchors": [m for m in tabs if m["cat"] == "human"], "leads": leads,
        "tablet_list": [{k: m.get(k) for k in ("id", "designation", "site", "site_key", "period", "cat", "hits")} for m in tabs]})
    print(T["key"], len(tabs), dict(cats), "sites", len(sites), "leads", len(leads), renders.most_common(4), file=sys.stderr)
json.dump(out, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
