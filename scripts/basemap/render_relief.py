#!/usr/bin/env python3
"""Render a label-free, atlas-style shaded-relief basemap as XYZ WebP tiles.

Data (all public domain):
  ETOPO 2022 v1 (NOAA NCEI) surface elevation incl. bathymetry, 15" tiles or 60" global
  Natural Earth 10m ocean, lakes, rivers+lake centerlines, coastline

A master image is rendered in Web Mercator, aligned to the XYZ grid at --zmax and
covering whole tiles at --zmin; lower zooms are produced by 2x downsampling.

Example:
  python render_relief.py --dem 'raw/N*.nc' --bbox 24 22 62 46 --zmin 7 --zmax 8 --out tiles
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


# Modern reservoirs / artificial lakes to leave off an ancient-world map
MODERN_LAKES = ("tharthar", "habbaniyah", "razazah", "assad", "ataturk", "keban", "nasser", "mingevir",
                "dam", "reservoir", "baraj", "bgeni", "qayroqum", "suu saktagychy", "embalse", "sagar")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem", required=True, help="glob of DEM files (netCDF z var or GeoTIFF)")
    ap.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--zmin", type=int, required=True)
    ap.add_argument("--zmax", type=int, required=True)
    ap.add_argument("--ne", default="raw/ne")
    ap.add_argument("--out", required=True)
    ap.add_argument("--zfactor", type=float, default=None)
    ap.add_argument("--max-river-rank", type=int, default=9)
    ap.add_argument("--river-scale", type=float, default=1.0)
    ap.add_argument("--quality", type=int, default=82)
    ap.add_argument("--preview", default=None, help="write a downsampled preview PNG")
    a = ap.parse_args()
    t0 = time.time()
    W, S, E, N = a.bbox
    # whole tiles at zmin
    x0, y0 = lonlat_to_px(W, N, a.zmin)
    x1, y1 = lonlat_to_px(E, S, a.zmin)
    tx0, ty0 = int(x0 // TILE), int(y0 // TILE)
    tx1, ty1 = int(math.ceil(x1 / TILE)), int(math.ceil(y1 / TILE))
    f = 2 ** (a.zmax - a.zmin)
    width, height = (tx1 - tx0) * TILE * f, (ty1 - ty0) * TILE * f
    res = 2 * ORIG / (TILE * 2 ** a.zmax)
    left, top = -ORIG + tx0 * TILE * f * res, ORIG - ty0 * TILE * f * res
    tr = Affine(res, 0, left, 0, -res, top)
    print(f"master z{a.zmax}: {width}x{height}px, tiles z{a.zmin} x{tx0}-{tx1-1} y{ty0}-{ty1-1}, res {res:.1f} m", flush=True)
    ys = top - (np.arange(height) + 0.5) * res
    lat_rows = np.degrees(2 * np.arctan(np.exp(ys / R)) - math.pi / 2)
    gb = (left, top - height * res, left + width * res, top)  # merc bounds
    # lon/lat bbox of master for vector clipping
    lonW, lonE = left / ORIG * 180, (left + width * res) / ORIG * 180
    latS, latN = float(lat_rows[-1]), float(lat_rows[0])
    vb = (lonW - 1, latS - 1, lonE + 1, latN + 1)

    # ── DEM ──
    dem = np.full((height, width), np.nan, np.float32)
    for p in sorted(glob.glob(a.dem)):
        src_path = f"netcdf:{p}:z" if p.endswith(".nc") else p
        with rasterio.open(src_path) as src:
            b = src.bounds
            if b.right < vb[0] or b.left > vb[2] or b.top < vb[1] or b.bottom > vb[3]:
                continue
            tmp = np.full((height, width), np.nan, np.float32)
            reproject(rasterio.band(src, 1), tmp, src_nodata=src.nodata, dst_nodata=np.nan,
                      dst_transform=tr, dst_crs="EPSG:3857", resampling=Resampling.bilinear,
                      src_crs=src.crs or "EPSG:4326")
            m = np.isfinite(tmp) & ~np.isfinite(dem)
            dem[m] = tmp[m]
            print("  dem", os.path.basename(p), f"{time.time()-t0:.0f}s", flush=True)
    dem = np.nan_to_num(dem, nan=0.0)

    # ── masks from Natural Earth ──
    def to_merc(geoms):
        return [transform_geom("EPSG:4326", "EPSG:3857", mapping(g)) for g in geoms]
    sea_g, _ = read_vec(f"{a.ne}/ne_10m_ocean.shp", vb)
    lake_all, lf = read_vec(f"{a.ne}/ne_10m_lakes.shp", vb, cols=["name", "featurecla"])
    lake_g = [g for g, n, c in zip(lake_all, lf["name"], lf["featurecla"])
              if c != "Reservoir" and not any(k in (n or "").lower() for k in MODERN_LAKES)]
    print(f"  lakes kept {len(lake_g)}/{len(lake_all)}", flush=True)
    shape = (height, width)
    sea = rasterize(to_merc(sea_g), out_shape=shape, transform=tr, fill=0, default_value=1, dtype="uint8").astype(bool)
    lake = rasterize(to_merc(lake_g), out_shape=shape, transform=tr, fill=0, default_value=1, dtype="uint8").astype(bool) & ~sea
    print("  masks", f"{time.time()-t0:.0f}s", flush=True)

    # ── colour + shading ──
    zf = a.zfactor if a.zfactor is not None else {4: 6, 5: 5, 6: 4, 7: 3, 8: 2.2, 9: 1.6, 10: 1.3}.get(a.zmax, 2)
    hs_main = hillshade(dem, res, lat_rows, zf, 315, 45)
    hs_soft = hillshade(dem, res, lat_rows, zf, 260, 55)
    hs = 0.7 * hs_main + 0.3 * hs_soft
    flat = math.sin(math.radians(45)) * 0.7 + math.sin(math.radians(55)) * 0.3
    shade = np.clip(hs / flat, 0, 1.3)
    land_rgb = ramp(dem, LAND)
    sea_rgb = ramp(np.minimum(dem, 0), SEA)
    k_land, k_sea = 0.55, 0.30
    land_rgb *= (1 + k_land * (shade - 1))[..., None]
    sea_rgb *= (1 + k_sea * (shade - 1))[..., None]
    rgb = np.where(sea[..., None], sea_rgb, land_rgb)
    rgb[lake] = LAKE
    del land_rgb, sea_rgb, hs, hs_main, hs_soft, shade
    print("  shaded", f"{time.time()-t0:.0f}s", flush=True)

    # ── vector strokes (2x supersampled masks) ──
    def stroke_mask(lines_with_width):
        ss = 2
        im = Image.new("L", (width * ss, height * ss), 0)
        d = ImageDraw.Draw(im)
        for geom, wpx in lines_with_width:
            g = transform_geom("EPSG:4326", "EPSG:3857", mapping(geom))
            parts = [g["coordinates"]] if g["type"] in ("LineString", "LinearRing") else g["coordinates"]
            if g["type"] == "Polygon":
                parts = g["coordinates"]
            for part in parts:
                pts = [((x - left) / res * ss, (top - y) / res * ss) for x, y in part]
                if len(pts) > 1:
                    d.line(pts, fill=255, width=max(1, int(round(wpx * ss))), joint="curve")
        return np.asarray(im.resize((width, height), Image.BOX), np.float32) / 255.0

    rivers, rf = read_vec(f"{a.ne}/ne_10m_rivers_lake_centerlines.shp", vb, cols=["scalerank", "featurecla"])
    ranks, classes = rf["scalerank"], rf["featurecla"]
    widths = {1: 2.4, 2: 2.1, 3: 1.8, 4: 1.6, 5: 1.4, 6: 1.2, 7: 1.0, 8: 0.9, 9: 0.8}
    rl = []
    for g, r, c in zip(rivers, ranks, classes):
        r = int(r)
        if r > a.max_river_rank or c == "Canal":
            continue
        w = widths.get(r, 0.8) * a.river_scale * (0.7 if "Intermittent" in str(c) else 1.0)
        rl.append((g, w))
    rmask = stroke_mask(rl)[..., None] * 0.9
    coast_g, _ = read_vec(f"{a.ne}/ne_10m_coastline.shp", vb)
    cmask = stroke_mask([(g, 0.9) for g in coast_g] + [(g.boundary, 0.7) for g in lake_g])[..., None] * 0.55
    rgb = rgb * (1 - cmask) + np.array(COAST, np.float32) * cmask
    rgb = rgb * (1 - rmask) + np.array(RIVER, np.float32) * rmask
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    del rgb, rmask, cmask
    print("  strokes", f"{time.time()-t0:.0f}s", flush=True)
    if a.preview:
        p = img.copy(); p.thumbnail((2400, 2400), Image.LANCZOS); p.save(a.preview)

    # ── tiles ──
    stats = {}
    cur = img
    for z in range(a.zmax, a.zmin - 1, -1):
        if z != a.zmax:
            cur = cur.resize((cur.width // 2, cur.height // 2), Image.LANCZOS)
        s = 2 ** (z - a.zmin)
        n = 0; size = 0
        for ty in range(cur.height // TILE):
            for tx in range(cur.width // TILE):
                X, Y = tx0 * s + tx, ty0 * s + ty
                d = os.path.join(a.out, str(z), str(X)); os.makedirs(d, exist_ok=True)
                fn = os.path.join(d, f"{Y}.webp")
                cur.crop((tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)).save(fn, "WEBP", quality=a.quality, method=6)
                n += 1; size += os.path.getsize(fn)
        stats[z] = (n, size)
        print(f"  z{z}: {n} tiles, {size/1e6:.2f} MB", flush=True)
    print("done", f"{time.time()-t0:.0f}s", stats)


if __name__ == "__main__":
    main()
