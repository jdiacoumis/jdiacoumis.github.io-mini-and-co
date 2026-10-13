// Development-only pages: a fake hosted checkout (with instalment-plan
// simulations), a stand-in billing portal, and a mailbox for the console
// email driver — so every payment journey is testable offline.
//
// Security: fail-closed — every handler 404s unless ENVIRONMENT is exactly
// 'development' (same response as a route that does not exist), and every
// simulated payment is a synthetic Stripe-shaped event run through the SAME
// claim → process → mark path as the real webhook (handleVerifiedEvent; only
// the signature check is skipped), so dev cannot diverge from production.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound, HttpError } from '../lib/http.js';
import { isValidId, normaliseEmail, isValidEmail } from '../lib/validate.js';
import { getOwnedBooking, effectiveStatus, formatAud } from '../lib/domain.js';
import { ledgerTotals } from '../lib/ledger.js';
import { instalmentSchedule } from '../lib/pricing.js';
import { handleVerifiedEvent } from './webhooks.js';
import { uuid, nowIso } from '../lib/db.js';
import { logEvent } from '../lib/log.js';

function assertDevEnvironment(env) {
  if (env.ENVIRONMENT !== 'development') throw notFound();
}

const compactId = () => uuid().replace(/-/g, '');
const unixNow = () => Math.floor(Date.now() / 1000);

function mockSubscriptionId(bookingId) {
  return `sub_mock_${bookingId.replace(/-/g, '')}`;
}

function event(type, object) {
  return { id: `evt_mock_${compactId()}`, type, created: unixNow(), data: { object } };
}

function invoice(booking, { amount, billingReason = 'subscription_cycle' }) {
  return {
    id: `in_mock_${compactId()}`,
    amount_paid: amount,
    amount_due: amount,
    billing_reason: billingReason,
    status_transitions: { paid_at: unixNow() },
    parent: {
      subscription_details: {
        subscription: booking.stripe_subscription_id || mockSubscriptionId(booking.id),
        metadata: { booking_id: booking.id },
      },
    },
  };
}

async function runEvents(env, events) {
  for (const evt of events) {
    const { outcome } = await handleVerifiedEvent(env, evt);
    if (outcome === 'failed') throw new HttpError(500, 'The simulated payment event failed — see the server log.');
  }
}

// GET /dev/mock-checkout?booking=…[&ref=…] — stand-in for Stripe's hosted
// page; for a confirmed instalment plan it also offers plan simulations.
export async function handleMockCheckout(req, env) {
  assertDevEnvironment(env);
  const user = await requireAuthOrRedirect(req, env);
  const url = new URL(req.url);
  const bookingId = String(url.searchParams.get('booking') || '');
  const ref = String(url.searchParams.get('ref') || '');
  if (!isValidId(bookingId)) throw notFound();
  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  const isPlan = booking.payment_method === 'plan';
  const open = effectiveStatus(booking) === 'pending' && ref && booking.payment_ref === ref;
  let schedule = null;
  if (isPlan) schedule = instalmentSchedule(booking.amount_cents, booking.plan_instalments, booking.plan_interval || 'week', nowIso());

  let controls;
  if (open) {
    controls = html`
      <p><strong>${isPlan
        ? `First instalment today: ${formatAud(schedule.firstCents)}, then ${booking.plan_instalments - 1} × ${formatAud(schedule.eachCents)}`
        : `Total: ${formatAud(booking.amount_cents)} AUD`}</strong> for ${booking.child_name}</p>
      <form method="post" action="/dev/mock-checkout" class="booking-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="booking" value="${booking.id}">
        <input type="hidden" name="ref" value="${ref}">
        <button type="submit" name="outcome" value="pay">${isPlan ? 'Pay first instalment' : 'Pay now'}</button>
        <button type="submit" name="outcome" value="cancel" class="button-secondary">Cancel</button>
      </form>
    `;
  } else if (isPlan && booking.status === 'confirmed') {
    const totals = await ledgerTotals(env, booking.id);
    controls = html`
      <p>Instalments paid: ${totals.instalments_paid} of ${booking.plan_instalments} · received ${formatAud(totals.money_in_cents)}
        · status ${booking.payment_status}</p>
      <form method="post" action="/dev/mock-checkout" class="booking-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="booking" value="${booking.id}">
        <button type="submit" name="outcome" value="instalment_paid">Simulate next instalment paid</button>
        <button type="submit" name="outcome" value="instalment_failed" class="button-secondary">Simulate instalment failed</button>
        <button type="submit" name="outcome" value="plan_ended" class="button-secondary">Simulate plan ended</button>
      </form>
    `;
  } else {
    controls = html`<p>This checkout is no longer open — no payment can be taken here.</p>`;
  }

  const body = html`
    <div class="confirm-panel">
      <h1>Mock checkout (dev only)</h1>
      <p class="lede">This stands in for Stripe's hosted payment page during local development.</p>
      ${controls}
      <p><a href="/book/confirm?booking=${booking.id}">Booking confirmation page</a></p>
    </div>
  `;
  return pageResponse('Mock checkout', body, { user });
}

