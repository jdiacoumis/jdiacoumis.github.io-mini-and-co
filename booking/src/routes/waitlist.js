// Parent waitlist (Phase 2A — waitlist spec, design D7). When a term has no
// seat left for a whole-term booking, the class list offers its waitlist: the
// family picks a child and joins. One entry per child per term (the table's
// UNIQUE(term_id, child_id)), ordered by join time; the family sees its place
// in line here, on the class list and on the account page, and can leave at
// any time. Leaving an entry that holds an offer declines it: the held place
// is released (after its hosted checkout is closed) for the next family, and
// the owner is told. Offers themselves are made by the owner (Phase 2C).
//
// Security: owner-scoped — another family's child or entry id gets the same
// 404 as a missing one; every POST checks the CSRF token; joins are rate
// limited; logs carry id prefixes only.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, tooMany } from '../lib/http.js';
import { isValidId } from '../lib/validate.js';
import { formatSydney } from '../lib/time.js';
import { uuid, nowIso } from '../lib/db.js';
import {
  loadTerm, termSessionsRemaining, isReturningFamily, getOwnedBooking, expireBooking, formatAud,
} from '../lib/domain.js';
import { canBookTerm } from '../lib/pricing.js';
import { notifyOwner } from '../lib/notify.js';
import { allowRate } from '../lib/ratelimit.js';
import { logEvent } from '../lib/log.js';
import {
  listChildren, liveTermBookings, listWaitlistEntries, waitlistPositionText, seatsText, plural,
} from '../lib/parent-flow.js';
import { closeProviderCheckout } from './booking.js';

const NOTICES = {
  joined: "You're on the waitlist — we'll email you if a place opens up.",
  already: 'That child is already on this waitlist.',
  booked: 'That child already has a place in this term.',
  left: "You've left the waitlist.",
  places: 'Good news — there are places in this term right now, so you can book straight away.',
};

function page(body) {
  return html`<div class="parent-flow">${body}</div>`;
}

function entryItem(w, user, termId) {
  return html`
    <li class="waitlist-entry">
      ${w.status === 'offered'
        ? html`<p><strong>${w.child_name}</strong> — a place is being held${w.offer_expires_at ? html` until ${formatSydney(w.offer_expires_at)}` : ''}.</p>
            ${w.offer_booking_id ? html`<p><a class="button-link" href="/account/bookings/${w.offer_booking_id}/pay">Pay now</a></p>` : ''}`
        : html`<p><strong>${w.child_name}</strong> is on the waitlist — ${waitlistPositionText(w.position)} (joined ${formatSydney(w.joined_at, 'date')}).</p>`}
      <form method="post" action="/book/waitlist/leave" class="inline-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="entry" value="${w.id}">
        <input type="hidden" name="term" value="${termId}">
        <button type="submit" class="button-secondary button-small">${w.status === 'offered' ? 'No thanks — release the place' : 'Leave the waitlist'}</button>
      </form>
    </li>
  `;
}

