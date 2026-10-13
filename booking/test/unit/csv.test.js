import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../../src/lib/csv.js';

test('parseCsv handles quoted fields, embedded commas and escaped quotes', () => {
  const rows = parseCsv('a,b,c\n"x,1","say ""hi""",z\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x,1', 'say "hi"', 'z']]);
});

test('parseCsv handles \\r\\n rows and embedded newlines in quotes', () => {
  const rows = parseCsv('h1,h2\r\n"line1\nline2",b\r\n');
  assert.deepEqual(rows, [['h1', 'h2'], ['line1\nline2', 'b']]);
});

test('parseCsv returns null for an unterminated quoted field', () => {
  assert.equal(parseCsv('a,"broken\n'), null);
});

test('parseCsv skips blank lines', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n\n'), [['a', 'b'], ['1', '2']]);
});

test('toCsv quotes everything and doubles embedded quotes', () => {
  const out = toCsv(['h'], [['say "hi"']]);
  assert.equal(out, '"h"\r\n"say ""hi"""\r\n');
});

test('toCsv neutralises spreadsheet formula injection', () => {
  const out = toCsv(['note'], [['=HYPERLINK("http://evil")'], ['+1'], ['-2'], ['@cmd'], ['\tx']]);
  for (const line of out.split('\r\n').slice(1).filter(Boolean)) {
    assert.ok(line.startsWith(`"'`), `expected apostrophe guard in ${JSON.stringify(line)}`);
  }
});

test('round-trip: toCsv output parses back to the same values', () => {
  const rows = [['a,b', 'c"d', 'plain'], ['x', '', 'z']];
  const parsed = parseCsv(toCsv(['1', '2', '3'], rows));
  assert.deepEqual(parsed.slice(1), rows);
});
