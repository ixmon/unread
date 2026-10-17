#!/usr/bin/env python3
"""Draw the Unread Atlas logo tiles as SVG outlines (no web font needed at runtime).

Glyph outlines come from the self-hosted Noto Sans Cuneiform (web/fonts/NotoSansCuneiform.woff2, OFL).
Needs: pip install fonttools brotli.   Writes web/assets/logo/*.svg

  A  𒉡𒋃      nu-šid       NU U+12261 + ŠID U+122C3                 Sumerian "not counted / not read (out)"  <- in use
  B  𒁾𒉡𒋃    dub nu-šid   DUB U+1207E + NU + ŠID                   Sumerian "tablet (that is) not read"
  C  𒆷𒊭𒋢𒌑  la ša-su-ú   LA U+121B7 ŠA U+122AD SU U+122E2 U₂ U+12311  Akkadian lā šasû "not read aloud"
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "web/fonts/NotoSansCuneiform.woff2"
OUT = ROOT / "web/assets/logo"
LOGOS = [
    ("logo-nu-shid.svg", "\U00012261\U000122C3", "nu-šid (Sumerian “not read”): cuneiform signs NU and ŠID"),
    ("logo-dub-nu-shid.svg", "\U0001207E\U00012261\U000122C3", "dub nu-šid (Sumerian “tablet not read”): DUB NU ŠID"),
    ("logo-la-sasu.svg", "\U000121B7\U000122AD\U000122E2\U00012311", "lā šasû (Akkadian “not read aloud”): la-ša-su-ú"),
]


def outline(font, text, gap=40):
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    pen, bp, x = SVGPathPen(gs), BoundsPen(gs), 0
    for ch in text:
        g = cmap[ord(ch)]  # KeyError = the font lacks the sign
        t = (1, 0, 0, -1, x, 0)
        gs[g].draw(TransformPen(pen, t)); gs[g].draw(TransformPen(bp, t))
        x += gs[g].width + gap
    return pen.getCommands(), bp.bounds


def main():
    font = TTFont(FONT); OUT.mkdir(parents=True, exist_ok=True)
    for name, text, label in LOGOS:
        d, (x0, y0, x1, y1) = outline(font, text)
        p = (y1 - y0) * 0.12
        vb = [round(x0 - p), round(y0 - p), round(x1 - x0 + 2 * p), round(y1 - y0 + 2 * p)]
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}"><title>{label}</title>'
               '<defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d4895a"/>'
               '<stop offset="1" stop-color="#8b4a2e"/></linearGradient></defs>'
               f'<rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" rx="{round(vb[3] * .18)}" fill="url(#c)"/>'
               f'<path fill="#2b170d" d="{d}"/></svg>\n')
        (OUT / name).write_text(svg); print("wrote", OUT / name, f"aspect {vb[2] / vb[3]:.3f}")


if __name__ == "__main__":
    main()
