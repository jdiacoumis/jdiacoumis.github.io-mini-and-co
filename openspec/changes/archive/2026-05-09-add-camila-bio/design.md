## Context

The Mini & Co. site is plain static HTML/CSS with two existing developer scripts under `scripts/` (`export-banner.py`, `export-logo.py`). Both follow the same shape: hardcoded source/destination paths, a single argparse override at most, one external dep (`cairosvg`), and a print of what was written. They are run manually before commit; their outputs are tracked in git.

This change introduces our first photographic asset, a 5MB studio JPEG of Camila. The image is far too heavy to ship and will not be the last photo we add — Camila has a marketing shoot planned. We need a small, conventional pipeline before we add the bio rather than after, otherwise we'll either commit the bloated original (polluting history irreversibly) or set up the pipeline retroactively under time pressure when the next batch of photos arrives.

Constraints worth naming:
- **No build step**: the site is hand-authored static HTML. Anything we add at the asset layer must remain a developer-only tool, not a runtime dependency.
- **`.devcontainer/` is gitignored** in this project (per the project CLAUDE.md). Editing `post-create.sh` is a deliberate, narrow act — it's tracked by exception, not by default.
- **Brand tokens are the source of truth**: the bio layout must use existing CSS custom properties from the top of `css/styles.css`, not introduce new ones.
- **Header/footer are duplicated by hand across four HTML files**: this change touches `about.html` only, so we don't have to fan out across the others.

## Goals / Non-Goals

**Goals:**

1. Replace the "Meet Camila" placeholder on `about.html` with the agreed first-person bio copy and a responsive, optimised photograph.
2. Establish a repeatable convention for handling raw → optimised photographic assets that future marketing shoots can drop into without re-deciding any of this.
3. Keep the originals out of git history while keeping the convention discoverable on a fresh clone.
4. Add the new dependency (Pillow) once, in the devcontainer provisioning, so contributors don't hit "missing module" errors.

**Non-Goals:**

1. **No image-pipeline framework.** No imagemin, no sharp, no Node toolchain. A small Python script using Pillow is sufficient, matches the existing scripts/ pattern, and avoids touching the site's "no build step" architecture.
2. **No CMS, no templating layer, no shared header/footer extraction.** The repeated HTML across four pages is documented and accepted — this change does not refactor it.
3. **No content-hash filenames or service worker caching.** Filenames stay human-readable (`camila-1200.jpg`). The site has no SW; HTTP caching headers are the host's concern.
4. **No Git LFS, no external object storage for originals.** Out of scope for a four-page marketing site. Originals live locally in `photos-staging/`; full re-export reproducibility from a fresh clone is explicitly traded away.
5. **No new brand tokens.** All bio layout uses existing custom properties from `css/styles.css` lines 1–38.
6. **No changes to other pages.** This is `about.html` content + asset infrastructure. `index.html`, `classes.html`, `contact.html` are not touched.

## Decisions

### Decision 1: Staging directory at repo root, not under `assets/`

Raw originals go in `/photos-staging/` at the repo root, gitignored except for a tracked `README.md` that documents the convention.

**Rationale:**

- Co-locating staging *inside* `assets/photos/_raw/` would mix unpublished material into the same folder as published deliverables. The `.gitignore` rule then has to discriminate by path prefix, which is fragile (a future output named `_anything.jpg` would be silently skipped).
- A top-level `photos-staging/` is unambiguous: anyone seeing it understands "workflow folder, not output." It mirrors patterns like `tmp/`, `scratch/`, or `drafts/` that are common in static-site repos.
- The single ignore rule `/photos-staging/*` plus `!/photos-staging/README.md` is short, obvious, and survives renames inside the directory.

**Alternatives considered:**

- *`assets/photos/_raw/`* — rejected as above (mixes published with unpublished).
- *Git LFS* — rejected as massively disproportionate for a four-page marketing site.
- *Don't track originals at all, no convention* — rejected because the README is the only thing that makes the convention visible to a fresh clone or to Camila if she ever interacts with the repo.

**Trade-off accepted:** A fresh clone cannot regenerate `assets/photos/*` because it lacks the originals. We accept this. The optimised outputs are tracked in git; only re-running the optimiser at different sizes/qualities requires having the originals locally.

### Decision 2: Optimiser is a Python script using Pillow, matching the existing scripts/ pattern

`scripts/optimise-photos.py` is a small Pillow-based script. It globs `photos-staging/*.{jpg,jpeg,png}` (top-level only, not recursive), and for each input emits six outputs: `<slug>-{600,1200,1600}.{jpg,webp}` into `assets/photos/`. The slug is the source filename's stem (no extension).

**Rationale:**

- The two existing scripts are Python + argparse + one external dep. Matching that pattern means contributors learn one thing once.
- Pillow has built-in WebP support since 2017 (4.0); no separate library or system dependency is needed.
- A handful of decisions are defaulted, not made configurable: widths (600/1200/1600), JPG quality (82), WebP quality (80). These are CLI-overridable via argparse but rarely will be. Defaulting keeps the call site `python3 scripts/optimise-photos.py` with zero flags for the common case.
- Top-level glob (not recursive) means subdirectories in `photos-staging/` (e.g. `2026-04-marketing/`) are intentionally skipped. They serve as a holding area for shots not yet promoted to "ready to publish." To publish, move the file up to the staging root and rerun.

