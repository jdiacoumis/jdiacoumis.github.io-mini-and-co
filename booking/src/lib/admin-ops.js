// Admin operations (Phase 2B — designs D1, D2, D5, D6, D8, D9): the SQL and
// helpers behind the owner's admin pages, kept out of the route modules so
// they can be unit-tested against a real D1.
//
//   * Term planning (pure): weekly class dates from a start date and a length
//     (weeks, or a last class date), skipping holidays; each session converted
//     from Sydney wall clock on its own date, so a term spanning a daylight-
//     saving change keeps its local start time; re-run defaults; term names.
//   * The term grid (pure): cell codes from booking_sessions rows, and the
//     ledger-backed payment summary ("Paid", "Plan 3 of 6 · next 12 Feb",
//     "Overdue $56", "Unpaid $168 — pay-later until 12 Feb", "Comp").
//   * Guarded writes: every multi-statement change is ONE env.DB.batch()
//     (atomic) with txn_guards CHECK guards for conditional rollback, and
//     every capacity test uses the single held-seat definition from
//     lib/domain.js (holdsSeatSql / heldSeatsSql): transfers, cancelling one
//     week with a credit, cancelling a session (credits for every affected
//     family), restoring a cancelled booking, attendance, resolving flags.
//   * Reads for the dashboard, Needs attention, customers, credits, vouchers,
//     manual bookings and auto-enrol.
//
// Rows are database rows (snake_case). Money is integer cents; instants are
// UTC ISO strings with second precision; dates are YYYY-MM-DD (Sydney).

import { uuid, nowIso, isoFromMs, isoPlusSeconds, txnGuard, isConstraintError } from './db.js';
import { html, joinHtml, csrfField } from './html.js';
import { logEvent } from './log.js';
import { sydneyToUtc, sydneyFields, formatSydney } from './time.js';
import {
  holdsSeatSql, heldSeatsSql, bookingLiveSql, loadTerm, listTermSessions, prepareBooking,
  createPendingBooking, confirmBooking, formatAud, CHECKOUT_HOLD_MAX_SECS, KIND_LABELS,
  NEEDS_ATTENTION_LABELS, isCheckoutHold, flagStatement,
} from './domain.js';
import {
  issueCreditStatement, creditBalance, ledgerTotals, paymentInsertStatement, recomputeStatement,
} from './ledger.js';
import { planExpectedCents, proRata } from './pricing.js';

const DAY_MS = 86400 * 1000;

export const MAX_TERM_WEEKS = 52;
export const RERUN_GAP_WEEKS = 2;              // re-run: two empty weeks between terms
export const PAY_LATER_HOLD_SECS = 7 * 86400;  // manual pay-later / auto-enrol fallback hold
export const STALE_CHECKOUT_SECS = 40 * 60;    // D6: pending with a checkout older than this
export const RECENT_CHECKOUT_HOURS = 72;       // ended checkouts worth a "Check with Stripe"

// --- Dates (pure) --------------------------------------------------------------

export function isDateStr(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return false;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return date.getUTCFullYear() === +m[1] && date.getUTCMonth() === +m[2] - 1 && date.getUTCDate() === +m[3];
}

function dateParts(dateStr) {
  return dateStr.split('-').map(Number);
}

