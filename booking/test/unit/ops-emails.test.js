// Ops email builders (lib/emails/ops.js): subjects, Sydney times, amounts,
// links, and escaping of anything a family typed (names, notes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reminder, sessionCancelled, reenrolInvitation, waitlistOffer, planFailed, offlineReceipt, bulk, cleanSubject,
} from '../../src/lib/emails/ops.js';
import { formatSydney } from '../../src/lib/time.js';

const STARTS = '2027-02-03T00:00:00Z'; // Wed 3 Feb 2027, 11:00 am AEDT
const NASTY = '<b>Max</b> & "Co"';
const ACCOUNT = 'https://miniandcosensoryclasses.com/account';

const all = () => [
  reminder({ parentName: NASTY, childName: NASTY, className: 'Sensory Play', startsAt: STARTS, venue: 'Hall', accountUrl: ACCOUNT }),
  sessionCancelled({ parentName: NASTY, childName: NASTY, className: 'Sensory Play', startsAt: STARTS, reason: '<i>flood</i>', creditCents: 2800, accountUrl: ACCOUNT }),
  reenrolInvitation({ parentName: NASTY, childName: NASTY, termName: 'Term 1 2027', className: 'Sensory Play', amountCents: 15000, payByAt: STARTS, accountUrl: ACCOUNT }),
  waitlistOffer({ parentName: NASTY, childName: NASTY, termName: 'Term 1 2027', className: 'Sensory Play', amountCents: 11200, expiresAt: STARTS, accountUrl: ACCOUNT, detail: 'the rest of the term — 4 weeks' }),
  planFailed({ parentName: NASTY, childName: NASTY, amountDueCents: 2800, updateCardUrl: ACCOUNT }),
  offlineReceipt({ parentName: NASTY, childName: NASTY, amountCents: 16800, method: 'cash', paidAt: STARTS, summary: 'Term 1 2027', accountUrl: ACCOUNT }),
  bulk({ subject: 'Theme change', bodyText: `Hello ${NASTY}\n\nSecond paragraph`, parentName: NASTY }),
];

test('every builder returns a one-line subject, plain text and an html fragment', () => {
  for (const message of all()) {
    assert.equal(typeof message.subject, 'string');
    assert.ok(message.subject.length > 0 && !/[\r\n]/.test(message.subject), message.subject);
    assert.match(message.text, /Warmly,\nCamila — Mini & Co\. Sensory Classes$/);
    assert.match(String(message.html), /<p>Warmly,<br>Camila — Mini &amp; Co\. Sensory Classes<\/p>$/);
  }
});

test('names, reasons and messages are escaped in html and kept verbatim in text', () => {
  for (const message of all()) {
    const body = String(message.html);
    assert.ok(!body.includes('<b>Max</b>'), `raw markup leaked: ${message.subject}`);
    assert.ok(!body.includes('<i>'), 'reason markup leaked');
    assert.ok(body.includes('&lt;b&gt;Max&lt;/b&gt; &amp; &quot;Co&quot;'), `escaped name missing: ${message.subject}`);
    assert.ok(message.text.includes(NASTY), 'text keeps the name as typed');
  }
});

test('reminder: date in the subject, Sydney time, venue, what to bring, account link', () => {
  const m = reminder({ parentName: 'Jo', childName: 'Edie', className: 'Sensory Play — Wednesday 11:00 am', startsAt: STARTS, venue: 'Oran Park Library', accountUrl: ACCOUNT });
  assert.equal(m.subject, `Reminder: Edie's class on ${formatSydney(STARTS, 'date')}`);
  assert.ok(m.text.includes(formatSydney(STARTS)));
  assert.match(formatSydney(STARTS), /11:00\s?am/, 'rendered in Sydney (AEDT), not UTC');
  assert.ok(m.text.includes('Oran Park Library'));
  assert.ok(m.text.includes('muslin or burp cloth for Edie'));
  assert.ok(String(m.html).includes(`<a href="${ACCOUNT}">`));
  assert.ok(m.text.startsWith('Hi Jo,'));
  assert.ok(reminder({ childName: 'Edie', className: 'X', startsAt: STARTS }).text.startsWith('Hi there,'));
});

test("possessives follow Australian style (James's)", () => {
  assert.ok(reminder({ childName: 'James', className: 'X', startsAt: STARTS }).subject.startsWith("Reminder: James's class"));
});

test('session cancelled: credit amount when given, a plain line when not', () => {
  const credited = sessionCancelled({ parentName: 'Jo', childName: 'Edie', className: 'Sensory Play', startsAt: STARTS, reason: 'venue closed', creditCents: 2800, accountUrl: ACCOUNT });
  assert.equal(credited.subject, `Class cancelled: Sensory Play ${formatSydney(STARTS, 'date')}`);
  assert.ok(credited.text.includes('has been cancelled (venue closed).'));
  assert.ok(credited.text.includes('credit of $28.00'));
  const none = sessionCancelled({ parentName: 'Jo', childName: 'Edie', className: 'Sensory Play', startsAt: STARTS });
  assert.ok(!none.text.includes('credit of'));
  assert.ok(none.text.includes('just reply to this email'));
});

