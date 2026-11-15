import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarTitleDisplayStore, CALENDAR_TITLE_SHORTENING_KEY } from '../src/features/calendar/title-display-store.ts';
import { createCalendarTitleDisplay, calendarDisplayedTitle } from '../src/features/calendar/title-display.ts';
import { calendarSearchIndex, searchCalendarIndex } from '../src/features/calendar/search.ts';
import { newEventDraft, recurrenceLabel } from '../src/features/calendar/events.ts';
import { calendarTitleLabel, createTitleDateTimeInput } from '../src/features/calendar/title-datetime.ts';
import { addDays, daysBetween } from '../src/domain/scheduling/local-date.ts';
import { projectPrivateCalendarEvents } from '../src/features/calendar/private-event-projection.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { scrollCalendarToDate, selectCalendarView } from './helpers/calendar-ui.mjs';

const day = '2026-11-17';
const originalTitle = '毎週火曜日18時から友達と食事';
const displayedTitle = '友達と食事';
const event = (extra = {}) => ({ ...newEventDraft(day, 'Asia/Tokyo'), title: originalTitle, id: 'appointment', revision: 2, startMinute: 1080, endMinute: 1140, ...extra });
function memory(initial) {
  const data = new Map(initial === undefined ? [] : [[CALENDAR_TITLE_SHORTENING_KEY, initial]]), writes = [];
  return { data, writes, fail: false, getItemSync: key => data.get(key) ?? null, setItemSync(key, value) { if (this.fail) throw new Error('unavailable'); data.set(key, value); writes.push([key, value]); } };
}
const storageMock = storage => ({ __esModule: true, default: storage });
const checkbox = ui => {
  const row = ui.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '予定名の日時表現を省略');
  assert.ok(row, 'the existing view menu must expose the title preference'); return row;
};
const toggleTitle = async ui => { checkbox(ui).props.onPress(); await ui.flush(); };

test('calendar title shortening defaults on persists once and retains its accepted value after failed or invalid changes', () => {
  const storage = memory(), store = createCalendarTitleDisplayStore(storage); let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  assert.equal(store.getSnapshot(), true); store.select(true); assert.equal(storage.writes.length, 0);
  store.select(false); store.select(false); assert.equal(store.getSnapshot(), false); assert.equal(notifications, 1);
  assert.deepEqual(storage.writes, [[CALENDAR_TITLE_SHORTENING_KEY, 'false']]);
  assert.equal(createCalendarTitleDisplayStore(storage).getSnapshot(), false);
  storage.fail = true; assert.throws(() => store.select(true)); assert.equal(store.getSnapshot(), false); assert.equal(notifications, 1);
  assert.throws(() => store.select('true')); assert.equal(store.getSnapshot(), false);
  storage.fail = false; unsubscribe(); store.select(true); assert.equal(notifications, 1);
  assert.equal(createCalendarTitleDisplayStore(storage).getSnapshot(), true);
  assert.equal(createCalendarTitleDisplayStore(memory('invalid')).getSnapshot(), true);
  assert.equal(createCalendarTitleDisplayStore({ getItemSync() { throw new Error('unavailable'); }, setItemSync() {} }).getSnapshot(), true);
});

test('calendar display projection reuses repeated title parsing without rewriting source titles timezone originals or unchanged rows', () => {
  let parses = 0; const display = createCalendarTitleDisplay((title, _reference, shorten) => { parses++; return shorten ? title.replace('毎週火曜日18時から', '') : title; });
  const base = projectPrivateCalendarEvents([event(), event({ id: 'plain', title: '学校' })], [], day, day);
  const original = { ...base[0], timeZone: 'UTC' }; base[0].original = original;
  const repeated = Array.from({ length: 100 }, (_, n) => ({ ...base[0], id: `round-${n}` }));
  const before = structuredClone(repeated), projected = display.occurrences(repeated, day);
  assert.equal(parses, 1); assert.equal(projected[0].title, originalTitle); assert.equal(calendarDisplayedTitle(projected[0]), displayedTitle);
  assert.equal(projected[0].original, original); assert.deepEqual(repeated, before);
  assert.equal(display.occurrences(projected, day), projected); assert.equal(parses, 1);
  const restored = display.occurrences(projected, day, false); assert.equal(calendarDisplayedTitle(restored[0]), originalTitle); assert.equal('displayTitle' in restored[0], false);
  const plain = [base[1]]; assert.equal(display.occurrences(plain, day), plain); assert.equal(display.occurrences(base, day, false), base);
});

