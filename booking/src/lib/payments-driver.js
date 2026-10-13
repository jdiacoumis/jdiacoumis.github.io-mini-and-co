// Payments driver (design D4): Stripe over REST (production) or a mock (local
// development). Card data never touches this system — Stripe Checkout and the
// Billing Portal are fully hosted. The mock driver refuses to load outside
// ENVIRONMENT=development (fail-closed).
//
// Surface (both drivers):
//   createCheckout({ bookingId, amountCents, description, customerEmail,
//                    customerId, mode: 'payment'|'subscription',
//                    plan: { eachCents, firstCents, n, interval },
//                    successUrl, cancelUrl })          → { url, checkoutRef }
//   expireCheckout(ref)                                → { status }
//   retrieveCheckout(ref)  → { status, paymentStatus, paymentIntent,
//                              subscriptionId, customerId, amountTotal, mode, bookingId }
//   retrieveSubscription(id) → { id, status, customerId, startDate,
//                                billingCycleAnchor, cancelAt, currentPeriodEnd, metadata }
//   setSubscriptionCancelAt(id, unixSeconds)           → { id, cancelAt }
//   cancelSubscription(id)                             → { id, status }
//   listInvoices(subscriptionId, { limit })  → [{ id, status, amountPaid,
//                              amountDue, paidAt (unix), attemptCount,
//                              subscriptionId, bookingId, customerId }],
//                              newest first (Check with Stripe replays the
//                              paid ones when invoice.paid webhooks were lost)
//   invoicePaymentIntent(invoiceId)       → the payment intent that paid an
//                              invoice, or null (Stripe API 2025-03-31.basil
//                              removed invoice.payment_intent: Invoice Payments)
//   invoiceForPaymentIntent(paymentIntentId) → the invoice it paid, or null
//                              (charge.invoice was removed the same way)
//   listRefunds({ paymentIntent })     → [{ id, amount, status, created,
//                              paymentIntent, chargeId }], or null when the
//                              driver keeps no refunds (the mock)
//   createBillingPortalSession(customerId, returnUrl)  → url
//   verifyWebhook(signatureHeader, rawBody)            → event (or throws)
//
// Every Stripe request names STRIPE_API_VERSION (the Stripe-Version header):
// the code reads fields as they are in that version, whatever the account's
// default version is or becomes. The webhook endpoint must be created with
// the same version (DEPLOYMENT.md), since events are rendered in the
// endpoint's version, not the request's.

import { hmacSha256Hex, timingSafeEqual } from './crypto.js';
import { logEvent } from './log.js';
import { uuid, nowIso } from './db.js';

const STRIPE_API = 'https://api.stripe.com/v1';

// The API version this integration is written against: the last Basil
// release (2025-03-31.basil moved invoice payments to Invoice Payments and
// subscription periods to its items; later Basil versions are additive).
// Changing it is an upgrade: read Stripe's changelog, then re-run the
// test-mode checks in DEPLOYMENT.md and move the webhook endpoint too.
export const STRIPE_API_VERSION = '2025-08-27.basil';
const WEBHOOK_TOLERANCE_SECS = 300; // 5 minutes

// Stripe's minimum Checkout lifetime is 30 minutes; the booking's seat hold
// (PENDING_BOOKING_EXPIRY_SECS, 35 minutes) outlives it, so a payment can only
// land after the hold through a delayed webhook — which D6 handles.
export const CHECKOUT_EXPIRY_SECS = 31 * 60;

const INTERVAL_COUNT = { week: 1, fortnight: 2 };

// Stripe object ids are [A-Za-z0-9_]; never interpolate anything else into a URL path.
function stripeId(value, what) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_]{3,255}$/.test(id)) throw new Error(`Invalid Stripe ${what} id`);
  return id;
}

// A field that may be an id or an expanded object.
export function idOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

async function stripeRequest(env, method, path, params = null) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  const init = {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_API_VERSION },
  };
  if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = params.toString();
  }
  const response = await fetch(`${STRIPE_API}${path}`, init);
  if (!response.ok) {
    // Security: Stripe's error body can echo request details — keep only the
    // error code for the logs; callers show a generic message.
    let code = '';
    try {
      const body = await response.json();
      code = String(body?.error?.code || body?.error?.type || '').slice(0, 60);
    } catch { /* not JSON */ }
    const err = new Error(`Stripe ${method} ${path.split('?')[0].split('/').slice(0, 3).join('/')} failed (HTTP ${response.status}${code ? `, ${code}` : ''})`);
    err.status = response.status;
    err.code = code;
    throw err;
  }
  return response.json();
}

