// Admin: bookings (filtered list with ledger-backed payment columns, CSV),
// the booking page (weeks, ledger, notes) and its actions — move a week to
// another class, cancel one week with an optional credit, cancel / restore
// the whole booking, record an offline payment (with an emailed receipt) or
// an adjustment — and customers (search, family page, parent and child
// editing, admin notes). Phase 2B owns this file.
//
// Security: admin-only (live allowlist re-check per request); state changes
// are POST + CSRF and go through lib/domain.js / lib/admin-ops.js, which
// re-check the booking's CURRENT state inside one guarded batch: an offline
// payment confirms a pending or expired booking only through the capacity-
// guarded path (never overselling); repeated submissions are idempotent (a
// per-form nonce keys the ledger row and the receipt); destructive actions
// (cancel booking, cancel a week) have a confirm page.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm, roleFor } from '../lib/middleware.js';
import { redirect, notFound, HttpError } from '../lib/http.js';
import { uuid, nowIso, isConstraintError } from '../lib/db.js';
import { formatSydney, formatAge, sydneyToUtc } from '../lib/time.js';
import {
  isValidId, cleanText, parseDollarsToCents, normaliseEmail, isValidEmail, normalisePhone, isValidAuPhone,
  isValidName, validateDob, isYesNo,
} from '../lib/validate.js';
import {
  effectiveStatus, formatAud, confirmBooking, cancelBooking, getBooking, KIND_LABELS, PAYMENT_STATUS_LABELS,
  NEEDS_ATTENTION_LABELS, BOOKING_KINDS, forgetPlanChoiceStatement,
} from '../lib/domain.js';
import { recordPayment } from '../lib/ledger.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { notifyBookingConfirmed } from '../lib/notify.js';
import { csvResponse } from '../lib/csv.js';
import { logEvent, logError } from '../lib/log.js';
import { CHECK_NOTICES, sendOfflineReceipt } from './admin-ops.js';
import {
  listBookings, loadBookingRow, listLedger, listBookingRows, bookingWeeks, perWeekCreditCents, paymentSummary,
  owingCents, transferBookingSession, listTransferTargets, cancelBookingWeek, restoreBooking, wasConfirmed,
  saveBookingNotes, cancelEndedBooking, appendBookingNote, listCustomers, loadCustomer, createChild, creditState,
  noticeFor, errorBlock, centsToInput, optionalDollars, parseSignedDollarsToCents, isDateStr, addDays, shortDate,
} from '../lib/admin-ops.js';

const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired'];
const PAYMENT_STATUSES = Object.keys(PAYMENT_STATUS_LABELS);
const OFFLINE_METHODS = ['cash', 'bank transfer', 'card (in person)', 'other'];

const NOTICES = {
  'payment-recorded': 'Payment recorded and a receipt emailed.',
  'payment-confirmed': 'Payment recorded and the booking is confirmed. A receipt has been emailed.',
  'paid-no-seat': 'Payment recorded, but the booking could not be confirmed — its seat has been taken. It is flagged under Needs attention.',
  adjusted: 'Adjustment saved in the ledger.',
  cancelled: 'Booking cancelled and its places released. Any refund is made in the Stripe dashboard.',
  'cancelled-plan-warning': 'Booking cancelled, but the instalment plan could not be stopped in Stripe — please cancel the subscription in the Stripe dashboard.',
  'cancelled-ended': 'Booking marked cancelled. Any refund is made in the Stripe dashboard.',
  restored: 'Booking restored — its places are held again.',
  'restored-plan': 'Booking restored — its places are held again. Its instalment plan was stopped when it was cancelled, so record any remaining instalments as offline payments.',
  transferred: 'Week moved. No money has changed.',
  'week-cancelled': 'Week cancelled — the place is free for someone else.',
  'week-cancelled-credit': 'Week cancelled and a credit added to the family’s account.',
  'notes-saved': 'Notes saved.',
  'created-offline': 'Booking created and confirmed. The family has been emailed a confirmation and a receipt.',
  'created-paylater': 'Place held for 7 days. The family has been emailed to sign in and press Pay now.',
  'created-comp': 'Complimentary booking created and confirmed. The family has been emailed.',
  'created-free': 'Booking created and confirmed — nothing to pay (account credit covered it).',
  'created-unconfirmed': 'Booking created, but it could not be confirmed — see Needs attention.',
  ...CHECK_NOTICES,
};
const ERRORS = {
  'restore-no-seat': 'It can’t be restored: one of its weeks has no free seat any more (or the child is booked in elsewhere).',
  'restore-never-confirmed': 'Only a booking that had been confirmed can be restored. Make a new booking instead.',
  'restore-not-cancelled': 'That booking is not cancelled.',
  'week-not-booked': 'That week is no longer booked.',
  'booking-not-live': 'That booking has ended, so its weeks can’t be changed.',
  'adjustment-amount': 'Please enter an adjustment like 10, −10 or 12.50.',
};

// --- Bookings list --------------------------------------------------------------

function describeSessions(sessionStarts) {
  const starts = String(sessionStarts || '').split('|').filter(Boolean).sort();
  if (starts.length > 2) return `${formatSydney(starts[0], 'date')} – ${formatSydney(starts[starts.length - 1], 'date')} (${starts.length} weeks)`;
  return starts.map((s) => formatSydney(s)).join('; ') || '—';
}

function recordPaymentForm(b, csrfToken, { open = false } = {}) {
  const methods = OFFLINE_METHODS.map((m) => html`<option value="${m}">${m}</option>`);
  return html`
    <details class="inline-details" ${open ? 'open' : ''}>
      <summary>Record offline payment</summary>
      <form method="post" action="/admin/bookings/${b.id}/record-payment" class="inline-form record-payment-form">
        ${csrfField(csrfToken)}
        <input type="hidden" name="nonce" value="${uuid()}">
        <label>Amount (AUD) <input type="text" name="amount" value="${centsToInput(owingCents(b))}" required size="8" inputmode="decimal"></label>
        <label>Method <select name="method">${joinHtml(methods)}</select></label>
        <label>Note <input type="text" name="note" maxlength="200"></label>
        <button type="submit" class="button-small">Record payment</button>
      </form>
    </details>
  `;
}

function readFilters(get) {
  const termRaw = String(get('term') || '');
  return {
    term: isValidId(termRaw) ? termRaw : '',
    status: BOOKING_STATUSES.includes(get('status')) ? get('status') : '',
    payment: PAYMENT_STATUSES.includes(get('payment')) ? get('payment') : '',
    kind: BOOKING_KINDS.includes(get('kind')) ? get('kind') : '',
    attention: get('attention') === '1' ? '1' : '',
  };
}

function filtersToOptions(f) {
  return {
    termId: f.term || null, status: f.status || null, paymentStatus: f.payment || null, kind: f.kind || null,
    attention: Boolean(f.attention),
  };
}

