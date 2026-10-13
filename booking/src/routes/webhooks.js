// Stripe webhook (design D6): the path that turns provider events into
// booking and ledger state.
//
// Security:
//   * Signature verification (HMAC-SHA256 over `${t}.${payload}`, constant
//     time, 5-minute tolerance) happens before the payload is trusted at all;
//     failures return 400 and change nothing.
//   * Booking ids come from client_reference_id / metadata that this system
//     set server-side when creating the checkout — nothing browser-controlled
//     decides which booking a payment confirms.
//
// Reliability (review finding: events were marked handled before handling):
//   1. INSERT webhook_events(status='processing') BEFORE handling;
//   2. an existing 'done' row is a replay → 200, nothing reprocessed;
//   3. an existing 'processing'/'failed' row older than 2 minutes is
//      reclaimed and processed again (a crashed or failed attempt);
//      a younger one is in flight → 409 so Stripe retries later;
//   4. success marks 'done'; an exception marks 'failed' and returns 500 so
//      Stripe retries. Every handler is idempotent (ledger keyed on provider
//      ids, guarded confirmation), so reprocessing is always safe.
//   Email/notification failures never fail an event.

import { getPaymentsDriver, idOf } from '../lib/payments-driver.js';
import { confirmBooking, abandonCheckout, flagStatement } from '../lib/domain.js';
import { paymentInsertStatement, recomputeStatement, recomputeBooking, ledgerTotals } from '../lib/ledger.js';
import { planCancelAt, planExpectedCents, INTERVAL_DAYS } from '../lib/pricing.js';
import { notifyBookingConfirmed, notifyAttention, notifyPlanFailed } from '../lib/notify.js';
import { nowIso, isoFromMs } from '../lib/db.js';
import { isValidId } from '../lib/validate.js';
import { logEvent, logError } from '../lib/log.js';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const REPROCESS_AFTER_SECS = 120;

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

// --- Event bookkeeping -------------------------------------------------------

// Claim an event for processing. Returns 'claimed' | 'replay' | 'busy'.
export async function claimWebhookEvent(env, eventId, nowMs = Date.now()) {
  const now = isoFromMs(nowMs);
  const inserted = await env.DB.prepare(
    `INSERT INTO webhook_events (event_id, status, received_at) VALUES (?1, 'processing', ?2)
     ON CONFLICT(event_id) DO NOTHING`,
  ).bind(eventId, now).run();
  if (inserted.meta.changes > 0) return 'claimed';

  const staleBefore = isoFromMs(nowMs - REPROCESS_AFTER_SECS * 1000);
  const reclaimed = await env.DB.prepare(
    `UPDATE webhook_events SET status = 'processing', received_at = ?2, processed_at = NULL
     WHERE event_id = ?1 AND status IN ('processing', 'failed') AND received_at <= ?3`,
  ).bind(eventId, now, staleBefore).run();
  if (reclaimed.meta.changes > 0) return 'claimed';

  const row = await env.DB.prepare(`SELECT status FROM webhook_events WHERE event_id = ?1`).bind(eventId).first();
  return row && row.status === 'done' ? 'replay' : 'busy';
}

export async function finishWebhookEvent(env, eventId, status) {
  await env.DB.prepare(
    `UPDATE webhook_events SET status = ?2, processed_at = ?3 WHERE event_id = ?1`,
  ).bind(eventId, status, nowIso()).run();
}

// Claim → process → mark. Shared by the real endpoint and the dev mock
// checkout (which skips only the signature check). Returns { outcome, status }.
export async function handleVerifiedEvent(env, event) {
  const claim = await claimWebhookEvent(env, event.id);
  if (claim === 'replay') {
    logEvent('webhook_replay_ignored', { event_id: event.id.slice(0, 16) });
    return { outcome: 'replay', status: 200 };
  }
  if (claim === 'busy') {
    logEvent('webhook_in_flight', { event_id: event.id.slice(0, 16) });
    return { outcome: 'busy', status: 409 };
  }
  try {
    await processStripeEvent(env, event);
    await finishWebhookEvent(env, event.id, 'done');
    return { outcome: 'done', status: 200 };
  } catch (err) {
    logError('webhook_processing_failed', err, { event_type: String(event.type).slice(0, 60) });
    try {
      await finishWebhookEvent(env, event.id, 'failed');
    } catch (markErr) {
      logError('webhook_mark_failed', markErr, {});
    }
    return { outcome: 'failed', status: 500 };
  }
}

