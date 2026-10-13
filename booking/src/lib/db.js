// Database helpers and time/id conventions.
//
// INVARIANT: every timestamp stored in D1 is a UTC ISO-8601 string with SECOND
// precision and 'Z' suffix ("2026-07-22T01:00:00Z"). With one shared format,
// lexicographic comparison in SQL equals chronological comparison. Always use
// nowIso()/isoPlusSeconds()/isoFromMs() (never new Date().toISOString(), which
// adds milliseconds).

export function uuid() {
  return crypto.randomUUID();
}

export function isoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function nowIso() {
  return isoFromMs(Date.now());
}

export function isoPlusSeconds(seconds, from = Date.now()) {
  return isoFromMs(from + seconds * 1000);
}

// "2027-02-03T00:00:00Z" + n days → ISO (UTC arithmetic; DST-free).
export function isoPlusDays(iso, days) {
  return isoFromMs(Date.parse(iso) + days * 86400 * 1000);
}

// Conditional rollback inside an atomic D1 batch (D1 has no interactive
// transactions). txn_guards only accepts the id 'ok', so the INSERT violates
// the table's CHECK — and aborts the WHOLE batch — whenever `conditionSql`
// is false (or NULL). The DELETE resets the table for the next guard.
// `conditionSql` refers to `binds` as ?1..?N; the failure code binds as ?N+1.
export function txnGuard(env, conditionSql, binds, code) {
  if (!code || code === 'ok') throw new Error('txnGuard needs a failure code other than "ok"');
  return [
    env.DB.prepare(
      `INSERT INTO txn_guards (id) SELECT CASE WHEN (${conditionSql}) THEN 'ok' ELSE ?${binds.length + 1} END`,
    ).bind(...binds, String(code)),
    env.DB.prepare(`DELETE FROM txn_guards WHERE id = 'ok'`),
  ];
}

// A failed guard (or any other CHECK) surfaces as a constraint error from the
// batch; anything else is a genuine database failure and must propagate.
export function isConstraintError(err) {
  return /constraint failed/i.test(String(err && err.message));
}
