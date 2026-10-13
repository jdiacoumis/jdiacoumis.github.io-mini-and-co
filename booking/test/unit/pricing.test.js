// Pricing rules (design D3) — pure functions, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canBookTerm, quoteTerm, quoteSessions, quoteTrial, applyVoucher, applyCredits, finaliseQuote,
  planFor, instalmentSchedule, planCancelAt, planExpectedCents, proRata, normaliseVoucherCode,
} from '../../src/lib/pricing.js';

const NOW = '2027-02-17T00:00:00Z';

function term(overrides = {}) {
  return {
    id: 't1', status: 'open', term_price_cents: 28000, casual_price_cents: 3000,
    trial_price_cents: null, returning_price_cents: null, returning_opens_at: null,
    public_opens_at: null, plan_instalments: 6, plan_interval: 'week', ...overrides,
  };
}

// Ten weekly sessions from 2027-02-03 (Wednesdays at 11:00 AEDT = 00:00Z).
function tenWeeks(extra = {}) {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `s${i + 1}`,
    starts_at: new Date(Date.UTC(2027, 1, 3 + 7 * i)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    status: extra[i + 1] || 'scheduled',
    casual_price_cents: 3000,
  }));
}

test('before the term starts: full term price for every session', () => {
  const q = quoteTerm({ term: term(), sessions: tenWeeks(), now: '2027-01-20T00:00:00Z' });
  assert.equal(q.ok, true);
  assert.equal(q.listCents, 28000);
  assert.equal(q.weeks, 10);
  assert.equal(q.totalWeeks, 10);
  assert.equal(q.isProRata, false);
});

test('family joins in week four of ten: seven tenths of the price, rounded to the cent', () => {
  // Three sessions (Feb 3, 10, 17 00:00Z) have started by Feb 17 00:00:01Z.
  const q = quoteTerm({ term: term({ term_price_cents: 16801 }), sessions: tenWeeks(), now: '2027-02-17T00:00:01Z' });
  assert.equal(q.weeks, 7);
  assert.equal(q.listCents, Math.round((16801 * 7) / 10)); // 11760.7 → 11761
  assert.equal(q.listCents, 11761);
  assert.equal(q.isProRata, true);
  assert.deepEqual(q.sessionIds, ['s4', 's5', 's6', 's7', 's8', 's9', 's10']);
});

test('cancelled sessions are not counted in the pro-rata denominator', () => {
  const q = quoteTerm({ term: term(), sessions: tenWeeks({ 6: 'cancelled' }), now: '2027-02-17T00:00:01Z' });
  assert.equal(q.totalWeeks, 9);
  assert.equal(q.weeks, 6);
  assert.equal(q.listCents, Math.round((28000 * 6) / 9));
});

test('weeks the child already holds are left out and the price follows', () => {
  const q = quoteTerm({ term: term(), sessions: tenWeeks(), now: '2027-01-20T00:00:00Z', excludeSessionIds: ['s1'] });
  assert.equal(q.weeks, 9);
  assert.equal(q.listCents, proRata(28000, 9, 10));
  const none = quoteTerm({ term: term(), sessions: tenWeeks().slice(0, 1), now: '2027-01-20T00:00:00Z', excludeSessionIds: ['s1'] });
  assert.deepEqual(none, { ok: false, reason: 'already_booked' });
});

test('a finished or closed term cannot be quoted', () => {
  assert.equal(quoteTerm({ term: term(), sessions: tenWeeks(), now: '2027-06-01T00:00:00Z' }).reason, 'finished');
  assert.equal(quoteTerm({ term: term({ status: 'closed' }), sessions: tenWeeks(), now: NOW }).reason, 'closed');
  assert.equal(quoteTerm({ term: term({ status: 'draft' }), sessions: tenWeeks(), now: NOW }).reason, 'closed');
});

test('returning family books during the returning window at the returning price', () => {
  const t = term({
    returning_price_cents: 25000,
    returning_opens_at: '2027-01-10T00:00:00Z',
    public_opens_at: '2027-01-24T00:00:00Z',
  });
  const now = '2027-01-15T00:00:00Z';
  const returning = quoteTerm({ term: t, sessions: tenWeeks(), now, returning: true });
  assert.equal(returning.ok, true);
  assert.equal(returning.isReturning, true);
  assert.equal(returning.listCents, 25000);

  // A family without a previous-term booking sees "opens on <date>".
  const stranger = quoteTerm({ term: t, sessions: tenWeeks(), now, returning: false });
  assert.deepEqual(stranger, { ok: false, reason: 'not_open_yet', opensAt: '2027-01-24T00:00:00Z' });

  // Before the returning window, a returning family is told the earlier date.
  assert.equal(canBookTerm({ term: t, now: '2027-01-01T00:00:00Z', returning: true }).opensAt, '2027-01-10T00:00:00Z');

  // After public opening a returning family still gets the returning price.
  const later = quoteTerm({ term: t, sessions: tenWeeks(), now: '2027-01-30T00:00:00Z', returning: true });
  assert.equal(later.listCents, 25000);
  assert.equal(quoteTerm({ term: t, sessions: tenWeeks(), now: '2027-01-30T00:00:00Z' }).listCents, 28000);
});

