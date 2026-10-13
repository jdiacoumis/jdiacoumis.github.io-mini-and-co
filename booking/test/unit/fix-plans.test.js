// Review fixes (task 3.2) — instalment plans after checkout:
//   finding 1   a cash/transfer payment that completes a live plan stops the
//               Stripe subscription; money beyond the total is flagged
//               'overpaid' (plans included); the record-payment form warns
//               while a plan is live;
//   finding 3   a plan's end date (cancel_at) no longer depends on
//               checkout.session.completed: invoice.paid and Check with
//               Stripe set it when missing;
//   finding 5   no "update your card" nudges once the subscription has
//               ended; "Mark as sorted" on a plan that ended short settles
//               the money (still owed, or written off);
//   finding 11  cancelling while the family pays confirms instead; "Stop
//               plan" works on any booking with a live subscription;
//   also        "Record refund" never changes the payment status.
// Stripe is a fake (test/unit/stripe-fake.js) that keeps one subscription
// per test, so what was asked of it can be checked.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb, seedFamilyAndTerm, signedIn, formRequest, outcome, routeHandler, iso,
} from './helpers.js';
import { fakeStripe, stripeEnv } from './stripe-fake.js';
import { prepareBooking, createPendingBooking, attachPaymentRef, cancelBooking } from '../../src/lib/domain.js';
import { processStripeEvent } from '../../src/routes/webhooks.js';
import { checkWithStripe } from '../../src/routes/admin-ops.js';
import { overdueNudges } from '../../src/lib/jobs/ops.js';
import { planCancelAt } from '../../src/lib/pricing.js';
import * as adminBookings from '../../src/routes/admin-bookings.js';
import * as adminOps from '../../src/routes/admin-ops.js';

const { env, dispose } = await createTestDb();
after(() => dispose());
const senv = stripeEnv(env);
let stripe = null;
afterEach(() => { if (stripe) stripe.restore(); stripe = null; });

let seq = 0;
const nextId = (p) => `${p}_${Date.now()}${(seq += 1)}`;
const row = (id) => env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();
const ledger = async (id) => (await env.DB.prepare(
  `SELECT kind, amount_cents, provider_ref FROM payments WHERE booking_id = ?1 ORDER BY created_at, rowid`,
).bind(id).all()).results;
const count = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).first()).n;
const ANCHOR = 1900000000;

// Stripe for one subscription: retrieve (cancel_at as set), set cancel_at,
// cancel (status canceled), Invoice Payments, refunds and the checkout.
function subscriptionStripe(sub, { bookingId = null, cancelAt = null, metadata = {}, refuseCancel = false, checkout = null } = {}) {
  const state = { status: 'active', cancelAt, cancelled: 0, setCancelAt: [] };
  stripe = fakeStripe([
    ['GET', new RegExp(`^/v1/subscriptions/${sub}$`), () => ({
      id: sub, status: state.status, cancel_at: state.cancelAt, billing_cycle_anchor: ANCHOR, start_date: ANCHOR,
      metadata: { ...(bookingId ? { booking_id: bookingId } : {}), ...metadata },
    })],
    ['POST', new RegExp(`^/v1/subscriptions/${sub}$`), (url, params) => {
      state.cancelAt = Number(params.get('cancel_at'));
      state.setCancelAt.push(state.cancelAt);
      return { id: sub, cancel_at: state.cancelAt };
    }],
    ['DELETE', new RegExp(`^/v1/subscriptions/${sub}$`), () => {
      if (refuseCancel) return { status: 500, body: { error: { type: 'api_error' } } };
      state.status = 'canceled';
      state.cancelled += 1;
      return { id: sub, status: 'canceled' };
    }],
    ['GET', /^\/v1\/invoice_payments$/, () => ({ data: [] })],
    ['GET', /^\/v1\/invoices$/, () => ({ data: [] })],
    ['GET', /^\/v1\/refunds$/, () => ({ data: [] })],
    ...(checkout ? [
      ['POST', new RegExp(`^/v1/checkout/sessions/${checkout.id}/expire$`), () => (checkout.expire === 'ok'
        ? { id: checkout.id, status: 'expired' }
        : { status: 400, body: { error: { type: 'invalid_request_error', code: 'checkout_session_not_open' } } })],
      ['GET', new RegExp(`^/v1/checkout/sessions/${checkout.id}$`), () => (checkout.retrieve === 'fail'
        ? { status: 500, body: { error: { type: 'api_error' } } }
        : checkout.body)],
    ] : []),
  ]);
  return state;
}