// --- Helpers -----------------------------------------------------------------

async function safely(label, promise) {
  try {
    return await promise;
  } catch (err) {
    logError(label, err, {});
    return null;
  }
}

function bookingRef(object) {
  const id = object?.client_reference_id || object?.metadata?.booking_id;
  return typeof id === 'string' && isValidId(id) ? id : null;
}

function unixToIso(seconds) {
  return Number.isInteger(seconds) ? isoFromMs(seconds * 1000) : null;
}

// Remember the family's Stripe customer for the next checkout (D4).
async function rememberCustomer(env, bookingId, customer) {
  const customerId = idOf(customer);
  if (!customerId || !/^cus_[A-Za-z0-9]+$/.test(customerId)) return;
  await env.DB.prepare(
    `UPDATE users SET stripe_customer_id = ?1
     WHERE id = (SELECT user_id FROM bookings WHERE id = ?2) AND stripe_customer_id IS NULL`,
  ).bind(customerId, bookingId).run();
}

// The booking an invoice belongs to: subscription metadata (both the current
// `parent.subscription_details` and the older `subscription_details` shapes),
// then line metadata, then the stored subscription id.
async function bookingForInvoice(env, invoice) {
  const details = invoice?.parent?.subscription_details || invoice?.subscription_details || null;
  const subscriptionId = idOf(details?.subscription) || idOf(invoice?.subscription) || null;
  let bookingId = details?.metadata?.booking_id || null;
  if (!bookingId) {
    for (const line of invoice?.lines?.data || []) {
      if (line?.metadata?.booking_id) { bookingId = line.metadata.booking_id; break; }
    }
  }
  if (bookingId && !isValidId(bookingId)) bookingId = null;
  if (!bookingId && subscriptionId) {
    const row = await env.DB.prepare(`SELECT id FROM bookings WHERE stripe_subscription_id = ?1`).bind(subscriptionId).first();
    bookingId = row ? row.id : null;
  }
  return { bookingId, subscriptionId };
}

async function bookingForSubscription(env, subscription) {
  const fromMeta = subscription?.metadata?.booking_id;
  if (typeof fromMeta === 'string' && isValidId(fromMeta)) return fromMeta;
  if (!subscription?.id) return null;
  const row = await env.DB.prepare(`SELECT id FROM bookings WHERE stripe_subscription_id = ?1`).bind(subscription.id).first();
  return row ? row.id : null;
}

