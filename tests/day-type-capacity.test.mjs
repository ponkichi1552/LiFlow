import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privatePlannerSyncFixture, privatePreferenceInput } from './helpers/private-planner-sync.mjs';
const { snapshotDayTypeCapacity } = await import('../src/features/planner/day-type-capacity.ts');
const { prepareAdaptivePlacementInput } = await import('../src/features/planner/adaptive-input.ts');
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');
const { snapshotPersonalPlacementPreferences } = await import('../src/features/planner/personal-placement-preferences.ts');
const { privatePlannerAllowedWindows } = await import('../src/features/sharing/private-planner/preferences.ts');
const { createPersonalCapacityEditor } = await import('../src/features/settings/personal-capacity-editor.ts');
const { createPrivatePreferenceEditor } = await import('../src/features/sharing/private-planner/preference-editor.ts');
const { createOwnerRhythmSettings } = await import('../src/features/settings/owner-rhythm-settings.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');
const repository = await import('../src/platform/storage/repository.ts');
const empty = () => ({ allowedBands: [], dayOverrides: [] });
const types = () => ({ workday: { maximumMinutes: 30, allowedBands: [{ startMinute: 1140, endMinute: 1260 }] },
  holiday: { maximumMinutes: 90, allowedBands: [{ startMinute: 540, endMinute: 1080 }] } });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const geometry = (overrides = {}) => prepareAdaptivePlacementInput({ from: '2026-11-09', through: '2026-11-10', timeZone: 'UTC',
  preferences: { ...empty(), restDays: [2], heavyLimit: 2, normalLimit: 2, dayTypes: types(), ...overrides }, events: [], exceptions: [], fingerprint });
const span = (date, start, end) => ({ start: Date.parse(`${date}T${start}:00Z`), end: Date.parse(`${date}T${end}:00Z`) });

test('day type capacity rejects hidden fields and invalid bounds while preserving explicit zeros and merging copied bands', () => {
  const original = types(); original.workday.allowedBands.push({ startMinute: 1200, endMinute: 1320 });
  const copy = snapshotDayTypeCapacity(original); assert.equal(original.workday.allowedBands.length, 2);
  assert.deepEqual(copy.workday.allowedBands, [{ startMinute: 1140, endMinute: 1320 }]); copy.workday.allowedBands[0].endMinute = 1440;
  assert.equal(original.workday.allowedBands[0].endMinute, 1260);
  assert.deepEqual(snapshotDayTypeCapacity({ workday: { maximumMinutes: 0, allowedBands: [] }, holiday: {} }), { workday: { maximumMinutes: 0, allowedBands: [] }, holiday: {} });
  for (const value of [null, {}, { workday: {}, holiday: {}, token: 'hidden' }, { workday: { detail: 'hidden' }, holiday: {} },
    { workday: { maximumMinutes: -1 }, holiday: {} }, { workday: { maximumMinutes: 1.5 }, holiday: {} },
    { workday: { allowedBands: [{ startMinute: 1260, endMinute: 1140 }] }, holiday: {} },
    { workday: { allowedBands: [{ startMinute: 0, endMinute: 1440, secret: 'hidden' }] }, holiday: {} }]) assert.throws(() => snapshotDayTypeCapacity(value));
});

test('date holiday changes switch both duration budget and allowed hours with explicit date exceptions taking precedence', () => {
  const value = geometry(); assert.deepEqual(value.days.map(day => [day.holiday, day.maximumMinutes]), [[false, 30], [true, 90]]);
  assert.deepEqual(value.days[0].allowed, [span('2026-11-09', '19:00', '21:00')]);
  assert.deepEqual(value.days[1].allowed, [span('2026-11-10', '09:00', '18:00')]);
  const switched = geometry({ dayOverrides: [{ date: '2026-11-09', holiday: true }, { date: '2026-11-10', holiday: false, maximumMinutes: 0, allowedBands: [] }] });
  assert.equal(switched.days[0].maximumMinutes, 90); assert.deepEqual(switched.days[0].allowed, [span('2026-11-09', '09:00', '18:00')]);
  assert.equal(switched.days[1].maximumMinutes, 0); assert.deepEqual(switched.days[1].allowed, []);
  assert.notEqual(value.revision, switched.revision);
  const privateValue = { ...privatePreferenceInput(), restDays: [2], dayTypes: types(), dayOverrides: [{ date: '2026-11-09', holiday: true }] , timeZone: 'UTC' };
  assert.deepEqual(privatePlannerAllowedWindows(privateValue, '2026-11-09', '2026-11-10').windows,
    [span('2026-11-09', '09:00', '18:00'), span('2026-11-10', '09:00', '18:00')]);
});

