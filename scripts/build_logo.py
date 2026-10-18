#!/usr/bin/env python3
"""Draw the Unread Atlas logo as SVG paths (no web font needed at runtime): 𒉡𒋃 nu-šid,
Sumerian "not counted / not read (out)", NU U+12261 + ŠID U+122C3.

Outlines come from the self-hosted Noto Sans Cuneiform (web/fonts/NotoSansCuneiform.woff2, OFL).
Needs: pip install fonttools brotli.

  web/assets/logo/logo.svg  the header logo: the Noto outlines as a light-slate wall drawn inside each sign
                            (hollow wedges, transparent interior); the wall thickens when drawn <= 40 px tall
  web/favicon.svg           the same on a flat dark rounded tile
  --app-icon FILE           square, full-bleed dark tile version for the PNG app icons (apple-touch-icon.png,
                            icon-192.png, icon-512.png); rasterise it (and favicon.svg -> favicon.ico 16/32/48)
                            in headless Chromium, which renders the clip paths correctly
  --variants DIR            also write the design alternates that were compared and not shipped
                            (a solid, c line-art accent, f off-white, f-dark2 clay, the clay tablet and the
                            dub nu-šid / lā šasû wordings) to DIR, outside web/
"""
import math
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "web/fonts/NotoSansCuneiform.woff2"
OUT = ROOT / "web/assets/logo"
NU_SHID = "\U00012261\U000122C3"
TITLE = "nu-šid (Sumerian “not read”): cuneiform signs NU and ŠID"
OFF, ACC, TILE, EDGE = "#ece6da", "#d08a5c", "#171a20", "#3a3f48"
SLATE, CLAY = "#8e9bad", "#a9785a"  # shipped logo: light slate blue-gray; f-dark2 alternate: accent, dimmed
FAV = SLATE


def outline(font, text, gap=40):
    """Noto glyph outlines laid out left to right; SVG (y-down) units. Returns (path d, bounds)."""
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    pen, bp, x = SVGPathPen(gs), BoundsPen(gs), 0
    for ch in text:
        g = cmap[ord(ch)]  # KeyError = the font lacks the sign
        t = (1, 0, 0, -1, x, 0)
        gs[g].draw(TransformPen(pen, t)); gs[g].draw(TransformPen(bp, t))
        x += gs[g].width + gap
    return pen.getCommands(), bp.bounds


def tablet(font, text, label):
    d, (x0, y0, x1, y1) = outline(font, text)
    p = (y1 - y0) * 0.12
    vb = [round(x0 - p), round(y0 - p), round(x1 - x0 + 2 * p), round(y1 - y0 + 2 * p)]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}"><title>{label}</title>'
            '<defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d4895a"/>'
            '<stop offset="1" stop-color="#8b4a2e"/></linearGradient></defs>'
            f'<rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" rx="{round(vb[3] * .18)}" fill="url(#c)"/>'
            f'<path fill="#2b170d" d="{d}"/></svg>\n')


# Wedges of NU and ŠID as (head x, y) -> (tail x, y), in the Noto outline units above
WEDGES = [
    # NU: horizontal, vertical, diagonal
    ((105, -262), (930, -262)), ((315, -560), (315, -10)), ((290, 105), (830, -365)),
    # ŠID: four horizontals, two inner verticals, right vertical, bottom horizontal
    ((1185, -676), (2215, -676)), ((1185, -516), (2215, -516)), ((1185, -340), (2215, -340)), ((1185, -168), (1790, -168)),
    ((1505, -620), (1505, -40)), ((1782, -300), (1782, 110)),
    ((2290, -846), (2290, 175)), ((1690, 160), (2290, 160)),
]
HW, HL = 200, 230  # wedge head width and length


def _frame(p0, p1):
    (x0, y0), (x1, y1) = p0, p1
    L = math.hypot(x1 - x0, y1 - y0); ux, uy = (x1 - x0) / L, (y1 - y0) / L
    return x0, y0, x1, y1, ux, uy, -uy, ux


def wedge_line(p0, p1):
    x0, y0, x1, y1, ux, uy, nx, ny = _frame(p0, p1)
    hx, hy = x0 + ux * HL, y0 + uy * HL
    return (f"M{x0 + nx * HW / 2:.0f} {y0 + ny * HW / 2:.0f}L{hx:.0f} {hy:.0f}L{x0 - nx * HW / 2:.0f} {y0 - ny * HW / 2:.0f}Z"
            f"M{hx:.0f} {hy:.0f}L{x1:.0f} {y1:.0f}")


