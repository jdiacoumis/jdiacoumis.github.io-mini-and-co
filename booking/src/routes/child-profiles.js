// Child profile management: CRUD operations for a parent's children.

import { html, layout, formInput, formTextarea } from '../lib/html.js';
import { requireAuthOrRedirect } from '../lib/middleware.js';
import { formatAge, validateDob } from '../lib/time.js';
import { normaliseEmail, isValidName, validateDob: validateDobFromValidate, parseIntInRange } from '../lib/validate.js';
import { uuid, nowIso } from '../lib/db.js';
import { redirect, badRequest } from '../lib/http.js';
import { logEvent } from '../lib/log.js';

// GET /account/children — list parent's children.
export async function handleListChildren(req, env) {
  const user = await requireAuthOrRedirect(req, env);

  const children = await env.DB.prepare(
    `SELECT id, name, dob, medical_notes, photo_consent FROM children
     WHERE user_id = ?1 AND archived_at IS NULL
     ORDER BY created_at DESC`,
  ).bind(user.userId).all();

  const childRows = (children.results || []).map((c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${formatAge(c.dob)}</td>
      <td>${c.photo_consent ? '✓' : '—'}</td>
      <td><a href="/account/children/${c.id}/edit">Edit</a> | <a href="/account/children/${c.id}/delete">Delete</a></td>
    </tr>
  `).join('');

  const body = html`
    <h1>My Children</h1>
    <p><a href="/account/children/add" class="btn">Add a child</a></p>
    ${children.results.length > 0 ? html`
      <table>
        <thead>
          <tr><th>Name</th><th>Age</th><th>Photo consent</th><th>Actions</th></tr>
        </thead>
        <tbody>${raw(childRows)}</tbody>
      </table>
    ` : html`<p>No children yet. <a href="/account/children/add">Add one</a></p>`}
  `;

  return new Response(layout('My Children', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// GET /account/children/add — render add-child form.
export async function handleAddChild(req, env) {
  const user = await requireAuthOrRedirect(req, env);

  const body = html`
    <h1>Add a Child</h1>
    <form method="post" action="/account/children/add">
      <div class="form-group">
        <label for="name">Child's name</label>
        <input type="text" id="name" name="name" required>
      </div>
      <div class="form-group">
        <label for="dob">Date of birth (YYYY-MM-DD)</label>
        <input type="date" id="dob" name="dob" required>
      </div>
      <div class="form-group">
        <label for="medical">Medical notes (optional)</label>
        <textarea id="medical" name="medical" rows="4"></textarea>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" name="photo_consent" value="1">
          I consent to photos being used for class memories
        </label>
      </div>
      <button type="submit">Save child</button>
    </form>
  `;

  return new Response(layout('Add Child', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// POST /account/children/add — create a child record.
export async function handleAddChildPost(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const data = await req.formData();

  const name = String(data.get('name') || '').trim();
  const dob = String(data.get('dob') || '').trim();
  const medical = String(data.get('medical') || '').trim();
  const photoConsent = data.get('photo_consent') ? 1 : 0;

  // Validate inputs.
  if (!isValidName(name)) throw badRequest('Name is required and must be 1–80 characters.');
  const dobError = validateDobFromValidate(dob);
  if (dobError) throw badRequest(dobError);

  const childId = uuid();
  const now = nowIso();

  await env.DB.prepare(
    `INSERT INTO children (id, user_id, name, dob, medical_notes, photo_consent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(childId, user.userId, name, dob, medical, photoConsent, now).run();

  logEvent('child_created', { user_id: user.userId.slice(0, 8), child_id: childId.slice(0, 8) });

  throw redirect('/account/children', 303);
}

// GET /account/children/:id/edit — render edit form.
export async function handleEditChild(req, env, childId) {
  const user = await requireAuthOrRedirect(req, env);

  const child = await env.DB.prepare(
    `SELECT id, name, dob, medical_notes, photo_consent FROM children
     WHERE id = ?1 AND user_id = ?2`,
  ).bind(childId, user.userId).first();

  if (!child) throw { status: 404, publicMessage: 'Child not found.' };

  const body = html`
    <h1>Edit ${escapeHtml(child.name)}</h1>
    <form method="post" action="/account/children/${childId}">
      <div class="form-group">
        <label for="name">Child's name</label>
        <input type="text" id="name" name="name" value="${escapeHtml(child.name)}" required>
      </div>
      <div class="form-group">
        <label for="dob">Date of birth (YYYY-MM-DD)</label>
        <input type="date" id="dob" name="dob" value="${escapeHtml(child.dob)}" required>
      </div>
      <div class="form-group">
        <label for="medical">Medical notes</label>
        <textarea id="medical" name="medical" rows="4">${escapeHtml(child.medical_notes)}</textarea>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" name="photo_consent" value="1" ${child.photo_consent ? 'checked' : ''}>
          Photo consent
        </label>
      </div>
      <button type="submit">Save changes</button>
    </form>
  `;

  return new Response(layout('Edit Child', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// POST /account/children/:id — update a child record.
export async function handleEditChildPost(req, env, childId) {
  const user = await requireAuthOrRedirect(req, env);
  const child = await env.DB.prepare(
    `SELECT id FROM children WHERE id = ?1 AND user_id = ?2`,
  ).bind(childId, user.userId).first();

  if (!child) throw { status: 404, publicMessage: 'Child not found.' };

  const data = await req.formData();
  const name = String(data.get('name') || '').trim();
  const dob = String(data.get('dob') || '').trim();
  const medical = String(data.get('medical') || '').trim();
  const photoConsent = data.get('photo_consent') ? 1 : 0;

  if (!isValidName(name)) throw badRequest('Name is required.');
  const dobError = validateDobFromValidate(dob);
  if (dobError) throw badRequest(dobError);

  await env.DB.prepare(
    `UPDATE children SET name = ?1, dob = ?2, medical_notes = ?3, photo_consent = ?4
     WHERE id = ?5`,
  ).bind(name, dob, medical, photoConsent, childId).run();

  logEvent('child_updated', { child_id: childId.slice(0, 8) });
  throw redirect('/account/children', 303);
}

// POST /account/children/:id/delete — soft-delete a child.
export async function handleDeleteChild(req, env, childId) {
  const user = await requireAuthOrRedirect(req, env);
  const child = await env.DB.prepare(
    `SELECT id FROM children WHERE id = ?1 AND user_id = ?2`,
  ).bind(childId, user.userId).first();

  if (!child) throw { status: 404, publicMessage: 'Child not found.' };

  await env.DB.prepare(
    `UPDATE children SET archived_at = datetime('now') WHERE id = ?1`,
  ).bind(childId).run();

  logEvent('child_archived', { child_id: childId.slice(0, 8) });
  throw redirect('/account/children', 303);
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (ch) => map[ch]);
}
