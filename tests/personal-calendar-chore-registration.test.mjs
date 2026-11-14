import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { readAdaptivePersonalInside } from '../src/platform/storage/adaptive-personal-chores.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { commonChoreLinks } = await import('../src/features/planner/common-chore-links.ts');
const repository = await import('../src/platform/storage/repository.ts');
const { choreCalendarTiming, choreCalendarSpan } = await import('../src/domain/chores/calendar-timing.ts');
const { timedCalendarChoreEvents } = await import('../src/features/calendar/timed-chores.ts');
const flush = async ui => { for (let i = 0; i < 30; i++) await ui.flush(); };
async function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-12T01:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1,2,3,4,5,6,7], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
  return h;
}
test('personal calendar one-off registration completes once and undo restores its exact day without creating a calendar event or learning a fake period', async t => {
  const h = await setup(t); const command = { operationId: 'calendar-intent.once', name: '荷物の片付け', date: '2026-11-12', repeat: false };
  const chore = await repository.registerPersonalCalendarChore(h.database, command);
  assert.equal((await repository.registerPersonalCalendarChore(h.database, command)).id, chore.id);
  const snapshot = await repository.loadPlannerSnapshot(h.database); const entry = snapshot.scheduleEntries.find(row => row.choreId === chore.id);
  assert.equal(entry.suggestedDate, command.date); assert.equal(snapshot.scheduleEntries.filter(row => row.choreId === chore.id).length, 1);
  assert.equal(snapshot.personalCadences[chore.id].label, 'この日だけ'); assert.equal(snapshot.personalCadences[chore.id].automatic, false);
  const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt);
  assert.equal((await repository.loadPlannerSnapshot(h.database)).scheduleEntries.filter(row => row.choreId === chore.id).length, 0);
  const done = await readAdaptivePersonalInside(h.database, chore.id); assert.equal(done.state.validUnitCount, 0); assert.equal(done.state.model, null);
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
  const restored = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === chore.id);
  assert.equal(restored.id, entry.id); assert.equal(restored.suggestedDate, entry.suggestedDate);
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions WHERE id=?').get(chore.id).n, 1);
  await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 10 });
  assert.equal((await repository.readPersonalCalendarChore(h.database, chore.id)).definition.personalSchedule.once, undefined);
  await repository.updateChoreSettings(h.database, chore.id, { resetSchedule: true });
  assert.equal((await repository.readPersonalCalendarChore(h.database, chore.id)).definition.personalSchedule.once, true);
});
test('personal calendar moves the actual pending round without changing its recurring cadence or accepting stale edits', async t => {
  const h = await setup(t); const chore = await repository.addPersonalChore(h.database, { name: '植物に水をあげる', intervalDays: 14 });
  const before = await repository.readPersonalCalendarChore(h.database, chore.id);
  const command = { operationId: 'calendar-intent.move', choreId: chore.id, name: chore.name, date: '2026-12-01', repeat: false,
    expectedDefinition: before.signature, expectedRoundId: before.roundId, expectedPlanRevision: before.planRevision, options: { windowRadiusDays: 0 } };
  await repository.registerPersonalCalendarChore(h.database, command);
  const moved = await readAdaptivePersonalInside(h.database, chore.id);
  assert.equal(moved.plan.id, before.roundId); assert.equal(moved.plan.recommendedDate, command.date); assert.equal(moved.state.model.days, 14);
  assert.equal((await repository.readPersonalCalendarChore(h.database, chore.id)).signature, before.signature);
  await repository.updatePlannerSettings(h.database, { ...(await repository.loadPlannerSnapshot(h.database)).settings, restDays: [6,7] });
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).plan.recommendedDate, command.date, 'automatic input changes keep an explicitly chosen day');
  await assert.rejects(repository.registerPersonalCalendarChore(h.database, { ...command, operationId: 'calendar-intent.stale', date: '2026-12-02' }), /更新/);
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).plan.recommendedDate, command.date);
  const snapshot = await repository.loadPlannerSnapshot(h.database); assert.equal(snapshot.scheduleEntries.filter(row => row.choreId === chore.id).length, 1);
});
test('personal calendar recurring registration uses one existing definition and a real monthly date while invalid input leaves no partial chore', async t => {
  const h = await setup(t); const snapshot = await repository.loadPlannerSnapshot(h.database); const existing = snapshot.chores.find(row => row.personalRecipeId && row.personalSchedulingKind !== 'seasonal');
  const observed = await repository.readPersonalCalendarChore(h.database, existing.id);
  const before = h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions').get().n;
  await repository.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.monthly', choreId: existing.id, expectedDefinition: observed.signature,
    expectedRoundId: observed.roundId, expectedPlanRevision: observed.planRevision, name: existing.name, date: '2026-11-21', repeat: true, monthly: true });
  const selected = await repository.readPersonalCalendarChore(h.database, existing.id); assert.equal(selected.definition.personalSchedule.monthlyDay, 21);
  assert.equal((await readAdaptivePersonalInside(h.database, existing.id)).plan.recommendedDate, '2026-11-21');
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions').get().n, before);
  await assert.rejects(repository.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.invalid', name: '無効', date: '2026-11-12', repeat: true, intervalDays: 0 }), /周期/);
  assert.equal(h.connection.prepare("SELECT COUNT(*) n FROM chore_definitions WHERE name='無効'").get().n, 0);
  const oneOff = { ...selected.definition, personalSchedule: { startDate: '2026-11-21', once: true } };
  assert.deepEqual(commonChoreLinks([oneOff], [{ ...existing, enabled: true }]), [], 'an explicitly private one-off is never suppressed or completed by a shared same-name chore');
});
for (const platform of ['ios','android']) {
  test(`${platform} personal calendar adds a chore through the original form with optional repeat details and no separate page`, async t => {
    const h = await setup(t); const snapshot = await repository.loadPlannerSnapshot(h.database); const saved = []; const routes = [];
    const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
    const data = { database: h.database, snapshot, refresh: async () => {} };
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, personalData: () => data,
      navigate: (...args) => routes.push(args), props: { today: '2026-11-12', timeZone: 'Asia/Tokyo', local, selectedDate: '2026-11-12', onSelectDate: date => saved.push(date), dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null } });
    t.after(() => ui.unmount()); await ui.press('予定を追加'); await ui.press('家事を追加'); await ui.press('新しい家事を作る');
    assert.ok(ui.text().includes('予定を追加')); await ui.change('家事名', '個人の片付け');
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'), false);
    await ui.press('家事の詳細設定'); assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'), false);
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の目安時間'), false);
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の期間幅'), false);
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '開始を選択'));
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '終了を選択'));
    ui.nodes().find(node => node.props.accessibilityLabel === '追加する家事を繰り返す' && node.props.onPress).props.onPress(); await ui.flush();
    await ui.change('追加する家事の周期', '10');
    assert.equal(h.connection.prepare("SELECT COUNT(*) n FROM chore_definitions WHERE name='個人の片付け'").get().n, 0);
    await ui.press('予定を保存'); await flush(ui);
    assert.deepEqual(routes, []); const row = h.connection.prepare("SELECT id FROM chore_definitions WHERE name='個人の片付け'").get(); assert.ok(row);
    assert.equal((await readAdaptivePersonalInside(h.database, row.id)).state.model.days, 10);
    assert.equal((await readLocalCalendar(h.database)).events.length, 0);
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '家事名'), false, 'durable save returns to the calendar');
  });
}

