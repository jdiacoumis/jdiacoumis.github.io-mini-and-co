"""Export a print-ready PNG of assets/banner/banner.svg.

The banner is designed at 850 mm × 2000 mm (Australian standard pull-up
banner). This script renders it at a configurable DPI — default 150 DPI,
which is the resolution most commercial roller-banner printers actually
print at (the substrate doesn't carry detail much finer than that).

The output PNG embeds physical-size metadata (the PNG pHYs chunk) so that
print-shop upload tools read the correct millimetre dimensions instead of
assuming 72 DPI.

Run from the repo root:  python3 scripts/export-banner.py
Optional:                python3 scripts/export-banner.py --dpi 200
Print-shop canvas:       python3 scripts/export-banner.py --print-size 841x2055 --dpi 300

With `--print-size`, the script exports ONLY a file sized to an exact print
spec (e.g. Officeworks pull-up banners want 841 mm × 2055 mm — the extra
height beyond the visible ~2000 mm wraps into the roller cassette), leaving
banner.png untouched so the repo copy can stay at a web-friendly DPI. The
artwork is scaled to fit without distortion, top-aligned, and the leftover
strip is filled with the banner's cream background so it blends into the
cassette.

Output: assets/banner/banner.png
        assets/banner/banner-print-<W>x<H>.png (with --print-size, instead)
"""

from __future__ import annotations

import argparse
import io
import re
from pathlib import Path

import cairosvg
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_SVG = REPO_ROOT / "assets" / "banner" / "banner.svg"
OUT_PNG = REPO_ROOT / "assets" / "banner" / "banner.png"

# Banner physical dimensions in millimetres (matches banner.svg viewBox).
WIDTH_MM = 850
HEIGHT_MM = 2000
MM_PER_INCH = 25.4

# Must match the base <rect fill> in banner.svg (--colour-bg in css/styles.css).
BACKGROUND_COLOUR = "#faf6f1"

# Bounds chosen so a mistyped DPI can't request an absurd render. 300 DPI is
# already beyond what roller-banner substrate resolves; it exists to satisfy
# print-shop preflight checks, not to add visible detail.
MIN_DPI = 36
MAX_DPI = 300

# A 300 DPI render of the 2 m banner is ~241 megapixels, which crosses
# Pillow's default decompression-bomb threshold (~179 MP). The input here is
# our own freshly-rendered SVG, not an untrusted file, so raise the ceiling
# just enough to cover MAX_DPI renders while keeping a hard cap in place.
Image.MAX_IMAGE_PIXELS = 400_000_000


def mm_to_px(mm: float, dpi: int) -> int:
    return round(mm / MM_PER_INCH * dpi)


def render_artwork(width_px: int, height_px: int) -> Image.Image:
    """Render banner.svg to a Pillow image at the given pixel size."""
    # banner.svg embeds the logo and QR as base64 data URIs, so it has no
    # external file references. unsafe=True is kept defensively in case the
    # base64 ever gets swapped back out for relative href references.
    png_bytes = cairosvg.svg2png(
        url=str(SRC_SVG),
        write_to=None,
        output_width=width_px,
        output_height=height_px,
        unsafe=True,
    )
    return Image.open(io.BytesIO(png_bytes)).convert("RGB")


def export_native(dpi: int) -> None:
    """Export the banner at its native 850×2000 mm size."""
    width_px = mm_to_px(WIDTH_MM, dpi)
    height_px = mm_to_px(HEIGHT_MM, dpi)

    artwork = render_artwork(width_px, height_px)
    # Pillow writes the pHYs chunk from `dpi`, so upload tools read 850×2000 mm.
    artwork.save(OUT_PNG, dpi=(dpi, dpi))

    print(f"Rendered {OUT_PNG.relative_to(REPO_ROOT)} at "
          f"{width_px}×{height_px}px ({dpi} DPI, {WIDTH_MM}×{HEIGHT_MM}mm).")


def export_print_canvas(dpi: int, canvas_width_mm: int, canvas_height_mm: int) -> None:
    """Export the banner on an exact print-spec canvas.

    The artwork keeps its 850:2000 aspect ratio, scaled to fit inside the
    canvas, centred horizontally and top-aligned (the unused strip at the
    bottom of a pull-up banner disappears into the roller cassette).
    """
    canvas_width_px = mm_to_px(canvas_width_mm, dpi)
    canvas_height_px = mm_to_px(canvas_height_mm, dpi)

    scale = min(canvas_width_px / WIDTH_MM, canvas_height_px / HEIGHT_MM)
    artwork_width_px = round(WIDTH_MM * scale)
    artwork_height_px = round(HEIGHT_MM * scale)

    artwork = render_artwork(artwork_width_px, artwork_height_px)
    canvas = Image.new("RGB", (canvas_width_px, canvas_height_px), BACKGROUND_COLOUR)
    canvas.paste(artwork, ((canvas_width_px - artwork_width_px) // 2, 0))

    out_path = OUT_PNG.with_name(f"banner-print-{canvas_width_mm}x{canvas_height_mm}.png")
    canvas.save(out_path, dpi=(dpi, dpi))

    print(f"Rendered {out_path.relative_to(REPO_ROOT)} at "
          f"{canvas_width_px}×{canvas_height_px}px "
          f"({dpi} DPI, {canvas_width_mm}×{canvas_height_mm}mm canvas, "
          f"artwork {round(WIDTH_MM * scale / dpi * MM_PER_INCH)}×"
          f"{round(HEIGHT_MM * scale / dpi * MM_PER_INCH)}mm, top-aligned).")


def parse_print_size(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d{2,4})x(\d{2,4})", value)
    if not match:
        raise argparse.ArgumentTypeError(
            f"Print size '{value}' is invalid. "
            f"Expected millimetre dimensions as WIDTHxHEIGHT, e.g. 841x2055."
        )
    return int(match.group(1)), int(match.group(2))


def parse_dpi(value: str) -> int:
    try:
        dpi = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"DPI '{value}' is not a whole number.")
    if not MIN_DPI <= dpi <= MAX_DPI:
        raise argparse.ArgumentTypeError(
            f"DPI {dpi} is out of range. Expected {MIN_DPI}–{MAX_DPI}; "
            f"commercial roller-banner printing rarely benefits beyond 200."
        )
    return dpi


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dpi", type=parse_dpi, default=150,
                        help="Output resolution in dots per inch (default: 150).")
    parser.add_argument("--print-size", type=parse_print_size, default=None,
                        metavar="WxH",
                        help="Export only an exact print canvas in millimetres, "
                             "e.g. 841x2055 (Officeworks pull-up banner spec); "
                             "banner.png is left untouched.")
    args = parser.parse_args()

    if args.print_size:
        export_print_canvas(args.dpi, *args.print_size)
    else:
        export_native(args.dpi)


if __name__ == "__main__":
    main()
