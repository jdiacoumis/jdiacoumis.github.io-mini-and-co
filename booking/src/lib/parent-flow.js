// Parent flow helpers (Phase 2A — booking-flow, payment-plans and waitlist
// specs): how a term, a price, a hold or a payment status is presented to a
// family on the class list, checkout, confirmation, account and waitlist
// pages, plus a few owner-scoped reads those pages share.
//
// Prices and eligibility always come from lib/pricing.js and lib/domain.js
// (prepareBooking is the only path to a bookable quote); these helpers only
// decide how to SHOW them. The first half is pure (no I/O, no clock reads)
// and unit-tested; the reads below take the account id and never return
// another family's rows.

import {
  canBookTerm, returningPriceApplies, proRata, planFor, instalmentSchedule,
} from './pricing.js';
import {
  PENDING_BOOKING_EXPIRY_SECS, bookingLiveSql, childHasTrial, effectiveStatus, formatAud,
} from './domain.js';
import { formatSydney } from './time.js';

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// --- Terms on the class list --------------------------------------------------

// How a term looks to one family right now.
//   term:      a listOpenTerms() row (sessions, remaining, term_seats_left, …)
//   returning: the viewer is a returning family (domain.isReturningFamily)
// Returns:
//   access              canBookTerm(): { open, viaReturningWindow } or
//                       { open: false, reason, opensAt }
//   weeks, totalWeeks   weeks a term booking covers now / scheduled weeks
//   isProRata           the term has started (fewer weeks than scheduled)
//   priceCents          what a term booking costs THIS family now, before
//                       any voucher or credit (pro-rated once started)
//   publicPriceCents    the everyone price for the same weeks
//   returningPriceCents the returning-family price for those weeks, or null
//   isReturning         the returning-family price applies to this family
//   plan                planFor() → { n, interval } | null
//   returningUntil      while this family books in the early window: when it
//                       opens to everyone (else null)
//   earlyWindow         the term is not public yet but last term's families
//                       may book earlier: { from (null = already), until }
//   seatsLeft           places left for a whole-term booking
export function termOffer({ term, now, returning = false }) {
  const scheduled = (term.sessions || []).filter((s) => s.status === 'scheduled');
  const remaining = term.remaining || scheduled.filter((s) => s.starts_at > now);
  const weeks = remaining.length;
  const totalWeeks = scheduled.length;
  const hasReturningPrice = term.returning_price_cents !== null && term.returning_price_cents !== undefined;
  const isReturning = returningPriceApplies({ term, now, returning });
  const publicPriceCents = proRata(term.term_price_cents, weeks, totalWeeks);
  const returningPriceCents = hasReturningPrice ? proRata(term.returning_price_cents, weeks, totalWeeks) : null;
  const priceCents = isReturning ? returningPriceCents : publicPriceCents;
  const access = canBookTerm({ term, now, returning });
  const publicOpen = !term.public_opens_at || now >= term.public_opens_at;
  const earlyWindow = !publicOpen && Boolean(term.previous_term_id)
    && (!term.returning_opens_at || term.returning_opens_at < term.public_opens_at)
    ? { from: term.returning_opens_at && term.returning_opens_at > now ? term.returning_opens_at : null, until: term.public_opens_at }
    : null;
  const seatsLeft = term.term_seats_left
    ?? (remaining.length ? Math.min(...remaining.map((s) => s.seats_left)) : 0);
  return {
    access,
    weeks,
    totalWeeks,
    isProRata: weeks < totalWeeks,
    priceCents,
    publicPriceCents,
    returningPriceCents,
    isReturning,
    plan: weeks > 0 ? planFor(term, weeks, priceCents) : null,
    returningUntil: access.open && access.viaReturningWindow ? term.public_opens_at : null,
    earlyWindow,
    seatsLeft: Math.max(0, seatsLeft),
  };
}

// The class list's headline price for a term ("Whole term, 6 weeks —
// $168.00", "Join for the remaining 4 weeks — $112.00").
export function termHeadline(offer) {
  const price = formatAud(offer.priceCents);
  if (!offer.isProRata) return `Whole term, ${plural(offer.totalWeeks, 'week')} — ${price}`;
  if (offer.weeks === 1) return `Join for the final week — ${price}`;
  return `Join for the remaining ${offer.weeks} weeks — ${price}`;
}

