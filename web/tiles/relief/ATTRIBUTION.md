# Unread relief basemap

Label-free, atlas-style shaded relief tiles (XYZ, 256 px, WebP) rendered by
`scripts/basemap/render_relief.py`. No modern roads, borders, labels or reservoirs.

| Zooms | Extent (lon/lat) | Elevation source |
|---|---|---|
| 0–7 | whole world (Web Mercator, ±85.05°) | ETOPO 2022 v1, 60 arc-second global surface elevation |
| 7–8 | 24…62 E, 22…46 N (overrides the 60″ z7 tiles there) | ETOPO 2022 v1, 15 arc-second surface elevation tiles |

Outside the Near East the map upscales z7 beyond zoom 7; inside it upscales z8 beyond zoom 8 (Leaflet `maxNativeZoom`).

## Sources and licences

- **NOAA NCEI ETOPO 2022 Global Relief Model** (surface elevation incl. bathymetry), public domain (U.S. Government work).
  NOAA National Centers for Environmental Information. 2022: ETOPO 2022 15 Arc-Second Global Relief Model. doi:10.25921/fd45-gt74
  https://www.ncei.noaa.gov/products/etopo-global-relief-model
- **Natural Earth** 1:10m ocean, lakes, rivers + lake centerlines, coastline, glaciated areas,
  Antarctic ice shelves, public domain.
  https://www.naturalearthdata.com/about/terms-of-use/ (Made with Natural Earth.)
  Reservoirs and modern artificial lakes are excluded worldwide: every Natural Earth lake with
  `featurecla == "Reservoir"` (~230, e.g. Mead, Powell, Kariba, Volta, Nasser, Itaipu, Bratsk) plus a name
  pattern list (Tharthar, Habbaniyah, Razzaza, Assad, Atatürk, "dam", "reservoir", "represa", "embalse", …).
  Ice sheets, glaciers and Antarctic ice shelves are drawn in muted grey-white from the same DEM.
  Full-world zooms wrap the hillshade across the antimeridian (no seam).

Water areas use Natural Earth polygons (not the DEM sign), so below-sea-level basins such as the
Caspian, Dead Sea and Qattara are handled correctly. Sea colour encodes ETOPO bathymetry, so a future
sea-level/coastline time slider can reuse the same DEM.

## Rebuild

```bash
python -m venv .venv && .venv/bin/pip install rasterio pyogrio shapely numpy pillow
# raw data: ETOPO_2022_v1_15s_N{30,45,60}E{015,030,045,060}_surface.nc, ETOPO_2022_v1_60s_N90W180_surface.nc,
#           Natural Earth 10m physical shapefiles (ocean, lakes, rivers_lake_centerlines, coastline,
#           glaciated_areas, antarctic_ice_shelves_polys) unzipped into raw/ne/
# world z0-7 (render the Near East z7-8 below AFTER this so its 15" z7 tiles overwrite the 60" ones): zoom, max river rank, river scale, band rows (bands bound memory for big masters)
for spec in "0 2 0.6 0" "1 2 0.6 0" "2 3 0.6 0" "3 3 0.7 0" "4 5 0.8 0" "5 6 0.9 8" "6 7 1.0 8" "7 8 1.0 4"; do set -- $spec
  python scripts/basemap/render_relief.py --dem raw/etopo60s.nc --world --zmin $1 --zmax $1 \
    --max-river-rank $2 --river-scale $3 --band-rows $4 --quality 88 --out web/tiles/relief; done
for z in 7 8; do python scripts/basemap/render_relief.py --dem 'raw/N*.nc' --bbox 24 22 62 46 \
    --zmin $z --zmax $z --quality 88 --out web/tiles/relief; done
```