test('new day type hours and minute caps constrain actual placement rather than only changing displayed settings', () => {
  const input = geometry(); const date = '2026-11-09';
  const tasks = ['one', 'two'].map(id => ({ id, choreId: id, baseDate: date, periodDays: 1, minutes: 20, load: 'normal', purpose: 'direct', fixedDaily: false }));
  const results = placeAdaptiveRounds({ ...input, tasks, fixedLoads: [], today: date, now: Date.parse(`${date}T00:00Z`) });
  assert.equal(results.filter(result => result.slot).length, 1);
  assert.deepEqual(results.find(result => result.slot).slot, span(date, '19:00', '19:20'));
  const blocked = { ...input, busy: [span(date, '19:00', '21:00')] };
  assert.equal(placeAdaptiveRounds({ ...blocked, tasks, fixedLoads: [], today: date, now: Date.parse(`${date}T00:00Z`) }).filter(result => result.slot).length, 0);
});

test('capacity edits preserve legacy caps until touched and invalid time ranges never replace approved hours', async () => {
  let saved = { ...empty(), maximumMinutes: 90 }; let writes = 0;
  const editor = createPersonalCapacityEditor({ initial: saved, delayMs: 60000, save: async (value, before) => { assert.deepEqual(before, saved); writes++; saved = value; } });
  await editor.flush(); assert.equal(writes, 0); assert.equal(saved.dayTypes, undefined);
  editor.setMaximum('workday', '30'); await editor.flush(); assert.deepEqual(saved.dayTypes, { workday: { maximumMinutes: 30 }, holiday: { maximumMinutes: 90 } });
  assert.equal(saved.maximumMinutes, undefined);
  editor.setBandTime('workday', undefined, 'startMinute', 1320); assert.equal(await editor.flush(), false); assert.equal(writes, 1);
  const id = editor.getSnapshot().raw.dayTypes.workday.bands[0].id;
  editor.setBandTime('workday', id, 'endMinute', 1440); assert.equal(await editor.flush(), true); assert.equal(writes, 2);
  assert.deepEqual(saved.dayTypes.workday.allowedBands, [{ startMinute: 1320, endMinute: 1440 }]);
  editor.setMaximum('workday', ''); await editor.flush(); assert.equal(saved.dayTypes.workday.maximumMinutes, undefined); assert.equal(saved.dayTypes.holiday.maximumMinutes, 90);
});

test('holiday taps toggle effective weekdays and restore defaults without discarding per-date caps or bands', async () => {
  let saved = { ...empty(), dayOverrides: [{ date: '2026-11-09', maximumMinutes: 0, allowedBands: [] }] };
  const editor = createPersonalCapacityEditor({ initial: saved, delayMs: 60000, save: async value => { saved = value; } });
  editor.toggleHoliday('2026-11-09', [7]); await editor.flush(); assert.deepEqual(saved.dayOverrides, [{ date: '2026-11-09', holiday: true, maximumMinutes: 0, allowedBands: [] }]);
  editor.toggleHoliday('2026-11-09', [7]); await editor.flush(); assert.deepEqual(saved.dayOverrides, [{ date: '2026-11-09', maximumMinutes: 0, allowedBands: [] }]);
  editor.toggleHoliday('2026-11-08', [7]); await editor.flush(); assert.equal(saved.dayOverrides.find(day => day.date === '2026-11-08').holiday, false);
  editor.toggleHoliday('2026-11-08', [7]); await editor.flush(); assert.equal(saved.dayOverrides.some(day => day.date === '2026-11-08'), false);
});

test('encrypted owner settings retain both day types across legacy editors rhythm updates and another own device', async t => {
  const h = await privatePlannerSyncFixture(t); const initial = { ...privatePreferenceInput(), dayTypes: types() };
  await h.left.store.save(0, initial); const local = { frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 };
  const rhythm = createOwnerRhythmSettings({ store: h.left.store, saved: await h.left.store.read(), local, timeZone: 'UTC', saveLocal: async () => {} });
  assert.deepEqual(rhythm.placement().dayTypes, types()); await rhythm.save({ ...local, restDays: [2] });
  const legacy = createPrivatePreferenceEditor({ store: h.left.store, saved: await h.left.store.read(), defaults: initial, delayMs: 60000 });
  legacy.change(raw => ({ ...raw, normal: '3' })); await legacy.flush(); await h.left.sync.synchronize(); await h.right.sync.synchronize();
  assert.deepEqual((await h.right.store.read()).dayTypes, types()); assert.equal(JSON.stringify(h.wire.current).includes('dayTypes'), false);
});

