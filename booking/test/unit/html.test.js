import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, escapeHtml, joinHtml, csrfField, layout } from '../../src/lib/html.js';

test('interpolated values are escaped by default', () => {
  const out = String(html`<p>${'<script>alert(1)</script>'}</p>`);
  assert.equal(out, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('all five HTML-special characters are escaped', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('attribute-context injection is neutralised', () => {
  const out = String(html`<input value="${'" onmouseover="alert(1)'}">`);
  assert.ok(!out.includes('" onmouseover="'));
  assert.ok(out.includes('&quot; onmouseover=&quot;'));
});

test('nested html`` fragments are not double-escaped', () => {
  const inner = html`<b>${'a & b'}</b>`;
  const outer = String(html`<div>${inner}</div>`);
  assert.equal(outer, '<div><b>a &amp; b</b></div>');
});

test('raw() opts out of escaping and is idempotent', () => {
  assert.equal(String(html`${raw('<i>x</i>')}`), '<i>x</i>');
  assert.equal(String(html`${raw(raw('<i>x</i>'))}`), '<i>x</i>');
});

test('joinHtml joins fragments without escaping them', () => {
  const items = ['a<b', 'c'].map((v) => html`<li>${v}</li>`);
  assert.equal(String(joinHtml(items)), '<li>a&lt;b</li><li>c</li>');
});

test('null and undefined render as empty strings', () => {
  assert.equal(String(html`<p>${null}${undefined}</p>`), '<p></p>');
});

test('csrfField escapes the token', () => {
  const out = String(csrfField('abc"><script>'));
  assert.ok(out.includes('value="abc&quot;&gt;&lt;script&gt;"'));
});

test('layout escapes the title and embeds the body unescaped', () => {
  const page = String(layout('<Evil>', html`<h1>${'safe & sound'}</h1>`));
  assert.ok(page.includes('<title>&lt;Evil&gt; — Mini &amp; Co. Sensory Classes</title>'));
  assert.ok(page.includes('<h1>safe &amp; sound</h1>'));
});
