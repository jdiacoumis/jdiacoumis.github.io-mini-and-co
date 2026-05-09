## Why

The about page has carried a "Camila's bio coming soon" placeholder since launch. Camila is the human Mini & Co. is built around, and the page already does heavy lifting on philosophy and evidence — without her story, the section that promises "the person behind Mini & Co." is the weakest part of the site. We now have a studio photo and Camila's biographical material, so we can replace the placeholder with a first-person bio and her photograph.

Doing this reveals a second gap: the site has no convention for managing photographic assets. The studio shot is a 5MB JPEG, far too heavy to ship as-is, and we want this to be the first of several marketing photos rather than a one-off. We need a small image pipeline before we add the bio, otherwise we'll either commit a bloated original or set a bad precedent for future photos.

## What Changes

- Add `scripts/optimise-photos.py`: reads `photos-staging/*.{jpg,jpeg,png}` and writes optimised JPG + WebP variants at three widths (600 / 1200 / 1600) into `assets/photos/`. Skips files whose outputs are already up-to-date relative to source mtime.
- Add a top-level `photos-staging/` directory: holds raw originals locally, gitignored except for a tracked `README.md` documenting the convention.
- Update `.gitignore` so that `/photos-staging/*` is excluded but `/photos-staging/README.md` is preserved.
- Update `.devcontainer/post-create.sh` to install Pillow (`pip install --user pillow`) so the new script's dependency is provisioned alongside `cairosvg`.
- Replace the "Meet Camila" placeholder in `about.html` with the agreed first-person bio copy and a responsive `<picture>` element using `srcset` for the three optimised widths, WebP first with JPG fallback.
- Add CSS for an asymmetric two-column "bio" layout (photo left, prose right at desktop; photo above prose at mobile) using existing brand tokens — no new design tokens.
- Decommission `assets/bio-photo/`: move the original out to `photos-staging/`, generate the optimised outputs into `assets/photos/`, delete the now-unused `assets/bio-photo/` directory.
- Update `CLAUDE.md` (project) to document the new staging convention, the new script, and the new Pillow dependency under "Common commands" and "Asset pipeline".

## Capabilities

### New Capabilities
- `photo-pipeline`: convention for taking raw photographic assets from a local-only staging directory to optimised, multi-size, multi-format outputs in the tracked `assets/photos/` directory.
- `founder-bio`: contract that the about page presents Camila's biography with her photograph in a calm, evidence-anchored layout consistent with the rest of the page.

### Modified Capabilities
<!-- None — booking-cta is the only existing spec and is unrelated to this change. -->

## Impact

- **New files**: `scripts/optimise-photos.py`, `photos-staging/README.md`, `assets/photos/camila-{600,1200,1600}.{jpg,webp}` (six generated outputs).
- **Edited files**: `.gitignore`, `.devcontainer/post-create.sh`, `about.html`, `css/styles.css`, `CLAUDE.md`.
- **Deleted files**: `assets/bio-photo/CAMILA_STUDIO-6.jpg`, `assets/bio-photo/` directory.
- **New runtime dependency**: Pillow (Python imaging library), installed via `post-create.sh`. No new browser-side dependency.
- **Devcontainer scope**: this is the first deliberate edit to a tracked devcontainer file in this project; per the project CLAUDE.md, `.devcontainer/` is otherwise gitignored. The edit is intentional and scoped to one line.
- **No architectural change**: still no framework, no bundler, no build step required to serve the site. The optimise script is a developer-only tool; the published HTML/CSS/assets remain plain static files.
- **Browser support**: WebP has ~96% global support; the `<picture>` element falls back to JPG for any browser that doesn't.