// GET /admin/bookings[?term=…&status=…&payment=…&kind=…&attention=1]
export async function handleAdminBookings(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const filters = readFilters((name) => url.searchParams.get(name));
  const now = nowIso();
  const [bookings, terms] = await Promise.all([
    listBookings(env, filtersToOptions(filters)),
    env.DB.prepare(
      `SELECT t.id, t.name, c.name AS class_name FROM terms t JOIN classes c ON c.id = t.class_id ORDER BY t.starts_on DESC, c.name`,
    ).all().then((r) => r.results || []),
  ]);
  const opt = (name, value, label) => html`<option value="${value}" ${filters[name] === value ? 'selected' : ''}>${label}</option>`;

  const rows = bookings.map((b) => {
    const status = effectiveStatus(b, now);
    const payment = paymentSummary(b, now);
    const canRecord = status !== 'cancelled' && b.kind !== 'complimentary' && owingCents(b) > 0;
    return html`
      <tr class="${b.needs_attention ? 'row-attention' : ''}">
        <td><a href="/admin/customers/${b.user_id}">${b.parent_name || '—'}</a><br><span class="muted">${b.parent_email}</span></td>
        <td><a href="/admin/bookings/${b.id}">${b.child_name}</a></td>
        <td>${KIND_LABELS[b.kind] || b.kind}${b.term_name ? html`<br><span class="muted">${b.term_name}${b.class_name ? ` · ${b.class_name}` : ''}</span>` : ''}</td>
        <td>${describeSessions(b.session_starts)}</td>
        <td>${formatAud(b.amount_cents + b.credit_cents)}</td>
        <td>${formatAud(b.received_cents)}</td>
        <td>${payment.label}
          ${b.needs_attention ? html`<br><span class="attention-flag">${NEEDS_ATTENTION_LABELS[b.needs_attention] || b.needs_attention}</span>` : ''}</td>
        <td><span class="status status-${status}">${status}</span></td>
        <td class="table-actions">
          <a href="/admin/bookings/${b.id}">View</a>
          ${canRecord ? recordPaymentForm(b, user.csrfToken) : ''}
          ${b.status === 'pending' || b.status === 'confirmed' ? html`<a href="/admin/bookings/${b.id}/cancel">Cancel</a>` : ''}
        </td>
      </tr>
    `;
  });

  const filtered = Object.values(filters).some(Boolean);
  const body = html`
    <div class="admin-wide">
      <div class="page-head">
        <h1>Bookings</h1>
        <a href="/admin/bookings/new" class="button-link">New booking</a>
      </div>
      ${noticeFor(req, NOTICES, ERRORS)}
      <form method="get" action="/admin/bookings" class="filter-form">
        <label>Term <select name="term"><option value="">Any</option>${joinHtml(terms.map((t) => opt('term', t.id, `${t.class_name} — ${t.name}`)))}</select></label>
        <label>Status <select name="status"><option value="">Any</option>${joinHtml(BOOKING_STATUSES.map((s) => opt('status', s, s)))}</select></label>
        <label>Payment <select name="payment"><option value="">Any</option>${joinHtml(PAYMENT_STATUSES.map((s) => opt('payment', s, PAYMENT_STATUS_LABELS[s])))}</select></label>
        <label>Kind <select name="kind"><option value="">Any</option>${joinHtml(BOOKING_KINDS.map((k) => opt('kind', k, KIND_LABELS[k])))}</select></label>
        <label class="filter-check"><input type="checkbox" name="attention" value="1" ${filters.attention ? 'checked' : ''}> Needs attention</label>
        <button type="submit" class="button-small">Filter</button>
        ${filtered ? html`<a href="/admin/bookings">Clear</a>` : ''}
      </form>
      ${rows.length ? html`
        <div class="table-scroll">
          <table class="booking-table">
            <thead><tr><th>Parent</th><th>Child</th><th>Booking</th><th>Session(s)</th><th>Owed</th><th>Received</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${joinHtml(rows)}</tbody>
          </table>
        </div>
        <form method="post" action="/admin/bookings.csv" class="inline-form">
          ${csrfField(user.csrfToken)}
          ${joinHtml(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`))}
          <button type="submit" class="button-secondary">Download bookings CSV</button>
        </form>
      ` : html`<p>No bookings${filtered ? ' match these filters' : ''}.</p>`}
    </div>
  `;
  return pageResponse('Bookings', body, { user, admin: true });
}

// POST /admin/bookings.csv — the (filtered) list with ledger totals.
export async function handleAdminBookingsCsv(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const filters = readFilters((name) => form.get(name));
  const bookings = await listBookings(env, { ...filtersToOptions(filters), limit: 1000 });
  const now = nowIso();
  logEvent('bookings_exported', { rows: bookings.length });

  return csvResponse(
    `bookings${filters.status ? `-${filters.status}` : ''}.csv`,
    ['Created', 'Parent', 'Email', 'Phone', 'Child', 'Kind', 'Term', 'Sessions (Sydney)', 'List', 'Discount', 'Voucher',
      'Credit', 'Owed', 'Received', 'Refunded', 'Owing', 'Payment status', 'Payment', 'Status', 'Needs attention', 'Paid at'],
    bookings.map((b) => [
      b.created_at,
      b.parent_name,
      b.parent_email,
      b.parent_phone,
      b.child_name,
      KIND_LABELS[b.kind] || b.kind,
      b.term_name || '',
      describeSessions(b.session_starts),
      formatAud(b.list_amount_cents),
      formatAud(b.discount_cents),
      b.voucher_code || '',
      formatAud(b.credit_cents),
      formatAud(b.amount_cents + b.credit_cents),
      formatAud(b.received_cents),
      formatAud(b.refunded_cents),
      formatAud(owingCents(b)),
      PAYMENT_STATUS_LABELS[b.payment_status] || b.payment_status,
      paymentSummary(b, now).label,
      effectiveStatus(b, now),
      b.needs_attention ? NEEDS_ATTENTION_LABELS[b.needs_attention] || b.needs_attention : '',
      b.paid_at || '',
    ]),
  );
}

// --- The booking page --------------------------------------------------------------

const LEDGER_LABELS = {
  checkout: 'Card payment', instalment: 'Instalment', offline: 'Offline payment', refund: 'Refund',
  credit_applied: 'Account credit', adjustment: 'Adjustment',
};

function rowStatusLabel(r) {
  if (r.status === 'transferred_out') {
    return `Moved to ${r.transferred_to_class_name || 'another class'}${r.transferred_to_starts_at ? `, ${formatSydney(r.transferred_to_starts_at)}` : ''}`;
  }
  if (r.status === 'cancelled') return r.session_status === 'cancelled' ? 'Cancelled (class cancelled)' : 'Cancelled';
  if (r.session_status === 'cancelled') return 'Class cancelled';
  return 'Booked';
}

// GET /admin/bookings/:id
export async function handleAdminBooking(req, env, params) {
  const user = await requireAdmin(req, env);
  const now = nowIso();
  const b = await loadBookingRow(env, params.id);
  if (!b) throw notFound();
  const [rows, ledger, credits, full] = await Promise.all([
    listBookingRows(env, b.id),
    listLedger(env, b.id),
    env.DB.prepare(`SELECT * FROM credits WHERE source_booking_id = ?1 ORDER BY issued_at`).bind(b.id).all().then((r) => r.results || []),
    getBooking(env, b.id),
  ]);
  const status = effectiveStatus(b, now);
  const live = status === 'confirmed' || status === 'pending';
  const payment = paymentSummary(b, now);

  const weekRows = rows.map((r) => {
    const canChange = live && r.status === 'booked' && r.session_status === 'scheduled';
    return html`
      <tr class="${r.status === 'booked' && r.session_status === 'scheduled' ? '' : 'row-cancelled'}">
        <td><a href="/admin/sessions/${r.session_id}/roster">${formatSydney(r.starts_at)}</a></td>
        <td>${r.class_name}</td>
        <td>${rowStatusLabel(r)}</td>
        <td>${r.attendance === 'present' ? 'Present' : r.attendance === 'absent' ? 'Absent' : ''}</td>
        <td class="table-actions">${canChange ? html`
          ${r.attendance !== 'present' ? html`<a href="/admin/bookings/${b.id}/transfer?session=${r.session_id}">Move to another class</a>` : ''}
          <a href="/admin/bookings/${b.id}/cancel-week?session=${r.session_id}">Cancel this week</a>` : ''}
        </td>
      </tr>`;
  });
  const ledgerRows = ledger.map((p) => html`
    <tr>
      <td>${formatSydney(p.paid_at, 'date')}</td>
      <td>${LEDGER_LABELS[p.kind] || p.kind}</td>
      <td>${formatAud(p.amount_cents)}</td>
      <td>${p.method || ''}${p.note ? html`<br><span class="muted">${p.note}</span>` : ''}</td>
      <td class="muted">${p.recorded_by_email || p.provider || ''}</td>
    </tr>`);
  const creditRows = credits.map((c) => html`
    <li>${formatAud(c.amount_cents)} — ${c.reason || 'credit'} · ${creditState(c, now)}${c.remaining_cents !== c.amount_cents ? ` (${formatAud(c.remaining_cents)} left)` : ''}</li>`);
  const canCheck = Boolean(b.payment_ref || b.stripe_subscription_id);
  const canRecord = b.status !== 'cancelled' && b.kind !== 'complimentary';

  const body = html`
    <p class="breadcrumb"><a href="/admin/bookings">Bookings</a></p>
    <h1>${b.child_name} — ${KIND_LABELS[b.kind] || b.kind}</h1>
    ${noticeFor(req, NOTICES, ERRORS)}
    ${b.needs_attention ? html`
      <div class="confirm-box">
        <p><span class="attention-flag">${NEEDS_ATTENTION_LABELS[b.needs_attention] || b.needs_attention}</span></p>
        <form method="post" action="/admin/bookings/${b.id}/resolve" class="inline-form">
          ${csrfField(user.csrfToken)}
          <label>What did you do? <input type="text" name="note" maxlength="300" required></label>
          <button type="submit" class="button-small">Mark as sorted</button>
        </form>
      </div>` : ''}
    <dl class="detail-list">
      <dt>Parent</dt><dd><a href="/admin/customers/${b.user_id}">${b.parent_name || b.parent_email}</a> · ${b.parent_email}${b.parent_phone ? ` · ${b.parent_phone}` : ''}</dd>
      <dt>Child</dt><dd>${b.child_name}${full && full.child_dob ? ` (${formatAge(full.child_dob)})` : ''}</dd>
      <dt>Booking</dt><dd>${b.term_name ? html`<a href="/admin/terms/${b.term_id}">${b.term_name}</a> · ${b.class_name}` : 'One-off classes'}</dd>
      <dt>Status</dt><dd><span class="status status-${status}">${status}</span>${b.status === 'pending' && b.expires_at ? ` · held until ${formatSydney(b.expires_at)}` : ''}${b.cancelled_at ? ` · cancelled ${formatSydney(b.cancelled_at, 'date')}${b.cancel_reason ? ` (${b.cancel_reason})` : ''}` : ''}</dd>
      <dt>Price</dt><dd>${formatAud(b.list_amount_cents)}${b.discount_cents ? ` − voucher ${b.voucher_code || ''} ${formatAud(b.discount_cents)}` : ''}${b.credit_cents ? ` − account credit ${formatAud(b.credit_cents)}` : ''} = ${formatAud(b.amount_cents)} to pay</dd>
      <dt>Payment</dt><dd>${payment.label} · received ${formatAud(b.received_cents)}${b.refunded_cents ? ` · refunded ${formatAud(b.refunded_cents)}` : ''}${payment.owingCents ? ` · owes ${formatAud(payment.owingCents)}` : ''}</dd>
      ${b.payment_method === 'plan' ? html`<dt>Instalments</dt><dd>${b.plan_instalments} × ${formatAud(b.plan_instalment_cents)} every ${b.plan_interval || 'week'} · ${b.instalments_paid} paid${b.plan_next_charge_at ? ` · next ${shortDate(b.plan_next_charge_at)}` : ''}</dd>` : ''}
      <dt>Booked</dt><dd>${formatSydney(b.created_at)}</dd>
    </dl>
    <div class="inline-actions">
      ${canCheck ? html`
        <form method="post" action="/admin/bookings/${b.id}/check" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-small button-secondary">Check with Stripe</button>
        </form>` : ''}
      ${b.status !== 'cancelled' ? html`<a href="/admin/bookings/${b.id}/cancel" class="button-link button-small button-secondary">Cancel booking…</a>` : ''}
      ${b.status === 'cancelled' && wasConfirmed(b) ? html`
        <form method="post" action="/admin/bookings/${b.id}/restore" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-small">Restore booking</button>
        </form>` : ''}
    </div>
    <h2>Weeks</h2>
    <div class="table-scroll">
      <table class="booking-table">
        <thead><tr><th>When (Sydney)</th><th>Class</th><th>Status</th><th>Attendance</th><th></th></tr></thead>
        <tbody>${weekRows.length ? joinHtml(weekRows) : html`<tr><td colspan="5">No weeks.</td></tr>`}</tbody>
      </table>
    </div>
    <h2 id="record-payment">Payments</h2>
    ${ledgerRows.length ? html`
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>Date</th><th>What</th><th>Amount</th><th>How</th><th>By</th></tr></thead>
          <tbody>${joinHtml(ledgerRows)}</tbody>
        </table>
      </div>` : html`<p>No payments yet.</p>`}
    ${canRecord ? recordPaymentForm(b, user.csrfToken, { open: payment.owingCents > 0 }) : ''}
    <details class="inline-details">
      <summary>Add an adjustment</summary>
      <form method="post" action="/admin/bookings/${b.id}/adjustment" class="inline-form record-payment-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="nonce" value="${uuid()}">
        <p class="form-hint">A positive amount counts as paid (for example a discount after booking);
          a negative amount (−10) adds to what the family owes.</p>
        <label>Amount (AUD) <input type="text" name="amount" required size="8"></label>
        <label>Reason <input type="text" name="note" maxlength="200" required></label>
        <button type="submit" class="button-small">Save adjustment</button>
      </form>
    </details>
    ${creditRows.length ? html`<h2>Credits from this booking</h2><ul>${joinHtml(creditRows)}</ul>` : ''}
    <h2>Notes</h2>
    <form method="post" action="/admin/bookings/${b.id}/notes" class="booking-form">
      ${csrfField(user.csrfToken)}
      <label for="admin_notes" class="sr-only">Notes (only you see these)</label>
      <textarea id="admin_notes" name="notes" rows="4" maxlength="5000">${full ? full.admin_notes : ''}</textarea>
      <button type="submit" class="button-small">Save notes</button>
    </form>
  `;
  return pageResponse(`${b.child_name} — booking`, body, { user, admin: true });
}

// POST /admin/bookings/:id/notes
export async function handleAdminBookingNotes(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req, 32 * 1024);
  requireCsrf(req, user, form);
  const saved = await saveBookingNotes(env, params.id, cleanText(form.get('notes'), 5000));
  if (!saved) throw notFound();
  return redirect(`/admin/bookings/${params.id}?ok=notes-saved`, 303);
}

// POST /admin/bookings/:id/record-payment — "Record offline payment" (cash,
// bank transfer, …). On a pending or expired booking this confirms it through
// the same capacity-guarded path as a card payment; on a confirmed booking it
// just adds the ledger row. The form's nonce makes a double submit harmless
// (one ledger row, one receipt).
export async function handleAdminRecordPayment(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const booking = await env.DB.prepare(
    `SELECT id, status, kind, payment_ref FROM bookings WHERE id = ?1`,
  ).bind(params.id).first();
  if (!booking) throw notFound('That booking does not exist.');
  if (booking.status === 'cancelled') {
    throw new HttpError(409, 'This booking is cancelled — restore it before recording a payment.');
  }

  const amountCents = parseDollarsToCents(form.get('amount'), 1000000);
  if (!amountCents) throw new HttpError(400, 'Please enter the amount received, e.g. 168 or 28.50.');
  const nonce = String(form.get('nonce') || '');
  if (!isValidId(nonce)) throw new HttpError(400, 'That form has expired — please reload the page and try again.');
  const method = OFFLINE_METHODS.includes(form.get('method')) ? form.get('method') : 'other';
  const payment = {
    kind: 'offline', amountCents, providerRef: `offline:${nonce}`, method,
    note: cleanText(form.get('note'), 200), recordedBy: user.userId, paidAt: nowIso(),
  };

  let ok;
  if (booking.status === 'confirmed') {
    await recordPayment(env, { ...payment, bookingId: booking.id });
    ok = 'payment-recorded';
  } else {
    // Pending: stop a live Stripe checkout so the family cannot pay twice.
    let checkoutClosed = !booking.payment_ref;
    if (booking.status === 'pending' && booking.payment_ref) {
      try {
        await getPaymentsDriver(env).expireCheckout(booking.payment_ref);
        checkoutClosed = true;
      } catch (err) {
        logError('checkout_expire_failed', err, { booking_id: booking.id.slice(0, 8) });
      }
    }
    // Paid by hand, not by instalments: an instalment plan chosen for that
    // checkout never started, so it must not shape the payment status. (If
    // the checkout could not be closed it may have just completed — then its
    // plan is real and is kept.)
    if (checkoutClosed) await forgetPlanChoiceStatement(env, booking.id, booking.payment_ref).run();
    const result = await confirmBooking(env, booking.id, { provider: 'external', payment });
    if (result.ok) {
      ok = 'payment-confirmed';
      if (result.newlyConfirmed) {
        try {
          await notifyBookingConfirmed(env, booking.id);
        } catch (err) {
          logError('confirmation_email_failed', err, { booking_id: booking.id.slice(0, 8) });
        }
      }
    } else if (result.error === 'paid_no_seat') {
      ok = 'paid-no-seat';
    } else {
      throw new HttpError(409, 'The booking changed while you were looking at it — please review it again.');
    }
  }
  logEvent('offline_payment_recorded', { booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8), outcome: ok });
  const full = await getBooking(env, booking.id);
  try {
    await sendOfflineReceipt(env, full, payment);
  } catch (err) {
    logError('offline_receipt_failed', err, { booking_id: booking.id.slice(0, 8) });
  }
  return redirect(`/admin/bookings/${booking.id}?ok=${ok}`, 303);
}

// POST /admin/bookings/:id/adjustment — a signed ledger row with a reason.
export async function handleAdminAdjustment(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const booking = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?1`).bind(params.id).first();
  if (!booking) throw notFound();
  const amountCents = parseSignedDollarsToCents(form.get('amount'), 1000000);
  const nonce = String(form.get('nonce') || '');
  if (!amountCents || !isValidId(nonce)) return redirect(`/admin/bookings/${booking.id}?err=adjustment-amount`, 303);
  await recordPayment(env, {
    bookingId: booking.id, kind: 'adjustment', amountCents, providerRef: `adjustment:${nonce}`, method: 'adjustment',
    note: cleanText(form.get('note'), 200), recordedBy: user.userId,
  });
  logEvent('ledger_adjustment', { booking_id: booking.id.slice(0, 8), amount_cents: amountCents, by: user.userId.slice(0, 8) });
  return redirect(`/admin/bookings/${booking.id}?ok=adjusted`, 303);
}