test('anonymous SQLite loads new day type settings into the actual planner without a login', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-05T01:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [7], enabledChoreIds: [createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID)[1].id], previousDates: {}, weatherLocation: null });
  const initial = await repository.loadPersonalPlacementPreferences(h.database); await repository.savePersonalPlacementPreferences(h.database, { ...initial, dayTypes: types() }, initial);
  const restored = await repository.loadPersonalPlacementPreferences(h.database); assert.deepEqual(restored.dayTypes, types());
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, memberId: repository.LOCAL_MEMBER_ID, now: new Date(), timeZone: 'UTC' });
  const input = context.prepareGeometry(); assert.equal(input.days[0].maximumMinutes, 30);
  assert.deepEqual(input.days[0].allowed, [span('2026-11-05', '19:00', '21:00')]);
  assert.deepEqual(snapshotPersonalPlacementPreferences(restored), restored);
});

for (const platform of ['ios', 'android']) test(`${platform} rhythm calendar and time pickers save the selected values without submitting unfinished bands`, async t => {
  let saved = empty(); let writes = 0; const effects = []; let androidPicker;
  const ui = screenHarness('src/features/settings/personal-capacity-settings.tsx', { exportName: 'PersonalCapacitySettings', platform,
    effect: callback => effects.push(callback), datePicker: value => { androidPicker = value; }, props: { today: '2026-11-05', restDays: [7],
      load: async () => ({ initial: saved, save: async (value, expected) => { assert.deepEqual(expected, saved); saved = value; writes++; } }), onDraftChange() {} } });
  t.after(effects.shift()()); const settle = async () => { for (let i = 0; i < 10; i++) await ui.flush(); }; await settle();
  assert.equal(writes, 0); await ui.press('2026/11/05 平日');
  await ui.change('平日の家事時間上限', '30'); ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '平日の家事時間上限').props.onBlur(); await settle();
  assert.equal(saved.dayOverrides[0].holiday, true); assert.equal(saved.dayTypes.workday.maximumMinutes, 30);
  const pick = async (label, hour) => {
    await ui.press(`${label}を選択`); const picker = platform === 'android' ? androidPicker : ui.nodes().find(node => node.type === 'DateTimePicker').props;
    picker.onValueChange({}, new Date(`2026-11-05T${String(hour).padStart(2, '0')}:00:00Z`)); await settle();
    if (platform === 'ios') await ui.press(`${label}の選択を完了`);
  };
  const before = writes; await pick('平日の開始時刻', 22); assert.equal(writes, before); assert.match(ui.text(), /開始より後/);
  await pick('平日の終了時刻', 23); ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '平日の家事時間上限').props.onBlur(); await settle();
  assert.deepEqual(saved.dayTypes.workday.allowedBands, [{ startMinute: 1320, endMinute: 1380 }]);
});

test('ios confirming an untouched time wheel commits its displayed value and keeps the picker open through the first draft update', async t => {
  let saved = { ...empty(), dayTypes: { workday: { allowedBands: [] }, holiday: {} } }; const effects = [];
  const ui = screenHarness('src/features/settings/personal-capacity-settings.tsx', { exportName: 'PersonalCapacitySettings', platform: 'ios',
    effect: callback => effects.push(callback), props: { today: '2026-11-05', load: async () => ({ initial: saved, save: async value => { saved = value; } }), onDraftChange() {} } });
  t.after(effects.shift()()); const settle = async () => { for (let i = 0; i < 8; i++) await ui.flush(); }; await settle();
  await ui.press('平日の開始時刻を選択'); await ui.press('平日の開始時刻の選択を完了');
  await ui.press('平日の終了時刻を選択'); await ui.press('平日の終了時刻の選択を完了');
  ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '平日の家事時間上限').props.onBlur(); await settle();
  assert.deepEqual(saved.dayTypes.workday.allowedBands, [{ startMinute: 1140, endMinute: 1260 }]);
});

test('approved initial hours match displayed defaults and explicit saved or empty bands override them', () => {
  const input = geometry({ dayTypes: undefined });
  assert.deepEqual(input.days[0].allowed, [span('2026-11-09', '19:00', '21:00')]);
  assert.deepEqual(input.days[1].allowed, [span('2026-11-10', '09:00', '19:00')]);
  const privateInput = { ...privatePreferenceInput(), allowedBands: [], restDays: [2], timeZone: 'UTC' };
  assert.deepEqual(privatePlannerAllowedWindows(privateInput, '2026-11-09', '2026-11-10').windows, [...input.days[0].allowed, ...input.days[1].allowed]);
  const legacy = geometry({ dayTypes: undefined, allowedBands: [{ weekday: 1, startMinute: 420, endMinute: 480 }], dayOverrides: [{ date: '2026-11-10', allowedBands: [] }] });
  assert.deepEqual(legacy.days[0].allowed, [span('2026-11-09', '07:00', '08:00')]); assert.deepEqual(legacy.days[1].allowed, []);
});
