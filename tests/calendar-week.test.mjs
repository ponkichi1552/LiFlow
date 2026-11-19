import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarWeekDays, calendarWeekLabel } from '../src/features/calendar/week-layout.ts';
import { createCalendarDisplayStore, CALENDAR_IDLE_RESET_MS } from '../src/features/calendar/display-store.ts';
import { addDays, daysBetween, formatJapaneseDate } from '../src/domain/scheduling/local-date.ts';
import { CATEGORY_PRESETS, INITIAL_CATEGORIES, UNCATEGORIZED_CALENDAR_CATEGORY, newEventDraft } from '../src/features/calendar/events.ts';
import { calendarEventAppearance } from '../src/features/calendar/event-appearance.ts';
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
  const parts = [625, 740, 840].map((endMinute, index) => event({ id: `overlap-${index}`, title: names[index], endMinute }));
  parts.push(event({ id: 'later', title: '途中の別件', startMinute: 827, endMinute: 835 }));
  const staggered = [[900, 975], [920, 965], [935, 990]].map(([startMinute, endMinute], index) =>
    event({ id: `staggered-${index}`, title: `午後の予定 ${index + 1}`, startMinute, endMinute }));
  parts.push(...staggered);
  const tight = [1025, 1030].map((endMinute, index) =>
    event({ id: `tight-${index}`, title: `短い連絡 ${index + 1}`, startMinute: 1020, endMinute, categoryId: 'work' }));
  parts.push(...tight);
  parts.push(event({ id: 'five-minutes', title: '荷物を渡す', startMinute: 1080, endMinute: 1085 }),
    event({ id: 'ten-minutes', title: '電話をかける', startMinute: 1140, endMinute: 1150 }),
    event({ id: 'solo-long', title: '単独で読書する', startMinute: 1200, endMinute: 1260 }));
  const opened = [];
  const local = binding({ snapshot: { events: parts, exceptions: [], categories: [...INITIAL_CATEGORIES], drafts: [] },
    prepareDraft: draft => { opened.push(draft); return draft; } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(),
    props: { today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
  t.after(() => ui.unmount());
  const style = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(Boolean));
  const visibleText = node => (node.children ?? []).flatMap(child => typeof child === 'object' ? visibleText(child) : [child]).join(' ');
  for (const mode of ['3日表示', '7日表示']) {
    await selectCalendarView(ui, mode);
    if (mode === '7日表示') {
      find(ui, 'calendar-week').props.onLayout({ nativeEvent: { layout: { width: 390 } } });
      await ui.flush();
    }
    const rails = names.map((_name, index) => style(find(ui, `calendar-duration-overlap-${index}:${day}`)));
    const eventNodes = names.map((_name, index) => find(ui, `calendar-movable-overlap-${index}:${day}`));
    const cards = eventNodes.map(style);
    assert.deepEqual(rails.map(rail => rail.top), [rails[0].top, rails[0].top, rails[0].top]);
    assert.ok(rails[0].height < rails[1].height && rails[1].height < rails[2].height);
    for (const [i, rail] of rails.entries()) {
      assert.equal(cards[i].left, rail.left + rail.width, 'each label sits directly against its own duration rail');
      assert.ok(cards[i].top >= rail.top && cards[i].top + cards[i].height <= rail.top + rail.height + 1e-6);
    }
    assert.equal(cards[0].top, rails[0].top);
    assert.ok(cards.every((card, index) => !index || card.top >= cards[index - 1].top + cards[index - 1].height));
    assert.deepEqual(cards.map(card => card.left + card.width), Array(3).fill(cards[0].left + cards[0].width));
    assert.equal(visibleText(eventNodes[0]).trim(), names[0]);
    assert.match(visibleText(eventNodes[1]), /10:00/u);
    assert.ok(cards[0].height < cards[1].height);
    assert.equal(ui.button(`${names[0]}を編集`).props.accessibilityValue.text, '10:00〜10:25');
    const later = style(find(ui, `calendar-movable-later:${day}`));
    assert.ok(later.borderLeftWidth > 0, 'a lone title beside an earlier rail uses a single background and edge');
    assert.ok(later.left > rails[2].left + rails[2].width, 'another appointment’s rail stays visually separate');
    for (const entry of staggered) {
      const rail = style(find(ui, `calendar-duration-${entry.id}:${day}`));
      const label = style(find(ui, `calendar-movable-${entry.id}:${day}`));
      assert.equal(label.left, rail.left + rail.width);
      assert.ok(label.top >= rail.top && label.top + label.height <= rail.top + rail.height + 1e-6,
        'the full title background sits beside its own duration rail');
    }
    assert.equal(visibleText(find(ui, `calendar-movable-staggered-0:${day}`)).trim(), staggered[0].title,
      'omit the leading clock when the next labels would detach');
    const sameHeight = mode === '3日表示' ? tight.map(row => style(find(ui, `calendar-movable-${row.id}:${day}`))) : [];
    if (sameHeight.length) {
      assert.equal(sameHeight[0].top, sameHeight[1].top, 'unplaceable titles start together in separate readable lanes');
      assert.notEqual(sameHeight[0].left, sameHeight[1].left);
    } else {
      const tightRails = tight.map(row => style(find(ui, `calendar-duration-${row.id}:${day}`)));
      assert.equal(tightRails[0].top, tightRails[1].top);
      assert.notEqual(tightRails[0].left, tightRails[1].left);
    }
    const five = style(find(ui, `calendar-movable-five-minutes:${day}`));
    const ten = style(find(ui, `calendar-movable-ten-minutes:${day}`));
    const solo = style(find(ui, `calendar-movable-solo-long:${day}`));
    const displayedHour = ten.top - five.top;
    assert.equal(later.top, 827 / 60 * displayedHour);
    assert.equal(five.top, displayedHour * 18, 'the minimum length does not change the start position');
    assert.ok(five.height > displayedHour * 5 / 60 && Math.abs(five.height - ten.height) < .0001,
      'very short appointments use the same visible minimum');
    assert.equal(solo.height, displayedHour, 'the background of a single long appointment follows its duration');
    assert.ok([...sameHeight, five, ten, solo].every(frame => frame.borderLeftWidth > 0 && frame.backgroundColor));
    for (const id of [...(sameHeight.length ? tight.map(row => row.id) : []), 'five-minutes', 'ten-minutes', 'solo-long']) {
      assert.ok(!ui.nodes().some(node => node.props.testID === `calendar-duration-${id}:${day}`),
        'one attached edge and its background share the same frame');
    }
    assert.equal(ui.button('荷物を渡すを編集').props.accessibilityValue.text, '18:00〜18:05');
    if (sameHeight.length) await ui.press('短い連絡 2を編集');
    else {
      await ui.press(`${formatJapaneseDate(day)} 17:00、重なった予定2件を開く`);
      await ui.press('短い連絡 2、17:00〜17:10');
    }
    assert.equal(opened.at(-1).value.startMinute, 1020);
    await ui.press('閉じる');
    for (const [index, name] of names.entries()) {
      await ui.press(`${name}を編集`);
      assert.equal(opened.at(-1).eventId, `overlap-${index}`);
      assert.equal(opened.at(-1).value.startMinute, 600);
      await ui.press('閉じる');
    }
  }
});