**Alternatives considered:**

- *Node + sharp* — faster, more idiomatic for web tooling, but introduces Node, package.json, and node_modules on a repo that has none of those. Rejected.
- *imagemagick CLI* — fewer dependencies (it's pre-installed in the devcontainer), but the script becomes a shell pipeline with quality settings spread across multiple `convert` invocations. Pillow keeps everything in one readable Python file.
- *Manifest file (`photos.toml`) listing inputs and metadata* — rejected for v1. The directory glob plus filename-as-slug is sufficient. If we later want to co-locate alt text or crop hints with each photo, a manifest is a natural extension.
- *Recursive glob* — rejected. We want subdirectories to act as a "not yet ready" gate, not a transparent passthrough.

**Idempotence:** the script skips a `(source, output)` pair if every output's mtime is newer than the source's. This makes re-running cheap and safe. Forced re-export uses `--force`.

### Decision 3: Three widths (600 / 1200 / 1600), JPG + WebP per width

Six outputs per photo: `<slug>-600.jpg`, `<slug>-600.webp`, `<slug>-1200.jpg`, `<slug>-1200.webp`, `<slug>-1600.jpg`, `<slug>-1600.webp`.

**Rationale:**

- 600w covers mobile portraits and small contexts.
- 1200w covers desktop in the asymmetric two-column layout (photo column ≈ 470px, ×2 retina ≈ 940px → 1200w gives headroom).
- 1600w covers full-bleed and large retina cases that future marketing photos may need.
- Both JPG and WebP per width is required for the `<picture>` element fallback. WebP has ~96% browser support; the JPG fallback is a small price for the long tail.
- Dropping to two widths (e.g. 800/1600) was tempting for simplicity, but `srcset` works best with at least three breakpoints when image use cases vary. Three is cheap (six files of <250KB each) and futureproof.

**Quality settings:** JPG 82, WebP 80. These are conventional sweet spots for photography: visually indistinguishable from higher quality at typical viewing sizes, ~150–200KB per file at the largest size. Configurable via `--jpg-quality` / `--webp-quality` if a specific photo demands it.

**Filename convention:** `<slug>-<width>.{jpg,webp}` — width-suffixed integer, no `w` letter (the `w` belongs in `srcset` descriptors, not filenames). Picked over `<slug>@<width>.jpg` (some build tools special-case `@2x`-style suffixes; we don't want any tool to mistake our filenames for that convention).

### Decision 4: Bio layout uses an asymmetric two-column pattern, not centred-photo-above-prose

```
desktop                                 mobile (≤ 768px)
┌────────┬───────────────────────────┐  ┌──────────────────────────┐
│        │ [eyebrow] Meet Camila     │  │ [eyebrow] Meet Camila    │
│ photo  │ The person behind...      │  │ The person behind...     │
│        │                           │  │                          │
│ ~40%   │ Para 1...                 │  │       [photo]            │
│        │ Para 2...                 │  │ (photo above prose,      │
│        │ Para 3...                 │  │  contained width)        │
│        │ Para 4...                 │  │                          │
│        │                           │  │ Para 1...                │
└────────┴───────────────────────────┘  └──────────────────────────┘
```

**Rationale:**

- The page above the bio is dense with structured content (three pillars, four pillars, evidence cards, promise checklist). A centred-above layout would feel like another structured block. The asymmetric layout breaks that rhythm and signals "this is a person, not another framework."
- The existing `.evidence` section already uses a two-column desktop grid (CSS line 487+), so the pattern is in the design vocabulary. Bio uses a different ratio (40/60 vs 50/50) to differentiate from evidence cards.
- Photo on the left, prose on the right is the dominant Western reading direction for founder bios; reading the face first, then the words feels right.
- On mobile the photo stacks above the prose. We do not crop or alter the photo for mobile; the same image scales down inside its column.

**Alternatives considered:**

- *Centred photo above prose* — works but reads as another content block (see above).
- *Pull-quote treatment alongside photo* — charming but competes with the lede paragraph at the top of the section, and we've now committed to four substantial paragraphs of bio that don't pull-quote cleanly.
- *Card-style treatment matching `.evidence__item`* — rejected as too rigid for the warmth this section is supposed to convey.

### Decision 5: `<picture>` element with WebP-first ordering, JPG fallback, single `sizes` declaration

Markup shape:

```html
<picture>
  <source type="image/webp"
          srcset="assets/photos/camila-600.webp 600w,
                  assets/photos/camila-1200.webp 1200w,
                  assets/photos/camila-1600.webp 1600w"
          sizes="(min-width: 768px) 40vw, 100vw">
  <img src="assets/photos/camila-1200.jpg"
       srcset="assets/photos/camila-600.jpg 600w,
               assets/photos/camila-1200.jpg 1200w,
               assets/photos/camila-1600.jpg 1600w"
       sizes="(min-width: 768px) 40vw, 100vw"
       alt="Camila, smiling, holding a notebook in a softly lit studio"
       width="1200" height="1800"
       loading="lazy" decoding="async">
</picture>
```

**Rationale:**

- `<source type="image/webp">` first means modern browsers pick WebP automatically; the `<img>` is the JPG fallback for everything else.
- Both `<source>` and `<img>` need their own `srcset` and `sizes` so the browser can pick a width regardless of which format it prefers.
- `sizes="(min-width: 768px) 40vw, 100vw"` matches the layout: at desktop the photo is ~40% of viewport (the column width), at mobile it's ~100%. The 768px breakpoint matches the existing CSS breakpoint for stacking.
- `width` and `height` attributes (intrinsic, not CSS) prevent layout shift while the photo loads. They're set to the source aspect ratio.
- `loading="lazy"` and `decoding="async"` are appropriate because the bio sits well below the fold on every viewport.
- `alt` text describes the image specifically, not generically ("photo of Camila"). The exact wording will be confirmed in implementation.

### Decision 6: Pillow added to `post-create.sh`, not just documented for manual install

`.devcontainer/post-create.sh` gets one line: `pip install --user pillow` alongside the existing `cairosvg` install.

**Rationale:**

- The user has confirmed (this conversation) they want this in the devcontainer. The alternative — documenting "run `pip install --user pillow` once" in CLAUDE.md — was rejected as less reproducible.
- This is the first deliberate edit to a tracked devcontainer file in this project. It's narrow (one line) and serves a stated convention (future photo work needs the same dep).

**Trade-off:** future contributors who don't use the devcontainer have to install Pillow themselves. CLAUDE.md will mention this dep alongside `cairosvg` so the requirement is visible.

## Risks / Trade-offs

- **Trade-off — no full reproducibility from fresh clone.** Originals are not tracked. Re-exporting `assets/photos/*` requires the originals locally. → Mitigation: outputs are tracked, and the `photos-staging/README.md` documents where originals are kept (Camila's own backup, photographer's gallery link, etc. — to be filled in during implementation).
- **Risk — developer commits a 5MB original to `photos-staging/` without realising it's gitignored, then `git add -f`s it.** → Mitigation: `photos-staging/README.md` explicitly states the directory is gitignored and originals stay local. CLAUDE.md repeats this. Convention by signage, not enforcement.
- **Risk — Pillow's WebP support is technically optional at compile time.** Pillow built from source without `libwebp-dev` lacks WebP. → Mitigation: pip-installed Pillow on Debian (the devcontainer base) ships with WebP enabled. The script will fail loudly if WebP is missing, surfacing the issue immediately rather than silently emitting JPGs only.
- **Risk — `photos-staging/` directory is empty on fresh clone (only README), so running the script produces no work.** → Mitigation: the script prints "no photos found in photos-staging/" rather than failing, so the no-op path is benign.
- **Risk — bio copy is in someone else's voice (mine, AI-drafted) rather than Camila's.** → Mitigation: copy has been iterated through Camila's stream-of-thought source notes; final copy must be reviewed by Camila before this change is merged. Tasks include a "review with Camila" gate.
- **Risk — devcontainer change requires rebuilding the container to pick up the new dep.** → Mitigation: documented in CLAUDE.md and in the change tasks. First-time contributors after this lands will rebuild as part of normal devcontainer updates.

## Migration Plan

This is a static site with no deploy pipeline state to migrate. Steps:

1. Implement per `tasks.md`.
2. Locally: rebuild devcontainer (or `pip install --user pillow` once) so the new dep is present.
3. Move the existing `assets/bio-photo/CAMILA_STUDIO-6.jpg` into `photos-staging/camila.jpg`.
4. Run `python3 scripts/optimise-photos.py` to generate `assets/photos/camila-{600,1200,1600}.{jpg,webp}`.
5. Verify in browser at `python3 -m http.server 8080` that the about page renders the photo and bio correctly across mobile / desktop.
6. Verify that `git status` shows the new outputs as tracked and the original as gitignored (i.e. it does NOT appear in `git status`).
7. Commit and merge.

**Rollback:** revert the merge commit. The optimised outputs are deleted, the placeholder copy returns, the script and staging convention are removed. No external state is touched.

## Open Questions

1. **Does Camila approve the final bio copy in her own voice?** This is a hard gate before merge. Specifically: the line "You shouldn't have to do any of that alone." carries a lot of conviction — does it sound like her?
2. **Alt text wording.** The draft "Camila, smiling, holding a notebook in a softly lit studio" is descriptive but worth a final review. Specifically, should it mention her role ("Camila, founder of Mini & Co., …")? Convention says no — alt text describes the image, not the role — but on a founder bio it could go either way.
3. **Is `photos-staging/README.md` the right place to record where the originals are backed up?** Or should that go in CLAUDE.md? Leaning README — it's co-located with the convention.