def hollow(d, wall, small_wall, cid, colour=OFF):
    """Outline drawn as a wall *inside* the sign (stroke clipped to the glyph), so the silhouette matches (a)
    exactly; strokes thinner than 2 x wall stay solid. small_wall applies when the image renders <= 40 px tall."""
    return (f'<style>.w{{stroke-width:{2 * wall}}}@media (max-height:40px){{.w{{stroke-width:{2 * small_wall}}}}}</style>'
            f'<defs><clipPath id="{cid}"><path d="{d}"/></clipPath></defs>'
            f'<path class="w" fill="none" stroke="{colour}" stroke-width="{2 * wall}" stroke-linejoin="miter" '
            f'clip-path="url(#{cid})" d="{d}"/>')


def favicon(font, fill=0.96, radius=0.14, wall=190):
    """Square dark tile with the logo at a heavy wall, centred, as wide as `fill` (the two signs are ~2:1)."""
    d, (x0, y0, x1, y1) = outline(font, NU_SHID)
    w, h = x1 - x0, y1 - y0
    S = max(w, h) / fill  # tile side in font units
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    vb = [round(cx - S / 2), round(cy - S / 2), round(S), round(S)]
    body = (f'<rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" rx="{round(S * radius)}" fill="{TILE}"/>'
            f'<defs><clipPath id="k"><path d="{d}"/></clipPath></defs>'
            f'<path fill="none" stroke="{FAV}" stroke-width="{wall}" clip-path="url(#k)" d="{d}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}"><title>{TITLE}</title>{body}</svg>\n'


def flat(font):
    d, (bx0, by0, bx1, by1) = outline(font, NU_SHID)
    GX, GY, GW, GH = bx0, by0, bx1 - bx0, by1 - by0

    def svg(body, pad, tile=False):
        p = GH * pad
        vb = [GX - p, GY - p, GW + 2 * p, GH + 2 * p]
        vb = [round(v) for v in vb]
        bg = (f'<rect x="{vb[0] + 18}" y="{vb[1] + 18}" width="{vb[2] - 36}" height="{vb[3] - 36}" rx="{round(vb[3] * .07)}" '
              f'fill="{TILE}" stroke="{EDGE}" stroke-width="36"/>') if tile else ""
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}"><title>{TITLE}</title>{bg}{body}</svg>\n'

    line = "".join(wedge_line(a, b) for a, b in WEDGES)
    return {
        "logo-a.svg": svg(f'<path fill="{OFF}" d="{d}"/>', 0.04),
        "logo-c.svg": svg(f'<path fill="none" stroke="{ACC}" stroke-width="52" stroke-linejoin="round" stroke-linecap="round" d="{line}"/>', 0.08),
        "logo-f.svg": svg(hollow(d, wall=34, small_wall=48, cid="nu-shid-f"), 0.04),
        "logo.svg": svg(hollow(d, wall=34, small_wall=48, cid="nu-shid", colour=SLATE), 0.04),
        "logo-f-dark2.svg": svg(hollow(d, wall=34, small_wall=48, cid="nu-shid-f2", colour=CLAY), 0.04),
    }


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variants", type=Path, help="also write the unshipped design alternates here")
    ap.add_argument("--app-icon", type=Path, help="write the full-bleed square app-icon SVG here")
    args = ap.parse_args()
    font = TTFont(FONT); OUT.mkdir(parents=True, exist_ok=True)
    files = flat(font)
    logo = files.pop("logo.svg")
    (OUT / "logo.svg").write_text(logo); print("wrote", OUT / "logo.svg", len(logo), "bytes")
    (ROOT / "web/favicon.svg").write_text(favicon(font)); print("wrote", ROOT / "web/favicon.svg")
    if args.app_icon:
        args.app_icon.parent.mkdir(parents=True, exist_ok=True)
        args.app_icon.write_text(favicon(font, fill=0.80, radius=0, wall=150)); print("wrote", args.app_icon)
    if args.variants:
        files["logo-tablet.svg"] = tablet(font, NU_SHID, TITLE)
        files["logo-dub-nu-shid.svg"] = tablet(font, "\U0001207E" + NU_SHID, "dub nu-šid (Sumerian “tablet not read”): DUB NU ŠID")
        files["logo-la-sasu.svg"] = tablet(font, "\U000121B7\U000122AD\U000122E2\U00012311", "lā šasû (Akkadian “not read aloud”): la-ša-su-ú")
        args.variants.mkdir(parents=True, exist_ok=True)
        for name, svg in files.items():
            (args.variants / name).write_text(svg); print("wrote", args.variants / name, len(svg), "bytes")


if __name__ == "__main__":
    main()