// A charge → its booking: by payment intent (checkout ledger rows are keyed on
// it), then the invoice (instalment rows), then metadata.
async function bookingForCharge(env, charge) {
  const paymentIntent = idOf(charge?.payment_intent);
  if (paymentIntent) {
    const byLedger = await env.DB.prepare(`SELECT booking_id FROM payments WHERE provider_ref = ?1`).bind(paymentIntent).first();
    if (byLedger) return byLedger.booking_id;
    const byBooking = await env.DB.prepare(`SELECT id FROM bookings WHERE payment_intent = ?1`).bind(paymentIntent).first();
    if (byBooking) return byBooking.id;
  }
  const invoice = idOf(charge?.invoice);
  if (invoice) {
    const byInvoice = await env.DB.prepare(`SELECT booking_id FROM payments WHERE provider_ref = ?1`).bind(invoice).first();
    if (byInvoice) return byInvoice.booking_id;
  }
  const fromMeta = charge?.metadata?.booking_id;
  if (typeof fromMeta === 'string' && isValidId(fromMeta)) {
    const row = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?1`).bind(fromMeta).first();
    if (row) return row.id;
  }
  return null;
}

// The plan a subscription was created for (checkoutParams puts it in the
// subscription's metadata), written back onto a booking that lost its copy.
// Returns { plan_instalments, plan_interval } or null.
async function restorePlanFromSubscription(env, bookingId, sub) {
  const meta = sub?.metadata || {};
  const n = Number(meta.plan_instalments);
  const each = Number(meta.plan_instalment_cents);
  const interval = meta.plan_interval;
  if (!Number.isInteger(n) || n < 2 || n > 20 || !['week', 'fortnight'].includes(interval)
    || !Number.isInteger(each) || each <= 0 || each > 1000000) return null;
  await env.DB.prepare(
    `UPDATE bookings SET payment_method = 'plan', plan_instalments = ?2, plan_interval = ?3, plan_instalment_cents = ?4
     WHERE id = ?1 AND (plan_instalments IS NULL OR plan_instalments < 2)`,
  ).bind(bookingId, n, interval, each).run();
  logEvent('plan_restored_from_subscription', { booking_id: bookingId.slice(0, 8) });
  return { plan_instalments: n, plan_interval: interval };
}

// After a confirmation attempt: email the family once, alert the owner when
// money landed somewhere it should not have.
async function afterConfirm(env, bookingId, result) {
  if (result.ok && result.newlyConfirmed) {
    await safely('confirmation_email_failed', notifyBookingConfirmed(env, bookingId));
  }
  const flag = result.flagged || (result.ok && result.creditShortfall ? 'credit_shortfall' : null);
  if (flag) await safely('attention_email_failed', notifyAttention(env, bookingId, flag));
}

// A one-off payment that differs from what the booking owes (amount mismatch
// or a second payment) is flagged for the owner.
async function checkPaidInFull(env, bookingId) {
  const booking = await env.DB.prepare(
    `SELECT amount_cents, credit_cents, payment_method, status FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking || booking.status !== 'confirmed' || booking.payment_method === 'plan') return;
  const totals = await ledgerTotals(env, bookingId);
  if (totals.received_cents !== booking.amount_cents + booking.credit_cents) {
    await flagStatement(env, bookingId, 'webhook_mismatch', { overwrite: false }).run();
    await safely('attention_email_failed', notifyAttention(env, bookingId, 'webhook_mismatch', {
      detail: `Stripe reported a payment that does not match what the booking owes.`,
    }));
  }
}

// --- Handlers ----------------------------------------------------------------

