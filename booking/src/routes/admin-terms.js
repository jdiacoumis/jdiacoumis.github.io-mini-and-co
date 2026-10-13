// Admin terms (Phase 2B — class-scheduling spec, designs D1/D8):
//
//   * the terms list (per class: status, dates, bookings, seats, links);
//   * create a term — for one class or several at once ("also create for") —
//     generating one session per week at the class's Sydney start time
//     (converted date by date, so daylight-saving changes keep 11:00 at
//     11:00), skipping holiday dates, with the class defaults;
//   * edit a term (name, prices, opening times, plan options; price changes
//     never alter existing bookings), add or remove a week, open / close;
//   * the term grid (families × weeks with attendance and the ledger-backed
//     payment column, seats left per week) and its CSV;
//   * re-run a term (prefilled copy with shifted dates) and auto-enrol the
//     previous term's families as held pending bookings with an email.
//
// Security: requireAdmin on every route (live allowlist), CSRF on every POST,
// all output through the auto-escaping html`` template, CSV through
// lib/csv.js (formula-injection safe), ids in logs truncated.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound } from '../lib/http.js';
import { uuid, nowIso } from '../lib/db.js';
import { isValidId, cleanText, parseIntInRange } from '../lib/validate.js';
import { formatSydney, sydneyFields, sydneyToUtc } from '../lib/time.js';
import { loadTerm, listTermSessions, formatAud } from '../lib/domain.js';
import { csvResponse } from '../lib/csv.js';
import { sendTemplate, notifyBookingConfirmed } from '../lib/notify.js';
import { reenrolInvitation } from '../lib/emails/ops.js';
import { logEvent, logError } from '../lib/log.js';
import {
  planTermDates, parseDateList, sessionStartsFor, datetimeLocalToUtc, utcToDatetimeLocal, rerunDefaults,
  addDays, isDateStr, createTermsWithSessions, termNameTaken, listTermsOverview, loadTermGrid, GRID_CELLS,
  syncTermDates, removeTermSession, sessionHasBookings, autoEnrolCandidates, autoEnrolChild, autoEnrolExpiry,
  noticeFor, errorBlock, centsToInput, optionalDollars, shortDate,
} from '../lib/admin-ops.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS_LABELS = { draft: 'Draft', open: 'Open for bookings', closed: 'Closed' };
const TERM_STATUSES = ['draft', 'open', 'closed'];
const MAX_TERM_PRICE_CENTS = 1000000;
const MAX_CASUAL_PRICE_CENTS = 100000;

const NOTICES = {
  'term-created': 'Term created with its weekly sessions. It is a draft until you open it for bookings.',
  'terms-created': 'Terms created for each class with their weekly sessions. They are drafts until you open them.',
  'term-updated': 'Term saved. Existing bookings keep the price they were booked at.',
  'week-added': 'Week added to the term.',
  'week-removed': 'Week removed from the term.',
  'status-open': 'The term is open — families can see it and book.',
  'status-closed': 'The term is closed — it no longer appears on the booking page.',
  'status-draft': 'The term is back to draft — families cannot see or book it.',
  'rerun-created': 'New term created as a draft. Next: tick the families whose places you want to hold.',
};
const ERRORS = {
  'week-has-bookings': 'That week has bookings (or booking history), so it cannot be removed. Cancel it instead — the families are told and credited.',
  'week-date': 'Please choose a real date for the new week.',
  'week-exists': 'There is already a session for this class at that date and time.',
  'class-time': 'This class has no regular start time — set one on the class first.',
};

// --- Shared loading -------------------------------------------------------------

async function loadClasses(env) {
  return (await env.DB.prepare(
    `SELECT id, name, active, weekday, start_time, default_duration_mins, default_capacity
     FROM classes ORDER BY active DESC, name`,
  ).all()).results || [];
}

async function loadAllTerms(env) {
  return (await env.DB.prepare(
    `SELECT t.id, t.class_id, t.name, t.status, t.starts_on, t.ends_on, t.term_price_cents, t.casual_price_cents,
            t.trial_price_cents, t.returning_price_cents, t.plan_instalments, t.plan_interval, c.name AS class_name
     FROM terms t JOIN classes c ON c.id = t.class_id
     ORDER BY t.starts_on DESC, c.name`,
  ).all()).results || [];
}

// The class's most recent term that starts before `beforeDate` (the
// "previous term" that makes a family returning).
async function latestEarlierTerm(env, classId, beforeDate, exceptTermId = null) {
  const row = await env.DB.prepare(
    `SELECT id FROM terms WHERE class_id = ?1 AND starts_on < ?2 AND id != COALESCE(?3, '')
     ORDER BY starts_on DESC LIMIT 1`,
  ).bind(classId, beforeDate, exceptTermId).first();
  return row ? row.id : null;
}

function slotLabel(cls) {
  if (cls.weekday === null || cls.weekday === undefined || !cls.start_time) return 'no regular day/time set';
  return `${WEEKDAYS[cls.weekday]}s at ${cls.start_time}`;
}

function statusBadge(status) {
  return html`<span class="status term-status-${status}">${STATUS_LABELS[status] || status}</span>`;
}

function dateRange(term) {
  if (!isDateStr(term.starts_on) || !isDateStr(term.ends_on)) return '';
  const label = (d) => formatSydney(sydneyToUtc(d, '12:00'), 'date');
  return `${label(term.starts_on)} – ${label(term.ends_on)}`;
}

// --- The term form ----------------------------------------------------------------

const EMPTY_VALUES = {
  class_id: '', also: [], name: '', starts_on: '', weeks: '', ends_on: '', holidays: '',
  term_price: '', casual_price: '', trial_price: '', returning_price: '', returning_opens_at: '',
  public_opens_at: '', previous_term_id: 'auto', plan_instalments: '0', plan_interval: 'week',
  open_now: '', apply_casual: '1',
};

function valuesFromTerm(term) {
  return {
    ...EMPTY_VALUES,
    class_id: term.class_id,
    name: term.name,
    term_price: centsToInput(term.term_price_cents),
    casual_price: centsToInput(term.casual_price_cents),
    trial_price: centsToInput(term.trial_price_cents),
    returning_price: centsToInput(term.returning_price_cents),
    returning_opens_at: utcToDatetimeLocal(term.returning_opens_at),
    public_opens_at: utcToDatetimeLocal(term.public_opens_at),
    previous_term_id: term.previous_term_id || '',
    plan_instalments: String(term.plan_instalments ?? 0),
    plan_interval: term.plan_interval || 'week',
  };
}

