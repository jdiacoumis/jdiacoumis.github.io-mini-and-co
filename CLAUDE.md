# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Static marketing site for **Mini & Co**, a sensory play class business for babies aged 3–12 months (Oran Park, NSW). Plain HTML + CSS + a tiny JS file. No framework, no bundler, no package manifest. Deployed as static hosting (CNAME → `miniandcosensoryclasses.com`).

## Common commands

Serve locally (any static server works):

```bash
python3 -m http.server 8080      # then http://localhost:8080
# or
npx serve .
```

Asset exports (require `cairosvg`, `pillow`, and `segno` — `cairosvg`/`pillow` are installed by [.devcontainer/post-create.sh](.devcontainer/post-create.sh); install all manually with `pip install --user cairosvg pillow segno`):

```bash
python3 scripts/export-banner.py            # 850×2000mm pull-up banner → assets/banner/banner.png
python3 scripts/export-banner.py --dpi 200  # higher-res override
python3 scripts/export-flyer.py             # A4 portrait flyer → assets/flyer/flyer.{svg,png}
python3 scripts/export-flyer.py --dpi 300   # higher-res override (default 200)
python3 scripts/export-logo.py              # Instagram tile variants → assets/logo/instagram/
python3 scripts/optimise-photos.py          # photos-staging/*.{jpg,jpeg,png} → assets/photos/<slug>-<width>.{jpg,webp}
python3 scripts/optimise-photos.py --force  # re-export every photo regardless of mtime
```

There is no test suite, lint config, or build step. `dist/`, `build/`, and `node_modules/` are gitignored but unused by the site itself.

## Architecture

Each page is a fully standalone HTML file (`index.html`, `classes.html`, `about.html`, `contact.html`) sharing one stylesheet (`css/styles.css`) and one script (`js/main.js`, mobile nav toggle only). The header/footer markup is duplicated across pages by hand — there's no templating layer, so navigation or contact-detail edits need to be applied to every `*.html` file.

### Brand tokens — single source of truth

All design tokens live as CSS custom properties at the top of [css/styles.css](css/styles.css#L1-L38). Reuse these instead of hardcoding values:

**Palette** (cream/blush/sage/plum):
- Backgrounds: `--colour-bg` `#faf6f1`, `--colour-bg-warm` `#f6ebe2`, `--colour-bg-blush` `#f4e3dc`, `--colour-bg-sage` `#dde3d4`
- Accents: `--colour-accent-blush` `#e8c4b8`, `--colour-accent-sage` `#aebda1`
- Text: `--colour-text` `#3d2a3d` (deep plum, also referenced as `PLUM` in [scripts/export-logo.py](scripts/export-logo.py)), `--colour-text-soft` `#6b5466`, `--colour-text-muted` `#8d7d8a`
- Lines: `--colour-line` `#e6d8cf`, `--colour-line-soft` `#efe4dc`

**Typography**: `--font-display` Cormorant Garamond (300/400/500), `--font-body` Outfit (300/400/500/600). Both are pulled live from Google Fonts in each page's `<head>`. The `fonts/` directory holds local TTFs of the same families — those exist specifically so [assets/banner/banner.svg](assets/banner/banner.svg) can embed subsetted glyphs and render identically offline (in print) and in browsers without network access.

**Spacing/layout**: `--space-2xs` … `--space-3xl`, `--max-width` 1180px, `--max-width-prose` 62ch, `--max-width-narrow` 760px, `--radius-sm/md/lg/pill`, `--shadow-soft`, `--shadow-lift`, `--transition` 200ms.

### Asset pipeline

`assets/banner/banner.svg` and `assets/logo/logo.svg` are the editable source files. The PNGs (`banner.png`, `logo/instagram/*.png`) are **generated** — regenerate via the scripts in `scripts/`, do not hand-edit. The logo export composites coloured backgrounds and recolours the plum hex by string-replacement, so any palette change there must match `--colour-text`.

Photographic assets follow a different convention. Raw originals live locally in [photos-staging/](photos-staging/) (gitignored except for the README). Run `python3 scripts/optimise-photos.py` to turn each top-level `*.jpg`/`*.jpeg`/`*.png` into six tracked outputs at `assets/photos/<slug>-{600,1200,1600}.{jpg,webp}` — JPG quality 82, WebP quality 80, width-based resize with no upscale. The optimiser is idempotent (skips outputs newer than the source); `--force` reprocesses everything. Subdirectories of `photos-staging/` are intentionally skipped so they can act as a "not yet ready" holding area. Pillow is the only new Python dep and is installed by `post-create.sh`.

## OpenSpec workflow

This repo uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) for spec-driven development. State lives in `openspec/` (`specs/` for stable specs, `changes/` for in-flight proposals, `changes/archive/` for completed). Slash commands are registered under `.claude/commands/opsx/`.

Lifecycle (use these slash commands rather than editing `openspec/` by hand):

1. `/opsx:propose <description>` — scaffolds `openspec/changes/<name>/` with `proposal.md`, `design.md`, `tasks.md`.
2. `/opsx:apply [name]` — implements the tasks, ticking checkboxes as it goes.
3. `/opsx:archive [name]` — moves the completed change into `openspec/changes/archive/`.
4. `/opsx:explore <topic>` — thinking-only mode; do **not** write code, only investigate and optionally produce artifacts.

Note: OpenSpec is installed at container-create time via [.devcontainer/post-create.sh](.devcontainer/post-create.sh) — `openspec` should already be on PATH. Telemetry is on by default; opt out with `OPENSPEC_TELEMETRY=0`.

## Conventions

- **Australian English** in all user-visible copy and in code identifiers (note `--colour-*` not `--color-*`). HTML pages declare `lang="en-AU"`.
- **No frameworks, no build step.** Resist the urge to introduce one — every page is a hand-authored HTML file by design.
- **Header/nav/footer changes** must be applied across all four `*.html` files; there is no shared layout.
- **`.devcontainer/` is gitignored** in this project's `.gitignore` (the directory exists locally but isn't tracked) — image/devcontainer changes go through the upstream image repo or via post-create.sh edits committed deliberately.
