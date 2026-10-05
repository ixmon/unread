#!/usr/bin/env python3
"""
Classify how "untranslated" a CDLI work is for the reader UI.

Tiers (best → most "open gap"):
  cdli_english   — CDLI records a translation_source (human English on CDLI)
  open_project   — well-known digital corpora with open English (RINAP, ETCSL, …)
  print_edition  — standard published series usually include a translation in print
                   (ARET Italian, BAM, ARM, …) but CDLI has no English
  no_open_english — no CDLI English, no open-project hit, no series match
                   → best "first open English" candidates

Machine drafts are runtime (package english[]) and layered on in the UI.
"""

from __future__ import annotations

import re
from typing import Any

# Open digital English / major ORACC-style projects
OPEN_PROJECT = re.compile(
    r"\b("
    r"RINAP|RIMA|RIME|RINBE|ETCSL|SAA|SAAo|CMAwR|"
    r"CDLI\s*Literary|"  # often mirrors ETCSL
    r"Behistun|Persepolis Fortification|"
    r"Ashurbanipal|Sennacherib|Esarhaddon|Gudea\s*Cyl"
    r")\b",
    re.I,
)

# Print series that typically ship with translation / extensive commentary
# (language may be IT/DE/FR/EN — still "has been translated by scholars")
PRINT_EDITION = re.compile(
    r"\b("
    r"ARET|ARES|"  # Ebla — Fronzaroli et al. (often Italian)
    r"BAM|AMT|TCL\s*6|"  # medical / scholarly
    r"ARM|FM\s*\d|"  # Mari
    r"YOS\s*10|YOS\s*11|"  # omen / literary series
    r"CT\s*\d+|CTN|KAR|KAL|"
    r"EA\s*\d+|El-Amarna|Amarna\s*letter|"
    r"CUSAS|MSL|OBTR|AbB|TIM\s*\d|"
    r"VS\s*10|VS\s*17|"  # literary
    r"OIP\s*99|OIP\s*104|"  # Abu Salabikh / Manishtushu etc.
    r"ARET\s*11|ARET\s*13"
    r")\b",
    re.I,
)

# Explicit non-English markers in translation_source
NO_TRANS = {
    "",
    "no translation",
    "none",
    "n/a",
    "no translation (witness)",
    "check",
    "uncertain",
}


def _blob(*parts: str | None) -> str:
    return " ".join(p for p in parts if p)


def classify_translation(
    *,
    designation: str = "",
    subgenre: str = "",
    primary_publication: str = "",
    publication_history: str = "",
    translation_source: str = "",
    language: str = "",
) -> dict[str, Any]:
    """Return status fields for catalog / UI."""
    tr = (translation_source or "").strip()
    tr_l = tr.lower()
    blob = _blob(designation, subgenre, primary_publication, publication_history)

    cdli_has_english = bool(tr) and tr_l not in NO_TRANS
    open_hit = OPEN_PROJECT.search(blob)
    print_hit = PRINT_EDITION.search(blob)

    if cdli_has_english:
        status = "cdli_english"
        label = "CDLI English"
        detail = f"CDLI translation_source: {tr}"
        short = "CDLI has English"
        open_english = True
        print_edition = bool(print_hit)
    elif open_hit:
        status = "open_project"
        label = "Open English elsewhere"
        detail = f"Likely open English via {open_hit.group(0)} (ORACC / ETCSL / similar)"
        short = f"Open: {open_hit.group(0)}"
        open_english = True
        print_edition = bool(print_hit)
    elif print_hit:
        status = "print_edition"
        label = "Print edition (no CDLI English)"
        detail = (
            f"Published series match ({print_hit.group(0)}) — scholars have almost certainly "
            f"translated this (often IT/DE/FR/EN in print), but CDLI has no English text"
        )
        short = f"Print: {print_hit.group(0)}"
        open_english = False
        print_edition = True
    else:
        status = "no_open_english"
        label = "No open English found"
        detail = (
            "CDLI has no English; no RINAP/ETCSL-style project hit; no common print-series "
            "match. Strong candidate for a first open English reading (still verify literature)."
        )
        short = "No open English"
        open_english = False
        print_edition = False

    # "Untranslated" in the product sense: no open digital English
    untranslated_open = not open_english

    return {
        "translation_status": status,
        "translation_label": label,
        "translation_short": short,
        "translation_detail": detail,
        "cdli_has_english": cdli_has_english,
        "open_english": open_english,
        "print_edition_likely": print_edition,
        "untranslated_open": untranslated_open,
        # keep legacy flag = open digital English known
        "known_elsewhere": open_english and not cdli_has_english,
    }


def badge_class(status: str) -> str:
    return {
        "cdli_english": "status-cdli",
        "open_project": "status-open",
        "print_edition": "status-print",
        "no_open_english": "status-fresh",
    }.get(status, "status-unknown")
