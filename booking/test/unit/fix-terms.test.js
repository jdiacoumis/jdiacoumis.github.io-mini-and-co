// Review fixes (task 3.2) — creating terms:
//   * one term name per class is enforced by the database (migration 0003),
//     and the New term form turns a concurrent duplicate into a plain
//     message instead of a second term;
//   * finding 7: "Also create for" puts each class's sessions in the same
//     Monday–Sunday weeks as the primary class's (an earlier weekday moves
//     back, not into the following week), a holiday date skips its whole
//     week for every class, and holiday dates in no week of the term are
//     shown to the owner.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb, signedIn, formRequest, outcome, routeHandler, iso,
} from './helpers.js';
import { createTermsWithSessions, planTermDates, sameWeekDate, weekOf } from '../../src/lib/admin-ops.js';
import * as adminTerms from '../../src/routes/admin-terms.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const count = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).first()).n;

async function addClass(id, { weekday = 3, time = '11:00', name = id } = {}) {
  await run(`INSERT INTO classes (id, name, weekday, start_time, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    id, name, weekday, time, iso(Date.now()));
}

const spec = (classId, name) => ({
  classId, name, startsOn: '2031-02-05', endsOn: '2031-02-12', termPriceCents: 16800, casualPriceCents: 3000,
  sessions: [{ startsAt: '2031-02-05T00:00:00Z' }, { startsAt: '2031-02-12T00:00:00Z' }], durationMins: 45, capacity: 12,
});

test('the database refuses a second term with the same name for a class (any case), atomically', async () => {
  await addClass('tu-class');
  await createTermsWithSessions(env, [spec('tu-class', 'Term 1 2031')]);
  await assert.rejects(createTermsWithSessions(env, [spec('tu-class', 'term 1 2031')]), /constraint/i);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM terms WHERE class_id = 'tu-class'`), 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM class_sessions WHERE class_id = 'tu-class'`), 2, 'no orphan sessions');
  await addClass('tu-other');
  await createTermsWithSessions(env, [spec('tu-other', 'Term 1 2031')]); // another class may reuse the name
});

test('two quick submits of the New term form create one term; the second gets a plain message', async () => {
  await addClass('tu-form', { weekday: 3 });
  const admin = await signedIn(env, 'owner@example.com');
  const post = routeHandler(adminTerms, 'POST', '/admin/terms/new');
  const body = {
    csrf: admin.csrf, class_id: 'tu-form', name: 'Term 2 2031', starts_on: '2031-04-30', weeks: '3', ends_on: '',
    holidays: '', term_price: '168', casual_price: '30', trial_price: '', returning_price: '', returning_opens_at: '',
    public_opens_at: '', previous_term_id: 'auto', plan_instalments: '0', plan_interval: 'week',
  };
  const send = () => outcome(post(formRequest('POST', '/admin/terms/new', { cookie: admin.cookie, form: body }), env, {}));
  const results = await Promise.all([send(), send()]);
  // The second submit is refused either by the page's own check (400) or —
  // when both passed it at once — by the database (409); never a second term.
  const statuses = results.map((r) => r.status).sort((a, b) => a - b);
  assert.ok(statuses[0] === 303 && [400, 409].includes(statuses[1]), JSON.stringify(statuses));
  const refused = results.find((r) => r.status !== 303);
  assert.match(await refused.text(), /already (exists for this class|has a term called)/);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM terms WHERE class_id = 'tu-form'`), 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM class_sessions WHERE class_id = 'tu-form'`), 3);
});

test('when the page check is passed (the race), the database refusal shows the plain message', async () => {
  await addClass('tu-race', { weekday: 3 });
  await createTermsWithSessions(env, [spec('tu-race', 'Term 3 2031')]);
  // The page's own "name taken" query answers "no", as it would for a submit
  // that ran it before the other one had written its term.
  const blind = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql) => target.prepare(sql.includes('lower(trim(name)) = lower(trim(?2))')
            ? 'SELECT NULL AS yes WHERE ?1 IS NULL AND ?2 IS NULL AND ?3 IS NULL'
            : sql);
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  const admin = await signedIn(env, 'owner@example.com');
  const post = routeHandler(adminTerms, 'POST', '/admin/terms/new');
  const res = await outcome(post(formRequest('POST', '/admin/terms/new', {
    cookie: admin.cookie,
    form: {
      csrf: admin.csrf, class_id: 'tu-race', name: 'TERM 3 2031', starts_on: '2031-07-23', weeks: '2', ends_on: '',
      holidays: '', term_price: '168', casual_price: '30', previous_term_id: 'auto', plan_instalments: '0', plan_interval: 'week',
    },
  }), blind, {}));
  assert.equal(res.status, 409);
  assert.match(await res.text(), /already exists for this class/);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM terms WHERE class_id = 'tu-race'`), 1);
});

