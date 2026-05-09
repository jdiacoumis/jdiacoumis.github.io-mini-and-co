## 1. Staging directory and gitignore

- [x] 1.1 Create `photos-staging/` at the repo root
- [x] 1.2 Add `photos-staging/README.md` documenting the convention: directory is gitignored, raw originals stay local, optimised outputs go to `assets/photos/` via `scripts/optimise-photos.py`, subdirectories are not auto-published
- [x] 1.3 Update `.gitignore` to add `/photos-staging/*` and `!/photos-staging/README.md`
- [x] 1.4 Verify with `git status` that the staging directory is empty-of-tracked-content except the README, and that dropping a test JPG into `photos-staging/` does not show in `git status`

## 2. Devcontainer dependency

- [x] 2.1 Read `.devcontainer/post-create.sh` to find the existing `pip install --user` line for cairosvg
- [x] 2.2 Add `pillow` to the existing `pip install --user` invocation (single line, alongside cairosvg)
- [x] 2.3 Locally install Pillow into the current container (`pip install --user pillow`) so the script works without rebuilding
- [x] 2.4 Verify Pillow's WebP support is available: `python3 -c "from PIL import features; assert features.check('webp')"`

## 3. Optimiser script

- [x] 3.1 Create `scripts/optimise-photos.py` following the shape of `scripts/export-banner.py`: argparse, paths derived from `__file__`, single-purpose `main()`
- [x] 3.2 Implement top-level glob of `photos-staging/*.{jpg,jpeg,png}` (case-insensitive); skip subdirectories
- [x] 3.3 Implement per-source loop emitting six outputs: `<slug>-{600,1200,1600}.{jpg,webp}` into `assets/photos/`
- [x] 3.4 Implement Pillow resize using `Image.thumbnail()` (or equivalent that preserves aspect ratio against the long edge), encoding JPGs at quality 82 and WebPs at quality 80
- [x] 3.5 Implement idempotence: skip a source if all six expected outputs exist AND every output's mtime ≥ source's mtime
- [x] 3.6 Add `--force` flag to bypass the idempotence check
- [x] 3.7 Add `--jpg-quality` and `--webp-quality` CLI flags for overriding defaults
- [x] 3.8 Print a one-line summary per output (path + size in KB), matching the style of `export-logo.py`
- [x] 3.9 Print a clean message ("no photos found in photos-staging/") when staging is empty rather than erroring

## 4. Asset migration

- [x] 4.1 Create `assets/photos/` directory (tracked)
- [x] 4.2 Move `assets/bio-photo/CAMILA_STUDIO-6.jpg` to `photos-staging/camila.jpg` (rename in transit so the slug is `camila`)
- [x] 4.3 Delete the now-empty `assets/bio-photo/` directory
- [x] 4.4 Run `python3 scripts/optimise-photos.py` and verify it produces six files at `assets/photos/camila-{600,1200,1600}.{jpg,webp}`
- [x] 4.5 Spot-check the largest JPG (1600w) is under ~250KB and the equivalent WebP is roughly 40% smaller
- [x] 4.6 Re-run the optimiser a second time and confirm it skips all outputs (idempotence)
- [x] 4.7 Run with `--force` and confirm all outputs are regenerated

## 5. Bio markup on about.html

- [x] 5.1 Locate the existing "Meet Camila" `<section>` in `about.html` (the `.placeholder-note` block)
- [x] 5.2 Replace the section's body with: eyebrow + `<h2>` + a new `.bio` container holding `<picture>` (left) and a `.bio__body` div with the four bio paragraphs (right)
- [x] 5.3 Inside `<picture>`, add `<source type="image/webp" srcset="…600w, …1200w, …1600w" sizes="(min-width: 768px) 40vw, 100vw">`
- [x] 5.4 Inside `<picture>`, add `<img src="assets/photos/camila-1200.jpg" srcset="…600w, …1200w, …1600w" sizes="…" alt="…" width="1200" height="1800" loading="lazy" decoding="async">` — confirm the actual aspect ratio against the generated 1200w JPG and adjust width/height to match
- [x] 5.5 Paste the canonical bio prose verbatim from `specs/founder-bio/spec.md` (the "canonical four-paragraph text" requirement) into `.bio__body` as four `<p>` elements; HTML-escape `&` as `&amp;` in "Mini & Co." but make no other substitutions
- [x] 5.6 Confirm no occurrence of "Camila's bio coming soon" or `class="placeholder-note"` remains in `about.html`
- [x] 5.7 Confirm `index.html`, `classes.html`, `contact.html`, and `js/main.js` are unchanged

