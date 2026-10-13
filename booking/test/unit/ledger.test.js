// Payment ledger, credits and vouchers (design D5) against a real D1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  recordPayment, recomputeBooking, issueCredit, voidCredit, availableCredits, creditBalance,
  creditRedemptionStatements, reverseRedemptionStatements, useVoucher, loadVoucher,
  paymentInsertStatement,
} from '../../src/lib/ledger.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const fam = await seedFamilyAndTerm(env, { prefix: 'led' });
const NOW = iso(Date.now());

async function insertBooking(id, { amount = 16800, credit = 0, method = 'full', kind = 'term', status = 'confirmed' } = {}) {
  await env.DB.prepare(
    `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, credit_cents,
                           amount_cents, payment_method, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).bind(id, fam.userId, fam.childId, kind, fam.termId, status, amount + credit, credit, amount, method,
    NOW, daysFromNow(1)).run();
}

test('recordPayment is idempotent on provider_ref and derives paid status', async () => {
  await insertBooking('b-full');
  const first = await recordPayment(env, { bookingId: 'b-full', kind: 'checkout', amountCents: 16800, provider: 'stripe', providerRef: 'pi_1' });
  const replay = await recordPayment(env, { bookingId: 'b-full', kind: 'checkout', amountCents: 16800, provider: 'stripe', providerRef: 'pi_1' });
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = 'b-full'`).first();
  assert.equal(rows.n, 1, 'exactly one ledger row per provider reference');
  const booking = await env.DB.prepare(`SELECT paid_cents, payment_status, paid_at FROM bookings WHERE id = 'b-full'`).first();
  assert.equal(booking.paid_cents, 16800);
  assert.equal(booking.payment_status, 'paid');
  assert.ok(booking.paid_at);
});

test('partial and offline payments; a refund is recorded but does not make a paid booking unpaid', async () => {
  await insertBooking('b-part');
  await recordPayment(env, { bookingId: 'b-part', kind: 'offline', amountCents: 10000, method: 'cash', recordedBy: 'admin' });
  assert.deepEqual(await recomputeBooking(env, 'b-part'), { paid_cents: 10000, payment_status: 'unpaid' });
  await recordPayment(env, { bookingId: 'b-part', kind: 'offline', amountCents: 6800, method: 'bank transfer' });
  assert.equal((await recomputeBooking(env, 'b-part')).payment_status, 'paid');
  await recordPayment(env, { bookingId: 'b-part', kind: 'refund', amountCents: -2800, providerRef: 're_1' });
  assert.deepEqual(await recomputeBooking(env, 'b-part'), { paid_cents: 14000, payment_status: 'paid' });
});

test('ledger rows are validated: kinds, signs and integer cents', () => {
  const base = { bookingId: 'b-full', now: NOW };
  assert.throws(() => paymentInsertStatement(env, { ...base, kind: 'gift', amountCents: 1 }), /Unknown ledger kind/);
  assert.throws(() => paymentInsertStatement(env, { ...base, kind: 'refund', amountCents: 100 }), /negative/);
  assert.throws(() => paymentInsertStatement(env, { ...base, kind: 'checkout', amountCents: -100 }), /positive/);
  assert.throws(() => paymentInsertStatement(env, { ...base, kind: 'checkout', amountCents: 10.5 }), /integer/);
  assert.throws(() => paymentInsertStatement(env, { ...base, kind: 'adjustment', amountCents: 0 }), /zero/);
});

test('plan bookings: active → overdue stays until caught up → complete', async () => {
  await insertBooking('b-plan', { amount: 10000, method: 'plan', status: 'confirmed' });
  assert.equal((await recomputeBooking(env, 'b-plan')).payment_status, 'unpaid');
  await recordPayment(env, { bookingId: 'b-plan', kind: 'instalment', amountCents: 3334, providerRef: 'in_1' });
  assert.equal((await recomputeBooking(env, 'b-plan')).payment_status, 'plan_active');

  await env.DB.prepare(`UPDATE bookings SET payment_status = 'plan_overdue' WHERE id = 'b-plan'`).run();
  assert.equal((await recomputeBooking(env, 'b-plan')).payment_status, 'plan_overdue', 'overdue is sticky');

  await recordPayment(env, { bookingId: 'b-plan', kind: 'instalment', amountCents: 3333, providerRef: 'in_2' });
  await recordPayment(env, { bookingId: 'b-plan', kind: 'instalment', amountCents: 3333, providerRef: 'in_3' });
  assert.deepEqual(await recomputeBooking(env, 'b-plan'), { paid_cents: 10000, payment_status: 'plan_complete' });
});

