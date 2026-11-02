import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';

const repository = await import('../src/platform/storage/repository.ts');
const { selectDateTasks } = await import('../src/domain/scheduling/date-tasks.ts');
const { addDays, localDateFromDate } = await import('../src/domain/scheduling/local-date.ts');

async function setup(database) {
  await repository.initializeLocalDatabase(database);
  const first = await repository.loadPlannerSnapshot(database, '2026-10-24');
  const chore = first.chores[0];
  await repository.completeFirstSetup(database, {
    frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { date: '2026-10-01' } }, weatherLocation: null,
  });
  return { ...chore, enabled: true };
}
test('reopening a current personal database does no seed writes while a missing local member is still repaired', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const initial = h.connection.prepare('SELECT id,definition_json FROM chore_definitions ORDER BY id').all();
  h.writes.length = 0; await repository.initializeLocalDatabase({ ...h.database });
  assert.equal(h.writes.length, 0, 'each cold connection must not rewrite an already initialized household');
  assert.deepEqual(h.connection.prepare('SELECT id,definition_json FROM chore_definitions ORDER BY id').all(), initial);
  const member = h.connection.prepare('SELECT * FROM household_members').get();
  h.connection.prepare('DELETE FROM chore_assignments').run(); h.connection.prepare('DELETE FROM household_members').run();
  await repository.initializeLocalDatabase({ ...h.database });
  assert.deepEqual(h.connection.prepare('SELECT * FROM household_members').get(), member);
});

test('unchanged planner refreshes do not rewrite seed data or generated schedule rows', async () => {
  const { connection, database, writes } = createDatabase();
  try {
    await setup(database);
    await repository.loadPlannerSnapshot(database, '2026-10-24');
    writes.length = 0;
    await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(writes.length, 0, writes.map((write) => write.sql).join('\n'));
  } finally { connection.close(); }
});

test('concurrent planner refreshes do not nest SQLite transactions', async () => {
  const { connection, database } = createDatabase();
  try {
    await setup(database);
    const results = await Promise.allSettled([
      repository.loadPlannerSnapshot(database, '2026-10-24'),
      repository.loadPlannerSnapshot(database, '2026-10-24'),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled'), JSON.stringify(results.map((result) => result.reason?.message)));
  } finally { connection.close(); }
});

test('undoing an older completion preserves a newer completion and undoing both restores the original state', async () => {
  const { connection, database } = createDatabase();
  try {
    const chore = await setup(database);
    connection.prepare('UPDATE chore_state SET last_completed_date = ?, initial_pending = 0 WHERE chore_id = ?')
      .run('2026-10-15', chore.id);
    const original = { choreId: chore.id, lastCompletedDate: '2026-10-01', lastCompletedEstimated: true, initialPending: false };
    const afterFirst = { ...original, lastCompletedDate: '2026-10-08', lastCompletedEstimated: false };
    const insert = connection.prepare(`INSERT INTO chore_completions
      (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome, previous_chore_state_json)
      VALUES (?, ?, ?, ?, 'inApp', ?, 'completed', ?)`);
    insert.run('first', repository.LOCAL_HOUSEHOLD_ID, chore.id, '2026-10-08T03:00:00.000Z', 'entry-first', JSON.stringify(original));
    insert.run('second', repository.LOCAL_HOUSEHOLD_ID, chore.id, '2026-10-15T03:00:00.000Z', 'entry-second', JSON.stringify(afterFirst));
    assert.equal(await repository.undoCompletedChore(database, 'first'), true);
    assert.equal(connection.prepare('SELECT last_completed_date FROM chore_state WHERE chore_id = ?').get(chore.id).last_completed_date, '2026-10-15');
    assert.equal(await repository.undoCompletedChore(database, 'second'), true);
    const restored = connection.prepare('SELECT * FROM chore_state WHERE chore_id = ?').get(chore.id);
    assert.equal(restored.last_completed_date, '2026-10-01');
    assert.equal(restored.last_completed_estimated, 1);
  } finally { connection.close(); }
});

test('late weather results cannot replace a newer planner snapshot', async () => {
  const { connection, database } = createDatabase();
  try {
    await setup(database);
    await repository.saveWeatherLocation(database, { region: '横浜市', displayName: '横浜市, 神奈川県', latitude: 35.44, longitude: 139.64 });
    const snapshot = await repository.loadPlannerSnapshot(database, '2026-10-24');
    let finishWeather;
    const weatherResult = new Promise((resolve) => { finishWeather = resolve; });
    const pending = repository.applyWeatherToPlannerSnapshot(database, snapshot, () => true, () => weatherResult);
    const newer = await repository.loadPlannerSnapshot(database, '2026-10-25');
    finishWeather({ schedule: [], outcome: 'adjusted', adjustmentCount: 1 });
    assert.equal(await pending, null);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM chore_schedule_entries').get().count, newer.scheduleEntries.length);
  } finally { connection.close(); }
});

test('daily completion, repeated taps, undo, and refresh retain one visible card', async () => {
  const { connection, database, writes } = createDatabase();
  try {
    const today = localDateFromDate(new Date());
    const chore = await setup(database);
    await repository.updateChoreDefinition(database, { ...chore, load: 'light', everyday: true,
      frequencyDaysByMode: { frequent: 1, balanced: 1, relaxed: 1 }, windowRadiusDays: 0, maxShiftDays: 0 });
    connection.prepare('UPDATE chore_state SET last_completed_date = ?, initial_pending = 0 WHERE chore_id = ?')
      .run(addDays(today, -7), chore.id);
    let snapshot = await repository.loadPlannerSnapshot(database, today);
    assert.equal(snapshot.scheduleEntries.filter((item) => item.status === 'overdue').length, 3);
    let rows = selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3);
    assert.equal(rows.length, 1);
    const pending = rows[0].entry;
    const results = await Promise.all([repository.completeChore(database, pending), repository.completeChore(database, pending)]);
    assert.deepEqual(results, [true, false]);
    snapshot = await repository.loadPlannerSnapshot(database, today);
    rows = selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].completed, true);
    const completionId = rows[0].completion.id;
    assert.equal(await repository.undoCompletedChore(database, completionId), true);
    assert.equal(await repository.undoCompletedChore(database, completionId), false);
    snapshot = await repository.loadPlannerSnapshot(database, today);
    rows = selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].completed, false);
    assert.equal(rows[0].entry.id, pending.id);
    writes.length = 0;
    await repository.loadPlannerSnapshot(database, today);
    assert.equal(writes.length, 0);
  } finally { connection.close(); }
});

