// Domain-level booking logic (designs D2, D3, D6), shared by the parent flow,
// the admin portal, the payment webhooks and the scheduled jobs:
//
//   * THE definition of a held seat (holdsSeatSql / heldSeatsSql) — every
//     count, guard, roster, list and grid uses it;
//   * terms and their sessions, returning families, one trial per child (any class);
//   * prepareBooking(): pricing + every eligibility check, for a quote;
//   * createPendingBooking(): capacity-guarded, atomic seat reservation that
//     also redeems credits and counts the voucher use in the same batch;
//   * confirmBooking(): the ONE confirmation path for every payment source,
//     re-checking seats when the hold had lapsed (paid_no_seat otherwise);
//   * cancelBooking / expireBooking / abandonCheckout / sweepExpiredBookings,
//     which give credits and voucher uses back when a pending booking ends.
//
// D1 has no interactive transactions: every multi-statement write is one
// env.DB.batch() (atomic), with txn_guards CHECK guards for conditional
// rollback. Side effects that must happen exactly once on a status change are
// conditioned on the booking's status at that point of the batch and placed
// BEFORE the change itself.
//
// Rows are returned as database rows (snake_case) with computed fields added
// in the same style (seats_held, seats_left, …).

import { uuid, nowIso, isoPlusSeconds, txnGuard, isConstraintError } from './db.js';
import { logEvent, logError } from './log.js';
import {
  quoteTerm, quoteSessions, quoteTrial, finaliseQuote, planFor, instalmentSchedule,
  normaliseVoucherCode, canBookTerm, applyCredits,
} from './pricing.js';
import {
  paymentInsertStatement, recomputeStatement, creditAppliedStatement, availableCredits,
  creditRedemptionStatements, reverseRedemptionStatements, voucherUseStatements,
  voucherReleaseStatements, loadVoucher,
} from './ledger.js';
import { getPaymentsDriver, stopSubscription } from './payments-driver.js';

// A parent's seats are held this long while they pay (Stripe Checkout itself
// expires after 31 minutes — see payments-driver.js).
export const PENDING_BOOKING_EXPIRY_SECS = 35 * 60;

// A pending booking held for at most this long is a CHECKOUT hold (a parent
// paying right now); anything longer is a PAY-LATER hold (an owner booking, a
// waitlist offer, an auto-enrolment) that the family pays from their account
// with Pay now. Pay-later holds last hours or days, and createPendingBooking
// refuses one that would not clear this threshold.
export const CHECKOUT_HOLD_MAX_SECS = PENDING_BOOKING_EXPIRY_SECS + 5 * 60;

// THE checkout-hold rule: every page, list and action that tells the two
// kinds of hold apart uses this one function.
//   booking: a bookings row (created_at, expires_at)
export function isCheckoutHold(booking) {
  const span = Date.parse(booking.expires_at) - Date.parse(booking.created_at);
  return Number.isFinite(span) && span <= CHECKOUT_HOLD_MAX_SECS * 1000;
}

export const BOOKING_KINDS = ['term', 'casual', 'trial', 'complimentary'];

export const KIND_LABELS = {
  term: 'Term',
  casual: 'Casual',
  trial: 'Trial class',
  complimentary: 'Complimentary',
};

export const PAYMENT_STATUS_LABELS = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  plan_active: 'Paying by instalments',
  plan_overdue: 'Instalment overdue',
  plan_complete: 'Instalments complete',
  waived: 'Complimentary',
};

// bookings.needs_attention values, with owner-facing wording.
export const NEEDS_ATTENTION_LABELS = {
  paid_no_seat: 'Paid, but no seat was free',
  paid_after_cancel: 'Paid after the booking was cancelled',
  plan_overdue: 'Instalment overdue',
  plan_ended_short: 'Instalment plan ended before the full amount was paid',
  webhook_mismatch: "Payment doesn't match the booking",
  credit_shortfall: 'Account credit was no longer available when the payment arrived',
  overpaid: 'Paid more than the booking costs',
  plan_stop_failed: "Fully paid, but the instalment plan couldn't be stopped in Stripe",
};

export function formatAud(cents) {
  const value = Number(cents || 0);
  const sign = value < 0 ? '−' : '';
  return `${sign}$${(Math.abs(value) / 100).toFixed(2)}`;
}

// --- The definition of a held seat -------------------------------------------

// A LIVE booking: confirmed, or pending with an unexpired hold.
export function bookingLiveSql(b, nowParam) {
  return `(${b}.status = 'confirmed' OR (${b}.status = 'pending' AND ${b}.expires_at > ${nowParam}))`;
}

// A booking_sessions row HOLDS A SEAT when it is 'booked' and its booking is
// live (schema comment on booking_sessions; design D2). This is the only
// definition — everything below is built on it.
export function holdsSeatSql(bs, b, nowParam) {
  return `(${bs}.status = 'booked' AND ${bookingLiveSql(b, nowParam)})`;
}

// Seats held in a session: a scalar subquery. `sessionAlias` is a table alias
// ("cs" → cs.id) or a bound parameter holding the session id ("?2").
export function heldSeatsSql(sessionAlias, nowParam, { excludeBooking = null } = {}) {
  const sessionId = sessionAlias.startsWith('?') ? sessionAlias : `${sessionAlias}.id`;
  return `(SELECT COUNT(*) FROM booking_sessions hs JOIN bookings hb ON hb.id = hs.booking_id
           WHERE hs.session_id = ${sessionId} AND ${holdsSeatSql('hs', 'hb', nowParam)}${
             excludeBooking ? ` AND hb.id != ${excludeBooking}` : ''})`;
}

// Does this child already hold a seat in the session (through another booking)?
function childInSessionSql(sessionIdExpr, childParam, nowParam, excludeBookingParam) {
  return `EXISTS (SELECT 1 FROM booking_sessions cbs JOIN bookings cb ON cb.id = cbs.booking_id
                  WHERE cbs.session_id = ${sessionIdExpr} AND cb.child_id = ${childParam}
                    AND cb.id != ${excludeBookingParam} AND ${holdsSeatSql('cbs', 'cb', nowParam)})`;
}

