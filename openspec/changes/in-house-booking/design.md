# In-House Booking System — Design

## Context

The marketing site is four hand-authored static HTML pages on GitHub Pages (CNAME → `miniandcosensoryclasses.com`). Bookings run through ClassForKids ($70/month) which blocks Meta Pixel integration, so the pixel currently fires a `Lead` on CTA click — before any money changes hands. The business is small (~20 customers, two Wednesday sessions/week at $25) but growing; the system must be near-zero cost, low-maintenance, and safe to run by a non-technical owner.

Validated in this devcontainer: `wrangler dev` (workerd) runs locally with a local D1 (SQLite) database, so the whole stack is testable end-to-end offline with mock payment/email drivers.

## Goals / Non-Goals

**Goals:**
- Replace ClassForKids: parent accounts, child profiles, waiver/consents, Stripe payment, admin schedule/rosters, at ~$0/month infrastructure (Cloudflare free tier; Stripe per-transaction fees only).
- Full first-party Meta Pixel funnel ending in `Purchase` on real payment, with Conversions API deduplication.
- Painless migration: CSV import of existing customers and their paid enrolments; magic-link invites (no passwords, ever).
- Everything verifiable locally: seeded dev database, mock payments, console email driver, scripted end-to-end journey.
- Defence-in-depth security: this system stores children's medical notes and parent PII.

**Non-Goals:**
- No refund automation (refunds via Stripe dashboard; admin marks bookings cancelled).
- No recurring subscriptions/direct debit; each checkout is a one-off payment (single session or multi-session block in one cart).
- No native apps, no waitlists, no discount codes (schema leaves room; not built now).
- No change to the marketing pages' static, build-free nature.

## Decisions

