import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { addDays, formatJapaneseDate } from '../src/domain/scheduling/local-date.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { saveCalendarEvent, readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const descendants = node => [node, ...(node.children ?? []).filter(child => typeof child === 'object').flatMap(descendants)];
for (const platform of ['ios', 'android']) test(`${platform} four appointments and expanded chores stay inside a small calendar viewport`, async t => {
  const day = '2026-11-13';
  const events = Array.from({ length: 4 }, (_, index) => ({ ...newEventDraft(day, 'Asia/Tokyo'), id: `busy-${index}`, title: `予定${index + 1}`, revision: 1, allDay: true }));
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 12, total: 12 }), renderChores: () => '最後の家事もスクロールで読めます',
    local: { database: {}, snapshot: { events, exceptions: [], categories: [], drafts: [], draft: null }, loading: false, error: null, refresh: async () => {} },
  } });
  t.after(() => screen.unmount());
  for (const mode of ['1日表示', '2日表示']) {
    await selectCalendarView(screen, mode);
    if (screen.nodes().some(row => row.props.accessibilityLabel === '2026年11月13日の家事を開く')) await screen.press('2026年11月13日の家事を開く');
    screen.nodes().find(row => row.props.testID === 'calendar-viewport').props.onLayout({ nativeEvent: { layout: { height: 300 } } });
    screen.nodes().find(row => row.props.testID === 'calendar-fixed-day-heading').props.onLayout({ nativeEvent: { layout: { height: 160 } } });
    screen.nodes().find(row => row.props.accessibilityLabel === '2026年11月13日の家事一覧').props.onContentSizeChange(180, 900);
    await screen.flush();
    const pane = screen.nodes().find(row => row.props.testID === `calendar-chore-column:${day}`);
    const style = Object.assign({}, ...pane.props.style.flat(Infinity).filter(Boolean));
    assert.ok(style.height > 0 && style.height < 300 - 160, 'the expanded pane must leave room for the timeline and cannot extend under the tab bar');
    for (const event of events) screen.button(`${event.title}を編集`);
    assert.ok(descendants(pane).some(row => row.children?.includes('最後の家事もスクロールで読めます')));
    const chores = descendants(pane).find(row => row.props.accessibilityLabel === '2026年11月13日の家事一覧');
    assert.ok(chores.props.scrollEnabled && chores.props.showsVerticalScrollIndicator);
    assert.equal(descendants(pane).some(row => row.props.accessibilityLabel?.startsWith('2026年11月13日の家事一覧の')), false);
  }
});
for (const platform of ['ios', 'android']) test(`${platform} short calendar cards never cover the next editable event in either day mode`, async () => {
  const day = '2026-10-30';
  const events = [[540, 630], [634, 635], [645, 735]].map(([startMinute, endMinute], i) => ({
    ...newEventDraft(day, 'Asia/Tokyo'), id: `card-${i}`, title: `予定${i}`, revision: 1, startMinute, endMinute,
  }));
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
    local: { database: {}, snapshot: { events, exceptions: [], categories: [], drafts: [], draft: null }, loading: false, error: null, refresh: async () => {} },
  } });
  for (const mode of ['1日表示', '2日表示']) {
    await selectCalendarView(screen, mode);
    const cards = events.map(row => {
      const button = screen.button(`${row.title}を編集`);
      const carrier = screen.nodes().find(node => node.props.testID?.startsWith('calendar-movable-') && descendants(node).includes(button));
      assert.ok(carrier, 'the editable card keeps its collision rectangle on its movable wrapper');
      return carrier;
    });
    const rectangles = cards.map(card => {
      const style = Object.assign({}, ...card.props.style.flat(Infinity).filter(value => value && typeof value === 'object'));
      return { top: style.top, bottom: style.top + style.height, left: parseFloat(style.left), right: parseFloat(style.left) + parseFloat(style.width) };
    });
    for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
      const a = rectangles[i], b = rectangles[j];
      if (a.top < b.bottom && b.top < a.bottom) assert.ok(a.right <= b.left || b.right <= a.left, `card ${i} covers card ${j} in ${mode}`);
    }
  }
  screen.unmount();
});
for (const platform of ['ios', 'android']) test(`${platform} timeline date and chore controls remain outside the native scrolling content in both day modes`, async () => {
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 2, total: 2, minutes: 45 }), renderChores: day => `手順:${day}`,
  } });
  for (const [mode, days] of [['1日表示', 1], ['2日表示', 2]]) {
    await selectCalendarView(screen, mode);
    const header = screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading'); const list = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
    assert.ok(header && list); assert.equal(descendants(list).includes(header), false);
    const panels = screen.nodes().find(node => node.props.testID === 'calendar-day-panels');
    assert.ok(panels); assert.equal(descendants(list).includes(panels), false);
    const toggles = descendants(panels).filter(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('の家事を'));
    assert.equal(toggles.length, days); const calls = []; list.props.ref.current = { scrollToOffset: value => calls.push(value) };
    if (toggles[0].props.accessibilityState.expanded) { await toggles[0].props.onPress(); await screen.flush(); }
    await screen.nodes().find(node => node.props.accessibilityLabel === toggles[0].props.accessibilityLabel?.replace('閉じる', '開く')).props.onPress(); await screen.flush(); assert.ok(screen.text().includes('手順:2026-10-31'));
    const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
    assert.ok(pane); assert.equal(descendants(list).includes(pane), false);
    assert.equal(calls.length, 0, 'expanding the fixed list must not jump the timeline away from the appointments');
    list.props.onScroll?.({ nativeEvent: { contentOffset: { y: 800, x: 0 } } }); screen.render();
    const stillFixed = screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading'); assert.ok(stillFixed);
  }
});