// "or 6 weekly payments of $28.00" / "or 3 weekly payments ($33.34, then
// $33.33)" — amounts only, so no clock is needed.
export function planSummary(plan, totalCents) {
  if (!plan || !Number.isInteger(totalCents) || totalCents <= 0) return '';
  const schedule = instalmentSchedule(totalCents, plan.n, plan.interval, '2000-01-01T00:00:00Z');
  const cadence = plan.interval === 'fortnight' ? 'fortnightly' : 'weekly';
  return schedule.firstCents === schedule.eachCents
    ? `or ${plan.n} ${cadence} payments of ${formatAud(schedule.eachCents)}`
    : `or ${plan.n} ${cadence} payments (${formatAud(schedule.firstCents)}, then ${formatAud(schedule.eachCents)})`;
}

// "Places left" wording, gentle urgency near the end.
export function seatsText(n) {
  if (n <= 0) return 'Full';
  return n <= 3 ? `Only ${plural(n, 'place')} left` : `${plural(n, 'place')} left`;
}

// "$30.00 each", or "from $25.00 each" when individual prices differ.
export function casualPriceText(sessions) {
  const prices = [...new Set((sessions || []).map((s) => s.casual_price_cents))];
  if (!prices.length) return '';
  return prices.length === 1 ? `${formatAud(prices[0])} each` : `from ${formatAud(Math.min(...prices))} each`;
}

// A booking's class dates in one line: a range for three or more.
export function describeDates(startsIso) {
  const starts = [...(startsIso || [])].filter(Boolean).sort();
  if (!starts.length) return '';
  if (starts.length > 2) {
    return `${formatSydney(starts[0], 'date')} – ${formatSydney(starts[starts.length - 1], 'date')} (${plural(starts.length, 'class', 'classes')})`;
  }
  return starts.map((s) => formatSydney(s)).join('; ');
}

// --- Holds and payment status --------------------------------------------------

// A checkout hold lasts PENDING_BOOKING_EXPIRY_SECS while a parent pays;
// pay-later holds (admin bookings, waitlist offers, auto-enrol) last days.
// Same rule as domain.js's private isCheckoutHold().
export function isCheckoutHold(booking) {
  const span = Date.parse(booking.expires_at) - Date.parse(booking.created_at);
  return Number.isFinite(span) && span <= (PENDING_BOOKING_EXPIRY_SECS + 300) * 1000;
}

// A live pending booking the family pays for from their account (Pay now).
export function isPayLaterHold(booking, now) {
  return booking.status === 'pending' && Boolean(booking.expires_at) && booking.expires_at > now
    && !isCheckoutHold(booking);
}

// Flags meaning money arrived but the booking could not be honoured as is.
export const PAYMENT_RECEIVED_FLAGS = ['paid_no_seat', 'paid_after_cancel'];

// A booking really paid by instalments: a plan was chosen AND its
// subscription started. (A plan chosen for a checkout that was abandoned,
// then settled another way, is not one.)
export function isInstalmentPlan(booking) {
  return booking.payment_method === 'plan' && Boolean(booking.plan_instalments)
    && Boolean(booking.stripe_subscription_id);
}