// Does this child hold a live trial anywhere? ONE trial per child across all
// classes (owner decision, 2026-10-13 interview). `classParam` stays in the
// signature for call-site stability but no longer narrows the check.
// A trial the OWNER called off does not count, so the child may book another:
// the trial booking must be live AND still hold a 'booked' row in a scheduled
// session (a cancelled week or a cancelled class frees it; a trial moved to
// another class has a 'booked' row there, so it still counts).
function trialHeldSql(childParam, classParam, nowParam, excludeBookingParam = null) {
  return `EXISTS (SELECT 1 FROM bookings tb
                  JOIN booking_sessions tbs ON tbs.booking_id = tb.id AND tbs.status = 'booked'
                  JOIN class_sessions tcs ON tcs.id = tbs.session_id AND tcs.status = 'scheduled'
                  WHERE tb.child_id = ${childParam} AND tb.kind = 'trial'
                    ${excludeBookingParam ? `AND tb.id != ${excludeBookingParam}` : ''}
                    AND ${bookingLiveSql('tb', nowParam)})`;
}

function decorateSession(row, now) {
  const seatsLeft = row.status === 'scheduled' ? Math.max(0, row.capacity - row.seats_held) : 0;
  return { ...row, seats_left: seatsLeft, is_past: row.starts_at <= now };
}

// --- Sessions ----------------------------------------------------------------

const SESSION_COLUMNS = `cs.id, cs.class_id, cs.term_id, cs.starts_at, cs.duration_mins, cs.capacity,
  cs.casual_price_cents, cs.status, cs.cancelled_reason, cs.cancelled_at`;

// Sessions a parent is trying to book, in the order asked, with bookability:
// reason ∈ not_found | unavailable (cancelled / class inactive) | past | full.
export async function loadSessionsForBooking(env, sessionIds, now = nowIso()) {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(', ');
  const result = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS}, c.active AS class_active, c.name AS class_name, c.venue,
            t.name AS term_name, ${heldSeatsSql('cs', '?1')} AS seats_held
     FROM class_sessions cs
     JOIN classes c ON c.id = cs.class_id
     LEFT JOIN terms t ON t.id = cs.term_id
     WHERE cs.id IN (${placeholders})`,
  ).bind(now, ...ids).all();

  const byId = new Map((result.results || []).map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) return { id, bookable: false, reason: 'not_found' };
    let reason = null;
    if (row.status !== 'scheduled' || !row.class_active) reason = 'unavailable';
    else if (row.starts_at <= now) reason = 'past';
    else if (row.seats_held >= row.capacity) reason = 'full';
    return { ...decorateSession(row, now), bookable: !reason, reason };
  });
}

// Sessions among `sessionIds` in which this child already holds a seat.
export async function sessionsAlreadyBookedForChild(env, childId, sessionIds, now = nowIso()) {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return new Set();
  const placeholders = ids.map((_, i) => `?${i + 3}`).join(', ');
  const rows = await env.DB.prepare(
    `SELECT DISTINCT bs.session_id FROM booking_sessions bs
     JOIN bookings b ON b.id = bs.booking_id
     WHERE b.child_id = ?1 AND bs.session_id IN (${placeholders})
       AND ${holdsSeatSql('bs', 'b', '?2')}`,
  ).bind(childId, now, ...ids).all();
  return new Set((rows.results || []).map((r) => r.session_id));
}

// Admin schedule: sessions with live fullness, optionally one class or term.
export async function listSessionsWithFullness(env, {
  upcomingOnly = true, classId = null, termId = null, now = nowIso(),
} = {}) {
  const rows = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS}, c.name AS class_name, c.active AS class_active, t.name AS term_name,
            ${heldSeatsSql('cs', '?1')} AS seats_held
     FROM class_sessions cs
     JOIN classes c ON c.id = cs.class_id
     LEFT JOIN terms t ON t.id = cs.term_id
     WHERE (?4 = 0 OR cs.starts_at > ?1)
       AND (?2 IS NULL OR cs.class_id = ?2)
       AND (?3 IS NULL OR cs.term_id = ?3)
     ORDER BY cs.starts_at`,
  ).bind(now, classId, termId, upcomingOnly ? 1 : 0).all();
  return (rows.results || []).map((r) => decorateSession(r, now));
}

// --- Terms -------------------------------------------------------------------

const TERM_SELECT = `
  SELECT t.*, c.name AS class_name, c.description AS class_description, c.venue, c.age_range,
         c.weekday, c.start_time, c.default_duration_mins, c.default_capacity, c.active AS class_active
  FROM terms t JOIN classes c ON c.id = t.class_id`;

// A term with its class details (or null).
export async function loadTerm(env, termId) {
  if (!termId) return null;
  return env.DB.prepare(`${TERM_SELECT} WHERE t.id = ?1`).bind(termId).first();
}

// Every session of a term (any status), in date order, with seats.
export async function listTermSessions(env, termId, { now = nowIso() } = {}) {
  const rows = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS}, ${heldSeatsSql('cs', '?2')} AS seats_held
     FROM class_sessions cs WHERE cs.term_id = ?1 ORDER BY cs.starts_at`,
  ).bind(termId, now).all();
  return (rows.results || []).map((r) => decorateSession(r, now));
}

// The term's scheduled sessions that have not started, and how many scheduled
// sessions it has in total (the pro-rata denominator, D3).
export async function termSessionsRemaining(env, termId, now = nowIso()) {
  const sessions = await listTermSessions(env, termId, { now });
  const scheduled = sessions.filter((s) => s.status === 'scheduled');
  return {
    sessions,
    remaining: scheduled.filter((s) => s.starts_at > now),
    totalScheduled: scheduled.length,
  };
}

// Open terms of active classes that still have a session to come, each with
// its sessions (seats per session), total_scheduled, remaining (scheduled and
// upcoming) and term_seats_left (the fewest seats left across remaining
// sessions — a term booking needs a seat in every one).
export async function listOpenTerms(env, { now = nowIso() } = {}) {
  const filter = `t.status = 'open' AND c.active = 1
    AND EXISTS (SELECT 1 FROM class_sessions s
                WHERE s.term_id = t.id AND s.status = 'scheduled' AND s.starts_at > ?1)`;
  const terms = (await env.DB.prepare(
    `${TERM_SELECT} WHERE ${filter} ORDER BY t.starts_on, c.start_time, c.name`,
  ).bind(now).all()).results || [];
  if (!terms.length) return [];

  const sessions = (await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS}, ${heldSeatsSql('cs', '?1')} AS seats_held
     FROM class_sessions cs
     WHERE cs.term_id IN (SELECT t.id FROM terms t JOIN classes c ON c.id = t.class_id WHERE ${filter})
     ORDER BY cs.starts_at`,
  ).bind(now).all()).results || [];

  const byTerm = new Map(terms.map((t) => [t.id, []]));
  for (const s of sessions) byTerm.get(s.term_id)?.push(decorateSession(s, now));
  return terms.map((term) => {
    const all = byTerm.get(term.id) || [];
    const scheduled = all.filter((s) => s.status === 'scheduled');
    const remaining = scheduled.filter((s) => s.starts_at > now);
    return {
      ...term,
      sessions: all,
      total_scheduled: scheduled.length,
      remaining,
      term_seats_left: remaining.length ? Math.min(...remaining.map((s) => s.seats_left)) : 0,
    };
  });
}