// mode: 'new' (class + "also create for" + dates), 'rerun' (dates; class and
// previous term fixed), 'edit' (no dates — weeks are managed one by one).
function termForm({ mode, action, values, classes = [], terms = [], error = '', csrfToken, fixedClass = null, submitLabel }) {
  const withDates = mode !== 'edit';
  const classFields = mode === 'new' ? html`
    <div class="form-group">
      <label for="class_id">Class (weekly slot)</label>
      <select id="class_id" name="class_id" required>
        ${joinHtml(classes.filter((c) => c.active).map((c) => html`
          <option value="${c.id}" ${c.id === values.class_id ? 'selected' : ''}>${c.name} — ${slotLabel(c)}</option>`))}
      </select>
    </div>
    ${classes.filter((c) => c.active).length > 1 ? html`
      <fieldset class="form-group check-list">
        <legend>Also create the same term for</legend>
        ${joinHtml(classes.filter((c) => c.active).map((c) => html`
          <label><input type="checkbox" name="also" value="${c.id}" ${values.also.includes(c.id) ? 'checked' : ''}>
            ${c.name} <span class="muted">(${slotLabel(c)})</span></label>`))}
        <p class="form-hint">Each class gets its own term with its own seats, on its own day and time.</p>
      </fieldset>` : ''}
  ` : html`<p><strong>Class:</strong> ${fixedClass ? `${fixedClass.name} — ${slotLabel(fixedClass)}` : ''}</p>`;

  const previousOptions = [
    ...(mode === 'new' ? [html`<option value="auto" ${values.previous_term_id === 'auto' ? 'selected' : ''}>Automatic — the class's most recent term</option>`] : []),
    html`<option value="" ${values.previous_term_id === '' ? 'selected' : ''}>None</option>`,
    ...terms.map((t) => html`<option value="${t.id}" ${values.previous_term_id === t.id ? 'selected' : ''}>${t.class_name} — ${t.name}</option>`),
  ];

  return html`
    ${errorBlock(error)}
    <form method="post" action="${action}" class="booking-form term-form">
      ${csrfField(csrfToken)}
      ${classFields}
      <div class="form-group">
        <label for="name">Term name</label>
        <input type="text" id="name" name="name" value="${values.name}" required maxlength="100" placeholder="Term 1 2027">
      </div>
      ${withDates ? html`
        <div class="form-row">
          <div class="form-group">
            <label for="starts_on">First class date</label>
            <input type="date" id="starts_on" name="starts_on" value="${values.starts_on}" required>
          </div>
          <div class="form-group">
            <label for="weeks">Number of weeks <span class="muted">(count holiday weeks too)</span></label>
            <input type="number" id="weeks" name="weeks" value="${values.weeks}" min="1" max="52">
          </div>
          <div class="form-group">
            <label for="ends_on">…or the last class date</label>
            <input type="date" id="ends_on" name="ends_on" value="${values.ends_on}">
          </div>
        </div>
        <div class="form-group">
          <label for="holidays">Holiday dates to skip <span class="muted">(optional, e.g. 2027-03-10 — one per line or separated by commas)</span></label>
          <textarea id="holidays" name="holidays" rows="2" maxlength="1000">${values.holidays}</textarea>
        </div>
      ` : ''}
      <h2>Prices</h2>
      <div class="form-row">
        <div class="form-group">
          <label for="term_price">Whole term (AUD)</label>
          <input type="text" id="term_price" name="term_price" value="${values.term_price}" required inputmode="decimal" placeholder="168">
        </div>
        <div class="form-group">
          <label for="casual_price">Casual class (AUD)</label>
          <input type="text" id="casual_price" name="casual_price" value="${values.casual_price}" required inputmode="decimal" placeholder="30">
        </div>
        <div class="form-group">
          <label for="trial_price">Trial class <span class="muted">(blank = casual price)</span></label>
          <input type="text" id="trial_price" name="trial_price" value="${values.trial_price}" inputmode="decimal">
        </div>
      </div>
      ${mode === 'edit' ? html`
        <div class="form-group">
          <label><input type="checkbox" name="apply_casual" value="1" ${values.apply_casual ? 'checked' : ''}>
            Also use the casual price for the upcoming weeks of this term</label>
        </div>` : ''}
      <h2>Returning families and opening times</h2>
      <div class="form-row">
        <div class="form-group">
          <label for="returning_price">Returning-family term price <span class="muted">(optional)</span></label>
          <input type="text" id="returning_price" name="returning_price" value="${values.returning_price}" inputmode="decimal">
        </div>
        <div class="form-group">
          <label for="returning_opens_at">Returning families can book from <span class="muted">(optional)</span></label>
          <input type="datetime-local" id="returning_opens_at" name="returning_opens_at" value="${values.returning_opens_at}">
        </div>
        <div class="form-group">
          <label for="public_opens_at">Everyone can book from <span class="muted">(optional)</span></label>
          <input type="datetime-local" id="public_opens_at" name="public_opens_at" value="${values.public_opens_at}">
        </div>
      </div>
      ${mode === 'rerun' ? html`<input type="hidden" name="previous_term_id" value="${values.previous_term_id}">` : html`
        <div class="form-group">
          <label for="previous_term_id">Previous term <span class="muted">(its families count as returning)</span></label>
          <select id="previous_term_id" name="previous_term_id">${joinHtml(previousOptions)}</select>
        </div>`}
      <h2>Paying by instalments</h2>
      <div class="form-row">
        <div class="form-group">
          <label for="plan_instalments">Number of instalments <span class="muted">(0 = pay in full only)</span></label>
          <input type="number" id="plan_instalments" name="plan_instalments" value="${values.plan_instalments}" min="0" max="20">
        </div>
        <div class="form-group">
          <label for="plan_interval">Charged every</label>
          <select id="plan_interval" name="plan_interval">
            <option value="week" ${values.plan_interval === 'week' ? 'selected' : ''}>Week</option>
            <option value="fortnight" ${values.plan_interval === 'fortnight' ? 'selected' : ''}>Fortnight</option>
          </select>
        </div>
      </div>
      ${mode === 'new' ? html`
        <div class="form-group">
          <label><input type="checkbox" name="open_now" value="1" ${values.open_now ? 'checked' : ''}>
            Open for bookings straight away <span class="muted">(otherwise it stays a draft until you open it)</span></label>
        </div>` : ''}
      <button type="submit">${submitLabel}</button>
    </form>
  `;
}

