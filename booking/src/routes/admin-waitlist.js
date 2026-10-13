// Admin waitlist (waitlist spec, design D7). Each term's waitlist in join
// order with the child, parent contact details and notes; the owner can:
//   * offer a place — the rest of the term, a trial class or chosen weeks, at
//     a price that defaults from the term and can be changed. The offer is a
//     pending booking holding the seats for 48 hours, and the family is
//     emailed (sign in → account → Pay now);
//   * withdraw an offer (back in line, seat released), mark declined, remove,
//     and put a declined/removed family back in their original place;
//   * add a family who asked by phone (creating the parent and child if new).
// Lapsed offers return to waiting through the core expireOffers job; a paid
// offer is marked booked by confirmBooking (and by the reconcileWaitlist job
// in lib/jobs/ops.js as a safety net). Capacity override = edit the session.
//
// Security: requireAdmin on every route (live ADMIN_EMAILS check), CSRF on
// every POST, ids validated before any query, all output through the
// auto-escaping html`` template, logs carry id prefixes only.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAdmin, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound } from '../lib/http.js';
import { uuid, nowIso, isoFromMs, isConstraintError } from '../lib/db.js';
import {
  isValidId, cleanText, normaliseEmail, isValidEmail, normalisePhone, isValidAuPhone, validateDob,
  parseDollarsToCents,
} from '../lib/validate.js';
import { formatSydney, formatAge } from '../lib/time.js';
import {
  prepareBooking, createPendingBooking, expireBooking, termSessionsRemaining, formatAud,
} from '../lib/domain.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { sendTemplate } from '../lib/notify.js';
import { waitlistOffer } from '../lib/emails/ops.js';
import { logEvent, logError } from '../lib/log.js';

export const OFFER_HOLD_HOURS = 48;
export const OFFER_KINDS = ['term', 'trial', 'casual'];
const MAX_WEEKS = 60;

const OFFER_KIND_LABELS = {
  term: 'The rest of the term',
  trial: 'A trial class',
  casual: 'Chosen weeks',
};
const OFFER_KIND_HINTS = {
  term: 'every remaining week, at the term price (less for a term that has already started)',
  trial: 'one week at the trial price — tick the week below',
  casual: 'the weeks you tick below, at the casual price per class',
};

export const ENTRY_STATUS_LABELS = {
  waiting: 'Waiting',
  offered: 'Offer sent',
  booked: 'Booked',
  declined: 'Declined',
  removed: 'Removed',
};

const TERM_STATUS_LABELS = { open: 'Open for booking', draft: 'Draft — not open yet', closed: 'Closed' };

// Post-redirect-get notices, allowlisted by key (nothing user-controlled is
// reflected from the query string).
const NOTICES = {
  offered: 'Offer sent — the place is held for 48 hours and the family has been emailed.',
  'offered-no-email': "The offer is made and the place is held, but the email couldn't be sent — please contact the family yourself.",
  withdrawn: 'Offer withdrawn — the held place is free again and the family is back in line.',
  declined: 'Marked as declined. Any place held for them has been released.',
  removed: 'Removed from the waitlist. Any place held for them has been released.',
  restored: "Back on the waitlist in their original place.",
  added: 'Added to the end of the waitlist.',
  rejoined: 'Back on the waitlist, at the end of the line.',
  'already-booked': 'That family has already paid for their offer — they are booked in.',
  unchanged: 'Nothing changed — that entry had already been updated.',
};

// --- Data --------------------------------------------------------------------

const ENTRY_SELECT = `
  SELECT w.id, w.term_id, w.user_id, w.child_id, w.status, w.note, w.joined_at, w.offered_at,
         w.offer_expires_at, w.offer_booking_id, w.resolved_at,
         u.name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
         ch.name AS child_name, ch.dob AS child_dob, ch.photo_consent, ch.medical_notes,
         t.name AS term_name, t.status AS term_status, c.name AS class_name,
         ob.status AS offer_status, ob.kind AS offer_kind, ob.amount_cents AS offer_amount_cents
  FROM waitlist w
  JOIN users u ON u.id = w.user_id
  JOIN children ch ON ch.id = w.child_id
  JOIN terms t ON t.id = w.term_id
  JOIN classes c ON c.id = t.class_id
  LEFT JOIN bookings ob ON ob.id = w.offer_booking_id`;

export async function loadEntry(env, entryId) {
  if (!isValidId(entryId)) return null;
  return env.DB.prepare(`${ENTRY_SELECT} WHERE w.id = ?1`).bind(entryId).first();
}

// Terms on the page: the one asked for, or every open and draft term plus
// any other term that still has a family waiting or holding an offer.
async function loadTerms(env, termId = null) {
  return (await env.DB.prepare(
    `SELECT t.id, t.name, t.status, t.starts_on, t.ends_on, c.name AS class_name
     FROM terms t JOIN classes c ON c.id = t.class_id
     WHERE (?1 IS NOT NULL AND t.id = ?1)
        OR (?1 IS NULL AND (t.status IN ('open', 'draft')
            OR EXISTS (SELECT 1 FROM waitlist w WHERE w.term_id = t.id AND w.status IN ('waiting', 'offered'))))
     ORDER BY t.starts_on, c.start_time, c.name`,
  ).bind(termId).all()).results || [];
}