async function onCheckoutCompleted(env, session) {
  const bookingId = bookingRef(session);
  if (!bookingId) {
    logEvent('webhook_no_booking_ref', { event_type: 'checkout.session.completed' });
    return;
  }
  const driver = getPaymentsDriver(env);
  await rememberCustomer(env, bookingId, session.customer);

  if (session.mode === 'subscription') {
    const subscriptionId = idOf(session.subscription);
    if (!subscriptionId) throw new Error('Subscription checkout completed without a subscription id');
    let plan = await env.DB.prepare(
      `SELECT plan_instalments, plan_interval FROM bookings WHERE id = ?1`,
    ).bind(bookingId).first();
    const sub = await driver.retrieveSubscription(subscriptionId);
    if (plan && !(plan.plan_instalments >= 2)) {
      // The booking forgot its plan (an earlier checkout was abandoned): a
      // subscription that completes anyway is still a plan — restore it from
      // the subscription's metadata, or it would never be given an end.
      const restored = await restorePlanFromSubscription(env, bookingId, sub);
      if (restored) plan = restored;
    }
    if (plan && plan.plan_instalments >= 2) {
      // Exactly n invoices: cancel at the end of the n-th billing period.
      const anchor = sub.billingCycleAnchor || sub.startDate || Math.floor(Date.now() / 1000);
      const cancelAt = planCancelAt(anchor, plan.plan_instalments, plan.plan_interval || 'week');
      if (sub.cancelAt !== cancelAt) await driver.setSubscriptionCancelAt(subscriptionId, cancelAt);
    } else {
      // No plan anywhere: never leave a subscription running unnoticed.
      logEvent('subscription_without_plan', { booking_id: bookingId.slice(0, 8) });
      await flagStatement(env, bookingId, 'webhook_mismatch', { overwrite: false }).run();
      await safely('attention_email_failed', notifyAttention(env, bookingId, 'webhook_mismatch', {
        detail: 'Stripe started an instalment plan for this booking without the plan details — check the subscription in Stripe and set its end date.',
      }));
    }
    // The ledger row arrives with the first invoice's invoice.paid.
    const result = await confirmBooking(env, bookingId, { provider: driver.name, paymentRef: session.id, subscriptionId });
    await afterConfirm(env, bookingId, result);
    return;
  }

  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    logEvent('checkout_completed_unpaid', { booking_id: bookingId.slice(0, 8) });
    return;
  }
  const paymentIntent = idOf(session.payment_intent);
  const amount = Number.isInteger(session.amount_total) ? session.amount_total : 0;
  const payment = amount > 0
    ? { kind: 'checkout', amountCents: amount, provider: driver.name, providerRef: paymentIntent || session.id, method: 'card' }
    : null;
  const result = await confirmBooking(env, bookingId, { provider: driver.name, paymentRef: session.id, paymentIntent, payment });
  await afterConfirm(env, bookingId, result);
  if (result.ok) await checkPaidInFull(env, bookingId);
}

async function onCheckoutExpired(env, session) {
  const bookingId = bookingRef(session);
  if (!bookingId) return;
  const outcome = await abandonCheckout(env, bookingId, session.id);
  logEvent('webhook_checkout_expired', { booking_id: bookingId.slice(0, 8), outcome });
}

