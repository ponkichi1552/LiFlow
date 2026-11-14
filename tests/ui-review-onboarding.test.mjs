import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const { anchorForMonthlyDay } = await import('../src/features/calendar/monthly-day.ts');
const selection = await import('../src/features/settings/chore-source-selection.ts');

test('monthly day selection retains 31 independently of a shorter starting month', () => {
  assert.equal(anchorForMonthlyDay('2026-11-14', 31), '2026-12-31');
  assert.equal(anchorForMonthlyDay('2028-02-01', 29), '2028-02-29');
  assert.equal(anchorForMonthlyDay('2027-02-01', 29), '2027-03-29');
  assert.throws(() => anchorForMonthlyDay('2026-11-14', 0));
});
test('chore settings remember the destination only inside the same account group and generation', () => {
  const group = { userId: 'ui-review', groupId: 'home', localGeneration: 1 };
  const scope = selection.choreSourceScope(group); selection.rememberChoreSource(scope, 'group');
  assert.equal(selection.readChoreSource(scope), 'group');
  for (const changed of [{ ...group, userId: 'other' }, { ...group, groupId: 'other' }, { ...group, localGeneration: 2 }])
    assert.equal(selection.readChoreSource(selection.choreSourceScope(changed)), 'personal');
});
for (const platform of ['ios', 'android']) test(`${platform} first run finishes from required choices without permission prompts or optional setup`, async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await repository.initializeLocalDatabase(db.database);
  const snapshot = await repository.loadPlannerSnapshot(db.database, '2026-11-14'); let completed = 0, permission = 0;
  const ui = screenHarness('src/features/onboarding/first-run-setup.tsx', { platform, exportName: 'FirstRunSetup', database: db.database,
    props: { snapshot, onComplete: async () => { completed++; } }, mocks: {
      '@/platform/notifications/expo-local-notification-gateway': { ExpoLocalNotificationGateway: class { requestPermission() { permission++; return Promise.resolve(true); } } },
    } }); t.after(() => ui.unmount());
  await ui.press('選択をすべて外す'); await ui.press('次へ');
  await ui.press('30分'); await ui.press('20–22時'); await ui.press('設定して始める');
  assert.equal(completed, 1); assert.equal(permission, 0);
  const saved = await repository.loadPlannerSnapshot(db.database, snapshot.today);
  assert.equal(saved.settings.setupCompleted, true); assert.equal(saved.settings.notificationsEnabled, false);
  assert.equal(saved.chores.some(chore => chore.enabled), false); assert.deepEqual(saved.wasteSchedules, []);
  const prefs = await repository.loadPersonalPlacementPreferences(db.database);
  assert.equal(prefs.dayTypes.workday.maximumMinutes, 30);
  assert.deepEqual(prefs.dayTypes.workday.allowedBands, [{ startMinute: 1200, endMinute: 1320 }]);
  assert.deepEqual(prefs.dayTypes.holiday.allowedBands, [{ startMinute: 540, endMinute: 1140 }]);
});
test('first run saves time preferences atomically and never replays them after setup was committed', async t => {
  const db = createDatabase(); t.after(() => db.connection.close()); await repository.initializeLocalDatabase(db.database);
  const base = { frequencyMode: 'balanced', restDays: [6, 7], enabledChoreIds: [], previousDates: {}, weatherLocation: null,
    dayTypes: { workday: { maximumMinutes: 30 }, holiday: { maximumMinutes: 60 } } };
  const run = db.database.runAsync; let reject = true;
  db.database.runAsync = async (sql, ...args) => { if (reject && sql.includes('UPDATE household_settings SET frequency_mode')) throw new Error('synthetic write failure'); return run(sql, ...args); };
  await assert.rejects(repository.completeFirstSetup(db.database, base), /synthetic/);
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM personal_adaptive_preferences').get().n, 0);
  reject = false; await repository.completeFirstSetup(db.database, base);
  await repository.completeFirstSetup(db.database, { ...base, dayTypes: { workday: { maximumMinutes: 999 }, holiday: {} } });
  assert.equal((await repository.loadPersonalPlacementPreferences(db.database)).dayTypes.workday.maximumMinutes, 30);
});
