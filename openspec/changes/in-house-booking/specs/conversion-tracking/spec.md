# Conversion Tracking

## ADDED Requirements

### Requirement: First-party pixel bootstrap on booking pages

Every booking page SHALL initialise Meta Pixel `1991468878409217` and fire a `PageView` event on load. The pixel SHALL be bootstrapped from a script served from the site's own origin; booking pages MUST NOT rely on inline scripts for pixel initialisation, and the pixel MUST load and fire without violating the site's Content Security Policy.

#### Scenario: Pixel initialises and PageView fires on a booking page

- **WHEN** a visitor loads any booking page
- **THEN** Meta Pixel `1991468878409217` is initialised from a script delivered by the site's own origin
- **AND** a `PageView` event is fired for that page

#### Scenario: Pixel loads cleanly under the enforced Content Security Policy

- **WHEN** a booking page is loaded with the Content Security Policy enforced
- **THEN** no inline pixel script is present on the page
- **AND** the pixel initialises and fires events without any Content Security Policy violation being reported

### Requirement: ViewContent event on the class list

The class list page SHALL fire a `ViewContent` event after the pixel has initialised, so that browsing the available classes is recognised as the top of the conversion funnel.

#### Scenario: Visitor views the class list

- **WHEN** a visitor loads the page listing available classes and sessions
- **THEN** a `ViewContent` event is fired to Meta Pixel `1991468878409217`

### Requirement: InitiateCheckout event when checkout starts

The booking flow SHALL fire an `InitiateCheckout` event at the point a parent starts checkout for a booking. The event MUST fire before the parent is handed to the payment provider and MUST NOT fire merely from browsing classes or session details.

#### Scenario: Parent starts checkout

- **WHEN** a signed-in parent proceeds from session selection into checkout
- **THEN** an `InitiateCheckout` event is fired before redirection to the payment page

#### Scenario: Browsing alone does not trigger InitiateCheckout

- **WHEN** a visitor views the class list or a session's details without starting checkout
- **THEN** no `InitiateCheckout` event is fired

### Requirement: Purchase event only on a paid booking's confirmation page

A `Purchase` event SHALL be fired only on the confirmation page of a booking whose payment has been confirmed. The event MUST include the booking's paid value, `currency` set to `AUD`, and an event ID equal to the booking's identifier. A confirmation page for a booking that is not yet paid MUST NOT fire `Purchase`.

#### Scenario: Confirmation page of a paid booking fires Purchase

- **WHEN** a parent lands on the confirmation page of a booking whose payment has been confirmed
- **THEN** a single `Purchase` event is fired with the amount the parent paid as its value
- **AND** the event's currency is `AUD`
- **AND** the event ID equals the booking's identifier

#### Scenario: Unpaid booking does not fire Purchase

- **WHEN** a parent views the confirmation page while the booking is still pending payment confirmation
- **THEN** no `Purchase` event is fired
- **AND** a `Purchase` event is fired only once the page reflects the booking as paid

### Requirement: Purchase counted exactly once per booking

Each booking SHALL produce exactly one counted `Purchase` conversion. Any repeat emission of the event for the same booking — for example a page refresh or a revisit to the confirmation page — MUST carry the identical event ID (the booking's identifier) so that Meta deduplicates it to a single conversion.

#### Scenario: Refreshing the confirmation page does not double-count

- **WHEN** a parent refreshes or revisits the confirmation page of a paid booking
- **THEN** any re-emitted `Purchase` event carries the same event ID as the original
- **AND** the booking is counted as exactly one conversion

### Requirement: Server-side Conversions API Purchase with deduplicating event ID

When a Conversions API access token is configured, the system SHALL send a server-side `Purchase` event to the Meta Conversions API at the moment the payment webhook confirms a booking as paid. The server-side event MUST carry an `event_id` identical to the booking identifier used by the browser-side `Purchase` event, and the same value and `AUD` currency, so Meta deduplicates the browser and server copies. When no Conversions API token is configured, the system MUST NOT attempt any Conversions API request and webhook processing MUST complete normally.

#### Scenario: Webhook confirmation sends a deduplicated server-side Purchase

- **WHEN** a Conversions API token is configured and the payment webhook confirms a booking as paid
- **THEN** a server-side `Purchase` event is sent to the Meta Conversions API
- **AND** its `event_id` equals the booking's identifier
- **AND** its value and `AUD` currency match the browser-side `Purchase` event

#### Scenario: No Conversions API token configured

- **WHEN** the payment webhook confirms a booking as paid and no Conversions API token is configured
- **THEN** no request is made to the Meta Conversions API
- **AND** the booking is still confirmed and webhook processing succeeds

### Requirement: User identifiers hashed before Conversions API transmission

User identifiers attached to a Conversions API event SHALL be normalised according to Meta's normalisation rules (for example, email addresses lowercased and trimmed; phone numbers reduced to digits with country code) and then hashed with SHA-256 before transmission. Plaintext email addresses or phone numbers MUST NOT appear anywhere in the Conversions API request payload.

#### Scenario: Identifiers are normalised and hashed

- **WHEN** a server-side `Purchase` event is prepared with the purchasing parent's email address and phone number
- **THEN** each identifier is normalised per Meta's rules and replaced with its SHA-256 hash before the request is sent
- **AND** the request payload contains no plaintext email address or phone number

### Requirement: Conversions API failures do not affect booking confirmation

A failed or rejected Conversions API request MUST NOT cause the payment webhook to fail, the booking to remain unconfirmed, or the confirmation email to be withheld. The failure SHALL be recorded in the system's logs without including raw user identifiers, tokens, or medical information.

#### Scenario: Conversions API outage during webhook processing

- **WHEN** the payment webhook confirms a booking as paid and the Conversions API request fails
- **THEN** the booking is still marked as confirmed and paid
- **AND** the webhook completes successfully and the confirmation email is still sent
- **AND** the failure is logged without any plaintext email address, phone number, token, or medical detail

### Requirement: Lead-on-click event removed from marketing pages

The marketing pages MUST NOT fire a `Lead` event when a visitor clicks a "Book now" call to action. The marketing pages SHALL retain their existing pixel `PageView` tracking, with conversion measurement provided solely by the booking funnel events ending in `Purchase`.

#### Scenario: Clicking Book now fires no Lead event

- **WHEN** a visitor clicks a "Book now" call to action on any marketing page
- **THEN** no `Lead` event is sent to the Meta Pixel
- **AND** the visitor proceeds to the first-party booking experience

#### Scenario: Marketing pages keep PageView tracking

- **WHEN** a visitor loads any marketing page
- **THEN** the Meta Pixel still fires a `PageView` event for that page
