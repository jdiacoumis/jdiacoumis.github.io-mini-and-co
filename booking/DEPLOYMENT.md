# Deployment — Cloudflare, Stripe, Resend, DNS cutover

The Worker serves the whole site (marketing pages as static assets + booking
app), so deploying it and pointing DNS at it replaces GitHub Pages. GitHub
Pages keeps serving the site until the DNS cutover in step 6, and remains the
instant rollback afterwards.

Run all `wrangler` commands from `booking/`.

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

## 2. Secrets

Set via `wrangler secret put <NAME>` (never in `wrangler.toml` or git):

| Secret | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API key (`sk_test_…` first, `sk_live_…` at go-live) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint (`whsec_…`) |
| `RESEND_API_KEY` | Resend transactional email |
| `META_CAPI_TOKEN` | Optional — Conversions API; omit to disable server-side events |

Plain vars (already in `wrangler.toml [vars]`): `ENVIRONMENT=production`,
`EMAIL_DRIVER=resend`, `PAYMENTS_DRIVER=stripe`, `PUBLIC_BASE_URL`,
`EMAIL_FROM`, `ADMIN_EMAILS` (comma-separated admin sign-in addresses),
`META_PIXEL_ID`, `WAIVER_VERSION`.

## 3. Stripe

1. Create a Stripe account (business details, BSB/account for payouts —
   owner action).
2. Stay in **test mode** until step 5 has been verified end to end.
3. Developers → Webhooks → Add endpoint:
   - URL: `https://<your-worker>.workers.dev/api/stripe/webhook` (update to
     the real domain after cutover, or register both).
   - Events: `checkout.session.completed` and `checkout.session.expired`.
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Test cards: `4242 4242 4242 4242`, any future expiry/CVC.

## 4. Resend

1. Create a Resend account and add the domain
   `miniandcosensoryclasses.com` (Domains → Add).
2. Add the DNS records Resend lists (SPF + DKIM TXT/CNAME) in Cloudflare DNS —
   owner action; verification usually completes within the hour.
3. Create an API key → `RESEND_API_KEY`. Mail sends from
   `bookings@miniandcosensoryclasses.com` (see `EMAIL_FROM`).

## 5. Staging deploy and verification

```bash
npx wrangler deploy        # deploys to <name>.workers.dev
```

Note: `PUBLIC_BASE_URL` is used in emails and Stripe return URLs. For staging
verification, temporarily set it to the `workers.dev` URL (and back before the
production deploy), or test with that caveat in mind.

Verify on the `workers.dev` URL with Stripe in test mode:

1. Marketing pages render; `/booking/src/index.js` and `/openspec/…` are 404.
2. Sign in via magic link (real email through Resend).
3. Add a child → book a session → pay with a test card → confirmation page
   flips to paid; confirmation email arrives; the booking shows paid in
   `/admin/bookings`; the webhook shows 200s in Stripe's dashboard.
4. Admin: create a class + repeating sessions, check the roster, export CSVs.
5. Run the customer migration (see MIGRATION.md) — still on test data if you
   prefer, the import is idempotent and re-runnable.

## 6. Go-live and DNS cutover

1. Switch Stripe to live mode: replace `STRIPE_SECRET_KEY` and create a live
   webhook endpoint for `https://miniandcosensoryclasses.com/api/stripe/webhook`
   (new `STRIPE_WEBHOOK_SECRET`).
2. Confirm `PUBLIC_BASE_URL=https://miniandcosensoryclasses.com` and
   `npx wrangler deploy`.
3. In the Cloudflare dashboard → Workers → your Worker → **Domains & Routes**:
   add the custom domain `miniandcosensoryclasses.com` (and `www` if wanted).
   Cloudflare creates the DNS records on the zone; remove/disable the old
   GitHub Pages `A`/`CNAME` records for the apex.
4. Smoke-test the production domain (marketing pages, one real $25 booking —
   refund it from the Stripe dashboard afterwards if it was a test).
5. Announce the change-over on Instagram; cancel ClassForKids after the last
   migrated term (see MIGRATION.md).

## 7. Rollback

- **Instant**: point the apex DNS records back at GitHub Pages (the records
  removed in step 6.3) — the static site is fully functional without the
  Worker; only booking pauses.
- **Data**: nothing is lost — D1 keeps all accounts/bookings; admin CSV
  exports (`/admin/bookings`, per-session rosters) provide an offline copy at
  any time. `wrangler d1 export miniandco-booking --remote --output=backup.sql`
  takes a full database backup; do this before risky changes.

## Operations notes

- **Logs**: Workers Logs are enabled (`[observability.logs]`); events are
  structured JSON with PII masked.
- **Migrations**: new schema changes go in `booking/migrations/000N_*.sql`,
  applied with `wrangler d1 migrations apply miniandco-booking --remote`.
- **Webhook outage**: confirmation pages poll booking status and Stripe
  retries webhooks for days; a booking stuck `pending` after a real payment
  can be marked paid from `/admin/bookings` once verified in Stripe.
