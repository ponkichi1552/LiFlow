import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createHouseholdChoreDefinitions } from '../src/domain/chores/catalog.ts';
import { resetChoreSchedule } from '../src/domain/chores/schedule-defaults.ts';
import { createChoreSettingsEditor } from '../src/features/settings/chore-settings-editor.ts';
import { isTaskUrgent } from '../src/domain/scheduling/task-priority.ts';
import { loadSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { applyReceivedSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
import { receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { prepareStartupDisplay, finishStartupDisplay } from '../src/platform/diagnostics/startup-splash.ts';
const repository = await import('../src/platform/storage/repository.ts');
const range = { from: '2026-10-27', through: '2026-11-30', asOfDate: '2026-10-29' };
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `${d.options.identity.deviceId}.reset.${++n}`, now, sync: async () => {} }); }

test('schedule reset restores catalog defaults by stable ID while preserving enabled state names procedures and provenance', () => {
  for (const base of createHouseholdChoreDefinitions('home')) for (const enabled of [false, true]) {
    const current = { ...base, enabled, name: '変更した名前', instructions: ['自分の手順'], recommendedCycleDays: 123, load: 'light', windowRadiusDays: 14, maxShiftDays: 0, holidayPriority: !base.holidayPriority };
    const reset = resetChoreSchedule(current);
    assert.equal(reset.enabled, enabled); assert.equal(reset.name, current.name); assert.deepEqual(reset.instructions, current.instructions);
    for (const field of ['frequencyDaysByMode', 'load', 'windowRadiusDays', 'maxShiftDays', 'holidayPriority', 'everyday']) assert.deepEqual(reset[field], base[field]);
    assert.equal(reset.recommendedCycleDays, base.requiresCycleSelection ? 123 : undefined); assert.equal(reset.userIntervalDays, undefined);
    assert.equal(current.recommendedCycleDays, 123);
  }
  assert.throws(() => resetChoreSchedule({ ...createHouseholdChoreDefinitions('home')[0], id: 'custom' }), /初期値/);
});

test('condition-based appliance reset never disables a chore or invents a manufacturer cycle', () => {
  const current = { ...createHouseholdChoreDefinitions('home')[0], id: 'care.1', applianceId: 'appliance', userIntervalDays: 19, recommendedCycleDays: 19, enabled: true };
  const next = resetChoreSchedule(current); assert.equal(next.enabled, true); assert.equal(next.userIntervalDays, 19); assert.equal(next.load, 'light'); assert.equal(next.windowRadiusDays, 1);
  const maker = resetChoreSchedule({ ...current, manufacturerRecommendedIntervalDays: 30 }); assert.equal(maker.userIntervalDays, undefined); assert.equal(maker.enabled, true);
});

test('reset replaces unsaved scheduling drafts without dropping a separately queued enabled toggle', async () => {
  const base = createHouseholdChoreDefinitions('home')[0]; let saved = base; const patches = [];
  const editor = createChoreSettingsEditor(base, 'balanced', async patch => {
    patches.push(patch); saved = (await import('../src/domain/chores/settings-patch.ts')).applyChoreSettingsPatch(saved, patch);
  });
  editor.changeCycle('123'); editor.changeRadius('14'); editor.changeEnabled(false); await editor.resetSchedule();
  assert.equal(saved.recommendedCycleDays, undefined); assert.equal(saved.windowRadiusDays, base.windowRadiusDays); assert.equal(saved.enabled, false);
  assert.equal(editor.getSnapshot().draft.cycleText, String(base.frequencyDaysByMode.balanced)); assert.ok(patches.some(patch => patch.resetSchedule));
});

test('personal all-chore reset is atomic and preserves all enabled flags completion history assignment state and names', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); let snapshot = await repository.loadPlannerSnapshot(h.database, range.asOfDate);
    const base = snapshot.chores.find(chore => !chore.archived);
    await repository.updateChoreDefinition(h.database, { ...base, name: '名前を保持', instructions: ['手順を保持'], enabled: false, recommendedCycleDays: 123, load: 'light', windowRadiusDays: 14 });
    const before = () => ({ states: h.connection.prepare('SELECT * FROM chore_state ORDER BY chore_id').all(), completions: h.connection.prepare('SELECT * FROM chore_completions ORDER BY id').all(),
      definitions: h.connection.prepare('SELECT id,enabled,name FROM chore_definitions ORDER BY id').all() });
    const preserved = before(); await repository.resetAllChoreSchedules(h.database); assert.deepEqual(before(), preserved);
    snapshot = await repository.loadPlannerSnapshot(h.database, range.asOfDate); const reset = snapshot.chores.find(chore => chore.id === base.id);
    assert.equal(reset.name, '名前を保持'); assert.deepEqual(reset.instructions, ['手順を保持']); assert.equal(reset.enabled, false); assert.equal(reset.recommendedCycleDays, undefined);
    await repository.updateChoreSettings(h.database, base.id, { cycleDays: 35 });
    const rows = h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all();
    h.connection.exec(`CREATE TRIGGER stop_reset BEFORE UPDATE ON chore_definitions WHEN NEW.id='builtin-chore-02' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`);
    await repository.updateChoreSettings(h.database, base.id, { load: 'light' });
    // Make a second row need resetting, then fail while updating it.
    h.connection.exec('DROP TRIGGER stop_reset'); await repository.updateChoreSettings(h.database, 'builtin-chore-02', { cycleDays: 15 });
    const atFailure = h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all();
    h.connection.exec(`CREATE TRIGGER stop_reset BEFORE UPDATE ON chore_definitions WHEN NEW.id='builtin-chore-02' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`);
    await assert.rejects(repository.resetAllChoreSchedules(h.database), /synthetic rollback/); assert.deepEqual(h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all(), atFailure);
    assert.ok(rows.length > 0);
  } finally { h.connection.close(); }
});

