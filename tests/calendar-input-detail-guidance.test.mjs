import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { createCalendarMonthDetailStore, MONTH_DETAIL_KEY, monthDetailLayout } from '../src/features/calendar/month-detail-store.ts';
import { calendarMonthContentHeight, calendarMonthPreviewLayout, calendarMonthUsedHeight, MONTH_EVENT_ROW_HEIGHT, MONTH_MORE_HEIGHT, MONTH_CELL_GAP } from '../src/features/calendar/month-density.ts';
import { calendarHelpPlacement, measureCalendarHelpTargets } from '../src/features/calendar/help-targets.ts';
const repository = await import('../src/platform/storage/repository.ts');
const calendars = await import('../src/platform/storage/calendar-events.ts');
const date = '2026-11-20';
const draft = value => ({ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: value ?? newEventDraft(date, 'Asia/Tokyo') });

function memory(initial = null) {
  const data = new Map(initial ? [[MONTH_DETAIL_KEY, initial]] : []), writes = [];
  return { data, writes, fail: false, getItemSync: key => data.get(key) ?? null, setItemSync(key, value) { if (this.fail) throw new Error('storage unavailable'); data.set(key, value); writes.push([key, value]); } };
}
test('month detail is a device preference with idempotent writes and failed saves keep the accepted mode', () => {
  const storage = memory(), store = createCalendarMonthDetailStore(storage);
  assert.equal(store.getSnapshot(), 'standard'); assert.equal(storage.writes.length, 0); store.select('standard'); assert.equal(storage.writes.length, 0);
  store.select('detailed'); assert.equal(store.getSnapshot(), 'detailed'); assert.deepEqual(storage.writes, [[MONTH_DETAIL_KEY, 'detailed']]);
  assert.equal(createCalendarMonthDetailStore(storage).getSnapshot(), 'detailed');
  storage.fail = true; assert.throws(() => store.select('compact')); assert.equal(store.getSnapshot(), 'detailed');
  assert.throws(() => store.select('invalid')); assert.equal(store.getSnapshot(), 'detailed');
});
test('every month detail retains all counts and reserves chores waste and overflow before additional text', () => {
  for (const mode of ['compact', 'standard', 'detailed']) for (const base of [0, 100, 180, 300]) for (const total of [0, 1, 3, 7, 100]) for (const summary of [false, true]) for (const waste of [false, true]) {
    const config = monthDetailLayout(mode), height = calendarMonthContentHeight(base, config.maxEvents);
    const result = calendarMonthPreviewLayout(height, total, summary, waste, config.maxEvents);
    assert.equal(result.visible + result.hidden, total);
    const used = calendarMonthUsedHeight(result.visible, summary, waste) + (result.hidden ? MONTH_MORE_HEIGHT + MONTH_CELL_GAP : 0) + (config.extra ? result.extraLines * MONTH_EVENT_ROW_HEIGHT : 0);
    assert.ok(used <= height, `${mode}: reserved day labels must stay visible`);
  }
});
test('calendar help callouts stay inside safe screen bounds and point to the actual measured control', () => {
  for (const width of [320, 390, 844]) for (const height of [390, 844]) for (const rect of [undefined, { x: 5, y: 40, width: 50, height: 44 }, { x: width - 80, y: height - 100, width: 60, height: 44 }, { x: -10, y: 150, width: 80, height: 30 }]) {
    const screen = { width, height, top: 30, bottom: 20 }, result = calendarHelpPlacement(screen, rect, 250);
    assert.ok(result.left >= 0 && result.left + result.width <= width); assert.ok(result.top >= screen.top);
    assert.ok(result.top + result.height <= height - screen.bottom);
    if (result.arrow) { assert.equal(result.arrow.toX, result.target.x + result.target.width / 2); assert.ok(Number.isFinite(result.arrow.toY)); }
  }
});
test('calendar help measures real visible editable events and ignores offscreen missing or late native measurements', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = (x, y, width, height) => ({ measureInWindow: done => done(x, y, width, height) });
  let calls = 0, measured;
  measureCalendarHelpTargets({ add: host(300, 50, 44, 44), calendar: host(0, 120, 390, 600) }, new Map([
    ['offscreen', host(0, -50, 50, 30)], ['visible', host(50, 200, 100, 40)], ['under-toolbar', host(200, 690, 60, 30)],
  ]), value => { calls++; measured = value; });
  assert.equal(calls, 1); assert.deepEqual(measured.event, { x: 50, y: 200, width: 100, height: 40 });
  let late; const cancel = measureCalendarHelpTargets({ add: { measureInWindow: done => { late = done; } } }, new Map(), () => { calls++; });
  cancel(); late(0, 0, 20, 20); t.mock.timers.tick(200); assert.equal(calls, 1);
});

