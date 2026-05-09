## Why

The Class4Kids tenant at `mini-co-sensory.classforkids.io` is now live with the Term 3 Wednesday 11:00–11:45 class published, but every page of the site still tells customers bookings aren't open and routes them through a `mailto:` "Register your interest" CTA. That copy is now stale, and a real booking flow exists — sending parents to email when they could be booking on the spot is a worse experience than the product we already have running.

## What Changes

- Replace the five "Register your interest" `mailto:` CTAs across `index.html`, `about.html`, `classes.html`, and `contact.html` with "Book now" links to `https://mini-co-sensory.classforkids.io`, opening in a new tab with `rel="noopener"`.
- Update the surrounding body copy on `classes.html`, `contact.html`, and `about.html` (lede paragraphs, eyebrow text, the "what to include" instructions block, and the contact-page meta description) so it no longer claims bookings aren't live or instructs customers on how to compose an enquiry email.
- Drop the email fallback section on `contact.html` entirely — Camila's email remains in the duplicated footer across all pages, so this is a demotion, not a removal.
- **No** new "Book now" button in the header nav, **no** Class4Kids iframe/embed, **no** outbound click tracking, **no** CSS or JS changes — the existing `.button` class is reused as-is and the static no-build-step architecture is preserved.

## Capabilities

### New Capabilities
- `booking-cta`: Defines how the marketing site advertises and links out to the live booking provider — CTA wording, link target, link attributes, and where these CTAs may appear. This becomes the baseline contract that future booking-related changes (provider switch, header CTA, deep linking) delta from.

### Modified Capabilities
<!-- None — no existing specs in openspec/specs/ to modify. -->

## Impact

- **HTML pages**: `index.html`, `about.html`, `classes.html`, `contact.html` — five CTA elements plus several lede/eyebrow/meta-description copy blocks. No structural changes.
- **CSS / JS / assets**: untouched.
- **External dependency**: introduces a soft dependency on the Class4Kids tenant URL `https://mini-co-sensory.classforkids.io` remaining the canonical booking entry point.
- **CLAUDE.md guidance**: respected — no framework, no build step, no new files outside `openspec/`, all copy in Australian English.
- **Customer-facing risk**: low. The Class4Kids landing page is publicly visible and rendering the Term 3 class. Worst case if C4K has an outage, the CTA dead-ends — same blast radius as the current `mailto:` link returning a bounce.
