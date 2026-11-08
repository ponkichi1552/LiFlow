import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privatePlannerSyncFixture, privatePreferenceInput } from './helpers/private-planner-sync.mjs';
const { snapshotPersonalPlacementPreferences } = await import('../src/features/planner/personal-placement-preferences.ts');
const { snapshotPrivatePlannerPreferences, privatePlannerPreferenceValues } = await import('../src/features/sharing/private-planner/preferences.ts');
const { createPersonalCapacityEditor } = await import('../src/features/settings/personal-capacity-editor.ts');
const { createPrivatePreferenceEditor } = await import('../src/features/sharing/private-planner/preference-editor.ts');
const { createOwnerRhythmSettings } = await import('../src/features/settings/owner-rhythm-settings.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');
const { bindAdaptiveOwnerReader } = await import('../src/platform/storage/adaptive-owner-inputs.ts');
const repository = await import('../src/platform/storage/repository.ts');
const empty = () => ({ allowedBands: [], dayOverrides: [] });
const changed = () => ({ allowedBands: [], maximumMinutes: 90, dayOverrides: [{ date: '2026-11-09', holiday: false, maximumMinutes: 0, allowedBands: [] }, { date: '2026-11-10', holiday: true }] });

test('personal capacity settings preserve zero and explicit empty bands while rejecting invalid dates duplicates and hidden data', () => {
  const raw = changed(); const before = structuredClone(raw); assert.deepEqual(snapshotPersonalPlacementPreferences(raw), raw); assert.deepEqual(raw, before);
  for (const update of [{ maximumMinutes: -1 }, { maximumMinutes: Infinity }, { maximumMinutes: 1.5 }, { dayOverrides: null },
    { dayOverrides: [{ date: '2026-02-30', holiday: true }] }, { dayOverrides: [{ date: '2026-11-09', holiday: 'false' }] },
    { dayOverrides: [{ date: '2026-11-09', holiday: true }, { date: '2026-11-09', holiday: false }] },
    { dayOverrides: [{ date: '2026-11-09', maximumMinutes: NaN }] }, { dayOverrides: [{ date: '2026-11-09', accessToken: 'forbidden' }] }]) {
    assert.throws(() => snapshotPersonalPlacementPreferences({ ...empty(), ...update }));
  }
  assert.throws(() => snapshotPrivatePlannerPreferences({ ...privatePreferenceInput(), dayOverrides: null }));
});

test('capacity form autosaves without creating values on open and retains invalid or newer in-flight input', async () => {
  let saved = empty(); const writes = []; let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const editor = createPersonalCapacityEditor({ initial: saved, delayMs: 60_000, save: async (value, expected) => {
    assert.deepEqual(expected, saved); writes.push(value); saved = value; if (writes.length === 1) { entered(); await gate; }
  } });
  assert.equal(await editor.flush(), true); assert.equal(writes.length, 0);
  editor.change(raw => ({ ...raw, maximum: '９０' })); const flushing = editor.flush(); await started;
  editor.change(raw => ({ ...raw, maximum: '120' })); release(); assert.equal(await flushing, true); assert.equal(saved.maximumMinutes, 120);
  editor.change(raw => ({ ...raw, maximum: '1a' })); let left = 0; assert.equal(await editor.navigateAfterSave(() => left++), true); assert.equal(left, 1);
  assert.equal(saved.maximumMinutes, 120); assert.equal(editor.getSnapshot().raw.maximum, '120'); editor.resumeNavigation();
  editor.change(raw => ({ ...raw, maximum: '' })); assert.equal(await editor.flush(), true); assert.equal(saved.maximumMinutes, undefined);
});

test('capacity date edits preserve per-date caps and bands and cannot save duplicate dates', async () => {
  let saved = changed(); const editor = createPersonalCapacityEditor({ initial: saved, delayMs: 60_000, save: async value => { saved = value; } });
  editor.addDate('2026-11-11'); editor.addDate('2026-11-11'); assert.equal(editor.getSnapshot().raw.days.length, 3);
  editor.change(raw => ({ ...raw, days: raw.days.map(day => day.date === '2026-11-11' ? { ...day, maximum: '30', holiday: false } : day) }));
  assert.equal(await editor.flush(), true); assert.equal(saved.dayOverrides[2].maximumMinutes, 30); assert.equal(saved.dayOverrides[0].maximumMinutes, 0);
  editor.change(raw => ({ ...raw, days: raw.days.map(day => ({ ...day, date: '2026-11-10' })) })); assert.equal(await editor.flush(), false);
  assert.equal(saved.dayOverrides.length, 3);
});

