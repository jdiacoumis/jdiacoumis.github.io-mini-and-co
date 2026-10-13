// Admin: bookings list (status filter, money columns from the ledger),
// "Record offline payment", cancellation, customers list, bookings CSV.
// Phase 2B owns this file.
//
// Security: admin-only (live allowlist re-check per request); state changes
// are POST + CSRF and go through lib/domain.js, which validates the booking's
// CURRENT state: an offline payment confirms a pending or expired booking only
// through the capacity-guarded path (never overselling), repeated submissions
// are idempotent (a per-form nonce keys the ledger row), and cancellation
// releases seats atomically.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, HttpError } from '../lib/http.js';
import { uuid } from '../lib/db.js';
import { formatSydney, formatAge } from '../lib/time.js';
import { isValidId, cleanText, parseDollarsToCents } from '../lib/validate.js';
import {
  effectiveStatus, formatAud, confirmBooking, cancelBooking, KIND_LABELS, PAYMENT_STATUS_LABELS,
  NEEDS_ATTENTION_LABELS,
} from '../lib/domain.js';
import { recordPayment } from '../lib/ledger.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { csvResponse } from '../lib/csv.js';
import { logEvent, logError } from '../lib/log.js';

const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired'];
const OFFLINE_METHODS = ['cash', 'bank transfer', 'card (in person)', 'other'];

const NOTICES = {
  'payment-recorded': 'Payment recorded.',
  'payment-confirmed': 'Payment recorded and the booking is confirmed.',
  'paid-no-seat': 'Payment recorded, but the booking could not be confirmed — its seat has been taken. It is flagged under Needs attention.',
  cancelled: 'Booking cancelled and its seats released.',
  'cancelled-plan-warning': 'Booking cancelled, but the instalment plan could not be stopped in Stripe — please cancel the subscription in the Stripe dashboard.',
};

// Bookings with parent/child/term/session detail; optionally filtered by
// status. An unrecognised filter value is treated as "no filter".
async function loadBookings(env, statusFilter) {
  const stmt = env.DB.prepare(
    `SELECT b.id, b.kind, b.status, b.amount_cents, b.paid_cents, b.list_amount_cents, b.discount_cents,
            b.credit_cents, b.payment_method, b.payment_status, b.payment_provider, b.paid_at, b.created_at,
            b.expires_at, b.needs_attention,
            u.name AS parent_name, u.email AS parent_email, ch.name AS child_name, t.name AS term_name,
            (SELECT GROUP_CONCAT(cs.starts_at, '|') FROM booking_sessions bs
             JOIN class_sessions cs ON cs.id = bs.session_id
             WHERE bs.booking_id = b.id AND bs.status = 'booked') AS session_starts
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     LEFT JOIN terms t ON t.id = b.term_id
     ${statusFilter ? 'WHERE b.status = ?1' : ''}
     ORDER BY b.created_at DESC
     LIMIT 500`,
  );
  const result = statusFilter ? await stmt.bind(statusFilter).all() : await stmt.all();
  return result.results || [];
}

function describeSessions(sessionStarts) {
  const starts = String(sessionStarts || '').split('|').filter(Boolean).sort();
  if (starts.length > 2) return `${formatSydney(starts[0], 'date')} – ${formatSydney(starts[starts.length - 1], 'date')} (${starts.length} weeks)`;
  return starts.map((s) => formatSydney(s)).join('; ') || '—';
}

// Money still to collect. Account credit joins the ledger (credit_applied)
// only when the booking is confirmed, so before that it is not "owed".
function outstanding(b) {
  const creditNotYetApplied = b.status === 'confirmed' ? 0 : b.credit_cents;
  return Math.max(0, b.amount_cents + b.credit_cents - creditNotYetApplied - b.paid_cents);
}

function recordPaymentForm(b, csrfToken) {
  const methods = OFFLINE_METHODS.map((m) => html`<option value="${m}">${m}</option>`);
  return html`
    <details class="inline-details">
      <summary>Record offline payment</summary>
      <form method="post" action="/admin/bookings/${b.id}/record-payment" class="inline-form record-payment-form">
        ${csrfField(csrfToken)}
        <input type="hidden" name="nonce" value="${uuid()}">
        <label>Amount (AUD) <input type="text" name="amount" value="${(outstanding(b) / 100).toFixed(2)}" required size="8"></label>
        <label>Method <select name="method">${joinHtml(methods)}</select></label>
        <label>Note <input type="text" name="note" maxlength="200"></label>
        <button type="submit" class="button-small">Record payment</button>
      </form>
    </details>
  `;
}

