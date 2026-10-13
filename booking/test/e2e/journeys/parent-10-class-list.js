// Class list (booking-flow spec, D3): each class with its open terms — the
// whole-term price, "join for the remaining N weeks" once started, the
// returning-family window and price, opening times honoured, places left,
// casual dates with their price and places, one trial per child across
// classes, and Join the waitlist when a term is full. Scenarios run on terms
// created here (closed again at the end), so other journeys' changes to the
// seed terms cannot disturb them.

export const title = 'Parent: class list prices, windows, places, trial, waitlist';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const at = (days) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '${days} days')`;

// A term of weekly sessions starting `firstDay` days from now, in a new class
// (or in the class of `classKey`). SQL values are passed as SQL literals.
function createTerm(ctx, {
  key, classKey = null, className = '', termName, weeks = 6, firstDay = 1, capacity = 12, termPrice = 16800,
  casual = 3000, publicOpensAt = 'NULL', returningOpensAt = 'NULL', previousTermId = 'NULL', returningPrice = 'NULL',
  plan = 6, status = 'open',
}) {
  const classId = `cls-${classKey || key}`;
  const termId = `term-${key}`;
  if (!classKey) {
    ctx.sqlWrite(`INSERT INTO classes (id, name, description, venue, age_range, weekday, start_time, default_duration_mins,
                                       default_capacity, active, created_at)
                  VALUES ('${classId}', '${className}', 'An e2e class.', 'Test Hall', '3–12 months', 4, '10:00', 45, ${capacity}, 1, ${NOW})`);
  }
  ctx.sqlWrite(`INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents, returning_price_cents,
                                   returning_opens_at, public_opens_at, previous_term_id, plan_instalments, plan_interval, status, created_at)
                VALUES ('${termId}', '${classId}', '${termName}', date('now', '${firstDay} days'), date('now', '${firstDay + 7 * (weeks - 1)} days'),
                        ${termPrice}, ${casual}, ${returningPrice}, ${returningOpensAt}, ${publicOpensAt}, ${previousTermId}, ${plan}, 'week',
                        '${status}', ${NOW})`);
  const rows = Array.from({ length: weeks }, (_, i) => `('${termId}-w${i + 1}', '${classId}', '${termId}', ${at(firstDay + 7 * i)},
    45, ${capacity}, ${casual}, 'scheduled', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO class_sessions (id, class_id, term_id, starts_at, duration_mins, capacity, casual_price_cents, status, created_at)
                VALUES ${rows.join(', ')}`);
  return termId;
}

// Another family takes every remaining seat of a term.
function fillTerm(ctx, termId, key) {
  ctx.sqlWrite(`INSERT INTO users (id, email, created_at) VALUES ('${key}-user', '${key}@example.com', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('${key}-child', '${key}-user', 'Filler', '2025-09-01', ${NOW})`);
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
                VALUES ('${key}-booking', '${key}-user', '${key}-child', 'term', '${termId}', 'confirmed', 0, ${NOW})`);
  ctx.sqlWrite(`INSERT INTO booking_sessions (booking_id, session_id, status)
                SELECT '${key}-booking', id, 'booked' FROM class_sessions WHERE term_id = '${termId}' AND starts_at > ${NOW}`);
}

// The class-list markup of one term (up to the next group or the card's end).
function termBlock(html, termId) {
  const start = html.indexOf(`id="term-${termId}"`);
  if (start === -1) return '';
  const rest = html.slice(start + 1);
  const ends = [rest.indexOf('class="term-group'), rest.indexOf('</section>')].filter((i) => i !== -1);
  return html.slice(start, start + 1 + (ends.length ? Math.min(...ends) : rest.length));
}

async function newParent(ctx, email, childName) {
  const cookie = await ctx.signIn(email);
  const csrf = await ctx.csrfFor(cookie);
  await ctx.fetch('/account/children/new', {
    method: 'POST', cookie, body: { csrf, name: childName, dob: '2025-10-15', medical: '', photo_consent: 'yes' },
  });
  const [user] = ctx.sql(`SELECT id FROM users WHERE email = '${email}'`);
  const [child] = ctx.sql(`SELECT id FROM children WHERE user_id = '${user.id}' AND name = '${childName}'`);
  return { cookie, csrf, userId: user.id, childId: child.id };
}

