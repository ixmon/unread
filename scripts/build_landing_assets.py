#!/usr/bin/env python3
"""Landing-page hero assets (stdlib only).

  web/assets/landing_dots.{json,dat}  compact copy of web/assets/map_of_maps.json for the home page hero
                                (no ids, no term lists, 4 bytes per dot) -> lazy-loaded after the poster
  web/assets/land.json          Natural Earth 1:50m land + rivers, clipped to the hero's map window,
                                drawn faintly behind the Geography state (public domain, naturalearthdata.com)

Usage: python3 scripts/build_landing_assets.py [--ne-dir DIR]   (downloads the NE GeoJSON if DIR lacks it)
"""
import argparse, json, struct, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "web" / "assets"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
BBOX = (26.0, 20.0, 64.0, 46.0)  # lon0, lat0, lon1, lat1 (hero window is lon 30-60, lat 24-42)


def ne(d: Path, name: str) -> dict:
    p = d / name
    if not p.exists():
        d.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(NE + name, p)
    return json.loads(p.read_text())


def clip_poly(ring):
    x0, y0, x1, y1 = BBOX
    edges = [(lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
             (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1))]
    out = ring
    for inside, cut in edges:
        if not out:
            break
        src, out = out, []
        for i, cur in enumerate(src):
            prev = src[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cut(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cut(prev, cur))
    return out


def flat(pts):
    r, last = [], None
    for x, y in pts:
        q = (round(x, 2), round(y, 2))
        if q != last:
            r += q
            last = q
    return r


def polys(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def lines(geom):
    return [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"] if geom["type"] == "MultiLineString" else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ne-dir", default="/tmp/naturalearth")
    a = ap.parse_args()
    d = Path(a.ne_dir)
    land, lakes = [], []
    for f in ne(d, "ne_50m_land.geojson")["features"]:
        for poly in polys(f["geometry"]):
            for k, ring in enumerate(poly):
                c = clip_poly([tuple(p) for p in ring])
                if len(c) >= 3:
                    (land if k == 0 else lakes).append(flat(c))
    for f in ne(d, "ne_50m_lakes.geojson")["features"]:
        for poly in polys(f["geometry"]):
            c = clip_poly([tuple(p) for p in poly[0]])
            if len(c) >= 3:
                lakes.append(flat(c))
    x0, y0, x1, y1 = BBOX
    rivers = []
    for f in ne(d, "ne_50m_rivers_lake_centerlines.geojson")["features"]:
        for ln in lines(f["geometry"]):
            seg = []
            for p in ln:
                if x0 <= p[0] <= x1 and y0 <= p[1] <= y1:
                    seg.append(p)
                elif seg:
                    if len(seg) > 1:
                        rivers.append(flat(seg))
                    seg = []
            if len(seg) > 1:
                rivers.append(flat(seg))
    doc = {"source": "Natural Earth 1:50m land, lakes, rivers (public domain)", "bbox": BBOX,
           "land": [r for r in land if len(r) >= 6], "lakes": [r for r in lakes if len(r) >= 6], "rivers": rivers}
    (A / "land.json").write_text(json.dumps(doc, separators=(",", ":")))

    D = json.loads((A / "map_of_maps.json").read_text())
    # binary, 4 bytes per dot (S3/CloudFront here does not gzip; not .bin, which build_site.py rejects as model weights): u8 coord index (255 = no find-spot),
    # i16 LE year (-32768 = undated), u8 genre<<4 | state.  Coordinates live in the JSON header.
    coords, ci, buf = [], {}, bytearray()
    for t in D["tablets"]:
        if t[1] is None:
            k = 255
        else:
            q = (round(t[1], 2), round(t[2], 2))
            if q not in ci:
                ci[q] = len(coords); coords.append(q)
            k = ci[q]
        if len(coords) > 255:
            raise SystemExit("more than 255 distinct find-spots; widen the coord index")
        buf += struct.pack("<BhB", k, -32768 if t[3] is None else int(t[3]), (t[4] << 4) | t[5])
    dots = {"note": "Hero sample derived from map_of_maps.json by scripts/build_landing_assets.py; dots in landing_dots.dat",
            "n": len(D["tablets"]), "corpus_tablets": D["corpus_tablets"], "genres": D["genres"], "states": D["states"],
            "presets": sorted(D["terms"]), "coords": coords}
    (A / "landing_dots.json").write_text(json.dumps(dots, separators=(",", ":")))
    (A / "landing_dots.dat").write_bytes(bytes(buf))
    for n in ("land.json", "landing_dots.json", "landing_dots.dat", "map_of_maps.json"):
        print(n, (A / n).stat().st_size)


if __name__ == "__main__":
    main()
