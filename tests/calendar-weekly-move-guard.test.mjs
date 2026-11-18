import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { newEventDraft, calendarEventAnchors, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { calendarMovedDraft, calendarOccurrenceDraft, calendarSeriesMovedDraft, calendarFutureMovedDraft } from '../src/features/calendar/direct-actions.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { googleImportedEvent } from '../src/features/calendar/google-event-import.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView, scrollCalendarToDate } from './helpers/calendar-ui.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const storage = await import('../src/platform/storage/calendar-events.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');

const original = (extra = {}) => ({ ...newEventDraft('2026-11-01', 'Asia/Tokyo'), id: 'series', revision: 1, title: '会議',
  recurrence: 'custom', customRecurrence: { unit: 'week', interval: 2, weekdays: [0, 3] }, ...extra });
const held = (series, date = '2026-11-18') => projectCalendarEvents([series], [], date, date)[0];
const error = /間隔を保てません.*この予定だけ/u;

test('whole and future multiweek moves refuse an unrepresentable week phase without changing the source or captured proof', () => {
  for (const allDay of [false, true]) {
    const series = original({ allDay }), occurrence = held(series), draft = { ...calendarOccurrenceDraft(occurrence, true), audience: 'group', groupId: 'group', basisRevision: 'captured-proof' };
    const before = structuredClone({ series, occurrence, draft });
    for (const move of [calendarSeriesMovedDraft, calendarFutureMovedDraft]) assert.throws(() => move(draft, series, { day: '2026-11-17', minute: 540 }, 'Asia/Tokyo'), error);
    assert.deepEqual({ series, occurrence, draft }, before);
    const one = calendarMovedDraft(draft, { day: '2026-11-17', minute: 540 }, 'Asia/Tokyo');
    assert.equal(one.scope, 'one'); assert.equal(one.anchorDate, '2026-11-18'); assert.equal(one.value.startDate, '2026-11-17');
    assert.equal(one.value.recurrence, 'none'); assert.equal(one.basisRevision, draft.basisRevision);
  }
});

test('weekly move acceptance agrees with independently translated occurrence dates across every weekday set and year boundary', () => {
  let accepted = 0, refused = 0;
  for (const interval of [1, 2, 3]) for (const startDay of [0, 3, 6]) for (let mask = 1; mask < 128; mask++) for (const shift of [-8, -1, 1, 8]) for (const until of [null, 2, 35]) {
    const startDate = addDays('2026-12-27', startDay), weekdays = Array.from({ length: 7 }, (_, day) => day).filter(day => mask & (1 << day));
    const series = original({ startDate, endDate: startDate, allDay: true, customRecurrence: { unit: 'week', interval, weekdays }, untilDate: until === null ? null : addDays(startDate, until) });
    const through = series.untilDate ?? addDays(startDate, 84), dates = calendarEventAnchors(series, startDate, through); if (!dates.length) continue;
    const occurrence = held(series, dates[0]), draft = calendarOccurrenceDraft(occurrence, true);
    const target = { day: addDays(occurrence.startDate, shift), minute: occurrence.startMinute };
    const expected = dates.map(day => addDays(day, shift));
    const rotated = { ...series, startDate: addDays(startDate, shift), endDate: addDays(startDate, shift),
      untilDate: series.untilDate ? addDays(series.untilDate, shift) : null,
      customRecurrence: { ...series.customRecurrence, weekdays: weekdays.map(day => (day + shift % 7 + 7) % 7).sort((a, b) => a - b) } };
    const actual = calendarEventAnchors(rotated, rotated.startDate, addDays(through, shift));
    const context = JSON.stringify({ startDate, interval, weekdays, shift, until });
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      const moved = calendarSeriesMovedDraft(draft, series, target, 'Asia/Tokyo');
      assert.deepEqual(calendarEventAnchors({ ...moved.value, id: series.id, revision: 2 }, moved.value.startDate, addDays(through, shift)), expected, context); accepted++;
    } else { assert.throws(() => calendarSeriesMovedDraft(draft, series, target, 'Asia/Tokyo'), error, context); refused++; }
  }
  assert.ok(accepted > 1000 && refused > 1000, 'the matrix must cover safe and unrepresentable shifts');
});

