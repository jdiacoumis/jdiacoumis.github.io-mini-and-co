// Meta Conversions API driver: send server-side Purchase events for deduplication.
// Only sends if META_CAPI_TOKEN is configured; otherwise is a no-op.

import { sha256Hex } from './crypto.js';
import { logEvent, logError } from './log.js';

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalisePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function hashString(value) {
  return sha256Hex(normaliseEmail(value));
}

async function hashPhone(value) {
  return sha256Hex(normalisePhone(value));
}

export async function sendPurchaseEvent(
  env,
  { bookingId, email, phone, amountCents, currency = 'AUD' },
) {
  if (!env.META_CAPI_TOKEN) {
    // No token configured; skip silently.
    return { sent: false, reason: 'no_token' };
  }

  try {
    const hashedEmail = await hashString(email);
    const hashedPhone = await hashPhone(phone);

    const payload = {
      data: [
        {
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: bookingId, // Unique per booking for deduplication
          event_source_url: `${env.PUBLIC_BASE_URL}/booking/confirm`,
          user_data: {
            em: hashedEmail,
            ph: hashedPhone,
          },
          custom_data: {
            value: (amountCents / 100).toFixed(2),
            currency,
          },
        },
      ],
      access_token: env.META_CAPI_TOKEN,
    };

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${env.META_PIXEL_ID}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Meta API error (${response.status}): ${error}`);
    }

    logEvent('capi_purchase_sent', {
      booking_id: bookingId.slice(0, 8),
      amount_cents: amountCents,
    });

    return { sent: true };
  } catch (err) {
    logError('capi_purchase_failed', err, { booking_id: bookingId.slice(0, 8) });
    // Don't re-throw; CAPI failures shouldn't break the booking confirmation flow.
    return { sent: false, error: err.message };
  }
}

export async function markCapiSent(env, bookingId) {
  // Update the booking to mark CAPI event as sent (idempotent).
  await env.DB.prepare(
    `UPDATE bookings SET capi_sent = 1 WHERE id = ?1`,
  ).bind(bookingId).run();
}
