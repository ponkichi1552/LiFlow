import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarWeekDays, calendarWeekLabel } from '../src/features/calendar/week-layout.ts';
import { createCalendarDisplayStore, CALENDAR_IDLE_RESET_MS } from '../src/features/calendar/display-store.ts';
import { addDays, daysBetween, formatJapaneseDate } from '../src/domain/scheduling/local-date.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';

test('calendar weeks retain the month weekday order across months years leap days and DST dates', () => {
  for (const date of ['2026-11-15', '2026-11-14', '2027-01-01', '2028-02-29', '2026-03-08', '2026-11-01']) {
    const days = calendarWeekDays(date);
    assert.equal(days.length, 7); assert.ok(days.includes(date));
    assert.equal(new Date(`${days[0]}T00:00:00Z`).getUTCDay(), 0);
    for (let i = 1; i < 7; i++) assert.equal(daysBetween(days[i - 1], days[i]), 1);
    assert.equal(calendarWeekDays(addDays(date, 7))[0], addDays(days[0], 7));
  }
  assert.match(calendarWeekLabel('2027-01-01'), /2026年12月27日.*2027年1月2日/u);
  assert.match(calendarWeekLabel('2026-11-14'), /11月8日.*14日/u);
});
test('weekly display remains process local and resets to month after the approved idle interval', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let now = 0;
  const store = createCalendarDisplayStore(() => now); t.after(() => store.dispose());
  store.select('week'); assert.equal(store.getSnapshot().view, 'week'); assert.equal(store.getSnapshot().detail, 'week');
  store.leave(); now = CALENDAR_IDLE_RESET_MS - 1; store.enter(); assert.equal(store.getSnapshot().view, 'week');
  store.leave(); now += CALENDAR_IDLE_RESET_MS; store.enter(); assert.equal(store.getSnapshot().view, 'month');
  const fresh = createCalendarDisplayStore(); assert.equal(fresh.getSnapshot().view, 'month'); fresh.dispose();
});

