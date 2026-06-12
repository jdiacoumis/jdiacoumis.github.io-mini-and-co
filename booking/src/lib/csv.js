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
