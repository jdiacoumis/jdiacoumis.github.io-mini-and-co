// Payment ledger, credits and vouchers (design D5).
//
// `payments` is append-only: every checkout payment, instalment, offline
// payment, refund (negative), applied credit and adjustment (signed) is a
// row. A booking's paid_cents and payment_status are DERIVED from it by
// recomputeBooking() after every insert — never written by hand.
//
// Idempotency: provider_ref is UNIQUE (payment_intent / invoice / refund id),
// and every insert is ON CONFLICT DO NOTHING, so webhook retries and admin
// "Check with Stripe" can never create a duplicate row.
//
// Money model (all integer cents):
//   due       = bookings.amount_cents + bookings.credit_cents
//             = list − voucher discount (what the booking costs after discounts)
//   amount_cents is the part payable in money; credit_cents was covered by
//   account credit, which appears in the ledger as a 'credit_applied' row once
//   the booking is confirmed — so a fully settled booking's ledger sums to due.
//   received  = SUM(rows) excluding refunds. A refund is recorded (paid_cents
//   is net of it) but does not turn a deliberately refunded booking "unpaid".
//
// Statement builders (…Statement / …Statements) return prepared statements for
// inclusion in a caller's atomic env.DB.batch(); the plain functions run their
// own batch.

import { uuid, nowIso, txnGuard, isConstraintError } from './db.js';
import { logEvent } from './log.js';

export const LEDGER_KINDS = ['checkout', 'instalment', 'offline', 'refund', 'credit_applied', 'adjustment'];
export const MONEY_IN_KINDS = ['checkout', 'instalment', 'offline'];
const MONEY_IN_SQL = `('checkout', 'instalment', 'offline')`;

// Booking statuses a conditional statement may test (allow-list: the values
// are inlined into SQL).
const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired'];

function statusCondition(bookingParam, statuses) {
  if (!statuses) return '1';
  for (const s of statuses) {
    if (!BOOKING_STATUSES.includes(s)) throw new Error(`Unknown booking status: ${s}`);
  }
  return `(SELECT status FROM bookings WHERE id = ${bookingParam}) IN (${statuses.map((s) => `'${s}'`).join(', ')})`;
}

function checkAmount(kind, amountCents) {
  if (!LEDGER_KINDS.includes(kind)) throw new Error(`Unknown ledger kind: ${kind}`);
  if (!Number.isInteger(amountCents)) throw new Error('Ledger amounts are integer cents');
  if (kind === 'refund' && amountCents >= 0) throw new Error('Refunds are negative ledger rows');
  if (kind === 'adjustment' && amountCents === 0) throw new Error('An adjustment cannot be zero');
  if (kind !== 'refund' && kind !== 'adjustment' && amountCents <= 0) throw new Error(`${kind} rows are positive`);
}

// --- Payments ----------------------------------------------------------------

// INSERT one ledger row; a repeated provider_ref is silently ignored.
export function paymentInsertStatement(env, {
  bookingId, kind, amountCents, provider = null, providerRef = null, method = '', note = '',
  recordedBy = null, paidAt = null, now = nowIso(),
}) {
  checkAmount(kind, amountCents);
  return env.DB.prepare(
    `INSERT INTO payments (id, booking_id, kind, amount_cents, provider, provider_ref, method, note,
                           recorded_by, paid_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(provider_ref) DO NOTHING`,
  ).bind(uuid(), bookingId, kind, amountCents, provider, providerRef, String(method || ''),
    String(note || ''), recordedBy, paidAt || now, now);
}

// The 'credit_applied' row for a booking's credit_cents, once (at confirmation).
export function creditAppliedStatement(env, bookingId, now = nowIso()) {
  return env.DB.prepare(
    `INSERT INTO payments (id, booking_id, kind, amount_cents, method, note, paid_at, created_at)
     SELECT ?1, b.id, 'credit_applied', b.credit_cents, 'credit', 'Account credit applied', ?3, ?3
     FROM bookings b
     WHERE b.id = ?2 AND b.credit_cents > 0
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.kind = 'credit_applied')`,
  ).bind(uuid(), bookingId, now);
}

// Re-derive paid_cents, paid_at and payment_status from the ledger.
//   complimentary                 → waived
//   plan: received ≥ due          → plan_complete
//         marked overdue          → plan_overdue (cleared by the instalment
//                                   handler once the plan has caught up)
//         any money received     → plan_active, else unpaid
//   otherwise: received ≥ due     → paid, else unpaid
export function recomputeStatement(env, bookingId) {
  const received = `(SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
                     WHERE p.booking_id = bookings.id AND p.kind != 'refund')`;
  return env.DB.prepare(
    `UPDATE bookings SET
       paid_cents = (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.booking_id = bookings.id),
       paid_at = COALESCE(paid_at, (SELECT MIN(p.paid_at) FROM payments p
                                    WHERE p.booking_id = bookings.id AND p.kind IN ${MONEY_IN_SQL}
                                      AND p.amount_cents > 0)),
       payment_status = CASE
         WHEN kind = 'complimentary' THEN 'waived'
         WHEN payment_method = 'plan' THEN CASE
           WHEN ${received} >= amount_cents + credit_cents THEN 'plan_complete'
           WHEN payment_status = 'plan_overdue' THEN 'plan_overdue'
           WHEN EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = bookings.id
                          AND p.kind IN ${MONEY_IN_SQL} AND p.amount_cents > 0) THEN 'plan_active'
           ELSE 'unpaid' END
         WHEN ${received} >= amount_cents + credit_cents THEN 'paid'
         ELSE 'unpaid' END
     WHERE id = ?1`,
  ).bind(bookingId);
}