test('finite weekly series and safe whole week clock and timezone moves keep their dates and Google recurrence', () => {
  const finite = original({ untilDate: '2026-11-01' }), first = held(finite, finite.startDate);
  const short = calendarSeriesMovedDraft(calendarOccurrenceDraft(first, true), finite, { day: '2026-10-31', minute: 540 }, 'Asia/Tokyo');
  assert.deepEqual(calendarEventAnchors({ ...short.value, id: finite.id, revision: 2 }, '2026-10-01', '2026-12-31'), ['2026-10-31']);
  const source = original({ startDate: '2026-03-01', endDate: '2026-03-01', timeZone: 'America/New_York', untilDate: '2026-05-01' });
  const occurrence = held(source, '2026-03-15'), draft = calendarOccurrenceDraft(occurrence, true);
  const timed = calendarSeriesMovedDraft(draft, source, { day: '2026-03-15', minute: 23 * 60 }, 'Asia/Tokyo');
  assert.equal(timed.value.startDate, source.startDate); assert.equal(timed.value.startMinute, 600); assert.equal(timed.value.endMinute, 660);
  assert.deepEqual(timed.value.customRecurrence, source.customRecurrence);
  const wire = googleEventBody(timed.value), roundtrip = googleImportedEvent({ id: 'roundtrip', ...wire }, 'personal');
  assert.deepEqual(roundtrip.customRecurrence, source.customRecurrence); assert.equal(roundtrip.untilDate, source.untilDate);
  assert.match(wire.recurrence[0], /INTERVAL=2;BYDAY=SU,WE;WKST=SU/u);
  const shifted = calendarSeriesMovedDraft(draft, source, { day: '2026-03-22', minute: 22 * 60 }, 'Asia/Tokyo');
  assert.equal(shifted.value.startDate, '2026-03-08'); assert.deepEqual(shifted.value.customRecurrence, source.customRecurrence);
  assert.throws(() => calendarSeriesMovedDraft(draft, source, { day: '2026-03-08', minute: 150 }, 'America/New_York'), /夏時間/u);
  assert.throws(() => calendarSeriesMovedDraft(draft, source, { day: '2026-11-01', minute: 90 }, 'America/New_York'), /夏時間/u);
});

const find = (ui, id) => { const node = ui.nodes().find(row => row.props.testID === id); assert.ok(node, id); return node; };
async function dragEarlierDay(ui, mode, date) {
  if (mode === 'month') { await scrollCalendarToDate(ui, date); ui.button(`会議、${date}の予定`).props.onAccessibilityAction({ nativeEvent: { actionName: 'movePreviousDay' } }); await ui.flush(); return; }
  await selectCalendarView(ui, mode);
  if (mode === '7日表示') { find(ui, 'calendar-week').props.onLayout({ nativeEvent: { layout: { width: 350 } } }); await ui.flush(); }
  let card = find(ui, `calendar-movable-series:${date}`);
  card.children.find(row => row?.props?.accessibilityRole === 'button').props.onLongPress(); await ui.flush();
  card = find(ui, `calendar-movable-series:${date}`); card.props.onPanResponderGrant();
  card.props.onPanResponderRelease(null, { dx: mode === '7日表示' ? -150 : -200, dy: 0, numberActiveTouches: 1 }); await ui.flush();
}