const DATE_ERRORS = {
  start_date: 'Please enter the first class date.',
  end_date: 'The last class date must be a real date on or after the first class date.',
  weeks: 'Please enter how many weeks the term runs (1–52), or the last class date.',
  too_long: 'A term can run for at most 52 weeks.',
  no_sessions: 'Every week is a holiday — there would be no classes.',
};

// Validate the fields every mode shares. Returns { values, parsed, error }.
function readTermForm(form, { mode }) {
  const text = (name, max = 100) => String(form.get(name) ?? '').trim().slice(0, max);
  const values = {
    ...EMPTY_VALUES,
    class_id: text('class_id', 64),
    also: form.getAll('also').map(String).filter((id) => isValidId(id)),
    name: cleanText(form.get('name'), 100),
    starts_on: text('starts_on', 10),
    weeks: text('weeks', 3),
    ends_on: text('ends_on', 10),
    holidays: cleanText(form.get('holidays'), 1000),
    term_price: text('term_price', 12),
    casual_price: text('casual_price', 12),
    trial_price: text('trial_price', 12),
    returning_price: text('returning_price', 12),
    returning_opens_at: text('returning_opens_at', 19),
    public_opens_at: text('public_opens_at', 19),
    previous_term_id: form.has('previous_term_id') ? text('previous_term_id', 64) : 'auto',
    plan_instalments: text('plan_instalments', 3) || '0',
    plan_interval: form.get('plan_interval') === 'fortnight' ? 'fortnight' : 'week',
    open_now: form.get('open_now') ? '1' : '',
    apply_casual: form.get('apply_casual') ? '1' : '',
  };
  const fail = (error) => ({ values, parsed: null, error });

  if (!values.name) return fail('Please give the term a name, like “Term 1 2027”.');
  const termPrice = optionalDollars(values.term_price, MAX_TERM_PRICE_CENTS);
  if (!termPrice.ok || termPrice.cents === null) return fail('The whole-term price must be an amount like 168 or 168.50.');
  const casual = optionalDollars(values.casual_price, MAX_CASUAL_PRICE_CENTS);
  if (!casual.ok || casual.cents === null) return fail('The casual class price must be an amount like 30.');
  const trial = optionalDollars(values.trial_price, MAX_CASUAL_PRICE_CENTS);
  if (!trial.ok) return fail('The trial price must be blank or an amount like 25.');
  const returning = optionalDollars(values.returning_price, MAX_TERM_PRICE_CENTS);
  if (!returning.ok) return fail('The returning-family price must be blank or an amount like 150.');
  const returningOpensAt = values.returning_opens_at ? datetimeLocalToUtc(values.returning_opens_at) : null;
  if (values.returning_opens_at && !returningOpensAt) return fail('Please enter when returning families can book as a date and time, or leave it blank.');
  const publicOpensAt = values.public_opens_at ? datetimeLocalToUtc(values.public_opens_at) : null;
  if (values.public_opens_at && !publicOpensAt) return fail('Please enter when everyone can book as a date and time, or leave it blank.');
  if (returningOpensAt && publicOpensAt && returningOpensAt > publicOpensAt) {
    return fail('Returning families should be able to book before (or when) everyone else can.');
  }
  const planInstalments = parseIntInRange(values.plan_instalments, 0, 20);
  if (planInstalments === null || planInstalments === 1) return fail('Instalments must be 0 (pay in full only) or between 2 and 20.');
  if (values.previous_term_id && values.previous_term_id !== 'auto' && !isValidId(values.previous_term_id)) {
    return fail('Please choose the previous term again.');
  }

  let dates = null;
  if (mode !== 'edit') {
    if (!isDateStr(values.starts_on)) return fail('Please enter the first class date.');
    let weeks = null;
    let endsOn = null;
    if (values.ends_on) {
      if (!isDateStr(values.ends_on)) return fail('The last class date is not a real date.');
      endsOn = values.ends_on;
    } else {
      weeks = parseIntInRange(values.weeks, 1, 52);
      if (weeks === null) return fail('Please enter how many weeks the term runs (1–52), or the last class date.');
    }
    const holidays = parseDateList(values.holidays);
    if (holidays.invalid.length) return fail(`These holiday dates could not be read: ${holidays.invalid.slice(0, 5).join(', ')}. Use the form 2027-03-10.`);
    dates = { startsOn: values.starts_on, weeks, endsOn, skipDates: holidays.dates };
  }

  return {
    values,
    error: null,
    parsed: {
      termPriceCents: termPrice.cents,
      casualPriceCents: casual.cents,
      trialPriceCents: trial.cents,
      returningPriceCents: returning.cents,
      returningOpensAt,
      publicOpensAt,
      planInstalments,
      planInterval: values.plan_interval,
      dates,
    },
  };
}

// Plan one class's term dates from the shared fields: the first class date
// moves to this class's weekday within the same week.
function planForClass(cls, primary, dates) {
  const delta = (cls.weekday - primary.weekday + 7) % 7;
  return planTermDates({
    startsOn: addDays(dates.startsOn, delta),
    weeks: dates.weeks,
    endsOn: dates.endsOn ? addDays(dates.endsOn, delta) : null,
    skipDates: dates.skipDates,
    weekday: cls.weekday,
  });
}

function datePlanError(code, cls) {
  if (code === 'start_weekday') {
    return `The first class date must be a ${WEEKDAYS[cls.weekday]} — ${cls.name} runs on ${WEEKDAYS[cls.weekday]}s.`;
  }
  return DATE_ERRORS[code] || 'Please check the dates.';
}

// --- Terms list -------------------------------------------------------------------

