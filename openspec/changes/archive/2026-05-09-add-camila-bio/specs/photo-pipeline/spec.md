## ADDED Requirements

### Requirement: Raw photographic originals SHALL live in a gitignored staging directory at the repo root

The repo SHALL contain a top-level directory `photos-staging/` that holds raw photographic originals locally. The directory's contents SHALL be excluded from version control by `.gitignore` rules, with the sole exception of a tracked `photos-staging/README.md` that documents the convention.

#### Scenario: Developer drops an original into staging

- **WHEN** a developer copies a raw photograph (e.g. `camila.jpg` at 5MB) into `photos-staging/`
- **THEN** `git status` shows the file as ignored (it does not appear in the untracked list)
- **AND** the file is still readable by `scripts/optimise-photos.py` from its location in `photos-staging/`

#### Scenario: Fresh clone preserves the convention

- **WHEN** a contributor clones the repo for the first time
- **THEN** `photos-staging/README.md` is present and tracked in git
- **AND** the README explains the staging convention, that originals stay local, and how to run the optimiser

#### Scenario: New file in staging is not silently published

- **WHEN** a developer adds a file to `photos-staging/` and runs `git add .`
- **THEN** the file is not staged for commit
- **AND** only the optimised outputs (in `assets/photos/`) plus changes to tracked files appear in `git status`

### Requirement: Optimised photographic outputs SHALL be tracked in `assets/photos/` with a width-suffixed filename convention

The repo SHALL contain a tracked directory `assets/photos/` that holds only the optimised outputs of the photo pipeline. Filenames SHALL follow the pattern `<slug>-<width>.<extension>` where `<slug>` is the source filename's stem (no extension), `<width>` is one of `600`, `1200`, `1600`, and `<extension>` is one of `jpg` or `webp`.

#### Scenario: Optimiser produces six outputs per source

- **WHEN** the developer places `photos-staging/camila.jpg` and runs `python3 scripts/optimise-photos.py`
- **THEN** `assets/photos/` contains exactly six new files: `camila-600.jpg`, `camila-600.webp`, `camila-1200.jpg`, `camila-1200.webp`, `camila-1600.jpg`, `camila-1600.webp`
- **AND** every output is a valid image file at its declared width

#### Scenario: Slug is derived from source filename stem

- **WHEN** the developer places `photos-staging/sarah-with-baby.jpg` and runs the optimiser
- **THEN** the outputs are named `sarah-with-baby-{600,1200,1600}.{jpg,webp}`
- **AND** the slug `sarah-with-baby` matches the source's filename stem with no transformation beyond extension removal

#### Scenario: Output filenames must not use `w` suffix or `@2x` style

- **WHEN** a reviewer inspects filenames in `assets/photos/`
- **THEN** no filename matches `*-<n>w.{jpg,webp}` (the `w` letter belongs in `srcset` descriptors, not filenames)
- **AND** no filename matches `*@<n>x.{jpg,webp}` (we do not use the `@2x` retina-suffix convention)

### Requirement: The optimiser SHALL produce both JPG and WebP at three widths per source

For each source image, the optimiser SHALL produce six outputs: JPG and WebP at widths 600, 1200, and 1600 pixels (long edge). The JPG variant SHALL be encoded at quality 82. The WebP variant SHALL be encoded at quality 80. Both quality settings SHALL be overridable via CLI flags.

#### Scenario: Default quality settings produce expected file sizes

- **WHEN** the optimiser runs against a typical portrait JPG (~3000×4500 source)
- **THEN** each output JPG at 1600w is under ~250KB
- **AND** each output WebP at 1600w is roughly 40% smaller than the equivalent JPG

#### Scenario: Quality is overridable

- **WHEN** the developer runs `python3 scripts/optimise-photos.py --jpg-quality 90 --webp-quality 88`
- **THEN** the outputs are encoded at the supplied qualities, not the defaults

### Requirement: The optimiser SHALL be idempotent and skip up-to-date outputs

