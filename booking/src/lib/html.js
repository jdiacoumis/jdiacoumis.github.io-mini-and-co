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
  // Same header markup and classes as the static marketing pages (styles.css
  // already ships the styling and js/main.js the mobile toggle) — with
  // root-absolute hrefs because booking pages live under nested paths, plus
  // the account-aware items. Sign-out is a POST form (state-changing, CSRF).
  const accountNav = user
    ? html`
        <li><a class="site-nav__link" href="/account">My account</a></li>
        ${user.role === 'admin' ? html`<li><a class="site-nav__link" href="/admin">Admin</a></li>` : ''}
        <li>
          <form method="post" action="/auth/logout" class="nav-signout-form">
            ${csrfField(user.csrfToken)}
            <button type="submit" class="site-nav__link nav-signout">Sign out</button>
          </form>
        </li>
      `
    : html`<li><a class="site-nav__link" href="/auth/request-magic-link">Sign in</a></li>`;

  return html`<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} — Mini &amp; Co. Sensory Classes</title>
  <meta name="theme-color" content="#faf6f1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Outfit:wght@300;400;500;600&display=swap">
  <link rel="stylesheet" href="/css/styles.css">
  <link rel="stylesheet" href="/css/booking.css">
  ${raw(extraHead)}
</head>
<body class="booking-body">
  <header class="site-header">
    <div class="container site-header__inner">
      <a class="site-logo" href="/" aria-label="Mini &amp; Co. — home">
        <img src="/assets/logo/logo.svg" alt="Mini &amp; Co. Sensory Classes">
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-nav" aria-label="Toggle menu" data-nav-toggle>
        <span class="nav-toggle__bar" aria-hidden="true"></span>
      </button>
      <nav class="site-nav" id="primary-nav" data-site-nav aria-label="Primary">
        <ul class="site-nav__list">
          <li><a class="site-nav__link" href="/">Home</a></li>
          <li><a class="site-nav__link" href="/classes.html">Classes</a></li>
          <li><a class="site-nav__link" href="/book">Book</a></li>
          ${accountNav}
        </ul>
      </nav>
    </div>
  </header>
  <main class="booking-main">
    ${bodyHtml}
  </main>
  <footer class="site-footer">
    <div class="container site-footer__inner">
      <div>
        <h2>Mini &amp; Co.</h2>
        <p>Evidence-based sensory classes for little ones 3–12 months and their mums, in Oran Park, NSW.</p>
      </div>
      <div>
        <h3>Visit</h3>
        <ul class="site-footer__list">
          <li>Sandown Room</li>
          <li>Oran Park Library</li>
          <li>72 Central Ave</li>
          <li>Oran Park NSW 2570</li>
        </ul>
      </div>
      <div>
        <h3>Stay in touch</h3>
        <ul class="site-footer__list">
          <li><a href="mailto:miniandco.classes@gmail.com">miniandco.classes@gmail.com</a></li>
          <li><a href="https://instagram.com/miniandco.classes" rel="noopener noreferrer" target="_blank">@miniandco.classes</a></li>
        </ul>
      </div>
    </div>
    <div class="container site-footer__bottom">
      © 2026 Mini &amp; Co. Sensory Classes
    </div>
  </footer>
  <script src="/js/main.js" defer></script>
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