for (const platform of ['ios', 'android']) test(`${platform} time grids show the overnight continuation with a midnight scale and keep the real end editable`, async t => {
  const next = addDays(day, 1);
  const long = event({ id: 'night', title: '夜行列車', startMinute: 23 * 60, endDate: next, endMinute: 6 * 60 + 40 });
  const short = event({ id: 'few-minutes-overnight', title: '洗濯', startDate: next, startMinute: 23 * 60 + 45, endDate: addDays(next, 1), endMinute: 5 });
  const opened = [];
  const local = binding({ snapshot: { events: [long, short], exceptions: [], categories: [], drafts: [] },
    prepareDraft: draft => { opened.push(draft); return draft; } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(),
    props: { today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
  t.after(() => ui.unmount());
  const style = node => Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
  for (const mode of ['1日表示', '2日表示', '3日表示', '7日表示']) {
    await selectCalendarView(ui, mode);
    const card = style(find(ui, `calendar-movable-night:${day}`));
    const displayedHour = card.top / 23;
    let midnight = displayedHour * 24;
    if (mode !== '7日表示') {
      const hour = find(ui, 'calendar-hour-24');
      const rule = style(hour.children.find(node => node.type === 'View'));
      assert.equal(rule.position, 'absolute', 'the line follows the hour coordinate, independent of the text height');
      midnight = style(hour).top + rule.top;
      assert.match(ui.text(), /24:00/u);
    }
    assert.equal(card.top + card.height - midnight, displayedHour / 2, 'only the first half hour appears past midnight');
    if (mode !== '1日表示') {
      const shortCard = style(find(ui, `calendar-movable-few-minutes-overnight:${next}`));
      const duration = style(find(ui, `calendar-duration-few-minutes-overnight:${next}`));
      assert.ok(duration.top > 0, 'the minimum height leaves room for a label above the start');
      assert.equal(shortCard.borderLeftWidth, 0, 'only the duration layer paints the start');
      assert.ok(Math.abs(shortCard.top + duration.top - 23.75 * displayedHour) < 1e-6, 'the duration rail starts exactly at 23:45');
      assert.ok(Math.abs(shortCard.top + duration.top + duration.height - midnight - displayedHour / 12) < 1e-6,
        'the colored duration ends exactly at 00:05');
      assert.ok(Math.abs(shortCard.top + shortCard.height - midnight - displayedHour / 12) < 1e-6,
        'a five-minute continuation visibly crosses the midnight line and stops at its real end');
    }
    assert.doesNotMatch(ui.text(), /24:30/u);
    const slot = ui.button(`2026年11月11日の空き時間に予定を追加`);
    const before = opened.length;
    slot.props.onLongPress({ nativeEvent: { locationY: displayedHour * 24.25 } });
    await ui.flush();
    assert.equal(opened.length, before, 'the continuation is not an empty slot on the starting day');
    await ui.press('夜行列車を編集');
    assert.deepEqual([opened.at(-1).value.endDate, opened.at(-1).value.endMinute], [next, long.endMinute]);
    await ui.press('閉じる');
  }
});

test('only overlapping uncategorized events borrow unused colors in calendar time grids', async t => {
  const reserved = { id: 'custom.orange', name: '勉強', color: CATEGORY_PRESETS[3], revision: 1 };
  const categories = [...INITIAL_CATEGORIES, reserved];
  const rows = [
    event({ id: 'work', categoryId: 'work' }),
    event({ id: 'uncategorized-a', startMinute: 612, endMinute: 635, categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id }),
    event({ id: 'uncategorized-b', startMinute: 615, endMinute: 640, categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id }),
    event({ id: 'adjacent-a', startMinute: 725, endMinute: 730, categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id }),
    event({ id: 'adjacent-b', startMinute: 730, endMinute: 735, categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id }),
  ];
  const local = binding({ snapshot: { events: rows, exceptions: [], categories, drafts: [] } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform: 'ios', layoutEffect: effect => effect(),
    props: { today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
  t.after(() => ui.unmount());
  const lightAccent = color => calendarEventAppearance(color, false).accent;
  const neutral = lightAccent(UNCATEGORIZED_CALENDAR_CATEGORY.color);
  await selectCalendarView(ui, '1日表示');
  const accent = id => Object.assign({}, ...find(ui, `calendar-movable-${id}:${day}`).props.style.flat(Infinity).filter(Boolean)).borderLeftColor;
  const used = categories.map(category => lightAccent(category.color));
  assert.equal(accent('work'), lightAccent(categories.find(category => category.id === 'work').color));
  const a = accent('uncategorized-a');
  const b = accent('uncategorized-b');
  assert.ok(![...used, neutral].includes(a));
  assert.ok(![...used, neutral, a].includes(b));
  assert.equal(accent('adjacent-a'), neutral);
  assert.equal(accent('adjacent-b'), neutral);
  assert.deepEqual(rows.map(row => row.categoryId), ['work', ...Array(4).fill(UNCATEGORIZED_CALENDAR_CATEGORY.id)]);
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
  const group = `${formatJapaneseDate(day)} 10:00、重なった予定${parts.length}件を開く`;
  await ui.press(group);
  await ui.press('重なる予定 5、10:00〜12:00');
  assert.equal(opened.at(-1).eventId, 'dense-4');
  await ui.press('閉じる');
  await ui.press(group);
  await ui.press('この日を1日表示');
  for (const entry of parts) assert.ok(ui.button(`${entry.title}を編集`));
});

for (const platform of ['ios', 'android']) test(`${platform} three and seven day calendars keep opened chores in their day column outside the timeline`, async t => {
  const next = addDays(day, 1); const name = 'エアコンのフィルターと吹き出し口の掃除';
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    layoutEffect: effect => effect(), props: { today: day, timeZone: 'Asia/Tokyo', local: binding(),
      dayInfo: date => ({ loaded: true, total: date === day || date === next ? 1 : 0 }),
      renderChores: date => `${name} ${date}` } });
  t.after(() => ui.unmount());
  const label = (date, suffix) => `${formatJapaneseDate(date, { year: true })}の家事${suffix}`;
  const descendants = node => [node, ...(node.children ?? []).flatMap(child => typeof child === 'object' ? descendants(child) : [child])];
  const checkColumn = (open, closed) => {
    const column = find(ui, `calendar-chore-column:${open}`);
    assert.ok(descendants(column).includes(`${name} ${open}`));
    assert.equal(descendants(find(ui, `calendar-chore-column:${closed}`)).includes(`${name} ${closed}`), false);
  };
  for (const [mode, timeline] of [['3日表示', 'calendar-timeline'], ['7日表示', 'calendar-week-time-scroll']]) {
    await selectCalendarView(ui, mode);
    await ui.press(label(day, 'を開く'));
    const pane = find(ui, 'calendar-fixed-chores');
    assert.equal(descendants(find(ui, timeline)).some(node => node === pane), false);
    assert.equal(descendants(pane).filter(node => node.props?.accessibilityLabel?.endsWith('の家事一覧')).length, 1);
    checkColumn(day, next);
    await ui.press(label(next, 'を開く'));
    assert.ok(ui.text().includes(`${name} ${day}`));
    assert.ok(ui.text().includes(`${name} ${next}`));
    assert.equal(ui.button(label(day, 'を閉じる')).props.accessibilityState.expanded, true);
    const list = date => ui.nodes().find(node => node.props.accessibilityLabel === label(date, '一覧'));
    list(day).props.onContentSizeChange(105, 390);
    list(next).props.onContentSizeChange(105, 44);
    await ui.flush();
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === label(next, '一覧の続きを表示')), false);
    const offsets = [];
    list(day).props.ref.current = { scrollTo: options => offsets.push(options.y) };
    await ui.press(label(day, '一覧の続きを表示'));
    assert.ok(offsets.at(-1) > 0);
    list(day).props.onScroll({ nativeEvent: { contentOffset: { y: 390 }, contentSize: { height: 390 }, layoutMeasurement: { height: 100 } } });
    await ui.flush();
    await ui.press(label(day, '一覧の先頭に戻る'));
    assert.equal(offsets.at(-1), 0);
    await ui.press(label(next, 'を閉じる'));
    checkColumn(day, next);
    await ui.press(label(day, 'を閉じる'));
    assert.equal(ui.nodes().some(node => node.props.testID === 'calendar-fixed-chores'), false);
  }
});
for (const platform of ['ios', 'android']) test(`${platform} short overlaps after midnight only narrow their own labels`, async t => {
  const windows = [[0, 400], [0, 420], [0, 5], [65, 110], [75, 100]];
  const rows = windows.map(([start, end], index) => event({
    id: `midnight-${index}`, title: `深夜の予定 ${index + 1}`, startMinute: start, endMinute: end,
  }));
  const local = binding({ snapshot: { events: rows, exceptions: [], categories: [], drafts: [] } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    width: 360, layoutEffect: effect => effect(), props: {
      today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
    } });
  t.after(() => ui.unmount());
  const style = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(Boolean));
  for (const mode of ['3日表示', '7日表示']) {
    await selectCalendarView(ui, mode);
    if (mode === '7日表示') {
      find(ui, 'calendar-week').props.onLayout({ nativeEvent: { layout: { width: 360 } } });
      await ui.flush();
    }
    const [first, second, short] = rows.slice(0, 3).map(row => style(find(ui, `calendar-movable-${row.id}:${day}`)));
    const collisionCards = mode === '3日表示' ? rows.slice(3).map(row => style(find(ui, `calendar-movable-${row.id}:${day}`)))
      : [style(ui.button(`${formatJapaneseDate(day)} 01:05、重なった予定2件を開く`))];
    for (const [index, label] of [first, second].entries()) {
      const rail = style(find(ui, `calendar-duration-${rows[index].id}:${day}`));
      assert.equal(rail.top, 0);
      assert.equal(label.left, rail.left + rail.width);
      if (collisionCards.length === 2) assert.ok(collisionCards.every(card => label.width > card.width));
      assert.ok(label.top >= rail.top && label.top + label.height <= rail.top + rail.height);
      assert.ok([short, ...collisionCards].every(card => label.top >= card.top + card.height || label.top + label.height <= card.top));
    }
    if (collisionCards.length === 2) assert.notEqual(collisionCards[0].left, collisionCards[1].left);
    for (const row of rows.slice(0, 3)) assert.ok(ui.button(`${row.title}を編集`));
  }
});

for (const platform of ['ios', 'android']) test(`${platform} cramped timeline columns reveal every title without altering the duration rails`, async t => {
  const entries = [[600, 675], [620, 665], [635, 690]].map(([startMinute, endMinute], index) =>
    event({ id: `scaled-${index}`, title: ['まちの写真展', 'オンライン編集会議', '台所の設備点検'][index], startMinute, endMinute }));
  const open = [];
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    width: 411, fontScale: 1.15, layoutEffect: effect => effect(), props: {
      today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      local: binding({ snapshot: { events: entries, exceptions: [], drafts: [], categories: [] }, prepareDraft: draft => { open.push(draft); return draft; } }),
    } });
  t.after(() => ui.unmount());
  await selectCalendarView(ui, '3日表示');
  const label = `${formatJapaneseDate(day)} 10:00、重なった予定3件を開く`;
  assert.ok(ui.button(label));
  const flat = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(Boolean));
  for (const item of entries) {
    const rail = flat(find(ui, `calendar-duration-${item.id}:${day}`));
    const hourHeight = flat(find(ui, 'calendar-hour-11')).top - flat(find(ui, 'calendar-hour-10')).top;
    assert.ok(Math.abs(rail.top - item.startMinute / 60 * hourHeight) < 1e-6);
    await ui.press(label);
    const match = ui.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith(`${item.title}、`));
    assert.ok(match);
    await ui.press(match.props.accessibilityLabel);
    assert.equal(open.at(-1).eventId, item.id);
    assert.equal(open.at(-1).value.startMinute, item.startMinute);
    await ui.press('閉じる');
  }
});