async function planBooking(prefix, { plan = true, expiresAt = null } = {}) {
  const fam = await seedFamilyAndTerm(env, { prefix });
  const prepared = await prepareBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, paymentChoice: plan ? 'plan' : 'full',
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote, expiresAt,
  });
  const ref = `cs_${prefix.replace(/-/g, '')}`;
  await attachPaymentRef(env, created.id, 'stripe', ref);
  return { id: created.id, ref, fam, sub: `sub_${prefix.replace(/-/g, '')}`, quote: prepared.quote };
}

const completed = (b) => ({
  id: nextId('evt'), type: 'checkout.session.completed',
  data: { object: { id: b.ref, mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: b.id, subscription: b.sub } },
});
const invoice = (b, type, invoiceId, amount = 2800) => ({
  id: nextId('evt'), type,
  data: { object: {
    id: invoiceId, object: 'invoice', amount_paid: type === 'invoice.paid' ? amount : 0, amount_due: amount, attempt_count: 1,
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    parent: { subscription_details: { subscription: b.sub, metadata: { booking_id: b.id } } },
  } },
});
const deleted = (b) => ({ id: nextId('evt'), type: 'customer.subscription.deleted', data: { object: { id: b.sub, status: 'canceled', metadata: { booking_id: b.id } } } });

async function admin() {
  return signedIn(env, 'owner@example.com');
}

async function recordPayment(b, amount, method = 'bank transfer') {
  const owner = await admin();
  const handler = routeHandler(adminBookings, 'POST', '/admin/bookings/:id/record-payment');
  return outcome(handler(formRequest('POST', `/admin/bookings/${b.id}/record-payment`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, nonce: crypto.randomUUID(), amount, method, note: '' },
  }), senv, { id: b.id }));
}

test('finding 1: a transfer for the rest of a plan stops the subscription — no more instalments, nothing flagged', async () => {
  const b = await planBooking('pl-transfer');
  const state = subscriptionStripe(b.sub, { bookingId: b.id });
  await processStripeEvent(senv, completed(b));
  assert.deepEqual(state.setCancelAt, [planCancelAt(ANCHOR, 6, 'week')], 'the end date is set at checkout');
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`));
  await processStripeEvent(senv, invoice(b, 'invoice.payment_failed', `in_${b.sub}_2`));
  let r = await row(b.id);
  assert.equal(r.payment_status, 'plan_overdue');
  assert.equal(r.needs_attention, 'plan_overdue');

  const res = await recordPayment(b, '140');
  assert.equal(res.status, 303);
  assert.match(res.headers.get('Location'), /ok=payment-recorded-plan-stopped/);
  assert.equal(state.cancelled, 1, 'the Stripe subscription was cancelled');
  r = await row(b.id);
  assert.equal(r.payment_status, 'plan_complete');
  assert.equal(r.paid_cents, 16800);
  assert.equal(r.needs_attention, null, 'caught up: the overdue flag is cleared');
  assert.ok(r.plan_ended_at, 'the end of the plan is recorded');
  assert.equal(r.plan_next_charge_at, null);
  assert.match(r.admin_notes, /instalment plan stopped — everything owed has been paid/);

  // Stripe's own notice of the end changes nothing (it was ours).
  await processStripeEvent(senv, deleted(b));
  r = await row(b.id);
  assert.equal(r.needs_attention, null, 'not "ended short"');
  assert.equal(r.payment_status, 'plan_complete');

  // A retry Stripe had already collected before the stop: money beyond the
  // total is recorded once and flagged for the owner.
  const late = invoice(b, 'invoice.paid', `in_${b.sub}_2`);
  await processStripeEvent(senv, late);
  await processStripeEvent(senv, { ...late, id: nextId('evt') });
  r = await row(b.id);
  assert.equal(r.needs_attention, 'overpaid');
  assert.equal(r.paid_cents, 19600);
  assert.equal((await ledger(b.id)).filter((p) => p.provider_ref === `in_${b.sub}_2`).length, 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM email_log WHERE dedupe_key = ?1`, `attention:overpaid:${b.id}:owner@example.com`), 1,
    'the owner is emailed once');
});

