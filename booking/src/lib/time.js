// Australia/Sydney time handling. Storage is ALWAYS UTC ISO-8601 (see db.js);
// these helpers convert at the edges: admin enters Sydney wall-clock times,
// every page renders Sydney wall-clock times. Intl handles AEST/AEDT.

const TZ = 'Australia/Sydney';

function tzOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - date.getTime()) / 60000;
}

// "2026-07-22" + "11:00" (Sydney wall clock) → "2026-07-22T01:00:00Z".
// Iterates because the offset depends on the instant (DST transitions).
export function sydneyToUtc(dateStr, timeStr) {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  const m2 = /^(\d{2}):(\d{2})$/.exec(String(timeStr));
  if (!m1 || !m2) return null;
  const target = Date.UTC(+m1[1], +m1[2] - 1, +m1[3], +m2[1], +m2[2], 0);
  if (Number.isNaN(target)) return null;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const next = target - tzOffsetMinutes(new Date(guess)) * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatSydney(utcIso, style = 'full') {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return '';
  const opts = {
    full: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true },
    date: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
    time: { hour: 'numeric', minute: '2-digit', hour12: true },
    dateLong: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  }[style] || undefined;
  return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, ...opts }).format(date).replace(/am$/i, 'am').replace(/pm$/i, 'pm');
}

// Sydney wall-clock date/time fields of a stored UTC instant (for edit forms).
export function sydneyFields(utcIso) {
  const date = new Date(utcIso);
  const dtf = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function ageInMonths(dobStr, atIso = null) {
  const dob = new Date(`${dobStr}T00:00:00Z`);
  const at = atIso ? new Date(atIso) : new Date();
  if (Number.isNaN(dob.getTime()) || Number.isNaN(at.getTime())) return null;
  let months = (at.getUTCFullYear() - dob.getUTCFullYear()) * 12 + (at.getUTCMonth() - dob.getUTCMonth());
  if (at.getUTCDate() < dob.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

export function formatAge(dobStr, atIso = null) {
  const months = ageInMonths(dobStr, atIso);
  if (months === null) return '';
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'}`;
}
