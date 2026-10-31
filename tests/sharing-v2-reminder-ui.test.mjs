import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createV2ReminderEditor } from '../src/features/sharing/v2-ui/reminder-editor.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import { readFileSync } from 'node:fs';

function fixture() {
  const state = { revision: 0, preferences: { enabled: false, hour: 9, minute: 0 }, groupRevision: 'group-revision' };
  let permissions = 0, syncs = 0; const writes = []; let permitted = true;
  const runtime = { store: { async read() { return structuredClone(state); }, async save(revision, value) {
    assert.equal(revision, state.revision); writes.push(structuredClone(value));
    if (JSON.stringify(value) !== JSON.stringify(state.preferences)) { state.revision++; state.preferences = structuredClone(value); }
    return structuredClone(state);
  } }, async requestPermission() { permissions++; return permitted; }, async permissionStatus() { return permitted; }, async synchronize() { syncs++; return { skippedDates: [] }; } };
  return { runtime, state, writes, permissions: () => permissions, syncs: () => syncs, permit(value) { permitted = value; } };
}
async function open(h, platform, load = async () => h.runtime) {
  const effects = []; const layoutEffects = []; let backs = 0;
  const screen = screenHarness('src/features/sharing/v2-ui/reminder-screen.tsx', { exportName: 'V2ReminderScreen', platform,
    props: { load, onBack() { backs++; } }, effect: callback => effects.push(callback), layoutEffect: callback => layoutEffects.push(callback) });
  const close = effects.shift()(); for (let i = 0; i < 10; i++) await screen.flush(); for (const apply of layoutEffects) apply();
  return { screen, effects, close, backs: () => backs };
}
const flush = async screen => { for (let i = 0; i < 10; i++) await screen.flush(); };
const input = (screen, label) => screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === label);
for (const platform of ['ios', 'android']) {
  test(`${platform} normal v2 notification route fences stale UI writes after the selected workspace changes`, async () => {
    const h = fixture(); const active = { protocol: 2, userId: 'owner', groupId: 'group-a', identity: { deviceId: 'device' }, reminders: async () => h.runtime };
    const context = { ready: true, active, userId: 'owner' }; const effects = []; let load;
    const screen = screenHarness('src/app/group-v2/notifications.tsx', { platform, layoutEffect: callback => effects.push(callback), mocks: {
      '../../hooks/use-workspace': { useWorkspace: () => context }, '../../features/sharing/v2-ui/reminder-screen': { V2ReminderScreen: props => { load = props.load; return null; } },
    } });
    effects.shift()(); const session = await load(); await session.store.read();
    context.active = { ...active, groupId: 'group-b' }; screen.render(); effects.at(-1)();
    await assert.rejects(session.store.save(0, { enabled: true, hour: 10, minute: 0 }), /参加状態が変わり/u); assert.equal(h.writes.length, 0);
  });
  test(`${platform} normal notification route does not open settings for personal v1 or foreign-account scopes`, () => {
    for (const active of [null, { protocol: 1 }, { protocol: 2, userId: 'foreign', identity: { deviceId: 'other' } }]) {
      let opened = 0; const context = { ready: true, active, userId: 'owner' };
      const screen = screenHarness('src/app/group-v2/notifications.tsx', { platform, mocks: {
        '../../hooks/use-workspace': { useWorkspace: () => context }, '../../features/sharing/v2-ui/reminder-screen': { V2ReminderScreen: () => { opened++; return null; } },
      } });
      assert.match(screen.text(), /通知を設定する共有グループ/u); assert.equal(opened, 0); assert.equal(screen.nodes().some(node => node.type === 'Switch'), false);
    }
  });
  test(`${platform} v2 reminder QA route is unavailable in release before any identity database or notification permission opens`, () => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = false; let opens = 0;
    try {
      const screen = screenHarness('src/app/development/v2-reminder-preview.tsx', { platform,
        mocks: { '../../platform/sharing/v2-reminder-preview': { createV2ReminderPreview: async () => { opens++; throw new Error('must not open'); } } } });
      assert.match(screen.text(), /開発ビルド専用/u); assert.equal(opens, 0); assert.equal(screen.nodes().some(row => row.type === 'Switch' || row.type === 'TextInput'), false);
    } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
  });
  test(`${platform} v2 reminders UI requests permission only on enable and valid time edits autosave`, async () => {
    const h = fixture(); const ui = await open(h, platform);
    assert.equal(h.permissions(), 0); assert.equal(h.writes.length, 0);
    assert.equal(ui.screen.nodes().find(node => node.type === 'Switch').props.value, false);
    const page = ui.screen.nodes().find(node => node.type === 'ScrollView'); assert.equal(page.props.automaticallyAdjustKeyboardInsets, true); assert.equal(page.props.keyboardDismissMode, 'on-drag');
    const hour = input(ui.screen, '共有通知の時'); hour.props.onChangeText('18'); await ui.screen.flush(); input(ui.screen, '共有通知の分').props.onChangeText('7'); await ui.screen.flush();
    input(ui.screen, '共有通知の分').props.onBlur(); await flush(ui.screen); assert.deepEqual(h.state.preferences, { enabled: false, hour: 18, minute: 7 });
    assert.equal(h.syncs(), 1, 'an accepted autosave refreshes native delivery even if the page is then left');
    assert.equal(h.permissions(), 0);
    ui.screen.nodes().find(node => node.type === 'Switch').props.onValueChange(true); await flush(ui.screen);
    assert.equal(h.permissions(), 1); assert.equal(h.state.preferences.enabled, true);
    assert.equal(h.syncs(), 2);
    await ui.screen.press('通知を今すぐ更新'); await flush(ui.screen); assert.equal(h.syncs(), 3); assert.match(ui.screen.text(), /この端末の通知へ反映/u);
    ui.close?.();
  });
  test(`${platform} v2 invalid reminder times remain visible, block leaving, and can be explicitly discarded`, async () => {
    const h = fixture(); const ui = await open(h, platform);
    input(ui.screen, '共有通知の時').props.onChangeText('24'); await ui.screen.flush(); input(ui.screen, '共有通知の時').props.onBlur(); await flush(ui.screen);
    assert.equal(h.writes.length, 0); assert.equal(input(ui.screen, '共有通知の時').props.value, '24');
    await ui.screen.press('前の画面に戻る'); await flush(ui.screen); assert.equal(ui.backs(), 0); assert.match(ui.screen.text(), /未保存の入力を修正/u);
    await ui.screen.press('未保存の通知設定を破棄して戻る'); await flush(ui.screen); assert.equal(ui.backs(), 1); assert.equal(h.writes.length, 0); ui.close?.();
  });
  test(`${platform} v2 denied permission leaves notification preferences off and does not fabricate a successful save`, async () => {
    const h = fixture(); h.permit(false); const ui = await open(h, platform);
    ui.screen.nodes().find(node => node.type === 'Switch').props.onValueChange(true); await flush(ui.screen);
    assert.equal(h.state.preferences.enabled, false); assert.equal(h.writes.length, 0); assert.match(ui.screen.text(), /通知が許可されていません/u); ui.close?.();
  });
  test(`${platform} v2 reminder read failure keeps Back and retry available without permission or saves`, async () => {
    const h = fixture(); const ui = await open(h, platform, async () => { throw new Error('storage unavailable'); });
    assert.match(ui.screen.text(), /保存内容は保持/u); ui.screen.button('通知設定を再読込'); await ui.screen.press('前の画面に戻る'); assert.equal(ui.backs(), 1);
    assert.equal(h.writes.length, 0); assert.equal(h.permissions(), 0); ui.close?.();
  });
}

