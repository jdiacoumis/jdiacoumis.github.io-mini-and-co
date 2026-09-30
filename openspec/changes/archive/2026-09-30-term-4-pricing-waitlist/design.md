## Context

The four pages are hand-authored HTML with duplicated JSON-LD (`index.html` carries the LocalBusiness block plus two launch `Event`s; `classes.html` carries the same two `Event`s). Prices and dates appear in both visible detail grids and structured data, so a term rollover has to touch both. The `booking-cta` spec currently requires all copy to be "consistent with bookings being open", which a sold-out term contradicts.

Source of the new facts: the owner-supplied business brief dated 30 September 2026 (kept local and gitignored under `business/`), confirmed by the owner in conversation: price copy "$168 per 6-week term (casual $30)", Term 4 waitlist via the existing ClassForKids "Book now" link, flyer deferred.

## Goals / Non-Goals

**Goals:**
- Show the current price and Term 4 status accurately everywhere a visitor or search engine reads them.
- Keep "Book now" as the single booking entry point; ClassForKids handles the waitlist.
- Leave the site easy to roll over to Term 1 2027 once dates and pricing are set.

**Non-Goals:**
- Publishing Term 1 2027 dates or prices (not yet known — "details coming soon" only).
- Flyer/banner regeneration, tone or claim changes, layout or CSS changes.

## Decisions

### Decision 1: Keep "Book now" rather than a "Join the waitlist" button
- **Chosen**: Button text, `href`, `target` and `rel` stay exactly as the `booking-cta` spec requires; surrounding copy explains that Term 4 is full and the button leads to the waitlist.
- **Rationale**: ClassForKids serves both enrolment and waitlist from the same landing page, so the button works unchanged once a new term opens — only the lede copy needs rolling back. Changing the button would mean amending three more `booking-cta` requirements for a temporary state.

### Decision 2: Price as one tile — "$168" with "per 6-week term · casual $30"
- **Chosen**: Keep the existing price tile, relabelled from `Investment` to `Price` at the owner's request, and its `dd` + soft-span pattern: `$168` as the headline figure, "per 6-week term · casual $30" as the sub-line.
- **Alternative considered**: Separate tiles for term and casual. Rejected — adds a grid item on `classes.html` (four tiles today) and gives casual attendance more prominence than a full term.

### Decision 3: Replace, don't append, the schedule tiles
- **Chosen**: On both grids, "Launch class" → "Term 4" (14 Oct – 18 Nov 2026, fully booked · waitlist open) and "Term 3 …" → "Term 1 2027" (details coming soon). Tile counts stay at six (`index.html`) and four (`classes.html`), so the grid layout is untouched.

### Decision 4: JSON-LD — price list in the catalogue, sold-out status on the events
- **Chosen**: `priceRange` becomes `"$30–$168"`. The LocalBusiness `OfferCatalog` lists two offers without `availability` — a 6-week term at 168 AUD and a casual class at 30 AUD — because it describes the standing price list, not a specific term. The two launch `Event`s are replaced with "Term 4 (Morning)" and "Term 4 (Afternoon)" events spanning the first class start to the last class end (`2026-10-14T11:00:00+11:00` → `2026-11-18T11:45:00+11:00`, and 13:00/13:45), each with an `eventSchedule` (weekly, Wednesday, `PT45M`) and an offer of 168 AUD with `availability: SoldOut`.
- **Rationale**: Past-dated launch events are stale data Google may still surface. One event per session with a weekly schedule is far lighter than twelve per-class events and describes a term enrolment accurately.
- **Offset**: NSW daylight saving starts Sunday 4 October 2026, so every Term 4 time uses `+11:00` (the old June events correctly used `+10:00`).

### Decision 5: Waitlist wording
- **Chosen**: A short, warm line per CTA band, e.g. "Term 4 is fully booked. Tap Book now to join the waitlist and we'll be in touch if a place opens up." Only the ledes and one `h2` change; the other headings stay.
- **Rationale**: The owner prefers short, readable copy. "We'll be in touch if a place opens" matches how she is already handling trial-place openings, without promising a specific notification mechanism.

## Risks / Trade-offs

- **[Risk]** Copy goes stale again when Term 4 ends or Term 1 opens. **Mitigation**: the new `term-details` spec lists every surface that must move together, making the next rollover a checklist.
- **[Risk]** A spot opens mid-term and the site still says fully booked. **Mitigation**: acceptable — the waitlist is the right funnel either way and the button still reaches ClassForKids.
- **[Trade-off]** Google may show no event rich result for sold-out events. Accepted; accuracy matters more than a result that sends people to a full class.

## Migration Plan

1. Land this change (proposal, design, spec deltas, tasks).
2. Apply HTML edits and the sitemap bump per `tasks.md`; verify locally.
3. Archive the change so `booking-cta` is updated and `term-details` is created under `openspec/specs/`.
