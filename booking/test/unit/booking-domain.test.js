// Booking domain (designs D2, D3, D6) against a real D1: kinds and pricing,
// opening rules, one trial per child per class, credits and vouchers inside
// the reservation batch (and given back on expiry), the guarded confirmation
// and cancellation.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  prepareBooking, createPendingBooking, confirmBooking, cancelBooking, expireBooking,
  sweepExpiredBookings, abandonCheckout, isReturningFamily, childHasTrial, listOpenTerms,
  termSessionsRemaining, getOwnedBooking, effectiveStatus, markPurchaseTracked,
} from '../../src/lib/domain.js';
import { issueCredit, availableCredits, loadVoucher } from '../../src/lib/ledger.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const NOW = () => iso(Date.now());

async function book(fam, { kind = 'term', sessionIds = [], voucherCode = '', paymentChoice = 'full', childId = fam.childId, userId = fam.userId, termId = fam.termId } = {}) {
  const prepared = await prepareBooking(env, { userId, childId, kind, termId, sessionIds, voucherCode, paymentChoice });
  if (!prepared.ok) return { prepared };
  const created = await createPendingBooking(env, {
    userId, childId, kind, termId, sessionIds: prepared.quote.sessionIds, quote: prepared.quote,
    waiverVersion: 'test-1', photoConsent: true, medicalNotes: '',
  });
  return { prepared, created };
}

async function row(id) {
  return env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();
}

test('term booking covers every remaining session at the term price', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'a' });
  const { prepared, created } = await book(fam);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.quote.listCents, 16800);
  assert.equal(prepared.quote.weeks, 6);
  assert.deepEqual(prepared.quote.planOption, { n: 6, interval: 'week' });
  assert.ok(created.id);
  const b = await row(created.id);
  assert.equal(b.kind, 'term');
  assert.equal(b.term_id, fam.termId);
  assert.equal(b.amount_cents, 16800);
  assert.equal(b.payment_method, 'full');
  const seats = await env.DB.prepare(`SELECT COUNT(*) AS n FROM booking_sessions WHERE booking_id = ?1 AND status = 'booked'`).bind(created.id).first();
  assert.equal(seats.n, 6);

  const { remaining, totalScheduled } = await termSessionsRemaining(env, fam.termId);
  assert.equal(totalScheduled, 6);
  assert.equal(remaining[0].seats_held, 1);
});

test('after the term starts the price is pro-rated on the remaining weeks', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'b', startInDays: -10 }); // weeks 1-2 have passed
  const { prepared } = await book(fam);
  assert.equal(prepared.quote.weeks, 4);
  assert.equal(prepared.quote.listCents, Math.round((16800 * 4) / 6));
  assert.equal(prepared.quote.isProRata, true);
});

test('plan choice snapshots the schedule; a plan needs a term booking', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'c' });
  const { prepared, created } = await book(fam, { paymentChoice: 'plan' });
  assert.equal(prepared.quote.plan.n, 6);
  assert.equal(prepared.quote.plan.eachCents, 2800);
  assert.equal(prepared.quote.plan.firstCents, 2800);
  const b = await row(created.id);
  assert.equal(b.payment_method, 'plan');
  assert.equal(b.plan_instalments, 6);
  assert.equal(b.plan_instalment_cents, 2800);
  assert.equal(b.plan_interval, 'week');

  const casual = await prepareBooking(env, {
    userId: fam.userId, childId: fam.childIds[0], kind: 'casual', termId: fam.termId,
    sessionIds: [fam.sessionIds[5]], paymentChoice: 'plan',
  });
  assert.equal(casual.ok, false);
});

test('one trial per child per class, at the trial price', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'd', trialPrice: 1500, children: 2 });
  const first = await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]] });
  assert.equal(first.prepared.quote.listCents, 1500);
  assert.ok(first.created.id);
  assert.equal(await childHasTrial(env, fam.childId, fam.classId), true);

  const second = await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[1]] });
  assert.equal(second.prepared.ok, false);
  assert.equal(second.prepared.error, 'trial_used');

  // The guard inside the batch refuses it too (bypassing prepareBooking).
  const direct = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'trial', termId: fam.termId, sessionIds: [fam.sessionIds[2]],
    quote: { listCents: 1500, discountCents: 0, creditCents: 0, amountCents: 1500, allocations: [] },
  });
  assert.equal(direct.error, 'trial_used');

  // A sibling may still trial; more than one session is never a trial.
  assert.ok((await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]], childId: fam.childIds[1] })).created.id);
  const two = await prepareBooking(env, { userId: fam.userId, childId: fam.childIds[1], kind: 'trial', termId: fam.termId, sessionIds: fam.sessionIds.slice(0, 2) });
  assert.equal(two.error, 'trial_one_session');

  // An expired trial no longer counts.
  await expireBooking(env, first.created.id);
  assert.equal(await childHasTrial(env, fam.childId, fam.classId), false);
});