The optimiser SHALL skip processing a source file if every one of its six expected outputs already exists in `assets/photos/` AND every output's modification time is newer than the source's modification time. A `--force` flag SHALL bypass this check and reprocess everything.

#### Scenario: Re-running the optimiser is cheap when nothing has changed

- **WHEN** the developer runs the optimiser twice in succession with no changes
- **THEN** the second run reports "skipped" (or equivalent) for every source
- **AND** no output file has its mtime updated by the second run

#### Scenario: Editing the source triggers re-export on next run

- **WHEN** the developer modifies `photos-staging/camila.jpg` (e.g. crops it, replaces it)
- **AND** runs the optimiser
- **THEN** all six outputs for `camila` are regenerated

#### Scenario: `--force` reprocesses regardless of mtimes

- **WHEN** the developer runs `python3 scripts/optimise-photos.py --force`
- **THEN** every source in `photos-staging/` is reprocessed
- **AND** every output's mtime is updated, even if the inputs were unchanged

### Requirement: The optimiser SHALL process only top-level files in `photos-staging/`, not subdirectories

The optimiser SHALL glob `photos-staging/*.{jpg,jpeg,png}` (case-insensitive) at the top level only. Files inside subdirectories of `photos-staging/` SHALL be ignored. This allows subdirectories to act as a "not yet ready" holding area for shots that should not be published.

#### Scenario: Files in a subdirectory are not processed

- **WHEN** the developer places a file at `photos-staging/2026-04-marketing/studio-1.jpg`
- **AND** runs the optimiser
- **THEN** no output is produced for `studio-1`
- **AND** the optimiser does not error or warn about the file's existence

#### Scenario: Promoting a subdirectory file is a deliberate move

- **WHEN** the developer wants `2026-04-marketing/studio-1.jpg` to be published
- **THEN** they move it to `photos-staging/studio-1.jpg` (top level) before re-running the optimiser
- **AND** the output appears at `assets/photos/studio-1-{600,1200,1600}.{jpg,webp}`

### Requirement: The optimiser SHALL match the existing scripts/ pattern and have a single new external dependency

The optimiser SHALL be implemented as a single Python file at `scripts/optimise-photos.py`, structured similarly to the existing `scripts/export-banner.py` and `scripts/export-logo.py`: argparse-based CLI, hardcoded source/destination paths derivable from `__file__`, and at most one new external Python dependency (Pillow). It SHALL print a one-line summary per output file written, listing path and approximate size.

#### Scenario: Script is invokable with zero arguments for the common case

- **WHEN** the developer runs `python3 scripts/optimise-photos.py` from the repo root with no flags
- **THEN** all sources in `photos-staging/` are processed using default widths and qualities
- **AND** the script exits successfully with a printed summary

#### Scenario: Pillow is the only new dependency

- **WHEN** a reviewer audits the script's imports
- **THEN** the only third-party imports are `PIL` (Pillow) and standard library modules
- **AND** no new dependency on Node, sharp, imagemin, or any system-level binary tool is introduced

#### Scenario: Pillow is provisioned by the devcontainer

- **WHEN** a contributor builds the devcontainer from a fresh state
- **THEN** Pillow is installed as part of `.devcontainer/post-create.sh`
- **AND** the optimiser runs without needing a manual `pip install`

### Requirement: The pipeline SHALL not introduce a build step for the published site

The optimiser is a developer-only tool. The published static site (HTML/CSS/JS in the repo root and `assets/`) SHALL remain serveable by `python3 -m http.server 8080` with no build, compile, bundling, or transformation step. The optimiser is only invoked manually before commit.

#### Scenario: Site serves on a fresh clone without running the optimiser

- **WHEN** a contributor clones the repo and serves it with `python3 -m http.server 8080`
- **THEN** the about page renders correctly
- **AND** the optimised photo files in `assets/photos/` are served directly because they are tracked in git

#### Scenario: No CI step runs the optimiser

- **WHEN** a reviewer inspects the repo's CI configuration (if any) and the deploy pipeline
- **THEN** no automated step runs `optimise-photos.py`
- **AND** the script exists purely as a manual developer tool, like the other scripts in `scripts/`
