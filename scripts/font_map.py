#!/usr/bin/env python3
"""Period/language -> cuneiform font, from the single table in web/fonts/fonts.json.

Same matching as web/js/fontmap.js: rules in order, each regex case-insensitive, a missing
field matches anything, first match wins, otherwise "default".
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

FONTS_JSON = Path(__file__).resolve().parent.parent / "web" / "fonts" / "fonts.json"


@lru_cache(maxsize=1)
def table() -> dict:
    return json.loads(FONTS_JSON.read_text())


def font_for(language: str | None = None, period: str | None = None, genre: str | None = None) -> str:
    t = table()
    vals = {"language": language or "", "period": period or "", "genre": genre or ""}
    for r in t["rules"]:
        if all(re.search(r[k], vals[k], re.I) for k in ("language", "period", "genre") if k in r):
            return r["font"]
    return t["default"]


def font_info(font_id: str) -> dict:
    return table()["fonts"][font_id]


def font_face_css(font_ids, base: str) -> str:
    """@font-face rules (font-display: swap) for just these fonts (+ the fallback)."""
    t = table()
    out = []
    for fid in dict.fromkeys(list(font_ids) + [t["fallback"]]):
        f = t["fonts"][fid]
        rng = f";unicode-range:{f['unicode_range']}" if f.get("unicode_range") else ""
        out.append(f'@font-face{{font-family:"{f["family"]}";src:url("{base}{f["file"]}") format("{f["format"]}");font-display:swap{rng}}}')
    return "\n".join(out)


def font_stack(font_id: str) -> str:
    t = table()
    fam = t["fonts"][font_id]["family"]
    fb = t["fonts"][t["fallback"]]["family"]
    return f'"{fam}", "{fb}", serif' if fam != fb else f'"{fam}", serif'
