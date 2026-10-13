// Instalment plans after checkout (design D4; adversarial review, task 3.2,
// findings 1, 3, 5 and 11): the bookkeeping shared by the Stripe webhook, the
// owner's money actions (record a payment, an adjustment, Stop plan, Cancel)
// and Check with Stripe.
//
//   updatePlanProgress  next charge date; "overdue" cleared once the money
//                       received has caught up with the schedule
//   ensurePlanEnd       a live subscription always has its end date
//                       (cancel_at): from the booking's plan, else the plan
//                       the subscription carries in its metadata; flagged
//                       webhook_mismatch when there is none anywhere
//   stopPlan            stop the subscription now and record it
//                       (bookings.plan_ended_at) — the owner's "Stop plan"
//   settlePlanIfPaid    everything owed has arrived (instalments plus cash,
//                       a transfer or an adjustment): stop the subscription
//                       so Stripe takes nothing more; a failed stop is
//                       flagged plan_stop_failed
//   flagIfOverpaid      more money in (net of refunds) than the booking
//                       costs: flagged 'overpaid' for the owner
//   markPlanEnded       Stripe says the subscription ended
//
// A plan's subscription is "live" while stripe_subscription_id is set and
// plan_ended_at is NULL.

import { nowIso, isoFromMs } from './db.js';
import { logEvent, logError } from './log.js';
import { formatSydney } from './time.js';
import { getPaymentsDriver, stopSubscription } from './payments-driver.js';
import { ledgerTotals, recomputeStatement } from './ledger.js';
import { planCancelAt, planExpectedCents, INTERVAL_DAYS } from './pricing.js';
import { flagStatement, formatAud } from './domain.js';
import { notifyAttention } from './notify.js';

const ENDED_STATUSES = ['canceled', 'incomplete_expired'];

async function quietly(label, promise) {
  try {
    return await promise;
  } catch (err) {
    logError(label, err, {});
    return null;
  }
}

function noteStatement(env, bookingId, line) {
  return env.DB.prepare(
    `UPDATE bookings SET admin_notes = CASE WHEN admin_notes = '' THEN ?2 ELSE admin_notes || char(10) || ?2 END
     WHERE id = ?1`,
  ).bind(bookingId, String(line).slice(0, 600));
}