const day = '2026-11-11';
const event = (extra = {}) => ({ ...newEventDraft(day, 'Asia/Tokyo'), id: 'appointment', revision: 2, title: '会議', startMinute: 600, endMinute: 660, ...extra });
const binding = (extra = {}) => ({ database: {}, loading: false, error: null, snapshot: { events: [event()], exceptions: [], categories: [], drafts: [] }, refresh: async () => {}, ...extra });
const find = (ui, id) => { const node = ui.nodes().find(node => node.props.testID === id); assert.ok(node, id); return node; };
for (const platform of ['ios', 'android']) test(`${platform} overlapping appointments keep their real duration and each of three simultaneous labels can be opened`, async t => {
  const names = ['短い予定', '夜間の作業', '長い予定'];
  const parts = [660, 740, 840].map((endMinute, index) => event({ id: `overlap-${index}`, title: names[index], endMinute }));
  parts.push(event({ id: 'later', title: '途中の別件', startMinute: 827, endMinute: 835 }));
  const opened = [];
  const local = binding({ snapshot: { events: parts, exceptions: [], categories: [], drafts: [] },
    prepareDraft: draft => { opened.push(draft); return draft; } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(),
    props: { today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
  t.after(() => ui.unmount());
  const style = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(Boolean));
  for (const mode of ['3日表示', '7日表示']) {
    await selectCalendarView(ui, mode);
    const rails = names.map((_name, index) => style(find(ui, `calendar-duration-overlap-${index}:${day}`)));
    const cards = names.map((_name, index) => style(find(ui, `calendar-movable-overlap-${index}:${day}`)));
    assert.deepEqual(rails.map(rail => rail.top), [rails[0].top, rails[0].top, rails[0].top]);
    assert.ok(rails[0].height < rails[1].height && rails[1].height < rails[2].height);
    for (const [i, rail] of rails.entries()) {
      const link = style(find(ui, `calendar-connector-overlap-${i}:${day}`));
      assert.ok(link.top >= rail.top && link.top < rail.top + rail.height, 'each connector starts on its own event’s time rail');
      assert.ok(link.left >= rail.left && link.left < rail.left + rail.width);
      assert.equal(link.backgroundColor, rail.backgroundColor);
    }
    assert.equal(cards[0].top, rails[0].top);
    assert.ok(cards.every((card, index) => !index || card.top >= cards[index - 1].top + cards[index - 1].height));
    assert.equal(new Set(cards.map(card => card.width)).size, 1, 'a long event does not consume horizontal space from its neighbours');
    const later = style(find(ui, `calendar-movable-later:${day}`));
    assert.equal(later.width, cards[0].width);
    assert.equal(later.top, style(find(ui, `calendar-duration-later:${day}`)).top);
    for (const [index, name] of names.entries()) {
      await ui.press(`${name}を編集`);
      assert.equal(opened.at(-1).eventId, `overlap-${index}`);
      assert.equal(opened.at(-1).value.startMinute, 600);
      await ui.press('閉じる');
    }
  }
});

for (const platform of ['ios', 'android']) test(`${platform} a dense cluster keeps every event accessible and can switch to its one-day timeline`, async t => {
  const parts = [620, 630, 660, 680, 720].map((endMinute, index) => event({ id: `dense-${index}`, title: `重なる予定 ${index + 1}`, endMinute }));
  const opened = [];
  const local = binding({ snapshot: { events: parts, exceptions: [], categories: [], drafts: [] },
    prepareDraft: draft => { opened.push(draft); return draft; } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(),
    props: { today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
  t.after(() => ui.unmount());
  await selectCalendarView(ui, '3日表示');
  const group = `${formatJapaneseDate(day)} 10:00、重なった予定3件を開く`;
  await ui.press(group);
  await ui.press('重なる予定 5、10:00〜12:00');
  assert.equal(opened.at(-1).eventId, 'dense-4');
  await ui.press('閉じる');
  await ui.press(group);
  await ui.press('この日を1日表示');
  for (const entry of parts) assert.ok(ui.button(`${entry.title}を編集`));
});

for (const platform of ['ios', 'android']) test(`${platform} three and seven day calendars open one full-width chore list outside the timeline`, async t => {
  const next = addDays(day, 1); const name = 'エアコンのフィルターと吹き出し口の掃除';
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    layoutEffect: effect => effect(), props: { today: day, timeZone: 'Asia/Tokyo', local: binding(),
      dayInfo: date => ({ loaded: true, total: date === day || date === next ? 1 : 0 }),
      renderChores: date => `${name} ${date}` } });
  t.after(() => ui.unmount());
  const label = (date, suffix) => `${formatJapaneseDate(date, { year: true })}の家事${suffix}`;
  const descendants = node => [node, ...(node.children ?? []).flatMap(child => typeof child === 'object' ? descendants(child) : [child])];
  for (const [mode, timeline] of [['3日表示', 'calendar-timeline'], ['7日表示', 'calendar-week-time-scroll']]) {
    await selectCalendarView(ui, mode);
    await ui.press(label(day, 'を開く'));
    const pane = find(ui, 'calendar-fixed-chores');
    assert.equal(descendants(find(ui, timeline)).some(node => node === pane), false);
    assert.equal(descendants(pane).filter(node => node.props?.accessibilityLabel?.endsWith('の家事一覧')).length, 1);
    assert.ok(ui.text().includes(`${name} ${day}`));
    await ui.press(label(next, 'を開く'));
    assert.ok(ui.text().includes(`${name} ${next}`));
    assert.equal(ui.text().includes(`${name} ${day}`), false);
    await ui.press(label(next, 'を閉じる'));
    assert.equal(ui.nodes().some(node => node.props.testID === 'calendar-fixed-chores'), false);
  }
});
for (const [platform, ...testNames] of [
  ['ios', 'ios week mode shows seven dated timeline columns and navigates by complete weeks without writing events', 'ios seven day mode retains seven aligned columns with horizontal rules and puts clocks inside appointments', 'ios three day mode keeps all three dates selected across a week boundary and slides by one day', 'ios weekly empty slot uses that weekday and clock and does not save until the normal save action', 'ios week drag uses the existing move authority and undo and releases both scroll directions', 'ios week mode preserves all-day metadata unknown chores and timed chore actions without allowing protected drags'],
  ['android', 'android week mode shows seven dated timeline columns and navigates by complete weeks without writing events', 'android seven day mode retains seven aligned columns with horizontal rules and puts clocks inside appointments', 'android three day mode keeps all three dates selected across a week boundary and slides by one day', 'android weekly empty slot uses that weekday and clock and does not save until the normal save action', 'android week drag uses the existing move authority and undo and releases both scroll directions', 'android week mode preserves all-day metadata unknown chores and timed chore actions without allowing protected drags']
]) {
  const make = (local, options = {}) => screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    layoutEffect: effect => effect(), ...options, props: { today: day, selectedDate: day, timeZone: 'Asia/Tokyo', local,
      dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null, ...options.props } });
  test(testNames[0], async t => {
    const writes = [], selected = [], local = binding({ saveEvent: async draft => writes.push(draft) }); const before = structuredClone(local.snapshot);
    const ui = make(local, { props: { onSelectDate: date => selected.push(date) } }); t.after(() => ui.unmount());
    await selectCalendarView(ui, '7日表示'); find(ui, 'calendar-week');
    assert.equal(ui.nodes().filter(node => node.props.accessibilityLabel?.endsWith('の空き時間に予定を追加')).length, 7);
    assert.equal(ui.button('カレンダーの表示を選択').props.accessibilityValue.text, '7日');
    ui.button('会議を編集'); await ui.press('次の7日間'); assert.equal(selected.at(-1), '2026-11-18');
    await ui.press('前の7日間'); assert.equal(selected.at(-1), day); await ui.press('今日');
    assert.deepEqual(writes, []); assert.deepEqual(local.snapshot, before);
    await ui.press('月表示に戻る'); find(ui, 'calendar-weeks');
  });
  test(testNames[1], async t => {
    const calls = []; let recenter;
    const props = { date: day, currentMinute: null, defaultMinute: 540, dragging: false, activeDay: null, hourHeight: 60,
      onSelect() {}, onReady: value => { recenter = value; }, onScroll() {}, renderHeading: date => date, renderSummary: () => null, renderDay: (day, days, width) => `${day}:${days.length}:${width}` };
    const ui = screenHarness('src/features/calendar/calendar-week.tsx', { exportName: 'CalendarWeek', platform, layoutEffect: effect => effect(), props }); t.after(() => ui.unmount());
    find(ui, 'calendar-week-time-scroll').props.ref.current = { scrollTo: value => calls.push(value) };
    recenter(18 * 60); assert.equal(calls.length, 0, 'a destination received before layout must wait');
    find(ui, 'calendar-week').props.onLayout({ nativeEvent: { layout: { width: 350 } } }); await ui.flush();
    find(ui, 'calendar-week-time-scroll').props.onLayout({ nativeEvent: { layout: { height: 400 } } }); await ui.flush();
    assert.ok(calls.at(-1).y > 12 * 60); assert.match(ui.text(), /2026-11-11:7:50/u);
    assert.equal(ui.nodes().some(node => node.props.horizontal), false); assert.equal(find(ui, 'calendar-week-heading').children.filter(row => typeof row === 'object').length, 7);
    const rows = ui.nodes().filter(node => node.type === 'View' && node.props.pointerEvents === 'none'); assert.ok(rows.length >= 25, 'time rows retain their horizontal boundaries');
    const before = calls.length; ui.render(); assert.equal(calls.length, before, 'repaint must retain the current scroll');
  });
  test(testNames[2], async t => {
    const selected = [], ui = make(binding(), { props: { selectedDate: '2026-11-14', onSelectDate: date => selected.push(date) } }); t.after(() => ui.unmount());
    await selectCalendarView(ui, '3日表示');
    assert.equal(ui.nodes().filter(node => node.props.accessibilityLabel?.endsWith('の空き時間に予定を追加')).length, 3);
    const dates = ui.nodes().filter(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('を表示') && node.props.accessibilityState?.selected);
    assert.equal(dates.length, 3); assert.ok(dates.some(node => node.props.accessibilityValue.text.includes('表示中の3日目')));
    const gesture = ui.nodes().find(node => node.type === 'NativeGestureDetector').props.gesture;
    gesture.onActivate({ x: 200, translationX: 0, numberOfPointers: 1 }); gesture.onDeactivate({ translationX: -100, translationY: 0, canceled: false }); await ui.flush();
    assert.equal(selected.at(-1), '2026-11-15');
    await selectCalendarView(ui, '7日表示'); find(ui, 'calendar-week');
  });
  test(testNames[3], async t => {
    const writes = []; const ui = make(binding({ saveEvent: async draft => writes.push(draft) })); t.after(() => ui.unmount());
    await selectCalendarView(ui, '7日表示');
    const slot = ui.nodes().find(node => node.props.accessibilityLabel === '2026年11月13日の空き時間に予定を追加');
    assert.ok(slot); slot.props.onLongPress({ nativeEvent: { locationY: 0 } }); await ui.flush(); assert.equal(writes.length, 0);
    await ui.change('予定名', '深夜の予定'); await ui.press('予定を保存');
    assert.equal(writes.length, 1); assert.equal(writes[0].value.startDate, '2026-11-13'); assert.equal(writes[0].value.startMinute, 0);
  });
  test(testNames[4], async t => {
    const writes = [], local = binding({ saveEvent: async draft => { writes.push(draft); local.snapshot = { ...local.snapshot, events: [{ ...local.snapshot.events[0], ...draft.value, revision: local.snapshot.events[0].revision + 1 }] }; } }); const ui = make(local); t.after(() => ui.unmount());
    await selectCalendarView(ui, '7日表示'); const card = () => ui.nodes().find(node => node.props.testID?.startsWith('calendar-movable-'));
    find(ui, 'calendar-week').props.onLayout({ nativeEvent: { layout: { width: 350 } } }); await ui.flush();
    ui.button('会議を編集').props.onLongPress(); await ui.flush(); card().props.onPanResponderGrant();
    assert.equal(find(ui, 'calendar-week-time-scroll').props.scrollEnabled, false);
    card().props.onPanResponderRelease(null, { dx: 1000, dy: 44 }); await ui.flush();
    assert.equal(writes.length, 1); assert.equal(writes[0].value.startDate, '2026-11-14'); assert.equal(writes[0].value.startMinute, 660);
    assert.equal(find(ui, 'calendar-week-time-scroll').props.scrollEnabled, true);
    await ui.press('移動を元に戻す'); assert.equal(writes.length, 2); assert.equal(writes[1].value.startDate, day); assert.equal(writes[1].value.startMinute, 600);
    assert.equal(local.snapshot.events[0].startDate, day);
  });
  test(testNames[5], async t => {
    let opened = 0; const ui = make(binding({ snapshot: { events: [event({ readOnly: true }), event({ id: 'all', title: '旅行', allDay: true }), event({ id: 'birthday', title: '誕生日', birthday: true, allDay: true })], exceptions: [], categories: [], drafts: [] } }), { props: {
      dayInfo: date => ({ loaded: date !== day, total: date === day ? undefined : 1 }), renderChores: date => `家事:${date}`,
      timedChores: [{ id: 'chore', name: '時刻付き家事', start: Date.parse(`${day}T12:00:00+09:00`), end: Date.parse(`${day}T12:30:00+09:00`), onOpen: () => opened++ }],
    } }); t.after(() => ui.unmount());
    await selectCalendarView(ui, '7日表示'); assert.match(ui.text(), /未取得/u); assert.match(ui.button('旅行を編集').props.accessibilityHint, /終日/u); ui.button('誕生日を編集');
    assert.equal(ui.button('会議を編集').props.onLongPress, undefined);
    await ui.press('時刻付き家事を編集'); assert.equal(opened, 1);
    assert.equal(ui.button('時刻付き家事を編集').props.onLongPress, undefined);
    await ui.press('2026年11月10日の家事を開く'); assert.match(ui.text(), /家事:2026-11-10/u);
  });
}
