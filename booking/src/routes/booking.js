// Parent booking flow: public class list → child + waiver/consent step →
// capacity-guarded pending booking → hosted payment → confirmation page.
//
// Security: every booking read/action is scoped to the owning account; the
// waiver/consent answers are snapshotted onto the booking; seat reservation
// is race-safe (see lib/domain.js); payment happens entirely on the hosted
// provider page so no card data ever touches this system.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuth, requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, badRequest } from '../lib/http.js';
import { isValidId, isYesNo, cleanText } from '../lib/validate.js';
import { formatSydney, sydneyWeekday } from '../lib/time.js';
import {
  listOpenClasses, loadSessionsForBooking, createPendingBooking, attachPaymentRef,
  confirmBooking, getOwnedBooking, effectiveStatus, expireBooking,
  sweepExpiredBookings, sessionsAlreadyBookedForChild, formatAud,
} from '../lib/domain.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { allowRate } from '../lib/ratelimit.js';
import { tooMany } from '../lib/http.js';
import { logEvent, logError } from '../lib/log.js';

const MEDICAL_NOTES_MAX = 2000;
const MAX_SESSIONS_PER_BOOKING = 20;

// Session ids from a query string or form, validated and bounded.
function pickSessionIds(values) {
  const ids = values.filter((v) => isValidId(v));
  return [...new Set(ids)].slice(0, MAX_SESSIONS_PER_BOOKING);
}

function sessionLine(s) {
  return html`${formatSydney(s.starts_at ?? s.startsAt)} · ${s.duration_mins ?? s.durationMins} min`;
}

function sessionCheckboxRow(s) {
  const full = s.seatsLeft === 0;
  const availability = full
    ? html`<span class="session-full">Full</span>`
    : html`<span class="session-spots">${s.seatsLeft} ${s.seatsLeft === 1 ? 'spot' : 'spots'} left</span>`;
  return html`
    <li class="session-option ${full ? 'session-option-full' : ''}">
      <label>
        <input type="checkbox" name="session" value="${s.id}" ${full ? 'disabled' : ''}>
        <span class="session-when">${formatSydney(s.startsAt)}</span>
        <span class="session-meta">${s.durationMins} min · ${formatAud(s.priceCents)}</span>
        ${availability}
      </label>
    </li>
  `;
}

function checkoutLink(sessions) {
  return `/book/checkout?${sessions.map((s) => `session=${encodeURIComponent(s.id)}`).join('&')}`;
}

// GET /book — public class list, organised by term and weekly time slot,
// with whole-term booking and a single-session trial as the headline actions.
export async function handleClassList(req, env) {
  const user = await requireAuth(req, env);
  await sweepExpiredBookings(env);
  const classes = await listOpenClasses(env);

  const classCards = classes.map((cls) => {
    // Sessions arrive sorted by start time; group term → weekly slot.
    const terms = new Map();
    for (const s of cls.sessions) {
      const termKey = s.termLabel || 'Upcoming sessions';
      if (!terms.has(termKey)) terms.set(termKey, new Map());
      const slots = terms.get(termKey);
      const slotKey = `${sydneyWeekday(s.startsAt)}s at ${formatSydney(s.startsAt, 'time')}`;
      if (!slots.has(slotKey)) slots.set(slotKey, []);
      slots.get(slotKey).push(s);
    }

    const nextAvailable = cls.sessions.find((s) => s.seatsLeft > 0);

    const termBlocks = [...terms.entries()].map(([label, slots]) => {
      const all = [...slots.values()].flat().sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
      const range = `${formatSydney(all[0].startsAt, 'date')} – ${formatSydney(all[all.length - 1].startsAt, 'date')}`;

      const slotBlocks = [...slots.entries()].map(([slotLabel, list]) => {
        const bookable = list.filter((s) => s.seatsLeft > 0);
        const total = bookable.reduce((sum, s) => sum + s.priceCents, 0);
        return html`
          <div class="slot-group">
            <h4>${slotLabel}</h4>
            ${bookable.length > 1 ? html`
              <a class="button-link button-small" href="${checkoutLink(bookable)}">
                Book the full term — ${bookable.length} sessions · ${formatAud(total)}
              </a>
            ` : ''}
            <details class="slot-sessions">
              <summary>Pick individual dates instead</summary>
              <ul class="session-list">${joinHtml(list.map(sessionCheckboxRow))}</ul>
            </details>
          </div>
        `;
      });

      return html`
        <div class="term-group">
          <h3>${label} <span class="term-range">· ${range}</span></h3>
          ${joinHtml(slotBlocks)}
        </div>
      `;
    });

    return html`
      <section class="class-card">
        <h2>${cls.name}</h2>
        <p class="class-meta">${cls.ageRange} · ${cls.venue}</p>
        <p>${cls.description}</p>
        ${nextAvailable ? html`
          <p class="trial-line">New to Mini &amp; Co.?
            <a href="${checkoutLink([nextAvailable])}">Try a single class first — next spot ${formatSydney(nextAvailable.startsAt)}</a>
          </p>
        ` : ''}
        ${joinHtml(termBlocks)}
      </section>
    `;
  });

  const body = html`
    <h1>Book a class</h1>
    ${classes.length ? html`
      <p class="lede">Book a whole term in one go, or pick the individual dates that suit you. All times are Sydney local time.</p>
      <form method="get" action="/book/checkout" data-pixel-page="class-list">
        ${joinHtml(classCards)}
        <button type="submit">Continue with selected dates</button>
      </form>
    ` : html`
      <p class="lede">There are no upcoming sessions open for booking right now — check back soon, or follow us on Instagram for the next term's dates.</p>
    `}
  `;
  return pageResponse('Book a class', body, { user });
}