for (const platform of ['ios', 'android']) test(`${platform} only committed day swipes animate and reduce motion keeps them instant`, async t => {
  for (const reduceMotion of [false, true]) {
    const timings = [], selected = [];
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
      reduceMotion, onTiming: (value, config) => timings.push({ value, config }), layoutEffect: effect => effect(),
      props: { selectedDate: day, today: day, timeZone: 'Asia/Tokyo', local: binding(), dayInfo: () => ({ loaded: true, total: 0 }),
        renderChores: () => null, onSelectDate: date => selected.push(date) } });
    t.after(() => ui.unmount());
    const swipe = async (translationX, translationY, canceled) => {
      const gesture = ui.nodes().find(node => node.type === 'NativeGestureDetector').props.gesture;
      gesture.onActivate({ x: 200, translationX: 0, numberOfPointers: 1 });
      gesture.onDeactivate({ translationX, translationY, canceled });
      await ui.flush();
    };
    for (const mode of ['1日表示', '2日表示', '3日表示']) {
      await selectCalendarView(ui, mode);
      timings.length = 0; selected.length = 0;
      await swipe(-90, 0, true);
      await swipe(-26, 0, false);
      assert.deepEqual(timings, []);
      assert.deepEqual(selected, []);
      await swipe(-90, 0, false);
      await swipe(90, 0, false);
      assert.deepEqual(selected, [addDays(day, 1), day]);
      assert.equal(timings.length, reduceMotion ? 0 : 2);
      assert.ok(timings.every(({ value, config }) => value === 0 && config.reduceMotion === 'system'));
    }
  }
});

