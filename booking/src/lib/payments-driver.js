// Payments driver: Stripe Checkout (production) or mock (local dev).
// Card data never touches this system — Stripe Checkout is fully hosted.
// The mock driver refuses to load in production (fail-closed).

import { hmacSha256Hex, timingSafeEqual } from './crypto.js';
import { logEvent } from './log.js';
import { uuid } from './db.js';

const WEBHOOK_TOLERANCE_SECS = 300; // 5 minutes

function stripeDriver(env) {
  return {
    name: 'stripe',

    // Create a hosted Checkout Session for a pending booking. The booking id
    // travels as client_reference_id so the webhook can reconcile payment →
    // booking without trusting anything client-side.
    async createCheckout({ bookingId, amountCents, description }) {
      const params = new URLSearchParams({
        mode: 'payment',
        success_url: `${env.PUBLIC_BASE_URL}/book/confirm?booking=${bookingId}`,
        cancel_url: `${env.PUBLIC_BASE_URL}/book/cancelled?booking=${bookingId}`,
        'payment_method_types[]': 'card',
        'line_items[0][price_data][currency]': 'aud',
        'line_items[0][price_data][unit_amount]': String(amountCents),
        'line_items[0][price_data][product_data][name]': description,
        'line_items[0][quantity]': '1',
        client_reference_id: bookingId,
        expires_at: String(Math.floor(Date.now() / 1000) + 30 * 60),
      });

      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });

      if (!response.ok) {
        // Security: Stripe's error body can include request details — log the
        // status only, never echo it to the user.
        throw new Error(`Stripe checkout creation failed (HTTP ${response.status})`);
      }

      const session = await response.json();
      logEvent('checkout_created', {
        booking_id: bookingId.slice(0, 8),
        amount_cents: amountCents,
        provider: 'stripe',
      });
      return { url: session.url, checkoutRef: session.id };
    },

    // Verify a Stripe webhook: HMAC-SHA256 over `${timestamp}.${payload}`
    // with the endpoint secret, constant-time compare, 5-minute timestamp
    // tolerance (replay window). Returns the parsed event or throws.
    async verifyWebhook(signatureHeader, body) {
      const parts = String(signatureHeader || '').split(',');
      let timestamp = null;
      const candidates = [];
      for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') timestamp = value;
        if (key === 'v1') candidates.push(value);
      }
      if (!timestamp || candidates.length === 0) {
        throw new Error('Webhook signature header malformed');
      }

      const ts = Number.parseInt(timestamp, 10);
      if (!Number.isInteger(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > WEBHOOK_TOLERANCE_SECS) {
        throw new Error('Webhook timestamp outside tolerance');
      }

      const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${body}`);
      // Constant-time comparison against every v1 candidate (Stripe sends
      // multiple during secret rolls); no early exit on partial match.
      let valid = false;
      for (const candidate of candidates) {
        if (timingSafeEqual(expected, candidate)) valid = true;
      }
      if (!valid) throw new Error('Webhook signature mismatch');

      return JSON.parse(body);
    },
  };
}

function mockDriver(env) {
  // Security: fail-closed — the mock driver must be impossible to reach in
  // production, where it would confirm bookings without payment.
  if (env.ENVIRONMENT === 'production') {
    throw new Error('Mock payments driver cannot load in production');
  }

  return {
    name: 'mock',

    async createCheckout({ bookingId, amountCents, description }) {
      const checkoutRef = `mock_${uuid()}`;
      logEvent('checkout_created', {
        booking_id: bookingId.slice(0, 8),
        amount_cents: amountCents,
        provider: 'mock',
      });
      return { url: `/dev/mock-checkout?booking=${bookingId}`, checkoutRef };
    },

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
