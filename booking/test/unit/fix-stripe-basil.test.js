// Review fix (task 3.2, finding 2): refunds of instalments were dropped.
// Stripe API 2025-03-31.basil removed charge.invoice (and
// invoice.payment_intent), so charge.refunded for an instalment — which now
// names only the payment intent — matched no booking. Every Stripe request
// now pins Stripe-Version; invoice.paid stores the instalment's payment
// intent (Invoice Payments); refunds resolve by payment intent first, then
// invoice; refund lists come from Stripe when the event has none; and Check
// with Stripe adds refunds whose webhook was lost. Events here are in the
// current shape: no charge.invoice, no invoice.payment_intent, no
// charge.refunds.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm } from './helpers.js';
import { fakeStripe, stripeEnv } from './stripe-fake.js';
import { getPaymentsDriver, STRIPE_API_VERSION } from '../../src/lib/payments-driver.js';
import { prepareBooking, createPendingBooking, attachPaymentRef } from '../../src/lib/domain.js';
import { processStripeEvent } from '../../src/routes/webhooks.js';
import { reconcileRefunds } from '../../src/routes/admin-ops.js';

const { env, dispose } = await createTestDb();
after(() => dispose());
let stripe = null;
afterEach(() => { if (stripe) stripe.restore(); stripe = null; });

const senv = stripeEnv(env);
let seq = 0;
const nextId = (p) => `${p}_${Date.now()}${(seq += 1)}`;
const ledger = async (id) => (await env.DB.prepare(
  `SELECT kind, amount_cents, provider_ref, payment_intent FROM payments WHERE booking_id = ?1 ORDER BY created_at, rowid`,
).bind(id).all()).results;
const booking = (id) => env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();

async function pending(fam, { paymentChoice = 'plan', kind = 'term', sessionIds = [] } = {}) {
  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind, termId: fam.termId, sessionIds, paymentChoice });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind, termId: fam.termId, sessionIds: prepared.quote.sessionIds, quote: prepared.quote,
  });
  const ref = nextId('cs_test');
  await attachPaymentRef(env, created.id, 'stripe', ref);
  return { id: created.id, ref, quote: prepared.quote };
}

// invoice.paid as Basil sends it: the subscription under parent, no
// payment_intent on the invoice.
const invoicePaid = (bookingId, invoiceId, amount, subscription) => ({
  id: nextId('evt'), type: 'invoice.paid',
  data: { object: {
    id: invoiceId, object: 'invoice', status: 'paid', amount_paid: amount, amount_due: amount,
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    parent: { type: 'subscription_details', subscription_details: { subscription, metadata: { booking_id: bookingId } } },
  } },
});
// charge.refunded as Basil sends it: payment intent only.
const chargeRefunded = (chargeId, paymentIntent, amountRefunded) => ({
  id: nextId('evt'), type: 'charge.refunded',
  data: { object: { id: chargeId, object: 'charge', payment_intent: paymentIntent, amount_refunded: amountRefunded, refunded: true } },
});

// Stripe's side of one plan: invoices → payment intents, refunds per intent.
function planStripe({ subscription, bookingId, intents = {}, refunds = {}, failInvoicePayments = false }) {
  return fakeStripe([
    ['GET', /^\/v1\/invoice_payments$/, (url) => {
      if (failInvoicePayments) return { status: 500, body: { error: { type: 'api_error' } } };
      const invoice = url.searchParams.get('invoice');
      const pi = url.searchParams.get('payment[payment_intent]');
      const entries = Object.entries(intents)
        .filter(([inv, p]) => (invoice ? inv === invoice : p === pi))
        .map(([inv, p]) => ({ object: 'invoice_payment', invoice: inv, is_default: true, status: 'paid', payment: { type: 'payment_intent', payment_intent: p } }));
      return { object: 'list', data: entries };
    }],
    ['GET', /^\/v1\/refunds$/, (url) => ({ object: 'list', data: refunds[url.searchParams.get('payment_intent')] || [] })],
    ['GET', /^\/v1\/subscriptions\//, () => ({
      id: subscription, status: 'active', cancel_at: Math.floor(Date.now() / 1000) + 30 * 86400,
      start_date: Math.floor(Date.now() / 1000), billing_cycle_anchor: Math.floor(Date.now() / 1000),
      metadata: { booking_id: bookingId },
    })],
    ['POST', /^\/v1\/subscriptions\//, (url, params) => ({ id: subscription, cancel_at: Number(params.get('cancel_at')) })],
    ['DELETE', /^\/v1\/subscriptions\//, () => ({ id: subscription, status: 'canceled' })],
  ]);
}