for (const platform of ['ios', 'android']) {
  test(`${platform} month two three and seven day drags reject unrepresentable whole and future moves before any save and keep single occurrence available`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const mode of ['month', '2日表示', '3日表示', '7日表示']) for (const scope of ['繰り返し全体', '今後の予定すべて']) {
      const source = original(), writes = [], snapshot = { events: [source], exceptions: [], categories: [], drafts: [] }, before = structuredClone(snapshot);
      const local = { database: {}, snapshot, loading: false, error: null, shared: { groupId: 'group', name: '家族', enabled: true },
        prepareDraft: draft => ({ ...draft, audience: 'group', groupId: 'group', basisRevision: 'captured-proof' }), refresh: async () => {}, saveEvent: async draft => writes.push(draft) };
      const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(), props: {
        today: '2026-11-17', selectedDate: '2026-11-17', timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      } });
      try {
        await dragEarlierDay(ui, mode, '2026-11-18');
        const unavailable = ui.button(scope);
        assert.equal(unavailable.props.disabled, true); assert.equal(unavailable.props.accessibilityState.disabled, true);
        assert.match(ui.text(), /この日付に移動できる範囲/u); assert.equal(writes.length, 0);
        assert.deepEqual(snapshot, before); assert.equal(ui.nodes().some(row => row.props.accessibilityLabel === '移動を元に戻す'), false);
        await ui.press('キャンセル');
        assert.equal(find(ui, mode === 'month' ? 'calendar-weeks' : mode === '7日表示' ? 'calendar-week-time-scroll' : 'calendar-timeline').props.scrollEnabled, true);
        await dragEarlierDay(ui, mode, '2026-11-18'); await ui.press('この予定だけ');
        assert.equal(writes.length, 1); assert.equal(writes[0].scope, 'one'); assert.equal(writes[0].anchorDate, '2026-11-18');
        assert.equal(writes[0].value.startDate, mode === '7日表示' ? '2026-11-15' : '2026-11-17');
        assert.equal(writes[0].basisRevision, 'captured-proof'); assert.equal(writes[0].audience, 'group'); assert.deepEqual(snapshot, before);
      } finally { ui.unmount(); }
    }
  });

  test(`${platform} safe one day clock moves and Undo retain a multiweek series individual edits deletions and the original Google body`, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const value = original(), id = await storage.saveCalendarEvent(h.database, { expectedRevision: 0, value });
    await storage.saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-04', expectedExceptionRevision: 0,
      value: { ...value, title: '保持する個別変更', startDate: '2026-11-05', endDate: '2026-11-05', recurrence: 'none', customRecurrence: undefined, untilDate: null } });
    await storage.deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate: '2026-11-15', expectedExceptionRevision: 0 });
    const local = { database: h.database, snapshot: await storage.readLocalCalendar(h.database), loading: false, error: null,
      refresh: async () => { local.snapshot = await storage.readLocalCalendar(h.database); } };
    const plain = snapshot => projectCalendarEvents(snapshot.events, snapshot.exceptions, '2026-11-01', '2026-12-01').map(row => ({ title: row.title, date: row.startDate, minute: row.startMinute }));
    const before = plain(local.snapshot), exceptionBodies = local.snapshot.exceptions.map(row => ({ anchorDate: row.anchorDate, override: row.override }));
    const wire = googleEventBody(local.snapshot.events[0]);
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(), props: {
      today: '2026-11-18', selectedDate: '2026-11-18', timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
    } }); t.after(() => ui.unmount());
    await selectCalendarView(ui, '1日表示'); ui.button('会議を編集').props.onAccessibilityAction({ nativeEvent: { actionName: 'moveLater' } }); await ui.flush();
    await ui.press('繰り返し全体'); for (let i = 0; i < 12; i++) await ui.flush();
    assert.equal(local.snapshot.events[0].startMinute, 545); assert.deepEqual(local.snapshot.events[0].customRecurrence, value.customRecurrence);
    assert.deepEqual(local.snapshot.exceptions.map(row => ({ anchorDate: row.anchorDate, override: row.override })), exceptionBodies);
    await ui.press('移動を元に戻す'); for (let i = 0; i < 12; i++) await ui.flush();
    assert.deepEqual(plain(local.snapshot), before); assert.deepEqual(googleEventBody(local.snapshot.events[0]), wire);
    assert.deepEqual(local.snapshot.exceptions.map(row => ({ anchorDate: row.anchorDate, override: row.override })), exceptionBodies);
    assert.equal(ui.nodes().some(row => row.props.accessibilityLabel === '移動を元に戻す'), false);
  });
}
