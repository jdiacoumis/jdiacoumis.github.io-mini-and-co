// Database helpers and time/id conventions.
//
// INVARIANT: every timestamp stored in D1 is a UTC ISO-8601 string with SECOND
// precision and 'Z' suffix ("2026-07-22T01:00:00Z"). With one shared format,
// lexicographic comparison in SQL equals chronological comparison. Always use
// nowIso()/isoPlusSeconds() (never new Date().toISOString(), which adds ms).

export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoPlusSeconds(seconds, from = Date.now()) {
  return new Date(from + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
