# Mini & Co. — In-House Booking System

A Cloudflare Worker + D1 (SQLite) application that serves the static marketing
site as assets and runs the booking system on the same origin: parent accounts
with passwordless magic-link sign-in, child profiles, waiver/consent capture,
capacity-safe session booking, hosted Stripe Checkout payment, an admin portal,
CSV customer migration, and a first-party Meta Pixel funnel ending in a
deduplicated `Purchase`.

**Zero runtime dependencies.** The only dev dependency is `wrangler`. Stripe,
Resend, and the Meta Conversions API are called over plain `fetch`; webhook
signatures are verified with Web Crypto.

## Architecture

One Worker serves everything:

- Requests matching static files (the marketing site at the repo root) are
  served by Workers Assets and never invoke the Worker. The repo-root
  `.assetsignore` keeps `booking/`, `openspec/`, `scripts/`, dotfiles, etc.
  off the public site (verified by the e2e suite).
- Dynamic routes run in the Worker against D1:
  - `/book` — public class list; `/book/checkout` — child + waiver/consent
    step; `/book/confirm` — status-polling confirmation page.
  - `/account` — parent dashboard, profile, child CRUD.
  - `/auth/*` — magic-link request/verify (scanner-safe POST consume), logout.
  - `/admin/*` — schedule, classes, sessions (weekly repeat), rosters,
    bookings (mark-paid/cancel), customers, CSV import/export.
  - `/api/stripe/webhook` — signature-verified, replay-protected payment
    confirmation; `/api/bookings/:id/status` — owner-scoped polling.
  - `/dev/*` — mock checkout + mailbox, only when `ENVIRONMENT=development`.

```
booking/
├── src/
│   ├── index.js          # router, security headers/CSP, error handling
│   ├── lib/              # html templating (auto-escaping), crypto, session,
│   │                     # CSRF middleware, rate limiting, validation,
│   │                     # Sydney time, domain (capacity-guarded bookings),
│   │                     # csv, payments/email/CAPI drivers, logging
│   └── routes/           # auth, booking, account, child-profiles, admin*,
│                         # webhooks, dev
├── migrations/           # D1 schema (apply with wrangler d1 migrations)
├── seed/dev-seed.sql     # local development data
└── test/                 # unit (node --test + miniflare D1) and e2e
```

Key invariants:

- **Times**: stored UTC ISO-8601 with second precision; entered and rendered
  in `Australia/Sydney` (AEST/AEDT handled by `Intl`, unit-tested across the
  DST boundary).
- **Capacity**: seat reservation is a guarded multi-statement `batch()` (D1
  batches are atomic). A `txn_guards` CHECK violation aborts the whole batch
  when any selected session is full, so two parents racing for the last seat
  resolve to exactly one booking (unit-tested with a concurrent burst).
- **Consent snapshots**: waiver version/timestamp, photo consent, and medical
  notes are copied onto each booking at booking time; later profile edits
  never alter the record.
- **Drivers**: `PAYMENTS_DRIVER=stripe|mock`, `EMAIL_DRIVER=resend|console`.
  Mock/dev surfaces refuse to load unless `ENVIRONMENT=development`
  (fail-closed).

## Security model (summary)

- Magic-link tokens and session ids are 256-bit CSPRNG values; only SHA-256
  hashes are stored. Links are single-use (atomic consume), 20-minute expiry,
  consumed by POST so mail scanners can't burn them. Sessions: `HttpOnly;
  Secure; SameSite=Lax`, 30-day absolute expiry, server-side revocation on
  logout, fresh id per sign-in.
- Every state-changing request verifies a per-session CSRF token plus
  Origin/Sec-Fetch-Site; the verify endpoint also rejects cross-site POSTs
  (login-CSRF defence).
- All HTML rendering goes through an auto-escaping tagged template; CSP allows
  only same-origin scripts plus the Meta pixel host; no inline scripts on
  booking pages.
- All ids are opaque UUIDs; every read/write is ownership-scoped — another
  account's resource returns the same 404 as a nonexistent one.
- Admin role comes only from the `ADMIN_EMAILS` allowlist, re-derived at every
  sign-in and re-checked per request; denials are logged and rate limited.
- Rate limits: magic-link requests (per email + IP), token verification
  (per IP), booking creation (per account), invites (per email).
- Logs are structured JSON with masked emails and id prefixes only — never
  tokens, full emails, phones, or medical content.
- CSV exports neutralise spreadsheet formula injection.

## Local development

```bash
cd booking
npm install                 # wrangler only
npm run migrate:local       # apply D1 schema
npm run seed:local          # seed a class + sessions
npm run dev                 # http://localhost:8787
```

> Tip: if edits to the database trigger dev-server reloads (the assets watcher
> covers the repo root), run wrangler with state outside the tree:
> `npx wrangler dev --persist-to /tmp/wrangler-persist` (apply migrations and
> seed with the same `--persist-to`).

Local conveniences (all `ENVIRONMENT=development` only, from `.dev.vars`):

- **Email**: the console driver writes to a `dev_emails` table — open
  `/dev/mailbox` to read magic links and confirmations.
- **Payments**: the mock driver redirects to `/dev/mock-checkout`, which
  drives the same confirmation path as the Stripe webhook.
- **Admin**: sign in with the email listed in `ADMIN_EMAILS` (`.dev.vars`).

## Tests

```bash
npm test      # 54 unit tests: escaping, validation, Sydney time/DST,
              # webhook signatures, rate limiting, capacity race (real D1
              # via miniflare, which wrangler already bundles)
npm run e2e   # 39 checks: boots a fresh wrangler dev + database and walks
              # the parent and admin journeys, isolation/CSRF smoke tests,
              # and asset-exposure checks
```

## Related documents

- [DEPLOYMENT.md](DEPLOYMENT.md) — Cloudflare/Stripe/Resend setup, DNS
  cutover, rollback.
- [MIGRATION.md](MIGRATION.md) — moving customers across from ClassForKids.