// Calendar arithmetic on the date only (no clock, so no DST effects).
export function addDays(dateStr, days) {
  const [y, m, d] = dateParts(dateStr);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(fromDate, toDate) {
  const [y1, m1, d1] = dateParts(fromDate);
  const [y2, m2, d2] = dateParts(toDate);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

// 0 = Sunday … 6 = Saturday (the calendar date's own weekday).
export function dateWeekday(dateStr) {
  const [y, m, d] = dateParts(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// "2027-03-10, 2027-04-14" (commas, spaces or new lines) → sorted unique dates
// plus whatever could not be read.
export function parseDateList(text) {
  const tokens = String(text || '').split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean).slice(0, 60);
  const dates = new Set();
  const invalid = [];
  for (const token of tokens) {
    if (isDateStr(token)) dates.add(token);
    else invalid.push(token);
  }
  return { dates: [...dates].sort(), invalid };
}

// "2027-02-03T09:00" from <input type="datetime-local"> (Sydney) → UTC ISO.
export function datetimeLocalToUtc(value) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(String(value || '').trim());
  return m ? sydneyToUtc(m[1], m[2]) : null;
}

// UTC ISO → "2027-02-03T09:00" for a datetime-local input (Sydney).
export function utcToDatetimeLocal(iso) {
  if (!iso) return '';
  const f = sydneyFields(iso);
  return `${f.date}T${f.time}`;
}

// "12 Feb" in Sydney.
export function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' }).format(date);
}

// Signed dollars ("-12.50", "+5", "30") → integer cents, or null.
export function parseSignedDollarsToCents(value, maxCents = 1000000) {
  const m = /^\s*([+\-−])?\s*\$?\s*(\d{1,5})(?:\.(\d{1,2}))?\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const cents = (+m[2]) * 100 + (m[3] ? +m[3].padEnd(2, '0') : 0);
  if (cents > maxCents) return null;
  return m[1] === '-' || m[1] === '−' ? -cents : cents;
}

// --- Term planning (pure) --------------------------------------------------------

// The weekly class dates of a term: from `startsOn` every 7 days up to the
// last class date (`endsOn`, or start + (weeks − 1) weeks), leaving out the
// holiday dates. "A ten-week term with a holiday" is weeks = 10 → nine
// classes (class-scheduling spec). `weekday` (0–6), when given, must match
// the start date.
// Returns { ok: true, dates, skipped, unusedSkipDates, startsOn, endsOn }
// or { ok: false, error } with error ∈ start_date | start_weekday | end_date |
// weeks | too_long | no_sessions.
export function planTermDates({ startsOn, weeks = null, endsOn = null, skipDates = [], weekday = null }) {
  if (!isDateStr(startsOn)) return { ok: false, error: 'start_date' };
  if (weekday !== null && weekday !== undefined && dateWeekday(startsOn) !== Number(weekday)) {
    return { ok: false, error: 'start_weekday' };
  }
  let last;
  if (endsOn) {
    if (!isDateStr(endsOn) || endsOn < startsOn) return { ok: false, error: 'end_date' };
    if (daysBetween(startsOn, endsOn) > 7 * (MAX_TERM_WEEKS - 1)) return { ok: false, error: 'too_long' };
    last = endsOn;
  } else {
    if (!Number.isInteger(weeks) || weeks < 1) return { ok: false, error: 'weeks' };
    if (weeks > MAX_TERM_WEEKS) return { ok: false, error: 'too_long' };
    last = addDays(startsOn, 7 * (weeks - 1));
  }
  const skip = new Set(skipDates);
  const dates = [];
  const skipped = [];
  for (let date = startsOn; date <= last; date = addDays(date, 7)) {
    (skip.has(date) ? skipped : dates).push(date);
  }
  if (!dates.length) return { ok: false, error: 'no_sessions' };
  return {
    ok: true,
    dates,
    skipped,
    unusedSkipDates: [...skip].filter((d) => !skipped.includes(d)).sort(),
    startsOn: dates[0],
    endsOn: dates[dates.length - 1],
  };
}

// One UTC start instant per class date at the class's Sydney start time —
// converted date by date, so 11:00 stays 11:00 across AEDT/AEST changes.
export function sessionStartsFor(dates, startTime) {
  return dates.map((date) => ({ date, startsAt: sydneyToUtc(date, startTime) }));
}

// "Term 1 2027" → "Term 2 2027"; "Term 4 2027" → "Term 1 2028"; "Term 3" →
// "Term 4"; anything else gets " (next)".
export function nextTermName(name) {
  const text = String(name || '').trim();
  const full = /\bTerm\s+([1-4])\s+(\d{4})\b/i.exec(text);
  if (full) {
    const n = Number(full[1]);
    const year = Number(full[2]);
    const next = n < 4 ? `Term ${n + 1} ${year}` : `Term 1 ${year + 1}`;
    return `${text.slice(0, full.index)}${next}${text.slice(full.index + full[0].length)}`;
  }
  const bare = /\bTerm\s+(\d{1,2})\b/i.exec(text);
  if (bare) return `${text.slice(0, bare.index)}Term ${Number(bare[1]) + 1}${text.slice(bare.index + bare[0].length)}`;
  return `${text || 'New term'} (next)`.slice(0, 100);
}

// Prefill for "Re-run this term": same length, starting RERUN_GAP_WEEKS empty
// weeks after the source's last class (same weekday), opening times moved by
// the same number of days on the Sydney wall clock.
export function rerunDefaults(source, { gapWeeks = RERUN_GAP_WEEKS } = {}) {
  const spanWeeks = Math.floor(daysBetween(source.starts_on, source.ends_on) / 7) + 1;
  const shiftDays = 7 * (spanWeeks + gapWeeks);
  const shift = (iso) => {
    if (!iso) return null;
    const f = sydneyFields(iso);
    return sydneyToUtc(addDays(f.date, shiftDays), f.time);
  };
  return {
    name: nextTermName(source.name),
    startsOn: addDays(source.starts_on, shiftDays),
    weeks: spanWeeks,
    shiftDays,
    returningOpensAt: shift(source.returning_opens_at),
    publicOpensAt: shift(source.public_opens_at),
  };
}

// --- Money (pure) ------------------------------------------------------------

// The per-week value of a booking (D8): what it cost after discounts — money
// plus account credit — over the weeks it covers, rounded down so the credits
// for every week never exceed what was paid.
export function perWeekCreditCents({ amountCents = 0, creditCents = 0, weeks }) {
  if (!Number.isInteger(weeks) || weeks <= 0) return 0;
  return Math.floor(Math.max(0, (amountCents || 0) + (creditCents || 0)) / weeks);
}

// A checkout hold (35 minutes) as opposed to a pay-later hold (days): the
// rule lives in lib/domain.js (re-exported here for the admin pages).
export { isCheckoutHold };

// Money still to collect. `received_cents` is the ledger total without
// refunds (falls back to paid_cents); account credit joins the ledger only at
// confirmation, so a pending booking owes just its money part.
export function owingCents(b) {
  const received = b.received_cents ?? b.paid_cents ?? 0;
  const due = (b.amount_cents || 0) + (b.credit_cents || 0);
  const creditPending = b.status === 'confirmed' ? 0 : (b.credit_cents || 0);
  return Math.max(0, due - creditPending - received);
}

// The payment column (D8), from the booking and its ledger totals
// (received_cents, money_in_cents, instalments_paid).
// Returns { label, owingCents, tone } with tone ∈ paid | plan | overdue |
// unpaid | comp | waiting | ended.
export function paymentSummary(b, now = nowIso()) {
  const owing = owingCents(b);
  const received = b.received_cents ?? b.paid_cents ?? 0;
  if (b.kind === 'complimentary' || b.payment_status === 'waived') return { label: 'Comp', owingCents: 0, tone: 'comp' };
  if (b.status === 'cancelled') {
    return { label: received > 0 ? `Cancelled — ${formatAud(received)} received` : 'Cancelled', owingCents: 0, tone: 'ended' };
  }
  const lapsed = b.status === 'expired' || (b.status === 'pending' && b.expires_at && b.expires_at <= now);
  if (lapsed) {
    return received > 0
      ? { label: `Paid ${formatAud(received)} — no seat`, owingCents: 0, tone: 'overdue' }
      : { label: 'Hold lapsed — not paid', owingCents: 0, tone: 'ended' };
  }
  if (b.status === 'pending') {
    if (b.expires_at && !isCheckoutHold(b)) {
      return { label: `Unpaid ${formatAud(owing)} — pay-later until ${shortDate(b.expires_at)}`, owingCents: owing, tone: 'unpaid' };
    }
    return { label: 'Paying now', owingCents: owing, tone: 'waiting' };
  }
  if (b.payment_method === 'plan') {
    if (owing === 0 || b.payment_status === 'plan_complete') return { label: 'Paid', owingCents: 0, tone: 'paid' };
    if (b.payment_status === 'plan_overdue') {
      const expected = planExpectedCents({
        totalCents: b.amount_cents, n: b.plan_instalments, eachCents: b.plan_instalment_cents,
        interval: b.plan_interval || 'week', anchorIso: b.paid_at, now,
      });
      const behind = Math.max(0, expected - (b.money_in_cents || 0));
      const overdue = Math.min(owing, behind > 0 ? behind : (b.plan_instalment_cents || owing));
      return { label: `Overdue ${formatAud(overdue)}`, owingCents: owing, tone: 'overdue' };
    }
    const next = b.plan_next_charge_at ? ` · next ${shortDate(b.plan_next_charge_at)}` : '';
    return { label: `Plan ${b.instalments_paid || 0} of ${b.plan_instalments || 0}${next}`, owingCents: owing, tone: 'plan' };
  }
  if (owing === 0) return { label: 'Paid', owingCents: 0, tone: 'paid' };
  if (received > 0) return { label: `Part paid — owes ${formatAud(owing)}`, owingCents: owing, tone: 'unpaid' };
  return { label: `Unpaid ${formatAud(owing)}`, owingCents: owing, tone: 'unpaid' };
}

// --- The term grid (pure) ----------------------------------------------------------

export const GRID_CELLS = {
  present: { symbol: '✓', label: 'Present' },
  absent: { symbol: '✗', label: 'Absent' },
  booked: { symbol: '·', label: 'Booked' },
  cancelled: { symbol: '–', label: 'Cancelled' },
  moved: { symbol: '→', label: 'Moved to another class' },
  none: { symbol: '', label: 'Not booked' },
};

// One grid cell from a booking_sessions row (or none) and its session.
export function gridCell(row, session = null) {
  if (!row) return 'none';
  if (row.status === 'transferred_out') return 'moved';
  if (row.status === 'cancelled' || (session && session.status === 'cancelled')) return 'cancelled';
  if (row.attendance === 'present') return 'present';
  if (row.attendance === 'absent') return 'absent';
  return 'booked';
}

// --- Shared SQL ---------------------------------------------------------------

// Ledger totals per booking (D5): received = everything except refunds.
export const LEDGER_TOTALS_JOIN = `LEFT JOIN (
    SELECT booking_id,
           SUM(CASE WHEN kind != 'refund' THEN amount_cents ELSE 0 END) AS received_cents,
           SUM(CASE WHEN kind IN ('checkout', 'instalment', 'offline') THEN amount_cents ELSE 0 END) AS money_in_cents,
           -SUM(CASE WHEN kind = 'refund' THEN amount_cents ELSE 0 END) AS refunded_cents,
           SUM(CASE WHEN kind = 'instalment' THEN 1 ELSE 0 END) AS instalments_paid
    FROM payments GROUP BY booking_id) lt ON lt.booking_id = b.id`;

const LEDGER_COLUMNS = `COALESCE(lt.received_cents, 0) AS received_cents,
  COALESCE(lt.money_in_cents, 0) AS money_in_cents, COALESCE(lt.refunded_cents, 0) AS refunded_cents,
  COALESCE(lt.instalments_paid, 0) AS instalments_paid`;

export const BOOKING_LIST_COLUMNS = `b.id, b.user_id, b.child_id, b.kind, b.term_id, b.status,
  b.list_amount_cents, b.discount_cents, b.voucher_code, b.credit_cents, b.amount_cents, b.paid_cents,
  b.payment_method, b.payment_status, b.payment_provider, b.payment_ref, b.stripe_subscription_id,
  b.plan_instalments, b.plan_instalment_cents, b.plan_interval, b.plan_next_charge_at, b.plan_ended_at, b.paid_at,
  b.needs_attention, b.created_at, b.expires_at, b.cancelled_at, b.cancel_reason,
  u.name AS parent_name, u.email AS parent_email, u.phone AS parent_phone, ch.name AS child_name,
  t.name AS term_name, tc.name AS class_name, ${LEDGER_COLUMNS},
  (SELECT GROUP_CONCAT(cs.starts_at, '|') FROM booking_sessions sbs
     JOIN class_sessions cs ON cs.id = sbs.session_id
     WHERE sbs.booking_id = b.id AND sbs.status = 'booked') AS session_starts`;

export const BOOKING_LIST_FROM = `FROM bookings b
  JOIN users u ON u.id = b.user_id
  JOIN children ch ON ch.id = b.child_id
  LEFT JOIN terms t ON t.id = b.term_id
  LEFT JOIN classes tc ON tc.id = t.class_id
  ${LEDGER_TOTALS_JOIN}`;

// Does this child hold a seat in the session through any live booking (other
// than `excludeBookingParam`)? Built on the one held-seat definition.
export function childInSessionSql(sessionIdExpr, childParam, nowParam, excludeBookingParam = null) {
  return `EXISTS (SELECT 1 FROM booking_sessions xbs JOIN bookings xb ON xb.id = xbs.booking_id
                  WHERE xbs.session_id = ${sessionIdExpr} AND xb.child_id = ${childParam}
                    ${excludeBookingParam ? `AND xb.id != ${excludeBookingParam}` : ''}
                    AND ${holdsSeatSql('xbs', 'xb', nowParam)})`;
}

// Bookings with filters (all optional): termId, status, paymentStatus, kind,
// attention (flagged only), owing (only money still to collect).
export async function listBookings(env, {
  termId = null, status = null, paymentStatus = null, kind = null, attention = false, userId = null, limit = 500,
} = {}) {
  const where = [];
  const binds = [];
  const add = (sql, value) => {
    binds.push(value);
    where.push(sql.replace('?', `?${binds.length}`));
  };
  if (termId) add('b.term_id = ?', termId);
  if (status) add('b.status = ?', status);
  if (paymentStatus) add('b.payment_status = ?', paymentStatus);
  if (kind) add('b.kind = ?', kind);
  if (userId) add('b.user_id = ?', userId);
  if (attention) where.push('b.needs_attention IS NOT NULL');
  binds.push(Math.max(1, Math.min(1000, limit)));
  const rows = await env.DB.prepare(
    `SELECT ${BOOKING_LIST_COLUMNS} ${BOOKING_LIST_FROM}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.created_at DESC
     LIMIT ?${binds.length}`,
  ).bind(...binds).all();
  return rows.results || [];
}

export async function loadBookingRow(env, bookingId) {
  return env.DB.prepare(`SELECT ${BOOKING_LIST_COLUMNS} ${BOOKING_LIST_FROM} WHERE b.id = ?1`).bind(bookingId).first();
}

// Every ledger row of a booking, oldest first, with who recorded it.
export async function listLedger(env, bookingId) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.kind, p.amount_cents, p.provider, p.provider_ref, p.method, p.note, p.paid_at, p.created_at,
            p.recorded_by, u.email AS recorded_by_email
     FROM payments p LEFT JOIN users u ON u.id = p.recorded_by
     WHERE p.booking_id = ?1 ORDER BY p.paid_at, p.created_at`,
  ).bind(bookingId).all();
  return rows.results || [];
}

// Weeks a booking covers (D8 per-week rate): its rows minus the moved-out
// ones (a transfer swaps one row for another, so the count is stable).
export async function bookingWeeks(env, bookingId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS weeks FROM booking_sessions WHERE booking_id = ?1 AND status != 'transferred_out'`,
  ).bind(bookingId).first();
  return row ? row.weeks : 0;
}

