// Payment webhooks (design D6) against a real D1: the event row is written
// BEFORE handling and marked done only after; failures are retried, replays
// are not; a payment after the hold lapsed re-takes its seats or is flagged
// paid_no_seat; subscriptions, failures and refunds update the ledger.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  handleVerifiedEvent, claimWebhookEvent, processStripeEvent, handleStripeWebhook, REPROCESS_AFTER_SECS,
} from '../../src/routes/webhooks.js';
import {
  prepareBooking, createPendingBooking, attachPaymentRef, expireBooking, cancelBooking, confirmBooking,
} from '../../src/lib/domain.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

let seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now()}_${(seq += 1)}`;

async function pendingBooking(fam, { kind = 'casual', sessionIds = [fam.sessionIds[0]], childId = fam.childId, paymentChoice = 'full', expiresAt = null } = {}) {
  const prepared = await prepareBooking(env, { userId: fam.userId, childId, kind, termId: fam.termId, sessionIds, paymentChoice });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId, kind, termId: fam.termId, sessionIds: prepared.quote.sessionIds, quote: prepared.quote, expiresAt,
  });
  assert.ok(created.id, JSON.stringify(created));
  const ref = nextId('cs_test');
  await attachPaymentRef(env, created.id, 'mock', ref);
  return { id: created.id, ref, amount: created.amountCents, quote: prepared.quote };
}

function checkoutCompleted(booking, overrides = {}) {
  return {
    id: nextId('evt'),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: booking.ref, mode: 'payment', status: 'complete', payment_status: 'paid',
        client_reference_id: booking.id, payment_intent: nextId('pi'), amount_total: booking.amount, ...overrides,
      },
    },
  };
}

function invoiceEvent(type, bookingId, { amount = 2800, id = nextId('in'), subscription = 'sub_test_1', attempt = 1 } = {}) {
  return {
    id: nextId('evt'),
    type,
    data: {
      object: {
        id, amount_paid: type === 'invoice.paid' ? amount : 0, amount_due: amount, attempt_count: attempt,
        status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
        parent: { subscription_details: { subscription, metadata: { booking_id: bookingId } } },
      },
    },
  };
}

const row = (id) => env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();
const ledger = async (id) => (await env.DB.prepare(`SELECT kind, amount_cents, provider_ref FROM payments WHERE booking_id = ?1 ORDER BY created_at`).bind(id).all()).results;
const eventRow = (id) => env.DB.prepare(`SELECT status, processed_at FROM webhook_events WHERE event_id = ?1`).bind(id).first();
const emails = async (template) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE template = ?1`).bind(template).first()).n;

test('the event row is claimed before handling, marked done after, and a replay is not reprocessed', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w1' });
  const booking = await pendingBooking(fam);
  const event = checkoutCompleted(booking);

  const first = await handleVerifiedEvent(env, event);
  assert.deepEqual(first, { outcome: 'done', status: 200 });
  assert.equal((await eventRow(event.id)).status, 'done');
  assert.equal((await row(booking.id)).status, 'confirmed');
  assert.equal((await ledger(booking.id)).length, 1);
  const confirmations = await emails('booking_confirmed');

  const replay = await handleVerifiedEvent(env, event);
  assert.deepEqual(replay, { outcome: 'replay', status: 200 });
  assert.equal((await ledger(booking.id)).length, 1, 'no duplicate ledger row');
  assert.equal(await emails('booking_confirmed'), confirmations, 'no second confirmation email');
});

test('claiming: fresh processing/failed rows are busy; older than two minutes they are reclaimed', async () => {
  const id = nextId('evt');
  const t0 = Date.now();
  assert.equal(await claimWebhookEvent(env, id, t0), 'claimed');
  assert.equal(await claimWebhookEvent(env, id, t0 + 1000), 'busy', 'another delivery is in flight');
  assert.equal(await claimWebhookEvent(env, id, t0 + (REPROCESS_AFTER_SECS + 1) * 1000), 'claimed', 'a stuck attempt is reclaimed');
  await env.DB.prepare(`UPDATE webhook_events SET status = 'failed' WHERE event_id = ?1`).bind(id).run();
  assert.equal(await claimWebhookEvent(env, id, t0 + (REPROCESS_AFTER_SECS + 2) * 1000), 'busy');
  assert.equal(await claimWebhookEvent(env, id, t0 + (2 * REPROCESS_AFTER_SECS + 5) * 1000), 'claimed');
  await env.DB.prepare(`UPDATE webhook_events SET status = 'done' WHERE event_id = ?1`).bind(id).run();
  assert.equal(await claimWebhookEvent(env, id, t0 + 10 * REPROCESS_AFTER_SECS * 1000), 'replay');
});

