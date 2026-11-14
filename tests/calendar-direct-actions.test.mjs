import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDragTarget, calendarMonthDragTarget, calendarMovedDraft, calendarOccurrenceDraft, calendarSlotDraft, duplicateCalendarDraft } from '../src/features/calendar/direct-actions.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { calendarMonthRows, MONTH_HEADING_HEIGHT } from '../src/features/calendar/month-rows.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView, scrollCalendarToDate } from './helpers/calendar-ui.mjs';

const day = '2026-11-14';
const event = (extra = {}) => ({ ...newEventDraft(day, 'Asia/Tokyo'), title: '会議', location: '会議室', notes: '確認内容', id: 'appointment', revision: 4, ...extra });
const occurrence = (extra = {}) => ({ ...event(), id: 'appointment:2026-11-14', eventId: 'appointment', anchorDate: day, eventRevision: 4, exceptionRevision: 2, ...extra });

test('calendar duplication creates an independent single occurrence without source identity or sync proofs', () => {
  const original = { eventId: 'shared-original', anchorDate: day, revision: 4, exceptionRevision: 2, scope: 'one', audience: 'group', groupId: 'group',
    basisRevision: 'old-heads', submission: { id: 'old-intent', digest: 'old-digest' }, editorCategory: { id: 'work', name: '仕事', color: '#8459B3', revision: 2 },
    value: { ...event({ recurrence: 'weekly' }), externalUrl: 'private-link', readOnly: true } };
  const before = structuredClone(original); const copy = duplicateCalendarDraft(original);
  assert.equal(copy.eventId, null); assert.equal(copy.anchorDate, null); assert.equal(copy.revision, 0); assert.equal(copy.exceptionRevision, 0);
  assert.equal(copy.scope, 'series'); assert.equal(copy.audience, 'group'); assert.equal(copy.groupId, 'group');
  assert.equal(copy.value.recurrence, 'none'); assert.equal(copy.value.title, original.value.title); assert.equal(copy.value.location, '会議室'); assert.equal(copy.value.notes, '確認内容');
  for (const key of ['id', 'revision', 'externalUrl', 'readOnly']) assert.ok(!(key in copy.value));
  for (const key of ['basisRevision', 'submission']) assert.ok(!(key in copy));
  copy.editorCategory.name = '別分類'; assert.deepEqual(original, before);
});

test('empty calendar slots use the selected civil day and five-minute time without writing an appointment', () => {
  const draft = calendarSlotDraft(day, 612, 'Asia/Tokyo');
  assert.equal(draft.eventId, null); assert.equal(draft.value.title, ''); assert.equal(draft.value.startDate, day);
  assert.equal(draft.value.startMinute, 610); assert.equal(draft.value.endMinute, 670);
  const late = calendarSlotDraft(day, 1439, 'Asia/Tokyo');
  assert.equal(late.value.startMinute, 1435); assert.equal(late.value.endDate, '2026-11-15'); assert.equal(late.value.endMinute, 55);
});

test('calendar drag targets snap to five minutes and stay in the displayed days and time range', () => {
  const start = { day, minute: 540 }; const days = [day, '2026-11-15'];
  assert.deepEqual(calendarDragTarget(start, days, 100, 60, 100, 32), { day: days[1], minute: 570 });
  assert.deepEqual(calendarDragTarget(start, days, 100, 60, -1000, -1000), { day, minute: 0 });
  assert.deepEqual(calendarDragTarget(start, days, 100, 60, 1000, 1000), { day: days[1], minute: 1435 });
  assert.equal(calendarDragTarget(start, [], 100, 60, 0, 0), null);
  assert.equal(calendarDragTarget(start, days, 0, 60, 0, 0), null);
});