for (const platform of ['ios', 'android']) test(`${platform} a carryover appointment at midnight starts the visible day at the top of its timeline`, async () => {
  const previous = '2026-10-31'; const selected = '2026-11-01';
  const overnight = { ...newEventDraft(previous, 'Asia/Tokyo'), id: 'overnight', title: '夜をまたぐ予定', revision: 1,
    startMinute: 23 * 60, endDate: selected, endMinute: 60 };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-20', selectedDate: selected, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0, pending: 0 }), renderChores: () => null,
    local: { database: {}, snapshot: { events: [overnight], exceptions: [], categories: [], drafts: [] }, loading: false, error: null, refresh: async () => {} },
  } });
  try {
    await selectCalendarView(screen, '1日表示');
    const offsets = []; const timeline = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
    timeline.props.ref.current = { scrollToOffset: value => offsets.push(value.offset) };
    screen.nodes().find(node => node.props.testID === 'calendar-timeline-days').props.onLayout({ nativeEvent: { layout: { height: 0 } } });
    timeline.props.onLayout({ nativeEvent: { layout: { height: 500 } } }); await screen.flush();
    assert.ok(offsets.length > 0); assert.equal(offsets.at(-1), 0, 'the carryover starts at minute zero on the selected date');
  } finally { screen.unmount(); }
});

for (const platform of ['ios', 'android']) test(`${platform} changing day modes keeps an already expanded chore list visible instead of scrolling past it`, async () => {
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-10-31', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 4, total: 4 }), renderChores: () => '洗面台の清掃',
  } });
  await selectCalendarView(screen, '1日表示'); await screen.press('2026年10月31日の家事を開く');
  await selectCalendarView(screen, '2日表示');
  const offsets = []; const list = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
  list.props.ref.current = { scrollToOffset: value => offsets.push(value.offset) };
  const top = descendants(list).find(node => node.type === 'View' && typeof node.props.onLayout === 'function');
  top.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
  list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  assert.equal(screen.button('2026年10月31日の家事を閉じる').props.accessibilityState.expanded, true);
  const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
  assert.ok(pane); assert.equal(descendants(list).includes(pane), false);
  assert.ok(descendants(pane).some(node => node.children?.includes('洗面台の清掃')), 'the expanded list stays above the timeline after a mode change');
  screen.unmount();
});

