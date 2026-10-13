import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sydneyToUtc, formatSydney, sydneyFields, ageInMonths, formatAge } from '../../src/lib/time.js';

test('AEST (winter, UTC+10): 09:30 Sydney is 23:30Z the previous day', () => {
  assert.equal(sydneyToUtc('2026-06-15', '09:30'), '2026-06-14T23:30:00Z');
});

test('AEDT (summer, UTC+11): 09:30 Sydney is 22:30Z the previous day', () => {
  assert.equal(sydneyToUtc('2026-01-15', '09:30'), '2026-01-14T22:30:00Z');
});

test('first Wednesday after the 2026 DST start uses AEDT', () => {
  // DST starts Sunday 2026-10-04 in NSW.
  assert.equal(sydneyToUtc('2026-09-30', '09:30'), '2026-09-29T23:30:00Z'); // AEST
  assert.equal(sydneyToUtc('2026-10-07', '09:30'), '2026-10-06T22:30:00Z'); // AEDT
});

test('round-trip: stored UTC renders back to the entered Sydney wall clock', () => {
  for (const [date, time] of [['2026-06-15', '09:30'], ['2026-01-15', '13:00'], ['2026-10-07', '09:30']]) {
    const utc = sydneyToUtc(date, time);
    assert.deepEqual(sydneyFields(utc), { date, time });
  }
});

test('formatSydney renders Sydney-local wall clock', () => {
  const rendered = formatSydney('2026-06-14T23:30:00Z');
  assert.match(rendered, /15 June 2026|15 Jun(e)? 2026/);
  assert.match(rendered, /9:30\s?am/i);
});

test('malformed inputs are rejected, not mangled', () => {
  assert.equal(sydneyToUtc('2026-13-40', '09:30'), null);
  assert.equal(sydneyToUtc('2026-06-15', '25:99'), null);
  assert.equal(sydneyToUtc('junk', 'junk'), null);
  assert.equal(formatSydney('not-a-date'), '');
});

test('age in months and formatting', () => {
  assert.equal(ageInMonths('2025-10-01', '2026-06-12T00:00:00Z'), 8);
  assert.equal(ageInMonths('2026-06-01', '2026-06-12T00:00:00Z'), 0);
  assert.equal(formatAge('2025-10-01', '2026-06-12T00:00:00Z'), '8 months');
  assert.equal(formatAge('2023-05-01', '2026-06-12T00:00:00Z'), '3 years');
});
