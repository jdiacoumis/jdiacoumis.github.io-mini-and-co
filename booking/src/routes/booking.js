// Parent booking flow (Phase 2A): class list by class and term → checkout
// (child, price with voucher and account credit, pay in full or by weekly
// instalments, waiver/consent) → capacity-guarded pending booking → hosted
// payment → confirmation page. Also the page Stripe sends a parent back to
// when they leave the hosted checkout, the "start again" action for an
// unfinished checkout, and the status API the confirmation page polls.
//
// All prices and eligibility come from lib/domain.js prepareBooking() — the
// browser never supplies an amount. lib/parent-flow.js only decides how a
// term, a price or a payment status is presented.
//
// Security: every booking read/action is scoped to the owning account (any
// other id gets the same 404 as a missing one); every POST checks the CSRF
// token; the waiver/consent answers are snapshotted onto the booking; seat
// reservation is race-safe; payment happens entirely on the hosted provider
// page; logs carry id prefixes only.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuth, requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, badRequest, tooMany } from '../lib/http.js';
import { isValidId, isYesNo, cleanText } from '../lib/validate.js';
import { formatSydney } from '../lib/time.js';
import { nowIso } from '../lib/db.js';
import {
  listOpenTerms, listOneOffSessions, isReturningFamily, prepareBooking, loadTerm,
  createPendingBooking, attachPaymentRef, confirmBooking, getOwnedBooking, effectiveStatus,
  expireBooking, abandonCheckout, markPurchaseTracked, formatAud, KIND_LABELS,
} from '../lib/domain.js';
import { instalmentSchedule, normaliseVoucherCode } from '../lib/pricing.js';
import { ledgerTotals } from '../lib/ledger.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { sendPurchaseEvent, markCapiSent } from '../lib/capi-driver.js';
import { notifyBookingConfirmed } from '../lib/notify.js';
import { waiverHtml } from '../lib/waiver.js';
import { allowRate } from '../lib/ratelimit.js';
import { logEvent, logError } from '../lib/log.js';
import {
  termOffer, termHeadline, planSummary, seatsText, casualPriceText, plural, isPayLaterHold,
  planScheduleView, waitlistPositionText, listChildren, childrenWithTrial, liveTermBookings,
  pendingHoldsForChild, listWaitlistEntries, isInstalmentPlan, PAYMENT_RECEIVED_FLAGS,
} from '../lib/parent-flow.js';

export const MEDICAL_NOTES_MAX = 2000;
const MAX_SESSIONS_PER_BOOKING = 20;
const PARENT_KINDS = ['term', 'casual', 'trial'];
export const CONTACT_EMAIL = 'miniandco.classes@gmail.com';
// payments-driver names: a booking paid through the hosted checkout.
const ONLINE_PAYMENT_PROVIDERS = ['stripe', 'mock'];

export const VOUCHER_ERRORS = {
  not_found: "We couldn't find that voucher code — please check it.",
  inactive: 'That voucher is no longer active.',
  not_started: "That voucher can't be used yet.",
  expired: 'That voucher has expired.',
  used_up: 'That voucher has been fully used.',
  not_applicable: "That voucher can't be used for this kind of booking.",
};

// Session ids from a query string or form, validated and bounded.
function pickSessionIds(values) {
  return [...new Set(values.map(String).filter((v) => isValidId(v)))].slice(0, MAX_SESSIONS_PER_BOOKING);
}

// The booking a checkout URL or form describes.
// Returns { params } or { params: null } when malformed, or { params, error:
// 'no_sessions' } when a casual/trial request picked no class.
function readCheckoutParams(get, getAll) {
  let kind = String(get('kind') || '');
  const sessionIds = pickSessionIds(getAll('session'));
  if (!kind && sessionIds.length) kind = 'casual'; // older links: ?session=…
  if (!PARENT_KINDS.includes(kind)) return { params: null };
  const termRaw = String(get('term') || '');
  if (termRaw && !isValidId(termRaw)) return { params: null };
  const termId = termRaw || null;
  if (kind === 'term' && !termId) return { params: null };
  const childRaw = String(get('child') || '');
  const params = {
    kind,
    termId,
    sessionIds: kind === 'term' ? [] : sessionIds,
    childId: isValidId(childRaw) ? childRaw : null,
    voucherCode: normaliseVoucherCode(get('voucher')),
    paymentChoice: get('payment') === 'plan' ? 'plan' : 'full',
  };
  if (kind !== 'term' && !sessionIds.length) return { params, error: 'no_sessions' };
  return { params };
}

function checkoutQuery(params, overrides = {}) {
  const p = { ...params, ...overrides };
  const q = new URLSearchParams();
  q.set('kind', p.kind);
  if (p.termId) q.set('term', p.termId);
  for (const id of p.sessionIds) q.append('session', id);
  if (p.childId) q.set('child', p.childId);
  if (p.voucherCode) q.set('voucher', p.voucherCode);
  if (p.paymentChoice === 'plan') q.set('payment', 'plan');
  return q.toString();
}

function hiddenParams(params, { omit = [] } = {}) {
  const fields = [html`<input type="hidden" name="kind" value="${params.kind}">`];
  if (params.termId) fields.push(html`<input type="hidden" name="term" value="${params.termId}">`);
  for (const id of params.sessionIds) fields.push(html`<input type="hidden" name="session" value="${id}">`);
  if (params.childId && !omit.includes('child')) fields.push(html`<input type="hidden" name="child" value="${params.childId}">`);
  if (params.voucherCode && !omit.includes('voucher')) fields.push(html`<input type="hidden" name="voucher" value="${params.voucherCode}">`);
  if (params.paymentChoice === 'plan' && !omit.includes('payment')) fields.push(html`<input type="hidden" name="payment" value="plan">`);
  return joinHtml(fields);
}

function sessionLine(s) {
  return html`${formatSydney(s.starts_at)} · ${s.duration_mins} min`;
}

// A booking's classes, one line per date. When they are all the same class
// its name (and venue) is said once, above the dates — `heading: false` when
// the page already shows it.
export function sessionsList(sessions, { heading = true } = {}) {
  if (!sessions.length) return '';
  const classes = new Set(sessions.map((s) => s.class_name));
  const venues = [...new Set(sessions.map((s) => s.venue).filter(Boolean))];
  const single = classes.size === 1;
  const items = sessions.map((s) => html`
    <li class="checkout-session"><span>${single ? '' : html`${s.class_name} — `}${sessionLine(s)}</span></li>`);
  return html`
    ${single && heading ? html`<p class="sessions-heading">${sessions[0].class_name}${venues.length === 1 ? html` · ${venues[0]}` : ''}</p>` : ''}
    <ul class="checkout-sessions">${joinHtml(items)}</ul>
  `;
}

// What a booking is, in a few words: "Term — Term 1 2027".
export function bookingTitle(kind, termName) {
  return `${KIND_LABELS[kind] || 'Booking'}${termName ? ` — ${termName}` : ''}`;
}