test('NULL opening instants mean open', () => {
  assert.deepEqual(canBookTerm({ term: term(), now: NOW }), { open: true, viaReturningWindow: false });
  const t = term({ public_opens_at: '2027-03-01T00:00:00Z' });
  assert.equal(canBookTerm({ term: t, now: NOW }).open, false);
  assert.equal(canBookTerm({ term: t, now: NOW, returning: true }).viaReturningWindow, true);
});

test('casual and trial quotes', () => {
  const sessions = tenWeeks().slice(4, 6).map((s, i) => ({ ...s, casual_price_cents: 3000 + i * 500 }));
  assert.equal(quoteSessions({ sessions }).listCents, 6500);
  assert.equal(quoteSessions({ sessions: [] }).ok, false);
  const s = { id: 's9', casual_price_cents: 3000 };
  assert.equal(quoteTrial({ term: term(), session: s }).listCents, 3000);           // casual fallback
  assert.equal(quoteTrial({ term: term({ trial_price_cents: 1500 }), session: s }).listCents, 1500);
  assert.equal(quoteTrial({ term: term({ trial_price_cents: 0 }), session: s }).listCents, 0); // free trial
  assert.equal(quoteTrial({ term: null, session: s }).listCents, 3000);             // one-off session
});

function voucher(overrides = {}) {
  return {
    code: 'SAVE5', kind: 'amount', value: 500, applies_to: 'any', max_uses: null, uses: 0,
    valid_from: null, valid_until: null, active: 1, ...overrides,
  };
}

test('vouchers: amount and percent, never below zero', () => {
  assert.deepEqual(applyVoucher(voucher(), { listCents: 3000, kind: 'casual', now: NOW }), { ok: true, code: 'SAVE5', discountCents: 500 });
  assert.equal(applyVoucher(voucher({ value: 9999 }), { listCents: 3000, kind: 'casual', now: NOW }).discountCents, 3000);
  assert.equal(applyVoucher(voucher({ kind: 'percent', value: 10 }), { listCents: 16800, kind: 'term', now: NOW }).discountCents, 1680);
  assert.equal(applyVoucher(voucher({ kind: 'percent', value: 15 }), { listCents: 3333, kind: 'term', now: NOW }).discountCents, 500); // 499.95 → 500
  assert.equal(applyVoucher(voucher({ kind: 'percent', value: 100 }), { listCents: 3000, kind: 'trial', now: NOW }).discountCents, 3000);
});

test('vouchers: activity, validity window, use limit and applicability', () => {
  const ctx = { listCents: 3000, kind: 'casual', now: NOW };
  assert.equal(applyVoucher(null, ctx).reason, 'not_found');
  assert.equal(applyVoucher(voucher({ active: 0 }), ctx).reason, 'inactive');
  assert.equal(applyVoucher(voucher({ valid_from: '2027-03-01T00:00:00Z' }), ctx).reason, 'not_started');
  assert.equal(applyVoucher(voucher({ valid_until: NOW }), ctx).reason, 'expired');
  assert.equal(applyVoucher(voucher({ max_uses: 3, uses: 3 }), ctx).reason, 'used_up');
  assert.equal(applyVoucher(voucher({ max_uses: 3, uses: 2 }), ctx).ok, true);
  assert.equal(applyVoucher(voucher({ applies_to: 'term' }), ctx).reason, 'not_applicable');
  assert.equal(applyVoucher(voucher({ applies_to: 'casual' }), { ...ctx, kind: 'trial' }).ok, true);
  assert.equal(applyVoucher(voucher({ applies_to: 'casual' }), { ...ctx, kind: 'term' }).reason, 'not_applicable');
  assert.equal(applyVoucher(voucher(), { ...ctx, kind: 'complimentary' }).reason, 'not_applicable');
  assert.equal(normaliseVoucherCode(' save 5 '), 'SAVE5');
});