test('actual anonymous SQLite capacity save is idempotent rejects stale changes and rolls back planning and preferences together', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-05T01:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const initial = await repository.loadPersonalPlacementPreferences(h.database); assert.deepEqual(initial, empty());
  const value = changed(); await repository.savePersonalPlacementPreferences(h.database, value, initial);
  const row = () => h.connection.prepare('SELECT * FROM personal_adaptive_preferences').get(); const accepted = row();
  await repository.savePersonalPlacementPreferences(h.database, value, initial); assert.deepEqual(row(), accepted);
  await assert.rejects(repository.savePersonalPlacementPreferences(h.database, { ...value, maximumMinutes: 50 }, initial), /別の操作/);
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, memberId: repository.LOCAL_MEMBER_ID,
    now: new Date(), timeZone: 'Asia/Tokyo' });
  // Setup is not completed, so no speculative schedules are created by editing settings.
  assert.equal(context, null);
  const before = h.connection.serialize(); const run = h.database.runAsync;
  h.database.runAsync = async (...args) => { if (args[0].includes('INSERT INTO personal_adaptive_preferences')) { await run(...args); throw new Error('disk failure after write'); } return run(...args); };
  await assert.rejects(repository.savePersonalPlacementPreferences(h.database, { ...value, maximumMinutes: 50 }, value), /disk failure/);
  assert.deepEqual(h.connection.serialize(), before); h.database.runAsync = run;
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: null, common: null, assertCurrent() {} })); t.after(stop);
  await assert.rejects(repository.savePersonalPlacementPreferences(h.database, empty(), value), /本人/); assert.deepEqual(h.connection.serialize(), before);
});

test('owner rhythm and capacity saves serialize through one protected revision and legacy editors retain the new optional settings', async t => {
  const h = await privatePlannerSyncFixture(t); const initial = privatePreferenceInput(); const local = { frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 };
  await h.left.store.save(0, initial); const source = createOwnerRhythmSettings({ store: h.left.store, saved: await h.left.store.read(), local,
    timeZone: 'Asia/Tokyo', saveLocal: async () => {} });
  const value = { ...changed(), allowedBands: initial.allowedBands };
  await Promise.all([source.savePlacement(value, source.placement()), source.save({ ...local, restDays: [1], heavyDailyLimit: 3 })]);
  const saved = await h.left.store.read(); assert.equal(saved.revision, 3); assert.equal(saved.maximumMinutes, 90); assert.deepEqual(saved.dayOverrides, changed().dayOverrides); assert.deepEqual(saved.restDays, [1]);
  const editor = createPrivatePreferenceEditor({ store: h.left.store, saved, defaults: initial, delayMs: 60_000 });
  editor.change(raw => ({ ...raw, normal: '5' })); assert.equal(await editor.flush(), true);
  assert.deepEqual(source.placement(), value); assert.deepEqual((await h.left.store.read()).dayOverrides, changed().dayOverrides);
  assert.equal((await h.left.store.read()).maximumMinutes, 90);
});

test('a capacity edit first recovers a partial rhythm publication rather than orphaning its durable SQLite projection', async t => {
  const h = await privatePlannerSyncFixture(t); const local = { frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 };
  await h.left.store.save(0, privatePreferenceInput()); let fail = true; let applied;
  const source = createOwnerRhythmSettings({ store: h.left.store, saved: await h.left.store.read(), local, timeZone: 'Asia/Tokyo',
    saveLocal: async value => { if (fail) throw new Error('local unavailable'); applied = value; } });
  const next = { ...local, heavyDailyLimit: 4 }; await assert.rejects(source.save(next), /local unavailable/);
  const expected = source.placement(); const value = { ...expected, maximumMinutes: 75 };
  await assert.rejects(source.savePlacement(value, expected), /local unavailable/);
  assert.equal((await h.left.store.read()).revision, 2); assert.equal((await h.left.store.read()).maximumMinutes, undefined);
  fail = false; await source.savePlacement(value, expected); assert.deepEqual(applied, next);
  assert.equal(await h.left.store.readLocalProjection(), null); assert.equal((await h.left.store.read()).revision, 3);
  assert.equal((await h.left.store.read()).maximumMinutes, 75); assert.equal((await h.left.store.read()).loadLimits.heavyDailyLimit, 4);
});

test('a valid larger private date profile remains recoverable through the bounded rhythm publication journal', async t => {
  const h = await privatePlannerSyncFixture(t); const { addDays } = await import('../src/domain/scheduling/local-date.ts');
  const value = { ...privatePreferenceInput(), dayOverrides: [] };
  while (JSON.stringify(value).length < 8400) value.dayOverrides.push({ date: addDays('2027-01-01', value.dayOverrides.length), holiday: true });
  await h.left.store.save(0, value); const local = { frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 };
  let fail = true; const source = createOwnerRhythmSettings({ store: h.left.store, saved: await h.left.store.read(), local, timeZone: 'Asia/Tokyo',
    saveLocal: async () => { if (fail) throw new Error('interrupted'); } });
  await assert.rejects(source.save({ ...local, heavyDailyLimit: 4 }), /interrupted/);
  const pending = await h.left.store.readLocalProjection(); assert.ok(JSON.stringify(pending).length > 8192);
  assert.deepEqual(pending.preferences.dayOverrides, value.dayOverrides); fail = false; await source.resume();
  assert.equal(await h.left.store.readLocalProjection(), null); assert.deepEqual((await h.left.store.read()).dayOverrides, value.dayOverrides);
  await h.left.sync.synchronize(); await h.right.sync.synchronize(); assert.deepEqual((await h.right.store.read()).dayOverrides, value.dayOverrides);
});