// Booking sessions with class and attendance detail, in date order.
export async function listBookingRows(env, bookingId) {
  const rows = await env.DB.prepare(
    `SELECT bs.session_id, bs.status, bs.attendance, bs.attendance_marked_at, bs.transferred_to_session_id,
            bs.changed_at, cs.starts_at, cs.status AS session_status, cs.term_id, c.name AS class_name,
            tcs.starts_at AS transferred_to_starts_at, tc.name AS transferred_to_class_name
     FROM booking_sessions bs
     JOIN class_sessions cs ON cs.id = bs.session_id
     JOIN classes c ON c.id = cs.class_id
     LEFT JOIN class_sessions tcs ON tcs.id = bs.transferred_to_session_id
     LEFT JOIN classes tc ON tc.id = tcs.class_id
     WHERE bs.booking_id = ?1
     ORDER BY cs.starts_at`,
  ).bind(bookingId).all();
  return rows.results || [];
}

// --- Terms ---------------------------------------------------------------------

// Insert terms and their sessions in one atomic batch. Each spec:
//   { id?, classId, name, startsOn, endsOn, termPriceCents, casualPriceCents,
//     trialPriceCents, returningPriceCents, returningOpensAt, publicOpensAt,
//     previousTermId, planInstalments, planInterval, status,
//     sessions: [{ startsAt }], durationMins, capacity }
// Returns the term ids in order.
export async function createTermsWithSessions(env, specs, { now = nowIso() } = {}) {
  const statements = [];
  const ids = [];
  for (const spec of specs) {
    const termId = spec.id || uuid();
    ids.push(termId);
    statements.push(env.DB.prepare(
      `INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents,
                          trial_price_cents, returning_price_cents, returning_opens_at, public_opens_at,
                          previous_term_id, plan_instalments, plan_interval, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(termId, spec.classId, spec.name, spec.startsOn, spec.endsOn, spec.termPriceCents,
      spec.casualPriceCents, spec.trialPriceCents ?? null, spec.returningPriceCents ?? null,
      spec.returningOpensAt ?? null, spec.publicOpensAt ?? null, spec.previousTermId ?? null,
      spec.planInstalments ?? 0, spec.planInterval || 'week', spec.status || 'draft', now));
    for (const session of spec.sessions) {
      statements.push(env.DB.prepare(
        `INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents,
                                     status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8)`,
      ).bind(uuid(), spec.classId, termId, session.startsAt, spec.durationMins, spec.capacity,
        spec.casualPriceCents, now));
    }
  }
  await env.DB.batch(statements);
  logEvent('terms_created', { count: ids.length, sessions: specs.reduce((n, s) => n + s.sessions.length, 0) });
  return ids;
}

// Keep terms.starts_on/ends_on equal to the first/last session date (Sydney)
// after weeks are added, removed or moved.
export async function syncTermDates(env, termId) {
  const row = await env.DB.prepare(
    `SELECT MIN(starts_at) AS first, MAX(starts_at) AS last FROM class_sessions WHERE term_id = ?1`,
  ).bind(termId).first();
  if (!row || !row.first) return;
  await env.DB.prepare(`UPDATE terms SET starts_on = ?2, ends_on = ?3 WHERE id = ?1`)
    .bind(termId, sydneyFields(row.first).date, sydneyFields(row.last).date).run();
}

// Is a term name already used by another term of this class?
export async function termNameTaken(env, classId, name, exceptTermId = null) {
  const row = await env.DB.prepare(
    `SELECT 1 AS yes FROM terms WHERE class_id = ?1 AND lower(trim(name)) = lower(trim(?2)) AND id != COALESCE(?3, '')`,
  ).bind(classId, name, exceptTermId).first();
  return Boolean(row);
}

// The terms list: every term with its class, scheduled/upcoming sessions,
// live bookings, the fewest seats left in an upcoming session, and waitlist.
export async function listTermsOverview(env, now = nowIso()) {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.class_id, t.name, t.status, t.starts_on, t.ends_on, t.term_price_cents, t.casual_price_cents,
            t.returning_price_cents, t.public_opens_at, t.returning_opens_at, t.previous_term_id, t.plan_instalments,
            c.name AS class_name, c.active AS class_active,
            (SELECT COUNT(*) FROM class_sessions s WHERE s.term_id = t.id AND s.status = 'scheduled') AS session_count,
            (SELECT COUNT(*) FROM class_sessions s WHERE s.term_id = t.id AND s.status = 'scheduled'
               AND s.starts_at > ?1) AS upcoming_count,
            (SELECT COUNT(DISTINCT lb.id) FROM bookings lb
               JOIN booking_sessions lbs ON lbs.booking_id = lb.id
               JOIN class_sessions ls ON ls.id = lbs.session_id
               WHERE ls.term_id = t.id AND ${holdsSeatSql('lbs', 'lb', '?1')}) AS live_bookings,
            (SELECT MIN(s.capacity - ${heldSeatsSql('s', '?1')}) FROM class_sessions s
               WHERE s.term_id = t.id AND s.status = 'scheduled' AND s.starts_at > ?1) AS min_seats_left,
            (SELECT COUNT(*) FROM waitlist w WHERE w.term_id = t.id AND w.status IN ('waiting', 'offered')) AS waiting
     FROM terms t JOIN classes c ON c.id = t.class_id
     ORDER BY c.active DESC, c.name, t.starts_on DESC`,
  ).bind(now).all();
  return rows.results || [];
}

// Everything the term grid needs: the term, its sessions (seats per
// session), its families (live bookings with a booked week in the term, with
// ledger totals) and every booking_sessions row of the term.
export async function loadTermGrid(env, termId, now = nowIso()) {
  const term = await loadTerm(env, termId);
  if (!term) return null;
  const sessions = await listTermSessions(env, termId, { now });
  const families = (await env.DB.prepare(
    `SELECT ${BOOKING_LIST_COLUMNS} ${BOOKING_LIST_FROM}
     WHERE ${bookingLiveSql('b', '?2')}
       AND EXISTS (SELECT 1 FROM booking_sessions gbs JOIN class_sessions gcs ON gcs.id = gbs.session_id
                   WHERE gbs.booking_id = b.id AND gcs.term_id = ?1 AND gbs.status = 'booked')
     ORDER BY ch.name COLLATE NOCASE, u.name COLLATE NOCASE`,
  ).bind(termId, now).all()).results || [];
  const cellRows = (await env.DB.prepare(
    `SELECT bs.booking_id, bs.session_id, bs.status, bs.attendance
     FROM booking_sessions bs JOIN class_sessions cs ON cs.id = bs.session_id
     WHERE cs.term_id = ?1`,
  ).bind(termId).all()).results || [];
  const rowsByBooking = new Map();
  for (const r of cellRows) {
    if (!rowsByBooking.has(r.booking_id)) rowsByBooking.set(r.booking_id, new Map());
    rowsByBooking.get(r.booking_id).set(r.session_id, r);
  }
  const grid = families.map((b) => ({
    booking: b,
    payment: paymentSummary(b, now),
    cells: sessions.map((s) => gridCell(rowsByBooking.get(b.id)?.get(s.id) || null, s)),
  }));
  return { term, sessions, grid };
}

// --- Sessions ---------------------------------------------------------------

export async function loadSession(env, sessionId, now = nowIso()) {
  return env.DB.prepare(
    `SELECT cs.id, cs.class_id, cs.term_id, cs.starts_at, cs.duration_mins, cs.capacity, cs.casual_price_cents,
            cs.status, cs.cancelled_reason, cs.cancelled_at, c.name AS class_name, c.venue, c.active AS class_active,
            t.name AS term_name, ${heldSeatsSql('cs', '?2')} AS seats_held
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id LEFT JOIN terms t ON t.id = cs.term_id
     WHERE cs.id = ?1`,
  ).bind(sessionId, now).first();
}

// Families holding a seat in a session, with what cancelling it would credit
// them: confirmed bookings get the per-week value of their booking (term
// weeks and casual/trial classes alike — for one class that is what they
// paid); pending holds and complimentary places get none.
export async function sessionCancellationPlan(env, sessionId, now = nowIso()) {
  const rows = (await env.DB.prepare(
    `SELECT b.id AS booking_id, b.user_id, b.child_id, b.kind, b.status, b.amount_cents, b.credit_cents,
            u.name AS parent_name, u.email AS parent_email, ch.name AS child_name,
            (SELECT COUNT(*) FROM booking_sessions w WHERE w.booking_id = b.id AND w.status != 'transferred_out') AS weeks
     FROM booking_sessions bs
     JOIN bookings b ON b.id = bs.booking_id
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     WHERE bs.session_id = ?1 AND ${holdsSeatSql('bs', 'b', '?2')}
     ORDER BY ch.name COLLATE NOCASE`,
  ).bind(sessionId, now).all()).results || [];
  return rows.map((r) => ({
    ...r,
    creditCents: r.status === 'confirmed' && r.kind !== 'complimentary'
      ? perWeekCreditCents({ amountCents: r.amount_cents, creditCents: r.credit_cents, weeks: r.weeks })
      : 0,
  }));
}

// Cancel a session (owner action, D8): in ONE batch the session is marked
// cancelled with the reason, every seat-holding row in it becomes
// 'cancelled', and each confirmed family gets its credit (source = the
// booking and the session). Guards roll everything back if the session or a
// row changed since it was read; the caller retries. The family notices are
// sent afterwards by notifySessionCancelled (routes/admin.js).
// Returns { ok, affected: [...plan rows], creditsIssued, creditCents } or
// { ok: false, error: not_found | not_scheduled | busy }.
export async function cancelSessionWithCredits(env, sessionId, { reason, by, now = nowIso() }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await loadSession(env, sessionId, now);
    if (!session) return { ok: false, error: 'not_found' };
    if (session.status !== 'scheduled') return { ok: false, error: 'not_scheduled' };
    const plan = await sessionCancellationPlan(env, sessionId, now);
    const when = formatSydney(session.starts_at, 'date');
    const creditReason = `Class cancelled — ${session.class_name}, ${when}${reason ? ` (${reason})` : ''}`.slice(0, 300);
    const statements = [
      ...txnGuard(env, `(SELECT status FROM class_sessions WHERE id = ?1) = 'scheduled'`, [sessionId], 'session'),
      // Nobody may have taken a seat since the plan was read (they would
      // keep a place in a cancelled class with no credit): re-read instead.
      ...txnGuard(env,
        `(SELECT COUNT(*) FROM booking_sessions cbs JOIN bookings cb ON cb.id = cbs.booking_id
          WHERE cbs.session_id = ?1 AND ${holdsSeatSql('cbs', 'cb', '?2')}) = ?3`,
        [sessionId, now, plan.length], 'newcomer'),
      env.DB.prepare(
        `UPDATE class_sessions SET status = 'cancelled', cancelled_reason = ?2, cancelled_at = ?3
         WHERE id = ?1 AND status = 'scheduled'`,
      ).bind(sessionId, String(reason || '').slice(0, 500), now),
    ];
    for (const row of plan) {
      statements.push(
        ...txnGuard(env,
          `EXISTS (SELECT 1 FROM booking_sessions gbs JOIN bookings gb ON gb.id = gbs.booking_id
                   WHERE gbs.booking_id = ?1 AND gbs.session_id = ?2 AND ${holdsSeatSql('gbs', 'gb', '?3')}
                     AND gb.status = ?4)`,
          [row.booking_id, sessionId, now, row.status], 'row'),
        env.DB.prepare(
          `UPDATE booking_sessions SET status = 'cancelled', changed_at = ?3
           WHERE booking_id = ?1 AND session_id = ?2 AND status = 'booked'`,
        ).bind(row.booking_id, sessionId, now),
      );
      if (row.creditCents > 0) {
        statements.push(issueCreditStatement(env, {
          userId: row.user_id, childId: row.child_id, amountCents: row.creditCents, reason: creditReason,
          sourceBookingId: row.booking_id, sourceSessionId: sessionId, issuedBy: by, now,
        }).statement);
      }
    }
    try {
      await env.DB.batch(statements);
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      continue; // something changed underneath — re-read and try again
    }
    const credited = plan.filter((r) => r.creditCents > 0);
    logEvent('session_cancelled', {
      session_id: sessionId.slice(0, 8), families: plan.length, credits: credited.length,
      by: String(by || '').slice(0, 8),
    });
    return {
      ok: true,
      affected: plan,
      creditsIssued: credited.length,
      creditCents: credited.reduce((sum, r) => sum + r.creditCents, 0),
    };
  }
  return { ok: false, error: 'busy' };
}

