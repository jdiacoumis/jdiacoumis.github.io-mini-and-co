// Parent account area: dashboard (profile, children, bookings) and profile
// editing. Everything here is scoped to the signed-in account.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect } from '../lib/http.js';
import { isValidName, isValidAuPhone, normalisePhone, cleanText } from '../lib/validate.js';
import { formatSydney, formatAge } from '../lib/time.js';
import { listUserBookings, effectiveStatus, formatAud } from '../lib/domain.js';
import { logEvent } from '../lib/log.js';

const STATUS_LABELS = {
  pending: 'Awaiting payment',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  expired: 'Not completed',
};

// GET /account — the parent dashboard.
export async function handleAccountDashboard(req, env) {
  const user = await requireAuthOrRedirect(req, env);

  const children = (await env.DB.prepare(
    `SELECT id, name, dob FROM children
     WHERE user_id = ?1 AND archived_at IS NULL ORDER BY created_at`,
  ).bind(user.userId).all()).results || [];

  const bookings = await listUserBookings(env, user.userId);

  const childItems = children.map((c) => html`
    <li>${c.name} (${formatAge(c.dob)}) — <a href="/account/children/${c.id}/edit">edit</a></li>
  `);

  const bookingRows = bookings.map((b) => {
    const status = effectiveStatus(b);
    const starts = String(b.session_starts || '').split('|').filter(Boolean).sort();
    const when = starts.map((s) => formatSydney(s)).join('; ');
    return html`
      <tr>
        <td><a href="/book/confirm?booking=${b.id}">${when || '—'}</a></td>
        <td>${b.child_name}</td>
        <td>${formatAud(b.amount_cents)}</td>
        <td><span class="status status-${status}">${STATUS_LABELS[status] || status}</span></td>
      </tr>
    `;
  });

  const body = html`
    <div class="page-head">
      <h1>My account</h1>
      <a href="/book" class="button-link">Book a class</a>
    </div>
    <p class="account-signed-in">Signed in as ${user.email}</p>

    <section class="account-section">
      <h2>My bookings</h2>
      ${bookings.length ? html`
        <table class="booking-table">
          <thead><tr><th>Session(s)</th><th>Child</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>${joinHtml(bookingRows)}</tbody>
        </table>
      ` : html`<p>No bookings yet — <a href="/book">grab a spot in the next class</a>.</p>`}
    </section>

    <section class="account-section">
      <h2>My children</h2>
      ${children.length
        ? html`<ul class="account-children">${joinHtml(childItems)}</ul>`
        : html`<p>No children added yet — <a href="/account/children/new">add your little one</a> to start booking.</p>`}
      <p><a href="/account/children">Manage children</a></p>
    </section>

    <section class="account-section">
      <h2>My details</h2>
      <p>${user.name ? html`${user.name}` : html`<em>No name on file yet</em>`}${user.phone ? html` · ${user.phone}` : ''}
        · <a href="/account/profile">Update</a></p>
    </section>
  `;
  return pageResponse('My account', body, { user });
}

function profileForm(user, values, error = '') {
  return html`
    <h1>My details</h1>
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="/account/profile" class="booking-form">
      ${csrfField(user.csrfToken)}
      <div class="form-group">
        <label for="name">Your name</label>
        <input type="text" id="name" name="name" value="${values.name}" required maxlength="100" autocomplete="name">
      </div>
      <div class="form-group">
        <label for="phone">Mobile number (so we can reach you about class changes)</label>
        <input type="tel" id="phone" name="phone" value="${values.phone}" autocomplete="tel">
      </div>
      <button type="submit">Save details</button>
    </form>
    <p><a href="/account">Back to my account</a></p>
  `;
}

// GET /account/profile — edit name and phone.
export async function handleProfile(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  return pageResponse('My details', profileForm(user, { name: user.name, phone: user.phone }), { user });
}

// POST /account/profile — save name and phone.
export async function handleProfilePost(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const values = {
    name: cleanText(form.get('name'), 100),
    phone: normalisePhone(form.get('phone')),
  };

  if (!isValidName(values.name)) {
    return pageResponse('My details', profileForm(user, values, 'Please enter your name (up to 100 characters).'), { user, status: 400 });
  }
  if (values.phone && !isValidAuPhone(values.phone)) {
    return pageResponse('My details', profileForm(user, values, 'That phone number does not look right — please check it (e.g. 0412 345 678).'), { user, status: 400 });
  }

  await env.DB.prepare(
    `UPDATE users SET name = ?1, phone = ?2 WHERE id = ?3`,
  ).bind(values.name, values.phone, user.userId).run();

  logEvent('profile_updated', { user_id: user.userId.slice(0, 8) });
  return redirect('/account', 303);
}
