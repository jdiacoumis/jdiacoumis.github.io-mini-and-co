# Mini & Co. — In-House Booking System

A Cloudflare Worker + D1 (SQLite) application that serves the static marketing
site as assets and runs the booking system on the same origin: parent accounts
with passwordless magic-link sign-in, child profiles, waiver/consent capture,
terms with term / casual / trial / complimentary bookings, capacity-safe seat
holds, hosted Stripe Checkout payment in full or by weekly instalments (Stripe
subscriptions), a payment ledger, credits and vouchers, an admin portal with a
roster-only staff role, scheduled jobs, CSV customer migration, and a
first-party Meta Pixel funnel ending in a deduplicated `Purchase`.

**Zero runtime dependencies.** The only dev dependency is `wrangler`. Stripe,
Resend, and the Meta Conversions API are called over plain `fetch`; webhook
signatures are verified with Web Crypto.

## Architecture

One Worker serves everything:

- Requests matching static files are served by Workers Assets and never
  invoke the Worker. Assets come ONLY from `booking/public/`, which
  `scripts/stage-assets.mjs` fills from an explicit allow-list (the four
  pages, `css/`, `js/`, `assets/`, `robots.txt`, `sitemap.xml`; dotfiles,
  symlinks and files over 25 MiB skipped). `npm run dev` and `npm run deploy`
  stage first; nothing else in the repository can be served (e2e-verified).
- Dynamic routes run in the Worker against D1:
  - `/book` — public class list by term; `/book/checkout` — child, price
    breakdown (voucher, credits), pay in full or by instalments, waiver/
    consent; `/book/confirm` — status-polling confirmation page;
    `/book/cancelled` — expires the Stripe session, then releases seats.
  - `/account` — parent dashboard, profile, child CRUD.
  - `/auth/*` — magic-link request/verify (scanner-safe POST consume), logout.
  - `/admin/*` — schedule, classes (weekly slots), sessions, rosters (also
    open to `STAFF_EMAILS`), bookings (record offline payment / cancel),
    customers, CSV import by term/export. Terms, Needs attention, Waitlist,
    Email and manual bookings are registered placeholders filled in Phase 2.
  - `/api/stripe/webhook` — signature-verified; events are claimed before
    and marked done after handling (D6); `/api/bookings/:id/status` —
    owner-scoped polling.
  - `/dev/*` — mock checkout (with instalment-plan simulations), mock billing
    portal and mailbox, only when `ENVIRONMENT=development`.
- A cron trigger (every 15 minutes) runs `scheduled()` → `lib/cron.js`:
  sweep lapsed holds, expire waitlist offers, purge old records.

```
booking/
├── src/
│   ├── index.js          # router (modules self-register), security
│   │                     # headers/CSP, errors, scheduled() handler
│   ├── lib/              # html templating (auto-escaping), crypto, session,
│   │                     # middleware (CSRF, live roles), rate limiting,
│   │                     # validation, Sydney time, domain (terms, held
│   │                     # seats, guarded bookings), pricing (pure), ledger,
│   │                     # payments/email/CAPI drivers, notify, cron,
│   │                     # emails/*, jobs/*, csv, logging
│   └── routes/           # auth, booking, waitlist, account, child-profiles,
│                         # admin*, webhooks, dev — each exports
│                         # registerRoutes(route)
├── scripts/stage-assets.mjs  # allow-listed copy of the site into public/
├── migrations/           # D1 schema (apply with wrangler d1 migrations)
├── seed/dev-seed.sql     # local development data (two slots, open terms)
└── test/                 # unit (node --test + miniflare D1) and modular
                          # e2e (test/e2e/run.js + journeys/*.js)
```

Key invariants:

- **Times**: stored UTC ISO-8601 with second precision; entered and rendered
  in `Australia/Sydney` (AEST/AEDT handled by `Intl`, unit-tested across the
  DST boundary).
- **Capacity**: a seat is held by a `booking_sessions` row with status
  `booked` on a confirmed or unexpired pending booking — one definition
  (`heldSeatsSql`) used everywhere. Seat reservation is a guarded
  multi-statement `batch()` (D1 batches are atomic); a `txn_guards` CHECK
  violation aborts the whole batch when any selected session is full, so two
  parents racing for the last seat resolve to exactly one booking. Credits
  and voucher uses are taken in the same batch and given back if the hold
  lapses.
- **Money**: integer cents; prices come from `lib/pricing.js` (pure,
  unit-tested). `payments` is an append-only ledger keyed on provider ids;
  `paid_cents`/`payment_status` are derived from it. A payment that lands
  after a hold lapsed re-takes its seats or is flagged `paid_no_seat` —
  never oversold.
- **Consent snapshots**: waiver version/timestamp, photo consent, and medical
  notes are copied onto each booking at booking time; later profile edits
  never alter the record.
- **Drivers**: `PAYMENTS_DRIVER=stripe|mock`, `EMAIL_DRIVER=resend|console`.
  The mock payments driver, the console email driver and the dev pages
  refuse to load unless `ENVIRONMENT=development`, and an unknown driver
  name throws (fail-closed).

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
- Admin and staff rights come only from the `ADMIN_EMAILS` / `STAFF_EMAILS`
  allowlists, re-derived on every request (removal is immediate); staff may
  open rosters and post attendance only. Denials are logged and rate
  limited.
- Rate limits: magic-link requests (per email + IP), token verification
  (per IP), booking creation (per account), invites (per email).
- Logs are structured JSON with masked emails and id prefixes only — never
  tokens, full emails, phones, or medical content.
- CSV exports neutralise spreadsheet formula injection.

## Local development

```bash
cd booking
npm ci                      # wrangler only
npm run migrate:local       # apply D1 schema
npm run seed:local          # two weekly slots with open terms, a voucher
npm run dev                 # stages public/, then http://localhost:8787
```

Local conveniences (all `ENVIRONMENT=development` only, from `.dev.vars`):

- **Email**: the console driver writes to a `dev_emails` table — open
  `/dev/mailbox` to read magic links and confirmations.
- **Payments**: the mock driver redirects to `/dev/mock-checkout`, which
  posts synthetic Stripe events through the same webhook processing — pay
  now, cancel, and for instalment plans "next instalment paid" /
  "instalment failed" / "plan ended".
- **Staff**: sign in as the `STAFF_EMAILS` address (`.dev.vars`) to see the
  roster-only role.
- **Cron**: `npx wrangler dev --test-scheduled`, then open `/__scheduled`.
- **Admin**: sign in with the email listed in `ADMIN_EMAILS` (`.dev.vars`).

## Tests

```bash
npm test      # 136 unit tests: pricing, ledger, booking domain (races,
              # credits, vouchers, guarded confirmation), webhooks (claim
              # ordering, retries, plans, refunds), Stripe driver, escaping,
              # validation, Sydney time/DST, roles, cron, notify — D1 via
              # miniflare, which wrangler already bundles
npm run e2e   # 160 checks: stages assets, boots a fresh wrangler dev +
              # database, runs test/e2e/journeys/*.js (publishing, parent,
              # plans, isolation/roles, admin, cron);
              # `npm run e2e -- plans` runs matching journeys only
```

## Related documents

- [DEPLOYMENT.md](DEPLOYMENT.md) — Cloudflare/Stripe/Resend setup, DNS
  cutover, rollback.
- [MIGRATION.md](MIGRATION.md) — moving customers across from ClassForKids.