// Put a cancelled session back on the schedule. Rows cancelled with it and
// credits issued for it are NOT undone (the owner decides per family).
export async function reinstateSession(env, sessionId) {
  const result = await env.DB.prepare(
    `UPDATE class_sessions SET status = 'scheduled', cancelled_reason = '', cancelled_at = NULL
     WHERE id = ?1 AND status = 'cancelled'`,
  ).bind(sessionId).run();
  return result.meta.changes > 0;
}

// Remove a week from a term — only a session no booking has ever touched
// (no booking_sessions rows, no credits): one guarded DELETE.
export async function removeTermSession(env, termId, sessionId) {
  const result = await env.DB.prepare(
    `DELETE FROM class_sessions
     WHERE id = ?1 AND term_id = ?2
       AND NOT EXISTS (SELECT 1 FROM booking_sessions WHERE session_id = ?1)
       AND NOT EXISTS (SELECT 1 FROM credits WHERE source_session_id = ?1)`,
  ).bind(sessionId, termId).run();
  return result.meta.changes > 0;
}

export async function sessionHasBookings(env, sessionId) {
  const row = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM booking_sessions WHERE session_id = ?1)
            OR EXISTS (SELECT 1 FROM credits WHERE source_session_id = ?1) AS used`,
  ).bind(sessionId).first();
  return Boolean(row && row.used);
}

// --- Roster and attendance -------------------------------------------------------

// Seat holders of a session (the held-seat definition) with the booking
// snapshot AND the child's current profile, ledger totals and attendance.
export async function loadRoster(env, sessionId, now = nowIso()) {
  const rows = await env.DB.prepare(
    `SELECT b.id AS booking_id, b.id, b.kind, b.status, b.payment_status, b.payment_method, b.payment_provider,
            b.amount_cents, b.credit_cents, b.paid_cents, b.paid_at, b.created_at, b.expires_at,
            b.plan_instalments, b.plan_instalment_cents, b.plan_interval, b.plan_next_charge_at,
            b.photo_consent_snapshot, b.medical_notes_snapshot, b.needs_attention,
            bs.attendance, bs.attendance_marked_at, bs.attendance_marked_by,
            u.name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
            ch.id AS child_id, ch.name AS child_name, ch.dob AS child_dob,
            ch.photo_consent AS child_photo_consent, ch.medical_notes AS child_medical_notes,
            mu.email AS marked_by_email, mu.name AS marked_by_name, ${LEDGER_COLUMNS}
     FROM booking_sessions bs
     JOIN bookings b ON b.id = bs.booking_id
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     LEFT JOIN users mu ON mu.id = bs.attendance_marked_by
     ${LEDGER_TOTALS_JOIN}
     WHERE bs.session_id = ?1 AND ${holdsSeatSql('bs', 'b', '?2')}
     ORDER BY ch.name COLLATE NOCASE`,
  ).bind(sessionId, now).all();
  return rows.results || [];
}

// Photo consent for the roster: the stricter of the booking snapshot and the
// child's current profile (roster spec: consent withdrawn mid-term shows No).
export function strictestConsent(snapshot, current) {
  const values = [snapshot, current].filter((v) => v !== null && v !== undefined).map(Number);
  if (!values.length) return { allowed: false, changed: false };
  return { allowed: values.every((v) => v === 1), changed: values.length === 2 && values[0] !== values[1] };
}

// Record (or clear) one child's attendance in a session: only a booked row
// of a live booking. Returns true when a row was updated.
export async function markAttendance(env, { sessionId, bookingId, mark, by, now = nowIso() }) {
  if (mark !== null && mark !== 'present' && mark !== 'absent') throw new Error('Unknown attendance mark');
  const result = await env.DB.prepare(
    `UPDATE booking_sessions SET attendance = ?3, attendance_marked_at = ?4, attendance_marked_by = ?5
     WHERE booking_id = ?1 AND session_id = ?2 AND status = 'booked'
       AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = ?1 AND ${bookingLiveSql('b', '?4')})`,
  ).bind(bookingId, sessionId, mark, now, by).run();
  return result.meta.changes > 0;
}

// Upcoming (and the last week's) sessions for the rosters page.
export async function listRosterSessions(env, { now = nowIso(), pastDays = 7, aheadDays = 56 } = {}) {
  const from = isoFromMs(Date.parse(now) - pastDays * DAY_MS);
  const to = isoFromMs(Date.parse(now) + aheadDays * DAY_MS);
  const rows = await env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.capacity, cs.status, c.name AS class_name, t.name AS term_name,
            ${heldSeatsSql('cs', '?3')} AS seats_held,
            (SELECT COUNT(*) FROM booking_sessions mbs JOIN bookings mb ON mb.id = mbs.booking_id
               WHERE mbs.session_id = cs.id AND mbs.attendance IS NOT NULL AND ${holdsSeatSql('mbs', 'mb', '?3')}) AS marked
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id LEFT JOIN terms t ON t.id = cs.term_id
     WHERE cs.starts_at >= ?1 AND cs.starts_at <= ?2
     ORDER BY cs.starts_at`,
  ).bind(from, to, now).all();
  return rows.results || [];
}