// The line item a parent sees on the hosted payment page.
export function paymentDescription(kind, { termName = null, className = null, childName }) {
  return `Mini & Co. — ${KIND_LABELS[kind] || 'Booking'}${termName ? `, ${termName}${className ? ` (${className})` : ''}` : ''} for ${childName}`;
}

// Every parent page body sits in one wrapper (touch-target and spacing rules
// in the 2A block of css/booking.css).
function page(body) {
  return html`<div class="parent-flow">${body}</div>`;
}

// --- Class list --------------------------------------------------------------

function sessionCheckboxRow(s) {
  const full = s.seats_left <= 0;
  return html`
    <li class="session-option ${full ? 'session-option-full' : ''}">
      <label>
        <input type="checkbox" name="session" value="${s.id}" data-price-cents="${s.casual_price_cents}" ${full ? 'disabled' : ''}>
        <span class="session-when">${formatSydney(s.starts_at)}</span>
        <span class="session-meta">${s.duration_mins} min · ${formatAud(s.casual_price_cents)}</span>
        ${full ? html`<span class="session-full">Full</span>` : html`<span class="session-spots">${seatsText(s.seats_left)}</span>`}
      </label>
    </li>
  `;
}

// Tick-the-dates form for casual classes (one term's weeks, or a class's
// one-off sessions). js/booking-picker.js adds a running total.
function casualPicker(sessions, { termId = null, summary = null }) {
  const list = html`
    <ul class="session-list">${joinHtml(sessions.map(sessionCheckboxRow))}</ul>
    <p class="casual-total" data-casual-total aria-live="polite"></p>
    <button type="submit" class="button-secondary" data-casual-submit>Book selected classes</button>
  `;
  return html`
    <form method="get" action="/book/checkout" class="casual-form" data-casual-picker>
      <input type="hidden" name="kind" value="casual">
      ${termId ? html`<input type="hidden" name="term" value="${termId}">` : ''}
      ${summary
        ? html`<details class="slot-sessions"><summary>${summary}</summary>
            <p class="muted">Tick the weeks you'd like to come.</p>${list}</details>`
        : list}
    </form>
  `;
}

function trialBlock(term, openSessions, childSuffix) {
  const [next, ...others] = openSessions;
  const price = term.trial_price_cents ?? next.casual_price_cents;
  const href = (s) => html`/book/checkout?kind=trial&amp;term=${term.id}&amp;session=${s.id}${childSuffix}`;
  return html`
    <div class="trial-line">
      <p>New to Mini &amp; Co.? <a href="${href(next)}">Book a trial class — ${formatAud(price)} (${formatSydney(next.starts_at)})</a></p>
      ${others.length ? html`
        <details class="trial-dates">
          <summary>Choose a different week for the trial</summary>
          <ul>${joinHtml(others.map((s) => html`<li><a href="${href(s)}">${formatSydney(s.starts_at)}</a></li>`))}</ul>
        </details>` : ''}
      <p class="muted">One trial class per child. Afterwards we'll email you an offer to join the rest of the term.</p>
    </div>
  `;
}

// One term of a class, as this family sees it right now.
function termBlock(term, view) {
  const { now, signedIn, children, trialUsed } = view;
  const returning = view.returningTerms.has(term.id);
  const offer = termOffer({ term, now, returning });
  const scheduled = term.sessions.filter((s) => s.status === 'scheduled');
  const range = `${formatSydney(scheduled[0].starts_at, 'date')} – ${formatSydney(scheduled[scheduled.length - 1].starts_at, 'date')}`;
  const open = term.remaining.filter((s) => s.seats_left > 0);
  const booked = view.liveBookings.filter((b) => b.term_id === term.id);
  const bookedChildIds = new Set(booked.map((b) => b.child_id));
  const entries = view.waitlist.filter((w) => w.term_id === term.id);
  const waitlisted = new Set(entries.map((w) => w.child_id));
  const knownChildren = signedIn && children.length > 0;
  const unbooked = children.filter((c) => !bookedChildIds.has(c.id));
  const canBookTerm = !knownChildren || unbooked.length > 0;
  const canJoinWaitlist = !knownChildren || unbooked.some((c) => !waitlisted.has(c.id));
  const trialChildren = unbooked.filter((c) => !trialUsed.has(c.id));
  const offerTrial = open.length > 0 && (!knownChildren || trialChildren.length > 0);
  const childSuffix = knownChildren && children.length > 1 && trialChildren.length === 1 ? `&child=${trialChildren[0].id}` : '';

  const showReturningPrice = !signedIn && Boolean(term.previous_term_id) && !offer.isReturning
    && offer.returningPriceCents !== null && offer.returningPriceCents < offer.publicPriceCents;
  const priceLine = html`
    <p class="term-price">${termHeadline(offer)}
      ${offer.isReturning ? html`<span class="term-returning">returning family price</span>` : ''}
      ${offer.plan ? html`<span class="term-plan">${planSummary(offer.plan, offer.priceCents)}</span>` : ''}
    </p>
    ${offer.isProRata ? html`<p class="muted">The term has started, so you only pay for the weeks that are left.</p>` : ''}
    ${showReturningPrice ? html`<p class="muted">Families returning from last term pay ${formatAud(offer.returningPriceCents)}.</p>` : ''}
  `;

  const bookedNotes = booked.map((b) => {
    if (b.status === 'confirmed') return html`<li>${b.child_name} is booked in for this term.</li>`;
    return isPayLaterHold(b, now)
      ? html`<li>${b.child_name}'s place is held until ${formatSydney(b.expires_at)}. <a href="/account/bookings/${b.id}/pay">Pay now</a></li>`
      : html`<li>${b.child_name}'s booking is waiting for its payment to finish.</li>`;
  });
  // An offer of the whole term already shows above as a held booking; an
  // offer of a trial or chosen weeks is shown here.
  const heldIds = new Set(booked.map((b) => b.id));
  const waitNotes = entries.map((w) => {
    if (w.status === 'waiting') return html`<li>${w.child_name} is on the waitlist — ${waitlistPositionText(w.position)}.</li>`;
    if (!w.offer_booking_id || heldIds.has(w.offer_booking_id)) return '';
    return html`<li>A place is being held for ${w.child_name}${w.offer_expires_at ? html` until ${formatSydney(w.offer_expires_at)}` : ''}.
      <a href="/account/bookings/${w.offer_booking_id}/pay">Pay now</a></li>`;
  }).filter(Boolean);
  const notes = [...bookedNotes, ...waitNotes];

  let actions;
  if (!offer.access.open) {
    const { opensAt } = offer.access;
    const early = offer.earlyWindow && !returning
      ? html`<p class="term-early">Families enrolled last term can book early${offer.earlyWindow.from ? html` from ${formatSydney(offer.earlyWindow.from)}` : ''}${signedIn
        ? '.' : html` — <a href="/auth/request-magic-link?next=%2Fbook">sign in</a> to book.`}</p>`
      : '';
    actions = html`
      <p class="term-opens">${opensAt ? html`Bookings open ${formatSydney(opensAt)}.` : 'Bookings are not open yet.'}${
        returning && opensAt && opensAt === term.returning_opens_at ? ' Early booking for returning families.' : ''}</p>
      ${early}
    `;
  } else {
    const windowNote = offer.returningUntil
      ? html`<p class="term-window">Returning families only until ${formatSydney(offer.returningUntil)} — then bookings open to everyone.</p>`
      : '';
    const termAction = offer.seatsLeft > 0
      ? (canBookTerm ? html`
          <p class="term-book">
            <a class="button-link" href="/book/checkout?kind=term&amp;term=${term.id}">${offer.isProRata ? 'Join the term' : 'Book the term'}</a>
            <span class="session-spots">${seatsText(offer.seatsLeft)}</span>
          </p>` : '')
      : html`
          <div class="term-full">
            ${canJoinWaitlist ? html`
              <p><strong>This term is full.</strong> Join the waitlist and we'll email you if a place opens up.</p>
              <p><a class="button-link button-secondary" href="/book/waitlist?term=${term.id}">Join the waitlist</a></p>`
            : html`<p><strong>This term is full.</strong></p>`}
          </div>`;
    actions = html`
      ${windowNote}
      ${termAction}
      ${open.length ? casualPicker(term.remaining, { termId: term.id, summary: `Or book individual classes — ${casualPriceText(term.remaining)}` }) : ''}
      ${offerTrial ? trialBlock(term, open, childSuffix) : ''}
    `;
  }

  return html`
    <div class="term-group" id="term-${term.id}">
      <h3>${term.name} <span class="term-range">· ${range} · ${plural(offer.totalWeeks, 'week')}</span></h3>
      ${priceLine}
      ${notes.length ? html`<ul class="term-notes">${joinHtml(notes)}</ul>` : ''}
      ${actions}
    </div>
  `;
}