// Plan bookkeeping after an instalment: next charge date, and clear "overdue"
// once the money collected has caught up with the schedule.
async function updatePlanProgress(env, bookingId, now = nowIso()) {
  const b = await env.DB.prepare(
    `SELECT amount_cents, plan_instalments, plan_instalment_cents, plan_interval, paid_at, payment_status
     FROM bookings WHERE id = ?1 AND payment_method = 'plan'`,
  ).bind(bookingId).first();
  if (!b || !b.plan_instalments) return;
  const totals = await ledgerTotals(env, bookingId);
  const days = INTERVAL_DAYS[b.plan_interval] || 7;
  const paid = totals.instalments_paid;
  const next = paid < b.plan_instalments && b.paid_at
    ? isoFromMs(Date.parse(b.paid_at) + paid * days * 86400 * 1000)
    : null;
  const expected = planExpectedCents({
    totalCents: b.amount_cents, n: b.plan_instalments, eachCents: b.plan_instalment_cents,
    interval: b.plan_interval, anchorIso: b.paid_at, now,
  });
  const caughtUp = totals.money_in_cents >= expected ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET plan_next_charge_at = ?2,
         payment_status = CASE WHEN payment_status = 'plan_overdue' AND ?3 = 1 THEN 'plan_active' ELSE payment_status END,
         needs_attention = CASE WHEN needs_attention = 'plan_overdue' AND ?3 = 1 THEN NULL ELSE needs_attention END
       WHERE id = ?1`,
    ).bind(bookingId, next, caughtUp),
    recomputeStatement(env, bookingId),
  ]);
}

async function onInvoicePaid(env, invoice) {
  const { bookingId, subscriptionId } = await bookingForInvoice(env, invoice);
  if (!bookingId) {
    logEvent('webhook_invoice_unmatched', { invoice: String(invoice?.id || '').slice(0, 16) });
    return;
  }
  const amount = invoice.amount_paid;
  if (!Number.isInteger(amount) || amount <= 0 || typeof invoice.id !== 'string') {
    logEvent('webhook_invoice_zero', { booking_id: bookingId.slice(0, 8) });
    return;
  }
  const driver = getPaymentsDriver(env);
  await rememberCustomer(env, bookingId, invoice.customer);
  // Stripe does not order events: the first invoice may arrive before
  // checkout.session.completed, so this path confirms (guarded) too.
  const result = await confirmBooking(env, bookingId, {
    provider: driver.name,
    subscriptionId,
    payment: {
      kind: 'instalment', amountCents: amount, provider: driver.name, providerRef: invoice.id, method: 'card',
      paidAt: unixToIso(invoice.status_transitions?.paid_at) || undefined,
    },
  });
  await afterConfirm(env, bookingId, result);
  if (result.ok) await updatePlanProgress(env, bookingId);
}

async function onInvoicePaymentFailed(env, invoice) {
  const { bookingId } = await bookingForInvoice(env, invoice);
  if (!bookingId) {
    logEvent('webhook_invoice_unmatched', { invoice: String(invoice?.id || '').slice(0, 16) });
    return;
  }
  const booking = await env.DB.prepare(
    `SELECT status, payment_method FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  // Only a running plan can be overdue (a failed first payment just leaves the
  // checkout open; a cancelled booking's subscription has been stopped).
  if (!booking || booking.status !== 'confirmed' || booking.payment_method !== 'plan') {
    logEvent('webhook_invoice_failed_ignored', { booking_id: bookingId.slice(0, 8) });
    return;
  }
  // The place is NEVER cancelled here: the owner decides from Needs attention.
  await env.DB.prepare(
    `UPDATE bookings SET payment_status = 'plan_overdue', needs_attention = COALESCE(needs_attention, 'plan_overdue')
     WHERE id = ?1 AND payment_status != 'plan_complete'`,
  ).bind(bookingId).run();
  logEvent('plan_instalment_failed', { booking_id: bookingId.slice(0, 8), attempt: invoice.attempt_count ?? null });
  await safely('plan_failed_notice_failed', notifyPlanFailed(env, bookingId, {
    invoiceId: typeof invoice.id === 'string' ? invoice.id : null,
    attempt: Number.isInteger(invoice.attempt_count) ? invoice.attempt_count : null,
    amountDueCents: Number.isInteger(invoice.amount_due) ? invoice.amount_due : null,
  }));
}

async function onSubscriptionDeleted(env, subscription) {
  const bookingId = await bookingForSubscription(env, subscription);
  if (!bookingId) {
    logEvent('webhook_subscription_unmatched', {});
    return;
  }
  const booking = await env.DB.prepare(`SELECT status FROM bookings WHERE id = ?1`).bind(bookingId).first();
  if (!booking || booking.status !== 'confirmed') {
    logEvent('webhook_subscription_ended_ignored', { booking_id: bookingId.slice(0, 8) });
    return;
  }
  const { payment_status: status } = await recomputeBooking(env, bookingId);
  if (status === 'plan_complete') {
    await env.DB.prepare(`UPDATE bookings SET plan_next_charge_at = NULL WHERE id = ?1`).bind(bookingId).run();
    logEvent('plan_completed', { booking_id: bookingId.slice(0, 8) });
    return;
  }
  // The plan ended (retries exhausted, or cancelled in the dashboard) before
  // the full amount arrived. Flag it — more specific than plan_overdue.
  await env.DB.prepare(
    `UPDATE bookings SET plan_next_charge_at = NULL,
       needs_attention = CASE WHEN needs_attention IS NULL OR needs_attention = 'plan_overdue'
                              THEN 'plan_ended_short' ELSE needs_attention END
     WHERE id = ?1`,
  ).bind(bookingId).run();
  await safely('attention_email_failed', notifyAttention(env, bookingId, 'plan_ended_short'));
}

