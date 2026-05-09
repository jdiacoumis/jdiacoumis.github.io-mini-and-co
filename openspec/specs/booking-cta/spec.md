# booking-cta Specification

## Purpose
TBD - created by archiving change class4kids-booking-cta. Update Purpose after archive.
## Requirements
### Requirement: Primary booking CTAs SHALL use consistent wording

Every primary call-to-action on the marketing site that exists to drive a customer toward booking a class SHALL display the text "Book now". No other wording (e.g. "Register your interest", "Book a class", "Enrol now") MAY be used for the primary booking CTA.

#### Scenario: Customer scans any page for the booking entry point
- **WHEN** a customer loads `index.html`, `about.html`, `classes.html`, or `contact.html`
- **THEN** every primary booking CTA on that page reads exactly "Book now"
- **AND** no primary CTA reads "Register your interest" or any other variant

#### Scenario: Future page is added with a booking CTA
- **WHEN** a new page is added that includes a primary booking CTA
- **THEN** that CTA SHALL read "Book now" to remain consistent with the existing pages

### Requirement: Primary booking CTAs SHALL link to the Class4Kids tenant landing page

The `href` of every primary booking CTA SHALL be exactly `https://mini-co-sensory.classforkids.io`. CTAs MUST NOT link to per-class deep links, to a Class4Kids subpath, or to any other booking provider.

#### Scenario: Customer activates a booking CTA
- **WHEN** the customer clicks or activates any "Book now" CTA on the site
- **THEN** the destination URL is `https://mini-co-sensory.classforkids.io`

#### Scenario: A new class is published in Class4Kids
- **WHEN** the owner publishes additional classes on the Class4Kids tenant
- **THEN** no edit to the marketing site is required, because every CTA points at the tenant landing page rather than a specific class

### Requirement: Primary booking CTAs SHALL open in a new tab securely

Every primary booking CTA SHALL set `target="_blank"` and SHALL include `rel="noopener"`. The `rel` attribute MAY additionally include `noreferrer`, but this is not required — Class4Kids legitimately benefits from referrer information.

#### Scenario: Customer activates a booking CTA
- **WHEN** the customer clicks any "Book now" CTA
- **THEN** the Class4Kids page opens in a new browser tab
- **AND** the original Mini & Co tab remains open so the customer can return without using the back button

#### Scenario: Security review checks outbound link hygiene
- **WHEN** a reviewer inspects any primary booking CTA in the HTML source
- **THEN** the anchor element includes `target="_blank"` and `rel="noopener"` (or `rel="noopener noreferrer"`)

### Requirement: The site MUST NOT use a `mailto:` scheme for the primary booking path

No primary booking CTA on the marketing site MAY use a `mailto:` URL. Email remains available via the footer (and any explicit non-booking contact links) but MUST NOT be presented as the way to book a class.

#### Scenario: Customer wants to book a class
- **WHEN** the customer follows any primary CTA whose purpose is to book a class
- **THEN** they reach the Class4Kids booking flow, not a pre-filled email draft

#### Scenario: Customer wants to send a non-booking enquiry
- **WHEN** the customer wants to ask a question, give feedback, or contact the owner for a non-booking reason
- **THEN** the footer email link (or another explicitly non-booking contact path) remains available across all pages

### Requirement: Page copy MUST NOT contradict the live booking flow

No body copy, lede paragraph, eyebrow text, or `<meta name="description">` content on any page MAY claim that bookings are not yet open, that customers must "register interest", or that customers should email the owner to book a class. Copy MUST be consistent with the fact that bookings are live via Class4Kids.

#### Scenario: Reader skims the site for booking status
- **WHEN** the customer reads any heading, lede, eyebrow, paragraph, or page meta description across the four HTML pages
- **THEN** the copy is consistent with bookings being open via Class4Kids
- **AND** no copy claims bookings are "opening soon", "not live yet", or that the customer should email to register

#### Scenario: Search engine indexes the contact page
- **WHEN** a search engine reads `<meta name="description">` on `contact.html`
- **THEN** the description does not promise an "interest registration" flow that no longer exists

### Requirement: This change MUST NOT alter the static no-build-step architecture

Implementing booking CTAs MUST NOT introduce a JavaScript framework, CSS preprocessor, build step, package manifest, or new runtime dependency. The change MUST work entirely through edits to the existing HTML files using the existing `.button` class.

#### Scenario: Developer pulls the repo after this change lands
- **WHEN** the developer clones the repo and serves it with `python3 -m http.server 8080`
- **THEN** every page renders and every "Book now" CTA functions without any build, install, or compile step

#### Scenario: Reviewer audits the diff
- **WHEN** a reviewer inspects the change
- **THEN** the diff touches only the four HTML files and the OpenSpec artifacts — no new files in `css/`, `js/`, `assets/`, `scripts/`, or any new config files at the repo root