test('finding 1: while a plan is live the record-payment form warns; a part payment leaves it running', async () => {
  const b = await planBooking('pl-part');
  const state = subscriptionStripe(b.sub, { bookingId: b.id });
  await processStripeEvent(senv, completed(b));
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`));
  const owner = await admin();
  const page = await routeHandler(adminBookings, 'GET', '/admin/bookings/:id')(
    formRequest('GET', `/admin/bookings/${b.id}`, { cookie: owner.cookie }), senv, { id: b.id });
  const text = await page.text();
  assert.match(text, /Instalments are still being taken by card for this booking/);
  assert.match(text, new RegExp(`/admin/bookings/${b.id}/stop-plan`));

  const res = await recordPayment(b, '28');
  assert.match(res.headers.get('Location'), /ok=payment-recorded(?!-plan)/);
  assert.equal(state.cancelled, 0, 'part of the money: the plan carries on');
  const r = await row(b.id);
  assert.equal(r.payment_status, 'plan_active');
  assert.equal(r.plan_ended_at, null);
});

test('an instalment beyond the plan (a 7th) is recorded once and flagged, never ledgered twice', async () => {
  const b = await planBooking('pl-seventh');
  const state = subscriptionStripe(b.sub, { bookingId: b.id });
  await processStripeEvent(senv, completed(b));
  for (let i = 1; i <= 6; i += 1) await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_${i}`));
  let r = await row(b.id);
  assert.equal(r.payment_status, 'plan_complete');
  assert.equal(r.needs_attention, null);
  assert.equal(state.cancelled, 1, 'the sixth instalment completes the plan and stops it');
  const seventh = invoice(b, 'invoice.paid', `in_${b.sub}_7`);
  await processStripeEvent(senv, seventh);
  await processStripeEvent(senv, { ...seventh, id: nextId('evt') });
  r = await row(b.id);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?1 AND kind = 'instalment'`, b.id), 7);
  assert.equal(r.needs_attention, 'overpaid');
  assert.equal(r.paid_cents, 16800 + 2800);
});

test('finding 3: an invoice.paid without checkout.session.completed gives the subscription its end date', async () => {
  const b = await planBooking('pl-noevent');
  const state = subscriptionStripe(b.sub, { bookingId: b.id });
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`));
  const r = await row(b.id);
  assert.equal(r.status, 'confirmed');
  assert.deepEqual(state.setCancelAt, [planCancelAt(ANCHOR, 6, 'week')], 'from the booking\'s plan');
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_2`));
  assert.equal(state.setCancelAt.length, 1, 'an end date already there is left alone');
});

test('finding 3: from the subscription metadata when the booking forgot its plan, flagged when neither has one', async () => {
  const b = await planBooking('pl-meta');
  await env.DB.prepare(`UPDATE bookings SET payment_method = 'full', plan_instalments = NULL, plan_instalment_cents = NULL, plan_interval = NULL WHERE id = ?1`).bind(b.id).run();
  const state = subscriptionStripe(b.sub, { bookingId: b.id, metadata: { plan_instalments: '4', plan_interval: 'fortnight', plan_instalment_cents: '4200' } });
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`, 4200));
  assert.deepEqual(state.setCancelAt, [planCancelAt(ANCHOR, 4, 'fortnight')]);
  assert.equal((await row(b.id)).plan_instalments, 4);
  stripe.restore();

  const c = await planBooking('pl-none');
  await env.DB.prepare(`UPDATE bookings SET payment_method = 'full', plan_instalments = NULL, plan_instalment_cents = NULL, plan_interval = NULL WHERE id = ?1`).bind(c.id).run();
  const none = subscriptionStripe(c.sub, { bookingId: c.id });
  await processStripeEvent(senv, invoice(c, 'invoice.paid', `in_${c.sub}_1`));
  assert.equal(none.setCancelAt.length, 0);
  assert.equal((await row(c.id)).needs_attention, 'webhook_mismatch');
});

