#!/usr/bin/env python3
"""
Build catalog.json, ATF→Unicode reading map, and packaged sample texts
from the local deep-cuneiform CDLI dump.

Usage (from repo root):
  python3 scripts/build_catalog.py
  python3 scripts/build_catalog.py --deep-cuneiform ../deep-cuneiform --top 800 --samples 30
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SITES = {
    "Umma (mod. Tell Jokha)": (31.67, 45.89),
    "Girsu (mod. Tello)": (31.56, 46.18),
    "Puzriš-Dagan (mod. Drehem)": (32.00, 45.00),
    "Nippur (mod. Nuffar)": (32.13, 45.23),
    "Ur (mod. Tell Muqayyar)": (30.96, 46.10),
    "Uruk (mod. Warka)": (31.32, 45.64),
    "Kanesh (mod. Kültepe)": (38.85, 35.63),
    "Adab (mod. Bismaya)": (31.95, 45.97),
    "Nineveh (mod. Kuyunjik)": (36.36, 43.15),
    "Susa (mod. Shush)": (32.19, 48.25),
    "Mari (mod. Tell Hariri)": (34.55, 40.89),
    "Ebla (mod. Tell Mardikh)": (35.80, 36.80),
    "Assur (mod. Qalat Sherqat)": (35.46, 43.26),
    "Sippar-Yahrurum (mod. Tell Abu Habbah)": (33.06, 44.25),
    "Kalhu (mod. Nimrud)": (36.10, 43.33),
    "Lagash (mod. El-Hiba)": (31.42, 46.41),
    "Akhetaten (mod. el-Amarna)": (27.65, 30.90),
    "Huzirina (mod. Sultantepe)": (37.05, 38.92),
    "Babylon (mod. Babylon)": (32.54, 44.42),
    "Borsippa (mod. Birs Nimrud)": (32.39, 44.34),
    "Isin (mod. Ishan al-Bahriyat)": (31.90, 45.27),
    "Larsa (mod. Tell as-Senkereh)": (31.29, 45.85),
    "Kish (mod. Tell Uhaimir)": (32.54, 44.60),
    "Shuruppak (mod. Fara)": (31.78, 45.51),
    "Eridu (mod. Tell Abu Shahrain)": (30.82, 45.99),
    "Nagar (mod. Tell Brak)": (36.67, 41.06),
    "Pārśa (mod. Persepolis)": (29.94, 52.89),
    "uncertain (mod. Behistun)": (34.39, 47.44),
    "Garšana (mod. uncertain)": (31.80, 45.70),
    "Irisagrig (mod. uncertain)": (32.10, 45.40),
    "Sippar-Amnanum (mod. Tell ed-Der)": (33.09, 44.30),
    "Dur-Sharrukin (mod. Khorsabad)": (36.51, 43.23),
    "Hattusa (mod. Boğazkale)": (40.02, 34.62),
    "Susarra (mod. Tell Shemshara)": (36.20, 44.90),
}

INTERESTING = re.compile(
    r"literary|royal|monumental|letter|scientific|omen|prayer|incantation|ritual|astronom",
    re.I,
)
ADMIN = re.compile(r"^administrative", re.I)

# Shared classifier (open English vs print edition vs gap)
sys_path_hook = Path(__file__).resolve().parent
if str(sys_path_hook) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(sys_path_hook))
from translation_status import classify_translation  # noqa: E402


def normalize_site(name: str | None):
    if not name:
        return None, None, None
    n = name.strip().rstrip(" ?")
    if n in SITES:
        lat, lon = SITES[n]
        return n, lat, lon
    for k, (lat, lon) in SITES.items():
        base = k.split(" (")[0]
        if n.startswith(base) or k.startswith(n.split(" (")[0]):
            return k, lat, lon
    return name, None, None


def period_year(period: str | None):
    if not period:
        return None
    m = re.search(r"(\d{3,4})\s*[-–]\s*(\d{3,4})\s*BC", period)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return -((a + b) // 2)
    m = re.search(r"ca\.\s*(\d{3,4})", period)
    if m:
        return -int(m.group(1))
    return None


def font_for(period: str, genre: str, language: str) -> str:
    p = (period or "").lower()
    g = (genre or "").lower()
    lang = (language or "").lower()
    if "hittite" in lang:
        return "UllikummiA"
    if "neo-assyrian" in p or "middle assyrian" in p:
        return "Assurbanipal"
    if "neo-babylonian" in p or "achaemenid" in p or "late babylonian" in p:
        return "Esagil"
    if "old babylonian" in p or "early old babylonian" in p:
        if "literary" in g:
            return "OBFreie"
        if "royal" in g or "monumental" in g:
            return "SantakkuM"
        return "Santakku"
    if "old akkadian" in p or "lagash" in p or "ed iii" in p:
        return "SantakkuM"
    return "NotoSansCuneiform"


def build_reading_map(dc: Path, out: Path) -> None:
    signs_path = (
        dc
        / "data/ebl/ebl_data/ebl-api/ebl/tests/atf_importer/test_data/signs.json"
    )
    ebl_map_path = dc / "data/dictionaries/ebl_reading_unicode.json"
    readings: dict = {}
    multi: dict = {}

    if signs_path.exists():
        signs = json.loads(signs_path.read_text(encoding="utf-8"))
        for s in signs:
            uni = s.get("unicode") or []
            if not uni:
                continue
            name = (s.get("_id") or "").lower()
            if name and name not in readings:
                readings[name] = uni
            for v in s.get("values") or []:
                val = (v.get("value") or "").lower()
                if not val:
                    continue
                sub = v.get("subIndex") or 99
                if val not in readings or sub == 1:
                    readings[val] = uni

    if ebl_map_path.exists():
        ebl = json.loads(ebl_map_path.read_text(encoding="utf-8"))
        for k, rec in (ebl.get("multi") or {}).items():
            uni = rec.get("unicode") if isinstance(rec, dict) else rec
            if isinstance(uni, list) and uni:
                multi[k.lower()] = uni
        for k, rec in (ebl.get("single_priority") or {}).items():
            cp = rec.get("unicode") if isinstance(rec, dict) else rec
            if isinstance(cp, int):
                readings[k.lower()] = [cp]

    out.write_text(
        json.dumps(
            {
                "source": "eBL signs.json + ebl_reading_unicode multi",
                "n_readings": len(readings),
                "n_multi": len(multi),
                "readings": readings,
                "multi": multi,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Wrote {out} ({len(readings)} readings, {len(multi)} multi)")


def parse_atf_dump(atf_path: Path):
    header_re = re.compile(r"^&(P\d+)\s*=\s*(.*)$")
    content_line_re = re.compile(r"^\d")
    texts: dict = {}
    bodies: dict = {}
    cur = None
    cl = ch = 0
    des = ""
    buf: list[str] = []

    def flush():
        nonlocal cur, cl, ch, des, buf
        if cur:
            texts[cur] = {"content_lines": cl, "chars": ch, "desig_atf": des}
            bodies[cur] = buf

    with open(atf_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = header_re.match(line)
            if m:
                flush()
                cur = m.group(1)
                des = m.group(2).strip()
                cl = ch = 0
                buf = [line]
                continue
            if cur is None:
                continue
            buf.append(line)
            s = line.strip()
            if content_line_re.match(s):
                cl += 1
                ch += len(s)
    flush()
    return texts, bodies


def parse_atf_lines(body_lines: list[str]) -> list[dict]:
    lines_out = []
    surface = ""
    column = ""
    for raw in body_lines:
        s = raw.rstrip("\n")
        if s.startswith("&") or s.startswith("#atf") or s.startswith("#link"):
            continue
        if s.startswith("@"):
            tag = s[1:].strip()
            if tag.startswith("column"):
                column = tag
            elif (
                tag
                in (
                    "obverse",
                    "reverse",
                    "surface a",
                    "surface b",
                    "left",
                    "right",
                    "top",
                    "bottom",
                    "tablet",
                    "fragment",
                )
                or tag.startswith("surface")
                or tag.startswith("object")
            ):
                surface = tag
                column = ""
            continue
        if s.startswith("$") or s.startswith(">>") or s.startswith("<<"):
            lines_out.append(
                {"type": "note", "text": s, "surface": surface, "column": column}
            )
            continue
        if not s.strip():
            continue
        m = re.match(r"^(\d+[a-z']*)\.\s*(.*)$", s.strip())
        if m:
            lines_out.append(
                {
                    "type": "line",
                    "n": m.group(1),
                    "atf": m.group(2),
                    "surface": surface,
                    "column": column,
                    "english": None,
                }
            )
        else:
            lines_out.append(
                {"type": "raw", "text": s, "surface": surface, "column": column}
            )
    return lines_out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--deep-cuneiform",
        type=Path,
        default=ROOT.parent / "deep-cuneiform",
    )
    ap.add_argument("--top", type=int, default=800)
    ap.add_argument("--samples", type=int, default=26)
    args = ap.parse_args()
    dc: Path = args.deep_cuneiform
    atf_path = dc / "data/cdli-gh-data/cdliatf_unblocked.atf"
    csv_path = dc / "data/cdli-gh-data/cdli_cat.csv"
    if not atf_path.exists() or not csv_path.exists():
        raise SystemExit(f"CDLI dump not found under {dc}/data/cdli-gh-data/")

    data_dir = ROOT / "data"
    texts_dir = data_dir / "texts"
    data_dir.mkdir(parents=True, exist_ok=True)
    texts_dir.mkdir(parents=True, exist_ok=True)

    build_reading_map(dc, data_dir / "atf_unicode_readings.json")

    print("Parsing ATF dump…")
    texts, bodies = parse_atf_dump(atf_path)
    print(f"  {len(texts)} texts")

    print("Loading catalogue…")
    cat: dict = {}
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            id_text = (row.get("id_text") or "").strip()
            if not id_text.isdigit():
                continue
            p = f"P{int(id_text):06d}"
            tr = (row.get("translation_source") or "").strip().lower()
            untranslated = tr in (
                "",
                "no translation",
                "none",
                "n/a",
                "no translation (witness)",
                "check",
                "uncertain",
            )
            cat[p] = row
            cat[p]["_untranslated"] = untranslated

    entries = []
    for p, st in texts.items():
        row = cat.get(p)
        if not row or not row["_untranslated"]:
            continue
        g = (row.get("genre") or "").strip()
        if ADMIN.match(g) and not INTERESTING.search(g):
            continue
        if not INTERESTING.search(g) and st["content_lines"] < 80:
            continue
        if st["content_lines"] < 25:
            continue
        des = (row.get("designation") or st["desig_atf"] or "").strip()
        period = (row.get("period") or "").strip()
        lang = (row.get("language") or "").strip()
        site_raw = (row.get("provenience") or "").strip()
        site, lat, lon = normalize_site(site_raw)
        pub_hist = (row.get("publication_history") or "").strip()
        primary = (row.get("primary_publication") or "").strip()
        sub = (row.get("subgenre") or "").strip()
        tr_src = (row.get("translation_source") or "").strip()
        status = classify_translation(
            designation=des,
            subgenre=sub,
            primary_publication=primary,
            publication_history=pub_hist,
            translation_source=tr_src,
            language=lang,
        )
        # Prefer true open-English gaps in ranking
        score_mult = 1.0
        if status["open_english"]:
            score_mult = 0.35
        elif status["print_edition_likely"]:
            score_mult = 0.75
        else:
            score_mult = 1.15
        entries.append(
            {
                "id": p,
                "designation": des,
                "genre": g,
                "subgenre": sub,
                "language": lang,
                "period": period,
                "year": period_year(period),
                "provenience": site_raw,
                "site": site,
                "lat": lat,
                "lon": lon,
                "content_lines": st["content_lines"],
                "chars": st["chars"],
                "atf_source": (row.get("atf_source") or "").strip(),
                "translation_source": tr_src,
                "museum_no": (row.get("museum_no") or "").strip(),
                "primary_publication": primary,
                "publication_history": pub_hist,
                **status,
                "font": font_for(period, g, lang),
                "cdli_url": f"https://cdli.earth/artifacts/{int(p[1:])}",
                "score": st["content_lines"]
                * score_mult
                * (1.2 if INTERESTING.search(g) else 0.8),
            }
        )

    entries.sort(key=lambda e: e["score"], reverse=True)
    top = entries[: args.top]
    catalog = {
        "generated": "from local CDLI dump + catalogue",
        "total_candidates": len(entries),
        "count": len(top),
        "note": (
            'CDLI "no translation" ≠ never translated. See translation_status: '
            "cdli_english | open_project | print_edition | no_open_english."
        ),
        "translation_status_legend": {
            "cdli_english": "CDLI records an English translation_source",
            "open_project": "Open digital English likely (RINAP, ETCSL, SAA, …)",
            "print_edition": "Print series (ARET, BAM, …) — scholarship translated it; not on CDLI",
            "no_open_english": "No CDLI English / open project / series hit — best open-English gap",
        },
        "items": top,
        "sites": {k: {"lat": v[0], "lon": v[1]} for k, v in SITES.items()},
    }
    (data_dir / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Wrote catalog ({len(top)} / {len(entries)} candidates)")

    demo_ids: list[str] = []
    for e in entries:
        if e["id"] in demo_ids:
            continue
        if e.get("open_english") and e["genre"] not in ("Omen", "Scientific"):
            continue
        if e["genre"] in (
            "Literary",
            "Omen",
            "Scientific",
            "Royal/Monumental",
            "Letter",
            "Prayer/Incantation",
        ):
            demo_ids.append(e["id"])
        if len(demo_ids) >= args.samples:
            break
    for forced in [
        "P293400",
        "P285254",
        "P241509",
        "P213189",
        "P343019",
        "P355698",
        "P221796",
    ]:
        if forced not in demo_ids and forced in texts:
            demo_ids.append(forced)

    manifest = []
    for pid in demo_ids:
        body = bodies.get(pid)
        if not body:
            continue
        meta = next((e for e in entries if e["id"] == pid), None) or {
            "id": pid,
            "designation": texts[pid]["desig_atf"],
            "genre": "",
            "period": "",
            "language": "",
            "font": "NotoSansCuneiform",
            "content_lines": texts[pid]["content_lines"],
            "chars": texts[pid]["chars"],
            "known_elsewhere": False,
            "site": None,
            "lat": None,
            "lon": None,
            "year": None,
            "cdli_url": f"https://cdli.earth/artifacts/{int(pid[1:])}",
        }
        atf_full = "".join(body)
        if len(atf_full) > 120_000:
            atf_full = atf_full[:120_000] + "\n$ rest truncated for demo package\n"
        lines = parse_atf_lines(body[:5000] if len(body) > 5000 else body)
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
        pkg = {
            **{k: meta.get(k) for k in keys},
            "atf": atf_full,
            "lines": lines,
            "english": None,
            "english_note": "No model translation yet — wire atf-translate-test or HF in-browser.",
            "status": "atf_only",
            "has_machine_draft": False,
            "machine_draft_lines": 0,
        }
        (texts_dir / f"{pid}.json").write_text(
            json.dumps(pkg, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        manifest.append(
            {
                "id": pid,
                "designation": pkg.get("designation"),
                "genre": pkg.get("genre"),
                "lines": pkg.get("content_lines"),
                "font": pkg.get("font"),
            }
        )

    (texts_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"Packaged {len(manifest)} sample texts → data/texts/")


if __name__ == "__main__":
    main()
