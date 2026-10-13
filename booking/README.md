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
  - `/book` — public class list by term (term / "join for the remaining N
    weeks" / casual / trial, returning-family window and price, waitlist
    when full); `js/booking-picker.js` adds a running total to the casual
    picker. `/book/checkout` — child, price breakdown (voucher, credits),
    pay in full or by instalments, waiver/consent; `/book/confirm` —
    status-polling confirmation page (`js/booking-status.js` polls
    `/api/bookings/:id/status`); `/book/cancelled` — where Stripe sends a
    family who leaves its page: a GET that changes nothing and offers
    `POST /book/checkout/release` (CSRF), which expires the Stripe session,
    then releases the seats (or keeps a pay-later hold) — the same "cancel
    that payment and start again" the checkout and account pages use.
  - `/book/waitlist` — a term's waitlist for the family: place in line, join
    when the term is full (`POST /book/waitlist`), leave or decline an offer
    (`POST /book/waitlist/leave`, which closes the offer's checkout and
    releases the seat).
  - `/account` — parent dashboard (bookings with Pay now for held places,
    payment status and instalments, credit balance, waitlist entries),
    profile, child CRUD. `/account/bookings/:id/pay` — Pay now for a held
    place (an owner booking, waitlist offer or re-enrolment): waiver if not
    yet accepted, pay in full or by instalments, one live hosted checkout at
    a time. `POST /account/billing-portal` — Update card (Stripe Billing
    Portal) for a running instalment plan.
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
    preview, `/admin/email/log`); CSV import by term and exports. On a
    booking: record an offline payment, an adjustment or a refund made by
    hand; Stop plan (any booking with a live instalment subscription);
    Check with Stripe.
  - `/api/stripe/webhook` — signature-verified; events are claimed before
    and marked done after handling (D6); `/api/bookings/:id/status` —
    owner-scoped polling.
  - `/dev/*` — mock checkout (with instalment-plan simulations, including an
    instalment whose webhook is lost), mock billing portal and mailbox (with
    each email's Reply-To), only when `ENVIRONMENT=development`.
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
│   │   ├── plans.js        # instalment plans after checkout: progress, end
│   │   │                   # date (cancel_at), stop when paid / Stop plan,
│   │   │                   # 'overpaid'
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
├── scripts/stage-assets.mjs  # allow-listed copy of the site into public/,
│                             # plus public/_headers (static security headers)
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
  refuse to load unless `ENVIRONMENT=development` (production and the
  `staging` environment use Stripe test/live and Resend), and an unknown
  driver name throws (fail-closed). Every Stripe request pins
  `Stripe-Version: 2025-08-27.basil` (`STRIPE_API_VERSION`); webhook
  endpoints must use the same version (DEPLOYMENT). The payments driver's
  `listInvoices()` (Stripe `GET /v1/invoices?subscription=…`; the mock reads
  the `dev_mock_invoices` outbox the dev checkout writes) lets Check with
  Stripe add instalments whose `invoice.paid` webhook was lost; Invoice
  Payments (`invoicePaymentIntent`, `invoiceForPaymentIntent`) link
  instalments and refunds, which Basil no longer does on the objects
  themselves; `listRefunds()` gives a payment intent's refunds. A Stripe
  customer id Stripe no longer knows is forgotten and the checkout falls
  back to the family's email.
- **Holds**: a pending booking held for at most 40 minutes is a checkout
  hold (a parent paying now, 35 minutes); anything longer is a pay-later
  hold paid with Pay now (owner bookings 7 days, waitlist offers 48 hours,
  auto-enrolment until public opening or 7 days). `isCheckoutHold()` in
  `lib/domain.js` is the one rule, and `createPendingBooking` refuses a
  pay-later hold that would not clear it. A family may have at most 3
  checkout holds at once (guarded in the booking batch) and 6 children;
  Pay now stretches a hold about to end at most twice
  (`bookings.hold_extensions`).
- **Plans**: a plan's subscription is live while `stripe_subscription_id`
  is set and `plan_ended_at` is NULL. It always gets its end date
  (`cancel_at`) — from checkout.session.completed, else the first
  invoice.paid or Check with Stripe — and is stopped (Stripe cancels its
  open invoices' collection too) when everything owed has arrived by any
  route (instalments, offline payments, adjustments), by Stop plan, or when
  the booking is cancelled. Money in beyond the price is flagged
  `overpaid`.
- **Emails are idempotent**: every family or owner email goes through
  `notify.sendTemplate()`, which claims an `email_log` row by `dedupe_key`
  as `pending` before sending and marks it `sent` (with the provider's id) or
  `failed` after — a job, webhook retry or double-click with the same key
  sends nothing new; a failed send, or one left `pending` for ten minutes
  (the request died part-way), is retried by the next call with that key.
  (Magic links and invites are sent directly and are never logged — they
  carry sign-in tokens.)

## Communications

Templates are pure functions in `lib/emails/*.js` returning
`{ subject, text, html }`; `html` is built with the auto-escaping `` html`` ``
tag, so a name typed by a family can never inject markup into an email, and
subjects are forced onto one line.

Mail is sent from `EMAIL_FROM` (`bookings@…`) with a **Reply-To** of
`EMAIL_REPLY_TO` (else the first `ADMIN_EMAILS` address), so a family who
"replies to this email" reaches the owner (`lib/email-driver.js`).

| Email | Sent by | Dedupe key |
| --- | --- | --- |
| Booking confirmation (with plan schedule) | webhook / confirm paths → `notifyBookingConfirmed` | `booking_confirmed:<booking>` |
| Day-before reminder | job `sendReminders` | `reminder:<session>:<booking>` |
| Class cancelled (with the credit) + owner summary | session cancel → `notifySessionCancelled` | `session_cancelled:<session>:<booking>` / `…:<owner email>` |
| Waitlist offer | `/admin/waitlist/:id/offer` | `waitlist_offer:<entry>:<booking>` |
| Failed instalment (Update card link) + owner alert | `invoice.payment_failed` → `notifyPlanFailed` | `plan_failed:<booking>:<invoice>` / owner per attempt |
| Overdue-plan reminder (weekly, live plans only) | job `overdueNudges` | `plan_overdue:<booking>:<ISO week>` |
| Re-enrol invitation (returning-family price) | `/admin/terms/:id/auto-enrol` → `reenrolInvitation` | `reenrol:<term>:<child>:<booking>` (a place held again is announced again) |
| Place held — please pay (pay-later booking) | `/admin/bookings/new/details` → `payLaterHold` | `pay_later:<booking>` |
| Offline-payment receipt | record payment / manual booking → `offlineReceipt` | `offline_receipt:<payment ref>` |
| Trial follow-up | job `trialFollowUps` → `trialFollowUpEmail` | `trial_followup:<booking>` |
| Bulk email | `/admin/email` → Send | `bulk:<batch>:<user>` |
| Needs-attention alert | `notifyAttention` | `attention:<flag>:<booking>:<owner email>` |
| Waitlist offer declined (owner) | `/book/waitlist/leave` | `waitlist_declined:<entry>:<booking>:<owner email>` |
| Waitlist offer lapsed (owner) | job `expireOffers` | `offer_lapsed:<entry>:<booking>:<owner email>` |

**Bulk email** (`/admin/email`): the owner picks an audience — a term's
families (live bookings), a term's waitlist (waiting or offered), or every
current family (a live booking with a booked week still to come) — writes a
subject and plain-text message, previews it (recipient count and list, the
email as the first family will see it; POST + CSRF so text never travels in
a URL) and sends: one email per parent through `sendTemplate`, keyed on the
batch id created at preview, so a double-click, refresh or retry never
emails anyone twice and failed sends can be retried from the result page.
Each email is two database writes and one request to Resend, so Send emails
at most 12 families per request and carries on with a Continue form that
`js/admin-continue.js` submits by itself (README → Limits); the automatic
Continue only covers families never tried, so a failing address can't loop —
Try again retries failures, and nobody is emailed twice.

**Email log** (`/admin/email/log`): `email_log` newest first, filtered by
template, term, recipient address (literal substring) and status, 50 a page.

## Scheduled jobs

`wrangler.toml` runs `scheduled()` every 15 minutes; `lib/cron.js` runs the
registry in order, isolating failures (one failing job never stops the
others). Every job is idempotent and safe to overlap.

| Job | File | What it does |
| --- | --- | --- |
| `sweepExpiredBookings` | `jobs/core.js` | Lapses pending holds past `expires_at`, giving back credit redemptions and voucher uses. |
| `expireOffers` | `jobs/core.js` | Waitlist offers past their deadline: the held booking expires (seat released), the entry returns to `waiting` with "Offer lapsed …" noted, and the owner is emailed once. |
| `purge` | `jobs/core.js` | Deletes sign-in tokens, web sessions, rate-limit windows and webhook events older than 30 days. |
| `trialFollowUps` | `jobs/parent.js` | Confirmed trials whose class started 20 hours to 7 days ago, attended or unmarked, in an open term with weeks to come and no term booking yet: one email offering the rest of the term at the pro-rata price (the same `prepareBooking` quote as the checkout), or its waitlist when full. |
| `sendReminders` | `jobs/ops.js` | Confirmed bookings' booked rows in scheduled sessions starting 20–28 h ahead: one reminder per (session, booking). |
| `overdueNudges` | `jobs/ops.js` | Plans still `plan_overdue` whose subscription is live (not ended by Stripe, Stop plan or "Mark as sorted"), and behind schedule: a reminder with the shortfall at most every 7 days and once per Sydney ISO week. |
| `reconcileWaitlist` | `jobs/ops.js` | Entries whose offer booking is confirmed become `booked` (a safety net — `confirmBooking` already does this). |

## Limits

On the Workers free plan Cloudflare allows each request 50 D1 queries and 50
subrequests (`fetch` to Stripe, Resend, Meta); whether a D1 `batch()` counts
as one query or one per statement is not documented, so the owner's bulk
actions are built to stay within the stricter reading (~40 statements):

- **Cancelling a class**: one guarded batch with a fixed number of statements
  however many families are booked (families and amounts go in as JSON and
  are expanded with `json_each`), then one email per family.
- **Auto-enrol**: one family per request (about 20 queries), the rest carried
  in a Continue form that `js/admin-continue.js` submits by itself.
- **Bulk email**: 12 families per request, the same way.

Unit tests count the statements of these steps (`countingEnv` in
`test/unit/helpers.js`). If a page still fails with "Too many API requests by
single Worker invocation", the Workers Paid plan (1,000 queries per request)
removes the problem without code changes (DEPLOYMENT step 1). D1 also refuses
`LIKE` patterns over 50 characters: searches are trimmed to fit
(`containsPattern`).

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
  booking pages. Static files get HSTS, nosniff, a referrer policy and a
  framing-only CSP from the staged `public/_headers` (the marketing pages'
  inline pixel snippet rules out a script policy there). Names are cleaned
  to one line (no control characters reach an email header).
- All ids are opaque UUIDs; every read/write is ownership-scoped — another
  account's resource returns the same 404 as a nonexistent one.
- Admin and staff rights come only from the `ADMIN_EMAILS` / `STAFF_EMAILS`
  allowlists, re-derived on every request (removal is immediate); staff may
  open rosters and post attendance only. Denials are logged and rate
  limited.
- Rate limits: magic-link requests (per IP first, then per address + IP —
  nobody can use up someone else's links; over the address limit the page
  still says "check your email"), token verification (per IP), booking
  creation and voucher codes tried (per account), invites (per email).
  Malformed session ids are refused before any lookup.
- Logs are structured JSON with masked emails and id prefixes only — never
  tokens, full emails, phones, or medical content.
- CSV exports neutralise spreadsheet formula injection.

## Local development

```bash
cd booking
npm ci                      # wrangler only
npm run migrate:local       # apply D1 schema (0002 and 0006 add dev-only outbox tables)
npm run seed:local          # two weekly slots with open terms, a voucher
npm run dev                 # stages public/, then http://localhost:8787
```

Local conveniences (all `ENVIRONMENT=development` only, from `.dev.vars`):

- **Email**: the console driver writes to a `dev_emails` table — open
  `/dev/mailbox` to read magic links and confirmations.
- **Payments**: the mock driver redirects to `/dev/mock-checkout`, which
  posts synthetic Stripe events through the same webhook processing — pay
  now, cancel, and for instalment plans "next instalment paid" /
  "instalment paid, webhook lost" (then try Check with Stripe) /
  "instalment failed" / "plan ended".
- **Staff**: sign in as the `STAFF_EMAILS` address (`.dev.vars`) to see the
  roster-only role.
- **Cron**: `npx wrangler dev --test-scheduled`, then open `/__scheduled`.
- **Admin**: sign in with the email listed in `ADMIN_EMAILS` (`.dev.vars`).

## Tests

```bash
npm test      # 311 unit tests: pricing, ledger, booking domain (races,
              # credits, vouchers, guarded confirmation, hold rules, trials),
              # webhooks (claim ordering, retries, signatures, plans,
              # refunds), Stripe driver (incl. listInvoices, the pinned API
              # version), Check with Stripe reconciliation, escaping,
              # validation, Sydney time/DST, roles and the admin nav, cron,
              # notify and Reply-To, ops emails, session-cancelled/plan-failed
              # notices, reminders and nudges, waitlist offers and order, bulk
              # email, admin authz/CSRF, and the review fixes
              # (test/unit/fix-*.test.js: plans, Basil refunds, sign-in
              # limits, auto-enrol, terms, session cancel, import, staging,
              # email log, caps and the rest) — D1 via miniflare, which
              # wrangler already bundles; Stripe is a fake
              # (test/unit/stripe-fake.js), nothing leaves the machine
npm run e2e   # 654 checks: stages assets, boots a fresh wrangler dev +
              # database, runs test/e2e/journeys/*.js (publishing, parent,
              # plans, isolation/roles, admin, cron, waitlist offers,
              # reminders, bulk email, the fix-* review journeys and the x-*
              # cross-feature journeys); `npm run e2e -- ops` runs matching
              # journeys only
```

Journeys share one server and database and run in file-name order
(`admin-*`, `core-*`, `fix-*`, `ops-*`, `parent-*`, then `x-*`), so each uses
its own addresses and data (the `fix-*`, `ops-*` and `x-*` journeys create
their own classes and terms). The run shares one owner sign-in
(`ctx.adminCookie`) and some journeys mint web sessions in SQL.
`ctx.runCron()` returns only once every scheduled job has finished (a marker
the last job resolves), and the runner places throwaway private files in the
repository (outside the allow-list, and a dotfile, a junk file and a symlink
inside allow-listed folders) so the publishing checks prove each is a 404
while it exists on disk; they are removed afterwards.

`fix-10` walks the review's high finding: a $168 term on 6 × $28, the second
instalment fails, the family pays the remaining $140 by transfer — the plan
is stopped at the (mock) provider and nothing more can be taken.

The `x-*` journeys (helpers in `test/e2e/support.js`) cross the feature
areas: an instalment plan with a week transferred and a lost instalment
webhook found by Check with Stripe (`x-10`); the waitlist from a full term to
a paid offer, a lapsed offer and a declined one (`x-20`); re-run → auto-enrol
→ the returning family pays at the returning price while a new family waits
for the public opening (`x-30`); a payment after the hold lapsed →
`paid_no_seat` → a credit (`x-40`); a cancelled class → credits, notices and
the credit at the next checkout, then one reminder per family (`x-50`); the
facilitator's roster-only role (`x-60`); staged scripts and private files
(`x-70`).

## Related documents

- [OWNER-GUIDE.md](OWNER-GUIDE.md) — for Camila: running terms, rosters,
  bookings, payments, the waitlist and emails, screen by screen.
- [DEPLOYMENT.md](DEPLOYMENT.md) — Cloudflare/Stripe/Resend setup, the
  staging Worker and database, DNS cutover, rollback.
- [MIGRATION.md](MIGRATION.md) — moving customers across from ClassForKids.