export async function recomputeBooking(env, bookingId) {
  await recomputeStatement(env, bookingId).run();
  return env.DB.prepare(
    `SELECT paid_cents, payment_status FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
}

// Record one ledger row and recompute, atomically. Returns { inserted } —
// false when the provider_ref was already recorded (a replay).
export async function recordPayment(env, payment) {
  const now = payment.now || nowIso();
  const [insert] = await env.DB.batch([
    paymentInsertStatement(env, { ...payment, now }),
    recomputeStatement(env, payment.bookingId),
  ]);
  const inserted = insert.meta.changes > 0;
  if (inserted) {
    logEvent('ledger_row_recorded', {
      booking_id: payment.bookingId.slice(0, 8), kind: payment.kind, amount_cents: payment.amountCents,
    });
  }
  return { inserted };
}

// Money and credit received for a booking, excluding refunds (see header).
export async function ledgerTotals(env, bookingId) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(amount_cents), 0) AS net_cents,
       COALESCE(SUM(CASE WHEN kind != 'refund' THEN amount_cents ELSE 0 END), 0) AS received_cents,
       COALESCE(SUM(CASE WHEN kind IN ${MONEY_IN_SQL} THEN amount_cents ELSE 0 END), 0) AS money_in_cents,
       COALESCE(SUM(CASE WHEN kind = 'instalment' THEN 1 ELSE 0 END), 0) AS instalments_paid
     FROM payments WHERE booking_id = ?1`,
  ).bind(bookingId).first();
  return row;
}

// --- Credits -----------------------------------------------------------------

export function issueCreditStatement(env, {
  userId, childId = null, amountCents, reason = '', sourceBookingId = null, sourceSessionId = null,
  issuedBy = 'system', expiresAt = null, now = nowIso(), id = uuid(),
}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Credits are positive integer cents');
  return {
    id,
    statement: env.DB.prepare(
      `INSERT INTO credits (id, user_id, child_id, amount_cents, remaining_cents, reason,
                            source_booking_id, source_session_id, issued_by, issued_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(id, userId, childId, amountCents, String(reason || ''), sourceBookingId, sourceSessionId,
      issuedBy, now, expiresAt),
  };
}

export async function issueCredit(env, options) {
  const { id, statement } = issueCreditStatement(env, options);
  await statement.run();
  logEvent('credit_issued', { credit_id: id.slice(0, 8), amount_cents: options.amountCents });
  return id;
}

// Voiding stops a credit being used from now on; past redemptions stand.
export async function voidCredit(env, creditId, { by = null, now = nowIso() } = {}) {
  const result = await env.DB.prepare(
    `UPDATE credits SET voided_at = ?2 WHERE id = ?1 AND voided_at IS NULL`,
  ).bind(creditId, now).run();
  const voided = result.meta.changes > 0;
  if (voided) logEvent('credit_voided', { credit_id: creditId.slice(0, 8), by: by ? String(by).slice(0, 8) : null });
  return voided;
}

// Credits usable now for a child of this account (child-specific or any-child
// credits), in the order they are spent: child-specific first, then soonest
// expiry, then oldest. With childId null: every usable credit of the account.
export async function availableCredits(env, userId, childId = null, now = nowIso()) {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, child_id, amount_cents, remaining_cents, reason, issued_at, expires_at
     FROM credits
     WHERE user_id = ?1 AND voided_at IS NULL AND remaining_cents > 0
       AND (expires_at IS NULL OR expires_at > ?3)
       AND (?2 IS NULL OR child_id IS NULL OR child_id = ?2)
     ORDER BY (child_id IS NULL), (expires_at IS NULL), expires_at, issued_at`,
  ).bind(userId, childId, now).all();
  return rows.results || [];
}

export async function creditBalance(env, userId, now = nowIso()) {
  const credits = await availableCredits(env, userId, null, now);
  return credits.reduce((sum, c) => sum + c.remaining_cents, 0);
}

// Redeem credits for a booking inside the booking's batch. Each allocation
// inserts a redemption and decrements the credit; credits.remaining_cents has
// CHECK (>= 0), so a credit spent concurrently aborts the whole batch, and a
// guard aborts it if the credit was voided, expired, or is not this family's.
// `whenStatusIn` makes every statement a no-op unless the booking is in one of
// those states at that point of the batch (used when re-confirming).
export function creditRedemptionStatements(env, {
  bookingId, userId, childId, allocations, now = nowIso(), whenStatusIn = null,
}) {
  const statements = [];
  for (const { creditId, amountCents } of allocations || []) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Redemptions are positive cents');
    const when = statusCondition('?2', whenStatusIn);
    statements.push(
      env.DB.prepare(
        `INSERT INTO credit_redemptions (credit_id, booking_id, amount_cents, redeemed_at)
         SELECT ?1, ?2, ?3, ?4 WHERE ${when}`,
      ).bind(creditId, bookingId, amountCents, now),
      env.DB.prepare(
        `UPDATE credits SET remaining_cents = remaining_cents - ?3 WHERE id = ?1 AND ${when}`,
      ).bind(creditId, bookingId, amountCents),
      ...txnGuard(env,
        `NOT ${statusCondition('?2', whenStatusIn)}
         OR EXISTS (SELECT 1 FROM credits WHERE id = ?1 AND user_id = ?3 AND voided_at IS NULL
                      AND (expires_at IS NULL OR expires_at > ?4)
                      AND (child_id IS NULL OR child_id = ?5))`,
        [creditId, bookingId, userId, now, childId], 'credit'),
    );
  }
  return statements;
}

