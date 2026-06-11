// Payments driver: Stripe Checkout (production) or mock (local dev).
// The mock driver refuses to load in production (fail-closed).

import { logEvent, logError } from './log.js';
import { uuid } from './db.js';

async function stripeDriver(env) {
  return {
    async createCheckout(bookingId, amountCents, childName, sessionId) {
      const params = new URLSearchParams({
        'payment_method_types[]': 'card',
        'mode': 'payment',
        'success_url': `${env.PUBLIC_BASE_URL}/booking/confirm?session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${env.PUBLIC_BASE_URL}/book/checkout?cancelled=1`,
        'line_items[0][price_data][currency]': 'aud',
        'line_items[0][price_data][unit_amount]': String(amountCents),
        'line_items[0][price_data][product_data][name]': `Mini & Co. — ${childName}`,
        'line_items[0][quantity]': '1',
        'client_reference_id': bookingId,
        'expires_at': String(Math.floor(Date.now() / 1000) + 30 * 60), // 30 min
      });

      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });

      if (!response.ok) {
        throw new Error(`Stripe error: ${response.statusText}`);
      }

      const session = await response.json();
      logEvent('checkout_created', {
        booking_id: bookingId.slice(0, 8),
        amount_cents: amountCents,
        provider: 'stripe',
        session_id: session.id.slice(0, 8),
      });

      return { url: session.url, sessionId: session.id };
    },

    async verifyWebhook(signature, body) {
      const { hmacSha256Hex, timingSafeEqual } = await import('./crypto.js');
      const [timestamp, ...parts] = signature.split(',').map((p) => p.split('=')[1]);
      const signed = `${timestamp}.${body}`;
      const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, signed);
      const received = parts[0];

      if (!timingSafeEqual(expected, received)) {
        throw new Error('Webhook signature mismatch');
      }

      const now = Math.floor(Date.now() / 1000);
      const ts = parseInt(timestamp, 10);
      if (Math.abs(now - ts) > 300) { // 5 min tolerance
        throw new Error('Webhook timestamp too old');
      }

      return JSON.parse(body);
    },
  };
}

async function mockDriver(env) {
  if (env.ENVIRONMENT === 'production') {
    throw new Error('Mock payments driver cannot load in production');
  }

  return {
    async createCheckout(bookingId, amountCents, childName, sessionId) {
      const sessionId = uuid();
      logEvent('checkout_created', {
        booking_id: bookingId.slice(0, 8),
        amount_cents: amountCents,
        provider: 'mock',
        session_id: sessionId.slice(0, 8),
      });

      return { url: `/booking/mock-checkout?session_id=${sessionId}&booking_id=${bookingId}`, sessionId };
    },

    async verifyWebhook(signature, body) {
      // Mock always accepts the payload as-is (for testing).
      return JSON.parse(body);
    },

    async completeCheckout(env, bookingId, sessionId) {
      // Mock success: called from the mock checkout page.
      return { success: true };
    },
  };
}

export async function getPaymentsDriver(env) {
  if (env.PAYMENTS_DRIVER === 'stripe') {
    return stripeDriver(env);
  } else if (env.PAYMENTS_DRIVER === 'mock') {
    return mockDriver(env);
  } else {
    throw new Error(`Unknown PAYMENTS_DRIVER: ${env.PAYMENTS_DRIVER}`);
  }
}

export const DEFAULT_STRIPE_WEBHOOK_DELAY_MS = 500; // webhook may lag by this much