async function loadEntries(env, termIds) {
  if (!termIds.length) return [];
  const placeholders = termIds.map((_, i) => `?${i + 1}`).join(', ');
  return (await env.DB.prepare(
    `${ENTRY_SELECT} WHERE w.term_id IN (${placeholders}) ORDER BY w.joined_at, w.id`,
  ).bind(...termIds).all()).results || [];
}

// --- Describing an offer -----------------------------------------------------

const PLURALS = { class: 'classes', family: 'families' };

function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  const last = word.split(' ').pop();
  return `${n} ${PLURALS[last] ? word.replace(/\S+$/, PLURALS[last]) : `${word}s`}`;
}

// "the rest of the term — 4 weeks, Wed 22 Oct 2026 to Wed 12 Nov 2026" etc.
export function describeOffer(kind, sessions) {
  const starts = (sessions || []).map((s) => s.starts_at).filter(Boolean).sort();
  if (!starts.length) return '';
  const first = formatSydney(starts[0], 'date');
  const last = formatSydney(starts[starts.length - 1], 'date');
  if (kind === 'trial') return `a trial class on ${formatSydney(starts[0])}`;
  if (kind === 'term') {
    return starts.length === 1
      ? `the rest of the term — 1 week, ${first}`
      : `the rest of the term — ${plural(starts.length, 'week')}, ${first} to ${last}`;
  }
  if (starts.length === 1) return `1 class on ${formatSydney(starts[0])}`;
  if (starts.length <= 4) return `${plural(starts.length, 'class')}: ${starts.map((s) => formatSydney(s, 'date')).join(', ')}`;
  return `${plural(starts.length, 'class')}, ${first} to ${last}`;
}

// --- Actions (exported for unit tests) ------------------------------------

