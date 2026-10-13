// Customer migration: CSV upload → preview → commit → invite emails.
//
// The whole facility is admin-only. Nothing is written at upload/preview
// time; committing is a separate explicit POST. The commit is idempotent,
// keyed on normalised parent email + child name: users are created with
// INSERT OR IGNORE on the unique email, children and bookings via guarded
// INSERT…WHERE NOT EXISTS (single statements are serialised by D1, so
// concurrent duplicate commits cannot double-insert). An enrolment names a
// class and a term (enrol_class, enrol_term) and becomes a confirmed,
// externally paid term booking covering the term's remaining sessions: it
// occupies capacity but never triggers payment, a confirmation email, or a
// Purchase conversion event. Blank enrolment columns import the family only.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { badRequest } from '../lib/http.js';
import { uuid, nowIso } from '../lib/db.js';
import { normaliseEmail, isValidEmail, normalisePhone, cleanText, validateDob } from '../lib/validate.js';
import { parseCsv, csvResponse } from '../lib/csv.js';
import { sendMagicLinkEmail } from './auth.js';
import { allowRate } from '../lib/ratelimit.js';
import { logEvent, logError, maskEmail } from '../lib/log.js';

const MAX_CSV_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const REQUIRED_COLUMNS = ['parent_name', 'parent_email', 'parent_phone', 'child_name', 'child_dob', 'medical_notes', 'photo_consent'];
const OPTIONAL_COLUMNS = ['enrol_class', 'enrol_term'];

function parseConsent(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(v)) return 'yes';
  if (['no', 'n', 'false', '0'].includes(v)) return 'no';
  return null;
}