// GET /admin/terms
export async function handleAdminTerms(req, env) {
  const user = await requireAdmin(req, env);
  const [terms, classes] = await Promise.all([listTermsOverview(env), loadClasses(env)]);

  const sections = classes.map((cls) => {
    const classTerms = terms.filter((t) => t.class_id === cls.id);
    const rows = classTerms.map((t) => html`
      <tr>
        <td><a href="/admin/terms/${t.id}">${t.name}</a></td>
        <td>${statusBadge(t.status)}</td>
        <td>${dateRange(t)}</td>
        <td>${t.session_count} week${t.session_count === 1 ? '' : 's'}${t.upcoming_count && t.upcoming_count < t.session_count ? html`<br><span class="muted">${t.upcoming_count} to come</span>` : ''}</td>
        <td>${t.live_bookings}</td>
        <td>${t.min_seats_left === null ? '—' : t.min_seats_left}</td>
        <td>${formatAud(t.term_price_cents)}${t.returning_price_cents !== null ? html`<br><span class="muted">returning ${formatAud(t.returning_price_cents)}</span>` : ''}</td>
        <td class="table-actions">
          <a href="/admin/terms/${t.id}">Grid</a>
          <a href="/admin/terms/${t.id}/edit">Edit</a>
          <a href="/admin/terms/${t.id}/rerun">Re-run</a>
          <a href="/admin/waitlist?term=${t.id}">Waitlist${t.waiting ? ` (${t.waiting})` : ''}</a>
        </td>
      </tr>
    `);
    return html`
      <section class="class-card">
        <h2>${cls.name}${cls.active ? '' : html` <span class="muted">(inactive)</span>`}</h2>
        <p class="class-meta">${slotLabel(cls)}</p>
        ${rows.length ? html`
          <div class="table-scroll">
            <table class="booking-table">
              <thead><tr><th>Term</th><th>Status</th><th>Dates</th><th>Weeks</th><th>Families</th><th>Fewest seats left</th><th>Price</th><th></th></tr></thead>
              <tbody>${joinHtml(rows)}</tbody>
            </table>
          </div>` : html`<p class="muted">No terms yet.</p>`}
        ${cls.active ? html`<p><a href="/admin/terms/new?class=${cls.id}">New term for this class</a></p>` : ''}
      </section>
    `;
  });

  const body = html`
    <div class="admin-wide">
      <div class="page-head">
        <h1>Terms</h1>
        <a href="/admin/terms/new" class="button-link">New term</a>
      </div>
      ${noticeFor(req, NOTICES, ERRORS)}
      <p class="lede">Each class (weekly slot) runs in terms. Open a term to let families book; the grid shows who is booked, who came and who has paid.</p>
      ${sections.length ? joinHtml(sections) : html`<p>No classes yet. <a href="/admin/classes/new">Add a class</a> first.</p>`}
    </div>
  `;
  return pageResponse('Terms', body, { user, admin: true });
}

// --- New term ----------------------------------------------------------------------

async function newTermPage(env, user, values, { error = '', status = 200 } = {}) {
  const [classes, terms] = await Promise.all([loadClasses(env), loadAllTerms(env)]);
  if (!classes.some((c) => c.active)) return redirect('/admin/classes/new', 303);
  const body = html`
    <h1>New term</h1>
    <p class="lede">Choose the class, the first class date and the length — a session is made for every week except the holidays.
      Everything stays editable afterwards.</p>
    ${termForm({ mode: 'new', action: '/admin/terms/new', values, classes, terms, error, csrfToken: user.csrfToken, submitLabel: 'Create term' })}
  `;
  return pageResponse('New term', body, { user, admin: true, status });
}

// GET /admin/terms/new[?class=…] — prices and plan options prefilled from the
// class's most recent term.
export async function handleAdminTermNew(req, env) {
  const user = await requireAdmin(req, env);
  const classes = await loadClasses(env);
  const wanted = new URL(req.url).searchParams.get('class');
  const cls = classes.find((c) => c.id === wanted && c.active) || classes.find((c) => c.active);
  let values = { ...EMPTY_VALUES, class_id: cls ? cls.id : '', weeks: '10' };
  if (cls) {
    const latest = await env.DB.prepare(
      `SELECT * FROM terms WHERE class_id = ?1 ORDER BY starts_on DESC LIMIT 1`,
    ).bind(cls.id).first();
    if (latest) {
      const copy = valuesFromTerm(latest);
      values = {
        ...values,
        term_price: copy.term_price, casual_price: copy.casual_price, trial_price: copy.trial_price,
        returning_price: copy.returning_price, plan_instalments: copy.plan_instalments, plan_interval: copy.plan_interval,
      };
    }
  }
  return newTermPage(env, user, values);
}

// POST /admin/terms/new — one term per chosen class, each with its sessions,
// in one atomic batch.
export async function handleAdminTermNewPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, parsed, error } = readTermForm(form, { mode: 'new' });
  if (error) return newTermPage(env, user, values, { error, status: 400 });
  const classes = await loadClasses(env);
  const primary = classes.find((c) => c.id === values.class_id && c.active);
  if (!primary) return newTermPage(env, user, values, { error: 'Please choose a class.', status: 400 });
  const others = [...new Set(values.also)]
    .filter((id) => id !== primary.id)
    .map((id) => classes.find((c) => c.id === id && c.active))
    .filter(Boolean);

  const specs = [];
  for (const cls of [primary, ...others]) {
    if (cls.weekday === null || cls.weekday === undefined || !cls.start_time) {
      return newTermPage(env, user, values, { error: `${cls.name} has no regular day and start time — set them on the class first.`, status: 400 });
    }
    const plan = planForClass(cls, primary, parsed.dates);
    if (!plan.ok) return newTermPage(env, user, values, { error: datePlanError(plan.error, cls), status: 400 });
    if (await termNameTaken(env, cls.id, values.name)) {
      return newTermPage(env, user, values, { error: `${cls.name} already has a term called “${values.name}”.`, status: 400 });
    }
    let previousTermId = null;
    if (cls === primary && values.previous_term_id !== 'auto') {
      previousTermId = values.previous_term_id || null;
      if (previousTermId) {
        const prev = await loadTerm(env, previousTermId);
        if (!prev || prev.class_id !== cls.id) {
          return newTermPage(env, user, values, { error: 'The previous term must belong to the same class.', status: 400 });
        }
      }
    } else {
      previousTermId = await latestEarlierTerm(env, cls.id, plan.startsOn);
    }
    specs.push({
      classId: cls.id,
      name: values.name,
      startsOn: plan.startsOn,
      endsOn: plan.endsOn,
      termPriceCents: parsed.termPriceCents,
      casualPriceCents: parsed.casualPriceCents,
      trialPriceCents: parsed.trialPriceCents,
      returningPriceCents: parsed.returningPriceCents,
      returningOpensAt: parsed.returningOpensAt,
      publicOpensAt: parsed.publicOpensAt,
      previousTermId,
      planInstalments: parsed.planInstalments,
      planInterval: parsed.planInterval,
      status: values.open_now ? 'open' : 'draft',
      sessions: sessionStartsFor(plan.dates, cls.start_time),
      durationMins: cls.default_duration_mins,
      capacity: cls.default_capacity,
    });
  }

  const ids = await createTermsWithSessions(env, specs);
  logEvent('term_created_by_admin', { terms: ids.length, by: user.userId.slice(0, 8) });
  return redirect(`/admin/terms/${ids[0]}?ok=${ids.length > 1 ? 'terms-created' : 'term-created'}`, 303);
}

// --- The term grid ------------------------------------------------------------------

