import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView, openCalendarDay, moveCalendarMonth } from './helpers/calendar-ui.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, projectCalendarEvents } from '../src/features/calendar/events.ts';
import { localCalendarAvailability, combineCalendarAvailability } from '../src/features/calendar/local-availability.ts';
const store = await import('../src/platform/storage/calendar-events.ts');
const repository = await import('../src/platform/storage/repository.ts');
const today = '2026-10-30';
async function fixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const local = { database: h.database, snapshot: await store.readLocalCalendar(h.database), loading: false, error: null,
    refresh: async () => { local.snapshot = await store.readLocalCalendar(h.database); } };
  return { ...h, local };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} resizing a browsed month never recenters it on the original date while explicit navigation can center again`, () => {
    const calls = [];
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null,
    } });
    let weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    weeks.props.ref.current = { scrollToOffset: request => calls.push(request) };
    weeks.props.onLayout(); assert.equal(calls.length, 1, 'initial entry still centers the selected day');
    weeks.props.onScrollBeginDrag?.();
    const viewport = screen.nodes().find(node => typeof node.props.onLayout === 'function' && node.type === 'View');
    viewport.props.onLayout({ nativeEvent: { layout: { height: 420 } } }); screen.render();
    weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks'); weeks.props.onContentSizeChange();
    weeks.props.onScrollToIndexFailed();
    assert.equal(calls.length, 1, 'native layout and retry callbacks must not send the user back to the initial day after a drag');
    weeks.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); screen.render();
    weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks'); weeks.props.onLayout();
    assert.equal(calls.length, 2, 'an explicit next-month command is allowed to center its target');
  });
  test(`${platform} calendar view and day changes reset native scroll offsets without changing the selected date`, async t => {
    const h = await fixture(t);
    // Fixed test geometry models a native list retaining an offset across React reuse.
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, flatListItemHeight: 100, layoutEffect: effect => effect(), props: {
      today, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, pending: 1 }), renderChores: day => `家事：${day}`,
    } });
    const scroll = id => {
      const list = screen.nodes().find(node => node.props.testID === id);
      list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 1200 } } }); screen.render();
    };
    await openCalendarDay(screen, today, { chores: false });
    scroll('calendar-timeline'); await selectCalendarView(screen, 'リスト表示');
    await screen.press('2026年10月30日の家事を開く');
    assert.ok(screen.text().includes(`家事：${today}`), 'the selected day must be visible without scrolling back through inherited timeline offsets');
    scroll('calendar-agenda'); await selectCalendarView(screen, '2日表示');
    assert.ok(screen.text().includes('10月30日（金）')); assert.ok(screen.text().includes('10月31日（土）'));
    scroll('calendar-timeline'); await selectCalendarView(screen, '1日表示');
    assert.ok(screen.text().includes('10月30日（金）'));
    scroll('calendar-timeline');
    const gesture = screen.nodes().find(node => typeof node.props.onPanResponderRelease === 'function');
    gesture.props.onPanResponderRelease({}, { x0: 200, dx: -140, dy: 0 }); screen.render();
    assert.ok(screen.text().includes('10月31日（土）'), 'the next day starts with its own scroll state');
    await selectCalendarView(screen, 'リスト表示'); await screen.press('2026年10月31日の家事を開く');
    assert.ok(screen.text().includes('家事：2026-10-31'));
  });
  test(`${platform} calendar month header follows visible weeks when native offsets belong to an earlier row height`, async t => {
    const h = await fixture(t);
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null,
    } });
    let weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    weeks.props.onScrollBeginDrag();
    // A stale native offset must not overrule the identities of the rows actually on screen.
    weeks.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: weeks.props.data.findIndex(row => row.days.includes('2026-08-30')) * 100 } } });
    screen.render(); weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    assert.equal(typeof weeks.props.onViewableItemsChanged, 'function');
    const changed = weeks.props.onViewableItemsChanged;
    const visible = days => changed({ viewableItems: days.map(day => { const index = weeks.props.data.findIndex(row => row.days.includes(day)); const item = weeks.props.data[index]; return { item, key: item.id, index, isViewable: true }; }), changed: [] });
    visible(['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08']); screen.render();
    assert.ok(screen.text().includes('2026年10月')); assert.equal(screen.text().includes('2026年8月'), false);
    weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    assert.equal(weeks.props.onViewableItemsChanged, changed, 'layout updates keep the native subscription stable');
    visible(['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']); screen.render();
    assert.ok(screen.text().includes('2026年11月'));
    visible(['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08']); screen.render();
    assert.ok(screen.text().includes('2026年10月'), 'scrolling back must not be trapped in the initial callback closure');
    visible([]); screen.render(); assert.ok(screen.text().includes('2026年10月'));
    await screen.press('予定を追加');
    assert.ok(screen.text().includes('2026/10/30'), 'new events start on the selected visible date rather than the stale header month');
  });
  test(`${platform} native calendar starts with a virtualized full month keeps hierarchy and date preference and reveals chores only on request`, async t => {
    const h = await fixture(t); let opened = 0; const dates = [];
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, pending: 2, total: 2, minutes: 45 }),
      renderChores: date => { opened++; dates.push(date); return '家事の詳細'; },
    } });
    assert.equal(opened, 0); assert.ok(screen.nodes().some(node => node.props.testID === 'calendar-weeks'));
    screen.button('カレンダーの表示を選択'); screen.button('予定を追加');
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '月表示'), false);
    await openCalendarDay(screen, today, { chores: false }); assert.equal(opened, 0);
    await screen.press('2026年10月30日の家事を開く'); assert.ok(opened > 0); assert.equal(dates.at(-1), today);
    await screen.press('月表示に戻る'); await moveCalendarMonth(screen, 1); await selectCalendarView(screen, '1日表示');
    assert.ok(screen.text().includes('11月30日')); assert.equal(screen.text().includes('11月1日（'), false);
    await screen.press('月表示に戻る'); await screen.press('年表示に戻る');
    assert.equal(screen.nodes().filter(node => node.props.accessibilityLabel?.match(/^2026年\d+月を表示$/)).length, 12);
    await screen.press('2026年12月を表示'); assert.ok(screen.nodes().some(node => node.props.testID === 'calendar-weeks'));
  });
  test(`${platform} native calendar saves the latest edited title once without creating a chore recurrence`, async t => {
    const h = await fixture(t); let closed = 0; let saved = 0;
    const value = { ...newEventDraft(today, 'Asia/Tokyo'), title: '' };
    const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      props: { initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value }, local: h.local, onClose: () => closed++, onSaved: () => saved++ } });
    for (const label of ['予定名', '予定の場所', '予定のメモ']) {
      assert.ok(screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === label));
    }
    const input = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '予定名'); input.props.onChangeText('授業');
    screen.render();
    const button = screen.button('予定を保存'); button.props.onPress(); button.props.onPress();
    for (let n = 0; n < 20 && !saved; n++) await screen.flush();
    assert.equal(saved, 1); assert.equal(closed, 0); assert.equal((await store.readLocalCalendar(h.database)).events.length, 1);
    assert.equal((await store.readLocalCalendar(h.database)).events[0].title, '授業');
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_schedule_entries').get().n, 0);
  });
  test(`${platform} native editor retains a closed draft and reuses preset and custom RGB classification colors`, async t => {
    const h = await fixture(t); let closed = 0;
    const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      props: { initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(today, 'Asia/Tokyo') }, local: h.local, onClose: () => closed++, onSaved() {} } });
    await screen.change('予定名', '通院'); await screen.press('繰り返しを選択');
    if (platform === 'ios') { screen.nodes().find(node => node.type === 'NativePicker').props.onValueChange('biweekly'); screen.render(); await screen.press('繰り返しの選択を完了'); }
    else await screen.press('隔週');
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === '学校の分類を選択'), false, 'category choices stay collapsed until requested');
    await screen.press('分類を選択'); await screen.press('分類を追加'); await screen.change('分類名', '病院'); await screen.press('カスタムカラー');
    await screen.change('カラーR', '32'); await screen.change('カラーG', '64'); await screen.change('カラーB', '128'); await screen.press('分類を保存');
    const category = (await store.readLocalCalendar(h.database)).categories.find(row => row.name === '病院'); assert.equal(category.color, '#204080');
    await screen.press('予定の編集を閉じる'); for (let n = 0; n < 15 && !closed; n++) await screen.flush();
    const draft = (await store.readLocalCalendar(h.database)).draft; assert.equal(draft.value.title, '通院'); assert.equal(draft.value.recurrence, 'biweekly'); assert.equal(draft.value.categoryId, category.id);
    assert.equal((await store.readLocalCalendar(h.database)).events.length, 0, 'closing a draft never creates an event');
  });
  test(`${platform} dates use OS pickers and calendar gestures reserve tab motion for screen edges`, async t => {
    let params; let date; const field = screenHarness('src/features/calendar/calendar-field.tsx', { exportName: 'CalendarField', platform, datePicker: value => { params = value; },
      props: { label: '開始日', date: today, minute: 540, mode: 'date', onDate: value => { date = value; } } });
    await field.press('開始日を選択');
    if (platform === 'android') { assert.equal(params.mode, 'date'); params.onValueChange({}, new Date(2026, 10, 2, 12)); assert.equal(date, '2026-11-02'); }
    else {
      assert.ok(field.nodes().some(node => node.type === 'DateTimePicker'));
      assert.ok(field.nodes().some(node => node.type === 'Modal'), 'the native wheel uses the screen width instead of overlapping its adjacent end-date field');
      await field.press('開始日の選択を完了');
      assert.equal(field.nodes().some(node => node.type === 'DateTimePicker'), false);
    }
    const h = await fixture(t); const navigation = []; const chosen = [];
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: fn => fn(), props: {
      today, timeZone: 'Asia/Tokyo', local: h.local, onNavigate: tab => navigation.push(tab), onSelectDate: value => chosen.push(value), dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null,
    } });
    await selectCalendarView(screen, '1日表示');
    const swipe = (x0, dx, dy = 1) => { const root = screen.nodes().find(node => node.props.onPanResponderRelease); root.props.onPanResponderRelease({}, { x0, dx, dy }); screen.render(); };
    swipe(150, -100); assert.equal(chosen.at(-1), '2026-10-31'); assert.deepEqual(navigation, []);
    swipe(10, 100); assert.deepEqual(navigation, ['home']); swipe(385, -100); assert.deepEqual(navigation, ['home', 'chores']);
  });
  test(`${platform} saving an event in another month brings its actual date into the month viewport`, async t => {
    const h = await fixture(t); let picker;
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, datePicker: value => { picker = value; }, props: { today, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null } });
    await screen.press('予定を追加'); await screen.change('予定名', '将来の表示確認'); await screen.press('開始日を選択');
    if (platform === 'ios') { screen.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({}, new Date(2028, 9, 31, 12)); screen.render(); await screen.press('開始日の選択を完了'); }
    else { picker.onValueChange({}, new Date(2028, 9, 31, 12)); screen.render(); }
    await screen.press('予定を保存'); for (let n = 0; n < 20 && screen.nodes().some(node => node.props.accessibilityLabel === '予定を保存'); n++) await screen.flush();
    assert.ok(screen.text().includes('2028年10月'));
    assert.ok(screen.nodes().some(node => node.props.accessibilityLabel?.startsWith('2028年10月31日、')));
    await selectCalendarView(screen, '1日表示'); assert.ok(screen.text().includes('10月31日'));
  });
  test(`${platform} native month callbacks during editor dismissal cannot move the saved event to another month`, async t => {
    const h = await fixture(t); const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: '2026-11-01', timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, pending: 0 }), renderChores: () => null,
    } });
    await screen.press('予定を追加'); await screen.change('予定名', '月初の予定'); await screen.press('予定を保存');
    for (let n = 0; n < 20 && screen.nodes().some(node => node.props.accessibilityLabel === '予定を保存'); n++) await screen.flush();
    const weeks = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    const visible = ['2026-11-29', '2026-12-06', '2026-12-13'].map(day => {
      const index = weeks.props.data.findIndex(row => row.days.includes(day)); const item = weeks.props.data[index];
      return { item, key: item.id, index, isViewable: true };
    });
    weeks.props.onViewableItemsChanged({ viewableItems: visible, changed: [] }); screen.render();
    await selectCalendarView(screen, 'リスト表示');
    assert.ok(screen.button('月初の予定を編集'));
    assert.ok(screen.text().includes('11月1日（日）'), 'saving and changing display keeps the actual saved date');
    assert.equal((await store.readLocalCalendar(h.database)).events[0].startDate, '2026-11-01');
  });
}
test('iOS interactive editor dismissal keeps the latest draft visible when SQLite fails and allows a safe retry', async t => {
  const h = await fixture(t); let closed = 0;
  const run = h.database.runAsync.bind(h.database);
  h.database.runAsync = async (sql, ...args) => {
    if (sql.includes('calendar_drafts')) throw new Error('下書きを保存できませんでした');
    return run(sql, ...args);
  };
  const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform: 'ios',
    props: { initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(today, 'Asia/Tokyo') }, local: h.local, onClose: () => closed++, onSaved() {} } });
  await screen.change('予定名', '保存前の予定');
  screen.nodes().find(node => node.type === 'Modal').props.onRequestClose();
  for (let n = 0; n < 15; n++) await screen.flush();
  assert.equal(closed, 0);
  assert.ok(screen.text().includes('下書きを保存できませんでした'));
  assert.equal(screen.nodes().find(node => node.type === 'Modal').props.visible, true);
  assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '予定名').props.defaultValue, '保存前の予定');
  h.database.runAsync = run;
  await screen.press('予定の編集を閉じる');
  for (let n = 0; n < 15 && !closed; n++) await screen.flush();
  assert.equal(closed, 1);
  assert.equal((await store.readLocalCalendar(h.database)).draft.value.title, '保存前の予定');
});
test('local calendar availability unions overlaps keeps birthdays informational and does not double count Google daily aggregates', async t => {
  const h = await fixture(t);
  const make = (id, patch) => ({ ...newEventDraft(today, 'Asia/Tokyo'), title: id, id, revision: 1, ...patch });
  const events = [make('first', { startMinute: 540, endMinute: 660 }), make('overlap', { startMinute: 600, endMinute: 720 }),
    make('birthday', { allDay: true, birthday: true, recurrence: 'yearly' })];
  const busy = localCalendarAvailability(events, [], today, today, 'Asia/Tokyo'); assert.equal(busy[today].busyMinutes, 180);
  assert.equal(combineCalendarAvailability({ [today]: { busyMinutes: 240 } }, busy)[today].busyMinutes, 240);
  assert.equal(combineCalendarAvailability(undefined, busy), busy);
  await store.saveCalendarEvent(h.database, { expectedRevision: 0, value: make('trip', { allDay: true }) });
  const snapshot = await repository.loadPlannerSnapshot(h.database, today); assert.equal(snapshot.externalAvailabilityByDate[today].busyMinutes, 1440);
  assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM calendar_availability_days').get().n, 0, 'local entries never masquerade as a Google download');
  assert.equal(projectCalendarEvents([events[2]], [], today, today).length, 1);
});
