// Meta Pixel bootstrap for the first-party booking pages.
//
// Served from our own origin so the booking pages need no inline scripts
// (CSP: script-src 'self' https://connect.facebook.net). Fires the funnel:
//   PageView          — every booking page
//   ViewContent       — class list ([data-pixel-page="class-list"])
//   InitiateCheckout  — checkout step ([data-pixel-page="checkout"])
//   Purchase          — paid confirmation page only ([data-pixel-purchase]),
//                       with eventID = booking id so refreshes and the
//                       server-side Conversions API copy dedupe to one
//                       conversion.
(function (f, b, e, v, n, t, s) {
  'use strict';

  var PIXEL_ID = '1991468878409217';

  // Standard Meta pixel loader (moved out of inline <script> for CSP).
  if (f.fbq) return;
  n = f.fbq = function () {
    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
  };
  if (!f._fbq) f._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = '2.0';
  n.queue = [];
  t = b.createElement(e);
  t.async = true;
  t.src = v;
  s = b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t, s);

  fbq('init', PIXEL_ID);
  fbq('track', 'PageView');

  function onReady() {
    if (b.querySelector('[data-pixel-page="class-list"]')) {
      fbq('track', 'ViewContent', { content_name: 'Class list' });
    }

    if (b.querySelector('[data-pixel-page="checkout"]')) {
      fbq('track', 'InitiateCheckout');
    }

    var purchase = b.querySelector('[data-pixel-purchase]');
    if (purchase) {
      var bookingId = purchase.getAttribute('data-booking-id') || '';
      var amount = parseFloat(purchase.getAttribute('data-amount') || '0');
      var currency = purchase.getAttribute('data-currency') || 'AUD';
      if (bookingId && amount > 0) {
        // eventID = booking id: Meta deduplicates page refreshes and the
        // webhook's Conversions API event into a single conversion.
        fbq('track', 'Purchase', { value: amount, currency: currency }, { eventID: bookingId });
      }
    }
  }

  if (b.readyState === 'loading') {
    b.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
