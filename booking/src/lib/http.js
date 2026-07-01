// HTTP control-flow errors. Handlers throw these; the entry point renders them.
// Security: publicMessage is shown to users — keep it generic. Internal detail
// belongs in logs only (never expose stack traces or database errors).

export class HttpError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export class RedirectError extends Error {
  constructor(location) {
    super(`redirect:${location}`);
    this.location = location;
  }
}

export const badRequest = (msg = 'That request was not valid.') => new HttpError(400, msg);
export const forbidden = (msg = 'You do not have access to that.') => new HttpError(403, msg);
export const notFound = (msg = 'We could not find that page.') => new HttpError(404, msg);
export const tooMany = (msg = 'Too many attempts — please wait a few minutes and try again.') => new HttpError(429, msg);

export function redirect(location, status = 303) {
  // Security: only same-site relative redirects are ever issued from user
  // input; absolute URLs here must be our own (e.g. Stripe URLs are returned
  // direct from the payments driver, not echoed from request parameters).
  return new Response(null, { status, headers: { Location: location } });
}

// Security: prevents open redirects — `next` parameters must be a local path.
export function safeNextPath(next, fallback = '/account') {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.includes('\n') || next.includes('\r')) return fallback;
  if (next.length > 512) return fallback;
  return next;
}
