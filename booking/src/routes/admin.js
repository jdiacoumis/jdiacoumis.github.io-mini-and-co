// Admin portal: schedule dashboard, classes (weekly slots), sessions (with a
// proper cancel flow), rosters with attendance, and the staff rosters page.
// Phase 2B owns this file.
//
// Security: every handler starts with requireAdmin — or requireStaff for the
// rosters page, a roster and (routes/admin-ops.js) attendance, the only pages
// a facilitator may use (live allowlist re-check on each request, denials
// logged and rate limited); all state changes verify the per-session CSRF
// token; CSV exports are POST + CSRF, admin-only, and neutralise formula
// injection (lib/csv.js). Times are entered and rendered in Australia/Sydney
// and stored as UTC.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireStaff, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound } from '../lib/http.js';
import { uuid, nowIso } from '../lib/db.js';
import { isValidId, cleanText, parseIntInRange, parseDollarsToCents } from '../lib/validate.js';
import { sydneyToUtc, formatSydney, sydneyFields, formatAge } from '../lib/time.js';
import {
  listSessionsWithFullness, formatAud, sweepExpiredBookings, KIND_LABELS,
} from '../lib/domain.js';
import { notifySessionCancelled } from '../lib/notify.js';
import { csvResponse } from '../lib/csv.js';
import { logEvent, logError } from '../lib/log.js';
import {
  dashboardCounts, loadSession, sessionCancellationPlan, cancelSessionWithCredits, reinstateSession,
  loadRoster, strictestConsent, paymentSummary, listRosterSessions, syncTermDates, noticeFor, errorBlock,
} from '../lib/admin-ops.js';

const MAX_REPEAT_WEEKS = 52;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Post-redirect-get notices, allowlisted by key so nothing user-controlled is
// ever reflected from the query string.
const NOTICES = {
  'class-created': 'Class created.',
  'class-updated': 'Class updated.',
  'sessions-created': 'Session(s) created.',
  'session-updated': 'Session updated.',
  'session-reinstated': 'The session is back on the schedule. Families whose places were cancelled with it need booking again (their credits stay).',
  'attendance-saved': 'Attendance saved.',
};
const ERRORS = {
  'attendance-missing': 'Nothing was marked — please tap the child\'s button again.',
  'attendance-not-booked': 'That child is no longer booked into this session.',
  'session-has-bookings': 'This session has bookings, so it can\'t move to another class or term. Cancel it, or move the families one by one.',
};

function notice(req) {
  return noticeFor(req, NOTICES, ERRORS);
}

// Calendar-safe date addition on a YYYY-MM-DD string (UTC arithmetic on the
// date part only — combined with sydneyToUtc per occurrence this preserves
// the Sydney wall-clock time across AEST/AEDT transitions).
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function listAllClasses(env) {
  return (await env.DB.prepare(
    `SELECT id, name, active, weekday, start_time, default_duration_mins, default_capacity
     FROM classes ORDER BY active DESC, name`,
  ).all()).results || [];
}

async function listAllTerms(env) {
  return (await env.DB.prepare(
    `SELECT t.id, t.class_id, t.name, t.status, t.starts_on, t.ends_on, t.casual_price_cents, c.name AS class_name
     FROM terms t JOIN classes c ON c.id = t.class_id
     ORDER BY t.starts_on DESC, c.name`,
  ).all()).results || [];
}

