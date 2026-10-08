#!/usr/bin/env python3
"""Render a label-free, atlas-style shaded-relief basemap as XYZ WebP tiles.

Data (all public domain):
  ETOPO 2022 v1 (NOAA NCEI) surface elevation incl. bathymetry, 15" tiles or 60" global
  Natural Earth 10m ocean, lakes, rivers+lake centerlines, coastline

A master image is rendered in Web Mercator, aligned to the XYZ grid at --zmax and
covering whole tiles at --zmin; lower zooms are produced by 2x downsampling.

Large masters (e.g. the whole world at z6/z7) are processed in horizontal bands of
--band-rows tile rows to bound memory. If the master spans 360 degrees, hillshade wraps
across the antimeridian (no seam). Geometry is clipped to the Web Mercator latitude limit.

Examples:
  python render_relief.py --dem 'raw/N*.nc' --bbox 24 22 62 46 --zmin 8 --zmax 8 --out tiles
  python render_relief.py --dem raw/etopo60s.nc --world --zmin 6 --zmax 6 --band-rows 8 --out tiles
"""
import argparse, glob, math, os, time
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_geom
from rasterio.transform import Affine
from rasterio.features import rasterize
import pyogrio.raw as pr
import shapely
from shapely.geometry import mapping
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
R = 6378137.0
ORIG = math.pi * R
TILE = 256

# ── palette (muted parchment/earth; blue-grey water) ──
LAND = [  # elevation m, RGB
    (-500, (186, 174, 142)), (0, (186, 174, 142)), (150, (182, 169, 134)), (400, (174, 159, 123)),
    (800, (162, 145, 110)), (1300, (147, 129, 97)), (2000, (131, 114, 88)), (2800, (120, 108, 92)),
    (3800, (138, 132, 123)), (5000, (172, 168, 160)), (8000, (196, 193, 187)),
]
SEA = [
    (-8000, (50, 64, 76)), (-4000, (60, 77, 90)), (-2000, (71, 90, 103)), (-1000, (83, 103, 116)),
    (-200, (102, 122, 133)), (-50, (117, 137, 146)), (0, (128, 146, 154)),
]
ICE = [  # ice sheets / glaciers / ice shelves (Natural Earth glaciated areas + Antarctic ice shelves); muted for the dark UI
    (0, (176, 182, 185)), (1000, (184, 189, 191)), (2500, (192, 196, 197)), (4500, (200, 203, 203)),
]
LAKE = (110, 130, 140)
RIVER = (92, 116, 130)
COAST = (78, 96, 108)


def ramp(z, stops):
    xs = np.array([s[0] for s in stops], float)
    out = np.empty(z.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(z, xs, np.array([s[1][c] for s in stops], float))
    return out


def lonlat_to_px(lon, lat, zoom):
    n = TILE * 2 ** zoom
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def hillshade(z, res, lat_rows, zf, az=315.0, alt=45.0):
    """Horn-style hillshade on a Mercator grid with per-row ground pixel size."""
    dx = (res * np.cos(np.radians(lat_rows)))[:, None].astype(np.float32)
    dy = dx
    gy, gx = np.gradient(z.astype(np.float32))
    gx = gx / dx * zf
    gy = gy / dy * zf
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)  # y grows southward in image coords
    a, h = math.radians(az), math.radians(alt)
    hs = np.sin(h) * np.cos(slope) + np.cos(h) * np.sin(slope) * np.cos(a - aspect - math.pi)
    return np.clip(hs, 0, 1)


def read_vec(path, bbox, cols=None):
    """Return (geoms, {field: values}) — field access by name (pyogrio returns file order)."""
    meta, _fids, geoms, fields = pr.read(path, bbox=tuple(bbox), columns=cols or [])
    names = list(meta["fields"])
    keep = [i for i, g in enumerate(geoms) if g is not None]
    d = {n: [fields[j][i] for i in keep] for j, n in enumerate(names)}
    return [shapely.from_wkb(geoms[i]) for i in keep], d