// Offer a place to a waiting family: a pending booking holding the seats for
// OFFER_HOLD_HOURS, the entry marked offered, and the offer email.
// priceCents (optional) replaces the term's list price; account credit is
// still taken off automatically.
// Returns { ok: true, bookingId, expiresAt, amountCents, termId, emailed } or
// { ok: false, error, sessions?, entry? } — error ∈ invalid_kind | not_found |
// not_waiting | any prepareBooking / createPendingBooking error.
export async function offerPlace(env, { entryId, kind, sessionIds = [], priceCents = null, now = nowIso() }) {
  if (!OFFER_KINDS.includes(kind)) return { ok: false, error: 'invalid_kind' };
  const entry = await loadEntry(env, entryId);
  if (!entry) return { ok: false, error: 'not_found' };
  if (entry.status !== 'waiting') return { ok: false, error: 'not_waiting', entry };

  const prepared = await prepareBooking(env, {
    userId: entry.user_id, childId: entry.child_id, kind, termId: entry.term_id,
    sessionIds: kind === 'term' ? [] : sessionIds, now, admin: true,
    priceOverrideCents: Number.isInteger(priceCents) ? priceCents : null,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error, sessions: prepared.sessions || [], entry };

  const { quote } = prepared;
  const expiresAt = isoFromMs(Date.parse(now) + OFFER_HOLD_HOURS * 3600 * 1000);
  // The family accepts the waiver when they pay; until then the roster shows
  // the child's current photo consent and medical notes.
  const created = await createPendingBooking(env, {
    userId: entry.user_id, childId: entry.child_id, kind, termId: entry.term_id,
    sessionIds: quote.sessionIds, quote, expiresAt, now,
    paymentMethod: quote.amountCents > 0 ? 'full' : 'none',
    photoConsent: entry.photo_consent === 1, medicalNotes: entry.medical_notes || '',
  });
  if (created.error) return { ok: false, error: created.error, sessions: created.sessions || [], entry };

  const claimed = await env.DB.prepare(
    `UPDATE waitlist SET status = 'offered', offer_booking_id = ?2, offered_at = ?3, offer_expires_at = ?4,
            resolved_at = NULL
     WHERE id = ?1 AND status = 'waiting'`,
  ).bind(entry.id, created.id, now, expiresAt).run();
  if (claimed.meta.changes === 0) {
    // Someone acted on this entry at the same moment: undo our hold.
    await expireBooking(env, created.id);
    return { ok: false, error: 'not_waiting', entry };
  }
  logEvent('waitlist_offer_made', {
    entry_id: entry.id.slice(0, 8), booking_id: created.id.slice(0, 8), kind, amount_cents: created.amountCents,
  });

  const message = waitlistOffer({
    parentName: entry.parent_name, childName: entry.child_name, termName: entry.term_name,
    className: entry.class_name, amountCents: created.amountCents, expiresAt,
    accountUrl: `${env.PUBLIC_BASE_URL}/account`, detail: describeOffer(kind, prepared.sessions),
  });
  const email = await sendTemplate(env, {
    template: 'waitlist_offer', to: entry.parent_email, userId: entry.user_id, bookingId: created.id,
    termId: entry.term_id, dedupeKey: `waitlist_offer:${entry.id}:${created.id}`, ...message,
  });
  return {
    ok: true, bookingId: created.id, expiresAt, amountCents: created.amountCents, termId: entry.term_id,
    emailed: Boolean(email.sent || email.skipped),
  };
}

// Release the pending booking behind an offer. A Stripe checkout started from
// Pay now is expired first so it can no longer take money; then the hold is
// expired (seats, credit and voucher use given back). A payment that still
// lands later goes through the guarded confirm path (seat re-check).
// Returns 'released' | 'paid' | 'none'.
export async function releaseOffer(env, bookingId) {
  if (!bookingId) return 'none';
  const booking = await env.DB.prepare(
    `SELECT id, status, payment_ref FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return 'none';
  if (booking.status === 'confirmed') return 'paid';
  if (booking.status !== 'pending') return 'none';
  if (booking.payment_ref) {
    try {
      await getPaymentsDriver(env).expireCheckout(booking.payment_ref);
    } catch (err) {
      logError('offer_checkout_expire_failed', err, { booking_id: booking.id.slice(0, 8) });
    }
  }
  return (await expireBooking(env, booking.id)) ? 'released' : 'none';
}

// Which statuses each action applies to.
const ACTION_FROM = {
  withdraw: ['offered'],
  decline: ['waiting', 'offered'],
  remove: ['waiting', 'offered'],
  restore: ['declined', 'removed'],
};

// withdraw | decline | remove | restore one entry (releasing any held offer
// first). Returns { ok: true, entry, released } or { ok: false, error, entry? }
// with error ∈ not_found | unchanged | already_paid.
export async function changeEntry(env, entryId, action, { now = nowIso() } = {}) {
  if (!Object.hasOwn(ACTION_FROM, action)) throw new Error(`Unknown waitlist action: ${action}`);
  const entry = await loadEntry(env, entryId);
  if (!entry) return { ok: false, error: 'not_found' };
  if (!ACTION_FROM[action].includes(entry.status)) return { ok: false, error: 'unchanged', entry };

  let released = 'none';
  if (entry.status === 'offered') {
    released = await releaseOffer(env, entry.offer_booking_id);
    if (released === 'paid') {
      await env.DB.prepare(
        `UPDATE waitlist SET status = 'booked', resolved_at = ?2 WHERE id = ?1 AND status = 'offered'`,
      ).bind(entry.id, now).run();
      return { ok: false, error: 'already_paid', entry };
    }
  }

  let statement;
  if (action === 'withdraw') {
    statement = env.DB.prepare(
      `UPDATE waitlist SET status = 'waiting', offered_at = NULL, offer_expires_at = NULL, offer_booking_id = NULL,
              note = TRIM(note || ' ' || ?3)
       WHERE id = ?1 AND status = ?2`,
    ).bind(entry.id, entry.status, `Offer withdrawn ${formatSydney(now, 'date')}.`);
  } else if (action === 'restore') {
    statement = env.DB.prepare(
      `UPDATE waitlist SET status = 'waiting', resolved_at = NULL, offered_at = NULL, offer_expires_at = NULL
       WHERE id = ?1 AND status = ?2`,
    ).bind(entry.id, entry.status);
  } else {
    statement = env.DB.prepare(
      `UPDATE waitlist SET status = ?3, resolved_at = ?4, offer_expires_at = NULL WHERE id = ?1 AND status = ?2`,
    ).bind(entry.id, entry.status, action === 'decline' ? 'declined' : 'removed', now);
  }
  const result = await statement.run();
  if (result.meta.changes === 0) return { ok: false, error: 'unchanged', entry };
  logEvent('waitlist_entry_changed', { entry_id: entry.id.slice(0, 8), action, released });
  return { ok: true, entry, released };
}

const ADD_ERRORS = {
  term_not_found: 'Please choose a term.',
  invalid_email: "Please enter the parent's email address.",
  invalid_phone: 'That phone number does not look right — please check it (e.g. 0412 345 678).',
  invalid_child_name: "Please enter the child's name.",
  dob_needed: "We don't have this child on file yet — please add their date of birth.",
};

// Put a family on a term's waitlist (phone enquiries). The parent is found by
// email or created; the child is found by name (any case) or created — an
// existing family's details are never changed here. A family who declined or
// was removed joins again at the end of the line.
// Returns { ok: true, entryId, rejoined, createdParent, createdChild } or
// { ok: false, error, message }.
export async function addToWaitlist(env, {
  termId, email, parentName = '', phone = '', childName, childDob = '', note = '', now = nowIso(),
}) {
  const fail = (error, message = ADD_ERRORS[error]) => ({ ok: false, error, message });
  const term = isValidId(termId)
    ? await env.DB.prepare(`SELECT id FROM terms WHERE id = ?1`).bind(termId).first()
    : null;
  if (!term) return fail('term_not_found');
  const address = normaliseEmail(email);
  if (!isValidEmail(address)) return fail('invalid_email');
  const name = cleanText(childName, 100).replace(/\s+/g, ' ');
  if (!name) return fail('invalid_child_name');
  const tel = normalisePhone(phone);
  if (tel && !isValidAuPhone(tel)) return fail('invalid_phone');

  // Look up and validate everything first; then write in one atomic batch.
  const parent = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(address).first();
  const child = parent
    ? await env.DB.prepare(
      `SELECT id, name FROM children WHERE user_id = ?1 AND lower(name) = lower(?2) AND archived_at IS NULL
       ORDER BY created_at LIMIT 1`,
    ).bind(parent.id, name).first()
    : null;
  const dob = String(childDob || '').trim();
  if (!child) {
    if (!dob) return fail('dob_needed');
    const dobError = validateDob(dob);
    if (dobError) return fail('invalid_dob', dobError);
  }
  const cleanNote = cleanText(note, 500);

  if (child) {
    const existing = await env.DB.prepare(
      `SELECT id, status FROM waitlist WHERE term_id = ?1 AND child_id = ?2`,
    ).bind(term.id, child.id).first();
    if (existing) {
      if (existing.status !== 'declined' && existing.status !== 'removed') {
        return fail('already_listed', `${child.name} is already on this waitlist (${ENTRY_STATUS_LABELS[existing.status].toLowerCase()}).`);
      }
      const rejoin = await env.DB.prepare(
        `UPDATE waitlist SET status = 'waiting', joined_at = ?2, offered_at = NULL, offer_expires_at = NULL,
                resolved_at = NULL, note = CASE WHEN ?3 = '' THEN note ELSE ?3 END
         WHERE id = ?1 AND status IN ('declined', 'removed')`,
      ).bind(existing.id, now, cleanNote).run();
      if (rejoin.meta.changes === 0) return fail('already_listed', `${child.name} is already on this waitlist.`);
      logEvent('waitlist_rejoined_by_admin', { entry_id: existing.id.slice(0, 8) });
      return { ok: true, entryId: existing.id, rejoined: true, createdParent: false, createdChild: false };
    }
  }

  // Parent (if new), child (if new) and entry together. Rows are found by
  // email and name inside the batch, so a family added twice at the same
  // moment resolves to the same parent, child and one entry.
  const statements = [];
  if (!parent) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, phone, role, created_at) VALUES (?1, ?2, ?3, ?4, 'parent', ?5)`,
    ).bind(uuid(), address, cleanText(parentName, 100).replace(/\s+/g, ' '), tel, now));
  }
  if (!child) {
    statements.push(env.DB.prepare(
      `INSERT INTO children (id, user_id, name, dob, medical_notes, photo_consent, created_at)
       SELECT ?1, u.id, ?3, ?4, '', 0, ?5 FROM users u
       WHERE u.email = ?2
         AND NOT EXISTS (SELECT 1 FROM children c WHERE c.user_id = u.id AND lower(c.name) = lower(?3)
                           AND c.archived_at IS NULL)`,
    ).bind(uuid(), address, name, dob, now));
  }
  const entryId = uuid();
  statements.push(env.DB.prepare(
    `INSERT INTO waitlist (id, term_id, user_id, child_id, status, note, joined_at)
     SELECT ?1, ?2, u.id,
            (SELECT c.id FROM children c WHERE c.user_id = u.id AND lower(c.name) = lower(?4) AND c.archived_at IS NULL
             ORDER BY c.created_at LIMIT 1),
            'waiting', ?5, ?6
     FROM users u WHERE u.email = ?3
     ON CONFLICT(term_id, child_id) DO NOTHING`,
  ).bind(entryId, term.id, address, name, cleanNote, now));

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    logError('waitlist_add_failed', err, {});
    return fail('add_failed', 'That family could not be added just now — please try again.');
  }
  if (results[results.length - 1].meta.changes === 0) return fail('already_listed', `${name} is already on this waitlist.`);
  const createdParent = !parent && results[0].meta.changes > 0;
  const createdChild = !child && results[parent ? 0 : 1].meta.changes > 0;
  logEvent('waitlist_added_by_admin', { entry_id: entryId.slice(0, 8), new_parent: createdParent, new_child: createdChild });
  return { ok: true, entryId, rejoined: false, createdParent, createdChild };
}

