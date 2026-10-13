// Publishing (site-publishing spec, D11): only the staged allow-list is
// served. The runner places throwaway private files (business/zz-probe.md,
// .DS_Store) in the repo before staging, so these checks prove that a private
// file on disk is still a 404.

export const title = 'Publishing: allow-listed static assets';

export async function run(ctx) {
  ctx.section('Private paths are 404');
  for (const path of [
    '/business/zz-probe.md', '/business/x.md', '/.DS_Store', '/.dev.vars', '/booking/.dev.vars',
    '/CLAUDE.md', '/README.md', '/booking/src/index.js', '/booking/wrangler.toml', '/booking/public/index.html',
    '/openspec/x', '/openspec/project.md', '/scripts/export-banner.py', '/.git/config', '/assets/.DS_Store',
    '/photos-staging/README.md', '/fonts/',
  ]) {
    const res = await fetch(`${ctx.base}${path}`);
    await res.text();
    ctx.check(`${path} → 404`, res.status === 404, `got ${res.status}`);
  }

  ctx.section('Site files are served');
  for (const path of [
    '/', '/classes', '/about', '/contact', '/css/styles.css', '/css/booking.css', '/js/main.js',
    '/js/booking-status.js', '/js/booking-pixel.js', '/robots.txt', '/sitemap.xml', '/assets/logo/logo.svg',
  ]) {
    const res = await fetch(`${ctx.base}${path}`);
    await res.text();
    ctx.check(`${path} → 200`, res.status === 200, `got ${res.status}`);
  }
}