function cellHtml(code) {
  const cell = GRID_CELLS[code] || GRID_CELLS.none;
  if (code === 'none') return html`<td class="grid-cell grid-none"><span class="sr-only">${cell.label}</span></td>`;
  return html`<td class="grid-cell grid-${code}" title="${cell.label}"><span aria-hidden="true">${cell.symbol}</span><span class="sr-only">${cell.label}</span></td>`;
}

function statusActions(term, csrfToken) {
  const button = (status, label, secondary = true) => html`
    <form method="post" action="/admin/terms/${term.id}/status" class="inline-form">
      ${csrfField(csrfToken)}
      <input type="hidden" name="status" value="${status}">
      <button type="submit" class="button-small${secondary ? ' button-secondary' : ''}">${label}</button>
    </form>`;
  return joinHtml([
    term.status !== 'open' ? button('open', 'Open for bookings', false) : '',
    term.status === 'open' ? button('closed', 'Close term') : '',
    term.status === 'closed' ? button('draft', 'Back to draft') : '',
    term.status === 'draft' ? button('closed', 'Close term') : '',
  ]);
}

// GET /admin/terms/:id — families × weeks (D8).
export async function handleAdminTermGrid(req, env, params) {
  const user = await requireAdmin(req, env);
  const now = nowIso();
  const data = await loadTermGrid(env, params.id, now);
  if (!data) throw notFound();
  const { term, sessions, grid } = data;

  const head = sessions.map((s) => html`
    <th class="grid-week${s.status === 'cancelled' ? ' grid-week-cancelled' : ''}">
      <a href="/admin/sessions/${s.id}/roster">${shortDate(s.starts_at)}</a>
      ${s.status === 'cancelled' ? html`<br><span class="muted">cancelled</span>` : ''}
    </th>`);
  const rows = grid.map(({ booking: b, payment, cells }) => html`
    <tr class="${b.needs_attention ? 'row-attention' : ''}">
      <th scope="row" class="grid-family">
        <a href="/admin/bookings/${b.id}">${b.child_name}</a>
        <br><span class="muted">${b.parent_name || b.parent_email} · ${b.kind === 'term' ? 'Term' : b.kind === 'complimentary' ? 'Comp' : b.kind === 'trial' ? 'Trial' : 'Casual'}</span>
      </th>
      ${joinHtml(cells.map(cellHtml))}
      <td class="grid-payment grid-pay-${payment.tone}">${payment.label}</td>
      <td class="grid-owing">${payment.owingCents ? formatAud(payment.owingCents) : '—'}</td>
    </tr>`);
  const seats = sessions.map((s) => html`<td class="grid-seats">${s.status === 'cancelled' ? '–' : s.seats_left}</td>`);
  const owingTotal = grid.reduce((sum, r) => sum + r.payment.owingCents, 0);

  const body = html`
    <div class="admin-wide">
      <p class="breadcrumb"><a href="/admin/terms">Terms</a></p>
      <h1>${term.name} — ${term.class_name}</h1>
      ${noticeFor(req, NOTICES, ERRORS)}
      <p class="lede">${statusBadge(term.status)} · ${dateRange(term)} · ${sessions.filter((s) => s.status === 'scheduled').length} weeks
        · term ${formatAud(term.term_price_cents)}${term.returning_price_cents !== null ? ` (returning ${formatAud(term.returning_price_cents)})` : ''}
        · casual ${formatAud(term.casual_price_cents)}</p>
      <div class="inline-actions">
        ${statusActions(term, user.csrfToken)}
        <a href="/admin/terms/${term.id}/edit" class="button-link button-secondary button-small">Edit term &amp; weeks</a>
        <a href="/admin/terms/${term.id}/rerun" class="button-link button-secondary button-small">Re-run term</a>
        ${term.previous_term_id ? html`<a href="/admin/terms/${term.id}/auto-enrol" class="button-link button-secondary button-small">Auto-enrol returning families</a>` : ''}
        <a href="/admin/waitlist?term=${term.id}" class="button-link button-secondary button-small">Waitlist</a>
        <a href="/admin/bookings/new" class="button-link button-secondary button-small">New booking</a>
      </div>
      <ul class="grid-legend">${joinHtml(['present', 'absent', 'booked', 'cancelled', 'moved'].map((code) => html`
        <li><span class="grid-legend-symbol grid-${code}" aria-hidden="true">${GRID_CELLS[code].symbol}</span> ${GRID_CELLS[code].label.toLowerCase()}</li>`))}
      </ul>
      ${sessions.length ? html`
        <div class="table-scroll">
          <table class="booking-table term-grid">
            <thead><tr><th class="grid-family">Family</th>${joinHtml(head)}<th>Payment</th><th>Owing</th></tr></thead>
            <tbody>${rows.length ? joinHtml(rows) : html`<tr><td colspan="${sessions.length + 3}">No families booked yet.</td></tr>`}</tbody>
            <tfoot><tr><th scope="row" class="grid-family">Seats left</th>${joinHtml(seats)}<td></td><td>${owingTotal ? formatAud(owingTotal) : ''}</td></tr></tfoot>
          </table>
        </div>
        <form method="post" action="/admin/terms/${term.id}/grid.csv" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-secondary">Download grid CSV</button>
        </form>
      ` : html`<p>This term has no sessions. <a href="/admin/terms/${term.id}/edit">Add a week</a>.</p>`}
    </div>
  `;
  return pageResponse(term.name, body, { user, admin: true });
}

// POST /admin/terms/:id/grid.csv
export async function handleAdminTermGridCsv(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const data = await loadTermGrid(env, params.id, nowIso());
  if (!data) throw notFound();
  const { term, sessions, grid } = data;
  logEvent('term_grid_exported', { term_id: term.id.slice(0, 8), rows: grid.length });
  return csvResponse(
    `term-grid-${term.starts_on}.csv`,
    ['Child', 'Parent', 'Email', 'Phone', 'Booking',
      ...sessions.map((s) => `${sydneyFields(s.starts_at).date}${s.status === 'cancelled' ? ' (cancelled)' : ''}`),
      'Payment', 'Owed', 'Received', 'Owing'],
    grid.map(({ booking: b, payment, cells }) => [
      b.child_name, b.parent_name, b.parent_email, b.parent_phone, b.kind,
      ...cells.map((code) => (code === 'none' ? '' : GRID_CELLS[code].label)),
      payment.label,
      formatAud(b.amount_cents + b.credit_cents),
      formatAud(b.received_cents),
      formatAud(payment.owingCents),
    ]),
  );
}

// --- Edit a term, its weeks and its status -----------------------------------------------