// POST /dev/mock-checkout — synthesise the Stripe events for the chosen
// outcome and run them through the shared webhook processing path.
export async function handleMockCheckoutPost(req, env) {
  assertDevEnvironment(env);
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const bookingId = String(form.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();
  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();
  const ref = String(form.get('ref') || '');
  const outcome = String(form.get('outcome') || '');
  const back = `/dev/mock-checkout?booking=${booking.id}`;

  if (outcome === 'cancel') return redirect(`/book/cancelled?booking=${booking.id}`, 303);

  if (outcome === 'pay') {
    // Like Stripe: only the live checkout can take a payment.
    if (effectiveStatus(booking) !== 'pending' || !ref || booking.payment_ref !== ref) {
      throw new HttpError(409, 'This checkout is no longer open — no payment was taken.');
    }
    logEvent('mock_payment_simulated', { booking_id: booking.id.slice(0, 8) });
    if (booking.payment_method === 'plan') {
      const schedule = instalmentSchedule(booking.amount_cents, booking.plan_instalments, booking.plan_interval || 'week', nowIso());
      const subscription = mockSubscriptionId(booking.id);
      await runEvents(env, [
        event('checkout.session.completed', {
          id: ref, mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: booking.id,
          metadata: { booking_id: booking.id }, subscription, customer: null, amount_total: schedule.firstCents,
        }),
        event('invoice.paid', invoice({ ...booking, stripe_subscription_id: subscription }, {
          amount: schedule.firstCents, billingReason: 'subscription_create',
        })),
      ]);
    } else {
      await runEvents(env, [event('checkout.session.completed', {
        id: ref, mode: 'payment', status: 'complete', payment_status: 'paid', client_reference_id: booking.id,
        metadata: { booking_id: booking.id }, payment_intent: `pi_mock_${compactId()}`, customer: null,
        amount_total: booking.amount_cents,
      })]);
    }
    return redirect(`/book/confirm?booking=${booking.id}`, 303);
  }

  if (!['instalment_paid', 'instalment_failed', 'plan_ended'].includes(outcome)) throw notFound();
  if (booking.payment_method !== 'plan' || !booking.stripe_subscription_id) {
    throw new HttpError(409, 'That booking has no instalment plan.');
  }
  const schedule = instalmentSchedule(booking.amount_cents, booking.plan_instalments, booking.plan_interval || 'week', nowIso());
  const subscriptionDeleted = event('customer.subscription.deleted', {
    id: booking.stripe_subscription_id, status: 'canceled', metadata: { booking_id: booking.id },
  });

  if (outcome === 'instalment_paid') {
    const { instalments_paid: paid } = await ledgerTotals(env, booking.id);
    if (paid < booking.plan_instalments) {
      const events = [event('invoice.paid', invoice(booking, { amount: schedule.eachCents }))];
      // Stripe cancels the subscription after the last instalment.
      if (paid + 1 >= booking.plan_instalments) events.push(subscriptionDeleted);
      await runEvents(env, events);
    }
  } else if (outcome === 'instalment_failed') {
    await runEvents(env, [event('invoice.payment_failed', {
      ...invoice(booking, { amount: 0 }), amount_due: schedule.eachCents, attempt_count: 1,
    })]);
  } else {
    await runEvents(env, [subscriptionDeleted]);
  }
  return redirect(back, 303);
}

// GET /dev/mock-portal — stand-in for Stripe's billing portal ("Update card").
export async function handleMockPortal(req, env) {
  assertDevEnvironment(env);
  const user = await requireAuthOrRedirect(req, env);
  const body = html`
    <div class="confirm-panel">
      <h1>Mock billing portal (dev only)</h1>
      <p class="lede">In production this is Stripe's hosted page where a family updates the card used for instalments.</p>
      <p><a href="/account" class="button-link">Back to my account</a></p>
    </div>
  `;
  return pageResponse('Mock billing portal', body, { user });
}

// Render an email body as escaped text with http(s) URLs turned into
// clickable links — so the magic-link journey is one click in local dev.
function linkifyBody(text) {
  const parts = [];
  const urlPattern = /https?:\/\/[^\s<>"]+/g;
  let last = 0;
  for (const match of String(text || '').matchAll(urlPattern)) {
    parts.push(html`${text.slice(last, match.index)}`);
    parts.push(html`<a href="${match[0]}">${match[0]}</a>`);
    last = match.index + match[0].length;
  }
  parts.push(html`${String(text || '').slice(last)}`);
  return joinHtml(parts);
}

// GET /dev/mailbox[?to=address] — the console email driver's outbox, newest
// first, optionally for one recipient.
export async function handleDevMailbox(req, env) {
  assertDevEnvironment(env);
  const to = normaliseEmail(new URL(req.url).searchParams.get('to'));
  const filter = isValidEmail(to) ? to : null;

  const emails = (await env.DB.prepare(
    `SELECT id, to_email, subject, body_text, reply_to, created_at FROM dev_emails
     WHERE ?1 IS NULL OR to_email = ?1
     ORDER BY id DESC LIMIT 20`,
  ).bind(filter).all()).results || [];

  const items = emails.map((e) => html`
    <article class="class-card">
      <h2>${e.subject}</h2>
      <p class="class-meta">To ${e.to_email}${e.reply_to ? html` · Reply-To ${e.reply_to}` : ''} · ${e.created_at}</p>
      <pre class="mail-body">${linkifyBody(e.body_text)}</pre>
    </article>
  `);

  const body = html`
    <h1>Dev mailbox</h1>
    <p class="lede">Messages "sent" by the console email driver, newest first${filter ? html` — to ${filter}` : ''}.</p>
    ${items.length ? joinHtml(items) : html`<p>No emails yet.</p>`}
  `;
  return pageResponse('Dev mailbox', body);
}

export function registerRoutes(route) {
  route('GET', '/dev/mock-checkout', handleMockCheckout);
  route('POST', '/dev/mock-checkout', handleMockCheckoutPost);
  route('GET', '/dev/mock-portal', handleMockPortal);
  route('GET', '/dev/mailbox', handleDevMailbox);
}