// --- Finding 7 ------------------------------------------------------------------

test('a holiday date skips the class in its Monday–Sunday week; dates in no week of the term are reported', () => {
  // Wednesdays from 3 Feb 2027; Monday 8 March is in the week of Wednesday 10 March.
  const plan = planTermDates({ startsOn: '2027-02-03', weeks: 10, skipDates: ['2027-03-08', '2027-05-05'], weekday: 3 });
  assert.equal(plan.dates.length, 9);
  assert.deepEqual(plan.skipped, ['2027-03-10']);
  assert.deepEqual(plan.unusedSkipDates, ['2027-05-05']);
  assert.equal(weekOf('2027-03-14'), '2027-03-08', 'Sunday belongs to the week that began on Monday');
  assert.equal(sameWeekDate('2027-03-10', 1), '2027-03-08', 'Monday of a Wednesday\'s week is two days earlier');
  assert.equal(sameWeekDate('2027-03-10', 0), '2027-03-14', 'Sunday ends that week');
});

test('Monday + Wednesday from one form: the same weeks, the same holiday week skipped, unused holidays shown', async () => {
  await addClass('tw-wed', { weekday: 3, time: '10:00', name: 'TW Wednesday' });
  await addClass('tw-mon', { weekday: 1, time: '11:30', name: 'TW Monday' });
  const admin = await signedIn(env, 'owner@example.com');
  const res = await outcome(routeHandler(adminTerms, 'POST', '/admin/terms/new')(formRequest('POST', '/admin/terms/new', {
    cookie: admin.cookie,
    form: {
      csrf: admin.csrf, class_id: 'tw-wed', also: 'tw-mon', name: 'Term 1 2032', starts_on: '2032-02-04', weeks: '6', ends_on: '',
      holidays: '2032-02-18\n2032-07-07', term_price: '150', casual_price: '30', previous_term_id: 'auto',
      plan_instalments: '0', plan_interval: 'week',
    },
  }), env, {}));
  assert.equal(res.status, 303);
  const location = res.headers.get('Location');
  assert.match(location, /ok=terms-created&unused=2032-07-07$/);
  const dates = async (classId) => (await env.DB.prepare(
    `SELECT starts_at FROM class_sessions WHERE class_id = ?1 ORDER BY starts_at`,
  ).bind(classId).all()).results.map((r) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(r.starts_at)));
  assert.deepEqual(await dates('tw-wed'), ['2032-02-04', '2032-02-11', '2032-02-25', '2032-03-03', '2032-03-10']);
  assert.deepEqual(await dates('tw-mon'), ['2032-02-02', '2032-02-09', '2032-02-23', '2032-03-01', '2032-03-08'],
    'Mondays of the same weeks — not the week after — and the holiday week skipped');
  const termId = new URL(location, 'http://x').pathname.split('/').pop();
  const grid = await routeHandler(adminTerms, 'GET', '/admin/terms/:id')(
    formRequest('GET', location, { cookie: admin.cookie }), env, { id: termId });
  const text = await grid.text();
  assert.match(text, /This holiday date was\s+not in any week of the term, so it was not used: Wed,? 7 Jul(y)? 2032/);
});
