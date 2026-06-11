// Secure HTML templating: default auto-escaping, explicit opt-out for raw HTML.
// Uses a tagged template literal that escapes all interpolations by default,
// with a raw() marker for the rare cases where you need unescaped content
// (e.g. rendered form fields, trusted server-side markup).
//
// Usage:
//   html`<div>${message}</div>`  // message is escaped
//   html`<div>${raw(trustedHtml)}</div>`  // trustedHtml is NOT escaped

const escapeMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (ch) => escapeMap[ch]);
}

export class RawHtml {
  constructor(value) {
    this.value = value;
  }
}

export function raw(value) {
  return new RawHtml(value);
}

export function html(strings, ...values) {
  let result = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const escaped = value instanceof RawHtml ? value.value : escapeHtml(value);
    result += escaped + strings[i + 1];
  }
  return result;
}

// Layout wrapper: page structure shared across booking pages.
export function layout(title, bodyHtml, extraHead = '') {
  return html`<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Mini & Co. Sensory Classes</title>
  <link rel="stylesheet" href="/css/styles.css">
  <link rel="stylesheet" href="/booking.css">
  ${raw(extraHead)}
</head>
<body>
  <header class="site-header">
    <div class="site-header-content">
      <a href="/" class="site-title">Mini & Co.</a>
      <nav class="site-nav">
        <a href="/">Home</a>
        <a href="/classes.html">Classes</a>
        <a href="/about.html">About</a>
        <a href="/contact.html">Contact</a>
      </nav>
    </div>
  </header>
  <main class="booking-main">
    ${raw(bodyHtml)}
  </main>
  <footer class="site-footer">
    <div class="site-footer-content">
      <p>&copy; 2026 Mini & Co. All rights reserved.</p>
      <p><a href="mailto:miniandco.classes@gmail.com">miniandco.classes@gmail.com</a></p>
    </div>
  </footer>
</body>
</html>`;
}

// Form field helpers: render input elements with proper escaping and attributes.
export function formInput(name, value = '', type = 'text', attrs = '') {
  const escaped = escapeHtml(value);
  return raw(`<input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escaped}" ${attrs}>`);
}

export function formTextarea(name, value = '', attrs = '') {
  const escaped = escapeHtml(value);
  return raw(`<textarea name="${escapeHtml(name)}" ${attrs}>${escaped}</textarea>`);
}

export function formSelect(name, options, selectedValue = '', attrs = '') {
  let html = `<select name="${escapeHtml(name)}" ${attrs}>`;
  for (const opt of options) {
    const selected = opt.value === selectedValue ? ' selected' : '';
    html += `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += '</select>';
  return raw(html);
}