// Friendly conflict page identifying the unavailable session(s).
function unavailablePage(user, sessions) {
  const reasons = {
    full: 'has just filled up',
    past: 'has already started',
    not_found: 'is no longer available',
    unavailable: 'is no longer available',
    already_booked: 'is already booked for this child',
  };
  const allDuplicates = sessions.every((s) => s.reason === 'already_booked');
  const items = sessions.map((s) => html`
    <li>${s.class_name ? html`${s.class_name} — ` : ''}${s.starts_at ? sessionLine(s) : 'A selected session'} ${reasons[s.reason] || 'is unavailable'}.</li>
  `);
  const body = html`
    <h1>${allDuplicates ? 'Already booked!' : 'Oh no — that session just filled up'}</h1>
    <ul class="notice-list">${joinHtml(items)}</ul>
    <p class="lede">No payment has been taken and no new seats are held. ${allDuplicates ? html`You can see the existing booking in <a href="/account">your account</a>.` : 'Pop back to the class list to pick another time.'}</p>
    <p><a href="/book" class="button-link">Back to classes</a></p>
  `;
  return pageResponse('Session unavailable', body, { user, status: 409 });
}

// GET /book/checkout?session=…[&child=…] — child choice + waiver/consent step.
export async function handleCheckout(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const sessionIds = pickSessionIds(url.searchParams.getAll('session'));
  if (!sessionIds.length) return redirect('/book', 303);

  const sessions = await loadSessionsForBooking(env, sessionIds);
  const unavailable = sessions.filter((s) => !s.bookable);
  if (unavailable.length) return unavailablePage(user, unavailable);

  const children = (await env.DB.prepare(
    `SELECT id, name, medical_notes, photo_consent FROM children
     WHERE user_id = ?1 AND archived_at IS NULL ORDER BY created_at`,
  ).bind(user.userId).all()).results || [];

  const sessionParams = sessionIds.map((id) => `session=${encodeURIComponent(id)}`).join('&');

  // A booking is always for a specific child — direct parents with none to
  // create a profile first (child-profiles spec), then return here.
  if (!children.length) {
    const next = encodeURIComponent(`/book/checkout?${sessionParams}`);
    const body = html`
      <h1>First, tell us about your little one</h1>
      <p class="lede">Bookings are made for a specific child, so we know ages, medical needs, and photo preferences for each class.</p>
      <p><a href="/account/children/new?next=${next}" class="button-link">Add your child</a></p>
    `;
    return pageResponse('Add your child', body, { user });
  }

  // More than one child and none chosen yet → chooser step.
  const childParam = url.searchParams.get('child');
  let child = null;
  if (childParam && isValidId(childParam)) {
    child = children.find((c) => c.id === childParam) || null;
  }
  if (!child && children.length === 1) child = children[0];

  if (!child) {
    const options = children.map((c) => html`
      <li><a class="button-link" href="/book/checkout?${sessionParams}&child=${c.id}">${c.name}</a></li>
    `);
    const body = html`
      <h1>Who is coming along?</h1>
      <ul class="child-chooser">${joinHtml(options)}</ul>
      <p><a href="/account/children/new?next=${encodeURIComponent(`/book/checkout?${sessionParams}`)}">Add another child</a></p>
    `;
    return pageResponse('Choose a child', body, { user });
  }

  // Leave out anything this child is already booked into, with a notice; if
  // nothing remains, say so instead of selling a duplicate seat.
  const alreadyBooked = await sessionsAlreadyBookedForChild(env, child.id, sessions.map((s) => s.id));
  const bookableSessions = sessions.filter((s) => !alreadyBooked.has(s.id));
  if (!bookableSessions.length) {
    return unavailablePage(user, sessions.map((s) => ({ ...s, reason: 'already_booked' })));
  }
  const duplicateNotice = alreadyBooked.size ? html`
    <p class="form-notice" role="status">${child.name} is already booked into
      ${joinHtml(sessions.filter((s) => alreadyBooked.has(s.id)).map((s) => sessionLine(s)), '; ')}
      — those dates have been left out below.</p>
  ` : '';

  const total = bookableSessions.reduce((sum, s) => sum + s.price_cents, 0);
  const sessionItems = bookableSessions.map((s) => html`
    <li class="checkout-session">
      <span>${s.class_name} — ${sessionLine(s)}</span>
      <span>${formatAud(s.price_cents)}</span>
      <input type="hidden" name="session" value="${s.id}">
    </li>
  `);

  const consent = child.photo_consent ? 'yes' : 'no';
  const body = html`
    <h1>Checkout</h1>
    ${duplicateNotice}
    <form method="post" action="/book/checkout" class="booking-form" data-pixel-page="checkout">
      ${csrfField(user.csrfToken)}
      <input type="hidden" name="child" value="${child.id}">

      <h2>Booking for ${child.name}</h2>
      <ul class="checkout-sessions">${joinHtml(sessionItems)}</ul>
      <p class="checkout-total"><strong>Total: ${formatAud(total)} AUD</strong></p>

      <h2>Medical details</h2>
      <div class="form-group">
        <label for="medical">Please confirm ${child.name}'s medical conditions or allergies (leave blank if none)</label>
        <textarea id="medical" name="medical" rows="4" maxlength="${MEDICAL_NOTES_MAX}">${child.medical_notes}</textarea>
      </div>

      <h2>Photos</h2>
      <fieldset class="form-group consent-group">
        <legend>May we include ${child.name} in class photos shared on our socials?</legend>
        <label><input type="radio" name="photo_consent" value="yes" ${consent === 'yes' ? 'checked' : ''} required> Yes, photos are okay</label>
        <label><input type="radio" name="photo_consent" value="no" ${consent === 'no' ? 'checked' : ''}> No, please keep my child out of photos</label>
      </fieldset>

      <h2>Waiver and terms</h2>
      <div class="waiver-text">
        <p>I understand that Mini &amp; Co. sensory classes involve supervised play and that I (or the accompanying adult) remain responsible for my child at all times during the session. I have disclosed all relevant medical conditions and allergies above. I understand classes involve sensory materials (water, textures, food-safe items) and will guide my child's participation according to their needs. Bookings are transferable to another session where space allows; please contact us as early as possible if you can't make it.</p>
        <p class="waiver-version">Waiver version ${env.WAIVER_VERSION}</p>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="waiver" value="accepted" required> I accept the waiver and terms above</label>
      </div>

      <button type="submit">Continue to payment</button>
    </form>
  `;
  return pageResponse('Checkout', body, { user });
}

