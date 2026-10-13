# Deployment — Cloudflare, Stripe, Resend, DNS cutover

The Worker serves the whole site (marketing pages as static assets + booking
app), so deploying it and pointing DNS at it replaces GitHub Pages. GitHub
Pages keeps serving the site until the DNS cutover in step 7, and remains the
instant rollback afterwards.

Run all `wrangler` commands from `booking/`. Items marked **(check)** are
dashboard menu names that Stripe or Cloudflare may have renamed; the setting
itself is what matters.

## 1. Cloudflare account and Worker

1. Create/log in to a Cloudflare account (free plan is sufficient) and add the
   `miniandcosensoryclasses.com` zone (Cloudflare will list the nameservers to
   set at the registrar — doing this early lets DNS settle before cutover;
   keep the existing GitHub Pages DNS records when importing).
2. Authenticate wrangler: `npx wrangler login`.
3. Create the production database and wire it up:

   ```bash
   npx wrangler d1 create miniandco-booking
   # paste the returned database_id into wrangler.toml ([[d1_databases]])
   npx wrangler d1 migrations apply miniandco-booking --remote
   ```

## 2. Secrets and settings

Set via `wrangler secret put <NAME>` (never in `wrangler.toml` or git):

| Secret | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API key (`sk_test_…` first, `sk_live_…` at go-live) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint (`whsec_…`) |
| `RESEND_API_KEY` | Resend transactional email |
| `META_CAPI_TOKEN` | Optional — Conversions API; omit to disable server-side events |

Plain vars (in `wrangler.toml [vars]`):

| Var | Purpose |
| --- | --- |
| `ENVIRONMENT` | `production` (the mock payments driver, console email driver and `/dev/*` pages refuse to run otherwise) |
| `EMAIL_DRIVER` / `PAYMENTS_DRIVER` | `resend` / `stripe` (an unknown value fails closed) |
| `PUBLIC_BASE_URL` | The site's address, used in every email link (account, Pay now, Update card) and in Stripe return URLs |
| `EMAIL_FROM` | `Mini & Co. <bookings@miniandcosensoryclasses.com>` — must be a verified Resend domain (it need not receive mail — see `EMAIL_REPLY_TO`) |
| `EMAIL_REPLY_TO` | Where families' replies go: every email carries this Reply-To (`miniandco.classes@gmail.com`). Blank = the first `ADMIN_EMAILS` address (step 4) |
| `ADMIN_EMAILS` | Comma-separated admin sign-in addresses (the owner) |
| `STAFF_EMAILS` | Comma-separated facilitators: rosters and attendance only |
| `META_PIXEL_ID`, `WAIVER_VERSION` | Pixel id; version string of the current waiver text |

Both allowlists are re-checked on every request, so adding or removing an
address takes effect on that person's next click — edit `wrangler.toml` and
`npm run deploy`. Admins are alerted by email (needs attention, failed
instalments, class-cancelled summaries) at every `ADMIN_EMAILS` address.

## 3. Stripe — the business's own account

1. **Owner action**: create a Stripe account for the business itself (ABN,
   business details, the bank account for payouts) — not a personal or
   developer account. Invite James as a team member with developer access so
   he can create keys and webhooks without owning the account.
2. Stay in **test mode** until step 6 has been verified end to end.
3. **Webhook** — Developers → Webhooks → Add endpoint (check):
   - URL: `https://<your-worker>.workers.dev/api/stripe/webhook` (update to
     the real domain after cutover, or register both).
   - Events — exactly these six:
     `checkout.session.completed`, `checkout.session.expired`,
     `invoice.paid`, `invoice.payment_failed`,
     `customer.subscription.deleted`, `charge.refunded`.
     (Pay-in-full checkouts and the first instalment arrive through the
     checkout and invoice events; later instalments through `invoice.*`;
     the end of a plan through `customer.subscription.deleted`; refunds made
     in the dashboard through `charge.refunded`.)
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Customer portal** (where "Update card" on the account page goes) —
   Settings → Billing → Customer portal (check): activate the default
   configuration and set:
   - **Payment methods: allow customers to update** — on.
   - **Cancel subscriptions: off.** Families can't cancel bookings
     themselves; a cancelled plan would only show up as "plan ended short".
   - **Switch plans / update quantities: off.**
   - Business information: name, Terms & Conditions and privacy links.
   The portal configuration is separate in test and live mode — set both.
5. **Failed payments** — Settings → Billing → Revenue recovery (check):
   - **Smart Retries: on** (Stripe's recommended schedule, about 8 tries over
     2 weeks). The booking keeps its place throughout; the family is emailed
     once per failed instalment and weekly while overdue, and the owner sees
     it under Needs attention.
   - **If all retries fail: cancel the subscription.** The booking is then
     flagged "Instalment plan ended before the full amount was paid" for the
     owner to sort out (she can record the rest as an offline payment).
   - Stripe's own customer emails for failed payments and expiring cards can
     stay on; ours are separate and say the same thing.
