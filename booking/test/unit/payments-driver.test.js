// Stripe payments driver (design D4): Checkout parameters in payment and
// subscription mode, and the REST calls for expire / retrieve / cancel_at /
// billing portal — with fetch stubbed, nothing leaves the machine.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPaymentsDriver, checkoutParams, CHECKOUT_EXPIRY_SECS } from '../../src/lib/payments-driver.js';

const env = { PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', PUBLIC_BASE_URL: 'https://example.com' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? new URLSearchParams(init.body) : null, headers: init.headers });
    const { status = 200, body = {} } = responder(String(url), init) || {};
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('payment mode: one line item, booking id server-side, 31-minute expiry, customer creation', () => {
  const p = checkoutParams(env, {
    bookingId: 'b-1', amountCents: 16800, description: 'Term', customerEmail: 'jane@example.com', nowSeconds: 1000,
  });
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('client_reference_id'), 'b-1');
  assert.equal(p.get('metadata[booking_id]'), 'b-1');
  assert.equal(p.get('payment_intent_data[metadata][booking_id]'), 'b-1');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '16800');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'aud');
  assert.equal(p.get('expires_at'), String(1000 + CHECKOUT_EXPIRY_SECS));
  assert.equal(CHECKOUT_EXPIRY_SECS, 31 * 60);
  assert.equal(p.get('customer_creation'), 'always');
  assert.equal(p.get('customer_email'), 'jane@example.com');
  assert.equal(p.get('success_url'), 'https://example.com/book/confirm?booking=b-1');
  assert.equal(p.get('cancel_url'), 'https://example.com/book/cancelled?booking=b-1');

  const returning = checkoutParams(env, { bookingId: 'b-2', amountCents: 3000, customerId: 'cus_123', customerEmail: 'x@example.com' });
  assert.equal(returning.get('customer'), 'cus_123', 'an existing Stripe customer is reused');
  assert.equal(returning.get('customer_email'), null);
  assert.equal(returning.get('customer_creation'), null);
});

test('subscription mode: weekly recurring price plus the first-instalment remainder', () => {
  const p = checkoutParams(env, {
    bookingId: 'b-3', description: 'Term', mode: 'subscription', customerEmail: 'jane@example.com',
    plan: { n: 3, eachCents: 3333, firstCents: 3334, interval: 'week' },
  });
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '3333');
  assert.equal(p.get('line_items[0][price_data][recurring][interval]'), 'week');
  assert.equal(p.get('line_items[0][price_data][recurring][interval_count]'), '1');
  assert.equal(p.get('line_items[1][price_data][unit_amount]'), '1');
  assert.equal(p.get('line_items[1][price_data][recurring][interval]'), null, 'the remainder is one-off');
  assert.equal(p.get('subscription_data[metadata][booking_id]'), 'b-3');
  assert.equal(p.get('customer_creation'), null, 'not allowed in subscription mode');
  assert.ok(p.get('expires_at'));

  const even = checkoutParams(env, {
    bookingId: 'b-4', description: 'Term', mode: 'subscription', plan: { n: 6, eachCents: 2800, firstCents: 2800, interval: 'fortnight' },
  });
  assert.equal(even.get('line_items[0][price_data][recurring][interval_count]'), '2');
  assert.equal(even.get('line_items[1][price_data][unit_amount]'), null, 'no remainder line when it divides evenly');
  assert.throws(() => checkoutParams(env, { bookingId: 'b', mode: 'subscription', plan: { n: 1, eachCents: 100, firstCents: 100, interval: 'week' } }));
});

test('createCheckout posts form-encoded with the secret key and returns the hosted URL', async () => {
  const calls = stubFetch(() => ({ body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } }));
  const driver = getPaymentsDriver(env);
  const result = await driver.createCheckout({ bookingId: 'b-5', amountCents: 3000, description: 'Casual' });
  assert.deepEqual(result, { url: 'https://checkout.stripe.com/c/pay/cs_test_1', checkoutRef: 'cs_test_1' });
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test_x');
  assert.equal(calls[0].body.get('client_reference_id'), 'b-5');
});

test('expire, retrieve, cancel_at (no proration), cancel and billing portal calls', async () => {
  const calls = stubFetch((url) => {
    if (url.endsWith('/expire')) return { body: { id: 'cs_1', status: 'expired' } };
    if (url.includes('/checkout/sessions/')) {
      return { body: { id: 'cs_1', status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_1' }, subscription: null, customer: 'cus_1', amount_total: 3000, mode: 'payment', client_reference_id: 'b-6' } };
    }
    if (url.includes('/billing_portal/')) return { body: { url: 'https://billing.stripe.com/p/session/x' } };
    return { body: { id: 'sub_1', status: 'active', start_date: 100, billing_cycle_anchor: 100, cancel_at: 900, customer: 'cus_1', items: { data: [{ current_period_end: 704 }] }, metadata: { booking_id: 'b-6' } } };
  });
  const driver = getPaymentsDriver(env);
  assert.deepEqual(await driver.expireCheckout('cs_1'), { status: 'expired' });
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions/cs_1/expire');
  const info = await driver.retrieveCheckout('cs_1');
  assert.equal(info.paymentIntent, 'pi_1', 'expanded objects are reduced to ids');
  assert.equal(info.bookingId, 'b-6');
  const sub = await driver.retrieveSubscription('sub_1');
  assert.equal(sub.billingCycleAnchor, 100);
  assert.equal(sub.currentPeriodEnd, 704, 'period end read from the subscription item (current API)');
  await driver.setSubscriptionCancelAt('sub_1', 1234.9);
  const update = calls[calls.length - 1];
  assert.equal(update.url, 'https://api.stripe.com/v1/subscriptions/sub_1');
  assert.equal(update.body.get('cancel_at'), '1234');
  assert.equal(update.body.get('proration_behavior'), 'none');
  await driver.cancelSubscription('sub_1');
  assert.equal(calls[calls.length - 1].method, 'DELETE');
  assert.equal(await driver.createBillingPortalSession('cus_1', 'https://example.com/account'), 'https://billing.stripe.com/p/session/x');
  assert.equal(calls[calls.length - 1].body.get('return_url'), 'https://example.com/account');
});

test('ids are validated before they reach a URL path; Stripe errors never echo the body', async () => {
  const driver = getPaymentsDriver(env);
  await assert.rejects(driver.expireCheckout('../../v1/charges'), /Invalid Stripe checkout id/);
  await assert.rejects(driver.retrieveSubscription('sub_1/../x'), /Invalid Stripe subscription id/);
  stubFetch(() => ({ status: 400, body: { error: { code: 'resource_missing', message: 'No such checkout.session: cs_secret_detail' } } }));
  await assert.rejects(driver.retrieveCheckout('cs_missing'), (err) => {
    assert.match(err.message, /HTTP 400, resource_missing/);
    assert.ok(!err.message.includes('cs_secret_detail'));
    return true;
  });
  await assert.rejects(getPaymentsDriver({ PAYMENTS_DRIVER: 'stripe' }).retrieveCheckout('cs_1'), /STRIPE_SECRET_KEY/);
});

test('the mock driver is fail-closed outside development', () => {
  assert.throws(() => getPaymentsDriver({ PAYMENTS_DRIVER: 'mock', ENVIRONMENT: 'production' }), /cannot load in production/);
  assert.throws(() => getPaymentsDriver({ PAYMENTS_DRIVER: 'mock' }), /cannot load in production/);
  assert.throws(() => getPaymentsDriver({ PAYMENTS_DRIVER: 'paypal' }), /Unknown PAYMENTS_DRIVER/);
});