async function editTermPage(env, user, term, values, { error = '', status = 200, req = null } = {}) {
  const now = nowIso();
  const [classes, allTerms, sessions] = await Promise.all([loadClasses(env), loadAllTerms(env), listTermSessions(env, term.id, { now })]);
  const cls = classes.find((c) => c.id === term.class_id);
  const sameClass = allTerms.filter((t) => t.class_id === term.class_id && t.id !== term.id);
  const used = new Map();
  for (const s of sessions) used.set(s.id, await sessionHasBookings(env, s.id));
  const last = sessions.length ? sydneyFields(sessions[sessions.length - 1].starts_at).date : term.starts_on;

  const weekRows = sessions.map((s) => html`
    <tr class="${s.status === 'cancelled' ? 'row-cancelled' : ''}">
      <td>${formatSydney(s.starts_at)}</td>
      <td>${s.status === 'cancelled' ? `Cancelled${s.cancelled_reason ? ` — ${s.cancelled_reason}` : ''}` : s.is_past ? 'Finished' : 'Scheduled'}</td>
      <td>${s.seats_held}/${s.capacity}</td>
      <td>${formatAud(s.casual_price_cents)}</td>
      <td class="table-actions">
        <a href="/admin/sessions/${s.id}/roster">Roster</a>
        <a href="/admin/sessions/${s.id}/edit">Edit</a>
        ${s.status === 'scheduled' ? html`<a href="/admin/sessions/${s.id}/cancel">Cancel week</a>` : ''}
        ${used.get(s.id) ? '' : html`
          <details class="inline-details">
            <summary>Remove week</summary>
            <form method="post" action="/admin/terms/${term.id}/remove-week" class="inline-form">
              ${csrfField(user.csrfToken)}
              <input type="hidden" name="session" value="${s.id}">
              <button type="submit" class="button-small button-danger">Yes, remove this week</button>
            </form>
          </details>`}
      </td>
    </tr>`);

  const body = html`
    <p class="breadcrumb"><a href="/admin/terms">Terms</a> › <a href="/admin/terms/${term.id}">${term.name}</a></p>
    <h1>Edit ${term.name}</h1>
    ${req ? noticeFor(req, NOTICES, ERRORS) : ''}
    <p class="lede">${statusBadge(term.status)} · ${cls ? `${cls.name} — ${slotLabel(cls)}` : ''}</p>
    <div class="inline-actions">${statusActions(term, user.csrfToken)}</div>
    <h2>Weeks</h2>
    <div class="table-scroll">
      <table class="booking-table">
        <thead><tr><th>When (Sydney)</th><th>Status</th><th>Seats</th><th>Casual price</th><th></th></tr></thead>
        <tbody>${weekRows.length ? joinHtml(weekRows) : html`<tr><td colspan="5">No weeks yet.</td></tr>`}</tbody>
      </table>
    </div>
    <form method="post" action="/admin/terms/${term.id}/add-week" class="inline-form add-week-form">
      ${csrfField(user.csrfToken)}
      <label for="week_date">Add a week on</label>
      <input type="date" id="week_date" name="date" value="${addDays(last, 7)}" required>
      <button type="submit" class="button-small">Add week</button>
    </form>
    <p class="form-hint">A week with bookings can't be removed — cancel it instead, and the families are told and credited.</p>
    <h2>Term details</h2>
    ${termForm({
      mode: 'edit', action: `/admin/terms/${term.id}/edit`, values, terms: sameClass, error,
      csrfToken: user.csrfToken, fixedClass: cls, submitLabel: 'Save term',
    })}
  `;
  return pageResponse(`Edit ${term.name}`, body, { user, admin: true, status });
}

// GET /admin/terms/:id/edit
export async function handleAdminTermEdit(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  return editTermPage(env, user, term, valuesFromTerm(term), { req });
}

// POST /admin/terms/:id/edit — prices and options apply to future bookings
// only: amounts already on bookings are never touched.
export async function handleAdminTermEditPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, parsed, error } = readTermForm(form, { mode: 'edit' });
  if (error) return editTermPage(env, user, term, values, { error, status: 400 });
  if (await termNameTaken(env, term.class_id, values.name, term.id)) {
    return editTermPage(env, user, term, values, { error: `This class already has a term called “${values.name}”.`, status: 400 });
  }
  let previousTermId = values.previous_term_id || null;
  if (previousTermId === 'auto') previousTermId = term.previous_term_id || null;
  if (previousTermId) {
    const prev = await loadTerm(env, previousTermId);
    if (!prev || prev.class_id !== term.class_id || prev.id === term.id) {
      return editTermPage(env, user, term, values, { error: 'The previous term must be another term of the same class.', status: 400 });
    }
  }

  const now = nowIso();
  const statements = [env.DB.prepare(
    `UPDATE terms SET name = ?2, term_price_cents = ?3, casual_price_cents = ?4, trial_price_cents = ?5,
            returning_price_cents = ?6, returning_opens_at = ?7, public_opens_at = ?8, previous_term_id = ?9,
            plan_instalments = ?10, plan_interval = ?11
     WHERE id = ?1`,
  ).bind(term.id, values.name, parsed.termPriceCents, parsed.casualPriceCents, parsed.trialPriceCents,
    parsed.returningPriceCents, parsed.returningOpensAt, parsed.publicOpensAt, previousTermId,
    parsed.planInstalments, parsed.planInterval)];
  if (values.apply_casual) {
    statements.push(env.DB.prepare(
      `UPDATE class_sessions SET casual_price_cents = ?2 WHERE term_id = ?1 AND status = 'scheduled' AND starts_at > ?3`,
    ).bind(term.id, parsed.casualPriceCents, now));
  }
  await env.DB.batch(statements);
  logEvent('term_updated', { term_id: term.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/terms/${term.id}?ok=term-updated`, 303);
}

// POST /admin/terms/:id/add-week — one more session at the class time, with
// the class defaults (or the last week's) and the term's casual price.
export async function handleAdminTermAddWeek(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const date = String(form.get('date') || '').trim();
  if (!isDateStr(date)) return redirect(`/admin/terms/${term.id}/edit?err=week-date`, 303);
  const last = await env.DB.prepare(
    `SELECT starts_at, duration_mins, capacity FROM class_sessions WHERE term_id = ?1 ORDER BY starts_at DESC LIMIT 1`,
  ).bind(term.id).first();
  const time = term.start_time || (last ? sydneyFields(last.starts_at).time : null);
  if (!time) return redirect(`/admin/terms/${term.id}/edit?err=class-time`, 303);
  const startsAt = sydneyToUtc(date, time);
  if (!startsAt) return redirect(`/admin/terms/${term.id}/edit?err=week-date`, 303);

  const result = await env.DB.prepare(
    `INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8
     WHERE NOT EXISTS (SELECT 1 FROM class_sessions WHERE class_id = ?2 AND starts_at = ?4)`,
  ).bind(uuid(), term.class_id, term.id, startsAt, last ? last.duration_mins : term.default_duration_mins,
    last ? last.capacity : term.default_capacity, term.casual_price_cents, nowIso()).run();
  if (result.meta.changes === 0) return redirect(`/admin/terms/${term.id}/edit?err=week-exists`, 303);
  await syncTermDates(env, term.id);
  logEvent('term_week_added', { term_id: term.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/terms/${term.id}/edit?ok=week-added`, 303);
}