// The payment line a family sees for one booking.
//   booking: a bookings row (listUserBookings / getOwnedBooking shape)
//   instalmentsPaid: number of 'instalment' ledger rows for it
// Returns { key, label, detail, tone } with tone ∈ ok | due | alert | muted.
//   key ∈ received | cancelled | expired | complimentary | pay_now | paying |
//         paid | credit | plan_active | plan_overdue | plan_complete | unpaid
export function paymentStatusView(booking, { instalmentsPaid = 0, now }) {
  const status = effectiveStatus(booking, now);
  const due = booking.amount_cents + booking.credit_cents;
  const owing = Math.max(0, due - booking.paid_cents);
  if (PAYMENT_RECEIVED_FLAGS.includes(booking.needs_attention)) {
    return { key: 'received', label: 'Payment received', detail: 'Camila will be in touch', tone: 'alert' };
  }
  if (status === 'cancelled') {
    return booking.paid_cents > 0
      ? { key: 'cancelled', label: `Paid ${formatAud(booking.paid_cents)}`, detail: 'booking cancelled', tone: 'muted' }
      : { key: 'cancelled', label: 'Cancelled', detail: '', tone: 'muted' };
  }
  if (status === 'expired') return { key: 'expired', label: 'Not completed', detail: '', tone: 'muted' };
  if (booking.kind === 'complimentary' || booking.payment_status === 'waived') {
    return { key: 'complimentary', label: 'Complimentary', detail: 'nothing to pay', tone: 'ok' };
  }
  if (status === 'pending') {
    if (isPayLaterHold(booking, now)) {
      return {
        key: 'pay_now', label: `To pay: ${formatAud(booking.amount_cents)}`,
        detail: `held for you until ${formatSydney(booking.expires_at)}`, tone: 'due',
      };
    }
    return { key: 'paying', label: 'Payment in progress', detail: '', tone: 'due' };
  }
  const n = booking.plan_instalments || 0;
  let paymentStatus = booking.payment_status;
  if (paymentStatus.startsWith('plan_') && !isInstalmentPlan(booking)) {
    // A plan was chosen but never started (settled another way).
    paymentStatus = paymentStatus === 'plan_complete' || owing === 0 ? 'paid' : 'unpaid';
  }
  switch (paymentStatus) {
    case 'paid':
      return booking.amount_cents === 0 && booking.credit_cents > 0
        ? { key: 'credit', label: 'Paid', detail: 'with account credit', tone: 'ok' }
        : { key: 'paid', label: 'Paid', detail: '', tone: 'ok' };
    case 'plan_active':
      return {
        key: 'plan_active', label: `Instalments: ${Math.min(instalmentsPaid, n)} of ${n} paid`,
        detail: booking.plan_next_charge_at ? `next payment ${formatSydney(booking.plan_next_charge_at, 'date')}` : '',
        tone: 'ok',
      };
    case 'plan_overdue':
      return {
        key: 'plan_overdue', label: 'Payment overdue',
        detail: `an instalment didn't go through (${Math.min(instalmentsPaid, n)} of ${n} paid)`, tone: 'alert',
      };
    case 'plan_complete':
      return { key: 'plan_complete', label: 'Paid', detail: `all ${n} instalments`, tone: 'ok' };
    default:
      return { key: 'unpaid', label: 'Unpaid', detail: owing > 0 ? `${formatAud(owing)} to pay` : '', tone: 'due' };
  }
}

// The instalment schedule of a plan booking, with the ones already paid
// marked. Dates are anchored on the first payment, as Stripe bills them —
// or on `now` while that payment is still on its way (never on when the
// booking was created: a held place may be paid for days later).
export function planScheduleView(booking, instalmentsPaid = 0, now = null) {
  if (!booking.plan_instalments || booking.amount_cents <= 0) return [];
  const anchor = booking.paid_at || now || booking.created_at;
  const schedule = instalmentSchedule(booking.amount_cents, booking.plan_instalments, booking.plan_interval || 'week', anchor);
  return schedule.payments.map((p) => ({ ...p, paid: p.index <= instalmentsPaid }));
}

export function waitlistPositionText(position) {
  return position <= 1 ? 'first in line' : `number ${position} in line`;
}

// --- Owner-scoped reads ---------------------------------------------------------

export async function listChildren(env, userId) {
  return (await env.DB.prepare(
    `SELECT id, name, dob, medical_notes, photo_consent FROM children
     WHERE user_id = ?1 AND archived_at IS NULL ORDER BY created_at`,
  ).bind(userId).all()).results || [];
}

// Children (of those given) who already have a live trial, any class.
export async function childrenWithTrial(env, children, now) {
  const used = new Set();
  for (const child of children) {
    if (await childHasTrial(env, child.id, null, now)) used.add(child.id);
  }
  return used;
}