// Parse + validate the whole file. Returns { error } for structural problems
// or { rows } where each row is { line, values, valid, reason, enrolment }.
async function analyseCsv(env, text) {
  if (text.length > MAX_CSV_BYTES) return { error: 'That file is too large — the import is meant for a small customer list.' };
  const parsed = parseCsv(text);
  if (!parsed || !parsed.length) return { error: 'That file could not be parsed as CSV. Export it as plain comma-separated values and try again.' };

  const header = parsed[0].map((h) => String(h).trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { error: `The CSV is missing required column(s): ${missing.join(', ')}.` };
  if (parsed.length - 1 > MAX_ROWS) return { error: `Too many rows (limit ${MAX_ROWS}).` };

  const col = (row, name) => {
    const idx = header.indexOf(name);
    return idx === -1 ? '' : String(row[idx] ?? '').trim();
  };

  // Resolve enrolment targets once: classes by name, terms by (class, name)
  // with their remaining scheduled sessions.
  const now = nowIso();
  const classes = (await env.DB.prepare(`SELECT id, name FROM classes`).all()).results || [];
  const classByName = new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const terms = (await env.DB.prepare(`SELECT id, class_id, name FROM terms`).all()).results || [];
  const termByClassName = new Map(terms.map((t) => [`${t.class_id}|${t.name.trim().toLowerCase()}`, t]));
  const sessions = (await env.DB.prepare(
    `SELECT id, term_id FROM class_sessions WHERE status = 'scheduled' AND term_id IS NOT NULL AND starts_at > ?1
     ORDER BY starts_at`,
  ).bind(now).all()).results || [];
  const remainingByTerm = new Map();
  for (const sess of sessions) {
    if (!remainingByTerm.has(sess.term_id)) remainingByTerm.set(sess.term_id, []);
    remainingByTerm.get(sess.term_id).push(sess.id);
  }

  const rows = [];
  for (let i = 1; i < parsed.length; i += 1) {
    const r = parsed[i];
    const values = {
      parent_name: cleanText(col(r, 'parent_name'), 100),
      parent_email: normaliseEmail(col(r, 'parent_email')),
      parent_phone: normalisePhone(col(r, 'parent_phone')),
      child_name: cleanText(col(r, 'child_name'), 100),
      child_dob: col(r, 'child_dob'),
      medical_notes: cleanText(col(r, 'medical_notes'), 2000),
      photo_consent: col(r, 'photo_consent'),
      enrol_class: col(r, 'enrol_class'),
      enrol_term: col(r, 'enrol_term'),
    };
    const line = i + 1; // 1-based, counting the header as line 1

    let reason = null;
    let consent = null;
    let enrolment = null;

    if (!isValidEmail(values.parent_email)) reason = 'invalid email address';
    else if (!values.child_name) reason = 'missing child name';
    else if (validateDob(values.child_dob)) reason = `invalid date of birth (${validateDob(values.child_dob)})`;
    else if ((consent = parseConsent(values.photo_consent)) === null) reason = `photo consent "${values.photo_consent}" is not a clear yes/no`;
    else if (values.enrol_class || values.enrol_term) {
      const classId = classByName.get(values.enrol_class.trim().toLowerCase());
      const term = classId ? termByClassName.get(`${classId}|${values.enrol_term.trim().toLowerCase()}`) : null;
      if (!classId) {
        reason = `unknown class "${values.enrol_class}"`;
      } else if (!values.enrol_term) {
        reason = 'enrol_class given but enrol_term is empty';
      } else if (!term) {
        reason = `no term "${values.enrol_term}" for class "${values.enrol_class}"`;
      } else if (!(remainingByTerm.get(term.id) || []).length) {
        reason = `term "${values.enrol_term}" has no sessions left`;
      } else {
        enrolment = { classId, termId: term.id, termName: term.name, sessionIds: remainingByTerm.get(term.id) };
      }
    }

    rows.push({ line, values: { ...values, photo_consent: consent ?? values.photo_consent }, valid: !reason, reason, enrolment });
  }

  if (!rows.length) return { error: 'The file has a header but no data rows.' };
  return { rows };
}

// Does this row match records that already exist? (for the preview)
async function rowExists(env, row) {
  const user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(row.values.parent_email).first();
  if (!user) return { parent: false, child: false };
  const child = await env.DB.prepare(
    `SELECT id FROM children WHERE user_id = ?1 AND lower(name) = lower(?2) AND archived_at IS NULL`,
  ).bind(user.id, row.values.child_name).first();
  return { parent: true, child: !!child };
}

// The CSV travels preview → commit → invites as a base64 hidden field, so
// nothing half-imported is ever stored server-side. (~20 customers ≈ a few KB.)
function encodePayload(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function decodePayload(b64) {
  try {
    const bytes = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_CSV_BYTES) return null;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// GET /admin/import — upload form.
export async function handleImport(req, env) {
  const user = await requireAdmin(req, env);
  const body = html`
    <h1>Customer import</h1>
    <p class="lede">Upload the migration CSV (<a href="/admin/import/template.csv">download the template</a>).
      Nothing is saved until you confirm the preview.</p>
    <form method="post" action="/admin/import/preview" enctype="multipart/form-data" class="booking-form">
      ${csrfField(user.csrfToken)}
      <div class="form-group">
        <label for="file">Migration CSV file</label>
        <input type="file" id="file" name="file" accept=".csv,text/csv" required>
      </div>
      <button type="submit">Preview import</button>
    </form>
  `;
  return pageResponse('Customer import', body, { user, admin: true });
}

// GET /admin/import/template.csv
export async function handleImportTemplate(req, env) {
  await requireAdmin(req, env);
  return csvResponse('migration-template.csv',
    [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS],
    [
      ['Jane Citizen', 'jane@example.com', '0412345678', 'Ava', '2025-10-01', 'Mild eczema', 'yes', 'Sensory Play — Wednesday 11:00 am', 'Term 1 2027'],
      ['Sam Smith', 'sam@example.com', '0412000000', 'Leo', '2025-12-01', '', 'no', '', ''],
    ]);
}

function previewTable(rows, statuses) {
  const body = rows.map((row, i) => html`
    <tr class="${row.valid ? '' : 'row-cancelled'}">
      <td>${row.line}</td>
      <td>${row.values.parent_email}</td>
      <td>${row.values.child_name}</td>
      <td>${row.enrolment ? `${row.enrolment.termName} (${row.enrolment.sessionIds.length} session(s))` : '—'}</td>
      <td>${row.valid ? (statuses ? statuses[i] : 'OK') : html`Invalid — ${row.reason}`}</td>
    </tr>
  `);
  return html`
    <table class="booking-table">
      <thead><tr><th>Line</th><th>Parent email</th><th>Child</th><th>Enrolment</th><th>Status</th></tr></thead>
      <tbody>${joinHtml(body)}</tbody>
    </table>
  `;
}

// POST /admin/import/preview — parse + validate, write nothing.
export async function handleImportPreview(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req, MAX_CSV_BYTES * 2);
  requireCsrf(req, user, form);

  const file = form.get('file');
  const text = file && typeof file.text === 'function' ? await file.text() : String(file || '');
  const { rows, error } = await analyseCsv(env, text);

  if (error) {
    const body = html`<h1>Customer import</h1><p class="form-error" role="alert">${error}</p>
      <p><a href="/admin/import">Try another file</a></p>`;
    return pageResponse('Customer import', body, { user, status: 400, admin: true });
  }

  const statuses = [];
  for (const row of rows) {
    if (!row.valid) { statuses.push(''); continue; }
    const exists = await rowExists(env, row);
    statuses.push(exists.child ? 'Matches existing parent + child' : exists.parent ? 'New child for existing parent' : 'New parent + child');
  }

  const validCount = rows.filter((r) => r.valid).length;
  const body = html`
    <h1>Import preview</h1>
    <p class="lede">${validCount} of ${rows.length} row(s) are valid. Nothing has been saved yet —
      committing imports the valid rows and skips the rest.</p>
    ${previewTable(rows, statuses)}
    <form method="post" action="/admin/import/commit" class="booking-form">
      ${csrfField(user.csrfToken)}
      <input type="hidden" name="payload" value="${encodePayload(text)}">
      <button type="submit" ${validCount ? '' : 'disabled'}>Commit import (${validCount} row${validCount === 1 ? '' : 's'})</button>
      <a href="/admin/import" class="button-link button-secondary">Start again</a>
    </form>
  `;
  return pageResponse('Import preview', body, { user, admin: true });
}

// Import one valid row. Returns a short human outcome string.
async function importRow(env, row) {
  const now = nowIso();
  const v = row.values;

  // Parent: unique email makes this race-safe; existing details are never
  // overwritten by an import.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, phone, role, created_at)
     VALUES (?1, ?2, ?3, ?4, 'parent', ?5)`,
  ).bind(uuid(), v.parent_email, v.parent_name, v.parent_phone, now).run();
  const parent = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(v.parent_email).first();

  // Child: guarded insert keyed on (parent, name) — idempotent and safe under
  // concurrent commits because the statement executes atomically.
  const childId = uuid();
  const childInsert = await env.DB.prepare(
    `INSERT INTO children (id, user_id, name, dob, medical_notes, photo_consent, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (SELECT 1 FROM children
                       WHERE user_id = ?2 AND lower(name) = lower(?3) AND archived_at IS NULL)`,
  ).bind(childId, parent.id, v.child_name, v.child_dob, v.medical_notes,
    v.photo_consent === 'yes' ? 1 : 0, now).run();
  const childCreated = childInsert.meta.changes > 0;
  const child = await env.DB.prepare(
    `SELECT id FROM children WHERE user_id = ?1 AND lower(name) = lower(?2) AND archived_at IS NULL`,
  ).bind(parent.id, v.child_name).first();

  let enrolNote = '';
  if (row.enrolment) {
    const { termId, sessionIds } = row.enrolment;
    // Idempotent re-import: skip if the child already has a confirmed term
    // booking for this term.
    const already = await env.DB.prepare(
      `SELECT 1 FROM bookings WHERE child_id = ?1 AND term_id = ?2 AND kind = 'term' AND status = 'confirmed' LIMIT 1`,
    ).bind(child.id, termId).first();

    if (already) {
      enrolNote = ', enrolment already exists';
    } else {
      // Confirmed, externally paid term booking (paid on the old system):
      // nothing owing, no payment flow, no conversion event. Weeks the child
      // already holds are left out. Consent/medical snapshots come from the
      // import; the waiver is accepted (versioned) on their next booking.
      const bookingId = uuid();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents,
                                 currency, payment_method, payment_status, payment_provider,
                                 photo_consent_snapshot, medical_notes_snapshot, admin_notes, created_at)
           VALUES (?1, ?2, ?3, 'term', ?4, 'confirmed', 0, 0, 'AUD', 'none', 'paid', 'external', ?5, ?6,
                   'Imported from ClassForKids', ?7)`,
        ).bind(bookingId, parent.id, child.id, termId, v.photo_consent === 'yes' ? 1 : 0, v.medical_notes, now),
        ...sessionIds.map((sid) => env.DB.prepare(
          `INSERT INTO booking_sessions (booking_id, session_id, status)
           SELECT ?1, ?2, 'booked'
           WHERE NOT EXISTS (SELECT 1 FROM booking_sessions bs JOIN bookings b ON b.id = bs.booking_id
                             WHERE bs.session_id = ?2 AND b.child_id = ?3 AND b.status = 'confirmed'
                               AND bs.status = 'booked')`,
        ).bind(bookingId, sid, child.id)),
      ]);
      enrolNote = `, enrolled in ${row.enrolment.termName}`;
    }
  }

  return `${childCreated ? 'Imported' : 'Already existed'}${enrolNote}`;
}

