# booking-cta Delta Specification

## MODIFIED Requirements

### Requirement: Primary booking CTAs SHALL link to the Class4Kids tenant landing page

The `href` of every primary booking CTA SHALL be exactly `/book/`, the first-party booking path served on the same origin as the marketing site. CTAs MUST NOT link to `classforkids.io`, to any other third-party booking provider, or to any external booking domain. CTAs MUST use a root-relative path so the destination resolves on the same origin regardless of which page the customer is on.

#### Scenario: Customer activates a booking CTA
- **WHEN** the customer clicks or activates any "Book now" CTA on the marketing site
- **THEN** the destination URL is `/book/` on the same origin
- **AND** the customer lands on the first-party booking class list

#### Scenario: Reviewer audits CTA destinations for third-party providers
- **WHEN** a reviewer inspects the `href` of every primary booking CTA across the marketing pages
- **THEN** no CTA references `classforkids.io` or any other third-party booking provider
- **AND** every CTA `href` is exactly `/book/`

#### Scenario: A new class is published in the booking system
- **WHEN** the owner publishes additional classes or sessions in the first-party booking system
- **THEN** no edit to the marketing pages is required, because every CTA points at the booking class list rather than a specific class or session

### Requirement: Primary booking CTAs SHALL open in a new tab securely

Because the booking path is now same-origin, every primary booking CTA SHALL open in the same tab as an ordinary same-origin navigation. CTAs MUST NOT set `target="_blank"` and MUST NOT carry a `rel` attribute for opener or referrer isolation — neither is required for same-origin links, and same-tab navigation preserves the back button and first-party conversion attribution.

#### Scenario: Customer activates a booking CTA
- **WHEN** the customer clicks any "Book now" CTA
- **THEN** the booking page loads in the same browser tab
- **AND** the customer can return to the marketing page using the browser back button

#### Scenario: Security review checks link hygiene
- **WHEN** a reviewer inspects any primary booking CTA in the page source
- **THEN** the anchor element has no `target="_blank"` attribute
- **AND** the anchor element has no `rel="noopener"` or `rel="noreferrer"` attribute

### Requirement: Page copy MUST NOT contradict the live booking flow

No body copy, lede paragraph, eyebrow text, or `<meta name="description">` content on any marketing page MAY claim that bookings are not yet open, that customers must "register interest", or that customers should email the owner to book a class. Copy MUST be consistent with the fact that bookings are live through the site's own first-party booking system, and MUST NOT reference Class4Kids or any other former booking provider.

#### Scenario: Reader skims the site for booking status
- **WHEN** the customer reads any heading, lede, eyebrow, paragraph, or page meta description across the marketing pages
- **THEN** the copy is consistent with bookings being open on the site itself
- **AND** no copy claims bookings are "opening soon", "not live yet", or that the customer should email to register

#### Scenario: Reader looks for the former booking provider
- **WHEN** the customer reads any visible copy or metadata on the marketing pages
- **THEN** no copy references Class4Kids, ClassForKids, or any other third-party booking provider as the way to book

#### Scenario: Search engine indexes the contact page
- **WHEN** a search engine reads the contact page's meta description
- **THEN** the description does not promise an "interest registration" flow or a third-party booking flow that no longer exists

### Requirement: This change MUST NOT alter the static no-build-step architecture

The marketing pages themselves MUST remain static, hand-authored HTML with no JavaScript framework, CSS preprocessor, build step, or compile step: a customer-facing marketing page MUST render fully when served by any plain static file server. The booking subsystem reachable under `/book`, `/account`, `/admin`, and `/api` is served by a first-party server-side runtime and is explicitly exempt from this constraint — its existence MUST NOT impose a build step, framework, or runtime dependency on the marketing pages.

#### Scenario: Developer serves the marketing pages with a plain static server
- **WHEN** the developer clones the repository and serves it with any plain static file server, without any install, build, or compile step
- **THEN** every marketing page renders fully with its styles and navigation intact
- **AND** every "Book now" CTA is present with its `/book/` destination (the booking pages behind it are out of scope for static serving)

#### Scenario: Reviewer audits the marketing pages for build tooling
- **WHEN** a reviewer inspects the marketing pages and their stylesheets and scripts
- **THEN** they find no framework, preprocessor output, bundler artefact, or build configuration required to render those pages

#### Scenario: Booking subsystem evolves independently
- **WHEN** the first-party booking subsystem under `/book`, `/account`, `/admin`, or `/api` is changed or redeployed
- **THEN** the marketing pages continue to render unchanged from the same static files with no rebuild required
