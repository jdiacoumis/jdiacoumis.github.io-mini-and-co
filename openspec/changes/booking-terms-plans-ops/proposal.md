# Booking: terms, payment plans and owner operations

## Why

The `in-house-booking` change built the platform — one Cloudflare Worker + D1, magic-link sign-in, child profiles, per-session capacity, hosted Stripe Checkout, an admin portal, CSV migration and a first-party Meta funnel — but it models the business as it was in June 2026: $25 per session, no term as a priced unit, no waitlist, no instalments, and almost none of the day-to-day owner operations ClassForKids provides. Since then the business sells six- to ten-week terms with a casual per-class price, runs a waitlist, gives returning families an early-bird window and price, issues vouchers and class credits, and wants weekly payment plans that debit automatically (a family who chose to "pay weekly" on the old system stopped turning up and nobody wanted to chase them). An adversarial review of the branch on 2026-10-13 also found payment-reconciliation and publishing defects that must be fixed before any deploy.

Interview with the owners (2026-10-13) settled the policy: terms must stay as flexible as ClassForKids (dates, length, price editable later); a trial is one casual-priced class per child followed by an offer of the rest of the term; the waitlist is per term and the owner picks who gets a seat; payment is by card through the business's own Stripe account, in full or by automatic instalments; refunds stay in the Stripe dashboard at launch; parents cannot cancel their own bookings at launch; a casual facilitator gets roster-only access; reminders, class-cancelled notices and bulk email go out by email only; Term 1 2027 opens on this system while ClassForKids runs out Term 4; DNS moves to Cloudflare and mail sends from the business domain via Resend; no sibling discount; age limits warn only.

## What Changes

- **Terms become first-class records**: a term belongs to a class (one weekly slot such as "Sensory Play — Wednesday 11:00 am"), has start/end dates, a term price, a casual price, an optional trial price, an optional returning-family price and window, an optional public opening time, and payment-plan options. Creating a term generates its weekly sessions (with holiday skip dates); sessions and prices stay editable afterwards. Joining a term after it has started is priced pro-rata on the remaining weeks.
- **Booking kinds**: `term`, `casual`, `trial` (one per child per class, casual/trial price, followed by an emailed offer of the remaining weeks) and `complimentary` (admin-only, nothing owed). A trial or casual booking holds a seat only in its own session; other families book later weeks over it.
- **Payment plans**: at checkout a term booking may be paid in full or in N weekly/fortnightly instalments debited automatically through a Stripe subscription that ends after the last instalment. Failed instalments are retried by Stripe, flagged for the owner, and never silently cancel the place.
- **Payment ledger**: every payment, instalment, offline payment, refund, credit and adjustment is a row; each booking carries what is owed, what is paid and a payment status. The owner can record a cash/bank-transfer payment and see at a glance who owes what.
- **Reconciliation made safe** (review findings): webhook events are marked handled only after they are handled; a payment that lands after a seat hold lapsed re-checks capacity before the booking is honoured and is otherwise flagged "paid, no seat"; the Stripe cancel page expires the Stripe session before releasing the seat; a "Check with Stripe" action and a "Needs attention" list let the owner resolve any mismatch without a developer.
- **Waitlist** per term: parents join when a term has no seat; the owner sees the list in join order, offers a seat (remaining term, trial or chosen weeks) with a timed hold, and the parent pays from their account. Offers that lapse release the seat.
- **Owner operations**: a term grid (families × weeks with paid/plan/unpaid and attendance), attendance marking on the roster, manual/phone bookings with offline payment or a pay-by link, transfers between sessions, cancelling a single week with an optional credit, credits and vouchers management, customer and child editing, re-run a term with auto-enrol and a returning-family window, cancelling a session with automatic notices and credits.
- **Staff role**: facilitators listed in `STAFF_EMAILS` sign in the same way and see only rosters and attendance.
- **Parent communications**: booking confirmation with the plan schedule, reminder the day before, class-cancelled notice, re-enrol invitation, waitlist offer, failed-instalment notice, offline-payment receipt, and owner-composed bulk email to a term's families. A cron trigger drives reminders, sweeps and cleanups.
- **Publishing**: static assets are served from an allow-listed `public/` folder built by a script, never from the repo root on disk.
- **Pixel**: loads only on the booking funnel pages; `Purchase` renders once per booking; Conversions API payloads carry the required fields.
- **Marketing pages are untouched** by this change: the Book now buttons keep pointing at ClassForKids until the DNS cutover change.
- **Schema re-baselined**: no production database exists, so `0001_init.sql` is rewritten to the new model and `0002_term_labels.sql` is removed.

## Capabilities

### New Capabilities

- `payment-plans`: instalment payment via Stripe subscriptions, ledger-backed payment status, failure handling and owner visibility.
- `waitlist`: per-term waitlist with owner-driven, time-limited seat offers.
- `parent-comms`: transactional and owner-composed emails with an idempotent send log and a scheduled trigger.
- `site-publishing`: allow-listed static asset staging for the Worker.

### Modified Capabilities

- `class-scheduling`: terms, per-class weekly slots, holiday skip dates, pro-rata pricing, term editing and re-run.
- `booking-flow`: booking kinds, term/casual/trial pricing, vouchers, credits, payment-plan choice, returning-family window, pay-later pending bookings, reconciliation guarantees.
- `admin-portal`: term grid, attendance, manual bookings, transfers, single-week cancellation, credits, vouchers, customer editing, needs-attention list, Check with Stripe, offline payments, staff access.
- `parent-auth`: `staff` role; admin/staff rights re-derived from the allowlists on every request.
- `conversion-tracking`: pixel scoped to funnel pages, Purchase once, CAPI payload fields.
- `customer-migration`: import enrolments by term.
- `booking-cta`: the switch of marketing CTAs to `/book/` is deferred to the cutover change; this change leaves the marketing pages as on `main`.

## Impact

- **Code**: `booking/` (schema, domain, pricing, ledger, payments driver, webhooks, cron, routes, emails, tests, docs), `css/booking.css`, `js/booking-*.js`, a new `booking/scripts/stage-assets.mjs`, `wrangler.toml` (assets dir, cron trigger, `STAFF_EMAILS`).
- **Third parties**: Stripe (Checkout in payment and subscription mode, subscriptions, refunds via dashboard, billing portal for card updates), Resend, Meta CAPI. The business needs its own Stripe account (owner action).
- **Marketing pages**: none.
- **Data**: new tables `terms`, `payments`, `credits`, `credit_redemptions`, `vouchers`, `waitlist`, `email_log`; `bookings` and `booking_sessions` gain money and attendance columns; `users.role` gains `staff`.