// A Stripe "No such customer / subscription / …" error: the id we hold is
// not (or no longer) in this Stripe account — e.g. test-mode ids after the
// switch to live mode.
export function isMissingResource(err) {
  return Boolean(err) && (err.code === 'resource_missing' || err.status === 404);
}

function normaliseRefund(refund) {
  return {
    id: typeof refund?.id === 'string' ? refund.id : null,
    amount: Number.isInteger(refund?.amount) ? refund.amount : 0,
    status: refund?.status || null,                 // pending | requires_action | succeeded | failed | canceled
    created: Number.isInteger(refund?.created) ? refund.created : null,
    paymentIntent: idOf(refund?.payment_intent),
    chargeId: idOf(refund?.charge),
  };
}

// The payment intent of a paid invoice from an Invoice Payment list (or an
// invoice's `payments` field when it was included): the default payment
// first, then any paid one.
export function paymentIntentFromInvoicePayments(list) {
  const payments = (Array.isArray(list) ? list : [])
    .filter((p) => p && p.payment && p.payment.type === 'payment_intent' && (!p.status || p.status === 'paid'));
  const chosen = payments.find((p) => p.is_default) || payments[0];
  return chosen ? idOf(chosen.payment.payment_intent) : null;
}

function normaliseCheckout(session) {
  return {
    status: session.status,                     // open | complete | expired
    paymentStatus: session.payment_status,      // paid | unpaid | no_payment_required
    paymentIntent: idOf(session.payment_intent),
    subscriptionId: idOf(session.subscription),
    customerId: idOf(session.customer),
    amountTotal: Number.isInteger(session.amount_total) ? session.amount_total : null,
    mode: session.mode,
    bookingId: session.client_reference_id || session.metadata?.booking_id || null,
  };
}

function normaliseSubscription(sub) {
  return {
    id: sub.id,
    status: sub.status,
    customerId: idOf(sub.customer),
    startDate: sub.start_date ?? null,
    billingCycleAnchor: sub.billing_cycle_anchor ?? null,
    cancelAt: sub.cancel_at ?? null,
    currentPeriodEnd: sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null,
    metadata: sub.metadata || {},
  };
}

// An invoice → the driver's shape. The subscription (and the booking id we
// put in its metadata) sit under `parent.subscription_details` in current API
// versions and at the top level in older ones.
function normaliseInvoice(invoice) {
  const details = invoice?.parent?.subscription_details || invoice?.subscription_details || null;
  let bookingId = details?.metadata?.booking_id || null;
  if (!bookingId) {
    for (const line of invoice?.lines?.data || []) {
      if (line?.metadata?.booking_id) { bookingId = line.metadata.booking_id; break; }
    }
  }
  const whole = (n) => (Number.isInteger(n) ? n : 0);
  return {
    id: typeof invoice?.id === 'string' ? invoice.id : null,
    status: invoice?.status || null,                 // draft | open | paid | uncollectible | void
    amountPaid: whole(invoice?.amount_paid),
    amountDue: whole(invoice?.amount_due),
    paidAt: Number.isInteger(invoice?.status_transitions?.paid_at) ? invoice.status_transitions.paid_at : null,
    attemptCount: whole(invoice?.attempt_count),
    subscriptionId: idOf(details?.subscription) || idOf(invoice?.subscription) || null,
    bookingId: typeof bookingId === 'string' ? bookingId : null,
    customerId: idOf(invoice?.customer),
  };
}

// Validate an instalment plan for subscription mode.
function checkPlan(plan) {
  if (!plan || !Number.isInteger(plan.n) || plan.n < 2) throw new Error('A plan needs at least two instalments');
  if (!Number.isInteger(plan.eachCents) || plan.eachCents <= 0) throw new Error('Instalments are positive cents');
  if (!Number.isInteger(plan.firstCents) || plan.firstCents < plan.eachCents) throw new Error('first ≥ each');
  if (!INTERVAL_COUNT[plan.interval]) throw new Error(`Unknown plan interval: ${plan.interval}`);
}