function oneOffBlock(sessions) {
  return html`
    <div class="term-group one-off-group">
      <h3>Single classes <span class="term-range">· ${casualPriceText(sessions)}</span></h3>
      ${casualPicker(sessions, {})}
    </div>
  `;
}

// Terms and one-off sessions grouped by class (one weekly slot), in the
// order the terms run.
function groupByClass(terms, oneOffs) {
  const groups = new Map();
  const ensure = (row) => {
    if (!groups.has(row.class_id)) {
      groups.set(row.class_id, {
        classId: row.class_id, name: row.class_name, ageRange: row.age_range, venue: row.venue,
        description: row.class_description, terms: [], oneOffs: [],
      });
    }
    return groups.get(row.class_id);
  };
  for (const term of terms) ensure(term).terms.push(term);
  for (const session of oneOffs) ensure(session).oneOffs.push(session);
  return [...groups.values()];
}

function classCard(group, view) {
  const meta = [group.ageRange, group.venue].filter(Boolean).join(' · ');
  return html`
    <section class="class-card" id="class-${group.classId}">
      <h2>${group.name}</h2>
      ${meta ? html`<p class="class-meta">${meta}</p>` : ''}
      ${group.description ? html`<p>${group.description}</p>` : ''}
      ${joinHtml(group.terms.map((term) => termBlock(term, view)))}
      ${group.oneOffs.length ? oneOffBlock(group.oneOffs) : ''}
    </section>
  `;
}

// GET /book — public class list: each class with its open terms (prices,
// opening windows, places, casual dates, trial, waitlist).
export async function handleClassList(req, env) {
  const user = await requireAuth(req, env);
  const now = nowIso();
  const [terms, oneOffs] = await Promise.all([listOpenTerms(env, { now }), listOneOffSessions(env, { now })]);

  const view = {
    now, signedIn: Boolean(user), children: [], trialUsed: new Set(), returningTerms: new Set(),
    liveBookings: [], waitlist: [],
  };
  if (user) {
    const [children, liveBookings, waitlist] = await Promise.all([
      listChildren(env, user.userId),
      liveTermBookings(env, user.userId, now),
      listWaitlistEntries(env, user.userId),
    ]);
    Object.assign(view, { children, liveBookings, waitlist });
    view.trialUsed = await childrenWithTrial(env, children, now);
    for (const term of terms) {
      if (term.previous_term_id && await isReturningFamily(env, user.userId, term.id)) view.returningTerms.add(term.id);
    }
  }

  const groups = groupByClass(terms, oneOffs);
  const body = html`
    <h1>Book a class</h1>
    <div data-pixel-page="class-list">
      ${groups.length ? html`
        <p class="lede">Book a whole term, join part-way through, pick single classes, or try one class first.
          All times are Sydney time.</p>
        ${joinHtml(groups.map((group) => classCard(group, view)))}
      ` : html`
        <p class="lede">There are no classes open for booking right now — check back soon, or follow us on
          Instagram for the next term's dates.</p>
      `}
    </div>
    <script src="/js/booking-picker.js" defer></script>
  `;
  return pageResponse('Book a class', page(body), { user, pixel: true });
}

// --- Checkout ----------------------------------------------------------------

const REASONS = {
  full: 'is full',
  past: 'has already started',
  not_found: 'is no longer available',
  unavailable: 'is no longer available',
  already_booked: 'is already booked for this child',
};

// Help when the conflict is the family's own unfinished booking: a pay-later
// hold just needs paying; an abandoned checkout can be cancelled and restarted.
function holdHelp(user, hold, child, params, now) {
  if (isPayLaterHold(hold, now)) {
    return {
      title: `${child.name}'s place is already held`,
      body: html`
        <p class="lede">${child.name}'s place is held for you until ${formatSydney(hold.expires_at)} — it just needs paying.</p>
        <p><a class="button-link" href="/account/bookings/${hold.id}/pay">Pay now</a></p>
      `,
    };
  }
  return {
    title: "You've already started this booking",
    body: html`
      <p class="lede">You started this booking a little while ago, but the payment wasn't finished.
        If you closed the payment page, you can cancel that payment and start again.</p>
      <form method="post" action="/book/checkout/release" class="inline-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="booking" value="${hold.id}">
        ${params ? hiddenParams(params) : ''}
        <button type="submit">Cancel that payment and start again</button>
      </form>
    `,
  };
}

