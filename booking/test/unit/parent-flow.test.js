// Parent flow helpers (lib/parent-flow.js): how terms, prices, holds and
// payment statuses are presented, plus the owner-scoped reads behind the
// class list, account and waitlist pages.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  termOffer, termHeadline, planSummary, seatsText, casualPriceText, describeDates, isCheckoutHold,
  isPayLaterHold, paymentStatusView, planScheduleView, waitlistPositionText, listWaitlistEntries,
  pendingHoldsForChild, liveTermBookings, instalmentCounts, childrenWithTrial, isInstalmentPlan,
} from '../../src/lib/parent-flow.js';
import { prepareBooking, createPendingBooking, confirmBooking } from '../../src/lib/domain.js';

const NOW = '2027-02-10T00:00:00Z';
const DAY = 86400e3;
const at = (days) => iso(Date.parse(NOW) + days * DAY);

// A listOpenTerms()-shaped term: `past` sessions before NOW, `future` after.
function makeTerm(overrides = {}, { past = 0, future = 6, seats = 12, cancelled = [] } = {}) {
  const sessions = [];
  for (let i = past; i > 0; i -= 1) sessions.push({ id: `p${i}`, starts_at: at(-7 * i + 1), status: 'scheduled', seats_left: seats, casual_price_cents: 3000 });
  for (let i = 0; i < future; i += 1) sessions.push({ id: `f${i + 1}`, starts_at: at(7 * i + 1), status: 'scheduled', seats_left: seats, casual_price_cents: 3000 });
  for (const id of cancelled) sessions.find((s) => s.id === id).status = 'cancelled';
  const scheduled = sessions.filter((s) => s.status === 'scheduled');
  const remaining = scheduled.filter((s) => s.starts_at > NOW);
  return {
    id: 'term-x', term_price_cents: 16800, casual_price_cents: 3000, trial_price_cents: null,
    returning_price_cents: null, returning_opens_at: null, public_opens_at: null, previous_term_id: null,
    plan_instalments: 6, plan_interval: 'week', status: 'open',
    ...overrides,
    sessions,
    remaining,
    total_scheduled: scheduled.length,
    term_seats_left: remaining.length ? Math.min(...remaining.map((s) => s.seats_left)) : 0,
  };
}

test('a term before it starts: whole-term price, plan, places', () => {
  const offer = termOffer({ term: makeTerm(), now: NOW });
  assert.equal(offer.access.open, true);
  assert.equal(offer.isProRata, false);
  assert.equal(offer.weeks, 6);
  assert.equal(offer.priceCents, 16800);
  assert.deepEqual(offer.plan, { n: 6, interval: 'week' });
  assert.equal(offer.seatsLeft, 12);
  assert.equal(termHeadline(offer), 'Whole term, 6 weeks — $168.00');
  assert.equal(planSummary(offer.plan, offer.priceCents), 'or 6 weekly payments of $28.00');
});

test('once started: "join for the remaining N weeks" at the pro-rata price', () => {
  const offer = termOffer({ term: makeTerm({}, { past: 2, future: 4 }), now: NOW });
  assert.equal(offer.isProRata, true);
  assert.equal(offer.weeks, 4);
  assert.equal(offer.totalWeeks, 6);
  assert.equal(offer.priceCents, 11200);
  assert.equal(termHeadline(offer), 'Join for the remaining 4 weeks — $112.00');
  assert.deepEqual(offer.plan, { n: 4, interval: 'week' }, 'no more instalments than weeks left');

  const last = termOffer({ term: makeTerm({}, { past: 5, future: 1 }), now: NOW });
  assert.equal(termHeadline(last), 'Join for the final week — $28.00');
  assert.equal(last.plan, null, 'one week left: pay in full only');
});

test('cancelled weeks are not counted in the pro-rata denominator', () => {
  const offer = termOffer({ term: makeTerm({}, { past: 2, future: 5, cancelled: ['f5'] }), now: NOW });
  assert.equal(offer.totalWeeks, 6);
  assert.equal(offer.weeks, 4);
  assert.equal(offer.priceCents, 11200);
});

test('returning window: returning families book early at their price; others see the opening date', () => {
  const term = makeTerm({
    previous_term_id: 'term-prev', returning_price_cents: 15000,
    returning_opens_at: at(-1), public_opens_at: at(2),
  });
  const returning = termOffer({ term, now: NOW, returning: true });
  assert.equal(returning.access.open, true);
  assert.equal(returning.isReturning, true);
  assert.equal(returning.priceCents, 15000);
  assert.equal(returning.returningUntil, at(2));
  assert.equal(termHeadline(returning), 'Whole term, 6 weeks — $150.00');

  const everyoneElse = termOffer({ term, now: NOW, returning: false });
  assert.equal(everyoneElse.access.open, false);
  assert.equal(everyoneElse.access.opensAt, at(2));
  assert.equal(everyoneElse.priceCents, 16800);
  assert.equal(everyoneElse.returningPriceCents, 15000);
  assert.deepEqual(everyoneElse.earlyWindow, { from: null, until: at(2) }, 'the early window is already open');
  assert.equal(everyoneElse.returningUntil, null);
});

