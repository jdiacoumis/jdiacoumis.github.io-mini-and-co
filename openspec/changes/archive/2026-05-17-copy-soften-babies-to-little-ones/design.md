## Context

The Mini & Co. site (static HTML + SVG + Python export scripts) currently uses "babies" as the default noun for the class cohort. The cohort itself isn't changing — only the noun used to describe them. The change touches every page, the JSON-LD schema graph, two print assets, the founder-bio spec, and project documentation.

Two complicating factors push this above "trivial find-and-replace":

1. **Founder-bio spec lock.** `openspec/specs/founder-bio/spec.md` pins the bio prose word-for-word and requires spec and `about.html` to change in the same commit. Two of the three "baby/babies" occurrences in the bio are touched; one (the autobiographical "a four-year-old and a baby") is deliberately preserved.
2. **Generated print assets.** `assets/flyer/flyer.svg` is regenerated from `scripts/export-flyer.py`, and `assets/banner/banner.png` is regenerated from `assets/banner/banner.svg` via `scripts/export-banner.py`. Editing the rendered SVG directly would be undone on the next export.

## Goals / Non-Goals

**Goals:**
- Replace "babies" / "baby" with "little ones" / "little one" everywhere on the site where the swap reads naturally.
- Keep the SEO surface (meta tags + JSON-LD schema) consistent with visible body copy.
- Update the founder-bio spec and `about.html` bio paragraphs in lockstep.
- Regenerate print assets so flyer and banner ship the new copy.

**Non-Goals:**
- Mass rewrite of site tone beyond the "babies → little ones" swap.
- Restructuring the founder-bio narrative beats (only the specific noun is changing).
- Changing the age descriptor "3–12 months" or adding new SEO keywords.
- Editing archived OpenSpec changes or the photo-pipeline scenario filenames.

## Decisions

### Decision 1: "Little ones" by default, reword where awkward
- **Chosen**: Use "little ones" as the default noun; for phrasings where the swap is clumsy ("parent-baby moments", "parent and baby to interact"), rework the sentence rather than mechanically substitute.
- **Alternative considered**: Pure find-and-replace. Rejected — would produce "parent-little-one moments" which scans badly and reads as a forced compound noun.
- **Alternative considered**: Mix "little ones" (plural cohort) with "your child" (singular possessive). Rejected — "your little one" already reads naturally for the singular case and keeps the noun consistent.

### Decision 2: SEO copy moves too
- **Chosen**: Change meta descriptions, og/twitter cards, and JSON-LD schema to "little ones".
- **Rationale**: The visible copy is the primary discovery surface (CTR on search snippets). The "3–12 months" descriptor carries the search intent; "babies" as a noun isn't load-bearing for the long-tail queries this small business actually competes for ("sensory classes Oran Park", "baby classes near me" — the latter still ranks on the body content).
- **Alternative considered**: Keep "babies" in SEO surfaces only. Rejected — creates a voice-discontinuity between snippet and landing page and complicates future copy edits.

### Decision 3: Keep "a four-year-old and a baby" in Camila's bio
- **Chosen**: Preserve the autobiographical phrase verbatim.
- **Rationale**: "A baby" here does age-contrast work against "a four-year-old". Swapping to "a little one" loses the contrast (a four-year-old is also a little one) and reads as a non-sequitur.
- **Mitigation**: Flag for Camila's review during apply so she can override if she prefers a different phrasing in her own voice.

### Decision 4: One OpenSpec change, not two
- **Chosen**: Drive the whole rewrite (site copy + spec update + docs) through a single OpenSpec change.
- **Rationale**: The founder-bio spec requires lockstep updates with `about.html`; splitting site copy and bio into two changes would create an intermediate state where the spec or rendered HTML is wrong.

### Decision 5: Asset regeneration via existing scripts
- **Chosen**: Edit `scripts/export-flyer.py` (template string) and `assets/banner/banner.svg` (source), then run the existing export scripts.
- **Rationale**: This is the documented pipeline in `CLAUDE.md`. Hand-editing the generated `flyer.svg` would be reverted on the next export.

## Risks / Trade-offs

- **[Risk]** "Little ones" reads softer than "babies" — some readers may find it less specific about the class age range. **Mitigation**: The "3–12 months" descriptor stays everywhere "babies" was previously paired with it, so age specificity is preserved at the phrase level.
- **[Risk]** SEO impact from changing "babies" to "little ones" in meta/schema is hard to predict on a brand-new site with low traffic. **Mitigation**: Body copy still contains "3–12 months" and indirectly references baby development concepts; Google ranks pages on full content, not just meta. The "little ones" phrase is also a recognised search term in the parenting niche.
- **[Risk]** Re-running `export-flyer.py` and `export-banner.py` produces image diffs that may include incidental pixel changes (font kerning, anti-aliasing). **Mitigation**: Visually eyeball both outputs after regeneration; commit only if the text change is the only meaningful diff.
- **[Trade-off]** Camila's bio retains a single "a baby" while the rest of the site says "little ones". Internally inconsistent but defensible because the bio is autobiographical narrative, not marketing copy. Documented in the spec delta and flagged for Camila's review.

## Migration Plan

1. Land the OpenSpec change (proposal + design + spec delta + tasks) — already in flight.
2. Apply edits in the order in `tasks.md`: HTML files, then print sources, then regenerate print assets, then docs, then verification.
3. Spec delta and matching `about.html` lines must land in the same commit (per founder-bio spec line 71).
4. No rollback complexity — this is a copy change. If Camila objects after seeing it deployed, revert with a single revert commit.

## Open Questions

- Does Camila want the about.html headline "Built around babies. Designed for mums." to become "Built around little ones. Designed for mums."? The plan defaults to yes for consistency, but flag for her sign-off before merge — the headline is a brand voice decision, not just a copy edit.
