## 1. Homepage copy (`index.html`)

- [x] 1.1 Update meta description, og:description, twitter:description (lines 7, 15, 22) — "babies 3–12 months" → "little ones 3–12 months"
- [x] 1.2 Update JSON-LD LocalBusiness description (line 30) — "babies aged 3–12 months" → "little ones aged 3–12 months"
- [x] 1.3 Update JSON-LD Service name (line 84) — "Sensory play class for babies 3–12 months" → "Sensory play class for little ones 3–12 months"
- [x] 1.4 Update JSON-LD Event descriptions, both morning and afternoon (lines 109, 144) — "babies 3–12 months" → "little ones 3–12 months"
- [x] 1.5 Update hero lede (line 215) — "Evidence-based sensory play for babies 3–12 months and their mums" → "…for little ones 3–12 months and their mums"
- [x] 1.6 Update welcome paragraph (line 231) — "sensory play class for babies 3–12 months and their mums" → "…for little ones…"
- [x] 1.7 Rework "intentional parent-baby moments" (line 232) → "intentional moments between you and your little one"
- [x] 1.8 Rework "Intentional moments for parent and baby to interact" (line 256) → "Intentional moments for you and your little one to interact"
- [x] 1.9 Update "where babies can explore at their own pace" (line 264) → "where little ones can explore at their own pace"
- [x] 1.10 Update "follow each baby's cues" (line 294) → "follow each little one's cues"
- [x] 1.11 Update "Babies thrive when they feel safe" (line 300) → "Little ones thrive when they feel safe"
- [x] 1.12 Update class details label `<dt>For babies aged</dt>` (line 327) → `<dt>For little ones aged</dt>`
- [x] 1.13 Update footer description (line 357) — "babies 3–12 months and their mums" → "little ones 3–12 months and their mums"

## 2. About page copy (`about.html`) — excluding bio (handled in section 6)

- [x] 2.1 Update meta description, og:description, twitter:description (lines 7, 15, 22) — "sensory class for babies in Oran Park" → "…for little ones in Oran Park"
- [x] 2.2 Update H1 (line 58) — "Built around babies. Designed for mums." → "Built around little ones. Designed for mums." (flagged for Camila sign-off)
- [x] 2.3 Update main about description (line 67) — "babies 3–12 months and their mums" → "little ones 3–12 months and their mums"
- [x] 2.4 Rework "intentional parent-baby moments" and "whether their baby giggles" (line 68) — "intentional moments between you and your little one" + "whether their little one giggles, feeds, fusses, or quietly watches the room"
- [x] 2.5 Update footer description (line 116) — match other pages

## 3. Classes page copy (`classes.html`)

- [x] 3.1 Update meta description, og:description, twitter:description (lines 7, 15, 22) — "sensory class for babies" → "sensory class for little ones"
- [x] 3.2 Update JSON-LD Event descriptions, both morning and afternoon (lines 32, 67) — "babies 3–12 months" → "little ones 3–12 months"
- [x] 3.3 Update class flow description (line 147) — "babies (and mums) know what to expect" → "little ones (and mums) know what to expect"
- [x] 3.4 Update "Time for babies to follow their curiosity" (line 153) → "Time for little ones to follow their curiosity"
- [x] 3.5 Update H2 (line 160) — "Babies 3–12 months and their mums." → "Little ones 3–12 months and their mums."
- [x] 3.6 Update "If your baby cries…" and "your baby's mood and stage" (line 161) — swap to "little one" / "little one's"
- [x] 3.7 Update "Pick the time that fits your baby's day" (line 172) — "your little one's day"
- [x] 3.8 Update H2 (line 202) — "Just yourself and your baby." → "Just yourself and your little one."
- [x] 3.9 Update "whatever your baby usually needs" (line 208) → "whatever your little one usually needs"
- [x] 3.10 Update "gentle on babies' senses" (line 216) → "gentle on little ones' senses"
- [x] 3.11 Update footer description (line 237) — match other pages

## 4. Contact page (`contact.html`)

- [x] 4.1 Update footer description (line 109) — "babies 3–12 months and their mums" → "little ones 3–12 months and their mums"

## 5. Project docs

- [x] 5.1 Update `README.md` lines 3 and 7 — "babies aged 3–12 months" → "little ones aged 3–12 months"
- [x] 5.2 Update `CLAUDE.md` line 7 — "babies aged 3–12 months" → "little ones aged 3–12 months"

## 6. Founder-bio spec + matching about.html bio (lockstep, same commit)

- [x] 6.1 Update `openspec/specs/founder-bio/spec.md` requirement line 25 — "what she hopes mums and babies take home" → "what she hopes mums and little ones take home"
- [x] 6.2 Update spec line 47 canonical paragraph 3 — "how their babies grow and develop" → "how their little ones grow and develop"; KEEP "a four-year-old and a baby"
- [x] 6.3 Update spec line 49 canonical paragraph 4 — "helping a baby grow" → "helping a little one grow"
- [x] 6.4 Add a note to the canonical-text requirement explaining why "a baby" is preserved in paragraph 3 (per delta spec in this change)
- [x] 6.5 Update `about.html` line 95 to match new spec paragraph 3 wording
- [x] 6.6 Update `about.html` line 96 to match new spec paragraph 4 wording

## 7. Print assets — regenerate after editing source

- [x] 7.1 Edit `assets/banner/banner.svg` line 116 — "babies aged 3–12 months" → "little ones aged 3–12 months"
- [x] 7.2 Run `python3 scripts/export-banner.py` to regenerate `assets/banner/banner.png`
- [x] 7.3 Edit `scripts/export-flyer.py` line 200 template string — "babies 3–12 months and their mums" → "little ones 3–12 months and their mums"
- [x] 7.4 Run `python3 scripts/export-flyer.py` to regenerate `assets/flyer/flyer.svg` and `assets/flyer/flyer.png`
- [x] 7.5 Visually inspect both regenerated PNGs for the updated text and no incidental regressions

## 8. Verification

- [x] 8.1 `grep -rni "bab" --include='*.html' --include='*.svg' --include='*.py' --include='*.md' --include='*.css' --include='*.js' .` — confirm the only remaining hits are: "a four-year-old and a baby" in about.html + spec.md (kept intentionally), photo-pipeline spec example filenames, archived OpenSpec changes
- [x] 8.2 Start local server (`python3 -m http.server 8080`) and walk all four pages — confirm headers, footers, body copy, and view-source meta/schema read consistently
- [x] 8.3 Run `openspec validate` if available, or `openspec status` to confirm spec integrity
- [x] 8.4 Flag Camila for sign-off on (a) bio paragraph changes, (b) "Built around babies" → "Built around little ones" headline change
