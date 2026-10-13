// Parent waitlist (Phase 2A — waitlist spec, design D7): join a term's
// waitlist from the class list when it has no seat; entries show on the
// account page. Phase 1 registers the route with a placeholder page so later
// work never touches index.js.

import { html, pageResponse } from '../lib/html.js';
import { requireAuthOrRedirect } from '../lib/middleware.js';

// GET /book/waitlist[?term=…]
export async function handleWaitlistPage(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  const body = html`
    <h1>Waitlist</h1>
    <p class="lede">Coming soon — joining a term's waitlist online is on its way. In the meantime,
      email <a href="mailto:miniandco.classes@gmail.com">miniandco.classes@gmail.com</a> and we'll add you.</p>
    <p><a href="/book" class="button-link">Back to classes</a></p>
  `;
  return pageResponse('Waitlist', body, { user, pixel: true });
}

export function registerRoutes(route) {
  route('GET', '/book/waitlist', handleWaitlistPage);
}
