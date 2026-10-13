// Admin email (parent-comms spec, design D10).
//
//   /admin/email      the owner writes one message for a group — a term's
//                     families (live bookings), a term's waitlist, or every
//                     current family — previews it with a real name and the
//                     recipient count, then sends it: one email per parent,
//                     addressed only to them, through sendTemplate. The batch
//                     id from the preview is the dedupe key
//                     (bulk:<batch>:<user>), so a double-click, a refresh or a
//                     retry after a failure never emails anyone twice.
//   /admin/email/log  every email the system has sent (email_log), newest
//                     first, filtered by type, term, recipient and status.
//
// Security: requireAdmin on every route (live ADMIN_EMAILS check), CSRF on
// every POST (preview included, so message text never travels in a URL),
// output through the auto-escaping html`` template (the owner's text and
// every family's name arrive as text), logs carry counts and id prefixes
// only — never addresses or subjects.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { uuid, nowIso } from '../lib/db.js';
import { isValidId, cleanText, parseIntInRange } from '../lib/validate.js';
import { formatSydney } from '../lib/time.js';
import { bookingLiveSql } from '../lib/domain.js';
import { sendTemplate, tallySends } from '../lib/notify.js';
import { bulk } from '../lib/emails/ops.js';
import { logEvent } from '../lib/log.js';
import { containsPattern } from '../lib/admin-ops.js';

export const AUDIENCES = ['term', 'waitlist', 'all'];
const AUDIENCE_LABELS = {
  term: 'Families booked into a term',
  waitlist: "Families on a term's waitlist",
  all: "All current families — everyone booked into a class that's still to come",
};
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
const LOG_PAGE_SIZE = 50;

// What each email_log.template means, in the owner's words: one entry per
// template name the code sends (a unit test checks every `template:` in
// src/ has a label here).
export const TEMPLATE_LABELS = {
  booking_confirmed: 'Booking confirmation',
  pay_later_hold: 'Place held — please pay (your booking)',
  reminder: 'Class reminder (day before)',
  session_cancelled: 'Class cancelled',
  waitlist_offer: 'Waitlist offer',
  plan_failed: 'Payment did not go through',
  plan_overdue: 'Overdue payment reminder',
  reenrol_invitation: 'Re-enrol invitation',
  offline_receipt: 'Payment receipt',
  trial_followup: 'Trial follow-up',
  bulk: 'Your message to families',
  owner_alert: 'Alert to you',
  owner_attention: 'Needs attention — alert to you',
  owner_plan_failed: 'Payment failed — alert to you',
  owner_session_cancelled: 'Class cancelled — summary to you',
  owner_waitlist_declined: 'Waitlist place declined — alert to you',
  owner_offer_lapsed: 'Waitlist offer lapsed — alert to you',
};

export function templateLabel(template) {
  return TEMPLATE_LABELS[template] || String(template || '').replace(/_/g, ' ');
}

// --- Audiences -----------------------------------------------------------------

// One recipient per parent: { userId, email, parentName, children: [names] },
// sorted by name.
//   term     — live bookings (confirmed, or an unexpired hold) in the term
//   waitlist — the term's entries still waiting or holding an offer
//   all      — live bookings with a booked week still to come
export async function audienceRecipients(env, { audience, termId = null, now = nowIso() }) {
  let statement;
  if (audience === 'term') {
    statement = env.DB.prepare(
      `SELECT DISTINCT u.id AS user_id, u.email, u.name AS parent_name, ch.name AS child_name
       FROM bookings b JOIN users u ON u.id = b.user_id JOIN children ch ON ch.id = b.child_id
       WHERE b.term_id = ?1 AND ${bookingLiveSql('b', '?2')}`,
    ).bind(termId, now);
  } else if (audience === 'waitlist') {
    statement = env.DB.prepare(
      `SELECT DISTINCT u.id AS user_id, u.email, u.name AS parent_name, ch.name AS child_name
       FROM waitlist w JOIN users u ON u.id = w.user_id JOIN children ch ON ch.id = w.child_id
       WHERE w.term_id = ?1 AND w.status IN ('waiting', 'offered')`,
    ).bind(termId);
  } else if (audience === 'all') {
    statement = env.DB.prepare(
      `SELECT DISTINCT u.id AS user_id, u.email, u.name AS parent_name, ch.name AS child_name
       FROM bookings b JOIN users u ON u.id = b.user_id JOIN children ch ON ch.id = b.child_id
       WHERE ${bookingLiveSql('b', '?1')}
         AND EXISTS (SELECT 1 FROM booking_sessions bs JOIN class_sessions cs ON cs.id = bs.session_id
                     WHERE bs.booking_id = b.id AND bs.status = 'booked' AND cs.status = 'scheduled'
                       AND cs.starts_at > ?1)`,
    ).bind(now);
  } else {
    return [];
  }
  const rows = (await statement.all()).results || [];
  const byUser = new Map();
  for (const r of rows) {
    const entry = byUser.get(r.user_id) || { userId: r.user_id, email: r.email, parentName: r.parent_name || '', children: [] };
    if (!entry.children.includes(r.child_name)) entry.children.push(r.child_name);
    byUser.set(r.user_id, entry);
  }
  const sortName = (r) => (r.parentName || r.email).toLowerCase();
  return [...byUser.values()].sort((a, b) => sortName(a).localeCompare(sortName(b)));
}