// Build the Checkout Session parameters (exported for unit tests).
export function checkoutParams(env, {
  bookingId, amountCents, description, customerEmail = null, customerId = null,
  mode = 'payment', plan = null, successUrl = null, cancelUrl = null, nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const params = new URLSearchParams();
  params.set('mode', mode);
  params.set('success_url', successUrl || `${env.PUBLIC_BASE_URL}/book/confirm?booking=${bookingId}`);
  params.set('cancel_url', cancelUrl || `${env.PUBLIC_BASE_URL}/book/cancelled?booking=${bookingId}`);
  // The booking id travels server-side → Stripe → webhook; nothing the
  // browser sends decides which booking a payment confirms.
  params.set('client_reference_id', bookingId);
  params.set('metadata[booking_id]', bookingId);
  params.set('payment_method_types[0]', 'card');
  params.set('expires_at', String(nowSeconds + CHECKOUT_EXPIRY_SECS));
  if (customerId) params.set('customer', customerId);
  else if (customerEmail) params.set('customer_email', customerEmail);

  const name = String(description || 'Mini & Co. Sensory Classes').slice(0, 250);
  if (mode === 'payment') {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amountCents must be positive');
    params.set('line_items[0][price_data][currency]', 'aud');
    params.set('line_items[0][price_data][unit_amount]', String(amountCents));
    params.set('line_items[0][price_data][product_data][name]', name);
    params.set('line_items[0][quantity]', '1');
    params.set('payment_intent_data[metadata][booking_id]', bookingId);
    // Reuse one Stripe customer per family (users.stripe_customer_id).
    if (!customerId) params.set('customer_creation', 'always');
  } else if (mode === 'subscription') {
    checkPlan(plan);
    params.set('line_items[0][price_data][currency]', 'aud');
    params.set('line_items[0][price_data][unit_amount]', String(plan.eachCents));
    params.set('line_items[0][price_data][recurring][interval]', 'week');
    params.set('line_items[0][price_data][recurring][interval_count]', String(INTERVAL_COUNT[plan.interval]));
    params.set('line_items[0][price_data][product_data][name]', name);
    params.set('line_items[0][quantity]', '1');
    // The remainder of an uneven split rides on the first invoice only.
    if (plan.firstCents > plan.eachCents) {
      params.set('line_items[1][price_data][currency]', 'aud');
      params.set('line_items[1][price_data][unit_amount]', String(plan.firstCents - plan.eachCents));
      params.set('line_items[1][price_data][product_data][name]', `${name.slice(0, 200)} — first instalment balance`);
      params.set('line_items[1][quantity]', '1');
    }
    params.set('subscription_data[metadata][booking_id]', bookingId);
    // The plan travels with the subscription too, so the webhook can always
    // give it its end date (cancel_at) — even if the booking's own copy of
    // the plan was cleared when an earlier checkout was abandoned.
    params.set('subscription_data[metadata][plan_instalments]', String(plan.n));
    params.set('subscription_data[metadata][plan_interval]', plan.interval);
    params.set('subscription_data[metadata][plan_instalment_cents]', String(plan.eachCents));
  } else {
    throw new Error(`Unknown checkout mode: ${mode}`);
  }
  return params;
}

function stripeDriver(env) {
  return {
    name: 'stripe',

    async createCheckout(options) {
      const session = await stripeRequest(env, 'POST', '/checkout/sessions', checkoutParams(env, options));
      logEvent('checkout_created', {
        booking_id: options.bookingId.slice(0, 8), mode: options.mode || 'payment', provider: 'stripe',
      });
      return { url: session.url, checkoutRef: session.id };
    },

    // After this, the hosted page can no longer take a payment. Throws if the
    // session is not open (e.g. it was already completed).
    async expireCheckout(ref) {
      const session = await stripeRequest(env, 'POST', `/checkout/sessions/${stripeId(ref, 'checkout')}/expire`);
      return { status: session.status };
    },

    async retrieveCheckout(ref) {
      return normaliseCheckout(await stripeRequest(env, 'GET', `/checkout/sessions/${stripeId(ref, 'checkout')}`));
    },

    async retrieveSubscription(id) {
      return normaliseSubscription(await stripeRequest(env, 'GET', `/subscriptions/${stripeId(id, 'subscription')}`));
    },

    async setSubscriptionCancelAt(id, unixSeconds) {
      const params = new URLSearchParams({
        cancel_at: String(Math.floor(unixSeconds)),
        proration_behavior: 'none',
      });
      const sub = await stripeRequest(env, 'POST', `/subscriptions/${stripeId(id, 'subscription')}`, params);
      return { id: sub.id, cancelAt: sub.cancel_at };
    },

    async cancelSubscription(id) {
      const sub = await stripeRequest(env, 'DELETE', `/subscriptions/${stripeId(id, 'subscription')}`);
      return { id: sub.id, status: sub.status };
    },

    // A plan has at most 20 instalments (terms.plan_instalments), so one page
    // of up to 100 invoices holds them all.
    async listInvoices(subscriptionId, { limit = 100 } = {}) {
      const query = new URLSearchParams({
        subscription: stripeId(subscriptionId, 'subscription'),
        limit: String(Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)))),
      });
      const list = await stripeRequest(env, 'GET', `/invoices?${query}`);
      return (Array.isArray(list?.data) ? list.data : []).map(normaliseInvoice).filter((i) => i.id);
    },

    async invoicePaymentIntent(invoiceId) {
      const query = new URLSearchParams({ invoice: stripeId(invoiceId, 'invoice'), limit: '10' });
      const list = await stripeRequest(env, 'GET', `/invoice_payments?${query}`);
      return paymentIntentFromInvoicePayments(list?.data);
    },

    async invoiceForPaymentIntent(paymentIntentId) {
      const query = new URLSearchParams({
        'payment[type]': 'payment_intent',
        'payment[payment_intent]': stripeId(paymentIntentId, 'payment intent'),
        limit: '1',
      });
      const list = await stripeRequest(env, 'GET', `/invoice_payments?${query}`);
      const first = Array.isArray(list?.data) ? list.data[0] : null;
      return first ? idOf(first.invoice) : null;
    },

    // A payment intent has at most a handful of refunds: one page holds them.
    async listRefunds({ paymentIntent }) {
      const query = new URLSearchParams({ payment_intent: stripeId(paymentIntent, 'payment intent'), limit: '100' });
      const list = await stripeRequest(env, 'GET', `/refunds?${query}`);
      return (Array.isArray(list?.data) ? list.data : []).map(normaliseRefund).filter((r) => r.id);
    },

    async createBillingPortalSession(customerId, returnUrl) {
      const params = new URLSearchParams({ customer: stripeId(customerId, 'customer'), return_url: returnUrl });
      const session = await stripeRequest(env, 'POST', '/billing_portal/sessions', params);
      return session.url;
    },

    // HMAC-SHA256 over `${timestamp}.${payload}` with the endpoint secret,
    // constant-time compare, 5-minute tolerance. Returns the event or throws.
    async verifyWebhook(signatureHeader, body) {
      // Security: never fall back to HMAC-ing with the string "undefined" — a
      // missing secret must reject every webhook.
      if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
      let timestamp = null;
      const candidates = [];
      for (const part of String(signatureHeader || '').split(',')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') timestamp = value;
        if (key === 'v1') candidates.push(value);
      }
      if (!timestamp || candidates.length === 0) throw new Error('Webhook signature header malformed');

      const ts = Number.parseInt(timestamp, 10);
      if (!Number.isInteger(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > WEBHOOK_TOLERANCE_SECS) {
        throw new Error('Webhook timestamp outside tolerance');
      }
      const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${body}`);
      // Constant-time against every v1 candidate (Stripe sends several during
      // a secret roll); no early exit.
      let valid = false;
      for (const candidate of candidates) {
        if (timingSafeEqual(expected, candidate)) valid = true;
      }
      if (!valid) throw new Error('Webhook signature mismatch');
      return JSON.parse(body);
    },
  };
}

// The mock keeps no state of its own: a mock checkout is "open" while a
// pending booking with that payment_ref still holds its seats, "complete" once
// the booking is confirmed — so it behaves like Stripe for the code paths
// that ask (cancel page, Check with Stripe). The dev page /dev/mock-checkout
// plays the hosted page and posts synthetic events through the same webhook
// processing as production (routes/dev.js); the instalments it "charges" are
// kept in the dev_mock_invoices outbox, which listInvoices() reads — so a
// lost invoice.paid webhook can be simulated and reconciled.
function mockDriver(env) {
  // Security: fail-closed — the mock confirms bookings without payment, so it
  // loads only when the environment is EXPLICITLY development.
  if (env.ENVIRONMENT !== 'development') throw new Error('Mock payments driver cannot load in production');

  const bookingByRef = (ref) => env.DB.prepare(
    `SELECT id, status, expires_at, payment_intent, stripe_subscription_id, amount_cents, payment_method,
            plan_instalments, plan_instalment_cents, plan_interval, paid_at
     FROM bookings WHERE payment_ref = ?1`,
  ).bind(ref).first();

  return {
    name: 'mock',

    async createCheckout({ bookingId, mode = 'payment', plan = null, amountCents }) {
      if (mode === 'subscription') checkPlan(plan);
      else if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amountCents must be positive');
      const checkoutRef = `cs_mock_${uuid().replace(/-/g, '')}`;
      logEvent('checkout_created', { booking_id: bookingId.slice(0, 8), mode, provider: 'mock' });
      return {
        url: `/dev/mock-checkout?booking=${encodeURIComponent(bookingId)}&ref=${checkoutRef}`,
        checkoutRef,
      };
    },

    async expireCheckout(ref) {
      const booking = await bookingByRef(ref);
      if (booking && booking.status === 'confirmed') {
        const err = new Error('Mock checkout is already complete');
        err.code = 'checkout_complete';
        throw err;
      }
      logEvent('mock_checkout_expired', { ref: String(ref).slice(0, 16) });
      return { status: 'expired' };
    },

    async retrieveCheckout(ref) {
      const booking = await bookingByRef(ref);
      if (!booking) throw new Error('No such mock checkout');
      const live = booking.status === 'pending' && booking.expires_at > nowIso();
      const complete = booking.status === 'confirmed' || Boolean(booking.paid_at);
      return {
        status: complete ? 'complete' : live ? 'open' : 'expired',
        paymentStatus: complete ? 'paid' : 'unpaid',
        paymentIntent: booking.payment_intent,
        subscriptionId: booking.stripe_subscription_id,
        customerId: null,
        amountTotal: booking.amount_cents,
        mode: booking.payment_method === 'plan' ? 'subscription' : 'payment',
        bookingId: booking.id,
      };
    },

    async retrieveSubscription(id) {
      const booking = await env.DB.prepare(
        `SELECT id, status, paid_at, created_at FROM bookings WHERE stripe_subscription_id = ?1`,
      ).bind(id).first();
      const anchor = Math.floor(Date.parse(booking?.paid_at || booking?.created_at || nowIso()) / 1000);
      return {
        id,
        status: booking && booking.status !== 'cancelled' ? 'active' : 'canceled',
        customerId: null,
        startDate: anchor,
        billingCycleAnchor: anchor,
        cancelAt: null,
        currentPeriodEnd: null,
        metadata: booking ? { booking_id: booking.id } : {},
      };
    },

    async setSubscriptionCancelAt(id, unixSeconds) {
      logEvent('mock_subscription_cancel_at', { subscription: String(id).slice(0, 16), cancel_at: unixSeconds });
      return { id, cancelAt: unixSeconds };
    },

    async cancelSubscription(id) {
      logEvent('mock_subscription_cancelled', { subscription: String(id).slice(0, 16) });
      return { id, status: 'canceled' };
    },

    async listInvoices(subscriptionId, { limit = 100 } = {}) {
      const rows = (await env.DB.prepare(
        `SELECT id, subscription_id, booking_id, status, amount_paid, amount_due, attempt_count, paid_at
         FROM dev_mock_invoices WHERE subscription_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2`,
      ).bind(String(subscriptionId), Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)))).all()).results || [];
      return rows.map((r) => ({
        id: r.id, status: r.status, amountPaid: r.amount_paid, amountDue: r.amount_due, paidAt: r.paid_at,
        attemptCount: r.attempt_count, subscriptionId: r.subscription_id, bookingId: r.booking_id, customerId: null,
      }));
    },

    // A mock instalment's payment intent is derived from its invoice id
    // (pi_mock_X ↔ in_mock_X), for the invoices dev_mock_invoices holds.
    async invoicePaymentIntent(invoiceId) {
      const row = await env.DB.prepare(`SELECT id FROM dev_mock_invoices WHERE id = ?1 AND status = 'paid'`)
        .bind(String(invoiceId)).first();
      return row && row.id.startsWith('in_mock_') ? `pi_mock_${row.id.slice('in_mock_'.length)}` : null;
    },

    async invoiceForPaymentIntent(paymentIntentId) {
      const pi = String(paymentIntentId || '');
      if (!pi.startsWith('pi_mock_')) return null;
      const row = await env.DB.prepare(`SELECT id FROM dev_mock_invoices WHERE id = ?1`)
        .bind(`in_mock_${pi.slice('pi_mock_'.length)}`).first();
      return row ? row.id : null;
    },

    // The mock keeps no refunds; callers fall back to what the event says.
    async listRefunds() {
      return null;
    },

    async createBillingPortalSession() {
      return '/dev/mock-portal';
    },

    // Development only: the mock endpoint trusts the body (no signature).
    async verifyWebhook(signatureHeader, body) {
      return JSON.parse(body);
    },
  };
}

export function getPaymentsDriver(env) {
  if (env.PAYMENTS_DRIVER === 'stripe') return stripeDriver(env);
  if (env.PAYMENTS_DRIVER === 'mock') return mockDriver(env);
  throw new Error(`Unknown PAYMENTS_DRIVER: ${env.PAYMENTS_DRIVER}`);
}