// A booking that cannot go ahead, explained — every prepareBooking() and
// createPendingBooking() error has its own plain-language page.
async function cannotBookPage(env, user, failure, { child = null, params = null } = {}) {
  const now = nowIso();
  const termId = params ? params.termId : null;
  const sessions = failure.sessions || [];
  let title = "Sorry — that booking can't go ahead";
  let message = '';
  let status = 409;
  let extra = '';
  let waitlist = false;
  switch (failure.error) {
    case 'not_open_yet': {
      title = 'Not open yet';
      const term = termId ? await loadTerm(env, termId) : null;
      message = failure.opensAt
        ? `Bookings for ${term ? term.name : 'this term'} open ${formatSydney(failure.opensAt)}.`
        : 'Bookings for this term are not open yet.';
      if (term && term.previous_term_id && term.public_opens_at && now < term.public_opens_at) {
        extra = html`<p>Families enrolled last term can book a little earlier — if that's you, make sure you're signed in with the email you booked with last term.</p>`;
      }
      break;
    }
    case 'closed':
      title = 'Bookings are closed';
      message = 'Bookings for this term are closed — have a look at the classes that are open now.';
      break;
    case 'finished':
      title = 'This term has finished';
      message = 'There are no classes left in this term — have a look at what is coming up next.';
      break;
    case 'no_sessions':
      title = 'Choose a class';
      message = "Please tick at least one class you'd like to book.";
      status = 400;
      break;
    case 'trial_one_session':
      title = 'A trial is one class';
      message = 'A trial is a single class — please choose just one date.';
      status = 400;
      break;
    case 'trial_used':
      title = 'Trial already booked';
      message = `${child ? child.name : 'This child'} has already had a trial class — you're welcome to book the term or a casual class instead.`;
      break;
    case 'already_booked':
      title = 'Already booked!';
      message = 'You can see the existing booking in your account.';
      break;
    case 'full':
    case 'capacity':
      title = 'Oh no — that class just filled up';
      message = 'No payment has been taken and no places are held.';
      waitlist = Boolean(termId);
      break;
    case 'unavailable':
      title = 'That class is no longer available';
      message = 'No payment has been taken and no places are held.';
      break;
    case 'plan_unavailable':
      message = "Instalments aren't available for this booking — please go back and choose to pay in full.";
      status = 400;
      break;
    case 'voucher_invalid':
      message = 'That voucher can no longer be used — please go back and remove it.';
      status = 400;
      break;
    case 'credit_changed':
      message = 'Your account credit changed while you were booking — please go back to the class list and try again.';
      break;
    case 'invalid_kind':
      title = "That booking link doesn't look right";
      message = 'Please start again from the class list.';
      status = 400;
      break;
    default:
      title = "We couldn't find that class";
      message = 'It may have been changed or removed — have a look at the classes that are open now.';
      status = failure.error === 'not_found' ? 404 : 409;
  }

  // The conflict may be this family's own unfinished booking: offer to pay
  // for it (pay-later hold) or to cancel the abandoned payment and restart.
  if (child && (failure.error === 'already_booked' || failure.error === 'trial_used')) {
    const holds = await pendingHoldsForChild(env, {
      userId: user.userId, childId: child.id, termId, sessionIds: sessions.map((s) => s.id),
      kind: failure.error === 'trial_used' ? 'trial' : null, now,
    });
    if (holds.length) {
      const help = holdHelp(user, holds[0], child, params, now);
      title = help.title;
      message = '';
      extra = help.body;
    }
  }

  const items = sessions.map((s) => html`
    <li>${s.class_name ? html`${s.class_name} — ` : ''}${s.starts_at ? sessionLine(s) : 'A selected class'} ${REASONS[s.reason] || 'is unavailable'}.</li>
  `);
  const body = html`
    <h1>${title}</h1>
    ${items.length ? html`<ul class="notice-list">${joinHtml(items)}</ul>` : ''}
    ${message ? html`<p class="lede">${message}</p>` : ''}
    ${extra}
    ${failure.error === 'already_booked' && !extra ? html`<p><a href="/account">Go to my account</a></p>` : ''}
    ${waitlist ? html`<p><a class="button-link button-secondary" href="/book/waitlist?term=${termId}">Join the waitlist</a></p>` : ''}
    <p><a href="/book" class="button-link">Back to classes</a></p>
  `;
  return pageResponse('Booking unavailable', page(body), { user, status, pixel: true });
}

function priceBreakdown(quote) {
  const returningNote = quote.isReturning ? ' (returning family price)' : '';
  const label = {
    term: quote.isProRata
      ? `Remaining ${quote.weeks} of ${quote.totalWeeks} weeks${returningNote}`
      : `Whole term — ${plural(quote.weeks, 'week')}${returningNote}`,
    casual: plural(quote.weeks, 'casual class', 'casual classes'),
    trial: 'Trial class',
  }[quote.kind] || 'Booking';
  return html`
    <table class="price-breakdown">
      <tbody>
        <tr><td>${label}</td><td>${formatAud(quote.listCents)}</td></tr>
        ${quote.discountCents ? html`<tr><td>Voucher ${quote.voucherCode}</td><td>−${formatAud(quote.discountCents)}</td></tr>` : ''}
        ${quote.creditCents ? html`<tr><td>Account credit applied</td><td>−${formatAud(quote.creditCents)}</td></tr>` : ''}
        <tr class="price-total"><td>Total</td><td>${formatAud(quote.amountCents)} AUD</td></tr>
      </tbody>
    </table>
  `;
}

// The pay-in-full / instalments choice with the dated schedule (D3/D4).
export function planChoice({ amountCents, planOption, paymentChoice, now }) {
  if (!planOption || amountCents <= 0) return '';
  const { n, interval } = planOption;
  const schedule = instalmentSchedule(amountCents, n, interval, now);
  const cadence = interval === 'fortnight' ? 'fortnightly' : 'weekly';
  const then = interval === 'fortnight' ? 'every fortnight' : 'each week';
  const isPlan = paymentChoice === 'plan';
  return html`
    <fieldset class="form-group plan-options">
      <legend>How would you like to pay?</legend>
      <label class="choice"><input type="radio" name="payment" value="full" ${isPlan ? '' : 'checked'}>
        <span>Pay ${formatAud(amountCents)} in full today</span></label>
      <label class="choice"><input type="radio" name="payment" value="plan" ${isPlan ? 'checked' : ''}>
        <span>Pay in ${n} ${cadence} instalments — ${formatAud(schedule.firstCents)} today, then ${formatAud(schedule.eachCents)} ${then}</span></label>
      <details class="plan-schedule" ${isPlan ? 'open' : ''}>
        <summary>See the instalment dates</summary>
        <ol class="plan-dates">${joinHtml(schedule.payments.map((p) => html`
          <li><span>${p.index === 1 ? 'Today' : formatSydney(p.dueAt, 'date')}</span><span>${formatAud(p.amountCents)}</span></li>`))}</ol>
        <p class="muted">Instalments come out automatically from the card you use today. If one doesn't go through
          we'll let you know, your place is kept, and you can update your card from your account.</p>
      </details>
    </fieldset>
  `;
}