test('credits are applied in order up to the amount due', () => {
  const credits = [{ id: 'c1', remaining_cents: 1000 }, { id: 'c2', remaining_cents: 5000 }, { id: 'c3', remaining_cents: 700 }];
  assert.deepEqual(applyCredits(credits, 3000), {
    creditCents: 3000,
    allocations: [{ creditId: 'c1', amountCents: 1000 }, { creditId: 'c2', amountCents: 2000 }],
  });
  assert.deepEqual(applyCredits(credits, 0), { creditCents: 0, allocations: [] });
  assert.equal(applyCredits([{ id: 'c1', remaining_cents: 500 }], 3000).creditCents, 500);
});

test('finaliseQuote: voucher before credits; a $30 credit covers a $30 class', () => {
  const base = quoteSessions({ sessions: [{ id: 's1', casual_price_cents: 3000 }] });
  const covered = finaliseQuote(base, { credits: [{ id: 'c1', remaining_cents: 3000 }], now: NOW });
  assert.equal(covered.amountCents, 0);
  assert.equal(covered.creditCents, 3000);

  const both = finaliseQuote(base, { voucher: voucher(), voucherCode: 'SAVE5', credits: [{ id: 'c1', remaining_cents: 1000 }], now: NOW });
  assert.equal(both.discountCents, 500);
  assert.equal(both.creditCents, 1000);
  assert.equal(both.amountCents, 1500);
  assert.equal(both.listCents - both.discountCents - both.creditCents, both.amountCents);

  const bad = finaliseQuote(base, { voucher: null, voucherCode: 'NOPE', now: NOW });
  assert.equal(bad.voucherError, 'not_found');
  assert.equal(bad.amountCents, 3000);
});

test('instalments: $168 over six weekly, $100 over three', () => {
  const six = instalmentSchedule(16800, 6, 'week', '2027-02-03T00:00:00Z');
  assert.equal(six.eachCents, 2800);
  assert.equal(six.firstCents, 2800);
  assert.deepEqual(six.payments.map((p) => p.amountCents), [2800, 2800, 2800, 2800, 2800, 2800]);
  assert.equal(six.payments[1].dueAt, '2027-02-10T00:00:00Z');
  assert.equal(six.payments[5].dueAt, '2027-03-10T00:00:00Z');

  const three = instalmentSchedule(10000, 3, 'week', '2027-02-03T00:00:00Z');
  assert.deepEqual(three.payments.map((p) => p.amountCents), [3334, 3333, 3333]);
  assert.equal(three.payments.reduce((s, p) => s + p.amountCents, 0), 10000);

  const fortnightly = instalmentSchedule(16800, 3, 'fortnight', '2027-02-03T00:00:00Z');
  assert.deepEqual(fortnightly.payments.map((p) => p.dueAt), ['2027-02-03T00:00:00Z', '2027-02-17T00:00:00Z', '2027-03-03T00:00:00Z']);
});

test('plan availability is capped by the payment dates left and the Stripe minimum', () => {
  assert.deepEqual(planFor(term(), 10, 28000), { n: 6, interval: 'week' });
  assert.deepEqual(planFor(term(), 4, 11200), { n: 4, interval: 'week' });
  assert.equal(planFor(term(), 1, 2800), null);
  assert.equal(planFor(term({ plan_instalments: 0 }), 10, 28000), null);
  assert.deepEqual(planFor(term({ plan_interval: 'fortnight', plan_instalments: 5 }), 6, 16800), { n: 3, interval: 'fortnight' });
  assert.equal(planFor(term(), 10, 200), null); // 33c instalments are below Stripe's minimum
});

test('the subscription is cancelled at the end of the n-th period, never inside one', () => {
  const anchor = Date.UTC(2027, 1, 3) / 1000;
  assert.equal(planCancelAt(anchor, 6, 'week'), anchor + 6 * 7 * 86400);
  assert.equal(planCancelAt(anchor, 3, 'fortnight'), anchor + 3 * 14 * 86400);
});

test('expected plan collections by date', () => {
  const plan = { totalCents: 10000, n: 3, eachCents: 3333, interval: 'week', anchorIso: '2027-02-03T00:00:00Z' };
  assert.equal(planExpectedCents({ ...plan, now: '2027-02-03T01:00:00Z' }), 3334);
  assert.equal(planExpectedCents({ ...plan, now: '2027-02-10T00:00:00Z' }), 6667);
  assert.equal(planExpectedCents({ ...plan, now: '2027-06-01T00:00:00Z' }), 10000);
  assert.equal(planExpectedCents({ ...plan, anchorIso: null, now: '2027-06-01T00:00:00Z' }), 0);
});
