// A stand-in for api.stripe.com in unit tests: fetch is replaced while a test
// runs; each request is matched against [method, path regexp, handler] rules
// (handler(url, params, init) → JSON body, or { status, body }). Every call is
// recorded with its headers, so tests can check what was sent.
//   const stripe = fakeStripe([['GET', /^\/v1\/refunds/, () => ({ data: [] })]]);
//   … stripe.calls … stripe.restore();
// Unmatched requests answer 404 resource_missing (and are recorded).

export function fakeStripe(rules = []) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.stripe.com') return realFetch(input, init);
    const method = init.method || 'GET';
    const params = init.body ? new URLSearchParams(String(init.body)) : url.searchParams;
    const call = { method, path: url.pathname, url, params, headers: { ...(init.headers || {}) } };
    calls.push(call);
    for (const [m, pattern, handler] of rules) {
      if (m !== method || !pattern.test(url.pathname)) continue;
      const out = await handler(url, params, init);
      const { status, body } = out && Object.hasOwn(out, 'status') && Object.hasOwn(out, 'body') ? out : { status: 200, body: out };
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    calls,
    rules,
    restore() { globalThis.fetch = realFetch; },
  };
}

// The env a test passes to code that should talk to (fake) Stripe.
export function stripeEnv(env) {
  return { ...env, PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_fake' };
}
