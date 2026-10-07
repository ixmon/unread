# Unread relief basemap

Label-free, atlas-style shaded relief tiles (XYZ, 256 px, WebP) rendered by
`scripts/basemap/render_relief.py`. No modern roads, borders, labels or reservoirs.

| Zooms | Extent (lon/lat) | Elevation source |
|---|---|---|
| 4–6 | -10…100 E, 5…60 N | ETOPO 2022 v1, 60 arc-second global surface elevation |
| 7–8 | 24…62 E, 22…46 N | ETOPO 2022 v1, 15 arc-second surface elevation tiles |

Beyond z8 the map upscales z8 (Leaflet `maxNativeZoom`).

## Sources and licences

- **NOAA NCEI ETOPO 2022 Global Relief Model** (surface elevation incl. bathymetry), public domain (U.S. Government work).
  NOAA National Centers for Environmental Information. 2022: ETOPO 2022 15 Arc-Second Global Relief Model. doi:10.25921/fd45-gt74
  https://www.ncei.noaa.gov/products/etopo-global-relief-model
- **Natural Earth** 1:10m ocean, lakes, rivers + lake centerlines, coastline, public domain.
  https://www.naturalearthdata.com/about/terms-of-use/ (Made with Natural Earth.)
  Reservoirs and modern artificial lakes (e.g. Tharthar, Habbaniyah, Razzaza, Assad, Atatürk, Nasser) are excluded.

Water areas use Natural Earth polygons (not the DEM sign), so below-sea-level basins such as the
Caspian, Dead Sea and Qattara are handled correctly. Sea colour encodes ETOPO bathymetry, so a future
sea-level/coastline time slider can reuse the same DEM.

## Rebuild

```bash
python -m venv .venv && .venv/bin/pip install rasterio pyogrio shapely numpy pillow
# raw data: ETOPO_2022_v1_15s_N{30,45,60}E{015,030,045,060}_surface.nc, ETOPO_2022_v1_60s_N90W180_surface.nc,
#           Natural Earth 10m physical shapefiles unzipped into raw/ne/
for z in 4 5 6; do python scripts/basemap/render_relief.py --dem raw/etopo60s.nc --bbox -10 5 100 60 \
    --zmin $z --zmax $z --max-river-rank $((z+1)) --quality 88 --out web/tiles/relief; done
for z in 7 8; do python scripts/basemap/render_relief.py --dem 'raw/N*.nc' --bbox 24 22 62 46 \
    --zmin $z --zmax $z --quality 88 --out web/tiles/relief; done
```
