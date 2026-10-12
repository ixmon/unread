#!/usr/bin/env python3
"""Mockup G data: cuneiform sign dictionary (web/mockups/data/signs*.json).

Sources (all local, nothing invented):
  * Sign list: eBL sign list as vendored in deep-cuneiform (ebl-api tests/atf_importer/test_data/signs.json,
    2,493 signs: name, values with sub-index, Unicode, concordance numbers MZL/ABZ/HZL/LAK/OBZL/...).
  * Usage: corpus.sqlite (read-only). Each tablet counted once (cdli > oracc > tlhdig > achemenet > ebl
    by canonical_id). ATF tokens are resolved to signs by exact reading+index in the eBL list.
    Aggregate counts only; no eBL ATF or English text is copied.
  * Glosses: human English from CDLI, where translations.line_ref == '<surface> <line_no>' (line aligned).
    Words are ranked by lift over all aligned lines, i.e. "English words that co-occur with this sign on the
    same line", not a dictionary meaning.
  * Archaic forms: CDLI proto-cuneiform sign drawings (R. K. Englund, CC BY 4.0), copied to web/mockups/img/signs.
"""
import sqlite3, re, json, collections, sys, unicodedata, shutil, math, os
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
DC = Path("/home/darkstar/cursor/deep-cuneiform")
DB = "/home/darkstar/cursor/unread-db/corpus.sqlite"
SIGNS = DC / "data/ebl/ebl_data/ebl-api/ebl/tests/atf_importer/test_data/signs.json"
ARCH = DC / "data/ocr/proto-cuneiform_signs/archsigns"
OUT = ROOT / "web/mockups/data"
IMG = ROOT / "web/mockups/img/signs"
# showcase: eBL id -> (display name, archaic drawing stems)
SHOW = {"AN": ("AN / DINGIR", ["AN"]), "KA": ("KA", ["KA~a"]), "ŠE": ("ŠE (barley)", ["SZE~a@t", "SZE~b", "SZE~c"]),
        "GUD": ("GU₄ (GUD, ox)", ["GU4"]), "|SAL.TUG₂|": ("NIN", ["NIN"]), "GA₂": ("GA₂", ["GA2~a1", "GA2~b", "GA2~c"])}
BUCKETS = [("Archaic", r"uruk|proto-?cun|jemdet|jdn"), ("Early Dynastic", r"^ed\b|early dynastic|ebla|fara"),
           ("Old Akkadian", r"old akkadian|sargonic"), ("Ur III", r"ur iii|lagash ii"),
           ("Old Babylonian", r"old babylonian|old assyrian|isin|larsa"),
           ("Middle Bab./Assyr.", r"middle babylonian|middle assyrian|kassite|middle elamite"),
           ("Hittite", r"hittite"), ("Neo-Assyrian", r"neo-assyrian"),
           ("Neo-/Late Babylonian", r"neo-babylonian|late babylonian|achaemenid|hellenistic|seleucid|parthian|neo-elamite")]
BNAMES = [b for b, _ in BUCKETS]
def bucket(p):
    p = (p or "").lower()
    for i, (_, rx) in enumerate(BUCKETS):
        if re.search(rx, p): return i
    return None
SUB = str.maketrans("₀₁₂₃₄₅₆₇₈₉", "0123456789")
def ascii_read(v):
    return v.replace("š", "sz").replace("Š", "SZ").replace("ĝ", "g").replace("Ĝ", "G").replace("ṣ", "s,").replace("ṭ", "t,") \
            .replace("ḫ", "h").replace("Ḫ", "H").translate(SUB)
def ascii_name(n):
    return ascii_read(n)
signs = json.load(open(SIGNS))
r2s, conflicts = {}, 0
for s in signs:
    for v in s["values"]:
        if v["subIndex"] is None: continue
        k = ascii_read(v["value"]).lower() + ("" if v["subIndex"] == 1 else str(v["subIndex"]))
        if k in r2s and r2s[k] != s["_id"]: conflicts += 1; continue
        r2s[k] = s["_id"]
print("readings", len(r2s), "conflicts skipped", conflicts, file=sys.stderr)
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
texts, PRI = {}, {"cdli": 0, "oracc": 1, "tlhdig": 2, "achemenet": 3, "ebl": 4}
for src, tid, cid, per, prov, lat, lon in con.execute("select source_id,id,canonical_id,period,provenience,lat,lon from texts"):
    texts[(src, tid)] = (cid or tid, bucket(per), prov, lat, lon)
best = {}
for (src, tid), (cid, *_r) in texts.items():
    if cid not in best or PRI.get(src, 9) < PRI.get(best[cid][0], 9): best[cid] = (src, tid)
keep = set(best.values()); print("texts kept", len(keep), file=sys.stderr)
hum = {}
for tid, ref, content in con.execute("select text_id,line_ref,content from translations where source_id='cdli' and author_type='human' and lang='en'"):
    hum[(tid, ref)] = content