// Medical details, photo consent and the waiver: required before any payment
// session is created (booking-flow spec). Shared with the account's Pay now.
export function consentFields({ child, env, medicalNotes = null }) {
  const consent = child.photo_consent ? 'yes' : 'no';
  return html`
    <h2>Medical details</h2>
    <div class="form-group">
      <label for="medical">Please confirm ${child.name}'s medical conditions or allergies (leave blank if none)</label>
      <textarea id="medical" name="medical" rows="4" maxlength="${MEDICAL_NOTES_MAX}">${medicalNotes ?? child.medical_notes}</textarea>
    </div>

    <h2>Photos</h2>
    <fieldset class="form-group consent-group">
      <legend>May we include ${child.name} in class photos shared on our socials?</legend>
      <label><input type="radio" name="photo_consent" value="yes" ${consent === 'yes' ? 'checked' : ''} required> Yes, photos are okay</label>
      <label><input type="radio" name="photo_consent" value="no" ${consent === 'no' ? 'checked' : ''}> No, please keep my child out of photos</label>
    </fieldset>

    <h2>Terms &amp; Conditions</h2>
    <div class="waiver-text" tabindex="0">
      ${waiverHtml}
      <p class="waiver-version">Waiver version ${env.WAIVER_VERSION}</p>
    </div>
    <div class="form-group">
      <label class="choice"><input type="checkbox" name="waiver" value="accepted" required> <span>I have read and accept the Terms &amp; Conditions and Cancellation Policy above</span></label>
    </div>
  `;
}

// The waiver/consent answers from a submitted form, or null when incomplete.
export function readConsent(form) {
  const photoConsent = String(form.get('photo_consent') || '');
  if (form.get('waiver') !== 'accepted' || !isYesNo(photoConsent)) return null;
  return { photoConsent: photoConsent === 'yes', medical: cleanText(form.get('medical'), MEDICAL_NOTES_MAX) };
}

async function childChooser(env, user, params, children) {
  const now = nowIso();
  const trialUsed = params.kind === 'trial' ? await childrenWithTrial(env, children, now) : new Set();
  const booked = params.kind === 'term' && params.termId
    ? new Set((await liveTermBookings(env, user.userId, now)).filter((b) => b.term_id === params.termId).map((b) => b.child_id))
    : new Set();
  const options = children.map((c) => {
    const reason = trialUsed.has(c.id) ? 'has already had a trial class'
      : booked.has(c.id) ? 'is already booked in for this term' : '';
    return reason
      ? html`<li><span class="child-unavailable">${c.name} <span class="muted">— ${reason}</span></span></li>`
      : html`<li><a class="button-link" href="/book/checkout?${checkoutQuery(params, { childId: c.id })}">${c.name}</a></li>`;
  });
  const body = html`
    <h1>Who is coming along?</h1>
    <ul class="child-chooser">${joinHtml(options)}</ul>
    <p><a href="/account/children/new?next=${encodeURIComponent(`/book/checkout?${checkoutQuery(params)}`)}">Add another child</a></p>
    <p><a href="/book">Back to classes</a></p>
  `;
  return pageResponse('Choose a child', page(body), { user, pixel: true });
}