test('two concurrent trials for one child resolve to one (in-batch guard)', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'd2' });
  const quote = { listCents: 3000, discountCents: 0, creditCents: 0, amountCents: 3000, allocations: [] };
  const attempts = await Promise.all(fam.sessionIds.slice(0, 4).map((sessionId) => createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'trial', termId: fam.termId, sessionIds: [sessionId], quote,
  })));
  assert.equal(attempts.filter((a) => a.id).length, 1, 'exactly one trial may win');
  assert.ok(attempts.filter((a) => a.error).every((a) => a.error === 'trial_used'));
});

test('a term booking skips weeks the child already holds (e.g. a trial)', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'e' });
  await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]] });
  const { prepared, created } = await book(fam);
  assert.equal(prepared.quote.weeks, 5);
  assert.deepEqual(prepared.warnings, ['child_already_holds_some_weeks']);
  assert.ok(created.id);
});

test('opening times: returning families first, everyone else from public opening', async () => {
  const prev = await seedFamilyAndTerm(env, { prefix: 'f-prev', status: 'closed', startInDays: -60 });
  await env.DB.prepare(
    `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
     VALUES ('f-prev-booking', ?1, ?2, 'term', ?3, 'confirmed', 16800, ?4)`,
  ).bind(prev.userId, prev.childId, prev.termId, NOW()).run();

  const next = await seedFamilyAndTerm(env, {
    prefix: 'f-next', previousTermId: prev.termId, returningPrice: 15000,
    returningOpensAt: daysFromNow(-1), publicOpensAt: daysFromNow(2),
  });
  assert.equal(await isReturningFamily(env, prev.userId, next.termId), true);
  assert.equal(await isReturningFamily(env, next.userId, next.termId), false);

  const returning = await prepareBooking(env, { userId: prev.userId, childId: prev.childId, kind: 'term', termId: next.termId });
  assert.equal(returning.ok, true);
  assert.equal(returning.quote.listCents, 15000);
  assert.equal(returning.quote.isReturning, true);

  const stranger = await prepareBooking(env, { userId: next.userId, childId: next.childId, kind: 'term', termId: next.termId });
  assert.equal(stranger.error, 'not_open_yet');
  assert.ok(stranger.opensAt);
  // Casual and trial bookings follow the term's opening time too.
  const casual = await prepareBooking(env, { userId: next.userId, childId: next.childId, kind: 'casual', termId: next.termId, sessionIds: [next.sessionIds[0]] });
  assert.equal(casual.error, 'not_open_yet');
  // The owner can always book.
  const admin = await prepareBooking(env, { userId: next.userId, childId: next.childId, kind: 'term', termId: next.termId, admin: true });
  assert.equal(admin.ok, true);
});

test('a voucher is counted in the reservation batch and given back when the hold lapses', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'g' });
  await env.DB.prepare(
    `INSERT INTO vouchers (code, kind, value, max_uses, uses, active, created_at) VALUES ('ONCE', 'amount', 500, 1, 0, 1, ?1)`,
  ).bind(NOW()).run();
  const { prepared, created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]], voucherCode: 'once' });
  assert.equal(prepared.quote.discountCents, 500);
  assert.equal(prepared.quote.amountCents, 2500);
  assert.equal((await loadVoucher(env, 'ONCE')).uses, 1);

  const again = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[1]], voucherCode: 'ONCE' });
  assert.equal(again.quote.voucherError, 'used_up');

  await env.DB.prepare(`UPDATE bookings SET expires_at = ?2 WHERE id = ?1`).bind(created.id, daysFromNow(-0.01)).run();
  assert.equal(await sweepExpiredBookings(env), 1);
  assert.equal((await loadVoucher(env, 'ONCE')).uses, 0, 'the lapsed booking gave its use back');
  assert.equal((await row(created.id)).status, 'expired');
});

