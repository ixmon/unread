#!/usr/bin/env python3
"""
Hunt interesting omen + math/metrology tablets from the local CDLI dump.

Writes:
  data/omen_candidates.json
  data/math_candidates.json

Merges flags into data/catalog.json and packages featured samples into data/texts/.

Usage (from repo root):
  python3 scripts/hunt_omens_math.py
  python3 scripts/hunt_omens_math.py --deep-cuneiform ../deep-cuneiform
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from translation_status import classify_translation  # noqa: E402

# Reuse site map + helpers from build_catalog
from build_catalog import (  # noqa: E402
    SITES,
    font_for,
    normalize_site,
    parse_atf_lines,
    period_year,
)

# ---------------------------------------------------------------------------
# Omen signals
# ---------------------------------------------------------------------------
OMEN_SUB = re.compile(
    r"extispic|physiogn|izbu|iqqur|enuma\s*anu|eae\b|mul\.?apin|"
    r"dream|tirku|alamdimmu|kataduggu|nigdimdimmu|kittabru|"
    r"šumma|summa|omens?\b|liver|astrolog",
    re.I,
)
OMEN_DES = re.compile(
    r"\b(TBP|YOS\s*10|CT\s*(3[0-9]|4[0-1])|KAR\s*\d|SpTU.*omen|"
    r"AfO\s*Beih|EAE|Enuma\s*Anu|Šumma|Summa|Izbu|SAA\s*8|SAA\s*10)\b",
    re.I,
)
# Famous / already well-published online — downrank, don't exclude
OMEN_FAMOUS = re.compile(r"\b(SAA\s*8|SAA\s*10|SAA\s*4)\b", re.I)

# DISZ omen protasis; BE-lines; šumma
OMEN_ATF = {
    "disz_line": re.compile(r"(?m)^\d+[a-z']*\.\s*_?DISZ\b"),
    "be_line": re.compile(r"(?m)^\d+[a-z']*\.\s*BE\b"),
    "summa": re.compile(r"\b(szum-ma|szumma|sum-ma|DIŠ)\b", re.I),
    "body_part": re.compile(
        r"\b(sag-ki|sag-du|igi-min|gesztug|kir4|nundum|gaba|sza3|"
        r"szu-si|gir3|ubur|gu2|te\b|murub4)\b",
        re.I,
    ),
    "liver": re.compile(r"\b(giš-tukul|na\b|zi\b|gír|kal\b|é|pad)\b"),  # weak
    "apodosis": re.compile(
        r"\b(lugal|kur\b|ug7|ti-la|si-sa2|hul\b|sig5|uku2|nig2-tuku|"
        r"arhusz|pa-sza2-ha|u4-mesz)\b",
        re.I,
    ),
}

OMEN_BLURBS = {
    "physiognomy": "Physiognomy — body/face omens",
    "extispicy": "Extispicy — liver / sacrificial-omens",
    "omens from births": "Birth omens (Šumma izbu-type)",
    "dreams": "Dream omens",
    "mul.apin": "Mul.Apin astronomical omens / star list",
    "šumma tirku": "Skin-spot omens (šumma tirku)",
    "kittabru": "Mole / wart omens (Šumma kittabru)",
}

# Literary compositions that mention "dream" but are not omen series
OMEN_FALSE_POSITIVE = re.compile(
    r"dumuzi.?s?\s*dream|etcsl\s*1\.04\.03|literary\s*000347",
    re.I,
)

OMEN_KIND_LABELS = {
    "physiognomy": "Physiognomy",
    "extispicy": "Liver / extispicy",
    "birth": "Birth (izbu)",
    "astral": "Astral / Mul.Apin",
    "skin": "Skin spots",
    "moles": "Moles / kittabru",
    "dream": "Dreams",
    "series": "Omen series",
}

MATH_KIND_LABELS = {
    "reciprocal": "Reciprocals",
    "multiplication": "Multiplication",
    "metrology": "Metrology",
    "coefficient": "Coefficients",
    "problem": "Problem text",
    "math": "Math",
}

# ---------------------------------------------------------------------------
# Math signals
# ---------------------------------------------------------------------------
MATH_SUB = re.compile(
    r"math|metrol|reciproc|multipl|coefficient|algebra|geom|"
    r"igi-gub|problem\s*text|table\s*of|numerical",
    re.I,
)
MATH_DES = re.compile(
    r"\b(MCT|TMB|TMS|ACT\b|MAD\s*\d|OIP\s*11|HS\s*\d+|YBC\s*\d+|Plimpton|"
    r"metrological|mathematical|reciprocal|multiplication\s*table)\b",
    re.I,
)
MATH_FAMOUS = re.compile(r"\b(Plimpton\s*322|ACT\b)\b", re.I)

MATH_ATF = {
    "igi": re.compile(r"\bigi\b", re.I),
    "ara": re.compile(r"\ba-ra[2₂]?\b", re.I),
    "ibsi": re.compile(r"\bib2?-si8\b", re.I),
    "igigub": re.compile(r"\bigi-gub\b", re.I),
    "sexagesimal": re.compile(
        r"\b\d+\([a-z0-9]+\)(?:\s+\d+\([a-z0-9]+\)){2,}", re.I
    ),
    "ninda_sar": re.compile(r"\b(ninda|sar\b|iku|bur3|ubu|ese3)\b", re.I),
    "table_row": re.compile(r"(?m)^\d+[a-z']*\.\s*[\d(]"),
    "ba_zi": re.compile(r"\b(ba-zi|ib2-tak4|szu-nigin2?)\b", re.I),
}


def load_catalogue(csv_path: Path) -> dict[str, dict]:
    cat: dict[str, dict] = {}
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            id_text = (row.get("id_text") or "").strip()
            if not id_text.isdigit():
                continue
            p = f"P{int(id_text):06d}"
            cat[p] = row
    return cat


def stream_atf(atf_path: Path):
    """Yield (pid, designation_line, body_lines)."""
    pid = None
    desig = ""
    buf: list[str] = []

    with open(atf_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("&P"):
                if pid and buf:
                    yield pid, desig, buf
                m = re.match(r"&P(\d+)", line)
                pid = f"P{int(m.group(1)):06d}" if m else None
                desig = line.strip()
                buf = [line]
            elif pid:
                buf.append(line)
        if pid and buf:
            yield pid, desig, buf


def content_stats(body: list[str]) -> tuple[int, int, str]:
    cl = 0
    ch = 0
    content_line_re = re.compile(r"^\d+[a-z']*\.")
    for line in body:
        s = line.strip()
        if content_line_re.match(s):
            cl += 1
            ch += len(s)
    return cl, ch, "".join(body)


def classify_omen_kind(blurb: str, sub: str = "", des: str = "", genre: str = "") -> str | None:
    """Return subtype kind, or None for known literary false positives."""
    blob = f"{blurb} {sub} {des} {genre}".lower()
    if OMEN_FALSE_POSITIVE.search(blob):
        return None
    if "mul.apin" in blob or "astral" in blob or "eae" in blob or "enuma anu" in blob:
        return "astral"
    if "extispic" in blob or "liver" in blob or "sacrificial" in blob:
        return "extispicy"
    if "birth" in blob or "izbu" in blob:
        return "birth"
    if "dream" in blob:
        return "dream"
    if "tirku" in blob or "skin" in blob:
        return "skin"
    if "kittabru" in blob or "mole" in blob or "wart" in blob:
        return "moles"
    if "physiogn" in blob or "tbp" in blob or "body" in blob or "face" in blob:
        return "physiognomy"
    return "series"


def classify_math_kind(blurb: str, sub: str = "", des: str = "") -> str:
    blob = f"{blurb} {sub} {des}".lower()
    if "reciproc" in blob or "(igi)" in blob:
        return "reciprocal"
    if "coefficient" in blob or "igi-gub" in blob:
        return "coefficient"
    if "problem" in blob:
        return "problem"
    if "multipl" in blob or "a-rá" in blob or "a-ra" in blob or "×" in blob:
        return "multiplication"
    if "metrol" in blob:
        return "metrology"
    return "math"


def score_omen(row: dict, body_text: str, lines: int) -> tuple[float, dict, str, str | None]:
    g = (row.get("genre") or "").strip()
    s = (row.get("subgenre") or "").strip()
    des = f"{row.get('designation') or ''} {row.get('primary_publication') or ''}"
    blob = f"{g} {s} {des}"

    if OMEN_FALSE_POSITIVE.search(blob):
        return 0, {"false_positive": True}, "Literary (not omen)", None

    scores: dict[str, float] = {}
    if g.lower() == "omen":
        scores["genre_omen"] = 40
    if OMEN_SUB.search(s) or OMEN_SUB.search(blob):
        scores["sub_match"] = 35
    if OMEN_DES.search(des):
        scores["des_match"] = 20

    disz = len(OMEN_ATF["disz_line"].findall(body_text))
    be = len(OMEN_ATF["be_line"].findall(body_text))
    bodyp = len(OMEN_ATF["body_part"].findall(body_text))
    apod = len(OMEN_ATF["apodosis"].findall(body_text))
    scores["disz_lines"] = min(disz, 80) * 1.2
    scores["be_lines"] = min(be, 40) * 0.8
    scores["body_parts"] = min(bodyp, 40) * 0.5
    scores["apodosis"] = min(apod, 50) * 0.3
    scores["size"] = min(lines, 400) * 0.25

    # Diversity bonus for named series types
    blurb = ""
    sl = s.lower()
    for key, label in OMEN_BLURBS.items():
        if key in sl or key.replace("š", "sz") in sl:
            blurb = label
            scores["typed"] = 15
            break
    if not blurb:
        if "extispic" in sl:
            blurb = OMEN_BLURBS["extispicy"]
        elif "physiogn" in sl or "tirku" in sl or "kittabru" in des.lower() or "tbp" in des.lower():
            blurb = "Physiognomy / body omens"
        elif "izbu" in sl or "birth" in sl:
            blurb = OMEN_BLURBS["omens from births"]
        elif "dream" in sl:
            blurb = OMEN_BLURBS["dreams"]
        elif "mul" in sl or "eae" in sl or "enuma" in sl:
            blurb = "Astral / EAE-type omens"
        elif g.lower() == "omen":
            blurb = "Omen series (type unspecified)"
        else:
            blurb = "Omen-like tablet"

    kind = classify_omen_kind(blurb, s, des, g)
    total = sum(v for v in scores.values() if isinstance(v, (int, float)))
    if OMEN_FAMOUS.search(des):
        total *= 0.55
        scores["famous_penalty"] = True
    # Need real omen signal
    if kind is None or (total < 45 and disz < 5 and g.lower() != "omen"):
        return 0, scores, blurb, kind
    return total, scores, blurb, kind


def score_math(row: dict, body_text: str, lines: int) -> tuple[float, dict, str, str]:
    g = (row.get("genre") or "").strip()
    s = (row.get("subgenre") or "").strip()
    des = f"{row.get('designation') or ''} {row.get('primary_publication') or ''}"
    blob = f"{g} {s} {des}"

    scores: dict[str, float] = {}
    if re.search(r"math", g, re.I):
        scores["genre_math"] = 50
    if MATH_SUB.search(s) or MATH_SUB.search(blob):
        scores["sub_match"] = 40
    if MATH_DES.search(des):
        scores["des_match"] = 25
    if "metrol" in s.lower() or "metrol" in blob.lower():
        scores["metrol"] = 30

    igi = len(MATH_ATF["igi"].findall(body_text))
    ara = len(MATH_ATF["ara"].findall(body_text))
    ibsi = len(MATH_ATF["ibsi"].findall(body_text))
    igigub = len(MATH_ATF["igigub"].findall(body_text))
    sex = len(MATH_ATF["sexagesimal"].findall(body_text))
    ninda = len(MATH_ATF["ninda_sar"].findall(body_text))
    trows = len(MATH_ATF["table_row"].findall(body_text))

    scores["igi"] = min(igi, 60) * 1.5
    scores["ara"] = min(ara, 40) * 2.0
    scores["ibsi"] = min(ibsi, 20) * 3.0
    scores["igigub"] = min(igigub, 20) * 4.0
    scores["sexagesimal"] = min(sex, 40) * 1.2
    scores["area_units"] = min(ninda, 30) * 0.6
    scores["table_rows"] = min(trows, 100) * 0.15
    scores["size"] = min(lines, 300) * 0.2

    # blurb
    if "metrol" in s.lower() or "metrol" in blob.lower():
        blurb = "Metrological table / list"
    elif igigub >= 2 or "coefficient" in blob.lower():
        blurb = "Coefficient / igi-gub list"
    elif ara >= 3 or "multipl" in blob.lower():
        blurb = "Multiplication / a-rá table"
    elif igi >= 5 or "reciproc" in blob.lower():
        blurb = "Reciprocal (igi) table"
    elif ibsi >= 1 or "problem" in blob.lower():
        blurb = "Mathematical problem text"
    elif re.search(r"math", g, re.I):
        blurb = "Mathematical tablet"
    else:
        blurb = "Numerical / school math"

    kind = classify_math_kind(blurb, s, des)
    total = sum(v for k, v in scores.items() if isinstance(v, (int, float)))
    if MATH_FAMOUS.search(des):
        total *= 0.5
        scores["famous_penalty"] = True

    # Filter false positives: admin accounts with a-ra and ninda
    admin = bool(re.search(r"^admin", g, re.I))
    pure_signal = (
        scores.get("genre_math", 0)
        + scores.get("sub_match", 0)
        + scores.get("des_match", 0)
        + scores.get("metrol", 0)
        + scores.get("igigub", 0)
        + scores.get("ibsi", 0)
        + scores.get("ara", 0)
        + scores.get("igi", 0)
    )
    if admin and pure_signal < 80:
        # Keep metro-mathematical ledgers only if strongly tagged
        if "metro" not in (s + " " + blob).lower():
            return 0, scores, blurb, kind
        total *= 0.45
        scores["admin_penalty"] = True
    if pure_signal < 25 and total < 55:
        return 0, scores, blurb, kind
    return total, scores, blurb, kind


def prefilter_row(row: dict) -> tuple[bool, bool]:
    """Return (maybe_omen, maybe_math) from catalogue alone."""
    g = (row.get("genre") or "").strip()
    s = (row.get("subgenre") or "").strip()
    des = f"{row.get('designation') or ''} {row.get('primary_publication') or ''}"
    blob = f"{g} {s} {des}"
    omen = g.lower() == "omen" or bool(OMEN_SUB.search(blob)) or bool(OMEN_DES.search(des))
    math = bool(re.search(r"math", g, re.I)) or bool(MATH_SUB.search(blob)) or bool(
        MATH_DES.search(des)
    )
    return omen, math


def entry_from_row(
    pid: str,
    row: dict,
    lines: int,
    chars: int,
    score: float,
    blurb: str,
    kind: str,
    detail: dict,
    sample: list[str],
) -> dict:
    g = (row.get("genre") or "").strip()
    s = (row.get("subgenre") or "").strip()
    des = (row.get("designation") or "").strip()
    period = (row.get("period") or "").strip()
    lang = (row.get("language") or "").strip()
    site_raw = (row.get("provenience") or "").strip()
    site, lat, lon = normalize_site(site_raw)
    primary = (row.get("primary_publication") or "").strip()
    pub_hist = (row.get("publication_history") or "").strip()
    tr_src = (row.get("translation_source") or "").strip()
    status = classify_translation(
        designation=des,
        subgenre=s,
        primary_publication=primary,
        publication_history=pub_hist,
        translation_source=tr_src,
        language=lang,
    )
    return {
        "id": pid,
        "score": round(score, 1),
        "lines": lines,
        "chars": chars,
        "des": des,
        "genre": g,
        "sub": s,
        "lang": lang,
        "period": period,
        "site": site or site_raw,
        "site_raw": site_raw,
        "lat": lat,
        "lon": lon,
        "primary": primary,
        "atf_src": (row.get("atf_source") or "").strip(),
        "museum_no": (row.get("museum_no") or "").strip(),
        "blurb": blurb,
        "kind": kind,
        "detail": {k: v for k, v in detail.items() if not isinstance(v, bool) or v is True},
        "sample": sample,
        **status,
        "year": period_year(period),
        "font": font_for(period, g, lang),
        "cdli_url": f"https://cdli.earth/artifacts/{int(pid[1:])}",
    }


def catalog_item_from_candidate(c: dict, flag: str, score_key: str) -> dict:
    """Shape a catalog.json item from a hunt candidate."""
    item = {
        "id": c["id"],
        "designation": c.get("des") or c["id"],
        "genre": c.get("genre") or "",
        "subgenre": c.get("sub") or "",
        "language": c.get("lang") or "",
        "period": c.get("period") or "",
        "year": c.get("year"),
        "provenience": c.get("site_raw") or c.get("site") or "",
        "site": c.get("site"),
        "lat": c.get("lat"),
        "lon": c.get("lon"),
        "content_lines": c.get("lines") or 0,
        "chars": c.get("chars") or 0,
        "atf_source": c.get("atf_src") or "",
        "translation_source": "",
        "museum_no": c.get("museum_no") or "",
        "primary_publication": c.get("primary") or "",
        "publication_history": "",
        "translation_status": c.get("translation_status") or "no_open_english",
        "translation_label": c.get("translation_label") or "No open English found",
        "translation_short": c.get("translation_short") or "No open English",
        "translation_detail": c.get("translation_detail") or "",
        "cdli_has_english": c.get("cdli_has_english", False),
        "open_english": c.get("open_english", False),
        "print_edition_likely": c.get("print_edition_likely", False),
        "untranslated_open": c.get("untranslated_open", True),
        "font": c.get("font") or "NotoSansCuneiform",
        "cdli_url": c.get("cdli_url"),
        "score": c.get("score") or 0,
        flag: True,
        score_key: c.get("score") or 0,
    }
    if flag == "omen_hunt":
        item["omen_blurb"] = c.get("blurb") or "Omen tablet"
        item["omen_kind"] = c.get("kind") or ""
    if flag == "math_hunt":
        item["math_blurb"] = c.get("blurb") or "Mathematical tablet"
        item["math_kind"] = c.get("kind") or ""
    return item


def package_text(
    pid: str,
    body: list[str],
    meta: dict,
    extra: dict,
    texts_dir: Path,
) -> dict:
    atf_full = "".join(body)
    if len(atf_full) > 120_000:
        atf_full = atf_full[:120_000] + "\n$ rest truncated for demo package\n"
    lines = parse_atf_lines(body[:8000] if len(body) > 8000 else body)
    keys = [
        "id",
        "designation",
        "genre",
        "subgenre",
        "language",
        "period",
        "year",
        "provenience",
        "site",
        "lat",
        "lon",
        "content_lines",
        "chars",
        "font",
        "known_elsewhere",
        "translation_status",
        "translation_label",
        "translation_short",
        "translation_detail",
        "cdli_has_english",
        "open_english",
        "print_edition_likely",
        "untranslated_open",
        "cdli_url",
        "museum_no",
        "primary_publication",
        "atf_source",
    ]
    # map candidate-style meta → package
    mapped = {
        "id": pid,
        "designation": meta.get("designation") or meta.get("des") or pid,
        "genre": meta.get("genre") or "",
        "subgenre": meta.get("subgenre") or meta.get("sub") or "",
        "language": meta.get("language") or meta.get("lang") or "",
        "period": meta.get("period") or "",
        "year": meta.get("year"),
        "provenience": meta.get("provenience") or meta.get("site_raw") or meta.get("site") or "",
        "site": meta.get("site"),
        "lat": meta.get("lat"),
        "lon": meta.get("lon"),
        "content_lines": meta.get("content_lines") or meta.get("lines") or 0,
        "chars": meta.get("chars") or 0,
        "font": meta.get("font") or "NotoSansCuneiform",
        "known_elsewhere": False,
        "translation_status": meta.get("translation_status"),
        "translation_label": meta.get("translation_label"),
        "translation_short": meta.get("translation_short"),
        "translation_detail": meta.get("translation_detail"),
        "cdli_has_english": meta.get("cdli_has_english", False),
        "open_english": meta.get("open_english", False),
        "print_edition_likely": meta.get("print_edition_likely", False),
        "untranslated_open": meta.get("untranslated_open", True),
        "cdli_url": meta.get("cdli_url") or f"https://cdli.earth/artifacts/{int(pid[1:])}",
        "museum_no": meta.get("museum_no") or "",
        "primary_publication": meta.get("primary_publication") or meta.get("primary") or "",
        "atf_source": meta.get("atf_source") or meta.get("atf_src") or "",
    }
    pkg = {
        **{k: mapped.get(k) for k in keys},
        **extra,
        "atf": atf_full,
        "lines": lines,
        "english": None,
        "english_note": "No model translation yet — use Translate in the reader.",
        "status": "atf_only",
        "has_machine_draft": False,
        "machine_draft_lines": 0,
    }
    (texts_dir / f"{pid}.json").write_text(
        json.dumps(pkg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {
        "id": pid,
        "designation": pkg.get("designation"),
        "genre": pkg.get("genre"),
        "lines": pkg.get("content_lines"),
        "font": pkg.get("font"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--deep-cuneiform",
        type=Path,
        default=ROOT.parent / "deep-cuneiform",
    )
    ap.add_argument("--omen-top", type=int, default=60)
    ap.add_argument("--math-top", type=int, default=40)
    ap.add_argument("--catalog-omen", type=int, default=35)
    ap.add_argument("--catalog-math", type=int, default=25)
    args = ap.parse_args()

    dc = args.deep_cuneiform
    atf_path = dc / "data/cdli-gh-data/cdliatf_unblocked.atf"
    csv_path = dc / "data/cdli-gh-data/cdli_cat.csv"
    if not atf_path.exists() or not csv_path.exists():
        raise SystemExit(f"CDLI dump not found under {dc}/data/cdli-gh-data/")

    data_dir = ROOT / "data"
    texts_dir = data_dir / "texts"
    data_dir.mkdir(parents=True, exist_ok=True)
    texts_dir.mkdir(parents=True, exist_ok=True)

    print("Loading catalogue…")
    cat = load_catalogue(csv_path)
    print(f"  {len(cat)} rows")

    # Prefilter set for speed (still score ATF for those)
    want_omen: set[str] = set()
    want_math: set[str] = set()
    for pid, row in cat.items():
        o, m = prefilter_row(row)
        if o:
            want_omen.add(pid)
        if m:
            want_math.add(pid)
    print(f"  prefilter omen-ish {len(want_omen)} math-ish {len(want_math)}")

    # Always include known gems if in dump
    force_omen = {"P480113", "P293400", "P365915", "P480106", "P480107", "P394166"}
    force_math = {"P464229", "P227751", "P229294"}
    want_omen |= force_omen
    want_math |= force_math
    want = want_omen | want_math

    omen_hits: list[dict] = []
    math_hits: list[dict] = []
    bodies: dict[str, list[str]] = {}

    print("Scanning ATF dump…")
    n_seen = 0
    for pid, desig, body in stream_atf(atf_path):
        n_seen += 1
        if n_seen % 25000 == 0:
            print(f"  …{n_seen} texts")
        if pid not in want:
            continue
        row = cat.get(pid)
        if not row:
            continue
        lines, chars, text = content_stats(body)
        if lines < 12:
            continue
        sample = [
            ln.strip()
            for ln in body
            if re.match(r"^\d+", ln.strip())
        ][:6]

        if pid in want_omen:
            sc, detail, blurb, kind = score_omen(row, text, lines)
            if kind and (sc >= 45 or pid in force_omen):
                e = entry_from_row(pid, row, lines, chars, sc, blurb, kind, detail, sample)
                omen_hits.append(e)
                bodies[pid] = body

        if pid in want_math:
            sc, detail, blurb, kind = score_math(row, text, lines)
            if sc >= 40 or pid in force_math:
                e = entry_from_row(pid, row, lines, chars, sc, blurb, kind, detail, sample)
                math_hits.append(e)
                bodies[pid] = body

    omen_hits.sort(key=lambda x: -x["score"])
    math_hits.sort(key=lambda x: -x["score"])
    # de-dupe by id keep best
    def dedupe(items):
        seen = set()
        out = []
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            out.append(it)
        return out

    omen_hits = dedupe(omen_hits)[: args.omen_top]
    math_hits = dedupe(math_hits)[: args.math_top]

    omen_path = data_dir / "omen_candidates.json"
    math_path = data_dir / "math_candidates.json"
    omen_path.write_text(
        json.dumps(
            {
                "note": "Interesting omen tablets from local CDLI dump (physiognomy, extispicy, izbu, EAE…)",
                "count": len(omen_hits),
                "items": omen_hits,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    math_path.write_text(
        json.dumps(
            {
                "note": "Interesting math/metrology tablets from local CDLI dump",
                "count": len(math_hits),
                "items": math_hits,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {omen_path} ({len(omen_hits)})")
    print(f"Wrote {math_path} ({len(math_hits)})")

    # Featured picks
    def pick_featured(items: list[dict], n: int, prefer_ids: list[str]) -> list[str]:
        ids = []
        for pid in prefer_ids:
            if any(x["id"] == pid for x in items) and pid not in ids:
                ids.append(pid)
        for it in items:
            if it["id"] not in ids:
                ids.append(it["id"])
            if len(ids) >= n:
                break
        return ids[:n]

    omen_featured = pick_featured(
        omen_hits,
        6,
        ["P480113", "P365915", "P452591", "P479385", "P453398", "P236901"],
    )
    math_featured = pick_featured(
        math_hits,
        5,
        ["P257557", "P464229", "P368713", "P229294", "P493017"],
    )

    omen_blurbs = {c["id"]: c["blurb"] for c in omen_hits if c["id"] in omen_featured}
    math_blurbs = {c["id"]: c["blurb"] for c in math_hits if c["id"] in math_featured}
    # also blurbs for all catalog-bound
    for c in omen_hits[: args.catalog_omen]:
        omen_blurbs.setdefault(c["id"], c["blurb"])
    for c in math_hits[: args.catalog_math]:
        math_blurbs.setdefault(c["id"], c["blurb"])

    # Merge into catalog
    catalog_path = data_dir / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    by_id = {it["id"]: it for it in catalog["items"]}

    omen_for_cat = omen_hits[: args.catalog_omen]
    math_for_cat = math_hits[: args.catalog_math]

    for c in omen_for_cat:
        pid = c["id"]
        if pid in by_id:
            by_id[pid]["omen_hunt"] = True
            by_id[pid]["omen_score"] = c["score"]
            by_id[pid]["omen_blurb"] = c["blurb"]
            by_id[pid]["omen_kind"] = c.get("kind") or ""
        else:
            by_id[pid] = catalog_item_from_candidate(c, "omen_hunt", "omen_score")

    for c in math_for_cat:
        pid = c["id"]
        if pid in by_id:
            by_id[pid]["math_hunt"] = True
            by_id[pid]["math_score"] = c["score"]
            by_id[pid]["math_blurb"] = c["blurb"]
            by_id[pid]["math_kind"] = c.get("kind") or ""
        else:
            by_id[pid] = catalog_item_from_candidate(c, "math_hunt", "math_score")

    catalog["items"] = list(by_id.values())
    catalog["count"] = len(catalog["items"])
    catalog["omens"] = {
        "enabled": True,
        "count": sum(1 for it in catalog["items"] if it.get("omen_hunt")),
        "note": "Physiognomy, extispicy, birth, skin, moles, and astral omen tablets",
        "featured": omen_featured,
        "blurbs": omen_blurbs,
        "kinds": sorted(
            {
                it.get("omen_kind")
                for it in catalog["items"]
                if it.get("omen_hunt") and it.get("omen_kind")
            }
        ),
    }
    catalog["math"] = {
        "enabled": True,
        "count": sum(1 for it in catalog["items"] if it.get("math_hunt")),
        "note": "Metrological tables, reciprocals, multiplication, school math",
        "featured": math_featured,
        "blurbs": math_blurbs,
        "kinds": sorted(
            {
                it.get("math_kind")
                for it in catalog["items"]
                if it.get("math_hunt") and it.get("math_kind")
            }
        ),
    }
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"Catalog updated: {catalog['omens']['count']} omens, "
        f"{catalog['math']['count']} math (total items {catalog['count']})"
    )

    # Package featured + a few top extras
    package_ids = list(
        dict.fromkeys(
            omen_featured
            + math_featured
            + [c["id"] for c in omen_for_cat[:8]]
            + [c["id"] for c in math_for_cat[:6]]
        )
    )

    # load existing manifest
    man_path = texts_dir / "manifest.json"
    if man_path.exists():
        manifest = json.loads(man_path.read_text(encoding="utf-8"))
    else:
        manifest = []
    man_by = {m["id"]: m for m in manifest}

    # Need bodies for packaging — re-fetch if missing
    need = [pid for pid in package_ids if pid not in bodies]
    if need:
        print(f"Re-scan for {len(need)} package bodies…")
        need_set = set(need)
        for pid, desig, body in stream_atf(atf_path):
            if pid in need_set:
                bodies[pid] = body
                need_set.discard(pid)
                if not need_set:
                    break

    cand_by = {c["id"]: c for c in omen_hits + math_hits}
    packaged_n = 0
    for pid in package_ids:
        body = bodies.get(pid)
        if not body:
            print(f"  skip package {pid}: no ATF body")
            continue
        meta = by_id.get(pid) or cand_by.get(pid) or {"id": pid}
        extra = {}
        cand = cand_by.get(pid) or {}
        omenish = meta.get("omen_hunt") or (
            cand.get("kind")
            in {
                "physiognomy",
                "extispicy",
                "birth",
                "astral",
                "skin",
                "moles",
                "dream",
                "series",
                "omen",
            }
        )
        mathish = meta.get("math_hunt") or (
            cand.get("kind")
            in {
                "reciprocal",
                "multiplication",
                "metrology",
                "coefficient",
                "problem",
                "math",
            }
        )
        if omenish:
            extra["omen_hunt"] = True
            extra["omen_blurb"] = meta.get("omen_blurb") or cand.get("blurb")
            extra["omen_score"] = meta.get("omen_score") or cand.get("score")
            extra["omen_kind"] = meta.get("omen_kind") or cand.get("kind")
        if mathish:
            extra["math_hunt"] = True
            extra["math_blurb"] = meta.get("math_blurb") or cand.get("blurb")
            extra["math_score"] = meta.get("math_score") or cand.get("score")
            extra["math_kind"] = meta.get("math_kind") or cand.get("kind")
        # merge into existing package if present (preserve english)
        existing_path = texts_dir / f"{pid}.json"
        if existing_path.exists():
            old = json.loads(existing_path.read_text(encoding="utf-8"))
            old.update({k: v for k, v in extra.items() if v is not None})
            # also refresh meta fields lightly
            for k in (
                "omen_blurb",
                "math_blurb",
                "omen_hunt",
                "math_hunt",
                "omen_score",
                "math_score",
                "omen_kind",
                "math_kind",
            ):
                if k in extra:
                    old[k] = extra[k]
            existing_path.write_text(
                json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            man_by[pid] = {
                "id": pid,
                "designation": old.get("designation"),
                "genre": old.get("genre"),
                "lines": old.get("content_lines"),
                "font": old.get("font"),
            }
            packaged_n += 1
            print(f"  updated package {pid}")
        else:
            m = package_text(pid, body, meta if "designation" in meta or "des" in meta else cand_by.get(pid, meta), extra, texts_dir)
            man_by[pid] = m
            packaged_n += 1
            print(f"  packaged {pid}")

    man_path.write_text(
        json.dumps(list(man_by.values()), indent=2), encoding="utf-8"
    )
    print(f"Packaged/updated {packaged_n} texts; manifest size {len(man_by)}")

    print("\nFeatured omens:")
    for pid in omen_featured:
        c = cand_by.get(pid) or {}
        print(f"  {pid}  {c.get('score')}  {c.get('blurb')}  — {c.get('des', '')[:50]}")
    print("Featured math:")
    for pid in math_featured:
        c = cand_by.get(pid) or {}
        print(f"  {pid}  {c.get('score')}  {c.get('blurb')}  — {c.get('des', '')[:50]}")


if __name__ == "__main__":
    main()