// GET /book/checkout?kind=term|casual|trial&term=…&session=…[&child=…][&voucher=…][&payment=plan]
export async function handleCheckout(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const { params, error } = readCheckoutParams((k) => url.searchParams.get(k), (k) => url.searchParams.getAll(k));
  if (!params) return redirect('/book', 303);
  if (error) return cannotBookPage(env, user, { error }, { params });

  const children = await listChildren(env, user.userId);
  // A booking is always for a specific child — direct parents with none to
  // create a profile first (child-profiles spec), then return here.
  if (!children.length) {
    const next = encodeURIComponent(`/book/checkout?${checkoutQuery(params)}`);
    const body = html`
      <h1>First, tell us about your little one</h1>
      <p class="lede">Bookings are made for a specific child, so we know ages, medical needs, and photo preferences for each class.</p>
      <p><a href="/account/children/new?next=${next}" class="button-link">Add your child</a></p>
    `;
    return pageResponse('Add your child', page(body), { user, pixel: true });
  }

  let child = params.childId ? children.find((c) => c.id === params.childId) || null : null;
  if (!child && children.length === 1) [child] = children;
  if (!child) return childChooser(env, user, params, children);
  params.childId = child.id;

  const now = nowIso();
  const prepared = await prepareBooking(env, {
    userId: user.userId, childId: child.id, kind: params.kind, termId: params.termId,
    sessionIds: params.sessionIds, voucherCode: params.voucherCode, now,
  });
  if (!prepared.ok) return cannotBookPage(env, user, prepared, { child, params });
  const { quote, term, sessions } = prepared;

  const title = bookingTitle(quote.kind, term ? term.name : null);
  const voucherMessage = quote.voucherError ? VOUCHER_ERRORS[quote.voucherError] || 'That voucher cannot be used.' : '';

  const body = html`
    <h1>Checkout</h1>
    <section class="checkout-summary" data-pixel-page="checkout">
      <h2>${title} for ${child.name}</h2>
      ${children.length > 1 ? html`<p class="checkout-child">Not for ${child.name}? <a href="/book/checkout?${checkoutQuery(params, { childId: null })}">Choose another child</a></p>` : ''}
      ${term ? html`<p class="class-meta">${term.class_name} · ${term.venue}</p>` : ''}
      ${prepared.warnings.includes('child_already_holds_some_weeks')
        ? html`<p class="form-notice" role="status">${child.name} already has a place in some of these weeks — those are left out and the price follows.</p>`
        : ''}
      ${sessionsList(sessions, { heading: !term })}
      ${priceBreakdown(quote)}
      ${quote.isProRata ? html`<p class="muted">The term has already started, so the price covers the ${plural(quote.weeks, 'week')} that are left.</p>` : ''}
      ${quote.creditCents ? html`<p class="muted">Your account credit is used automatically — nothing to enter.</p>` : ''}
      ${quote.kind === 'trial' ? html`<p class="muted">After the trial we'll email you an offer to join the rest of the term.</p>` : ''}
    </section>

    <form method="get" action="/book/checkout" class="voucher-form">
      ${hiddenParams(params, { omit: ['voucher'] })}
      <label for="voucher">Voucher code</label>
      <input type="text" id="voucher" name="voucher" value="${params.voucherCode}" maxlength="40" autocomplete="off">
      <button type="submit" class="button-secondary button-small">Apply</button>
      ${voucherMessage ? html`<p class="form-error" role="alert">${voucherMessage}</p>` : ''}
    </form>

    <form method="post" action="/book/checkout" class="booking-form">
      ${csrfField(user.csrfToken)}
      ${hiddenParams({ ...params, voucherCode: quote.voucherCode || '' }, { omit: ['payment'] })}

      ${planChoice({ amountCents: quote.amountCents, planOption: quote.planOption, paymentChoice: params.paymentChoice, now })}
      ${consentFields({ child, env })}

      <button type="submit">${quote.amountCents > 0 ? 'Continue to payment' : 'Confirm booking'}</button>
    </form>
    <p><a href="/book">Back to classes</a></p>
  `;
  return pageResponse('Checkout', page(body), { user, pixel: true });
}

// Start the hosted payment for a pending booking and remember its handle.
// Throws when the provider refuses (callers decide what happens to the hold).
// `exclusive` (Pay now on an existing booking): the checkout is attached —
// together with how it pays (in full, or the plan the webhook and the mock
// checkout read) in the same write — only if no other checkout was attached
// meanwhile (a double click, a second tab). Otherwise it is expired at once
// and null returned, so two hosted pages can never both take a payment for
// one booking, and the plan on record always matches the attached checkout.
export async function createHostedCheckout(env, {
  bookingId, amountCents, description, user, plan = null, exclusive = false,
}) {
  const driver = getPaymentsDriver(env);
  const checkout = await driver.createCheckout({
    bookingId,
    amountCents,
    description,
    customerEmail: user.email,
    customerId: user.stripeCustomerId,
    mode: plan ? 'subscription' : 'payment',
    plan: plan ? { n: plan.n, eachCents: plan.eachCents, firstCents: plan.firstCents, interval: plan.interval } : null,
  });
  if (!exclusive) {
    await attachPaymentRef(env, bookingId, driver.name, checkout.checkoutRef);
    return checkout.url;
  }
  const attached = await env.DB.prepare(
    `UPDATE bookings SET payment_provider = ?2, payment_ref = ?3, payment_method = ?4,
            plan_instalments = ?5, plan_instalment_cents = ?6, plan_interval = ?7
     WHERE id = ?1 AND status = 'pending' AND payment_ref IS NULL`,
  ).bind(bookingId, driver.name, checkout.checkoutRef, plan ? 'plan' : 'full',
    plan ? plan.n : null, plan ? plan.eachCents : null, plan ? plan.interval : null).run();
  if (attached.meta.changes > 0) return checkout.url;
  try {
    await driver.expireCheckout(checkout.checkoutRef);
  } catch (err) {
    logError('checkout_expire_failed', err, { booking_id: bookingId.slice(0, 8) });
  }
  return null;
}

async function sendConfirmation(env, bookingId, ctx) {
  const send = notifyBookingConfirmed(env, bookingId).catch((err) => logError('confirmation_email_failed', err, {}));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
}

// Confirm a booking that owes nothing (credit or voucher covers it) — the
// zero-balance path shared with the account's Pay now.
export async function confirmWithoutPayment(env, bookingId, ctx) {
  const result = await confirmBooking(env, bookingId, { provider: 'free' });
  if (result.ok && result.newlyConfirmed) await sendConfirmation(env, bookingId, ctx);
  return result;
}

// POST /book/checkout — create the pending booking and hand off to payment.
export async function handleCheckoutPost(req, env, _params, ctx) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const { params, error } = readCheckoutParams((k) => form.get(k), (k) => form.getAll(k));
  if (!params) throw badRequest('That booking request was not valid.');
  if (error) return cannotBookPage(env, user, { error }, { params });

  // Ownership check: a child id belonging to another account is treated
  // exactly like a nonexistent one (no booking, no disclosure).
  const child = params.childId ? await env.DB.prepare(
    `SELECT id, name FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(params.childId, user.userId).first() : null;
  if (!child) throw notFound();

  // Waiver acceptance and an explicit consent answer are required BEFORE any
  // payment session is created (booking-flow spec).
  const consent = readConsent(form);
  if (!consent) {
    throw badRequest('Please accept the waiver and answer the photo consent question before continuing to payment.');
  }

  // Security: pending bookings hold seats — limit how many one account can
  // start (resource-exhaustion abuse, API4/CWE-400).
  if (!(await allowRate(env, `checkout:user:${user.userId}`, 8, 900))) {
    throw tooMany('You have started quite a few bookings in a short time — please give it a few minutes and try again.');
  }

  const prepared = await prepareBooking(env, {
    userId: user.userId, childId: child.id, kind: params.kind, termId: params.termId,
    sessionIds: params.sessionIds, voucherCode: params.voucherCode, paymentChoice: params.paymentChoice,
  });
  if (!prepared.ok) return cannotBookPage(env, user, prepared, { child, params });
  const { quote, term } = prepared;
  if (quote.voucherError) {
    const body = html`
      <h1>Voucher not applied</h1>
      <p class="lede">${VOUCHER_ERRORS[quote.voucherError] || 'That voucher cannot be used.'} Nothing has been booked —
        please go back, remove the code or try another, and continue.</p>
      <p><a href="/book/checkout?${checkoutQuery(params, { voucherCode: '' })}" class="button-link">Back to checkout</a></p>
    `;
    return pageResponse('Voucher not applied', page(body), { user, status: 400, pixel: true });
  }

  const created = await createPendingBooking(env, {
    userId: user.userId, childId: child.id, kind: params.kind, termId: term ? term.id : null,
    sessionIds: quote.sessionIds, quote, waiverVersion: env.WAIVER_VERSION,
    photoConsent: consent.photoConsent, medicalNotes: consent.medical,
  });
  if (created.error) return cannotBookPage(env, user, created, { child, params });

  // Nothing to pay (credit or voucher covers it): confirm straight away.
  if (created.amountCents === 0) {
    await confirmWithoutPayment(env, created.id, ctx);
    return redirect(`/book/confirm?booking=${created.id}`, 303);
  }

  let url;
  try {
    url = await createHostedCheckout(env, {
      bookingId: created.id,
      amountCents: created.amountCents,
      description: paymentDescription(params.kind, { termName: term?.name, className: term?.class_name, childName: child.name }),
      user,
      plan: quote.plan,
    });
  } catch (err) {
    logError('checkout_creation_failed', err, { booking_id: created.id.slice(0, 8) });
    await expireBooking(env, created.id); // release the held seats
    throw badRequest('We could not start the payment — no money has been taken. Please try again in a moment.');
  }
  return redirect(url, 303);
}

// --- Leaving a hosted checkout --------------------------------------------------

// Expire the hosted checkout attached to a booking so it can no longer take a
// payment. Returns 'none' (nothing attached) | 'expired' | 'complete' (it was
// paid: the payment is on its way) | 'unknown' (provider unreachable; nothing
// changed).
export async function closeProviderCheckout(env, booking) {
  if (!booking.payment_ref) return 'none';
  const driver = getPaymentsDriver(env);
  try {
    await driver.expireCheckout(booking.payment_ref);
    return 'expired';
  } catch (err) {
    // Not open any more: either completed (the payment is on its way) or
    // already expired. Ask the provider which.
    let info = null;
    try {
      info = await driver.retrieveCheckout(booking.payment_ref);
    } catch (retrieveErr) {
      logError('checkout_retrieve_failed', retrieveErr, { booking_id: booking.id.slice(0, 8) });
    }
    if (info && info.status === 'complete') return 'complete';
    if (info && info.status === 'expired') return 'expired';
    logError('checkout_expire_failed', err, { booking_id: booking.id.slice(0, 8) });
    return 'unknown';
  }
}

// The parent backed out of the hosted checkout. Expire the provider's session
// FIRST so the still-open Stripe tab can no longer take a payment, then
// release (or, for a pay-later hold, keep) the seats.
// Returns 'released' | 'kept' | 'paid' | 'held'.
export async function backOutOfCheckout(env, booking) {
  const closed = await closeProviderCheckout(env, booking);
  if (closed === 'complete') return 'paid';
  if (closed === 'unknown') return 'held';
  // A held place keeps its seats (detached); either way an instalment plan
  // chosen for the abandoned checkout is forgotten by abandonCheckout (Pay
  // now asks again), so an offline payment recorded later is never a plan.
  const outcome = await abandonCheckout(env, booking.id, booking.payment_ref || null);
  logEvent('booking_backed_out_of_checkout', { booking_id: booking.id.slice(0, 8), outcome });
  return outcome === 'detached' ? 'kept' : 'released';
}