test('credits: redeemed when reserving, returned on expiry, re-taken when a late payment confirms', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'h' });
  const creditId = await issueCredit(env, { userId: fam.userId, amountCents: 1000, reason: 'Goodwill' });
  const { prepared, created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  assert.equal(prepared.quote.creditCents, 1000);
  assert.equal(prepared.quote.amountCents, 2000);
  assert.deepEqual(await availableCredits(env, fam.userId, fam.childId), []);

  await expireBooking(env, created.id);
  assert.equal((await availableCredits(env, fam.userId, fam.childId))[0].remaining_cents, 1000, 'expiry returned the credit');

  // The payment lands late; the seat is still free → confirmed, credit re-taken.
  const result = await confirmBooking(env, created.id, {
    provider: 'mock', payment: { kind: 'checkout', amountCents: 2000, provider: 'mock', providerRef: 'pi_late_h' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reconfirmed, true);
  assert.equal(result.creditShortfall, false);
  const b = await row(created.id);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.paid_cents, 3000, 'checkout + credit_applied rows');
  assert.equal(b.payment_status, 'paid');
  const credit = await env.DB.prepare(`SELECT remaining_cents FROM credits WHERE id = ?1`).bind(creditId).first();
  assert.equal(credit.remaining_cents, 0);
});

test('a late payment whose credit was spent meanwhile confirms, records only the credit re-taken, and is flagged', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'h2', children: 2 });
  const creditId = await issueCredit(env, { userId: fam.userId, amountCents: 1000 });
  const first = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  assert.equal(first.prepared.quote.creditCents, 1000);
  await expireBooking(env, first.created.id);                     // credit returned…
  const second = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[1]], childId: fam.childIds[1] });
  assert.equal(second.prepared.quote.creditCents, 1000);           // …and spent by a sibling's booking

  const result = await confirmBooking(env, first.created.id, {
    provider: 'mock', payment: { kind: 'checkout', amountCents: 2000, providerRef: 'pi_late_h2' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.creditShortfall, true);
  const b = await row(first.created.id);
  assert.equal(b.status, 'confirmed', 'the family paid, the seat was free: honoured');
  assert.equal(b.needs_attention, 'credit_shortfall');
  assert.equal(b.paid_cents, 2000, 'no credit_applied row for credit that was not redeemed');
  assert.equal(b.payment_status, 'unpaid', '$10 still outstanding');
  const credit = await env.DB.prepare(`SELECT remaining_cents FROM credits WHERE id = ?1`).bind(creditId).first();
  assert.equal(credit.remaining_cents, 0, 'never overspent');
});

test('a credit covering the whole class confirms with nothing to pay', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'i' });
  await issueCredit(env, { userId: fam.userId, amountCents: 3000 });
  const { prepared, created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[2]] });
  assert.equal(prepared.quote.amountCents, 0);
  const result = await confirmBooking(env, created.id, { provider: 'free' });
  assert.equal(result.ok, true);
  assert.equal(result.newlyConfirmed, true);
  const b = await row(created.id);
  assert.equal(b.payment_method, 'none');
  assert.equal(b.payment_status, 'paid');
  const ledger = await env.DB.prepare(`SELECT kind, amount_cents FROM payments WHERE booking_id = ?1`).bind(created.id).all();
  assert.deepEqual(ledger.results, [{ kind: 'credit_applied', amount_cents: 3000 }]);
  const redemption = await env.DB.prepare(`SELECT amount_cents FROM credit_redemptions WHERE booking_id = ?1`).bind(created.id).first();
  assert.equal(redemption.amount_cents, 3000);
});

test('confirm is idempotent; a second payment reference is recorded, the first is not doubled', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'j' });
  const { created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  const payment = { kind: 'checkout', amountCents: 3000, provider: 'mock', providerRef: 'pi_j' };
  const first = await confirmBooking(env, created.id, { provider: 'mock', payment });
  const second = await confirmBooking(env, created.id, { provider: 'mock', payment });
  assert.equal(first.newlyConfirmed, true);
  assert.equal(second.newlyConfirmed, false);
  assert.equal((await row(created.id)).paid_cents, 3000);
});

