import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDisplayColor, calendarEventAppearance, calendarColorContrast } from '../src/features/calendar/event-appearance.ts';
import { plannerLightColors, plannerDarkColors } from '../src/components/planner-theme.ts';
import { calendarMonthContentHeight, calendarMonthEventSlots, calendarMonthUsedHeight, MONTH_MAX_EVENT_ROWS } from '../src/features/calendar/month-density.ts';
import { calendarMonthRows, MONTH_HEADING_HEIGHT } from '../src/features/calendar/month-rows.ts';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { calendarSearchDestination, calendarSearchIndex, calendarSearchSelection, searchCalendarIndex } from '../src/features/calendar/search.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const store = await import('../src/platform/storage/calendar-events.ts');
const date = '2026-11-12';
const event = (id, patch = {}) => ({ ...newEventDraft(date, 'Asia/Tokyo'), title: id, id, revision: 1, ...patch });
const draft = (patch = {}) => ({ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(date, 'Asia/Tokyo'), ...patch });
const flush = async ui => { for (let i = 0; i < 16; i++) await ui.flush(); };
async function fixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const local = { database: h.database, snapshot: await store.readLocalCalendar(h.database), loading: false, error: null,
    refresh: async () => { local.snapshot = await store.readLocalCalendar(h.database); } };
  return { ...h, local };
}