// Send one batch: every recipient individually, deduped on the batch id.
// Returns { outcomes: [{ …recipient, result }], sent, skipped, failed }.
export async function sendBulk(env, { batchId, recipients, subject, bodyText, termId = null }) {
  const outcomes = [];
  for (const r of recipients) {
    const message = bulk({ subject, bodyText, parentName: r.parentName });
    const result = await sendTemplate(env, {
      template: 'bulk', to: r.email, userId: r.userId, termId,
      dedupeKey: `bulk:${batchId}:${r.userId}`, ...message,
    });
    outcomes.push({ ...r, result });
  }
  return { outcomes, ...tallySends(outcomes.map((o) => o.result)) };
}

// --- Form handling ---------------------------------------------------------

async function loadTerms(env) {
  return (await env.DB.prepare(
    `SELECT t.id, t.name, t.status, t.starts_on, c.name AS class_name
     FROM terms t JOIN classes c ON c.id = t.class_id
     ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, t.starts_on DESC, c.start_time, c.name`,
  ).all()).results || [];
}

// Validate the compose fields. Returns { values, error } (error null = ok).
export function readCompose(get) {
  const values = {
    audience: String(get('audience') || ''),
    term: String(get('term') || ''),
    subject: cleanText(get('subject'), SUBJECT_MAX + 100).replace(/\s+/g, ' ').trim(),
    body: cleanText(String(get('body') || '').replace(/\r\n?/g, '\n'), BODY_MAX + 1000),
  };
  let error = null;
  if (!AUDIENCES.includes(values.audience)) error = 'Please choose who should get the email.';
  else if (values.audience !== 'all' && !isValidId(values.term)) error = 'Please choose a term.';
  else if (!values.subject) error = 'Please write a subject line.';
  else if (values.subject.length > SUBJECT_MAX) error = `Please keep the subject under ${SUBJECT_MAX} characters.`;
  else if (!values.body) error = 'Please write your message.';
  else if (values.body.length > BODY_MAX) error = `Please keep the message under ${BODY_MAX} characters.`;
  return { values, error };
}

function audienceDescription(audience, term) {
  if (audience === 'all') return "every current family (anyone booked into a class that's still to come)";
  const name = term ? `${term.class_name} — ${term.name}` : 'the term';
  return audience === 'waitlist' ? `everyone on the ${name} waitlist` : `everyone booked into ${name}`;
}

function composeForm(user, terms, values) {
  const groups = [['open', 'Open terms'], ['draft', 'Draft terms'], ['closed', 'Closed terms']].map(([status, label]) => {
    const options = terms.filter((t) => t.status === status).map((t) => html`
      <option value="${t.id}" ${t.id === values.term ? 'selected' : ''}>${t.class_name} — ${t.name}</option>`);
    return options.length ? html`<optgroup label="${label}">${joinHtml(options)}</optgroup>` : '';
  });
  const audience = AUDIENCES.includes(values.audience) ? values.audience : 'term';
  const radios = AUDIENCES.map((a) => html`
    <label class="email-audience">
      <input type="radio" name="audience" value="${a}" ${a === audience ? 'checked' : ''}>
      <span>${AUDIENCE_LABELS[a]}</span>
    </label>`);
  return html`
    <form method="post" action="/admin/email/preview" class="booking-form email-compose">
      ${csrfField(user.csrfToken)}
      <fieldset class="form-group consent-group">
        <legend>Who should get it?</legend>
        ${joinHtml(radios)}
      </fieldset>
      <div class="form-group">
        <label for="term">Which term (for a term's families or its waitlist)</label>
        <select id="term" name="term">
          <option value="">Choose a term…</option>
          ${joinHtml(groups)}
        </select>
      </div>
      <div class="form-group">
        <label for="subject">Subject</label>
        <input type="text" id="subject" name="subject" value="${values.subject}" maxlength="${SUBJECT_MAX}" required>
      </div>
      <div class="form-group">
        <label for="body">Message</label>
        <textarea id="body" name="body" rows="12" maxlength="${BODY_MAX}" required>${values.body}</textarea>
        <p class="muted">Each family's copy starts “Hi &lt;their name&gt;,” and ends with your sign-off, so just write
          the message itself. Leave an empty line between paragraphs.</p>
      </div>
      <button type="submit">Preview</button>
    </form>
  `;
}

