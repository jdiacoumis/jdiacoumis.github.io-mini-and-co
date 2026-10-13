// Mini & Co. admin: long owner actions (holding places for returning
// families, sending a bulk email) run a step at a time so each request stays
// within Cloudflare's per-request limits. A page that has more to do shows a
// "Continue" form marked data-auto-continue; this submits it by itself, so the
// owner only watches. Without JavaScript she presses the button.
(function () {
  var form = document.querySelector('form[data-auto-continue]');
  if (!form) return;
  var note = form.querySelector('[data-auto-continue-note]');
  if (note) note.textContent = 'Working — this page carries on by itself…';
  window.setTimeout(function () { form.submit(); }, 300);
}());