// --- Rendering: the waitlist page --------------------------------------------

function seatsSummary(remaining) {
  if (!remaining.length) return 'No weeks left in this term';
  const rest = Math.min(...remaining.map((s) => s.seats_left));
  if (rest > 0) return `${plural(rest, 'place')} free for the rest of the term`;
  const withSeat = remaining.filter((s) => s.seats_left > 0).length;
  return `Full for the rest of the term · ${withSeat} of ${plural(remaining.length, 'remaining week')} with a free seat`;
}

function confirmForm(entry, action, summary, explain, button, csrfToken, { danger = false } = {}) {
  return html`
    <details class="ops-confirm">
      <summary class="button-link button-secondary">${summary}</summary>
      <form method="post" action="/admin/waitlist/${entry.id}/${action}">
        ${csrfField(csrfToken)}
        <p>${explain}</p>
        <button type="submit" class="${danger ? 'button-danger' : ''}">${button}</button>
      </form>
    </details>
  `;
}

function entryItem(e, position, user) {
  const offered = e.status === 'offered';
  const actions = offered
    ? [
      confirmForm(e, 'withdraw', 'Withdraw offer',
        `Releases the place held for ${e.child_name} and puts them back in line where they were.`,
        'Yes, withdraw the offer', user.csrfToken),
      confirmForm(e, 'decline', 'Mark declined',
        "They don't want the place. The held place is released.", 'Yes, mark declined', user.csrfToken),
      confirmForm(e, 'remove', 'Remove',
        'Takes them off the waitlist and releases the held place. You can put them back later.',
        'Yes, remove', user.csrfToken, { danger: true }),
    ]
    : [
      html`<a class="button-link" href="/admin/waitlist/${e.id}/offer">Offer a place</a>`,
      confirmForm(e, 'decline', 'Mark declined',
        "They don't want a place this term.", 'Yes, mark declined', user.csrfToken),
      confirmForm(e, 'remove', 'Remove',
        'Takes them off the waitlist. You can put them back later.', 'Yes, remove', user.csrfToken, { danger: true }),
    ];
  return html`
    <li class="waitlist-entry${offered ? ' waitlist-entry--offered' : ''}" id="entry-${e.id}">
      <p class="waitlist-entry__head">
        <span class="waitlist-position">${position}.</span>
        <strong>${e.child_name}</strong>
        <span class="muted">${formatAge(e.child_dob)}</span>
        <span class="status status-${e.status}">${ENTRY_STATUS_LABELS[e.status]}</span>
      </p>
      <p class="waitlist-contact">${e.parent_name || 'No name on file'}
        · <a href="mailto:${e.parent_email}">${e.parent_email}</a>${e.parent_phone ? html`
        · <a href="tel:${e.parent_phone}">${e.parent_phone}</a>` : ''}</p>
      <p class="muted">Joined ${formatSydney(e.joined_at)}</p>
      ${e.note ? html`<p class="waitlist-note">${e.note}</p>` : ''}
      ${offered ? html`
        <p class="waitlist-offer">Offered ${formatSydney(e.offered_at, 'date')}:
          ${(OFFER_KIND_LABELS[e.offer_kind] || 'a booking').toLowerCase()} for ${formatAud(e.offer_amount_cents)} —
          held until <strong>${formatSydney(e.offer_expires_at)}</strong>.</p>
      ` : ''}
      <div class="waitlist-actions">${joinHtml(actions)}</div>
    </li>
  `;
}