// GET /book/waitlist?term=… — the term's waitlist for this family: their
// children's places in line, and the join form while the term is full.
export async function handleWaitlistPage(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const termId = String(url.searchParams.get('term') || '');
  if (!termId) return redirect('/account#waitlist', 303);
  if (!isValidId(termId)) throw notFound();
  const term = await loadTerm(env, termId);
  if (!term || term.status === 'draft') throw notFound();

  const now = nowIso();
  const notice = NOTICES[url.searchParams.get('ok')] || '';
  const { remaining } = await termSessionsRemaining(env, term.id, now);
  const finished = term.status !== 'open' || !remaining.length;
  const seatsLeft = remaining.length ? Math.max(0, Math.min(...remaining.map((s) => s.seats_left))) : 0;
  const range = remaining.length
    ? `${formatSydney(remaining[0].starts_at, 'date')} – ${formatSydney(remaining[remaining.length - 1].starts_at, 'date')}`
    : '';

  const [children, entries, live] = await Promise.all([
    listChildren(env, user.userId),
    listWaitlistEntries(env, user.userId, { termId: term.id }),
    liveTermBookings(env, user.userId, now),
  ]);
  const onList = new Set(entries.map((w) => w.child_id));
  const booked = new Set(live.filter((b) => b.term_id === term.id).map((b) => b.child_id));

  let main;
  if (finished) {
    main = html`
      <p class="lede">This term has finished — have a look at what's coming up next.</p>
      <p><a href="/book" class="button-link">See classes</a></p>
    `;
  } else if (seatsLeft > 0) {
    const returning = term.previous_term_id ? await isReturningFamily(env, user.userId, term.id) : false;
    const access = canBookTerm({ term, now, returning });
    main = access.open
      ? html`
        <p class="lede">Good news — there ${seatsLeft === 1 ? 'is' : 'are'} ${seatsText(seatsLeft).toLowerCase()} in this term right now, so there's no need to wait.</p>
        <p><a class="button-link" href="/book/checkout?kind=term&amp;term=${term.id}">Book the term</a></p>`
      : html`<p class="lede">Bookings for this term open ${access.opensAt ? formatSydney(access.opensAt) : 'soon'} — there's no waitlist until it's full.</p>
        <p><a href="/book" class="button-link">Back to classes</a></p>`;
  } else if (!children.length) {
    main = html`
      <p class="lede">First, add your little one to your account — then you can join the waitlist for them.</p>
      <p><a class="button-link" href="/account/children/new?next=${encodeURIComponent(`/book/waitlist?term=${term.id}`)}">Add your child</a></p>
    `;
  } else {
    const options = children.map((c) => {
      const reason = booked.has(c.id) ? 'already has a place in this term' : onList.has(c.id) ? 'is already on the waitlist' : '';
      return html`
        <label class="choice ${reason ? 'choice-disabled' : ''}">
          <input type="radio" name="child" value="${c.id}" ${reason ? 'disabled' : ''} ${!reason && children.length === 1 ? 'checked' : ''} required>
          <span>${c.name}${reason ? html` <span class="muted">— ${reason}</span>` : ''}</span>
        </label>
      `;
    });
    const anyEligible = children.some((c) => !booked.has(c.id) && !onList.has(c.id));
    main = html`
      <p class="lede">This term is full. Join the waitlist and we'll email you if a place opens up — Camila offers
        places in the order families joined, and a place offered to you is held for 48 hours.</p>
      ${anyEligible ? html`
        <form method="post" action="/book/waitlist" class="booking-form">
          ${csrfField(user.csrfToken)}
          <input type="hidden" name="term" value="${term.id}">
          <fieldset class="form-group child-choices">
            <legend>Who would you like to add?</legend>
            ${joinHtml(options)}
          </fieldset>
          <button type="submit">Join the waitlist</button>
        </form>` : ''}
    `;
  }

  const body = html`
    <h1>Waitlist — ${term.name}</h1>
    <p class="class-meta">${term.class_name}${range ? html` · ${range}` : ''}${remaining.length ? html` · ${plural(remaining.length, 'week')} to go` : ''}</p>
    ${notice ? html`<p class="form-notice" role="status">${notice}</p>` : ''}
    ${entries.length ? html`<ul class="waitlist-list">${joinHtml(entries.map((w) => entryItem(w, user, term.id)))}</ul>` : ''}
    ${main}
    <p><a href="/book">Back to classes</a> · <a href="/account">My account</a></p>
  `;
  return pageResponse('Waitlist', page(body), { user, pixel: true });
}

// POST /book/waitlist — join (term, child). One entry per child per term;
// an entry the family left earlier is re-opened at the back of the line.
export async function handleWaitlistJoin(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const termId = String(form.get('term') || '');
  if (!isValidId(termId)) throw notFound();
  const back = (ok) => redirect(`/book/waitlist?term=${termId}&ok=${ok}`, 303);
  const childId = String(form.get('child') || '');
  if (!childId) return redirect(`/book/waitlist?term=${termId}`, 303);
  if (!isValidId(childId)) throw notFound();
  const child = await env.DB.prepare(
    `SELECT id, name FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(childId, user.userId).first();
  if (!child) throw notFound();
  const term = await loadTerm(env, termId);
  if (!term || term.status !== 'open') throw notFound();

  if (!(await allowRate(env, `waitlist:user:${user.userId}`, 20, 900))) {
    throw tooMany('Please wait a few minutes and try again.');
  }

  const now = nowIso();
  const { remaining } = await termSessionsRemaining(env, term.id, now);
  if (!remaining.length) return redirect(`/book/waitlist?term=${termId}`, 303);
  if (Math.min(...remaining.map((s) => s.seats_left)) > 0) return back('places');
  const live = await liveTermBookings(env, user.userId, now);
  if (live.some((b) => b.term_id === term.id && b.child_id === child.id)) return back('booked');

  const existing = await env.DB.prepare(
    `SELECT id, status FROM waitlist WHERE term_id = ?1 AND child_id = ?2`,
  ).bind(term.id, child.id).first();
  if (existing && (existing.status === 'waiting' || existing.status === 'offered')) return back('already');
  if (existing && existing.status === 'booked') return back('booked');

  if (existing) {
    await env.DB.prepare(
      `UPDATE waitlist SET status = 'waiting', joined_at = ?3, offered_at = NULL, offer_expires_at = NULL,
              resolved_at = NULL, note = TRIM(note || ' ' || ?4)
       WHERE id = ?1 AND user_id = ?2 AND status IN ('removed', 'declined')`,
    ).bind(existing.id, user.userId, now, `Re-joined online ${formatSydney(now, 'date')}.`).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at)
       VALUES (?1, ?2, ?3, ?4, 'waiting', ?5)
       ON CONFLICT(term_id, child_id) DO NOTHING`,
    ).bind(uuid(), term.id, user.userId, child.id, now).run();
  }
  logEvent('waitlist_joined', { user_id: user.userId.slice(0, 8), term_id: term.id.slice(0, 8) });
  return back('joined');
}