// GET /admin/bookings[?status=…]
export async function handleAdminBookings(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const requested = url.searchParams.get('status');
  const statusFilter = BOOKING_STATUSES.includes(requested) ? requested : null;
  const noticeText = NOTICES[url.searchParams.get('ok')];

  const bookings = await loadBookings(env, statusFilter);
  const filterLinks = [html`<a href="/admin/bookings" class="${statusFilter ? '' : 'filter-active'}">All</a>`]
    .concat(BOOKING_STATUSES.map((s) => html`
      <a href="/admin/bookings?status=${s}" class="${statusFilter === s ? 'filter-active' : ''}">${s}</a>
    `));

  const rows = bookings.map((b) => {
    const status = effectiveStatus(b);
    const canRecord = status !== 'cancelled' && b.kind !== 'complimentary' && outstanding(b) > 0;
    return html`
      <tr class="${b.needs_attention ? 'row-attention' : ''}">
        <td>${b.parent_name || '—'}<br><span class="muted">${b.parent_email}</span></td>
        <td>${b.child_name}</td>
        <td>${KIND_LABELS[b.kind] || b.kind}${b.term_name ? html`<br><span class="muted">${b.term_name}</span>` : ''}</td>
        <td>${describeSessions(b.session_starts)}</td>
        <td>${formatAud(b.amount_cents + b.credit_cents)}</td>
        <td>${formatAud(b.paid_cents)}</td>
        <td>${PAYMENT_STATUS_LABELS[b.payment_status] || b.payment_status}
          ${b.needs_attention ? html`<br><span class="attention-flag">${NEEDS_ATTENTION_LABELS[b.needs_attention] || b.needs_attention}</span>` : ''}</td>
        <td><span class="status status-${status}">${status}</span></td>
        <td class="table-actions">
          ${canRecord ? recordPaymentForm(b, user.csrfToken) : ''}
          ${b.status === 'pending' || b.status === 'confirmed' ? html`
            <form method="post" action="/admin/bookings/${b.id}/cancel" class="inline-form">
              ${csrfField(user.csrfToken)}
              <button type="submit" class="button-small button-secondary">Cancel</button>
            </form>
          ` : ''}
        </td>
      </tr>
    `;
  });

  const body = html`
    <h1>Bookings</h1>
    ${noticeText ? html`<p class="form-notice" role="status">${noticeText}</p>` : ''}
    <p class="filter-links">Filter: ${joinHtml(filterLinks, ' · ')}</p>
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Parent</th><th>Child</th><th>Booking</th><th>Session(s)</th><th>Owed</th><th>Paid</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
      <form method="post" action="/admin/bookings.csv" class="inline-form">
        ${csrfField(user.csrfToken)}
        ${statusFilter ? html`<input type="hidden" name="status" value="${statusFilter}">` : ''}
        <button type="submit" class="button-secondary">Download bookings CSV</button>
      </form>
    ` : html`<p>No bookings${statusFilter ? html` with status “${statusFilter}”` : ''}.</p>`}
  `;
  return pageResponse('Bookings', body, { user, admin: true });
}

// POST /admin/bookings/:id/record-payment — "Record offline payment" (cash,
// bank transfer, …). On a pending or expired booking this confirms it through
// the same capacity-guarded path as a card payment; on a confirmed booking it
// just adds the ledger row. The form's nonce makes a double submit harmless.
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
  if (!isValidId(nonce)) throw new HttpError(400, 'That form has expired — please reload the bookings page and try again.');
  const method = OFFLINE_METHODS.includes(form.get('method')) ? form.get('method') : 'other';
  const payment = {
    kind: 'offline', amountCents, providerRef: `offline:${nonce}`, method,
    note: cleanText(form.get('note'), 200), recordedBy: user.userId,
  };

  if (booking.status === 'confirmed') {
    await recordPayment(env, { ...payment, bookingId: booking.id });
    logEvent('offline_payment_recorded', { booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8) });
    return redirect('/admin/bookings?ok=payment-recorded', 303);
  }

  // Pending: stop a live Stripe checkout so the family cannot pay twice.
  if (booking.status === 'pending' && booking.payment_ref) {
    try {
      await getPaymentsDriver(env).expireCheckout(booking.payment_ref);
    } catch (err) {
      logError('checkout_expire_failed', err, { booking_id: booking.id.slice(0, 8) });
    }
  }
  const result = await confirmBooking(env, booking.id, { provider: 'external', payment });
  logEvent('offline_payment_recorded', {
    booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8), outcome: result.ok ? 'confirmed' : result.error,
  });
  if (result.ok) return redirect('/admin/bookings?ok=payment-confirmed', 303);
  if (result.error === 'paid_no_seat') return redirect('/admin/bookings?ok=paid-no-seat', 303);
  throw new HttpError(409, 'The booking changed while you were looking at it — please review it again.');
}

// POST /admin/bookings/:id/cancel — cancel a pending or confirmed booking,
// releasing its seats. Refunds, where owed, are made in the Stripe dashboard.
export async function handleAdminCancelBooking(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const result = await cancelBooking(env, params.id, {
    by: user.userId, reason: cleanText(form.get('reason'), 500),
  });
  if (!result.ok && result.error === 'not_found') throw notFound('That booking does not exist.');
  if (!result.ok) throw new HttpError(409, `This booking is already ${result.error === 'state_changed' ? 'changed' : result.error}.`);
  logEvent('booking_cancelled_by_admin', { booking_id: params.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/bookings?ok=${result.subscriptionStopped === false ? 'cancelled-plan-warning' : 'cancelled'}`, 303);
}