function earlierItem(e, user) {
  const when = e.resolved_at ? ` ${formatSydney(e.resolved_at, 'date')}` : '';
  return html`
    <li class="waitlist-earlier__item">
      <span><strong>${e.child_name}</strong> (${e.parent_email}) —
        <span class="status status-${e.status}">${ENTRY_STATUS_LABELS[e.status]}</span>${when}</span>
      ${e.status === 'declined' || e.status === 'removed' ? html`
        <form method="post" action="/admin/waitlist/${e.id}/restore" class="inline-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="button-secondary">Put back on the list</button>
        </form>
      ` : ''}
    </li>
  `;
}

function addForm(term, user, addError) {
  const mine = addError && addError.termId === term.id;
  const v = mine ? addError.values : {};
  return html`
    <details class="waitlist-add" id="add-${term.id}" ${mine ? 'open' : ''}>
      <summary class="button-link button-secondary">Add a family to this waitlist</summary>
      ${mine ? html`<p class="form-error" role="alert">${addError.message}</p>` : ''}
      <form method="post" action="/admin/waitlist/add" class="booking-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="term" value="${term.id}">
        <div class="form-group">
          <label for="email-${term.id}">Parent's email</label>
          <input type="email" id="email-${term.id}" name="email" value="${v.email || ''}" required maxlength="254" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="child-${term.id}">Child's name</label>
          <input type="text" id="child-${term.id}" name="child_name" value="${v.child_name || ''}" required maxlength="100" autocomplete="off">
        </div>
        <p class="muted">For a family we don't know yet, also fill in the details below. An existing family's details are never changed here.</p>
        <div class="form-group">
          <label for="dob-${term.id}">Child's date of birth (new child only)</label>
          <input type="date" id="dob-${term.id}" name="child_dob" value="${v.child_dob || ''}">
        </div>
        <div class="form-group">
          <label for="pname-${term.id}">Parent's name (new family only)</label>
          <input type="text" id="pname-${term.id}" name="parent_name" value="${v.parent_name || ''}" maxlength="100" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="phone-${term.id}">Parent's mobile (new family only)</label>
          <input type="tel" id="phone-${term.id}" name="phone" value="${v.phone || ''}" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="note-${term.id}">Note (optional, e.g. "can only do 11 am")</label>
          <input type="text" id="note-${term.id}" name="note" value="${v.note || ''}" maxlength="500">
        </div>
        <button type="submit">Add to the waitlist</button>
      </form>
    </details>
  `;
}

