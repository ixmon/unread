#!/usr/bin/env python3
"""Held-out test: can Qwen (local llama.cpp server) or v4e (atf->English T5) supply sign glosses?
Held-out = signs that already have a dictionary gloss (ePSD2 / ORACC Akkadian / eBL / Wiktionary). The model sees
only the sign name, Unicode and eBL readings; its answer is scored against every dictionary sense we hold for it.
Usage: eval_gloss_models.py qwen|v4e-prep|score|apply"""
import json, re, random, sys, urllib.request, collections
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]; GD = ROOT / "data/sign_glosses"
rows = json.load(open(GD / "sign_glosses.json"))["signs"]
DICT = {"epsd2", "epsd2-ogsl", "oracc-akk", "ebl", "wiktionary"}
def refs(r): return {x["gw"] for s in r["all_sources"] if s["kind"] in DICT for x in s["senses"] if x.get("gw")}
STOP = set("a an the of to in on for and or be is as by with one which who that thing kind type something make made used".split())
def stems(t): return {w[:5] for w in re.findall(r"[a-z]+", (t or "").lower()) if w not in STOP and len(w) > 2}
def hit(ans, rs): a = stems(ans); return bool(a) and any(a & stems(x) for x in rs)
def reading(r):
    for v in r["readings"]:
        if not re.search(r"\d", v): return v
    return r["readings"][0] if r["readings"] else r["sign"].lower()
random.seed(7)
known = [r for r in rows if r["gloss_kind"] in DICT and refs(r)]
comp = [r for r in known if r["sign"].startswith("|")]; simp = [r for r in known if not r["sign"].startswith("|")]
held = random.sample(simp, 100) + random.sample(comp, min(100, len(comp)))
missing = [r for r in rows if not r["gloss"]]
def prompt(r):
    return (f"Cuneiform sign {r['sign']}" + (f" ({r['unicode']})" if r["unicode"] else "") +
            f". Known readings: {', '.join(r['readings'][:12]) or 'none'}.\nWhat does this sign mean in English when used as a word "
            "(Sumerian or Akkadian logogram)? Reply with only the meaning in 1-4 words. If you do not know, reply exactly UNKNOWN.")
def qwen(r):
    body = json.dumps({"model": "qwen3.8", "messages": [{"role": "user", "content": prompt(r)}], "max_tokens": 24, "temperature": 0,
                       "chat_template_kwargs": {"enable_thinking": False}}).encode()
    q = urllib.request.Request("http://localhost:8080/v1/chat/completions", body, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(q, timeout=300))["choices"][0]["message"]["content"].strip().split("\n")[0][:60]
def report(name, preds, sets):
    out = {}
    for lab, rs in sets.items():
        n = len(rs); unk = sum(1 for r in rs if re.search(r"unknown", preds[r["sign"]], re.I))
        ok = sum(1 for r in rs if not re.search(r"unknown", preds[r["sign"]], re.I) and hit(preds[r["sign"]], refs(r)))
        ans = n - unk
        out[lab] = {"n": n, "correct": ok, "acc_all": round(ok / n, 3), "answered": ans, "precision_answered": round(ok / ans, 3) if ans else None}
    print(name, json.dumps(out)); return out
mode = sys.argv[1]
if mode == "qwen":
    P = {r["sign"]: qwen(r) for r in held}
    M = {r["sign"]: qwen(r) for r in missing}
    json.dump({"held": P, "missing": M}, open(GD / "eval_qwen.json", "w"), ensure_ascii=False, indent=1)
    report("qwen", P, {"held_simple": held[:100], "held_compound": held[100:], "held_all": held})
elif mode == "v4e-prep":
    json.dump([{"atf": reading(r), "english": "x", "sign": r["sign"]} for r in held + missing], open(GD / "v4e_in.json", "w"), ensure_ascii=False)
elif mode == "score":
    Q = json.load(open(GD / "eval_qwen.json")); V = json.load(open(GD / "v4e_out.json"))
    signs = [r["sign"] for r in held + missing]; VP = {s: v["hyp"] for s, v in zip(signs, V)}
    res = {"qwen": report("qwen", Q["held"], {"simple": held[:100], "compound": held[100:], "all": held}),
           "v4e": report("v4e", VP, {"simple": held[:100], "compound": held[100:], "all": held}),
           "qwen_missing_answered": sum(1 for s, a in Q["missing"].items() if not re.search("unknown", a, re.I)), "missing_n": len(missing)}
    ex = [{"sign": r["sign"], "refs": sorted(refs(r))[:6], "qwen": Q["held"][r["sign"]], "v4e": VP[r["sign"]], "input_reading": reading(r)} for r in held]
    json.dump({"results": res, "examples": ex, "missing_qwen": Q["missing"], "missing_v4e": {s: VP[s] for s in Q["missing"]}},
              open(GD / "model_gloss_eval.json", "w"), ensure_ascii=False, indent=1)