test('complimentary bookings are waived; nothing owed counts as paid', async () => {
  await insertBooking('b-comp', { amount: 0, kind: 'complimentary', method: 'none' });
  assert.equal((await recomputeBooking(env, 'b-comp')).payment_status, 'waived');
  await insertBooking('b-zero', { amount: 0, kind: 'casual', method: 'none' });
  assert.equal((await recomputeBooking(env, 'b-zero')).payment_status, 'paid');
});

test('credits: issue, list in spending order, void, balance', async () => {
  const anyChild = await issueCredit(env, { userId: fam.userId, amountCents: 3000, reason: 'Class cancelled', issuedBy: 'admin' });
  const childOnly = await issueCredit(env, { userId: fam.userId, childId: fam.childId, amountCents: 1500, reason: 'Missed week' });
  const expired = await issueCredit(env, { userId: fam.userId, amountCents: 999, expiresAt: daysFromNow(-1) });
  const list = await availableCredits(env, fam.userId, fam.childId);
  assert.deepEqual(list.map((c) => c.id), [childOnly, anyChild], 'child-specific first; expired excluded');
  assert.equal(await creditBalance(env, fam.userId), 4500);
  assert.ok(expired);

  assert.equal(await voidCredit(env, childOnly, { by: 'admin' }), true);
  assert.equal(await voidCredit(env, childOnly), false, 'voiding twice is a no-op');
  assert.deepEqual((await availableCredits(env, fam.userId, fam.childId)).map((c) => c.id), [anyChild]);
});

test('credit redemptions are guarded and reversible inside a batch', async () => {
  const creditId = await issueCredit(env, { userId: fam.userId, amountCents: 2000 });
  await insertBooking('b-cred', { status: 'pending' });
  const statements = creditRedemptionStatements(env, {
    bookingId: 'b-cred', userId: fam.userId, childId: fam.childId, allocations: [{ creditId, amountCents: 1500 }], now: NOW,
  });
  await env.DB.batch(statements);
  const after = await env.DB.prepare(`SELECT remaining_cents FROM credits WHERE id = ?1`).bind(creditId).first();
  assert.equal(after.remaining_cents, 500);

  // Overspending violates remaining_cents >= 0 and rolls the batch back.
  await insertBooking('b-cred2', { status: 'pending' });
  await assert.rejects(env.DB.batch(creditRedemptionStatements(env, {
    bookingId: 'b-cred2', userId: fam.userId, childId: fam.childId, allocations: [{ creditId, amountCents: 600 }], now: NOW,
  })));
  const redemptions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM credit_redemptions WHERE booking_id = 'b-cred2'`).first();
  assert.equal(redemptions.n, 0);

  // Another family's credit is refused by the guard.
  await env.DB.prepare(`INSERT INTO users (id, email, created_at) VALUES ('other', 'other@example.com', ?1)`).bind(NOW).run();
  const foreign = await issueCredit(env, { userId: 'other', amountCents: 5000 });
  await assert.rejects(env.DB.batch(creditRedemptionStatements(env, {
    bookingId: 'b-cred2', userId: fam.userId, childId: fam.childId, allocations: [{ creditId: foreign, amountCents: 100 }], now: NOW,
  })), /constraint/i);

  // Reversal only runs while the booking is still pending, and only once.
  await env.DB.batch(reverseRedemptionStatements(env, 'b-cred'));
  await env.DB.batch(reverseRedemptionStatements(env, 'b-cred'));
  const restored = await env.DB.prepare(`SELECT remaining_cents FROM credits WHERE id = ?1`).bind(creditId).first();
  assert.equal(restored.remaining_cents, 2000);
});

test('voucher uses are counted within max_uses, atomically', async () => {
  await env.DB.prepare(
    `INSERT INTO vouchers (code, kind, value, max_uses, uses, active, created_at) VALUES ('TWICE', 'amount', 500, 2, 0, 1, ?1)`,
  ).bind(NOW).run();
  const results = await Promise.all([1, 2, 3, 4].map(() => useVoucher(env, 'TWICE')));
  assert.equal(results.filter(Boolean).length, 2);
  assert.equal((await loadVoucher(env, 'TWICE')).uses, 2);
  assert.equal(await useVoucher(env, 'NOPE'), false);
});
