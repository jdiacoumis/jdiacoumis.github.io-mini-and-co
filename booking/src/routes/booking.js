// Parent booking flow: class list by term → child + waiver/consent step →
// capacity-guarded pending booking → hosted payment (in full or by
// instalments) → confirmation page.
//
// Phase 1 gives the term-based model a functional, plain flow; Phase 2A
// (which owns this file) polishes it. All prices and eligibility come from
// lib/domain.js prepareBooking() — the browser never supplies an amount.
//
// Security: every booking read/action is scoped to the owning account; the
// waiver/consent answers are snapshotted onto the booking; seat reservation is
// race-safe; payment happens entirely on the hosted provider page.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuth, requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, badRequest, tooMany } from '../lib/http.js';
import { isValidId, isYesNo, cleanText } from '../lib/validate.js';
import { formatSydney } from '../lib/time.js';
import { nowIso } from '../lib/db.js';
import {
  listOpenTerms, listOneOffSessions, isReturningFamily, childHasTrial, prepareBooking,
  createPendingBooking, attachPaymentRef, confirmBooking, getOwnedBooking, effectiveStatus,
  expireBooking, abandonCheckout, markPurchaseTracked, formatAud, KIND_LABELS,
} from '../lib/domain.js';
import {
  canBookTerm, returningPriceApplies, proRata, planFor, instalmentSchedule, normaliseVoucherCode,
} from '../lib/pricing.js';
import { getPaymentsDriver } from '../lib/payments-driver.js';
import { sendPurchaseEvent, markCapiSent } from '../lib/capi-driver.js';
import { notifyBookingConfirmed } from '../lib/notify.js';
import { waiverHtml } from '../lib/waiver.js';
import { allowRate } from '../lib/ratelimit.js';
import { logEvent, logError } from '../lib/log.js';

const MEDICAL_NOTES_MAX = 2000;
const MAX_SESSIONS_PER_BOOKING = 20;
const PARENT_KINDS = ['term', 'casual', 'trial'];