test('finding 3: Check with Stripe on a confirmed plan sets a missing end date (and says so)', async () => {
  const b = await planBooking('pl-check');
  const state = subscriptionStripe(b.sub, { bookingId: b.id, cancelAt: planCancelAt(ANCHOR, 6, 'week') });
  await processStripeEvent(senv, completed(b));
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`));
  state.cancelAt = null; // removed in the dashboard, say
  state.setCancelAt.length = 0;
  const out = {};
  const result = await checkWithStripe(senv, await row(b.id), out);
  assert.equal(result, 'check-plan-active');
  assert.equal(out.also, 'plan-end-set');
  assert.deepEqual(state.setCancelAt, [planCancelAt(ANCHOR, 6, 'week')]);
});

test('finding 5: no "update your card" nudges once the subscription has ended; the owner settles what is left', async () => {
  const b = await planBooking('pl-short');
  const state = subscriptionStripe(b.sub, { bookingId: b.id });
  await processStripeEvent(senv, completed(b));
  // The plan started 15 days ago; one instalment arrived, then the card failed.
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`));
  await env.DB.prepare(`UPDATE bookings SET paid_at = ?2 WHERE id = ?1`).bind(b.id, iso(Date.now() - 15 * 86400e3)).run();
  await processStripeEvent(senv, invoice(b, 'invoice.payment_failed', `in_${b.sub}_2`));
  await env.DB.prepare(`UPDATE email_log SET sent_at = ?2 WHERE booking_id = ?1`).bind(b.id, iso(Date.now() - 10 * 86400e3)).run();
  const nudges = await overdueNudges(env, { now: iso(Date.now()) });
  assert.ok(nudges.sent >= 1, 'live and overdue: nudged');
  await env.DB.prepare(`DELETE FROM email_log WHERE booking_id = ?1 AND template = 'plan_overdue'`).bind(b.id).run();

  // Stripe gives up: the plan ends short.
  state.status = 'canceled';
  await processStripeEvent(senv, deleted(b));
  let r = await row(b.id);
  assert.equal(r.needs_attention, 'plan_ended_short');
  assert.ok(r.plan_ended_at);
  const before = await count(`SELECT COUNT(*) AS n FROM email_log WHERE booking_id = ?1 AND template = 'plan_overdue'`, b.id);
  await overdueNudges(env, { now: iso(Date.now() + 8 * 86400e3) });
  assert.equal(await count(`SELECT COUNT(*) AS n FROM email_log WHERE booking_id = ?1 AND template = 'plan_overdue'`, b.id), before,
    'ended: no more nudges');

  // "Mark as sorted" needs a decision about the rest…
  const owner = await admin();
  const resolve = routeHandler(adminOps, 'POST', '/admin/bookings/:id/resolve');
  const undecided = await outcome(resolve(formRequest('POST', `/admin/bookings/${b.id}/resolve`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, note: 'Called them' },
  }), senv, { id: b.id }));
  assert.match(undecided.headers.get('Location'), /err=resolve-outcome/);
  assert.equal((await row(b.id)).needs_attention, 'plan_ended_short');
  // …"they'll pay the rest another way": no longer a plan, still owing.
  const owed = await outcome(resolve(formRequest('POST', `/admin/bookings/${b.id}/resolve`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, note: 'Paying by transfer', plan_outcome: 'owed' },
  }), senv, { id: b.id }));
  assert.match(owed.headers.get('Location'), /ok=resolved/);
  r = await row(b.id);
  assert.deepEqual([r.needs_attention, r.payment_method, r.payment_status], [null, 'offline', 'unpaid']);
  assert.match(r.admin_notes, /the rest is still owed/);
});