### D1. Platform: one Cloudflare Worker + D1, serving the marketing site as static assets
- The Worker serves the whole site: static assets via Workers Assets (requests matching files never invoke the Worker and are free/unlimited); dynamic routes (`/book/*`, `/account/*`, `/admin/*`, `/api/*`) run in the Worker against a D1 database.
- A `.assetsignore` excludes `booking/`, `scripts/`, `photos-staging/`, `openspec/`, dotfiles, etc. from being publicly served.
- Same-origin booking → first-party cookies, clean pixel attribution, no CORS at all.
- *Alternatives*: Supabase (can't run its stack in this container; auth UX heavier), Node on Render/Fly (monthly cost, cold starts, server to patch), keeping GH Pages + a separate `book.` subdomain Worker (needs the zone on Cloudflare anyway; split-origin complicates cookies and pixel).
- *Cutover*: GitHub Pages keeps serving `main` until DNS moves to the Worker; rollback is pointing DNS back.

### D2. Plain JavaScript, server-rendered HTML, no framework, no build step
- Hand-rolled router (method + URL pattern), HTML via a strict auto-escaping `html` tagged template literal (escapes by default; raw insertion only via an explicit `raw()` marker). Classic form POSTs with redirect-on-success; a few small progressive-enhancement scripts served as static files.
- Runtime dependencies: **zero**. Dev dependency: `wrangler` only. Stripe, Resend and Meta CAPI are called via `fetch` against their REST APIs; webhook signatures verified with Web Crypto.
- *Alternatives*: Hono (nice but unnecessary dependency surface for ~30 routes), SPA (build step, client state, worse CSP), Stripe SDK (works on Workers but pulls a large dependency for two endpoints).

### D3. Authentication: passwordless email magic links
- Parents and admins sign in by entering their email; we send a single-use link. No passwords stored — nothing to breach, and migrated customers onboard with one click.
- Token: 256-bit CSPRNG value; only its SHA-256 hash is stored (`auth_tokens`), 20-minute expiry, single use, bound to normalised email. Verification consumes the token atomically (`UPDATE ... WHERE used_at IS NULL`).
- Web sessions: 256-bit CSPRNG id, SHA-256 hash stored in `web_sessions` with user id, created/last-seen, 30-day absolute expiry; cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`. New session id issued at every login; logout deletes the row (server-side revocation).
- Roles: `parent` | `admin` on `users`. Admins are bootstrapped from an `ADMIN_EMAILS` env allowlist at login time; admin routes re-check role server-side on every request.
- Rate limiting: per-email and per-IP counters (D1 table, fixed window) on magic-link requests and token verification; generic responses so the endpoint can't be used to enumerate accounts.
- *Alternatives*: passwords + bcrypt (Workers lack native bcrypt/argon2; PBKDF2 via WebCrypto is possible but passwords are strictly worse for this audience), OAuth (overkill, third-party dependency).

### D4. CSRF and browser security
- Per-session CSRF token (random 256-bit, stored against the web session) embedded in every form; all state-changing requests verify token + `Origin`/`Sec-Fetch-Site` header; `SameSite=Lax` as an additional layer.
- Security headers on every dynamic response: CSP (`default-src 'self'`; `script-src 'self' https://connect.facebook.net`; `img-src 'self' https://www.facebook.com data:`; `form-action 'self' https://checkout.stripe.com`; `frame-ancestors 'none'`), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. No inline scripts on booking pages — the pixel bootstrap lives in a static JS file reading config from `data-` attributes.

### D5. Payments: Stripe Checkout (hosted) behind a driver interface
- Booking flow creates a `pending` booking, then a Stripe Checkout Session (REST `POST /v1/checkout/sessions`, form-encoded, AUD) with `client_reference_id = booking id` and 30-minute expiry; parent pays on Stripe's hosted page (no card data ever touches us).
- `POST /api/stripe/webhook` verifies the `Stripe-Signature` header (HMAC-SHA256 over `${timestamp}.${payload}`, constant-time compare, 5-minute tolerance) and on `checkout.session.completed` marks the booking `confirmed`/paid, stores payment intent + amount, sends the confirmation email, and emits the CAPI `Purchase`. The success page also polls booking status so the parent sees confirmation even if the webhook lags.
- Drivers: `stripe` (production) and `mock` (local dev: an internal fake checkout page with "simulate success/cancel"). The mock driver refuses to load unless `ENVIRONMENT !== "production"` — fail-closed.
- *Alternatives*: Payment Links (no programmatic reconciliation per booking), Payment Intents + Elements (PCI surface, custom UI for no gain).

### D6. Capacity safety without interactive transactions
- D1 has no interactive transactions; seat reservation uses a guarded insert executed in a single `batch()` (implicitly atomic): `INSERT INTO booking_sessions ... SELECT ... WHERE (SELECT capacity ...) > (SELECT COUNT(*) of seats held by confirmed or unexpired pending bookings)`. If no row is inserted, the seat was lost — the user gets a friendly "session just filled up".
- Pending bookings hold seats for 35 minutes (Stripe Checkout expires at 30); expiry is opportunistic — read paths treat lapsed pending bookings as not seat-holding, and a sweep marks them `expired`.

### D7. Data model (D1 / SQLite)
- All primary keys are opaque random ids (`crypto.randomUUID()`) — no sequential ids to enumerate (IDOR hardening).
- Tables: `users` (id, email unique, name, phone, role, created_at), `children` (id, user_id FK, name, dob, medical_notes, photo_consent, created_at), `classes` (id, name, description, venue, age_range, active), `class_sessions` (id, class_id FK, starts_at UTC, duration_mins, capacity, price_cents, status), `bookings` (id, user_id, child_id, status `pending|confirmed|cancelled|expired`, amount_cents, currency, payment_provider, payment_ref, paid_at, waiver_version, waiver_accepted_at, photo_consent_snapshot, medical_notes_snapshot, created_at), `booking_sessions` (booking_id, session_id, PK both), `auth_tokens` (token_hash PK, email, purpose, expires_at, used_at, created_at), `web_sessions` (session_hash PK, user_id, csrf_token, created_at, expires_at), `rate_limits` (key, window_start, count).
- Waiver/consent answers are **snapshotted onto the booking** (version, timestamp, photo consent, medical notes at time of booking) — the legal record survives later profile edits.
- Times stored as UTC ISO-8601; entered and rendered in `Australia/Sydney` via `Intl.DateTimeFormat` (handles AEST/AEDT).

### D8. Email: Resend REST API behind a driver
- `EMAIL_DRIVER=resend` in production (single `fetch`, free tier 3,000/month — plenty for ~20 families), `EMAIL_DRIVER=console` in dev (logs the message; dev pages surface the magic link so the journey is testable offline).
- Sends: magic link, booking confirmation, migration invite. From `bookings@miniandcosensoryclasses.com` once the domain is verified in Resend.
- *Alternative*: MailChannels (free Workers tier discontinued), SES (heavier setup).

### D9. Meta Pixel + Conversions API
- Booking pages load the same pixel (`1991468878409217`) via a static first-party bootstrap script (CSP-clean). Funnel: `PageView` everywhere, `ViewContent` on the class list, `InitiateCheckout` when checkout starts, `Purchase` (value, currency=AUD) **only on the confirmation page of a paid booking**, with `eventID = booking id`.
- Webhook handler optionally sends the same `Purchase` via Conversions API (`META_CAPI_TOKEN`) with the identical `event_id` so Meta dedupes browser/server copies; user identifiers (email, phone) are SHA-256-hashed per Meta's normalisation rules before sending.
- Marketing pages keep their existing pixel; the `Lead`-on-click hack is removed in favour of the real funnel.

### D10. Customer migration
- Admin uploads a CSV (template provided; columns map from the ClassForKids export): parent name/email/phone, child name/dob, medical notes, photo consent, and optionally a class/sessions enrolment to recreate as a `confirmed` booking with `payment_provider='external'` (already paid on the old system).
- Import is idempotent (keyed on email + child name), previews before committing, and queues invite emails: "your account has moved — click to sign in, check your details, accept the new waiver".

### D11. Observability and privacy
- Structured `console.log` JSON lines (Workers Logs): auth events, authz denials, rate-limit trips, webhook outcomes, import summaries. **Never** log tokens, emails in full, or medical notes.
- Children's medical data shows only in the parent's own flow and the admin roster; exports are admin-only and CSRF-protected.

## Risks / Trade-offs

- [D1 has no interactive transactions] → all multi-statement writes use `batch()` (atomic) and guarded-insert patterns; capacity logic unit-tested for the race.
- [Magic-link email deliverability] → Resend with verified domain + SPF/DKIM; links last 20 min; resend allowed within rate limits; admin can see a parent's state regardless.
- [Webhook missed/delayed] → confirmation page polls booking status; admin sees `pending` bookings with a "check payment" action; Stripe retries webhooks for days; seats released after expiry window.
- [Worker/assets serve the whole site — misconfigured `.assetsignore` could expose internals] → explicit ignore list, e2e test asserts `/booking/src/...`, `/openspec/...` return 404.
- [One developer-owned bespoke system replaces a vendor] → zero-dependency code, exhaustive README/DEPLOYMENT/MIGRATION docs, seed + e2e scripts so behaviour is reproducible; data exportable as CSV at any time.
- [DNS cutover risk] → staged: deploy Worker to `workers.dev`, test with real Stripe test keys, then move DNS; GH Pages remains as instant rollback.

## Migration Plan

1. Deploy Worker (staging on `*.workers.dev`), run D1 migrations, set secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ADMIN_EMAILS`, `META_CAPI_TOKEN` optional), Stripe in test mode.
2. Verify the full journey on staging (test cards, webhook via Stripe CLI or dashboard).
3. Import customers from the ClassForKids CSV export; review the preview; commit; send invites.
4. Switch Stripe to live keys, point DNS at the Worker, change-over day announced on Instagram; ClassForKids cancelled after the last migrated term.
5. Rollback at any point: DNS back to GitHub Pages; D1 data exports via admin CSV.

## Open Questions

- Stripe account onboarding (business details, BSB for payouts) — owner action, documented in DEPLOYMENT.md.
- Resend domain verification (DNS TXT records) — owner action, documented.
- Term-block pricing (e.g. 8 sessions for $180): the cart supports multi-session checkout at per-session price; discounted blocks can be added later as a `classes`-level price rule.
