// Booking confirmation polling: while a booking is awaiting its payment
// confirmation, poll the same-origin status API and reload when it changes.
// Progressive enhancement only — without JS a <noscript> meta refresh covers
// the same behaviour. No external requests, CSP-clean.
(function () {
  'use strict';

  var panel = document.querySelector('[data-poll-booking]');
  if (!panel) return;

  var bookingId = panel.getAttribute('data-poll-booking');
  // The id is server-issued, but validate shape anyway before using it in a URL.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(bookingId)) return;

  var attempts = 0;
  var maxAttempts = 100; // ~5 minutes at 3s

  function poll() {
    attempts += 1;
    if (attempts > maxAttempts) return;

    fetch('/api/bookings/' + bookingId + '/status', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.status && data.status !== 'pending') {
          window.location.reload();
        } else {
          window.setTimeout(poll, 3000);
        }
      })
      .catch(function () {
        window.setTimeout(poll, 5000);
      });
  }

  window.setTimeout(poll, 3000);
})();
