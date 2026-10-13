// Parent account area (Phase 2A): the dashboard (bookings with their payment
// status, Pay now for places held for the family, Update card for
// instalment plans, account credit with expiry, waitlist places, children,
// details), the Pay now review → hosted checkout for pay-later holds, the
// Stripe Billing Portal hand-off, and profile editing.
//
// Security: everything is scoped to the signed-in account — another family's
// booking id gets the same 404 as a missing one; every POST checks the CSRF
// token; a held booking can only ever have one live hosted checkout (any
// earlier one is expired at the provider first); logs carry id prefixes only.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, badRequest, tooMany } from '../lib/http.js';
import { isValidId, isValidName, isValidAuPhone, normalisePhone, cleanText, cleanName } from '../lib/validate.js';
import { formatSydney, formatAge } from '../lib/time.js';
import { nowIso, isoPlusSeconds } from '../lib/db.js';
import {
  listUserBookings, effectiveStatus, getOwnedBooking, loadTerm, abandonCheckout, formatAud,
  PENDING_BOOKING_EXPIRY_SECS,
} from '../lib/domain.js';
import { availableCredits } from '../lib/ledger.js';
import { planFor, instalmentSchedule } from '../lib/pricing.js';
import { getPaymentsDriver, isMissingResource } from '../lib/payments-driver.js';
import { allowRate } from '../lib/ratelimit.js';
import { logEvent, logError } from '../lib/log.js';
import {
  paymentStatusView, describeDates, isPayLaterHold, waitlistPositionText, listChildren,
  instalmentCounts, listWaitlistEntries, plural, isInstalmentPlan, PAYMENT_RECEIVED_FLAGS,
} from '../lib/parent-flow.js';
import {
  bookingTitle, paymentDescription, planChoice, consentFields, readConsent, createHostedCheckout,
  closeProviderCheckout, confirmWithoutPayment, updateCardForm, sessionsList, CONTACT_EMAIL, forgetStripeCustomer,
} from './booking.js';

// How many times Pay now may stretch one booking's hold (see handlePayNowPost).
export const MAX_HOLD_EXTENSIONS = 2;

const STATUS_LABELS = {
  pending: 'Awaiting payment',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  expired: 'Not completed',
};

const NOTICES = {
  'waitlist-left': "You've left the waitlist.",
  'offer-declined': 'Thanks for letting us know — the place has been passed on to the next family.',
  'payment-cancelled': 'That payment was cancelled — no money was taken.',
  'no-card': "We don't have a card on file for you yet — it's saved when you first pay by instalments.",
  'details-saved': 'Your details are saved.',
};

function page(body) {
  return html`<div class="parent-flow">${body}</div>`;
}

// --- Dashboard ---------------------------------------------------------------

// Bookings that matter now: live ones, and any where money arrived.
function isCurrent(booking, now) {
  const status = effectiveStatus(booking, now);
  return status === 'confirmed' || status === 'pending'
    || PAYMENT_RECEIVED_FLAGS.includes(booking.needs_attention) || booking.paid_cents > 0;
}

function bookingCard(b, { now, instalmentsPaid, user }) {
  const status = effectiveStatus(b, now);
  const view = paymentStatusView(b, { instalmentsPaid, now });
  const starts = String(b.session_starts || '').split('|').filter(Boolean).sort();
  const when = describeDates(starts);
  const next = status === 'confirmed' ? starts.find((s) => s > now) : null;
  const runningPlan = status === 'confirmed' && isInstalmentPlan(b)
    && (b.payment_status === 'plan_active' || b.payment_status === 'plan_overdue');
  const actions = [];
  if (view.key === 'pay_now') actions.push(html`<a class="button-link" href="/account/bookings/${b.id}/pay">Pay now</a>`);
  if (runningPlan && user.stripeCustomerId) {
    actions.push(updateCardForm(user, { secondary: b.payment_status !== 'plan_overdue' }));
  } else if (view.key === 'plan_overdue') {
    actions.push(html`<span class="muted">Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> to update your card.</span>`);
  }
  if (view.key === 'paying') {
    actions.push(html`
      <form method="post" action="/book/checkout/release" class="inline-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="booking" value="${b.id}">
        <input type="hidden" name="from" value="account">
        <button type="submit" class="button-secondary">Didn't finish paying? Cancel it</button>
      </form>`);
  }
  actions.push(html`<a class="booking-card-link" href="/book/confirm?booking=${b.id}">Details</a>`);
  return html`
    <article class="booking-card ${view.tone === 'alert' ? 'booking-card-alert' : ''}">
      <div class="booking-card-head">
        <h3>${bookingTitle(b.kind, b.term_name)}</h3>
        <span class="status status-${status}">${STATUS_LABELS[status] || status}</span>
      </div>
      <p class="booking-card-meta">${b.child_name}${b.class_name ? html` · ${b.class_name}` : ''}</p>
      ${when ? html`<p class="booking-card-when">${when}</p>` : ''}
      ${next ? html`<p class="booking-card-when">Next class: ${formatSydney(next)}</p>` : ''}
      <p class="pay-status pay-status-${view.tone}"><strong>${view.label}</strong>${view.detail ? html` — ${view.detail}` : ''}</p>
      <div class="booking-card-actions">${joinHtml(actions)}</div>
    </article>
  `;
}

