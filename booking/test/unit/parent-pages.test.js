// Pure page helpers exported by routes/booking.js: the session list, the
// pay-in-full / instalments choice, titles and descriptions, and reading the
// waiver/consent answers from a form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionsList, planChoice, bookingTitle, paymentDescription, readConsent,
} from '../../src/routes/booking.js';

const session = (id, startsAt, className = 'Sensory Play — Wednesday 11:00 am', venue = 'Oran Park Library') => ({
  id, starts_at: startsAt, duration_mins: 45, class_name: className, venue,
});

test('one class: its name and venue once, then one line per date', () => {
  const out = String(sessionsList([session('a', '2027-02-03T00:00:00Z'), session('b', '2027-02-10T00:00:00Z')]));
  assert.equal((out.match(/Sensory Play/g) || []).length, 1);
  assert.match(out, /<p class="sessions-heading">Sensory Play — Wednesday 11:00 am · Oran Park Library<\/p>/);
  assert.equal((out.match(/<li class="checkout-session">/g) || []).length, 2);
  assert.match(out, /Wed, 3 Feb 2027, 11:00 am · 45 min/);
  assert.ok(!String(sessionsList([session('a', '2027-02-03T00:00:00Z')], { heading: false })).includes('sessions-heading'));
  assert.equal(String(sessionsList([])), '');
});

test('several classes: each line names its class; names are escaped', () => {
  const out = String(sessionsList([
    session('a', '2027-02-03T00:00:00Z', '<b>Morning</b>'),
    session('b', '2027-02-03T02:00:00Z', 'Afternoon'),
  ]));
  assert.ok(!out.includes('sessions-heading'));
  assert.match(out, /&lt;b&gt;Morning&lt;\/b&gt; — Wed, 3 Feb 2027/);
  assert.match(out, /Afternoon — Wed, 3 Feb 2027, 1:00 pm/);
});

test('plan choice: both options, the dated schedule, the chosen one checked and open', () => {
  const now = '2027-02-03T00:00:00Z';
  const full = String(planChoice({ amountCents: 10000, planOption: { n: 3, interval: 'week' }, paymentChoice: 'full', now }));
  assert.match(full, /Pay \$100\.00 in full today/);
  assert.match(full, /Pay in 3 weekly instalments — \$33\.34 today, then \$33\.33 each week/);
  assert.match(full, /value="full" checked/);
  assert.match(full, /<details class="plan-schedule" >/);
  assert.match(full, /<span>Today<\/span><span>\$33\.34<\/span>/);
  assert.match(full, /<span>Wed, 10 Feb 2027<\/span><span>\$33\.33<\/span>/);
  const plan = String(planChoice({ amountCents: 10000, planOption: { n: 3, interval: 'week' }, paymentChoice: 'plan', now }));
  assert.match(plan, /value="plan" checked/);
  assert.match(plan, /<details class="plan-schedule" open>/);
  const fortnight = String(planChoice({ amountCents: 6000, planOption: { n: 2, interval: 'fortnight' }, paymentChoice: 'full', now }));
  assert.match(fortnight, /2 fortnightly instalments — \$30\.00 today, then \$30\.00 every fortnight/);
  assert.equal(planChoice({ amountCents: 10000, planOption: null, paymentChoice: 'full', now }), '');
  assert.equal(planChoice({ amountCents: 0, planOption: { n: 3, interval: 'week' }, paymentChoice: 'plan', now }), '');
});

test('titles and payment descriptions', () => {
  assert.equal(bookingTitle('term', 'Term 1 2027'), 'Term — Term 1 2027');
  assert.equal(bookingTitle('trial', null), 'Trial class');
  assert.equal(paymentDescription('term', { termName: 'Term 1 2027', className: 'Wednesday 11:00 am', childName: 'Edie' }),
    'Mini & Co. — Term, Term 1 2027 (Wednesday 11:00 am) for Edie');
  assert.equal(paymentDescription('casual', { childName: 'Edie' }), 'Mini & Co. — Casual for Edie');
});

test('consent: the waiver must be accepted and photo consent answered yes or no', () => {
  const form = (entries) => new URLSearchParams(entries);
  assert.equal(readConsent(form({ photo_consent: 'yes' })), null);
  assert.equal(readConsent(form({ waiver: 'accepted' })), null);
  assert.equal(readConsent(form({ waiver: 'accepted', photo_consent: 'maybe' })), null);
  assert.deepEqual(readConsent(form({ waiver: 'accepted', photo_consent: 'no', medical: '  Egg allergy  ' })),
    { photoConsent: false, medical: 'Egg allergy' });
  assert.equal(readConsent(form({ waiver: 'accepted', photo_consent: 'yes', medical: 'x'.repeat(3000) })).medical.length, 2000);
});