// Upcoming scheduled one-off sessions (no term) of active classes.
export async function listOneOffSessions(env, { now = nowIso() } = {}) {
  const rows = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS}, c.name AS class_name, c.venue, c.age_range,
            c.description AS class_description, ${heldSeatsSql('cs', '?1')} AS seats_held
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id
     WHERE cs.term_id IS NULL AND cs.status = 'scheduled' AND c.active = 1 AND cs.starts_at > ?1
     ORDER BY c.name, cs.starts_at`,
  ).bind(now).all();
  return (rows.results || []).map((r) => decorateSession(r, now));
}

// A returning family holds a confirmed term booking (any child of the
// account) in the term's previous term (D3).
export async function isReturningFamily(env, userId, termId) {
  const row = await env.DB.prepare(
    `SELECT 1 AS yes FROM terms t
     JOIN bookings b ON b.term_id = t.previous_term_id
     WHERE t.id = ?2 AND b.user_id = ?1 AND b.kind = 'term' AND b.status = 'confirmed'
     LIMIT 1`,
  ).bind(userId, termId).first();
  return Boolean(row);
}

// Has this child already got a live trial (any class)?
export async function childHasTrial(env, childId, classId, now = nowIso()) {
  const row = await env.DB.prepare(
    `SELECT ${trialHeldSql('?1', '?2', '?3')} AS held`,
  ).bind(childId, classId, now).first();
  return Boolean(row && row.held);
}

// --- Preparing a booking (quote + checks) ------------------------------------

function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

// Everything a checkout (parent or admin) needs before reserving seats:
// which sessions, the price (D3: term / pro-rata / returning / casual / trial,
// voucher, credits, optional instalment plan) and every eligibility rule.
//
//   kind: term | casual | trial | complimentary
//   termId: required for term; for casual/trial the chosen sessions must
//           belong to it (one-off sessions: omit termId)
//   sessionIds: casual (chosen), trial (exactly one), complimentary (chosen,
//               or omit to cover the term's remaining sessions)
//   paymentChoice: 'full' | 'plan'
//   admin: true for owner-made bookings — skips opening times and term status
//          (auto-enrol targets draft terms) and allows complimentary
//   priceOverrideCents: admin price override (replaces the list price)
//   forceReturningPrice: admin auto-enrol — the term's returning price (if
//               it has one), pro-rated, whatever its returning window says
//
// Returns { ok: true, kind, term, sessions, quote, warnings } where quote =
//   { kind, sessionIds, weeks, totalWeeks, listCents, isProRata, isReturning,
//     discountCents, voucherCode, voucherError, creditCents, allocations,
//     amountCents, planOption: {n, interval} | null,
//     plan: {n, interval, eachCents, firstCents, schedule} | null }
// or { ok: false, error, … } with error ∈ invalid_kind | not_found | closed |
//   not_open_yet (opensAt) | finished | no_sessions | trial_one_session |
//   trial_used | unavailable | full (sessions) | already_booked (sessions) |
//   plan_unavailable. An invalid voucher is NOT an error here: quote.voucherError
//   says why, and the caller decides.
export async function prepareBooking(env, {
  userId, childId, kind, termId = null, sessionIds = [], voucherCode = '',
  paymentChoice = 'full', now = nowIso(), admin = false, priceOverrideCents = null, forceReturningPrice = false,
}) {
  if (!BOOKING_KINDS.includes(kind) || (kind === 'complimentary' && !admin)) return fail('invalid_kind');

  // Lapsed holds of this account give their seats, credits and voucher uses
  // back before anything is counted.
  await sweepExpiredBookings(env, { now, userId });

  const term = termId ? await loadTerm(env, termId) : null;
  if (termId && !term) return fail('not_found');
  const returning = term ? await isReturningFamily(env, userId, term.id) : false;
  const warnings = [];
  let base;
  let sessions;

  if (kind === 'term' || (kind === 'complimentary' && !sessionIds.length)) {
    if (!term) return fail('not_found');
    const all = await listTermSessions(env, term.id, { now });
    const held = await sessionsAlreadyBookedForChild(env, childId, all.map((s) => s.id), now);
    base = quoteTerm({
      term, sessions: all, now, returning, excludeSessionIds: [...held], ignoreOpening: admin,
      forceReturningPrice: admin && forceReturningPrice,
    });
    if (!base.ok) return fail(base.reason, { opensAt: base.opensAt || null });
    if (held.size) warnings.push('child_already_holds_some_weeks');
    sessions = await loadSessionsForBooking(env, base.sessionIds, now);
  } else {
    const ids = [...new Set(sessionIds)];
    if (!ids.length) return fail('no_sessions');
    if (kind === 'trial' && ids.length !== 1) return fail('trial_one_session');
    sessions = await loadSessionsForBooking(env, ids, now);
    if (sessions.some((s) => s.reason === 'not_found')) return fail('not_found');
    const termIds = new Set(sessions.map((s) => s.term_id || null));
    if (termIds.size > 1 || (term && !termIds.has(term.id)) || (!term && !termIds.has(null))) {
      return fail('not_found');
    }
    if (term && !admin) {
      const access = canBookTerm({ term, now, returning });
      if (!access.open) return fail(access.reason, { opensAt: access.opensAt || null });
    }
    if (kind === 'trial' && await childHasTrial(env, childId, sessions[0].class_id, now)) {
      return fail('trial_used');
    }
    base = kind === 'trial' ? quoteTrial({ term, session: sessions[0] }) : quoteSessions({ sessions });
  }

  const unavailable = sessions.filter((s) => !s.bookable);
  if (unavailable.length) {
    return fail(unavailable.some((s) => s.reason === 'full') ? 'full' : 'unavailable', { sessions: unavailable });
  }
  const duplicates = await sessionsAlreadyBookedForChild(env, childId, sessions.map((s) => s.id), now);
  if (duplicates.size) {
    return fail('already_booked', { sessions: sessions.filter((s) => duplicates.has(s.id)) });
  }

  if (kind === 'complimentary') base = { ...base, kind: 'complimentary', listCents: 0 };
  if (priceOverrideCents !== null && priceOverrideCents !== undefined) {
    base = { ...base, listCents: priceOverrideCents, priceOverridden: true };
  }

  const code = kind === 'complimentary' ? '' : normaliseVoucherCode(voucherCode);
  const voucher = code ? await loadVoucher(env, code) : null;
  const credits = kind === 'complimentary' ? [] : await availableCredits(env, userId, childId, now);
  const quote = finaliseQuote(base, { voucher, voucherCode: code, credits, now });

  const planOption = kind === 'term' ? planFor(term, quote.weeks, quote.amountCents) : null;
  let plan = null;
  if (paymentChoice === 'plan') {
    if (!planOption || quote.amountCents <= 0) return fail('plan_unavailable');
    const schedule = instalmentSchedule(quote.amountCents, planOption.n, planOption.interval, now);
    plan = { ...planOption, eachCents: schedule.eachCents, firstCents: schedule.firstCents, schedule };
  }

  return { ok: true, kind, term, sessions, quote: { ...quote, planOption, plan }, warnings };
}

// --- Reserving seats ---------------------------------------------------------

// Create a pending booking holding seats in one or more sessions, atomically.
//
// One batch: the booking row; a guarded insert per session (scheduled, class
// active, not started, a free seat by the held-seat definition, child not
// already in it); a count guard that rolls everything back unless EVERY seat
// was taken; the one-trial-per-class guard; the voucher use (within its
// limits); and the credit redemptions. Two parents racing for the last seat
// resolve to exactly one booking.
//
// `quote` comes from prepareBooking (listCents, discountCents, voucherCode,
// creditCents, allocations, amountCents, plan). `expiresAt` defaults to now +
// 35 minutes (a checkout hold); pay-later holds pass their own, which must
// outlast CHECKOUT_HOLD_MAX_SECS (isCheckoutHold tells the two apart).
// `paymentMethod` defaults from the quote: plan | none (nothing to pay) | full.
//
// Returns { id, expiresAt, amountCents, sessions } or { error, sessions? } with
// error ∈ no_sessions | unavailable | already_booked | trial_one_session |
// trial_used | capacity | voucher_invalid | credit_changed.
export async function createPendingBooking(env, {
  userId, childId, kind, termId = null, sessionIds, quote, waiverVersion = null,
  photoConsent = null, medicalNotes = null, expiresAt = null, paymentMethod = null, now = nowIso(),
}) {
  if (!BOOKING_KINDS.includes(kind)) throw new Error(`Unknown booking kind: ${kind}`);
  const unique = [...new Set(sessionIds || [])];
  if (!unique.length) return { error: 'no_sessions' };
  const listCents = quote.listCents ?? 0;
  const discountCents = quote.discountCents ?? 0;
  const creditCents = quote.creditCents ?? 0;
  const amountCents = quote.amountCents ?? 0;
  if (![listCents, discountCents, creditCents, amountCents].every((v) => Number.isInteger(v) && v >= 0)
    || listCents - discountCents - creditCents !== amountCents) {
    throw new Error('createPendingBooking: inconsistent quote');
  }
  if (expiresAt && Date.parse(expiresAt) - Date.parse(now) <= CHECKOUT_HOLD_MAX_SECS * 1000) {
    // It would be mistaken for a checkout hold: no Pay now, released by
    // "Didn't finish paying?" and Check with Stripe like an abandoned checkout.
    throw new Error('createPendingBooking: a pay-later hold must outlast the checkout hold');
  }

  const sessions = await loadSessionsForBooking(env, unique, now);
  const unavailable = sessions.filter((s) => !s.bookable);
  if (unavailable.length) return { error: 'unavailable', sessions: unavailable };
  const duplicates = await sessionsAlreadyBookedForChild(env, childId, unique, now);
  if (duplicates.size) {
    return {
      error: 'already_booked',
      sessions: sessions.filter((s) => duplicates.has(s.id)).map((s) => ({ ...s, reason: 'already_booked' })),
    };
  }
  let trialClassId = null;
  if (kind === 'trial') {
    if (unique.length !== 1) return { error: 'trial_one_session' };
    trialClassId = sessions[0].class_id;
    if (await childHasTrial(env, childId, trialClassId, now)) return { error: 'trial_used' };
  }

  const bookingId = uuid();
  const hold = expiresAt || isoPlusSeconds(PENDING_BOOKING_EXPIRY_SECS, Date.parse(now));
  const plan = quote.plan || null;
  const method = paymentMethod || (plan ? 'plan' : amountCents === 0 ? 'none' : 'full');
  const allocations = quote.allocations || [];

  const statements = [
    env.DB.prepare(
      `INSERT INTO bookings
         (id, user_id, child_id, kind, term_id, status, list_amount_cents, discount_cents, voucher_code,
          credit_cents, amount_cents, currency, payment_method, payment_status,
          plan_instalments, plan_instalment_cents, plan_interval,
          waiver_version, waiver_accepted_at, photo_consent_snapshot, medical_notes_snapshot,
          created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10, 'AUD', ?11, ?12, ?13, ?14, ?15,
               ?16, ?17, ?18, ?19, ?20, ?21)`,
    ).bind(
      bookingId, userId, childId, kind, termId, listCents, discountCents, quote.voucherCode || null,
      creditCents, amountCents, method, kind === 'complimentary' ? 'waived' : 'unpaid',
      plan ? plan.n : null, plan ? plan.eachCents : null, plan ? plan.interval : null,
      waiverVersion, waiverVersion ? now : null,
      photoConsent === null || photoConsent === undefined ? null : (photoConsent ? 1 : 0),
      medicalNotes, now, hold,
    ),

    ...unique.map((sessionId) => env.DB.prepare(
      `INSERT INTO booking_sessions (booking_id, session_id, status)
       SELECT ?1, cs.id, 'booked' FROM class_sessions cs
       JOIN classes c ON c.id = cs.class_id
       WHERE cs.id = ?2 AND cs.status = 'scheduled' AND c.active = 1 AND cs.starts_at > ?3
         AND cs.capacity > ${heldSeatsSql('cs', '?3')}
         AND NOT ${childInSessionSql('cs.id', '?4', '?3', '?1')}`,
    ).bind(bookingId, sessionId, now, childId)),

    ...txnGuard(env, `(SELECT COUNT(*) FROM booking_sessions WHERE booking_id = ?1) = ?2`,
      [bookingId, unique.length], 'capacity'),

    ...(kind === 'trial'
      ? txnGuard(env, `NOT ${trialHeldSql('?1', '?2', '?3', '?4')}`,
        [childId, trialClassId, now, bookingId], 'trial')
      : []),

    ...(quote.voucherCode ? voucherUseStatements(env, quote.voucherCode, { now }) : []),

    ...creditRedemptionStatements(env, { bookingId, userId, childId, allocations, now }),
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    // A guard rolled the batch back. Diagnose for the parent-facing message.
    const after = await loadSessionsForBooking(env, unique, now);
    const dupAfter = await sessionsAlreadyBookedForChild(env, childId, unique, now);
    const lost = after
      .map((s) => (dupAfter.has(s.id) ? { ...s, bookable: false, reason: 'already_booked' } : s))
      .filter((s) => !s.bookable);
    logEvent('booking_guard_rejected', { user_id: String(userId).slice(0, 8), lost: lost.length });
    if (lost.length) return { error: 'capacity', sessions: lost };
    if (kind === 'trial' && await childHasTrial(env, childId, trialClassId, now)) return { error: 'trial_used' };
    if (quote.voucherCode) {
      const voucher = await loadVoucher(env, quote.voucherCode);
      if (!voucher || !voucher.active || (voucher.max_uses !== null && voucher.uses >= voucher.max_uses)) {
        return { error: 'voucher_invalid' };
      }
    }
    if (allocations.length) return { error: 'credit_changed' };
    return { error: 'capacity', sessions: after };
  }

  logEvent('pending_booking_created', {
    booking_id: bookingId.slice(0, 8), kind, sessions: unique.length, amount_cents: amountCents,
  });
  return { id: bookingId, expiresAt: hold, amountCents, sessions };
}

// Record the hosted-checkout handle on a pending booking.
export async function attachPaymentRef(env, bookingId, provider, paymentRef) {
  await env.DB.prepare(
    `UPDATE bookings SET payment_provider = ?2, payment_ref = ?3 WHERE id = ?1`,
  ).bind(bookingId, provider, paymentRef).run();
}

// --- Confirming --------------------------------------------------------------

// Set (or, with flag = null, clear) a booking's needs_attention flag.
//   overwrite: false keeps a flag that is already set (setting only)
//   onlyIf:    [flags] — change the booking only while it carries one of
//              these flags (e.g. clear "paid_no_seat" but never a newer flag
//              that replaced it); values are bound, never inlined
export function flagStatement(env, bookingId, flag, { overwrite = true, onlyIf = null } = {}) {
  if (flag !== null && !Object.hasOwn(NEEDS_ATTENTION_LABELS, flag)) throw new Error(`Unknown attention flag: ${flag}`);
  const current = onlyIf ? [...new Set(onlyIf)] : [];
  if (onlyIf && !current.length) throw new Error('flagStatement: onlyIf needs at least one flag');
  const guard = current.length ? ` AND needs_attention IN (${current.map((_, i) => `?${i + 3}`).join(', ')})` : '';
  // ?2 is always used (D1 rejects bindings the SQL does not reference).
  const set = flag !== null && !overwrite ? 'COALESCE(needs_attention, ?2)' : '?2';
  return env.DB.prepare(`UPDATE bookings SET needs_attention = ${set} WHERE id = ?1${guard}`)
    .bind(bookingId, flag, ...current);
}

// Set or clear (flag = null) a flag now. Returns true when the booking changed.
export async function flagBooking(env, bookingId, flag, options = {}) {
  const result = await flagStatement(env, bookingId, flag, options).run();
  const changed = result.meta.changes > 0;
  if (changed) logEvent(flag === null ? 'booking_flag_cleared' : 'booking_flagged', { booking_id: bookingId.slice(0, 8), flag });
  return changed;
}

function waitlistBookedStatement(env, bookingId, now) {
  return env.DB.prepare(
    `UPDATE waitlist SET status = 'booked', resolved_at = ?2
     WHERE offer_booking_id = ?1 AND status IN ('offered', 'waiting')`,
  ).bind(bookingId, now);
}

function expiryStatements(env, bookingId) {
  return [
    ...reverseRedemptionStatements(env, bookingId, { whenStatusIn: ['pending'] }),
    ...voucherReleaseStatements(env, bookingId, { whenStatusIn: ['pending'] }),
    env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE id = ?1 AND status = 'pending'`).bind(bookingId),
  ];
}

