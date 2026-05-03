"""Export a print-ready PNG of assets/banner/banner.svg.

The banner is designed at 850 mm × 2000 mm (Australian standard pull-up
banner). This script renders it at a configurable DPI — default 150 DPI,
which is the resolution most commercial roller-banner printers actually
print at (the substrate doesn't carry detail much finer than that).

Run from the repo root:  python3 scripts/export-banner.py
Optional:                python3 scripts/export-banner.py --dpi 200

Output: assets/banner/banner.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cairosvg


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_SVG = REPO_ROOT / "assets" / "banner" / "banner.svg"
OUT_PNG = REPO_ROOT / "assets" / "banner" / "banner.png"

# Banner physical dimensions in millimetres (matches banner.svg viewBox).
WIDTH_MM = 850
HEIGHT_MM = 2000
MM_PER_INCH = 25.4


def render(dpi: int) -> None:
    width_px = round(WIDTH_MM / MM_PER_INCH * dpi)
    height_px = round(HEIGHT_MM / MM_PER_INCH * dpi)

    # banner.svg embeds the logo and QR as base64 data URIs, so it has no
    # external file references. unsafe=True is kept defensively in case the
    # base64 ever gets swapped back out for relative href references.
    cairosvg.svg2png(
        url=str(SRC_SVG),
        write_to=str(OUT_PNG),
        output_width=width_px,
        output_height=height_px,
        unsafe=True,
    )

    print(f"Rendered {OUT_PNG.relative_to(REPO_ROOT)} at {width_px}×{height_px}px ({dpi} DPI).")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dpi", type=int, default=150,
                        help="Output resolution in dots per inch (default: 150).")
    args = parser.parse_args()
    render(args.dpi)


if __name__ == "__main__":
    main()