// --- Transfers, single weeks, restore -------------------------------------------

// Move one booked week of a booking to another session (D2): the source row
// becomes 'transferred_out' (pointing at the target) and a 'booked' row is
// inserted for the target under the same guards as a new booking (scheduled,
// class active, not started, a free seat, the child not already in it). One
// batch; no money changes. Returns { ok } or { ok: false, error } with error ∈
// same_session | not_found | not_live | not_booked | attended | target_missing |
// target_unavailable | target_started | target_full | already_in_target | changed.
export async function transferBookingSession(env, { bookingId, fromSessionId, toSessionId, by = null, now = nowIso() }) {
  if (fromSessionId === toSessionId) return { ok: false, error: 'same_session' };
  const booking = await env.DB.prepare(
    `SELECT id, child_id, status, expires_at FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return { ok: false, error: 'not_found' };
  const live = booking.status === 'confirmed' || (booking.status === 'pending' && booking.expires_at > now);
  if (!live) return { ok: false, error: 'not_live' };
  const from = await env.DB.prepare(
    `SELECT status, attendance FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2`,
  ).bind(bookingId, fromSessionId).first();
  if (!from || from.status !== 'booked') return { ok: false, error: 'not_booked' };
  if (from.attendance === 'present') return { ok: false, error: 'attended' };

  const diagnose = async () => {
    const target = await loadSession(env, toSessionId, now);
    if (!target) return 'target_missing';
    if (target.status !== 'scheduled' || !target.class_active) return 'target_unavailable';
    if (target.starts_at <= now) return 'target_started';
    const inTarget = await env.DB.prepare(`SELECT ${childInSessionSql('?1', '?2', '?3')} AS yes`)
      .bind(toSessionId, booking.child_id, now).first();
    if (inTarget && inTarget.yes) return 'already_in_target';
    if (target.seats_held >= target.capacity) return 'target_full';
    return null;
  };
  const problem = await diagnose();
  if (problem) return { ok: false, error: problem };

  const statements = [
    ...txnGuard(env,
      `EXISTS (SELECT 1 FROM booking_sessions tbs JOIN bookings tb ON tb.id = tbs.booking_id
               WHERE tbs.booking_id = ?1 AND tbs.session_id = ?2 AND tbs.status = 'booked'
                 AND ${bookingLiveSql('tb', '?3')})`,
      [bookingId, fromSessionId, now], 'source'),
    env.DB.prepare(
      `UPDATE booking_sessions SET status = 'transferred_out', transferred_to_session_id = ?3, changed_at = ?4
       WHERE booking_id = ?1 AND session_id = ?2 AND status = 'booked'`,
    ).bind(bookingId, fromSessionId, toSessionId, now),
    // A stale (cancelled / moved-out) row for the target week is replaced.
    env.DB.prepare(
      `DELETE FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2 AND status != 'booked'`,
    ).bind(bookingId, toSessionId),
    env.DB.prepare(
      `INSERT INTO booking_sessions (booking_id, session_id, status, changed_at)
       SELECT ?1, cs.id, 'booked', ?3 FROM class_sessions cs JOIN classes c ON c.id = cs.class_id
       WHERE cs.id = ?2 AND cs.status = 'scheduled' AND c.active = 1 AND cs.starts_at > ?3
         AND cs.capacity > ${heldSeatsSql('cs', '?3')}
         AND NOT ${childInSessionSql('cs.id', '?4', '?3')}`,
    ).bind(bookingId, toSessionId, now, booking.child_id),
    ...txnGuard(env,
      `EXISTS (SELECT 1 FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2 AND status = 'booked')`,
      [bookingId, toSessionId], 'target'),
  ];
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    return { ok: false, error: (await diagnose()) || 'changed' };
  }
  logEvent('booking_week_transferred', {
    booking_id: bookingId.slice(0, 8), by: by ? String(by).slice(0, 8) : null,
  });
  return { ok: true };
}

// Sessions a booking's week could move to: upcoming, scheduled, active
// classes, with seats and whether the child is already in each.
export async function listTransferTargets(env, { childId, excludeSessionId = null, now = nowIso(), aheadDays = 120 }) {
  const until = isoFromMs(Date.parse(now) + aheadDays * DAY_MS);
  const rows = await env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.capacity, cs.status, c.name AS class_name, t.name AS term_name,
            ${heldSeatsSql('cs', '?1')} AS seats_held,
            ${childInSessionSql('cs.id', '?2', '?1')} AS child_in
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id LEFT JOIN terms t ON t.id = cs.term_id
     WHERE cs.status = 'scheduled' AND c.active = 1 AND cs.starts_at > ?1 AND cs.starts_at <= ?3
       AND cs.id != COALESCE(?4, '')
     ORDER BY cs.starts_at, c.name`,
  ).bind(now, childId, until, excludeSessionId).all();
  return (rows.results || []).map((r) => ({ ...r, seats_left: Math.max(0, r.capacity - r.seats_held) }));
}

// Cancel one booked week (D2/D8) with an optional credit, in one batch.
// Returns { ok, creditId } or { ok: false, error: not_found | not_live | not_booked | changed }.
export async function cancelBookingWeek(env, {
  bookingId, sessionId, creditCents = 0, reason = '', by = null, expiresAt = null, now = nowIso(),
}) {
  const booking = await env.DB.prepare(
    `SELECT id, user_id, child_id, status, expires_at FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return { ok: false, error: 'not_found' };
  const live = booking.status === 'confirmed' || (booking.status === 'pending' && booking.expires_at > now);
  if (!live) return { ok: false, error: 'not_live' };
  const row = await env.DB.prepare(
    `SELECT status FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2`,
  ).bind(bookingId, sessionId).first();
  if (!row || row.status !== 'booked') return { ok: false, error: 'not_booked' };
  if (!Number.isInteger(creditCents) || creditCents < 0) throw new Error('creditCents must be whole cents ≥ 0');

  const credit = creditCents > 0
    ? issueCreditStatement(env, {
      userId: booking.user_id, childId: booking.child_id, amountCents: creditCents,
      reason: String(reason || 'Week cancelled').slice(0, 300), sourceBookingId: bookingId,
      sourceSessionId: sessionId, issuedBy: by || 'system', expiresAt, now,
    })
    : null;
  try {
    await env.DB.batch([
      ...txnGuard(env,
        `EXISTS (SELECT 1 FROM booking_sessions cbs JOIN bookings cb ON cb.id = cbs.booking_id
                 WHERE cbs.booking_id = ?1 AND cbs.session_id = ?2 AND cbs.status = 'booked'
                   AND ${bookingLiveSql('cb', '?3')})`,
        [bookingId, sessionId, now], 'row'),
      env.DB.prepare(
        `UPDATE booking_sessions SET status = 'cancelled', changed_at = ?3
         WHERE booking_id = ?1 AND session_id = ?2 AND status = 'booked'`,
      ).bind(bookingId, sessionId, now),
      ...(credit ? [credit.statement] : []),
    ]);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    return { ok: false, error: 'changed' };
  }
  logEvent('booking_week_cancelled', {
    booking_id: bookingId.slice(0, 8), credit_cents: creditCents, by: by ? String(by).slice(0, 8) : null,
  });
  return { ok: true, creditId: credit ? credit.id : null };
}

// A cancelled booking that had been a real (confirmed) booking — paid,
// part-paid, complimentary or imported. Only those can be restored.
export function wasConfirmed(b) {
  return Boolean(b.paid_at) || b.kind === 'complimentary' || b.payment_provider === 'external'
    || ['paid', 'plan_active', 'plan_overdue', 'plan_complete', 'waived'].includes(b.payment_status);
}

// Restore a cancelled booking (the reversal of "Cancel booking"): confirmed
// again only if every upcoming booked week still has a free seat (capacity
// excluding this booking) and the child is not in that session elsewhere —
// checked by guards inside the same batch, so nothing is ever oversold.
// Returns { ok } or { ok: false, error: not_found | not_cancelled |
// never_confirmed | no_seat, sessions? }.
export async function restoreBooking(env, bookingId, { by = null, now = nowIso() } = {}) {
  const booking = await env.DB.prepare(
    `SELECT id, child_id, kind, status, paid_at, payment_status, payment_provider FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return { ok: false, error: 'not_found' };
  if (booking.status !== 'cancelled') return { ok: false, error: 'not_cancelled' };
  if (!wasConfirmed(booking)) return { ok: false, error: 'never_confirmed' };

  const upcoming = (await env.DB.prepare(
    `SELECT bs.session_id FROM booking_sessions bs JOIN class_sessions cs ON cs.id = bs.session_id
     WHERE bs.booking_id = ?1 AND bs.status = 'booked' AND cs.status = 'scheduled' AND cs.starts_at > ?2`,
  ).bind(bookingId, now).all()).results || [];
  const statements = [];
  for (const { session_id: sessionId } of upcoming) {
    statements.push(...txnGuard(env,
      `(SELECT capacity FROM class_sessions WHERE id = ?2) > ${heldSeatsSql('?2', '?3', { excludeBooking: '?1' })}
       AND NOT ${childInSessionSql('?2', '?4', '?3', '?1')}`,
      [bookingId, sessionId, now, booking.child_id], 'seat'));
  }
  const note = `${formatSydney(now, 'date')}: booking restored after cancellation.`;
  statements.push(
    env.DB.prepare(
      `UPDATE bookings SET status = 'confirmed', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = '',
              admin_notes = CASE WHEN admin_notes = '' THEN ?2 ELSE admin_notes || char(10) || ?2 END
       WHERE id = ?1 AND status = 'cancelled'`,
    ).bind(bookingId, note),
    ...txnGuard(env, `(SELECT status FROM bookings WHERE id = ?1) = 'confirmed'`, [bookingId], 'state'),
  );
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    const full = (await env.DB.prepare(
      `SELECT cs.id, cs.starts_at, c.name AS class_name FROM booking_sessions bs
       JOIN class_sessions cs ON cs.id = bs.session_id JOIN classes c ON c.id = cs.class_id
       WHERE bs.booking_id = ?1 AND bs.status = 'booked' AND cs.status = 'scheduled' AND cs.starts_at > ?2
         AND (cs.capacity <= ${heldSeatsSql('cs', '?2', { excludeBooking: '?1' })}
              OR ${childInSessionSql('cs.id', '?3', '?2', '?1')})`,
    ).bind(bookingId, now, booking.child_id).all()).results || [];
    return { ok: false, error: 'no_seat', sessions: full };
  }
  logEvent('booking_restored', { booking_id: bookingId.slice(0, 8), by: by ? String(by).slice(0, 8) : null });
  return { ok: true };
}

