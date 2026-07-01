// Admin portal: dashboard, class and session management, per-session rosters.
//
// Security: every handler starts with requireAdmin (server-side role re-check
// on each request, denials logged and rate limited); all state changes verify
// the per-session CSRF token; CSV exports are POST + CSRF and neutralise
// formula injection (lib/csv.js). Times are entered and rendered in
// Australia/Sydney and stored as UTC.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, badRequest } from '../lib/http.js';
import { uuid, nowIso } from '../lib/db.js';
import { isValidId, cleanText, parseIntInRange, parseDollarsToCents } from '../lib/validate.js';
import { sydneyToUtc, formatSydney, sydneyFields, formatAge } from '../lib/time.js';
import { listSessionsWithFullness, formatAud, sweepExpiredBookings } from '../lib/domain.js';
import { csvResponse } from '../lib/csv.js';
import { logEvent } from '../lib/log.js';

const MAX_REPEAT_WEEKS = 52;

// Post-redirect-get notices, allowlisted by key so nothing user-controlled is
// ever reflected from the query string.
const NOTICES = {
  'class-created': 'Class created.',
  'class-updated': 'Class updated.',
  'sessions-created': 'Session(s) created.',
  'session-updated': 'Session updated.',
};

function notice(req) {
  const key = new URL(req.url).searchParams.get('ok');
  const text = NOTICES[key];
  return text ? html`<p class="form-notice" role="status">${text}</p>` : html``;
}

export function adminNav() {
  return html`
    <nav class="admin-nav">
      <a href="/admin">Schedule</a>
      <a href="/admin/classes">Classes</a>
      <a href="/admin/bookings">Bookings</a>
      <a href="/admin/customers">Customers</a>
      <a href="/admin/import">Import</a>
    </nav>
  `;
}