// POST /admin/import/commit — import all valid rows, report per row.
export async function handleImportCommit(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req, MAX_CSV_BYTES * 2);
  requireCsrf(req, user, form);

  const text = decodePayload(form.get('payload'));
  if (text === null) throw badRequest('The import payload was malformed — please re-upload the file.');

  const { rows, error } = await analyseCsv(env, text);
  if (error) throw badRequest(error);

  const statuses = [];
  let imported = 0;
  for (const row of rows) {
    if (!row.valid) { statuses.push(''); continue; }
    try {
      statuses.push(await importRow(env, row));
      imported += 1;
    } catch (err) {
      logError('import_row_failed', err, { line: row.line });
      statuses.push('Failed — see logs');
    }
  }

  logEvent('customers_imported', { rows: rows.length, imported });

  const body = html`
    <h1>Import complete</h1>
    <p class="lede">${imported} of ${rows.length} row(s) processed. Skipped rows are listed with their reason.</p>
    ${previewTable(rows, statuses)}
    <h2>Invite emails</h2>
    <p>Send each imported parent a magic sign-in link so they can check their details — no password needed.</p>
    <form method="post" action="/admin/import/invites" class="booking-form">
      ${csrfField(user.csrfToken)}
      <input type="hidden" name="payload" value="${encodePayload(text)}">
      <button type="submit">Send invite emails</button>
    </form>
  `;
  return pageResponse('Import complete', body, { user, admin: true });
}