test('actual private geometry applies protected date holidays and zero day budgets without rewriting personal completion models', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-05T01:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1], enabledChoreIds: [createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID)[1].id], previousDates: {}, weatherLocation: null });
  const before = h.connection.prepare('SELECT chore_id,state_json,active_round_id FROM personal_adaptive_state ORDER BY chore_id').all();
  const own = { ...privatePreferenceInput(), allowedBands: [], maximumMinutes: 90, dayOverrides: changed().dayOverrides };
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: { ...own, schemaVersion: 1, ownerUserId: 'owner', revision: 1 }, common: null, assertCurrent() {} })); t.after(stop);
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, memberId: repository.LOCAL_MEMBER_ID, now: new Date(), timeZone: 'Asia/Tokyo' });
  const geometry = context.prepareGeometry(); const work = geometry.days.find(day => day.date === '2026-11-09'); const rest = geometry.days.find(day => day.date === '2026-11-10');
  assert.equal(work.holiday, false); assert.equal(work.maximumMinutes, 0); assert.deepEqual(work.allowed, []);
  assert.equal(rest.holiday, true); assert.equal(rest.maximumMinutes, 90); assert.equal(rest.allowed[0].end - rest.allowed[0].start, 10 * 3600_000);
  await repository.loadPlannerSnapshot(h.database);
  assert.deepEqual(h.connection.prepare('SELECT chore_id,state_json,active_round_id FROM personal_adaptive_state ORDER BY chore_id').all(), before);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_preferences').get().n, 0);
});

test('encrypted private preference synchronization retains new date and minute settings without exposing them to shared storage', async t => {
  const h = await privatePlannerSyncFixture(t); const value = { ...privatePreferenceInput(), ...changed() };
  await h.left.store.save(0, value); await h.left.sync.synchronize(); await h.right.sync.synchronize();
  assert.deepEqual(privatePlannerPreferenceValues(await h.right.store.read()), value);
  for (const text of ['maximumMinutes', 'dayOverrides', '2026-11-09']) assert.equal(JSON.stringify(h.wire.current).includes(text), false);
  const invalid = { ...value, dayOverrides: Array.from({ length: 300 }, (_, i) => ({ date: `2027-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`, holiday: true })) };
  assert.throws(() => snapshotPrivatePlannerPreferences(invalid), /多すぎ/);
});

for (const platform of ['ios', 'android']) test(`${platform} actual capacity controls autosave a date override and minute limit without a save button`, async t => {
  let saved = empty(); const effects = []; const source = { initial: saved, save: async (value, expected) => { assert.deepEqual(expected, saved); saved = value; } };
  const ui = screenHarness('src/features/settings/personal-capacity-settings.tsx', { exportName: 'PersonalCapacitySettings', platform,
    effect: callback => effects.push(callback), props: { today: '2026-11-05', load: async () => source, onDraftChange() {} } });
  t.after(effects.shift()()); for (let i = 0; i < 8; i++) await ui.flush();
  await ui.press('2026/11/05 平日'); for (let i = 0; i < 8; i++) await ui.flush();
  const field = ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '平日の家事時間上限'); assert.ok(field);
  field.props.onChangeText('60'); await ui.flush();
  ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '平日の家事時間上限').props.onBlur();
  for (let i = 0; i < 12; i++) await ui.flush();
  assert.equal(saved.dayTypes.workday.maximumMinutes, 60); assert.deepEqual(saved.dayTypes.holiday, {}); assert.deepEqual(saved.dayOverrides, [{ date: '2026-11-05', holiday: true }]);
  assert.equal(ui.text().includes('保存する'), false); assert.equal(ui.text().includes('自動移動'), false);
});

test('collapsing a settings section retains incomplete capacity input instead of unmounting its writer or silently discarding it', async t => {
  let open = true; let saves = 0; const effects = [];
  const ui = screenHarness('src/features/settings/personal-capacity-settings.tsx', { exportName: 'PersonalCapacitySettings',
    effect: callback => effects.push(callback), props: { today: '2026-11-05', load: async () => ({ initial: empty(), save: async () => saves++ }),
      onDraftChange() {}, children: content => open ? content : null } });
  t.after(effects.shift()()); for (let i = 0; i < 8; i++) await ui.flush();
  await ui.change('平日の家事時間上限', '1a'); open = false; ui.render(); assert.equal(ui.text(), '');
  open = true; ui.render(); assert.equal(ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '平日の家事時間上限').props.value, '1a');
  assert.match(ui.text(), /0以上/); assert.equal(saves, 0);
});
