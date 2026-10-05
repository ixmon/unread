# unread

A **web reader** for works that already have a source text but little or no open translation. The first corpus is cuneiform: ATF (transliteration) with little or no open English on CDLI. The tool is meant to grow past cuneiform.

Browse by genre, site, and period; open a three-column reader (**English · ATF · cuneiform**); scrub a timeline; pin findspots on a map.

Period-accurate cuneiform faces match the [eBL cuneiform converter](https://www.ebl.lmu.de/tools/cuneiform-converter) (Neo-Assyrian, Neo-Babylonian, Old Babylonian / Literature / Monumental, Hittite).

## Quick start

```bash
# Static reader — 0.0.0.0:42225 (8765 is used by the line-art app)
./scripts/serve.sh

# Translate API — 0.0.0.0:42226 (loads atf-en-best-v2 via CUDA when available)
./scripts/serve_api.sh

# Reader:  http://<this-machine-ip>:42225/
# API:     http://<this-machine-ip>:42226/api/health
```

In the reader toolbar, **Translate** sends ATF lines to the API in chunks, fills the English column live, and saves back to `data/texts/P######.json` when packaged.

Override ports if needed:

```bash
./scripts/serve.sh 42225
PORT=42226 ./scripts/serve_api.sh
# Point the UI at a custom API: http://host:42225/?api=http://host:42226
```## Rebuild catalog from local CDLI dump

Requires the sibling checkout with the bulk dump:

- `../deep-cuneiform/data/cdli-gh-data/cdli_cat.csv`
- `../deep-cuneiform/data/cdli-gh-data/cdliatf_unblocked.atf`

```bash
python3 scripts/build_catalog.py
# options: --top 800 --samples 30 --deep-cuneiform /path/to/deep-cuneiform

# Specialty hunts (omens + math/metrology) — merge into catalog + package samples
python3 scripts/hunt_omens_math.py
```

This writes:

| Path | Purpose |
|------|---------|
| `data/catalog.json` | Ranked browse index (~800+ specialty flags) |
| `data/atf_unicode_readings.json` | Offline ATF → Unicode map (eBL readings) |
| `data/texts/P######.json` | Packaged full ATF samples for the reader |
| `data/texts/manifest.json` | List of packaged IDs |
| `data/omen_candidates.json` | Full-dump omen shortlist |
| `data/math_candidates.json` | Full-dump math/metrology shortlist |

## UI features

- **Explore** — search / genre / period / language / site filters  
- **Epic hunt / Remedies / Omens / Math** — specialty shortlists with featured buttons  
- **Prefer CDLI-untranslated** — hides RINAP / ETCSL / etc. heuristics (`known_elsewhere`)  
- **Map** — findspots (Leaflet + CARTO dark tiles)  
- **Time browser** — ranks works near the scrubber year  
- **Reader** — toggle English / ATF / cuneiform columns; switch eBL period fonts  
- **Offline cuneiform** — client-side reading map; optional live eBL API  
- Deep links: `?mode=omens&id=P480113` · `?mode=omens&kind=extispicy&id=P453398` · `?mode=math&kind=reciprocal&id=P257557`  

## Fonts

WOFF faces under `web/fonts/` are converted from the research tree (`deep-cuneiform/data/fonts/`), originally from [ebl-frontend](https://github.com/ElectronicBabylonianLiterature/ebl-frontend) (`src/signs/ui/display/fonts/`).

| Face | eBL label |
|------|-----------|
| Assurbanipal | Neo-Assyrian |
| Esagil | Neo-Babylonian |
| Santakku | Old Babylonian |
| OBFreie | Old Babylonian Literature |
| SantakkuM | Old Babylonian Monumental |
| UllikummiA | Hittite |
| NotoSansCuneiform | Broad Unicode fallback |

**Credit:** fonts developed by **C. Ziegeler** and **S. Vanseveren** (eBL). Check upstream terms before public redistribution outside research use.

## Related projects

| Repo | Role |
|------|------|
| [`atf-translate-test`](../atf-translate-test) | ATF → English T5 model (works well) |
| [`deep-cuneiform`](../deep-cuneiform) | Line-art → ATF (WIP), CDLI cache, OCR, fonts docs |

## Roadmap

1. ~~Static reader + catalog + fonts + map/time~~  
2. Batch translate packaged samples with local `atf-translate-test` model → fill `english` in `data/texts/*.json`  
3. Optional **Transformers.js / ONNX** in-browser model from Hugging Face for GitHub Pages demos  
4. Line-art path once `deep-cuneiform` OCR is solid  
5. GitHub Pages deploy (`web/` as site root)

## Data caveat

CDLI `translation_source = "no translation"` means **not in CDLI**, not necessarily “never translated.” Many large royal and literary texts are published in RINAP, ETCSL, ORACC, etc. The catalog sets `known_elsewhere` when designations match those projects so you can hide them while hunting fresher material (Ebla rituals, BAM medical, OB omens, obscure literary, …).

## License / attribution

- CDLI catalogue & ATF: follow [CDLI](https://cdli.earth/) terms  
- eBL fonts & sign list: follow eBL / author terms  
- App code in this repo: TBD (add a LICENSE when you publish)
