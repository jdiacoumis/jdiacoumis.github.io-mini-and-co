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
  - `/book/waitlist` — join a full term's waitlist.
  - `/account` — parent dashboard (bookings with Pay now for held places,
    payment status, Update card via Stripe's billing portal, credit balance,
    waitlist entries), profile, child CRUD.
  - `/auth/*` — magic-link request/verify (scanner-safe POST consume), logout.
  - `/admin/*` — schedule; terms (create with weekly sessions, edit, open/
    close, the families × weeks grid, re-run with auto-enrol); classes
    (weekly slots); sessions (edit, cancel with notices and credits);
    rosters with attendance (the only pages open to `STAFF_EMAILS`);
    bookings (manual/pay-later/complimentary, record offline payment,
    transfers, single-week and whole-booking cancellation); Needs attention
    with Check with Stripe; credits and vouchers; customers; waitlist
    (`/admin/waitlist`: offers with a 48-hour held booking, withdraw,
    decline, remove, add by phone); email (`/admin/email`: bulk email with
    preview, `/admin/email/log`); CSV import by term and exports.
  - `/api/stripe/webhook` — signature-verified; events are claimed before
    and marked done after handling (D6); `/api/bookings/:id/status` —
    owner-scoped polling.
  - `/dev/*` — mock checkout (with instalment-plan simulations), mock billing
    portal and mailbox, only when `ENVIRONMENT=development`.