test('personal calendar keeps explicit start and end through completion, undo, retries and background replanning', async t => {
  const h = await setup(t); const timing = { allDay: false, startMinute: 19*60, endMinute: 20*60+30, endDayOffset: 0, timeZone: 'Asia/Tokyo' };
  const command = { operationId: 'calendar-intent.timed', name: '家事の時間指定', date: '2026-11-12', repeat: false, timing };
  const chore = await repository.registerPersonalCalendarChore(h.database, command);
  const span = choreCalendarSpan(command.date, timing);
  let snapshot = await repository.loadPlannerSnapshot(h.database); const entry = snapshot.scheduleEntries.find(row => row.choreId === chore.id);
  assert.deepEqual(entry.calendarTime, span); assert.equal(entry.windowStart, command.date); assert.equal(entry.windowEnd, command.date);
  const [event] = timedCalendarChoreEvents([{ id: entry.id, name: chore.name, ...span, onOpen() {} }], 'Asia/Tokyo');
  assert.equal(event.startMinute, 1140); assert.equal(event.endMinute, 1230); assert.equal(event.title, chore.name);
  await repository.registerPersonalCalendarChore(h.database, command);
  const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt);
  assert.equal((await repository.loadPlannerSnapshot(h.database)).scheduleEntries.some(row => row.choreId === chore.id), false);
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
  snapshot = await repository.loadPlannerSnapshot(h.database);
  assert.deepEqual(snapshot.scheduleEntries.find(row => row.choreId === chore.id).calendarTime, span);
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  const before = await repository.readPersonalCalendarChore(h.database, chore.id);
  await repository.registerPersonalCalendarChore(h.database, { ...command, operationId: 'calendar-intent.timed-move', date: '2026-11-14',
    choreId: chore.id, expectedDefinition: before.signature, expectedRoundId: before.roundId, expectedPlanRevision: before.planRevision });
  const moved = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === chore.id);
  assert.equal(moved.suggestedDate, '2026-11-14'); assert.deepEqual(moved.calendarTime, choreCalendarSpan('2026-11-14', timing));
});
test('personal calendar uses the entered date range and advances recurring time without hidden radius settings', async t => {
  const h = await setup(t); const timing = { allDay: true, startMinute: 540, endMinute: 555, endDayOffset: 2, timeZone: 'Asia/Tokyo' };
  const once = await repository.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.range', name: '期間の家事', date: '2026-11-12', repeat: false, timing });
  let entry = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === once.id);
  assert.equal(entry.windowStart, '2026-11-12'); assert.equal(entry.windowEnd, '2026-11-14'); assert.equal(entry.calendarTime, undefined);
  const repeatedTiming = { ...timing, allDay: false, startMinute: 23*60, endMinute: 30, endDayOffset: 1 };
  const repeated = await repository.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.recurring-time', name: '夜の家事', date: '2026-11-12', repeat: true, intervalDays: 7, timing: repeatedTiming });
  entry = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === repeated.id);
  assert.deepEqual(entry.calendarTime, choreCalendarSpan('2026-11-12', repeatedTiming));
  await repository.completeChoreWithReceipt(h.database, entry);
  const next = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === repeated.id);
  assert.equal(next.suggestedDate, '2026-11-19'); assert.deepEqual(next.calendarTime, choreCalendarSpan('2026-11-19', repeatedTiming));
  const before = h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions').get().n;
  await assert.rejects(repository.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.invalid-time', name: '無効な時刻', date: '2026-11-12', repeat: false, timing: { ...repeatedTiming, endDayOffset: 0 } }), /終了/);
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions').get().n, before);
  assert.throws(() => choreCalendarTiming({ startDate: '2026-11-12', endDate: '2026-11-11', ...timing }), /開始/);
  assert.throws(() => choreCalendarSpan('2027-03-14', { ...timing, allDay: false, endDayOffset: 0, startMinute: 150, endMinute: 240, timeZone: 'America/New_York' }), /夏時間/);
});
test('a missing future recurring clock never prevents completion or invents a valid time', async t => {
  const h = await setup(t); t.mock.timers.setTime(Date.parse('2027-03-07T12:00:00Z'));
  const chore = await repository.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.future-gap', name: '夏時間をまたぐ家事', date: '2027-03-07', repeat: true, intervalDays: 7,
    timing: { allDay: false, startMinute: 150, endMinute: 210, endDayOffset: 0, timeZone: 'America/New_York' } });
  const entry = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === chore.id);
  assert.ok(await repository.completeChoreWithReceipt(h.database, entry));
  const next = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row => row.choreId === chore.id);
  assert.equal(next.suggestedDate, '2027-03-14'); assert.equal(next.calendarTime, undefined); assert.equal(next.calendarTimeIssue, true);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} personal chore optional clocks stay blank and persist date-only without an invented time slot`, async t => {
    const h = await setup(t); const snapshot = await repository.loadPlannerSnapshot(h.database); const saved = [];
    const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
    const ui = screenHarness('src/features/calendar/personal-chore-registration.tsx', { exportName: 'PersonalCalendarChoreRegistration', platform, personalData: () => ({ database: h.database, snapshot, refresh: async () => {} }), props: {
      local, date: '2026-11-12', initialValue: { ...newEventDraft('2026-11-12', 'Asia/Tokyo'), startMinute: 780, endMinute: 900 }, onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {},
    } }); t.after(() => ui.unmount()); await ui.press('新しい家事を作る'); await ui.change('家事名', '時刻を決めない家事');
    assert.equal(ui.button('開始を選択').props.accessibilityValue.text, '未指定'); assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '未指定');
    await ui.press('予定を保存'); await flush(ui); assert.deepEqual(saved, ['2026-11-12']);
    const row = h.connection.prepare("SELECT id FROM chore_definitions WHERE name='時刻を決めない家事'").get(); assert.ok(row);
    const plan = await readAdaptivePersonalInside(h.database, row.id); assert.equal(plan.plan.slot, null); assert.equal(plan.plan.manualTime, undefined);
    assert.equal((await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(entry => entry.choreId === row.id).calendarTime, undefined);
    assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  });
  test(`${platform} personal chore partial clocks do not save and both selected clocks persist the exact interval`, async t => {
    const h = await setup(t); const snapshot = await repository.loadPlannerSnapshot(h.database); let picker; const saved = [];
    const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
    const ui = screenHarness('src/features/calendar/personal-chore-registration.tsx', { exportName: 'PersonalCalendarChoreRegistration', platform, datePicker: options => { picker = options; }, personalData: () => ({ database: h.database, snapshot, refresh: async () => {} }), props: {
      local, date: '2026-11-12', onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {},
    } }); t.after(() => ui.unmount()); await ui.press('新しい家事を作る'); await ui.change('家事名', '時刻を決める家事');
    const pick = async (label, clock) => {
      await ui.press(`${label}を選択`); const date = new Date(`2026-11-12T${clock}:00Z`);
      if (platform === 'ios') { ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({ type: 'set' }, date); await ui.flush(); await ui.press(`${label}の選択を完了`); }
      else { picker.onValueChange({ type: 'set' }, date); await ui.flush(); }
    };
    await pick('開始', '19:00'); await ui.press('予定を保存'); await flush(ui);
    assert.deepEqual(saved, []); assert.ok(ui.text().includes('開始時刻と終了時刻を両方選んでください'));
    assert.equal(h.connection.prepare("SELECT COUNT(*) n FROM chore_definitions WHERE name='時刻を決める家事'").get().n, 0);
    await pick('終了', '20:30'); await ui.press('予定を保存'); await flush(ui); assert.deepEqual(saved, ['2026-11-12']);
    const row = h.connection.prepare("SELECT id FROM chore_definitions WHERE name='時刻を決める家事'").get();
    const entry = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries.find(row_ => row_.choreId === row.id);
    assert.deepEqual(entry.calendarTime, { start: Date.parse('2026-11-12T10:00:00Z'), end: Date.parse('2026-11-12T11:30:00Z') });
  });
}
