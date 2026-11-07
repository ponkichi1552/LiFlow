import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, INITIAL_CATEGORIES } from '../src/features/calendar/events.ts';
import { personalLongCalendarPreviews } from '../src/features/calendar/long-cycle-preview.ts';
const store = await import('../src/platform/storage/calendar-events.ts');
const repository = await import('../src/platform/storage/repository.ts');
const date = '2026-10-30';
const value = patch => ({ ...newEventDraft(date, 'Asia/Tokyo'), title: '予定', ...patch });
const draft = patch => ({ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: value(), ...patch });
async function fixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const local = { database: h.database, snapshot: await store.readLocalCalendar(h.database), loading: false, error: null,
    refresh: async () => { local.snapshot = await store.readLocalCalendar(h.database); } };
  return { ...h, local };
}
test('calendar drafts retain whitespace-only unfinished titles without trapping the editor on close', async t => {
  const h = await fixture(t); const input = draft({ value: value({ title: ' \t ' }) });
  await store.saveCalendarDraft(h.database, input);
  assert.equal((await store.readLocalCalendar(h.database)).draft.value.title, input.value.title);
  await assert.rejects(store.saveCalendarEvent(h.database, { expectedRevision: 0, value: input.value }), /予定名/);
});
test('an older local event save cannot erase newer unfinished input for the same editor scope', async t => {
  const h = await fixture(t); const id = await store.saveCalendarEvent(h.database, { expectedRevision: 0, value: value() });
  await store.saveCalendarDraft(h.database, draft({ eventId: id, revision: 1, value: value({ notes: '別の編集画面で入力中' }) }));
  await store.saveCalendarEvent(h.database, { id, expectedRevision: 1, value: value({ title: '先に保存を開始した変更' }) });
  const saved = await store.readLocalCalendar(h.database); assert.equal(saved.events[0].revision, 2);
  assert.equal(saved.draft?.value.notes, '別の編集画面で入力中');
});
test('an invalid occurrence-only draft or empty deletion anchor cannot become a whole-series command', async t => {
  const h = await fixture(t); const recurring = value({ recurrence: 'weekly' }); const id = await store.saveCalendarEvent(h.database, { expectedRevision: 0, value: recurring });
  for (const anchorDate of [null, '']) await assert.rejects(store.saveCalendarDraft(h.database, draft({ eventId: id, revision: 1, scope: 'one', anchorDate, value: recurring })));
  await assert.rejects(store.deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate: '' }));
  assert.equal((await store.readLocalCalendar(h.database)).events.length, 1);
});
test('an adopted three-calendar-month cycle stays eligible for distant next-round display during an eighty-nine-day quarter', () => {
  const chore = { id: 'quarter', enabled: true, frequencyDaysByMode: { frequent: 90, balanced: 90, relaxed: 90 }, windowRadiusDays: 7 };
  const snapshot = { chores: [chore], completions: [], settings: { frequencyMode: 'balanced' }, scheduleEntries: [{ id: 'q-next', choreId: chore.id,
    cycleBaseDate: '2027-04-30', suggestedDate: '2027-04-30', windowStart: '2027-04-23', windowEnd: '2027-05-07' }],
    personalCadences: { quarter: { days: 89, automatic: true, windowRadiusDays: 7, calendarModel: { method: 'monthEnd', months: 3, anchor: '2027-01-31' } } } };
  assert.equal(personalLongCalendarPreviews(snapshot, '2027-02-01').length, 1);
  snapshot.personalCadences.quarter.calendarModel = { method: 'median', days: 89 };
  assert.equal(personalLongCalendarPreviews(snapshot, '2027-02-01').length, 0);
});
for (const platform of ['ios', 'android']) {
  test(`${platform} disabling recurrence removes a hidden expiry so the event can be moved and saved later`, async t => {
    const h = await fixture(t); let native; let saved = 0;
    const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, datePicker: picker => { native = picker; }, props: {
      initial: draft({ value: value({ allDay: true, recurrence: 'weekly', untilDate: '2026-11-01' }) }), local: h.local, onClose() {}, onSaved() { saved++; },
    } }); t.after(() => screen.unmount());
    await screen.press('繰り返しを選択');
    if (platform === 'ios') { screen.nodes().find(node => node.type === 'NativePicker').props.onValueChange('none'); screen.render(); await screen.press('繰り返しの選択を完了'); }
    else await screen.press('繰り返さない');
    await screen.press('開始日を選択');
    const picker = platform === 'ios' ? screen.nodes().find(node => node.type === 'DateTimePicker').props : native;
    picker.onValueChange({}, new Date(2026, 10, 7, 12)); await screen.flush();
    if (platform === 'ios') await screen.press('開始日の選択を完了');
    await screen.press('予定を保存'); for (let n = 0; n < 10 && !saved; n++) await screen.flush();
    assert.equal(saved, 1, screen.text()); const [event] = (await store.readLocalCalendar(h.database)).events;
    assert.equal(event.startDate, '2026-11-07'); assert.equal(event.untilDate, null); assert.equal(event.recurrence, 'none');
  });
  test(`${platform} a wall-clock time picker cannot change a valid event time merely because the device is on a DST gap date`, async () => {
    const before = process.env.TZ; process.env.TZ = 'America/Los_Angeles'; let native; const accepted = [];
    const screen = screenHarness('src/features/calendar/calendar-field.tsx', { exportName: 'CalendarField', platform, datePicker: picker => { native = picker; }, props: {
      label: '開始', date: '2026-03-08', minute: 150, mode: 'time', onMinute: minute => accepted.push(minute),
    } });
    try {
      await screen.press('開始を選択'); const picker = platform === 'ios' ? screen.nodes().find(node => node.type === 'DateTimePicker').props : native;
      const shown = new Intl.DateTimeFormat('en-GB', { timeZone: picker.timeZoneName ?? process.env.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(picker.value);
      assert.equal(shown, '02:30'); picker.onValueChange({}, picker.value); assert.deepEqual(accepted, [150]);
    } finally { screen.unmount(); if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  });
  test(`${platform} adding an appointment defaults to the personal draft even when a newer group draft is waiting`, async () => {
    const personal = draft({ value: value({ title: '個人の下書き' }) }); const group = draft({ audience: 'group', groupId: 'test-group', value: value({ title: '共有の下書き' }) });
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: date, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      local: { database: {}, snapshot: { events: [], exceptions: [], categories: INITIAL_CATEGORIES, drafts: [group, personal], draft: group }, shared: { groupId: 'test-group', name: '検査グループ', enabled: true } },
    } });
    try {
      await screen.press('予定を追加'); assert.equal(screen.button('個人').props.accessibilityState.selected, true);
      assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '予定名').props.defaultValue, personal.value.title);
    } finally { screen.unmount(); }
  });
  test(`${platform} classification save captures the latest typed name before a React repaint`, async () => {
    const saved = []; const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: {
      initial: draft(), onClose() {}, onSaved() {}, local: { database: {}, snapshot: { events: [], exceptions: [], categories: INITIAL_CATEGORIES },
        refresh: async () => {}, saveCategory: async input => { saved.push(input); return 'category.new'; } },
    } });
    try {
      await screen.press('分類を選択'); await screen.press('分類を追加');
      screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '分類名').props.onChangeText('最後に入力した分類');
      screen.button('分類を保存').props.onPress(); await screen.flush(); assert.equal(saved.length, 1); assert.equal(saved[0].name, '最後に入力した分類');
    } finally { screen.unmount(); }
  });
  test(`${platform} classification RGB fields preserve consecutive inputs and a valid preset replaces invalid custom input`, async () => {
    const saved = []; const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: {
      initial: draft(), onClose() {}, onSaved() {}, local: { database: {}, snapshot: { events: [], exceptions: [], categories: INITIAL_CATEGORIES },
        refresh: async () => {}, saveCategory: async input => { saved.push(input); return 'category.new'; } },
    } });
    try {
      await screen.press('分類を選択'); await screen.press('分類を追加'); await screen.change('分類名', '色の検査'); await screen.press('カスタムカラー');
      for (const [name, value] of [['R', '32'], ['G', '64'], ['B', '128']]) screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === `カラー${name}`).props.onChangeText(value);
      screen.button('分類を保存').props.onPress(); await screen.flush(); assert.equal(saved[0].color, '#204080');
      await screen.press('分類を選択'); await screen.press('分類を追加'); await screen.change('分類名', 'プリセットの検査'); await screen.press('カスタムカラー');
      await screen.change('カラーR', '999'); await screen.press('色 #348DC2');
      assert.equal(Boolean(screen.button('分類を保存').props.disabled), false); await screen.press('分類を保存'); assert.equal(saved.at(-1).color, '#348DC2');
    } finally { screen.unmount(); }
  });
  test(`${platform} horizontal year navigation respects the same range as the year buttons`, async () => {
    for (const [today, dx, expected] of [['2199-12-15', -100, '2199年'], ['1900-01-15', 100, '1900年']]) {
      const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: fn => fn(), props: {
        today, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      } });
      try {
        await screen.press('年表示に戻る'); const root = screen.nodes().find(node => node.props.onPanResponderRelease);
        root.props.onPanResponderRelease({}, { x0: 200, dx, dy: 0 }); screen.render();
        assert.equal(screen.button('表示する年と月を選択').props.accessibilityValue.text, expected);
      } finally { screen.unmount(); }
    }
  });
  test(`${platform} a valid classification preset remains saveable after invalid custom RGB input`, async () => {
    const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: {
      initial: draft(), onClose() {}, onSaved() {}, local: { database: {}, snapshot: { events: [], exceptions: [], categories: INITIAL_CATEGORIES }, refresh: async () => {}, saveCategory: async () => 'category.new' },
    } });
    try {
      await screen.press('分類を選択'); await screen.press('分類を追加'); await screen.change('分類名', 'プリセット'); await screen.press('カスタムカラー');
      await screen.change('カラーR', '999'); await screen.press('色 #348DC2'); assert.equal(Boolean(screen.button('分類を保存').props.disabled), false);
    } finally { screen.unmount(); }
  });
}
