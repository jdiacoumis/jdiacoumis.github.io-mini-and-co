## Why

Google Search Console flagged the site's Events structured data with a non-critical issue: `Missing field "validFrom" (in "offers")`. The Term 4 `Event` offers on `index.html` and `classes.html` give a price, currency, URL and availability but not the date tickets went on sale. Google may reclassify the issue as critical later, and nothing in the `term-details` spec reminds a future term rollover to set it.

## What Changes

- Add `"validFrom": "2026-09-01T00:00:00+10:00"` (the date Term 4 bookings opened on ClassForKids) to the `offers` of all four JSON-LD `Event`s: two on `index.html`, two on `classes.html`.
- Amend the `term-details` structured-data requirement so every `Event` offer carries `validFrom` set to the date that term's bookings opened, so the field is updated at each term rollover.

No breaking changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `term-details`: "Structured-data events SHALL reflect term dates, local offset and availability" now also requires `offers.validFrom`.

## Impact

- **Affected pages**: `index.html`, `classes.html` (JSON-LD only, nothing visible).
- **Affected specs**: `openspec/specs/term-details/spec.md` (one requirement).
- **Out of scope**: the LocalBusiness `OfferCatalog` offers on `index.html` (not Events, not flagged).
- No CSS, JS, asset or dependency changes.