test('finding 5: writing off what an ended-short plan still owes completes it', async () => {
  const b = await planBooking('pl-writeoff');
  const state = subscriptionStripe(b.sub, { bookingId: b.id });
  await processStripeEvent(senv, completed(b));
  await processStripeEvent(senv, invoice(b, 'invoice.paid', `in_${b.sub}_1`));
  state.status = 'canceled';
  await processStripeEvent(senv, deleted(b));
  const owner = await admin();
  const res = await outcome(routeHandler(adminOps, 'POST', '/admin/bookings/:id/resolve')(
    formRequest('POST', `/admin/bookings/${b.id}/resolve`, {
      cookie: owner.cookie, form: { csrf: owner.csrf, note: 'Family moved away', plan_outcome: 'write_off', back: 'attention' },
    }), senv, { id: b.id }));
  assert.match(res.headers.get('Location'), /^\/admin\/attention\?ok=resolved/);
  const r = await row(b.id);
  assert.deepEqual([r.needs_attention, r.payment_status], [null, 'plan_complete']);
  assert.deepEqual((await ledger(b.id)).filter((p) => p.kind === 'adjustment').map((p) => p.amount_cents), [16800 - 2800]);
  assert.match(r.admin_notes, /\$140\.00 written off/);
});

test('finding 11: cancelling while the family is paying confirms the booking instead', async () => {
  const b = await planBooking('pl-race');
  subscriptionStripe(b.sub, {
    bookingId: b.id,
    checkout: {
      id: b.ref, expire: 'refuse',
      body: { id: b.ref, status: 'complete', payment_status: 'paid', mode: 'subscription', subscription: b.sub, client_reference_id: b.id },
    },
  });
  const direct = await cancelBooking(senv, b.id, { by: 'admin' });
  assert.equal(direct.ok, false);
  assert.equal(direct.error, 'paid');
  assert.equal((await row(b.id)).status, 'pending', 'nothing cancelled underneath the payment');

  const owner = await admin();
  const res = await outcome(routeHandler(adminBookings, 'POST', '/admin/bookings/:id/cancel')(
    formRequest('POST', `/admin/bookings/${b.id}/cancel`, { cookie: owner.cookie, form: { csrf: owner.csrf, reason: 'Changed mind' } }),
    senv, { id: b.id }));
  assert.match(res.headers.get('Location'), /ok=cancel-paid&also=check-confirmed-plan/);
  const r = await row(b.id);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.stripe_subscription_id, b.sub);
});

test('finding 11: when Stripe cannot say whether the checkout was paid, the booking is not cancelled', async () => {
  const b = await planBooking('pl-unknown');
  subscriptionStripe(b.sub, { bookingId: b.id, checkout: { id: b.ref, expire: 'refuse', retrieve: 'fail' } });
  const owner = await admin();
  const res = await outcome(routeHandler(adminBookings, 'POST', '/admin/bookings/:id/cancel')(
    formRequest('POST', `/admin/bookings/${b.id}/cancel`, { cookie: owner.cookie, form: { csrf: owner.csrf } }), senv, { id: b.id }));
  assert.match(res.headers.get('Location'), /err=cancel-checkout-open/);
  assert.equal((await row(b.id)).status, 'pending');
});

