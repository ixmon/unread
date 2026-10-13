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
  * English glosses (per sign, priority order; nothing invented, blank if none):
      1. eBL sign-list logograms (field empty in the vendored copy, so currently 0),
      2. ORACC ePSD2 Sumerian glossary (gloss-sux.json, CC0): guide words (cf[gw]) of lemmas whose *base*
         is written with this one sign, weighted by attestations; base readings resolved via eBL values,
         else via the OGSL reading index (source label says which),
      3. fallback: English words that co-occur with the sign on CDLI line-aligned human translations,
         flagged 'inferred'.
  * OGSL (Oracc Global Sign List, ogsl-sl.json, CC0): extra readings (searchable) and Unicode where eBL lacks it.
    OGSL itself carries no meanings. Downloaded to deep-cuneiform/data/oracc_lists.
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
    return v.replace("š", "sz").replace("Š", "SZ").replace("ĝ", "g").replace("Ĝ", "G").replace("ŋ", "g").replace("Ŋ", "G").replace("ṣ", "s,").replace("ṭ", "t,") \
            .replace("ḫ", "h").replace("Ḫ", "H").translate(SUB)
def ascii_name(n):
    return ascii_read(n)
OL = DC / "data/oracc_lists"
signs = json.load(open(SIGNS))
OG = json.load(open(OL / "ogsl/ogsl-sl.json"))
OGS, OGI = OG["signs"], OG["index"]
EBL_IDS = {s["_id"] for s in signs}
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
gla, gla_lines = collections.defaultdict(collections.Counter), collections.Counter()
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
    line_signs = set(); all_ls = set()
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
            wsigns.append(sg); all_ls.add(sg)
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
    if ew is not None:
        for sg in all_ls: gla[sg].update(ew); gla_lines[sg] += 1
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
# ---- English glosses
PROPER = {"PN", "DN", "GN", "RN", "SN", "TN", "WN", "ON", "FN", "MN", "EN", "LN", "CN", "AN", "YN", "QN", "PNF"}
BADGW = {"cvne", "cvve", "unmng", "unknown", "meaning unknown", "mng?", "1", "x"}
eps = collections.defaultdict(collections.Counter); eps_via = collections.defaultdict(collections.Counter)
for e in json.load(open(OL / "epsd2_bases.json")):
    if e.get("pos") in PROPER or e["gw"] in BADGW: continue
    for b, k in e["bases"]:
        if k <= 0: continue
        r = re.sub(r"\{[^}]*\}", "", b)
        m = re.fullmatch(r"[^\s\-.()]+ₓ\((\|?[^)]+\|?)\)", r)
        sg, via = None, None
        if m and m.group(1) in EBL_IDS: sg, via = m.group(1), "eBL"
        elif re.search(r"[\s\-.()|]|ₓ|x", r) or not r: continue
        else:
            sg = r2s.get(ascii_read(r).lower()); via = "eBL"
            if not sg and OGI.get(r) in EBL_IDS: sg, via = OGI[r], "OGSL"
        if not sg: continue
        key = (e["cf"], e["gw"], e.get("pos", ""))
        eps[sg][key] += k; eps_via[sg][(key, via)] += k
GLOSS, gcount = {}, collections.Counter()
for s in signs:
    sid = s["_id"]
    if s.get("logograms"):  # eBL logogram meanings, if this copy ever carries them
        pass
    c = eps.get(sid)
    if c and sum(c.values()) >= 5:
        top = c.most_common(); mx = top[0][1]
        keep_ = [(k, n) for k, n in top if n >= max(5, 0.05 * mx)][:5]
        if keep_:
            via = collections.Counter()
            for (k, v), n in eps_via[sid].items():
                if k == keep_[0][0]: via[v] += n
            src = "ORACC ePSD2 glossary" + (" (reading via OGSL)" if via.most_common(1)[0][0] == "OGSL" else "")
            GLOSS[sid] = {"g": keep_[0][0][1], "src": src, "kind": "epsd2",
                          "list": [{"cf": k[0], "gw": k[1], "pos": k[2], "n": n} for k, n in keep_]}
            gcount["epsd2-ogsl" if "OGSL" in src else "epsd2"] += 1; continue
    L = gla_lines[sid]
    if L >= 30:
        cand = []
        for w, k in gla[sid].most_common(300):
            if k < 8: continue
            lift = (k / L) / (eng_all[w] / eng_n)
            if lift >= 3: cand.append((w, k, round(lift, 1)))
        cand = sorted(cand, key=lambda g: -g[1] * math.log(g[2]))[:4]
        if cand:
            GLOSS[sid] = {"g": cand[0][0], "src": "co-occurrence (inferred)", "kind": "cooc",
                          "list": [{"gw": w, "n": k, "lift": l} for w, k, l in cand], "lines": L}
            gcount["cooc"] += 1; continue
    gcount["none"] += 1
print("gloss coverage", dict(gcount), file=sys.stderr)
def og_vals(sid):
    o = OGS.get(sid) or {}
    return o.get("values") or [], o.get("utf8")
index = []
for s in signs:
    ch = uchar(s)
    ov, ou = og_vals(s["_id"]); uo = None
    if not ch and ou and all(0x12000 <= ord(c) <= 0x1254F for c in ou): ch, uo = ou, True
    G = GLOSS.get(s["_id"])
    index.append({"id": s["_id"], "a": ascii_name(s["_id"]), "u": ch, "cp": ["U+%X" % c for c in ucps(s)],
                  "uname": " / ".join(unicodedata.name(c, "") for c in (ch or "")) or None,
                  "v": [ascii_read(v["value"]).lower() + ("" if v["subIndex"] in (1, None) else str(v["subIndex"])) +
                        ("ₓ" if v["subIndex"] is None else "") for v in s["values"]],
                  "n": tot[s["_id"]], "pb": [by_b[s["_id"]][i] for i in range(len(BUCKETS))],
                  "lists": {l["name"]: l["number"] for l in s.get("lists", [])},
                  "g": G["g"] if G else None, "gs": G["kind"] if G else None, "gsrc": G["src"] if G else None,
                  "gl": G["list"] if G else [], "ov": [], "uo": uo, "_ov": ov})
for x in index:
    have = set(x["v"]); ov = []
    for v in x.pop("_ov"):
        a = ascii_read(v).lower()
        if a not in have and a not in ov and not a.startswith("|"): ov.append(a)
    x["ov"] = ov
    if not x["cp"] and x["u"]: x["cp"] = ["U+%X" % ord(c) for c in x["u"]]
    if not x["uname"] and x["u"]: x["uname"] = " / ".join(unicodedata.name(c, "") for c in x["u"]) or None
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
meta = {"built_from": "corpus.sqlite (read-only) + eBL sign list (vendored test data) + OGSL + ORACC ePSD2 glossary + CDLI proto-cuneiform drawings",
        "periods": BNAMES, "texts": len(keep), "aligned_lines": eng_n, "reading_conflicts_skipped": conflicts,
        "gloss_coverage": dict(gcount), "ogsl_timestamp": OG.get("UTC-timestamp")}
OUT.mkdir(parents=True, exist_ok=True)
json.dump({"meta": meta, "signs": index}, open(OUT / "signs_index.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump({"meta": meta, "detail": detail}, open(OUT / "signs_detail.json", "w"), ensure_ascii=False, separators=(",", ":"))
print("done", file=sys.stderr)
