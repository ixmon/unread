#!/usr/bin/env node
// Parity: JS tokfix.mjs vs Python tokfix.model_input / encode_tgt / atfcodec.decode.
// Usage: node web/js/tokfix.parity.mjs [n=5000]
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelInput, decode, encodeTgt } from "./tokfix.mjs";

const N = Number(process.argv[2] || 5000);
const dir = mkdtempSync(join(tmpdir(), "tokfix-parity-"));
const pyPath = join(dir, "ref.py");
writeFileSync(pyPath, `
import json, sys, os, random
sys.path.insert(0, os.path.expanduser('~/cursor/atf-translate-test/data/na/tokfix'))
sys.path.insert(0, os.path.expanduser('~/cursor/atf-mix/mix'))
import tokfix
from atfcodec import decode as py_decode
R = os.path.expanduser('~/cursor/atf-translate-test/data/na')
random.seed(27)
strs = []
for f in ['testclean/eval_lines_clean.clean.json','testclean/hit_test_clean.clean.json']:
    for p in json.load(open(f'{R}/{f}'))['pairs']:
        strs.append(('atf', p['atf']))
        if p.get('english'): strs.append(('tgt', p['english']))
tr = json.load(open(f'{R}/b2c/train.json'))
items = tr if isinstance(tr, list) else tr.get('pairs') or tr.get('items') or []
for it in items:
    if not isinstance(it, dict): continue
    for k in ('input','src','inp','source','atf'):
        if k in it and isinstance(it[k], str): strs.append(('atf', it[k])); break
random.shuffle(strs)
strs = strs[:${N}]
rows = []
for kind, s in strs:
    if kind == 'tgt':
        enc = tokfix.encode_tgt(s)
        rows.append({'kind': kind, 'src': s, 'enc': enc, 'dec': py_decode(enc)})
    else:
        enc = tokfix.model_input(s)
        body = enc[len(tokfix.PREFIX):]
        rows.append({'kind': kind, 'src': s, 'enc': enc, 'dec': py_decode(body)})
json.dump(rows, open(r'${dir}/py.json','w'), ensure_ascii=False)
from collections import Counter
print(len(rows), dict(Counter(r['kind'] for r in rows)))
`.replace("${N}", String(N)).replaceAll("${dir}", dir));

const r = spawnSync("python3", [pyPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
console.log("python:", r.stdout.trim());
const rows = JSON.parse(readFileSync(join(dir, "py.json"), "utf8"));
let badEnc = 0, badDec = 0;
const samples = [];
const PREFIX = "translate Akkadian to English: ";
for (const row of rows) {
  const enc = row.kind === "tgt" ? encodeTgt(row.src) : modelInput(row.src);
  if (enc !== row.enc) {
    badEnc++;
    if (samples.length < 12) samples.push({ kind: row.kind, phase: "enc", src: row.src.slice(0, 180), py: row.enc.slice(0, 220), js: enc.slice(0, 220) });
  }
  const body = row.kind === "atf" ? row.enc.slice(PREFIX.length) : row.enc;
  const djs = decode(body);
  if (djs !== row.dec) {
    badDec++;
    if (samples.length < 12) samples.push({ kind: row.kind, phase: "dec", src: row.src.slice(0, 180), py: row.dec.slice(0, 220), js: djs.slice(0, 220) });
  }
}
console.log(`n=${rows.length} enc_mismatch=${badEnc} dec_mismatch=${badDec}`);
if (samples.length) console.log(JSON.stringify(samples, null, 2));
process.exit(badEnc || badDec ? 2 : 0);