test('editing a chore window invalidates stale overdue schedule rows but preserves history', async () => {
  const { connection, database } = createDatabase();
  try {
    const chore = await setup(database);
    const definition = { ...chore, load: 'normal', recommendedCycleDays: 7, windowRadiusDays: 0, maxShiftDays: 0 };
    await repository.updateChoreDefinition(database, definition);
    connection.prepare('UPDATE chore_state SET last_completed_date = ?, initial_pending = 0 WHERE chore_id = ?')
      .run('2026-10-16', chore.id);
    const before = await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(before.scheduleEntries[0].windowEnd, '2026-10-23');
    assert.equal(before.scheduleEntries[0].status, 'overdue');
    connection.prepare(`INSERT INTO chore_completions (id, household_id, chore_id, completed_at, outcome)
      VALUES (?, ?, ?, ?, 'incomplete')`).run('history', repository.LOCAL_HOUSEHOLD_ID, chore.id, '2026-10-23T03:00:00.000Z');
    await repository.updateChoreDefinition(database, { ...definition, windowRadiusDays: 2 });
    const after = await repository.loadPlannerSnapshot(database, '2026-10-24');
    const occurrence = after.scheduleEntries.find((item) => item.cycleBaseDate === '2026-10-23');
    assert.equal(occurrence.windowStart, '2026-10-21');
    assert.equal(occurrence.windowEnd, '2026-10-25');
    assert.equal(occurrence.status, 'inWindow');
    assert.equal(after.completions.some((item) => item.id === 'history'), true);
  } finally { connection.close(); }
});

test('invalid planner settings are rejected before writing, and boundary settings survive reload', async () => {
  const { connection, database, writes } = createDatabase();
  try {
    await setup(database);
    const valid = { frequencyMode: 'balanced', restDays: [1, 7], heavyDailyLimit: 10, normalDailyLimit: 20 };
    for (const invalid of [
      { frequencyMode: 'other' }, { restDays: [0, 8] }, { restDays: [1.5] },
      { heavyDailyLimit: 0 }, { heavyDailyLimit: 11 }, { normalDailyLimit: 21 }, { normalDailyLimit: 1.5 },
    ]) {
      writes.length = 0;
      await assert.rejects(repository.updatePlannerSettings(database, { ...valid, ...invalid }), RangeError);
      assert.equal(writes.length, 0);
    }
    await repository.updatePlannerSettings(database, valid);
    const snapshot = await repository.loadPlannerSnapshot(database, '2026-10-24');
    for (const [key, value] of Object.entries(valid)) assert.deepEqual(snapshot.settings[key], value);
  } finally { connection.close(); }
});