6. **Payment methods**: cards only at launch (Settings → Payment methods).
7. **Test cards**: `4242 4242 4242 4242` (succeeds), `4000 0027 6000 3184`
   (needs 3-D Secure), `4000 0000 0000 0341` (saves, then fails when charged
   — use it to test a failed instalment); any future expiry and CVC.
8. **Refunds** are made in the Stripe dashboard (Payments → the payment →
   Refund); `charge.refunded` records them in the booking's ledger.

## 4. Resend and replies

1. Create a Resend account and add the domain
   `miniandcosensoryclasses.com` (Domains → Add).
2. Add the DNS records Resend lists (SPF and DKIM; Resend puts its sending
   records on a `send.` subdomain) in Cloudflare DNS — owner action;
   verification usually completes within the hour. A DMARC record
   (`_dmarc`, `v=DMARC1; p=none; rua=mailto:miniandco.classes@gmail.com`)
   helps deliverability.
3. Create an API key → `RESEND_API_KEY`. Mail is sent from `EMAIL_FROM`
   (`bookings@miniandcosensoryclasses.com`).
4. **Make replies reach Camila.** Families are told to "reply to this email"
   (confirmations, reminders, class-cancelled notices, waitlist offers,
   pay-later holds, failed payments). Every email the system sends carries a
   **Reply-To** of `EMAIL_REPLY_TO` (`miniandco.classes@gmail.com` in
   `wrangler.toml`; blank falls back to the first `ADMIN_EMAILS` address), so
   replies land in the Gmail inbox even though `bookings@…` sends them. To
   also catch people who write to `bookings@…` directly (optional):
   Cloudflare dashboard → the zone → **Email → Email Routing** (check) →
   enable, then add a route `bookings@miniandcosensoryclasses.com` →
   `miniandco.classes@gmail.com` (verify the Gmail address when asked).

## 5. Scheduled jobs (cron)

`wrangler.toml` has `[triggers] crons = ["*/15 * * * *"]`, deployed with the
Worker — nothing else to set up. Every 15 minutes `scheduled()` runs, in
order: `sweepExpiredBookings`, `expireOffers` (the owner is emailed about
each lapsed offer), `purge`, `trialFollowUps`, `sendReminders`,
`overdueNudges`, `reconcileWaitlist` (README → Scheduled jobs). Every job is
idempotent, so a missed or doubled run is
harmless; reminders go out 20–28 hours before a class, so an outage shorter
than 8 hours loses none.

After deploying, check Workers → the Worker → Settings → Triggers (check)
lists the cron, and Workers Logs show `cron_job_done` lines every 15 minutes
(`cron_job_failed` names any job that threw).

## 6. Staging deploy and verification

```bash
npm run deploy             # stages booking/public, then deploys to <name>.workers.dev
```

Always deploy with `npm run deploy` (or run `npm run stage` first): the Worker
serves static files only from `booking/public`, which
`scripts/stage-assets.mjs` rebuilds from the allow-list (`index.html`,
`classes.html`, `about.html`, `contact.html`, `css/`, `js/`, `assets/`,
`robots.txt`, `sitemap.xml`; dotfiles, symlinks and files over 25 MiB
skipped). A plain `wrangler deploy` would publish whatever `public/` last
held. To publish a new top-level file, add it to `ALLOW_LIST` in that script.

Note: `PUBLIC_BASE_URL` is used in emails and Stripe return URLs. For staging
verification, temporarily set it to the `workers.dev` URL (and back before the
production deploy), or test with that caveat in mind.

Verify on the `workers.dev` URL with Stripe in test mode:

1. Marketing pages render; `/booking/src/index.js`, `/openspec/…` and
   `/.dev.vars` are 404.
2. Sign in via magic link (real email through Resend); reply to it and check
   the reply reaches the Gmail inbox (the Reply-To, step 4.4).
3. Create a term (both classes), open it, and book it as a parent: pay in
   full with `4242…` → the confirmation page flips to paid, the confirmation
   email arrives, the booking shows Paid in the term grid, and the webhook
   shows 200s in Stripe's dashboard.