// --- Cancel / restore the whole booking ---------------------------------------------------

// GET /admin/bookings/:id/cancel — confirm step.
export async function handleAdminCancelBookingConfirm(req, env, params) {
  const user = await requireAdmin(req, env);
  const b = await loadBookingRow(env, params.id);
  if (!b) throw notFound();
  if (b.status === 'cancelled') return redirect(`/admin/bookings/${b.id}`, 303);
  const body = html`
    <p class="breadcrumb"><a href="/admin/bookings/${b.id}">Back to the booking</a></p>
    <h1>Cancel ${b.child_name}'s booking?</h1>
    <div class="confirm-box">
      <p>${KIND_LABELS[b.kind] || b.kind}${b.term_name ? ` · ${b.term_name}` : ''} · ${b.parent_name || b.parent_email}</p>
      <ul>
        <li>Every place it holds is released for other families.</li>
        ${b.payment_method === 'plan' && b.stripe_subscription_id ? html`<li>The instalment plan is stopped, so no more payments are taken.</li>` : ''}
        ${b.received_cents > 0 ? html`<li>${formatAud(b.received_cents)} has been received — refunds are made in the Stripe dashboard (or by hand for cash and bank transfers).</li>` : ''}
        <li>You can restore it later if the places are still free.</li>
      </ul>
      <form method="post" action="/admin/bookings/${b.id}/cancel" class="booking-form">
        ${csrfField(user.csrfToken)}
        <div class="form-group">
          <label for="reason">Reason <span class="muted">(only you see this)</span></label>
          <input type="text" id="reason" name="reason" maxlength="200">
        </div>
        <button type="submit" class="button-danger">Yes, cancel the booking</button>
        <a href="/admin/bookings/${b.id}" class="button-link button-secondary">Keep it</a>
      </form>
    </div>
  `;
  return pageResponse('Cancel booking', body, { user, admin: true });
}

