import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { addDays, localDateFromDate } from '../src/domain/scheduling/local-date.ts';
import { selectDateTasks } from '../src/domain/scheduling/date-tasks.ts';

const repository = await import('../src/platform/storage/repository.ts');
const { createTodayWidgetSnapshot } = await import('../src/features/widgets/today-widget-snapshot.ts');

const today = localDateFromDate(new Date());

async function setupDisabled(database) {
  await repository.initializeLocalDatabase(database);
  await repository.completeFirstSetup(database, {
    frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null,
  });
  return repository.loadPlannerSnapshot(database, today);
}

test('legacy enabled unknown state is repaired, and repeated refreshes keep the same first card', async () => {
  const h = createDatabase();
  try {
    const initial = await setupDisabled(h.database);
    const chore = initial.chores.find((item) => !item.archived);
    h.connection.prepare('UPDATE chore_definitions SET enabled = 1 WHERE id = ?').run(chore.id);
    h.connection.prepare('UPDATE chore_state SET initial_pending = 0, initial_scheduled_date = NULL WHERE chore_id = ?').run(chore.id);
    const first = await repository.loadPlannerSnapshot(h.database, today);
    const state = first.states.find((item) => item.choreId === chore.id);
    assert.equal(state.initialPending, true);
    assert.ok(state.initialScheduledDate);
    const second = await repository.loadPlannerSnapshot(h.database, today);
    assert.deepEqual(second.scheduleEntries, first.scheduleEntries);
    assert.deepEqual(second.states, first.states);
  } finally { h.connection.close(); }
});

test('legacy repair retains an already displayed first occurrence rather than moving it to the refresh date', async () => {
  const h = createDatabase();
  try {
    const initial = await setupDisabled(h.database);
    const chore = initial.chores.find((item) => item.load === 'normal' && !item.archived);
    await repository.setChoreEnabled(h.database, chore.id, true);
    const first = await repository.loadPlannerSnapshot(h.database, today);
    const entry = first.scheduleEntries.find((item) => item.id === `${chore.id}:initial`);
    for (const brokenPending of [0, 1]) {
      h.connection.prepare('UPDATE chore_state SET initial_pending = ?, initial_scheduled_date = NULL WHERE chore_id = ?').run(brokenPending, chore.id);
      const restored = await repository.loadPlannerSnapshot(h.database, addDays(today, 1));
      assert.equal(restored.scheduleEntries.find((item) => item.id === entry.id).suggestedDate, entry.suggestedDate);
      assert.equal(h.connection.prepare('SELECT initial_scheduled_date FROM chore_state WHERE chore_id = ?').get(chore.id).initial_scheduled_date, entry.suggestedDate);
    }
  } finally { h.connection.close(); }
});

for (const frequencyMode of ['frequent', 'balanced', 'relaxed']) {
  test(`all 46 built-in chores can be enabled and have their cycle edited from unknown/disabled (${frequencyMode})`, async () => {
    const h = createDatabase();
    try {
      let snapshot = await setupDisabled(h.database);
      const builtIn = snapshot.chores.filter((item) => !item.archived);
      assert.equal(builtIn.length, 46);
      await repository.updatePlannerSettings(h.database, { frequencyMode, restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 });
      for (const chore of builtIn) {
        if (chore.requiresCycleSelection) await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 17 });
        await repository.setChoreEnabled(h.database, chore.id, true);
      }
      snapshot = await repository.loadPlannerSnapshot(h.database, today);
      const firstDates = new Map(snapshot.states.map((state) => [state.choreId, state.initialScheduledDate]));
      for (const chore of builtIn) {
        assert.ok(firstDates.get(chore.id), chore.name);
        assert.equal(snapshot.scheduleEntries.filter((entry) => entry.id === `${chore.id}:initial`).length, 1, chore.name);
        const initialDate = firstDates.get(chore.id);
        assert.equal(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, initialDate, 0, snapshot.chores)
          .filter((task) => task.choreId === chore.id).length, 1, chore.name);
        await repository.updateChoreDefinition(h.database, { ...chore, enabled: true, requiresCycleSelection: false, recommendedCycleDays: 17, windowRadiusDays: 0, maxShiftDays: 0 });
      }
      snapshot = await repository.loadPlannerSnapshot(h.database, today);
      for (const chore of builtIn) {
        const entries = snapshot.scheduleEntries.filter((entry) => entry.choreId === chore.id);
        assert.equal(entries.find((entry) => entry.id === `${chore.id}:initial`).suggestedDate, firstDates.get(chore.id));
        assert.ok(entries.some((entry) => entry.cycleBaseDate === addDays(firstDates.get(chore.id), 17)), chore.name);
      }
      const reload = await repository.loadPlannerSnapshot(h.database, today);
      assert.deepEqual(reload.scheduleEntries, snapshot.scheduleEntries);
    } finally { h.connection.close(); }
  });
}

