// Review fix (task 3.2, finding 9): families migrated from ClassForKids got
// $0 credit when a class was cancelled — their imported booking cost $0, so
// its per-week value was $0. The import now takes an optional amount_paid
// (AUD) — blank means the term price for the weeks enrolled — as the
// booking's price, recorded as an offline "paid on ClassForKids" ledger row.
// (The owner can also set any family's credit on the cancel page.) Names are
// kept to one line.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, signedIn, formRequest, outcome, routeHandler } from './helpers.js';
import { cancelSessionWithCredits } from '../../src/lib/admin-ops.js';
import { cleanName, isValidName } from '../../src/lib/validate.js';
import * as adminImport from '../../src/routes/admin-import.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const HEADER = 'parent_name,parent_email,parent_phone,child_name,child_dob,medical_notes,photo_consent,enrol_class,enrol_term,amount_paid';

async function commit(owner, csv) {
  const payload = btoa(String.fromCharCode(...new TextEncoder().encode(csv)));
  const res = await outcome(routeHandler(adminImport, 'POST', '/admin/import/commit')(formRequest('POST', '/admin/import/commit', {
    cookie: owner.cookie, form: { csrf: owner.csrf, payload },
  }), env, {}));
  return { status: res.status, text: await res.text() };
}

test('imported enrolments carry what was paid (given, or the term price for the weeks enrolled) and earn a real credit', async () => {
  // A six-week, $168 term that started 8 days ago: four weeks are left.
  const fam = await seedFamilyAndTerm(env, { prefix: 'imp', startInDays: -8 });
  const owner = await signedIn(env, 'owner@example.com');
  const csv = [
    HEADER,
    'Ana Paid,imp-a@example.com,0400000001,Ada,2025-10-01,,yes,Sensory Play,Test Term,"$100.00"',
    'Bo Blank,imp-b@example.com,0400000002,"Ben\r\nBcc: x@evil.example",2025-10-01,,no,Sensory Play,Test Term,',
    'Cy Bad,imp-c@example.com,0400000003,Cal,2025-10-01,,yes,Sensory Play,Test Term,lots',
    'Di NoTerm,imp-d@example.com,0400000004,Dot,2025-10-01,,yes,,,30',
  ].join('\n');
  const first = await commit(owner, csv);
  assert.equal(first.status, 200);
  assert.match(first.text, /paid \$100\.00/);
  assert.match(first.text, /paid \$112\.00 \(term price for those weeks\)/);
  assert.match(first.text, /amount_paid &quot;lots&quot; is not an amount/);
  assert.match(first.text, /amount_paid is only for a row with an enrolment/);

  const bookings = (await env.DB.prepare(
    `SELECT b.id, u.email, ch.name AS child, b.list_amount_cents, b.amount_cents, b.paid_cents, b.payment_status, b.payment_method,
            (SELECT COUNT(*) FROM booking_sessions bs WHERE bs.booking_id = b.id) AS weeks
     FROM bookings b JOIN users u ON u.id = b.user_id JOIN children ch ON ch.id = b.child_id
     WHERE b.term_id = ?1 AND u.email LIKE 'imp-%' ORDER BY u.email`,
  ).bind(fam.termId).all()).results;
  assert.deepEqual(bookings.map((b) => [b.email, b.child, b.amount_cents, b.list_amount_cents, b.paid_cents, b.payment_status, b.weeks]), [
    ['imp-a@example.com', 'Ada', 10000, 10000, 10000, 'paid', 4],
    ['imp-b@example.com', 'Ben Bcc: x@evil.example', 11200, 11200, 11200, 'paid', 4],
  ]);
  const ledger = (await env.DB.prepare(`SELECT kind, amount_cents, method, provider FROM payments WHERE booking_id = ?1`).bind(bookings[0].id).all()).results;
  assert.deepEqual(ledger, [{ kind: 'offline', amount_cents: 10000, method: 'ClassForKids', provider: 'external' }]);

  // Committing again changes nothing.
  const again = await commit(owner, csv);
  assert.match(again.text, /enrolment already exists/);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?1`).bind(bookings[0].id).first()).n, 1);

  // A cancelled class now credits them a week's worth of what they paid.
  const remaining = fam.sessionIds.slice(2);
  const result = await cancelSessionWithCredits(env, remaining[0], { reason: 'Venue closed', by: 'owner' });
  assert.equal(result.ok, true);
  const credits = Object.fromEntries((await env.DB.prepare(
    `SELECT source_booking_id, amount_cents FROM credits WHERE source_session_id = ?1`,
  ).bind(remaining[0]).all()).results.map((c) => [c.source_booking_id, c.amount_cents]));
  assert.equal(credits[bookings[0].id], 2500, '$100 over 4 weeks');
  assert.equal(credits[bookings[1].id], 2800, '$112 over 4 weeks: the term\'s weekly rate');
});

test('names are kept to one line: control characters and line breaks never reach an email header', () => {
  assert.equal(cleanName('Ada\r\nBcc: x@evil.example', 100), 'Ada Bcc: x@evil.example');
  assert.equal(cleanName('  Ada \t Lovelace\u0085 ', 100), 'Ada Lovelace');
  assert.equal(isValidName('Ada\nLovelace'), false);
  assert.equal(isValidName('Ada Lovelace'), true);
});