## 6. Bio CSS

- [x] 6.1 Add a `.bio` rule using CSS Grid (or flex) for the asymmetric two-column layout: roughly `grid-template-columns: 2fr 3fr` at desktop, single column on mobile
- [x] 6.2 Add `.bio__photo` (or equivalent) styling so the photograph fills its column with the existing `--radius-md` and `--shadow-soft` (or similar from existing tokens)
- [x] 6.3 Add `.bio__body` styling for paragraph spacing using `--space-*` tokens
- [x] 6.4 Add the responsive breakpoint at 768px (or whichever existing breakpoint is consistent — match `.evidence`'s breakpoint if it differs) so the layout stacks below it
- [x] 6.5 Confirm no new `--colour-*`, `--font-*`, `--space-*`, `--radius-*`, or `--shadow-*` custom properties were added; only existing tokens referenced

## 7. Documentation

- [x] 7.1 Update project `CLAUDE.md`: add `python3 scripts/optimise-photos.py` to the "Common commands" section under asset exports
- [x] 7.2 Update project `CLAUDE.md`: in the "Asset pipeline" section, document the `photos-staging/` convention (gitignored, raw originals, the optimiser turns them into `assets/photos/<slug>-<width>.{jpg,webp}`)
- [x] 7.3 Update project `CLAUDE.md`: mention Pillow alongside `cairosvg` as a script-side Python dep installed by `post-create.sh`
- [x] 7.4 Note in `photos-staging/README.md` where Camila's photo originals are backed up (open question — fill in during implementation, or leave a TODO for Camila to provide)

## 8. Browser verification

- [ ] 8.1 Serve the site: `python3 -m http.server 8080`
- [ ] 8.2 Open `http://localhost:8080/about.html` on desktop viewport (≥ 768px) and confirm the photograph is left of the prose, layout breathes, no overflow, no broken styling
- [ ] 8.3 Resize the viewport below 768px and confirm the photograph stacks above the prose
- [ ] 8.4 In DevTools network tab, confirm the browser is fetching a WebP (not JPG) on a current Chrome
- [ ] 8.5 In DevTools network tab on a small viewport, confirm the 600w variant is fetched (not 1200w or 1600w)
- [ ] 8.6 Confirm no console errors and no layout shift when the image loads (intrinsic width/height attributes do their job)
- [ ] 8.7 Run `/security-review` per the project security guidance

## 9. Camila review gate (HARD GATE — do not merge before this)

- [ ] 9.1 Share the rendered bio with Camila for review
- [ ] 9.2 Confirm the bio prose lands in her voice — specifically the line "You shouldn't have to do any of that alone."
- [ ] 9.3 Confirm the alt text wording (descriptive of image content)
- [ ] 9.4 If Camila requests wording changes, update the canonical prose requirement in `specs/founder-bio/spec.md` first, then update `about.html` to match — both in the same commit, so spec and rendered page never diverge

## 10. Final cleanup

- [ ] 10.1 Run `git status` and confirm the diff matches the impact list in proposal.md exactly: new files (`photos-staging/README.md`, `scripts/optimise-photos.py`, `assets/photos/camila-*.{jpg,webp}`), edited files (`.gitignore`, `.devcontainer/post-create.sh`, `about.html`, `css/styles.css`, `CLAUDE.md`), deleted files (`assets/bio-photo/CAMILA_STUDIO-6.jpg`, `assets/bio-photo/`)
- [ ] 10.2 Confirm `photos-staging/camila.jpg` is NOT in the diff (gitignored)
- [ ] 10.3 Commit and prepare PR
