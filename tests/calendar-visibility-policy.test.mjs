import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { CalendarProjectionLimitError, calendarEventsInTimeZone, calendarMonth, indexCalendarOccurrences, newEventDraft } from '../src/features/calendar/events.ts';
import { projectPrivateCalendarDisplayEvents, projectPrivateCalendarEvents } from '../src/features/calendar/private-event-projection.ts';
import { v2WallTimeCandidates } from '../src/features/sharing/v2/local-time.ts';
import { createCalendarMonthCache } from '../src/features/calendar/month-cache.ts';
import { createCalendarMonthEventIndex } from '../src/features/calendar/month-event-index.ts';
import { visibleEventProjectionCandidates } from '../src/features/calendar/visible-event-candidates.ts';
import { calendarChoreDisplayThrough } from '../src/features/calendar/chore-display-range.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';

const contains = (node, text) => typeof node === 'string' ? node.includes(text) : Boolean(node && (node.children ?? []).some(child => contains(child, text)));
const today = '2026-11-07';
test('display projection reuses wall-time candidates only within one projection and preserves DST, midnight, exception metadata, and order', () => {
  const from = '2027-03-01'; const through = '2027-11-30'; const timeZone = 'Asia/Tokyo';
  const overnight = { ...newEventDraft('2027-05-15', 'America/Los_Angeles'), id: 'overnight', revision: 1, title: '元の予定' };
  const override = { ...newEventDraft('2027-05-15', 'America/Los_Angeles'), title: '日付をまたぐ例外', endDate: '2027-05-16', startMinute: 23 * 60 + 30, endMinute: 120 };
  const exception = { eventId: overnight.id, anchorDate: '2027-05-15', revision: 2, override, readOnly: true, blocksTime: false, externalUrl: 'https://calendar.example/event' };
  const gap = { ...newEventDraft('2027-03-14', 'America/Los_Angeles'), id: 'dst-gap', revision: 1, title: '夏時間の欠落', startMinute: 150, endMinute: 210 };
  const fold = { ...newEventDraft('2027-11-07', 'America/Los_Angeles'), id: 'dst-fold', revision: 1, title: '夏時間の重複', startMinute: 90, endMinute: 150 };
  const events = [overnight, gap, fold]; const exceptions = [exception]; const calls = [];
  const resolver = input => { calls.push(JSON.stringify([input.date, input.hour, input.minute, input.timeZone, input.second ?? 0, input.millisecond ?? 0])); return v2WallTimeCandidates(input); };
  const expected = calendarEventsInTimeZone(projectPrivateCalendarEvents(events, exceptions, from, through), timeZone);
  const actual = projectPrivateCalendarDisplayEvents(events, exceptions, from, through, timeZone, resolver);
  assert.deepEqual(actual, expected, 'a shared per-projection resolver preserves exact legacy rows and ordering');
  assert.equal(calls.length, 6, 'project and timezone stages resolve only the six unique start/end wall clocks');
  assert.equal(new Set(calls).size, calls.length);
  const moved = actual.find(row => row.eventId === overnight.id);
  assert.equal(moved.startDate, '2027-05-16'); assert.equal(moved.startMinute, 930);
  assert.equal(moved.endDate, '2027-05-16'); assert.equal(moved.endMinute, 1080);
  assert.equal(moved.readOnly, true); assert.equal(moved.blocksTime, false); assert.equal(moved.externalUrl, exception.externalUrl);
  assert.equal(moved.original.startDate, '2027-05-15'); assert.equal(moved.original.endDate, '2027-05-16');
  assert.equal(actual.find(row => row.eventId === gap.id).timeIssue, 'gap');
  assert.equal(actual.find(row => row.eventId === fold.id).timeIssue, 'fold');

  projectPrivateCalendarDisplayEvents(events, exceptions, from, through, timeZone, resolver);
  assert.equal(calls.length, 12, 'a later projection starts with an empty local cache');
});
test('display candidates skip distant one-off events while preserving moved overrides and recurrence tombstones', () => {
  const from = '2027-10-30'; const through = '2027-12-02';
  const distant = Array.from({ length: 1000 }, (_, index) => ({ ...newEventDraft('2000-01-01', 'UTC'), id: `distant-${index}`, revision: 1, title: `遠い予定${index}` }));
  const parent = { ...newEventDraft('2010-01-01', 'UTC'), id: 'detached-parent', revision: 1, title: '元の日付の予定' };
  const detached = { eventId: parent.id, anchorDate: '2010-01-01', revision: 2, detached: true, override: {
    ...newEventDraft('2027-11-19', 'UTC'), title: '離れた日から移動した予定', allDay: true,
  } };
  const recurring = { ...newEventDraft('2026-11-30', 'UTC'), id: 'monthly-series', revision: 1, title: '毎月の予定', recurrence: 'monthly' };
  const tombstone = { eventId: recurring.id, anchorDate: '2027-11-30', revision: 2, override: null };
  const inRange = { ...newEventDraft('2027-11-06', 'UTC'), id: 'in-range', revision: 1, title: '範囲内の予定' };
  const events = [...distant, parent, recurring, inRange]; const exceptions = [detached, tombstone];
  const candidates = visibleEventProjectionCandidates(events, exceptions, from, through);
  assert.equal(candidates.events.length, 3, 'only the intersecting event, repeating series, and moved override parent are projected');
  assert.equal(candidates.exceptions.length, 2, 'all exceptions for retained series, including cancellation tombstones, remain available');
  assert.deepEqual(
    projectPrivateCalendarEvents(candidates.events, candidates.exceptions, from, through),
    projectPrivateCalendarEvents(events, exceptions, from, through),
    'display filtering produces the same occurrences as the complete saved snapshot',
  );
  const projected = projectPrivateCalendarEvents(candidates.events, candidates.exceptions, from, through);
  assert.ok(projected.some(row => row.title === '離れた日から移動した予定' && row.startDate === '2027-11-19'));
  assert.ok(!projected.some(row => row.eventId === recurring.id && row.anchorDate === '2027-11-30'), 'a confirmed cancellation tombstone still suppresses its recurring occurrence');
});
test('calendar month event index projects on demand and evicts the least recently used month at its bound', () => {
  let wasteMonthProjections = 0;
  const wasteMonths = createCalendarMonthCache((from, through) => { wasteMonthProjections += 1; return { from, through }; });
  assert.deepEqual(wasteMonths.forDate('2027-11-06'), { from: '2027-11-01', through: '2027-11-30' });
  assert.deepEqual(wasteMonths.forDate('2027-11-28'), { from: '2027-11-01', through: '2027-11-30' });
  assert.equal(wasteMonthProjections, 1, 'all dates in a visible month reuse one complete month result');

  const calls = [];
  const index = createCalendarMonthEventIndex((from, through) => { calls.push([from, through]); return []; }, 2);
  index.forDate('2027-01-05');
  index.forDate('2027-01-31');
  index.forDate('2027-02-10');
  index.forDate('2027-03-10');
  assert.equal(calls.length, 3, 'the same month shares one projection and unrelated months stay untouched');
  assert.equal(index.cachedMonthCount(), 2);
  index.forDate('2027-01-15');
  assert.equal(calls.length, 4, 'the least recently used month is reprojected after eviction');
  assert.deepEqual(calls[0], ['2026-12-30', '2027-02-02']);
  assert.deepEqual(calls[2], ['2027-02-27', '2027-04-02']);
});
test('a real monthly occurrence overflow retains the exact visible rounds without repeating the failed month', () => {
  const day = '2027-07-01';
  const events = Array.from({ length: 650 }, (_, i) => ({
    ...newEventDraft(day, 'Asia/Tokyo'), id: `daily-${i}`, title: '7月の予定', revision: 1, allDay: true, recurrence: 'daily', untilDate: '2027-07-31',
  }));
  const exceptions = [{ eventId: events[0].id, anchorDate: day, revision: 1, override: null }, {
    eventId: events[1].id, anchorDate: '2027-07-20', revision: 1,
    override: { ...newEventDraft('2027-06-30', 'America/Los_Angeles'), title: '移動した回', startMinute: 1320, endMinute: 1380 },
  }];
  const calls = [];
  const project = (from, through) => projectPrivateCalendarDisplayEvents(events, exceptions, from, through, 'Asia/Tokyo');
  const index = createCalendarMonthEventIndex((from, through) => { calls.push([from, through]); return project(from, through); });
  assert.equal(index.errorForDate('2027-06-30'), null);
  const expected = indexCalendarOccurrences(project('2027-06-29', '2027-07-03'), day, day).get(day);
  const rows = index.forDate(day);
  assert.deepEqual(rows, expected);
  assert.equal(rows.length, 650);
  assert.ok(rows.some(row => row.title === '移動した回' && row.original?.startDate === '2027-06-30'));
  assert.equal(index.errorForDate(day), null);
  assert.equal(index.forDate(day), rows);
  assert.equal(index.forDate('2027-07-02').length, 650);
  assert.equal(calls.filter(([from, through]) => from === '2027-06-29' && through === '2027-08-02').length, 1);
  assert.equal(calls.filter(([from, through]) => from === '2027-06-29' && through === '2027-07-03').length, 1);
});
test('an overflowing time-zone margin splits source days and retains unique ordered appointments', () => {
  const day = '2027-07-01';
  const events = [
    { ...newEventDraft('2027-06-30', 'America/Los_Angeles'), id: 'shifted', title: '前日から', revision: 1, startMinute: 1320, endMinute: 1380 },
    { ...newEventDraft('2027-06-29', 'Asia/Tokyo'), id: 'several-days', title: '連日', revision: 1, allDay: true, endDate: '2027-07-03' },
    { ...newEventDraft(day, 'Asia/Tokyo'), id: 'morning', title: '朝', revision: 1 },
  ];
  const project = (from, through) => projectPrivateCalendarDisplayEvents(events, [], from, through, 'Asia/Tokyo');
  const calls = [];
  const index = createCalendarMonthEventIndex((from, through) => {
    calls.push([from, through]);
    if (from !== through) throw new CalendarProjectionLimitError();
    return project(from, through);
  });
  assert.deepEqual(index.forDate(day), indexCalendarOccurrences(project('2027-06-29', '2027-07-03'), day, day).get(day));
  assert.equal(index.errorForDate(day), null);
  assert.equal(calls.filter(([from, through]) => from === through).length, 5);
});
test('calendar housework stops at the end of the second following month across year and leap boundaries', () => {
  assert.equal(calendarChoreDisplayThrough('2026-11-07'), '2027-01-31');
  assert.equal(calendarChoreDisplayThrough('2027-12-31'), '2028-02-29');
  assert.equal(calendarChoreDisplayThrough('2026-12-31'), '2027-02-28');
});
test('the final housework month accepts its clipped range without planning spillover days from the next month', async () => {
  const { fixture, seeds, now } = await import('./helpers/sharing-v2-repository-fixture.mjs');
  const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
  const { createV2ScreenSession } = await import('../src/features/sharing/v2-ui/screen-session.ts');
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
    const session = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
      readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
    const value = await session.readModel({ calendarMonth: '2026-12-01', calendarRange: { from: '2026-11-01', through: '2026-12-31' } });
    assert.equal(value.plan.range.through, '2026-12-31');
    await assert.rejects(session.readModel({ calendarMonth: '2027-11-01' }), /予定のみ/);
  } finally { d.connection.close(); }
});
for (const platform of ['ios', 'android']) {
  test(`${platform} calendar projection failures are visible only on affected dates across a month boundary`, async () => {
    const failure = 'この日の予定を読み込めませんでした。';
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
      props: { today: '2027-06-30', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null },
      mocks: { './private-event-projection': {
        projectPrivateCalendarDisplayEvents: (_events, _exceptions, from, through) => {
          if (from === '2027-06-29' && through === '2027-08-02') throw new CalendarProjectionLimitError();
          if (from === '2027-06-29' && through === '2027-07-03') throw new Error(failure);
          return [];
        },
      } },
    });
    try {
      await selectCalendarView(screen, '2日表示');
      assert.ok(screen.nodes().some(node => node.props.accessibilityRole === 'alert' && node.props.accessibilityLabel?.startsWith('2027年7月1日')));
      assert.ok(!screen.nodes().some(node => node.props.accessibilityRole === 'alert' && node.props.accessibilityLabel?.startsWith('2027年6月30日')));
      await selectCalendarView(screen, 'リスト表示');
      assert.match(screen.text(), /この日の予定を読み込めませんでした/);
      const list = screen.nodes().find(node => node.props.testID === 'calendar-agenda');
      const [june30, july1] = list.children;
      assert.ok(contains(june30, '予定なし'));
      assert.ok(contains(july1, failure));
      assert.ok(!contains(july1, '予定なし'));
      await screen.press('月表示に戻る');
      assert.ok(screen.nodes().some(node => node.props.accessibilityLabel?.startsWith('2027年7月1日') && node.props.accessibilityLabel.includes(failure)));
    } finally { screen.unmount(); }
  });
  test(`${platform} a fast fling renders saved far-month recurrence and time-zone events before viewability updates`, async () => {
    const repeating = { ...newEventDraft('2026-11-30', 'Asia/Tokyo'), id: 'monthly-event', revision: 1, title: '元の月末予定', recurrence: 'monthly' };
    const exception = { eventId: repeating.id, anchorDate: '2027-11-30', revision: 2, override: {
      ...newEventDraft('2027-11-28', 'Asia/Tokyo'), title: '遠い繰り返し例外', recurrence: 'none', allDay: true,
    } };
    const timeZoneEvent = { ...newEventDraft('2027-11-07', 'Asia/Tokyo'), id: 'timezone-event', revision: 1, title: '時差をまたぐ予定', allDay: false, startMinute: 30, endMinute: 90 };
    const movable = { ...newEventDraft('2027-11-16', 'America/Los_Angeles'), id: 'movable-event', revision: 1, title: '遠い予定の移動', allDay: true };
    const detachedParent = { ...newEventDraft('2020-01-01', 'Asia/Tokyo'), id: 'detached-parent', revision: 1, title: '以前の日付の予定' };
    const detachedMove = { eventId: detachedParent.id, anchorDate: '2020-01-01', revision: 2, detached: true, override: {
      ...newEventDraft('2027-11-29', 'Asia/Tokyo'), title: '離れた日から移動した予定', allDay: true,
    } };
    const events = [repeating, timeZoneEvent, movable, detachedParent]; const exceptions = [exception, detachedMove]; const savedMoves = [];
    const wasteSchedules = [
      { id: 'monthly-waste', householdId: 'local', label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 7 },
      { id: 'weekly-waste', householdId: 'local', label: 'びん', recurrence: 'weekly', collectionWeekdays: [7] },
    ];
    const hiddenWasteKeys = ['weekly-waste:2027-11-28']; const completeFarWaste = day => day >= '2027-11-01' && day <= '2027-11-30';
    const oldFrom = calendarMonth('2026-11-01', -1); const oldThrough = addDays(calendarMonth('2026-11-01', 2), -1);
    const oldProjection = calendarEventsInTimeZone(projectPrivateCalendarEvents(events, exceptions, addDays(oldFrom, -2), addDays(oldThrough, 2)), 'America/Los_Angeles');
    const oldIndex = indexCalendarOccurrences(oldProjection, oldFrom, oldThrough);
    assert.equal(oldIndex.get('2027-11-28'), undefined, 'the selected-month range cannot index a row months away');

    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(), props: {
      today, timeZone: 'America/Los_Angeles', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      wasteSchedules, hiddenWasteKeys, wasteLoaded: completeFarWaste,
      local: { database: {}, snapshot: { events, exceptions, categories: [], draft: null, drafts: [] }, loading: false, error: null,
        refresh: async () => {}, saveEvent: async draft => { savedMoves.push(draft); } },
    } });
    try {
      const initialList = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
      const targetRow = initialList.props.data.find(row => row.days.includes('2027-11-06'));
      assert.ok(targetRow);
      initialList.props.onScrollBeginDrag();
      initialList.props.onScroll({ nativeEvent: { contentOffset: { y: targetRow.offset } } });
      screen.render();
      assert.equal(screen.nodes().find(node => node.props.accessibilityLabel === '表示する年と月を選択').props.accessibilityValue.text, '2026年11月', 'the test keeps selected-month viewability stale during the fling');
      assert.ok(screen.nodes().some(node => node.props.accessibilityLabel === '遠い繰り返し例外、2027-11-28の予定'), 'the moved exception appears in the first far row render');
      assert.ok(screen.nodes().some(node => node.props.accessibilityLabel === '離れた日から移動した予定、2027-11-29の予定'), 'a detached override from an unrelated parent date survives candidate filtering');
      assert.ok(screen.nodes().some(node => node.props.accessibilityLabel === '時差をまたぐ予定、2027-11-06の予定'), 'the saved timed event is projected to its display-zone date');
      assert.match(screen.nodes().find(node => node.props.accessibilityLabel?.startsWith('2027年11月7日'))?.props.accessibilityLabel ?? '', /粗大ごみ/, 'a confirmed occurrence kind appears with its far date');
      assert.match(screen.nodes().find(node => node.props.accessibilityLabel?.startsWith('2027年11月28日'))?.props.accessibilityLabel ?? '', /非表示の収集：びん/, 'a hidden occurrence indicator appears only with complete far-month coverage');

      const move = screen.nodes().find(node => node.props.accessibilityLabel === '遠い予定の移動、2027-11-16の予定');
      assert.ok(move?.props.accessibilityActions?.some(action => action.name === 'moveNextDay'), 'the visible far event retains its move gesture');
      move.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveNextDay' } });
      await screen.flush();
      assert.equal(savedMoves.length, 1, 'the far-row move resolves the same confirmed occurrence snapshot');
      assert.equal(savedMoves[0].value.startDate, '2027-11-17');
      assert.doesNotMatch(screen.text(), /予定が更新されました/);
    } finally { screen.unmount(); }

    const unknownScreen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'America/Los_Angeles', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      wasteSchedules, hiddenWasteKeys, wasteLoaded: day => !completeFarWaste(day),
      local: { database: {}, snapshot: { events, exceptions, categories: [], draft: null, drafts: [] }, loading: false, error: null, refresh: async () => {} },
    } });
    try {
      const list = unknownScreen.nodes().find(node => node.props.testID === 'calendar-weeks');
      const row = list.props.data.find(item => item.days.includes('2027-11-06'));
      list.props.onScrollBeginDrag(); list.props.onScroll({ nativeEvent: { contentOffset: { y: row.offset } } }); unknownScreen.render();
      const unknownSunday = unknownScreen.nodes().find(node => node.props.accessibilityLabel?.startsWith('2027年11月7日'));
      assert.ok(unknownSunday);
      assert.doesNotMatch(unknownSunday.props.accessibilityLabel, /粗大ごみ|びん|非表示の収集|収集未取得|収集日は未取得/, 'unknown waste remains internal and does not imply a collection or expose a status label');
      assert.doesNotMatch(unknownScreen.text(), /収集未取得|収集日は未取得/);
    } finally { unknownScreen.unmount(); }
  });
  test(`${platform} shared calendar navigation never reloads the housework plan for a distant appointment date`, async () => {
    const { fixture, seeds, now } = await import('./helpers/sharing-v2-repository-fixture.mjs');
    const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
    const { createV2ScreenSession } = await import('../src/features/sharing/v2-ui/screen-session.ts');
    const f = await fixture(); const d = await f.device(); let screen; let leave;
    try {
      await d.repository.commit(seeds());
      const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
      const source = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const model = await source.readModel(); const reads = []; let focus;
      const session = { ...source, readModel: async options => { reads.push(options); return model; } };
      screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(), focusEffect: callback => { focus = callback; },
        props: { purpose: 'workspace', view: 'calendar', lifecycleManaged: true, initialDisplay: { session, model }, loadSession: async () => session,
          onBack: () => {}, onConfiguration: () => {}, onHistory: () => {} } });
      leave = focus(); await screen.flush(); const initial = reads.length;
      await screen.press('表示する年と月を選択'); await screen.press('2027年'); await screen.press('11月'); await screen.press('2027年11月へ移動');
      await selectCalendarView(screen, '1日表示'); await screen.flush();
      assert.equal(reads.length, initial, 'choosing a far date must not trigger a shared/private Scheduler refresh');
      assert.doesNotMatch(screen.text(), /家事は未取得|共有予定を読み込んで|家事.*読込/);
    } finally { leave?.(); screen?.unmount(); d.connection.close(); }
  });
  test(`${platform} distant calendars display saved appointments without calculating or requesting housework outside the two-month horizon`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const requested = [];
    const far = { ...newEventDraft('2027-11-07', 'Asia/Tokyo'), id: 'future-saved', revision: 1, title: '保存済みの来年の予定' };
    const original = structuredClone(far);
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
      effectDependencies: true, effect: work => work(), props: {
        today, timeZone: 'Asia/Tokyo', onMonth: day => requested.push(day), monthLoaded: () => false,
        dayInfo: day => { assert.ok(day <= '2027-01-31', `unnecessary housework calculation: ${day}`); return { loaded: true, total: 3, pending: 3 }; }, renderChores: () => null,
        local: { database: {}, snapshot: { events: [far], exceptions: [], categories: [], draft: null, drafts: [] }, loading: false, error: null, refresh: async () => {} },
      } });
    await screen.press('表示する年と月を選択'); await screen.press('2027年'); await screen.press('11月'); await screen.press('2027年11月へ移動');
    t.mock.timers.tick(300); await screen.flush();
    assert.deepEqual(requested, []); assert.ok(screen.text().includes('保存済みの予定'));
    screen.button('保存済みの予定、2027-11-07の予定');
    assert.deepEqual(far, original, 'shortening the visible relative date keeps the complete saved appointment');
    const day = screen.nodes().find(node => node.props.accessibilityLabel?.startsWith('2027年11月7日、'));
    assert.ok(day); assert.doesNotMatch(day.props.accessibilityLabel, /家事|読込|未取得/);
    screen.unmount(); t.mock.timers.reset();
  });
  test(`${platform} expanded housework stays in its own scrolling pane when the calendar timeline scrolls`, async () => {
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 2, pending: 2 }), renderChores: day => `固定する家事:${day}`,
    } });
    for (const mode of ['1日表示', '2日表示']) {
      await selectCalendarView(screen, mode);
      const label = '2026年11月7日の家事を開く';
      if (screen.nodes().some(node => node.props.accessibilityLabel === label)) await screen.press(label);
      const timeline = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
      const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
      assert.ok(pane); assert.ok(contains(pane, `固定する家事:${today}`));
      assert.equal(contains(timeline, `固定する家事:${today}`), false);
      timeline.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 800 } } }); screen.render();
      assert.ok(contains(screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores'), `固定する家事:${today}`));
    }
    screen.unmount();
  });
  test(`${platform} official holidays annotate the date without an all-day appointment card`, async () => {
    const holidayDay = '2026-11-03';
    const holiday = { ...newEventDraft(holidayDay, 'Asia/Tokyo'), id: 'holiday', revision: 1, title: '祝日の検査', allDay: true, holiday: true, blocksTime: false, readOnly: true };
    const trip = { ...holiday, id: 'trip', title: '旅行', holiday: undefined, blocksTime: true, readOnly: false };
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: holidayDay, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0, pending: 0 }), renderChores: () => null,
      local: { database: {}, snapshot: { events: [holiday, trip], exceptions: [], categories: [], draft: null, drafts: [] }, loading: false, error: null, refresh: async () => {} },
    } });
    for (const mode of ['1日表示', '2日表示', 'リスト表示']) {
      await selectCalendarView(screen, mode); assert.ok(screen.text().includes('文化の日')); assert.equal(screen.text().includes(holiday.title), false);
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === `${holiday.title}を編集`), false);
      screen.button('旅行を編集');
    }
    screen.unmount();
  });
  test(`${platform} start and end time pickers offer five-minute steps without rewriting an existing imported minute on open`, async () => {
    for (const label of ['開始', '終了']) {
      let native; const accepted = [];
      const field = screenHarness('src/features/calendar/calendar-field.tsx', { exportName: 'CalendarField', platform, datePicker: value => { native = value; }, props: {
        label, date: today, minute: 634, mode: 'time', onMinute: value => accepted.push(value),
      } });
      await field.press(`${label}を選択`);
      const picker = platform === 'android' ? native : field.nodes().find(node => node.type === 'DateTimePicker').props;
      assert.equal(picker.minuteInterval, 5); assert.equal(picker.display, 'spinner');
      assert.equal(picker.value.getUTCMinutes(), 34); assert.deepEqual(accepted, []);
      picker.onValueChange({}, new Date(Date.UTC(2026, 10, 7, 10, 40))); assert.deepEqual(accepted, [640]);
      field.unmount();
    }
  });
}