// GET /admin[?class=…&term=…] — the owner's home: what needs doing (counts
// linking to the lists), quick links, and upcoming sessions with seats held
// (confirmed + unexpired pending) out of capacity. Facilitators
// (STAFF_EMAILS) are sent to their rosters page instead.
export async function handleAdminDashboard(req, env) {
  const user = await requireStaff(req, env);
  if (user.role !== 'admin') return redirect('/admin/rosters', 303);
  await sweepExpiredBookings(env);

  const url = new URL(req.url);
  const classFilter = isValidId(url.searchParams.get('class') || '') ? url.searchParams.get('class') : null;
  const termFilter = isValidId(url.searchParams.get('term') || '') ? url.searchParams.get('term') : null;
  const [sessions, counts] = await Promise.all([
    listSessionsWithFullness(env, { upcomingOnly: true, classId: classFilter, termId: termFilter }),
    dashboardCounts(env, nowIso()),
  ]);

  const rows = sessions.map((s) => html`
    <tr class="${s.status === 'cancelled' ? 'row-cancelled' : ''}">
      <td><a href="/admin/sessions/${s.id}/roster">${formatSydney(s.starts_at)}</a></td>
      <td>${s.class_name}${s.class_active ? '' : ' (class inactive)'}</td>
      <td>${s.term_id ? html`<a href="/admin/terms/${s.term_id}">${s.term_name}</a>` : 'One-off'}</td>
      <td>${s.seats_held}/${s.capacity}</td>
      <td>${formatAud(s.casual_price_cents)}</td>
      <td>${s.status === 'cancelled' ? 'Cancelled' : 'Scheduled'}</td>
      <td class="table-actions">
        <a href="/admin/sessions/${s.id}/edit">Edit</a>
        ${s.status === 'scheduled' ? html`<a href="/admin/sessions/${s.id}/cancel">Cancel</a>` : ''}
      </td>
    </tr>
  `);

  const tile = (href, number, label, alert = false) => html`
    <a class="stat-tile${alert && number ? ' stat-tile-alert' : ''}" href="${href}">
      <span class="stat-number">${number}</span><span class="stat-label">${label}</span>
    </a>`;

  const body = html`
    <h1>Admin</h1>
    ${notice(req)}
    <div class="stat-tiles">
      ${tile('/admin/attention', counts.attention, counts.attention === 1 ? 'booking needs attention' : 'bookings need attention', true)}
      ${tile('/admin/bookings?status=pending', counts.pay_later, 'pay-later places waiting for payment')}
      ${tile('/admin/terms', counts.open_terms, counts.open_terms === 1 ? 'term open for booking' : 'terms open for booking')}
      ${tile('/admin/waitlist', counts.waiting, 'on waitlists')}
    </div>
    <p class="quick-links">
      <a href="/admin/bookings/new" class="button-link">New booking</a>
      <a href="/admin/terms/new" class="button-link button-secondary">New term</a>
      <a href="/admin/rosters" class="button-link button-secondary">Rosters</a>
      <a href="/admin/credits" class="button-link button-secondary">Credits</a>
      <a href="/admin/vouchers" class="button-link button-secondary">Vouchers</a>
    </p>
    <h2>Upcoming sessions</h2>
    ${classFilter || termFilter ? html`<p class="form-notice">Filtered — <a href="/admin">show everything</a></p>` : ''}
    ${rows.length ? html`
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>When (Sydney)</th><th>Class</th><th>Term</th><th>Seats</th><th>Casual price</th><th>Status</th><th></th></tr></thead>
          <tbody>${joinHtml(rows)}</tbody>
        </table>
      </div>
    ` : html`<p>No upcoming sessions${classFilter || termFilter ? ' match this filter' : ''}. <a href="/admin/terms/new">Create a term</a>.</p>`}
    <p><a href="/admin/sessions/new" class="button-link button-secondary">Add one-off sessions</a></p>
  `;
  return pageResponse('Admin', body, { user, admin: true });
}

// --- Classes -----------------------------------------------------------------

