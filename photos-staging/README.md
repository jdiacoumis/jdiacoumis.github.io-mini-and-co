# photos-staging/

Local-only staging area for raw photographic originals (before optimisation).

## Convention

- This directory's contents are **gitignored**, except for this `README.md`.
- Drop raw originals (`*.jpg`, `*.jpeg`, `*.png`) at the **top level** of this directory. The slug used in published filenames is the source filename's stem — e.g. `camila.jpg` → `camila-1200.webp`.
- Run `python3 scripts/optimise-photos.py` from the repo root. It produces six outputs per source — `<slug>-{600,1200,1600}.{jpg,webp}` — into `assets/photos/`. Those outputs **are** tracked in git.
- **Subdirectories are not auto-published.** They serve as a holding area for shots that aren't yet ready. To publish a photo from a subdirectory, move it up to this directory's top level, then re-run the optimiser.

## Why originals are not tracked

Marketing-shoot originals are large (typical ~5MB JPEG), would balloon git history irreversibly, and don't need to be reproducible from a fresh clone — the optimised outputs are tracked, and only re-exporting at different sizes/qualities requires the originals.

## Where the originals live

> **TODO**: Camila / James to fill in once a backup location is agreed (e.g. Google Drive folder URL, photographer's gallery link). Until then, originals live on the operator's local machine only.

## Dependencies

The optimiser requires Pillow with WebP support:

```bash
pip install --user pillow
```

The devcontainer's `post-create.sh` installs this automatically alongside `cairosvg`. Verify WebP support with:

```bash
python3 -c "from PIL import features; assert features.check('webp')"
```