for (const platform of ['ios', 'android']) test(`${platform} all-day appointments stay outside clock scrolling across inclusive days and open the same saved occurrence`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const start = '2026-11-29', end = '2026-12-01', title = 'Synthetic inclusive appointment';
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(start, 'Asia/Tokyo'), title, allDay: true, endDate: end } });
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft('2026-11-30', 'Asia/Tokyo'), title: 'Synthetic same date appointment', allDay: true } });
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(start, 'Asia/Tokyo'), title: 'Synthetic midnight endpoint', startMinute: 23 * 60, endDate: end, endMinute: 0 } });
  const snapshot = await readLocalCalendar(h.database), opened = [];
  const local = { database: h.database, snapshot, loading: false, error: null, refresh: async () => {}, prepareDraft: draft => { opened.push(structuredClone(draft)); return draft; } };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: '2026-11-16', selectedDate: start, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
  } }); t.after(() => screen.unmount());
  const writes = h.writes.length;
  let focused = start;
  for (const [mode, days] of [['1日表示', 1], ['2日表示', 2], ['3日表示', 3]]) {
    await selectCalendarView(screen, mode);
    let rangeStart = focused;
    for (const date of [start, '2026-11-30', end]) {
      await screen.press(`${formatJapaneseDate(date, { year: true, weekday: true })}を表示`);
      focused = date;
      if (date < rangeStart || date > addDays(rangeStart, days - 1)) rangeStart = date;
      const clock = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
      const visible = Array.from({ length: days }, (_, index) => addDays(rangeStart, index)).filter(day => day <= end);
      const label = `${title}を編集`;
      const appointments = screen.nodes().filter(node => node.props.accessibilityLabel === label);
      assert.equal(appointments.length, 1, 'the inclusive span opens one saved occurrence across every visible date');
      assert.ok(!descendants(clock).includes(appointments[0]), 'clock positioning and scrolling must not carry the span away');
      assert.equal(appointments[0].props.accessibilityHint, `終日、${visible.map(day => formatJapaneseDate(day)).filter((_, index) => index === 0 || index === visible.length - 1).join('〜')}`);
      clock.props.ref.current = { scrollToOffset() {} };
      screen.nodes().find(node => node.props.testID === 'calendar-timeline-days').props.onLayout({ nativeEvent: { layout: { height: 0 } } });
      clock.props.onLayout({ nativeEvent: { layout: { height: 350 } } });
      clock.props.onScroll({ nativeEvent: { contentOffset: { y: 900 } } }); await screen.flush();
      assert.equal(screen.nodes().filter(node => node.props.accessibilityLabel === label).length, appointments.length);
      if (date === end) assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'Synthetic midnight endpointを編集'
        && node.props.testID?.endsWith(`:${end}`)), false, 'timed midnight end stays exclusive');
    }
    focused = '2026-12-03';
    await screen.press(`${formatJapaneseDate(focused, { year: true, weekday: true })}を表示`);
    assert.equal(screen.nodes().some(node => ['calendar-fixed-all-day', 'calendar-compact-all-day'].includes(node.props.testID)), false, 'no empty all-day pane remains after the inclusive end');
  }
  assert.equal(h.writes.length, writes, 'view changes and clock scrolling never persist per-day copies');
  await screen.press(`${formatJapaneseDate(end, { year: true, weekday: true })}を表示`); await screen.press(`${title}を編集`);
  assert.equal(opened.length, 1); assert.equal(opened[0].eventId, id); assert.equal(opened[0].revision, 1);
  assert.equal(opened[0].anchorDate, start); assert.equal(opened[0].value.startDate, start); assert.equal(opened[0].value.endDate, end);
  assert.deepEqual((await readLocalCalendar(h.database)).events, snapshot.events);
});

