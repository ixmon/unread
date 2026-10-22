# Unread Atlas

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
- **Search results on the map** (`web/js/searchmap.js`) — a corpus search over the Unread Atlas API pinned at find-spots (one circle per site, sized by tablets, merged when they overlap; fades with the time browser). Deep link `index.html?q=barley&period=Ur%20III` (also `in`, `genre`, `site`, `src`; `searchapi=` overrides the API); search.html's “Show on map” button opens it. Uses `GET /search/sites` and `/search?at=<site key>` (private `ixmon/aws-cunei-search`).  
- **Reader** — toggle English / ATF / cuneiform columns; cuneiform face chosen by period (override per session)  
- **Offline cuneiform** — client-side reading map; optional live eBL API  
- Deep links: `?mode=omens&id=P480113` · `?mode=omens&kind=extispicy&id=P453398` · `?mode=math&kind=reciprocal&id=P257557`  

## Fonts

Cuneiform is drawn in a period-matched face. **One table** decides which: [`web/fonts/fonts.json`](web/fonts/fonts.json)
(`fonts` = the shipped faces with author/licence/source, `rules` = ordered period/language/genre regexes).
The reader (`web/js/fontmap.js`), the static text pages (`scripts/build_static.py`) and the catalog builder
(`scripts/build_catalog.py`, via `scripts/font_map.py`) all read it. `@font-face` rules are added only for the face a
page actually uses (+ the Noto fallback), with `font-display: swap`. The reader's *Cuneiform face* menu overrides the
automatic choice for the current browser session.

| Rule (first match wins) | Face | Basis |
|------|------|------|
| language Hittite | UllikummiA | eBL “Hittite” |
| period Neo-Assyrian | Assurbanipal | eBL “Neo-Assyrian” |
| period Middle Assyrian | Assurbanipal | extension (no eBL MA face) |
| period Neo-Babylonian | Esagil | eBL “Neo-Babylonian” |
| period Late Babylonian / Achaemenid / Hellenistic | Esagil | extension (LB script continues NB forms) |
| period Old Babylonian + genre Literary | OBFreie | eBL “Old Babylonian Literature” |
| period Old Babylonian + genre Royal/Monumental | SantakkuM | eBL “Old Babylonian Monumental” |
| period Old Babylonian (other) | Santakku | eBL “Old Babylonian” (cursive) |
| everything else (Uruk, ED, Old Akkadian, Lagash II, Ur III, Old Assyrian, Middle Babylonian, Ebla, unknown) | Noto Sans Cuneiform | eBL has no face for these |

Signs a face lacks fall back to Noto Sans Cuneiform (eBL uses Adobe Blank, which hides them).

### Font credits and licences

- **Assurbanipal, Esagil, Santakku, SantakkuM, UllikummiA**: fonts created by **Sylvie Vanséveren**, available on the
  [Hethitologie Portal Mainz](https://hethport.net/cuneifont/). Terms: free of charge; may be used for academic and
  research purposes and on scholarly websites; must not be modified, distributed in modified form, or distributed
  commercially; credit required. We ship the exact files distributed by
  [ebl-frontend](https://github.com/ElectronicBabylonianLiterature/ebl-frontend) (commit `9916eb1d`,
  `src/Assurbanipal.woff2`, `src/signs/ui/display/fonts/*.woff`), not converted by us.
- **OB Freie** (Old Babylonian literary): © 2024 **Corvin R. Ziegeler** and Institut für Altorientalistik, FU Berlin
  (Latin glyphs from Junicode by Peter S. Baker), [SIL OFL 1.1](web/fonts/OFL-OBFreie.txt);
  publication <https://doi.org/10.17169/refubium-44983>. Repackaged from eBL's WOFF to WOFF2 (lossless, no subsetting).
- **Noto Sans Cuneiform**: Noto project (Google / Monotype), [SIL OFL 1.1](web/fonts/OFL-NotoSansCuneiform.txt). Repackaged as WOFF2.
- Not shipped: Vanséveren's **Bisitun / Persepolis** (Old Persian; licence would allow scholarly web use, but the site has
  no Old Persian ATF→Unicode conversion, so they would be unused) and **UllikummiB/C** (partial Hittite variants, unused by eBL).

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
- Cuneiform fonts: see *Font credits and licences* above; eBL sign list: follow eBL terms  
- App code in this repo: TBD (add a LICENSE when you publish)

## In-browser translator (`web/translate.html`)

