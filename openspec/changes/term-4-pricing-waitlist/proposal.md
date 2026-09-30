## Why

The site still advertises the June launch: "$25 per class", "Launch class · Wed 24 June 2026", "Term 3 enrolments from 22 July" and "Bookings are now open" on every page. Pricing has since moved to a term model (Term 4: $168 for six weeks, casual $30 per class subject to space), and Term 4 (six Wednesdays, 14 October – 18 November 2026) is fully booked. Visitors arriving now see a price that no longer exists and a promise of open bookings that ClassForKids can't honour — they can only join the waitlist.

## What Changes

- Replace the "$25 per class" investment tiles on `index.html` and `classes.html` with "$168 per 6-week term · casual $30", and relabel the tile from "Investment" to "Price".
- Replace the stale "Launch class" / "Term 3" schedule tiles with Term 4 (14 Oct – 18 Nov 2026, fully booked, waitlist open) and "Term 1 2027 · details coming soon".
- Rewrite every "Bookings are now open" / "open to book" / "Save your spot at the launch class" line to say Term 4 is full and families can join the waitlist. The "Book now" button text and link are unchanged — ClassForKids runs the waitlist from the same landing page.
- Drop "Launching Wednesday 24 June 2026" from the home page meta description.
- JSON-LD: change `priceRange` and the offer catalogue to the term and casual prices; replace the two past 24 June launch `Event`s with two Term 4 `Event`s (11 am and 1 pm) marked `SoldOut`, using the AEDT offset (+11:00) that applies from 4 October.
- Bump `sitemap.xml` `lastmod` for the four pages.
- Amend the `booking-cta` spec so copy may state that a term is full and point to the waitlist, instead of requiring "bookings are open".
- Add a `term-details` spec so price and term status stay consistent between visible copy and JSON-LD at each future term rollover.

No breaking changes.

## Capabilities

### New Capabilities

- `term-details`: The price, current-term dates and availability shown on the site, and their consistency across visible copy and structured data.

### Modified Capabilities

- `booking-cta`: "Page copy MUST NOT contradict the live booking flow" is reworded so full-term / waitlist copy is compliant; the "Book now" wording, link and new-tab rules are unchanged.

## Impact

- **Affected pages**: `index.html`, `classes.html`, `about.html`, `contact.html` (visible copy, one meta description, JSON-LD).
- **Affected files**: `sitemap.xml` (`lastmod` only).
- **Affected specs**: `openspec/specs/booking-cta/spec.md` (one requirement), new `openspec/specs/term-details/spec.md`.
- **Out of scope**: the printable flyer (`assets/flyer/`, still says "Term 3 begins · Wednesday 22 July" — deferred until Term 1 2027 dates are set); the pull-up banner (no dates or prices); "evidence-based" wording, socks and class-size copy (flagged separately, not part of this change).
- No CSS, JS, asset or dependency changes.