for (const platform of ['ios', 'android']) test(`${platform} all-day content shares bounded space with expanded chores and updates when events change`, async t => {
  const day = '2026-11-30';
  const events = Array.from({ length: 5 }, (_, index) => ({
    ...newEventDraft(day, 'Asia/Tokyo'), id: `all-day-${index}`, title: `旅行予定${index} ${'長い名前'.repeat(index + 1)}`, revision: 1, allDay: true,
  }));
  const local = { database: {}, loading: false, error: null, refresh: async () => {}, snapshot: { events, exceptions: [], categories: [], drafts: [] } };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(), props: {
    today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, pending: 12, total: 12 }), renderChores: () => '展開した家事一覧',
  } }); t.after(() => screen.unmount());
  const style = node => Object.assign({}, ...[typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style].flat(Infinity).filter(value => value && typeof value === 'object'));
  for (const mode of ['1日表示', '2日表示']) {
    local.snapshot = { ...local.snapshot, events }; screen.render();
    await selectCalendarView(screen, mode);
    const expand = `${formatJapaneseDate(day, { year: true })}の家事を開く`;
    if (screen.nodes().some(node => node.props.accessibilityLabel === expand)) await screen.press(expand);
    screen.nodes().find(node => node.props.testID === 'calendar-viewport').props.onLayout({ nativeEvent: { layout: { height: 300 } } });
    screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading').props.onLayout({ nativeEvent: { layout: { height: 160 } } });
    screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の家事一覧`).props.onContentSizeChange(150, 900);
    await screen.flush();
    const allDayScroll = screen.nodes().find(node => node.props.testID === 'calendar-compact-all-day');
    assert.ok(allDayScroll.props.scrollEnabled, 'overflowing all-day content has its own scroll surface');
    assert.equal(descendants(allDayScroll).filter(row => row.props.accessibilityLabel?.startsWith('旅行予定')).length, local.snapshot.events.length);
    const allDay = screen.nodes().find(node => node.props.testID === 'calendar-fixed-all-day'), chores = screen.nodes().find(node => node.props.testID === `calendar-chore-column:${day}`);
    const clock = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
    assert.ok(style(allDay).height > 0 && style(chores).height > 0);
    const toggleHeight = style(screen.button(expand.replace('開く', '閉じる'))).minHeight;
    assert.equal(style(chores).top, style(allDay).height + toggleHeight, 'chores follow the common all-day band and their own toggle');
    assert.ok(style(chores).top + style(chores).height < 300 - 160, 'both fixed panes must leave a clock viewport rather than overlapping the footer');
    assert.equal(descendants(clock).includes(allDay), false); assert.equal(descendants(clock).includes(chores), false);
    assert.equal(allDayScroll.props.simultaneousWith, clock.props.simultaneousWith, 'the pane participates in the existing horizontal day gesture');
    if (mode === '2日表示') {
      const next = addDays(day, 1);
      await screen.press(`${formatJapaneseDate(next, { year: true })}の家事を開く`);
      const other = screen.nodes().find(node => node.props.testID === `calendar-chore-column:${next}`);
      assert.equal(style(other).top, style(chores).top, 'chores start on the same row even on a day without an all-day event');
      assert.equal(descendants(clock).includes(other), false);
      assert.equal(style(screen.nodes().find(node => node.props.testID === `calendar-chore-column:${day}`)).height, style(chores).height);
      await screen.press(`${formatJapaneseDate(next, { year: true })}の家事を閉じる`);
    }
    screen.nodes().find(node => node.props.testID === 'calendar-viewport').props.onLayout({ nativeEvent: { layout: { height: 700 } } });
    screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading').props.onLayout({ nativeEvent: { layout: { height: 100 } } }); await screen.flush();
    local.snapshot = { ...local.snapshot, events: [{ ...local.snapshot.events[0], title: '一件でも長い旅行予定を時計から独立して読む'.repeat(6), revision: local.snapshot.events[0].revision + 1 }] }; screen.render();
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel?.startsWith('旅行予定0')), false);
    const currentButton = screen.button(`${local.snapshot.events[0].title}を編集`);
    assert.equal(descendants(screen.nodes().find(node => node.props.testID === 'calendar-timeline')).includes(currentButton), false);
    assert.equal(screen.nodes().filter(node => node.props.accessibilityLabel === currentButton.props.accessibilityLabel).length, 1);
  }
  await screen.press(`${formatJapaneseDate('2026-12-02', { year: true, weekday: true })}を表示`);
  assert.equal(screen.nodes().some(node => node.props.testID === 'calendar-fixed-all-day'), false);
});

for (const platform of ['ios', 'android']) test(`${platform} replaced all-day content cannot keep earlier rows or alter the current date pane`, async t => {
  const first = '2026-11-27';
  const initialEvents = Array.from({ length: 6 }, (_, index) => ({
    ...newEventDraft(addDays(first, index), 'Asia/Tokyo'), id: `measured-${index}`, title: `Synthetic content A ${index}`, revision: 1, allDay: true,
  }));
  const local = { database: {}, loading: false, error: null, refresh: async () => {}, snapshot: { events: initialEvents, exceptions: [], categories: [], drafts: [] } };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: first, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
  } }); t.after(() => screen.unmount());
  for (let edit = 0; edit < 18; edit++) {
    const prefix = `Synthetic content ${edit}:`;
    local.snapshot = { ...local.snapshot, events: initialEvents.map(row => ({ ...row, title: `${prefix}${row.id}`, revision: edit + 1 })) }; screen.render();
    await selectCalendarView(screen, ['1日表示', '2日表示', '3日表示'][edit % 3]);
    const panes = screen.nodes().filter(node => node.props.testID === 'calendar-fixed-all-day');
    const events = panes.flatMap(descendants).filter(node => node.props.accessibilityLabel?.startsWith('Synthetic content'));
    assert.equal(events.length, edit % 3 + 1);
    assert.ok(events.every(node => node.props.accessibilityLabel.startsWith(prefix)), 'old title revisions must not reappear');
  }
  local.snapshot = { ...local.snapshot, events: [] }; screen.render();
  assert.equal(screen.nodes().some(node => node.props.testID === 'calendar-fixed-all-day'), false);
});

for (const platform of ['ios', 'android']) test(`${platform} compact all-day rows bound long titles while preserving full accessible names and the same edit target`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const start = '2026-11-29', end = '2026-12-01';
  const title = `Synthetic inclusive trip ${'長い予定名'.repeat(12)}`, location = 'Synthetic saved location';
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(start, 'Asia/Tokyo'), title, location, allDay: true, endDate: end } });
  const snapshot = await readLocalCalendar(h.database), opened = [];
  const local = { database: h.database, snapshot, loading: false, error: null, refresh: async () => {}, prepareDraft: draft => { opened.push(structuredClone(draft)); return draft; } };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, width: 320, props: {
    today: start, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
  } }); t.after(() => screen.unmount());
  const writes = h.writes.length;
  for (const [mode, compact, visibleDays] of [['1日表示', true, 1], ['2日表示', true, 1], ['3日表示', true, 1], ['7日表示', true, 1], ['リスト表示', false, 3]]) {
    await selectCalendarView(screen, mode);
    const rows = screen.nodes().filter(node => node.props.accessibilityLabel === `${title}を編集`);
    assert.equal(rows.length, visibleDays, 'each view keeps an accessible action for the saved occurrence');
    for (const row of rows) {
      assert.equal(row.props.accessibilityRole, 'button');
      const label = descendants(row).find(node => node.type === 'Text' && node.children?.includes(title));
      assert.ok(label, 'display truncation never replaces the saved or accessible title with shortened text');
      if (compact) {
        assert.ok(label.props.numberOfLines > 0 && label.props.numberOfLines <= 2, 'compact columns must bound a long title instead of wrapping indefinitely');
        assert.equal(label.props.ellipsizeMode, 'tail');
        assert.match(row.props.accessibilityHint, new RegExp(location, 'u'));
        assert.equal(descendants(row).some(node => node.type === 'Text' && node.children?.includes(location)), false);
      } else {
        assert.ok(!label.props.numberOfLines, 'the list uses the available width for the full title');
        assert.ok(descendants(row).some(node => node.type === 'Text' && node.children?.includes(location)), 'the saved location remains in the list');
      }
      assert.notEqual(label.props.allowFontScaling, false, 'compact display respects the system text size');
    }
    await rows[0].props.onPress(); await screen.flush();
    const draft = opened.at(-1);
    assert.equal(draft.eventId, id); assert.equal(draft.anchorDate, start); assert.equal(draft.revision, 1);
    assert.equal(draft.value.title, title); assert.equal(draft.value.location, location);
    assert.equal(draft.value.startDate, start); assert.equal(draft.value.endDate, end);
    await screen.press('閉じる');
  }
  assert.equal(h.writes.length, writes, 'view changes and opening the original occurrence never persist a truncated title or per-day copies');
  assert.deepEqual((await readLocalCalendar(h.database)).events, snapshot.events);
});