// POST /admin/bookings/:id/cancel — cancel a pending or confirmed booking
// (seats released, live checkout expired, instalment plan stopped). A
// "paid, no seat" booking (status expired) is marked cancelled and its plan
// stopped too, so it never charges again.
export async function handleAdminCancelBooking(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const reason = cleanText(form.get('reason'), 500);

  const booking = await env.DB.prepare(
    `SELECT id, status, stripe_subscription_id, payment_status FROM bookings WHERE id = ?1`,
  ).bind(params.id).first();
  if (!booking) throw notFound('That booking does not exist.');

  if (booking.status === 'expired') {
    const changed = await cancelEndedBooking(env, booking.id, { by: user.userId, reason });
    if (!changed) throw new HttpError(409, 'This booking changed — please review it again.');
    let stopped = true;
    if (booking.stripe_subscription_id && booking.payment_status !== 'plan_complete') {
      try {
        await getPaymentsDriver(env).cancelSubscription(booking.stripe_subscription_id);
      } catch (err) {
        stopped = false;
        logError('subscription_cancel_failed', err, { booking_id: booking.id.slice(0, 8) });
      }
    }
    await appendBookingNote(env, booking.id, `${formatSydney(nowIso(), 'date')}: cancelled by the owner${reason ? ` — ${reason}` : ''}.`);
    logEvent('booking_cancelled_by_admin', { booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8), ended: true });
    return redirect(`/admin/bookings/${booking.id}?ok=${stopped ? 'cancelled-ended' : 'cancelled-plan-warning'}`, 303);
  }

  const result = await cancelBooking(env, booking.id, { by: user.userId, reason });
  if (!result.ok && result.error === 'not_found') throw notFound('That booking does not exist.');
  if (!result.ok) throw new HttpError(409, `This booking is already ${result.error === 'state_changed' ? 'changed' : result.error}.`);
  logEvent('booking_cancelled_by_admin', { booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/bookings/${booking.id}?ok=${result.subscriptionStopped === false ? 'cancelled-plan-warning' : 'cancelled'}`, 303);
}

// POST /admin/bookings/:id/restore
export async function handleAdminRestoreBooking(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const result = await restoreBooking(env, params.id, { by: user.userId });
  if (!result.ok && result.error === 'not_found') throw notFound();
  if (!result.ok) {
    const err = { no_seat: 'restore-no-seat', never_confirmed: 'restore-never-confirmed' }[result.error] || 'restore-not-cancelled';
    return redirect(`/admin/bookings/${params.id}?err=${err}`, 303);
  }
  const plan = await env.DB.prepare(
    `SELECT 1 AS yes FROM bookings WHERE id = ?1 AND payment_method = 'plan' AND stripe_subscription_id IS NOT NULL
       AND payment_status != 'plan_complete'`,
  ).bind(params.id).first();
  return redirect(`/admin/bookings/${params.id}?ok=${plan ? 'restored-plan' : 'restored'}`, 303);
}

// --- Move one week (transfer) ----------------------------------------------------------

async function loadWeek(env, bookingId, sessionId) {
  if (!isValidId(sessionId)) return null;
  return env.DB.prepare(
    `SELECT bs.status, bs.attendance, cs.id AS session_id, cs.starts_at, c.name AS class_name
     FROM booking_sessions bs JOIN class_sessions cs ON cs.id = bs.session_id JOIN classes c ON c.id = cs.class_id
     WHERE bs.booking_id = ?1 AND bs.session_id = ?2`,
  ).bind(bookingId, sessionId).first();
}

const TRANSFER_ERRORS = {
  same_session: 'Please choose a different class.',
  not_live: 'This booking has ended, so its weeks can’t be moved.',
  not_booked: 'That week is no longer booked.',
  attended: 'The child has already been marked present for that week.',
  target_missing: 'That class could not be found.',
  target_unavailable: 'That class is cancelled or not running.',
  target_started: 'That class has already started.',
  target_full: 'That class is full — choose another, or raise its capacity first.',
  already_in_target: 'The child is already booked into that class.',
  changed: 'Something changed while you were choosing — please try again.',
};

async function transferPage(env, user, b, week, { error = '', status = 200 } = {}) {
  const now = nowIso();
  const targets = await listTransferTargets(env, { childId: b.child_id, excludeSessionId: week.session_id, now });
  const items = targets.map((t) => {
    const blocked = t.child_in ? 'already booked' : t.seats_left <= 0 ? 'full' : '';
    return html`<li><label>
      <input type="radio" name="to" value="${t.id}" ${blocked ? 'disabled' : ''} required>
      ${formatSydney(t.starts_at)} · ${t.class_name}${t.term_name ? html` <span class="muted">(${t.term_name})</span>` : ''}
      <span class="muted">${blocked || `${t.seats_left} seat${t.seats_left === 1 ? '' : 's'} left`}</span>
    </label></li>`;
  });
  const body = html`
    <p class="breadcrumb"><a href="/admin/bookings/${b.id}">Back to the booking</a></p>
    <h1>Move ${b.child_name}'s class</h1>
    <p class="lede">From <strong>${formatSydney(week.starts_at)} · ${week.class_name}</strong> to another class with a free seat.
      No money changes; the original place is released.</p>
    ${errorBlock(error)}
    ${items.length ? html`
      <form method="post" action="/admin/bookings/${b.id}/transfer" class="booking-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="from" value="${week.session_id}">
        <ul class="check-list plain-list">${joinHtml(items)}</ul>
        <button type="submit">Move the class</button>
      </form>` : html`<p>There are no upcoming classes to move to.</p>`}
  `;
  return pageResponse('Move a class', body, { user, admin: true, status });
}

// GET /admin/bookings/:id/transfer?session=…
export async function handleAdminTransfer(req, env, params) {
  const user = await requireAdmin(req, env);
  const b = await loadBookingRow(env, params.id);
  if (!b) throw notFound();
  const week = await loadWeek(env, b.id, String(new URL(req.url).searchParams.get('session') || ''));
  if (!week) throw notFound();
  if (week.status !== 'booked') return redirect(`/admin/bookings/${b.id}?err=week-not-booked`, 303);
  return transferPage(env, user, b, week);
}

// POST /admin/bookings/:id/transfer — from, to.
export async function handleAdminTransferPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const b = await loadBookingRow(env, params.id);
  if (!b) throw notFound();
  const week = await loadWeek(env, b.id, String(form.get('from') || ''));
  if (!week) throw notFound();
  const to = String(form.get('to') || '');
  if (!isValidId(to)) return transferPage(env, user, b, week, { error: 'Please choose the class to move to.', status: 400 });
  const result = await transferBookingSession(env, {
    bookingId: b.id, fromSessionId: week.session_id, toSessionId: to, by: user.userId,
  });
  if (!result.ok) return transferPage(env, user, b, week, { error: TRANSFER_ERRORS[result.error] || 'That move is not possible.', status: 409 });
  return redirect(`/admin/bookings/${b.id}?ok=transferred`, 303);
}

// --- Cancel one week -----------------------------------------------------------------

async function defaultWeekCredit(env, b) {
  if (b.status !== 'confirmed' || b.kind === 'complimentary') return 0;
  return perWeekCreditCents({ amountCents: b.amount_cents, creditCents: b.credit_cents, weeks: await bookingWeeks(env, b.id) });
}

async function cancelWeekPage(env, user, b, week, { error = '', status = 200, values = null } = {}) {
  const suggested = await defaultWeekCredit(env, b);
  const v = values || { credit: centsToInput(suggested), reason: '', expires: '' };
  const body = html`
    <p class="breadcrumb"><a href="/admin/bookings/${b.id}">Back to the booking</a></p>
    <h1>Cancel one week for ${b.child_name}?</h1>
    <p class="lede">${formatSydney(week.starts_at)} · ${week.class_name}. The place is released for someone else.</p>
    ${errorBlock(error)}
    <form method="post" action="/admin/bookings/${b.id}/cancel-week" class="booking-form confirm-box">
      ${csrfField(user.csrfToken)}
      <input type="hidden" name="session" value="${week.session_id}">
      <div class="form-group">
        <label for="credit">Credit for the family <span class="muted">(AUD — 0 for none${suggested ? `; ${formatAud(suggested)} is one week's worth` : ''})</span></label>
        <input type="text" id="credit" name="credit" value="${v.credit}" inputmode="decimal">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="reason">Reason <span class="muted">(shown with the credit)</span></label>
          <input type="text" id="reason" name="reason" value="${v.reason}" maxlength="200" placeholder="Unwell">
        </div>
        <div class="form-group">
          <label for="expires">Credit expires after <span class="muted">(optional)</span></label>
          <input type="date" id="expires" name="expires" value="${v.expires}">
        </div>
      </div>
      <button type="submit" class="button-danger">Yes, cancel this week</button>
      <a href="/admin/bookings/${b.id}" class="button-link button-secondary">Keep it</a>
    </form>
  `;
  return pageResponse('Cancel a week', body, { user, admin: true, status });
}

// GET /admin/bookings/:id/cancel-week?session=… — confirm, with the default
// credit (the booking's per-week value; editable, 0 for none).
export async function handleAdminCancelWeek(req, env, params) {
  const user = await requireAdmin(req, env);
  const b = await loadBookingRow(env, params.id);
  if (!b) throw notFound();
  const week = await loadWeek(env, b.id, String(new URL(req.url).searchParams.get('session') || ''));
  if (!week) throw notFound();
  if (week.status !== 'booked') return redirect(`/admin/bookings/${b.id}?err=week-not-booked`, 303);
  return cancelWeekPage(env, user, b, week);
}

// POST /admin/bookings/:id/cancel-week
export async function handleAdminCancelWeekPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const b = await loadBookingRow(env, params.id);
  if (!b) throw notFound();
  const week = await loadWeek(env, b.id, String(form.get('session') || ''));
  if (!week) throw notFound();
  const values = {
    credit: String(form.get('credit') || '').trim().slice(0, 12),
    reason: cleanText(form.get('reason'), 200),
    expires: String(form.get('expires') || '').trim().slice(0, 10),
  };
  const credit = optionalDollars(values.credit, 1000000);
  if (!credit.ok) return cancelWeekPage(env, user, b, week, { error: 'The credit must be an amount like 28, or 0.', status: 400, values });
  if (values.expires && !isDateStr(values.expires)) return cancelWeekPage(env, user, b, week, { error: 'The expiry is not a real date.', status: 400, values });

  const result = await cancelBookingWeek(env, {
    bookingId: b.id, sessionId: week.session_id, creditCents: credit.cents || 0,
    reason: `Week cancelled — ${formatSydney(week.starts_at, 'date')}${values.reason ? ` (${values.reason})` : ''}`,
    by: user.userId, expiresAt: values.expires ? sydneyToUtc(addDays(values.expires, 1), '00:00') : null,
  });
  if (!result.ok) {
    return redirect(`/admin/bookings/${b.id}?err=${result.error === 'not_live' ? 'booking-not-live' : 'week-not-booked'}`, 303);
  }
  return redirect(`/admin/bookings/${b.id}?ok=${result.creditId ? 'week-cancelled-credit' : 'week-cancelled'}`, 303);
}

// --- Customers ---------------------------------------------------------------------

const CUSTOMER_NOTICES = {
  'customer-updated': 'Parent details saved.',
  'notes-saved': 'Notes saved.',
  'child-added': 'Child added.',
  'child-updated': 'Child details saved. Rosters show the new details from now on; past booking records keep what was agreed then.',
  'child-archived': 'Child archived — hidden from the family’s account and new bookings. Their existing bookings stay.',
  'child-restored': 'Child restored.',
  'credit-issued': 'Credit added — it will be used automatically on the family’s next booking.',
};
const CUSTOMER_ERRORS = {
  'credit-amount': 'Please enter the credit as an amount like 30.',
  'credit-child': 'Please choose the child again.',
  'credit-expiry': 'The credit expiry is not a real date.',
};

// GET /admin/customers[?q=…]
export async function handleAdminCustomers(req, env) {
  const user = await requireAdmin(req, env);
  const query = String(new URL(req.url).searchParams.get('q') || '').slice(0, 100);
  const parents = await listCustomers(env, { query });

  const rows = parents.map((p) => {
    const children = String(p.children || '').split('|').filter(Boolean).map((entry) => {
      const m = /^(.*) \((\d{4}-\d{2}-\d{2})\)$/.exec(entry);
      return m ? `${m[1]} (${formatAge(m[2])})` : entry;
    });
    return html`
      <tr>
        <td><a href="/admin/customers/${p.id}">${p.name || '—'}</a></td>
        <td>${p.email}</td>
        <td>${p.phone || '—'}</td>
        <td>${children.length ? children.join(', ') : '—'}</td>
        <td>${p.confirmed_bookings}</td>
      </tr>
    `;
  });

  const body = html`
    <h1>Customers</h1>
    <form method="get" action="/admin/customers" class="filter-form">
      <label>Search <input type="search" name="q" value="${query}" placeholder="Name, email or child"></label>
      <button type="submit" class="button-small">Search</button>
      ${query ? html`<a href="/admin/customers">Clear</a>` : ''}
    </form>
    ${rows.length ? html`
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>Parent</th><th>Email</th><th>Phone</th><th>Children</th><th>Bookings</th></tr></thead>
          <tbody>${joinHtml(rows)}</tbody>
        </table>
      </div>
    ` : html`<p>No customers${query ? ' match that search' : ' yet'}.</p>`}
  `;
  return pageResponse('Customers', body, { user, admin: true });
}

function childForm({ action, values, csrfToken, submitLabel }) {
  return html`
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <div class="form-row">
        <div class="form-group">
          <label for="child_name">Name</label>
          <input type="text" id="child_name" name="name" value="${values.name}" required maxlength="100">
        </div>
        <div class="form-group">
          <label for="child_dob">Date of birth</label>
          <input type="date" id="child_dob" name="dob" value="${values.dob}" required>
        </div>
      </div>
      <div class="form-group">
        <label for="child_medical">Medical conditions or allergies</label>
        <textarea id="child_medical" name="medical" rows="2" maxlength="2000">${values.medical}</textarea>
      </div>
      <div class="form-group consent-group">
        <span>Photo consent:</span>
        <label><input type="radio" name="photo_consent" value="yes" ${values.photo_consent === 'yes' ? 'checked' : ''} required> Yes</label>
        <label><input type="radio" name="photo_consent" value="no" ${values.photo_consent === 'no' ? 'checked' : ''}> No</label>
      </div>
      <button type="submit" class="button-small">${submitLabel}</button>
    </form>`;
}

function readChildForm(form) {
  const values = {
    name: cleanText(form.get('name'), 100),
    dob: String(form.get('dob') || '').trim().slice(0, 10),
    medical: cleanText(form.get('medical'), 2000),
    photo_consent: isYesNo(form.get('photo_consent')) ? form.get('photo_consent') : '',
  };
  if (!isValidName(values.name)) return { values, error: 'Please enter the child’s name.' };
  const dobError = validateDob(values.dob);
  if (dobError) return { values, error: dobError };
  if (!values.photo_consent) return { values, error: 'Please choose yes or no for photo consent.' };
  return { values, error: null };
}

async function customerPage(env, user, userId, { req = null, error = '', status = 200, parentValues = null, childValues = null } = {}) {
  const now = nowIso();
  const data = await loadCustomer(env, userId, now);
  if (!data) throw notFound();
  const { user: parent, children, bookings, credits, waitlist, creditBalanceCents } = data;
  const pv = parentValues || { name: parent.name, email: parent.email, phone: parent.phone };
  const cv = childValues || { name: '', dob: '', medical: '', photo_consent: '' };

  const childRows = children.map((c) => html`
    <tr class="${c.archived_at ? 'row-cancelled' : ''}">
      <td>${c.name}${c.archived_at ? ' (archived)' : ''}</td>
      <td>${c.dob} · ${formatAge(c.dob)}</td>
      <td>${c.photo_consent ? 'Yes' : 'No'}</td>
      <td class="roster-medical">${c.medical_notes || '—'}</td>
      <td class="table-actions">
        <a href="/admin/children/${c.id}/edit">Edit</a>
        <form method="post" action="/admin/children/${c.id}/${c.archived_at ? 'restore' : 'archive'}" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-small button-secondary">${c.archived_at ? 'Restore' : 'Archive'}</button>
        </form>
      </td>
    </tr>`);
  const bookingRows = bookings.map((b) => {
    const st = effectiveStatus(b, now);
    return html`
      <tr class="${b.needs_attention ? 'row-attention' : ''}">
        <td><a href="/admin/bookings/${b.id}">${b.child_name}</a></td>
        <td>${KIND_LABELS[b.kind] || b.kind}${b.term_name ? html`<br><span class="muted">${b.term_name}</span>` : ''}</td>
        <td>${describeSessions(b.session_starts)}</td>
        <td>${paymentSummary(b, now).label}</td>
        <td><span class="status status-${st}">${st}</span></td>
      </tr>`;
  });
  const creditRows = credits.map((c) => html`
    <tr class="${creditState(c, now) === 'Active' ? '' : 'row-cancelled'}">
      <td>${formatSydney(c.issued_at, 'date')}</td>
      <td>${formatAud(c.amount_cents)}</td>
      <td>${formatAud(c.remaining_cents)}</td>
      <td>${c.child_name || 'Any child'}</td>
      <td>${c.reason || '—'}</td>
      <td>${creditState(c, now)}</td>
    </tr>`);
  const waitRows = waitlist.map((w) => html`
    <li>${w.child_name} — ${w.class_name}, ${w.term_name}: ${w.status}${w.offer_expires_at ? ` (offer until ${formatSydney(w.offer_expires_at)})` : ''}
      <span class="muted">joined ${formatSydney(w.joined_at, 'date')}</span></li>`);
  const liveChildren = children.filter((c) => !c.archived_at);

  const body = html`
    <p class="breadcrumb"><a href="/admin/customers">Customers</a></p>
    <div class="page-head">
      <h1>${parent.name || parent.email}</h1>
      <a href="/admin/bookings/new?email=${encodeURIComponent(parent.email)}" class="button-link">New booking</a>
    </div>
    ${req ? noticeFor(req, CUSTOMER_NOTICES, CUSTOMER_ERRORS) : ''}
    ${errorBlock(error)}
    <p class="lede">Customer since ${formatSydney(parent.created_at, 'date')}${parent.last_login_at ? ` · last signed in ${formatSydney(parent.last_login_at, 'date')}` : ' · has not signed in yet'}
      · credit balance ${formatAud(creditBalanceCents)}</p>
    <h2>Parent</h2>
    <form method="post" action="/admin/customers/${parent.id}/edit" class="booking-form">
      ${csrfField(user.csrfToken)}
      <div class="form-row">
        <div class="form-group">
          <label for="pname">Name</label>
          <input type="text" id="pname" name="name" value="${pv.name}" maxlength="100">
        </div>
        <div class="form-group">
          <label for="pemail">Email <span class="muted">(they sign in with this)</span></label>
          <input type="email" id="pemail" name="email" value="${pv.email}" required maxlength="254">
        </div>
        <div class="form-group">
          <label for="pphone">Phone</label>
          <input type="tel" id="pphone" name="phone" value="${pv.phone}" maxlength="20">
        </div>
      </div>
      <button type="submit" class="button-small">Save parent details</button>
    </form>
    <h2>Children</h2>
    ${childRows.length ? html`
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>Name</th><th>Born</th><th>Photos OK</th><th>Medical notes</th><th></th></tr></thead>
          <tbody>${joinHtml(childRows)}</tbody>
        </table>
      </div>` : html`<p>No children yet.</p>`}
    <details class="inline-details" ${childValues ? 'open' : ''}>
      <summary>Add a child</summary>
      ${childForm({ action: `/admin/customers/${parent.id}/children/new`, values: cv, csrfToken: user.csrfToken, submitLabel: 'Add child' })}
    </details>
    <h2>Bookings</h2>
    ${bookingRows.length ? html`
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>Child</th><th>Booking</th><th>Sessions</th><th>Payment</th><th>Status</th></tr></thead>
          <tbody>${joinHtml(bookingRows)}</tbody>
        </table>
      </div>` : html`<p>No bookings yet.</p>`}
    <h2>Credits</h2>
    ${creditRows.length ? html`
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>Issued</th><th>Amount</th><th>Left</th><th>For</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>${joinHtml(creditRows)}</tbody>
        </table>
      </div>` : html`<p>No credits.</p>`}
    <p class="form-hint"><a href="/admin/credits?show=all">All credits</a> (void a credit from there).</p>
    <details class="inline-details">
      <summary>Give a credit</summary>
      <form method="post" action="/admin/customers/${parent.id}/credit" class="booking-form">
        ${csrfField(user.csrfToken)}
        <div class="form-row">
          <div class="form-group">
            <label for="credit_amount">Amount (AUD)</label>
            <input type="text" id="credit_amount" name="amount" required inputmode="decimal">
          </div>
          <div class="form-group">
            <label for="credit_child">For</label>
            <select id="credit_child" name="child">
              <option value="">Any child</option>
              ${joinHtml(liveChildren.map((c) => html`<option value="${c.id}">${c.name}</option>`))}
            </select>
          </div>
          <div class="form-group">
            <label for="credit_expires">Expires after <span class="muted">(optional)</span></label>
            <input type="date" id="credit_expires" name="expires">
          </div>
        </div>
        <div class="form-group">
          <label for="credit_reason">Reason</label>
          <input type="text" id="credit_reason" name="reason" maxlength="200" placeholder="Make-up for a missed class">
        </div>
        <button type="submit" class="button-small">Add credit</button>
      </form>
    </details>
    ${waitRows.length ? html`<h2>Waitlists</h2><ul>${joinHtml(waitRows)}</ul>` : ''}
    <h2>Notes</h2>
    <form method="post" action="/admin/customers/${parent.id}/notes" class="booking-form">
      ${csrfField(user.csrfToken)}
      <label for="customer_notes" class="sr-only">Notes (only you see these)</label>
      <textarea id="customer_notes" name="notes" rows="4" maxlength="5000">${parent.admin_notes}</textarea>
      <button type="submit" class="button-small">Save notes</button>
    </form>
  `;
  return pageResponse(parent.name || 'Customer', body, { user, admin: true, status });
}

// GET /admin/customers/:id
export async function handleAdminCustomer(req, env, params) {
  const user = await requireAdmin(req, env);
  return customerPage(env, user, params.id, { req });
}

// POST /admin/customers/:id/edit — name, email (unique), phone.
export async function handleAdminCustomerEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const parent = await env.DB.prepare(`SELECT id, email FROM users WHERE id = ?1`).bind(params.id).first();
  if (!parent) throw notFound();
  const values = {
    name: cleanText(form.get('name'), 100),
    email: normaliseEmail(form.get('email')).slice(0, 254),
    phone: normalisePhone(form.get('phone')).slice(0, 20),
  };
  const again = (error) => customerPage(env, user, parent.id, { error, status: 400, parentValues: values });
  if (!isValidEmail(values.email)) return again('Please enter a full email address.');
  if (values.phone && !isValidAuPhone(values.phone)) return again('That phone number doesn’t look right — use 8 to 12 digits.');
  const emailChanged = values.email !== parent.email;
  // Security: rights come from the email allowlists, so an email change must
  // never turn a family account into an owner/facilitator one (or rename one).
  if (emailChanged && roleFor(env, parent.email) !== 'parent') {
    return again('This is an owner or facilitator account — its email can’t be changed here.');
  }
  if (emailChanged && roleFor(env, values.email) !== 'parent') {
    return again('That address belongs to the owner or a facilitator — please use the family’s own email.');
  }
  const taken = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1 AND id != ?2`).bind(values.email, parent.id).first();
  if (taken) return again('Another account already uses that email address.');
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET name = ?2, email = ?3, phone = ?4 WHERE id = ?1`)
        .bind(parent.id, values.name, values.email, values.phone),
      // A new sign-in address signs the account out everywhere.
      ...(emailChanged ? [env.DB.prepare(`DELETE FROM web_sessions WHERE user_id = ?1`).bind(parent.id)] : []),
    ]);
  } catch (err) {
    if (isConstraintError(err)) return again('Another account already uses that email address.');
    throw err;
  }
  logEvent('customer_updated', { user_id: parent.id.slice(0, 8), email_changed: emailChanged, by: user.userId.slice(0, 8) });
  return redirect(`/admin/customers/${parent.id}?ok=customer-updated`, 303);
}

// POST /admin/customers/:id/notes
export async function handleAdminCustomerNotes(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req, 32 * 1024);
  requireCsrf(req, user, form);
  const result = await env.DB.prepare(`UPDATE users SET admin_notes = ?2 WHERE id = ?1`)
    .bind(params.id, cleanText(form.get('notes'), 5000)).run();
  if (result.meta.changes === 0) throw notFound();
  return redirect(`/admin/customers/${params.id}?ok=notes-saved`, 303);
}

// POST /admin/customers/:id/children/new
export async function handleAdminChildNew(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const parent = await env.DB.prepare(`SELECT id FROM users WHERE id = ?1`).bind(params.id).first();
  if (!parent) throw notFound();
  const { values, error } = readChildForm(form);
  if (error) return customerPage(env, user, parent.id, { error, status: 400, childValues: values });
  await createChild(env, {
    userId: parent.id, name: values.name, dob: values.dob, medicalNotes: values.medical,
    photoConsent: values.photo_consent === 'yes',
  });
  logEvent('child_added_by_admin', { user_id: parent.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/customers/${parent.id}?ok=child-added`, 303);
}