// Plan bookkeeping after money arrives on a plan: the next charge date, and
// clear "overdue" once the money collected has caught up with the schedule.
export async function updatePlanProgress(env, bookingId, now = nowIso()) {
  const b = await env.DB.prepare(
    `SELECT amount_cents, plan_instalments, plan_instalment_cents, plan_interval, paid_at, payment_status, plan_ended_at
     FROM bookings WHERE id = ?1 AND payment_method = 'plan'`,
  ).bind(bookingId).first();
  if (!b || !b.plan_instalments) return;
  const totals = await ledgerTotals(env, bookingId);
  const days = INTERVAL_DAYS[b.plan_interval] || 7;
  const paid = totals.instalments_paid;
  const next = !b.plan_ended_at && paid < b.plan_instalments && b.paid_at
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

// The plan a subscription was created for (checkoutParams puts it in the
// subscription's metadata), written back onto a booking that lost its copy.
// Returns { plan_instalments, plan_interval } or null.
export async function restorePlanFromSubscription(env, bookingId, sub) {
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

// Give a live subscription its end date: cancel at the end of the n-th
// billing period, so exactly n invoices are raised (D4). With onlyIfMissing
// (invoice.paid, Check with Stripe) an end date already there is left alone
// — the owner may have moved it in Stripe; checkout.session.completed sets
// it whenever it differs. A plan found nowhere (booking or metadata) flags
// webhook_mismatch so a subscription never bills on unnoticed.
// Returns 'ok' (already right) | 'set' | 'ended' (nothing to do) | 'missing'.
// Throws when Stripe cannot be asked (callers decide).
export async function ensurePlanEnd(env, {
  bookingId, subscriptionId, subscription = null, onlyIfMissing = true, nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const driver = getPaymentsDriver(env);
  const sub = subscription || await driver.retrieveSubscription(subscriptionId);
  if (!sub || ENDED_STATUSES.includes(sub.status)) return 'ended';
  if (onlyIfMissing && sub.cancelAt) return 'ok';
  let plan = await env.DB.prepare(`SELECT plan_instalments, plan_interval FROM bookings WHERE id = ?1`).bind(bookingId).first();
  if (plan && !(plan.plan_instalments >= 2)) {
    // The booking forgot its plan (an earlier checkout was abandoned): the
    // subscription is still a plan — restore it from the metadata.
    plan = (await restorePlanFromSubscription(env, bookingId, sub)) || plan;
  }
  if (!plan || !(plan.plan_instalments >= 2)) {
    logEvent('subscription_without_plan', { booking_id: bookingId.slice(0, 8) });
    await flagStatement(env, bookingId, 'webhook_mismatch', { overwrite: false }).run();
    await quietly('attention_email_failed', notifyAttention(env, bookingId, 'webhook_mismatch', {
      detail: 'Stripe started an instalment plan for this booking without the plan details — check the subscription in Stripe and set its end date (or press Stop plan).',
    }));
    return 'missing';
  }
  const anchor = sub.billingCycleAnchor || sub.startDate || nowSeconds;
  const cancelAt = planCancelAt(anchor, plan.plan_instalments, plan.plan_interval || 'week');
  if (sub.cancelAt === cancelAt) return 'ok';
  await driver.setSubscriptionCancelAt(sub.id || subscriptionId, cancelAt);
  logEvent('plan_end_set', { booking_id: bookingId.slice(0, 8), had_end: Boolean(sub.cancelAt) });
  return 'set';
}

// Record that a booking's subscription has ended (whoever ended it).
export function planEndedStatement(env, bookingId, now = nowIso()) {
  return env.DB.prepare(
    `UPDATE bookings SET plan_ended_at = COALESCE(plan_ended_at, ?2), plan_next_charge_at = NULL WHERE id = ?1`,
  ).bind(bookingId, now);
}

export async function markPlanEnded(env, bookingId, now = nowIso()) {
  await planEndedStatement(env, bookingId, now).run();
}

// Stop a booking's subscription now — Stripe takes no more instalments (and,
// by default, stops retrying a failed one) — and record it: plan_ended_at,
// no next charge, a note on the booking. A subscription Stripe has already
// ended (or does not know) counts as stopped.
// Returns { ok: true, already } or { ok: false, error: not_found | no_plan |
// stripe } (stripe: Stripe refused or could not be reached; still live).
export async function stopPlan(env, bookingId, { by = 'system', why = '', now = nowIso() } = {}) {
  const b = await env.DB.prepare(
    `SELECT id, stripe_subscription_id, plan_ended_at FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!b) return { ok: false, error: 'not_found' };
  if (!b.stripe_subscription_id) return { ok: false, error: 'no_plan' };
  if (b.plan_ended_at) return { ok: true, already: true };
  if (!(await stopSubscription(getPaymentsDriver(env), b.stripe_subscription_id))) {
    logEvent('plan_stop_refused', { booking_id: bookingId.slice(0, 8) });
    return { ok: false, error: 'stripe' };
  }
  const line = `${formatSydney(now, 'date')}: instalment plan stopped${why ? ` — ${why}` : ''}.`;
  await env.DB.batch([planEndedStatement(env, bookingId, now), noteStatement(env, bookingId, line)]);
  logEvent('plan_stopped', { booking_id: bookingId.slice(0, 8), by: String(by).slice(0, 8) });
  return { ok: true, already: false };
}

// Everything the booking owes has arrived — instalments, plus any cash,
// transfer or adjustment the owner recorded: stop the subscription so Stripe
// takes nothing more (review finding 1: a transfer for the rest while the
// card kept being charged took $224 for a $168 term). Refunds don't count
// against it (a refund never creates a new debt). Returns null when there
// is nothing to stop, else stopPlan's result; a stop that fails is flagged
// plan_stop_failed and the owner is emailed.
export async function settlePlanIfPaid(env, bookingId, { now = nowIso() } = {}) {
  const b = await env.DB.prepare(
    `SELECT status, payment_method, stripe_subscription_id, plan_ended_at, amount_cents, credit_cents
     FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!b || b.status !== 'confirmed' || b.payment_method !== 'plan' || !b.stripe_subscription_id || b.plan_ended_at) return null;
  const totals = await ledgerTotals(env, bookingId);
  if (totals.received_cents < b.amount_cents + b.credit_cents) return null;
  const result = await stopPlan(env, bookingId, { why: 'everything owed has been paid', now });
  if (!result.ok) {
    await flagStatement(env, bookingId, 'plan_stop_failed').run();
    await quietly('attention_email_failed', notifyAttention(env, bookingId, 'plan_stop_failed', {
      detail: 'Everything this booking owes has been paid, but Stripe could not be asked to stop the instalments. Press Stop plan on the booking (or cancel the subscription in the Stripe dashboard) so no more are taken.',
    }));
  }
  return result;
}

// More money in than the booking costs (net of refunds): flag 'overpaid' so
// the owner refunds the difference or turns it into a credit. Returns true
// when the booking is (now) overpaid.
export async function flagIfOverpaid(env, bookingId) {
  const b = await env.DB.prepare(
    `SELECT amount_cents, credit_cents, needs_attention FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!b) return false;
  const totals = await ledgerTotals(env, bookingId);
  const excess = totals.net_cents - (b.amount_cents + b.credit_cents);
  if (excess <= 0) return false;
  await flagStatement(env, bookingId, 'overpaid', { overwrite: false }).run();
  logEvent('booking_overpaid', { booking_id: bookingId.slice(0, 8), excess_cents: excess });
  await quietly('attention_email_failed', notifyAttention(env, bookingId, 'overpaid', {
    detail: `${formatAud(excess)} more has been received than this booking costs. Refund the difference (in Stripe for a card payment, or by hand and then Record refund) or give it as a credit, then mark it as sorted.`,
  }));
  return true;
}