export async function run(ctx) {
  const started = createTerm(ctx, { key: 'pf-started', className: 'PF Started Class', termName: 'Started Term', firstDay: -13 });
  const full = createTerm(ctx, { key: 'pf-full', className: 'PF Full Class', termName: 'Full Term', weeks: 3, capacity: 1 });
  fillTerm(ctx, full, 'e2e-pf-filler');
  const later = createTerm(ctx, { key: 'pf-later', className: 'PF Later Class', termName: 'Later Term', publicOpensAt: at(5) });
  const whole = createTerm(ctx, { key: 'pf-whole', className: 'PF Whole Class', termName: 'Whole Term', firstDay: 2 });

  ctx.section('Prices and places (signed out)');
  const list = (await ctx.fetch('/book')).text;
  const wholeBlock = termBlock(list, whole);
  ctx.check('a term that has not started shows the whole-term price', wholeBlock.includes('Whole term, 6 weeks — $168.00'));
  ctx.check('the term card offers a plan and shows places left',
    wholeBlock.includes('or 6 weekly payments of $28.00') && wholeBlock.includes('12 places left') && wholeBlock.includes('Book the term'));
  const startedBlock = termBlock(list, started);
  ctx.check('a started term offers the remaining weeks at the pro-rata price',
    startedBlock.includes('Join for the remaining 4 weeks — $112.00') && startedBlock.includes('Join the term'), startedBlock.slice(0, 400));
  ctx.check('a started term offers its remaining dates as casual classes with price and places',
    startedBlock.includes('$30.00 each') && (startedBlock.match(/name="session" value="term-pf-started-w\d"/g) || []).length === 4
      && startedBlock.includes('12 places left') && !startedBlock.includes('term-pf-started-w1"'));
  const fullBlock = termBlock(list, full);
  ctx.check('a full term offers its waitlist instead of a booking',
    fullBlock.includes('This term is full') && fullBlock.includes(`href="/book/waitlist?term=${full}"`)
      && !fullBlock.includes(`kind=term&amp;term=${full}`), fullBlock.slice(0, 400));
  const laterBlock = termBlock(list, later);
  ctx.check('a term that is not open yet shows when bookings open and nothing to book',
    laterBlock.includes('Bookings open') && !laterBlock.includes('kind=term') && !laterBlock.includes('name="session"')
      && !laterBlock.includes('Families enrolled last term'), laterBlock.slice(0, 400));
  ctx.check('classes are grouped with their terms', list.indexOf('PF Started Class') < list.indexOf('Started Term'));

  ctx.section('Returning-family window');
  // Last term (closed) and the next one: open to its families since
  // yesterday at $150, to everyone in two days at $168.
  const prev = createTerm(ctx, { key: 'pf-prev', className: 'PF Returning Class', termName: 'Earlier Term', firstDay: -60, status: 'closed' });
  const next = createTerm(ctx, {
    key: 'pf-next', classKey: 'pf-prev', termName: 'Next Term', firstDay: 3, previousTermId: `'${prev}'`,
    returningPrice: 15000, returningOpensAt: at(-1), publicOpensAt: at(2),
  });
  const anon = termBlock((await ctx.fetch('/book')).text, next);
  ctx.check('signed out: bookings open later, returning families early, returning price mentioned',
    anon.includes('Bookings open') && anon.includes('Families enrolled last term can book early')
      && anon.includes('sign in') && anon.includes('$150.00') && !anon.includes(`kind=term&amp;term=${next}`), anon.slice(0, 500));

  const newcomer = await newParent(ctx, 'e2e-pf-newcomer@example.com', 'Nell');
  const newBlock = termBlock((await ctx.fetch('/book', { cookie: newcomer.cookie })).text, next);
  ctx.check('a new family sees the opening date and cannot book',
    newBlock.includes('Bookings open') && !newBlock.includes(`kind=term&amp;term=${next}`) && !newBlock.includes('name="session"'),
    newBlock.replace(/\s+/g, ' '));
  const refused = await ctx.fetch(`/book/checkout?kind=term&term=${next}`, { cookie: newcomer.cookie });
  ctx.check('a new family is refused at checkout before public opening',
    refused.status === 409 && refused.text.includes('Not open yet') && refused.text.includes('Families enrolled last term'), `HTTP ${refused.status}`);
  const casualRefused = await ctx.fetch(`/book/checkout?kind=casual&term=${next}&session=${next}-w4`, { cookie: newcomer.cookie });
  ctx.check('casual classes follow the opening time too', casualRefused.status === 409 && casualRefused.text.includes('Not open yet'));

  const back = await newParent(ctx, 'e2e-pf-returning@example.com', 'Rosie');
  ctx.sqlWrite(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
                VALUES ('e2e-pf-prev-booking', '${back.userId}', '${back.childId}', 'term', '${prev}', 'confirmed', 16800, ${at(-60)})`);
  const backBlock = termBlock((await ctx.fetch('/book', { cookie: back.cookie })).text, next);
  ctx.check('a returning family sees the returning price and the early window',
    backBlock.includes('Whole term, 6 weeks — $150.00') && backBlock.includes('returning family price')
      && backBlock.includes('Returning families only until') && backBlock.includes(`kind=term&amp;term=${next}`), backBlock.slice(0, 500));
  const review = await ctx.fetch(`/book/checkout?kind=term&term=${next}`, { cookie: back.cookie });
  ctx.check('the returning family checks out at the returning price',
    review.status === 200 && review.text.includes('$150.00 AUD') && review.text.includes('(returning family price)'));
  const pay = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie: back.cookie,
    body: { csrf: back.csrf, kind: 'term', term: next, child: back.childId, photo_consent: 'yes', medical: '', waiver: 'accepted' },
  });
  const bookingId = /booking=([a-f0-9-]+)/.exec(pay.location)?.[1];
  const ref = /ref=([A-Za-z0-9_]+)/.exec(pay.location)?.[1];
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie: back.cookie, body: { csrf: back.csrf, booking: bookingId, ref, outcome: 'pay' } });
  const [row] = ctx.sql(`SELECT status, amount_cents FROM bookings WHERE id = '${bookingId}'`);
  ctx.check('the booking is confirmed at $150.00', row && row.status === 'confirmed' && row.amount_cents === 15000, JSON.stringify(row));
  const after = termBlock((await ctx.fetch('/book', { cookie: back.cookie })).text, next);
  ctx.check('the class list then shows the child booked in, with no second Book button',
    after.includes('Rosie is booked in for this term') && !after.includes(`kind=term&amp;term=${next}`));

  ctx.section('One trial per child, across classes');
  const trialler = await newParent(ctx, 'e2e-pf-trial@example.com', 'Tilly');
  const before = (await ctx.fetch('/book', { cookie: trialler.cookie })).text;
  const trialSession = new RegExp(`kind=trial&amp;term=${started}&amp;session=([A-Za-z0-9-]+)`).exec(before)?.[1];
  ctx.check('every open term offers a trial before the child has had one',
    Boolean(trialSession) && before.includes(`kind=trial&amp;term=${whole}&amp;session=`) && before.includes('Choose a different week for the trial'));
  const trial = await ctx.fetch('/book/checkout', {
    method: 'POST', cookie: trialler.cookie,
    body: { csrf: trialler.csrf, kind: 'trial', term: started, session: trialSession, child: trialler.childId, photo_consent: 'no', medical: '', waiver: 'accepted' },
  });
  const trialId = /booking=([a-f0-9-]+)/.exec(trial.location)?.[1];
  const trialRef = /ref=([A-Za-z0-9_]+)/.exec(trial.location)?.[1];
  await ctx.fetch('/dev/mock-checkout', { method: 'POST', cookie: trialler.cookie, body: { csrf: trialler.csrf, booking: trialId, ref: trialRef, outcome: 'pay' } });
  const afterTrial = (await ctx.fetch('/book', { cookie: trialler.cookie })).text;
  ctx.check('once the trial is booked no class offers this child another', !afterTrial.includes('kind=trial'));
  const another = await ctx.fetch(`/book/checkout?kind=trial&term=${whole}&session=${whole}-w2&child=${trialler.childId}`, { cookie: trialler.cookie });
  ctx.check('a trial in a different class is refused', another.status === 409 && another.text.includes('Trial already booked'));

  ctx.sqlWrite(`UPDATE terms SET status = 'closed' WHERE id IN ('${started}', '${full}', '${later}', '${next}', '${whole}')`);
}