async function loadChild(env, childId) {
  return env.DB.prepare(
    `SELECT c.id, c.user_id, c.name, c.dob, c.medical_notes, c.photo_consent, c.archived_at, u.name AS parent_name, u.email AS parent_email
     FROM children c JOIN users u ON u.id = c.user_id WHERE c.id = ?1`,
  ).bind(childId).first();
}

function childEditPage(user, child, values, { error = '', status = 200 } = {}) {
  const body = html`
    <p class="breadcrumb"><a href="/admin/customers/${child.user_id}">${child.parent_name || child.parent_email}</a></p>
    <h1>Edit ${child.name}</h1>
    <p class="lede">Changes show on rosters from now on. Each booking keeps the consent and notes agreed when it was made,
      and the roster always shows the stricter photo consent.</p>
    ${errorBlock(error)}
    ${childForm({ action: `/admin/children/${child.id}/edit`, values, csrfToken: user.csrfToken, submitLabel: 'Save child' })}
  `;
  return pageResponse(`Edit ${child.name}`, body, { user, admin: true, status });
}

// GET /admin/children/:id/edit
export async function handleAdminChildEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const child = await loadChild(env, params.id);
  if (!child) throw notFound();
  return childEditPage(user, child, {
    name: child.name, dob: child.dob, medical: child.medical_notes, photo_consent: child.photo_consent ? 'yes' : 'no',
  });
}