test('complete, disable, re-enable, edit, and undo keep history and exactly one active card', async () => {
  const h = createDatabase();
  try {
    let snapshot = await setupDisabled(h.database);
    const chore = snapshot.chores.find((item) => item.everyday && !item.archived);
    await repository.setChoreEnabled(h.database, chore.id, true);
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const entry = snapshot.scheduleEntries.find((item) => item.id === `${chore.id}:initial`);
    assert.equal(await repository.completeChore(h.database, entry), true);
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const completion = snapshot.completions.find((item) => item.choreId === chore.id);
    await repository.setChoreEnabled(h.database, chore.id, false);
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(snapshot.completions.length, 1, 'disabling must retain history');
    assert.equal(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores).length, 0, 'disabled completion must not become a ghost card');
    assert.equal(createTodayWidgetSnapshot(snapshot.scheduleEntries, snapshot.chores, snapshot.completions, today, new Date().toISOString()).chores.length, 0);
    await repository.updateChoreDefinition(h.database, { ...chore, enabled: true, recommendedCycleDays: 7 });
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores).length, 1);
    assert.equal(await repository.undoCompletedChore(h.database, completion.id), true);
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const tasks = selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].completed, false);
    assert.equal(tasks[0].id, entry.id);
    assert.ok(snapshot.scheduleEntries.some((item) => item.cycleBaseDate === addDays(today, 7)));
  } finally { h.connection.close(); }
});

test('re-enabling an unstarted chore after several days plans a fresh first date', async () => {
  const h = createDatabase();
  try {
    let snapshot = await setupDisabled(h.database);
    const chore = snapshot.chores.find((item) => item.load === 'normal' && !item.archived);
    await repository.setChoreEnabled(h.database, chore.id, true);
    await repository.loadPlannerSnapshot(h.database, today);
    await repository.setChoreEnabled(h.database, chore.id, false);
    snapshot = await repository.loadPlannerSnapshot(h.database, addDays(today, 7));
    assert.equal(snapshot.scheduleEntries.length, 0);
    await repository.setChoreEnabled(h.database, chore.id, true);
    snapshot = await repository.loadPlannerSnapshot(h.database, addDays(today, 7));
    assert.equal(snapshot.scheduleEntries.find((entry) => entry.id === `${chore.id}:initial`).suggestedDate, addDays(today, 7));
    assert.equal(snapshot.completions.length, 0, 'enabling must not invent a real completion');
  } finally { h.connection.close(); }
});

test('a stale card cannot complete a chore after the user has disabled it', async () => {
  const h = createDatabase();
  try {
    const initial = await setupDisabled(h.database);
    const chore = initial.chores.find((item) => !item.archived);
    await repository.setChoreEnabled(h.database, chore.id, true);
    const snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const entry = snapshot.scheduleEntries.find((item) => item.choreId === chore.id);
    await repository.setChoreEnabled(h.database, chore.id, false);
    assert.equal(await repository.completeChore(h.database, entry), false);
    assert.equal((await repository.loadPlannerSnapshot(h.database, today)).completions.length, 0);
  } finally { h.connection.close(); }
});

test('short, long and out-of-horizon cycle edits retain the unknown initial occurrence and one card per date', async () => {
  const h = createDatabase();
  try {
    let snapshot = await setupDisabled(h.database);
    const chore = snapshot.chores.find((item) => item.load === 'normal' && !item.archived);
    for (const cycle of [1, 2, 7, 30, 90, 180, 3650]) {
      await repository.updateChoreDefinition(h.database, { ...chore, enabled: true, recommendedCycleDays: cycle, maxShiftDays: 0, windowRadiusDays: 0 });
      snapshot = await repository.loadPlannerSnapshot(h.database, today);
      assert.equal(snapshot.scheduleEntries.find((entry) => entry.id === `${chore.id}:initial`).suggestedDate, today, `${cycle}`);
      assert.equal(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores).length, 1);
      const next = snapshot.scheduleEntries.find((entry) => entry.cycleBaseDate === addDays(today, cycle));
      assert.equal(Boolean(next), cycle <= 180, 'a cycle beyond the horizon must not hide the initial card');
    }
  } finally { h.connection.close(); }
});

for (const method of ['toggle', 'individual settings']) {
  test(`unknown chore enabled through ${method} keeps its first date across reload and midnight`, async () => {
    const h = createDatabase();
    try {
      const initial = await setupDisabled(h.database);
      const chore = initial.chores.find((item) => !item.archived && item.load === 'normal');
      if (method === 'toggle') await repository.setChoreEnabled(h.database, chore.id, true);
      else await repository.updateChoreDefinition(h.database, { ...chore, enabled: true, recommendedCycleDays: 7 });
      const first = await repository.loadPlannerSnapshot(h.database, today);
      const entry = first.scheduleEntries.find((item) => item.id === `${chore.id}:initial`);
      assert.ok(entry, 'enabling a chore must create its first card');
      const stored = h.connection.prepare('SELECT * FROM chore_state WHERE chore_id = ?').get(chore.id);
      assert.equal(stored.initial_pending, 1, 'unknown date must stay pending after enabling');
      assert.equal(stored.initial_scheduled_date, entry.suggestedDate, 'first date must be persisted');
      const next = await repository.loadPlannerSnapshot(h.database, addDays(today, 1));
      const same = next.scheduleEntries.find((item) => item.id === entry.id);
      assert.equal(same.suggestedDate, entry.suggestedDate, 'midnight must not silently move the first occurrence');
      assert.equal(same.status, 'overdue');
      assert.equal(selectDateTasks(next.scheduleEntries, next.completions, addDays(today, 1), 3).length, 1);
    } finally { h.connection.close(); }
  });
}
