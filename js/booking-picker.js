// Casual-class picker on the class list (/book): as dates are ticked, show how
// many classes and the running total, and keep "Book selected classes"
// disabled until at least one is ticked. Progressive enhancement only —
// without JavaScript the form still works and the checkout page shows the
// total. Same-origin, no network requests, CSP-clean (no inline script).
(function () {
  'use strict';

  function formatAud(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function setUp(form) {
    var boxes = form.querySelectorAll('input[type="checkbox"][name="session"]');
    var total = form.querySelector('[data-casual-total]');
    var submit = form.querySelector('[data-casual-submit]');

    function update() {
      var count = 0;
      var cents = 0;
      for (var i = 0; i < boxes.length; i += 1) {
        if (boxes[i].checked && !boxes[i].disabled) {
          count += 1;
          cents += parseInt(boxes[i].getAttribute('data-price-cents'), 10) || 0;
        }
      }
      if (total) {
        total.textContent = count
          ? count + (count === 1 ? ' class' : ' classes') + ' selected · ' + formatAud(cents)
          : '';
      }
      if (submit) submit.disabled = count === 0;
    }

    for (var i = 0; i < boxes.length; i += 1) boxes[i].addEventListener('change', update);
    update();
  }

  var forms = document.querySelectorAll('form[data-casual-picker]');
  for (var i = 0; i < forms.length; i += 1) setUp(forms[i]);
})();