// POST /admin/children/:id/edit
export async function handleAdminChildEditPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const child = await loadChild(env, params.id);
  if (!child) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const { values, error } = readChildForm(form);
  if (error) return childEditPage(user, child, values, { error, status: 400 });
  await env.DB.prepare(
    `UPDATE children SET name = ?2, dob = ?3, medical_notes = ?4, photo_consent = ?5 WHERE id = ?1`,
  ).bind(child.id, values.name, values.dob, values.medical, values.photo_consent === 'yes' ? 1 : 0).run();
  logEvent('child_updated_by_admin', { child_id: child.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/customers/${child.user_id}?ok=child-updated`, 303);
}

// POST /admin/children/:id/archive | /restore — reversible.
async function setChildArchived(req, env, params, archived) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const child = await loadChild(env, params.id);
  if (!child) throw notFound();
  await env.DB.prepare(`UPDATE children SET archived_at = ?2 WHERE id = ?1`)
    .bind(child.id, archived ? nowIso() : null).run();
  logEvent(archived ? 'child_archived_by_admin' : 'child_restored_by_admin', { child_id: child.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/customers/${child.user_id}?ok=${archived ? 'child-archived' : 'child-restored'}`, 303);
}

export const handleAdminChildArchive = (req, env, params) => setChildArchived(req, env, params, true);
export const handleAdminChildRestore = (req, env, params) => setChildArchived(req, env, params, false);