function termSection({ term, entries, remaining, user, addError }) {
  const active = entries.filter((e) => e.status === 'waiting' || e.status === 'offered');
  const earlier = entries.filter((e) => e.status !== 'waiting' && e.status !== 'offered');
  return html`
    <section class="class-card waitlist-term" id="term-${term.id}">
      <h2>${term.class_name} — ${term.name}</h2>
      <p class="class-meta">${term.starts_on} to ${term.ends_on} · ${TERM_STATUS_LABELS[term.status] || term.status}
        · ${seatsSummary(remaining)}</p>
      <p class="waitlist-summary">${plural(active.filter((e) => e.status === 'waiting').length, 'family')} waiting${
        active.some((e) => e.status === 'offered') ? ` · ${plural(active.filter((e) => e.status === 'offered').length, 'offer')} out` : ''}</p>
      ${active.length
        ? html`<ol class="waitlist-entries">${joinHtml(active.map((e, i) => entryItem(e, i + 1, user)))}</ol>`
        : html`<p class="muted">Nobody is waiting for this term.</p>`}
      ${earlier.length ? html`
        <details class="waitlist-earlier">
          <summary>Earlier entries (${earlier.length}) — booked, declined or removed</summary>
          <ul>${joinHtml(earlier.map((e) => earlierItem(e, user)))}</ul>
        </details>
      ` : ''}
      <div class="waitlist-term__tools">
        ${active.length ? html`<a class="button-link button-secondary" href="/admin/email?audience=waitlist&amp;term=${term.id}">Message this waitlist</a>` : ''}
        ${addForm(term, user, addError)}
      </div>
    </section>
  `;
}

async function renderWaitlistPage(env, user, { termId = null, noticeKey = null, addError = null, status = 200 } = {}) {
  const now = nowIso();
  const terms = await loadTerms(env, termId);
  if (termId && !terms.length) throw notFound('We could not find that term.');
  const allTerms = termId ? await loadTerms(env, null) : terms;
  const entries = await loadEntries(env, terms.map((t) => t.id));
  const sections = [];
  for (const term of terms) {
    const { remaining } = await termSessionsRemaining(env, term.id, now);
    sections.push(termSection({
      term, entries: entries.filter((e) => e.term_id === term.id), remaining, user, addError,
    }));
  }
  const noticeText = NOTICES[noticeKey];
  const filterLinks = [html`<a href="/admin/waitlist" class="${termId ? '' : 'filter-active'}">All current terms</a>`]
    .concat(allTerms.map((t) => html`
      <a href="/admin/waitlist?term=${t.id}" class="${t.id === termId ? 'filter-active' : ''}">${t.class_name} — ${t.name}</a>`));

  const body = html`
    <div class="ops-page">
      <h1>Waitlist</h1>
      ${noticeText ? html`<p class="form-notice" role="status">${noticeText}</p>` : ''}
      ${addError && !addError.termId ? html`<p class="form-error" role="alert">${addError.message}</p>` : ''}
      <p class="lede">Families waiting for a place, in the order they joined. When a place comes up, press
        <strong>Offer a place</strong>: it's held for ${OFFER_HOLD_HOURS} hours while the family pays from their
        account, and goes back to the list if they don't. To make room in a full week, raise that week's capacity
        (Edit session) first.</p>
      <p class="filter-links">Show: ${joinHtml(filterLinks, ' · ')}</p>
      ${sections.length ? joinHtml(sections) : html`<p>There are no open or draft terms yet.</p>`}
    </div>
  `;
  return pageResponse('Waitlist', body, { user, admin: true, status });
}

// --- Rendering: the offer page -----------------------------------------------

const PREPARE_ERRORS = {
  invalid_kind: 'Please choose what you are offering.',
  not_found: 'One of those weeks is no longer part of this term — please choose again.',
  finished: 'This term has no weeks left to offer.',
  no_sessions: 'Please tick at least one week.',
  trial_one_session: 'A trial is one class — please tick exactly one week.',
  trial_used: 'This child has already had a trial class, so a trial cannot be offered again. Offer the rest of the term or chosen weeks instead.',
  unavailable: 'One of those weeks is no longer running (cancelled, or already started).',
  full: 'One of those weeks is full. Raise that week\'s capacity (Edit session) or choose other weeks.',
  capacity: 'Someone has just taken the last seat in one of those weeks — please choose again.',
  already_booked: 'This child is already booked into one of those weeks.',
  credit_changed: "The family's account credit changed just now — please try again.",
  voucher_invalid: 'Please try again.',
  not_waiting: 'This family is not waiting any more (an offer may already be out) — nothing was sent.',
};

function offerChoiceForm(entry, sessions, { kind, chosen }) {
  const kinds = OFFER_KINDS.map((k) => html`
    <label class="offer-kind">
      <input type="radio" name="kind" value="${k}" ${k === (kind || 'term') ? 'checked' : ''}>
      <span><strong>${OFFER_KIND_LABELS[k]}</strong> — ${OFFER_KIND_HINTS[k]}</span>
    </label>
  `);
  const weeks = sessions.map((s) => html`
    <li class="offer-week">
      <label>
        <input type="checkbox" name="session" value="${s.id}" ${chosen.includes(s.id) ? 'checked' : ''}>
        <span>${formatSydney(s.starts_at)} — ${s.seats_left > 0 ? `${plural(s.seats_left, 'seat')} free` : 'full'}</span>
      </label>
      ${s.seats_left > 0 ? '' : html`<a href="/admin/sessions/${s.id}/edit">Raise capacity</a>`}
    </li>
  `);
  return html`
    <form method="get" action="/admin/waitlist/${entry.id}/offer" class="booking-form offer-choice">
      <fieldset class="form-group consent-group">
        <legend>What are you offering?</legend>
        ${joinHtml(kinds)}
      </fieldset>
      <fieldset class="form-group consent-group">
        <legend>Weeks (only for a trial or chosen weeks)</legend>
        ${weeks.length ? html`<ul class="offer-weeks">${joinHtml(weeks)}</ul>` : html`<p>No weeks left in this term.</p>`}
      </fieldset>
      <button type="submit">Work out the price</button>
    </form>
  `;
}