# Modern reservoirs / artificial lakes to leave off an ancient-world map. Natural Earth already tags
# ~230 lakes worldwide as featurecla == "Reservoir"; these patterns catch a few misclassified ones.
import re
MODERN_LAKES = re.compile(
    r"tharthar|habbaniyah|razazah|assad|ataturk|keban|nasser|mingevir|\bdam\b|reservoir|r[ée]servoir|"
    r"baraj|bgeni|qayroqum|suu saktagychy|embalse|represa|barragem|shuiku|vodokhranilishche|\bsagar\b",
    re.I)
MERC_LAT = 85.0511287798


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem", required=True, help="glob of DEM files (netCDF z var or GeoTIFF)")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"))
    ap.add_argument("--world", action="store_true", help="full world extent (overrides --bbox)")
    ap.add_argument("--zmin", type=int, required=True)
    ap.add_argument("--zmax", type=int, required=True)
    ap.add_argument("--ne", default="raw/ne")
    ap.add_argument("--out", required=True)
    ap.add_argument("--zfactor", type=float, default=None)
    ap.add_argument("--max-river-rank", type=int, default=9)
    ap.add_argument("--river-scale", type=float, default=1.0)
    ap.add_argument("--quality", type=int, default=82)
    ap.add_argument("--band-rows", type=int, default=0, help="process N tile rows at a time (needs zmin == zmax)")
    ap.add_argument("--preview", default=None, help="write a downsampled preview PNG (unbanded only)")
    a = ap.parse_args()
    t0 = time.time()

    # ── tile grid ──
    if a.world:
        tx0, ty0, tx1, ty1 = 0, 0, 2 ** a.zmin, 2 ** a.zmin
    else:
        W, S, E, N = a.bbox
        x0, y0 = lonlat_to_px(W, N, a.zmin)
        x1, y1 = lonlat_to_px(E, S, a.zmin)
        tx0, ty0 = int(x0 // TILE), int(y0 // TILE)
        tx1, ty1 = int(math.ceil(x1 / TILE)), int(math.ceil(y1 / TILE))
    f = 2 ** (a.zmax - a.zmin)
    width, height = (tx1 - tx0) * TILE * f, (ty1 - ty0) * TILE * f
    res = 2 * ORIG / (TILE * 2 ** a.zmax)
    left, top = -ORIG + tx0 * TILE * f * res, ORIG - ty0 * TILE * f * res
    wrap = width * res >= 2 * ORIG - 1
    print(f"master z{a.zmax}: {width}x{height}px, tiles z{a.zmin} x{tx0}-{tx1-1} y{ty0}-{ty1-1}, res {res:.1f} m, wrap={wrap}", flush=True)
    lat_of = lambda yy: np.degrees(2 * np.arctan(np.exp(yy / R)) - math.pi / 2)
    lonW, lonE = left / ORIG * 180, (left + width * res) / ORIG * 180
    latN, latS = float(lat_of(top)), float(lat_of(top - height * res))
    vb = (max(lonW - 1, -180), max(latS - 1, -90), min(lonE + 1, 180), min(latN + 1, 90))

    # ── vectors: read once, clip to the Mercator limit, project once ──
    def merc(g):
        g = shapely.clip_by_rect(g, -180, -MERC_LAT, 180, MERC_LAT)
        if g.is_empty:
            return None
        return transform_geom("EPSG:4326", "EPSG:3857", mapping(g))
    def mercs(gs):
        return [m for m in (merc(g) for g in gs) if m is not None]
    sea_m = mercs(read_vec(f"{a.ne}/ne_10m_ocean.shp", vb)[0])
    lake_all, lf = read_vec(f"{a.ne}/ne_10m_lakes.shp", vb, cols=["name", "featurecla"])
    lake_g = [g for g, n, c in zip(lake_all, lf["name"], lf["featurecla"])
              if c != "Reservoir" and not MODERN_LAKES.search(n or "")]
    print(f"  lakes kept {len(lake_g)}/{len(lake_all)}", flush=True)
    lake_m = mercs(lake_g)
    ice_m = []
    for fn in ("ne_10m_glaciated_areas.shp", "ne_10m_antarctic_ice_shelves_polys.shp"):
        if os.path.exists(f"{a.ne}/{fn}"):
            ice_m += mercs(read_vec(f"{a.ne}/{fn}", vb)[0])
    rivers, rf = read_vec(f"{a.ne}/ne_10m_rivers_lake_centerlines.shp", vb, cols=["scalerank", "featurecla"])
    widths = {1: 2.4, 2: 2.1, 3: 1.8, 4: 1.6, 5: 1.4, 6: 1.2, 7: 1.0, 8: 0.9, 9: 0.8}
    river_m = []
    for g, r, c in zip(rivers, rf["scalerank"], rf["featurecla"]):
        r = int(r)
        if r > a.max_river_rank or c == "Canal":
            continue
        m = merc(g)
        if m:
            river_m.append((m, widths.get(r, 0.8) * a.river_scale * (0.7 if "Intermittent" in str(c) else 1.0)))
    coast_m = [(m, 0.9) for m in mercs(read_vec(f"{a.ne}/ne_10m_coastline.shp", vb)[0])]
    coast_m += [(m, 0.7) for m in mercs([g.boundary for g in lake_g])]
    print(f"  vectors ready ({len(river_m)} rivers) {time.time()-t0:.0f}s", flush=True)
    dem_paths = sorted(glob.glob(a.dem))
    zf = a.zfactor if a.zfactor is not None else {0: 12, 1: 11, 2: 10, 3: 8, 4: 6, 5: 5, 6: 4, 7: 3, 8: 2.2, 9: 1.6, 10: 1.3}.get(a.zmax, 2)

    def lines_of(g):
        t = g["type"]
        c = g["coordinates"]
        if t == "LineString":
            return [c]
        if t in ("MultiLineString", "Polygon"):
            return c
        if t == "MultiPolygon":
            return [ring for poly in c for ring in poly]
        if t == "GeometryCollection":
            return [l for gg in g["geometries"] for l in lines_of(gg)]
        return []

    def render_band(r0, r1):
        """Render master pixel rows [r0, r1) → PIL RGB image."""
        pad = 1
        h = r1 - r0 + 2 * pad
        btop = top - (r0 - pad) * res
        tr = Affine(res, 0, left, 0, -res, btop)
        lat_rows = lat_of(btop - (np.arange(h) + 0.5) * res)
        dem = np.full((h, width), np.nan, np.float32)
        for pth in dem_paths:
            src_path = f"netcdf:{pth}:z" if pth.endswith(".nc") else pth
            with rasterio.open(src_path) as src:
                b = src.bounds
                if b.right < vb[0] or b.left > vb[2] or b.top < vb[1] or b.bottom > vb[3]:
                    continue
                tmp = np.full((h, width), np.nan, np.float32)
                reproject(rasterio.band(src, 1), tmp, src_nodata=src.nodata, dst_nodata=np.nan,
                          dst_transform=tr, dst_crs="EPSG:3857", resampling=Resampling.bilinear,
                          src_crs=src.crs or "EPSG:4326")
                m = np.isfinite(tmp) & ~np.isfinite(dem)
                dem[m] = tmp[m]
                del tmp
        dem = np.nan_to_num(dem, nan=0.0)
        shape = (h, width)
        sea = rasterize(sea_m, out_shape=shape, transform=tr, fill=0, default_value=1, dtype="uint8").astype(bool) if sea_m else np.zeros(shape, bool)
        lake = (rasterize(lake_m, out_shape=shape, transform=tr, fill=0, default_value=1, dtype="uint8").astype(bool) & ~sea) if lake_m else np.zeros(shape, bool)
        ice = rasterize(ice_m, out_shape=shape, transform=tr, fill=0, default_value=1, dtype="uint8").astype(bool) if ice_m else np.zeros(shape, bool)
        # hillshade (wrap columns across the antimeridian for full-world masters)
        dz = np.pad(dem, ((0, 0), (1, 1)), mode="wrap") if wrap else dem
        hs = 0.7 * hillshade(dz, res, lat_rows, zf, 315, 45) + 0.3 * hillshade(dz, res, lat_rows, zf, 260, 55)
        if wrap:
            hs = hs[:, 1:-1]
        del dz
        flat = math.sin(math.radians(45)) * 0.7 + math.sin(math.radians(55)) * 0.3
        shade = np.clip(hs / flat, 0, 1.3)
        del hs
        rgb = ramp(dem, LAND)
        rgb *= (1 + 0.55 * (shade - 1))[..., None]
        if sea.any():
            sea_rgb = ramp(np.minimum(dem, 0), SEA)
            sea_rgb *= (1 + 0.30 * (shade - 1))[..., None]
            rgb[sea] = sea_rgb[sea]
            del sea_rgb
        if ice.any():
            ice_rgb = ramp(np.maximum(dem, 0), ICE)
            ice_rgb *= (1 + 0.45 * (shade - 1))[..., None]
            rgb[ice] = ice_rgb[ice]
            del ice_rgb
        rgb[lake] = LAKE
        del shade, sea, lake, ice, dem

        def stroke_mask(items):
            ss = 2
            im = Image.new("L", (width * ss, h * ss), 0)
            d = ImageDraw.Draw(im)
            ytop, ybot = btop, btop - h * res
            for g, wpx in items:
                for part in lines_of(g):
                    if len(part) < 2:
                        continue
                    ys_ = [p[1] for p in part]
                    if max(ys_) < ybot - 5 * res or min(ys_) > ytop + 5 * res:
                        continue
                    pts = [((x - left) / res * ss, (btop - y) / res * ss) for x, y in part]
                    d.line(pts, fill=255, width=max(1, int(round(wpx * ss))), joint="curve")
            return np.asarray(im.resize((width, h), Image.BOX), np.float32) / 255.0

        cm = stroke_mask(coast_m)[..., None] * 0.55
        rgb = rgb * (1 - cm) + np.array(COAST, np.float32) * cm
        del cm
        rm = stroke_mask(river_m)[..., None] * 0.9
        rgb = rgb * (1 - rm) + np.array(RIVER, np.float32) * rm
        del rm
        return Image.fromarray(np.clip(rgb[pad:-pad], 0, 255).astype(np.uint8), "RGB")

    def write_tiles(img, z, row_off_tiles, s):
        n = size = 0
        for ty in range(img.height // TILE):
            for tx in range(img.width // TILE):
                X, Y = tx0 * s + tx, ty0 * s + row_off_tiles + ty
                d = os.path.join(a.out, str(z), str(X)); os.makedirs(d, exist_ok=True)
                fn = os.path.join(d, f"{Y}.webp")
                img.crop((tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)).save(fn, "WEBP", quality=a.quality, method=6)
                n += 1; size += os.path.getsize(fn)
        return n, size

    stats = {}
    if a.band_rows and a.band_rows * TILE < height:
        assert a.zmin == a.zmax, "--band-rows requires zmin == zmax"
        n = size = 0
        rows_t = height // TILE
        for br in range(0, rows_t, a.band_rows):
            be = min(rows_t, br + a.band_rows)
            img = render_band(br * TILE, be * TILE)
            dn, ds = write_tiles(img, a.zmax, br, 1)
            n += dn; size += ds
            print(f"  band rows {br}-{be-1}: {dn} tiles {ds/1e6:.2f} MB  {time.time()-t0:.0f}s", flush=True)
        stats[a.zmax] = (n, size)
    else:
        img = render_band(0, height)
        if a.preview:
            pv = img.copy(); pv.thumbnail((2400, 2400), Image.LANCZOS); pv.save(a.preview)
        cur = img
        for z in range(a.zmax, a.zmin - 1, -1):
            if z != a.zmax:
                cur = cur.resize((cur.width // 2, cur.height // 2), Image.LANCZOS)
            stats[z] = write_tiles(cur, z, 0, 2 ** (z - a.zmin))
    for z, (n, size) in sorted(stats.items()):
        print(f"  z{z}: {n} tiles, {size/1e6:.2f} MB", flush=True)
    print("done", f"{time.time()-t0:.0f}s", stats)


if __name__ == "__main__":
    main()