// Would any of this booking's seats be refused right now? (capacity excluding
// the booking itself, or the child already in that session elsewhere)
async function seatConflict(env, booking, now) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS conflicts FROM booking_sessions bs
     JOIN class_sessions cs ON cs.id = bs.session_id
     WHERE bs.booking_id = ?1 AND bs.status = 'booked' AND cs.status = 'scheduled' AND cs.starts_at > ?2
       AND (cs.capacity <= ${heldSeatsSql('cs', '?2', { excludeBooking: '?1' })}
            OR ${childInSessionSql('cs.id', '?3', '?2', '?1')})`,
  ).bind(booking.id, now, booking.child_id).first();
  return row.conflicts > 0;
}

// Confirm a booking because money (or nothing-owed) says so. The ONE path for
// the Stripe webhook, the mock checkout, zero-total checkouts, offline
// payments and "Check with Stripe" (D6). Idempotent.
//
//   payment: optional ledger row { kind, amountCents, provider, providerRef,
//            method, note, recordedBy, paidAt } recorded in the same batch.
//
//   * confirmed → records the payment (if new) and recomputes.
//   * cancelled → records the payment, flags paid_after_cancel.
//   * pending with a live hold → confirmed.
//   * expired, or pending past its hold → every seat is re-taken under the
//     same guards as a new booking (capacity excluding this booking; child
//     not already in the session; started/cancelled sessions are not
//     re-checked). Success → confirmed (credit and voucher uses re-taken).
//     Failure → the payment is still recorded, the booking stays expired and
//     is flagged paid_no_seat; nothing is sold twice.
//
// Returns { ok: true, status: 'confirmed', newlyConfirmed, reconfirmed,
//           creditShortfall } or { ok: false, error, flagged? } with
// error ∈ not_found | cancelled | paid_no_seat.
export async function confirmBooking(env, bookingId, options = {}) {
  let skipCredits = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await attemptConfirm(env, bookingId, { ...options, skipCredits });
    if (!outcome.retry) return outcome;
    if (outcome.retry === 'credit') skipCredits = true;
  }
  throw new Error('confirmBooking: booking state kept changing');
}

async function attemptConfirm(env, bookingId, {
  provider = null, paymentRef = null, paymentIntent = null, subscriptionId = null,
  payment = null, now = nowIso(), skipCredits = false,
}) {
  const booking = await env.DB.prepare(
    `SELECT id, user_id, child_id, kind, status, expires_at, credit_cents, voucher_code
     FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return { ok: false, error: 'not_found' };

  const ledger = payment ? [paymentInsertStatement(env, { ...payment, bookingId, now })] : [];
  const refs = env.DB.prepare(
    `UPDATE bookings SET payment_provider = COALESCE(?2, payment_provider),
            payment_ref = COALESCE(?3, payment_ref), payment_intent = COALESCE(?4, payment_intent),
            stripe_subscription_id = COALESCE(?5, stripe_subscription_id)
     WHERE id = ?1`,
  ).bind(bookingId, provider, paymentRef, paymentIntent, subscriptionId);
  const recompute = recomputeStatement(env, bookingId);

  if (booking.status === 'confirmed') {
    await env.DB.batch([refs, creditAppliedStatement(env, bookingId, now), ...ledger, recompute]);
    return { ok: true, status: 'confirmed', newlyConfirmed: false, reconfirmed: false, creditShortfall: false };
  }

  if (booking.status === 'cancelled') {
    if (!payment) return { ok: false, error: 'cancelled' };
    await env.DB.batch([refs, ...ledger, flagStatement(env, bookingId, 'paid_after_cancel'), recompute]);
    logEvent('payment_after_cancel', { booking_id: bookingId.slice(0, 8) });
    return { ok: false, error: 'cancelled', flagged: 'paid_after_cancel' };
  }

  const holdLive = booking.status === 'pending' && Boolean(booking.expires_at) && booking.expires_at > now;
  const flip = env.DB.prepare(
    `UPDATE bookings SET status = 'confirmed', payment_provider = COALESCE(?2, payment_provider),
            payment_ref = COALESCE(?3, payment_ref), payment_intent = COALESCE(?4, payment_intent),
            stripe_subscription_id = COALESCE(?5, stripe_subscription_id)
     WHERE id = ?1 AND status IN ('pending', 'expired')`,
  ).bind(bookingId, provider, paymentRef, paymentIntent, subscriptionId);
  let before = [];
  let creditShortfall = false;
  let creditApplied = null; // null = the booking's full credit_cents
  if (!holdLive) {
    // D6: the hold lapsed before the payment landed — re-take every seat.
    const notYet = `(SELECT status FROM bookings WHERE id = ?1) IN ('pending', 'expired')`;
    const rows = (await env.DB.prepare(
      `SELECT bs.session_id FROM booking_sessions bs JOIN class_sessions cs ON cs.id = bs.session_id
       WHERE bs.booking_id = ?1 AND bs.status = 'booked' AND cs.status = 'scheduled' AND cs.starts_at > ?2`,
    ).bind(bookingId, now).all()).results || [];
    for (const row of rows) {
      before.push(...txnGuard(env,
        `NOT ${notYet}
         OR ((SELECT capacity FROM class_sessions WHERE id = ?2) > ${heldSeatsSql('?2', '?3', { excludeBooking: '?1' })}
             AND NOT ${childInSessionSql('?2', '?4', '?3', '?1')})`,
        [bookingId, row.session_id, now, booking.child_id], 'seat'));
    }
    // An expired booking gave its credit and voucher use back; take them again.
    if (booking.credit_cents > 0 && booking.status === 'expired') {
      let creditCents = 0;
      if (!skipCredits) {
        const credits = await availableCredits(env, booking.user_id, booking.child_id, now);
        const applied = applyCredits(credits, booking.credit_cents);
        creditCents = applied.creditCents;
        before.push(...creditRedemptionStatements(env, {
          bookingId, userId: booking.user_id, childId: booking.child_id,
          allocations: applied.allocations, now, whenStatusIn: ['expired'],
        }));
      }
      creditShortfall = creditCents < booking.credit_cents;
      creditApplied = creditCents; // the ledger records only what was re-taken
    }
    if (booking.voucher_code) {
      before.push(...voucherUseStatements(env, booking.voucher_code, {
        bookingId, now, whenStatusIn: ['expired'], enforceLimits: false,
      }));
    }
  }

  const after = [
    ...txnGuard(env, `(SELECT status FROM bookings WHERE id = ?1) = 'confirmed'`, [bookingId], 'state'),
    waitlistBookedStatement(env, bookingId, now),
    creditAppliedStatement(env, bookingId, now, creditApplied),
    ...ledger,
    ...(creditShortfall ? [flagStatement(env, bookingId, 'credit_shortfall', { overwrite: false })] : []),
    recompute,
  ];
  const statements = [...before, flip, ...after];
  try {
    const results = await env.DB.batch(statements);
    const newlyConfirmed = results[before.length].meta.changes > 0;
    if (newlyConfirmed) {
      logEvent('booking_confirmed', {
        booking_id: bookingId.slice(0, 8), provider: provider || 'none', reconfirmed: !holdLive,
      });
    }
    return {
      ok: true, status: 'confirmed', newlyConfirmed, reconfirmed: newlyConfirmed && !holdLive, creditShortfall,
    };
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    if (holdLive) return { retry: 'state' }; // swept or cancelled meanwhile: reload
    if (await seatConflict(env, booking, now)) {
      // The seats are gone: keep the money on record, never oversell.
      await env.DB.batch([
        ...expiryStatements(env, bookingId),
        refs, ...ledger, flagStatement(env, bookingId, 'paid_no_seat'), recompute,
      ]);
      logEvent('paid_no_seat', { booking_id: bookingId.slice(0, 8) });
      return { ok: false, error: 'paid_no_seat', flagged: 'paid_no_seat' };
    }
    if (!skipCredits && booking.credit_cents > 0 && booking.status === 'expired') return { retry: 'credit' };
    return { retry: 'state' };
  }
}

