// Child profile management: CRUD for a parent's children.
//
// Security (child-profiles spec):
//   * Every operation is scoped to the signed-in account; another account's
//     child id gets the same 404 as a nonexistent id (no cross-account
//     disclosure, CWE-639).
//   * All state changes verify the per-session CSRF token (CWE-352).
//   * Photo consent is an explicit yes/no with no pre-selected value.
//   * Medical notes never appear in logs.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { formatAge } from '../lib/time.js';
import { isValidName, validateDob, cleanText, isYesNo } from '../lib/validate.js';
import { uuid, nowIso } from '../lib/db.js';
import { redirect, notFound } from '../lib/http.js';
import { safeNextPath } from '../lib/http.js';
import { logEvent } from '../lib/log.js';

const MEDICAL_NOTES_MAX = 2000;

// Owner-scoped lookup: returns null for both "not yours" and "doesn't exist".
async function getOwnedChild(env, childId, userId) {
  return env.DB.prepare(
    `SELECT id, name, dob, medical_notes, photo_consent FROM children
     WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(childId, userId).first();
}

// Shared add/edit form. `values.photo_consent` is 'yes' | 'no' | '' — an empty
// value renders NO pre-selected radio (the consent choice must be explicit).
function childForm({ action, values, error = '', csrfToken, submitLabel, next = '' }) {
  const consent = values.photo_consent;
  return html`
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="${action}" class="booking-form">
      ${csrfField(csrfToken)}
      <input type="hidden" name="next" value="${next}">
      <div class="form-group">
        <label for="name">Child's name</label>
        <input type="text" id="name" name="name" value="${values.name}" required maxlength="100" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="dob">Date of birth</label>
        <input type="date" id="dob" name="dob" value="${values.dob}" required>
      </div>
      <div class="form-group">
        <label for="medical">Medical conditions or allergies we should know about (optional)</label>
        <textarea id="medical" name="medical" rows="4" maxlength="${MEDICAL_NOTES_MAX}">${values.medical}</textarea>
      </div>
      <fieldset class="form-group consent-group">
        <legend>May we include your child in class photos shared on our socials?</legend>
        <label><input type="radio" name="photo_consent" value="yes" ${consent === 'yes' ? 'checked' : ''} required> Yes, photos are okay</label>
        <label><input type="radio" name="photo_consent" value="no" ${consent === 'no' ? 'checked' : ''}> No, please keep my child out of photos</label>
      </fieldset>
      <button type="submit">${submitLabel}</button>
    </form>
  `;
}

// Validate a submitted child form. Returns { values, error }: values always
// echo what was typed (so a failed submission preserves the parent's input).
function validateChildForm(form) {
  const values = {
    name: String(form.get('name') || '').trim(),
    dob: String(form.get('dob') || '').trim(),
    medical: cleanText(form.get('medical'), MEDICAL_NOTES_MAX),
    photo_consent: ['yes', 'no'].includes(form.get('photo_consent')) ? form.get('photo_consent') : '',
  };

  if (!isValidName(values.name)) {
    return { values, error: 'Please enter your child\'s name (up to 100 characters).' };
  }
  const dobError = validateDob(values.dob);
  if (dobError) return { values, error: dobError };
  if (!isYesNo(values.photo_consent)) {
    return { values, error: 'Please choose yes or no for photo consent — we need an explicit answer either way.' };
  }
  return { values, error: null };
}

// GET /account/children — list the signed-in parent's children.
export async function handleListChildren(req, env) {
  const user = await requireAuthOrRedirect(req, env);

  const children = await env.DB.prepare(
    `SELECT id, name, dob, photo_consent FROM children
     WHERE user_id = ?1 AND archived_at IS NULL
     ORDER BY created_at`,
  ).bind(user.userId).all();

  const rows = (children.results || []).map((c) => html`
    <tr>
      <td>${c.name}</td>
      <td>${formatAge(c.dob)}</td>
      <td>${c.photo_consent ? 'Yes' : 'No'}</td>
      <td class="table-actions">
        <a href="/account/children/${c.id}/edit">Edit</a>
        <a href="/account/children/${c.id}/delete">Remove</a>
      </td>
    </tr>
  `);

  const body = html`
    <h1>My children</h1>
    ${rows.length ? html`
      <table class="booking-table">
        <thead><tr><th>Name</th><th>Age</th><th>Photo consent</th><th></th></tr></thead>
        <tbody>${joinHtml(rows)}</tbody>
      </table>
    ` : html`<p class="lede">No children added yet — add your little one to start booking classes.</p>`}
    <p><a href="/account/children/new" class="button-link">Add a child</a></p>
    <p><a href="/account">Back to my account</a></p>
  `;
  return pageResponse('My children', body, { user });
}

// GET /account/children/new — render the add-child form.
export async function handleAddChild(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const next = safeNextPath(new URL(req.url).searchParams.get('next'), '');
  const body = html`
    <h1>Add a child</h1>
    ${childForm({
      action: '/account/children/new',
      values: { name: '', dob: '', medical: '', photo_consent: '' },
      csrfToken: user.csrfToken,
      submitLabel: 'Save child',
      next,
    })}
  `;
  return pageResponse('Add a child', body, { user });
}

// POST /account/children/new — create a child profile.
export async function handleAddChildPost(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const next = safeNextPath(String(form.get('next') || ''), '');
  const { values, error } = validateChildForm(form);
  if (error) {
    const body = html`<h1>Add a child</h1>${childForm({
      action: '/account/children/new', values, error, csrfToken: user.csrfToken, submitLabel: 'Save child', next,
    })}`;
    return pageResponse('Add a child', body, { user, status: 400 });
  }

  const childId = uuid();
  await env.DB.prepare(
    `INSERT INTO children (id, user_id, name, dob, medical_notes, photo_consent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(childId, user.userId, values.name, values.dob, values.medical,
    values.photo_consent === 'yes' ? 1 : 0, nowIso()).run();

  // Security: log ids only — never the child's name or medical content.
  logEvent('child_created', { user_id: user.userId.slice(0, 8), child_id: childId.slice(0, 8) });

  return redirect(next || '/account/children', 303);
}

// GET /account/children/:id/edit — render the edit form.
export async function handleEditChild(req, env, params) {
  const user = await requireAuthOrRedirect(req, env);
  const child = await getOwnedChild(env, params.id, user.userId);
  if (!child) throw notFound();

  const body = html`
    <h1>Edit ${child.name}</h1>
    ${childForm({
      action: `/account/children/${child.id}/edit`,
      values: {
        name: child.name,
        dob: child.dob,
        medical: child.medical_notes,
        photo_consent: child.photo_consent ? 'yes' : 'no',
      },
      csrfToken: user.csrfToken,
      submitLabel: 'Save changes',
    })}
    <p><a href="/account/children">Back to my children</a></p>
  `;
  return pageResponse('Edit child', body, { user });
}

// POST /account/children/:id/edit — update a child profile. A failed
// validation leaves the stored profile unchanged; existing bookings keep
// their snapshotted consent/medical values (snapshots live on bookings).
export async function handleEditChildPost(req, env, params) {
  const user = await requireAuthOrRedirect(req, env);
  const child = await getOwnedChild(env, params.id, user.userId);
  if (!child) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { values, error } = validateChildForm(form);
  if (error) {
    const body = html`<h1>Edit ${child.name}</h1>${childForm({
      action: `/account/children/${child.id}/edit`, values, error, csrfToken: user.csrfToken, submitLabel: 'Save changes',
    })}`;
    return pageResponse('Edit child', body, { user, status: 400 });
  }

  await env.DB.prepare(
    `UPDATE children SET name = ?1, dob = ?2, medical_notes = ?3, photo_consent = ?4
     WHERE id = ?5 AND user_id = ?6`,
  ).bind(values.name, values.dob, values.medical,
    values.photo_consent === 'yes' ? 1 : 0, child.id, user.userId).run();

  logEvent('child_updated', { child_id: child.id.slice(0, 8) });
  return redirect('/account/children', 303);
}

// GET /account/children/:id/delete — confirmation page (delete is a POST).
export async function handleDeleteChild(req, env, params) {
  const user = await requireAuthOrRedirect(req, env);
  const child = await getOwnedChild(env, params.id, user.userId);
  if (!child) throw notFound();

  const body = html`
    <h1>Remove ${child.name}?</h1>
    <p class="lede">This removes ${child.name} from your account. Past bookings are kept for our records.</p>
    <form method="post" action="/account/children/${child.id}/delete" class="booking-form">
      ${csrfField(user.csrfToken)}
      <button type="submit" class="button-danger">Yes, remove</button>
      <a href="/account/children" class="button-link button-secondary">Cancel</a>
    </form>
  `;
  return pageResponse('Remove child', body, { user });
}

// POST /account/children/:id/delete — soft-delete (archive) a child.
export async function handleDeleteChildPost(req, env, params) {
  const user = await requireAuthOrRedirect(req, env);
  const child = await getOwnedChild(env, params.id, user.userId);
  if (!child) throw notFound();

  const form = await parseForm(req);
  requireCsrf(req, user, form);

  await env.DB.prepare(
    `UPDATE children SET archived_at = ?1 WHERE id = ?2 AND user_id = ?3`,
  ).bind(nowIso(), child.id, user.userId).run();

  logEvent('child_archived', { child_id: child.id.slice(0, 8) });
  return redirect('/account/children', 303);
}