function offerQuoteForm(entry, prepared, { kind, chosen, priceInput, csrfToken, now }) {
  const q = prepared.quote;
  const expiresAt = isoFromMs(Date.parse(now) + OFFER_HOLD_HOURS * 3600 * 1000);
  const rows = [
    html`<tr><td>${q.isReturning ? 'Returning-family price' : 'Usual price'}${q.isProRata ? html` <span class="muted">(${q.weeks} of ${q.totalWeeks} weeks, pro-rata)</span>` : ''}</td><td>${formatAud(q.listCents)}</td></tr>`,
    q.creditCents > 0 ? html`<tr><td>Account credit (taken off automatically)</td><td>−${formatAud(q.creditCents)}</td></tr>` : '',
    html`<tr class="price-total"><td>The family pays</td><td>${formatAud(q.amountCents)}</td></tr>`,
  ];
  const warnings = (prepared.warnings || []).includes('child_already_holds_some_weeks')
    ? html`<p class="muted">${entry.child_name} already has some of these weeks booked; those weeks are left out.</p>`
    : '';
  return html`
    <section class="checkout-summary offer-summary">
      <h2>The offer</h2>
      <p><strong>${describeOffer(kind, prepared.sessions).replace(/^./, (c) => c.toUpperCase())}</strong></p>
      <table class="price-breakdown"><tbody>${joinHtml(rows.filter(Boolean))}</tbody></table>
      ${warnings}
    </section>
    <form method="post" action="/admin/waitlist/${entry.id}/offer" class="booking-form">
      ${csrfField(csrfToken)}
      <input type="hidden" name="kind" value="${kind}">
      ${kind === 'term' ? '' : joinHtml(chosen.map((id) => html`<input type="hidden" name="session" value="${id}">`))}
      <div class="form-group">
        <label for="price">Price for this offer in dollars, before any account credit (change it if you've agreed a different price)</label>
        <input type="text" id="price" name="price" value="${priceInput}" inputmode="decimal" required>
      </div>
      <p>The place will be held for ${OFFER_HOLD_HOURS} hours — until ${formatSydney(expiresAt)} — and
        ${entry.parent_email} will get an email asking them to sign in and press Pay now.</p>
      <button type="submit">Send the offer</button>
    </form>
  `;
}

async function renderOfferPage(env, user, entry, {
  kind = null, chosen = [], priceInput = null, error = '', status = 200, now = nowIso(),
} = {}) {
  const { remaining } = await termSessionsRemaining(env, entry.term_id, now);
  let quote = html``;
  let failure = error;
  if (entry.status === 'waiting' && kind) {
    const prepared = await prepareBooking(env, {
      userId: entry.user_id, childId: entry.child_id, kind, termId: entry.term_id,
      sessionIds: kind === 'term' ? [] : chosen, now, admin: true,
    });
    if (prepared.ok) {
      quote = offerQuoteForm(entry, prepared, {
        kind, chosen, now, csrfToken: user.csrfToken,
        priceInput: priceInput ?? (prepared.quote.listCents / 100).toFixed(2),
      });
    } else if (!failure) {
      failure = PREPARE_ERRORS[prepared.error] || 'That offer cannot be made — please choose again.';
      if (status === 200) status = 409;
    }
  }
  const body = html`
    <div class="ops-page">
      <h1>Offer a place</h1>
      <p class="lede"><strong>${entry.child_name}</strong> (${formatAge(entry.child_dob)})
        · ${entry.parent_name || entry.parent_email} · ${entry.class_name} — ${entry.term_name}</p>
      ${failure ? html`<p class="form-error" role="alert">${failure}</p>` : ''}
      ${entry.status === 'waiting'
        ? html`${offerChoiceForm(entry, remaining, { kind, chosen })}${quote}`
        : html`<p>An offer can only be made to a family who is waiting. ${entry.child_name}'s entry is:
            <strong>${ENTRY_STATUS_LABELS[entry.status]}</strong>.</p>`}
      <p><a href="/admin/waitlist?term=${entry.term_id}">Back to the waitlist</a></p>
    </div>
  `;
  return pageResponse('Offer a place', body, { user, admin: true, status });
}

// --- Handlers ----------------------------------------------------------------

function readKind(value) {
  return OFFER_KINDS.includes(value) ? value : null;
}

function readSessionIds(values) {
  return [...new Set(values.map(String).filter(isValidId))].slice(0, MAX_WEEKS);
}

// GET /admin/waitlist[?term=…]
export async function handleAdminWaitlist(req, env) {
  const user = await requireAdmin(req, env);
  const url = new URL(req.url);
  const termParam = url.searchParams.get('term') || '';
  return renderWaitlistPage(env, user, {
    termId: isValidId(termParam) ? termParam : null,
    noticeKey: url.searchParams.get('ok'),
  });
}