// --- Ending a booking --------------------------------------------------------

async function tryExpireCheckout(env, checkoutRef) {
  try {
    await getPaymentsDriver(env).expireCheckout(checkoutRef);
    return true;
  } catch (err) {
    logError('checkout_expire_failed', err, {});
    return false;
  }
}

// Expire a pending booking now (seats released; its credit redemptions and
// voucher use are given back in the same batch). Returns true if it changed.
export async function expireBooking(env, bookingId) {
  const results = await env.DB.batch(expiryStatements(env, bookingId));
  const changed = results[results.length - 1].meta.changes > 0;
  if (changed) logEvent('booking_expired', { booking_id: bookingId.slice(0, 8) });
  return changed;
}

// Forget an instalment plan that was chosen for a checkout which is now over
// without the plan starting (no subscription): the booking goes back to "pay
// in full", so a later offline payment or a fresh Pay now is never treated as
// a plan (recomputeBooking would otherwise report plan_* statuses). Only
// while the booking is still on `paymentRef` (null once detached) — a newer
// checkout attached meanwhile keeps its own choice — and never once confirmed.
export function forgetPlanChoiceStatement(env, bookingId, paymentRef) {
  return env.DB.prepare(
    `UPDATE bookings SET payment_method = 'full', plan_instalments = NULL, plan_instalment_cents = NULL,
            plan_interval = NULL, plan_next_charge_at = NULL
     WHERE id = ?1 AND status IN ('pending', 'expired') AND payment_ref IS ?2
       AND payment_method = 'plan' AND stripe_subscription_id IS NULL`,
  ).bind(bookingId, paymentRef ?? null);
}

