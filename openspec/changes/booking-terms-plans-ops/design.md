# Booking: terms, payment plans and owner operations — Design

## Context

Builds on the `in-house-booking` change (same branch). Platform facts that stay true: one Worker serves the marketing site as static assets plus `/book`, `/account`, `/admin`, `/api`; D1 (SQLite) with no interactive transactions, so multi-statement writes are `batch()` (atomic) with the `txn_guards` CHECK trick for conditional rollback; plain JavaScript, zero runtime dependencies, server-rendered HTML through the auto-escaping `html` template; magic-link auth; hosted Stripe Checkout; Resend email; Australia/Sydney rendering of UTC instants.

The business: two Wednesday classes (11:00 am and 1:00 pm), 12 families each, terms of 6–10 weeks priced per term ($168 for 6 weeks in Term 4 2026) with a casual price per class ($30), a returning-family early price and window, trial classes, vouchers, giveaway class packs, a 48-hour cancellation policy with credits and make-ups at the owner's discretion, and a casual facilitator joining. ClassForKids is kept through Term 4 2026 (ends 18 November); Term 1 2027 opens on this system.

## Goals / Non-Goals

**Goals**
- Model terms, booking kinds and money the way the business actually sells, with the flexibility ClassForKids gives (edit dates, weeks, prices later).
- Automatic instalments with no manual chasing, and a ledger that makes "who owes what" a glance.
- Every money/seat mismatch is visible and fixable by the owner from the admin portal.
- A trial or casual booking holds one seat in one session only.
- Owner can run a term without James: schedule, grid, attendance, manual bookings, transfers, credits, waitlist, emails.
- Safe publishing: nothing outside an allow-list is ever served.

**Non-Goals**
- Parent self-service cancellation (owner only at launch).
- In-app refunds (Stripe dashboard; the ledger records refunds from the webhook).
- SMS; sibling discounts; a parent app.
- Switching the marketing CTAs (separate cutover change).
- BECS Direct Debit (possible later: Checkout `payment_method_types`; cards only now).

## Decisions

### D1. A class is one weekly slot; a term belongs to a class
`classes` = "Sensory Play — Wednesday 11:00 am" (weekday + start time + defaults). `terms` = a dated, priced run of that slot: `starts_on`, `ends_on`, `term_price_cents`, `casual_price_cents`, `trial_price_cents` (NULL → casual), `returning_price_cents` + `returning_opens_at`, `public_opens_at`, `previous_term_id`, `plan_instalments`, `plan_interval`, `status` draft|open|closed. Creating a term generates one `class_sessions` row per week from the class's weekday/time, skipping holiday dates, each with `term_id`, the class defaults and the term's casual price. Sessions remain individually editable (time, capacity, price, cancel), and weeks can be added or removed later; price edits never change existing bookings. The waitlist, the grid and re-run all key off the term. Two slots on the same day are two classes with two terms — the admin "create term" form can create both at once ("also create for: ☑ Wednesday 1:00 pm").

### D2. Booking kinds and seat holding
`bookings.kind` ∈ term | casual | trial | complimentary. A booking has one `booking_sessions` row per session it covers; a row holds a seat when `status = 'booked'` and the booking is confirmed or pending-unexpired. This is the ONLY definition of a held seat, implemented once in `lib/domain.js` (`heldSeatsSql(alias)`) and used by every count, guard, list and grid. Term bookings cover every remaining scheduled session of the term at booking time; casual covers chosen sessions; trial covers exactly one session and a child may hold at most one trial per class (`kind='trial'` and `status IN (confirmed, pending-unexpired)`). Cancelling a single week sets that row to `cancelled`; transferring sets it to `transferred_out` and inserts a `booked` row for the target session (guarded by capacity and the child-not-already-in-session rule). Cancelling a whole booking sets `bookings.status='cancelled'` (its rows stop holding seats without being touched).