print("aligned cdli human lines", len(hum), file=sys.stderr)
STOP = set("the a an of and to in for is was his her its their he she it they this that with by from on as at be or not are were have has i you we my your our them him".split())
WRD = re.compile(r"[a-z][a-z'\-]{2,}")
TOK = re.compile(r"\{[^}]*\}|[^\s\-\.{}:+]+")
CLEAN = re.compile(r"[\[\]#?!*<>()⸢⸣˺˹_]")
tot = collections.Counter()                        # sign -> n
by_b = collections.defaultdict(collections.Counter)  # sign -> bucket -> n
by_lang = collections.defaultdict(collections.Counter)
rd = collections.defaultdict(collections.Counter)  # (sign,bucket) -> reading/use
words = collections.defaultdict(collections.Counter)
sites = collections.defaultdict(collections.Counter); siteLL = {}
seen_site = set()
eng_all, eng_n = collections.Counter(), 0
gl = collections.defaultdict(collections.Counter)   # (sign,bucket) -> word
gl_lines = collections.Counter()
n = 0
for src, tid, surf, lno, lang, asc in con.execute("select source_id,text_id,surface,line_no,lang,atf_ascii from lines"):
    n += 1
    if n % 500000 == 0: print(n, file=sys.stderr)
    if (src, tid) not in keep or not asc: continue
    cid, b, prov, lat, lon = texts[(src, tid)]
    eng = hum.get((tid, f"{surf} {lno}")) if src == "cdli" else None
    ew = None
    if eng is not None:
        ew = set(w for w in WRD.findall(eng.lower()) if w not in STOP); eng_all.update(ew); eng_n += 1
    line_signs = set()
    for word in asc.split():
        w = CLEAN.sub("", re.sub(r"\d+\(", "", word))
        if not w or w.startswith("$") or w.startswith("@"): continue
        wsigns = []
        for t in TOK.findall(w):
            det = t.startswith("{")
            t0 = t.strip("{}")
            if not t0 or t0 == "x": continue
            r = t0.lower()
            sg = r2s.get(r)
            if not sg: continue
            wsigns.append(sg)
            tot[sg] += 1; by_lang[sg][lang or "?"] += 1
            if b is not None: by_b[sg][b] += 1
            if sg in SHOW:
                use = "{%s} determinative" % r if det else (r.upper() + " (logogram)" if t0.isupper() and lang != "sux" else r)
                rd[(sg, b)][use] += 1
                line_signs.add(sg)
        for sg in set(wsigns):
            if sg in SHOW and len(w) < 40: words[sg][w.lower() if not w.isupper() else w] += 1
    for sg in line_signs:
        if prov and lat is not None and (sg, cid) not in seen_site:
            seen_site.add((sg, cid)); sites[sg][prov] += 1; siteLL[prov] = (round(lat, 2), round(lon, 2))
        if ew is not None and b is not None:
            gl[(sg, b)].update(ew); gl_lines[(sg, b)] += 1
print("lines", n, file=sys.stderr)
def ucps(s):
    out = []
    for c in s.get("unicode") or []:
        try: out.append(int(c))
        except (TypeError, ValueError): return []
    return out
def uchar(s):
    u = ucps(s)
    return "".join(chr(c) for c in u) if u and all(0x12000 <= c <= 0x1254F for c in u) else None
index = []
for s in signs:
    ch = uchar(s)
    index.append({"id": s["_id"], "a": ascii_name(s["_id"]), "u": ch, "cp": ["U+%X" % c for c in ucps(s)],
                  "uname": " / ".join(unicodedata.name(c, "") for c in (ch or "")) or None,
                  "v": [ascii_read(v["value"]).lower() + ("" if v["subIndex"] in (1, None) else str(v["subIndex"])) +
                        ("ₓ" if v["subIndex"] is None else "") for v in s["values"]],
                  "n": tot[s["_id"]], "pb": [by_b[s["_id"]][i] for i in range(len(BUCKETS))],
                  "lists": {l["name"]: l["number"] for l in s.get("lists", [])}})
index.sort(key=lambda x: -x["n"])
detail = {}
for sg, (disp, arch) in SHOW.items():
    s = next(x for x in signs if x["_id"] == sg)
    per = []
    for i, bn in enumerate(BNAMES):
        c = rd[(sg, i)]; T = sum(c.values())
        glo = []
        if gl_lines[(sg, i)] >= 20:
            for w, k in gl[(sg, i)].most_common(400):
                if k < 4: continue
                lift = (k / gl_lines[(sg, i)]) / (eng_all[w] / eng_n)
                glo.append((w, k, round(lift, 1)))
            glo = sorted([g for g in glo if g[2] >= 1.5], key=lambda g: -g[1] * math.log(g[2]))[:6]
        per.append({"period": bn, "n": T, "readings": c.most_common(6), "gloss_lines": gl_lines[(sg, i)], "glosses": glo})
    imgs = []
    IMG.mkdir(parents=True, exist_ok=True)
    for a in arch:
        f = ARCH / (a + ".jpg")
        if f.exists():
            shutil.copy(f, IMG / f.name); imgs.append({"file": "img/signs/" + f.name, "name": a})
    detail[ascii_name(sg)] = {"id": sg, "display": disp, "u": uchar(s), "archaic": imgs,
        "top_words": words[sg].most_common(15), "langs": by_lang[sg].most_common(8),
        "sites": [{"site": p, "n": k, "ll": siteLL[p]} for p, k in sites[sg].most_common(25)], "periods": per}
meta = {"built_from": "corpus.sqlite (read-only) + eBL sign list (vendored test data) + CDLI proto-cuneiform drawings",
        "periods": BNAMES, "texts": len(keep), "aligned_lines": eng_n, "reading_conflicts_skipped": conflicts}
OUT.mkdir(parents=True, exist_ok=True)
json.dump({"meta": meta, "signs": index}, open(OUT / "signs_index.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump({"meta": meta, "detail": detail}, open(OUT / "signs_detail.json", "w"), ensure_ascii=False, separators=(",", ":"))
print("done", file=sys.stderr)