export function registerRoutes(route) {
  route('GET', '/admin/bookings', handleAdminBookings);
  route('POST', '/admin/bookings.csv', handleAdminBookingsCsv);
  route('GET', '/admin/bookings/:id', handleAdminBooking);
  route('POST', '/admin/bookings/:id/notes', handleAdminBookingNotes);
  route('POST', '/admin/bookings/:id/record-payment', handleAdminRecordPayment);
  route('POST', '/admin/bookings/:id/adjustment', handleAdminAdjustment);
  route('GET', '/admin/bookings/:id/cancel', handleAdminCancelBookingConfirm);
  route('POST', '/admin/bookings/:id/cancel', handleAdminCancelBooking);
  route('POST', '/admin/bookings/:id/restore', handleAdminRestoreBooking);
  route('GET', '/admin/bookings/:id/transfer', handleAdminTransfer);
  route('POST', '/admin/bookings/:id/transfer', handleAdminTransferPost);
  route('GET', '/admin/bookings/:id/cancel-week', handleAdminCancelWeek);
  route('POST', '/admin/bookings/:id/cancel-week', handleAdminCancelWeekPost);
  route('GET', '/admin/customers', handleAdminCustomers);
  route('GET', '/admin/customers/:id', handleAdminCustomer);
  route('POST', '/admin/customers/:id/edit', handleAdminCustomerEdit);
  route('POST', '/admin/customers/:id/notes', handleAdminCustomerNotes);
  route('POST', '/admin/customers/:id/children/new', handleAdminChildNew);
  route('GET', '/admin/children/:id/edit', handleAdminChildEdit);
  route('POST', '/admin/children/:id/edit', handleAdminChildEditPost);
  route('POST', '/admin/children/:id/archive', handleAdminChildArchive);
  route('POST', '/admin/children/:id/restore', handleAdminChildRestore);
}