### D3. Pricing (`lib/pricing.js`, pure functions, unit-tested)
- Term, full: `term_price_cents` when booked before the first session starts. Returning price applies when the family (any child of the account) has a confirmed `term` booking in `previous_term_id` and `now ≥ returning_opens_at`. Nobody can book before `returning_opens_at` (returning) or `public_opens_at` (everyone); NULL means open.
- Term, after start: pro-rata on remaining scheduled sessions: `round(price × remaining / total_scheduled)` where `total_scheduled` counts non-cancelled sessions of the term. Shown as "Join for the remaining N weeks".
- Casual: `class_sessions.casual_price_cents` per session. Trial: `terms.trial_price_cents ?? casual`.
- Vouchers: `amount` or `percent`, `applies_to` any|term|casual, validity window, max uses; applied before credits; never below zero.
- Credits: the account's unexpired, non-voided credits (matching child or any-child) are applied automatically up to the balance; redemptions are recorded in `credit_redemptions` inside the booking batch; a cancelled/expired pending booking returns its redemptions (sweep and cancel paths must reverse them).
- Instalments: `n = plan_instalments` (term bookings only, including pro-rata; n ≤ remaining weeks); `each = floor(total / n)`, `first = total − each × (n − 1)`. The schedule and the first-payment amount are shown before checkout.

### D4. Payment plans on Stripe subscriptions
Checkout Session `mode=subscription` with a recurring `price_data` (`unit_amount = each`, `recurring[interval] = week`, `interval_count` 1 or 2 for fortnight) plus, when `first > each`, a one-off line item for the remainder billed on the first invoice. `subscription_data[metadata][booking_id]`, `client_reference_id = booking id`, `customer` reused from `users.stripe_customer_id` (created on first checkout via `customer_creation=always`/`customer` on retrieve). On `checkout.session.completed`: store `stripe_subscription_id`, set the subscription's `cancel_at` to `start + (n − 1) × interval + 12 hours` so exactly n invoices are raised, confirm the booking (guarded, see D6). `invoice.paid` → ledger row (`kind='instalment'`, `provider_ref = invoice id`) and `plan_next_charge_at`; `invoice.payment_failed` → `payment_status='plan_overdue'`, `needs_attention='plan_overdue'`, parent email via `notifyPlanFailed`; `customer.subscription.deleted` → `plan_complete` if `paid_cents ≥ amount_cents`, else `needs_attention='plan_ended_short'`. Stripe Smart Retries and its own dunning emails stay on (dashboard setting, documented). The place is never auto-cancelled on failure: the owner decides from Needs attention. "Update card" on the account page opens a Billing Portal session (`POST /v1/billing_portal/sessions`). Pay-in-full term bookings and casual/trial use `mode=payment` as before (ledger `kind='checkout'`, `provider_ref = payment_intent`). Mock driver mirrors all of this with a dev page to simulate the next instalment succeeding or failing.

### D5. Ledger
`payments` is append-only; `bookings.paid_cents` and `payment_status` are derived by `lib/ledger.js: recomputeBooking(env, bookingId)` after every insert. `provider_ref` is UNIQUE so webhook retries and admin "Check with Stripe" are idempotent. Offline payments (`kind='offline'`, method, note, `recorded_by`) and adjustments (`kind='adjustment'`, signed) are admin actions with CSRF. Refunds come from `charge.refunded` (negative `kind='refund'`), recorded even though they are issued in the Stripe dashboard. Credits applied at checkout appear as `kind='credit_applied'` so the ledger always sums to what was owed.

