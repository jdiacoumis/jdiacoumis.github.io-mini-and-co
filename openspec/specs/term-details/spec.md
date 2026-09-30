# term-details Specification

## Purpose
TBD - created by archiving change term-4-pricing-waitlist. Update Purpose after archive.
## Requirements
### Requirement: The site SHALL show the current class price consistently

The visible "Price" tile (formerly "Investment") on `index.html` and `classes.html` SHALL show the current term price and casual price in the form `$<term>` with the sub-line "per <n>-week term · casual $<casual>". The JSON-LD on `index.html` (`priceRange` and each `OfferCatalog` offer) and the `offers.price` of every JSON-LD `Event` SHALL use the same figures. No page MAY display a superseded price.

#### Scenario: Visitor compares prices across pages
- **WHEN** a visitor reads the Price tile on `index.html` and on `classes.html`
- **THEN** both show the same term price and casual price

#### Scenario: Search engine reads structured data
- **WHEN** a crawler parses the JSON-LD on `index.html` and `classes.html`
- **THEN** every price in `priceRange`, the offer catalogue and each `Event` offer matches the visible Price tile

#### Scenario: Term 4 2026 values
- **WHEN** the change `term-4-pricing-waitlist` is applied
- **THEN** the term price is $168 for a 6-week term and the casual price is $30

### Requirement: The site SHALL describe the current and next term, not past ones

The schedule detail grids on `index.html` and `classes.html` SHALL name the current term with its first and last class dates and its availability, and SHALL name the next term (with dates if known, otherwise "details coming soon"). No visible copy, meta description or JSON-LD `Event` MAY advertise a class date that has already passed.

#### Scenario: Visitor checks when classes run
- **WHEN** a visitor reads the schedule grid on either page
- **THEN** they see the current term's date range and whether it is full
- **AND** they see what is known about the next term

#### Scenario: Launch-era dates are gone
- **WHEN** a reviewer greps the four HTML files for `24 June`, `22 July`, `Launch class` and `launch class`
- **THEN** there are no matches

### Requirement: Structured-data events SHALL reflect term dates, local offset and availability

Each weekly session time SHALL have one JSON-LD `Event` per term on every page that carries events, with `startDate` at the first class start, `endDate` at the last class end, an `eventSchedule` describing the weekly Wednesday 45-minute repeat, and `offers.availability` set to `https://schema.org/SoldOut` when the term is full or `https://schema.org/InStock` otherwise. Times SHALL use the Sydney offset in force on each date (`+10:00` AEST, `+11:00` AEDT from the first Sunday in October to the first Sunday in April).

#### Scenario: Term 4 2026 events
- **WHEN** a crawler parses the `Event`s on `index.html` or `classes.html`
- **THEN** there are exactly two: 11:00–11:45 and 13:00–13:45, starting `2026-10-14` and ending `2026-11-18`, all with `+11:00`
- **AND** both offers are `SoldOut` at 168 AUD