async function composePage(env, user, { values, error = '', status = 200 }) {
  const terms = await loadTerms(env);
  const body = html`
    <div class="ops-page">
      <h1>Email families</h1>
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
      <p class="lede">Write one message and send it to a group of families. Each family gets their own copy,
        addressed only to them, and every email is kept in the <a href="/admin/email/log">email log</a>.
        You'll see a preview before anything is sent.</p>
      <p class="muted">This is for news about the classes families are booked into or waiting for. For promotions
        (say, a new term to past families), use a mailing-list tool that includes an unsubscribe link.</p>
      ${composeForm(user, terms, values)}
    </div>
  `;
  return pageResponse('Email families', body, { user, admin: true, status });
}

async function termForAudience(env, values) {
  if (values.audience === 'all') return { ok: true, term: null };
  const term = await env.DB.prepare(
    `SELECT t.id, t.name, c.name AS class_name FROM terms t JOIN classes c ON c.id = t.class_id WHERE t.id = ?1`,
  ).bind(values.term).first();
  return term ? { ok: true, term } : { ok: false };
}

function hiddenMessage(values) {
  return html`
    <input type="hidden" name="audience" value="${values.audience}">
    <input type="hidden" name="term" value="${values.audience === 'all' ? '' : values.term}">
    <input type="hidden" name="subject" value="${values.subject}">
    <input type="hidden" name="body" value="${values.body}">
  `;
}

function recipientList(recipients) {
  return html`<ul class="email-recipients">${joinHtml(recipients.map((r) => html`
    <li>${r.parentName || 'No name on file'} — ${r.email}${r.children.length ? html` <span class="muted">(${r.children.join(', ')})</span>` : ''}</li>`))}</ul>`;
}

// --- Handlers ----------------------------------------------------------------

// GET /admin/email[?audience=…&term=…] — compose (the waitlist page's
// "Message this waitlist" link preselects the audience and term).
export async function handleAdminEmail(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const audience = url.searchParams.get('audience');
  const term = url.searchParams.get('term') || '';
  return composePage(env, user, {
    values: {
      audience: AUDIENCES.includes(audience) ? audience : 'term',
      term: isValidId(term) ? term : '',
      subject: '',
      body: '',
    },
  });
}

