// Secure HTML templating: default auto-escaping, explicit opt-out for raw HTML.
// The html`` tag escapes every interpolated value unless it is the result of
// another html`` template or has been explicitly wrapped in raw(). This makes
// templates composable (nested html`` fragments are not double-escaped) while
// keeping "escape by default" as the only path for user-controlled data (XSS,
// CWE-79).
//
// Usage:
//   html`<div>${userText}</div>`           // escaped
//   html`<div>${html`<b>safe</b>`}</div>`  // composed, not double-escaped
//   raw(items.map((i) => html`<li>${i}</li>`).join(''))  // joined fragments

const escapeMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => escapeMap[ch]);
}

export class RawHtml {
  constructor(value) {
    this.value = String(value ?? '');
  }

  toString() {
    return this.value;
  }
}

export function raw(value) {
  return value instanceof RawHtml ? value : new RawHtml(value);
}

export function html(strings, ...values) {
  let result = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    result += (value instanceof RawHtml ? value.value : escapeHtml(value)) + strings[i + 1];
  }
  return new RawHtml(result);
}

// Join an array of html`` fragments without escaping them.
export function joinHtml(fragments, separator = '') {
  return raw(fragments.map((f) => String(f)).join(separator));
}

// Hidden CSRF input for state-changing forms. The token is random base64url
// (no HTML-special characters), but it goes through escaping anyway.
export function csrfField(csrfToken) {
  return html`<input type="hidden" name="csrf" value="${csrfToken}">`;
}

// Layout wrapper: page structure shared across booking pages. Pass the
// signed-in user (from requireAuth) to render account-aware navigation;
// the sign-out control is a POST form because sign-out is state-changing
// and must carry the CSRF token.
export function layout(title, bodyHtml, { user = null, extraHead = '' } = {}) {
  const accountNav = user
    ? html`
        <a href="/account">My account</a>
        ${user.role === 'admin' ? html`<a href="/admin">Admin</a>` : ''}
        <form method="post" action="/auth/logout" class="nav-signout-form">
          ${csrfField(user.csrfToken)}
          <button type="submit" class="nav-signout">Sign out</button>
        </form>
      `
    : html`<a href="/auth/request-magic-link">Sign in</a>`;

  return html`<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} — Mini &amp; Co. Sensory Classes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Outfit:wght@300;400;500;600&display=swap">
  <link rel="stylesheet" href="/css/styles.css">
  <link rel="stylesheet" href="/css/booking.css">
  ${raw(extraHead)}
</head>
<body class="booking-body">
  <header class="booking-header">
    <div class="booking-header-content">
      <a href="/" class="booking-site-title">Mini &amp; Co.</a>
      <nav class="booking-nav">
        <a href="/book">Book</a>
        ${accountNav}
      </nav>
    </div>
  </header>
  <main class="booking-main">
    ${bodyHtml}
  </main>
  <footer class="booking-footer">
    <p>&copy; 2026 Mini &amp; Co. Sensory Classes · Oran Park, NSW</p>
  </footer>
  <script src="/js/booking-pixel.js" defer></script>
</body>
</html>`;
}

// Standard HTML page response. Security headers are added centrally by the
// entry point; Cache-Control is no-store because booking pages carry PII.
export function pageResponse(title, bodyHtml, { user = null, extraHead = '', status = 200 } = {}) {
  return new Response(String(layout(title, bodyHtml, { user, extraHead })), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