Runs the ATF→English T5 model fully client-side with Transformers.js v3 in a Web Worker
(`web/js/translator.js` + `web/js/translator-worker.js`). Per line: prefix
`translate Akkadian to English: `, max 100 new tokens. Transformers.js 3.x has no beam search, so the
browser decodes greedily (identical to PyTorch greedy); the pre-generated drafts used 4 beams in Python.
Output is labelled as a machine draft with model + date. `?id=P123456[&from=N]` prefills 48 ATF lines of a
packaged text (the reader's "Translate in browser" button links there on the static site).

Weights load by default from the Hugging Face Hub repo set in `DEFAULT_REMOTE_MODEL` (translator.js),
currently `montycrypto/atf-to-english-onnx`: `onnx/{encoder_model,decoder_model_merged}_quantized.onnx` (int8,
default) or the fp32 files, plus the patched `tokenizer.json`. The staged upload lives in
`../atf-translate-test/onnx-export/hf-upload/`. Dev override with local files (gitignored `web/models/`, never deployed):

```bash
cp -r ../atf-translate-test/onnx-export/hf-upload web/models/atf-to-english
python3 -m http.server -d web 8000   # http://localhost:8000/translate.html?local=1
```

Other options: `?dtype=fp32`, `?model=<hf-id>`, `?revision=<sha>`.
Note: the exported `tokenizer.json` uses `Sequence[WhitespaceSplit, Metaspace(prepend_scheme)]`, which Transformers.js 3.7
tokenizes wrongly (garbage output). The web copy uses a single classic T5 `Metaspace` (`add_prefix_space: true`); ids match
Python on all ATF inputs tested, but it is not byte-for-byte identical on every English string, so it is kept out of the
PyTorch repo.

## Public build and deploy (`dist/`, GitHub Pages)

`./scripts/build_site.sh` assembles `dist/` (real files, no symlinks; `web/models/` excluded) from `web/` plus the runtime
data in `data/`: `catalog.json`, `atf_unicode_readings.json`, `texts/manifest.json` and `texts/<id>.json`. Policy lives in
`scripts/publish_policy.json`: ATF only from sources with `can_republish_atf` (eBL is not), and machine English only as
already packaged and stamped (`scripts/stamp_mt.py` adds model, version and date). The build fails on unstamped English,
symlinks, files over 100 MB, model weights or local paths. `.github/workflows/pages.yml` runs the same build on pushes to
`main` and deploys with `actions/deploy-pages` (repo setting: Pages source = GitHub Actions). The dist page carries
`<meta name="unread-static">`, so the reader never probes the local translate API there.

## Corpus numbers (`web/corpus_stats.json`)

Every corpus figure on the site (map header, About, home hero, browse/credits text, `<title>`/og/twitter/JSON-LD
descriptions) comes from one file, `web/corpus_stats.json`, written by `scripts/build_corpus_stats.py` from
`~/cursor/unread-db/corpus.sqlite`. It holds `generated_at`, `corpus_built_at`, the counts, per-source records vs
tablets, top period/language labels, and the SQL behind each count. "Tablets" are distinct
`COALESCE(canonical_id,id)`; "records" are source listings (one tablet listed by CDLI and ORACC is 2 records).

- **Rebuild it after any corpus or translation update** (new corpus.sqlite, new machine English, new source):
  `python3 scripts/build_corpus_stats.py`. `./scripts/build_site.sh` runs it automatically when the DB is present.
- Pages never hardcode figures: mark them `<span data-stat="key">` (dotted paths such as `sources.cdli.tablets`)
  or `data-stat-tpl="… {tablets} …"` on `<meta>`/`<title>`. The script stamps current values into the HTML (for
  crawlers, link previews and no-JS), and the browser refills `data-stat` elements from the JSON at runtime.

## Curated static pages (`web/t/`)

`python3 scripts/build_static.py` reads `web/data-curated/curated.json` plus `../unread-db/corpus.sqlite`
(read-only) and `web/data/texts/<id>.json`, and writes pre-rendered `web/t/<id>.html`, `web/t/index.html`
and `web/sitemap.xml`. ATF is only shown when the source allows republication (`sources.can_republish_atf`).

## Basemap (`web/tiles/relief/`)

The map uses our own label-free shaded-relief tiles (WebP XYZ: world z0–7, Near East z7–8 from finer data) instead of CARTO
(which now requires an API key). Rendered by `scripts/basemap/render_relief.py` from NOAA ETOPO 2022
(public domain) and Natural Earth 10m (public domain); no roads, borders, labels or modern reservoirs.
Sources, extents and rebuild commands: `web/tiles/relief/ATTRIBUTION.md`.