function classForm({ action, values, error = '', csrfToken, submitLabel, showActive = false }) {
  const weekdayOptions = [html`<option value="" ${values.weekday === '' ? 'selected' : ''}>Not set</option>`]
    .concat(WEEKDAYS.map((name, i) => html`<option value="${i}" ${String(values.weekday) === String(i) ? 'selected' : ''}>${name}</option>`));
  return html`
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <div class="form-group">
        <label for="name">Class name (one weekly slot, e.g. "Sensory Play — Wednesday 11:00 am")</label>
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
      <div class="form-group">
        <label for="weekday">Day of the week</label>
        <select id="weekday" name="weekday">${joinHtml(weekdayOptions)}</select>
      </div>
      <div class="form-group">
        <label for="start_time">Start time (Sydney, 24h)</label>
        <input type="time" id="start_time" name="start_time" value="${values.start_time}">
      </div>
      <div class="form-group">
        <label for="default_duration_mins">Usual length (minutes)</label>
        <input type="number" id="default_duration_mins" name="default_duration_mins" value="${values.default_duration_mins}" min="5" max="480">
      </div>
      <div class="form-group">
        <label for="default_capacity">Usual capacity (seats)</label>
        <input type="number" id="default_capacity" name="default_capacity" value="${values.default_capacity}" min="1" max="500">
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
    weekday: String(form.get('weekday') ?? '').trim(),
    start_time: String(form.get('start_time') || '').trim(),
    default_duration_mins: String(form.get('default_duration_mins') || '45').trim(),
    default_capacity: String(form.get('default_capacity') || '12').trim(),
    active: form.get('active') ? 1 : 0,
  };
  if (!values.name) return { values, error: 'Please give the class a name.' };
  const weekday = values.weekday === '' ? null : parseIntInRange(values.weekday, 0, 6);
  if (values.weekday !== '' && weekday === null) return { values, error: 'Please choose a day of the week.' };
  if (values.start_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.start_time)) {
    return { values, error: 'Start time must be a 24-hour time like 11:00.' };
  }
  const duration = parseIntInRange(values.default_duration_mins, 5, 480);
  if (duration === null) return { values, error: 'Usual length must be between 5 and 480 minutes.' };
  const capacity = parseIntInRange(values.default_capacity, 1, 500);
  if (capacity === null) return { values, error: 'Usual capacity must be between 1 and 500.' };
  return {
    values,
    parsed: { weekday, startTime: values.start_time || null, duration, capacity },
    error: null,
  };
}

const EMPTY_CLASS = {
  name: '', description: '', venue: '', age_range: '', weekday: '', start_time: '',
  default_duration_mins: '45', default_capacity: '12', active: 1,
};

// GET /admin/classes — every class (weekly slot) with its terms.
export async function handleAdminClasses(req, env) {
  const user = await requireAdmin(req, env);
  const classes = (await env.DB.prepare(
    `SELECT id, name, venue, age_range, active, weekday, start_time FROM classes ORDER BY active DESC, name`,
  ).all()).results || [];
  const terms = (await env.DB.prepare(
    `SELECT t.id, t.class_id, t.name, t.status, t.starts_on, t.ends_on,
            (SELECT COUNT(*) FROM class_sessions s WHERE s.term_id = t.id AND s.status = 'scheduled') AS session_count
     FROM terms t ORDER BY t.starts_on`,
  ).all()).results || [];

  const cards = classes.map((c) => {
    const termItems = terms.filter((t) => t.class_id === c.id).map((t) => html`
      <li>
        <a href="/admin/terms/${t.id}">${t.name}</a> · ${t.starts_on} – ${t.ends_on}
        · ${t.session_count} session${t.session_count === 1 ? '' : 's'} · ${t.status}
      </li>
    `);
    return html`
      <section class="class-card">
        <h2>${c.name}${c.active ? '' : html` <span class="muted">(inactive)</span>`}</h2>
        <p class="class-meta">${c.weekday !== null ? `${WEEKDAYS[c.weekday]}s` : 'No regular day'}${c.start_time ? ` at ${c.start_time}` : ''} · ${c.age_range} · ${c.venue}</p>
        ${termItems.length
          ? html`<ul class="term-list">${joinHtml(termItems)}</ul>`
          : html`<p class="muted">No terms yet.</p>`}
        <p class="table-actions">
          <a href="/admin/classes/${c.id}/edit">Edit class</a>
          <a href="/admin?class=${c.id}">Upcoming sessions</a>
          <a href="/admin/terms/new?class=${c.id}">New term</a>
          <a href="/admin/sessions/new?class=${c.id}">Add one-off sessions</a>
        </p>
      </section>
    `;
  });

  const body = html`
    <h1>Classes</h1>
    ${notice(req)}
    ${cards.length ? joinHtml(cards) : html`<p>No classes yet.</p>`}
    <p><a href="/admin/classes/new" class="button-link">Add a class</a></p>
  `;
  return pageResponse('Classes', body, { user, admin: true });
}

// GET /admin/classes/new
export async function handleAdminClassNew(req, env) {
  const user = await requireAdmin(req, env);
  const body = html`
    <h1>Add a class</h1>
    ${classForm({ action: '/admin/classes/new', values: EMPTY_CLASS, csrfToken: user.csrfToken, submitLabel: 'Create class' })}
  `;
  return pageResponse('Add a class', body, { user, admin: true });
}

// POST /admin/classes/new
export async function handleAdminClassNewPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, parsed, error } = readClassForm(form);
  if (error) {
    const body = html`<h1>Add a class</h1>${classForm({
      action: '/admin/classes/new', values, error, csrfToken: user.csrfToken, submitLabel: 'Create class',
    })}`;
    return pageResponse('Add a class', body, { user, status: 400, admin: true });
  }

  const classId = uuid();
  await env.DB.prepare(
    `INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time,
                          default_duration_mins, default_capacity, active, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)`,
  ).bind(classId, values.name, values.description, values.venue, values.age_range, parsed.weekday,
    parsed.startTime, parsed.duration, parsed.capacity, nowIso()).run();

  logEvent('class_created', { class_id: classId.slice(0, 8) });
  return redirect('/admin/classes?ok=class-created', 303);
}

// GET /admin/classes/:id/edit
export async function handleAdminClassEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const cls = await env.DB.prepare(
    `SELECT id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
            default_capacity, active FROM classes WHERE id = ?1`,
  ).bind(params.id).first();
  if (!cls) throw notFound();

  const values = {
    ...cls,
    weekday: cls.weekday === null ? '' : String(cls.weekday),
    start_time: cls.start_time || '',
    default_duration_mins: String(cls.default_duration_mins),
    default_capacity: String(cls.default_capacity),
  };
  const body = html`
    <h1>Edit ${cls.name}</h1>
    ${classForm({
      action: `/admin/classes/${cls.id}/edit`, values, csrfToken: user.csrfToken, submitLabel: 'Save class', showActive: true,
    })}
  `;
  return pageResponse('Edit class', body, { user, admin: true });
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

  const { values, parsed, error } = readClassForm(form);
  if (error) {
    const body = html`<h1>Edit ${cls.name}</h1>${classForm({
      action: `/admin/classes/${cls.id}/edit`, values, error, csrfToken: user.csrfToken, submitLabel: 'Save class', showActive: true,
    })}`;
    return pageResponse('Edit class', body, { user, status: 400, admin: true });
  }

  await env.DB.prepare(
    `UPDATE classes SET name = ?1, description = ?2, venue = ?3, age_range = ?4, weekday = ?5,
            start_time = ?6, default_duration_mins = ?7, default_capacity = ?8, active = ?9
     WHERE id = ?10`,
  ).bind(values.name, values.description, values.venue, values.age_range, parsed.weekday, parsed.startTime,
    parsed.duration, parsed.capacity, values.active, cls.id).run();

  logEvent('class_updated', { class_id: cls.id.slice(0, 8), active: values.active });
  return redirect('/admin/classes?ok=class-updated', 303);
}

// --- Sessions ----------------------------------------------------------------

function sessionForm({ action, values, classes, terms, error = '', csrfToken, submitLabel, isEdit = false }) {
  const classOptions = classes.map((c) => html`
    <option value="${c.id}" ${c.id === values.class_id ? 'selected' : ''}>${c.name}${c.active ? '' : ' (inactive)'}</option>
  `);
  const termOptions = [html`<option value="" ${values.term_id ? '' : 'selected'}>No term (a one-off session)</option>`]
    .concat(terms.map((t) => html`
      <option value="${t.id}" ${t.id === values.term_id ? 'selected' : ''}>${t.class_name} — ${t.name} (${t.status})</option>
    `));
  return html`
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <div class="form-group">
        <label for="class_id">Class</label>
        <select id="class_id" name="class_id" required>${joinHtml(classOptions)}</select>
      </div>
      <div class="form-group">
        <label for="term_id">Term</label>
        <select id="term_id" name="term_id">${joinHtml(termOptions)}</select>
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
        <label for="price">Casual price per class (AUD, e.g. 30 or 30.50)</label>
        <input type="text" id="price" name="price" value="${values.price}" required>
      </div>
      ${isEdit ? '' : html`
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
function readSessionForm(form, { withRepeat, classes, terms }) {
  const values = {
    class_id: String(form.get('class_id') || ''),
    term_id: String(form.get('term_id') || ''),
    date: String(form.get('date') || '').trim(),
    time: String(form.get('time') || '').trim(),
    duration: String(form.get('duration') || '').trim(),
    capacity: String(form.get('capacity') || '').trim(),
    price: String(form.get('price') || '').trim(),
    repeat: String(form.get('repeat') || '1').trim(),
  };

  const cls = classes.find((c) => c.id === values.class_id);
  if (!cls) return { values, error: 'Please choose a class.' };
  const term = values.term_id ? terms.find((t) => t.id === values.term_id) : null;
  if (values.term_id && !term) return { values, error: 'Please choose a term (or none).' };
  if (term && term.class_id !== cls.id) return { values, error: `"${term.name}" belongs to a different class.` };
  const duration = parseIntInRange(values.duration, 5, 480);
  if (duration === null) return { values, error: 'Duration must be a whole number of minutes between 5 and 480.' };
  const capacity = parseIntInRange(values.capacity, 1, 500);
  if (capacity === null) return { values, error: 'Capacity must be a positive whole number (1–500).' };
  const priceCents = parseDollarsToCents(values.price);
  if (priceCents === null) return { values, error: 'Price must be a non-negative AUD amount, e.g. 30 or 30.50.' };

  let repeat = 1;
  if (withRepeat) {
    repeat = parseIntInRange(values.repeat, 1, MAX_REPEAT_WEEKS);
    if (repeat === null) return { values, error: `Repeat must be a whole number between 1 and ${MAX_REPEAT_WEEKS} weeks.` };
  }

  const startsAtUtc = sydneyToUtc(values.date, values.time);
  if (!startsAtUtc) return { values, error: 'Please enter a real date and start time.' };

  return { values, parsed: { cls, term, duration, capacity, priceCents, repeat, startsAtUtc }, error: null };
}

// GET /admin/sessions/new[?class=…]
export async function handleAdminSessionNew(req, env) {
  const user = await requireAdmin(req, env);
  const classes = await listAllClasses(env);
  if (!classes.length) return redirect('/admin/classes/new', 303);
  const terms = await listAllTerms(env);

  const preselect = new URL(req.url).searchParams.get('class');
  const cls = classes.find((c) => c.id === preselect) || classes[0];
  const body = html`
    <h1>Add sessions</h1>
    ${sessionForm({
      action: '/admin/sessions/new',
      values: {
        class_id: cls.id, term_id: '', date: '', time: cls.start_time || '11:00',
        duration: String(cls.default_duration_mins), capacity: String(cls.default_capacity), price: '30', repeat: '1',
      },
      classes, terms, csrfToken: user.csrfToken, submitLabel: 'Create sessions',
    })}
  `;
  return pageResponse('Add sessions', body, { user, admin: true });
}

// POST /admin/sessions/new — creates 1..N weekly sessions. Each occurrence is
// converted from Sydney wall-clock independently, so a run crossing an
// AEST/AEDT changeover keeps the same local start time.
export async function handleAdminSessionNewPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const [classes, terms] = await Promise.all([listAllClasses(env), listAllTerms(env)]);
  const { values, parsed, error } = readSessionForm(form, { withRepeat: true, classes, terms });
  if (error) {
    const body = html`<h1>Add sessions</h1>${sessionForm({
      action: '/admin/sessions/new', values, classes, terms, error, csrfToken: user.csrfToken, submitLabel: 'Create sessions',
    })}`;
    return pageResponse('Add sessions', body, { user, status: 400, admin: true });
  }

  const now = nowIso();
  const statements = [];
  for (let week = 0; week < parsed.repeat; week += 1) {
    const startsAt = week === 0 ? parsed.startsAtUtc : sydneyToUtc(addDays(values.date, 7 * week), values.time);
    statements.push(env.DB.prepare(
      `INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents,
                                   status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8)`,
    ).bind(uuid(), parsed.cls.id, parsed.term ? parsed.term.id : null, startsAt, parsed.duration, parsed.capacity,
      parsed.priceCents, now));
  }
  await env.DB.batch(statements);
  if (parsed.term) await syncTermDates(env, parsed.term.id);

  logEvent('sessions_created', { class_id: parsed.cls.id.slice(0, 8), count: parsed.repeat });
  return redirect('/admin?ok=sessions-created', 303);
}

// GET /admin/sessions/:id/edit — time, length, capacity and casual price.
// Cancelling has its own page (reason, credits, notices).
export async function handleAdminSessionEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await env.DB.prepare(
    `SELECT id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, cancelled_reason,
            cancelled_at
     FROM class_sessions WHERE id = ?1`,
  ).bind(params.id).first();
  if (!session) throw notFound();

  const [classes, terms] = await Promise.all([listAllClasses(env), listAllTerms(env)]);
  const fields = sydneyFields(session.starts_at);
  const body = html`
    <h1>Edit session</h1>
    ${notice(req)}
    ${session.status === 'cancelled' ? html`
      <div class="confirm-box">
        <p><strong>This session is cancelled</strong>${session.cancelled_reason ? ` — ${session.cancelled_reason}` : ''}
          ${session.cancelled_at ? ` (${formatSydney(session.cancelled_at, 'date')})` : ''}.</p>
        <form method="post" action="/admin/sessions/${session.id}/reinstate" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-small button-secondary">Put it back on the schedule</button>
        </form>
        <p class="form-hint">Families whose places were cancelled with it are not re-booked, and their credits stay.</p>
      </div>
    ` : ''}
    ${sessionForm({
      action: `/admin/sessions/${session.id}/edit`,
      values: {
        class_id: session.class_id,
        term_id: session.term_id || '',
        date: fields.date,
        time: fields.time,
        duration: String(session.duration_mins),
        capacity: String(session.capacity),
        price: (session.casual_price_cents / 100).toFixed(2),
      },
      classes, terms, csrfToken: user.csrfToken, submitLabel: 'Save session', isEdit: true,
    })}
    <p class="inline-actions">
      <a href="/admin/sessions/${session.id}/roster">View roster</a>
      ${session.status === 'scheduled' ? html`<a href="/admin/sessions/${session.id}/cancel" class="button-link button-small button-danger">Cancel this session…</a>` : ''}
    </p>
  `;
  return pageResponse('Edit session', body, { user, admin: true });
}

// POST /admin/sessions/:id/edit — details only (status changes go through
// the cancel / reinstate actions). A session with bookings keeps its class
// and term, so rosters and term grids stay truthful.
export async function handleAdminSessionEditPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await env.DB.prepare(
    `SELECT id, class_id, term_id, status FROM class_sessions WHERE id = ?1`,
  ).bind(params.id).first();
  if (!session) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const [classes, terms] = await Promise.all([listAllClasses(env), listAllTerms(env)]);
  const { values, parsed, error } = readSessionForm(form, { withRepeat: false, classes, terms });
  if (error) {
    const body = html`<h1>Edit session</h1>${sessionForm({
      action: `/admin/sessions/${session.id}/edit`, values, classes, terms, error, csrfToken: user.csrfToken,
      submitLabel: 'Save session', isEdit: true,
    })}`;
    return pageResponse('Edit session', body, { user, status: 400, admin: true });
  }
  const newTermId = parsed.term ? parsed.term.id : null;
  if (parsed.cls.id !== session.class_id || newTermId !== session.term_id) {
    const used = await env.DB.prepare(`SELECT 1 AS yes FROM booking_sessions WHERE session_id = ?1 LIMIT 1`)
      .bind(session.id).first();
    if (used) return redirect(`/admin/sessions/${session.id}/edit?err=session-has-bookings`, 303);
  }

  await env.DB.prepare(
    `UPDATE class_sessions SET class_id = ?1, term_id = ?2, starts_at = ?3, duration_mins = ?4, capacity = ?5,
            casual_price_cents = ?6
     WHERE id = ?7`,
  ).bind(parsed.cls.id, newTermId, parsed.startsAtUtc, parsed.duration, parsed.capacity, parsed.priceCents,
    session.id).run();
  for (const termId of new Set([session.term_id, newTermId].filter(Boolean))) await syncTermDates(env, termId);

  logEvent('session_updated', { session_id: session.id.slice(0, 8) });
  return redirect('/admin?ok=session-updated', 303);
}

// --- Cancelling a session (owner) -----------------------------------------------------

// GET /admin/sessions/:id/cancel — confirm step: who is affected and the
// credit each family will get.
export async function handleAdminSessionCancel(req, env, params) {
  const user = await requireAdmin(req, env);
  const now = nowIso();
  const session = await loadSession(env, params.id, now);
  if (!session) throw notFound();
  if (session.status !== 'scheduled') return redirect(`/admin/sessions/${session.id}/edit`, 303);
  const plan = await sessionCancellationPlan(env, session.id, now);
  return cancelSessionPage(user, session, plan, { now });
}

function cancelSessionPage(user, session, plan, { now, error = '', reason = '', status = 200 }) {
  const rows = plan.map((r) => html`
    <tr>
      <td>${r.child_name}</td>
      <td>${r.parent_name || r.parent_email}</td>
      <td>${KIND_LABELS[r.kind] || r.kind}${r.status === 'pending' ? ' (not paid yet)' : ''}</td>
      <td>${r.creditCents ? formatAud(r.creditCents) : 'No credit'}</td>
    </tr>`);
  const totalCredit = plan.reduce((sum, r) => sum + r.creditCents, 0);
  const body = html`
    <h1>Cancel this session?</h1>
    <p class="lede">${session.class_name} · ${formatSydney(session.starts_at)}${session.term_name ? ` · ${session.term_name}` : ''}</p>
    ${errorBlock(error)}
    ${session.starts_at <= now ? html`<p class="form-error">This session has already started.</p>` : ''}
    ${rows.length ? html`
      <p>${plan.length} ${plan.length === 1 ? 'family is' : 'families are'} booked. Each paid booking gets a credit for this
        class (the per-week value of their booking), applied automatically to their next booking — ${formatAud(totalCredit)} in total.
        Every family is emailed.</p>
      <div class="table-scroll">
        <table class="booking-table">
          <thead><tr><th>Child</th><th>Parent</th><th>Booking</th><th>Credit</th></tr></thead>
          <tbody>${joinHtml(rows)}</tbody>
        </table>
      </div>
    ` : html`<p>Nobody is booked into this session.</p>`}
    <form method="post" action="/admin/sessions/${session.id}/cancel" class="booking-form confirm-box">
      ${csrfField(user.csrfToken)}
      <div class="form-group">
        <label for="reason">Reason (shown to families)</label>
        <input type="text" id="reason" name="reason" value="${reason}" required maxlength="200" placeholder="Venue closed">
      </div>
      <button type="submit" class="button-danger">Yes, cancel the session</button>
      <a href="/admin/sessions/${session.id}/roster" class="button-link button-secondary">Keep it</a>
    </form>
  `;
  return pageResponse('Cancel session', body, { user, admin: true, status });
}

// POST /admin/sessions/:id/cancel — mark it cancelled, cancel every booked
// place in it and issue the credits (one atomic batch), then send the notices.
export async function handleAdminSessionCancelPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const now = nowIso();
  const session = await loadSession(env, params.id, now);
  if (!session) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const reason = cleanText(form.get('reason'), 200);
  if (!reason) {
    const plan = await sessionCancellationPlan(env, session.id, now);
    return cancelSessionPage(user, session, plan, { now, error: 'Please give a reason — families see it in their email.', status: 400 });
  }
  if (session.status !== 'scheduled') return redirect(`/admin/sessions/${session.id}/edit`, 303);

  const result = await cancelSessionWithCredits(env, session.id, { reason, by: user.userId, now });
  if (!result.ok) {
    if (result.error === 'not_scheduled') return redirect(`/admin/sessions/${session.id}/edit`, 303);
    const plan = await sessionCancellationPlan(env, session.id, now);
    return cancelSessionPage(user, session, plan, {
      now, reason, error: 'Bookings kept changing while cancelling — please try again.', status: 409,
    });
  }

  let notified = true;
  try {
    await notifySessionCancelled(env, session.id, { reason });
  } catch (err) {
    notified = false;
    logError('session_cancel_notice_failed', err, { session_id: session.id.slice(0, 8) });
  }

  const rows = result.affected.map((r) => html`
    <tr>
      <td><a href="/admin/bookings/${r.booking_id}">${r.child_name}</a></td>
      <td>${r.parent_name || r.parent_email}</td>
      <td>${r.creditCents ? `${formatAud(r.creditCents)} credit` : 'No credit (nothing paid)'}</td>
    </tr>`);
  const body = html`
    <h1>Session cancelled</h1>
    <p class="form-notice" role="status">${session.class_name}, ${formatSydney(session.starts_at)} is cancelled.
      ${result.creditsIssued} credit${result.creditsIssued === 1 ? '' : 's'} issued (${formatAud(result.creditCents)}).</p>
    ${notified ? '' : html`<p class="form-error">The emails to families could not be sent — please contact them directly.</p>`}
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Child</th><th>Parent</th><th>Credit</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>` : html`<p>Nobody was booked.</p>`}
    <p class="inline-actions">
      ${session.term_id ? html`<a href="/admin/terms/${session.term_id}">Back to the term</a>` : ''}
      <a href="/admin">Back to the schedule</a>
    </p>
  `;
  return pageResponse('Session cancelled', body, { user, admin: true });
}

