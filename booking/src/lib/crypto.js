// Cryptographic primitives. Web Crypto only — no dependencies.

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Security: 256 bits from the platform CSPRNG. Used for magic-link tokens,
// session tokens and CSRF tokens. Never use Math.random() for these.
export function randomToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(String(text))));
}

export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(message))));
}

// Security: constant-time string comparison (no early exit), so token and
// signature checks do not leak how many leading characters matched.
export function timingSafeEqual(a, b) {
  const aBytes = encoder.encode(String(a));
  const bBytes = encoder.encode(String(b));
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}