- A cron trigger (every 15 minutes) runs `scheduled()` → `lib/cron.js`,
  which runs every job in `lib/jobs/*.js` (see
  [Scheduled jobs](#scheduled-jobs)).

```
booking/
├── src/
│   ├── index.js            # router (modules self-register), security
│   │                       # headers/CSP, errors, scheduled() handler
│   ├── lib/
│   │   ├── domain.js       # terms, THE held-seat definition, prepare/create/
│   │   │                   # confirm/cancel/expire bookings (guarded batches)
│   │   ├── pricing.js      # pure: term/pro-rata/returning/casual/trial,
│   │   │                   # vouchers, credits, instalment schedules
│   │   ├── ledger.js       # payments ledger, derived payment status,
│   │   │                   # credits and voucher uses
│   │   ├── notify.js       # sendTemplate() + email_log (dedupe keys), owner
│   │   │                   # alerts, confirmation, session-cancelled and
│   │   │                   # plan-failed notices
│   │   ├── emails/         # core.js (owner alerts), parent.js (booking
│   │   │                   # emails), ops.js (reminder, class cancelled,
│   │   │                   # re-enrol, waitlist offer, failed instalment,
│   │   │                   # receipt, bulk) — each returns {subject,text,html}
│   │   ├── cron.js         # job registry runner
│   │   ├── jobs/           # core.js, parent.js, ops.js — scheduled jobs
│   │   ├── payments-driver.js, email-driver.js, capi-driver.js
│   │   └── html, crypto, session, middleware (CSRF, live roles), ratelimit,
│   │       validate, time (Sydney), csv, db, http, log
│   └── routes/             # auth, booking, waitlist, account, child-profiles,
│                           # admin, admin-terms, admin-bookings, admin-ops,
│                           # admin-import, admin-waitlist, admin-email,
│                           # webhooks, dev — each exports registerRoutes(route)
├── scripts/stage-assets.mjs  # allow-listed copy of the site into public/
├── migrations/             # D1 schema (apply with wrangler d1 migrations)
├── seed/dev-seed.sql       # local development data (two slots, open terms)
└── test/                   # unit (node --test + miniflare D1) and modular
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
- **Emails are idempotent**: every family or owner email goes through
  `notify.sendTemplate()`, which claims an `email_log` row by `dedupe_key`
  before sending — a job, webhook retry or double-click with the same key
  sends nothing new; a failed send is marked `failed` and retried by the
  next call with that key. (Magic links and invites are sent directly and
  are never logged — they carry sign-in tokens.)

## Communications

Templates are pure functions in `lib/emails/*.js` returning
`{ subject, text, html }`; `html` is built with the auto-escaping `` html`` ``
tag, so a name typed by a family can never inject markup into an email, and
subjects are forced onto one line.

| Email | Sent by | Dedupe key |
| --- | --- | --- |
| Booking confirmation (with plan schedule) | webhook / confirm paths → `notifyBookingConfirmed` | `booking_confirmed:<booking>` |
| Day-before reminder | job `sendReminders` | `reminder:<session>:<booking>` |
| Class cancelled (with the credit) + owner summary | session cancel → `notifySessionCancelled` | `session_cancelled:<session>:<booking>` / `…:<owner email>` |
| Waitlist offer | `/admin/waitlist/:id/offer` | `waitlist_offer:<entry>:<booking>` |
| Failed instalment (Update card link) + owner alert | `invoice.payment_failed` → `notifyPlanFailed` | `plan_failed:<booking>:<invoice>` / owner per attempt |
| Overdue-plan reminder (weekly) | job `overdueNudges` | `plan_overdue:<booking>:<ISO week>` |
| Re-enrol invitation, offline-payment receipt | Phase 2B routes (`reenrolInvitation`, `offlineReceipt`) | set by the caller |
| Trial follow-up | Phase 2A job | set by the caller |
| Bulk email | `/admin/email` → Send | `bulk:<batch>:<user>` |
| Needs-attention alert | `notifyAttention` | `attention:<flag>:<booking>:<owner email>` |

**Bulk email** (`/admin/email`): the owner picks an audience — a term's
families (live bookings), a term's waitlist (waiting or offered), or every
current family (a live booking with a booked week still to come) — writes a
subject and plain-text message, previews it (recipient count and list, the
email as the first family will see it; POST + CSRF so text never travels in
a URL) and sends: one email per parent through `sendTemplate`, keyed on the
batch id created at preview, so a double-click, refresh or retry never
emails anyone twice and failed sends can be retried from the result page.
Each email is one outgoing request to Resend, and Cloudflare caps outgoing
requests per incoming request (50 on the Workers free plan), so an audience
much larger than a term's ~24 families may stop part-way; pressing Send again
on the same preview emails only those not yet sent.

**Email log** (`/admin/email/log`): `email_log` newest first, filtered by
template, term, recipient address (literal substring) and status, 50 a page.

## Scheduled jobs

`wrangler.toml` runs `scheduled()` every 15 minutes; `lib/cron.js` runs the
registry in order, isolating failures (one failing job never stops the
others). Every job is idempotent and safe to overlap.

| Job | File | What it does |
| --- | --- | --- |
| `sweepExpiredBookings` | `jobs/core.js` | Lapses pending holds past `expires_at`, giving back credit redemptions and voucher uses. |
| `expireOffers` | `jobs/core.js` | Waitlist offers past their deadline: the held booking expires (seat released) and the entry returns to `waiting` with "Offer lapsed …" noted. |
| `purge` | `jobs/core.js` | Deletes sign-in tokens, web sessions, rate-limit windows and webhook events older than 30 days. |
| trial follow-ups | `jobs/parent.js` | Phase 2A: the day after a trial, offer the rest of the term. |
| `sendReminders` | `jobs/ops.js` | Confirmed bookings' booked rows in scheduled sessions starting 20–28 h ahead: one reminder per (session, booking). |
| `overdueNudges` | `jobs/ops.js` | Plans still `plan_overdue` (not `plan_ended_short`) and behind schedule: a reminder with the shortfall at most every 7 days and once per Sydney ISO week. |
| `reconcileWaitlist` | `jobs/ops.js` | Entries whose offer booking is confirmed become `booked` (a safety net — `confirmBooking` already does this). |

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
npm test      # unit tests: pricing, ledger, booking domain (races,
              # credits, vouchers, guarded confirmation), webhooks (claim
              # ordering, retries, plans, refunds), Stripe driver, escaping,
              # validation, Sydney time/DST, roles, cron, notify, ops emails,
              # session-cancelled/plan-failed notices, reminders and nudges,
              # waitlist offers, bulk email, admin authz/CSRF — D1 via
              # miniflare, which wrangler already bundles
npm run e2e   # stages assets, boots a fresh wrangler dev + database, runs
              # test/e2e/journeys/*.js (publishing, parent, plans,
              # isolation/roles, admin, cron, waitlist offers, reminders,
              # bulk email); `npm run e2e -- ops` runs matching journeys only
```

Journeys share one server and database and run in file-name order
(`admin-*`, `core-*`, `ops-*`, `parent-*`), so each uses its own addresses and
data (the `ops-*` journeys create their own draft/closed terms). The owner's
address may request only 3 sign-in links an hour, so journeys that act as the
owner beyond the first sign-in mint the owner's web session in SQL.

## Related documents

- [OWNER-GUIDE.md](OWNER-GUIDE.md) — for Camila: running terms, rosters,
  bookings, payments, the waitlist and emails, screen by screen.
- [DEPLOYMENT.md](DEPLOYMENT.md) — Cloudflare/Stripe/Resend setup, DNS
  cutover, rollback.
- [MIGRATION.md](MIGRATION.md) — moving customers across from ClassForKids.