// --- Notes and flags --------------------------------------------------------------

function appendNoteSql(column) {
  return `${column} = CASE WHEN ${column} = '' THEN ?2 ELSE ${column} || char(10) || ?2 END`;
}

// Replace a booking's admin notes (owner-only free text).
export async function saveBookingNotes(env, bookingId, notes) {
  const result = await env.DB.prepare(`UPDATE bookings SET admin_notes = ?2 WHERE id = ?1`)
    .bind(bookingId, String(notes || '').slice(0, 5000)).run();
  return result.meta.changes > 0;
}

// Clear the booking's flag — only while it is one of `flags` — and append a
// note line, in one batch: the note is written only when the flag clears
// (both statements test the same flag, and a batch is atomic). `extra`
// statements ride in the same batch, behind a guard that rolls everything
// back unless the flag is still one of `flags`.
async function clearFlagWithNote(env, bookingId, flags, line, extra = []) {
  const current = [...new Set(flags)];
  const guard = extra.length
    ? txnGuard(env, `(SELECT needs_attention FROM bookings WHERE id = ?1) IN (${current.map((_, i) => `?${i + 2}`).join(', ')})`,
      [bookingId, ...current], 'flag')
    : [];
  let results;
  try {
    results = await env.DB.batch([
      ...guard,
      env.DB.prepare(
        `UPDATE bookings SET ${appendNoteSql('admin_notes')}
         WHERE id = ?1 AND needs_attention IN (${current.map((_, i) => `?${i + 3}`).join(', ')})`,
      ).bind(bookingId, String(line).slice(0, 600), ...current),
      flagStatement(env, bookingId, null, { onlyIf: current }),
      ...extra,
    ]);
  } catch (err) {
    if (extra.length && isConstraintError(err)) return false; // the flag changed meanwhile
    throw err;
  }
  return results[guard.length + 1].meta.changes > 0;
}

// What "Mark as sorted" does to the money of an instalment plan that ended
// before it was paid (review finding 5) — the payment status otherwise stays
// "overdue" for good:
//   owed       the rest is still owed, paid another way: the booking stops
//              being a plan (payment_method 'offline'), so it reads "Part
//              paid — owes $…" and Record offline payment settles it;
//   write_off  the rest is written off: an adjustment for the shortfall
//              makes the plan complete.
export const PLAN_OUTCOMES = ['owed', 'write_off'];

// "Resolve" on Needs attention (D6): clear the flag and keep the owner's
// note on the booking. `planOutcome` (plan_ended_short only): see above.
export async function resolveAttention(env, bookingId, { note = '', by = null, now = nowIso(), planOutcome = null } = {}) {
  const booking = await env.DB.prepare(
    `SELECT needs_attention, amount_cents, credit_cents, payment_method FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking || !booking.needs_attention) return false;
  const label = NEEDS_ATTENTION_LABELS[booking.needs_attention] || booking.needs_attention;
  const extra = [];
  let outcomeText = '';
  if (booking.needs_attention === 'plan_ended_short' && PLAN_OUTCOMES.includes(planOutcome)) {
    if (planOutcome === 'owed') {
      extra.push(env.DB.prepare(`UPDATE bookings SET payment_method = 'offline' WHERE id = ?1 AND payment_method = 'plan'`).bind(bookingId));
      outcomeText = ' — the rest is still owed, to be paid another way';
    } else {
      const totals = await ledgerTotals(env, bookingId);
      const shortfall = booking.amount_cents + booking.credit_cents - totals.received_cents;
      if (shortfall > 0) {
        extra.push(paymentInsertStatement(env, {
          bookingId, kind: 'adjustment', amountCents: shortfall, providerRef: `writeoff:${uuid()}`, method: 'adjustment',
          note: 'Written off — the instalment plan ended before it was paid', recordedBy: by, now,
        }));
      }
      outcomeText = ` — ${formatAud(Math.max(0, shortfall))} written off`;
    }
    extra.push(recomputeStatement(env, bookingId));
  }
  const line = `${formatSydney(now, 'date')}: resolved "${label}"${outcomeText}${note ? ` — ${note}` : ''}`;
  const changed = await clearFlagWithNote(env, bookingId, [booking.needs_attention], line, extra);
  if (changed) {
    logEvent('attention_resolved', {
      booking_id: bookingId.slice(0, 8), by: by ? String(by).slice(0, 8) : null, plan_outcome: extra.length ? planOutcome : null,
    });
  }
  return changed;
}

// Clear a flag that a reconciliation has just made obsolete (e.g. a
// "paid, no seat" booking that Check with Stripe has now confirmed).
export async function clearFlagIf(env, bookingId, flags, note) {
  const allowed = flags.filter((f) => Object.hasOwn(NEEDS_ATTENTION_LABELS, f));
  if (!allowed.length) return false;
  return clearFlagWithNote(env, bookingId, allowed, note);
}

// A note line appended to a booking (e.g. "cancelled from Needs attention").
export async function appendBookingNote(env, bookingId, line) {
  await env.DB.prepare(`UPDATE bookings SET ${appendNoteSql('admin_notes')} WHERE id = ?1`)
    .bind(bookingId, String(line).slice(0, 600)).run();
}

// A "paid, no seat" booking is expired, so cancelBooking() refuses it; the
// owner's "Cancel" still records the decision (status cancelled).
export async function cancelEndedBooking(env, bookingId, { by, reason = '', now = nowIso() }) {
  const result = await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?2, cancelled_by = ?3, cancel_reason = ?4,
            plan_next_charge_at = NULL
     WHERE id = ?1 AND status = 'expired'`,
  ).bind(bookingId, now, String(by), String(reason || '').slice(0, 500)).run();
  return result.meta.changes > 0;
}

// --- Needs attention and the dashboard ---------------------------------------------