// The account's live (confirmed, or pending with an unexpired hold) term
// bookings, for "booked in" / "held — Pay now" notes per term.
export async function liveTermBookings(env, userId, now) {
  return (await env.DB.prepare(
    `SELECT b.id, b.child_id, b.term_id, b.status, b.created_at, b.expires_at, b.payment_ref,
            b.amount_cents, c.name AS child_name
     FROM bookings b JOIN children c ON c.id = b.child_id
     WHERE b.user_id = ?1 AND b.kind = 'term' AND b.term_id IS NOT NULL AND ${bookingLiveSql('b', '?2')}
     ORDER BY b.created_at`,
  ).bind(userId, now).all()).results || [];
}

// This child's live pending bookings that hold any of `sessionIds` (or, with
// no session ids, any booking in `termId`), optionally of one kind — the
// "you've already started this booking" case at checkout.
export async function pendingHoldsForChild(env, {
  userId, childId, termId = null, sessionIds = [], kind = null, now,
}) {
  const ids = [...new Set(sessionIds)].slice(0, 50);
  const bySession = ids.length
    ? `EXISTS (SELECT 1 FROM booking_sessions bs WHERE bs.booking_id = b.id AND bs.status = 'booked'
                 AND bs.session_id IN (${ids.map((_, i) => `?${i + 6}`).join(', ')}))`
    : '0';
  return (await env.DB.prepare(
    `SELECT b.id, b.kind, b.status, b.term_id, b.created_at, b.expires_at, b.payment_ref, b.amount_cents
     FROM bookings b
     WHERE b.user_id = ?1 AND b.child_id = ?2 AND b.status = 'pending' AND b.expires_at > ?3
       AND (?4 IS NULL OR b.kind = ?4)
       AND (${bySession} OR (?5 IS NOT NULL AND b.term_id = ?5))
     ORDER BY b.created_at DESC`,
  ).bind(userId, childId, now, kind, ids.length ? null : termId, ...ids).all()).results || [];
}

// Instalments paid per booking of the account: Map bookingId → count.
export async function instalmentCounts(env, userId) {
  const rows = (await env.DB.prepare(
    `SELECT p.booking_id, COUNT(*) AS n FROM payments p JOIN bookings b ON b.id = p.booking_id
     WHERE b.user_id = ?1 AND p.kind = 'instalment' AND p.amount_cents > 0
     GROUP BY p.booking_id`,
  ).bind(userId).all()).results || [];
  return new Map(rows.map((r) => [r.booking_id, r.n]));
}

// The account's waitlist entries (waiting or offered by default), with the
// place in line: entries of the same term still waiting or offered that
// joined earlier, plus one. Join times have second precision, so two
// families joining in the same second are ordered by insertion (rowid).
const WAITLIST_STATUSES = ['waiting', 'offered', 'booked', 'declined', 'removed'];

export async function listWaitlistEntries(env, userId, { termId = null, statuses = ['waiting', 'offered'] } = {}) {
  const wanted = statuses.filter((s) => WAITLIST_STATUSES.includes(s));
  if (!wanted.length) return [];
  const rows = await env.DB.prepare(
    `SELECT w.id, w.term_id, w.child_id, w.status, w.joined_at, w.offered_at, w.offer_expires_at,
            w.offer_booking_id, ch.name AS child_name, t.name AS term_name, c.name AS class_name,
            (SELECT COUNT(*) FROM waitlist w2
             WHERE w2.term_id = w.term_id AND w2.status IN ('waiting', 'offered')
               AND (w2.joined_at < w.joined_at OR (w2.joined_at = w.joined_at AND w2.rowid < w.rowid))) + 1 AS position
     FROM waitlist w
     JOIN children ch ON ch.id = w.child_id
     JOIN terms t ON t.id = w.term_id
     JOIN classes c ON c.id = t.class_id
     WHERE w.user_id = ?1 AND (?2 IS NULL OR w.term_id = ?2)
       AND w.status IN (${wanted.map((s) => `'${s}'`).join(', ')})
     ORDER BY w.joined_at, w.rowid`,
  ).bind(userId, termId).all();
  return rows.results || [];
}
