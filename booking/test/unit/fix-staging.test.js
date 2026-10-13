// Review fix (task 3.2, finding 10): staging shared the production D1. The
// staging environment (wrangler.toml [env.staging]) now has its own
// database, address and ENVIRONMENT=staging — under which the mock payments
// driver, the console email driver and the /dev pages still refuse to run,
// while Stripe and Resend work. A Stripe customer id that Stripe no longer
// knows (test-mode ids after going live, a deleted customer) is forgotten
// and the checkout falls back to the family's email.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestDb, signedIn, formRequest, outcome, routeHandler, iso } from './helpers.js';
import { fakeStripe, stripeEnv } from './stripe-fake.js';
import { getPaymentsDriver } from '../../src/lib/payments-driver.js';
import { sendEmail } from '../../src/lib/email-driver.js';
import { createHostedCheckout } from '../../src/routes/booking.js';
import * as dev from '../../src/routes/dev.js';
import * as account from '../../src/routes/account.js';

const { env, dispose } = await createTestDb();
after(() => dispose());
let stripe = null;
afterEach(() => { if (stripe) stripe.restore(); stripe = null; });

test('wrangler.toml: staging is its own Worker with its own database and ENVIRONMENT=staging', async () => {
  const toml = await readFile(new URL('../../wrangler.toml', import.meta.url), 'utf8');
  const section = (name) => {
    const start = toml.indexOf(`[${name}]`);
    assert.ok(start >= 0, `[${name}] present`);
    const rest = toml.slice(start + name.length + 2);
    const next = rest.search(/^\[/m);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const production = toml.slice(0, toml.indexOf('[env.staging]'));
  assert.match(production, /database_name = "miniandco-booking"\n/);
  assert.match(section('env.staging'), /name = "miniandco-site-staging"/);
  assert.match(section('[env.staging.d1_databases]'), /binding = "DB"[\s\S]*database_name = "miniandco-booking-staging"/);
  const vars = section('env.staging.vars');
  assert.match(vars, /ENVIRONMENT = "staging"/);
  assert.match(vars, /PAYMENTS_DRIVER = "stripe"/);
  assert.match(vars, /EMAIL_DRIVER = "resend"/);
  assert.match(vars, /PUBLIC_BASE_URL = "https:\/\/miniandco-site-staging\.[^"]+\.workers\.dev"/);
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['deploy:staging'], /npm run stage && wrangler deploy --env staging/);
  assert.match(pkg.scripts['migrate:staging'], /miniandco-booking-staging --env staging --remote/);
});

test('under ENVIRONMENT=staging the mock and console drivers and /dev refuse; Stripe and Resend work', async () => {
  const staging = { ...env, ENVIRONMENT: 'staging' };
  assert.throws(() => getPaymentsDriver({ ...staging, PAYMENTS_DRIVER: 'mock' }), /cannot load/);
  assert.equal(getPaymentsDriver({ ...staging, PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x' }).name, 'stripe');
  await assert.rejects(sendEmail({ ...staging, EMAIL_DRIVER: 'console' }, 'a@example.com', 'Hi', 'Hello'), /outside development/);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 're_msg_1' });
  try {
    assert.equal(await sendEmail({ ...staging, EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test' }, 'a@example.com', 'Hi', 'Hello'), 're_msg_1');
  } finally {
    globalThis.fetch = realFetch;
  }
  const mailbox = await outcome(routeHandler(dev, 'GET', '/dev/mailbox')(formRequest('GET', '/dev/mailbox'), staging, {}));
  assert.equal(mailbox.status, 404);
});

test('a Stripe customer Stripe no longer knows is forgotten; the checkout goes ahead with the email', async () => {
  await env.DB.prepare(`INSERT INTO users (id, email, stripe_customer_id, created_at) VALUES ('st-u', 'st@example.com', 'cus_testmode', ?1)`)
    .bind(iso(Date.now())).run();
  stripe = fakeStripe([
    ['POST', /^\/v1\/checkout\/sessions$/, (url, params) => (params.get('customer')
      ? { status: 400, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } }
      : { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' })],
  ]);
  const senv = stripeEnv(env);
  const url = await createHostedCheckout(senv, {
    bookingId: '00000000-0000-4000-8000-000000000001', amountCents: 3000, description: 'Casual class',
    user: { userId: 'st-u', email: 'st@example.com', stripeCustomerId: 'cus_testmode' },
  });
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_new');
  assert.equal(stripe.calls.length, 2);
  assert.equal(stripe.calls[1].params.get('customer_email'), 'st@example.com');
  assert.equal((await env.DB.prepare(`SELECT stripe_customer_id FROM users WHERE id = 'st-u'`).first()).stripe_customer_id, null);
});

test('Update card with a customer Stripe no longer knows forgets it instead of failing', async () => {
  const parent = await signedIn(env, 'st-portal@example.com');
  await env.DB.prepare(`UPDATE users SET stripe_customer_id = 'cus_gone' WHERE id = ?1`).bind(parent.userId).run();
  stripe = fakeStripe([
    ['POST', /^\/v1\/billing_portal\/sessions$/, () => ({ status: 400, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } })],
  ]);
  const res = await outcome(routeHandler(account, 'POST', '/account/billing-portal')(formRequest('POST', '/account/billing-portal', {
    cookie: parent.cookie, form: { csrf: parent.csrf },
  }), stripeEnv(env), {}));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/account?ok=no-card');
  assert.equal((await env.DB.prepare(`SELECT stripe_customer_id FROM users WHERE id = ?1`).bind(parent.userId).first()).stripe_customer_id, null);
});
