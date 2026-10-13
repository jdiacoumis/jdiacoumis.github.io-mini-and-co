// Cross-feature (Phase 3): publishing after the merge. The scripts the
// Phase 2 pages load are staged and served (js/booking-picker.js, used by
// the class list's casual picker), the class list loads it from our own
// origin with no inline script, and the files Phase 3 added under booking/
// (the dev migration, the e2e support module) are never served.

export const title = 'Cross-feature: staged scripts served, new private files not';

export async function run(ctx) {
  ctx.section('Scripts the pages load');
  for (const path of ['/js/booking-picker.js', '/js/booking-status.js', '/js/booking-pixel.js']) {
    const res = await fetch(`${ctx.base}${path}`);
    const text = await res.text();
    ctx.check(`${path} → 200 JavaScript`, res.status === 200 && /javascript/.test(res.headers.get('Content-Type') || '') && text.length > 100,
      `HTTP ${res.status} ${res.headers.get('Content-Type')}`);
  }
  const picker = await (await fetch(`${ctx.base}/js/booking-picker.js`)).text();
  ctx.check('it is the casual-class picker', picker.includes('data-casual-picker') && picker.includes('data-casual-total'));
  const list = await ctx.fetch('/book');
  ctx.check('the class list loads it from our origin', list.text.includes('<script src="/js/booking-picker.js" defer></script>')
    && list.text.includes('data-casual-picker'));
  ctx.check('no inline script on the class list', !/<script>(?!<\/script>)/.test(list.text) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(list.text));
  ctx.check("the CSP allows only our scripts (and Meta's)", (list.headers.get('Content-Security-Policy') || '').includes("script-src 'self' https://connect.facebook.net"));

  ctx.section('Private files stay private');
  for (const path of ['/booking/migrations/0002_dev_outbox.sql', '/migrations/0002_dev_outbox.sql', '/booking/test/e2e/support.js',
    '/test/e2e/support.js', '/booking/.dev.vars', '/js/../booking/wrangler.toml']) {
    const res = await fetch(`${ctx.base}${path}`);
    await res.text();
    ctx.check(`${path} → 404`, res.status === 404, `HTTP ${res.status}`);
  }
}