// POST /admin/email/preview — the message as one family will see it, with
// the recipient count and list. Nothing is sent.
export async function handlePreviewPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const { values, error } = readCompose((name) => form.get(name));
  if (error) return composePage(env, user, { values, error, status: 400 });
  const { ok, term } = await termForAudience(env, values);
  if (!ok) return composePage(env, user, { values, error: 'Please choose a term.', status: 400 });

  const recipients = await audienceRecipients(env, { audience: values.audience, termId: term ? term.id : null });
  const sample = recipients[0] || null;
  const message = bulk({ subject: values.subject, bodyText: values.body, parentName: sample ? sample.parentName : '' });
  const batch = uuid();
  const terms = await loadTerms(env);
  const count = recipients.length;

  const body = html`
    <div class="ops-page">
      <h1>Check your email</h1>
      ${count
        ? html`<p class="lede">This will go to <strong>${count} ${count === 1 ? 'family' : 'families'}</strong>:
            ${audienceDescription(values.audience, term)}. Each family gets their own copy, starting with their own name.</p>`
        : html`<p class="form-error" role="alert">Nobody matches — there's no one to send this to. Choose another group below.</p>`}
      ${count ? html`
        <details class="email-recipients-box">
          <summary>See who gets it (${count})</summary>
          ${recipientList(recipients)}
        </details>
      ` : ''}
      <section class="email-preview" aria-label="Email preview">
        <p class="email-preview__meta">${sample ? html`To: ${sample.email} · ` : ''}Subject: <strong>${message.subject}</strong></p>
        <div class="email-preview__body">${message.html}</div>
      </section>
      ${count ? html`
        <form method="post" action="/admin/email/send" class="email-send">
          ${csrfField(user.csrfToken)}
          ${hiddenMessage(values)}
          <input type="hidden" name="batch" value="${batch}">
          <button type="submit">Send to ${count} ${count === 1 ? 'family' : 'families'}</button>
        </form>
      ` : ''}
      <h2>Change something?</h2>
      ${composeForm(user, terms, values)}
    </div>
  `;
  return pageResponse('Check your email', body, { user, admin: true });
}

// POST /admin/email/send — send the previewed batch, one email per parent.
export async function handleSendPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const { values, error } = readCompose((name) => form.get(name));
  const batch = String(form.get('batch') || '');
  if (error || !isValidId(batch)) {
    return composePage(env, user, {
      values, error: error || 'That preview has expired — please press Preview again.', status: 400,
    });
  }
  const { ok, term } = await termForAudience(env, values);
  if (!ok) return composePage(env, user, { values, error: 'Please choose a term.', status: 400 });

  const recipients = await audienceRecipients(env, { audience: values.audience, termId: term ? term.id : null });
  const { outcomes, sent, skipped, failed } = await sendBulk(env, {
    batchId: batch, recipients, subject: values.subject, bodyText: values.body, termId: term ? term.id : null,
  });
  logEvent('bulk_email_sent', {
    batch: batch.slice(0, 8), audience: values.audience, recipients: recipients.length, sent, skipped, failed,
  });

  const outcomeLabel = (o) => (o.result.sent ? 'Sent' : o.result.skipped ? 'Already sent' : "Couldn't send");
  const logLink = `/admin/email/log?template=bulk${term ? `&term=${term.id}` : ''}`;
  const body = html`
    <div class="ops-page">
      <h1>${failed ? 'Email partly sent' : 'Email sent'}</h1>
      <p class="form-notice" role="status">Sent to ${sent} ${sent === 1 ? 'family' : 'families'}.${skipped
        ? ` ${skipped} already had this email, so they weren't sent it again.` : ''}</p>
      ${failed ? html`
        <p class="form-error" role="alert">${failed} email${failed === 1 ? '' : 's'} couldn't be sent. Press the button
          to try those again — nobody gets the email twice.</p>
        <form method="post" action="/admin/email/send" class="email-send">
          ${csrfField(user.csrfToken)}
          ${hiddenMessage(values)}
          <input type="hidden" name="batch" value="${batch}">
          <button type="submit">Try again</button>
        </form>
      ` : ''}
      <ul class="email-results">${joinHtml(outcomes.map((o) => html`
        <li><span class="email-results__status email-results__status--${o.result.sent ? 'sent' : o.result.skipped ? 'skipped' : 'failed'}">${outcomeLabel(o)}</span>
          ${o.parentName || 'No name on file'} — ${o.email}</li>`))}</ul>
      <p class="table-actions"><a href="${logLink}">See it in the email log</a> <a href="/admin/email">Write another email</a></p>
    </div>
  `;
  return pageResponse('Email sent', body, { user, admin: true });
}

// GET /admin/email/log[?template=…&term=…&q=…&status=…&page=…]
export async function handleEmailLog(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const templateParam = url.searchParams.get('template') || '';
  const template = /^[a-z_]{1,40}$/.test(templateParam) ? templateParam : null;
  const termParam = url.searchParams.get('term') || '';
  const termId = isValidId(termParam) ? termParam : null;
  const q = cleanText(url.searchParams.get('q'), 100).replace(/\s+/g, '').toLowerCase() || null;
  const statusParam = url.searchParams.get('status');
  const status = ['sent', 'failed', 'pending'].includes(statusParam) ? statusParam : null;
  const page = parseIntInRange(url.searchParams.get('page') || '1', 1, 10000) || 1;
  const like = q ? containsPattern(q) : null;

  const rows = (await env.DB.prepare(
    `SELECT el.id, el.template, el.to_email, el.subject, el.status, el.error, el.sent_at,
            t.name AS term_name, c.name AS class_name
     FROM email_log el
     LEFT JOIN terms t ON t.id = el.term_id
     LEFT JOIN classes c ON c.id = t.class_id
     WHERE (?1 IS NULL OR el.template = ?1)
       AND (?2 IS NULL OR el.term_id = ?2)
       AND (?3 IS NULL OR el.to_email LIKE ?3 ESCAPE '\\')
       AND (?4 IS NULL OR el.status = ?4)
     ORDER BY el.sent_at DESC, el.id DESC
     LIMIT ?5 OFFSET ?6`,
  ).bind(template, termId, like, status, LOG_PAGE_SIZE + 1, (page - 1) * LOG_PAGE_SIZE).all()).results || [];
  const hasMore = rows.length > LOG_PAGE_SIZE;
  const shown = rows.slice(0, LOG_PAGE_SIZE);

  const known = (await env.DB.prepare(`SELECT DISTINCT template FROM email_log ORDER BY template`).all()).results || [];
  const templates = [...new Set([...Object.keys(TEMPLATE_LABELS), ...known.map((r) => r.template)])]
    .sort((a, b) => templateLabel(a).localeCompare(templateLabel(b)));
  const terms = await loadTerms(env);

  const pageLink = (n) => {
    const params = new URLSearchParams();
    if (template) params.set('template', template);
    if (termId) params.set('term', termId);
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    params.set('page', String(n));
    return `/admin/email/log?${params.toString()}`;
  };

  const tableRows = shown.map((r) => html`
    <tr class="${r.status === 'failed' ? 'row-attention' : ''}">
      <td data-label="When">${formatSydney(r.sent_at)}</td>
      <td data-label="To">${r.to_email}</td>
      <td data-label="Email">${templateLabel(r.template)}<br><span class="muted">${r.subject}</span></td>
      <td data-label="Term">${r.term_name ? html`${r.class_name} — ${r.term_name}` : '—'}</td>
      <td data-label="Status">${r.status === 'sent' ? 'Sent' : r.status === 'pending'
    ? html`<span class="muted">Sending — not confirmed yet</span>`
    : html`<span class="email-status-failed">Failed</span>${r.error ? html`<br><span class="muted">${r.error}</span>` : ''}`}</td>
    </tr>
  `);

  const body = html`
    <div class="ops-page">
      <h1>Email log</h1>
      <p class="lede">Every email the system has sent, newest first — confirmations, reminders, offers,
        payment notices, your messages, and the alerts sent to you. (Sign-in links are never kept here.)
        A reminder that failed is tried again automatically by the next scheduled run (every 15 minutes).</p>
      <form method="get" action="/admin/email/log" class="email-log-filters">
        <label>Type
          <select name="template">
            <option value="">Every type</option>
            ${joinHtml(templates.map((t) => html`<option value="${t}" ${t === template ? 'selected' : ''}>${templateLabel(t)}</option>`))}
          </select>
        </label>
        <label>Term
          <select name="term">
            <option value="">Any term</option>
            ${joinHtml(terms.map((t) => html`<option value="${t.id}" ${t.id === termId ? 'selected' : ''}>${t.class_name} — ${t.name}</option>`))}
          </select>
        </label>
        <label>Email address contains
          <input type="text" name="q" value="${q || ''}" maxlength="100" autocomplete="off">
        </label>
        <label>Status
          <select name="status">
            <option value="">Any</option>
            <option value="sent" ${status === 'sent' ? 'selected' : ''}>Sent</option>
            <option value="failed" ${status === 'failed' ? 'selected' : ''}>Failed</option>
            <option value="pending" ${status === 'pending' ? 'selected' : ''}>Not confirmed yet</option>
          </select>
        </label>
        <button type="submit">Show</button>
      </form>
      ${shown.length ? html`
        <div class="table-scroll">
          <table class="booking-table email-log">
            <thead><tr><th>When (Sydney)</th><th>To</th><th>Email</th><th>Term</th><th>Status</th></tr></thead>
            <tbody>${joinHtml(tableRows)}</tbody>
          </table>
        </div>
      ` : html`<p>No emails match.</p>`}
      <p class="table-actions">
        ${page > 1 ? html`<a href="${pageLink(page - 1)}">Newer</a>` : ''}
        ${hasMore ? html`<a href="${pageLink(page + 1)}">Older</a>` : ''}
        <a href="/admin/email">Email families</a>
      </p>
    </div>
  `;
  return pageResponse('Email log', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/email', handleAdminEmail);
  route('POST', '/admin/email/preview', handlePreviewPost);
  route('POST', '/admin/email/send', handleSendPost);
  route('GET', '/admin/email/log', handleEmailLog);
}