test('calendar moves retain occurrence revisions and real duration while translating display time zones and rejecting DST ambiguity', () => {
  const source = occurrence({ timeZone: 'America/New_York', recurrence: 'weekly' });
  const shown = { ...source, startMinute: 1380, endMinute: 0, endDate: '2026-11-15', timeZone: 'Asia/Tokyo', original: source };
  const draft = { ...calendarOccurrenceDraft(shown, true), audience: 'group', groupId: 'group', basisRevision: 'captured-at-hold' };
  const moved = calendarMovedDraft(draft, { day: '2026-11-15', minute: 30 }, 'Asia/Tokyo');
  assert.equal(moved.value.timeZone, 'America/New_York'); assert.equal(moved.value.startDate, day); assert.equal(moved.value.startMinute, 630); assert.equal(moved.value.endMinute, 690);
  assert.equal(moved.scope, 'one'); assert.equal(moved.anchorDate, day); assert.equal(moved.revision, 4); assert.equal(moved.exceptionRevision, 2); assert.equal(moved.basisRevision, 'captured-at-hold');
  assert.throws(() => calendarMovedDraft(draft, { day: '2026-03-08', minute: 150 }, 'America/New_York'), /夏時間/u);
  assert.throws(() => calendarMovedDraft(draft, { day: '2026-11-01', minute: 90 }, 'America/New_York'), /夏時間/u);
});

test('month drag resolves scrolled partial weeks and rejects headings blank cells and offscreen drops', () => {
  const rows = calendarMonthRows(['2026-11-29', '2026-12-06'], 100);
  const viewport = { x: 20, y: 100, width: 700, height: 400 };
  const source = occurrence({ startDate: '2026-11-28', startMinute: 865 });
  const december = rows.find(row => row.days.includes('2026-12-01'));
  const y = viewport.y + december.offset + MONTH_HEADING_HEIGHT + 20;
  assert.deepEqual(calendarMonthDragTarget(source, '2026-11-30', rows, viewport, 0, 270, y), { day: '2026-11-29', minute: 865 }, 'dragging a continuation shifts the whole event by the same number of days');
  assert.deepEqual(calendarMonthDragTarget(source, '2026-11-30', rows, viewport, 100, 270, y - 100), { day: '2026-11-29', minute: 865 });
  assert.equal(calendarMonthDragTarget(source, day, rows, viewport, 0, 270, viewport.y + 30), null, 'the blank part of November is not December');
  assert.equal(calendarMonthDragTarget(source, day, rows, viewport, 0, 270, viewport.y + december.offset + 10), null, 'the month heading is not a date');
  for (const [x, pointY] of [[19, y], [720, y], [270, 99], [270, 500], [NaN, y]]) assert.equal(calendarMonthDragTarget(source, day, rows, viewport, 0, x, pointY), null);
  assert.equal(calendarMonthDragTarget(source, day, rows, null, 0, 270, y), null);
});

test('month all-day moves retain civil dates span and occurrence scope without inventing clock times', () => {
  const source = occurrence({ allDay: true, timeZone: 'America/New_York', startDate: '2026-10-31', endDate: '2026-11-02', startMinute: 0, endMinute: 0 });
  const draft = calendarOccurrenceDraft(source, true);
  const moved = calendarMovedDraft(draft, { day: '2026-11-01', minute: 0 }, 'Asia/Tokyo');
  assert.equal(moved.value.startDate, '2026-11-01'); assert.equal(moved.value.endDate, '2026-11-03');
  assert.equal(moved.value.allDay, true); assert.equal(moved.value.startMinute, 0); assert.equal(moved.value.endMinute, 0);
  assert.equal(moved.value.timeZone, 'America/New_York'); assert.equal(moved.scope, 'one'); assert.equal(moved.anchorDate, day);
});

