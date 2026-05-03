"""Export Instagram-ready PNGs from assets/logo/logo.svg.

Builds eight variants (cream/blush/sage/blue/plum tiles, profile-pic with
extra padding, plus two transparent overlays) by wrapping the source SVG
in a square viewBox of the right size and optionally compositing a
solid-colour background rect underneath. Logo recolour for the reversed
and cream-on-transparent variants is done by string-replacing the brand
plum hex in the SVG.

Run from repo root:  python3 scripts/export-logo.py
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cairosvg


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_SVG = REPO_ROOT / "assets" / "logo" / "logo.svg"
OUT_DIR = REPO_ROOT / "assets" / "logo" / "instagram"

PLUM = "#3d2a3d"
CREAM = "#faf6f1"

# The source SVG's own viewBox (30 45 340 310) is tight to the strokes/circle
# but does NOT bound the wordmark's glyph extents at font-size=62 — at that
# size "Mini & Co." actually reaches roughly x=0..400. We render the SVG's
# inner content directly in our own outer viewBox (stripping its <svg>
# wrapper, see render_svg below), and size that viewBox around the true art
# extents: ~400 wide, centred on (200, 200).
ART_CENTRE = 200
ART_BASE_SIDE = 400

OUTPUT_PX = 1080


@dataclass(frozen=True)
class Variant:
    filename: str
    background: str | None  # hex or None for transparent
    logo_colour: str
    pad_fraction: float


VARIANTS: tuple[Variant, ...] = (
    # Square coloured tiles, minimal padding so the mark fills the grid cell.
    Variant("logo-square-cream.png", CREAM, PLUM, 0.05),
    Variant("logo-square-blush.png", "#f4e3dc", PLUM, 0.05),
    Variant("logo-square-sage.png", "#dde3d4", PLUM, 0.05),
    Variant("logo-square-blue.png", "#d6e0e6", PLUM, 0.05),
    Variant("logo-square-plum.png", PLUM, CREAM, 0.05),
    # Profile picture: cream background, extra padding so the wordmark survives
    # Instagram's circle crop (~21% of corner area is lost).
    Variant("logo-ig-profile.png", CREAM, PLUM, 0.15),
    # Transparent overlays for stamping on photos.
    Variant("logo-transparent.png", None, PLUM, 0.05),
    Variant("logo-transparent-cream.png", None, CREAM, 0.05),
)


def extract_inner(source: str) -> str:
    """Return the source SVG's content with its outer <svg ...>...</svg> stripped.

    Nesting an <svg> inside another <svg> would force the inner viewBox to
    be remapped to fill the outer viewport, defeating any padding we add.
    Pulling out just the inner content lets us draw it directly in our own
    coordinate system using the original path/text coordinates.
    """
    open_end = source.index(">", source.index("<svg")) + 1
    close_start = source.rindex("</svg>")
    return source[open_end:close_start]


def build_svg(source: str, variant: Variant) -> bytes:
    """Wrap the source SVG content in a square outer canvas with optional background."""
    side = ART_BASE_SIDE * (1.0 + 2.0 * variant.pad_fraction)
    origin = ART_CENTRE - side / 2.0

    inner = extract_inner(source)
    if variant.logo_colour.lower() != PLUM:
        inner = inner.replace(PLUM, variant.logo_colour)

    background_rect = ""
    if variant.background is not None:
        background_rect = (
            f'<rect x="{origin}" y="{origin}" '
            f'width="{side}" height="{side}" '
            f'fill="{variant.background}"/>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{origin} {origin} {side} {side}">'
        f"{background_rect}"
        f"{inner}"
        f"</svg>"
    ).encode("utf-8")


def main() -> None:
    if not SRC_SVG.is_file():
        raise SystemExit(f"Source SVG not found: {SRC_SVG}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    source = SRC_SVG.read_text(encoding="utf-8")

    for variant in VARIANTS:
        wrapped = build_svg(source, variant)
        out_path = OUT_DIR / variant.filename
        cairosvg.svg2png(
            bytestring=wrapped,
            output_width=OUTPUT_PX,
            output_height=OUTPUT_PX,
            write_to=str(out_path),
        )
        size_kb = out_path.stat().st_size / 1024
        print(f"  {variant.filename:32s}  {size_kb:6.1f} KB")

    print(f"\nWrote {len(VARIANTS)} files to {OUT_DIR.relative_to(REPO_ROOT)}/")


if __name__ == "__main__":
    main()