for (const platform of ['ios', 'android']) test(`${platform} the selected holiday uses the same date color as any selected day`, async t => {
  const regular = '2026-11-22', holiday = '2026-11-23';
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    layoutEffect: effect => effect(), props: { today: regular, timeZone: 'Asia/Tokyo', local: binding(),
      dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
  t.after(() => ui.unmount());
  await selectCalendarView(ui, '3日表示');
  const label = day => `${formatJapaneseDate(day, { year: true, weekday: true })}を表示${day === holiday ? '、祝日：勤労感謝の日' : ''}`;
  const color = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(Boolean)).color;
  const number = day => color(ui.button(label(day)).children[1].children[0]);
  const heading = day => color(find(ui, `calendar-time-heading-${day}`));
  const regularSelected = number(regular);
  const selectedHeading = heading(regular);
  assert.notEqual(number(holiday), regularSelected);
  assert.notEqual(heading(holiday), selectedHeading);
  await ui.press(label(holiday));
  assert.equal(number(holiday), regularSelected);
  assert.equal(heading(holiday), selectedHeading);
  assert.match(ui.text(), /勤労感謝の日/u);
});

for (const platform of ['ios', 'android']) test(`${platform} multi-day all-day labels start in the first chore-free column of their own span`, async t => {
  const middle = addDays(day, 1), right = addDays(day, 2);
  const rows = [event({ id: 'spanning', title: '家族の旅行', allDay: true, endDate: right }),
    event({ id: 'one', title: '文化祭', allDay: true, startDate: middle, endDate: middle })];
  const local = binding({ snapshot: { events: rows, exceptions: [], categories: [], drafts: [] } });
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
    layoutEffect: effect => effect(), props: { today: day, timeZone: 'Asia/Tokyo', local,
      dayInfo: () => ({ loaded: true, total: 1 }), renderChores: date => `${date}の家事` } });
  t.after(() => ui.unmount());
  const style = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(Boolean));
  const titleStart = title => parseFloat(style(ui.button(`${title}を編集`).children.find(node => node.props.pointerEvents === 'none')).left);
  const openOrClose = (date, open) => ui.press(`${formatJapaneseDate(date, { year: true })}の家事を${open ? '開く' : '閉じる'}`);
  for (const mode of ['3日表示', '7日表示']) {
    await selectCalendarView(ui, mode);
    const bar = () => style(ui.button('家族の旅行を編集'));
    const original = bar();
    const leftStart = titleStart('家族の旅行');
    const singleStart = titleStart(rows[1].title);
    await openOrClose(middle, true);
    assert.equal(titleStart('家族の旅行'), leftStart);
    assert.equal(titleStart(rows[1].title), singleStart);
    await openOrClose(day, true);
    const rightStart = titleStart('家族の旅行');
    assert.ok(rightStart > leftStart);
    await openOrClose(middle, false);
    const middleStart = titleStart('家族の旅行');
    assert.ok(leftStart < middleStart && middleStart < rightStart);
    await openOrClose(middle, true);
    await openOrClose(right, true);
    assert.equal(titleStart('家族の旅行'), leftStart, 'with every day open, the label still fits inside its own band');
    assert.equal(titleStart(rows[1].title), singleStart);
    assert.equal(bar().left, original.left);
    assert.equal(bar().width, original.width);
    for (const date of [day, middle, right]) await openOrClose(date, false);
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
