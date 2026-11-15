import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarHelpStore, CALENDAR_HELP_SEEN_KEY } from '../src/features/calendar/help-store.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

function storage(saved = null) {
  const values = new Map(saved === null ? [] : [[CALENDAR_HELP_SEEN_KEY, saved]]), reads = [], writes = [];
  return { values, reads, writes, getItemSync(key) { reads.push(key); return values.get(key) ?? null; }, setItemSync(key, value) { writes.push([key, value]); values.set(key, value); } };
}

test('calendar help records only one shown device introduction and survives process recreation', () => {
  const saved = storage(), store = createCalendarHelpStore(saved);
  assert.deepEqual(saved.reads, []); const first = store.claimIntroduction(); assert.ok(first); assert.equal(store.claimIntroduction(), null);
  assert.deepEqual(saved.writes, []); first.shown(); first.shown(); first.release(); store.shown();
  assert.deepEqual(saved.writes, [[CALENDAR_HELP_SEEN_KEY, '1']]); assert.deepEqual(saved.reads, [CALENDAR_HELP_SEEN_KEY]);
  assert.equal(store.claimIntroduction(), null); assert.equal(createCalendarHelpStore(saved).claimIntroduction(), null);
});

test('calendar help retries an undisplayed introduction and ignores a late native presentation callback', () => {
  const saved = storage(), store = createCalendarHelpStore(saved), abandoned = store.claimIntroduction(); abandoned.release(); abandoned.shown();
  assert.deepEqual(saved.writes, []); const shown = store.claimIntroduction(); assert.ok(shown); shown.shown(); abandoned.release();
  assert.equal(store.claimIntroduction(), null); assert.equal(saved.writes.length, 1);
});

test('calendar help storage failures never block use or repeat the introduction within the same session', () => {
  let reads = 0, writes = 0;
  const store = createCalendarHelpStore({ getItemSync() { reads++; throw new Error('read failed'); }, setItemSync() { writes++; throw new Error('write failed'); } });
  const first = store.claimIntroduction(); assert.ok(first); assert.doesNotThrow(() => first.shown());
  assert.equal(store.claimIntroduction(), null); store.shown(); assert.equal(reads, 1); assert.equal(writes, 1);
});

test('an existing calendar help marker skips automatic presentation without a redundant local write', () => {
  const saved = storage('1'), store = createCalendarHelpStore(saved);
  assert.equal(store.claimIntroduction(), null); assert.equal(store.claimIntroduction(), null); store.shown();
  assert.deepEqual(saved.reads, [CALENDAR_HELP_SEEN_KEY]); assert.deepEqual(saved.writes, []);
});

const names = [
  ['ios', 'ios calendar help opens only on first focus and can reopen without changing the selected day view or native list',
    'ios calendar help waits for another calendar sheet and keeps the chosen display when dismissed',
    'ios calendar help remains available without a local calendar and returns from every native close path'],
  ['android', 'android calendar help opens only on first focus and can reopen without changing the selected day view or native list',
    'android calendar help waits for another calendar sheet and keeps the chosen display when dismissed',
    'android calendar help remains available without a local calendar and returns from every native close path'],
];
function calendar(platform, saved, localAvailable = true) {
  let callbacks = [], leaves = [], view = 'month', detail = 'two', reads = 0;
  const local = { database: {}, loading: false, error: null, refresh: async () => { reads++; }, requestRange: async () => { reads++; },
    snapshot: { events: [], exceptions: [], categories: [], drafts: [] } };
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar',
    focusEffect: callback => callbacks.push(callback), props: { today: '2026-11-15', selectedDate: '2026-11-16', timeZone: 'Asia/Tokyo',
      ...(localAvailable ? { local } : {}), dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null },
    mocks: { 'expo-sqlite/kv-store': { __esModule: true, default: saved },
      '../../hooks/use-calendar-display': { useCalendarDisplay: () => ({ view, detail, select: value => { view = value; if (value === 'day' || value === 'two' || value === 'list') detail = value; } }) } } });
  return { ui, local, reads: () => reads, view: () => view,
    async focus() { for (const leave of leaves) leave?.(); callbacks = []; ui.render(); leaves = callbacks.map(callback => callback()); await ui.flush(); },
    async leave() { for (const leave of leaves) leave?.(); leaves = []; await ui.flush(); },
    close() { for (const leave of leaves) leave?.(); ui.unmount(); },
  };
}
const modal = ui => ui.nodes().find(node => node.type === 'Modal');
async function close(ui, platform, path = 'button') {
  const sheet = modal(ui); assert.ok(sheet);
  if (path === 'button') await ui.press('カレンダーのヘルプを閉じる');
  else { sheet.props.onRequestClose(); await ui.flush(); }
  if (platform === 'ios') { sheet.props.onDismiss(); await ui.flush(); }
  assert.equal(modal(ui), undefined);
}
for (const [platform, firstName, waitingName, noLocalName] of names) {
  test(firstName, async t => {
    const saved = storage(), f = calendar(platform, saved); t.after(() => f.close()); const ui = f.ui;
    assert.equal(modal(ui), undefined); assert.deepEqual(saved.reads.filter(key => key === CALENDAR_HELP_SEEN_KEY), []);
    const list = ui.nodes().find(node => node.props.testID === 'calendar-weeks'); const before = structuredClone(f.local.snapshot);
    await f.focus(); assert.ok(modal(ui)); assert.throws(() => ui.button('予定を追加'), /missing button/);
    assert.match(ui.text(), /長押しして移動/u); assert.match(ui.text(), /個別に変更した回はそのまま/u);
    modal(ui).props.onShow(); await close(ui, platform);
    assert.equal(ui.nodes().find(node => node.props.testID === 'calendar-weeks').props.ref, list.props.ref);
    assert.equal(f.view(), 'month'); const reads = f.reads();
    await ui.press('カレンダーのヘルプを開く'); modal(ui).props.onShow(); await close(ui, platform, 'native');
    assert.equal(f.reads(), reads); assert.equal(ui.button('カレンダーの表示を選択').props.accessibilityValue.text, '2日');
    assert.deepEqual(f.local.snapshot, before); assert.deepEqual(saved.writes, [[CALENDAR_HELP_SEEN_KEY, '1']]);
    await f.leave(); await f.focus(); assert.equal(modal(ui), undefined);
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel?.startsWith('2026年11月16日')));
  });

  test(waitingName, async t => {
    const saved = storage(), f = calendar(platform, saved); t.after(() => f.close()); const ui = f.ui;
    await ui.press('カレンダーの表示を選択'); await f.focus(); assert.equal(ui.text().includes('予定は、長押しして移動'), false);
    assert.deepEqual(saved.writes, []); await ui.press('2日表示'); await f.focus(); assert.ok(modal(ui));
    modal(ui).props.onShow(); await close(ui, platform); assert.equal(f.view(), 'two');
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel?.startsWith('2026年11月16日')));
    await ui.press('予定を検索する'); assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '予定の検索を閉じる'));
    assert.equal(ui.text().includes('予定は、長押しして移動'), false);
  });

  test(noLocalName, async t => {
    const saved = storage('1'), f = calendar(platform, saved, false); t.after(() => f.close()); const ui = f.ui;
    await f.focus(); assert.equal(modal(ui), undefined); assert.equal(ui.button('予定を検索する').props.disabled, true);
    for (const path of ['button', 'native']) {
      await ui.press('カレンダーのヘルプを開く'); assert.ok(modal(ui)); modal(ui).props.onShow(); await close(ui, platform, path);
      ui.button('カレンダーのヘルプを開く'); assert.deepEqual(saved.writes, []);
    }
  });
}