4. Book again choosing instalments: the schedule is shown, the first
   instalment is taken, the grid shows "Plan 1 of N". Test a failure with
   `4000 0000 0000 0341` (or Stripe's test clocks): the family gets "Payment
   didn't go through", the owner gets an alert, the booking is under Needs
   attention; "Update card" opens Stripe's portal without a cancel button.
   Then verify **the plan stops after exactly n instalments** — the
   subscription's `cancel_at` (set when the checkout completes, to the end of
   the n-th billing period: `planCancelAt` in `lib/pricing.js`) — with a
   short-interval run on a Stripe **test clock** before go-live:
   1. Make a test term with a **2-instalment** plan (Instalments 2, weekly)
      and a test family.
   2. Stripe dashboard (test mode) → Billing → **Test clocks** → new
      simulation, frozen at now → add a customer (the test family's email).
      Link it to the family so the checkout reuses it:
      `npx wrangler d1 execute miniandco-booking --remote --command "UPDATE users SET stripe_customer_id = 'cus_…' WHERE email = '…'"`.
   3. Book the term by instalments, pay with `4242…`. In Stripe the
      subscription shows **Cancels** on the first payment's date + 2 weeks;
      the grid shows "Plan 1 of 2".
   4. Advance the clock one week: the second invoice is paid →
      `invoice.paid` → the grid shows **Paid** (plan complete).
   5. Advance it past the cancel date (and a further week): the subscription
      is **cancelled** (`customer.subscription.deleted`, 200 in the webhook
      log) with **no third invoice and no proration** line on any invoice,
      and the booking stays complete (not "ended short").
   If Stripe raised an extra invoice, prorated the last one or ended the plan
   early, stop: `planCancelAt` must change (design D4's alternative is
   start + (n − 1) × interval + 12 hours) and this test be repeated.
5. Waitlist: fill a week (set its capacity to the bookings it has), join the
   waitlist as a parent, offer the place from `/admin/waitlist`, pay it from
   the account page; the entry shows Booked.
6. Reminders: add a session about 24 hours ahead with a confirmed booking;
   within 15 minutes the reminder arrives and appears once in
   `/admin/email/log`.
7. Email: send a bulk email to a term's families (just your own test
   families) and check each arrives once and is in the log.
8. Staff: add a test address to `STAFF_EMAILS`, sign in with it — rosters and
   attendance work, every other admin page is refused.
9. Run the customer migration (see MIGRATION.md) — still on test data if you
   prefer; the import is idempotent and re-runnable.

## 7. Go-live and DNS cutover

1. Switch Stripe to live mode: replace `STRIPE_SECRET_KEY`, create a live
   webhook endpoint for `https://miniandcosensoryclasses.com/api/stripe/webhook`
   with the same six events (new `STRIPE_WEBHOOK_SECRET`), and repeat the
   customer portal and Smart Retries settings in live mode.
2. Confirm `PUBLIC_BASE_URL=https://miniandcosensoryclasses.com` and
   `npm run deploy`.
3. In the Cloudflare dashboard → Workers → your Worker → **Domains & Routes**:
   add the custom domain `miniandcosensoryclasses.com` (and `www` if wanted).
   Cloudflare creates the DNS records on the zone; remove/disable the old
   GitHub Pages `A`/`CNAME` records for the apex.
4. Smoke-test the production domain (marketing pages, one real casual
   booking — refund it from the Stripe dashboard afterwards if it was a test).
5. Announce the change-over on Instagram; cancel ClassForKids after the last
   migrated term (see MIGRATION.md). Switching the marketing Book now buttons
   from ClassForKids to `/book` is a separate change.

## 8. Rollback

- **Instant**: point the apex DNS records back at GitHub Pages (the records
  removed in step 7.3) — the static site is fully functional without the
  Worker; only booking pauses.
- **Data**: nothing is lost — D1 keeps all accounts/bookings; admin CSV
  exports (`/admin/bookings`, per-session rosters, the term grid) provide an
  offline copy at any time.
  `wrangler d1 export miniandco-booking --remote --output=backup.sql`
  takes a full database backup; do this before risky changes.

## Operations notes

- **Logs**: Workers Logs are enabled (`[observability.logs]`); events are
  structured JSON with emails masked and ids shortened — never tokens, phone
  numbers, medical notes or email subjects.
- **Email problems**: `/admin/email/log` shows every email with its status;
  failed reminders and nudges are retried by the next cron run. Resend's
  dashboard shows delivery and bounces.
- **Migrations**: new schema changes go in `booking/migrations/000N_*.sql`,
  applied with `wrangler d1 migrations apply miniandco-booking --remote`.
- **Webhook outage**: confirmation pages poll booking status and Stripe
  retries webhooks for days. A booking stuck waiting after a real payment
  appears under **Needs attention** after 40 minutes; **Check with Stripe**
  replays Stripe's record through the webhook's own handlers (the same
  capacity-guarded confirmation, ledger rows keyed on Stripe ids, so nothing
  is recorded twice) — and for an instalment plan it lists the subscription's
  invoices and adds any paid instalment whose `invoice.paid` never arrived.
