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
    const pane = screen.nodes().find(row => row.props.testID === 'calendar-fixed-chores');
    const style = Object.assign({}, ...pane.props.style.flat(Infinity).filter(Boolean));
    assert.ok(style.height > 0 && style.height < 300 - 160, 'the expanded pane must leave room for the timeline and cannot extend under the tab bar');
    for (const event of events) screen.button(`${event.title}を編集`);
    assert.ok(descendants(pane).some(row => row.children?.includes('最後の家事もスクロールで読めます')));
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
    const toggles = descendants(header).filter(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('の家事を'));
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
  for (const [mode, days] of [['1日表示', 1], ['2日表示', 2], ['3日表示', 3]]) {
    await selectCalendarView(screen, mode);
    for (const date of [start, '2026-11-30', end]) {
      await screen.press(`${formatJapaneseDate(date, { year: true, weekday: true })}を表示`);
      const clock = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
      const visible = Array.from({ length: days }, (_, index) => addDays(date, index)).filter(day => day <= end);
      const label = `${title}を編集`;
      const appointments = screen.nodes().filter(node => node.props.accessibilityLabel === label);
      assert.equal(appointments.length, days === 3 ? 1 : visible.length);
      assert.ok(appointments.every(row => !descendants(clock).includes(row)), 'clock positioning and scrolling must not carry all-day rows away');
      if (days === 3) assert.equal(appointments[0].props.accessibilityHint, `終日、${visible.map(day => formatJapaneseDate(day)).filter((_, index) => index === 0 || index === visible.length - 1).join('〜')}`);
      else for (const day of visible) {
        const pane = screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の終日予定`);
        assert.ok(pane && descendants(pane).some(node => node.props.accessibilityLabel === `${title}を編集`));
      }
      clock.props.ref.current = { scrollToOffset() {} };
      screen.nodes().find(node => node.props.testID === 'calendar-timeline-days').props.onLayout({ nativeEvent: { layout: { height: 0 } } });
      clock.props.onLayout({ nativeEvent: { layout: { height: 350 } } });
      clock.props.onScroll({ nativeEvent: { contentOffset: { y: 900 } } }); await screen.flush();
      assert.equal(screen.nodes().filter(node => node.props.accessibilityLabel === label).length, appointments.length);
      if (date === end) assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'Synthetic midnight endpointを編集'), false, 'timed midnight end stays exclusive');
    }
    await screen.press(`${formatJapaneseDate('2026-12-02', { year: true, weekday: true })}を表示`);
    assert.equal(screen.nodes().some(node => ['calendar-fixed-all-day', 'calendar-compact-all-day'].includes(node.props.testID)), false, 'no empty all-day pane remains after the inclusive end');
  }
  assert.equal(h.writes.length, writes, 'view changes and clock scrolling never persist per-day copies');
  await screen.press(`${formatJapaneseDate(end, { year: true, weekday: true })}を表示`); await screen.press(`${title}を編集`);
  assert.equal(opened.length, 1); assert.equal(opened[0].eventId, id); assert.equal(opened[0].revision, 1);
  assert.equal(opened[0].anchorDate, start); assert.equal(opened[0].value.startDate, start); assert.equal(opened[0].value.endDate, end);
  assert.deepEqual((await readLocalCalendar(h.database)).events, snapshot.events);
});

for (const platform of ['ios', 'android']) test(`${platform} measured all-day content shares bounded space with expanded chores and ignores stale content measurements`, async t => {
  const day = '2026-11-30';
  const local = { database: {}, loading: false, error: null, refresh: async () => {}, snapshot: { events: Array.from({ length: 5 }, (_, index) => ({
    ...newEventDraft(day, 'Asia/Tokyo'), id: `all-day-${index}`, title: `旅行予定${index} ${'長い名前'.repeat(index + 1)}`, revision: 1, allDay: true,
  })), exceptions: [], categories: [], drafts: [] } };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(), props: {
    today: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, pending: 12, total: 12 }), renderChores: () => '展開した家事一覧',
  } }); t.after(() => screen.unmount());
  const style = node => Object.assign({}, ...node.props.style.flat(Infinity).filter(value => value && typeof value === 'object'));
  for (const mode of ['1日表示', '2日表示']) {
    await selectCalendarView(screen, mode);
    const expand = `${formatJapaneseDate(day, { year: true })}の家事を開く`;
    if (screen.nodes().some(node => node.props.accessibilityLabel === expand)) await screen.press(expand);
    screen.nodes().find(node => node.props.testID === 'calendar-viewport').props.onLayout({ nativeEvent: { layout: { height: 300 } } });
    screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading').props.onLayout({ nativeEvent: { layout: { height: 160 } } });
    screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の家事一覧`).props.onContentSizeChange(150, 900);
    const allDayScroll = screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の終日予定`);
    assert.ok(allDayScroll, 'all-day content has its own accessible scroll surface');
    allDayScroll.props.onContentSizeChange(150, 900); await screen.flush();
    const allDay = screen.nodes().find(node => node.props.testID === 'calendar-fixed-all-day'), chores = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
    const clock = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
    assert.ok(style(allDay).height > 0 && style(chores).height > 0);
    assert.ok(style(allDay).height + style(chores).height < 300 - 160, 'both fixed panes must leave a clock viewport rather than overlapping the footer');
    assert.equal(descendants(clock).includes(allDay), false); assert.equal(descendants(clock).includes(chores), false);
    const settledAllDayScroll = screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の終日予定`);
    assert.equal(settledAllDayScroll.props.simultaneousWith, clock.props.simultaneousWith, 'the pane participates in the existing horizontal day gesture');
    assert.equal(settledAllDayScroll.props.scrollEnabled, true);
    screen.nodes().find(node => node.props.testID === 'calendar-viewport').props.onLayout({ nativeEvent: { layout: { height: 700 } } });
    screen.nodes().find(node => node.props.testID === 'calendar-fixed-day-heading').props.onLayout({ nativeEvent: { layout: { height: 100 } } }); await screen.flush();
    const oldContent = screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の終日予定`);
    oldContent.props.onContentSizeChange(150, 60); await screen.flush();
    local.snapshot = { ...local.snapshot, events: [{ ...local.snapshot.events[0], title: '一件でも長い旅行予定を時計から独立して読む'.repeat(6), revision: local.snapshot.events[0].revision + 1 }] }; screen.render();
    const currentContent = screen.nodes().find(node => node.props.accessibilityLabel === `${formatJapaneseDate(day, { year: true })}の終日予定`);
    currentContent.props.onContentSizeChange(150, 110); await screen.flush();
    const currentHeight = style(screen.nodes().find(node => node.props.testID === 'calendar-fixed-all-day')).height;
    oldContent.props.onContentSizeChange(150, 9000); await screen.flush();
    assert.equal(style(screen.nodes().find(node => node.props.testID === 'calendar-fixed-all-day')).height, currentHeight, 'a delayed size from previous rows cannot resize the current long row');
    const currentButton = screen.button(`${local.snapshot.events[0].title}を編集`);
    assert.equal(descendants(screen.nodes().find(node => node.props.testID === 'calendar-timeline')).includes(currentButton), false);
    assert.equal(screen.nodes().filter(node => node.props.accessibilityLabel === currentButton.props.accessibilityLabel).length, 1);
  }
  await screen.press(`${formatJapaneseDate('2026-12-01', { year: true, weekday: true })}を表示`);
  assert.equal(screen.nodes().some(node => node.props.testID === 'calendar-fixed-all-day'), false);
});

for (const platform of ['ios', 'android']) test(`${platform} all-day measurements retain only active content and ignore callbacks from retired content`, async t => {
  const first = '2026-11-29'; const initialEvents = Array.from({ length: 3 }, (_, index) => ({
    ...newEventDraft(addDays(first, index), 'Asia/Tokyo'), id: `measured-${index}`, title: `Synthetic content A ${index}`, revision: 1, allDay: true,
  }));
  const local = { database: {}, loading: false, error: null, refresh: async () => {}, snapshot: { events: initialEvents, exceptions: [], categories: [], drafts: [] } };
  let observed;
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(),
    // Observe the actual retained record for this resource bound, without adding a product API or replacing its updater.
    transformSource: (path, source) => {
      if (!path.endsWith('/features/calendar/planner-calendar.tsx')) return source;
      const anchor = '  const hasAllDay = allDayColumns.some'; assert.equal(source.split(anchor).length, 2);
      return source.replace(anchor, '  props.inspectAllDayMeasurements(allDayContentHeights, allDayColumns);\n' + anchor);
    }, props: {
      today: first, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
      inspectAllDayMeasurements: (heights, columns) => { observed = { heights, active: new Set(columns.filter(column => column.rows.length).map(column => column.measurement)) }; },
    } }); t.after(() => screen.unmount());
  let previous = []; let initialKeys;
  for (let edit = 0; edit < 40; edit++) {
    local.snapshot = { ...local.snapshot, events: initialEvents.map(row => ({ ...row, title: `Synthetic content ${edit} ${row.id}`, revision: edit + 1 })) }; screen.render();
    await selectCalendarView(screen, ['1日表示', '2日表示', '3日表示'][edit % 3]);
    const current = screen.nodes().filter(node => node.props.accessibilityLabel?.endsWith('の終日予定'));
    for (let index = 0; index < current.length; index++) current[index].props.onContentSizeChange(150, 100 + index);
    await screen.flush();
    const retained = Object.keys(observed.heights);
    assert.ok(retained.length <= observed.active.size, 'session edits cannot accumulate historical title, revision or column-width measurements');
    assert.ok(retained.every(key => observed.active.has(key)), 'only currently rendered content remains measured');
    if (!initialKeys) initialKeys = new Set(retained);
    const accepted = observed.heights;
    for (const old of previous) old.props.onContentSizeChange(150, 9000);
    await screen.flush(); assert.equal(observed.heights, accepted, 'inactive callbacks cannot restore discarded keys or trigger another layout state');
    for (let index = 0; index < current.length; index++) current[index].props.onContentSizeChange(150, 100 + index);
    await screen.flush(); assert.equal(observed.heights, accepted, 'an unchanged active measurement retains the same state');
    previous = current;
  }
  await screen.press(`${formatJapaneseDate('2026-12-02', { year: true, weekday: true })}を表示`);
  await screen.flush();
  assert.deepEqual(observed.heights, {}, 'no measurements are retained when no measured rows are present');
  const beforeRetired = observed.heights;
  for (const old of previous) old.props.onContentSizeChange(150, 9000);
  await screen.flush(); assert.equal(observed.heights, beforeRetired);
  assert.equal(screen.nodes().some(node => node.props.testID === 'calendar-fixed-all-day'), false);
  local.snapshot = { ...local.snapshot, events: initialEvents.map(row => ({ ...row, title: `Synthetic content 0 ${row.id}` })) }; screen.render();
  await screen.press(`${formatJapaneseDate(first, { year: true, weekday: true })}を表示`);
  assert.ok(Object.keys(observed.heights).every(key => !initialKeys.has(key)), 'returning to old rows cannot resurrect their retired measurement');
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
  let ordinaryTitleStyle;
  for (const [mode, compact, visibleDays] of [['1日表示', false, 1], ['2日表示', true, 2], ['3日表示', true, 1], ['7日表示', true, 1], ['リスト表示', false, 3]]) {
    await selectCalendarView(screen, mode);
    const combined = ['3日表示', '7日表示'].includes(mode);
    const rows = screen.nodes().filter(node => node.props.accessibilityLabel === `${title}を編集`);
    assert.equal(rows.length, visibleDays, 'each view keeps an accessible action for the saved occurrence');
    for (const row of rows) {
      assert.equal(row.props.accessibilityRole, 'button');
      const label = descendants(row).find(node => node.type === 'Text' && node.children?.includes(title));
      assert.ok(label, 'display truncation never replaces the saved or accessible title with shortened text');
      if (compact) {
        assert.ok(label.props.numberOfLines > 0 && label.props.numberOfLines <= 2, 'compact columns must bound a long title instead of wrapping indefinitely');
        if (!combined) assert.equal(label.props.ellipsizeMode, 'tail');
      } else assert.ok(!label.props.numberOfLines, 'the one-day and list rows retain their existing unrestricted title');
      assert.notEqual(label.props.allowFontScaling, false, 'compact display respects the system text size');
      if (!combined) {
        if (!ordinaryTitleStyle) ordinaryTitleStyle = label.props.style;
        assert.deepEqual(label.props.style, ordinaryTitleStyle, 'ordinary rows retain the same title typography and theme');
        assert.ok(descendants(row).some(node => node.type === 'Text' && node.children?.includes(location)), 'the saved location remains on ordinary rows');
      }
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
