# In-House Booking System

## Why

ClassForKids costs $70/month, delivers a janky booking experience, and won't let us attach our Meta Pixel to the booking pages — conversions can only be inferred from a `Lead` event fired when a customer *clicks* "Book now", not when they actually pay. Bringing bookings in-house removes the subscription cost, gives us the full conversion funnel (through to `Purchase`), and puts customer, consent, and payment data under our own control.

## What Changes

- **BREAKING**: Primary "Book now" CTAs stop linking to `https://mini-co-sensory.classforkids.io` and instead link to `/book/`, a first-party booking app served on the same domain.
- New `booking/` Cloudflare Worker (plain JavaScript, no framework) + D1 (SQLite) application that serves the existing static marketing site as assets and handles booking routes/APIs.
- Parents sign in with email magic links (no passwords), create child profiles (name, date of birth, medical conditions, photo consent), book class sessions, accept the waiver/terms per booking, and pay via Stripe Checkout; payment is confirmed by Stripe webhook.
- Admin portal for Camila/James: create classes and sessions (with weekly repeat), see per-session rosters (parent email/phone, child age, consents, medical notes), payment status, capacity/fullness, manual mark-as-paid, and CSV export.
- CSV customer import migrates the ~20 existing ClassForKids customers (accounts + children + current paid enrolments) and sends magic-link invite emails so they never set a password.
- Meta Pixel funnel on first-party pages: `ViewContent` (class list) → `InitiateCheckout` → `Purchase` on the booking confirmation page, with server-side Conversions API events deduplicated by event ID.
- Transactional email (magic links, booking confirmations, invites) via Resend's REST API, with a console driver for local development.

## Capabilities

### New Capabilities

- `parent-auth`: passwordless magic-link sign-in, session management, account profiles for parents and admins.
- `child-profiles`: child records with date of birth, medical conditions, and photo consent, owned by a parent account.
- `class-scheduling`: classes and dated sessions with capacity, pricing, weekly repeat creation, and fullness reporting.
- `booking-flow`: session selection, waiver/terms acceptance with consent snapshot, capacity-safe reservation, Stripe Checkout payment, webhook-confirmed booking.
- `admin-portal`: authenticated admin area for schedule management, rosters with contact/consent/payment detail, manual payment marking, and CSV export.
- `customer-migration`: CSV import of existing customers (accounts, children, paid enrolments) and magic-link invite emails.
- `conversion-tracking`: first-party Meta Pixel funnel with Conversions API deduplication keyed on booking event IDs.

### Modified Capabilities

- `booking-cta`: CTAs SHALL link to the first-party `/book/` path (same tab) instead of the Class4Kids tenant page; the "no new runtime dependency" requirement is scoped to the marketing pages only, since the booking subsystem introduces a Worker runtime by design.

## Impact

- **New code**: `booking/` directory (Worker source, D1 migrations, seeds, tests, wrangler config, deployment/migration docs). Single dev dependency: `wrangler`.
- **Marketing pages**: `index.html`, `classes.html`, `about.html`, `contact.html` — CTA hrefs, pixel event wiring, and structured-data offer URLs change; everything else stays static and build-free.
- **Hosting**: deployment target moves from GitHub Pages to a Cloudflare Worker with static assets (free tier); DNS cutover documented, GitHub Pages remains untouched until the branch is merged.
- **Third-party services**: Stripe (payments, webhook), Resend (transactional email), Meta Conversions API (optional, dedup), ClassForKids (decommissioned after migration).
- **Data**: customer PII (names, emails, phones), child details including medical notes, consent records, and payment references now live in our D1 database — schema, access control, and export paths are part of this change.
