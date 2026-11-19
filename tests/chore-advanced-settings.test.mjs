import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createPersonalChoreDefinitions } from '../src/domain/chores/personal-catalog.ts';
import { applyPersonalChoreSettingsPatch } from '../src/domain/chores/personal-settings-patch.ts';
import { hasChoreScheduleSettings } from '../src/domain/chores/cycle-policy.ts';
import { monthlyDateOnOrAfter, monthlyIntervalAt } from '../src/domain/chores/personal-schedule.ts';
import { readAdaptivePersonalInside } from '../src/platform/storage/adaptive-personal-chores.ts';
import { createChoreAdvancedEditor } from '../src/features/settings/chore-advanced-editor.ts';
import { initialConfigurationDraft } from '../src/features/sharing/v2-ui/initial-configuration-draft.ts';
const repository = await import('../src/platform/storage/repository.ts');

async function fixture(t, day = '2026-01-25') {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${day}T01:00:00Z`) });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const chore = createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID)[0];
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1, 2, 3, 4, 5, 6, 7], enabledChoreIds: [chore.id], previousDates: {}, weatherLocation: null });
  const patch = value => repository.updateChoreSettings(h.database, chore.id, value);
  return { ...h, chore, patch, snapshot: () => repository.loadPlannerSnapshot(h.database), clock: date => t.mock.timers.setTime(Date.parse(`${date}T01:00:00Z`)) };
}

test('personal monthly dates use real calendar months and restore 31 after February instead of drifting or inventing 30-day rules', () => {
  for (const [day, expected] of [['2026-02-01', '2026-02-28'], ['2028-02-01', '2028-02-29'], ['2026-03-01', '2026-03-31'], ['2026-12-31', '2026-12-31'], ['2027-01-01', '2027-01-31']]) {
    assert.equal(monthlyDateOnOrAfter(day, 31), expected);
  }
  assert.equal(monthlyIntervalAt('2026-02-28', 31), 28); assert.equal(monthlyIntervalAt('2028-02-29', 31), 29);
  assert.equal(monthlyIntervalAt('2026-03-31', 31), 31);
  for (const day of [0, 32, 1.5, NaN]) assert.throws(() => monthlyDateOnOrAfter('2026-01-01', day));
});

test('actual personal monthly completion early late and exact Undo retain the calendar rule without manufacturing adaptive observations', async t => {
  const h = await fixture(t); await h.patch({ personalSchedule: { startDate: '2026-01-31', monthlyDay: 31 }, windowRadiusDays: 0, holidayPriority: false });
  let snapshot = await h.snapshot(); let entry = snapshot.scheduleEntries[0]; assert.equal(entry.cycleBaseDate, '2026-01-31'); assert.equal(entry.suggestedDate, '2026-01-31');
  assert.equal(snapshot.personalCadences[h.chore.id].label, '毎月31日'); assert.equal(snapshot.personalCadences[h.chore.id].automatic, false);
  h.clock('2026-01-29'); await repository.completeChoreWithReceipt(h.database, entry);
  entry = (await h.snapshot()).scheduleEntries[0]; assert.equal(entry.cycleBaseDate, '2026-02-28', 'an early completion closes the issued January round');
  assert.equal((await h.snapshot()).personalCadences[h.chore.id].days, 28, 'the displayed period uses the same actual monthly interval as its plan');
  h.clock('2026-03-10'); const receipt = await repository.completeChoreWithReceipt(h.database, entry);
  assert.equal((await h.snapshot()).scheduleEntries[0].cycleBaseDate, '2026-03-31');
  const state = (await readAdaptivePersonalInside(h.database, h.chore.id)).state;
  assert.equal(state.model.method, 'monthlyDate'); assert.equal(state.validUnitCount, 0); assert.equal(state.validIntervalCount, 0);
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
  const restored = (await h.snapshot()).scheduleEntries[0]; assert.equal(restored.id, entry.id); assert.equal(restored.cycleBaseDate, '2026-02-28'); assert.equal(restored.status, 'overdue');
  const before = h.connection.serialize(); await h.snapshot(); assert.deepEqual(h.connection.serialize(), before, 'ordinary display reads do not regenerate monthly work');
});

test('personal start dates and later interval edits use the actual last completion rather than replaying the original start date', async t => {
  const h = await fixture(t); await h.patch({ cycleDays: 7, personalSchedule: { startDate: '2026-01-30' }, windowRadiusDays: 0, holidayPriority: false });
  const first = (await h.snapshot()).scheduleEntries[0]; assert.equal(first.cycleBaseDate, '2026-01-30');
  h.clock('2026-01-30'); await repository.completeChoreWithReceipt(h.database, first);
  assert.equal((await h.snapshot()).scheduleEntries[0].cycleBaseDate, '2026-02-06');
  h.clock('2026-02-01'); await h.patch({ cycleDays: 6 });
  assert.equal((await h.snapshot()).scheduleEntries[0].cycleBaseDate, '2026-02-05');
});

test('personal content edits preserve identity history scheduling defaults and the exact existing plan without reallocation', async t => {
  const h = await fixture(t); const snapshot = await h.snapshot(); const plan = await readAdaptivePersonalInside(h.database, h.chore.id);
  const defaults = snapshot.chores.find(row => row.id === h.chore.id).personalScheduleDefaults;
  const history = h.connection.prepare('SELECT * FROM personal_adaptive_actions ORDER BY sequence').all();
  await h.patch({ name: '部屋を片付ける', description: '自分向けの説明', instructions: ['片付ける', '掃除する'], tools: ['布'], cautions: ['滑らないようにする'], procedureSections: [{ title: '準備', steps: ['窓を開ける'] }] });
  const updated = (await h.snapshot()).chores.find(row => row.id === h.chore.id);
  for (const [field, value] of Object.entries({ name: '部屋を片付ける', description: '自分向けの説明', instructions: ['片付ける', '掃除する'], tools: ['布'], cautions: ['滑らないようにする'], procedureSections: [{ title: '準備', steps: ['窓を開ける'] }] })) assert.deepEqual(updated[field], value);
  assert.deepEqual(updated.personalScheduleDefaults, defaults); assert.equal(updated.id, h.chore.id);
  assert.deepEqual(await readAdaptivePersonalInside(h.database, h.chore.id), plan); assert.deepEqual(h.connection.prepare('SELECT * FROM personal_adaptive_actions ORDER BY sequence').all(), history);
  const before = h.connection.serialize(); await assert.rejects(h.patch({ name: ' ', personalSchedule: { startDate: '2026-01-31', monthlyDay: 31 } })); assert.deepEqual(h.connection.serialize(), before);
});

test('a private schedule reset clears monthly date overrides while keeping edited descriptions and completion records', async t => {
  const h = await fixture(t); await h.patch({ personalSchedule: { startDate: '2026-01-31', monthlyDay: 31 }, name: '自分の掃除', instructions: ['拭く'] });
  h.clock('2026-01-31'); await repository.completeChoreWithReceipt(h.database, (await h.snapshot()).scheduleEntries[0]);
  const completed = h.connection.prepare('SELECT * FROM chore_completions').all();
  await h.patch({ resetSchedule: true }); const next = (await h.snapshot()).chores.find(row => row.id === h.chore.id);
  assert.equal(next.personalSchedule, undefined); assert.equal(next.name, '自分の掃除'); assert.deepEqual(next.instructions, ['拭く']); assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions').all(), completed);
});

test('switching a private monthly rule back to days preserves actual completions and resumes the saved day cadence', async t => {
  const h = await fixture(t); await h.patch({ cycleDays: 7, personalSchedule: { startDate: '2026-01-31', monthlyDay: 31 }, windowRadiusDays: 0, holidayPriority: false });
  h.clock('2026-02-02'); await repository.completeChoreWithReceipt(h.database, (await h.snapshot()).scheduleEntries[0]);
  const history = h.connection.prepare('SELECT * FROM chore_completions').all();
  await h.patch({ personalSchedule: { startDate: '2026-01-31' } });
  const snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries[0].cycleBaseDate, '2026-02-09');
  assert.equal(snapshot.personalCadences[h.chore.id].label, '7日ごと'); assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions').all(), history);
});

test('an advanced private editor keeps unrelated queued fields and abandons invalid input without delaying navigation', async () => {
  let chore = createPersonalChoreDefinitions('local-household')[0]; const patches = [];
  const editor = createChoreAdvancedEditor(chore, '2026-11-12', async patch => { patches.push(patch); chore = applyPersonalChoreSettingsPatch(chore, patch); });
  editor.changeText('description', '説明'); editor.changeText('tools', '布\n\n掃除機'); assert.equal(await editor.flush(), true);
  assert.deepEqual(chore.tools, ['布', '掃除機']); assert.equal(chore.description, '説明');
  editor.changeSchedule({ startDate: '2026-12-01', monthly: true, monthlyDay: '21' }); assert.equal(await editor.flush(), true); assert.deepEqual(chore.personalSchedule, { startDate: '2026-12-01', monthlyDay: 21 });
  editor.changeText('name', ' '); let departed = false; await editor.navigateAfterSave(() => { departed = true; });
  assert.equal(departed, true); assert.equal(editor.getSnapshot().raw.name, chore.name); assert.ok(patches.every(patch => patch.name !== ' '));
});

test('editing an individual chore start date keeps a one-time rule and the latest saved clocks', async t => {
  const h = await fixture(t);
  const calendarTiming = { allDay: false, endDayOffset: 1, startMinute: 21 * 60, endMinute: 60, timeZone: 'Asia/Tokyo' };
  const chore = await repository.registerPersonalCalendarChore(h.database, {
    operationId: 'calendar-intent.edit-once', name: '夜の片付け', date: '2026-01-26', repeat: false, timing: calendarTiming,
    options: { windowRadiusDays: 0, estimatedMinutes: 15, load: 'normal', holidayPriority: false },
  });
  const latestTiming = { ...calendarTiming, endMinute: 75 };
  const editor = createChoreAdvancedEditor(chore, '2026-01-25', patch => repository.updateChoreSettings(h.database, chore.id, patch));
  await repository.updateChoreSettings(h.database, chore.id, { personalSchedule: { ...chore.personalSchedule, calendarTiming: latestTiming } });
  editor.changeSchedule({ startDate: '2026-01-27' });
  assert.equal(await editor.flush(), true);
  const snapshot = await h.snapshot();
  assert.deepEqual(snapshot.chores.find(row => row.id === chore.id).personalSchedule, { startDate: '2026-01-27', once: true, calendarTiming: latestTiming });
  assert.equal(snapshot.scheduleEntries.find(row => row.choreId === chore.id)?.suggestedDate, '2026-01-27');
  await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 7 });
  assert.deepEqual((await h.snapshot()).chores.find(row => row.id === chore.id).personalSchedule, { startDate: '2026-01-27', calendarTiming: latestTiming });
});

test('unsubmitted shared initial dates survive only the internal details step and do not cross accounts groups or controllers', async () => {
  const scope = {}; const draft = initialConfigurationDraft(scope, 'group:owner:chore', '2026-11-12');
  draft.change({ ...draft.read(), preset: 'common', interval: '7' }); draft.openDetails(); await draft.navigateAfterSave(() => {});
  const details = initialConfigurationDraft(scope, 'group:owner:chore', '2026-11-12'); assert.equal(details, draft);
  details.change({ ...details.read(), monthly: true, anchor: '2026-11-21' }); await details.navigateAfterSave(() => {}); draft.resumeBasic();
  assert.equal(draft.read().monthly, true); assert.equal(draft.read().preset, 'common'); assert.equal(draft.read().anchor, '2026-11-21');
  for (const foreign of [initialConfigurationDraft({}, 'group:owner:chore', '2026-11-12'), initialConfigurationDraft(scope, 'other:owner:chore', '2026-11-12'), initialConfigurationDraft(scope, 'group:member:chore', '2026-11-12')]) assert.equal(foreign.read().monthly, false);
  await draft.navigateAfterSave(() => {}); assert.equal(draft.read().monthly, false); assert.equal(draft.read().preset, '');
});

test('guide-only chores stay readable but have no scheduled-settings affordances while seasonal numeric disabled and monthly chores remain configurable', () => {
  const all = createPersonalChoreDefinitions('local-household'); const guide = all.filter(row => !hasChoreScheduleSettings(row)); assert.ok(guide.length > 0);
  for (const chore of guide) assert.equal(hasChoreScheduleSettings({ ...chore, enabled: true }), false);
  const seasonal = all.find(row => row.personalSchedulingKind === 'seasonal'); assert.equal(hasChoreScheduleSettings(seasonal), true);
  assert.equal(hasChoreScheduleSettings({ ...all[0], enabled: false }), true);
  assert.equal(hasChoreScheduleSettings({ ...guide[0], recommendedCycleDays: 14 }), true);
  assert.equal(hasChoreScheduleSettings({ ...guide[0], personalSchedule: { startDate: '2026-11-12', monthlyDay: 21 } }), true);
  const screen = screenHarness('src/features/chores/chore-guide.tsx', { exportName: 'ChoreGuide', props: { chore: guide[0], mode: 'balanced', procedureAction: { type: 'Pressable', props: { accessibilityRole: 'button', accessibilityLabel: '予定の有効化' } } } });
  assert.ok(screen.text().includes(guide[0].name)); assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '予定の有効化'), false);
});

test('actual shared display fallback periods never turn guide-only recipes into configurable recurring chores', async t => {
  const { createV2DevelopmentPreview } = await import('../src/features/sharing/development/v2-preview-session.ts');
  const { sharingTestCrypto } = await import('./helpers/sharing-crypto.mjs');
  const h = createDatabase(); t.after(() => h.connection.close()); let n = 0;
  const preview = await createV2DevelopmentPreview({ development: true, crypto: sharingTestCrypto, makeId: () => `advanced-catalog-${++n}`, now: () => new Date('2026-11-12T01:00:00Z'), openDatabase: async () => ({ database: h.database, close: async () => {} }) });
  const model = await preview.readModel({ management: true });
  const shoe = model.plan.chores.find(chore => chore.id.endsWith('liflow-catalog-6.026')); assert.ok(shoe); assert.equal(shoe.frequencyDaysByMode.balanced, 7, 'exercise the existing display-only fallback');
  assert.equal(model.configurations.find(row => row.choreId === shoe.id)?.configuration ?? null, null);
  assert.equal(hasChoreScheduleSettings(shoe), false);
  assert.equal(hasChoreScheduleSettings(model.plan.chores.find(chore => chore.id.endsWith('liflow-catalog-6.001'))), true);
});

for (const platform of ['ios', 'android']) test(`${platform} personal advanced settings edits every private content field and monthly rule through the actual controls`, async t => {
  let chore = createPersonalChoreDefinitions('local-household')[0]; const effects = [];
  const screen = screenHarness('src/features/settings/chore-advanced-settings.tsx', { exportName: 'ChoreAdvancedSettings', platform, effect: callback => effects.push(callback), props: { chore, today: '2026-11-12', save: async patch => { chore = applyPersonalChoreSettingsPatch(chore, patch); } } });
  t.after(() => screen.unmount()); for (const effect of effects.splice(0)) effect();
  for (const [field, value] of [['家事名', '確認の家事'], ['説明', '説明です'], ['手順', '準備\n実施'], ['使う道具', '布'], ['注意点', '電源を切る']]) { await screen.change(field, value); await screen.endEditing(field); for (let i = 0; i < 5; i++) await screen.flush(); }
  assert.equal(chore.name, '確認の家事'); assert.equal(chore.description, '説明です'); assert.deepEqual(chore.instructions, ['準備', '実施']); assert.deepEqual(chore.tools, ['布']); assert.deepEqual(chore.cautions, ['電源を切る']);
  await screen.press('毎月'); await screen.change('個人家事の毎月の日付', '21'); await screen.endEditing('個人家事の毎月の日付'); for (let i = 0; i < 8; i++) await screen.flush();
  assert.deepEqual(chore.personalSchedule, { startDate: '2026-11-12', monthlyDay: 21 });
});

test('the personal advanced settings route remains available inside a shared group and always edits the private database', async t => {
  const h = await fixture(t); let snapshot = await h.snapshot(); const navigation = []; const effects = [];
  const data = { database: h.database, snapshot, refresh: async () => { snapshot = await h.snapshot(); data.snapshot = snapshot; }, error: null, loading: false };
  const book = screenHarness('src/features/settings/chore-settings-screen.tsx', { exportName: 'ChoreSettingsBook', props: { choreId: h.chore.id, data }, navigate: (...args) => navigation.push(args) });
  t.after(() => book.unmount()); await book.press('詳細設定を開く'); assert.equal(navigation.at(-1)[1].pathname, '/settings/chore-options'); assert.equal(navigation.at(-1)[1].params.choreId, h.chore.id);
  const route = screenHarness('src/app/settings/chore-options.tsx', { params: { choreId: h.chore.id }, effect: callback => effects.push(callback), mocks: {
    '../../hooks/use-planner-data': { usePlannerData: options => { assert.deepEqual(options, { personal: true }); return data; } },
  } }); t.after(() => route.unmount()); for (const effect of effects.splice(0)) effect();
  await route.change('説明', 'グループには渡さない説明'); await route.endEditing('説明'); for (let i = 0; i < 8; i++) await route.flush();
  assert.equal((await h.snapshot()).chores.find(row => row.id === h.chore.id).description, 'グループには渡さない説明');
});
