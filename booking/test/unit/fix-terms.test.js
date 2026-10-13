// Review fixes (task 3.2) — creating terms: one term name per class is
// enforced by the database (migration 0003), and the New term form turns a
// concurrent duplicate into a plain message instead of a second term.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb, signedIn, formRequest, outcome, routeHandler, iso,
} from './helpers.js';
import { createTermsWithSessions } from '../../src/lib/admin-ops.js';
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
