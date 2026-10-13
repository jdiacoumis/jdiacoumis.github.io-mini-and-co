// Meta Conversions API: the server-side copy of the Purchase event, sent with
// the same event_id as the browser pixel (the booking id) so Meta counts one
// conversion. No-op unless META_CAPI_TOKEN is configured.
//
// D12: a website event must carry action_source, event_source_url and the
// visitor's client_user_agent / client_ip_address, so it is sent from the
// parent's own request for the confirmation page (routes/booking.js) — the
// Stripe webhook comes from Stripe's servers and knows neither. Identifiers
// are SHA-256 hashed after Meta's normalisation; nothing identifying is logged.

import { sha256Hex } from './crypto.js';
import { logEvent, logError } from './log.js';

// Pinned Graph API version: the newest at implementation time (v26.0,
// released 2026-07-29). Meta supports each version for at least two years.
export const GRAPH_API_VERSION = 'v26.0';

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Meta wants digits with the country code: Australian 04xx… → 614xx….
export function normalisePhoneForMeta(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `61${digits.slice(1)}`;
  return digits;
}

export async function purchaseEventPayload({
  bookingId, email, phone, amountCents, currency = 'AUD', eventSourceUrl, clientUserAgent,
  clientIpAddress, eventTime = Math.floor(Date.now() / 1000),
}) {
  const userData = {
    client_user_agent: String(clientUserAgent || ''),
  };
  if (clientIpAddress) userData.client_ip_address = String(clientIpAddress);
  const em = normaliseEmail(email);
  if (em) userData.em = [await sha256Hex(em)];
  const ph = normalisePhoneForMeta(phone);
  if (ph) userData.ph = [await sha256Hex(ph)];
  return {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: bookingId, // = the pixel's eventID: Meta deduplicates the pair
      action_source: 'website',
      event_source_url: eventSourceUrl,
      user_data: userData,
      custom_data: {
        value: Number((amountCents / 100).toFixed(2)),
        currency,
      },
    }],
  };
}

export async function sendPurchaseEvent(env, event) {
  if (!env.META_CAPI_TOKEN || !env.META_PIXEL_ID) return { sent: false, reason: 'not_configured' };
  try {
    const payload = await purchaseEventPayload(event);
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(env.META_PIXEL_ID)}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, access_token: env.META_CAPI_TOKEN }),
      },
    );
    if (!response.ok) throw new Error(`Meta Conversions API failed (HTTP ${response.status})`);
    logEvent('capi_purchase_sent', { booking_id: event.bookingId.slice(0, 8), amount_cents: event.amountCents });
    return { sent: true };
  } catch (err) {
    // A conversion report must never break the parent's page.
    logError('capi_purchase_failed', err, { booking_id: event.bookingId.slice(0, 8) });
    return { sent: false, error: 'send_failed' };
  }
}

// Record that the server-side Purchase went out (at most once per booking).
export async function markCapiSent(env, bookingId) {
  await env.DB.prepare(`UPDATE bookings SET capi_sent = 1 WHERE id = ?1`).bind(bookingId).run();
}