async function onChargeRefunded(env, charge) {
  const bookingId = await bookingForCharge(env, charge);
  if (!bookingId) {
    logEvent('webhook_refund_unmatched', { charge: String(charge?.id || '').slice(0, 16) });
    return;
  }
  const driver = getPaymentsDriver(env);
  const now = nowIso();
  const statements = [];
  const refunds = Array.isArray(charge.refunds?.data) ? charge.refunds.data : null;
  if (refunds) {
    for (const refund of refunds) {
      if (!refund || typeof refund.id !== 'string' || !Number.isInteger(refund.amount) || refund.amount <= 0) continue;
      if (refund.status === 'failed' || refund.status === 'canceled') continue;
      statements.push(paymentInsertStatement(env, {
        bookingId, kind: 'refund', amountCents: -refund.amount, provider: driver.name, providerRef: refund.id,
        method: 'card', note: 'Refunded in Stripe', paidAt: unixToIso(refund.created) || now, now,
      }));
    }
  } else if (Number.isInteger(charge.amount_refunded) && typeof charge.id === 'string') {
    // Newer API versions omit the refund list: record the change in the
    // charge's cumulative refunded amount, keyed on that cumulative total.
    const prior = await env.DB.prepare(
      `SELECT COALESCE(-SUM(amount_cents), 0) AS refunded FROM payments
       WHERE booking_id = ?1 AND kind = 'refund' AND provider_ref LIKE ?2`,
    ).bind(bookingId, `${charge.id}:refunded:%`).first();
    const delta = charge.amount_refunded - prior.refunded;
    if (delta > 0) {
      statements.push(paymentInsertStatement(env, {
        bookingId, kind: 'refund', amountCents: -delta, provider: driver.name,
        providerRef: `${charge.id}:refunded:${charge.amount_refunded}`, method: 'card', note: 'Refunded in Stripe', now,
      }));
    }
  }
  if (!statements.length) return;
  await env.DB.batch([...statements, recomputeStatement(env, bookingId)]);
  logEvent('refund_recorded', { booking_id: bookingId.slice(0, 8) });
}

const HANDLERS = {
  'checkout.session.completed': (env, o) => onCheckoutCompleted(env, o),
  'checkout.session.async_payment_succeeded': (env, o) => onCheckoutCompleted(env, o),
  'checkout.session.expired': (env, o) => onCheckoutExpired(env, o),
  'invoice.paid': (env, o) => onInvoicePaid(env, o),
  'invoice.payment_failed': (env, o) => onInvoicePaymentFailed(env, o),
  'customer.subscription.deleted': (env, o) => onSubscriptionDeleted(env, o),
  'charge.refunded': (env, o) => onChargeRefunded(env, o),
};

// Dispatch one verified event. Throws on failure (the caller marks it failed).
export async function processStripeEvent(env, event) {
  const handler = HANDLERS[event?.type];
  if (!handler) {
    logEvent('webhook_ignored_event', { event_type: String(event?.type || 'unknown').slice(0, 60) });
    return;
  }
  await handler(env, event.data?.object || {});
}

// POST /api/stripe/webhook
export async function handleStripeWebhook(req, env) {
  const length = Number(req.headers.get('Content-Length') || 0);
  if (length > MAX_WEBHOOK_BODY_BYTES) return json(413, { error: 'payload_too_large' });
  const body = await req.text();
  if (body.length > MAX_WEBHOOK_BODY_BYTES) return json(413, { error: 'payload_too_large' });

  const driver = getPaymentsDriver(env);
  let event;
  try {
    event = await driver.verifyWebhook(req.headers.get('Stripe-Signature'), body);
  } catch (err) {
    // Unsigned, tampered, or stale: reject without touching any booking.
    logEvent('webhook_signature_rejected', { reason: err.message });
    return json(400, { error: 'invalid_signature' });
  }
  if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(event.id) || typeof event.type !== 'string') {
    return json(400, { error: 'invalid_event' });
  }

  const { outcome, status } = await handleVerifiedEvent(env, event);
  return json(status, { received: status === 200, outcome });
}

export function registerRoutes(route) {
  route('POST', '/api/stripe/webhook', handleStripeWebhook);
}

