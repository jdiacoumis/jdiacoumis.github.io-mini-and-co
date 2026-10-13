"""Build the A5 "Play at Home" booklet at assets/ebook/play-at-home.pdf.

The booklet is hand-authored HTML (assets/ebook/play-at-home.html) printed to
PDF with headless Chromium, so the text stays easy to edit. Fonts come from
the local TTFs in fonts/ and photos from assets/photos/. This script also
regenerates the QR code (assets/ebook/qr.svg) that points at the site.

The page count is kept at a multiple of 4 so print shops can saddle-stitch it
as a booklet (e.g. Officeworks "booklet" printing on A4, folded to A5).

Run from repo root:  python3 scripts/export-ebook.py
Optional:            python3 scripts/export-ebook.py --chrome /path/to/chrome

Dependencies:
    pip install --user segno
    Chromium or Google Chrome (found automatically, or pass --chrome)
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import segno


REPO_ROOT = Path(__file__).resolve().parent.parent
EBOOK_DIR = REPO_ROOT / "assets" / "ebook"
SOURCE_HTML = EBOOK_DIR / "play-at-home.html"
OUT_PDF = EBOOK_DIR / "play-at-home.pdf"
QR_SVG = EBOOK_DIR / "qr.svg"

QR_TARGET_URL = "https://miniandcosensoryclasses.com/"
PLUM = "#3d2a3d"  # --colour-text in css/styles.css

CHROME_CANDIDATES = [
    "/opt/pw-browsers/chromium",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome(explicit: str | None) -> str:
    for candidate in [explicit, os.environ.get("CHROME")] + CHROME_CANDIDATES:
        if not candidate:
            continue
        resolved = shutil.which(candidate) or (candidate if Path(candidate).exists() else None)
        if resolved:
            return resolved
    sys.exit("Could not find Chromium or Chrome. Pass --chrome /path/to/chrome.")


def write_qr() -> None:
    qr = segno.make(QR_TARGET_URL, error="h")
    qr.save(QR_SVG, kind="svg", scale=10, border=2, dark=PLUM, light=None, xmldecl=False)


def print_pdf(chrome: str) -> None:
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            [
                chrome,
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                f"--user-data-dir={profile}",
                "--allow-file-access-from-files",
                "--no-pdf-header-footer",
                "--virtual-time-budget=10000",
                f"--print-to-pdf={OUT_PDF}",
                SOURCE_HTML.as_uri(),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chrome", help="path to a Chromium/Chrome binary")
    args = parser.parse_args()

    write_qr()
    print_pdf(find_chrome(args.chrome))
    print(f"Wrote {OUT_PDF.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
