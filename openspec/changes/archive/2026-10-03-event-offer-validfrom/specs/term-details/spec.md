## MODIFIED Requirements

### Requirement: Structured-data events SHALL reflect term dates, local offset and availability

Each weekly session time SHALL have one JSON-LD `Event` per term on every page that carries events, with `startDate` at the first class start, `endDate` at the last class end, an `eventSchedule` describing the weekly Wednesday 45-minute repeat, `offers.availability` set to `https://schema.org/SoldOut` when the term is full or `https://schema.org/InStock` otherwise, and `offers.validFrom` set to midnight on the date that term's bookings opened on ClassForKids. Times SHALL use the Sydney offset in force on each date (`+10:00` AEST, `+11:00` AEDT from the first Sunday in October to the first Sunday in April).

#### Scenario: Term 4 2026 events
- **WHEN** a crawler parses the `Event`s on `index.html` or `classes.html`
- **THEN** there are exactly two: 11:00–11:45 and 13:00–13:45, starting `2026-10-14` and ending `2026-11-18`, all with `+11:00`
- **AND** both offers are `SoldOut` at 168 AUD

#### Scenario: Offers say when bookings opened
- **WHEN** a crawler parses the `offers` of any `Event` on `index.html` or `classes.html`
- **THEN** it has a `validFrom` date at or before the time the page was published
- **AND** for Term 4 2026 the value is `2026-09-01T00:00:00+10:00`