for (const [platform, inputName, manualName, boundaryName, detailName, guidanceName] of [
  ['ios', 'ios new appointment titles fill civil dates and clocks and save the original sentence exactly once',
    'ios manually chosen appointment clocks take precedence over subsequent title expressions',
    'ios title inference leaves existing duplicate birthday and chore forms unchanged',
    'ios month detail can change in the existing menu without writing calendar data or changing view',
    'ios calendar guidance advances over the live controls and closes without changing its background'],
  ['android', 'android new appointment titles fill civil dates and clocks and save the original sentence exactly once',
    'android manually chosen appointment clocks take precedence over subsequent title expressions',
    'android title inference leaves existing duplicate birthday and chore forms unchanged',
    'android month detail can change in the existing menu without writing calendar data or changing view',
    'android calendar guidance advances over the live controls and closes without changing its background'],
]) {
  test(inputName, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T03:00:00Z') });
    const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
    const local = { database: h.database, snapshot: await calendars.readLocalCalendar(h.database), refresh: async () => {} }; const saved = [];
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial: draft(), local, onClose() {}, onSaved: date => saved.push(date) } }); t.after(() => ui.unmount());
    const title = '来週の火曜日18時から友達と食事'; await ui.change('予定名', title);
    assert.equal(ui.button('開始日を選択').props.accessibilityValue.text, '2026/11/17'); assert.equal(ui.button('開始を選択').props.accessibilityValue.text, '18:00');
    assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '19:00'); assert.equal((await calendars.readLocalCalendar(h.database)).events.length, 0);
    await ui.press('予定を保存'); for (let n = 0; n < 16; n++) await ui.flush();
    const events = (await calendars.readLocalCalendar(h.database)).events; assert.equal(events.length, 1); assert.equal(events[0].title, title);
    assert.equal(events[0].startDate, '2026-11-17'); assert.equal(events[0].startMinute, 1080); assert.deepEqual(saved, ['2026-11-17']);
  });
  test(manualName, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T03:00:00Z') }); let picker;
    const local = { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] }, refresh: async () => {} };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, datePicker: value => { picker = value; }, props: { initial: draft(), local, onClose() {}, onSaved() {} } }); t.after(() => ui.unmount());
    await ui.change('予定名', '明日18時に食事'); await ui.press('開始を選択');
    const picked = new Date('2026-11-16T20:00:00Z');
    if (platform === 'ios') { ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({}, picked); await ui.flush(); await ui.press('日時選択を閉じる'); }
    else { picker.onValueChange({}, picked); await ui.flush(); }
    await ui.change('予定名', '明日19時に食事'); assert.equal(ui.button('開始を選択').props.accessibilityValue.text, '20:00'); assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '21:00');
  });
  test(boundaryName, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T03:00:00Z') });
    for (const kind of ['existing', 'duplicate', 'birthday', 'chore']) {
      const value = { ...newEventDraft(date, 'Asia/Tokyo'), title: kind === 'duplicate' || kind === 'existing' ? '元の名前' : '', birthday: kind === 'birthday' };
      const initial = { ...draft(value), ...(kind === 'existing' ? { eventId: 'old', revision: 1 } : {}) };
      const local = { database: {}, snapshot: { events: kind === 'existing' ? [{ ...value, id: 'old', revision: 1 }] : [], exceptions: [], categories: [], drafts: [] }, refresh: async () => {} };
      const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial, local, onClose() {}, onSaved() {}, ...(kind === 'chore' ? { choreForm: { content: null, disabled: false, busy: false, entry: { value, onChange() {}, titleEditable: true } } } : {}) } });
      try {
        await ui.change(kind === 'chore' ? '家事名' : '予定名', '来週火曜日18時');
        assert.equal(ui.button(kind === 'birthday' ? '誕生日を選択' : '開始日を選択').props.accessibilityValue.text, '2026/11/20');
      } finally { ui.unmount(); }
    }
  });
  test(detailName, async t => {
    const storage = memory(); let closed = 0;
    const props = { value: 'two', onSelect() { assert.fail('density must not choose another view'); }, onClose() { closed++; }, monthDetail: 'standard', onMonthDetail: value => { store.select(value); props.monthDetail = store.getSnapshot(); } };
    const store = createCalendarMonthDetailStore(storage), ui = screenHarness('src/features/calendar/view-menu.tsx', { exportName: 'CalendarViewMenu', platform, props }); t.after(() => ui.unmount());
    storage.fail = true; await ui.press('月表示を詳しくにする'); assert.equal(closed, 0); assert.equal(store.getSnapshot(), 'standard'); assert.match(ui.text(), /保存できません/u);
    storage.fail = false; await ui.press('月表示を詳しくにする'); assert.equal(closed, 1); assert.equal(store.getSnapshot(), 'detailed');
    assert.equal(ui.button('月表示を詳しくにする').props.accessibilityState.selected, true); assert.deepEqual(storage.writes, [[MONTH_DETAIL_KEY, 'detailed']]);
  });
  test(guidanceName, async t => {
    let closed = 0, shown = 0, phase = 0; const effects = []; const targets = { add: { x: 310, y: 60, width: 44, height: 44 }, mode: { x: 250, y: 60, width: 56, height: 44 }, search: { x: 270, y: 740, width: 88, height: 44 } };
    const ui = screenHarness('src/features/calendar/calendar-help.tsx', { exportName: 'CalendarHelp', platform, props: { onClose: () => closed++, onShow: () => shown++, measureTargets: done => { done({ ...targets, event: { x: 50, y: phase ? 300 : 40, width: 80, height: 30 } }); return () => {}; } }, effectDependencies: true, effect: callback => effects.push(callback) }); t.after(() => ui.unmount());
    for (const effect of effects.splice(0)) effect(); await ui.flush();
    phase = 1; ui.nodes().find(node => node.type === 'Modal').props.onShow(); await ui.flush();
    const outline = ui.nodes().find(node => node.props.testID === 'calendar-help-target');
    const frame = Object.assign({}, ...outline.props.style);
    assert.ok(frame.top > 70 && frame.top <= 300 && frame.top + frame.height >= 330, 'native presentation remeasures the final control position');
    for (const title of ['予定・家事を追加', '表示・詳しさを切り替える', '予定・家事を探す']) { await ui.press('カレンダーの案内を次へ'); assert.match(ui.text(), new RegExp(title)); }
    await ui.press('カレンダーの案内を完了'); if (platform === 'ios') ui.nodes().find(node => node.type === 'Modal').props.onDismiss();
    assert.equal(closed, 1); assert.equal(shown, 1); assert.deepEqual(targets.add, { x: 310, y: 60, width: 44, height: 44 });
  });
}
