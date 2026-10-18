# Unread dark basemap (prototype)

Same sources and renderer as `../relief/` (see `../relief/ATTRIBUTION.md`): NOAA NCEI ETOPO 2022 and
Natural Earth, both public domain. Rendered with `scripts/basemap/render_relief.py --style dark`
(near-black land with a faint elevation tint and soft hillshade, dark sea, thin coastlines and rivers).

| Zooms | Extent (lon/lat) | Elevation source |
|---|---|---|
| 0–5 | whole world | ETOPO 2022 v1, 60 arc-second |
| 6–8 | 24…62 E, 22…46 N | ETOPO 2022 v1, 15 arc-second |

Used by map.html when the URL has `style=dark`. Build script: /mnt/alpaca/unread-basemap/run_dark.sh.
