import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, projectCalendarEvents, validateEventDraft } from '../src/features/calendar/events.ts';
import { customRecurrenceDates, customRecurrenceLabel, validateCustomRecurrence } from '../src/features/calendar/recurrence.ts';
const { calendarDraftKey, calendarDraftVersion, readLocalCalendar, saveCalendarDraft, saveCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const date = '2026-01-01';
const make = rule => ({ ...newEventDraft(date, 'Asia/Tokyo'), title: 'カスタムの予定', recurrence: 'custom', customRecurrence: rule });
const event = (rule, patch = {}) => ({ ...make(rule), ...patch, id: 'custom.event', revision: 1 });
async function fixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => { local.snapshot = await readLocalCalendar(h.database); } };
  return { ...h, local };
}
test('custom recurrence rejects malformed intervals units weekdays and monthly ordinals without accepting prototype names', () => {
  for (const rule of [undefined, null, {}, { unit: 'toString', interval: 1 }, { unit: 'day', interval: 0 }, { unit: 'day', interval: 1.5 }, { unit: 'year', interval: 1000 },
    { unit: 'week', interval: 1, weekdays: [] }, { unit: 'week', interval: 1, weekdays: [-1] }, { unit: 'week', interval: 1, weekdays: [7] },
    { unit: 'month', interval: 1, on: 'weekday', ordinal: 0, weekday: 1 }, { unit: 'month', interval: 1, on: 'weekday', ordinal: 6, weekday: 1 }, { unit: 'month', interval: 1, on: 'unknown' }]) assert.throws(() => validateCustomRecurrence(rule));
  assert.deepEqual(validateCustomRecurrence({ unit: 'week', interval: 2, weekdays: [4, 1, 1] }), { unit: 'week', interval: 2, weekdays: [1, 4] });
  assert.throws(() => validateEventDraft({ ...make({ unit: 'day', interval: 1 }), customRecurrence: undefined }));
  assert.throws(() => customRecurrenceDates({ unit: 'day', interval: 1 }, date, date, '2030-01-01'));
});
test('custom day and multi weekday intervals seek old series and retain one stable anchor per occurrence', () => {
  const daily = event({ unit: 'day', interval: 3 }, { startDate: '2010-01-01', endDate: '2010-01-01' });
  assert.deepEqual(projectCalendarEvents([daily], [], '2026-10-01', '2026-10-31').map(row => row.anchorDate), ['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10', '2026-10-13', '2026-10-16', '2026-10-19', '2026-10-22', '2026-10-25', '2026-10-28', '2026-10-31']);
  const weekly = event({ unit: 'week', interval: 2, weekdays: [1, 4] }, { untilDate: '2026-01-26' });
  const rows = projectCalendarEvents([weekly], [], date, '2026-02-05');
  assert.deepEqual(rows.map(row => row.startDate), ['2026-01-01', '2026-01-12', '2026-01-15', '2026-01-26']);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  const cancelled = projectCalendarEvents([weekly], [{ eventId: weekly.id, anchorDate: '2026-01-12', override: null, revision: 1 }], '2026-01-12', '2026-01-12');
  // A moved instance is still identified by its original valid weekly anchor.
  assert.deepEqual(projectCalendarEvents([weekly], [{ eventId: weekly.id, anchorDate: '2026-01-12', override: { ...make({ unit: 'day', interval: 1 }), recurrence: 'none', startDate: '2026-01-13', endDate: '2026-01-13' }, revision: 1 }], '2026-01-13', '2026-01-13').map(row => row.id), ['custom.event:2026-01-12']);
  assert.equal(cancelled.length, 0);
});
test('custom monthly second last and fifth weekdays and leap years never invent missing civil dates', () => {
  const rows = rule => projectCalendarEvents([event(rule)], [], date, '2026-03-31').map(row => row.startDate);
  assert.deepEqual(rows({ unit: 'month', interval: 1, on: 'weekday', ordinal: 2, weekday: 2 }), ['2026-01-13', '2026-02-10', '2026-03-10']);
  assert.deepEqual(rows({ unit: 'month', interval: 1, on: 'weekday', ordinal: -1, weekday: 5 }), ['2026-01-30', '2026-02-27', '2026-03-27']);
  assert.deepEqual(rows({ unit: 'month', interval: 1, on: 'weekday', ordinal: 5, weekday: 1 }), ['2026-03-30']);
  assert.deepEqual(rows({ unit: 'month', interval: 2, on: 'weekday', ordinal: 2, weekday: 2 }), ['2026-01-13', '2026-03-10']);
  const end = event({ unit: 'month', interval: 1, on: 'date' }, { startDate: '2026-01-31', endDate: '2026-01-31' });
  assert.deepEqual(projectCalendarEvents([end], [], date, '2026-03-31').map(row => row.startDate), ['2026-01-31', '2026-03-31']);
  const leap = event({ unit: 'year', interval: 2 }, { startDate: '2024-02-29', endDate: '2024-02-29', allDay: true });
  assert.equal(projectCalendarEvents([leap], [], '2026-01-01', '2026-12-31').length, 0);
  assert.equal(projectCalendarEvents([leap], [], '2028-01-01', '2028-12-31')[0].startDate, '2028-02-29');
  assert.equal(customRecurrenceLabel({ unit: 'month', interval: 1, on: 'weekday', ordinal: -1, weekday: 5 }, date), '毎月（最後の金曜）');
});
test('ended custom series do not break later calendar windows while moved instances and final multi day spans remain visible', () => {
  const ended = event({ unit: 'week', interval: 1, weekdays: [4] }, { untilDate: '2026-01-08' });
  const current = { ...newEventDraft('2026-03-03', 'Asia/Tokyo'), id: 'current.event', revision: 1, title: '現在の予定' };
  assert.deepEqual(projectCalendarEvents([ended, current], [], '2026-03-01', '2026-03-31').map(row => row.id), ['current.event:2026-03-03']);
  const moved = { eventId: ended.id, anchorDate: '2026-01-08', revision: 1, override: { ...newEventDraft('2026-03-10', 'Asia/Tokyo'), title: '移動した最終回' } };
  assert.deepEqual(projectCalendarEvents([ended], [moved], '2026-03-01', '2026-03-31').map(row => row.id), ['custom.event:2026-01-08']);
  const multiDay = { ...ended, endDate: '2026-01-03', allDay: true };
  assert.deepEqual(projectCalendarEvents([multiDay], [], '2026-01-10', '2026-01-10').map(row => row.anchorDate), ['2026-01-08']);
});
test('custom cadence edits require review before clearing existing exceptions and draft digests reveal no input text', async t => {
  const h = await fixture(t); const rule = { unit: 'week', interval: 1, weekdays: [1] };
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: make(rule) });
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-01-05', value: { ...newEventDraft('2026-01-06', 'Asia/Tokyo'), title: '変更した回' } });
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 1, value: make({ ...rule, weekdays: [2] }) }), /個別/);
  assert.equal((await readLocalCalendar(h.database)).exceptions.length, 1);
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, value: make({ ...rule, weekdays: [2] }), resetExceptions: true });
  assert.equal((await readLocalCalendar(h.database)).exceptions.length, 0);
  const draft = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: { ...make(rule), title: '公開しない入力' } };
  await saveCalendarDraft(h.database, draft); const saved = (await readLocalCalendar(h.database)).draft;
  assert.equal(calendarDraftKey(saved), 'new'); assert.match(calendarDraftVersion(saved), /^[0-9a-f]{64}$/);
  assert.equal(calendarDraftVersion(saved), calendarDraftVersion(draft));
  assert.notEqual(calendarDraftVersion(saved), calendarDraftVersion({ ...saved, value: { ...saved.value, customRecurrence: { ...rule, weekdays: [2] } } }));
});
for (const platform of ['ios', 'android']) {
  test(`${platform} custom repeat screen applies the latest interval weekdays and last monthly weekday and rejects incomplete input`, async () => {
    const saved = []; const screen = screenHarness('src/features/calendar/custom-recurrence-screen.tsx', { exportName: 'CustomRecurrenceScreen', platform, props: { date, onBack() {}, onSave: async value => saved.push(value) } });
    await screen.change('繰り返しの間隔', '2'); await screen.press('月曜日に繰り返す');
    const apply = screen.button('カスタム繰り返しを適用'); apply.props.onPress(); apply.props.onPress(); await screen.flush();
    assert.equal(saved.length, 1); assert.deepEqual(saved[0], { unit: 'week', interval: 2, weekdays: [1, 4] });
    await screen.press('月'); await screen.press('第N曜日'); await screen.press('月の週を選択');
    if (platform === 'ios') { screen.nodes().find(node => node.type === 'NativePicker').props.onValueChange('-1'); screen.render(); await screen.press('週の選択を完了'); }
    else await screen.press('最後');
    await screen.press('月の曜日を選択');
    if (platform === 'ios') { screen.nodes().find(node => node.type === 'NativePicker').props.onValueChange('5'); screen.render(); await screen.press('曜日の選択を完了'); }
    else await screen.press('金曜日');
    await screen.press('カスタム繰り返しを適用'); await screen.flush();
    assert.deepEqual(saved.at(-1), { unit: 'month', interval: 2, on: 'weekday', ordinal: -1, weekday: 5 });
    await screen.change('繰り返しの間隔', '1e2'); const count = saved.length; await screen.press('カスタム繰り返しを適用'); await screen.flush(); assert.equal(saved.length, count);
    assert.ok(screen.text().includes('1〜999'));
  });
  test(`${platform} choosing custom repeat saves unfinished private input before routing and keeps custom as the final option`, async t => {
    const h = await fixture(t); const navigation = []; let closed = 0;
    const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, navigate: (...args) => navigation.push(args), props: {
      initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(date, 'Asia/Tokyo') }, local: h.local, repeatReturnTo: platform === 'ios' ? 'personal' : 'group', onClose: () => closed++, onSaved() {},
    } });
    await screen.change('予定名', '入力途中の予定'); await screen.change('予定のメモ', '送らない本文'); await screen.press('繰り返しを選択');
    if (platform === 'ios') { assert.equal(screen.nodes().filter(node => node.type === 'NativePickerItem').at(-1).props.value, 'custom'); screen.nodes().find(node => node.type === 'NativePicker').props.onValueChange('custom'); }
    else await screen.press('カスタム');
    for (let n = 0; n < 20 && !navigation.length; n++) await screen.flush();
    assert.equal(closed, 1); assert.equal(navigation.length, 1); assert.equal(navigation[0][0], 'push');
    assert.equal(navigation[0][1].pathname, '/calendar-repeat'); assert.equal(navigation[0][1].params.returnTo, platform === 'ios' ? 'personal' : 'group');
    assert.equal(JSON.stringify(navigation).includes('送らない本文'), false);
    const stored = await readLocalCalendar(h.database); assert.equal(stored.draft.value.title, '入力途中の予定'); assert.equal(stored.draft.value.notes, '送らない本文'); assert.equal(stored.events.length, 0);
  });
}
test('returning from custom settings waits for the matching stored draft instead of reopening a stale rule', async t => {
  const h = await fixture(t);
  const draft = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: { ...newEventDraft(date, 'Asia/Tokyo'), title: '保持した予定' } };
  await saveCalendarDraft(h.database, draft); await h.local.refresh();
  const updated = { ...draft, value: make({ unit: 'month', interval: 1, on: 'weekday', ordinal: 2, weekday: 2 }) };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', params: { calendarDraft: 'new', calendarDraftVersion: calendarDraftVersion(updated) }, props: { today: date, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null } });
  assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '予定を保存'), false);
  await saveCalendarDraft(h.database, updated); await h.local.refresh(); screen.render();
  assert.ok(screen.nodes().some(node => node.props.accessibilityLabel === '予定を保存')); assert.ok(screen.text().includes('毎月（第2火曜）'));
  assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '予定名').props.defaultValue, 'カスタムの予定');
});
test('iOS wheel keeps native motion authoritative while capturing every intermediate choice and the final value', async () => {
  const changes = []; let closed = 0;
  const props = { title: '繰り返し', value: 'none', options: [{ value: 'none', label: '繰り返さない' }, { value: 'daily', label: '毎日' }, { value: 'weekly', label: '毎週' }, { value: 'biweekly', label: '隔週' }],
    onSelect: value => { changes.push(value); props.value = value; }, onClose: () => closed++ };
  const screen = screenHarness('src/features/calendar/calendar-option-picker.tsx', { exportName: 'CalendarOptionPicker', platform: 'ios', props });
  for (const value of ['daily', 'weekly', 'biweekly']) {
    const wheel = screen.nodes().find(node => node.type === 'NativePicker'); wheel.props.onValueChange(value); screen.render();
    assert.equal(screen.nodes().find(node => node.type === 'NativePicker').props.selectedValue, 'none', 'JS must not reset the moving native wheel to an older event');
  }
  await screen.press('繰り返しの選択を完了');
  assert.deepEqual(changes, ['daily', 'weekly', 'biweekly']); assert.equal(props.value, 'biweekly'); assert.equal(closed, 1);
});
test('custom repeat route applies only a personal draft and returns to the original workspace with an exact content digest', async t => {
  const h = await fixture(t); const navigation = []; let disabled = 0;
  await saveCalendarDraft(h.database, { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: { ...newEventDraft(date, 'Asia/Tokyo'), title: '端末だけの予定' } }); await h.local.refresh();
  const screen = screenHarness('src/app/calendar-repeat.tsx', { database: h.database, params: { draft: 'new', returnTo: 'group' }, layoutEffect: fn => fn(), disablePrevention: () => disabled++, navigate: (...args) => navigation.push(args),
    mocks: { '@/features/calendar/use-local-calendar': { useLocalCalendar: () => h.local } } });
  await screen.change('繰り返しの間隔', '3'); await screen.press('月曜日に繰り返す'); await screen.press('カスタム繰り返しを適用');
  for (let n = 0; n < 20 && !navigation.length; n++) await screen.flush();
  const saved = (await readLocalCalendar(h.database)).draft;
  assert.equal(saved.value.title, '端末だけの予定'); assert.deepEqual(saved.value.customRecurrence, { unit: 'week', interval: 3, weekdays: [1, 4] });
  assert.equal(navigation[0][1].pathname, '/(tabs)/explore'); assert.equal(navigation[0][1].params.calendarDraftVersion, calendarDraftVersion(saved));
  assert.equal(JSON.stringify(navigation).includes('端末だけの予定'), false); assert.equal(disabled, 1);
  assert.equal((await readLocalCalendar(h.database)).events.length, 0, 'the custom page never creates a second event');
});
test('direct custom route links cannot change birthday cadence or a single occurrence and cannot redirect outside the calendar', async t => {
  const h = await fixture(t);
  for (const kind of ['birthday', 'one']) {
    const draft = { eventId: kind === 'one' ? 'event.test' : null, anchorDate: kind === 'one' ? date : null, revision: kind === 'one' ? 1 : 0, exceptionRevision: 0,
      scope: kind === 'one' ? 'one' : 'series', value: { ...newEventDraft(date, 'Asia/Tokyo', kind === 'birthday'), title: '保護する入力' } };
    await saveCalendarDraft(h.database, draft); await h.local.refresh(); const navigation = []; const writes = h.writes.length;
    const screen = screenHarness('src/app/calendar-repeat.tsx', { database: h.database, params: { draft: calendarDraftKey(draft), returnTo: 'https://invalid.example' }, layoutEffect: fn => fn(), navigate: (...args) => navigation.push(args), mocks: { '@/features/calendar/use-local-calendar': { useLocalCalendar: () => h.local } } });
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'カスタム繰り返しを適用'), false); assert.equal(h.writes.length, writes);
    await screen.press('予定の入力に戻る'); for (let n = 0; n < 15 && !navigation.length; n++) await screen.flush();
    assert.equal(navigation[0][1].pathname, '/(tabs)/explore');
  }
});
