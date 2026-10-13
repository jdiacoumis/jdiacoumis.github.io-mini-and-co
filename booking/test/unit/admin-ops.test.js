// Admin operations — pure helpers (lib/admin-ops.js): term planning with
// holidays and across the daylight-saving changes, re-run defaults, term
// names, the per-week credit maths, grid cells, the payment column and the
// roster's stricter consent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTermDates, sessionStartsFor, parseDateList, nextTermName, rerunDefaults, perWeekCreditCents, gridCell,
  paymentSummary, owingCents, strictestConsent, parseSignedDollarsToCents, datetimeLocalToUtc,
  utcToDatetimeLocal, addDays, dateWeekday, isDateStr, describeBooking, optionalDollars, shortDate,
} from '../../src/lib/admin-ops.js';
import { sydneyToUtc, formatSydney, sydneyFields } from '../../src/lib/time.js';

test('a ten-week term with a holiday has nine classes (class-scheduling spec)', () => {
  const plan = planTermDates({ startsOn: '2027-02-03', weeks: 10, skipDates: ['2027-03-10'], weekday: 3 });
  assert.equal(plan.ok, true);
  assert.equal(plan.dates.length, 9);
  assert.deepEqual(plan.skipped, ['2027-03-10']);
  assert.ok(!plan.dates.includes('2027-03-10'));
  assert.equal(plan.startsOn, '2027-02-03');
  assert.equal(plan.endsOn, '2027-04-07');
  assert.ok(plan.dates.every((d) => dateWeekday(d) === 3), 'every class is on a Wednesday');
});

test('the length can be given as the last class date instead of weeks', () => {
  const byEnd = planTermDates({ startsOn: '2027-02-03', endsOn: '2027-04-07', skipDates: ['2027-03-10'] });
  const byWeeks = planTermDates({ startsOn: '2027-02-03', weeks: 10, skipDates: ['2027-03-10'] });
  assert.deepEqual(byEnd.dates, byWeeks.dates);
  // A last date that is not a class day stops at the last class before it.
  const loose = planTermDates({ startsOn: '2027-02-03', endsOn: '2027-02-20' });
  assert.deepEqual(loose.dates, ['2027-02-03', '2027-02-10', '2027-02-17']);
  // Holidays outside the term are reported, not silently used.
  const unused = planTermDates({ startsOn: '2027-02-03', weeks: 2, skipDates: ['2027-05-05'] });
  assert.deepEqual(unused.unusedSkipDates, ['2027-05-05']);
});

test('term planning rejects bad input in plain terms', () => {
  assert.equal(planTermDates({ startsOn: '2027-02-04', weeks: 6, weekday: 3 }).error, 'start_weekday');
  assert.equal(planTermDates({ startsOn: '2027-02-31', weeks: 6 }).error, 'start_date');
  assert.equal(planTermDates({ startsOn: '2027-02-03', weeks: 0 }).error, 'weeks');
  assert.equal(planTermDates({ startsOn: '2027-02-03', weeks: 53 }).error, 'too_long');
  assert.equal(planTermDates({ startsOn: '2027-02-03', endsOn: '2027-01-01' }).error, 'end_date');
  assert.equal(planTermDates({ startsOn: '2027-02-03', weeks: 1, skipDates: ['2027-02-03'] }).error, 'no_sessions');
});

test('sessions keep 11:00 Sydney time across the April 2027 daylight-saving end', () => {
  // DST ends on the first Sunday in April: 2027-04-04.
  const plan = planTermDates({ startsOn: '2027-03-17', weeks: 6, weekday: 3 });
  const starts = sessionStartsFor(plan.dates, '11:00');
  const byDate = Object.fromEntries(starts.map((s) => [s.date, s.startsAt]));
  assert.equal(byDate['2027-03-31'], '2027-03-31T00:00:00Z', 'AEDT is UTC+11');
  assert.equal(byDate['2027-04-07'], '2027-04-07T01:00:00Z', 'AEST is UTC+10');
  for (const { date, startsAt } of starts) {
    assert.deepEqual(sydneyFields(startsAt), { date, time: '11:00' });
    assert.match(formatSydney(startsAt, 'time'), /^11:00\s?am$/i);
  }
});

test('sessions keep 1:00 pm across the October 2026 daylight-saving start', () => {
  // DST starts on the first Sunday in October: 2026-10-04.
  const starts = sessionStartsFor(planTermDates({ startsOn: '2026-09-23', weeks: 4 }).dates, '13:00');
  assert.deepEqual(starts.map((s) => s.startsAt), [
    '2026-09-23T03:00:00Z', '2026-09-30T03:00:00Z', '2026-10-07T02:00:00Z', '2026-10-14T02:00:00Z',
  ]);
});