// The parent left (or Stripe expired) a hosted checkout — the caller knows it
// can no longer take a payment. A checkout hold is released; a longer
// pay-later hold keeps its seats and just forgets the abandoned checkout.
// Either way an instalment plan chosen for that checkout is forgotten.
// Ignored when a different checkout is now attached.
// Returns 'expired' | 'detached' | 'noop'.
export async function abandonCheckout(env, bookingId, checkoutRef = null) {
  const booking = await env.DB.prepare(
    `SELECT id, status, payment_ref, created_at, expires_at FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking || booking.status !== 'pending') return 'noop';
  if (checkoutRef && booking.payment_ref && booking.payment_ref !== checkoutRef) return 'noop';
  if (isCheckoutHold(booking)) {
    const statements = expiryStatements(env, bookingId);
    const results = await env.DB.batch([...statements, forgetPlanChoiceStatement(env, bookingId, booking.payment_ref)]);
    const changed = results[statements.length - 1].meta.changes > 0;
    if (changed) logEvent('booking_expired', { booking_id: bookingId.slice(0, 8) });
    return changed ? 'expired' : 'noop';
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET payment_ref = NULL WHERE id = ?1 AND status = 'pending' AND payment_ref IS ?2`,
    ).bind(bookingId, booking.payment_ref),
    forgetPlanChoiceStatement(env, bookingId, null),
  ]);
  return 'detached';
}

