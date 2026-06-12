// Admin: bookings list with status filtering, manual mark-as-paid and
// cancellation, customers list, bookings CSV export.
//
// Security: admin-only (server-side role re-check per request); state changes
// are POST + CSRF and validate the booking's CURRENT state (a cancelled or
// expired booking can never be marked paid; repeating mark-as-paid never
// rewrites the original payment record).

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound } from '../lib/http.js';
import { HttpError } from '../lib/http.js';
import { nowIso } from '../lib/db.js';
import { formatSydney, formatAge } from '../lib/time.js';
import { effectiveStatus, formatAud } from '../lib/domain.js';
import { csvResponse } from '../lib/csv.js';
import { adminNav } from './admin.js';
import { logEvent } from '../lib/log.js';

const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired'];

const NOTICES = {
  'marked-paid': 'Booking marked as paid.',
  'already-paid': 'That booking was already paid — the original payment record is unchanged.',
  cancelled: 'Booking cancelled and its seats released.',
};

// Bookings with parent/child/session detail; optionally filtered by status.
// An unrecognised filter value is treated as "no filter" (admin-portal spec).
async function loadBookings(env, statusFilter) {
  const where = statusFilter ? 'WHERE b.status = ?1' : '';
  const stmt = env.DB.prepare(
    `SELECT b.id, b.status, b.amount_cents, b.payment_provider, b.paid_at,
            b.created_at, b.expires_at,
            u.name AS parent_name, u.email AS parent_email,
            ch.name AS child_name,
            (SELECT GROUP_CONCAT(cs.starts_at, '|') FROM booking_sessions bs
             JOIN class_sessions cs ON cs.id = bs.session_id
             WHERE bs.booking_id = b.id) AS session_starts
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     ${where}
     ORDER BY b.created_at DESC
     LIMIT 500`,
  );
  const result = statusFilter ? await stmt.bind(statusFilter).all() : await stmt.all();
  return result.results || [];
}

function describeSessions(sessionStarts) {
  const starts = String(sessionStarts || '').split('|').filter(Boolean).sort();
  return starts.map((s) => formatSydney(s)).join('; ') || '—';
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
    return html`
      <tr>
        <td>${b.parent_name || '—'}<br><span class="muted">${b.parent_email}</span></td>
        <td>${b.child_name}</td>
        <td>${describeSessions(b.session_starts)}</td>
        <td>${formatAud(b.amount_cents)}</td>
        <td>${b.payment_provider || '—'}</td>
        <td><span class="status status-${status}">${status}</span></td>
        <td class="table-actions">
          ${b.status === 'pending' ? html`
            <form method="post" action="/admin/bookings/${b.id}/mark-paid" class="inline-form">
              ${csrfField(user.csrfToken)}
              <button type="submit" class="button-small">Mark paid</button>
            </form>
          ` : ''}
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
    ${adminNav()}
    ${noticeText ? html`<p class="form-notice" role="status">${noticeText}</p>` : ''}
    <p class="filter-links">Filter: ${joinHtml(filterLinks, ' · ')}</p>
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Parent</th><th>Child</th><th>Session(s)</th><th>Amount</th><th>Provider</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
      <form method="post" action="/admin/bookings.csv" class="inline-form">
        ${csrfField(user.csrfToken)}
        ${statusFilter ? html`<input type="hidden" name="status" value="${statusFilter}">` : ''}
        <button type="submit" class="button-secondary">Download bookings CSV</button>
      </form>
    ` : html`<p>No bookings${statusFilter ? html` with status “${statusFilter}”` : ''}.</p>`}
  `;
  return pageResponse('Bookings', body, { user });
}

// POST /admin/bookings/:id/mark-paid — record an offline (bank transfer /
// external) payment against a pending booking.
export async function handleAdminMarkPaid(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const booking = await env.DB.prepare(
    `SELECT id, status FROM bookings WHERE id = ?1`,
  ).bind(params.id).first();
  if (!booking) throw notFound('That booking does not exist.');

  if (booking.status === 'confirmed') {
    // Idempotent: never rewrite the original payment record.
    return redirect('/admin/bookings?ok=already-paid', 303);
  }
  if (booking.status !== 'pending') {
    throw new HttpError(409, `This booking is ${booking.status} — a ${booking.status} booking cannot be marked as paid.`);
  }

  const result = await env.DB.prepare(
    `UPDATE bookings
     SET status = 'confirmed', payment_provider = 'external', paid_at = ?2
     WHERE id = ?1 AND status = 'pending'`,
  ).bind(booking.id, nowIso()).run();

  if (result.meta.changes === 0) {
    throw new HttpError(409, 'The booking changed state while you were looking at it — please review it again.');
  }

  logEvent('booking_marked_paid', { booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect('/admin/bookings?ok=marked-paid', 303);
}

// POST /admin/bookings/:id/cancel — cancel a pending or confirmed booking,
// releasing its seats (cancelled bookings never count towards fullness).
// Refunds, where owed, are handled in the Stripe dashboard.
export async function handleAdminCancelBooking(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const booking = await env.DB.prepare(
    `SELECT id, status FROM bookings WHERE id = ?1`,
  ).bind(params.id).first();
  if (!booking) throw notFound('That booking does not exist.');

  if (booking.status !== 'pending' && booking.status !== 'confirmed') {
    throw new HttpError(409, `This booking is already ${booking.status}.`);
  }

  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'confirmed')`,
  ).bind(booking.id).run();

  logEvent('booking_cancelled_by_admin', { booking_id: booking.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect('/admin/bookings?ok=cancelled', 303);
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
    ['Created', 'Parent', 'Email', 'Child', 'Sessions (Sydney)', 'Amount', 'Provider', 'Status', 'Paid at'],
    bookings.map((b) => [
      b.created_at,
      b.parent_name,
      b.parent_email,
      b.child_name,
      describeSessions(b.session_starts),
      formatAud(b.amount_cents),
      b.payment_provider || '',
      effectiveStatus(b),
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
    ${adminNav()}
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Parent</th><th>Email</th><th>Phone</th><th>Children</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
    ` : html`<p>No customers yet.</p>`}
  `;
  return pageResponse('Customers', body, { user });
}
