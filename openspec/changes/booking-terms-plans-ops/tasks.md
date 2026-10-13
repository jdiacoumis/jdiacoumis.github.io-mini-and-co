## 0. Spec and baseline (done by the spec author)

- [x] 0.1 Merge `origin/main` into the branch, keeping main's four marketing pages (CTAs stay on ClassForKids until cutover)
- [x] 0.2 Re-baseline `booking/migrations/0001_init.sql` to the new data model; remove `0002_term_labels.sql`; rewrite `booking/seed/dev-seed.sql`
- [x] 0.3 Write this change's proposal, design, specs and tasks

## 1. Core (Phase 1 — one agent, on the branch)

- [x] 1.1 Asset staging: `booking/scripts/stage-assets.mjs` copies the allow-list into `booking/public/` (gitignored); `wrangler.toml` serves `public`; `npm run dev`/`deploy` stage first; e2e asserts `/business/*`, `/.DS_Store`, `/.dev.vars`, `/CLAUDE.md`, `/booking/*`, `/openspec/*` are 404
- [x] 1.2 Domain refactor to the new schema: ONE seat-holding SQL fragment (`booking_sessions.status='booked'` + confirmed-or-unexpired-pending) used by every count; terms; booking kinds; `booking_sessions` status; helpers for term sessions remaining, seats per session, child-already-booked
- [x] 1.3 `lib/pricing.js`: term quote (full / remaining-weeks pro-rata / returning price / casual / trial), voucher validation and application, credit application, instalment schedule maths; unit tests
- [x] 1.4 `lib/ledger.js`: `recordPayment` (idempotent on `provider_ref`), recompute `paid_cents`/`payment_status`, credit issue/redeem, voucher use counting; unit tests
- [x] 1.5 Payments driver: Stripe Checkout in `payment` and `subscription` mode (recurring price_data + one-off first-instalment remainder line), `expireCheckout`, `retrieveCheckout`, `retrieveSubscription`, `setSubscriptionCancelAt`, `createBillingPortalSession`, customer reuse via `users.stripe_customer_id`; mock driver with the same surface plus dev "simulate next instalment / fail instalment" controls
- [x] 1.6 Webhooks: event id stored before processing and deleted on failure (retry is a replay only when the stored event is `done`); handle `checkout.session.completed` (both modes), `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`; confirm-after-expiry re-runs the guarded seat insert and otherwise flags `paid_no_seat`; payment after admin cancel flags `paid_after_cancel`; unit tests for the ordering and the guarded confirm
- [x] 1.7 Security follow-ups: `safeNextPath` rejects control characters and resolves same-origin; pixel script only on `/book*` pages; `Purchase` rendered once (`purchase_tracked_at`); CAPI payload has `action_source`, `event_source_url`, `client_user_agent`, `client_ip_address`, current Graph API version; admin and staff rights re-derived from `ADMIN_EMAILS`/`STAFF_EMAILS` on every request; unknown `EMAIL_DRIVER` throws
- [x] 1.8 Scheduled handler (`[triggers] crons`) in `lib/cron.js` with a job registry: sweep lapsed holds, expire lapsed waitlist offers, purge old tokens/sessions/rate-limit rows/webhook events; `lib/notify.js` stub (`notifySessionCancelled`, `notifyPlanFailed`, `sendTemplate`) for Phase 2 to fill
- [x] 1.9 Route skeletons so Phase 2 agents never touch `index.js`/`html.js`: `routes/waitlist.js`, `routes/admin-terms.js`, `routes/admin-ops.js`, `routes/admin-waitlist.js`, `routes/admin-email.js`, each exporting `registerRoutes(route)`; admin nav gains Terms, Waitlist, Email, Needs attention; e2e runner made modular (`test/e2e/run.js` loads `test/e2e/journeys/*.js`)
- [x] 1.10 Existing routes compile and work against the new schema (class list grouped by term with the right prices, admin sessions/classes with `term_id`, bookings list with payment columns, import by term); seed loads; unit and e2e suites green

## 2. Features (Phase 2 — three agents in parallel worktrees)