// Calendar-safe date addition on a YYYY-MM-DD string (UTC arithmetic on the
// date part only — combined with sydneyToUtc per occurrence this preserves
// the Sydney wall-clock time across AEST/AEDT transitions).
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// GET /admin[?class=…&term=…] — dashboard: upcoming sessions in
// chronological order with fullness (confirmed + unexpired pending) out of
// capacity, optionally filtered to one class/term (linked from Classes).
export async function handleAdminDashboard(req, env) {
  const user = await requireAdmin(req, env);
  await sweepExpiredBookings(env);

  const url = new URL(req.url);
  const classFilter = isValidId(url.searchParams.get('class') || '') ? url.searchParams.get('class') : null;
  const termFilter = cleanText(url.searchParams.get('term'), 50) || null;

  let sessions = await listSessionsWithFullness(env, { upcomingOnly: true });
  if (classFilter) sessions = sessions.filter((s) => s.class_id === classFilter);
  if (termFilter) sessions = sessions.filter((s) => (s.term_label || '') === termFilter);

  const rows = sessions.map((s) => html`
    <tr class="${s.status === 'cancelled' ? 'row-cancelled' : ''}">
      <td><a href="/admin/sessions/${s.id}/roster">${formatSydney(s.starts_at)}</a></td>
      <td>${s.class_name}${s.class_active ? '' : ' (class inactive)'}</td>
      <td>${s.term_label || '—'}</td>
      <td>${s.seats_held}/${s.capacity}</td>
      <td>${formatAud(s.price_cents)}</td>
      <td>${s.status === 'cancelled' ? 'Cancelled' : 'Scheduled'}</td>
      <td class="table-actions"><a href="/admin/sessions/${s.id}/edit">Edit</a></td>
    </tr>
  `);

  const body = html`
    <h1>Admin</h1>
    ${adminNav()}
    ${notice(req)}
    <h2>Upcoming sessions</h2>
    ${classFilter || termFilter ? html`
      <p class="form-notice">Filtered${termFilter ? html` to ${termFilter}` : ''} — <a href="/admin">show everything</a></p>
    ` : ''}
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>When (Sydney)</th><th>Class</th><th>Term</th><th>Seats</th><th>Price</th><th>Status</th><th></th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
    ` : html`<p>No upcoming sessions${classFilter || termFilter ? ' match this filter' : ''}. <a href="/admin/sessions/new">Create some</a>.</p>`}
    <p><a href="/admin/sessions/new" class="button-link">Add sessions</a></p>
  `;
  return pageResponse('Admin', body, { user });
}

// --- Classes -----------------------------------------------------------------

function classForm({ action, values, error = '', csrfToken, submitLabel, showActive = false }) {
  return html`
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <div class="form-group">
        <label for="name">Class name</label>
        <input type="text" id="name" name="name" value="${values.name}" required maxlength="100">
      </div>
      <div class="form-group">
        <label for="description">Description</label>
        <textarea id="description" name="description" rows="3" maxlength="2000">${values.description}</textarea>
      </div>
      <div class="form-group">
        <label for="venue">Venue</label>
        <input type="text" id="venue" name="venue" value="${values.venue}" maxlength="200">
      </div>
      <div class="form-group">
        <label for="age_range">Age range (e.g. 3–12 months)</label>
        <input type="text" id="age_range" name="age_range" value="${values.age_range}" maxlength="100">
      </div>
      ${showActive ? html`
        <div class="form-group">
          <label><input type="checkbox" name="active" value="1" ${values.active ? 'checked' : ''}>
            Active (visible on the public class list)</label>
        </div>
      ` : ''}
      <button type="submit">${submitLabel}</button>
    </form>
  `;
}

function readClassForm(form) {
  const values = {
    name: cleanText(form.get('name'), 100),
    description: cleanText(form.get('description'), 2000),
    venue: cleanText(form.get('venue'), 200),
    age_range: cleanText(form.get('age_range'), 100),
    active: form.get('active') ? 1 : 0,
  };
  const error = values.name ? null : 'Please give the class a name.';
  return { values, error };
}

// GET /admin/classes — every class with its terms (label, date range,
// session count) so the schedule is organised the way it's sold.
export async function handleAdminClasses(req, env) {
  const user = await requireAdmin(req, env);
  const classes = (await env.DB.prepare(
    `SELECT id, name, venue, age_range, active FROM classes ORDER BY active DESC, name`,
  ).all()).results || [];

  const termRows = (await env.DB.prepare(
    `SELECT class_id, term_label, COUNT(*) AS session_count,
            MIN(starts_at) AS first_starts, MAX(starts_at) AS last_starts
     FROM class_sessions
     WHERE status = 'scheduled'
     GROUP BY class_id, term_label
     ORDER BY first_starts`,
  ).all()).results || [];

  const cards = classes.map((c) => {
    const terms = termRows.filter((t) => t.class_id === c.id);
    const termItems = terms.map((t) => html`
      <li>
        <a href="/admin?class=${c.id}&term=${encodeURIComponent(t.term_label)}">${t.term_label || 'Unlabelled sessions'}</a>
        · ${formatSydney(t.first_starts, 'date')} – ${formatSydney(t.last_starts, 'date')}
        · ${t.session_count} session${t.session_count === 1 ? '' : 's'}
      </li>
    `);
    return html`
      <section class="class-card">
        <h2>${c.name}${c.active ? '' : html` <span class="muted">(inactive)</span>`}</h2>
        <p class="class-meta">${c.age_range} · ${c.venue}</p>
        ${terms.length
          ? html`<ul class="term-list">${joinHtml(termItems)}</ul>`
          : html`<p class="muted">No scheduled sessions yet.</p>`}
        <p class="table-actions">
          <a href="/admin/classes/${c.id}/edit">Edit class</a>
          <a href="/admin/sessions/new?class=${c.id}">Add sessions</a>
        </p>
      </section>
    `;
  });

  const body = html`
    <h1>Classes</h1>
    ${adminNav()}
    ${notice(req)}
    ${cards.length ? joinHtml(cards) : html`<p>No classes yet.</p>`}
    <p><a href="/admin/classes/new" class="button-link">Add a class</a></p>
  `;
  return pageResponse('Classes', body, { user });
}

// GET /admin/classes/new
export async function handleAdminClassNew(req, env) {
  const user = await requireAdmin(req, env);
  const body = html`
    <h1>Add a class</h1>
    ${adminNav()}
    ${classForm({
      action: '/admin/classes/new',
      values: { name: '', description: '', venue: '', age_range: '', active: 1 },
      csrfToken: user.csrfToken,
      submitLabel: 'Create class',
    })}
  `;
  return pageResponse('Add a class', body, { user });
}

// POST /admin/classes/new
export async function handleAdminClassNewPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, error } = readClassForm(form);
  if (error) {
    const body = html`<h1>Add a class</h1>${adminNav()}${classForm({
      action: '/admin/classes/new', values, error, csrfToken: user.csrfToken, submitLabel: 'Create class',
    })}`;
    return pageResponse('Add a class', body, { user, status: 400 });
  }

  const classId = uuid();
  await env.DB.prepare(
    `INSERT INTO classes (id, name, description, venue, age_range, active, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)`,
  ).bind(classId, values.name, values.description, values.venue, values.age_range, nowIso()).run();

  logEvent('class_created', { class_id: classId.slice(0, 8) });
  return redirect('/admin/classes?ok=class-created', 303);
}

// GET /admin/classes/:id/edit
export async function handleAdminClassEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const cls = await env.DB.prepare(
    `SELECT id, name, description, venue, age_range, active FROM classes WHERE id = ?1`,
  ).bind(params.id).first();
  if (!cls) throw notFound();

  const body = html`
    <h1>Edit ${cls.name}</h1>
    ${adminNav()}
    ${classForm({
      action: `/admin/classes/${cls.id}/edit`,
      values: cls,
      csrfToken: user.csrfToken,
      submitLabel: 'Save class',
      showActive: true,
    })}
  `;
  return pageResponse('Edit class', body, { user });
}

// POST /admin/classes/:id/edit — includes deactivation (active checkbox).
// Deactivating hides the class from the public list; sessions and bookings
// are untouched.
export async function handleAdminClassEditPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const cls = await env.DB.prepare(`SELECT id, name FROM classes WHERE id = ?1`).bind(params.id).first();
  if (!cls) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, error } = readClassForm(form);
  if (error) {
    const body = html`<h1>Edit ${cls.name}</h1>${adminNav()}${classForm({
      action: `/admin/classes/${cls.id}/edit`, values, error, csrfToken: user.csrfToken, submitLabel: 'Save class', showActive: true,
    })}`;
    return pageResponse('Edit class', body, { user, status: 400 });
  }

  await env.DB.prepare(
    `UPDATE classes SET name = ?1, description = ?2, venue = ?3, age_range = ?4, active = ?5 WHERE id = ?6`,
  ).bind(values.name, values.description, values.venue, values.age_range, values.active, cls.id).run();

  logEvent('class_updated', { class_id: cls.id.slice(0, 8), active: values.active });
  return redirect('/admin/classes?ok=class-updated', 303);
}

// --- Sessions ----------------------------------------------------------------

function sessionForm({ action, values, classes, error = '', csrfToken, submitLabel, isEdit = false }) {
  const classOptions = classes.map((c) => html`
    <option value="${c.id}" ${c.id === values.class_id ? 'selected' : ''}>${c.name}${c.active ? '' : ' (inactive)'}</option>
  `);
  return html`
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <div class="form-group">
        <label for="class_id">Class</label>
        <select id="class_id" name="class_id" required>${joinHtml(classOptions)}</select>
      </div>
      <div class="form-group">
        <label for="date">Date (Sydney)</label>
        <input type="date" id="date" name="date" value="${values.date}" required>
      </div>
      <div class="form-group">
        <label for="time">Start time (Sydney, 24h)</label>
        <input type="time" id="time" name="time" value="${values.time}" required>
      </div>
      <div class="form-group">
        <label for="duration">Duration (minutes)</label>
        <input type="number" id="duration" name="duration" value="${values.duration}" min="5" max="480" required>
      </div>
      <div class="form-group">
        <label for="capacity">Capacity (seats)</label>
        <input type="number" id="capacity" name="capacity" value="${values.capacity}" min="1" max="500" required>
      </div>
      <div class="form-group">
        <label for="price">Price per child (AUD, e.g. 25 or 25.50)</label>
        <input type="text" id="price" name="price" value="${values.price}" required>
      </div>
      <div class="form-group">
        <label for="term_label">Term label (groups the public list, e.g. "Term 3" — optional)</label>
        <input type="text" id="term_label" name="term_label" value="${values.term_label}" maxlength="50">
      </div>
      ${isEdit ? html`
        <div class="form-group">
          <label for="status">Status</label>
          <select id="status" name="status">
            <option value="scheduled" ${values.status === 'scheduled' ? 'selected' : ''}>Scheduled</option>
            <option value="cancelled" ${values.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
        </div>
      ` : html`
        <div class="form-group">
          <label for="repeat">Repeat weekly for (weeks, 1 = just this session)</label>
          <input type="number" id="repeat" name="repeat" value="${values.repeat}" min="1" max="${MAX_REPEAT_WEEKS}" required>
        </div>
      `}
      <button type="submit">${submitLabel}</button>
    </form>
  `;
}

// Validate the shared session fields. Returns { values, parsed, error }.
function readSessionForm(form, { withRepeat }) {
  const values = {
    class_id: String(form.get('class_id') || ''),
    date: String(form.get('date') || '').trim(),
    time: String(form.get('time') || '').trim(),
    duration: String(form.get('duration') || '').trim(),
    capacity: String(form.get('capacity') || '').trim(),
    price: String(form.get('price') || '').trim(),
    term_label: cleanText(form.get('term_label'), 50),
    repeat: String(form.get('repeat') || '1').trim(),
    status: form.get('status') === 'cancelled' ? 'cancelled' : 'scheduled',
  };

  const duration = parseIntInRange(values.duration, 5, 480);
  if (duration === null) return { values, error: 'Duration must be a whole number of minutes between 5 and 480.' };
  const capacity = parseIntInRange(values.capacity, 1, 500);
  if (capacity === null) return { values, error: 'Capacity must be a positive whole number (1–500).' };
  const priceCents = parseDollarsToCents(values.price);
  if (priceCents === null) return { values, error: 'Price must be a non-negative AUD amount, e.g. 25 or 25.50.' };

  let repeat = 1;
  if (withRepeat) {
    repeat = parseIntInRange(values.repeat, 1, MAX_REPEAT_WEEKS);
    if (repeat === null) return { values, error: `Repeat must be a whole number between 1 and ${MAX_REPEAT_WEEKS} weeks.` };
  }

  const startsAtUtc = sydneyToUtc(values.date, values.time);
  if (!startsAtUtc) return { values, error: 'Please enter a real date and start time.' };

  return { values, parsed: { duration, capacity, priceCents, repeat, startsAtUtc }, error: null };
}

async function listAllClasses(env) {
  return (await env.DB.prepare(`SELECT id, name, active FROM classes ORDER BY active DESC, name`).all()).results || [];
}

// GET /admin/sessions/new[?class=…]
export async function handleAdminSessionNew(req, env) {
  const user = await requireAdmin(req, env);
  const classes = await listAllClasses(env);
  if (!classes.length) return redirect('/admin/classes/new', 303);

  const preselect = new URL(req.url).searchParams.get('class');
  const classId = classes.some((c) => c.id === preselect) ? preselect : classes[0].id;

  const body = html`
    <h1>Add sessions</h1>
    ${adminNav()}
    ${sessionForm({
      action: '/admin/sessions/new',
      values: { class_id: classId, date: '', time: '09:30', duration: '45', capacity: '12', price: '25', term_label: '', repeat: '1' },
      classes,
      csrfToken: user.csrfToken,
      submitLabel: 'Create sessions',
    })}
  `;
  return pageResponse('Add sessions', body, { user });
}

// POST /admin/sessions/new — creates 1..N weekly sessions. Each occurrence is
// converted from Sydney wall-clock independently, so a run crossing an
// AEST/AEDT changeover keeps the same local start time.
export async function handleAdminSessionNewPost(req, env, _params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const classes = await listAllClasses(env);
  const { values, parsed, error } = readSessionForm(form, { withRepeat: true });

  const cls = classes.find((c) => c.id === values.class_id);
  const finalError = error || (cls ? null : 'Please choose a class.');
  if (finalError) {
    const body = html`<h1>Add sessions</h1>${adminNav()}${sessionForm({
      action: '/admin/sessions/new', values, classes, error: finalError, csrfToken: user.csrfToken, submitLabel: 'Create sessions',
    })}`;
    return pageResponse('Add sessions', body, { user, status: 400 });
  }

  const now = nowIso();
  const statements = [];
  for (let week = 0; week < parsed.repeat; week += 1) {
    const startsAt = week === 0 ? parsed.startsAtUtc : sydneyToUtc(addDays(values.date, 7 * week), values.time);
    statements.push(env.DB.prepare(
      `INSERT INTO class_sessions (id, class_id, starts_at, duration_mins, capacity, price_cents, status, term_label, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled', ?7, ?8)`,
    ).bind(uuid(), cls.id, startsAt, parsed.duration, parsed.capacity, parsed.priceCents, values.term_label, now));
  }
  await env.DB.batch(statements);

  logEvent('sessions_created', { class_id: cls.id.slice(0, 8), count: parsed.repeat });
  return redirect('/admin?ok=sessions-created', 303);
}