test('every Stripe request names the pinned API version', async () => {
  stripe = fakeStripe([
    ['GET', /^\/v1\/checkout\/sessions\//, () => ({ id: 'cs_x', status: 'open' })],
    ['GET', /^\/v1\/subscriptions\//, () => ({ id: 'sub_x', status: 'active' })],
    ['GET', /^\/v1\/invoices$/, () => ({ data: [] })],
    ['GET', /^\/v1\/invoice_payments$/, () => ({ data: [] })],
    ['GET', /^\/v1\/refunds$/, () => ({ data: [] })],
    ['POST', /^\/v1\/checkout\/sessions\/[^/]+\/expire$/, () => ({ status: 'expired' })],
    ['DELETE', /^\/v1\/subscriptions\//, () => ({ id: 'sub_x', status: 'canceled' })],
  ]);
  const driver = getPaymentsDriver(senv);
  await driver.retrieveCheckout('cs_x');
  await driver.expireCheckout('cs_x');
  await driver.retrieveSubscription('sub_x');
  await driver.cancelSubscription('sub_x');
  await driver.listInvoices('sub_x');
  await driver.invoicePaymentIntent('in_x');
  await driver.invoiceForPaymentIntent('pi_x');
  await driver.listRefunds({ paymentIntent: 'pi_x' });
  assert.equal(stripe.calls.length, 8);
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}\.basil$/);
  for (const call of stripe.calls) assert.equal(call.headers['Stripe-Version'], STRIPE_API_VERSION, `${call.method} ${call.path}`);
  const lookup = stripe.calls.find((c) => c.path === '/v1/invoice_payments' && c.url.searchParams.get('payment[type]'));
  assert.equal(lookup.url.searchParams.get('payment[payment_intent]'), 'pi_x');
});

test('an instalment stores its payment intent, and its refund (payment intent only) is recorded against the booking', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sb1' });
  const b = await pending(fam);
  stripe = planStripe({
    subscription: 'sub_sb1', bookingId: b.id, intents: { in_sb1_1: 'pi_sb1_1' },
    refunds: { pi_sb1_1: [{ id: 're_sb1_1', amount: 2800, status: 'succeeded', payment_intent: 'pi_sb1_1', charge: 'ch_sb1_1', created: 1900000000 }] },
  });
  await processStripeEvent(senv, invoicePaid(b.id, 'in_sb1_1', 2800, 'sub_sb1'));
  assert.deepEqual((await ledger(b.id)).map((r) => [r.kind, r.amount_cents, r.provider_ref, r.payment_intent]),
    [['instalment', 2800, 'in_sb1_1', 'pi_sb1_1']]);

  const refund = chargeRefunded('ch_sb1_1', 'pi_sb1_1', 2800);
  await processStripeEvent(senv, refund);
  await processStripeEvent(senv, { ...refund, id: nextId('evt') }); // a second delivery
  const rows = await ledger(b.id);
  assert.deepEqual(rows.filter((r) => r.kind === 'refund').map((r) => [r.amount_cents, r.provider_ref, r.payment_intent]),
    [[-2800, 're_sb1_1', 'pi_sb1_1']], 'one row per Stripe refund, keyed on its id');
  const row = await booking(b.id);
  assert.equal(row.paid_cents, 0, 'the refund is in the ledger');
  assert.equal(row.payment_status, 'plan_active', 'a refund never turns the plan unpaid');
  assert.ok(stripe.calls.some((c) => c.path === '/v1/refunds' && c.url.searchParams.get('payment_intent') === 'pi_sb1_1'));
});