test('Stop plan: on a booking paid after it was cancelled, and on a live booking still owing', async () => {
  const owner = await admin();
  const stop = routeHandler(adminBookings, 'POST', '/admin/bookings/:id/stop-plan');
  const post = (b, e = senv) => outcome(stop(formRequest('POST', `/admin/bookings/${b.id}/stop-plan`, {
    cookie: owner.cookie, form: { csrf: owner.csrf, reason: 'Paying by transfer' },
  }), e, { id: b.id }));

  // Paid after cancel: the subscription is captured and can be stopped.
  const a = await planBooking('pl-stop-a');
  let state = subscriptionStripe(a.sub, { bookingId: a.id, checkout: { id: a.ref, expire: 'ok' } });
  await cancelBooking(senv, a.id, { by: 'admin' });
  await processStripeEvent(senv, completed(a));
  await processStripeEvent(senv, invoice(a, 'invoice.paid', `in_${a.sub}_1`));
  let r = await row(a.id);
  assert.deepEqual([r.status, r.needs_attention, r.stripe_subscription_id], ['cancelled', 'paid_after_cancel', a.sub]);
  assert.match(await (await routeHandler(adminBookings, 'GET', '/admin/bookings/:id')(
    formRequest('GET', `/admin/bookings/${a.id}`, { cookie: owner.cookie }), senv, { id: a.id })).text(), /Stop plan…/);
  let res = await post(a);
  assert.match(res.headers.get('Location'), /ok=plan-stopped/);
  assert.equal(state.cancelled, 1);
  r = await row(a.id);
  assert.ok(r.plan_ended_at);
  assert.equal(r.needs_attention, 'paid_after_cancel', 'the refund decision is still the owner\'s');
  stripe.restore();

  // A live booking that still owes: the rest is owed by other means.
  const c = await planBooking('pl-stop-c');
  state = subscriptionStripe(c.sub, { bookingId: c.id });
  await processStripeEvent(senv, completed(c));
  await processStripeEvent(senv, invoice(c, 'invoice.paid', `in_${c.sub}_1`));
  await processStripeEvent(senv, invoice(c, 'invoice.payment_failed', `in_${c.sub}_2`));
  res = await post(c);
  assert.match(res.headers.get('Location'), /ok=plan-stopped/);
  r = await row(c.id);
  assert.deepEqual([r.payment_method, r.payment_status, r.needs_attention], ['offline', 'unpaid', null]);
  assert.equal(state.cancelled, 1);
  await processStripeEvent(senv, deleted(c));
  assert.equal((await row(c.id)).needs_attention, null, 'Stripe confirming the end is not "ended short"');
  stripe.restore();

  // Stripe unreachable: nothing changes, the owner is told.
  const d = await planBooking('pl-stop-d');
  subscriptionStripe(d.sub, { bookingId: d.id, refuseCancel: true });
  await processStripeEvent(senv, completed(d));
  stripe.rules.find((rule) => rule[0] === 'GET' && String(rule[1]).includes(d.sub))[2] = () => ({ status: 500, body: {} });
  res = await post(d);
  assert.match(res.headers.get('Location'), /err=plan-stop-failed/);
  assert.equal((await row(d.id)).plan_ended_at, null);
});

test('Record refund: a negative row with the reason, never more than was paid, payment status unchanged', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'pl-refund' });
  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[0]] });
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: prepared.quote.sessionIds, quote: prepared.quote,
  });
  await attachPaymentRef(env, created.id, 'mock', 'cs_plrefund');
  await processStripeEvent(env, {
    id: nextId('evt'), type: 'checkout.session.completed',
    data: { object: { id: 'cs_plrefund', mode: 'payment', status: 'complete', payment_status: 'paid', client_reference_id: created.id, payment_intent: 'pi_plrefund', amount_total: 3000 } },
  });
  const owner = await admin();
  const refund = (amount, note = 'Unwell — refunded by transfer') => outcome(routeHandler(adminBookings, 'POST', '/admin/bookings/:id/record-refund')(
    formRequest('POST', `/admin/bookings/${created.id}/record-refund`, {
      cookie: owner.cookie, form: { csrf: owner.csrf, nonce: crypto.randomUUID(), amount, method: 'bank transfer', note },
    }), env, { id: created.id }));
  assert.match((await refund('31')).headers.get('Location'), /err=refund-amount/, 'more than was paid');
  assert.match((await refund('10', '')).headers.get('Location'), /err=refund-amount/, 'a reason is needed');
  assert.match((await refund('10')).headers.get('Location'), /ok=refund-recorded/);
  const r = await row(created.id);
  assert.equal(r.payment_status, 'paid', 'a refund never turns a booking unpaid');
  assert.equal(r.paid_cents, 2000);
  const rows = await env.DB.prepare(`SELECT kind, amount_cents, method, note, recorded_by FROM payments WHERE booking_id = ?1 AND kind = 'refund'`).bind(created.id).all();
  assert.deepEqual(rows.results, [{ kind: 'refund', amount_cents: -1000, method: 'bank transfer', note: 'Unwell — refunded by transfer', recorded_by: owner.userId }]);
  assert.match((await refund('20.01')).headers.get('Location'), /err=refund-amount/, 'only what is left to refund');
});