// Cancel a pending or confirmed booking (owner action; parents cannot cancel
// at launch). Its booking_sessions rows stop holding seats without being
// touched. A pending booking's live Stripe checkout is expired first (so it
// can no longer be paid) and its credits/voucher use are given back; a
// confirmed booking keeps its redemptions (refunds/credits are the owner's
// call). An instalment plan's subscription is stopped so no further
// instalments are taken (and its end recorded: plan_ended_at).
//
// A checkout that cannot be expired is asked about (review finding 11): if
// the family has just paid, nothing is cancelled — error 'paid', and the
// caller confirms the booking through Check with Stripe instead (cancelling
// would leave the payment, and an instalment plan's subscription, running
// against a cancelled booking). If Stripe cannot say, nothing is cancelled
// either — error 'checkout_open' (try again).
// Returns { ok, error?, checkoutExpired, subscriptionStopped }.
export async function cancelBooking(env, bookingId, { by = 'system', reason = '', now = nowIso(), stopPayments = true } = {}) {
  const booking = await env.DB.prepare(
    `SELECT id, status, payment_ref, stripe_subscription_id, payment_status, plan_ended_at FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return { ok: false, error: 'not_found' };
  if (booking.status !== 'pending' && booking.status !== 'confirmed') return { ok: false, error: booking.status };

  let checkoutExpired = null;
  if (stopPayments && booking.status === 'pending' && booking.payment_ref) {
    checkoutExpired = await tryExpireCheckout(env, booking.payment_ref);
    if (!checkoutExpired) {
      let checkout = null;
      try {
        checkout = await getPaymentsDriver(env).retrieveCheckout(booking.payment_ref);
      } catch (err) {
        logError('checkout_retrieve_failed', err, { booking_id: bookingId.slice(0, 8) });
      }
      if (checkout && checkout.status === 'complete') {
        logEvent('cancel_refused_paid', { booking_id: bookingId.slice(0, 8) });
        return { ok: false, error: 'paid', checkoutExpired: false, subscriptionStopped: null };
      }
      if (!checkout || checkout.status !== 'expired') {
        return { ok: false, error: 'checkout_open', checkoutExpired: false, subscriptionStopped: null };
      }
    }
  }

  const results = await env.DB.batch([
    ...reverseRedemptionStatements(env, bookingId, { whenStatusIn: ['pending'] }),
    ...voucherReleaseStatements(env, bookingId, { whenStatusIn: ['pending'] }),
    env.DB.prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?2, cancelled_by = ?3, cancel_reason = ?4,
              plan_next_charge_at = NULL
       WHERE id = ?1 AND status IN ('pending', 'confirmed')`,
    ).bind(bookingId, now, String(by), String(reason || '').slice(0, 500)),
  ]);
  const changed = results[results.length - 1].meta.changes > 0;
  if (!changed) return { ok: false, error: 'state_changed', checkoutExpired, subscriptionStopped: null };

  let subscriptionStopped = null;
  if (stopPayments && booking.stripe_subscription_id && !booking.plan_ended_at) {
    subscriptionStopped = await stopSubscription(getPaymentsDriver(env), booking.stripe_subscription_id);
    if (subscriptionStopped) {
      await env.DB.prepare(`UPDATE bookings SET plan_ended_at = COALESCE(plan_ended_at, ?2) WHERE id = ?1`)
        .bind(bookingId, now).run();
    } else {
      logEvent('subscription_not_stopped', { booking_id: bookingId.slice(0, 8) });
    }
  }
  logEvent('booking_cancelled', { booking_id: bookingId.slice(0, 8), by: String(by).slice(0, 8) });
  return { ok: true, checkoutExpired, subscriptionStopped };
}