test('a transient failure marks the event failed (500); the retry is processed and records exactly one row', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w2' });
  const booking = await pendingBooking(fam, { kind: 'term', sessionIds: [], paymentChoice: 'plan' });
  const event = invoiceEvent('invoice.paid', booking.id, { amount: 2800 });

  const broken = { ...env, PAYMENTS_DRIVER: 'misconfigured' }; // getPaymentsDriver throws mid-handler
  assert.deepEqual(await handleVerifiedEvent(broken, event), { outcome: 'failed', status: 500 });
  assert.equal((await eventRow(event.id)).status, 'failed', 'never marked handled');
  assert.equal((await ledger(booking.id)).length, 0);

  // Stripe retries later (after the two-minute window).
  await env.DB.prepare(`UPDATE webhook_events SET received_at = ?2 WHERE event_id = ?1`)
    .bind(event.id, iso(Date.now() - (REPROCESS_AFTER_SECS + 30) * 1000)).run();
  assert.deepEqual(await handleVerifiedEvent(env, event), { outcome: 'done', status: 200 });
  assert.deepEqual((await ledger(booking.id)).map((r) => [r.kind, r.amount_cents]), [['instalment', 2800]]);
  assert.equal((await row(booking.id)).status, 'confirmed', 'the first invoice confirms even before checkout.session.completed');

  // A later duplicate delivery of the same invoice under a new event id.
  const duplicate = { ...event, id: nextId('evt') };
  await handleVerifiedEvent(env, duplicate);
  assert.equal((await ledger(booking.id)).length, 1, 'exactly one ledger row for the invoice');
});

test('payment after the hold lapsed: honoured when the seat is still free', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w3' });
  const booking = await pendingBooking(fam);
  await expireBooking(env, booking.id);
  await processStripeEvent(env, checkoutCompleted(booking));
  const b = await row(booking.id);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.needs_attention, null);
  assert.equal(b.payment_status, 'paid');
});

