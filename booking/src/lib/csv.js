// CSV generation for admin exports.
//
// Security: values are always quoted, embedded quotes doubled, and values
// starting with a formula-triggering character (= + - @, tab, CR) are
// prefixed with an apostrophe so spreadsheet applications treat them as text
// (CSV/formula injection, CWE-1236). User-entered fields like medical notes
// pass through here.

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// Minimal RFC-4180 CSV parser (quoted fields, "" escapes, \r\n or \n rows).
// Returns an array of string arrays, or null if the input is structurally
// broken (an unterminated quoted field). Field and row counts are bounded by
// the caller via the upload size cap.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const s = String(text ?? '');

  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += 1; continue;
    }
    field += ch; i += 1;
  }
  if (inQuotes) return null;
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

export function csvResponse(filename, headers, rows) {
  // Filename is server-controlled; keep it to a safe charset anyway.
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