// POST /admin/import/invites — magic-link invites to imported parents only,
// rate limited per address so repeat clicks cannot flood inboxes.
export async function handleImportInvites(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req, MAX_CSV_BYTES * 2);
  requireCsrf(req, user, form);

  const text = decodePayload(form.get('payload'));
  if (text === null) throw badRequest('The invite payload was malformed — please re-run the import.');

  const { rows, error } = await analyseCsv(env, text);
  if (error) throw badRequest(error);

  const emails = [...new Set(rows.filter((r) => r.valid).map((r) => r.values.parent_email))];
  const results = [];
  for (const email of emails) {
    // Only to accounts that exist in this system (i.e. actually imported).
    const exists = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
    if (!exists) { results.push({ email, outcome: 'Skipped — no account' }); continue; }

    if (!(await allowRate(env, `invite:email:${email}`, 1, 600))) {
      results.push({ email, outcome: 'Skipped — invite already sent in the last 10 minutes' });
      continue;
    }

    try {
      await sendMagicLinkEmail(env, email, { purpose: 'invite' });
      logEvent('invite_sent', { email: maskEmail(email) });
      results.push({ email, outcome: 'Invite sent' });
    } catch (err) {
      logError('invite_send_failed', err, { email: maskEmail(email) });
      results.push({ email, outcome: 'Send failed — try again later' });
    }
  }

  const items = results.map((r) => html`<tr><td>${r.email}</td><td>${r.outcome}</td></tr>`);
  const body = html`
    <h1>Invites</h1>
    <table class="booking-table">
      <thead><tr><th>Parent</th><th>Outcome</th></tr></thead>
      <tbody>${joinHtml(items)}</tbody>
    </table>
    <p><a href="/admin/customers" class="button-link">View customers</a></p>
  `;
  return pageResponse('Invites', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/import', handleImport);
  route('GET', '/admin/import/template.csv', handleImportTemplate);
  route('POST', '/admin/import/preview', handleImportPreview);
  route('POST', '/admin/import/commit', handleImportCommit);
  route('POST', '/admin/import/invites', handleImportInvites);
}
