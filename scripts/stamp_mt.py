#!/usr/bin/env python3
"""Normalise machine-translation provenance in data/texts/<id>.json (idempotent).

Every packaged text that carries model English gets a public-safe stamp:
  translation_meta = {model, model_repo, model_version, translated_on, date_basis,
                      lines_translated, lines_total, prompt, kind: "machine_draft"}
  english_note     = "Machine translation · <model> · YYYY-MM-DD"
Local filesystem paths and device names are dropped (they were written by the local
translate API). translated_on is kept if already set; otherwise it is taken from the
file's modification date (UTC) and date_basis says so.

The model weights of local checkpoint atf-en-best-v2 are byte-identical to
huggingface.co/montycrypto/atf-to-english @ d871547f (model.safetensors sha256 f2136f34…).

Usage: python3 scripts/stamp_mt.py [--check]
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXTS = ROOT / "data" / "texts"
MODEL = "atf-en-best-v2"
MODEL_REPO = "montycrypto/atf-to-english"
MODEL_VERSION = "d871547f92875415dbbc7f4a37fd65e35f8ac97d"
PROMPT = "translate Akkadian to English: "


def note_for(m: dict) -> str:
    part = ""
    if m["lines_total"] and m["lines_translated"] < m["lines_total"]:
        part = f" First {m['lines_translated']} of {m['lines_total']} lines."
    return (
        f"Machine translation · {m['model']} · {m['translated_on']}{part}"
    )


def stamp(path: Path) -> tuple[bool, dict | None]:
    t = json.loads(path.read_text(encoding="utf-8"))
    eng = t.get("english")
    n = len(eng) if isinstance(eng, list) else (1 if isinstance(eng, str) and eng.strip() else 0)
    if not n:
        return False, None
    old = t.get("translation_meta") or {}
    total = sum(1 for l in t.get("lines", []) if l.get("type") == "line")
    if old.get("translated_on"):
        on, basis = old["translated_on"], old.get("date_basis", "recorded")
    else:
        on = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).date().isoformat()
        basis = "file modification date (translation happened on or before this day)"
    meta = {
        "kind": "machine_draft",
        "model": MODEL,
        "model_repo": MODEL_REPO,
        "model_version": MODEL_VERSION,
        "translated_on": on,
        "date_basis": basis,
        "prompt": old.get("prompt", PROMPT),
        "lines_translated": n,
        "lines_total": total,
    }
    if old.get("work"):
        meta["work"] = old["work"]
    new_note = note_for(meta)
    if old.get("work"):
        new_note += f" ({old['work']}; cf. published editions.)"
    changed = meta != old or t.get("english_note") != new_note or not t.get("has_machine_draft")
    t["translation_meta"] = meta
    t["english_note"] = new_note
    t["has_machine_draft"] = True
    t["machine_draft_lines"] = n
    return changed, t


def main() -> int:
    check = "--check" in sys.argv
    dirty = []
    for p in sorted(TEXTS.glob("*.json")):
        if p.name == "manifest.json":
            continue
        changed, t = stamp(p)
        if not changed:
            continue
        dirty.append(p.name)
        if not check:
            mtime = p.stat().st_mtime
            p.write_text(json.dumps(t, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            import os
            os.utime(p, (mtime, mtime))  # keep the date evidence stable
    print(("needs stamping: " if check else "stamped: ") + (", ".join(dirty) or "none"))
    return 1 if (check and dirty) else 0


if __name__ == "__main__":
    sys.exit(main())
