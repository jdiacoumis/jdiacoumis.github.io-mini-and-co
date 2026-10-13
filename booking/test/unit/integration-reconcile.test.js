// Phase 3: Check with Stripe reconciles an instalment plan's ledger with the
// invoices Stripe actually collected (lost invoice.paid webhooks), through
// the drivers' listInvoices() — Stripe over REST (fetch stubbed) and the
// mock (the dev_mock_invoices outbox the dev checkout writes).

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm } from './helpers.js';
import { getPaymentsDriver } from '../../src/lib/payments-driver.js';
import { prepareBooking, createPendingBooking, attachPaymentRef, confirmBooking } from '../../src/lib/domain.js';
import { processStripeEvent } from '../../src/routes/webhooks.js';
import { checkWithStripe, reconcileInstalments, CHECK_NOTICES } from '../../src/routes/admin-ops.js';

const { env: devEnv, dispose } = await createTestDb();
after(() => dispose());
const stripeEnv = { ...devEnv, PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x' };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubStripe(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, query: u.searchParams, method: init.method || 'GET', auth: init.headers?.Authorization });
    const route = routes.find((r) => r.method === (init.method || 'GET') && r.path === u.pathname);
    const body = route ? route.body(u) : { error: { code: 'resource_missing' } };
    return new Response(JSON.stringify(body), { status: route ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const invoiceObject = (id, bookingId, subscription, { amount = 2800, status = 'paid', paidAt = 1800000000, legacy = false } = {}) => ({
  id, object: 'invoice', status, amount_paid: status === 'paid' ? amount : 0, amount_due: amount, attempt_count: 1,
  status_transitions: { paid_at: status === 'paid' ? paidAt : null }, customer: 'cus_123',
  ...(legacy
    ? { subscription, subscription_details: { metadata: { booking_id: bookingId } } }
    : { parent: { subscription_details: { subscription, metadata: { booking_id: bookingId } } } }),
});

test('Stripe listInvoices: GET /v1/invoices for the subscription, both invoice shapes normalised', async () => {
  const calls = stubStripe([{
    method: 'GET', path: '/v1/invoices',
    body: () => ({
      object: 'list', has_more: false,
      data: [
        invoiceObject('in_new', 'bk-1', 'sub_ABC123'),
        invoiceObject('in_old', 'bk-1', 'sub_ABC123', { legacy: true, status: 'open' }),
      ],
    }),
  }]);
  const invoices = await getPaymentsDriver(stripeEnv).listInvoices('sub_ABC123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.get('subscription'), 'sub_ABC123');
  assert.equal(calls[0].query.get('limit'), '100');
  assert.equal(calls[0].auth, 'Bearer sk_test_x');
  assert.deepEqual(invoices[0], {
    id: 'in_new', status: 'paid', amountPaid: 2800, amountDue: 2800, paidAt: 1800000000, attemptCount: 1,
    subscriptionId: 'sub_ABC123', bookingId: 'bk-1', customerId: 'cus_123',
  });
  assert.equal(invoices[1].subscriptionId, 'sub_ABC123', 'the older top-level shape');
  assert.equal(invoices[1].bookingId, 'bk-1');
  assert.equal(invoices[1].amountPaid, 0);
  await assert.rejects(getPaymentsDriver(stripeEnv).listInvoices('sub_x/../../charges'), /Invalid Stripe subscription id/);
});

// A confirmed six-week plan whose first instalment (in_1) reached the ledger.
async function confirmedPlan(prefix) {
  const fam = await seedFamilyAndTerm(devEnv, { prefix });
  const prepared = await prepareBooking(devEnv, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, paymentChoice: 'plan',
  });
  const created = await createPendingBooking(devEnv, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote,
  });
  const sub = `sub_${prefix.replace(/-/g, '')}`;
  await attachPaymentRef(devEnv, created.id, 'stripe', `cs_${prefix.replace(/-/g, '')}`);
  await confirmBooking(stripeEnv, created.id, { provider: 'stripe', subscriptionId: sub });
  await processStripeEvent(stripeEnv, {
    type: 'invoice.paid', data: { object: invoiceObject(`in_${prefix}_1`, created.id, sub, { paidAt: 1800000000 }) },
  });
  return { id: created.id, sub, fam };
}

const instalments = async (id) => (await devEnv.DB.prepare(
  `SELECT provider_ref, amount_cents FROM payments WHERE booking_id = ?1 AND kind = 'instalment' ORDER BY paid_at`,
).bind(id).all()).results;

test('Check with Stripe adds the instalments whose webhooks were lost — once', async () => {
  const plan = await confirmedPlan('rc-plan');
  assert.equal((await instalments(plan.id)).length, 1);
  const listed = [
    invoiceObject('in_rc-plan_3', plan.id, plan.sub, { paidAt: 1801209600 }),
    invoiceObject('in_rc-plan_2', plan.id, plan.sub, { paidAt: 1800604800 }),
    invoiceObject('in_rc-plan_1', plan.id, plan.sub, { paidAt: 1800000000 }),
    invoiceObject('in_rc-open', plan.id, plan.sub, { status: 'open' }),
    invoiceObject('in_other', 'someone-else', plan.sub, { paidAt: 1800000001 }),
  ];
  stubStripe([
    { method: 'GET', path: '/v1/invoices', body: () => ({ object: 'list', data: listed }) },
    { method: 'GET', path: `/v1/subscriptions/${plan.sub}`, body: () => ({ id: plan.sub, status: 'active', customer: 'cus_123' }) },
  ]);
  const booking = await devEnv.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(plan.id).first();
  const result = await checkWithStripe(stripeEnv, booking);
  assert.equal(result, 'check-plan-active-added');
  assert.ok(CHECK_NOTICES[result].includes('have been added to the ledger'));
  const rows = await instalments(plan.id);
  assert.deepEqual(rows.map((r) => r.provider_ref), ['in_rc-plan_1', 'in_rc-plan_2', 'in_rc-plan_3'],
    'paid invoices only, this booking only, keyed on the invoice id');
  const after1 = await devEnv.DB.prepare(`SELECT paid_cents, payment_status, plan_next_charge_at FROM bookings WHERE id = ?1`).bind(plan.id).first();
  assert.equal(after1.paid_cents, 8400);
  assert.equal(after1.payment_status, 'plan_active');
  assert.ok(after1.plan_next_charge_at, 'the next charge date follows the instalments paid');

  assert.equal(await checkWithStripe(stripeEnv, booking), 'check-plan-active', 'checking again adds nothing');
  assert.equal((await instalments(plan.id)).length, 3);
});

test('Check with Stripe on a plan whose checkout webhook was lost confirms it and records the instalments', async () => {
  const fam = await seedFamilyAndTerm(devEnv, { prefix: 'rc-lost' });
  const prepared = await prepareBooking(devEnv, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, paymentChoice: 'plan',
  });
  const created = await createPendingBooking(devEnv, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote,
  });
  await attachPaymentRef(devEnv, created.id, 'stripe', 'cs_rclost');
  stubStripe([
    {
      method: 'GET', path: '/v1/checkout/sessions/cs_rclost',
      body: () => ({
        id: 'cs_rclost', status: 'complete', payment_status: 'paid', mode: 'subscription', subscription: 'sub_rclost',
        customer: 'cus_rc', amount_total: 2800, client_reference_id: created.id,
      }),
    },
    { method: 'GET', path: '/v1/subscriptions/sub_rclost', body: () => ({ id: 'sub_rclost', status: 'active', billing_cycle_anchor: 1800000000 }) },
    { method: 'POST', path: '/v1/subscriptions/sub_rclost', body: () => ({ id: 'sub_rclost', cancel_at: 1803628800 }) },
    { method: 'GET', path: '/v1/invoices', body: () => ({ data: [invoiceObject('in_rclost_1', created.id, 'sub_rclost')] }) },
  ]);
  const booking = await devEnv.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(created.id).first();
  assert.equal(await checkWithStripe(stripeEnv, booking), 'check-confirmed-plan');
  const row = await devEnv.DB.prepare(`SELECT status, payment_status, paid_cents, stripe_subscription_id FROM bookings WHERE id = ?1`).bind(created.id).first();
  assert.deepEqual(row, { status: 'confirmed', payment_status: 'plan_active', paid_cents: 2800, stripe_subscription_id: 'sub_rclost' });
  assert.deepEqual((await instalments(created.id)).map((r) => r.provider_ref), ['in_rclost_1']);
});