// POST /admin/terms/:id/remove-week — only a week nobody has booked.
export async function handleAdminTermRemoveWeek(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const sessionId = String(form.get('session') || '');
  if (!isValidId(sessionId)) throw notFound();
  const removed = await removeTermSession(env, term.id, sessionId);
  if (!removed) return redirect(`/admin/terms/${term.id}/edit?err=week-has-bookings`, 303);
  await syncTermDates(env, term.id);
  logEvent('term_week_removed', { term_id: term.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/terms/${term.id}/edit?ok=week-removed`, 303);
}

// POST /admin/terms/:id/status — open / close / back to draft (reversible).
export async function handleAdminTermStatus(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const status = String(form.get('status') || '');
  if (!TERM_STATUSES.includes(status)) throw notFound();
  await env.DB.prepare(`UPDATE terms SET status = ?2 WHERE id = ?1`).bind(term.id, status).run();
  logEvent('term_status_changed', { term_id: term.id.slice(0, 8), status, by: user.userId.slice(0, 8) });
  return redirect(`/admin/terms/${term.id}?ok=status-${status}`, 303);
}

// --- Re-run a term ------------------------------------------------------------------

async function rerunPage(env, user, source, values, { error = '', status = 200 } = {}) {
  const classes = await loadClasses(env);
  const cls = classes.find((c) => c.id === source.class_id);
  const body = html`
    <p class="breadcrumb"><a href="/admin/terms">Terms</a> › <a href="/admin/terms/${source.id}">${source.name}</a></p>
    <h1>Re-run ${source.name}</h1>
    <p class="lede">A copy of ${source.name} with new dates. It is created as a draft with ${source.name} as its previous term,
      so you can then hold places for this term's families before anyone else can book.</p>
    ${termForm({
      mode: 'rerun', action: `/admin/terms/${source.id}/rerun`, values, error, csrfToken: user.csrfToken,
      fixedClass: cls, submitLabel: 'Create the new term',
    })}
  `;
  return pageResponse(`Re-run ${source.name}`, body, { user, admin: true, status });
}

// GET /admin/terms/:id/rerun — prefilled: next term's name, same length
// starting two weeks after this one ends, same prices and options.
export async function handleAdminTermRerun(req, env, params) {
  const user = await requireAdmin(req, env);
  const source = await loadTerm(env, params.id);
  if (!source) throw notFound();
  const defaults = rerunDefaults(source);
  const values = {
    ...valuesFromTerm(source),
    name: defaults.name,
    starts_on: defaults.startsOn,
    weeks: String(defaults.weeks),
    returning_opens_at: utcToDatetimeLocal(defaults.returningOpensAt),
    public_opens_at: utcToDatetimeLocal(defaults.publicOpensAt),
    previous_term_id: source.id,
  };
  return rerunPage(env, user, source, values);
}

// POST /admin/terms/:id/rerun — create the new (draft) term and its sessions.
export async function handleAdminTermRerunPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const source = await loadTerm(env, params.id);
  if (!source) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, parsed, error } = readTermForm(form, { mode: 'rerun' });
  values.previous_term_id = source.id;
  if (error) return rerunPage(env, user, source, values, { error, status: 400 });
  if (source.weekday === null || source.weekday === undefined || !source.start_time) {
    return rerunPage(env, user, source, values, { error: 'This class has no regular day and start time — set them on the class first.', status: 400 });
  }
  const plan = planTermDates({ ...parsed.dates, weekday: source.weekday });
  if (!plan.ok) return rerunPage(env, user, source, values, { error: datePlanError(plan.error, { ...source, name: source.class_name }), status: 400 });
  if (await termNameTaken(env, source.class_id, values.name)) {
    return rerunPage(env, user, source, values, { error: `This class already has a term called “${values.name}”.`, status: 400 });
  }
  const [termId] = await createTermsWithSessions(env, [{
    classId: source.class_id,
    name: values.name,
    startsOn: plan.startsOn,
    endsOn: plan.endsOn,
    termPriceCents: parsed.termPriceCents,
    casualPriceCents: parsed.casualPriceCents,
    trialPriceCents: parsed.trialPriceCents,
    returningPriceCents: parsed.returningPriceCents,
    returningOpensAt: parsed.returningOpensAt,
    publicOpensAt: parsed.publicOpensAt,
    previousTermId: source.id,
    planInstalments: parsed.planInstalments,
    planInterval: parsed.planInterval,
    status: 'draft',
    sessions: sessionStartsFor(plan.dates, source.start_time),
    durationMins: source.default_duration_mins,
    capacity: source.default_capacity,
  }]);
  logEvent('term_rerun', { from: source.id.slice(0, 8), term_id: termId.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/terms/${termId}/auto-enrol?ok=rerun-created`, 303);
}

// --- Auto-enrol -------------------------------------------------------------------

// GET /admin/terms/:id/auto-enrol — the previous term's families, term
// families ticked; trial/casual/complimentary listed but not ticked.
export async function handleAdminAutoEnrol(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  const now = nowIso();
  const previous = term.previous_term_id ? await loadTerm(env, term.previous_term_id) : null;
  const candidates = previous ? await autoEnrolCandidates(env, term, now) : [];
  const holdUntil = autoEnrolExpiry(term, now);
  const price = term.returning_price_cents ?? term.term_price_cents;

  const items = candidates.map((c) => {
    const disabled = c.alreadyHeld || c.archived;
    return html`
      <li>
        <label>
          <input type="checkbox" name="child" value="${c.childId}" ${c.termFamily && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <strong>${c.childName}</strong> — ${c.parentName || c.parentEmail}
          <span class="muted">(${c.kindLabels.join(', ')} in ${previous.name})</span>
          ${c.alreadyHeld ? html`<span class="muted"> · already has a place in ${term.name}</span>` : ''}
          ${c.archived ? html`<span class="muted"> · child archived</span>` : ''}
        </label>
      </li>`;
  });

  const body = html`
    <p class="breadcrumb"><a href="/admin/terms">Terms</a> › <a href="/admin/terms/${term.id}">${term.name}</a></p>
    <h1>Hold places for returning families</h1>
    ${noticeFor(req, NOTICES, ERRORS)}
    ${previous ? html`
      <p class="lede">Each ticked child gets a place held in <strong>${term.name}</strong> (${term.class_name}) at
        ${formatAud(price)}${term.returning_price_cents !== null ? ' (the returning price)' : ''}, less any account credit,
        until <strong>${formatSydney(holdUntil)}</strong>. Their parent is emailed to sign in and press Pay now.
        Places not paid by then are released to everyone.</p>
      <p class="form-hint">Families who came for a trial or casual classes aren't ticked — tick them to invite them too.</p>
      ${items.length ? html`
        <form method="post" action="/admin/terms/${term.id}/auto-enrol" class="booking-form">
          ${csrfField(user.csrfToken)}
          <ul class="check-list plain-list">${joinHtml(items)}</ul>
          <button type="submit">Hold places and send invitations</button>
        </form>
      ` : html`<p>Nobody had a confirmed booking in ${previous.name}.</p>`}
    ` : html`<p>${term.name} has no previous term. <a href="/admin/terms/${term.id}/edit">Choose its previous term</a> to see who can be invited back.</p>`}
  `;
  return pageResponse('Auto-enrol', body, { user, admin: true });
}

const AUTO_ENROL_ERRORS = {
  full: 'no seat left in one of the weeks',
  already_booked: 'already booked into this term',
  finished: 'the term has finished',
  not_found: 'the term could not be found',
  child: 'child archived or not found',
  capacity: 'no seat left in one of the weeks',
  unavailable: 'one of the weeks is unavailable',
  credit_changed: 'account credit changed — try again',
};

// POST /admin/terms/:id/auto-enrol — one pending booking per ticked child
// (capacity-guarded), then the re-enrol invitation (once per term and child).
export async function handleAdminAutoEnrolPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const term = await loadTerm(env, params.id);
  if (!term) throw notFound();
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const now = nowIso();
  const candidates = await autoEnrolCandidates(env, term, now);
  const wanted = new Set(form.getAll('child').map(String).filter((id) => isValidId(id)));
  const chosen = candidates.filter((c) => wanted.has(c.childId));
  const expiresAt = autoEnrolExpiry(term, now);
  const accountUrl = `${env.PUBLIC_BASE_URL}/account`;

  const results = [];
  for (const c of chosen) {
    if (c.alreadyHeld) {
      results.push({ c, outcome: 'Skipped — already has a place' });
      continue;
    }
    let enrolled;
    try {
      enrolled = await autoEnrolChild(env, { term, userId: c.userId, childId: c.childId, now, expiresAt });
    } catch (err) {
      logError('auto_enrol_failed', err, { term_id: term.id.slice(0, 8) });
      results.push({ c, outcome: 'Failed — please try again' });
      continue;
    }
    if (!enrolled.ok) {
      results.push({ c, outcome: `Skipped — ${AUTO_ENROL_ERRORS[enrolled.error] || enrolled.error}` });
      continue;
    }
    let mail;
    if (enrolled.confirmed) {
      mail = await notifyBookingConfirmed(env, enrolled.bookingId);
    } else {
      const message = reenrolInvitation({
        parentName: c.parentName, childName: c.childName, termName: term.name, className: term.class_name,
        amountCents: enrolled.amountCents, payByAt: enrolled.expiresAt, accountUrl,
      });
      mail = await sendTemplate(env, {
        template: 'reenrol_invitation', to: c.parentEmail, userId: c.userId, bookingId: enrolled.bookingId,
        termId: term.id, dedupeKey: `reenrol:${term.id}:${c.childId}`, ...message,
      });
    }
    const emailed = mail && (mail.sent || mail.skipped);
    results.push({
      c,
      bookingId: enrolled.bookingId,
      outcome: enrolled.confirmed
        ? `Booked — fully covered by account credit${emailed ? ', confirmation sent' : ''}`
        : `Place held until ${shortDate(enrolled.expiresAt)} for ${formatAud(enrolled.amountCents)}${emailed ? ' — invitation sent' : ' — email could not be sent'}`,
    });
  }
  logEvent('auto_enrol_run', { term_id: term.id.slice(0, 8), chosen: chosen.length, by: user.userId.slice(0, 8) });

  const rows = results.map((r) => html`
    <tr>
      <td>${r.bookingId ? html`<a href="/admin/bookings/${r.bookingId}">${r.c.childName}</a>` : r.c.childName}</td>
      <td>${r.c.parentName || '—'}<br><span class="muted">${r.c.parentEmail}</span></td>
      <td>${r.outcome}</td>
    </tr>`);
  const body = html`
    <p class="breadcrumb"><a href="/admin/terms">Terms</a> › <a href="/admin/terms/${term.id}">${term.name}</a></p>
    <h1>Places held</h1>
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Child</th><th>Parent</th><th>Result</th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>` : html`<p>No families were ticked.</p>`}
    <p>When you're ready for everyone else, open the term from <a href="/admin/terms/${term.id}">its grid</a>.</p>
  `;
  return pageResponse('Places held', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/terms', handleAdminTerms);
  route('GET', '/admin/terms/new', handleAdminTermNew);
  route('POST', '/admin/terms/new', handleAdminTermNewPost);
  route('GET', '/admin/terms/:id', handleAdminTermGrid);
  route('POST', '/admin/terms/:id/grid.csv', handleAdminTermGridCsv);
  route('GET', '/admin/terms/:id/edit', handleAdminTermEdit);
  route('POST', '/admin/terms/:id/edit', handleAdminTermEditPost);
  route('POST', '/admin/terms/:id/add-week', handleAdminTermAddWeek);
  route('POST', '/admin/terms/:id/remove-week', handleAdminTermRemoveWeek);
  route('POST', '/admin/terms/:id/status', handleAdminTermStatus);
  route('GET', '/admin/terms/:id/rerun', handleAdminTermRerun);
  route('POST', '/admin/terms/:id/rerun', handleAdminTermRerunPost);
  route('GET', '/admin/terms/:id/auto-enrol', handleAdminAutoEnrol);
  route('POST', '/admin/terms/:id/auto-enrol', handleAdminAutoEnrolPost);
}