test('waitlist offer: amount, hold deadline, account link; zero amount says nothing to pay', () => {
  const m = waitlistOffer({ parentName: 'Jo', childName: 'Wren', termName: 'Term 1 2027', className: 'Sensory Play', amountCents: 11200, expiresAt: STARTS, accountUrl: ACCOUNT, detail: 'the rest of the term — 4 weeks' });
  assert.equal(m.subject, 'A place has opened up for Wren — Term 1 2027');
  assert.ok(m.text.includes('Pay now ($112.00)'));
  assert.ok(m.text.includes(`until ${formatSydney(STARTS)}`));
  assert.ok(m.text.includes(': the rest of the term — 4 weeks.'));
  assert.ok(m.text.includes(ACCOUNT));
  const free = waitlistOffer({ parentName: 'Jo', childName: 'Wren', termName: 'T', className: 'C', amountCents: 0, expiresAt: STARTS });
  assert.ok(free.text.includes("There's nothing to pay"));
  assert.ok(!free.text.includes('$0.00'));
});

test('plan failed: first notice vs weekly nudge, amount optional, update-card link', () => {
  const first = planFailed({ parentName: 'Jo', childName: 'Ava', amountDueCents: 2800, updateCardUrl: ACCOUNT });
  assert.equal(first.subject, "Payment didn't go through — Ava's classes");
  assert.ok(first.text.includes('($28.00)'));
  assert.ok(first.text.includes('tried again automatically'));
  assert.ok(String(first.html).includes(`<a href="${ACCOUNT}">`));
  const nudge = planFailed({ parentName: 'Jo', childName: 'Ava', amountDueCents: 5600, updateCardUrl: ACCOUNT, nudge: true });
  assert.equal(nudge.subject, "Reminder: a payment for Ava's classes is still outstanding");
  assert.ok(nudge.text.includes('($56.00) is still outstanding'));
  const noAmount = planFailed({ parentName: 'Jo', childName: 'Ava', amountDueCents: null });
  assert.ok(!noAmount.text.includes('$'));
});

test('re-enrol invitation keeps its contract (Phase 2B) and says the returning price only when told', () => {
  const m = reenrolInvitation({ parentName: 'Jo', childName: 'Edie', termName: 'Term 1 2027', className: 'Sensory Play', amountCents: 15000, payByAt: STARTS, accountUrl: ACCOUNT });
  assert.equal(m.subject, `Edie's place in Term 1 2027 is saved — pay by ${formatSydney(STARTS, 'date')}`);
  assert.ok(m.text.includes('The price for the term is $150.00.'));
  const returning = reenrolInvitation({ parentName: 'Jo', childName: 'Edie', termName: 'T', className: 'C', amountCents: 15000, payByAt: STARTS, returning: true });
  assert.ok(returning.text.includes('Your returning-family price is $150.00.'));
});

test('offline receipt: amount, method, date and summary', () => {
  const m = offlineReceipt({ parentName: 'Jo', childName: 'Edie', amountCents: 16800, method: 'bank transfer', paidAt: STARTS, summary: 'Term 1 2027', accountUrl: ACCOUNT });
  assert.equal(m.subject, 'Receipt: $168.00 received');
  assert.ok(m.text.includes(`$168.00 by bank transfer on ${formatSydney(STARTS, 'date')} for Edie's classes (Term 1 2027)`));
  const other = offlineReceipt({ parentName: 'Jo', childName: 'Edie', amountCents: 3000, method: 'other', paidAt: STARTS });
  assert.ok(other.text.includes('received $30.00 on'), other.text);
});

test('bulk: greeting by name, paragraphs and line breaks kept, CRLF normalised', () => {
  const m = bulk({ subject: 'Theme change', bodyText: 'First line\r\nsame paragraph\r\n\r\n\r\nSecond paragraph', parentName: 'Jo' });
  assert.equal(m.subject, 'Theme change');
  assert.ok(m.text.startsWith('Hi Jo,\n\nFirst line\nsame paragraph\n\nSecond paragraph\n\nWarmly,'));
  assert.ok(String(m.html).includes('<p>First line<br>same paragraph</p><p>Second paragraph</p>'));
  assert.equal(bulk({ bodyText: 'x' }).subject, 'A note from Mini & Co.');
});

test('subjects are forced onto one bounded line', () => {
  assert.equal(cleanSubject('A\r\nB\tC\u0000  D'), 'A B C D');
  assert.equal(cleanSubject('x'.repeat(500)).length, 200);
  assert.equal(waitlistOffer({ childName: 'Wren\nX', termName: 'T', className: 'C', amountCents: 1, expiresAt: STARTS }).subject,
    'A place has opened up for Wren X — T');
});