test('payment after the hold lapsed and the seat was resold: recorded, flagged paid_no_seat, owner emailed', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w4', capacity: 1, children: 2 });
  const a = await pendingBooking(fam);
  await expireBooking(env, a.id);
  const b = await pendingBooking(fam, { childId: fam.childIds[1] });
  await processStripeEvent(env, checkoutCompleted(b));
  const before = await emails('owner_attention');

  await processStripeEvent(env, checkoutCompleted(a));
  const rowA = await row(a.id);
  assert.equal(rowA.status, 'expired');
  assert.equal(rowA.needs_attention, 'paid_no_seat');
  assert.deepEqual((await ledger(a.id)).map((r) => r.kind), ['checkout']);
  assert.equal((await row(b.id)).status, 'confirmed', 'the other family keeps the seat');
  assert.ok((await emails('owner_attention')) > before, 'the owner is emailed');
  const held = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM booking_sessions bs JOIN bookings x ON x.id = bs.booking_id
     WHERE bs.session_id = ?1 AND x.status = 'confirmed'`,
  ).bind(fam.sessionIds[0]).first();
  assert.equal(held.n, 1, 'capacity 1, one confirmed booking');
});

test('payment for a cancelled booking is recorded and flagged paid_after_cancel', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w5' });
  const booking = await pendingBooking(fam);
  await cancelBooking(env, booking.id, { by: 'admin' });
  await processStripeEvent(env, checkoutCompleted(booking));
  const b = await row(booking.id);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.needs_attention, 'paid_after_cancel');
  assert.equal(b.paid_cents, booking.amount);
});

test('a payment that does not match what is owed is flagged webhook_mismatch', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w6' });
  const booking = await pendingBooking(fam);
  await processStripeEvent(env, checkoutCompleted(booking, { amount_total: booking.amount - 100 }));
  const b = await row(booking.id);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.payment_status, 'unpaid');
  assert.equal(b.needs_attention, 'webhook_mismatch');
});

test('subscription checkout: confirm, instalments, failure flags overdue, retry clears it, completion', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w7' });
  const booking = await pendingBooking(fam, { kind: 'term', sessionIds: [], paymentChoice: 'plan' });
  assert.equal(booking.quote.plan.n, 6);
  const subscription = 'sub_w7';

  await processStripeEvent(env, {
    id: nextId('evt'), type: 'checkout.session.completed',
    data: { object: { id: booking.ref, mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: booking.id, subscription } },
  });
  let b = await row(booking.id);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.stripe_subscription_id, subscription);
  assert.equal(b.payment_status, 'unpaid', 'no money until the first invoice is paid');

  await processStripeEvent(env, invoiceEvent('invoice.paid', booking.id, { subscription }));
  b = await row(booking.id);
  assert.equal(b.payment_status, 'plan_active');
  assert.equal(b.paid_cents, 2800);
  assert.ok(b.plan_next_charge_at > b.paid_at);

  await processStripeEvent(env, invoiceEvent('invoice.payment_failed', booking.id, { subscription }));
  b = await row(booking.id);
  assert.equal(b.payment_status, 'plan_overdue');
  assert.equal(b.needs_attention, 'plan_overdue');
  assert.equal(b.status, 'confirmed', 'the place is never cancelled by a failure');
  assert.ok((await emails('owner_plan_failed')) >= 1, 'notifyPlanFailed ran');

  await processStripeEvent(env, invoiceEvent('invoice.paid', booking.id, { subscription }));
  b = await row(booking.id);
  assert.equal(b.payment_status, 'plan_active', 'caught up again');
  assert.equal(b.needs_attention, null);

  for (let i = 0; i < 4; i += 1) await processStripeEvent(env, invoiceEvent('invoice.paid', booking.id, { subscription }));
  await processStripeEvent(env, { id: nextId('evt'), type: 'customer.subscription.deleted', data: { object: { id: subscription, metadata: { booking_id: booking.id } } } });
  b = await row(booking.id);
  assert.equal(b.paid_cents, 16800);
  assert.equal(b.payment_status, 'plan_complete');
  assert.equal(b.plan_next_charge_at, null);
  assert.equal(b.needs_attention, null);
});

test('a subscription that ends before the full amount is flagged plan_ended_short', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w8' });
  const booking = await pendingBooking(fam, { kind: 'term', sessionIds: [], paymentChoice: 'plan' });
  await processStripeEvent(env, invoiceEvent('invoice.paid', booking.id, { subscription: 'sub_w8' }));
  // Found by the stored subscription id (no metadata on this object).
  await processStripeEvent(env, { id: nextId('evt'), type: 'customer.subscription.deleted', data: { object: { id: 'sub_w8' } } });
  const b = await row(booking.id);
  assert.equal(b.needs_attention, 'plan_ended_short');
  assert.equal(b.payment_status, 'plan_active');
});

test('refunds are negative ledger rows, idempotent, in both event shapes', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w9' });
  const booking = await pendingBooking(fam);
  const paid = checkoutCompleted(booking);
  await processStripeEvent(env, paid);
  const pi = paid.data.object.payment_intent;

  const listed = {
    id: nextId('evt'), type: 'charge.refunded',
    data: { object: { id: 'ch_w9', payment_intent: pi, amount_refunded: 1000, refunds: { data: [{ id: 're_w9_1', amount: 1000, status: 'succeeded' }] } } },
  };
  await processStripeEvent(env, listed);
  await processStripeEvent(env, { ...listed, id: nextId('evt') });
  assert.deepEqual((await ledger(booking.id)).filter((r) => r.kind === 'refund').map((r) => r.amount_cents), [-1000]);

  // Newer API versions omit the refund list: cumulative amount_refunded.
  const fam2 = await seedFamilyAndTerm(env, { prefix: 'w9b' });
  const b2 = await pendingBooking(fam2);
  const paid2 = checkoutCompleted(b2);
  await processStripeEvent(env, paid2);
  const charge = (amount) => ({
    id: nextId('evt'), type: 'charge.refunded',
    data: { object: { id: 'ch_w9b', payment_intent: paid2.data.object.payment_intent, amount_refunded: amount } },
  });
  await processStripeEvent(env, charge(500));
  await processStripeEvent(env, charge(500));
  await processStripeEvent(env, charge(1200));
  assert.deepEqual((await ledger(b2.id)).filter((r) => r.kind === 'refund').map((r) => r.amount_cents), [-500, -700]);
  const row2 = await row(b2.id);
  assert.equal(row2.paid_cents, b2.amount - 1200);
  assert.equal(row2.payment_status, 'paid', 'a refund does not make the booking unpaid');
});

test('checkout.session.expired releases a checkout hold but keeps a pay-later hold', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w10', children: 2 });
  const quick = await pendingBooking(fam);
  await processStripeEvent(env, { id: nextId('evt'), type: 'checkout.session.expired', data: { object: { id: quick.ref, client_reference_id: quick.id } } });
  assert.equal((await row(quick.id)).status, 'expired');

  const later = await pendingBooking(fam, { childId: fam.childIds[1], expiresAt: daysFromNow(2) });
  await processStripeEvent(env, { id: nextId('evt'), type: 'checkout.session.expired', data: { object: { id: later.ref, client_reference_id: later.id } } });
  const b = await row(later.id);
  assert.equal(b.status, 'pending', 'the 48-hour offer survives an abandoned checkout');
  assert.equal(b.payment_ref, null);
});

test('the HTTP endpoint maps outcomes to status codes and rejects malformed events', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w11' });
  const booking = await pendingBooking(fam);
  const event = checkoutCompleted(booking);
  const post = (body) => handleStripeWebhook(new Request('https://example.com/api/stripe/webhook', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), env);
  assert.equal((await post(event)).status, 200);
  assert.equal((await post(event)).status, 200, 'replay acknowledged');
  assert.equal((await post({ type: 'x' })).status, 400, 'no event id');
  assert.equal((await post({ id: 'evt bad id', type: 'x' })).status, 400);
  const unknown = await post({ id: nextId('evt'), type: 'customer.created', data: { object: {} } });
  assert.equal(unknown.status, 200, 'unhandled event types are acknowledged');
});

test('confirmBooking stays the only path: a stale pending booking confirmed via the webhook re-takes its seats', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'w12' });
  const booking = await pendingBooking(fam);
  await env.DB.prepare(`UPDATE bookings SET expires_at = ?2 WHERE id = ?1`).bind(booking.id, daysFromNow(-0.01)).run();
  const result = await confirmBooking(env, booking.id, { provider: 'mock' });
  assert.equal(result.reconfirmed, true);
});

test('the endpoint answers a bad Stripe signature with 400 invalid_signature and records nothing', async () => {
  const { hmacSha256Hex } = await import('../../src/lib/crypto.js');
  const stripeEnv = { ...env, PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_right' };
  const fam = await seedFamilyAndTerm(env, { prefix: 'w13' });
  const booking = await pendingBooking(fam);
  const event = checkoutCompleted(booking);
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const post = (signature) => handleStripeWebhook(new Request('https://example.com/api/stripe/webhook', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(signature ? { 'Stripe-Signature': signature } : {}) },
  }), stripeEnv);
  const rejected = async (signature, why) => {
    const res = await post(signature);
    assert.equal(res.status, 400, why);
    assert.deepEqual(await res.json(), { error: 'invalid_signature' }, why);
  };
  await rejected(`t=${t},v1=${await hmacSha256Hex('whsec_wrong', `${t}.${body}`)}`, 'signed with another secret');
  await rejected(null, 'no signature header');
  await rejected(`t=${t - 600},v1=${await hmacSha256Hex('whsec_right', `${t - 600}.${body}`)}`, 'outside the 5-minute tolerance');
  await rejected(`t=${t},v1=${await hmacSha256Hex('whsec_right', `${t}.${body} `)}`, 'a tampered body');
  assert.equal(await eventRow(event.id), null, 'nothing claimed');
  assert.equal((await row(booking.id)).status, 'pending', 'nothing confirmed');
  // The same event, correctly signed, goes through — so the 400s were about the signature.
  const ok = await post(`t=${t},v1=${await hmacSha256Hex('whsec_right', `${t}.${body}`)}`);
  assert.equal(ok.status, 200);
  assert.equal((await row(booking.id)).status, 'confirmed');
});
