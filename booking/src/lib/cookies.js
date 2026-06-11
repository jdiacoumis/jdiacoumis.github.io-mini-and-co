// Minimal cookie parsing/serialising.

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function serialiseCookie(name, value, { maxAge, path = '/', httpOnly = true, secure = true, sameSite = 'Lax' } = {}) {
  // Security: cookie values we set are base64url tokens — no encoding needed,
  // but reject anything that would break the header just in case.
  if (!/^[A-Za-z0-9._-]*$/.test(value)) throw new Error('Invalid cookie value');
  let cookie = `${name}=${value}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (secure) cookie += '; Secure';
  if (typeof maxAge === 'number') cookie += `; Max-Age=${Math.floor(maxAge)}`;
  return cookie;
}
