"""Optimise raw photographs from photos-staging/ into web-ready outputs in assets/photos/.

For each raw original at the top level of photos-staging/ (jpg/jpeg/png, case-insensitive),
this script emits six files into assets/photos/:

    <slug>-600.jpg   <slug>-600.webp
    <slug>-1200.jpg  <slug>-1200.webp
    <slug>-1600.jpg  <slug>-1600.webp

Where <slug> is the source filename's stem. The image is resized so its width matches
the target (preserving aspect ratio; never upscaled). JPGs default to quality 82, WebPs
to quality 80 — conventional sweet spots for photography.

The script is idempotent: it skips a source if all six outputs exist and each one's
mtime is at least as new as the source. Pass --force to bypass that check.
Subdirectories of photos-staging/ are deliberately ignored — they hold material that
isn't yet ready to publish.

Run from the repo root:  python3 scripts/optimise-photos.py
Optional:                python3 scripts/optimise-photos.py --force
                         python3 scripts/optimise-photos.py --jpg-quality 90 --webp-quality 88
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "photos-staging"
OUT_DIR = REPO_ROOT / "assets" / "photos"

WIDTHS = (600, 1200, 1600)
SOURCE_SUFFIXES = (".jpg", ".jpeg", ".png")

DEFAULT_JPG_QUALITY = 82
DEFAULT_WEBP_QUALITY = 80


def find_sources() -> list[Path]:
    """Top-level image files in photos-staging/, sorted by name. Subdirectories ignored."""
    if not SRC_DIR.is_dir():
        return []
    return sorted(
        p for p in SRC_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in SOURCE_SUFFIXES
    )


def expected_outputs(source: Path) -> list[tuple[Path, str, int]]:
    """Six (path, format, target_width) tuples for a source's outputs."""
    slug = source.stem
    outputs: list[tuple[Path, str, int]] = []
    for w in WIDTHS:
        outputs.append((OUT_DIR / f"{slug}-{w}.jpg", "jpg", w))
        outputs.append((OUT_DIR / f"{slug}-{w}.webp", "webp", w))
    return outputs


def is_up_to_date(source: Path, outputs: list[tuple[Path, str, int]]) -> bool:
    src_mtime = source.stat().st_mtime
    for out_path, _, _ in outputs:
        if not out_path.is_file() or out_path.stat().st_mtime < src_mtime:
            return False
    return True


def encode(image: Image.Image, target_width: int, fmt: str, quality: int, out_path: Path) -> None:
    if image.width <= target_width:
        resized = image
    else:
        new_height = round(image.height * (target_width / image.width))
        resized = image.resize((target_width, new_height), Image.LANCZOS)

    if fmt == "jpg":
        if resized.mode != "RGB":
            resized = resized.convert("RGB")
        resized.save(out_path, format="JPEG", quality=quality, optimize=True, progressive=True)
    elif fmt == "webp":
        if resized.mode == "P":
            resized = resized.convert("RGBA" if "transparency" in resized.info else "RGB")
        resized.save(out_path, format="WEBP", quality=quality, method=6)
    else:
        raise ValueError(f"Unknown format: {fmt}")


def process(
    source: Path,
    *,
    force: bool,
    jpg_quality: int,
    webp_quality: int,
) -> int:
    """Return number of output files written for this source (0 if skipped)."""
    outputs = expected_outputs(source)
    if not force and is_up_to_date(source, outputs):
        print(f"  {source.name:32s}  skipped (up to date)")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        # Apply EXIF orientation so width/height reflect the visually correct
        # orientation; otherwise a portrait shot from a camera that records
        # rotation in EXIF would be resized as landscape.
        image = ImageOps.exif_transpose(image)

        written = 0
        for out_path, fmt, target_width in outputs:
            quality = jpg_quality if fmt == "jpg" else webp_quality
            encode(image, target_width, fmt, quality, out_path)
            size_kb = out_path.stat().st_size / 1024
            rel = str(out_path.relative_to(REPO_ROOT))
            print(f"  {rel:48s}  {size_kb:7.1f} KB")
            written += 1

    return written


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--force", action="store_true",
                        help="Reprocess every source, ignoring up-to-date outputs.")
    parser.add_argument("--jpg-quality", type=int, default=DEFAULT_JPG_QUALITY,
                        help=f"JPG encoder quality 1-100 (default: {DEFAULT_JPG_QUALITY}).")
    parser.add_argument("--webp-quality", type=int, default=DEFAULT_WEBP_QUALITY,
                        help=f"WebP encoder quality 1-100 (default: {DEFAULT_WEBP_QUALITY}).")
    args = parser.parse_args()

    sources = find_sources()
    if not sources:
        print("no photos found in photos-staging/")
        return

    total_written = 0
    for source in sources:
        total_written += process(
            source,
            force=args.force,
            jpg_quality=args.jpg_quality,
            webp_quality=args.webp_quality,
        )

    print(f"\nWrote {total_written} file(s) to {OUT_DIR.relative_to(REPO_ROOT)}/")


if __name__ == "__main__":
    main()