test('late payment after the seat was resold is recorded and flagged paid_no_seat', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'k', capacity: 1, children: 2 });
  const a = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  await expireBooking(env, a.created.id);                                     // A's hold lapses
  const b = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]], childId: fam.childIds[1] });
  await confirmBooking(env, b.created.id, { provider: 'mock', payment: { kind: 'checkout', amountCents: 3000, providerRef: 'pi_k_b' } });

  const late = await confirmBooking(env, a.created.id, {
    provider: 'mock', payment: { kind: 'checkout', amountCents: 3000, providerRef: 'pi_k_a' },
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'paid_no_seat');
  const rowA = await row(a.created.id);
  assert.equal(rowA.status, 'expired', 'A stays expired');
  assert.equal(rowA.needs_attention, 'paid_no_seat');
  assert.equal(rowA.paid_cents, 3000, "A's payment is in the ledger");
  assert.equal((await row(b.created.id)).status, 'confirmed', 'B keeps the seat');
  const held = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM booking_sessions bs JOIN bookings b ON b.id = bs.booking_id
     WHERE bs.session_id = ?1 AND b.status = 'confirmed'`,
  ).bind(fam.sessionIds[0]).first();
  assert.equal(held.n, 1, 'never oversold');
});

test('a pending booking past its hold (not yet swept) is re-checked the same way', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'l' });
  const { created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[1]] });
  await env.DB.prepare(`UPDATE bookings SET expires_at = ?2 WHERE id = ?1`).bind(created.id, daysFromNow(-0.01)).run();
  assert.equal(effectiveStatus(await row(created.id)), 'expired');
  const result = await confirmBooking(env, created.id, { provider: 'mock', payment: { kind: 'checkout', amountCents: 3000, providerRef: 'pi_l' } });
  assert.equal(result.ok, true);
  assert.equal(result.reconfirmed, true);
});

test('payment for a cancelled booking is recorded and flagged paid_after_cancel', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'm' });
  const { created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  const cancelled = await cancelBooking(env, created.id, { by: 'admin-1', reason: 'Family moved' });
  assert.equal(cancelled.ok, true);
  const late = await confirmBooking(env, created.id, { provider: 'mock', payment: { kind: 'checkout', amountCents: 3000, providerRef: 'pi_m' } });
  assert.equal(late.error, 'cancelled');
  assert.equal(late.flagged, 'paid_after_cancel');
  const b = await row(created.id);
  assert.equal(b.status, 'cancelled');
  assert.equal(b.needs_attention, 'paid_after_cancel');
  assert.equal(b.paid_cents, 3000);
  assert.equal(b.cancel_reason, 'Family moved');
});

test('cancelling a pending booking gives its credit back; a confirmed one keeps it', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'n' });
  await issueCredit(env, { userId: fam.userId, amountCents: 500 });
  const pending = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  await cancelBooking(env, pending.created.id, { by: 'admin' });
  assert.equal((await availableCredits(env, fam.userId, fam.childId))[0].remaining_cents, 500);

  const confirmed = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[1]] });
  await confirmBooking(env, confirmed.created.id, { provider: 'mock', payment: { kind: 'checkout', amountCents: 2500, providerRef: 'pi_n' } });
  await cancelBooking(env, confirmed.created.id, { by: 'admin' });
  assert.deepEqual(await availableCredits(env, fam.userId, fam.childId), []);
  assert.equal((await cancelBooking(env, confirmed.created.id)).error, 'cancelled');
});

test('abandoning a checkout releases a checkout hold but keeps a pay-later hold', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'o', children: 2 });
  const quick = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  await env.DB.prepare(`UPDATE bookings SET payment_ref = 'cs_quick' WHERE id = ?1`).bind(quick.created.id).run();
  assert.equal(await abandonCheckout(env, quick.created.id, 'cs_other'), 'noop', 'another checkout is attached');
  assert.equal(await abandonCheckout(env, quick.created.id, 'cs_quick'), 'expired');

  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childIds[1], kind: 'term', termId: fam.termId });
  const payLater = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childIds[1], kind: 'term', termId: fam.termId,
    sessionIds: prepared.quote.sessionIds, quote: prepared.quote, expiresAt: daysFromNow(2),
  });
  await env.DB.prepare(`UPDATE bookings SET payment_ref = 'cs_later' WHERE id = ?1`).bind(payLater.id).run();
  assert.equal(await abandonCheckout(env, payLater.id, 'cs_later'), 'detached');
  const b = await row(payLater.id);
  assert.equal(b.status, 'pending');
  assert.equal(b.payment_ref, null);
});

test('open terms list seats per session and the term-wide seats left', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'p', capacity: 2 });
  await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[3]] });
  const terms = await listOpenTerms(env);
  const term = terms.find((t) => t.id === fam.termId);
  assert.equal(term.total_scheduled, 6);
  assert.equal(term.remaining.length, 6);
  assert.equal(term.term_seats_left, 1);
  assert.equal(term.class_name, 'Sensory Play');
});

test('owner-scoped reads and the Purchase-once flag', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'q' });
  const other = await seedFamilyAndTerm(env, { prefix: 'q2' });
  const { created } = await book(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  assert.equal(await getOwnedBooking(env, created.id, other.userId), null);
  const mine = await getOwnedBooking(env, created.id, fam.userId);
  assert.equal(mine.sessions.length, 1);
  assert.equal('admin_notes' in mine, false, 'owner notes never reach the family');

  assert.equal(await markPurchaseTracked(env, created.id), false, 'only confirmed bookings track a Purchase');
  await confirmBooking(env, created.id, { provider: 'mock', payment: { kind: 'checkout', amountCents: 3000, providerRef: 'pi_q' } });
  assert.equal(await markPurchaseTracked(env, created.id), true);
  assert.equal(await markPurchaseTracked(env, created.id), false, 'Purchase renders once');
});