// POST /admin/waitlist/add
export async function handleAddPost(req, env) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const values = {
    term: String(form.get('term') || ''),
    email: String(form.get('email') || '').trim().slice(0, 254),
    child_name: cleanText(form.get('child_name'), 100),
    child_dob: String(form.get('child_dob') || '').trim().slice(0, 10),
    parent_name: cleanText(form.get('parent_name'), 100),
    phone: String(form.get('phone') || '').trim().slice(0, 30),
    note: cleanText(form.get('note'), 500),
  };
  const result = await addToWaitlist(env, {
    termId: values.term, email: values.email, parentName: values.parent_name, phone: values.phone,
    childName: values.child_name, childDob: values.child_dob, note: values.note,
  });
  if (!result.ok) {
    const termId = isValidId(values.term) && result.error !== 'term_not_found' ? values.term : null;
    return renderWaitlistPage(env, user, {
      termId, addError: { termId, message: result.message, values }, status: 400,
    });
  }
  return redirect(`/admin/waitlist?term=${encodeURIComponent(values.term)}&ok=${result.rejoined ? 'rejoined' : 'added'}`, 303);
}

// GET /admin/waitlist/:id/offer[?kind=…&session=…] — choose, then see the price.
export async function handleOfferPage(req, env, params) {
  const user = await requireAdmin(req, env);
  const entry = await loadEntry(env, params.id);
  if (!entry) throw notFound('That waitlist entry no longer exists.');
  const url = new URL(req.url);
  return renderOfferPage(env, user, entry, {
    kind: readKind(url.searchParams.get('kind')),
    chosen: readSessionIds(url.searchParams.getAll('session')),
  });
}

// POST /admin/waitlist/:id/offer — make the offer.
export async function handleOfferPost(req, env, params) {
  const user = await requireAdmin(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const entry = await loadEntry(env, params.id);
  if (!entry) throw notFound('That waitlist entry no longer exists.');

  const kind = readKind(form.get('kind'));
  const chosen = readSessionIds(form.getAll('session'));
  const priceInput = String(form.get('price') || '').trim().slice(0, 20);
  const priceCents = parseDollarsToCents(priceInput, 1000000);
  if (!kind || priceCents === null) {
    return renderOfferPage(env, user, entry, {
      kind, chosen, priceInput,
      error: kind ? 'Please enter the price in dollars, e.g. 168 or 112.50.' : PREPARE_ERRORS.invalid_kind,
      status: 400,
    });
  }

  const result = await offerPlace(env, { entryId: entry.id, kind, sessionIds: chosen, priceCents });
  if (!result.ok) {
    const fresh = (await loadEntry(env, entry.id)) || entry;
    return renderOfferPage(env, user, fresh, {
      kind, chosen, priceInput,
      error: PREPARE_ERRORS[result.error] || 'That offer cannot be made — please choose again.',
      status: result.error === 'not_waiting' ? 409 : 400,
    });
  }
  logEvent('waitlist_offer_by_admin', { entry_id: entry.id.slice(0, 8), by: user.userId.slice(0, 8) });
  return redirect(`/admin/waitlist?term=${encodeURIComponent(result.termId)}&ok=${result.emailed ? 'offered' : 'offered-no-email'}`, 303);
}

const ACTION_NOTICES = { withdraw: 'withdrawn', decline: 'declined', remove: 'removed', restore: 'restored' };

// POST /admin/waitlist/:id/{withdraw,decline,remove,restore}
function entryActionHandler(action) {
  return async function handleEntryAction(req, env, params) {
    const user = await requireAdmin(req, env);
    const form = await parseForm(req);
    requireCsrf(req, user, form);
    const result = await changeEntry(env, params.id, action);
    if (!result.ok && result.error === 'not_found') throw notFound('That waitlist entry no longer exists.');
    const key = result.ok ? ACTION_NOTICES[action] : result.error === 'already_paid' ? 'already-booked' : 'unchanged';
    if (result.ok) logEvent('waitlist_action_by_admin', { entry_id: result.entry.id.slice(0, 8), action, by: user.userId.slice(0, 8) });
    return redirect(`/admin/waitlist?term=${encodeURIComponent(result.entry.term_id)}&ok=${key}`, 303);
  };
}

export const handleWithdrawPost = entryActionHandler('withdraw');
export const handleDeclinePost = entryActionHandler('decline');
export const handleRemovePost = entryActionHandler('remove');
export const handleRestorePost = entryActionHandler('restore');

export function registerRoutes(route) {
  route('GET', '/admin/waitlist', handleAdminWaitlist);
  route('POST', '/admin/waitlist/add', handleAddPost);
  route('GET', '/admin/waitlist/:id/offer', handleOfferPage);
  route('POST', '/admin/waitlist/:id/offer', handleOfferPost);
  route('POST', '/admin/waitlist/:id/withdraw', handleWithdrawPost);
  route('POST', '/admin/waitlist/:id/decline', handleDeclinePost);
  route('POST', '/admin/waitlist/:id/remove', handleRemovePost);
  route('POST', '/admin/waitlist/:id/restore', handleRestorePost);
}
