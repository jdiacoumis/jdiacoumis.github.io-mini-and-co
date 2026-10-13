// Phase 3 integration fixes in the shared domain (lib/domain.js) and the
// modules that lean on it: clearing an attention flag through flagBooking,
// owner-cancelled trials no longer using up the child's one trial, ONE
// checkout-hold rule shared by every module, an abandoned instalment-plan
// checkout falling back to "pay in full", and every pay-later hold outlasting
// the checkout-hold threshold.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  prepareBooking, createPendingBooking, confirmBooking, abandonCheckout, attachPaymentRef, childHasTrial,
  flagBooking, flagStatement, isCheckoutHold, CHECKOUT_HOLD_MAX_SECS, PENDING_BOOKING_EXPIRY_SECS,
} from '../../src/lib/domain.js';
import { isCheckoutHold as parentIsCheckoutHold } from '../../src/lib/parent-flow.js';
import {
  isCheckoutHold as adminIsCheckoutHold, resolveAttention, clearFlagIf, cancelBookingWeek,
  cancelSessionWithCredits, transferBookingSession, PAY_LATER_HOLD_SECS, autoEnrolExpiry, createAdminBooking,
} from '../../src/lib/admin-ops.js';
import { offerPlace, OFFER_HOLD_HOURS } from '../../src/routes/admin-waitlist.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const row = (id) => env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();

async function book(fam, {
  kind = 'term', sessionIds = [], childId = fam.childId, paymentChoice = 'full', expiresAt = null,
} = {}) {
  const prepared = await prepareBooking(env, {
    userId: fam.userId, childId, kind, termId: fam.termId, sessionIds, paymentChoice,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId, kind, termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote, expiresAt, waiverVersion: 'test-1', photoConsent: true, medicalNotes: '',
  });
  assert.ok(created.id, JSON.stringify(created));
  return { id: created.id, quote: prepared.quote };
}

async function bookPaid(fam, options) {
  const booking = await book(fam, options);
  const result = await confirmBooking(env, booking.id, {
    provider: 'mock',
    payment: { kind: 'checkout', amountCents: booking.quote.amountCents, provider: 'mock', providerRef: `pi_${booking.id}` },
  });
  assert.equal(result.ok, true);
  return booking;
}

// --- 1. flagBooking(env, id, null) clears ----------------------------------------

test('flagBooking(null) clears the flag; onlyIf never clears a different flag', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-flag' });
  const { id } = await bookPaid(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });

  assert.equal(await flagBooking(env, id, 'webhook_mismatch'), true);
  assert.equal((await row(id)).needs_attention, 'webhook_mismatch');
  assert.equal(await flagBooking(env, id, null), true, 'null clears');
  assert.equal((await row(id)).needs_attention, null);
  assert.equal(await flagBooking(env, id, null), true, 'clearing again is harmless');

  await flagBooking(env, id, 'plan_overdue');
  await flagBooking(env, id, 'paid_no_seat', { overwrite: false });
  assert.equal((await row(id)).needs_attention, 'plan_overdue', 'overwrite: false keeps the earlier flag');
  assert.equal(await flagBooking(env, id, null, { onlyIf: ['paid_no_seat'] }), false, 'a different flag is kept');
  assert.equal((await row(id)).needs_attention, 'plan_overdue');
  await flagStatement(env, id, null, { onlyIf: ['paid_no_seat', 'plan_overdue'] }).run();
  assert.equal((await row(id)).needs_attention, null);
  assert.throws(() => flagStatement(env, id, 'not_a_flag'), /Unknown attention flag/);
});

test("the owner's Resolve and Check with Stripe's clear go through flagStatement and keep the note", async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-resolve' });
  const { id } = await bookPaid(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  await flagBooking(env, id, 'webhook_mismatch');
  assert.equal(await resolveAttention(env, id, { note: 'Rang the family' }), true);
  let b = await row(id);
  assert.equal(b.needs_attention, null);
  assert.match(b.admin_notes, /resolved "Payment doesn't match the booking" — Rang the family/);
  assert.equal(await resolveAttention(env, id, { note: 'again' }), false, 'nothing left to resolve');

  await flagBooking(env, id, 'plan_ended_short');
  assert.equal(await clearFlagIf(env, id, ['paid_no_seat'], 'Check with Stripe: paid'), false);
  b = await row(id);
  assert.equal(b.needs_attention, 'plan_ended_short', 'another flag is never cleared');
  assert.ok(!b.admin_notes.includes('Check with Stripe'), 'and no note is written');
  await flagBooking(env, id, 'paid_no_seat');
  assert.equal(await clearFlagIf(env, id, ['paid_no_seat'], 'Check with Stripe: paid'), true);
  b = await row(id);
  assert.equal(b.needs_attention, null);
  assert.ok(b.admin_notes.endsWith('Check with Stripe: paid'));
});