### D6. Reconciliation guarantees (review findings)
- Webhook: `INSERT INTO webhook_events (event_id, status='processing')`; if a row exists with `status='done'` → replay, 200; if it exists as `processing`/`failed` older than 2 minutes → reprocess. On handler success set `done`; on exception set `failed` and return 500 so Stripe retries. All state changes inside a handler go through `batch()`.
- Confirming a booking whose status is `expired` (payment landed after the 35-minute hold) re-runs the guarded seat insert for each of its `booked` rows (capacity excluding this booking; child not already in the session). Success → confirmed. Failure → the ledger row is still recorded, `needs_attention='paid_no_seat'`, status stays `expired`, owner emailed; the parent's confirmation page says the owner will be in touch, never "no payment was taken".
- Payment for a cancelled booking → ledger row + `needs_attention='paid_after_cancel'`.
- `/book/cancelled` calls `expireCheckout(payment_ref)` on the driver before releasing the seat, so the Stripe tab can no longer pay. Checkout `expires_at` = 31 minutes (Stripe's minimum is 30); the seat hold stays 35.
- Admin "Check with Stripe": retrieves the Checkout Session (and subscription if any); `paid` → confirm through the guarded path and record the ledger row; `expired`/`unpaid` → expire the booking; result shown to the owner. "Mark paid" becomes "Record offline payment" and works on pending or expired bookings through the same guarded confirm.
- Needs attention list: `needs_attention IS NOT NULL` plus pending bookings with `payment_ref` older than 40 minutes, with the actions above and a "Resolve" that clears the flag with a note.

### D7. Waitlist
`waitlist` rows per (term, child), `status` waiting|offered|booked|declined|removed. Parents join from the class list when the term has no seat for the remaining weeks (or the trial slot is full). Owner offers from `/admin/terms/:id/waitlist`: choose remaining term / trial / chosen weeks and price (defaults from the term); this creates a pending booking with `expires_at = now + 48 h`, links it (`offer_booking_id`), sets `status='offered'`, and emails the parent: sign in → account → Pay now. Cron `expireOffers` returns lapsed offers to `waiting` (and the pending booking to `expired`, releasing the seat). Paying flips the entry to `booked`. Capacity override is simply editing the session capacity.

### D8. Owner operations
- **Term grid** `/admin/terms/:id`: rows = bookings with any `booked` row in the term (child, parent), columns = sessions; cell = present ✓ / absent ✗ / booked · / cancelled – / blank; payment column from the ledger ("Paid", "Plan 3 of 6 · next 12 Feb", "Overdue $56", "Unpaid $168", "Comp"); seats left per column; CSV export; links to the roster and to the booking.
- **Roster** `/admin/sessions/:id/roster`: attendance toggles (POST per child, CSRF, 44 px targets), current profile beside the snapshot with the stricter consent shown, contact details; staff role may open and mark only this page.
- **Manual booking** `/admin/bookings/new`: find parent by email or create parent + child inline; kind; term (full/remaining) or chosen sessions; price override; payment: record offline now / pay-later (pending, 7-day hold, email with Pay now) / complimentary.
- **Transfers, single-week cancel, credits, vouchers, customers, notes**: see D2, D3, D5. Credits issued on single-week cancel default to the per-week rate (`amount_cents / weeks covered`).
- **Session cancel** (owner): reason; every term family gets a credit for that week automatically and an email; casual/trial bookings for that session are cancelled with credit; the cron reminder skips cancelled sessions.
- **Re-run a term**: form prefilled from the source term (name +1 term, dates shifted, same prices and plan options), creates the new term (draft) and sessions; "Auto-enrol" lists families with confirmed term bookings in the source (trial/casual excluded by default), creates pending bookings at the returning price with `expires_at = public_opens_at` (or 7 days), and sends re-enrol emails; the owner opens the term when ready.

### D9. Roles
`ADMIN_EMAILS` and new `STAFF_EMAILS` are env allowlists. `requireAdmin`/`requireStaff` re-derive the right from the allowlist on every request (removal is immediate); the stored `users.role` is a cache for display. Staff may `GET /admin/sessions/:id/roster` and `POST .../attendance` only; everything else under `/admin` is admin-only. Denials are logged.

### D10. Communications and cron
`lib/notify.js` + `lib/emails/*.js` build messages; every send writes `email_log` with a `dedupe_key` (e.g. `reminder:<session>:<booking>`), so jobs can re-run safely. `wrangler.toml` `[triggers] crons = ["*/15 * * * *"]`; `scheduled()` runs the registry in `lib/cron.js`: `sweepExpiredBookings` (also reverses credit redemptions), `expireOffers`, `sendReminders` (sessions starting in 20–28 h, confirmed bookings, booked rows, scheduled sessions), `trialFollowUps` (day after an attended/past trial, once), `overdueNudges` (every 7 days while `plan_overdue`), `purge` (tokens, sessions, rate limits, webhook events > 30 days). Bulk email: owner composes subject/body for a term's families (or the waitlist); sent one by one with the log.

### D11. Publishing
`booking/scripts/stage-assets.mjs` (Node, no deps) copies `index.html classes.html about.html contact.html css/ js/ assets/ robots.txt sitemap.xml` from the repo root into `booking/public/` (gitignored), deleting anything else there. `wrangler.toml` `[assets] directory = "public"`. `npm run dev` and `npm run deploy` run it first. The repo-root `.assetsignore` is removed. E2E asserts the private paths are 404.

### D12. Pixel and CAPI
`booking-pixel.js` is included only by pages under `/book` (the layout takes a `pixel: true` option). `Purchase` data attributes render only when `purchase_tracked_at IS NULL`, and the same request sets it. CAPI events carry `action_source=website`, `event_source_url`, `user_data.client_user_agent`, `client_ip_address`, hashed `em`/`ph`, `event_id = booking id`, Graph API version pinned to the current one at implementation time.

### D13. Schema re-baseline
No production database exists, so `0001_init.sql` is rewritten and `0002_term_labels.sql` removed. Future changes add `000N_*.sql`.

## Implementation plan and file ownership

Phase 1 (one agent, on the branch): tasks 1.x. It leaves `index.js` and `html.js` complete for Phase 2 (route skeletons, nav entries, layout options) and the e2e runner modular (`test/e2e/journeys/*.js`).

Phase 2 (three agents in separate worktrees branched from the Phase 1 result), each confined to the files listed in `tasks.md` §2A/§2B/§2C plus new files under `lib/emails/`, `test/unit/<area>-*.test.js`, `test/e2e/journeys/<area>-*.js`, and appends to `css/booking.css` in a marked section. Shared files (`index.js`, `html.js`, `domain.js`, `pricing.js`, `ledger.js`, `payments-driver.js`, `webhooks.js`, `middleware.js`, migrations) are frozen in Phase 2; a needed interface is added as a new file and reported.

Phase 3: merge, integration e2e, adversarial review, fixes, PR description, push.

## Risks / Trade-offs

- [Stripe subscriptions for instalments] → one more object to reconcile; mitigated by the ledger keyed on invoice ids and the Needs-attention list. Alternative (saved card + scheduled off-session charges) would put retries and SCA handling on us.
- [cancel_at timing] → verified in test mode with a short interval before go-live; Stripe raises the final invoice before `cancel_at`.
- [D1 batch atomicity] → unchanged pattern, now with reverse operations (credit redemptions) inside the same batch.
- [Pro-rata and weekly prices that don't divide] → integer maths with the remainder on the first instalment; unit-tested.
- [Email quota] → `email_log` makes resends safe; reminders are the biggest volume (~24/week).
- [Owner complexity] → `OWNER-GUIDE.md` and plain-language admin copy; every destructive admin action confirms and is reversible (restore booking, void credit, reopen term).

## Migration Plan

Unchanged from `in-house-booking` (deploy to workers.dev, Stripe test mode, verify, import, DNS cutover) with additions: the owner creates the business's own Stripe account; the webhook endpoint subscribes to `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`; Billing Portal default configuration enabled; `STAFF_EMAILS` set; cron trigger deployed. Import: Term 1 2027 families are created from the ClassForKids export with no enrolments (Term 4 finishes on ClassForKids); re-enrol invitations then go out from the new system.

## Open Questions

- BECS Direct Debit as a second payment method for plans (lower fees, slower settlement) — later.
- Whether `plan_interval` fortnight is wanted at launch (schema supports it; UI shows weekly only unless the term enables it).