// Give back a booking's credit redemptions (expiry / cancellation of a booking
// that was still pending). No-op unless the booking is in `whenStatusIn` at
// that point of the batch — callers place these BEFORE the status change, so
// they run exactly once, on the transition.
export function reverseRedemptionStatements(env, bookingId, { whenStatusIn = ['pending'] } = {}) {
  const when = statusCondition('?1', whenStatusIn);
  return [
    env.DB.prepare(
      `UPDATE credits
       SET remaining_cents = remaining_cents + (SELECT cr.amount_cents FROM credit_redemptions cr
                                                WHERE cr.credit_id = credits.id AND cr.booking_id = ?1)
       WHERE id IN (SELECT credit_id FROM credit_redemptions WHERE booking_id = ?1) AND ${when}`,
    ).bind(bookingId),
    env.DB.prepare(
      `DELETE FROM credit_redemptions WHERE booking_id = ?1 AND ${when}`,
    ).bind(bookingId),
  ];
}

// --- Vouchers ----------------------------------------------------------------

export async function loadVoucher(env, code) {
  if (!code) return null;
  return env.DB.prepare(
    `SELECT code, kind, value, applies_to, max_uses, uses, valid_from, valid_until, active, note
     FROM vouchers WHERE code = ?1`,
  ).bind(code).first();
}

// Count one use of a voucher inside a booking batch. With enforceLimits the
// batch aborts unless the voucher is active, in its validity window and
// within max_uses AFTER the increment (D1 serialises batches, so two parents
// racing for the last use resolve to one).
export function voucherUseStatements(env, code, {
  now = nowIso(), bookingId = null, whenStatusIn = null, enforceLimits = true,
} = {}) {
  // Bind only the parameters the SQL uses (D1 rejects surplus bindings).
  const statements = [whenStatusIn
    ? env.DB.prepare(
      `UPDATE vouchers SET uses = uses + 1 WHERE code = ?1 AND ${statusCondition('?2', whenStatusIn)}`,
    ).bind(code, bookingId)
    : env.DB.prepare(`UPDATE vouchers SET uses = uses + 1 WHERE code = ?1`).bind(code)];
  if (enforceLimits) {
    statements.push(...txnGuard(env,
      `EXISTS (SELECT 1 FROM vouchers WHERE code = ?1 AND active = 1
                 AND (max_uses IS NULL OR uses <= max_uses)
                 AND (valid_from IS NULL OR valid_from <= ?2)
                 AND (valid_until IS NULL OR valid_until > ?2))`,
      [code, now], 'voucher'));
  }
  return statements;
}

// Return a voucher use when a still-pending booking expires or is cancelled
// (same transition rule as reverseRedemptionStatements).
export function voucherReleaseStatements(env, bookingId, { whenStatusIn = ['pending'] } = {}) {
  const when = statusCondition('?1', whenStatusIn);
  return [
    env.DB.prepare(
      `UPDATE vouchers SET uses = MAX(0, uses - 1)
       WHERE code = (SELECT voucher_code FROM bookings WHERE id = ?1) AND ${when}`,
    ).bind(bookingId),
  ];
}

// Count a voucher use on its own (outside a booking). Returns false when the
// voucher is unknown, inactive, out of its window or used up.
export async function useVoucher(env, code, { now = nowIso() } = {}) {
  try {
    const [update] = await env.DB.batch(voucherUseStatements(env, code, { now }));
    return update.meta.changes > 0;
  } catch (err) {
    if (isConstraintError(err)) return false;
    throw err;
  }
}
