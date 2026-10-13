#!/usr/bin/env python3
"""Stream ORACC ePSD2 gloss-sux.json (1.9 GB, CC0) without loading it: keep per-entry cf/gw/pos/icount and
its *bases* (stem writings, e.g. še for še[barley]) with instance counts. Output: epsd2_bases.json."""
import json, re, sys
src, out = sys.argv[1], sys.argv[2]
KV = re.compile(r'^( *)"([^"]+)": (.*?),?$')
ents, cur, arr, pend = [], None, None, None
for line in open(src, encoding="utf-8"):
    m = KV.match(line.rstrip("\n"))
    if not m: continue
    ind, k, v = len(m.group(1)), m.group(2), m.group(3)
    if ind == 6:
        if k == "headword":
            cur = {"bases": []}; ents.append(cur); arr = None
        if cur is None: continue
        if v.startswith("["): arr = k; continue
        if k in ("cf", "gw", "pos", "icount"): cur[k] = json.loads(v)
    elif ind == 10 and cur is not None and arr == "bases":
        if k == "n": pend = json.loads(v)
        elif k == "icount" and pend is not None:
            cur["bases"].append([pend, int(json.loads(v))]); pend = None
json.dump([e for e in ents if e.get("gw") and e["bases"]], open(out, "w"), ensure_ascii=False)
print(len(ents), "entries", file=sys.stderr)