test('the mock driver lists the dev outbox, so a lost mock webhook reconciles too', async () => {
  const plan = await confirmedPlan('rc-mock');
  const insert = (id, status, amount, paidAt, createdAt) => devEnv.DB.prepare(
    `INSERT INTO dev_mock_invoices (id, subscription_id, booking_id, status, amount_paid, amount_due, attempt_count, paid_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)`,
  ).bind(id, plan.sub, plan.id, status, status === 'paid' ? amount : 0, amount, paidAt, createdAt).run();
  await insert('in_rc-mock_1', 'paid', 2800, 1800000000, '2027-01-15T08:00:00Z');
  await insert('in_rc-mock_2', 'paid', 2800, 1800604800, '2027-01-22T08:00:00Z');
  await insert('in_rc-mock_failed', 'open', 2800, null, '2027-01-29T08:00:00Z');
  const listed = await getPaymentsDriver(devEnv).listInvoices(plan.sub);
  assert.deepEqual(listed.map((i) => [i.id, i.status]), [['in_rc-mock_failed', 'open'], ['in_rc-mock_2', 'paid'], ['in_rc-mock_1', 'paid']]);
  assert.equal(await reconcileInstalments(devEnv, plan.id), 1);
  assert.equal(await reconcileInstalments(devEnv, plan.id), 0);
  assert.deepEqual((await instalments(plan.id)).map((r) => r.provider_ref), ['in_rc-mock_1', 'in_rc-mock_2']);
});