// --- 2. a trial the owner called off is not "used" -------------------------------

test('a trial whose week the owner cancelled frees the child for another trial', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-trial-week', trialPrice: 2000 });
  const trial = await bookPaid(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]] });
  assert.equal(await childHasTrial(env, fam.childId, fam.classId), true);
  const refused = await prepareBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'trial', termId: fam.termId, sessionIds: [fam.sessionIds[1]],
  });
  assert.equal(refused.error, 'trial_used');

  const cancelled = await cancelBookingWeek(env, { bookingId: trial.id, sessionId: fam.sessionIds[0], creditCents: 2000, by: 'owner' });
  assert.equal(cancelled.ok, true);
  assert.equal(await childHasTrial(env, fam.childId, fam.classId), false, 'the cancelled trial no longer counts');
  const again = await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[1]] });
  assert.ok(again.id, 'a second trial can be booked (in-batch guard included)');
});

test('a trial in a class the owner cancelled frees the child; a moved trial still counts', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-trial-session', children: 2 });
  await bookPaid(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]] });
  const moved = await bookPaid(fam, { kind: 'trial', sessionIds: [fam.sessionIds[0]], childId: fam.childIds[1] });

  const transfer = await transferBookingSession(env, { bookingId: moved.id, fromSessionId: fam.sessionIds[0], toSessionId: fam.sessionIds[2] });
  assert.equal(transfer.ok, true);
  const result = await cancelSessionWithCredits(env, fam.sessionIds[0], { reason: 'Venue closed', by: 'owner' });
  assert.equal(result.ok, true);

  assert.equal(await childHasTrial(env, fam.childIds[0], fam.classId), false, 'cancelled class: trial not used');
  assert.ok((await book(fam, { kind: 'trial', sessionIds: [fam.sessionIds[1]] })).id);
  assert.equal(await childHasTrial(env, fam.childIds[1], fam.classId), true, 'a trial moved to another week is still the trial');
  const second = await prepareBooking(env, {
    userId: fam.userId, childId: fam.childIds[1], kind: 'trial', termId: fam.termId, sessionIds: [fam.sessionIds[3]],
  });
  assert.equal(second.error, 'trial_used');
});

// --- 3. one checkout-hold rule ----------------------------------------------------

test('parent pages and admin pages use the domain checkout-hold rule itself', () => {
  assert.equal(parentIsCheckoutHold, isCheckoutHold);
  assert.equal(adminIsCheckoutHold, isCheckoutHold);
  const created = '2027-02-10T00:00:00Z';
  const at = (secs) => iso(Date.parse(created) + secs * 1000);
  assert.equal(isCheckoutHold({ created_at: created, expires_at: at(PENDING_BOOKING_EXPIRY_SECS) }), true);
  assert.equal(isCheckoutHold({ created_at: created, expires_at: at(CHECKOUT_HOLD_MAX_SECS) }), true);
  assert.equal(isCheckoutHold({ created_at: created, expires_at: at(CHECKOUT_HOLD_MAX_SECS + 1) }), false);
  assert.equal(CHECKOUT_HOLD_MAX_SECS, 40 * 60);
});

// --- 4. an abandoned plan checkout falls back to paying in full ------------------

async function choosePlan(id, ref) {
  // As Pay now does it (routes/booking.js createHostedCheckout, exclusive).
  await env.DB.prepare(
    `UPDATE bookings SET payment_provider = 'mock', payment_ref = ?2, payment_method = 'plan',
            plan_instalments = 6, plan_instalment_cents = 2800, plan_interval = 'week'
     WHERE id = ?1`,
  ).bind(id, ref).run();
}