test('before the returning window: opening dates for each audience', () => {
  const term = makeTerm({
    previous_term_id: 'term-prev', returning_price_cents: 15000,
    returning_opens_at: at(1), public_opens_at: at(3),
  });
  const returning = termOffer({ term, now: NOW, returning: true });
  assert.equal(returning.access.open, false);
  assert.equal(returning.access.opensAt, at(1));
  assert.equal(returning.isReturning, false, 'the returning price starts with the window');

  const everyoneElse = termOffer({ term, now: NOW });
  assert.equal(everyoneElse.access.opensAt, at(3));
  assert.deepEqual(everyoneElse.earlyWindow, { from: at(1), until: at(3) });
});

test('after public opening: returning families keep their price, nobody sees a window', () => {
  const term = makeTerm({
    previous_term_id: 'term-prev', returning_price_cents: 15000,
    returning_opens_at: at(-5), public_opens_at: at(-2),
  });
  const returning = termOffer({ term, now: NOW, returning: true });
  assert.equal(returning.priceCents, 15000);
  assert.equal(returning.returningUntil, null);
  const everyoneElse = termOffer({ term, now: NOW });
  assert.equal(everyoneElse.access.open, true);
  assert.equal(everyoneElse.earlyWindow, null);
  assert.equal(everyoneElse.priceCents, 16800);
});

test('a public opening date without a previous term has no early window', () => {
  const offer = termOffer({ term: makeTerm({ public_opens_at: at(2) }), now: NOW });
  assert.equal(offer.access.open, false);
  assert.equal(offer.access.opensAt, at(2));
  assert.equal(offer.earlyWindow, null);
});

test('a full term has no places for a term booking', () => {
  const term = makeTerm({}, { seats: 3 });
  term.remaining[2].seats_left = 0;
  term.term_seats_left = 0;
  assert.equal(termOffer({ term, now: NOW }).seatsLeft, 0);
});

test('plan, places and price wording', () => {
  assert.equal(planSummary({ n: 3, interval: 'week' }, 10000), 'or 3 weekly payments ($33.34, then $33.33)');
  assert.equal(planSummary({ n: 2, interval: 'fortnight' }, 6000), 'or 2 fortnightly payments of $30.00');
  assert.equal(planSummary(null, 10000), '');
  assert.equal(seatsText(12), '12 places left');
  assert.equal(seatsText(3), 'Only 3 places left');
  assert.equal(seatsText(1), 'Only 1 place left');
  assert.equal(seatsText(0), 'Full');
  assert.equal(casualPriceText([{ casual_price_cents: 3000 }, { casual_price_cents: 3000 }]), '$30.00 each');
  assert.equal(casualPriceText([{ casual_price_cents: 3000 }, { casual_price_cents: 2500 }]), 'from $25.00 each');
  assert.equal(waitlistPositionText(1), 'first in line');
  assert.equal(waitlistPositionText(3), 'number 3 in line');
});

test('dates: a range for three or more classes, a list otherwise (Sydney time)', () => {
  const starts = ['2027-02-24T00:00:00Z', '2027-02-10T00:00:00Z', '2027-02-17T00:00:00Z'];
  assert.equal(describeDates(starts), 'Wed, 10 Feb 2027 – Wed, 24 Feb 2027 (3 classes)');
  assert.equal(describeDates(['2027-02-10T00:00:00Z']), 'Wed, 10 Feb 2027, 11:00 am');
  assert.equal(describeDates([]), '');
});

test('checkout holds versus pay-later holds', () => {
  const created = '2027-02-10T00:00:00Z';
  const checkout = { status: 'pending', created_at: created, expires_at: '2027-02-10T00:35:00Z' };
  const payLater = { status: 'pending', created_at: created, expires_at: '2027-02-17T00:00:00Z' };
  assert.equal(isCheckoutHold(checkout), true);
  assert.equal(isCheckoutHold(payLater), false);
  assert.equal(isPayLaterHold(checkout, '2027-02-10T00:10:00Z'), false);
  assert.equal(isPayLaterHold(payLater, '2027-02-12T00:00:00Z'), true);
  assert.equal(isPayLaterHold(payLater, '2027-02-18T00:00:00Z'), false, 'a lapsed hold is not payable');
  assert.equal(isPayLaterHold({ ...payLater, status: 'confirmed' }, '2027-02-12T00:00:00Z'), false);
});