// POST /admin/bookings.csv — export the (optionally filtered) bookings list.
export async function handleAdminBookingsCsv(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const requested = String(form.get('status') || '');
  const statusFilter = BOOKING_STATUSES.includes(requested) ? requested : null;
  const bookings = await loadBookings(env, statusFilter);
  logEvent('bookings_exported', { rows: bookings.length });

  return csvResponse(
    `bookings${statusFilter ? `-${statusFilter}` : ''}.csv`,
    ['Created', 'Parent', 'Email', 'Child', 'Kind', 'Term', 'Sessions (Sydney)', 'List', 'Discount', 'Credit',
      'Owed', 'Paid', 'Payment status', 'Status', 'Needs attention', 'Paid at'],
    bookings.map((b) => [
      b.created_at,
      b.parent_name,
      b.parent_email,
      b.child_name,
      KIND_LABELS[b.kind] || b.kind,
      b.term_name || '',
      describeSessions(b.session_starts),
      formatAud(b.list_amount_cents),
      formatAud(b.discount_cents),
      formatAud(b.credit_cents),
      formatAud(b.amount_cents + b.credit_cents),
      formatAud(b.paid_cents),
      PAYMENT_STATUS_LABELS[b.payment_status] || b.payment_status,
      effectiveStatus(b),
      b.needs_attention ? NEEDS_ATTENTION_LABELS[b.needs_attention] || b.needs_attention : '',
      b.paid_at || '',
    ]),
  );
}

// GET /admin/customers — every parent account with their children and ages.
export async function handleAdminCustomers(req, env) {
  const user = await requireAdmin(req, env);

  const parents = (await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.created_at,
            (SELECT GROUP_CONCAT(c.name || ' (' || c.dob || ')', '|')
             FROM children c WHERE c.user_id = u.id AND c.archived_at IS NULL) AS children
     FROM users u
     WHERE u.role = 'parent'
     ORDER BY u.created_at DESC
     LIMIT 1000`,
  ).all()).results || [];

  const rows = parents.map((p) => {
    const children = String(p.children || '').split('|').filter(Boolean).map((entry) => {
      const m = /^(.*) \((\d{4}-\d{2}-\d{2})\)$/.exec(entry);
      return m ? `${m[1]} (${formatAge(m[2])})` : entry;
    });
    return html`
      <tr>
        <td>${p.name || '—'}</td>
        <td>${p.email}</td>
        <td>${p.phone || '—'}</td>
        <td>${children.length ? children.join(', ') : '—'}</td>
      </tr>
    `;
  });

  const body = html`
    <h1>Customers</h1>
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Parent</th><th>Email</th><th>Phone</th><th>Children</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
    ` : html`<p>No customers yet.</p>`}
  `;
  return pageResponse('Customers', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/bookings', handleAdminBookings);
  route('POST', '/admin/bookings/:id/record-payment', handleAdminRecordPayment);
  route('POST', '/admin/bookings/:id/cancel', handleAdminCancelBooking);
  route('POST', '/admin/bookings.csv', handleAdminBookingsCsv);
  route('GET', '/admin/customers', handleAdminCustomers);
}
