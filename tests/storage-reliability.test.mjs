import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { installFrozenSchedulerFixture } from './helpers/frozen-scheduler-fixture.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const { addDays, localDateFromDate } = await import('../src/domain/scheduling/local-date.ts');

const today = localDateFromDate(new Date());

async function fixture() {
  const h = createDatabase();
  await repository.initializeLocalDatabase(h.database);
  await installFrozenSchedulerFixture(h.database);
  const snapshot = await repository.loadPlannerSnapshot(h.database, today);
  const chore = snapshot.chores.find((item) => !item.archived);
  await repository.completeFirstSetup(h.database, {
    frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { unknownReason: 'unknown' } }, weatherLocation: null,
  });
  const plan = await repository.loadPlannerSnapshot(h.database, today);
  return { ...h, chore, chores: snapshot.chores.filter((item) => !item.archived), entry: plan.scheduleEntries.find((item) => item.choreId === chore.id) };
}

test('a stale guide cannot record an incomplete attempt or reopen Google Tasks after its chore was disabled', async () => {
  const h = await fixture();
  try {
    await repository.upsertGoogleTaskLink(h.database, {
      scheduleEntryId: h.entry.id, householdId: h.chore.householdId, choreId: h.chore.id,
      googleTaskListId: 'synthetic-list', googleTaskId: 'synthetic-task', lastSyncedStatus: 'needsAction',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await repository.setChoreEnabled(h.database, h.chore.id, false);
    const writes = h.writes.length;
    assert.equal(await repository.recordIncompleteChore(h.database, h.entry), false);
    assert.equal(h.writes.length, writes);
    assert.equal(h.connection.prepare('SELECT count(*) AS count FROM chore_completions').get().count, 0);
    assert.equal((await repository.listGoogleTaskLinks(h.database))[0].pendingStatus, undefined);
    await repository.setChoreEnabled(h.database, h.chore.id, true);
    assert.equal(await repository.recordIncompleteChore(h.database, h.entry, repository.LOCAL_MEMBER_ID), true);
    const first = h.connection.prepare('SELECT * FROM chore_completions').get();
    assert.equal(first.outcome, 'incomplete');
    assert.equal((await repository.listGoogleTaskLinks(h.database))[0].pendingStatus, 'needsAction');
    assert.equal(await repository.recordIncompleteChore(h.database, h.entry), true);
    assert.equal(h.connection.prepare('SELECT count(*) AS count FROM chore_completions').get().count, 1);
    assert.equal(await repository.completeChore(h.database, h.entry), true);
    assert.equal(await repository.recordIncompleteChore(h.database, h.entry), false);
    assert.equal(h.connection.prepare('SELECT id, outcome FROM chore_completions').get().id, first.id);
    assert.equal(h.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'completed');
  } finally { h.connection.close(); }
});

for (const name of ['completeChore', 'recordIncompleteChore']) {
  test(`${name} rejects missing chores, foreign households and synthetic initial occurrences without writing`, async () => {
    const h = await fixture();
    try {
      for (const entry of [{ ...h.entry, choreId: 'missing' }, { ...h.entry, householdId: 'other-home' },
        { ...h.entry, id: 'synthetic', status: 'initialPending' }]) {
        const before = h.writes.length;
        assert.equal(await repository[name](h.database, entry), false);
        assert.equal(h.writes.length, before);
      }
    } finally { h.connection.close(); }
  });
}

test('the guide submits an incomplete action once per tap sequence and allows retry after failure', async () => {
  const h = await fixture();
  try {
    const snapshot = await repository.loadPlannerSnapshot(h.database, today);
    let calls = 0; let fail = true; let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const screen = screenHarness('src/app/(tabs)/guide.tsx', {
      database: h.database, snapshot: () => snapshot, params: { choreId: h.chore.id },
      mocks: { '@/platform/storage/repository': { ...repository, async recordIncompleteChore() {
        calls++; await blocked; if (fail) throw new Error('synthetic write failure'); return true;
      } } },
    });
    const button = screen.button('未完了を記録');
    button.props.onPress(); button.props.onPress(); release(); await screen.flush();
    assert.equal(calls, 1);
    assert.ok(screen.text().includes('synthetic write failure'));
    fail = false; await screen.press('未完了を記録');
    assert.equal(calls, 2);
    assert.ok(screen.text().includes('未完了を記録し'));
  } finally { h.connection.close(); }
});

test('household assignments deduplicate members, reject missing members atomically, and support clearing', async () => {
  const h = await fixture();
  try {
    const id = await repository.addHouseholdMember(h.database, '  家族  ');
    assert.equal(h.connection.prepare('SELECT display_name FROM household_members WHERE id = ?').get(id).display_name, '家族');
    const before = h.writes.length;
    await assert.rejects(repository.addHouseholdMember(h.database, ' \t '), /メンバー名/);
    assert.equal(h.writes.length, before);
    await repository.setChoreAssignments(h.database, h.chore.id, [id, id, repository.LOCAL_MEMBER_ID]);
    const saved = h.connection.prepare('SELECT * FROM chore_assignments WHERE chore_id = ? ORDER BY member_id').all(h.chore.id);
    assert.equal(saved.length, 2);
    await assert.rejects(repository.setChoreAssignments(h.database, h.chore.id, [id, 'missing-member']), /FOREIGN KEY/);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_assignments WHERE chore_id = ? ORDER BY member_id').all(h.chore.id), saved);
    const snapshot = await repository.loadPlannerSnapshot(h.database, today);
    assert.deepEqual(new Set(snapshot.scheduleEntries.filter((item) => item.choreId === h.chore.id)[0].assignedMemberIds), new Set([id, repository.LOCAL_MEMBER_ID]));
    await repository.setChoreAssignments(h.database, h.chore.id, []);
    assert.equal(h.connection.prepare('SELECT count(*) AS count FROM chore_assignments WHERE chore_id = ?').get(h.chore.id).count, 0);
  } finally { h.connection.close(); }
});

test('dependency replacement preserves the old graph after cycles, self edges, or foreign-key failure', async () => {
  const h = await fixture();
  try {
    const [a, b, c] = h.chores;
    await repository.replaceChoreDependencies(h.database, b.id, [a.id, a.id]);
    await repository.replaceChoreDependencies(h.database, c.id, [b.id]);
    const graph = () => h.connection.prepare('SELECT * FROM chore_dependencies ORDER BY id').all();
    const before = graph();
    assert.equal(before.length, 2);
    for (const [successor, predecessors] of [[a.id, [c.id]], [b.id, [b.id]], [b.id, [c.id, 'missing-chore']]]) {
      await assert.rejects(repository.replaceChoreDependencies(h.database, successor, predecessors));
      assert.deepEqual(graph(), before);
    }
    await assert.rejects(repository.replaceChoreDependencies(h.database, b.id, [a.id, 'missing-chore']), /FOREIGN KEY/);
    assert.deepEqual(graph(), before);
    await repository.replaceChoreDependencies(h.database, b.id, []);
    assert.equal(graph().length, 1);
  } finally { h.connection.close(); }
});

for (const kind of ['initial', 'cycle', 'unrecognized', 'null-prior-state']) {
  test(`completion undo restores a compatible state for ${kind} history`, async () => {
    const h = await fixture();
    try {
      const date = addDays(today, -1);
      const entryId = kind === 'initial' ? `${h.chore.id}:initial`
        : kind === 'cycle' ? `${h.chore.id}:${date}` : `${h.chore.id}:legacy`;
      h.connection.prepare(`INSERT INTO chore_completions
        (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome, scheduled_date, previous_chore_state_json)
        VALUES ('legacy', ?, ?, ?, 'inApp', ?, 'completed', ?, ?)`).run(h.chore.householdId, h.chore.id,
          `${date}T03:00:00.000Z`, entryId, date, kind === 'null-prior-state' ? 'null' : null);
      h.connection.prepare('UPDATE chore_state SET last_completed_date = ?, initial_pending = 0 WHERE chore_id = ?').run(date, h.chore.id);
      assert.equal(await repository.undoCompletedChore(h.database, 'legacy'), true);
      const state = h.connection.prepare('SELECT * FROM chore_state WHERE chore_id = ?').get(h.chore.id);
      if (kind === 'null-prior-state') assert.equal(state, undefined);
      else if (kind === 'cycle') {
        assert.equal(state.last_completed_date, addDays(date, -h.chore.frequencyDaysByMode.balanced));
        assert.equal(state.initial_pending, 0);
      } else {
        assert.equal(state.last_completed_date, null);
        assert.equal(state.initial_pending, 1);
        assert.equal(state.initial_scheduled_date, date);
      }
      assert.equal(await repository.undoCompletedChore(h.database, 'legacy'), false);
      const snapshot = await repository.loadPlannerSnapshot(h.database, today);
      assert.equal(snapshot.completions.find((item) => item.id === 'legacy').outcome, 'incomplete');
      assert.ok(snapshot.scheduleEntries.some((item) => item.choreId === h.chore.id));
    } finally { h.connection.close(); }
  });
}

for (const variant of ['repair', 'estimated', 'initial-pending', 'different-date']) {
  test(`old future-completion repair follows saved history and respects ${variant} state on upgrade`, async () => {
    const h = await fixture();
    try {
      // Retired built-ins are intentionally removed by catalogue6. A custom
      // legacy job is retained and must still receive the historical repair.
      h.chore = { ...h.chore, id: 'retained-custom-legacy-history' };
      h.connection.prepare('INSERT INTO chore_definitions VALUES(?,?,?,?,?)').run(h.chore.id, h.chore.householdId, h.chore.name, 1, JSON.stringify(h.chore));
      h.connection.prepare('INSERT INTO chore_state(chore_id, initial_pending) VALUES(?,1)').run(h.chore.id);
      h.connection.prepare("INSERT INTO chore_assignments VALUES(?,'local-member')").run(h.chore.id);
      const original = { choreId: h.chore.id, lastCompletedDate: addDays(today, -10), lastCompletedEstimated: true, initialPending: false };
      const date = new Date(); date.setHours(12, 0, 0, 0);
      const yesterday = new Date(date); yesterday.setDate(yesterday.getDate() - 1);
      const afterFirst = { ...original, lastCompletedDate: localDateFromDate(yesterday), lastCompletedEstimated: false };
      const insert = h.connection.prepare(`INSERT INTO chore_completions
        (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome, scheduled_date, scheduled_window_start, previous_chore_state_json)
        VALUES (?, ?, ?, ?, 'inApp', ?, 'completed', ?, ?, ?)`);
      for (const [index, timestamp, previous] of [[0, yesterday, original], [1, date, afterFirst]]) {
        const future = addDays(today, 10 + index * 10);
        insert.run(`old-${index}`, h.chore.householdId, h.chore.id, timestamp.toISOString(), `future-${index}`, future, future, JSON.stringify(previous));
      }
      h.connection.prepare('UPDATE household_settings SET built_in_chore_catalog_version = 1').run();
      h.connection.prepare('UPDATE chore_state SET last_completed_date = ?, last_completed_estimated = ?, initial_pending = ? WHERE chore_id = ?')
        .run(variant === 'different-date' ? addDays(today, -2) : today, variant === 'estimated' ? 1 : 0, variant === 'initial-pending' ? 1 : 0, h.chore.id);
      const state = () => h.connection.prepare('SELECT * FROM chore_state WHERE chore_id = ?').get(h.chore.id);
      const before = state();
      await repository.initializeLocalDatabase({ ...h.database });
      if (variant === 'repair') {
        assert.equal(state().last_completed_date, original.lastCompletedDate);
        assert.equal(state().last_completed_estimated, 1);
      } else assert.deepEqual(state(), before);
      assert.equal(h.connection.prepare('SELECT count(*) AS count FROM chore_completions').get().count, 2);
      const upgraded = state();
      await repository.initializeLocalDatabase({ ...h.database });
      assert.deepEqual(state(), upgraded, 'subsequent opens must not reapply the old repair');
    } finally { h.connection.close(); }
  });
}