test('an instalment recorded before its payment intent was known is found through its invoice', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sb2' });
  const b = await pending(fam);
  stripe = planStripe({ subscription: 'sub_sb2', bookingId: b.id, intents: { in_sb2_1: 'pi_sb2_1' }, failInvoicePayments: true });
  await processStripeEvent(senv, invoicePaid(b.id, 'in_sb2_1', 2800, 'sub_sb2'));
  assert.equal((await ledger(b.id))[0].payment_intent, null, 'the lookup failed; the instalment is still recorded');

  stripe.restore();
  stripe = planStripe({
    subscription: 'sub_sb2', bookingId: b.id, intents: { in_sb2_1: 'pi_sb2_1' },
    refunds: { pi_sb2_1: [{ id: 're_sb2_1', amount: 1000, status: 'succeeded', payment_intent: 'pi_sb2_1' }] },
  });
  await processStripeEvent(senv, chargeRefunded('ch_sb2_1', 'pi_sb2_1', 1000));
  const rows = await ledger(b.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.amount_cents, r.payment_intent]),
    [['instalment', 2800, 'pi_sb2_1'], ['refund', -1000, 'pi_sb2_1']], 'matched by invoice, payment intent filled in');
});

test('a pay-in-full refund lists the refunds from Stripe when the event has none', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sb3' });
  const b = await pending(fam, { paymentChoice: 'full', kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  stripe = fakeStripe([
    ['GET', /^\/v1\/refunds$/, () => ({ data: [
      { id: 're_sb3_a', amount: 1000, status: 'succeeded', payment_intent: 'pi_sb3' },
      { id: 're_sb3_b', amount: 500, status: 'failed', payment_intent: 'pi_sb3' },
    ] })],
  ]);
  await processStripeEvent(senv, {
    id: nextId('evt'), type: 'checkout.session.completed',
    data: { object: { id: b.ref, mode: 'payment', status: 'complete', payment_status: 'paid', client_reference_id: b.id, payment_intent: 'pi_sb3', amount_total: b.quote.amountCents } },
  });
  await processStripeEvent(senv, chargeRefunded('ch_sb3', 'pi_sb3', 1000));
  const rows = await ledger(b.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.amount_cents, r.provider_ref, r.payment_intent]),
    [['checkout', 3000, 'pi_sb3', 'pi_sb3'], ['refund', -1000, 're_sb3_a', 'pi_sb3']], 'failed refunds are not money back');
});

test('Check with Stripe adds refunds whose webhook was lost, once', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sb4' });
  const b = await pending(fam);
  stripe = planStripe({ subscription: 'sub_sb4', bookingId: b.id, intents: { in_sb4_1: 'pi_sb4_1', in_sb4_2: 'pi_sb4_2' } });
  await processStripeEvent(senv, invoicePaid(b.id, 'in_sb4_1', 2800, 'sub_sb4'));
  await processStripeEvent(senv, invoicePaid(b.id, 'in_sb4_2', 2800, 'sub_sb4'));
  stripe.restore();
  stripe = planStripe({
    subscription: 'sub_sb4', bookingId: b.id, intents: { in_sb4_1: 'pi_sb4_1', in_sb4_2: 'pi_sb4_2' },
    refunds: { pi_sb4_2: [{ id: 're_sb4_2', amount: 2800, status: 'succeeded', payment_intent: 'pi_sb4_2' }] },
  });
  assert.equal(await reconcileRefunds(senv, b.id), 1);
  assert.equal(await reconcileRefunds(senv, b.id), 0, 'nothing twice');
  assert.deepEqual((await ledger(b.id)).filter((r) => r.kind === 'refund').map((r) => [r.amount_cents, r.provider_ref]), [[-2800, 're_sb4_2']]);
  assert.equal((await booking(b.id)).paid_cents, 2800);
});