test('shared reset keeps configuration assignment policy activation and history and rejects stale or ordinary-member requests', async () => {
  const f = await fixture(); const d = await f.device(); const member = await f.device('member', f.member);
  try {
    await d.repository.commit(seeds()); const c = controller(d);
    await c.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null });
    await c.actions.patchChoreConfiguration('floor', 1, { intervalDays: 14, windowBeforeDays: 5, active: false }, '2026-10-28');
    await c.actions.patchChore('floor', { load: 'heavy', name: '保持する家事名' });
    const before = await c.readModel(range); const config = before.configurations[0].configuration;
    await c.actions.resetChoreSchedules(['floor'], { floor: config.ruleVersion }, '2026-10-29');
    const after = await c.readModel(range); const reset = after.configurations[0].configuration;
    assert.equal(reset.intervalDays, 7); assert.equal(reset.windowBeforeDays, 2); assert.equal(reset.active, false);
    assert.deepEqual(reset.policy, config.policy); assert.equal(reset.anchorDate, config.anchorDate); assert.deepEqual(after.plan.history, before.plan.history);
    assert.equal(after.plan.chores[0].name, '保持する家事名'); assert.equal(after.plan.chores[0].load, 'normal');
    const facts = await loadSharedFacts(d.database, groupId); const cursor = await readSharingCheckpoint(member.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, facts, String(facts.length), member.repository.project, cursor.cursor, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const outbox = await listSharingOutbox(d.database, groupId);
    await assert.rejects(c.actions.resetChoreSchedules(['floor'], { floor: config.ruleVersion }), /changed|最新|変更|設定/i);
    assert.deepEqual(await listSharingOutbox(d.database, groupId), outbox);
    await assert.rejects(controller(member).actions.resetChoreSchedules(['floor'], { floor: reset.ruleVersion }), /管理者/);
    await assert.rejects(c.actions.resetChoreSchedules(['floor', 'missing'], { floor: reset.ruleVersion }, '2026-10-29'));
    assert.deepEqual(await listSharingOutbox(d.database, groupId), outbox, 'all resets roll back together');
  } finally { d.connection.close(); member.connection.close(); }
});

test('deadline attention is restricted to still-open windows and startup hides its native surface once without a loading card', async () => {
  const task = { completed: false, load: 'normal', recommendedDate: '2026-10-27', windowEnd: '2026-10-28' };
  assert.equal(isTaskUrgent(task, '2026-10-29'), false); assert.equal(isTaskUrgent({ ...task, windowEnd: '2026-10-29' }, '2026-10-29'), true);
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1; // Native splash can suppress every requested frame.
  try {
    let prevent = 0, hide = 0; prepareStartupDisplay({ preventAutoHideAsync: async () => { prevent++; }, hideAsync: async () => { hide++; } });
    assert.equal(prevent, 1); assert.equal(hide, 0); finishStartupDisplay(); finishStartupDisplay(); await Promise.resolve(); assert.equal(hide, 1);
  } finally { globalThis.requestAnimationFrame = previous; }
});

test('a compatible shared reset retains fixed future assignees and draft-40 groups need no forced upgrade', async () => {
  const f = await fixture({ schedulerVersion: 'liflow-shared-2-draft-40' }); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d);
    await c.actions.patchChoreConfiguration('floor', 1, { intervalDays: 14 }, '2026-10-28');
    await c.actions.assign({ choreId: 'floor', anchorDate: '2026-11-10', ruleVersion: 2, subjectUserId: null }, ['member'], 'this', true);
    const prior = (await c.readModel(range)).plan.occurrences.find(round => round.anchorDate === '2026-11-10'); assert.deepEqual(prior.assigneeIds, ['member']);
    await c.actions.resetChoreSchedules(['floor'], { floor: 2 }, '2026-10-29');
    const model = await c.readModel(range); const next = model.plan.occurrences.find(round => round.anchorDate === '2026-11-10');
    assert.deepEqual(next.assigneeIds, ['member']); assert.equal(next.assignmentFixed, true); assert.equal(model.configurations[0].configuration.intervalDays, 7);
    assert.equal(f.archive.at(-1).body.schedulerVersion, 'liflow-shared-2-draft-40'); assert.equal(d.state().rejected.length, 0);
  } finally { d.connection.close(); }
});