test('v2 reminder editor retains a newer incomplete draft after an earlier save resolves and blocks premature navigation', async () => {
  const h = fixture(); let release; let entered; const ready = new Promise(resolve => { entered = resolve; }); const wait = new Promise(resolve => { release = resolve; });
  const save = h.runtime.store.save;
  const store = { ...h.runtime.store, async save(...args) { entered(); await wait; return save(...args); } };
  const editor = createV2ReminderEditor({ store, saved: await store.read(), delayMs: 10_000 }); editor.change({ hour: '18' }); const pending = editor.flush(); await ready;
  editor.change({ minute: '' }); release(); assert.equal(await pending, false); assert.equal(editor.getSnapshot().raw.minute, ''); assert.equal(h.state.preferences.minute, 0);
  let navigate = 0; assert.equal(await editor.navigateAfterSave(() => navigate++), false); assert.equal(navigate, 0);
  editor.change({ minute: '25' }); assert.equal(await editor.flush(), true); assert.equal(h.state.preferences.minute, 25);
});

test('v2 reminder QA service rejects release calls before Native device identity or database access', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    const source = readFileSync(new URL('../src/platform/sharing/v2-reminder-preview.ts', import.meta.url), 'utf8');
    const mocks = Object.fromEntries([...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => [match[1], {}]));
    const api = loadNativeModule('src/platform/sharing/v2-reminder-preview.ts', mocks); await assert.rejects(api.createV2ReminderPreview(), /開発ビルド専用/u);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
