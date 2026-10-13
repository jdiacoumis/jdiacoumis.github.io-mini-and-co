// Publishing (site-publishing spec, D11): only the staged allow-list is
// served. The runner places throwaway private files in the repository before
// staging (ctx.probes: outside the allow-list, and inside allow-listed
// folders a dotfile, a junk file and a symlink to a private file), so each
// check below proves that a file that IS on disk is still a 404 — the
// allow-list and its filters keep it out, not its absence. Static pages
// carry the security headers from the staged public/_headers.

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const title = 'Publishing: allow-listed static assets';

function onDisk(ctx, path) {
  const full = join(ctx.repo, path.replace(/^\//, ''));
  try {
    return existsSync(full) || lstatSync(full).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function run(ctx) {
  ctx.section('Private files on disk are 404');
  const paths = [
    ...ctx.probes.map((p) => `/${p}`),
    '/CLAUDE.md', '/README.md', '/booking/.dev.vars', '/booking/src/index.js', '/booking/wrangler.toml',
    '/booking/public/index.html', '/scripts/export-banner.py', '/.git/config', '/photos-staging/README.md',
  ];
  for (const path of paths) {
    const res = await fetch(`${ctx.base}${path}`);
    await res.text();
    ctx.check(`${path} exists on disk → 404`, onDisk(ctx, path) && res.status === 404, `on disk: ${onDisk(ctx, path)}, got ${res.status}`);
  }
  const fonts = await fetch(`${ctx.base}/fonts/`);
  await fonts.text();
  ctx.check('/fonts/ (a folder outside the allow-list) → 404', existsSync(join(ctx.repo, 'fonts')) && fonts.status === 404);
  const headersFile = await fetch(`${ctx.base}/_headers`);
  await headersFile.text();
  ctx.check('the staged _headers file itself is not served', headersFile.status === 404, `got ${headersFile.status}`);

  ctx.section('Site files are served');
  for (const path of [
    '/', '/classes', '/about', '/contact', '/css/styles.css', '/css/booking.css', '/js/main.js',
    '/js/booking-status.js', '/js/booking-pixel.js', '/js/admin-continue.js', '/robots.txt', '/sitemap.xml', '/assets/logo/logo.svg',
  ]) {
    const res = await fetch(`${ctx.base}${path}`);
    await res.text();
    ctx.check(`${path} → 200`, res.status === 200, `got ${res.status}`);
  }

  ctx.section('Static pages carry the security headers');
  for (const path of ['/', '/classes', '/css/styles.css']) {
    const res = await fetch(`${ctx.base}${path}`);
    await res.text();
    const h = (name) => res.headers.get(name) || '';
    ctx.check(`${path}: HSTS, nosniff, referrer policy, no framing`,
      h('Strict-Transport-Security').includes('max-age=31536000') && h('X-Content-Type-Options') === 'nosniff'
        && h('Referrer-Policy') === 'strict-origin-when-cross-origin' && h('Content-Security-Policy').includes("frame-ancestors 'none'")
        && h('X-Frame-Options') === 'DENY',
      JSON.stringify(Object.fromEntries(res.headers)));
  }
  const home = await (await fetch(`${ctx.base}/`)).text();
  ctx.check("the marketing page's inline pixel snippet is not blocked by its CSP (no script-src in it)",
    home.includes('fbevents.js') && !/script-src/.test((await fetch(`${ctx.base}/`)).headers.get('Content-Security-Policy') || ''));
}
