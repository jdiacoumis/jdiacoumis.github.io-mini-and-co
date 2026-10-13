// Structured logging (one JSON line per event, picked up by Workers Logs).
// Security: never log tokens, full email addresses, phone numbers, or any
// medical/consent content. Use maskEmail() for correlation.

export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return `${s[0]}***@${s.slice(at + 1)}`;
}

export function logEvent(type, fields = {}) {
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), type, ...fields }));
  } catch {
    console.log(JSON.stringify({ t: new Date().toISOString(), type }));
  }
}

export function logError(type, err, fields = {}) {
  try {
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      type,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ...fields,
    }));
  } catch {
    console.error(type, err);
  }
}