// D6: flagged bookings, pending bookings whose checkout is older than 40
// minutes, and (collapsed on the page) checkouts that ended unpaid in the
// last three days — the place to look when a family says they paid.
export async function listAttention(env, now = nowIso()) {
  const staleBefore = isoFromMs(Date.parse(now) - STALE_CHECKOUT_SECS * 1000);
  const recentAfter = isoFromMs(Date.parse(now) - RECENT_CHECKOUT_HOURS * 3600 * 1000);
  const rows = (await env.DB.prepare(
    `SELECT ${BOOKING_LIST_COLUMNS} ${BOOKING_LIST_FROM}
     WHERE b.needs_attention IS NOT NULL
        OR (b.status = 'pending' AND b.payment_ref IS NOT NULL AND b.created_at <= ?1)
        OR (b.status = 'expired' AND b.payment_ref IS NOT NULL AND b.created_at >= ?2
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id))
     ORDER BY b.created_at DESC
     LIMIT 300`,
  ).bind(staleBefore, recentAfter).all()).results || [];
  return {
    flagged: rows.filter((b) => b.needs_attention),
    stale: rows.filter((b) => !b.needs_attention && b.status === 'pending'),
    ended: rows.filter((b) => !b.needs_attention && b.status === 'expired'),
  };
}

export async function dashboardCounts(env, now = nowIso()) {
  const staleBefore = isoFromMs(Date.parse(now) - STALE_CHECKOUT_SECS * 1000);
  return env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM bookings WHERE needs_attention IS NOT NULL)
         + (SELECT COUNT(*) FROM bookings WHERE needs_attention IS NULL AND status = 'pending'
              AND payment_ref IS NOT NULL AND created_at <= ?1) AS attention,
       (SELECT COUNT(*) FROM bookings WHERE status = 'pending' AND expires_at > ?2
          AND (julianday(expires_at) - julianday(created_at)) * 86400 > ?3) AS pay_later,
       (SELECT COUNT(*) FROM terms WHERE status = 'open') AS open_terms,
       (SELECT COUNT(*) FROM waitlist WHERE status = 'waiting') AS waiting`,
  ).bind(staleBefore, now, CHECKOUT_HOLD_MAX_SECS).first();
}

// --- Customers -----------------------------------------------------------------

export async function listCustomers(env, { query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const rows = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.created_at,
            (SELECT GROUP_CONCAT(c.name || ' (' || c.dob || ')', '|')
             FROM children c WHERE c.user_id = u.id AND c.archived_at IS NULL) AS children,
            (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'confirmed') AS confirmed_bookings
     FROM users u
     WHERE u.role = 'parent'
       AND (?1 = '' OR lower(u.name) LIKE ?2 ESCAPE '\\' OR lower(u.email) LIKE ?2 ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM children sc WHERE sc.user_id = u.id AND lower(sc.name) LIKE ?2 ESCAPE '\\'))
     ORDER BY u.created_at DESC
     LIMIT 1000`,
  ).bind(q, like).all();
  return rows.results || [];
}

