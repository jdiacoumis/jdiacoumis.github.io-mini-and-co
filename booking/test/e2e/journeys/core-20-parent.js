// Parent journey on the term model: sign in → child → class list by term →
// term checkout (voucher, waiver, consent) → mock payment → confirmation
// (Purchase once) → ledger; trial once per child; backing out of checkout
// expires the provider session before releasing seats; a credit that covers
// the whole class confirms with no payment step.

export const title = 'Parent: term booking, trial, back-out, credit';

const EMAIL = 'e2e-parent@example.com';

export async function run(ctx) {
  const cookie = await ctx.signIn(EMAIL);
  const account = await ctx.fetch('/account', { cookie });
  ctx.check('signed in to /account', account.status === 200 && account.text.includes(EMAIL));
  ctx.check('account page leads with the booking CTA', /page-head[\s\S]{0,200}Book a class/.test(account.text));
  ctx.check('account page does not load the pixel', !account.text.includes('booking-pixel.js'));

  ctx.section('Child profile');
  const csrf = await ctx.csrfFor(cookie);
  const noConsent = await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: 'Edie', dob: '2025-11-20', medical: 'Dairy intolerance' },
  });
  ctx.check('child without consent choice rejected', noConsent.status === 400 && noConsent.text.includes('value="Edie"'));
  const added = await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: 'Edie', dob: '2025-11-20', medical: 'Dairy intolerance', photo_consent: 'yes' },
  });
  ctx.check('child created', added.status === 303);

  ctx.section('Class list');
  const list = await ctx.fetch('/book', { cookie });
  ctx.check('class list shows the open terms with the term price',
    list.text.includes('Dev Term') && list.text.includes('Whole term, 6 weeks — $168.00'));
  ctx.check('class list offers casual classes at the casual price', list.text.includes('$30.00 each'));
  ctx.check('class list offers a trial class', list.text.includes('Book a trial class'));
  ctx.check('class list has the ViewContent hook and loads the pixel',
    list.text.includes('data-pixel-page="class-list"') && list.text.includes('/js/booking-pixel.js'));
  ctx.check('the closed previous term is not listed', !list.text.includes('Previous Term'));

  ctx.section('Term checkout');
  const review = await ctx.fetch('/book/checkout?kind=term&term=term-dev-11', { cookie });
  const childId = ctx.field(review.text, 'child');
  ctx.check('checkout shows the waiver, the total and the instalment option',
    review.text.includes('Waiver version') && review.text.includes('$168.00 AUD') && review.text.includes('6 weekly instalments'),
    review.text.slice(0, 300));
  ctx.check('checkout has the InitiateCheckout hook', review.text.includes('data-pixel-page="checkout"'));

  const withVoucher = await ctx.fetch(`/book/checkout?kind=term&term=term-dev-11&child=${childId}&voucher=dev5`, { cookie });
  ctx.check('voucher DEV5 takes $5 off', withVoucher.text.includes('Voucher DEV5') && withVoucher.text.includes('$163.00 AUD'));
  const badVoucher = await ctx.fetch(`/book/checkout?kind=term&term=term-dev-11&child=${childId}&voucher=NOPE`, { cookie });
  ctx.check('an unknown voucher is explained', badVoucher.text.includes('find that voucher code'));

  const base = { csrf, kind: 'term', term: 'term-dev-11', child: childId, medical: 'Dairy intolerance' };
  const noWaiver = await ctx.fetch('/book/checkout', { method: 'POST', cookie, body: { ...base, photo_consent: 'yes' } });
  ctx.check('payment blocked without waiver acceptance', noWaiver.status === 400);

  const pay = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie, body: { ...base, photo_consent: 'yes', waiver: 'accepted', payment: 'full' },
  });
  ctx.check('checkout redirects to the hosted payment page', pay.status === 303 && pay.location.includes('/dev/mock-checkout'), pay.location);
  const bookingId = /booking=([a-f0-9-]+)/.exec(pay.location)?.[1];
  const ref = /ref=([A-Za-z0-9_]+)/.exec(pay.location)?.[1];

  const pending = await ctx.fetch(`/book/confirm?booking=${bookingId}`, { cookie });
  ctx.check('confirmation page waits for the payment', pending.text.includes('data-poll-booking'));

  const mock = await ctx.fetch(pay.location, { cookie });
  ctx.check('mock checkout offers to pay $168.00', mock.text.includes('$168.00'));
  const paid = await ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie, body: { csrf: ctx.field(mock.text, 'csrf'), booking: bookingId, ref, outcome: 'pay' },
  });
  ctx.check('mock payment succeeds', paid.status === 303 && paid.location.includes('/book/confirm'));

  const confirm = await ctx.fetch(`/book/confirm?booking=${bookingId}`, { cookie });
  ctx.check('confirmation shows the paid booking', confirm.text.includes("You're booked in") && confirm.text.includes('Paid: $168.00 AUD'));
  ctx.check('Purchase pixel data renders on the first view',
    confirm.text.includes('data-pixel-purchase') && confirm.text.includes(`data-booking-id="${bookingId}"`));
  const again = await ctx.fetch(`/book/confirm?booking=${bookingId}`, { cookie });
  ctx.check('Purchase does not render a second time', again.status === 200 && !again.text.includes('data-pixel-purchase'));

  const status = await ctx.fetch(`/api/bookings/${bookingId}/status`, { cookie });
  ctx.check('status API reports confirmed', status.text.includes('"confirmed"'));
  const mail = await ctx.mailbox(EMAIL);
  ctx.check('confirmation email sent once', mail.filter((m) => m.subject.startsWith('Booking confirmed')).length === 1);
  const [row] = ctx.sql(`SELECT kind, status, amount_cents, paid_cents, payment_status, purchase_tracked_at FROM bookings WHERE id = '${bookingId}'`);
  ctx.check('booking is a confirmed, paid term booking',
    row && row.kind === 'term' && row.status === 'confirmed' && row.paid_cents === 16800 && row.payment_status === 'paid' && row.purchase_tracked_at,
    JSON.stringify(row));
  const ledger = ctx.sql(`SELECT kind, amount_cents FROM payments WHERE booking_id = '${bookingId}'`);
  ctx.check('ledger has exactly one checkout row', ledger.length === 1 && ledger[0].kind === 'checkout' && ledger[0].amount_cents === 16800,
    JSON.stringify(ledger));
  const seats = ctx.sql(`SELECT COUNT(*) AS n FROM booking_sessions WHERE booking_id = '${bookingId}' AND status = 'booked'`);
  ctx.check('the term booking holds all six weeks', seats[0].n === 6);

  const dup = await ctx.fetch(`/book/checkout?kind=term&term=term-dev-11&child=${childId}`, { cookie });
  ctx.check('a second term booking for the same child is refused', dup.status === 409 && dup.text.includes('Already booked'));

  ctx.section('Trial: once per child per class');
  const list2 = await ctx.fetch('/book', { cookie });
  const trialSession = /kind=trial&amp;term=term-dev-13&amp;session=([A-Za-z0-9-]+)/.exec(list2.text)?.[1];
  ctx.check('the 1 pm class offers a trial', Boolean(trialSession));
  const trialPost = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'trial', term: 'term-dev-13', session: trialSession, child: childId, photo_consent: 'no', medical: '', waiver: 'accepted' },
  });
  const trialId = /booking=([a-f0-9-]+)/.exec(trialPost.location)?.[1];
  const trialRef = /ref=([A-Za-z0-9_]+)/.exec(trialPost.location)?.[1];
  const trialMock = await ctx.fetch(trialPost.location, { cookie });
  ctx.check('the trial costs the trial price', trialMock.text.includes('$30.00'));
  await ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie, body: { csrf, booking: trialId, ref: trialRef, outcome: 'pay' },
  });
  const secondTrial = await ctx.fetch(`/book/checkout?kind=trial&term=term-dev-13&session=${trialSession}&child=${childId}`, { cookie });
  ctx.check('a second trial for the same child is refused', secondTrial.status === 409 && secondTrial.text.includes('Trial already booked'),
    `HTTP ${secondTrial.status}`);
  const list3 = await ctx.fetch('/book', { cookie });
  ctx.check('the class list stops offering that class a trial', !/kind=trial&amp;term=term-dev-13/.test(list3.text));

  ctx.section('Backing out of checkout');
  const casual = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'casual', term: 'term-dev-13', session: 'ses-13-w3', child: childId, photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const casualId = /booking=([a-f0-9-]+)/.exec(casual.location)?.[1];
  const casualRef = /ref=([A-Za-z0-9_]+)/.exec(casual.location)?.[1];
  const cancelled = await ctx.fetch(`/book/cancelled?booking=${casualId}`, { cookie });
  ctx.check('cancel page says no money was taken', cancelled.text.includes('No money was taken'));
  const [casualRow] = ctx.sql(`SELECT status FROM bookings WHERE id = '${casualId}'`);
  ctx.check('the pending booking is expired and its seat released', casualRow && casualRow.status === 'expired');
  const late = await ctx.fetch('/dev/mock-checkout', {
    method: 'POST', cookie, body: { csrf, booking: casualId, ref: casualRef, outcome: 'pay' },
  });
  ctx.check('the old checkout tab can no longer take a payment', late.status === 409);

  ctx.section('Credit covers the whole class');
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${EMAIL}'`);
  ctx.sqlWrite(`INSERT INTO credits (id, user_id, amount_cents, remaining_cents, reason, issued_by, issued_at)
                VALUES ('e2e-credit-1', '${user.id}', 3000, 3000, 'Goodwill', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`);
  const creditReview = await ctx.fetch(`/book/checkout?kind=casual&term=term-dev-13&session=ses-13-w4&child=${childId}`, { cookie });
  ctx.check('checkout applies the account credit', creditReview.text.includes('Account credit') && creditReview.text.includes('$0.00 AUD'));
  const free = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie,
    body: { csrf, kind: 'casual', term: 'term-dev-13', session: 'ses-13-w4', child: childId, photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  ctx.check('a fully covered booking skips payment', free.status === 303 && free.location.startsWith('/book/confirm'), free.location);
  const freeId = /booking=([a-f0-9-]+)/.exec(free.location)?.[1];
  const [freeRow] = ctx.sql(`SELECT status, payment_status, credit_cents FROM bookings WHERE id = '${freeId}'`);
  ctx.check('it is confirmed and paid by credit', freeRow && freeRow.status === 'confirmed' && freeRow.payment_status === 'paid' && freeRow.credit_cents === 3000,
    JSON.stringify(freeRow));
  const [credit] = ctx.sql(`SELECT remaining_cents FROM credits WHERE id = 'e2e-credit-1'`);
  ctx.check('the credit is used up', credit.remaining_cents === 0);
}
