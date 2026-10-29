# Self-hosted UI text faces

IBM Plex Sans, IBM Plex Mono (IBM), and Source Serif 4 (Adobe), latin + latin-ext
subsets only, SIL Open Font License 1.1.

- `OFL-IBMPlex.txt` — IBM Plex license
- `OFL-SourceSerif4.txt` — Source Serif license
- Loaded via `web/css/ui-fonts.css` (`font-display: swap`)

Do not place these woff2 files in the parent `web/fonts/` directory: `scripts/build_site.py`
requires that top-level font files match `fonts.json` exactly. Keep UI faces in this `ui/` subdir.