// POST /book/waitlist/leave — leave a waitlist; for an entry holding an
// offer, decline it and release the held place.
export async function handleWaitlistLeave(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const entryId = String(form.get('entry') || '');
  if (!isValidId(entryId)) throw notFound();
  const entry = await env.DB.prepare(
    `SELECT w.id, w.term_id, w.child_id, w.status, w.offer_booking_id, ch.name AS child_name, t.name AS term_name
     FROM waitlist w JOIN children ch ON ch.id = w.child_id JOIN terms t ON t.id = w.term_id
     WHERE w.id = ?1 AND w.user_id = ?2`,
  ).bind(entryId, user.userId).first();
  if (!entry) throw notFound();

  const now = nowIso();
  const fromAccount = form.get('from') === 'account';
  const done = (ok) => redirect(fromAccount ? `/account?ok=${ok}#waitlist` : `/book/waitlist?term=${entry.term_id}&ok=left`, 303);

  if (entry.status === 'waiting') {
    await env.DB.prepare(
      `UPDATE waitlist SET status = 'removed', resolved_at = ?3, note = TRIM(note || ' ' || ?4)
       WHERE id = ?1 AND user_id = ?2 AND status = 'waiting'`,
    ).bind(entry.id, user.userId, now, `Left the waitlist online ${formatSydney(now, 'date')}.`).run();
    logEvent('waitlist_left', { entry_id: entry.id.slice(0, 8) });
    return done('waitlist-left');
  }
  if (entry.status !== 'offered') return done('waitlist-left');

  // Declining an offer: close its hosted checkout first, so the place can't
  // be paid for after it has gone to the next family.
  const offer = entry.offer_booking_id ? await getOwnedBooking(env, entry.offer_booking_id, user.userId) : null;
  if (offer && offer.status === 'confirmed') return redirect(`/book/confirm?booking=${offer.id}`, 303);
  if (offer && offer.status === 'pending') {
    const closed = await closeProviderCheckout(env, offer);
    if (closed === 'complete') return redirect(`/book/confirm?booking=${offer.id}`, 303);
    if (closed === 'unknown') {
      const body = html`
        <h1>Please try again in a moment</h1>
        <p class="lede">We couldn't close the payment page for this place just now, so nothing has changed.</p>
        <p><a href="/account" class="button-link">Back to my account</a></p>
      `;
      return pageResponse('Please try again', page(body), { user, status: 503 });
    }
    await expireBooking(env, offer.id);
  }
  const declined = await env.DB.prepare(
    `UPDATE waitlist SET status = 'declined', resolved_at = ?3, note = TRIM(note || ' ' || ?4)
     WHERE id = ?1 AND user_id = ?2 AND status = 'offered'`,
  ).bind(entry.id, user.userId, now, `Offer declined online ${formatSydney(now, 'date')}.`).run();
  if (declined.meta.changes > 0) {
    logEvent('waitlist_offer_declined', { entry_id: entry.id.slice(0, 8) });
    await notifyOwner(env, `Waitlist place declined — ${entry.term_name}`,
      `${entry.child_name}'s family has declined the place offered from the ${entry.term_name} waitlist${
        offer ? ` (${formatAud(offer.amount_cents)})` : ''}. The held place has been released, so you can offer it to the next family.\n\n${env.PUBLIC_BASE_URL}/admin/waitlist`,
      { dedupeKey: `waitlist_declined:${entry.id}:${entry.offer_booking_id || 'none'}`, termId: entry.term_id, template: 'owner_waitlist_declined' },
    ).catch(() => {});
  }
  return done('offer-declined');
}

export function registerRoutes(route) {
  route('GET', '/book/waitlist', handleWaitlistPage);
  route('POST', '/book/waitlist', handleWaitlistJoin);
  route('POST', '/book/waitlist/leave', handleWaitlistLeave);
}