test('date helpers', () => {
  assert.equal(addDays('2027-02-24', 7), '2027-03-03');
  assert.equal(addDays('2028-02-26', 3), '2028-02-29');
  assert.equal(isDateStr('2027-02-29'), false);
  assert.equal(isDateStr('2028-02-29'), true);
  assert.deepEqual(parseDateList('2027-03-10, 2027-04-14\n2027-03-10 nope'), {
    dates: ['2027-03-10', '2027-04-14'], invalid: ['nope'],
  });
  assert.equal(datetimeLocalToUtc('2027-01-20T09:00'), sydneyToUtc('2027-01-20', '09:00'));
  assert.equal(datetimeLocalToUtc('20/01/2027 9am'), null);
  assert.equal(utcToDatetimeLocal(sydneyToUtc('2027-06-01', '18:30')), '2027-06-01T18:30');
  assert.equal(shortDate('2027-02-12T00:00:00Z'), '12 Feb');
});

test('next term names follow the four school terms', () => {
  assert.equal(nextTermName('Term 1 2027'), 'Term 2 2027');
  assert.equal(nextTermName('Term 4 2027'), 'Term 1 2028');
  assert.equal(nextTermName('Sensory Term 3 2027 (Wed)'), 'Sensory Term 4 2027 (Wed)');
  assert.equal(nextTermName('Term 3'), 'Term 4');
  assert.equal(nextTermName('Winter block'), 'Winter block (next)');
});

test('re-run defaults: same length, two weeks after the end, opening times on the same wall clock', () => {
  const source = {
    name: 'Term 1 2027', starts_on: '2027-02-03', ends_on: '2027-04-07',
    returning_opens_at: sydneyToUtc('2027-01-20', '09:00'), public_opens_at: null,
  };
  const d = rerunDefaults(source);
  assert.equal(d.name, 'Term 2 2027');
  assert.equal(d.weeks, 10);
  assert.equal(d.shiftDays, 84);
  assert.equal(d.startsOn, '2027-04-28');
  assert.equal(dateWeekday(d.startsOn), 3);
  // 9:00 am AEDT moves to 9:00 am AEST (not 8:00 am).
  assert.equal(d.returningOpensAt, sydneyToUtc('2027-04-14', '09:00'));
  assert.equal(d.publicOpensAt, null);
});

test('per-week credit = (money + credit) / weeks, rounded down', () => {
  assert.equal(perWeekCreditCents({ amountCents: 16800, weeks: 6 }), 2800);
  assert.equal(perWeekCreditCents({ amountCents: 10000, weeks: 3 }), 3333);
  assert.equal(perWeekCreditCents({ amountCents: 13800, creditCents: 3000, weeks: 6 }), 2800);
  assert.equal(perWeekCreditCents({ amountCents: 3000, weeks: 1 }), 3000);
  assert.equal(perWeekCreditCents({ amountCents: 0, weeks: 6 }), 0);
  assert.equal(perWeekCreditCents({ amountCents: 16800, weeks: 0 }), 0);
  // Never more in total than was paid.
  assert.ok(perWeekCreditCents({ amountCents: 5000, weeks: 3 }) * 3 <= 5000);
});

test('grid cells: present ✓, absent ✗, booked ·, cancelled –, moved, blank', () => {
  const live = { status: 'scheduled' };
  assert.equal(gridCell(null, live), 'none');
  assert.equal(gridCell({ status: 'booked', attendance: null }, live), 'booked');
  assert.equal(gridCell({ status: 'booked', attendance: 'present' }, live), 'present');
  assert.equal(gridCell({ status: 'booked', attendance: 'absent' }, live), 'absent');
  assert.equal(gridCell({ status: 'cancelled', attendance: null }, live), 'cancelled');
  assert.equal(gridCell({ status: 'booked', attendance: null }, { status: 'cancelled' }), 'cancelled');
  assert.equal(gridCell({ status: 'transferred_out', attendance: null }, live), 'moved');
});

const NOW = '2027-02-10T00:00:00Z';
const base = {
  kind: 'term', status: 'confirmed', amount_cents: 16800, credit_cents: 0, payment_method: 'full',
  payment_status: 'paid', received_cents: 16800, money_in_cents: 16800, instalments_paid: 0,
  created_at: '2027-01-20T00:00:00Z', expires_at: '2027-01-20T00:35:00Z',
};

test('payment column: paid, comp, unpaid and part paid', () => {
  assert.deepEqual(paymentSummary(base, NOW), { label: 'Paid', owingCents: 0, tone: 'paid' });
  assert.equal(paymentSummary({ ...base, kind: 'complimentary', amount_cents: 0, payment_status: 'waived', received_cents: 0 }, NOW).label, 'Comp');
  assert.equal(paymentSummary({ ...base, payment_status: 'unpaid', received_cents: 0 }, NOW).label, 'Unpaid $168.00');
  const part = paymentSummary({ ...base, payment_status: 'unpaid', received_cents: 10000 }, NOW);
  assert.equal(part.label, 'Part paid — owes $68.00');
  assert.equal(part.owingCents, 6800);
});