### 2A Parent flow (owns `routes/booking.js`, `routes/account.js`, `routes/waitlist.js`, `lib/emails/parent.js`, `js/booking-*.js`, parent section of `css/booking.css`)
- [ ] 2A.1 Class list: terms with term price, "join for the remaining N weeks" pro-rata once started, casual per-session, one trial per child per class, returning-family window and price, opening times honoured, waitlist join when a term has no seat
- [ ] 2A.2 Checkout: pay in full or instalment plan (schedule shown), voucher field, credits auto-applied, zero-balance confirms without payment, pending-with-pay-later bookings show "Pay now"
- [ ] 2A.3 Confirmation and account: payment status, instalments paid/next charge, "Update card" via billing portal, credits balance, waitlist entries, booking history; Purchase once
- [ ] 2A.4 Emails: confirmation with plan schedule; trial follow-up offer the day after the trial (cron job registered via `lib/cron.js`)

### 2B Admin operations (owns `routes/admin.js`, `routes/admin-bookings.js`, `routes/admin-terms.js`, `routes/admin-ops.js`, `routes/admin-import.js`, `lib/admin-ops.js`, `lib/csv.js`, admin section of `css/booking.css`)
- [x] 2B.1 Terms: create (dates, weeks, holiday skip dates, prices, plan options, opening windows) generating sessions; edit term and sessions later (add/remove weeks, change prices for future bookings only); close
- [x] 2B.2 Re-run a term: copy from a previous term with new dates/prices; auto-enrol current families as pending bookings held until the returning window closes, with re-enrol emails; trial/casual families excluded by default
- [x] 2B.3 Term grid: families × weeks, attendance marks, payment column (paid / plan k of n / overdue / unpaid, amount owing), seats left per week; CSV export
- [x] 2B.4 Roster: attendance marking with big touch targets; current profile shown beside the booking snapshot (stricter consent wins); staff may view and mark
- [x] 2B.5 Manual booking: existing or new parent and child, kind, term/remaining/sessions, offline payment recorded now or pay-later link (7-day hold); complimentary bookings
- [x] 2B.6 Transfers (one session to another with a seat), cancel one week with optional credit, cancel whole booking; credits list; vouchers CRUD; record offline payment; customer and child edit; admin notes
- [x] 2B.7 Needs-attention list and "Check with Stripe" (retrieve checkout/subscription and reconcile through the guarded path); cancel a session (reason) calling `notifySessionCancelled` and issuing credits to term families

### 2C Waitlist admin, comms, docs (owns `routes/admin-waitlist.js`, `routes/admin-email.js`, `lib/notify.js`, `lib/emails/ops.js`, cron jobs for reminders/overdue/offers, `booking/OWNER-GUIDE.md`, `README.md`, `DEPLOYMENT.md`, `MIGRATION.md`)
- [x] 2C.1 Waitlist admin: list per term in join order, offer (remaining term / trial / chosen weeks) creating a held pending booking with a 48-hour expiry and an email, remove, mark declined; lapsed offers release the seat and return the entry to waiting
- [x] 2C.2 Emails and templates: reminder the day before (idempotent via `email_log`), session cancelled (with credit note), re-enrol invitation, waitlist offer, failed instalment, offline-payment receipt; bulk email to a term's families composed by the owner
- [x] 2C.3 Cron jobs: reminders, overdue nudges, offer expiry; email log view in admin
- [x] 2C.4 Docs: `OWNER-GUIDE.md` for Camila (plain language, screen by screen), README/DEPLOYMENT (own Stripe account, subscription webhooks, billing portal, cron, `STAFF_EMAILS`, `public/` staging) and MIGRATION (terms-based import) updates

## 3. Integration and verification (Phase 3)

- [ ] 3.1 Merge the three Phase 2 branches; unit and e2e suites green; cross-feature e2e journeys (plan + transfer, waitlist offer → pay, re-run → returning family pays at returning price, late payment after hold → seat re-check)
- [ ] 3.2 Adversarial review across lenses (authz incl. staff role, CSRF, webhook ordering, money maths, DST) and fixes
- [ ] 3.3 PR description rewritten; branch pushed

## 4. Owner actions before staging (not code)

- [ ] 4.1 Create the business's own Stripe account; test-mode keys and a webhook endpoint for `checkout.session.*`, `invoice.*`, `customer.subscription.deleted`, `charge.refunded`
- [ ] 4.2 Cloudflare account, zone and D1; Resend domain verification; `ADMIN_EMAILS`/`STAFF_EMAILS`