for (const platform of ['ios', 'android']) {
  const make = (local, options = {}) => screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, alert: (_title, _message, buttons) => buttons.find(button => button.text === 'この予定のみ')?.onPress(), layoutEffect: effect => effect(), effect: effect => effect(), ...options, props: {
    today: day, selectedDate: day, timeZone: 'Asia/Tokyo', local, dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
  } });
  const binding = (extra = {}) => ({ database: {}, loading: false, error: null,
    snapshot: { events: [event()], exceptions: [], categories: [{ id: 'personal', name: '私用', color: '#3D906A', revision: 1 }], drafts: [] }, refresh: async () => {}, ...extra });
  const monthSetup = async (screen, sourceDay = day) => {
    const viewport = screen.nodes().find(node => node.props.testID === 'calendar-viewport');
    viewport.props.ref.current = { measureInWindow: callback => callback(10, 90, 350, 600) };
    viewport.props.onLayout({ nativeEvent: { layout: { height: 600 } }, currentTarget: 123 });
    await screen.flush(); await scrollCalendarToDate(screen, sourceDay);
    const list = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
    const origin = list.props.data.find(row => row.days.includes(sourceDay)).offset;
    return targetDay => {
      const row = list.props.data.find(row => row.days.includes(targetDay));
      return { dx: 0, dy: 0, numberActiveTouches: 1, moveX: 10 + (row.days.indexOf(targetDay) + .5) * 50,
        moveY: 90 + row.offset - origin + (row.monthStartColumn === null ? 0 : MONTH_HEADING_HEIGHT) + 60 };
    };
  };
  const monthController = screen => screen.nodes().find(node => node.type === 'NativeGestureDetector').props.gesture;
  const moveMonth = (control, point) => control.onUpdate({ handlerTag: 1, absoluteX: point.moveX, absoluteY: point.moveY, numberOfPointers: point.numberActiveTouches ?? 1 });
  const releaseMonth = (control, point) => { control.onDeactivate({ handlerTag: 1, absoluteX: point.moveX, absoluteY: point.moveY, canceled: false }); control.onFinalize(); };
  const holdMonth = async screen => {
    const button = screen.button(`会議、${day}の予定`);
    button.props.ref.current = { measureInWindow: cb => cb(310, 130, 50, 40) };
    button.props.onPressIn({ nativeEvent: { pageX: 335, pageY: 150 }, currentTarget: 456 }); button.props.onLongPress();
    await screen.flush(); const control = monthController(screen);
    control.onActivate({ handlerTag: 1, absoluteX: 335, absoluteY: 150, numberOfPointers: 1 });
    await screen.flush(); return monthController(screen);
  };
  test(`${platform} month edge dragging continues when its source week is virtualized away and commits only on release`, async () => {
    const previousRequest = globalThis.requestAnimationFrame; const previousCancel = globalThis.cancelAnimationFrame;
    let id = 0; let at = 0; let offset = 0; const frames = new Map(); const writes = [];
    globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; }; globalThis.cancelAnimationFrame = key => frames.delete(key);
    const screen = make(binding({ saveEvent: async draft => writes.push(draft) }));
    try {
      await monthSetup(screen); const list = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
      list.props.ref.current = { scrollToOffset: value => { offset = value.offset; const current = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
        current.props.onScroll({ nativeEvent: { contentOffset: { y: offset } } }); screen.render(); } };
      let card = await holdMonth(screen); const point = { moveX: 35, moveY: 685, numberActiveTouches: 1 };
      moveMonth(card, point);
      for (let i = 0; i < 200; i++) { at += 16; const work = [...frames.values()]; frames.clear(); work.forEach(callback => callback(at)); }
      await screen.flush(); assert.ok(offset > list.props.data.find(row => row.days.includes(day)).offset + 600);
      assert.ok(!screen.nodes().some(node => node.props.accessibilityLabel === `会議、${day}の予定`));
      assert.ok(screen.nodes().some(node => node.props.testID === 'calendar-month-drag-preview')); assert.deepEqual(writes, []);
      card = monthController(screen); releaseMonth(card, point); await screen.flush();
      assert.equal(writes.length, 1); assert.ok(writes[0].value.startDate > '2026-12-01'); assert.equal(writes[0].value.startMinute, 540);
      assert.equal(frames.size, 0); assert.ok(!screen.nodes().some(node => node.props.testID === 'calendar-month-drag-preview'));
    } finally { screen.unmount(); globalThis.requestAnimationFrame = previousRequest; globalThis.cancelAnimationFrame = previousCancel; }
  });
  test(`${platform} dragging a repeating event asks its scope and undo restores the series without overwriting a later edit`, async () => {
    let choices; const writes = [];
    const local = binding({ saveEvent: async draft => { writes.push(draft); local.snapshot = { ...local.snapshot,
      events: [{ ...local.snapshot.events[0], ...draft.value, revision: local.snapshot.events[0].revision + 1 }] }; } });
    local.snapshot.events = [event({ recurrence: 'weekly' })];
    const screen = make(local, { alert: (_title, _message, buttons) => { choices = buttons; } });
    try {
      const point = await monthSetup(screen); const card = await holdMonth(screen);
      releaseMonth(card, point('2026-11-15')); await screen.flush();
      assert.deepEqual(writes, []); assert.ok(choices.some(button => button.text === 'この予定のみ'));
      choices.find(button => button.text === 'すべての予定').onPress(); await screen.flush(); await screen.flush();
      assert.equal(writes[0].scope, 'series'); assert.equal(writes[0].value.recurrence, 'weekly'); assert.equal(writes[0].value.startDate, '2026-11-15');
      await screen.press('移動を元に戻す'); await screen.flush();
      assert.equal(writes.length, 2); assert.equal(local.snapshot.events[0].startDate, day); assert.equal(local.snapshot.events[0].recurrence, 'weekly');
      const again = await holdMonth(screen); releaseMonth(again, point('2026-11-15')); await screen.flush();
      choices.find(button => button.text === 'すべての予定').onPress(); await screen.flush(); await screen.flush();
      local.snapshot = { ...local.snapshot, events: [{ ...local.snapshot.events[0], title: '別の端末の編集', revision: 99 }] }; screen.render();
      await screen.press('移動を元に戻す'); await screen.flush();
      assert.equal(writes.length, 3); assert.match(screen.text(), /上書きせず/u);
    } finally { screen.unmount(); }
  });
  test(`${platform} undoing a single repeating drag removes only the newly created exception and scope cancellation never saves`, async () => {
    const writes = []; let restored = 0; let cancel = true;
    const local = binding({ restoreOccurrence: async draft => { restored++; assert.equal(draft.scope, 'one');
      local.snapshot = { ...local.snapshot, exceptions: [], events: [{ ...local.snapshot.events[0], revision: 5 }] }; },
      saveEvent: async draft => { writes.push(draft); local.snapshot = { ...local.snapshot,
        exceptions: [{ eventId: draft.eventId, anchorDate: draft.anchorDate, override: draft.value, revision: 1 }] }; } });
    local.snapshot.events = [event({ recurrence: 'weekly' })];
    const screen = make(local, { alert: (_title, _message, buttons) => buttons.find(button => button.text === (cancel ? 'キャンセル' : 'この予定のみ')).onPress() });
    try {
      const point = await monthSetup(screen); let card = await holdMonth(screen); releaseMonth(card, point('2026-11-15')); await screen.flush();
      assert.deepEqual(writes, []);
      cancel = false; card = await holdMonth(screen); releaseMonth(card, point('2026-11-15')); await screen.flush(); await screen.flush();
      assert.equal(writes.length, 1); assert.equal(writes[0].scope, 'one');
      await screen.press('移動を元に戻す'); await screen.flush(); assert.equal(restored, 1); assert.equal(writes.length, 1);
      assert.deepEqual(local.snapshot.exceptions, []); assert.equal(local.snapshot.events[0].recurrence, 'weekly');
    } finally { screen.unmount(); }
  });
  test(`${platform} month dragging changes only the date preserves times and returns scrolling without opening an editor`, async () => {
    for (const allDay of [false, true]) {
      const writes = []; const local = binding({ saveEvent: async draft => { writes.push(draft); } });
      local.snapshot.events = [event({ allDay, startMinute: allDay ? 0 : 865, endMinute: allDay ? 0 : 920 })];
      const screen = make(local);
      try {
        const point = await monthSetup(screen);
        let card = await holdMonth(screen);
        assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-weeks').props.scrollEnabled, false);
        moveMonth(card, point('2026-11-15')); await screen.flush();
        card = monthController(screen);
        releaseMonth(card, point('2026-11-15')); await screen.flush();
        assert.equal(writes.length, 1); assert.equal(writes[0].value.startDate, '2026-11-15'); assert.equal(writes[0].value.endDate, '2026-11-15');
        assert.equal(writes[0].value.startMinute, allDay ? 0 : 865); assert.equal(writes[0].value.endMinute, allDay ? 0 : 920);
        assert.equal(writes[0].value.allDay, allDay); assert.equal(writes[0].scope, 'series');
        assert.ok(screen.nodes().some(node => node.props.testID === 'calendar-weeks'));
        assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-weeks').props.scrollEnabled, true);
        assert.ok(!screen.text().includes('予定を編集'));
      } finally { screen.unmount(); }
    }
  });
  test(`${platform} month drags preserve repeating shared proofs and cancel invalid drops while excluding protected events`, async () => {
    const writes = []; let allowed = true;
    const local = binding({ saveEvent: async draft => writes.push(draft), canEditEvent: () => allowed,
      shared: { groupId: 'group', enabled: true }, prepareDraft: draft => ({ ...draft, audience: 'group', groupId: 'group', basisRevision: 'hold-proof' }) });
    local.snapshot.events = [event({ recurrence: 'weekly' })];
    const screen = make(local);
    try {
      const point = await monthSetup(screen);
      const hold = () => holdMonth(screen);
      let card = await hold(); releaseMonth(card, { ...point(day), moveX: -1 }); await screen.flush();
      assert.deepEqual(writes, []); assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-weeks').props.scrollEnabled, true);
      card = await hold(); allowed = false; screen.render(); releaseMonth(card, point('2026-11-15')); await screen.flush();
      assert.deepEqual(writes, []); assert.match(screen.text(), /権限がありません/u);
      allowed = true; screen.render(); card = await hold(); releaseMonth(card, point('2026-11-15')); await screen.flush();
      assert.equal(writes.length, 1); assert.equal(writes[0].scope, 'one'); assert.equal(writes[0].anchorDate, day);
      assert.equal(writes[0].basisRevision, 'hold-proof'); assert.equal(local.snapshot.events[0].startDate, day);
    } finally { screen.unmount(); }
    for (const extra of [{ readOnly: true }, { birthday: true }]) {
      const protectedScreen = make(binding({ snapshot: { ...local.snapshot, events: [event(extra)] } }));
      try { await monthSetup(protectedScreen);
        assert.equal(protectedScreen.button(`会議、${day}の予定`).props.onLongPress, undefined);
      } finally { protectedScreen.unmount(); }
    }
  });
  test(`${platform} calendar slot and duplicate shortcuts open editable unsaved forms without touching the original`, async () => {
    const writes = []; const local = binding({ saveEvent: async draft => { writes.push(draft); } });
    const screen = make(local);
    try {
      await selectCalendarView(screen, '1日表示');
      const slot = screen.nodes().find(node => node.props.accessibilityLabel?.includes('の空き時間に予定を追加'));
      slot.props.onLongPress({ nativeEvent: { locationY: 0 } }); await screen.flush();
      assert.deepEqual(writes, []); await screen.change('予定名', '深夜の予定'); await screen.press('予定を保存');
      assert.equal(writes[0].value.startDate, day); assert.equal(writes[0].value.startMinute, 0);
      await screen.press('会議を編集'); await screen.press('予定を複製');
      assert.equal(writes.length, 1); assert.ok(screen.text().includes('予定を追加'));
      await screen.change('予定名', '複製した会議'); await screen.press('予定を保存');
      assert.equal(writes[1].eventId, null); assert.equal(writes[1].value.location, '会議室'); assert.equal(writes[1].value.notes, '確認内容');
      assert.equal(local.snapshot.events[0].title, '会議');
    } finally { screen.unmount(); }
  });
  test(`${platform} held calendar drags use captured shared revisions, recheck permission, and restore scrolling after failure or cancellation`, async () => {
    const writes = []; let allowed = true; let proof = 'old-proof'; let fail = false;
    const local = binding({ shared: { groupId: 'group', enabled: true, name: '共有' }, canEditEvent: () => allowed,
      prepareDraft: draft => ({ ...draft, audience: 'group', groupId: 'group', basisRevision: proof }),
      saveEvent: async draft => { writes.push(draft); if (fail) throw new Error('競合を確認してください'); } });
    const screen = make(local);
    const card = () => screen.nodes().find(node => node.props.testID?.startsWith('calendar-movable-'));
    const hold = async () => { screen.button('会議を編集').props.onLongPress(); await screen.flush(); card().props.onPanResponderGrant(); };
    const drop = async () => { card().props.onPanResponderRelease(null, { dx: 1000, dy: 0 }); await screen.flush(); };
    try {
      await selectCalendarView(screen, '2日表示'); await hold();
      assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-timeline').props.scrollEnabled, false);
      proof = 'new-proof'; fail = true; screen.render(); await drop();
      assert.equal(writes.length, 1); assert.equal(writes[0].basisRevision, 'old-proof'); assert.equal(writes[0].value.startDate, '2026-11-15');
      assert.ok(screen.text().includes('競合を確認してください'));
      assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-timeline').props.scrollEnabled, true);
      await hold(); allowed = false; screen.render(); await drop();
      assert.equal(writes.length, 1); assert.ok(screen.text().includes('権限がありません'));
      allowed = true; screen.render(); await hold(); card().props.onPanResponderTerminate(); await screen.flush();
      assert.equal(writes.length, 1); assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-timeline').props.scrollEnabled, true);
    } finally { screen.unmount(); }
  });
  test(`${platform} a pending calendar move stays visible without duplicating the event or blocking scrolling and accepts the observed saved position`, async () => {
    let release; let entered; const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
    let written;
    const local = binding({ saveEvent: async draft => { written = draft; entered(); await gate;
      local.snapshot = { ...local.snapshot, events: [{ ...local.snapshot.events[0], ...draft.value, revision: 5 }] }; } });
    const screen = make(local); const movable = () => screen.nodes().find(node => node.props.testID?.startsWith('calendar-movable-'));
    try {
      await selectCalendarView(screen, '2日表示'); screen.button('会議を編集').props.onLongPress(); screen.render();
      movable().props.onPanResponderGrant(); movable().props.onPanResponderRelease(null, { dx: 1000, dy: 0 }); await started; await screen.flush();
      assert.equal(written.value.startDate, '2026-11-15');
      const dates = screen.nodes().map(node => node.props.accessibilityLabel ?? '');
      assert.ok(dates.some(label => label.startsWith('2026年11月15日') && label.includes('予定1件')));
      assert.ok(!dates.some(label => label.startsWith('2026年11月14日') && label.includes('予定1件')));
      assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-timeline').props.scrollEnabled, true);
      release(); await screen.flush(); await screen.flush();
      screen.button('会議を編集').props.onLongPress(); await screen.flush();
      assert.equal(screen.nodes().find(node => node.props.testID === 'calendar-timeline').props.scrollEnabled, false);
      movable().props.onPanResponderTerminate(); await screen.flush();
      assert.equal(local.snapshot.events[0].revision, 5);
    } finally { release(); await screen.flush(); screen.unmount(); }
  });
  test(`${platform} calendar drag shortcuts exclude read-only events and cannot cross a changed group binding`, async () => {
    const writes = []; const local = binding({ canEditEvent: () => true, saveEvent: async draft => writes.push(draft),
      shared: { groupId: 'first', enabled: true, name: '最初' }, prepareDraft: draft => ({ ...draft, audience: 'group', groupId: 'first', basisRevision: 'proof' }) });
    local.snapshot.events = [event({ readOnly: true })];
    const screen = make(local);
    try {
      await selectCalendarView(screen, '1日表示');
      assert.equal(screen.button('会議を編集').props.onLongPress, undefined);
      assert.equal(screen.button('会議を編集').props.accessibilityActions, undefined);
      local.snapshot = { ...local.snapshot, events: [event()] }; screen.render();
      screen.button('会議を編集').props.onLongPress(); await screen.flush();
      const card = screen.nodes().find(node => node.props.testID?.startsWith('calendar-movable-')); card.props.onPanResponderGrant();
      local.shared = { groupId: 'second', enabled: true, name: '別の共有先' }; screen.render();
      card.props.onPanResponderRelease(null, { dx: 0, dy: 60 }); await screen.flush();
      assert.deepEqual(writes, []); assert.ok(screen.text().includes('表示先が変わりました'));
    } finally { screen.unmount(); }
  });
  test(`${platform} dragging an already edited repeating occurrence changes only that occurrence and preserves its original anchor`, async () => {
    const writes = []; const local = binding({ saveEvent: async draft => writes.push(draft) });
    local.snapshot.events = [event({ recurrence: 'weekly' })];
    local.snapshot.exceptions = [{ eventId: 'appointment', anchorDate: day, revision: 2,
      override: { ...newEventDraft('2026-11-15', 'Asia/Tokyo'), title: '変更した回', startMinute: 600, endMinute: 660 } }];
    const screen = make(local);
    try {
      await selectCalendarView(screen, '2日表示');
      screen.button('変更した回を編集').props.onLongPress(); await screen.flush();
      const card = screen.nodes().find(node => node.props.testID?.startsWith('calendar-movable-'));
      card.props.onPanResponderGrant(); card.props.onPanResponderRelease(null, { dx: 0, dy: 44 }); await screen.flush();
      assert.equal(writes.length, 1); assert.equal(writes[0].scope, 'one');
      assert.equal(writes[0].anchorDate, day); assert.equal(writes[0].exceptionRevision, 2);
      assert.equal(writes[0].value.startDate, '2026-11-15'); assert.equal(writes[0].value.startMinute, 660);
      assert.equal(local.snapshot.events[0].recurrence, 'weekly');
    } finally { screen.unmount(); }
  });
}