// POST /book/checkout — create the pending booking and hand off to payment.
export async function handleCheckoutPost(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const childId = String(form.get('child') || '');
  const sessionIds = pickSessionIds(form.getAll('session').map(String));
  const medical = cleanText(form.get('medical'), MEDICAL_NOTES_MAX);
  const photoConsent = String(form.get('photo_consent') || '');
  const waiverAccepted = form.get('waiver') === 'accepted';

  if (!sessionIds.length) throw badRequest('No sessions were selected.');

  // Ownership check: a child id belonging to another account is treated
  // exactly like a nonexistent one (no booking, no disclosure).
  const child = isValidId(childId) ? await env.DB.prepare(
    `SELECT id, name FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(childId, user.userId).first() : null;
  if (!child) throw notFound();

  // Waiver acceptance and an explicit consent answer are required BEFORE any
  // payment session is created (booking-flow spec).
  if (!waiverAccepted || !isYesNo(photoConsent)) {
    throw badRequest('Please accept the waiver and answer the photo consent question before continuing to payment.');
  }

  // Security: pending bookings hold seats for 35 minutes — rate limit booking
  // creation per account so one signed-in user cannot hold a term's seats
  // hostage by spamming checkouts (resource-exhaustion abuse, API4/CWE-400).
  if (!(await allowRate(env, `checkout:user:${user.userId}`, 8, 900))) {
    throw tooMany('You have started quite a few bookings in a short time — please give it a few minutes and try again.');
  }

  const result = await createPendingBooking(env, {
    userId: user.userId,
    childId: child.id,
    sessionIds,
    waiverVersion: env.WAIVER_VERSION,
    photoConsent: photoConsent === 'yes',
    medicalNotes: medical,
  });

  if (result.error === 'unavailable' || result.error === 'capacity' || result.error === 'already_booked') {
    return unavailablePage(user, result.sessions);
  }
  if (result.error) throw badRequest('That booking could not be created. Please try again.');

  // Zero-priced bookings (free taster sessions) skip payment entirely.
  if (result.amountCents === 0) {
    await confirmBooking(env, result.id, { paymentProvider: 'free', amountCents: 0 });
    return redirect(`/book/confirm?booking=${result.id}`, 303);
  }

  const driver = getPaymentsDriver(env);
  let checkout;
  try {
    checkout = await driver.createCheckout({
      bookingId: result.id,
      amountCents: result.amountCents,
      description: `Mini & Co. Sensory Classes — ${result.sessions.length} session${result.sessions.length === 1 ? '' : 's'} for ${child.name}`,
    });
  } catch (err) {
    logError('checkout_creation_failed', err, { booking_id: result.id.slice(0, 8) });
    await expireBooking(env, result.id); // release the held seats
    throw badRequest('We could not start the payment — no money has been taken. Please try again in a moment.');
  }

  await attachPaymentRef(env, result.id, driver.name, checkout.checkoutRef);
  return redirect(checkout.url, 303);
}

// GET /book/confirm?booking=… — confirmation page; reflects pending payment
// and flips to paid once the webhook lands (the page polls its own status).
export async function handleConfirmPage(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const bookingId = String(url.searchParams.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();

  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  const status = effectiveStatus(booking);
  const sessionItems = booking.sessions.map((s) => html`
    <li>${s.class_name} — ${sessionLine(s)} <span class="session-venue">(${s.venue})</span></li>
  `);

  let body;
  let extraHead = '';
  if (status === 'confirmed') {
    body = html`
      <div class="confirm-panel confirm-paid"
           data-pixel-purchase data-booking-id="${booking.id}"
           data-amount="${(booking.amount_cents / 100).toFixed(2)}" data-currency="AUD">
        <h1>You're booked in! 🎉</h1>
        <p class="lede">Payment received — we can't wait to see ${booking.child_name}.</p>
        <ul class="confirm-sessions">${joinHtml(sessionItems)}</ul>
        <p><strong>Paid: ${formatAud(booking.amount_cents)} AUD</strong></p>
        <p>A confirmation email is on its way. You can see all your bookings in <a href="/account">your account</a>.</p>
      </div>
    `;
  } else if (status === 'pending') {
    // Poll via first-party JS; <noscript> meta-refresh keeps it working
    // without JavaScript.
    extraHead = `<noscript><meta http-equiv="refresh" content="5"></noscript>`;
    body = html`
      <div class="confirm-panel confirm-pending" data-poll-booking="${booking.id}">
        <h1>Confirming your payment…</h1>
        <p class="lede">We're waiting for the payment confirmation — this page will update automatically. You don't need to do anything.</p>
        <ul class="confirm-sessions">${joinHtml(sessionItems)}</ul>
      </div>
      <script src="/js/booking-status.js" defer></script>
    `;
  } else {
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>This booking wasn't completed</h1>
        <p class="lede">No payment was taken and the seats have been released. You can book again any time.</p>
        <p><a href="/book" class="button-link">Back to classes</a></p>
      </div>
    `;
  }
  return pageResponse('Booking confirmation', body, { user, extraHead });
}