function booking(overrides = {}) {
  return {
    id: 'b1', kind: 'term', status: 'confirmed', amount_cents: 16800, credit_cents: 0, paid_cents: 16800,
    payment_method: 'full', payment_status: 'paid', plan_instalments: null, plan_next_charge_at: null,
    needs_attention: null, created_at: '2027-02-01T00:00:00Z', expires_at: '2027-02-01T00:35:00Z', ...overrides,
  };
}

test('payment status: paid, plan k of n with next charge, overdue, complete, unpaid, complimentary', () => {
  const now = NOW;
  assert.deepEqual(paymentStatusView(booking(), { now }), { key: 'paid', label: 'Paid', detail: '', tone: 'ok' });
  const plan = booking({
    payment_method: 'plan', payment_status: 'plan_active', plan_instalments: 6, paid_cents: 5600,
    plan_next_charge_at: '2027-02-17T00:00:00Z', stripe_subscription_id: 'sub_1',
  });
  const active = paymentStatusView(plan, { instalmentsPaid: 2, now });
  assert.equal(active.label, 'Instalments: 2 of 6 paid');
  assert.equal(active.detail, 'next payment Wed, 17 Feb 2027');
  const overdue = paymentStatusView({ ...plan, payment_status: 'plan_overdue' }, { instalmentsPaid: 2, now });
  assert.equal(overdue.key, 'plan_overdue');
  assert.equal(overdue.tone, 'alert');
  assert.equal(paymentStatusView({ ...plan, payment_status: 'plan_complete' }, { instalmentsPaid: 6, now }).detail, 'all 6 instalments');
  const unpaid = paymentStatusView(booking({ payment_status: 'unpaid', paid_cents: 6800 }), { now });
  assert.deepEqual([unpaid.label, unpaid.detail], ['Unpaid', '$100.00 to pay']);
  assert.equal(paymentStatusView(booking({ kind: 'complimentary', payment_status: 'waived', amount_cents: 0 }), { now }).label, 'Complimentary');
  assert.equal(paymentStatusView(booking({ amount_cents: 0, credit_cents: 3000, paid_cents: 3000 }), { now }).detail, 'with account credit');
});

test('a plan chosen but never started (settled another way) is not shown as instalments', () => {
  const now = NOW;
  const stale = booking({ payment_method: 'plan', plan_instalments: 6, stripe_subscription_id: null });
  assert.equal(isInstalmentPlan(stale), false);
  assert.equal(isInstalmentPlan({ ...stale, stripe_subscription_id: 'sub_1' }), true);
  assert.deepEqual(paymentStatusView({ ...stale, payment_status: 'plan_complete' }, { now }), { key: 'paid', label: 'Paid', detail: '', tone: 'ok' });
  const part = paymentStatusView({ ...stale, payment_status: 'plan_active', paid_cents: 6800 }, { now });
  assert.deepEqual([part.label, part.detail], ['Unpaid', '$100.00 to pay']);
});

test('payment status: holds, lapsed and cancelled bookings, money that arrived late', () => {
  const now = NOW;
  const held = booking({ status: 'pending', paid_cents: 0, payment_status: 'unpaid', created_at: at(-1), expires_at: at(6) });
  const payNow = paymentStatusView(held, { now });
  assert.equal(payNow.key, 'pay_now');
  assert.equal(payNow.label, 'To pay: $168.00');
  assert.match(payNow.detail, /^held for you until /);
  const paying = paymentStatusView({ ...held, created_at: now, expires_at: iso(Date.parse(now) + 35 * 60e3) }, { now });
  assert.equal(paying.key, 'paying');
  assert.equal(paymentStatusView({ ...held, expires_at: at(-0.5) }, { now }).label, 'Not completed');
  assert.equal(paymentStatusView(booking({ status: 'cancelled', paid_cents: 0 }), { now }).label, 'Cancelled');
  const paidNoSeat = paymentStatusView(booking({ status: 'expired', needs_attention: 'paid_no_seat' }), { now });
  assert.deepEqual([paidNoSeat.label, paidNoSeat.detail], ['Payment received', 'Camila will be in touch']);
});

