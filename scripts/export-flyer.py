"""Build a print-ready A4 flyer at assets/flyer/flyer.{svg,png}.

Reproduces the flyer Camila mocked up, but driven by the real brand assets:
the source logo SVG (assets/logo/logo.svg), the local TTFs in fonts/, and a
freshly generated QR code that points at the site. Typography and palette
match assets/banner/banner.svg so the flyer reads as part of the same family.

Run from repo root:  python3 scripts/export-flyer.py
Optional:            python3 scripts/export-flyer.py --dpi 300

Dependencies (installed by .devcontainer/post-create.sh + segno):
    pip install --user cairosvg segno
"""

from __future__ import annotations

import argparse
import base64
import re
from pathlib import Path

import cairosvg
import segno


REPO_ROOT = Path(__file__).resolve().parent.parent
LOGO_SVG = REPO_ROOT / "assets" / "logo" / "logo.svg"
FONTS_DIR = REPO_ROOT / "fonts"
OUT_DIR = REPO_ROOT / "assets" / "flyer"
OUT_SVG = OUT_DIR / "flyer.svg"
OUT_PNG = OUT_DIR / "flyer.png"

# A4 portrait — the Australian standard, matches Camila's mock.
WIDTH_MM = 210
HEIGHT_MM = 297
MM_PER_INCH = 25.4

# Brand palette — kept in sync with css/styles.css and assets/banner/banner.svg.
BG = "#faf6f1"
BG_BLUSH = "#f4e3dc"
ACCENT_BLUSH = "#e8c4b8"
ACCENT_SAGE = "#aebda1"
LINE = "#e6d8cf"
PLUM = "#3d2a3d"
TEXT_SOFT = "#6b5466"
TEXT_MUTED = "#8d7d8a"
ORNAMENT = "#b39db0"
# Warm-blush "scan to book" panel — kept in sync with the panel in banner.svg.
PANEL_BLUSH = "#eccfc3"
PANEL_EYEBROW = "#a9786c"

# Hero photograph (tracked, optimised via scripts/optimise-photos.py). Shared
# subject with banner.svg so the flyer reads as part of the same family.
HERO_IMG = REPO_ROOT / "assets" / "photos" / "hero-sensory-play-1600.jpg"

QR_TARGET_URL = "https://miniandcosensoryclasses.com/"


def font_data_uri(filename: str) -> str:
    """Return a base64 data: URI for a TTF in the fonts/ directory.

    Embedding the fonts keeps the SVG renderable identically anywhere —
    cairosvg and any browser can resolve the @font-face without network
    access or fontconfig setup.
    """
    data = (FONTS_DIR / filename).read_bytes()
    return "data:font/ttf;base64," + base64.b64encode(data).decode("ascii")


def hero_data_uri() -> str:
    """Return a base64 data: URI for the hero JPEG, so the flyer SVG stays
    self-contained (no external file refs to resolve at render time)."""
    data = HERO_IMG.read_bytes()
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def logo_inner() -> str:
    """Return the inside of logo.svg with its outer <svg> wrapper stripped.

    The flyer wraps this in a nested <svg> with our own viewBox, so we can
    position the mark precisely without inheriting the source's tight
    viewBox (which clips the wordmark glyphs — see scripts/export-logo.py).
    """
    source = LOGO_SVG.read_text(encoding="utf-8")
    open_end = source.index(">", source.index("<svg")) + 1
    close_start = source.rindex("</svg>")
    return source[open_end:close_start]


def qr_svg_group(url: str, side_mm: float, x_mm: float, y_mm: float) -> str:
    """Generate an inline SVG <g> for a QR code at the given page position.

    segno emits an XML SVG which we parse down to just the <path> data, then
    rescale into millimetre coordinates so it sits cleanly alongside the
    rest of the flyer's mm-based layout.
    """
    qr = segno.make(url, error="h")
    # segno's path SVG is one <path> with unit-1 modules; default has a 4-module
    # quiet zone (border) baked in, which we keep — printed QRs need it.
    raw = qr.svg_inline(scale=1, border=4, dark=PLUM, light=None)
    width_match = re.search(r'width="(\d+)"', raw)
    path_match = re.search(r'<path[^>]*d="([^"]+)"', raw)
    if not width_match or not path_match:
        raise RuntimeError("Unexpected segno SVG output — could not parse QR.")
    modules = int(width_match.group(1))  # square, so width == height
    d_attr = path_match.group(1)
    scale = side_mm / modules
    # segno's path uses horizontal line commands (`h N`) — these draw strokes,
    # not filled regions. Render with stroke="…" and stroke-width=1 so each
    # module is fully covered; matches the banner's QR treatment.
    return (
        f'<g transform="translate({x_mm} {y_mm}) scale({scale})" '
        f'aria-label="QR code linking to {url}">'
        f'<path d="{d_attr}" stroke="{PLUM}" stroke-width="1" fill="none"/>'
        f"</g>"
    )