// GET /book/cancelled?booking=… — parent backed out of the hosted checkout.
export async function handleCancelledPage(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const bookingId = String(new URL(req.url).searchParams.get('booking') || '');

  let outcome = 'inactive';
  let booking = null;
  if (isValidId(bookingId)) {
    booking = await getOwnedBooking(env, bookingId, user.userId);
    if (booking && booking.status === 'confirmed') return redirect(`/book/confirm?booking=${booking.id}`, 303);
    // Money already arrived for it: the confirmation page explains.
    if (booking && (PAYMENT_RECEIVED_FLAGS.includes(booking.needs_attention) || booking.paid_cents > 0)) {
      return redirect(`/book/confirm?booking=${booking.id}`, 303);
    }
    if (booking && booking.status === 'pending') outcome = await backOutOfCheckout(env, booking);
  }
  if (outcome === 'paid') return redirect(`/book/confirm?booking=${booking.id}`, 303);

  const body = {
    released: html`
      <h1>Payment cancelled</h1>
      <p class="lede">No money was taken and your places have been released. You're welcome to book again whenever you're ready.</p>
      <p><a href="/book" class="button-link">Back to classes</a></p>
    `,
    kept: html`
      <h1>Payment cancelled</h1>
      <p class="lede">No money was taken. Your place is still held${booking && booking.expires_at ? html` until ${formatSydney(booking.expires_at)}` : ''} — you can pay from your account whenever you're ready.</p>
      <p><a href="/account" class="button-link">Go to my account</a></p>
    `,
    held: html`
      <h1>Payment not finished</h1>
      <p class="lede">We couldn't close the payment page just now. If you didn't pay, your place will be released automatically within half an hour.</p>
      <p><a href="/account" class="button-link">Go to my account</a></p>
    `,
    inactive: html`
      <h1>Payment cancelled</h1>
      <p class="lede">This booking is no longer waiting for a payment. You're welcome to book again whenever you're ready.</p>
      <p><a href="/book" class="button-link">Back to classes</a></p>
    `,
  }[outcome];
  return pageResponse('Payment cancelled', page(body), { user, pixel: true });
}