test('the plan schedule marks the instalments already paid', () => {
  const rows = planScheduleView(booking({
    amount_cents: 10000, payment_method: 'plan', plan_instalments: 3, plan_interval: 'week',
    paid_at: '2027-02-10T00:00:00Z',
  }), 1);
  assert.deepEqual(rows.map((r) => [r.amountCents, r.paid]), [[3334, true], [3333, false], [3333, false]]);
  assert.equal(rows[1].dueAt, '2027-02-17T00:00:00Z');

  // A place held for a week and paid today: the dates run from today, not
  // from when the hold was created, while the payment record is on its way.
  const held = planScheduleView(booking({
    amount_cents: 10000, payment_method: 'plan', plan_instalments: 3, plan_interval: 'week',
    paid_at: null, created_at: '2027-02-01T00:00:00Z',
  }), 0, '2027-02-08T03:00:00Z');
  assert.deepEqual(held.map((r) => r.dueAt), ['2027-02-08T03:00:00Z', '2027-02-15T03:00:00Z', '2027-02-22T03:00:00Z']);
});

// --- Owner-scoped reads against a real D1 ------------------------------------

const { env, dispose } = await createTestDb();
after(() => dispose());

async function book(fam, { kind = 'term', sessionIds = [], childId = fam.childId, expiresAt = null } = {}) {
  const prepared = await prepareBooking(env, { userId: fam.userId, childId, kind, termId: fam.termId, sessionIds });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId, kind, termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote, expiresAt,
  });
  assert.ok(created.id, JSON.stringify(created));
  return created.id;
}

test('waitlist places follow join order and close up when a family leaves', async () => {
  const a = await seedFamilyAndTerm(env, { prefix: 'wl-a' });
  const others = [];
  for (const prefix of ['wl-b', 'wl-c']) {
    const now = iso(Date.now());
    await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3)`).bind(`${prefix}-user`, `${prefix}@example.com`, now).run();
    await env.DB.prepare(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, ?2, 'Kid', '2025-10-01', ?3)`)
      .bind(`${prefix}-child`, `${prefix}-user`, now).run();
    others.push(prefix);
  }
  const join = (id, user, child, joinedAt) => env.DB.prepare(
    `INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at) VALUES (?1, ?2, ?3, ?4, 'waiting', ?5)`,
  ).bind(id, a.termId, user, child, joinedAt).run();
  await join('wl-1', 'wl-b-user', 'wl-b-child', daysFromNow(-3));
  await join('wl-2', a.userId, a.childId, daysFromNow(-2));
  await join('wl-3', 'wl-c-user', 'wl-c-child', daysFromNow(-1));

  const [mine] = await listWaitlistEntries(env, a.userId, { termId: a.termId });
  assert.equal(mine.position, 2);
  assert.equal(mine.term_name, 'Test Term');
  assert.equal(mine.child_name, 'Child 0');
  assert.equal((await listWaitlistEntries(env, 'wl-c-user'))[0].position, 3);

  await env.DB.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = 'wl-1'`).run();
  assert.equal((await listWaitlistEntries(env, a.userId))[0].position, 1);
  assert.deepEqual(await listWaitlistEntries(env, 'wl-b-user'), [], 'left entries are not listed');
  assert.equal((await listWaitlistEntries(env, 'wl-b-user', { statuses: ['removed'] })).length, 1);
});

test('holds, live term bookings and trial use are read per family', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'hold', children: 2 });
  const now = iso(Date.now());
  const termBooking = await book(fam, { expiresAt: daysFromNow(7) });
  const trial = await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]], childId: fam.childIds[1] });

  const holds = await pendingHoldsForChild(env, { userId: fam.userId, childId: fam.childId, termId: fam.termId, now });
  assert.deepEqual(holds.map((h) => h.id), [termBooking]);
  assert.equal(isPayLaterHold(holds[0], now), true);
  const bySession = await pendingHoldsForChild(env, {
    userId: fam.userId, childId: fam.childIds[1], sessionIds: [fam.sessionIds[0]], kind: 'trial', now,
  });
  assert.deepEqual(bySession.map((h) => h.id), [trial]);
  assert.deepEqual(await pendingHoldsForChild(env, { userId: 'someone-else', childId: fam.childId, termId: fam.termId, now }), []);

  const live = await liveTermBookings(env, fam.userId, now);
  assert.deepEqual(live.map((b) => [b.id, b.child_name]), [[termBooking, 'Child 0']]);

  const children = [{ id: fam.childIds[0] }, { id: fam.childIds[1] }];
  assert.deepEqual([...(await childrenWithTrial(env, children, now))], [fam.childIds[1]]);

  await confirmBooking(env, termBooking, {
    provider: 'mock', payment: { kind: 'instalment', amountCents: 2800, provider: 'mock', providerRef: 'in_hold_1' },
  });
  assert.deepEqual(await pendingHoldsForChild(env, { userId: fam.userId, childId: fam.childId, termId: fam.termId, now }), []);
  assert.equal((await instalmentCounts(env, fam.userId)).get(termBooking), 1);
});