test('payment column: instalment plans', () => {
  const plan = {
    ...base, payment_method: 'plan', payment_status: 'plan_active', plan_instalments: 6, plan_instalment_cents: 2800,
    plan_interval: 'week', paid_at: '2027-01-27T00:00:00Z', received_cents: 8400, money_in_cents: 8400,
    instalments_paid: 3, plan_next_charge_at: '2027-02-17T00:00:00Z',
  };
  assert.equal(paymentSummary(plan, NOW).label, 'Plan 3 of 6 · next 17 Feb');
  // Overdue: by 2027-02-10 (week 3 from 27 Jan) three instalments were due; only two arrived.
  const overdue = paymentSummary({ ...plan, payment_status: 'plan_overdue', received_cents: 5600, money_in_cents: 5600, instalments_paid: 2 }, NOW);
  assert.equal(overdue.label, 'Overdue $28.00');
  assert.equal(overdue.tone, 'overdue');
  assert.equal(paymentSummary({ ...plan, payment_status: 'plan_complete', received_cents: 16800 }, NOW).label, 'Paid');
});

test('payment column: pending pay-later holds and checkout holds', () => {
  const payLater = {
    ...base, status: 'pending', payment_status: 'unpaid', received_cents: 0, created_at: '2027-02-09T00:00:00Z',
    expires_at: '2027-02-16T00:00:00Z',
  };
  assert.equal(paymentSummary(payLater, NOW).label, 'Unpaid $168.00 — pay-later until 16 Feb');
  const checkout = { ...payLater, created_at: '2027-02-09T23:50:00Z', expires_at: '2027-02-10T00:25:00Z' };
  assert.equal(paymentSummary(checkout, NOW).label, 'Paying now');
  assert.equal(paymentSummary({ ...payLater, expires_at: '2027-02-09T12:00:00Z' }, NOW).label, 'Hold lapsed — not paid');
  assert.equal(paymentSummary({ ...base, status: 'expired', received_cents: 3000 }, NOW).label, 'Paid $30.00 — no seat');
});

test('owing counts account credit only once the booking is confirmed', () => {
  const withCredit = { ...base, amount_cents: 13800, credit_cents: 3000 };
  assert.equal(owingCents({ ...withCredit, status: 'pending', received_cents: 0 }), 13800);
  assert.equal(owingCents({ ...withCredit, status: 'confirmed', received_cents: 3000 }), 13800);
  assert.equal(owingCents({ ...withCredit, status: 'confirmed', received_cents: 16800 }), 0);
  // A refund does not make a settled booking owe money again (received excludes refunds).
  assert.equal(owingCents({ ...base, received_cents: 16800, paid_cents: 0 }), 0);
});

test('roster consent: the stricter of the booking snapshot and the current profile', () => {
  assert.deepEqual(strictestConsent(1, 1), { allowed: true, changed: false });
  assert.deepEqual(strictestConsent(1, 0), { allowed: false, changed: true });
  assert.deepEqual(strictestConsent(0, 1), { allowed: false, changed: true });
  assert.deepEqual(strictestConsent(null, 1), { allowed: true, changed: false });
  assert.deepEqual(strictestConsent(null, null), { allowed: false, changed: false });
});

test('money fields', () => {
  assert.equal(parseSignedDollarsToCents('-12.5'), -1250);
  assert.equal(parseSignedDollarsToCents('−5'), -500);
  assert.equal(parseSignedDollarsToCents('+$30'), 3000);
  assert.equal(parseSignedDollarsToCents('1-2'), null);
  assert.equal(parseSignedDollarsToCents('abc'), null);
  assert.deepEqual(optionalDollars('', 100), { ok: true, cents: null });
  assert.deepEqual(optionalDollars('168.5', 1000000), { ok: true, cents: 16850 });
  assert.equal(optionalDollars('-1', 100).ok, false);
  assert.equal(optionalDollars('20000', 1000000).ok, false);
});

test('booking descriptions for emails', () => {
  const sessions = [
    { starts_at: '2027-02-03T00:00:00Z', status: 'booked', class_name: 'Sensory Play' },
    { starts_at: '2027-02-10T00:00:00Z', status: 'booked', class_name: 'Sensory Play' },
    { starts_at: '2027-02-17T00:00:00Z', status: 'cancelled', class_name: 'Sensory Play' },
  ];
  const text = describeBooking({ kind: 'term', term_name: 'Term 1 2027', class_name: 'Sensory Play', sessions });
  assert.match(text, /^Term — Term 1 2027, Sensory Play \(2 weeks from /);
  const one = describeBooking({ kind: 'casual', sessions: [sessions[0]] });
  assert.match(one, /^Casual — Sensory Play \(.*11:00\s?am\)$/i);
});