test('calendar classification adapts white and black for visibility without changing source colors', () => {
  const source = ['#FFFFFF', '#000000', '#FFFF00', '#348DC2', '#fffeff', '#010101']; const before = JSON.stringify(source);
  assert.equal(calendarDisplayColor('#FFFFFF', false), plannerLightColors.muted);
  assert.equal(calendarDisplayColor('#000000', true), plannerDarkColors.ink);
  for (const dark of [false, true]) for (const color of source) {
    const appearance = calendarEventAppearance(color, dark);
    assert.ok(calendarColorContrast(appearance.foregroundColor, appearance.backgroundColor) >= 4.5, `${color} in ${dark ? 'dark' : 'light'}`);
    assert.notEqual(appearance.backgroundColor, dark ? plannerDarkColors.surface : plannerLightColors.surface);
  }
  assert.equal(JSON.stringify(source), before);
});
test('uniform month weeks retain appointment space alongside chores waste and holidays without changing scroll geometry for content', () => {
  const needed = calendarMonthContentHeight(96);
  assert.ok(calendarMonthEventSlots(needed, true, true) >= 3);
  assert.equal(calendarMonthEventSlots(needed, true, false), MONTH_MAX_EVENT_ROWS);
  for (const summary of [false, true]) for (const waste of [false, true]) {
    const slots = calendarMonthEventSlots(needed, summary, waste);
    assert.ok(calendarMonthUsedHeight(slots, summary, waste) <= needed, 'appointments and chores must fit inside their day cell');
    if (slots < MONTH_MAX_EVENT_ROWS) assert.ok(calendarMonthUsedHeight(slots + 1, summary, waste) > needed);
  }
  const rows = calendarMonthRows(['2026-11-22', '2026-11-29', '2026-12-06'], needed);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.height - (row.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT), needed);
    assert.equal(row.offset, index ? rows[index - 1].offset + rows[index - 1].height : 0);
  }
});
test('calendar search covers saved names places notes and edited occurrences without expanding unlimited series', () => {
  const events = [event('weekly', { title: 'カレンダー面談', location: 'QA room', notes: '資料を持参', recurrence: 'weekly', startDate: '2010-11-11', endDate: '2010-11-11' }), event('old', { title: '過去の予定', startDate: '2000-01-01', endDate: '2000-01-01' })];
  const exceptions = [{ eventId: 'weekly', anchorDate: date, revision: 3, override: { ...newEventDraft('2026-11-13', 'Asia/Tokyo'), title: '別名の面接', location: '会議室' } },
    { eventId: 'missing', anchorDate: date, revision: 1, override: event('別アカウント') }, { eventId: 'weekly', anchorDate: '2026-11-19', revision: 1, override: null }];
  const before = JSON.stringify([events, exceptions]); const index = calendarSearchIndex(events, exceptions);
  assert.equal(index.length, 3); assert.equal(searchCalendarIndex(index, 'かれんだー ＱＡ').matches[0].draft.eventId, 'weekly');
  assert.equal(searchCalendarIndex(index, '資料').matches[0].draft.scope, 'series');
  const moved = searchCalendarIndex(index, '別名').matches[0].draft;
  assert.equal(moved.anchorDate, date); assert.equal(moved.exceptionRevision, 3); assert.equal(moved.value.startDate, '2026-11-13');
  assert.equal(searchCalendarIndex(index, '過去').matches[0].draft.value.startDate, '2000-01-01');
  assert.equal(searchCalendarIndex(index, '別アカウント').matches.length, 0); assert.equal(searchCalendarIndex(index, '').matches.length, 0);
  assert.equal(JSON.stringify([events, exceptions]), before);
});
test('selecting a recurring search result resolves a real nearby round including ended and sparse leap day series', () => {
  const weekly = event('weekly', { recurrence: 'weekly', startDate: '2010-11-11', endDate: '2010-11-11' });
  const input = calendarSearchIndex([weekly], [])[0].draft;
  const selected = calendarSearchSelection(input, [weekly], [{ eventId: weekly.id, anchorDate: date, revision: 2, override: null }], date);
  assert.equal(selected.scope, 'one'); assert.equal(selected.anchorDate, '2026-11-19'); assert.equal(selected.value.startDate, '2026-11-19'); assert.equal(selected.value.recurrence, 'none');
  const ended = { ...weekly, untilDate: '2026-10-01' }; const prior = calendarSearchSelection(input, [ended], [], date);
  assert.equal(prior.anchorDate, '2026-10-01');
  const leap = event('leap', { allDay: true, recurrence: 'yearly', startDate: '2024-02-29', endDate: '2024-02-29' });
  assert.equal(calendarSearchSelection(calendarSearchIndex([leap], [])[0].draft, [leap], [], date).anchorDate, '2028-02-29');
  const many = calendarSearchIndex(Array.from({ length: 1000 }, (_, i) => event(`result-${i}`)), []);
  assert.equal(searchCalendarIndex(many, 'result', 60).matches.length, 60); assert.equal(searchCalendarIndex(many, 'result', 60).more, true);
});
test('search destinations follow the displayed time zone and actual recurring exceptions without changing records', () => {
  const overseas = event('late interview', { timeZone: 'America/New_York', startMinute: 23 * 60 + 30, endDate: '2026-11-13', endMinute: 30 });
  const [entry] = calendarSearchIndex([overseas], []);
  const before = JSON.stringify(overseas);
  assert.deepEqual(calendarSearchDestination(entry.draft, [overseas], [], date, 'Asia/Tokyo'), { date: '2026-11-13', minute: 13 * 60 + 30 });
  assert.equal(JSON.stringify(overseas), before);
  const allDay = { ...overseas, allDay: true, startDate: date, endDate: date };
  assert.deepEqual(calendarSearchDestination({ ...entry.draft, value: allDay }, [allDay], [], date, 'Asia/Tokyo'), { date, minute: null });
  const weekly = event('weekly', { recurrence: 'weekly' });
  const exceptions = [{ eventId: weekly.id, anchorDate: date, revision: 1, override: null },
    { eventId: weekly.id, anchorDate: '2026-11-19', revision: 2, override: { ...newEventDraft('2026-11-20', 'Asia/Tokyo'), title: '変更後の面談' } }];
  const rows = calendarSearchIndex([weekly], exceptions);
  for (const row of rows) assert.deepEqual(calendarSearchDestination(row.draft, [weekly], exceptions, date, 'Asia/Tokyo'), { date: '2026-11-20', minute: 9 * 60 });
});
for (const platform of ['ios', 'android']) {
  test(`${platform} calendar editor keeps a different event time zone explicit and saves its original clock`, async t => {
    const h = await fixture(t); const value = { ...newEventDraft(date, 'America/New_York'), title: '海外との面談', startMinute: 9 * 60, endMinute: 10 * 60 };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      props: { initial: draft({ value }), displayTimeZone: 'Asia/Tokyo', local: h.local, onClose() {}, onSaved() {} } });
    t.after(() => ui.unmount());
    assert.ok(ui.text().includes('America/New_York'));
    await ui.press('予定を保存'); await flush(ui);
    const saved = (await store.readLocalCalendar(h.database)).events[0];
    assert.equal(saved.timeZone, value.timeZone); assert.equal(saved.startMinute, value.startMinute); assert.equal(saved.endMinute, value.endMinute);
  });
  test(`${platform} detailed calendars render date-specific waste once and preserve unknown or conflicting status`, async t => {
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
      props: { today: date, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
        renderWaste: day => `収集表示:${day}:表示設定が重なっています。`, wasteLoaded: () => false } });
    t.after(() => ui.unmount());
    for (const mode of ['1日表示', '2日表示', 'リスト表示']) {
      await selectCalendarView(ui, mode);
      assert.equal(ui.text().split(`収集表示:${date}:`).length - 1, 1);
      assert.ok(ui.text().includes('表示設定が重なっています。'));
    }
  });
  test(`${platform} date selection keeps both days accessible across a week boundary and distinguishes today from the selected range`, async t => {
    const selected = [];
    const ui = screenHarness('src/features/calendar/calendar-date-strip.tsx', { exportName: 'CalendarDateStrip', platform,
      props: { date: '2026-11-14', today: '2026-11-12', days: 2, onSelect: day => selected.push(day) } });
    t.after(() => ui.unmount());
    const choices = ui.nodes().filter(node => node.props.accessibilityRole === 'button');
    assert.deepEqual(choices.filter(node => node.props.accessibilityState.selected).map(node => node.props.accessibilityLabel), ['2026年11月14日（土）を表示', '2026年11月15日（日）を表示']);
    assert.equal(ui.button('2026年11月14日（土）を表示').props.accessibilityValue.text, '選択日');
    assert.equal(ui.button('2026年11月15日（日）を表示').props.accessibilityValue.text, '表示中の2日目');
    assert.equal(ui.button('2026年11月12日（木）を表示').props.accessibilityState.selected, false);
    assert.equal(ui.button('2026年11月12日（木）を表示').props.accessibilityValue.text, '今日');
    await ui.press('2026年11月15日（日）を表示'); assert.deepEqual(selected, ['2026-11-15']);
    for (const day of ['2026-11-11', '2026-11-12']) {
      const overlap = screenHarness('src/features/calendar/calendar-date-strip.tsx', { exportName: 'CalendarDateStrip', platform,
        props: { date: day, today: '2026-11-12', days: 2, onSelect() {} } });
      try {
        const current = overlap.button('2026年11月12日（木）を表示');
        assert.equal(current.props.accessibilityState.selected, true);
        assert.equal(current.props.accessibilityValue.text, day === '2026-11-12' ? '今日、選択日' : '今日、表示中の2日目');
      } finally { overlap.unmount(); }
    }
  });
  test(`${platform} calendar action controls preserve the selected date and empty chores do not offer a dead expansion`, async t => {
    const h = await fixture(t); const reads = new Set();
    const props = { today: date, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: day => { reads.add(day); return { loaded: true, total: 0 }; }, renderChores: () => null };
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props });
    t.after(() => ui.unmount());
    const list = ui.nodes().find(node => node.props.testID === 'calendar-weeks'); const positions = list.props.data.map(row => [row.id, row.height, row.offset]);
    // A refreshed event snapshot must not resize all native row offsets or pre-read every distant day.
    reads.clear(); h.local.snapshot = { ...h.local.snapshot, events: [event('late-result')] }; ui.render(); await flush(ui);
    assert.deepEqual(ui.nodes().find(node => node.props.testID === 'calendar-weeks').props.data.map(row => [row.id, row.height, row.offset]), positions);
    const visibleDays = new Set(list.props.data.slice(list.props.initialScrollIndex, list.props.initialScrollIndex + list.props.initialNumToRender).flatMap(row => row.days).filter(Boolean));
    assert.ok([...reads].every(day => visibleDays.has(day)), 'native geometry must not read distant chore days outside rendered rows');
    await selectCalendarView(ui, '2日表示'); assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '2026年11月12日の家事を開く'), false);
    await ui.press('予定を追加'); assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '開始日を選択').props.accessibilityValue.text, '2026/11/12');
  });
  test(`${platform} multiline notes preserve the latest text across layout and the actual calendar save`, async t => {
    const h = await fixture(t); let saved = 0;
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      layoutEffect: callback => callback(), props: { initial: draft(), local: h.local, onClose() {}, onSaved() { saved++; } } });
    t.after(() => ui.unmount()); await ui.change('予定名', 'メモの入力');
    const notes = ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '予定のメモ');
    notes.props.onChangeText('1行目\n2行目\n最後の入力'); ui.render();
    await ui.press('予定を保存'); await flush(ui);
    assert.equal(saved, 1); assert.equal((await store.readLocalCalendar(h.database)).events[0].notes, '1行目\n2行目\n最後の入力');
  });
  test(`${platform} closing an appointment offers explicit draft or discard without saving a fake event`, async t => {
    const h = await fixture(t); let closed = 0;
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial: draft(), local: h.local, onClose: () => closed++, onSaved() {} } });
    t.after(() => ui.unmount()); const close = ui.button('予定の編集を閉じる');
    ui.nodes().find(node => node.props.accessibilityLabel === '予定名').props.onChangeText('入力途中'); close.props.onPress(); await flush(ui);
    assert.equal(closed, 0); assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0);
    assert.ok(ui.button('入力を破棄')); assert.ok(ui.button('下書き保存'));
    ui.nodes().find(node => node.type === 'Modal').props.onRequestClose(); await ui.flush(); assert.ok(ui.button('下書き保存'));
    const save = ui.button('下書き保存'); save.props.onPress(); save.props.onPress(); await flush(ui);
    const saved = await store.readLocalCalendar(h.database); assert.equal(closed, 1); assert.equal(saved.drafts.length, 1); assert.equal(saved.draft.value.title, '入力途中'); assert.equal(saved.events.length, 0);
    const resumed = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial: saved.draft, local: { ...h.local, snapshot: saved }, onClose: () => closed++, onSaved() {} } });
    t.after(() => resumed.unmount()); await resumed.press('予定の編集を閉じる'); await resumed.press('入力を破棄'); await flush(resumed);
    assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0); assert.equal(closed, 2);
  });
  test(`${platform} blank appointment exits leave no draft and concurrent newer input cannot be discarded`, async t => {
    const h = await fixture(t); let closed = 0; const empty = draft(); await store.saveCalendarDraft(h.database, empty); await h.local.refresh();
    const blank = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial: empty, local: h.local, onClose: () => closed++, onSaved() {} } });
    t.after(() => blank.unmount()); await blank.press('予定の編集を閉じる'); await flush(blank);
    assert.equal(closed, 1); assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0);
    const initial = draft({ value: { ...empty.value, title: '元の入力' } }); await store.saveCalendarDraft(h.database, initial); await h.local.refresh();
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial, local: h.local, onClose: () => closed++, onSaved() {} } });
    t.after(() => ui.unmount()); await store.saveCalendarDraft(h.database, { ...initial, value: { ...initial.value, title: '別画面の新しい入力' } });
    await ui.press('予定の編集を閉じる'); await ui.press('入力を破棄'); await flush(ui);
    assert.equal(closed, 1); assert.equal((await store.readLocalCalendar(h.database)).draft.value.title, '別画面の新しい入力'); assert.ok(ui.text().includes('別の画面'));
  });
  test(`${platform} calendar search displays the saved event date without editing and draft list exposes nonlatest edits`, async t => {
    const targetDate = '2027-03-04'; const selected = [];
    const h = await fixture(t); await store.saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(targetDate, 'Asia/Tokyo'), title: '歯科', location: 'QA room' } });
    await h.local.refresh(); const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: { today: date, timeZone: 'Asia/Tokyo', local: h.local, onSelectDate: day => selected.push(day), dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
    t.after(() => ui.unmount()); await ui.press('予定を検索する'); await ui.change('予定を検索', 'ＱＡ'); await ui.press('歯科の検索結果を開く');
    if (platform === 'ios') {
      assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '予定名'), false, 'the search sheet never presents an editor');
      const sheet = ui.nodes().find(node => node.type === 'Modal'); sheet.props.onDismiss(); sheet.props.onDismiss(); await ui.flush();
    }
    assert.deepEqual(selected, [targetDate]);
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '予定名' || node.props.accessibilityLabel === '予定を保存'), false);
    assert.match(ui.text(), /3月4日/u); assert.ok(ui.text().includes('歯科'));
    assert.equal(ui.button('歯科を編集').props.accessibilityState.selected, true, 'the matching result remains identified after the search sheet closes');
    assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0);
    await ui.press('歯科を編集');
    assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '予定名').props.defaultValue, '歯科');
    await ui.press('予定の編集を閉じる'); await flush(ui);
    const saved = h.local.snapshot.events[0];
    await store.saveCalendarDraft(h.database, draft({ eventId: saved.id, revision: 1, value: { ...saved, title: '歯科の変更途中' } }));
    await store.saveCalendarDraft(h.database, draft({ value: { ...newEventDraft(date, 'Asia/Tokyo'), title: '新しい予定の途中' } })); await h.local.refresh();
    let picked; const drafts = screenHarness('src/features/calendar/calendar-draft-list.tsx', { exportName: 'CalendarDraftList', platform, props: { local: h.local, drafts: h.local.snapshot.drafts, onClose() {}, onSelect: value => { picked = value; } } });
    t.after(() => drafts.unmount()); await drafts.press('歯科の変更途中の下書きを再開'); assert.equal(picked.eventId, saved.id);
    await drafts.press('新しい予定の途中の下書きを破棄'); await flush(drafts);
    assert.deepEqual((await store.readLocalCalendar(h.database)).drafts.map(row => row.value.title), ['歯科の変更途中']);
  });
  test(`${platform} search date navigation preserves each preferred detail view and does not require edit permission`, async t => {
    const h = await fixture(t); const targetDate = '2028-08-17'; let prepareCalls = 0;
    await store.saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(targetDate, 'Asia/Tokyo'), title: '遠い日の予定' } });
    await h.local.refresh(); h.local.prepareDraft = () => { prepareCalls++; throw new Error('閲覧専用です'); };
    for (const detail of ['1日', '2日', 'リスト']) {
      const selected = []; const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
        props: { today: date, timeZone: 'Asia/Tokyo', local: h.local, onSelectDate: day => selected.push(day), dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
      try {
        await selectCalendarView(ui, `${detail}表示`); await ui.press('月表示に戻る');
        if (detail === '2日') await ui.press('年表示に戻る');
        await ui.press('予定を検索する'); await ui.change('予定を検索', '遠い日の'); await ui.press('遠い日の予定の検索結果を開く');
        if (platform === 'ios') { ui.nodes().find(node => node.type === 'Modal').props.onDismiss(); await ui.flush(); }
        assert.equal(ui.button('カレンダーの表示を選択').props.accessibilityValue.text, detail);
        assert.deepEqual(selected, [targetDate]); assert.match(ui.text(), /8月17日/u); assert.ok(ui.text().includes('遠い日の予定'));
        assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '予定を保存'), false);
      } finally { ui.unmount(); }
    }
    assert.equal(prepareCalls, 0); const saved = await store.readLocalCalendar(h.database);
    assert.equal(saved.events.length, 1); assert.equal(saved.events[0].revision, 1); assert.equal(saved.drafts.length, 0);
  });
  test(`${platform} leaving calendar search restores its overview on return without altering events or drafts`, async t => {
    const h = await fixture(t); const blurs = new Map();
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, focusEffect: callback => {
      const cleanup = callback(); if (typeof cleanup === 'function') blurs.set(callback, cleanup);
    },
      props: { today: date, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
    t.after(() => ui.unmount()); await ui.press('予定を検索する'); await ui.change('予定を検索', '入力した検索語');
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '予定を検索' && node.type === 'TextInput'), true);
    assert.ok(blurs.size > 0); for (const blur of blurs.values()) blur(); await flush(ui);
    assert.equal(ui.nodes().some(node => node.props.testID === 'calendar-search-results'), false);
    assert.equal(ui.nodes().some(node => node.props.testID === 'calendar-weeks'), true);
    assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0); assert.equal((await store.readLocalCalendar(h.database)).events.length, 0);
    await ui.press('予定を検索する'); await ui.change('予定を検索', '保存しない検索語'); await ui.press('予定の検索を閉じる');
    if (platform === 'ios') { const sheet = ui.nodes().find(node => node.type === 'Modal'); assert.equal(sheet.props.visible, false); sheet.props.onDismiss(); }
    await ui.flush(); assert.equal(ui.nodes().some(node => node.props.testID === 'calendar-search-results'), false);
    await ui.press('予定を検索する'); const sheet = ui.nodes().find(node => node.type === 'Modal'); sheet.props.onRequestClose();
    if (platform === 'ios') sheet.props.onDismiss();
    await ui.flush(); assert.equal(ui.nodes().some(node => node.props.testID === 'calendar-search-results'), false);
    assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0); assert.equal((await store.readLocalCalendar(h.database)).events.length, 0);
  });
  test(`${platform} searching the displayed day recenters the chosen event without requiring a new layout`, async t => {
    const h = await fixture(t); const targetDate = '2026-11-14';
    for (const [title, minute] of [['朝の予定', 9 * 60], ['夜の予定', 18 * 60]]) await store.saveCalendarEvent(h.database,
      { expectedRevision: 0, value: { ...newEventDraft(targetDate, 'Asia/Tokyo'), title, startMinute: minute, endMinute: minute + 60 } });
    await h.local.refresh();
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: effect => effect(),
      props: { today: date, selectedDate: targetDate, timeZone: 'Asia/Tokyo', local: h.local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null } });
    t.after(() => ui.unmount()); await selectCalendarView(ui, '1日表示');
    const offsets = []; const timeline = ui.nodes().find(node => node.props.testID === 'calendar-timeline');
    timeline.props.ref.current = { scrollToOffset: value => offsets.push(value.offset) };
    timeline.props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    ui.nodes().find(node => node.props.testID === 'calendar-timeline-days').props.onLayout({ nativeEvent: { layout: { height: 100 } } });
    await new Promise(resolve => setTimeout(resolve, 5)); const first = offsets.at(-1); assert.equal(typeof first, 'number');
    const findNight = async () => { await ui.press('予定を検索する'); await ui.change('予定を検索', '夜の'); await ui.press('夜の予定の検索結果を開く');
      if (platform === 'ios') { ui.nodes().find(node => node.type === 'Modal').props.onDismiss(); await ui.flush(); }
      await new Promise(resolve => setTimeout(resolve, 5)); };
    await findNight(); assert.ok(offsets.at(-1) > first, 'a same-date result must scroll to the later chosen event');
    await selectCalendarView(ui, 'リスト表示'); const resets = [];
    ui.nodes().find(node => node.props.testID === 'calendar-agenda').props.ref.current = { scrollToOffset: value => resets.push(value.offset) };
    await findNight(); assert.deepEqual(resets, [0], 'same-date search returns the agenda to that date');
    assert.equal((await store.readLocalCalendar(h.database)).drafts.length, 0);
  });
}