// One family: account, children (archived last), bookings with ledger
// totals, credits, waitlist entries and the usable credit balance.
export async function loadCustomer(env, userId, now = nowIso()) {
  const user = await env.DB.prepare(
    `SELECT id, email, name, phone, role, admin_notes, created_at, last_login_at FROM users WHERE id = ?1`,
  ).bind(userId).first();
  if (!user) return null;
  const [children, credits, waitlist] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, dob, medical_notes, photo_consent, created_at, archived_at FROM children
       WHERE user_id = ?1 ORDER BY archived_at IS NOT NULL, created_at`,
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT c.*, ch.name AS child_name FROM credits c LEFT JOIN children ch ON ch.id = c.child_id
       WHERE c.user_id = ?1 ORDER BY c.issued_at DESC`,
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT w.id, w.status, w.joined_at, w.offered_at, w.offer_expires_at, w.note, t.name AS term_name,
              cl.name AS class_name, ch.name AS child_name
       FROM waitlist w JOIN terms t ON t.id = w.term_id JOIN classes cl ON cl.id = t.class_id
       JOIN children ch ON ch.id = w.child_id
       WHERE w.user_id = ?1 ORDER BY w.joined_at DESC`,
    ).bind(userId).all(),
  ]);
  return {
    user,
    children: children.results || [],
    bookings: await listBookings(env, { userId, limit: 200 }),
    credits: credits.results || [],
    waitlist: waitlist.results || [],
    creditBalanceCents: await creditBalance(env, userId, now),
  };
}

export function creditState(c, now = nowIso()) {
  if (c.voided_at) return 'Voided';
  if (c.remaining_cents <= 0) return 'Used';
  if (c.expires_at && c.expires_at <= now) return 'Expired';
  return 'Active';
}

// Credits list (D3/D5): usable ones, or every credit.
export async function listCredits(env, { all = false, now = nowIso() } = {}) {
  const rows = await env.DB.prepare(
    `SELECT c.*, u.name AS parent_name, u.email AS parent_email, ch.name AS child_name,
            cs.starts_at AS source_session_starts_at, iu.email AS issued_by_email
     FROM credits c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN children ch ON ch.id = c.child_id
     LEFT JOIN class_sessions cs ON cs.id = c.source_session_id
     LEFT JOIN users iu ON iu.id = c.issued_by
     WHERE ?1 = 1 OR (c.voided_at IS NULL AND c.remaining_cents > 0 AND (c.expires_at IS NULL OR c.expires_at > ?2))
     ORDER BY c.issued_at DESC
     LIMIT 500`,
  ).bind(all ? 1 : 0, now).all();
  return rows.results || [];
}

// Find a parent by email or create one (manual bookings): the email is
// normalised by the caller; an existing account is reused and only blank
// name/phone fields are filled in. Returns { id, created }.
export async function findOrCreateParent(env, { email, name = '', phone = '', now = nowIso() }) {
  const inserted = await env.DB.prepare(
    `INSERT INTO users (id, email, name, phone, role, created_at) VALUES (?1, ?2, ?3, ?4, 'parent', ?5)
     ON CONFLICT(email) DO NOTHING`,
  ).bind(uuid(), email, name, phone, now).run();
  const user = await env.DB.prepare(`SELECT id, name, phone FROM users WHERE email = ?1`).bind(email).first();
  if (inserted.meta.changes === 0 && (name || phone)) {
    await env.DB.prepare(
      `UPDATE users SET name = CASE WHEN name = '' THEN ?2 ELSE name END,
                        phone = CASE WHEN phone = '' THEN ?3 ELSE phone END
       WHERE id = ?1`,
    ).bind(user.id, name, phone).run();
  }
  return { id: user.id, created: inserted.meta.changes > 0 };
}

export async function createChild(env, { userId, name, dob, medicalNotes = '', photoConsent, now = nowIso() }) {
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO children (id, user_id, name, dob, medical_notes, photo_consent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(id, userId, name, dob, medicalNotes, photoConsent ? 1 : 0, now).run();
  return id;
}

// --- Manual bookings (D8) ------------------------------------------------------------

// Create an owner-made booking:
//   mode 'offline'  — pending, then confirmed through the guarded path with an
//                     offline ledger row for the amount received now;
//   mode 'paylater' — pending with a 7-day hold (the family pays from their
//                     account with Pay now);
//   mode 'comp'     — a complimentary booking (nothing owed), confirmed.
// Pricing and every eligibility rule come from prepareBooking({ admin: true }).
// Returns { ok: true, bookingId, mode, owedCents, expiresAt, confirmed,
//           confirmError } or { ok: false, error, sessions?, voucherError? }.
export async function createAdminBooking(env, {
  userId, childId, kind, termId = null, sessionIds = [], voucherCode = '', priceOverrideCents = null,
  mode, receivedCents = null, method = 'cash', note = '', nonce, by, now = nowIso(),
}) {
  if (!['offline', 'paylater', 'comp'].includes(mode)) throw new Error(`Unknown payment mode: ${mode}`);
  const child = await env.DB.prepare(
    `SELECT id, photo_consent, medical_notes FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(childId, userId).first();
  if (!child) return { ok: false, error: 'child' };

  const effectiveKind = mode === 'comp' ? 'complimentary' : kind;
  const prepared = await prepareBooking(env, {
    userId, childId, kind: effectiveKind, termId,
    sessionIds: effectiveKind === 'term' ? [] : sessionIds,
    voucherCode: mode === 'comp' ? '' : voucherCode,
    paymentChoice: 'full', now, admin: true,
    priceOverrideCents: mode === 'comp' ? null : priceOverrideCents,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error, sessions: prepared.sessions || [] };
  if (prepared.quote.voucherError) return { ok: false, error: 'voucher', voucherError: prepared.quote.voucherError };

  const quote = prepared.quote;
  const expiresAt = mode === 'paylater' ? isoPlusSeconds(PAY_LATER_HOLD_SECS, Date.parse(now)) : null;
  const created = await createPendingBooking(env, {
    userId, childId, kind: effectiveKind, termId, sessionIds: quote.sessionIds, quote,
    photoConsent: child.photo_consent === 1, medicalNotes: child.medical_notes || '',
    expiresAt, paymentMethod: mode === 'comp' ? 'none' : mode === 'offline' ? 'offline' : 'full', now,
  });
  if (created.error) return { ok: false, error: created.error, sessions: created.sessions || [] };

  const owed = quote.amountCents;
  const result = { ok: true, bookingId: created.id, mode, owedCents: owed, expiresAt: created.expiresAt, quote };
  if (mode === 'paylater' && owed > 0) return { ...result, confirmed: false };

  let payment = null;
  if (mode === 'offline' && owed > 0) {
    const amount = Number.isInteger(receivedCents) ? receivedCents : owed;
    if (amount > 0) {
      payment = {
        kind: 'offline', amountCents: amount, providerRef: `offline:${nonce || uuid()}`, method,
        note: String(note || '').slice(0, 200), recordedBy: by, paidAt: now,
      };
    }
  }
  const confirm = await confirmBooking(env, created.id, {
    provider: mode === 'comp' ? 'free' : 'external', payment, now,
  });
  return {
    ...result, confirmed: Boolean(confirm.ok), confirmError: confirm.ok ? null : confirm.error,
    payment, expiresAt: null,
  };
}

// --- Auto-enrol (D8) ----------------------------------------------------------

// Children with a confirmed booking in the term's previous term, grouped per
// child: term families are ticked by default, trial/casual/complimentary are
// listed unticked; children already holding a place in this term are marked.
export async function autoEnrolCandidates(env, term, now = nowIso()) {
  if (!term.previous_term_id) return [];
  const rows = (await env.DB.prepare(
    `SELECT b.kind, b.child_id, b.user_id, ch.name AS child_name, ch.archived_at,
            u.name AS parent_name, u.email AS parent_email
     FROM bookings b JOIN children ch ON ch.id = b.child_id JOIN users u ON u.id = b.user_id
     WHERE b.term_id = ?1 AND b.status = 'confirmed'
     ORDER BY ch.name COLLATE NOCASE`,
  ).bind(term.previous_term_id).all()).results || [];
  const held = new Set(((await env.DB.prepare(
    `SELECT DISTINCT b.child_id FROM bookings b WHERE b.term_id = ?1 AND ${bookingLiveSql('b', '?2')}`,
  ).bind(term.id, now).all()).results || []).map((r) => r.child_id));
  const byChild = new Map();
  for (const r of rows) {
    if (!byChild.has(r.child_id)) {
      byChild.set(r.child_id, {
        childId: r.child_id, userId: r.user_id, childName: r.child_name, parentName: r.parent_name,
        parentEmail: r.parent_email, archived: Boolean(r.archived_at), kinds: new Set(),
        alreadyHeld: held.has(r.child_id),
      });
    }
    byChild.get(r.child_id).kinds.add(r.kind);
  }
  return [...byChild.values()].map((c) => ({
    ...c,
    kindLabels: [...c.kinds].map((k) => KIND_LABELS[k] || k),
    termFamily: c.kinds.has('term'),
  }));
}

// When an auto-enrol hold ends: the public opening instant when it is still
// at least an hour away, otherwise a week from now.
export function autoEnrolExpiry(term, now = nowIso()) {
  const soonest = isoPlusSeconds(3600, Date.parse(now));
  if (term.public_opens_at && term.public_opens_at > soonest) return term.public_opens_at;
  return isoPlusSeconds(PAY_LATER_HOLD_SECS, Date.parse(now));
}

// Hold one child's place in the term as a pending term booking at the
// returning price (pro-rated if the term has started), with the account's
// credits applied. Returns { ok, bookingId, amountCents, expiresAt,
// confirmed } or { ok: false, error }.
export async function autoEnrolChild(env, { term, userId, childId, now = nowIso(), expiresAt = autoEnrolExpiry(term, now) }) {
  const child = await env.DB.prepare(
    `SELECT id, photo_consent, medical_notes FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(childId, userId).first();
  if (!child) return { ok: false, error: 'child' };
  // The returning price (pro-rated if the term has started) even before the
  // returning window opens — one quote, so the place costs few queries.
  const prepared = await prepareBooking(env, {
    userId, childId, kind: 'term', termId: term.id, now, admin: true, forceReturningPrice: true,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const created = await createPendingBooking(env, {
    userId, childId, kind: 'term', termId: term.id, sessionIds: prepared.quote.sessionIds, quote: prepared.quote,
    photoConsent: child.photo_consent === 1, medicalNotes: child.medical_notes || '',
    expiresAt, paymentMethod: 'full', now,
  });
  if (created.error) return { ok: false, error: created.error };
  if (prepared.quote.amountCents === 0) {
    const confirm = await confirmBooking(env, created.id, { provider: 'free', now });
    return { ok: true, bookingId: created.id, amountCents: 0, expiresAt: null, confirmed: Boolean(confirm.ok) };
  }
  logEvent('auto_enrolled', { booking_id: created.id.slice(0, 8), term_id: term.id.slice(0, 8) });
  return { ok: true, bookingId: created.id, amountCents: prepared.quote.amountCents, expiresAt: created.expiresAt, confirmed: false };
}

// --- Vouchers ------------------------------------------------------------------

export const VOUCHER_CODE_PATTERN = /^[A-Z0-9_-]{2,40}$/;

export async function listVouchers(env) {
  const rows = await env.DB.prepare(
    `SELECT v.*, (SELECT COUNT(*) FROM bookings b WHERE b.voucher_code = v.code) AS bookings
     FROM vouchers v ORDER BY v.active DESC, v.created_at DESC`,
  ).all();
  return rows.results || [];
}

export async function voucherInUse(env, code) {
  const row = await env.DB.prepare(
    `SELECT (SELECT uses FROM vouchers WHERE code = ?1) AS uses,
            EXISTS (SELECT 1 FROM bookings WHERE voucher_code = ?1) AS referenced`,
  ).bind(code).first();
  return Boolean(row && (row.uses > 0 || row.referenced));
}

// --- Page helpers ---------------------------------------------------------------

// Post-redirect-get notices: only allow-listed keys are ever shown, so nothing
// from the query string is reflected into the page.
// `also` (repeatable) adds further allow-listed notices (e.g. "refunds
// added" after a Check with Stripe).
export function noticeFor(req, notices = {}, errors = {}) {
  const params = new URL(req.url).searchParams;
  const pick = (map, key) => (key && Object.hasOwn(map, key) ? map[key] : null);
  const ok = pick(notices, params.get('ok'));
  const also = [...new Set(params.getAll('also'))].slice(0, 4)
    .filter((key) => key !== params.get('ok')).map((key) => pick(notices, key)).filter(Boolean);
  const err = pick(errors, params.get('err'));
  return html`${ok ? html`<p class="form-notice" role="status">${ok}</p>` : ''}${
    joinHtml(also.map((text) => html`<p class="form-notice" role="status">${text}</p>`))}${
    err ? html`<p class="form-error" role="alert">${err}</p>` : ''}`;
}

export function errorBlock(message) {
  return message ? html`<p class="form-error" role="alert">${message}</p>` : html``;
}

// Cents → "168.00" for a form field ('' for none).
export function centsToInput(cents) {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

// "Term — Term 1 2027, Sensory Play — Wednesday 11:00 am (9 weeks from Wed 3
// Feb 2027)" — for emails and receipts. `booking` comes from getBooking() /
// loadBookingForNotification() (term_name, class_name, sessions).
export function describeBooking(booking) {
  const sessions = (booking.sessions || []).filter((s) => !s.status || s.status === 'booked');
  const className = booking.class_name || (sessions[0] && sessions[0].class_name) || 'Mini & Co. class';
  const what = `${KIND_LABELS[booking.kind] || booking.kind} — ${booking.term_name ? `${booking.term_name}, ` : ''}${className}`;
  if (!sessions.length) return what;
  if (sessions.length === 1) return `${what} (${formatSydney(sessions[0].starts_at)})`;
  return `${what} (${sessions.length} weeks from ${formatSydney(sessions[0].starts_at, 'date')})`;
}

// The "Mark as sorted" form (booking page and Needs attention). A plan that
// ended before it was paid asks what happens to the rest (resolveAttention,
// PLAN_OUTCOMES).
export function resolveForm(b, csrfToken, { back = null, owing = 0 } = {}) {
  const endedShort = b.needs_attention === 'plan_ended_short';
  return html`
    <form method="post" action="/admin/bookings/${b.id}/resolve" class="inline-form resolve-form">
      ${csrfField(csrfToken)}
      ${back ? html`<input type="hidden" name="back" value="${back}">` : ''}
      ${endedShort ? html`
        <fieldset class="check-list">
          <legend>The money still owed${owing ? ` (${formatAud(owing)})` : ''}:</legend>
          <label><input type="radio" name="plan_outcome" value="owed" required> They'll pay it another way — keep it owing</label>
          <label><input type="radio" name="plan_outcome" value="write_off"> Write it off</label>
        </fieldset>` : ''}
      <label>What did you do? <input type="text" name="note" maxlength="300" required></label>
      <button type="submit" class="button-small">${back ? 'Save and clear the flag' : 'Mark as sorted'}</button>
    </form>`;
}

// A dollar field that may be left blank: { ok, cents } (cents null when blank).
export function optionalDollars(value, maxCents) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: true, cents: null };
  const m = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return { ok: false, cents: null };
  const cents = (+m[1]) * 100 + (m[2] ? +m[2].padEnd(2, '0') : 0);
  return cents <= maxCents ? { ok: true, cents } : { ok: false, cents: null };
}