function attentionItems(bookings, { now, user }) {
  const items = [];
  for (const b of bookings) {
    if (isPayLaterHold(b, now)) {
      items.push(html`<li>${b.child_name}'s place in ${bookingTitle(b.kind, b.term_name)} is held until ${formatSydney(b.expires_at)}.
        <a href="/account/bookings/${b.id}/pay">Pay now</a></li>`);
    } else if (effectiveStatus(b, now) === 'confirmed' && b.payment_status === 'plan_overdue') {
      items.push(html`<li>An instalment for ${b.child_name}'s ${bookingTitle(b.kind, b.term_name)} didn't go through — your place is kept.
        ${user.stripeCustomerId ? 'Please update your card below.' : html`Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we'll help.`}</li>`);
    }
  }
  return items;
}

function creditSection(credits, children) {
  if (!credits.length) return '';
  const names = new Map(children.map((c) => [c.id, c.name]));
  const total = credits.reduce((sum, c) => sum + c.remaining_cents, 0);
  const items = credits.map((c) => html`
    <li><strong>${formatAud(c.remaining_cents)}</strong>${c.remaining_cents !== c.amount_cents ? html` <span class="muted">(of ${formatAud(c.amount_cents)})</span>` : ''}
      — ${c.reason || 'Account credit'}${c.child_id && names.has(c.child_id) ? html` · for ${names.get(c.child_id)}` : ''}
      · <span class="muted">${c.expires_at ? html`use by ${formatSydney(c.expires_at, 'date')}` : 'no expiry date'}</span></li>
  `);
  return html`
    <section class="account-section" id="credit">
      <h2>Account credit</h2>
      <p class="account-credit">Balance: <strong>${formatAud(total)}</strong> — taken off your next booking automatically.</p>
      <ul class="credit-list">${joinHtml(items)}</ul>
    </section>
  `;
}

function waitlistSection(entries, user) {
  if (!entries.length) return '';
  const items = entries.map((w) => html`
    <li class="waitlist-entry">
      <p><strong>${w.child_name}</strong> — ${w.term_name} · ${w.class_name}</p>
      ${w.status === 'offered'
        ? html`<p class="pay-status pay-status-due"><strong>A place is being held for ${w.child_name}</strong>${w.offer_expires_at ? html` until ${formatSydney(w.offer_expires_at)}` : ''}.</p>
            ${w.offer_booking_id ? html`<p><a class="button-link" href="/account/bookings/${w.offer_booking_id}/pay">Pay now</a></p>` : ''}`
        : html`<p>On the waitlist — ${waitlistPositionText(w.position)} · joined ${formatSydney(w.joined_at, 'date')}</p>`}
      <form method="post" action="/book/waitlist/leave" class="inline-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="entry" value="${w.id}">
        <input type="hidden" name="from" value="account">
        <button type="submit" class="button-secondary button-small">${w.status === 'offered' ? 'No thanks — release the place' : 'Leave the waitlist'}</button>
      </form>
    </li>
  `);
  return html`
    <section class="account-section" id="waitlist">
      <h2>Waitlists</h2>
      <p class="muted">Camila offers places in the order families joined. We'll email you if one opens up.</p>
      <ul class="waitlist-list">${joinHtml(items)}</ul>
    </section>
  `;
}

// GET /account — the parent dashboard.
export async function handleAccountDashboard(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const now = nowIso();
  const notice = NOTICES[new URL(req.url).searchParams.get('ok')] || '';

  const [children, bookings, credits, counts, entries] = await Promise.all([
    listChildren(env, user.userId),
    listUserBookings(env, user.userId),
    availableCredits(env, user.userId, null, now),
    instalmentCounts(env, user.userId),
    listWaitlistEntries(env, user.userId),
  ]);

  const current = bookings.filter((b) => isCurrent(b, now));
  const earlier = bookings.filter((b) => !isCurrent(b, now));
  const card = (b) => bookingCard(b, { now, instalmentsPaid: counts.get(b.id) || 0, user });
  const attention = attentionItems(current, { now, user });
  const hasRunningPlan = current.some((b) => isInstalmentPlan(b)
    && (b.payment_status === 'plan_active' || b.payment_status === 'plan_overdue'));

  const childItems = children.map((c) => html`
    <li>${c.name} (${formatAge(c.dob)}) — <a href="/account/children/${c.id}/edit">edit</a></li>
  `);

  const body = html`
    <div class="page-head">
      <h1>My account</h1>
      <a href="/book" class="button-link">Book a class</a>
    </div>
    <p class="account-signed-in">Signed in as ${user.email}</p>
    ${notice ? html`<p class="form-notice" role="status">${notice}</p>` : ''}
    ${attention.length ? html`<div class="pf-alert" role="status"><ul>${joinHtml(attention)}</ul></div>` : ''}

    <section class="account-section" id="bookings">
      <h2>My bookings</h2>
      ${current.length
        ? html`<div class="booking-cards">${joinHtml(current.map(card))}</div>`
        : html`<p>No bookings yet — <a href="/book">grab a spot in the next class</a>.</p>`}
      ${earlier.length ? html`
        <details class="earlier-bookings">
          <summary>Cancelled and unfinished bookings (${earlier.length})</summary>
          <div class="booking-cards">${joinHtml(earlier.map(card))}</div>
        </details>` : ''}
      ${hasRunningPlan && user.stripeCustomerId ? html`
        <div class="update-card">
          <p>Paying by instalments? You can change the card your instalments come from at any time.</p>
          ${updateCardForm(user, { label: 'Update my card', secondary: true })}
        </div>` : ''}
    </section>

    ${creditSection(credits, children)}
    ${waitlistSection(entries, user)}

    <section class="account-section" id="children">
      <h2>My children</h2>
      ${children.length
        ? html`<ul class="account-children">${joinHtml(childItems)}</ul>`
        : html`<p>No children added yet — <a href="/account/children/new">add your little one</a> to start booking.</p>`}
      <p><a href="/account/children">Manage children</a> · <a href="/account/children/new">Add a child</a></p>
    </section>

    <section class="account-section" id="details">
      <h2>My details</h2>
      <p>${user.name ? html`${user.name}` : html`<em>No name on file yet</em>`}${user.phone ? html` · ${user.phone}` : ''}
        · <a href="/account/profile">Update</a></p>
    </section>
  `;
  return pageResponse('My account', page(body), { user });
}

// --- Pay now (pay-later holds) -----------------------------------------------

async function loadOwnedBooking(env, user, bookingId) {
  if (!isValidId(bookingId)) throw notFound();
  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();
  return booking;
}

function holdEndedPage(user, booking) {
  const body = html`
    <h1>This place is no longer held</h1>
    <p class="lede">The hold on ${booking.child_name}'s place ended ${booking.expires_at ? html`on ${formatSydney(booking.expires_at)}` : ''}, so it has been
      released. If you'd still like to come, have a look at the classes that are open — or email
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we'll see what we can do.</p>
    <p><a href="/book" class="button-link">See classes</a></p>
  `;
  return pageResponse('Place no longer held', page(body), { user, status: 409 });
}

function tryAgainPage(user, message) {
  const body = html`
    <h1>Please try again in a moment</h1>
    <p class="lede">${message}</p>
    <p><a href="/account" class="button-link">Back to my account</a></p>
  `;
  return pageResponse('Please try again', page(body), { user, status: 503 });
}

// The instalment plan a held term booking may use (only before any money has
// arrived): the term's plan, capped by the weeks still to come.
function payNowPlanOption(booking, term, now) {
  if (booking.kind !== 'term' || !term || booking.paid_cents > 0 || booking.amount_cents <= 0) return null;
  const weeksLeft = booking.sessions.filter((s) => s.status === 'booked' && s.session_status === 'scheduled' && s.starts_at > now).length;
  return planFor(term, weeksLeft, booking.amount_cents);
}

function heldBreakdown(booking) {
  const weeks = booking.sessions.filter((s) => s.status === 'booked').length;
  const label = booking.kind === 'term' ? `Term — ${plural(weeks, 'week')}`
    : booking.kind === 'trial' ? 'Trial class' : plural(weeks, 'class', 'classes');
  const outstanding = Math.max(0, booking.amount_cents - booking.paid_cents);
  return html`
    <table class="price-breakdown">
      <tbody>
        <tr><td>${label}</td><td>${formatAud(booking.list_amount_cents)}</td></tr>
        ${booking.discount_cents ? html`<tr><td>${booking.voucher_code ? `Voucher ${booking.voucher_code}` : 'Discount'}</td><td>−${formatAud(booking.discount_cents)}</td></tr>` : ''}
        ${booking.credit_cents ? html`<tr><td>Account credit applied</td><td>−${formatAud(booking.credit_cents)}</td></tr>` : ''}
        ${booking.paid_cents > 0 ? html`<tr><td>Already paid</td><td>−${formatAud(booking.paid_cents)}</td></tr>` : ''}
        <tr class="price-total"><td>To pay</td><td>${formatAud(outstanding)} AUD</td></tr>
      </tbody>
    </table>
  `;
}

// GET /account/bookings/:id/pay — review a place held for the family (an
// owner booking, a waitlist offer or a re-enrolment), choose in full or by
// instalments, accept the waiver if not yet accepted for it, then pay.
export async function handlePayNow(req, env, params) {
  const user = await requireAuthOrRedirect(req, env);
  const booking = await loadOwnedBooking(env, user, params.id);
  const now = nowIso();
  const status = effectiveStatus(booking, now);
  if (status === 'confirmed') return redirect(`/book/confirm?booking=${booking.id}`, 303);
  if (status !== 'pending') return holdEndedPage(user, booking);
  // A checkout already under way (35-minute hold): its confirmation page
  // follows the payment.
  if (!isPayLaterHold(booking, now)) return redirect(`/book/confirm?booking=${booking.id}`, 303);

  const child = await env.DB.prepare(
    `SELECT id, name, medical_notes, photo_consent FROM children WHERE id = ?1 AND user_id = ?2`,
  ).bind(booking.child_id, user.userId).first();
  if (!child) throw notFound();
  const term = booking.term_id ? await loadTerm(env, booking.term_id) : null;
  const planOption = payNowPlanOption(booking, term, now);
  const outstanding = Math.max(0, booking.amount_cents - booking.paid_cents);

  const body = html`
    <h1>Pay for ${child.name}'s place</h1>
    <section class="checkout-summary">
      <h2>${bookingTitle(booking.kind, booking.term_name)} for ${child.name}</h2>
      ${sessionsList(booking.sessions.filter((s) => s.status === 'booked'))}
      ${heldBreakdown(booking)}
      <p class="form-notice" role="status">This place is held for ${child.name} until ${formatSydney(booking.expires_at)}.</p>
    </section>
    <form method="post" action="/account/bookings/${booking.id}/pay" class="booking-form">
      ${csrfField(user.csrfToken)}
      ${planChoice({
        amountCents: outstanding, planOption, paymentChoice: booking.payment_method === 'plan' ? 'plan' : 'full', now,
      })}
      ${booking.waiver_accepted_at ? '' : consentFields({ child, env })}
      <button type="submit">${outstanding > 0 ? 'Continue to payment' : 'Confirm booking'}</button>
    </form>
    <p><a href="/account">Back to my account</a></p>
  `;
  return pageResponse('Pay now', page(body), { user });
}

// POST /account/bookings/:id/pay — start the hosted checkout for the amount
// still owed on a held booking. Any earlier checkout for it is expired at the
// provider first (and if it turns out to have been paid, the parent is sent to
// the confirmation instead), so only one hosted page can ever take a payment.
export async function handlePayNowPost(req, env, params, ctx) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  let booking = await loadOwnedBooking(env, user, params.id);
  const now = nowIso();
  const status = effectiveStatus(booking, now);
  if (status === 'confirmed') return redirect(`/book/confirm?booking=${booking.id}`, 303);
  if (status !== 'pending') return holdEndedPage(user, booking);
  if (!isPayLaterHold(booking, now)) return redirect(`/book/confirm?booking=${booking.id}`, 303);

  if (!(await allowRate(env, `paynow:user:${user.userId}`, 8, 900))) {
    throw tooMany('You have started quite a few payments in a short time — please give it a few minutes and try again.');
  }

  // Waiver acceptance and an explicit consent answer before any payment
  // session (booking-flow spec) — owner-made bookings have none yet.
  if (!booking.waiver_accepted_at) {
    const consent = readConsent(form);
    if (!consent) {
      throw badRequest('Please accept the waiver and answer the photo consent question before continuing to payment.');
    }
    await env.DB.prepare(
      `UPDATE bookings SET waiver_version = ?3, waiver_accepted_at = ?4, photo_consent_snapshot = ?5,
              medical_notes_snapshot = ?6
       WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND waiver_accepted_at IS NULL`,
    ).bind(booking.id, user.userId, env.WAIVER_VERSION, now, consent.photoConsent ? 1 : 0, consent.medical).run();
  }

  const outstanding = Math.max(0, booking.amount_cents - booking.paid_cents);
  if (outstanding === 0) {
    await confirmWithoutPayment(env, booking.id, ctx);
    return redirect(`/book/confirm?booking=${booking.id}`, 303);
  }

  let plan = null;
  if (form.get('payment') === 'plan') {
    const term = booking.term_id ? await loadTerm(env, booking.term_id) : null;
    const option = payNowPlanOption(booking, term, now);
    if (!option) throw badRequest("Instalments aren't available for this booking — please go back and choose to pay in full.");
    const schedule = instalmentSchedule(outstanding, option.n, option.interval, now);
    plan = { ...option, eachCents: schedule.eachCents, firstCents: schedule.firstCents };
  }

  if (booking.payment_ref) {
    const closed = await closeProviderCheckout(env, booking);
    if (closed === 'complete') return redirect(`/book/confirm?booking=${booking.id}`, 303);
    if (closed === 'unknown') {
      return tryAgainPage(user, "We couldn't close the earlier payment page for this booking just now, so nothing has changed. Your place is still held.");
    }
    const outcome = await abandonCheckout(env, booking.id, booking.payment_ref);
    if (outcome !== 'detached') {
      booking = await loadOwnedBooking(env, user, booking.id);
      if (effectiveStatus(booking, nowIso()) !== 'pending') return holdEndedPage(user, booking);
    }
  }

  // The hosted checkout stays open for about half an hour. A live hold that
  // ends sooner is stretched to the usual checkout hold — and a waitlist
  // offer's deadline with it, so the offer-expiry job leaves it alone — so a
  // family part-way through paying never loses the place under them. At most
  // MAX_HOLD_EXTENSIONS times per booking (review, low: pressing Pay now over
  // and over kept a place held indefinitely); after that the hold ends when
  // it ends, and a payment arriving later is re-checked for a seat (D6).
  // Holds with longer to run keep their own expiry; a lapsed hold is never
  // revived.
  const minHold = isoPlusSeconds(PENDING_BOOKING_EXPIRY_SECS, Date.parse(now));
  if (booking.expires_at < minHold) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE bookings SET expires_at = ?3, hold_extensions = hold_extensions + 1
         WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > ?4 AND expires_at < ?3
           AND hold_extensions < ?5`,
      ).bind(booking.id, user.userId, minHold, now, MAX_HOLD_EXTENSIONS),
      env.DB.prepare(
        `UPDATE waitlist SET offer_expires_at = ?3
         WHERE offer_booking_id = ?1 AND user_id = ?2 AND status = 'offered' AND offer_expires_at > ?4 AND offer_expires_at < ?3
           AND EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND expires_at = ?3)`,
      ).bind(booking.id, user.userId, minHold, now),
    ]);
  }

  let url;
  try {
    url = await createHostedCheckout(env, {
      bookingId: booking.id,
      amountCents: outstanding,
      description: paymentDescription(booking.kind, {
        termName: booking.term_name, className: booking.class_name, childName: booking.child_name,
      }),
      user,
      plan,
      exclusive: true,
    });
  } catch (err) {
    logError('paynow_checkout_failed', err, { booking_id: booking.id.slice(0, 8) });
    return tryAgainPage(user, 'We could not start the payment — no money has been taken and your place is still held.');
  }
  if (!url) {
    return tryAgainPage(user, 'A payment for this booking was started in another window a moment ago — please finish it there, or try again shortly.');
  }
  logEvent('paynow_checkout_started', { booking_id: booking.id.slice(0, 8), plan: Boolean(plan) });
  return redirect(url, 303);
}

// --- Update card (Stripe Billing Portal) -------------------------------------

// POST /account/billing-portal — hand the family to the hosted billing portal
// to change the card their instalments come from.
export async function handleBillingPortal(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);
  if (!user.stripeCustomerId) return redirect('/account?ok=no-card', 303);
  if (!(await allowRate(env, `portal:user:${user.userId}`, 10, 900))) {
    throw tooMany('Please wait a few minutes and try again.');
  }
  try {
    const url = await getPaymentsDriver(env).createBillingPortalSession(user.stripeCustomerId, `${env.PUBLIC_BASE_URL}/account`);
    logEvent('billing_portal_opened', { user_id: user.userId.slice(0, 8) });
    return redirect(url, 303);
  } catch (err) {
    if (isMissingResource(err)) {
      // Not a customer in this Stripe account (any more): forget it.
      await forgetStripeCustomer(env, user.userId, user.stripeCustomerId);
      return redirect('/account?ok=no-card', 303);
    }
    logError('billing_portal_failed', err, { user_id: user.userId.slice(0, 8) });
    return tryAgainPage(user, "We couldn't open the card page just now. Your instalments and your place are not affected.");
  }
}

// --- Profile -------------------------------------------------------------------

function profileForm(user, values, error = '') {
  return html`
    <h1>My details</h1>
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="/account/profile" class="booking-form">
      ${csrfField(user.csrfToken)}
      <div class="form-group">
        <label for="name">Your name</label>
        <input type="text" id="name" name="name" value="${values.name}" required maxlength="100" autocomplete="name">
      </div>
      <div class="form-group">
        <label for="phone">Mobile number (so we can reach you about class changes)</label>
        <input type="tel" id="phone" name="phone" value="${values.phone}" autocomplete="tel">
      </div>
      <button type="submit">Save details</button>
    </form>
    <p><a href="/account">Back to my account</a></p>
  `;
}

// GET /account/profile — edit name and phone.
export async function handleProfile(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  return pageResponse('My details', page(profileForm(user, { name: user.name, phone: user.phone })), { user });
}

// POST /account/profile — save name and phone.
export async function handleProfilePost(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const values = {
    name: cleanName(form.get('name'), 100),
    phone: normalisePhone(form.get('phone')),
  };

  if (!isValidName(values.name)) {
    return pageResponse('My details', page(profileForm(user, values, 'Please enter your name (up to 100 characters).')), { user, status: 400 });
  }
  if (values.phone && !isValidAuPhone(values.phone)) {
    return pageResponse('My details', page(profileForm(user, values, 'That phone number does not look right — please check it (e.g. 0412 345 678).')), { user, status: 400 });
  }

  await env.DB.prepare(
    `UPDATE users SET name = ?1, phone = ?2 WHERE id = ?3`,
  ).bind(values.name, values.phone, user.userId).run();

  logEvent('profile_updated', { user_id: user.userId.slice(0, 8) });
  return redirect('/account?ok=details-saved', 303);
}

export function registerRoutes(route) {
  route('GET', '/account', handleAccountDashboard);
  route('GET', '/account/profile', handleProfile);
  route('POST', '/account/profile', handleProfilePost);
  route('GET', '/account/bookings/:id/pay', handlePayNow);
  route('POST', '/account/bookings/:id/pay', handlePayNowPost);
  route('POST', '/account/billing-portal', handleBillingPortal);
}
