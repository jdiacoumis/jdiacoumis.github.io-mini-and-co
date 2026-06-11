## 1. Foundation

- [x] 1.1 Validate wrangler dev + local D1 run in the devcontainer
- [x] 1.2 Scaffold booking/ Worker project (package.json, wrangler.toml, .dev.vars, .gitignore) and repo-root .assetsignore
- [x] 1.3 D1 schema migration 0001_init.sql (users, children, classes, class_sessions, bookings, booking_sessions, auth_tokens, web_sessions, rate_limits, webhook_events, txn_guards, dev_emails) + dev seed
- [x] 1.4 Core libs: html auto-escaping templates + layout, crypto (CSPRNG tokens, SHA-256, HMAC, timing-safe compare), cookies, sessions, CSRF, rate limiting, validation, Sydney time handling, structured PII-safe logging
- [x] 1.5 Domain lib: capacity-guarded booking creation (batch + txn guard), seat counting, pending expiry, confirmBooking shared by webhook and mock driver
- [x] 1.6 Drivers: email (resend + console-with-dev-outbox), payments (stripe REST + mock, mock fail-closed in production), Meta CAPI sender
- [x] 1.7 Router, entry point with security headers/CSP, error pages; project boots under wrangler dev with stub routes

## 2. Features

- [x] 2.1 Auth routes: request magic link (rate-limited, no enumeration), verify via POST (scanner-safe), logout, session cookie lifecycle
- [~] 2.2 Parent flow: public class list with availability, profile + child CRUD (ownership enforced), checkout review with waiver/consent snapshot, payment redirect, confirmation page with status polling, parent dashboard
  - [x] Child profile CRUD (add, edit, delete)
  - [ ] Public class list with availability
  - [ ] Checkout flow with waiver/consent
  - [ ] Payment redirect and confirmation
  - [ ] Parent dashboard
- [ ] 2.3 Admin portal: dashboard with fullness, class/session CRUD + weekly repeat, per-session roster (contacts, child age, consents, medical, payment status), bookings list with filters, mark-paid/cancel, customers, CSV export
- [ ] 2.4 Stripe webhook endpoint: signature verification, replay protection, idempotent confirm; dev-only mock checkout + mailbox pages
- [ ] 2.5 Meta Pixel: first-party bootstrap (CSP-clean), funnel events, Purchase-once on confirmation, CAPI dedup from webhook; remove Lead-on-click from marketing pages
- [ ] 2.6 Customer migration: CSV template, preview → commit import (idempotent), externally-paid enrolment bookings, magic-link invite emails

## 3. Integration

- [ ] 3.1 Marketing pages: Book now CTAs → /book/ (same tab), structured-data offer URLs updated, copy no longer references Class4Kids
- [ ] 3.2 Booking pages share brand look: reuse css/styles.css tokens + booking.css; header/footer parity

## 4. Verification

- [ ] 4.1 Unit tests: escaping, validation, time conversion (AEST/AEDT), webhook signature, rate limiting, capacity race via guarded batch
- [ ] 4.2 Scripted end-to-end journey on wrangler dev: parent (magic link → child → waiver → mock pay → confirmed + pixel data) and admin (schedule CRUD → roster → import → export); asset-exposure checks (/booking/src, /openspec → 404)
- [ ] 4.3 Adversarial security review across lenses (authz/IDOR, XSS/CSP, CSRF, injection, session/crypto, webhook integrity, rate limiting); fix confirmed findings

## 5. Documentation

- [ ] 5.1 booking/README.md (architecture, local dev), DEPLOYMENT.md (Cloudflare, Stripe, Resend, DNS cutover, rollback), MIGRATION.md (ClassForKids export → import → invites)