// POST /admin/sessions/:id/reinstate — undo a cancellation (the session only).
export async function handleAdminSessionReinstate(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const session = await env.DB.prepare(`SELECT id FROM class_sessions WHERE id = ?1`).bind(params.id).first();
  if (!session) throw notFound();
  await reinstateSession(env, session.id);
  logEvent('session_reinstated', { session_id: session.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/sessions/${session.id}/edit?ok=session-reinstated`, 303);
}

// --- Rosters (admins and staff) --------------------------------------------------------

async function loadSessionHeader(env, sessionId) {
  return env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.capacity, cs.status, cs.term_id, cs.cancelled_reason, c.name AS class_name,
            c.venue, t.name AS term_name
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id LEFT JOIN terms t ON t.id = cs.term_id
     WHERE cs.id = ?1`,
  ).bind(sessionId).first();
}

// Facilitators see a roster-only navigation (never the admin one).
function staffNav() {
  return html`<nav class="staff-nav" aria-label="Rosters"><a href="/admin/rosters">All rosters</a></nav>`;
}

function attendanceControls(r, sessionId, csrfToken) {
  const button = (mark, label) => html`
    <button type="submit" name="mark" value="${mark}" class="attendance-button attendance-${mark}"
      aria-pressed="${r.attendance === mark ? 'true' : 'false'}">${label}</button>`;
  return html`
    <form method="post" action="/admin/sessions/${sessionId}/attendance" class="attendance-form">
      ${csrfField(csrfToken)}
      <input type="hidden" name="booking" value="${r.booking_id}">
      ${button('present', '✓ Here')}
      ${button('absent', '✗ Away')}
      ${r.attendance ? button('clear', 'Clear') : ''}
    </form>`;
}

// GET /admin/sessions/:id/roster — admins and staff (facilitators): who is
// coming, attendance buttons, contacts, and consent/medical notes from the
// child's CURRENT profile beside the booking snapshot (stricter consent shown).
export async function handleAdminRoster(req, env, params) {
  const user = await requireStaff(req, env);
  const isAdmin = user.role === 'admin';
  const session = await loadSessionHeader(env, params.id);
  if (!session) throw notFound();
  const now = nowIso();

  const roster = await loadRoster(env, session.id, now);
  const marked = roster.filter((r) => r.attendance).length;
  const rows = roster.map((r) => {
    const consent = strictestConsent(r.photo_consent_snapshot, r.child_photo_consent);
    const currentNotes = String(r.child_medical_notes || '').trim();
    const snapshotNotes = String(r.medical_notes_snapshot || '').trim();
    const payment = paymentSummary(r, now);
    return html`
      <tr id="b-${r.booking_id}" class="attendance-row attendance-row-${r.attendance || 'unmarked'}">
        <td>
          <strong>${r.child_name}</strong><br><span class="muted">${formatAge(r.child_dob, session.starts_at)} at session</span>
          ${isAdmin ? html`<br><a href="/admin/bookings/${r.booking_id}" class="muted">Booking</a>` : ''}
        </td>
        <td>${attendanceControls(r, session.id, user.csrfToken)}
          ${r.attendance && r.attendance_marked_at ? html`<span class="muted">${r.attendance === 'present' ? 'Here' : 'Away'} · ${formatSydney(r.attendance_marked_at, 'time')}</span>` : ''}</td>
        <td>${r.parent_name || '—'}<br><span class="muted">${r.parent_email}${r.parent_phone ? html`<br><a href="tel:${r.parent_phone}">${r.parent_phone}</a>` : ''}</span></td>
        <td class="${consent.allowed ? '' : 'consent-no'}">${consent.allowed ? 'Yes' : 'No'}${consent.changed ? html`<br><span class="muted">changed since booking</span>` : ''}</td>
        <td class="roster-medical">${currentNotes || snapshotNotes || '—'}${currentNotes && snapshotNotes && currentNotes !== snapshotNotes
          ? html`<br><span class="muted">At booking: ${snapshotNotes}</span>` : ''}</td>
        <td>${KIND_LABELS[r.kind] || r.kind}</td>
        <td>${payment.label}</td>
      </tr>
    `;
  });

  const body = html`
    ${isAdmin ? '' : staffNav()}
    <div class="admin-wide">
      <h1>Roster — ${session.class_name}</h1>
      ${notice(req)}
      <p class="lede">${formatSydney(session.starts_at)} · ${session.venue}${session.term_name ? ` · ${session.term_name}` : ''}
        · ${roster.length}/${session.capacity} seats taken · ${marked} of ${roster.length} marked
        ${session.status === 'cancelled' ? html`<strong> · SESSION CANCELLED${session.cancelled_reason ? ` (${session.cancelled_reason})` : ''}</strong>` : ''}</p>
      ${rows.length ? html`
        <div class="table-scroll">
          <table class="booking-table roster-table">
            <thead><tr><th>Child</th><th>Attendance</th><th>Parent</th><th>Photos OK</th><th>Medical notes</th><th>Booking</th><th>Payment</th></tr></thead>
            <tbody>${joinHtml(rows)}</tbody>
          </table>
        </div>
      ` : html`<p>No bookings for this session yet.</p>`}
      ${isAdmin ? html`
        <div class="inline-actions">
          ${rows.length ? html`
            <form method="post" action="/admin/sessions/${session.id}/roster.csv" class="inline-form">
              ${csrfField(user.csrfToken)}
              <button type="submit" class="button-secondary">Download roster CSV</button>
            </form>` : ''}
          <a href="/admin/sessions/${session.id}/edit">Edit session</a>
          ${session.status === 'scheduled' ? html`<a href="/admin/sessions/${session.id}/cancel">Cancel session</a>` : ''}
          ${session.term_id ? html`<a href="/admin/terms/${session.term_id}">Term grid</a>` : ''}
          <a href="/admin">Back to schedule</a>
        </div>
      ` : ''}
    </div>
  `;
  return pageResponse('Session roster', body, { user, admin: isAdmin });
}

// POST /admin/sessions/:id/roster.csv — CSV export (admin only; POST + CSRF so
// the export cannot be triggered cross-site).
export async function handleAdminRosterCsv(req, env, params) {
  const user = await requireAdmin(req, env);
  const session = await loadSessionHeader(env, params.id);
  if (!session) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const now = nowIso();
  const roster = await loadRoster(env, session.id, now);
  const fields = sydneyFields(session.starts_at);
  logEvent('roster_exported', { session_id: session.id.slice(0, 8), rows: roster.length });

  return csvResponse(
    `roster-${fields.date}.csv`,
    ['Child', 'Age at session', 'Parent', 'Email', 'Phone', 'Photo consent', 'Medical notes', 'Booking', 'Payment status',
      'Owed', 'Paid', 'Attendance'],
    roster.map((r) => [
      r.child_name,
      formatAge(r.child_dob, session.starts_at),
      r.parent_name,
      r.parent_email,
      r.parent_phone,
      strictestConsent(r.photo_consent_snapshot, r.child_photo_consent).allowed ? 'Yes' : 'No',
      String(r.child_medical_notes || '').trim() || r.medical_notes_snapshot,
      KIND_LABELS[r.kind] || r.kind,
      paymentSummary(r, now).label,
      formatAud(r.amount_cents + r.credit_cents),
      formatAud(r.paid_cents),
      r.attendance === 'present' ? 'Present' : r.attendance === 'absent' ? 'Absent' : '',
    ]),
  );
}

// GET /admin/rosters — the facilitator's landing page (staff and admins):
// the last week's and the coming weeks' sessions, each linking to its roster.
export async function handleAdminRosters(req, env) {
  const user = await requireStaff(req, env);
  const isAdmin = user.role === 'admin';
  const now = nowIso();
  const sessions = await listRosterSessions(env, { now });
  const upcoming = sessions.filter((s) => s.starts_at > now);
  const recent = sessions.filter((s) => s.starts_at <= now).reverse();
  const table = (list) => html`
    <div class="table-scroll">
      <table class="booking-table">
        <thead><tr><th>When (Sydney)</th><th>Class</th><th>Booked</th><th>Marked</th></tr></thead>
        <tbody>${joinHtml(list.map((s) => html`
          <tr class="${s.status === 'cancelled' ? 'row-cancelled' : ''}">
            <td><a href="/admin/sessions/${s.id}/roster">${formatSydney(s.starts_at)}</a></td>
            <td>${s.class_name}${s.term_name ? html`<br><span class="muted">${s.term_name}</span>` : ''}${s.status === 'cancelled' ? ' — cancelled' : ''}</td>
            <td>${s.seats_held}/${s.capacity}</td>
            <td>${s.marked}</td>
          </tr>`))}</tbody>
      </table>
    </div>`;
  const body = html`
    ${isAdmin ? '' : staffNav()}
    <h1>Rosters</h1>
    <p class="lede">Open a session to see who's coming and mark attendance.</p>
    <h2>Coming up</h2>
    ${upcoming.length ? table(upcoming) : html`<p>No sessions in the next few weeks.</p>`}
    <h2>Last 7 days</h2>
    ${recent.length ? table(recent) : html`<p>No sessions in the last week.</p>`}
  `;
  return pageResponse('Rosters', body, { user, admin: isAdmin });
}

export function registerRoutes(route) {
  route('GET', '/admin', handleAdminDashboard);
  route('GET', '/admin/rosters', handleAdminRosters);
  route('GET', '/admin/classes', handleAdminClasses);
  route('GET', '/admin/classes/new', handleAdminClassNew);
  route('POST', '/admin/classes/new', handleAdminClassNewPost);
  route('GET', '/admin/classes/:id/edit', handleAdminClassEdit);
  route('POST', '/admin/classes/:id/edit', handleAdminClassEditPost);
  route('GET', '/admin/sessions/new', handleAdminSessionNew);
  route('POST', '/admin/sessions/new', handleAdminSessionNewPost);
  route('GET', '/admin/sessions/:id/edit', handleAdminSessionEdit);
  route('POST', '/admin/sessions/:id/edit', handleAdminSessionEditPost);
  route('GET', '/admin/sessions/:id/cancel', handleAdminSessionCancel);
  route('POST', '/admin/sessions/:id/cancel', handleAdminSessionCancelPost);
  route('POST', '/admin/sessions/:id/reinstate', handleAdminSessionReinstate);
  route('GET', '/admin/sessions/:id/roster', handleAdminRoster);
  route('POST', '/admin/sessions/:id/roster.csv', handleAdminRosterCsv);
}