// Lapse pending bookings whose hold has passed (all, or one account's),
// giving back their credit redemptions and voucher uses in the same atomic
// batch. Read paths already ignore lapsed holds; this keeps credits and
// voucher counts right. Returns the number of bookings expired.
export async function sweepExpiredBookings(env, { now = nowIso(), userId = null } = {}) {
  const userClause = userId ? 'AND lb.user_id = ?2' : '';
  const binds = userId ? [now, userId] : [now];
  const probe = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings lb WHERE lb.status = 'pending' AND lb.expires_at <= ?1 ${userClause}`,
  ).bind(...binds).first();
  if (!probe.n) return 0;

  const lapsed = `SELECT lb.id FROM bookings lb WHERE lb.status = 'pending' AND lb.expires_at <= ?1 ${userClause}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE credits
       SET remaining_cents = remaining_cents + (SELECT COALESCE(SUM(cr.amount_cents), 0) FROM credit_redemptions cr
                                                WHERE cr.credit_id = credits.id AND cr.booking_id IN (${lapsed}))
       WHERE id IN (SELECT cr.credit_id FROM credit_redemptions cr WHERE cr.booking_id IN (${lapsed}))`,
    ).bind(...binds),
    env.DB.prepare(`DELETE FROM credit_redemptions WHERE booking_id IN (${lapsed})`).bind(...binds),
    env.DB.prepare(
      `UPDATE vouchers
       SET uses = MAX(0, uses - (SELECT COUNT(*) FROM bookings vb
                                 WHERE vb.voucher_code = vouchers.code AND vb.id IN (${lapsed})))
       WHERE code IN (SELECT vb.voucher_code FROM bookings vb WHERE vb.id IN (${lapsed}))`,
    ).bind(...binds),
    env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE id IN (${lapsed})`).bind(...binds),
  ]);
  const count = results[results.length - 1].meta.changes;
  if (count > 0) logEvent('bookings_swept', { count });
  return count;
}

// --- Reading bookings --------------------------------------------------------

// Columns safe to show the booking's own family (no admin notes).
const PARENT_BOOKING_COLUMNS = `b.id, b.user_id, b.child_id, b.kind, b.term_id, b.status,
  b.list_amount_cents, b.discount_cents, b.voucher_code, b.credit_cents, b.amount_cents, b.paid_cents,
  b.currency, b.payment_method, b.payment_status, b.payment_provider, b.payment_ref,
  b.stripe_subscription_id, b.plan_instalments, b.plan_instalment_cents, b.plan_interval,
  b.plan_next_charge_at, b.paid_at, b.waiver_version, b.waiver_accepted_at, b.photo_consent_snapshot,
  b.purchase_tracked_at, b.capi_sent, b.needs_attention, b.created_at, b.expires_at, b.cancelled_at`;

async function bookingSessions(env, bookingId) {
  const rows = await env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.duration_mins, cs.casual_price_cents, cs.status AS session_status,
            bs.status, bs.attendance, bs.transferred_to_session_id, cl.name AS class_name, cl.venue
     FROM booking_sessions bs
     JOIN class_sessions cs ON cs.id = bs.session_id
     JOIN classes cl ON cl.id = cs.class_id
     WHERE bs.booking_id = ?1
     ORDER BY cs.starts_at`,
  ).bind(bookingId).all();
  return rows.results || [];
}

// A booking with child, term and sessions, visible ONLY to the owning
// account. Missing and not-owned ids return the same null (no cross-account
// disclosure, CWE-639 / API1 BOLA).
export async function getOwnedBooking(env, bookingId, userId) {
  const booking = await env.DB.prepare(
    `SELECT ${PARENT_BOOKING_COLUMNS}, c.name AS child_name, t.name AS term_name, tc.name AS class_name
     FROM bookings b
     JOIN children c ON c.id = b.child_id
     LEFT JOIN terms t ON t.id = b.term_id
     LEFT JOIN classes tc ON tc.id = t.class_id
     WHERE b.id = ?1 AND b.user_id = ?2`,
  ).bind(bookingId, userId).first();
  if (!booking) return null;
  return { ...booking, sessions: await bookingSessions(env, bookingId) };
}

// Admin view of any booking: every column plus parent, child, term, sessions.
export async function getBooking(env, bookingId) {
  const booking = await env.DB.prepare(
    `SELECT b.*, u.email AS parent_email, u.name AS parent_name, u.phone AS parent_phone,
            c.name AS child_name, c.dob AS child_dob, t.name AS term_name, tc.name AS class_name
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN children c ON c.id = b.child_id
     LEFT JOIN terms t ON t.id = b.term_id
     LEFT JOIN classes tc ON tc.id = t.class_id
     WHERE b.id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return null;
  return { ...booking, sessions: await bookingSessions(env, bookingId) };
}

// An account's bookings for its dashboard, newest first.
export async function listUserBookings(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT ${PARENT_BOOKING_COLUMNS}, c.name AS child_name, t.name AS term_name, tc.name AS class_name,
            (SELECT GROUP_CONCAT(cs.starts_at, '|') FROM booking_sessions bs
             JOIN class_sessions cs ON cs.id = bs.session_id
             WHERE bs.booking_id = b.id AND bs.status = 'booked') AS session_starts
     FROM bookings b
     JOIN children c ON c.id = b.child_id
     LEFT JOIN terms t ON t.id = b.term_id
     LEFT JOIN classes tc ON tc.id = t.class_id
     WHERE b.user_id = ?1
     ORDER BY b.created_at DESC
     LIMIT 100`,
  ).bind(userId).all();
  return rows.results || [];
}

// A pending booking past its hold is shown (and treated) as expired even
// before the sweep has updated the row.
export function effectiveStatus(booking, now = nowIso()) {
  if (booking.status === 'pending' && booking.expires_at && booking.expires_at <= now) return 'expired';
  return booking.status;
}

// Everything needed to email the family or report the conversion: contact
// details, child, term/class, money/plan fields and booked sessions. Internal
// — never rendered for another account.
export async function loadBookingForNotification(env, bookingId) {
  const booking = await env.DB.prepare(
    `SELECT ${PARENT_BOOKING_COLUMNS}, u.email, u.phone, u.name AS parent_name,
            c.name AS child_name, t.name AS term_name, tc.name AS class_name
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN children c ON c.id = b.child_id
     LEFT JOIN terms t ON t.id = b.term_id
     LEFT JOIN classes tc ON tc.id = t.class_id
     WHERE b.id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return null;
  const sessions = (await bookingSessions(env, bookingId)).filter((s) => s.status === 'booked');
  return { ...booking, sessions };
}

// Mark the pixel Purchase as rendered. True only for the one request that
// flips it (D12: Purchase fires at most once per booking).
export async function markPurchaseTracked(env, bookingId, now = nowIso()) {
  const result = await env.DB.prepare(
    `UPDATE bookings SET purchase_tracked_at = ?2
     WHERE id = ?1 AND status = 'confirmed' AND purchase_tracked_at IS NULL`,
  ).bind(bookingId, now).run();
  return result.meta.changes > 0;
}