test('abandoning a plan checkout on a pay-later hold forgets the plan; an offline payment is then "paid"', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-plan-later' });
  const held = await book(fam, { expiresAt: daysFromNow(7) });
  await choosePlan(held.id, 'cs_plan_later');

  assert.equal(await abandonCheckout(env, held.id, 'cs_plan_later'), 'detached');
  const b = await row(held.id);
  assert.equal(b.status, 'pending', 'the held place is kept');
  assert.equal(b.payment_ref, null);
  assert.deepEqual([b.payment_method, b.plan_instalments, b.plan_instalment_cents, b.plan_interval, b.plan_next_charge_at],
    ['full', null, null, null, null]);

  const part = await confirmBooking(env, held.id, {
    provider: 'external', payment: { kind: 'offline', amountCents: 5000, providerRef: 'offline:ix-part', method: 'cash' },
  });
  assert.equal(part.ok, true);
  assert.equal((await row(held.id)).payment_status, 'unpaid', 'part-paid by hand is unpaid, never plan_active');
  await confirmBooking(env, held.id, {
    payment: { kind: 'offline', amountCents: 11800, providerRef: 'offline:ix-rest', method: 'cash' },
  });
  const paid = await row(held.id);
  assert.deepEqual([paid.status, paid.payment_status, paid.paid_cents], ['confirmed', 'paid', 16800]);
});

test('abandoning a plan checkout hold releases it and forgets the plan; a newer checkout keeps its plan', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-plan-now', children: 2 });
  const quick = await book(fam, { paymentChoice: 'plan' });
  await attachPaymentRef(env, quick.id, 'mock', 'cs_plan_now');
  assert.equal((await row(quick.id)).payment_method, 'plan');
  assert.equal(await abandonCheckout(env, quick.id, 'cs_plan_now'), 'expired');
  const expired = await row(quick.id);
  assert.deepEqual([expired.status, expired.payment_method, expired.plan_instalments], ['expired', 'full', null]);

  // A late offline payment re-takes the seats and is a plain payment.
  const late = await confirmBooking(env, quick.id, {
    provider: 'external', payment: { kind: 'offline', amountCents: 16800, providerRef: 'offline:ix-late', method: 'bank transfer' },
  });
  assert.equal(late.ok, true);
  assert.equal((await row(quick.id)).payment_status, 'paid');

  // Another tab attached a newer plan checkout: the stale abandon changes nothing.
  const held = await book(fam, { childId: fam.childIds[1], expiresAt: daysFromNow(7) });
  await choosePlan(held.id, 'cs_newer');
  assert.equal(await abandonCheckout(env, held.id, 'cs_older'), 'noop');
  const kept = await row(held.id);
  assert.deepEqual([kept.payment_ref, kept.payment_method, kept.plan_instalments], ['cs_newer', 'plan', 6]);
});

// --- 11. every pay-later hold outlasts the checkout-hold threshold ---------------

test('pay-later holds (manual 7 days, auto-enrol, waitlist offers) all clear the checkout-hold threshold', async () => {
  assert.ok(PAY_LATER_HOLD_SECS > CHECKOUT_HOLD_MAX_SECS);
  assert.ok(OFFER_HOLD_HOURS * 3600 > CHECKOUT_HOLD_MAX_SECS);
  const now = '2027-01-10T00:00:00Z';
  const span = (expiresAt) => (Date.parse(expiresAt) - Date.parse(now)) / 1000;
  for (const minutes of [5, 41, 59, 61, 600]) {
    const term = { public_opens_at: iso(Date.parse(now) + minutes * 60000) };
    assert.ok(span(autoEnrolExpiry(term, now)) > CHECKOUT_HOLD_MAX_SECS, `public opening ${minutes} min away`);
  }
  assert.ok(span(autoEnrolExpiry({ public_opens_at: null }, now)) > CHECKOUT_HOLD_MAX_SECS);

  // At the source: a hold that would look like a checkout hold is refused.
  const fam = await seedFamilyAndTerm(env, { prefix: 'ix-hold' });
  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId });
  const nowIso = iso(Date.now());
  await assert.rejects(createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote, expiresAt: iso(Date.parse(nowIso) + 30 * 60000), now: nowIso,
  }), /pay-later hold must outlast/);

  // The real paths produce pay-later holds the parent pages recognise.
  const manual = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, mode: 'paylater', nonce: 'ix-hold', by: 'owner',
  });
  assert.equal(manual.ok, true);
  assert.equal(isCheckoutHold(await row(manual.bookingId)), false);

  const waiting = await seedFamilyAndTerm(env, { prefix: 'ix-hold-wl' });
  await env.DB.prepare(
    `INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at) VALUES ('ix-hold-entry', ?1, ?2, ?3, 'waiting', ?4)`,
  ).bind(waiting.termId, waiting.userId, waiting.childId, nowIso).run();
  const offer = await offerPlace(env, { entryId: 'ix-hold-entry', kind: 'term' });
  assert.equal(offer.ok, true, JSON.stringify(offer));
  assert.equal(isCheckoutHold(await row(offer.bookingId)), false);
});