// GET /admin/sessions/:id/edit
export async function handleAdminSessionEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await env.DB.prepare(
    `SELECT id, class_id, starts_at, duration_mins, capacity, price_cents, status, term_label FROM class_sessions WHERE id = ?1`,
  ).bind(params.id).first();
  if (!session) throw notFound();

  const classes = await listAllClasses(env);
  const fields = sydneyFields(session.starts_at);
  const body = html`
    <h1>Edit session</h1>
    ${adminNav()}
    ${sessionForm({
      action: `/admin/sessions/${session.id}/edit`,
      values: {
        class_id: session.class_id,
        date: fields.date,
        time: fields.time,
        duration: String(session.duration_mins),
        capacity: String(session.capacity),
        price: (session.price_cents / 100).toFixed(2),
        term_label: session.term_label || '',
        status: session.status,
      },
      classes,
      csrfToken: user.csrfToken,
      submitLabel: 'Save session',
      isEdit: true,
    })}
    <p><a href="/admin/sessions/${session.id}/roster">View roster</a></p>
  `;
  return pageResponse('Edit session', body, { user });
}

// POST /admin/sessions/:id/edit — edit details or cancel the session.
export async function handleAdminSessionEditPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await env.DB.prepare(`SELECT id FROM class_sessions WHERE id = ?1`).bind(params.id).first();
  if (!session) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const classes = await listAllClasses(env);
  const { values, parsed, error } = readSessionForm(form, { withRepeat: false });
  const cls = classes.find((c) => c.id === values.class_id);
  const finalError = error || (cls ? null : 'Please choose a class.');
  if (finalError) {
    const body = html`<h1>Edit session</h1>${adminNav()}${sessionForm({
      action: `/admin/sessions/${session.id}/edit`, values, classes, error: finalError, csrfToken: user.csrfToken, submitLabel: 'Save session', isEdit: true,
    })}`;
    return pageResponse('Edit session', body, { user, status: 400 });
  }

  await env.DB.prepare(
    `UPDATE class_sessions SET class_id = ?1, starts_at = ?2, duration_mins = ?3,
            capacity = ?4, price_cents = ?5, status = ?6, term_label = ?7 WHERE id = ?8`,
  ).bind(cls.id, parsed.startsAtUtc, parsed.duration, parsed.capacity, parsed.priceCents, values.status, values.term_label, session.id).run();

  logEvent('session_updated', { session_id: session.id.slice(0, 8), status: values.status });
  return redirect('/admin?ok=session-updated', 303);
}