def build_svg() -> str:
    cormorant = font_data_uri("CormorantGaramond.ttf")
    cormorant_italic = font_data_uri("CormorantGaramond-Italic.ttf")
    outfit = font_data_uri("Outfit.ttf")
    hero = hero_data_uri()

    cx = WIDTH_MM / 2

    # QR inside the warm-blush footer panel (234..280), right-aligned and
    # vertically centred against the panel so it doesn't float to one corner.
    qr_side = 27
    qr_x = WIDTH_MM - 24 - qr_side   # ~4mm padding inside the panel's right edge
    qr_y = 240                       # leaves room for the SCAN TO BOOK caption below
    qr_block = qr_svg_group(QR_TARGET_URL, qr_side, qr_x, qr_y)

    # Logo: nested SVG inheriting our coordinate system. The 0..400 viewBox
    # covers the wordmark's full glyph extents (see export-logo.py rationale).
    logo_w = 60
    logo_h = 60  # square viewBox keeps "Mini & Co. — sensory classes —" centred
    logo_x = (WIDTH_MM - logo_w) / 2
    logo_y = 6
    logo_svg = (
        f'<svg x="{logo_x}" y="{logo_y}" width="{logo_w}" height="{logo_h}" '
        f'viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet">'
        f'{logo_inner()}'
        f'</svg>'
    )

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="{WIDTH_MM}mm" height="{HEIGHT_MM}mm"
     viewBox="0 0 {WIDTH_MM} {HEIGHT_MM}"
     role="img" aria-labelledby="flyerTitle">
  <title id="flyerTitle">Mini &amp; Co. Sensory Classes — A4 flyer</title>

  <defs>
    <style type="text/css"><![CDATA[
      @font-face {{
        font-family: 'Cormorant Garamond';
        src: url({cormorant}) format('truetype-variations');
        font-weight: 300 700;
        font-style: normal;
      }}
      @font-face {{
        font-family: 'Cormorant Garamond';
        src: url({cormorant_italic}) format('truetype-variations');
        font-weight: 300 700;
        font-style: italic;
      }}
      @font-face {{
        font-family: 'Outfit';
        src: url({outfit}) format('truetype-variations');
        font-weight: 100 900;
        font-style: normal;
      }}
      .display       {{ font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 400; }}
      .display-light {{ font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 300; }}
      .display-italic{{ font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 400; font-style: italic; }}
      .body          {{ font-family: 'Outfit', system-ui, sans-serif; font-weight: 300; }}
      .body-medium   {{ font-family: 'Outfit', system-ui, sans-serif; font-weight: 400; }}
      .eyebrow       {{ font-family: 'Outfit', system-ui, sans-serif; font-weight: 400; letter-spacing: 0.45em; text-transform: uppercase; }}
    ]]></style>
    <clipPath id="heroClip"><rect x="20" y="78" width="170" height="58" rx="5"/></clipPath>
  </defs>

  <!-- ===== BACKGROUND ===== -->
  <rect width="{WIDTH_MM}" height="{HEIGHT_MM}" fill="{BG}"/>

  <!-- Soft decorative blobs in the corners — same palette as the banner. -->
  <g opacity="0.6">
    <circle cx="-10" cy="-10" r="55" fill="{BG_BLUSH}"/>
    <circle cx="20" cy="35" r="18" fill="{ACCENT_BLUSH}" opacity="0.5"/>
    <circle cx="{WIDTH_MM + 15}" cy="20" r="50" fill="#e8dce5"/>
    <circle cx="{WIDTH_MM - 25}" cy="60" r="14" fill="{ACCENT_SAGE}" opacity="0.4"/>
    <circle cx="-20" cy="{HEIGHT_MM - 30}" r="60" fill="#e8dce5"/>
    <circle cx="{WIDTH_MM + 5}" cy="{HEIGHT_MM + 10}" r="55" fill="{BG_BLUSH}"/>
  </g>

  <!-- ===== LOGO ===== -->
  {logo_svg}

  <!-- Hairline ornament under logo, tucked close to the wordmark. -->
  <line x1="{cx - 12}" y1="72" x2="{cx + 12}" y2="72" stroke="{ORNAMENT}" stroke-width="0.3"/>
  <circle cx="{cx}" cy="72" r="0.7" fill="{ORNAMENT}"/>

  <!-- ===== HERO PHOTO ===== -->
  <!-- Same subject as banner.svg. Slice-fills a letterbox band; swap the source
       (assets/photos/hero-sensory-play-*) for the 24 June shots when ready. -->
  <image xlink:href="{hero}" x="20" y="78" width="170" height="58"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#heroClip)"/>
  <rect x="20" y="78" width="170" height="58" rx="5" fill="none" stroke="{ACCENT_SAGE}" stroke-width="0.4"/>

  <!-- ===== HEADLINE ===== -->
  <text x="{cx}" y="153" text-anchor="middle" class="display-light"
        font-size="16" fill="{PLUM}" letter-spacing="0.3">Sensory Play for Little Ones</text>

  <!-- ===== SUBTITLE (one short line — who it's for) ===== -->
  <text x="{cx}" y="167" text-anchor="middle" class="display-italic"
        font-size="6.5" fill="{TEXT_SOFT}" letter-spacing="0.2">For little ones 3–12 months &amp; their mums</text>

  <!-- ===== CLASS DETAILS ===== -->
  <text x="{cx}" y="184" text-anchor="middle" class="display-light"
        font-size="11" fill="{TEXT_SOFT}" letter-spacing="0.6">Wednesdays  ·  11 AM &amp; 1 PM</text>
  <text x="{cx}" y="194" text-anchor="middle" class="display-italic"
        font-size="7" fill="{TEXT_SOFT}" letter-spacing="0.2">Oran Park Library  ·  Sandown Room</text>

  <!-- ===== NOW ENROLLING (dated — the flyer carries what the banner omits) ===== -->
  <text x="{cx}" y="209" text-anchor="middle" class="eyebrow"
        font-size="5" fill="{TEXT_MUTED}">Now enrolling</text>
  <line x1="{cx - 14}" y1="213" x2="{cx + 14}" y2="213" stroke="{ORNAMENT}" stroke-width="0.3"/>
  <circle cx="{cx}" cy="213" r="0.7" fill="{ORNAMENT}"/>

  <text x="{cx}" y="224" text-anchor="middle" class="display"
        font-size="11" fill="{PLUM}" letter-spacing="0.2">Term 3 begins  ·  Wednesday 22 July</text>

  <!-- ===== BOOK NOW PANEL (warm blush) — booking CTA + key contacts ===== -->
  <rect x="20" y="234" width="170" height="46" rx="5" fill="{PANEL_BLUSH}"/>

  <text x="30" y="249" class="display" font-size="11" fill="{PLUM}" letter-spacing="0.2">Scan to book online</text>

  <!-- Website, Instagram, email -->
  <g transform="translate(30, 256)">
    <g fill="none" stroke="{PLUM}" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="3" cy="3" r="2.6"/>
      <ellipse cx="3" cy="3" rx="1.05" ry="2.6"/>
      <line x1="0.4" y1="3" x2="5.6" y2="3"/>
      <path d="M0.85 1.5 Q 3 2.3 5.15 1.5"/>
      <path d="M0.85 4.5 Q 3 3.7 5.15 4.5"/>
    </g>
    <text x="9" y="4.4" class="body-medium" font-size="3.6" fill="{PLUM}">miniandcosensoryclasses.com</text>
  </g>
  <g transform="translate(30, 264)">
    <g fill="none" stroke="{PLUM}" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round">
      <rect x="0.4" y="0.4" width="5.2" height="5.2" rx="1.3"/>
      <circle cx="3" cy="3" r="1.25"/>
      <circle cx="4.5" cy="1.5" r="0.32" fill="{PLUM}"/>
    </g>
    <text x="9" y="4.4" class="body-medium" font-size="3.6" fill="{PLUM}">@miniandco.classes</text>
  </g>
  <g transform="translate(30, 272)">
    <g fill="none" stroke="{PLUM}" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round">
      <rect x="0.4" y="1" width="5.2" height="4" rx="0.5"/>
      <path d="M0.4 1.5 L3 3.5 L5.6 1.5"/>
    </g>
    <text x="9" y="4.4" class="body-medium" font-size="3.6" fill="{PLUM}">miniandco.classes@gmail.com</text>
  </g>

  <!-- QR caption -->
  <text x="{qr_x + qr_side / 2}" y="{qr_y + qr_side + 3}" text-anchor="middle"
        class="body" font-size="2.6" fill="{PANEL_EYEBROW}" letter-spacing="0.6">SCAN TO BOOK</text>

  <!-- ===== QR CODE ===== -->
  {qr_block}

</svg>
"""


def render_png(dpi: int) -> None:
    width_px = round(WIDTH_MM / MM_PER_INCH * dpi)
    height_px = round(HEIGHT_MM / MM_PER_INCH * dpi)
    cairosvg.svg2png(
        url=str(OUT_SVG),
        write_to=str(OUT_PNG),
        output_width=width_px,
        output_height=height_px,
        unsafe=True,
    )
    print(f"Rendered {OUT_PNG.relative_to(REPO_ROOT)} at {width_px}×{height_px}px ({dpi} DPI).")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dpi", type=int, default=200,
                        help="Output PNG resolution in DPI (default: 200 — print-quality A4).")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_SVG.write_text(build_svg(), encoding="utf-8")
    print(f"Wrote {OUT_SVG.relative_to(REPO_ROOT)} ({OUT_SVG.stat().st_size / 1024:.0f} KB).")
    render_png(args.dpi)


if __name__ == "__main__":
    main()