const VOUCHER_ERRORS = {
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

// The booking a checkout URL or form describes. null = malformed.
function readCheckoutParams(get, getAll) {
  let kind = String(get('kind') || '');
  const sessionIds = pickSessionIds(getAll('session'));
  if (!kind && sessionIds.length) kind = 'casual'; // older links: ?session=…
  if (!PARENT_KINDS.includes(kind)) return null;
  const termRaw = String(get('term') || '');
  if (termRaw && !isValidId(termRaw)) return null;
  const termId = termRaw || null;
  if (kind === 'term' && !termId) return null;
  if (kind !== 'term' && !sessionIds.length) return null;
  const childRaw = String(get('child') || '');
  return {
    kind,
    termId,
    sessionIds: kind === 'term' ? [] : sessionIds,
    childId: isValidId(childRaw) ? childRaw : null,
    voucherCode: normaliseVoucherCode(get('voucher')),
    paymentChoice: get('payment') === 'plan' ? 'plan' : 'full',
  };
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

async function listChildren(env, userId) {
  return (await env.DB.prepare(
    `SELECT id, name, medical_notes, photo_consent FROM children
     WHERE user_id = ?1 AND archived_at IS NULL ORDER BY created_at`,
  ).bind(userId).all()).results || [];
}

function sessionLine(s) {
  return html`${formatSydney(s.starts_at)} · ${s.duration_mins} min`;
}

function seatsText(n) {
  return `${n} ${n === 1 ? 'place' : 'places'} left`;
}

// --- Class list --------------------------------------------------------------

function sessionCheckboxRow(s) {
  const full = s.seats_left === 0;
  return html`
    <li class="session-option ${full ? 'session-option-full' : ''}">
      <label>
        <input type="checkbox" name="session" value="${s.id}" ${full ? 'disabled' : ''}>
        <span class="session-when">${formatSydney(s.starts_at)}</span>
        <span class="session-meta">${s.duration_mins} min · ${formatAud(s.casual_price_cents)}</span>
        ${full ? html`<span class="session-full">Full</span>` : html`<span class="session-spots">${seatsText(s.seats_left)}</span>`}
      </label>
    </li>
  `;
}

function termCard(term, { now, returning, trialOpen }) {
  const access = canBookTerm({ term, now, returning });
  const scheduled = term.sessions.filter((s) => s.status === 'scheduled');
  const { remaining } = term;
  const returningPrice = returningPriceApplies({ term, now, returning });
  const base = returningPrice ? term.returning_price_cents : term.term_price_cents;
  const price = proRata(base, remaining.length, scheduled.length);
  const proRated = remaining.length < scheduled.length;
  const plan = planFor(term, remaining.length, price);
  const range = `${formatSydney(scheduled[0].starts_at, 'date')} – ${formatSydney(scheduled[scheduled.length - 1].starts_at, 'date')}`;
  const trialPrice = term.trial_price_cents ?? term.casual_price_cents;
  const nextOpen = remaining.find((s) => s.seats_left > 0);

  const priceLine = html`
    <p class="term-price">
      ${proRated ? `Join for the remaining ${remaining.length} weeks — ${formatAud(price)}` : `Whole term, ${scheduled.length} weeks — ${formatAud(price)}`}
      ${returningPrice ? html`<span class="term-returning">returning family price</span>` : ''}
      ${plan ? html`<span class="term-plan">or ${plan.n} ${plan.interval === 'fortnight' ? 'fortnightly' : 'weekly'} payments</span>` : ''}
    </p>
  `;

  let actions;
  if (!access.open) {
    actions = html`
      <p class="term-opens">${access.opensAt ? html`Bookings open ${formatSydney(access.opensAt)}.` : 'Bookings are not open yet.'}
        ${term.returning_opens_at && !returning ? ' Families enrolled last term get early access.' : ''}</p>
    `;
  } else {
    actions = html`
      ${term.term_seats_left > 0
        ? html`<p class="term-book"><a class="button-link" href="/book/checkout?kind=term&amp;term=${term.id}">Book the term</a>
            <span class="session-spots">${seatsText(term.term_seats_left)}</span></p>`
        : html`<p class="term-full">This term is full. <a href="/book/waitlist?term=${term.id}">Join the waitlist</a></p>`}
      <form method="get" action="/book/checkout" class="casual-form">
        <input type="hidden" name="kind" value="casual">
        <input type="hidden" name="term" value="${term.id}">
        <details class="slot-sessions">
          <summary>Or book individual classes — ${formatAud(term.casual_price_cents)} each</summary>
          <ul class="session-list">${joinHtml(remaining.map(sessionCheckboxRow))}</ul>
          <button type="submit" class="button-secondary">Book selected classes</button>
        </details>
      </form>
      ${trialOpen && nextOpen ? html`
        <p class="trial-line">New to Mini &amp; Co.?
          <a href="/book/checkout?kind=trial&amp;term=${term.id}&amp;session=${nextOpen.id}">Book a trial class — ${formatAud(trialPrice)} (${formatSydney(nextOpen.starts_at)})</a>
        </p>
      ` : ''}
    `;
  }

  return html`
    <section class="class-card term-card">
      <h2>${term.class_name}</h2>
      <p class="class-meta">${term.age_range} · ${term.venue}</p>
      <p>${term.class_description}</p>
      <div class="term-group">
        <h3>${term.name} <span class="term-range">· ${range}</span></h3>
        ${priceLine}
        ${actions}
      </div>
    </section>
  `;
}

function oneOffBlock(sessions) {
  if (!sessions.length) return '';
  return html`
    <section class="class-card">
      <h2>Other classes</h2>
      <form method="get" action="/book/checkout" class="casual-form">
        <input type="hidden" name="kind" value="casual">
        <ul class="session-list">${joinHtml(sessions.map((s) => html`
          ${sessionCheckboxRow(s)}
        `))}</ul>
        <button type="submit" class="button-secondary">Book selected classes</button>
      </form>
    </section>
  `;
}

// GET /book — public class list: open terms with their prices and actions.
export async function handleClassList(req, env) {
  const user = await requireAuth(req, env);
  const now = nowIso();
  const [terms, oneOffs] = await Promise.all([listOpenTerms(env, { now }), listOneOffSessions(env, { now })]);

  // Signed in: returning-family windows, and whether any child can still
  // book a trial in each class.
  const returning = new Set();
  const trialOpen = new Map();
  if (user) {
    const children = await listChildren(env, user.userId);
    for (const term of terms) {
      if (await isReturningFamily(env, user.userId, term.id)) returning.add(term.id);
      if (!trialOpen.has(term.class_id)) {
        let open = children.length === 0;
        for (const child of children) {
          if (!(await childHasTrial(env, child.id, term.class_id, now))) { open = true; break; }
        }
        trialOpen.set(term.class_id, open);
      }
    }
  }

  const cards = terms.map((term) => termCard(term, {
    now, returning: returning.has(term.id), trialOpen: trialOpen.get(term.class_id) ?? true,
  }));
  const body = html`
    <h1>Book a class</h1>
    <div data-pixel-page="class-list">
      ${terms.length || oneOffs.length ? html`
        <p class="lede">Book a whole term, join part-way through, or try a single class first. All times are Sydney local time.</p>
        ${joinHtml(cards)}
        ${oneOffBlock(oneOffs)}
      ` : html`
        <p class="lede">There are no classes open for booking right now — check back soon, or follow us on Instagram for the next term's dates.</p>
      `}
    </div>
  `;
  return pageResponse('Book a class', body, { user, pixel: true });
}

// --- Checkout ----------------------------------------------------------------

const REASONS = {
  full: 'has just filled up',
  past: 'has already started',
  not_found: 'is no longer available',
  unavailable: 'is no longer available',
  already_booked: 'is already booked for this child',
};

// A booking that cannot go ahead, explained.
function cannotBookPage(user, failure, { child = null, termId = null } = {}) {
  const sessions = failure.sessions || [];
  let title = "Sorry — that booking can't go ahead";
  let message;
  let status = 409;
  switch (failure.error) {
    case 'not_open_yet':
      title = 'Not open yet';
      message = failure.opensAt ? `Bookings for this term open ${formatSydney(failure.opensAt)}.` : 'Bookings for this term are not open yet.';
      break;
    case 'trial_used':
      title = 'Trial already booked';
      message = `${child ? child.name : 'This child'} has already had a trial class for this class — you're welcome to book the term or a casual class instead.`;
      break;
    case 'finished':
      message = 'This term has finished.';
      break;
    case 'already_booked':
      title = 'Already booked!';
      message = 'You can see the existing booking in your account.';
      break;
    case 'full':
    case 'capacity':
    case 'unavailable':
      title = 'Oh no — that class just filled up';
      message = 'No payment has been taken and no seats are held.';
      break;
    case 'plan_unavailable':
      message = "Instalments aren't available for this booking — please choose to pay in full.";
      status = 400;
      break;
    case 'voucher_invalid':
      message = 'That voucher can no longer be used — please go back and remove it.';
      status = 400;
      break;
    case 'credit_changed':
      message = 'Your account credit changed while you were booking — please go back to the class list and try again.';
      break;
    default:
      message = 'That class is no longer available.';
      status = failure.error === 'not_found' ? 404 : 409;
  }
  const items = sessions.map((s) => html`
    <li>${s.class_name ? html`${s.class_name} — ` : ''}${s.starts_at ? sessionLine(s) : 'A selected class'} ${REASONS[s.reason] || 'is unavailable'}.</li>
  `);
  const body = html`
    <h1>${title}</h1>
    ${items.length ? html`<ul class="notice-list">${joinHtml(items)}</ul>` : ''}
    <p class="lede">${message}</p>
    ${failure.error === 'already_booked' ? html`<p><a href="/account">Go to my account</a></p>` : ''}
    ${['full', 'capacity'].includes(failure.error) && termId ? html`<p><a href="/book/waitlist?term=${termId}">Join the waitlist</a></p>` : ''}
    <p><a href="/book" class="button-link">Back to classes</a></p>
  `;
  return pageResponse('Booking unavailable', body, { user, status, pixel: true });
}

function priceBreakdown(quote) {
  const returningNote = quote.isReturning ? ' (returning family price)' : '';
  const label = {
    term: quote.isProRata
      ? `Remaining ${quote.weeks} of ${quote.totalWeeks} weeks${returningNote}`
      : `Whole term — ${quote.weeks} weeks${returningNote}`,
    casual: `${quote.weeks} casual class${quote.weeks === 1 ? '' : 'es'}`,
    trial: 'Trial class',
  }[quote.kind] || 'Booking';
  return html`
    <table class="price-breakdown">
      <tbody>
        <tr><td>${label}</td><td>${formatAud(quote.listCents)}</td></tr>
        ${quote.discountCents ? html`<tr><td>Voucher ${quote.voucherCode}</td><td>−${formatAud(quote.discountCents)}</td></tr>` : ''}
        ${quote.creditCents ? html`<tr><td>Account credit</td><td>−${formatAud(quote.creditCents)}</td></tr>` : ''}
        <tr class="price-total"><td>Total</td><td>${formatAud(quote.amountCents)} AUD</td></tr>
      </tbody>
    </table>
  `;
}

function planChoice(quote, paymentChoice, now) {
  if (!quote.planOption || quote.amountCents <= 0) return '';
  const { n, interval } = quote.planOption;
  const schedule = instalmentSchedule(quote.amountCents, n, interval, now);
  const cadence = interval === 'fortnight' ? 'fortnightly' : 'weekly';
  const then = interval === 'fortnight' ? 'every fortnight' : 'each week';
  return html`
    <fieldset class="form-group plan-options">
      <legend>How would you like to pay?</legend>
      <label><input type="radio" name="payment" value="full" ${paymentChoice === 'plan' ? '' : 'checked'}>
        Pay ${formatAud(quote.amountCents)} in full today</label>
      <label><input type="radio" name="payment" value="plan" ${paymentChoice === 'plan' ? 'checked' : ''}>
        Pay in ${n} ${cadence} instalments — ${formatAud(schedule.firstCents)} today, then ${formatAud(schedule.eachCents)} ${then}</label>
      <details class="plan-schedule">
        <summary>See the instalment dates</summary>
        <ol>${joinHtml(schedule.payments.map((p) => html`<li>${formatSydney(p.dueAt, 'date')} — ${formatAud(p.amountCents)}</li>`))}</ol>
        <p class="muted">Instalments are taken automatically from the card you pay with today. You can update your card from your account.</p>
      </details>
    </fieldset>
  `;
}

// GET /book/checkout?kind=term|casual|trial&term=…&session=…[&child=…][&voucher=…]
export async function handleCheckout(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const params = readCheckoutParams((k) => url.searchParams.get(k), (k) => url.searchParams.getAll(k));
  if (!params) return redirect('/book', 303);

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
    return pageResponse('Add your child', body, { user, pixel: true });
  }

  let child = params.childId ? children.find((c) => c.id === params.childId) || null : null;
  if (!child && children.length === 1) child = children[0];
  if (!child) {
    const options = children.map((c) => html`
      <li><a class="button-link" href="/book/checkout?${checkoutQuery(params, { childId: c.id })}">${c.name}</a></li>
    `);
    const body = html`
      <h1>Who is coming along?</h1>
      <ul class="child-chooser">${joinHtml(options)}</ul>
      <p><a href="/account/children/new?next=${encodeURIComponent(`/book/checkout?${checkoutQuery(params)}`)}">Add another child</a></p>
    `;
    return pageResponse('Choose a child', body, { user, pixel: true });
  }
  params.childId = child.id;

  const now = nowIso();
  const prepared = await prepareBooking(env, {
    userId: user.userId, childId: child.id, kind: params.kind, termId: params.termId,
    sessionIds: params.sessionIds, voucherCode: params.voucherCode, now,
  });
  if (!prepared.ok) return cannotBookPage(user, prepared, { child, termId: params.termId });
  const { quote, term, sessions } = prepared;

  const title = `${KIND_LABELS[quote.kind]}${term ? ` — ${term.name}` : ''}`;
  const sessionItems = sessions.map((s) => html`<li class="checkout-session"><span>${s.class_name} — ${sessionLine(s)}</span></li>`);
  const consent = child.photo_consent ? 'yes' : 'no';
  const voucherMessage = quote.voucherError ? VOUCHER_ERRORS[quote.voucherError] || 'That voucher cannot be used.' : '';

  const body = html`
    <h1>Checkout</h1>
    <section class="checkout-summary" data-pixel-page="checkout">
      <h2>${title} for ${child.name}</h2>
      ${term ? html`<p class="class-meta">${term.class_name} · ${term.venue}</p>` : ''}
      ${prepared.warnings.includes('child_already_holds_some_weeks')
        ? html`<p class="form-notice" role="status">${child.name} already has a place in some of these weeks — those are left out and the price follows.</p>`
        : ''}
      <ul class="checkout-sessions">${joinHtml(sessionItems)}</ul>
      ${priceBreakdown(quote)}
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

      ${planChoice(quote, params.paymentChoice, now)}

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

      <h2>Terms &amp; Conditions</h2>
      <div class="waiver-text" tabindex="0">
        ${waiverHtml}
        <p class="waiver-version">Waiver version ${env.WAIVER_VERSION}</p>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="waiver" value="accepted" required> I have read and accept the Terms &amp; Conditions and Cancellation Policy above</label>
      </div>

      <button type="submit">${quote.amountCents > 0 ? 'Continue to payment' : 'Confirm booking'}</button>
    </form>
  `;
  return pageResponse('Checkout', body, { user, pixel: true });
}

// POST /book/checkout — create the pending booking and hand off to payment.
export async function handleCheckoutPost(req, env, _params, ctx) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const params = readCheckoutParams((k) => form.get(k), (k) => form.getAll(k));
  if (!params) throw badRequest('That booking request was not valid.');

  // Ownership check: a child id belonging to another account is treated
  // exactly like a nonexistent one (no booking, no disclosure).
  const child = params.childId ? await env.DB.prepare(
    `SELECT id, name FROM children WHERE id = ?1 AND user_id = ?2 AND archived_at IS NULL`,
  ).bind(params.childId, user.userId).first() : null;
  if (!child) throw notFound();

  // Waiver acceptance and an explicit consent answer are required BEFORE any
  // payment session is created (booking-flow spec).
  const photoConsent = String(form.get('photo_consent') || '');
  if (form.get('waiver') !== 'accepted' || !isYesNo(photoConsent)) {
    throw badRequest('Please accept the waiver and answer the photo consent question before continuing to payment.');
  }
  const medical = cleanText(form.get('medical'), MEDICAL_NOTES_MAX);

  // Security: pending bookings hold seats — limit how many one account can
  // start (resource-exhaustion abuse, API4/CWE-400).
  if (!(await allowRate(env, `checkout:user:${user.userId}`, 8, 900))) {
    throw tooMany('You have started quite a few bookings in a short time — please give it a few minutes and try again.');
  }

  const prepared = await prepareBooking(env, {
    userId: user.userId, childId: child.id, kind: params.kind, termId: params.termId,
    sessionIds: params.sessionIds, voucherCode: params.voucherCode, paymentChoice: params.paymentChoice,
  });
  if (!prepared.ok) return cannotBookPage(user, prepared, { child, termId: params.termId });
  const { quote, term } = prepared;
  if (quote.voucherError) {
    const body = html`
      <h1>Voucher not applied</h1>
      <p class="lede">${VOUCHER_ERRORS[quote.voucherError] || 'That voucher cannot be used.'} Nothing has been booked —
        please go back, remove the code or try another, and continue.</p>
      <p><a href="/book/checkout?${checkoutQuery(params, { voucherCode: '' })}" class="button-link">Back to checkout</a></p>
    `;
    return pageResponse('Voucher not applied', body, { user, status: 400, pixel: true });
  }

  const created = await createPendingBooking(env, {
    userId: user.userId, childId: child.id, kind: params.kind, termId: term ? term.id : null,
    sessionIds: quote.sessionIds, quote, waiverVersion: env.WAIVER_VERSION,
    photoConsent: photoConsent === 'yes', medicalNotes: medical,
  });
  if (created.error) return cannotBookPage(user, created, { child, termId: params.termId });

  // Nothing to pay (credit or voucher covers it): confirm straight away.
  if (created.amountCents === 0) {
    const result = await confirmBooking(env, created.id, { provider: 'free' });
    if (result.ok && result.newlyConfirmed) {
      const send = notifyBookingConfirmed(env, created.id).catch((err) => logError('confirmation_email_failed', err, {}));
      if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
    }
    return redirect(`/book/confirm?booking=${created.id}`, 303);
  }

  const driver = getPaymentsDriver(env);
  let checkout;
  try {
    checkout = await driver.createCheckout({
      bookingId: created.id,
      amountCents: created.amountCents,
      description: `Mini & Co. — ${KIND_LABELS[params.kind]}${term ? `, ${term.name} (${term.class_name})` : ''} for ${child.name}`,
      customerEmail: user.email,
      customerId: user.stripeCustomerId,
      mode: quote.plan ? 'subscription' : 'payment',
      plan: quote.plan ? {
        n: quote.plan.n, eachCents: quote.plan.eachCents, firstCents: quote.plan.firstCents, interval: quote.plan.interval,
      } : null,
    });
  } catch (err) {
    logError('checkout_creation_failed', err, { booking_id: created.id.slice(0, 8) });
    await expireBooking(env, created.id); // release the held seats
    throw badRequest('We could not start the payment — no money has been taken. Please try again in a moment.');
  }

  await attachPaymentRef(env, created.id, driver.name, checkout.checkoutRef);
  return redirect(checkout.url, 303);
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

function paymentSummary(booking) {
  if (booking.kind === 'complimentary') return html`<p>Complimentary — nothing to pay.</p>`;
  if (booking.payment_method === 'plan') {
    return html`
      <p><strong>Paid so far: ${formatAud(booking.paid_cents)} of ${formatAud(booking.amount_cents + booking.credit_cents)} AUD</strong></p>
      <p>Your remaining instalments are taken automatically${booking.plan_next_charge_at ? html` — the next one on ${formatSydney(booking.plan_next_charge_at, 'date')}` : ''}.</p>
    `;
  }
  if (booking.amount_cents === 0) return html`<p><strong>Nothing to pay</strong>${booking.credit_cents ? ' — covered by your account credit' : ''}.</p>`;
  return html`<p><strong>Paid: ${formatAud(booking.amount_cents)} AUD</strong></p>`;
}

// GET /book/confirm?booking=… — confirmation page; reflects pending payment
// and flips to paid once the webhook lands (the page polls its own status).
export async function handleConfirmPage(req, env, _params, ctx) {
  const user = await requireAuthOrRedirect(req, env);
  const bookingId = String(new URL(req.url).searchParams.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();

  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  const status = effectiveStatus(booking);
  const sessionItems = booking.sessions.filter((s) => s.status === 'booked').map((s) => html`
    <li>${s.class_name} — ${sessionLine(s)} <span class="session-venue">(${s.venue})</span></li>
  `);
  const title = `${KIND_LABELS[booking.kind] || 'Booking'}${booking.term_name ? ` — ${booking.term_name}` : ''}`;

  let body;
  let extraHead = '';
  if (status === 'confirmed') {
    // D12: the Purchase event renders at most once per booking — only the
    // request that sets purchase_tracked_at gets the data attributes (and
    // sends the server-side copy with this visitor's user agent and IP).
    const track = !booking.purchase_tracked_at && booking.amount_cents > 0
      && await markPurchaseTracked(env, booking.id);
    if (track && !booking.capi_sent) {
      const report = reportPurchase(env, req, booking, user).catch((err) => logError('capi_report_failed', err, {}));
      if (ctx && ctx.waitUntil) ctx.waitUntil(report); else await report;
    }
    body = html`
      <div class="confirm-panel confirm-paid"
        ${track ? html`data-pixel-purchase data-booking-id="${booking.id}" data-amount="${(booking.amount_cents / 100).toFixed(2)}" data-currency="AUD"` : ''}>
        <h1>You're booked in! 🎉</h1>
        <p class="lede">${title} for ${booking.child_name} — we can't wait to see you.</p>
        <ul class="confirm-sessions">${joinHtml(sessionItems)}</ul>
        ${paymentSummary(booking)}
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
  } else if (booking.needs_attention === 'paid_no_seat') {
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>Thank you — we've received your payment</h1>
        <p class="lede">Unfortunately the last place was taken while your payment was being processed. Camila has been
          told and will be in touch shortly to arrange another class or a refund. You don't need to do anything.</p>
      </div>
    `;
  } else if (status === 'cancelled') {
    body = html`
      <div class="confirm-panel confirm-lapsed">
        <h1>This booking has been cancelled</h1>
        <p class="lede">If you have any questions, email <a href="mailto:miniandco.classes@gmail.com">miniandco.classes@gmail.com</a>.</p>
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
  return pageResponse('Booking confirmation', body, { user, extraHead, pixel: true });
}

// The parent backed out of the hosted checkout. Expire the provider's session
// FIRST so the still-open Stripe tab can no longer take a payment, then
// release (or, for a pay-later hold, keep) the seats.
// Returns 'released' | 'kept' | 'paid' | 'held'.
async function backOutOfCheckout(env, booking) {
  if (!booking.payment_ref) {
    return (await abandonCheckout(env, booking.id, null)) === 'detached' ? 'kept' : 'released';
  }
  const driver = getPaymentsDriver(env);
  try {
    await driver.expireCheckout(booking.payment_ref);
  } catch (err) {
    // Not open any more: either completed (the payment is on its way) or
    // already expired. Ask the provider which.
    let info = null;
    try {
      info = await driver.retrieveCheckout(booking.payment_ref);
    } catch (retrieveErr) {
      logError('checkout_retrieve_failed', retrieveErr, { booking_id: booking.id.slice(0, 8) });
    }
    if (info && info.status === 'complete') return 'paid';
    if (!info || info.status !== 'expired') {
      logError('checkout_expire_failed', err, { booking_id: booking.id.slice(0, 8) });
      return 'held';
    }
  }
  const outcome = await abandonCheckout(env, booking.id, booking.payment_ref);
  logEvent('booking_backed_out_of_checkout', { booking_id: booking.id.slice(0, 8), outcome });
  return outcome === 'detached' ? 'kept' : 'released';
}

// GET /book/cancelled?booking=… — parent backed out of the hosted checkout.
export async function handleCancelledPage(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const bookingId = String(new URL(req.url).searchParams.get('booking') || '');

  let outcome = 'released';
  let booking = null;
  if (isValidId(bookingId)) {
    booking = await getOwnedBooking(env, bookingId, user.userId);
    if (booking && booking.status === 'confirmed') return redirect(`/book/confirm?booking=${booking.id}`, 303);
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
      <p class="lede">No money was taken. Your place is still held${booking && booking.expires_at ? html` until ${formatSydney(booking.expires_at)}` : ''} — you can pay from your account.</p>
      <p><a href="/account" class="button-link">Go to my account</a></p>
    `,
    held: html`
      <h1>Payment not finished</h1>
      <p class="lede">We couldn't close the payment page just now. If you didn't pay, your place will be released automatically within half an hour.</p>
      <p><a href="/account" class="button-link">Go to my account</a></p>
    `,
  }[outcome];
  return pageResponse('Payment cancelled', body, { user, pixel: true });
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
  route('GET', '/book/confirm', handleConfirmPage);
  route('GET', '/book/cancelled', handleCancelledPage);
  route('GET', '/api/bookings/:id/status', handleBookingStatus);
}