// --- Roster ------------------------------------------------------------------

const PAYMENT_LABELS = {
  confirmed: 'Paid',
  pending: 'Awaiting payment',
};

// Seat-holding bookings for a session with the parent/child/snapshot detail
// the roster needs. Consent and medical notes come from the BOOKING snapshot
// (reflects what was agreed at booking time, not later profile edits).
async function loadRoster(env, sessionId) {
  const now = nowIso();
  return (await env.DB.prepare(
    `SELECT b.id AS booking_id, b.status, b.paid_at, b.payment_provider, b.amount_cents,
            b.photo_consent_snapshot, b.medical_notes_snapshot,
            u.name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
            ch.name AS child_name, ch.dob AS child_dob
     FROM booking_sessions bs
     JOIN bookings b ON b.id = bs.booking_id
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     WHERE bs.session_id = ?1
       AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.expires_at > ?2))
     ORDER BY ch.name`,
  ).bind(sessionId, now).all()).results || [];
}

async function loadSessionHeader(env, sessionId) {
  return env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.capacity, cs.status, c.name AS class_name, c.venue
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id WHERE cs.id = ?1`,
  ).bind(sessionId).first();
}

// GET /admin/sessions/:id/roster
export async function handleAdminRoster(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await loadSessionHeader(env, params.id);
  if (!session) throw notFound();

  const roster = await loadRoster(env, session.id);
  const rows = roster.map((r) => html`
    <tr>
      <td>${r.child_name}<br><span class="muted">${formatAge(r.child_dob, session.starts_at)} at session</span></td>
      <td>${r.parent_name || '—'}<br><span class="muted">${r.parent_email}${r.parent_phone ? html`<br>${r.parent_phone}` : ''}</span></td>
      <td>${r.photo_consent_snapshot ? 'Yes' : 'No'}</td>
      <td class="roster-medical">${r.medical_notes_snapshot || '—'}</td>
      <td>${PAYMENT_LABELS[r.status] || r.status}${r.payment_provider ? html`<br><span class="muted">${r.payment_provider}</span>` : ''}</td>
    </tr>
  `);

  const body = html`
    <h1>Roster — ${session.class_name}</h1>
    ${adminNav()}
    <p class="lede">${formatSydney(session.starts_at)} · ${session.venue} · ${roster.length}/${session.capacity} seats taken${session.status === 'cancelled' ? ' · SESSION CANCELLED' : ''}</p>
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Child</th><th>Parent</th><th>Photos OK</th><th>Medical notes</th><th>Payment</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
      <form method="post" action="/admin/sessions/${session.id}/roster.csv" class="inline-form">
        ${csrfField(user.csrfToken)}
        <button type="submit" class="button-secondary">Download roster CSV</button>
      </form>
    ` : html`<p>No bookings for this session yet.</p>`}
    <p><a href="/admin">Back to schedule</a></p>
  `;
  return pageResponse('Session roster', body, { user });
}

// POST /admin/sessions/:id/roster.csv — CSV export (POST + CSRF so the export
// cannot be triggered cross-site).
export async function handleAdminRosterCsv(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await loadSessionHeader(env, params.id);
  if (!session) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const roster = await loadRoster(env, session.id);
  const fields = sydneyFields(session.starts_at);
  logEvent('roster_exported', { session_id: session.id.slice(0, 8), rows: roster.length });

  return csvResponse(
    `roster-${fields.date}.csv`,
    ['Child', 'Age at session', 'Parent', 'Email', 'Phone', 'Photo consent', 'Medical notes', 'Payment status', 'Amount'],
    roster.map((r) => [
      r.child_name,
      formatAge(r.child_dob, session.starts_at),
      r.parent_name,
      r.parent_email,
      r.parent_phone,
      r.photo_consent_snapshot ? 'Yes' : 'No',
      r.medical_notes_snapshot,
      PAYMENT_LABELS[r.status] || r.status,
      formatAud(r.amount_cents),
    ]),
  );
}
