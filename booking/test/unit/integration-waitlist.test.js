// Phase 3: the owner's waitlist page and the family's "place in line" agree —
// both order by join time, then insertion (rowid) — including families who
// join in the same second, an offer still out, and a family the owner puts
// back on the list (who goes to the back, even within the same second).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm } from './helpers.js';
import { loadEntries, addToWaitlist, changeEntry } from '../../src/routes/admin-waitlist.js';
import { listWaitlistEntries } from '../../src/lib/parent-flow.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const T = '2027-01-10T00:00:00Z';

// Line order on the admin page (waiting or offered entries, as rendered).
async function adminLine(termId) {
  return (await loadEntries(env, [termId]))
    .filter((e) => e.status === 'waiting' || e.status === 'offered')
    .map((e) => e.child_name);
}

// Each family's own view: child name → place in line.
async function parentPlaces(userIds, termId) {
  const places = {};
  for (const userId of userIds) {
    for (const e of await listWaitlistEntries(env, userId, { termId })) places[e.child_name] = e.position;
  }
  return places;
}

test('admin order and parent positions agree, ties broken by insertion, re-joins at the back', async () => {
  const term = await seedFamilyAndTerm(env, { prefix: 'wq' });
  const families = [];
  for (const name of ['Ada', 'Bo', 'Cy', 'Di']) {
    const added = await addToWaitlist(env, {
      termId: term.termId, email: `wq-${name.toLowerCase()}@example.com`, parentName: name, childName: name,
      childDob: '2026-02-02', now: T, // all four join in the same second
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    families.push({ name, entryId: added.entryId });
  }
  const users = (await env.DB.prepare(`SELECT id FROM users WHERE email LIKE 'wq-%'`).all()).results.map((u) => u.id);

  assert.deepEqual(await adminLine(term.termId), ['Ada', 'Bo', 'Cy', 'Di'], 'same second: the order they were added');
  assert.deepEqual(await parentPlaces(users, term.termId), { Ada: 1, Bo: 2, Cy: 3, Di: 4 });

  // An offer still out keeps its place in line for both.
  await env.DB.prepare(`UPDATE waitlist SET status = 'offered' WHERE id = ?1`).bind(families[1].entryId).run();
  assert.deepEqual(await parentPlaces(users, term.termId), { Ada: 1, Bo: 2, Cy: 3, Di: 4 });

  // Ada is removed, then added back by phone in that same second: the back.
  assert.equal((await changeEntry(env, families[0].entryId, 'remove')).ok, true);
  assert.deepEqual(await parentPlaces(users, term.termId), { Bo: 1, Cy: 2, Di: 3 }, 'the line closes up');
  const back = await addToWaitlist(env, { termId: term.termId, email: 'wq-ada@example.com', childName: 'Ada', now: T });
  assert.deepEqual([back.ok, back.rejoined, back.entryId], [true, true, families[0].entryId]);
  assert.deepEqual(await adminLine(term.termId), ['Bo', 'Cy', 'Di', 'Ada']);
  assert.deepEqual(await parentPlaces(users, term.termId), { Bo: 1, Cy: 2, Di: 3, Ada: 4 });

  // Put back by the owner ("restore") keeps the original place instead.
  assert.equal((await changeEntry(env, families[2].entryId, 'remove')).ok, true);
  assert.equal((await changeEntry(env, families[2].entryId, 'restore')).ok, true);
  assert.deepEqual(await adminLine(term.termId), ['Bo', 'Cy', 'Di', 'Ada']);
  assert.deepEqual(await parentPlaces(users, term.termId), { Bo: 1, Cy: 2, Di: 3, Ada: 4 });
});
