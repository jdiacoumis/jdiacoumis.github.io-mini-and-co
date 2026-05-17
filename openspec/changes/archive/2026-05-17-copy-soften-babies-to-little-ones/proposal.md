## Why

Site copy currently uses "babies" as the default noun for the cohort the classes serve (e.g. "sensory classes for babies 3–12 months"). Camila wants the language softened to "little ones" wherever it reads naturally — it lands warmer, matches her in-class voice, and reduces the impression that the classes are clinical/developmental-only. The age descriptor "3–12 months" still carries the precision; "babies" was doing tone work, not information work.

## What Changes

- Replace "babies" / "baby" with "little ones" / "little one" across visible HTML copy, headings, meta tags, JSON-LD schema, and print assets (banner SVG + flyer template).
- Rework two specific phrasings that don't hyphenate cleanly: "parent-baby moments" → "moments between you and your little one"; "parent and baby to interact" → "you and your little one to interact".
- Update the founder-bio capability spec to match the new bio wording: change "their babies" → "their little ones" and "helping a baby grow" → "helping a little one grow" (and the requirement narrative line). Keep "a four-year-old and a baby" in Camila's autobiographical sentence — "a baby" carries age contrast against the four-year-old that "a little one" would lose.
- Regenerate `assets/flyer/flyer.svg`, `assets/flyer/flyer.png`, and `assets/banner/banner.png` from updated sources.
- Update non-shipping copy in `README.md` and `CLAUDE.md` for consistency.

No breaking changes. No capability is being added or removed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `founder-bio`: The canonical bio text and one of the four-paragraph-narrative requirement lines change wording (babies → little ones in two clauses; requirement line at spec line 25). Camila's "a four-year-old and a baby" clause is preserved.

## Impact

- **Affected pages**: `index.html`, `about.html`, `classes.html`, `contact.html` — visible copy, headings, meta tags, JSON-LD schema.
- **Affected print/marketing assets**: `assets/banner/banner.svg` (hand-edit), `assets/banner/banner.png` (regenerate via `scripts/export-banner.py`), `assets/flyer/flyer.svg` + `assets/flyer/flyer.png` (regenerate via `scripts/export-flyer.py` after editing the template string in the script).
- **Affected specs**: `openspec/specs/founder-bio/spec.md` (lines 25, 47, 49).
- **Affected docs**: `README.md`, `CLAUDE.md`.
- **No code logic changes**, no dependency changes, no schema or routing changes.
- **Out of scope / explicitly not changed**: `openspec/specs/photo-pipeline/spec.md` lines 40–41 (hypothetical example filenames, not site copy); archived OpenSpec changes; logo/Instagram assets (no "baby" copy present).
- **Approval needed**: Camila to sign off on (a) the bio paragraph changes that mirror into `founder-bio` spec, and (b) the about.html headline change "Built around babies." → "Built around little ones."