test('calendar search indexes original and shortened titles while retaining original series and exception drafts', () => {
  const series = event({ recurrence: 'weekly' }); const override = { ...newEventDraft(day, 'Asia/Tokyo'), title: '旅行 4月11日から1週間', allDay: true };
  const index = calendarSearchIndex([series], [{ eventId: series.id, anchorDate: day, revision: 3, override }], day);
  for (const query of [displayedTitle, originalTitle, '毎週火曜日']) assert.equal(searchCalendarIndex(index, query).matches[0].draft.value, series);
  assert.equal(searchCalendarIndex(index, '旅行').matches[0].draft.value, override);
  assert.equal(searchCalendarIndex(index, '4月11日').matches[0].draft.value, override);
  assert.equal(series.title, originalTitle); assert.equal(override.title, '旅行 4月11日から1週間');
});

for (const platform of ['ios', 'android']) {
  const make = (local, storage, extra = {}) => screenHarness('src/features/calendar/planner-calendar.tsx', {
    exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(), mocks: { 'expo-sqlite/kv-store': storageMock(storage) },
    ...extra, props: { today: day, selectedDate: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null, ...extra.props },
  });
  const binding = (extra = {}) => ({ database: {}, loading: false, error: null, snapshot: { events: [event()], exceptions: [], categories: [], drafts: [] }, refresh: async () => {}, ...extra });

  test(`${platform} calendar title preference updates month day two three week and list labels without calendar writes or sync requests`, async t => {
    const storage = memory(); let writes = 0, requests = 0;
    const local = binding({ snapshot: { events: [event(), event({ id: 'all-day', title: '旅行 4月11日から1週間', allDay: true })], exceptions: [], categories: [], drafts: [] },
      saveEvent: async () => writes++, requestRange: () => requests++ });
    const before = structuredClone(local.snapshot), ui = make(local, storage); t.after(() => ui.unmount());
    await scrollCalendarToDate(ui, day); ui.button(`${displayedTitle}、${day}の予定`); assert.doesNotMatch(ui.text(), /毎週火曜日/u);
    for (const view of ['1日表示', '2日表示', '3日表示', '7日表示', 'リスト表示']) {
      await selectCalendarView(ui, view); ui.button(`${displayedTitle}を編集`); assert.match(ui.text(), /旅行/u); assert.doesNotMatch(ui.text(), /毎週火曜日|4月11日から1週間|元の地域/u);
    }
    await ui.press('カレンダーの表示を選択'); await toggleTitle(ui); assert.equal(checkbox(ui).props.accessibilityState.checked, false);
    await ui.press('表示の選択を閉じる'); ui.button(`${originalTitle}を編集`);
    for (const view of ['1日表示', '2日表示', '3日表示', '7日表示']) { await selectCalendarView(ui, view); ui.button(`${originalTitle}を編集`); }
    await ui.press('月表示に戻る'); await scrollCalendarToDate(ui, day); ui.button(`${originalTitle}、${day}の予定`);
    assert.equal(writes, 0); assert.equal(requests, 0); assert.deepEqual(local.snapshot, before); assert.equal(createCalendarTitleDisplayStore(storage).getSnapshot(), false);
  });

  test(`${platform} failed title preference saves keep the accepted checkbox and the menu usable`, async t => {
    const storage = memory(), ui = make(binding(), storage); t.after(() => ui.unmount()); await ui.press('カレンダーの表示を選択');
    storage.fail = true; await toggleTitle(ui); assert.equal(checkbox(ui).props.accessibilityState.checked, true); assert.match(ui.text(), /表示設定を保存できませんでした/u);
    storage.fail = false; await toggleTitle(ui); assert.equal(checkbox(ui).props.accessibilityState.checked, false); assert.doesNotMatch(ui.text(), /表示設定を保存できませんでした/u);
  });

  test(`${platform} editing duplicating and dragging shortened titles preserve the full saved sentence`, async t => {
    for (const audience of ['personal', 'group']) {
      const writes = [], storage = memory(), local = binding({ saveEvent: async draft => { writes.push(draft); },
        ...(audience === 'group' ? { shared: { groupId: 'group', name: '家族', enabled: true }, prepareDraft: draft => ({ ...draft, audience, groupId: 'group' }) } : {}) });
      const ui = make(local, storage); t.after(() => ui.unmount());
      try {
        await selectCalendarView(ui, '1日表示'); await ui.press(`${displayedTitle}を編集`);
        assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '予定名').props.defaultValue, originalTitle);
        await ui.press('予定を複製'); assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '予定名').props.defaultValue, originalTitle);
        await ui.press('予定を保存'); assert.equal(writes.length, 1); assert.equal(writes[0].eventId, null); assert.equal(writes[0].value.title, originalTitle); assert.equal('displayTitle' in writes[0].value, false);
        const button = ui.button(`${displayedTitle}を編集`); button.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveLater' } }); await ui.flush();
        assert.equal(writes.length, 2); assert.equal(writes[1].value.title, originalTitle); assert.equal(writes[1].value.startMinute, 1085); assert.equal('displayTitle' in writes[1].value, false);
        if (audience === 'group') for (const draft of writes) { assert.equal(draft.audience, 'group'); assert.equal(draft.groupId, 'group'); }
        assert.equal(local.snapshot.events[0].title, originalTitle);
      } finally { ui.unmount(); }
    }
  });

  test(`${platform} search results display the selected title style and open original drafts for either title query`, async t => {
    for (const initial of [undefined, 'false']) {
      const storage = memory(initial), local = binding(); let selected, originalDraft;
      const ui = screenHarness('src/features/calendar/calendar-search.tsx', { exportName: 'CalendarSearch', platform, mocks: { 'expo-sqlite/kv-store': storageMock(storage) },
        props: { local, focusDate: day, onClose() {}, onSelect: value => { selected = value; }, resolveSelection: draft => { originalDraft = draft; return { date: day, minute: 1080 }; } } });
      try {
        for (const query of [displayedTitle, '毎週火曜日']) {
          await ui.change('予定を検索', query); const label = initial === 'false' ? originalTitle : displayedTitle; ui.button(`${label}の検索結果を開く`);
        }
        const label = initial === 'false' ? originalTitle : displayedTitle; await ui.press(`${label}の検索結果を開く`);
        if (platform === 'ios') { ui.nodes().find(node => node.type === 'Modal').props.onDismiss(); await ui.flush(); }
        assert.equal(originalDraft.value, local.snapshot.events[0]); assert.equal(originalDraft.value.title, originalTitle); assert.deepEqual(selected, { date: day, minute: 1080 });
      } finally { ui.unmount(); }
    }
  });

  test(`${platform} shortened yearly periods and monthly date sets retain manual values through search editing duplication and month drag`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T03:00:00Z') });
    const today = '2026-11-16';
    const inferred = title => { const base = newEventDraft(today, 'Asia/Tokyo'); return createTitleDateTimeInput(base, today).change(base, title, true); };
    const values = [
      inferred('毎年5月22日お父さん誕生日'),
      inferred('彼女の誕生日、毎年8月22日'),
      inferred('旅行 4月11日から1週間'),
      inferred('旅行 4月11日18時から1週間'),
      inferred('明日から約1週間旅行'),
      inferred('毎月11日、12日ハッカソン'),
      { ...inferred('毎年5月22日手動の予定'), startDate: '2027-05-24', endDate: '2027-05-26', startMinute: 615, endMinute: 735,
        allDay: false, recurrence: 'custom', customRecurrence: { unit: 'month', interval: 2, on: 'dates', days: [24, 26] }, untilDate: '2027-12-31' },
    ];
    const fields = ['title', 'startDate', 'endDate', 'startMinute', 'endMinute', 'allDay', 'recurrence', 'untilDate', 'categoryId', 'location', 'notes', 'birthday', 'customRecurrence'];
    const body = value => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    for (const audience of ['personal', 'group']) for (const [index, input] of values.entries()) {
      const source = { ...input, id: `schedule-${index}`, revision: 7, location: '手動で選んだ場所', notes: '手動のメモ' }, before = structuredClone(source), writes = [];
      const storage = memory(), local = binding({ snapshot: { events: [source], exceptions: [], categories: [{ id: 'personal', name: '私用', color: '#3D906A', revision: 1 }], drafts: [] },
        saveEvent: async draft => { writes.push(structuredClone(draft)); },
        ...(audience === 'group' ? { shared: { groupId: 'retained-group', name: '家族', enabled: true }, prepareDraft: draft => ({ ...draft, audience, groupId: 'retained-group' }) } : {}) });
      const label = calendarTitleLabel(source.title, today); assert.notEqual(label, source.title, source.title);
      const ui = make(local, storage, { props: { today, selectedDate: source.startDate } });
      try {
        await scrollCalendarToDate(ui, source.startDate); ui.button(`${label}、${source.startDate}の予定`);
        await ui.press('カレンダーの表示を選択'); await toggleTitle(ui); await ui.press('表示の選択を閉じる');
        ui.button(`${source.title}、${source.startDate}の予定`);
        await ui.press('カレンダーの表示を選択'); await toggleTitle(ui); await ui.press('表示の選択を閉じる');
        await ui.press('予定を検索する'); await ui.change('予定を検索', source.title); ui.button(`${label}の検索結果を開く`);
        await ui.change('予定を検索', label); await ui.press(`${label}の検索結果を開く`);
        if (platform === 'ios') { ui.nodes().find(node => node.type === 'Modal').props.onDismiss(); await ui.flush(); }
        assert.equal(writes.length, 0, 'display and search cannot save the source schedule');
        await ui.press(`${label}を編集`);
        if (source.recurrence !== 'none') { await ui.press('変更する範囲を選択'); await ui.press('繰り返し全体'); }
        assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '予定名').props.defaultValue, source.title);
        assert.equal(ui.button('開始日を選択').props.accessibilityValue.text, source.startDate.replaceAll('-', '/'));
        assert.equal(ui.button('終了日を選択').props.accessibilityValue.text, source.endDate.replaceAll('-', '/'));
        assert.equal(ui.button('繰り返しを選択').props.accessibilityValue.text, recurrenceLabel(source));
        await ui.press('予定を保存'); assert.equal(writes.length, 1); assert.equal(writes[0].scope, 'series'); assert.deepEqual(body(writes[0].value), body(source));
        assert.equal('displayTitle' in writes[0].value, false);
        await ui.press(`${label}を編集`); await ui.press('予定を複製'); await ui.press('予定を保存');
        assert.equal(writes.length, 2); assert.equal(writes[1].eventId, null);
        const duplicate = { ...body(source), recurrence: 'none', untilDate: null }; delete duplicate.customRecurrence;
        assert.deepEqual(body(writes[1].value), duplicate, 'a copy keeps the captured period and original name as one independent occurrence');
        await ui.press('月表示に戻る'); await scrollCalendarToDate(ui, source.startDate);
        ui.button(`${label}、${source.startDate}の予定`).props.onAccessibilityAction({ nativeEvent: { actionName: 'moveNextDay' } }); await ui.flush();
        if (source.recurrence !== 'none') { await ui.press('繰り返し全体'); await ui.flush(); }
        assert.equal(writes.length, 3); const moved = writes[2].value;
        assert.equal(moved.title, source.title); assert.equal(moved.recurrence, source.recurrence); assert.equal(moved.allDay, source.allDay);
        assert.equal(moved.startDate, addDays(source.startDate, 1)); assert.equal(moved.endDate, addDays(source.endDate, 1));
        assert.equal(daysBetween(moved.startDate, moved.endDate), daysBetween(source.startDate, source.endDate));
        assert.equal(moved.startMinute, source.startMinute); assert.equal(moved.endMinute, source.endMinute);
        assert.equal(moved.untilDate, source.untilDate ? addDays(source.untilDate, 1) : null);
        assert.deepEqual(moved.customRecurrence, source.customRecurrence?.on === 'dates' ? { ...source.customRecurrence, days: source.customRecurrence.days.map(day => day + 1) } : source.customRecurrence);
        if (audience === 'group') for (const draft of writes) { assert.equal(draft.audience, 'group'); assert.equal(draft.groupId, 'retained-group'); }
        assert.deepEqual(source, before); assert.equal(Object.hasOwn(moved, 'displayTitle'), false);
      } finally { ui.unmount(); }
    }
  });
}