// GET /book/cancelled?booking=… — parent backed out of the hosted checkout.
// Their own pending booking is expired immediately so the seats free up.
export async function handleCancelledPage(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const bookingId = String(url.searchParams.get('booking') || '');

  if (isValidId(bookingId)) {
    const booking = await getOwnedBooking(env, bookingId, user.userId);
    if (booking && booking.status === 'pending') {
      await expireBooking(env, booking.id);
      logEvent('booking_cancelled_at_checkout', { booking_id: booking.id.slice(0, 8) });
    }
  }

  const body = html`
    <h1>Payment cancelled</h1>
    <p class="lede">No money was taken and your seats have been released. You're welcome to book again whenever you're ready.</p>
    <p><a href="/book" class="button-link">Back to classes</a></p>
  `;
  return pageResponse('Payment cancelled', body, { user });
}

// GET /api/bookings/:id/status — JSON status for confirmation-page polling.
// Owner-scoped: other accounts (and unknown ids) get the same 404 body.
export async function handleBookingStatus(req, env, params) {
  const user = await requireAuth(req, env);
  if (!user) {
    return Response.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!isValidId(params.id)) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const booking = await env.DB.prepare(
    `SELECT id, status, expires_at FROM bookings WHERE id = ?1 AND user_id = ?2`,
  ).bind(params.id, user.userId).first();
  if (!booking) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ status: effectiveStatus(booking) }, { headers: { 'Cache-Control': 'no-store' } });
}