// POST /book/checkout/release — "cancel that payment and start again": the
// family's own unfinished checkout (e.g. they left Stripe with the browser's
// back button) is expired at the provider, its hold released, and the parent
// returned to the checkout they were trying to start.
export async function handleReleaseCheckout(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  const bookingId = String(form.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();
  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  // Confirmed, or money already arrived for it (paid with no seat, paid
  // after cancellation): the confirmation page explains — never "no money
  // was taken".
  if (booking.status === 'confirmed' || PAYMENT_RECEIVED_FLAGS.includes(booking.needs_attention) || booking.paid_cents > 0) {
    return redirect(`/book/confirm?booking=${booking.id}`, 303);
  }
  const { params } = readCheckoutParams((k) => form.get(k), (k) => form.getAll(k));
  const fromAccount = form.get('from') === 'account';
  const back = fromAccount ? '/account?ok=payment-cancelled' : params ? `/book/checkout?${checkoutQuery(params)}` : '/book';
  if (booking.status !== 'pending') return redirect(fromAccount ? '/account' : back, 303);

  const outcome = await backOutOfCheckout(env, booking);
  if (outcome === 'paid') return redirect(`/book/confirm?booking=${booking.id}`, 303);
  if (outcome === 'held') {
    const body = html`
      <h1>Please try again in a moment</h1>
      <p class="lede">We couldn't close the earlier payment page just now, so nothing has changed. If you didn't pay,
        that booking will be released automatically within half an hour.</p>
      <p><a href="/book" class="button-link">Back to classes</a></p>
    `;
    return pageResponse('Please try again', page(body), { user, status: 503, pixel: true });
  }
  return redirect(back, 303);
}

// --- Confirmation ------------------------------------------------------------

async function reportPurchase(env, req, booking, user) {
  const url = new URL(req.url);
  const result = await sendPurchaseEvent(env, {
    bookingId: booking.id,
    email: user.email,
    phone: user.phone,
    amountCents: booking.amount_cents,
    eventSourceUrl: `${url.origin}${url.pathname}`,
    clientUserAgent: req.headers.get('User-Agent') || '',
    clientIpAddress: req.headers.get('CF-Connecting-IP') || '',
  });
  if (result.sent) await markCapiSent(env, booking.id);
}

// "Update card" (Stripe Billing Portal) — only when the family has a Stripe
// customer on file.
export function updateCardForm(user, { label = 'Update card', secondary = false } = {}) {
  if (!user.stripeCustomerId) return '';
  return html`
    <form method="post" action="/account/billing-portal" class="inline-form">
      ${csrfField(user.csrfToken)}
      <button type="submit" class="${secondary ? 'button-secondary' : ''}">${label}</button>
    </form>
  `;
}

function discountLines(booking) {
  const lines = [];
  if (booking.discount_cents > 0) {
    lines.push(`${booking.voucher_code ? `Voucher ${booking.voucher_code}` : 'Discount'}: −${formatAud(booking.discount_cents)}`);
  }
  if (booking.credit_cents > 0) lines.push(`Account credit: −${formatAud(booking.credit_cents)}`);
  return lines.length ? html`<p class="muted">${lines.join(' · ')}</p>` : '';
}

function planSummaryBlock(booking, instalmentsPaid, now) {
  const due = booking.amount_cents + booking.credit_cents;
  const schedule = planScheduleView(booking, instalmentsPaid, now);
  const left = schedule.filter((p) => !p.paid).length;
  return html`
    <p><strong>Paid so far: ${formatAud(booking.paid_cents)} of ${formatAud(due)} AUD</strong></p>
    <ol class="plan-dates">${joinHtml(schedule.map((p) => html`
      <li class="${p.paid ? 'plan-paid' : ''}"><span>${formatSydney(p.dueAt, 'date')}</span><span>${formatAud(p.amountCents)}${p.paid ? ' — paid' : ''}</span></li>`))}</ol>
    <p>${left > 0
      ? html`The remaining ${plural(left, 'instalment')} ${left === 1 ? 'is' : 'are'} taken automatically${booking.plan_next_charge_at ? html` — the next one on ${formatSydney(booking.plan_next_charge_at, 'date')}` : ''}.`
      : 'All instalments are paid — thank you!'}</p>
  `;
}

// The money part of a confirmed booking's page.
function paymentSummary(booking, { instalmentsPaid, user, now }) {
  if (booking.kind === 'complimentary' || booking.payment_status === 'waived') {
    return html`<p>Complimentary — nothing to pay.</p>`;
  }
  const flag = booking.needs_attention;
  const owing = Math.max(0, booking.amount_cents + booking.credit_cents - booking.paid_cents);
  // (a refund keeps a deliberately refunded booking "paid" — see ledger.js)
  const settled = booking.payment_status === 'paid' || booking.payment_status === 'plan_complete';
  const parts = [];
  if (isInstalmentPlan(booking)) {
    parts.push(planSummaryBlock(booking, instalmentsPaid, now));
  } else if (booking.amount_cents === 0) {
    parts.push(html`<p><strong>Nothing to pay</strong>${booking.credit_cents ? ' — covered by your account credit' : ''}.</p>`);
  } else if (settled) {
    parts.push(html`<p><strong>Paid: ${formatAud(booking.amount_cents)} AUD</strong></p>`);
  } else {
    parts.push(html`<p><strong>Still to pay: ${formatAud(owing)} AUD</strong></p>`);
  }
  parts.push(discountLines(booking));
  if (booking.payment_status === 'plan_overdue' || flag === 'plan_overdue') {
    parts.push(html`
      <div class="pf-alert" role="status">
        <p><strong>An instalment didn't go through.</strong> Your place is kept — please update your card so the payment can be retried.</p>
        ${user.stripeCustomerId ? updateCardForm(user) : html`<p>Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we'll help.</p>`}
      </div>`);
  } else if (flag === 'plan_ended_short') {
    parts.push(html`<p class="pf-alert">Your instalment plan ended before the full amount was paid — Camila will be in touch.</p>`);
  } else if (flag === 'credit_shortfall') {
    parts.push(html`<p class="pf-alert">Part of this booking was to be covered by account credit that had already been used — Camila will be in touch about the difference.</p>`);
  } else if (flag === 'webhook_mismatch') {
    parts.push(html`<p class="pf-alert">Camila will double-check the payment for this booking and be in touch if anything's needed.</p>`);
  }
  return joinHtml(parts);
}

// GET /book/confirm?booking=… — confirmation page; reflects pending payment
// and flips to confirmed once the webhook lands (the page polls its own
// status). Never claims "no payment was taken" when money arrived.
export async function handleConfirmPage(req, env, _params, ctx) {
  const user = await requireAuthOrRedirect(req, env);
  const bookingId = String(new URL(req.url).searchParams.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();

  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  const now = nowIso();
  const status = effectiveStatus(booking, now);
  const flag = booking.needs_attention;
  const classes = sessionsList(booking.sessions.filter((s) => s.status === 'booked'));
  const title = bookingTitle(booking.kind, booking.term_name);
  const received = html`
    <p>If you have any questions in the meantime, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
    <p><a href="/account" class="button-link">Go to my account</a></p>
  `;

  let body;
  let extraHead = '';
  if (status === 'confirmed') {
    // D12: the Purchase event renders at most once per booking — only the
    // request that sets purchase_tracked_at gets the data attributes (and
    // sends the server-side copy with this visitor's user agent and IP).
    // Only payments made online through the hosted checkout count: a cash or
    // bank-transfer payment the owner recorded is not a web conversion.
    const track = !booking.purchase_tracked_at && booking.amount_cents > 0
      && ONLINE_PAYMENT_PROVIDERS.includes(booking.payment_provider)
      && await markPurchaseTracked(env, booking.id);
    if (track && !booking.capi_sent) {
      const report = reportPurchase(env, req, booking, user).catch((err) => logError('capi_report_failed', err, {}));
      if (ctx && ctx.waitUntil) ctx.waitUntil(report); else await report;
    }
    const instalmentsPaid = isInstalmentPlan(booking) ? (await ledgerTotals(env, booking.id)).instalments_paid : 0;
    body = html`
      <div class="confirm-panel confirm-paid"
        ${track ? html`data-pixel-purchase data-booking-id="${booking.id}" data-amount="${(booking.amount_cents / 100).toFixed(2)}" data-currency="AUD"` : ''}>
        <h1>You're booked in! 🎉</h1>
        <p class="lede">${title} for ${booking.child_name} — we can't wait to see you.</p>
        ${classes}
        ${paymentSummary(booking, { instalmentsPaid, user, now })}
        ${booking.kind === 'trial' ? html`<p>After the class we'll email you an offer to join the rest of the term.</p>` : ''}
        <p>A confirmation email is on its way. You can see all your bookings in <a href="/account">your account</a>.</p>
      </div>
    `;
  } else if (status === 'pending' && !booking.payment_ref && isPayLaterHold(booking, now)) {
    body = html`
      <div class="confirm-panel confirm-pending">
        <h1>Your place is held</h1>
        <p class="lede">${title} for ${booking.child_name} is held for you until ${formatSydney(booking.expires_at)}.
          Pay before then to keep it.</p>
        ${classes}
        <p><a class="button-link" href="/account/bookings/${booking.id}/pay">Pay now — ${formatAud(booking.amount_cents)}</a></p>
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
        ${classes}
        <p class="muted">Closed the payment page without paying? You can pick up where you left off from <a href="/account">your account</a>.</p>
      </div>
      <script src="/js/booking-status.js" defer></script>
    `;
  } else if (flag === 'paid_after_cancel') {
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>Thank you — we've received your payment</h1>
        <p class="lede">This booking had been cancelled before your payment arrived. Camila has been told and will be in
          touch to sort it out — a refund or another class, whichever suits you. You don't need to do anything.</p>
        ${received}
      </div>
    `;
  } else if (flag === 'paid_no_seat' || (status === 'expired' && booking.paid_cents > 0)) {
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>Thank you — we've received your payment</h1>
        <p class="lede">Unfortunately the last place was taken while your payment was being processed. Camila has been
          told and will be in touch shortly to arrange another class or a refund. You don't need to do anything.</p>
        ${received}
      </div>
    `;
  } else if (status === 'cancelled') {
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>This booking has been cancelled</h1>
        ${booking.paid_cents > 0
          ? html`<p class="lede">Camila will be in touch about what you paid, if she hasn't been already.</p>`
          : ''}
        <p>If you have any questions, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
        <p><a href="/book" class="button-link">Back to classes</a></p>
      </div>
    `;
  } else {
    // Never claim "no payment was taken": a payment may still be on its way.
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>This booking wasn't completed</h1>
        <p class="lede">The places it was holding have been released. If you did complete a payment, don't worry —
          we'll match it up and be in touch. You can book again any time.</p>
        <p><a href="/book" class="button-link">Back to classes</a></p>
      </div>
    `;
  }
  return pageResponse('Booking confirmation', page(body), { user, extraHead, pixel: true });
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

export function registerRoutes(route) {
  route('GET', '/book', handleClassList);
  route('GET', '/book/checkout', handleCheckout);
  route('POST', '/book/checkout', handleCheckoutPost);
  route('POST', '/book/checkout/release', handleReleaseCheckout);
  route('GET', '/book/confirm', handleConfirmPage);
  route('GET', '/book/cancelled', handleCancelledPage);
  route('GET', '/api/bookings/:id/status', handleBookingStatus);
}
