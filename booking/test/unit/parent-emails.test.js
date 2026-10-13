// Parent email templates (lib/emails/parent.js): the booking confirmation
// with the instalment schedule, and the trial follow-up offer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingConfirmationEmail, trialFollowUpEmail } from '../../src/lib/emails/parent.js';

const env = { PUBLIC_BASE_URL: 'https://example.test' };

function booking(overrides = {}) {
  return {
    id: 'b1', kind: 'term', status: 'confirmed', parent_name: 'Sam', child_name: 'Edie',
    term_name: 'Term 1 2027', class_name: 'Sensory Play — Wednesday 11:00 am',
    amount_cents: 16800, credit_cents: 0, discount_cents: 0, voucher_code: null, paid_cents: 16800,
    payment_method: 'full', payment_status: 'paid', plan_instalments: null, plan_interval: null,
    paid_at: '2027-02-03T00:00:00Z', created_at: '2027-02-03T00:00:00Z',
    sessions: [
      { starts_at: '2027-02-03T00:00:00Z', duration_mins: 45, venue: 'Oran Park Library' },
      { starts_at: '2027-02-10T00:00:00Z', duration_mins: 45, venue: 'Oran Park Library' },
    ],
    ...overrides,
  };
}

test('confirmation for a paid term lists the classes, the venue and the amount', () => {
  const email = bookingConfirmationEmail({ booking: booking(), env });
  assert.equal(email.subject, 'Booking confirmed — see you soon, Edie!');
  assert.match(email.text, /Edie's booking is confirmed: Term — Term 1 2027 \(Sensory Play — Wednesday 11:00 am\)\./);
  assert.match(email.text, /Your classes \(2\):\n {2}• Wed, 3 Feb 2027, 11:00 am \(45 min\)/);
  assert.match(email.text, /Where: Oran Park Library/);
  assert.match(email.text, /Paid: \$168\.00 AUD\./);
  assert.match(email.text, /https:\/\/example\.test\/account/);
  assert.match(String(email.html), /<a href="https:\/\/example\.test\/account">your account<\/a>/);
});

test('confirmation for an instalment plan carries the dated schedule', () => {
  const email = bookingConfirmationEmail({
    booking: booking({
      amount_cents: 10000, paid_cents: 3334, payment_method: 'plan', payment_status: 'plan_active',
      plan_instalments: 3, plan_interval: 'week', stripe_subscription_id: 'sub_1',
    }),
    env,
  });
  assert.match(email.text, /Payment plan: 3 weekly instalments, collected automatically from your card\./);
  assert.match(email.text, / {2}1\. Wed, 3 Feb 2027 — \$33\.34 \(charged at checkout\)/);
  assert.match(email.text, / {2}2\. Wed, 10 Feb 2027 — \$33\.33/);
  assert.match(email.text, / {2}3\. Wed, 17 Feb 2027 — \$33\.33/);
  assert.match(email.text, /your place is kept/);
  assert.equal((String(email.html).match(/<li>/g) || []).length, 2 + 3, 'two classes and three instalments');
});

test('plan dates run from the payment, or from the confirmation, never from when a hold was created', () => {
  const held = booking({
    amount_cents: 10000, paid_cents: 0, paid_at: null, created_at: '2027-01-20T00:00:00Z', payment_method: 'plan',
    payment_status: 'unpaid', plan_instalments: 3, plan_interval: 'week', stripe_subscription_id: 'sub_2',
  });
  const email = bookingConfirmationEmail({ booking: held, env, now: '2027-01-27T00:00:00Z' });
  assert.match(email.text, / {2}1\. Wed, 27 Jan 2027 — \$33\.34 \(charged at checkout\)/);
  assert.match(email.text, / {2}3\. Wed, 10 Feb 2027 — \$33\.33/);
});

test('a plan chosen but never started is not described as instalments', () => {
  const settled = booking({ payment_method: 'plan', plan_instalments: 6, payment_status: 'plan_complete', stripe_subscription_id: null });
  const email = bookingConfirmationEmail({ booking: settled, env });
  assert.ok(!email.text.includes('Payment plan'));
  assert.match(email.text, /Paid: \$168\.00 AUD\./);
});

test('voucher and credit lines; credit-covered and complimentary bookings', () => {
  const discounted = bookingConfirmationEmail({
    booking: booking({ amount_cents: 1500, discount_cents: 500, voucher_code: 'DEV5', credit_cents: 1000, kind: 'casual', term_name: null }),
    env,
  });
  assert.match(discounted.text, /Paid: \$15\.00 AUD\.\nVoucher DEV5: −\$5\.00\nAccount credit used: \$10\.00/);
  const covered = bookingConfirmationEmail({ booking: booking({ amount_cents: 0, credit_cents: 3000 }), env });
  assert.match(covered.text, /Covered by your account credit \(\$30\.00\) — nothing to pay\./);
  const comp = bookingConfirmationEmail({ booking: booking({ kind: 'complimentary', payment_status: 'waived', amount_cents: 0 }), env });
  assert.match(comp.text, /complimentary — nothing to pay/);
  const trial = bookingConfirmationEmail({ booking: booking({ kind: 'trial' }), env });
  assert.match(trial.text, /offer to join the rest of the term/);
});

test('names typed by families are escaped in the HTML part', () => {
  const email = bookingConfirmationEmail({ booking: booking({ child_name: '<script>x</script>', parent_name: 'A & B' }), env });
  const out = String(email.html);
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(out.includes('Hi A &amp; B,'));
});

const followUp = {
  parentName: 'Sam', childName: 'Edie', className: 'Sensory Play — Wednesday 11:00 am', termName: 'Term 1 2027',
  bookUrl: 'https://example.test/book/checkout?kind=term&term=t1&child=c1',
  waitlistUrl: 'https://example.test/book/waitlist?term=t1', classesUrl: 'https://example.test/book',
};

test('trial follow-up offers the remaining weeks at the pro-rata price', () => {
  const email = trialFollowUpEmail({
    ...followUp,
    offer: {
      isFull: false, weeks: 5, listCents: 14000, amountCents: 13000, creditCents: 1000,
      plan: { n: 5, interval: 'week', eachCents: 2600, firstCents: 2600 }, nextStartsAt: '2027-02-10T00:00:00Z',
    },
  });
  assert.equal(email.subject, "How was Edie's trial class? Join the rest of Term 1 2027");
  assert.match(email.text, /join the remaining 5 weeks of Term 1 2027 for \$140\.00/);
  assert.match(email.text, /account credit of \$10\.00 comes off automatically, so you'd pay \$130\.00/);
  assert.match(email.text, /5 weekly instalments \(\$26\.00 when you book, then \$26\.00\)/);
  assert.match(email.text, /The next class is Wed, 10 Feb 2027, 11:00 am\./);
  assert.match(email.text, /Book the remaining 5 weeks: https:\/\/example\.test\/book\/checkout\?kind=term&term=t1&child=c1/);
  assert.match(email.text, /See all our classes: https:\/\/example\.test\/book/);
  assert.ok(String(email.html).includes('href="https://example.test/book/checkout?kind=term&amp;term=t1&amp;child=c1"'));
});

test('trial follow-up for a full term points to the waitlist', () => {
  const email = trialFollowUpEmail({ ...followUp, offer: { isFull: true } });
  assert.match(email.text, /full at the moment, but you can join the waitlist/);
  assert.match(email.text, /Join the waitlist: https:\/\/example\.test\/book\/waitlist\?term=t1/);
  assert.ok(!email.text.includes('/book/checkout'));
});
