// Development-only pages: a fake hosted checkout and a mailbox for the
// console email driver, so the whole journey is testable offline.
//
// Security: fail-closed — every handler 404s when ENVIRONMENT is production
// (same response as a route that does not exist), and the mock "payment"
// path goes through the exact same processCheckoutEvent code as the real
// webhook, so it cannot diverge from production behaviour.

import { html, pageResponse, csrfField, joinHtml } from '../lib/html.js';
import { requireAuthOrRedirect, requireCsrf, parseForm } from '../lib/middleware.js';
import { redirect, notFound } from '../lib/http.js';
import { isValidId } from '../lib/validate.js';
import { getOwnedBooking, formatAud } from '../lib/domain.js';
import { processCheckoutEvent } from './webhooks.js';
import { uuid } from '../lib/db.js';
import { logEvent } from '../lib/log.js';

function assertDevEnvironment(env) {
  if (env.ENVIRONMENT === 'production') throw notFound();
}

// GET /dev/mock-checkout?booking=… — stand-in for Stripe's hosted page.
export async function handleMockCheckout(req, env) {
  assertDevEnvironment(env);
  const user = await requireAuthOrRedirect(req, env);
  const bookingId = String(new URL(req.url).searchParams.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();

  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  const body = html`
    <div class="confirm-panel">
      <h1>Mock checkout (dev only)</h1>
      <p class="lede">This stands in for Stripe's hosted payment page during local development.</p>
      <p><strong>Booking total: ${formatAud(booking.amount_cents)} AUD</strong> for ${booking.child_name}</p>
      <form method="post" action="/dev/mock-checkout" class="booking-form">
        ${csrfField(user.csrfToken)}
        <input type="hidden" name="booking" value="${booking.id}">
        <button type="submit" name="outcome" value="success">Simulate successful payment</button>
        <button type="submit" name="outcome" value="cancel" class="button-secondary">Simulate cancel</button>
      </form>
    </div>
  `;
  return pageResponse('Mock checkout', body, { user });
}

// POST /dev/mock-checkout — synthesise the corresponding checkout event and
// run it through the shared webhook processing path.
export async function handleMockCheckoutPost(req, env) {
  assertDevEnvironment(env);
  const user = await requireAuthOrRedirect(req, env);
  const form = await parseForm(req);
  requireCsrf(req, user, form);

  const bookingId = String(form.get('booking') || '');
  if (!isValidId(bookingId)) throw notFound();
  const booking = await getOwnedBooking(env, bookingId, user.userId);
  if (!booking) throw notFound();

  const outcome = form.get('outcome');
  if (outcome === 'cancel') {
    return redirect(`/book/cancelled?booking=${booking.id}`, 303);
  }

  logEvent('mock_payment_simulated', { booking_id: booking.id.slice(0, 8) });
  await processCheckoutEvent(env, {
    id: `evt_mock_${uuid()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_mock_${uuid()}`,
        client_reference_id: booking.id,
        payment_intent: `pi_mock_${uuid()}`,
        amount_total: booking.amount_cents,
      },
    },
  });

  return redirect(`/book/confirm?booking=${booking.id}`, 303);
}

// GET /dev/mailbox — the console email driver's outbox, with the most recent
// messages first. Bodies render as plain text (escaped); links are visible
// to copy rather than rendered live HTML.
export async function handleDevMailbox(req, env) {
  assertDevEnvironment(env);

  const emails = (await env.DB.prepare(
    `SELECT id, to_email, subject, body_text, created_at FROM dev_emails
     ORDER BY id DESC LIMIT 20`,
  ).all()).results || [];

  const items = emails.map((e) => html`
    <article class="class-card">
      <h2>${e.subject}</h2>
      <p class="class-meta">To ${e.to_email} · ${e.created_at}</p>
      <pre class="mail-body">${e.body_text}</pre>
    </article>
  `);

  const body = html`
    <h1>Dev mailbox</h1>
    <p class="lede">Messages "sent" by the console email driver, newest first.</p>
    ${items.length ? joinHtml(items) : html`<p>No emails yet.</p>`}
  `;
  return pageResponse('Dev mailbox', body);
}
