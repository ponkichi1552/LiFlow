import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const day = '2026-11-14';
test('a device review build opens review cases from the main settings menu and starts on the regular home', async () => {
  const key = 'EXPO_PUBLIC_LIFLOW_UI_REVIEW';
  const previous = process.env[key];
  try {
    for (const [mode, enabled, autoOpen] of [[undefined, false, false], ['menu', true, false], ['1', true, true]]) {
      if (mode === undefined) delete process.env[key]; else process.env[key] = mode;
      const gate = loadNativeModule('src/features/development/ui-review/enabled.ts', {});
      assert.deepEqual(gate, { uiReviewEnabled: enabled, uiReviewBuild: autoOpen });
      const destinations = [];
      const ui = screenHarness('src/features/settings/settings-navigation.tsx', { exportName: 'SettingsNavigationScreen',
        mocks: { '../development/ui-review/enabled': gate }, navigate: (...args) => destinations.push(args) });
      try {
        if (enabled) {
          await ui.press('UI確認用データ');
          assert.deepEqual(destinations, [['push', '/development/ui-review']]);
        } else {
          assert.doesNotMatch(ui.text(), /UI確認用データ/u);
        }
      } finally { ui.unmount(); }
    }
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} unsupported shared single registrations explain the disabled save and offer the update destination without writing`, async t => {
    const destinations = []; let writes = 0;
    const choice = { id: 'chore', name: '床の掃除', enabled: false, load: 'normal', estimatedMinutes: 15 };
    const model = { viewerUserId: 'owner', adminUserId: 'owner', configurations: [],
      plan: { groupId: 'review-group', algorithm: 'liflow-shared-2-draft-55', timeZone: 'Asia/Tokyo', range: { asOfDate: day }, members: [], chores: [choice] } };
    const ui = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { platform, exportName: 'V2AddChore',
      navigate: (method, target) => destinations.push([method, target]), props: { model, calendarDate: day, initialChore: choice,
        calendarInput: { repeat: false }, actions: {}, busy: false, run: async () => { writes++; }, onCreated() { writes++; }, onBack() {} } });
    t.after(() => ui.unmount());
    assert.equal(ui.button('追加').props.disabled, true); assert.match(ui.text(), /1回だけ.*共有グループを更新/u);
    await ui.press('共有グループの更新を開く');
    assert.deepEqual(destinations, [['push', { pathname: '/sharing/group/[groupId]', params: { groupId: 'review-group', section: 'sync' } }]]);
    assert.equal(writes, 0);
  });
  test(`${platform} category editing has its own save and cannot submit a partial appointment`, async t => {
    const db = createDatabase(); t.after(() => db.connection.close()); await initializeLocalDatabase(db.database);
    const local = { database: db.database, snapshot: await readLocalCalendar(db.database), refresh: async () => {} };
    const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(day, 'Asia/Tokyo') };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { platform, exportName: 'CalendarEditor', props: { initial, local, onClose() {}, onSaved() {} } });
    t.after(() => ui.unmount());
    assert.equal(ui.button('予定を保存').props.disabled, true);
    await ui.change('予定名', 'カテゴリ編集中の予定'); assert.equal(ui.button('予定を保存').props.disabled, false);
    await ui.press('分類を選択'); await ui.press('分類を追加');
    assert.equal(ui.button('予定を保存').props.disabled, true); assert.equal(ui.button('分類を保存').props.disabled, true);
    assert.equal((await readLocalCalendar(db.database)).events.length, 0);
    await ui.press('分類の編集を閉じる'); assert.equal(ui.button('予定を保存').props.disabled, false);
  });
}
