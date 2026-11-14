import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createChoreSettingsEditor } from '../src/features/settings/chore-settings-editor.ts';
import { createPersonalChoreDefinitions } from '../src/domain/chores/personal-catalog.ts';
import { applyChoreSettingsPatch } from '../src/domain/chores/settings-patch.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { readAdaptivePersonalInside } from '../src/platform/storage/adaptive-personal-chores.ts';
const repository = await import('../src/platform/storage/repository.ts');

const chore = createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID).find(row => row.id === 'liflow-catalog-6.007');
const adopted = { mode: 'balanced', days: 60, label: '60日ごと', automatic: true, windowRadiusDays: 5 };

for (const platform of ['ios', 'android']) test(`${platform} personal cycle mode pins the displayed learned cadence with one tap and persists fixed automatic choices through the actual repository`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T01:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close());
  await repository.initializeLocalDatabase(h.database);
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id], previousDates: {}, weatherLocation: null });
  let snapshot;
  const refresh = async () => { snapshot = await repository.loadPlannerSnapshot(h.database); };
  await refresh(); let date = snapshot.scheduleEntries[0].suggestedDate;
  for (let index = 0; index < 4; index++) {
    t.mock.timers.setTime(Date.parse(`${date}T01:00:00Z`)); await refresh();
    await repository.completeChoreWithReceipt(h.database, snapshot.scheduleEntries[0]); date = addDays(date, 60);
  }
  await refresh(); assert.equal(snapshot.personalCadences[chore.id].days, 60);
  const options = { platform, database: h.database, snapshot: () => snapshot, refresh, params: { id: chore.id } };
  let screen = screenHarness('src/app/chores/[id].tsx', options);
  assert.equal(screen.button('自動調整').props.accessibilityState.selected, true);
  assert.equal(screen.nodes().find(row => row.props.accessibilityLabel === '家事周期の日数').props.value, '60');
  // Selection changes synchronously, before the asynchronous repository finishes.
  screen.button('固定').props.onPress(); screen.render();
  assert.equal(screen.button('固定').props.accessibilityState.selected, true);
  for (let index = 0; index < 4; index++) await screen.flush();
  await refresh();
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.fixedDays, 60);
  screen = screenHarness('src/app/chores/[id].tsx', options);
  assert.equal(screen.button('固定').props.accessibilityState.selected, true);
  const actionCount = () => h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='settings'").get().n;
  const before = actionCount(); await screen.press('固定'); await refresh(); assert.equal(actionCount(), before);
  for (let index = 0; index < 4; index++) {
    t.mock.timers.setTime(Date.parse(`${date}T01:00:00Z`)); await refresh();
    await repository.completeChoreWithReceipt(h.database, snapshot.scheduleEntries[0]); date = addDays(date, 20);
  }
  await refresh(); assert.equal(snapshot.personalCadences[chore.id].days, 60);
  const historyCount = h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n;
  screen = screenHarness('src/app/chores/[id].tsx', options); await screen.press('自動調整');
  for (let index = 0; index < 4; index++) await screen.flush();
  await refresh(); const automatic = await readAdaptivePersonalInside(h.database, chore.id);
  assert.equal(automatic.state.policy.fixedDays, null);
  assert.equal(automatic.state.model.days, chore.frequencyDaysByMode.balanced, 'release keeps the existing fresh-learning-generation rule');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n, historyCount);
  screen = screenHarness('src/app/chores/[id].tsx', options);
  assert.equal(screen.button('自動調整').props.accessibilityState.selected, true);
});

test('cycle mode coalesces rapid switches with a later numeric edit without restoring a stale cadence', async () => {
  const writes = []; let release; let stored = chore;
  const editor = createChoreSettingsEditor(chore, 'balanced', async patch => {
    writes.push(patch); if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    stored = applyChoreSettingsPatch(stored, patch);
  }, adopted);
  editor.changeCycleMode('fixed'); editor.changeCycleMode('automatic'); editor.changeCycle('２１');
  assert.equal(editor.getSnapshot().draft.cycleMode, 'fixed');
  release(); assert.equal(await editor.flush(), true);
  assert.deepEqual(writes, [{ cycleDays: 60 }, { cycleDays: 21 }]);
  assert.equal(stored.recommendedCycleDays, 21); assert.equal(editor.getSnapshot().draft.cycleText, '２１');
  assert.equal(editor.getSnapshot().draft.cycleMode, 'fixed');
});

test('cycle mode retries the captured learned value and discards a failed choice without touching other settings', async () => {
  const writes = []; let fail = true;
  const editor = createChoreSettingsEditor(chore, 'balanced', async patch => { writes.push(patch); if (fail) throw new Error('save failed'); }, adopted);
  editor.changeCycleMode('fixed'); assert.equal(await editor.flush(), false);
  assert.equal(editor.getSnapshot().draft.cycleMode, 'fixed'); assert.equal(editor.getSnapshot().draft.cycleText, '60');
  fail = false; assert.equal(await editor.flush(), true);
  assert.deepEqual(writes, [{ cycleDays: 60 }, { cycleDays: 60 }]);
  const second = createChoreSettingsEditor(chore, 'balanced', async () => { throw new Error('save failed'); }, adopted);
  second.changeCycleMode('fixed'); await second.flush(); second.discard();
  assert.equal(second.getSnapshot().draft.cycleMode, 'automatic'); assert.equal(second.getSnapshot().draft.cycleText, '60');
  assert.equal(second.getSnapshot().draft.load, chore.load);
});

test('viewing learned cycles and unavailable automatic modes cannot create a fixed override or erase a special schedule', async () => {
  const writes = [];
  const editor = createChoreSettingsEditor(chore, 'balanced', async patch => { writes.push(patch); }, adopted);
  editor.changeCycleMode('automatic'); await editor.flush(); assert.deepEqual(writes, []);
  editor.changeCycle('invalid'); editor.changeCycleMode('fixed'); await editor.flush(); assert.deepEqual(writes, []);
  for (const special of [
    { ...chore, personalSchedule: { startDate: '2026-11-14', monthlyDay: 14 } },
    { ...chore, personalSchedule: { startDate: '2026-11-14', once: true } },
    createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID).find(row => row.personalSchedulingKind === 'seasonal'),
    { ...chore, id: 'condition-appliance', personalRecipeId: undefined, applianceId: 'vacuum', manufacturerRecommendedIntervalDays: undefined, recommendedCycleDays: 21 },
  ]) {
    const value = createChoreSettingsEditor(special, 'balanced', async patch => { writes.push(patch); });
    assert.equal(value.canChangeCycleMode, false); value.changeCycleMode('fixed'); value.changeCycleMode('automatic'); await value.flush();
  }
  assert.deepEqual(writes, []);
});
