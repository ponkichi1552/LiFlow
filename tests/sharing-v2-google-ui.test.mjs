import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

const flush = async screen => { for (let i = 0; i < 12; i++) await screen.flush(); };
function fixture() {
  const calls = []; const control = { revision: 0, label: null, state: null }; let result = { kind: 'success', created: 2, updated: 1, imported: 1 };
  const runtime = { async readControl() { return structuredClone(control); }, async reviewConnection() { calls.push('review'); return { subject: 'subject', label: '選択したGoogle', connectionRevision: control.revision }; },
    async connect(review) { calls.push(['connect', structuredClone(review)]); control.revision++; control.label = review.label; control.state = { enabled: true, disconnected: false, status: 'idle' }; },
    async pause(revision, disconnected = false) { assert.equal(revision, control.revision); calls.push(['pause', disconnected]); control.revision++; control.state.enabled = false; control.state.disconnected = disconnected; },
    async synchronize(options) { calls.push(['sync', options]); return result; } };
  return { runtime, control, calls, outcome(value) { result = value; } };
}
async function open(h, platform, load = async () => h.runtime) {
  const effects = []; let backs = 0;
  const screen = screenHarness('src/features/sharing/v2-ui/google-tasks-screen.tsx', { exportName: 'V2GoogleTasksScreen', platform,
    props: { load, onBack() { backs++; } }, effect: callback => effects.push(callback) });
  effects.shift()(); await flush(screen); effects.at(-1)?.();
  return { screen, effects, backs: () => backs };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} v2 Tasks QA route is blocked in release before opening an identity database or Google`, () => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = false; let opened = 0;
    try {
      const screen = screenHarness('src/app/development/v2-google-tasks-preview.tsx', { platform, mocks: {
        '../../platform/sharing/v2-google-tasks-preview': { createV2GoogleTasksPreview: async () => { opened++; throw new Error('must not open'); } },
      } });
      assert.match(screen.text(), /開発ビルド専用/u); assert.equal(opened, 0);
    } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
  });
  test(`${platform} v2 Tasks screen never requests Google until explicit review and account confirmation`, async () => {
    const h = fixture(); const ui = await open(h, platform); assert.deepEqual(h.calls, []); assert.match(ui.screen.text(), /未接続/u);
    await ui.screen.press('Googleアカウントを確認'); await flush(ui.screen); assert.deepEqual(h.calls, ['review']); assert.match(ui.screen.text(), /選択したGoogle/u);
    assert.equal(h.control.state, null); await ui.screen.press('このアカウントで連携'); await flush(ui.screen);
    assert.equal(h.calls[1][0], 'connect'); assert.deepEqual(h.calls[2], ['sync', { force: true }]); assert.match(ui.screen.text(), /同期しました/u); assert.match(ui.screen.text(), /連携中/u);
    assert.equal(ui.screen.text().includes('subject'), false);
    await ui.screen.press('Google連携を一時停止'); await flush(ui.screen); assert.equal(h.control.state.enabled, false); assert.match(ui.screen.text(), /一時停止中/u);
  });
  test(`${platform} v2 Tasks screen distinguishes a retry or skipped run from successful synchronization`, async () => {
    const h = fixture(); h.control.state = { enabled: true, disconnected: false, status: 'retryPending', nextRetryAt: '2026-10-29T02:00:00Z' };
    const ui = await open(h, platform); h.outcome({ kind: 'retry', code: 'timeout' });
    await ui.screen.press('共有家事を今すぐ同期'); await flush(ui.screen); assert.match(ui.screen.text(), /反映が完了していません/u); assert.doesNotMatch(ui.screen.text(), /同期しました/u);
    h.outcome({ kind: 'success', skipped: true }); await ui.screen.press('共有家事を今すぐ同期'); await flush(ui.screen); assert.match(ui.screen.text(), /同期を見送りました/u);
    await ui.screen.press('前の画面に戻る'); assert.equal(ui.backs(), 1);
  });
  test(`${platform} v2 Tasks pause remains usable during a slow sync and late results cannot replace pause feedback`, async () => {
    const h = fixture(); h.control.state = { enabled: true, disconnected: false, status: 'idle' }; const ui = await open(h, platform);
    let release; h.runtime.synchronize = async () => new Promise(resolve => { release = resolve; });
    const sync = ui.screen.press('共有家事を今すぐ同期'); await ui.screen.flush();
    assert.equal(ui.screen.button('Google連携を一時停止').props.disabled, false);
    await ui.screen.press('Google連携を一時停止'); await flush(ui.screen); assert.equal(h.control.state.enabled, false);
    release({ kind: 'success', created: 100 }); await sync; await flush(ui.screen);
    assert.match(ui.screen.text(), /一時停止しました/u); assert.doesNotMatch(ui.screen.text(), /追加100件/u);
  });
  test(`${platform} v2 Tasks read failure retains Back and retry without any connection changes`, async () => {
    const h = fixture(); const ui = await open(h, platform, async () => { throw new Error('disk read failed'); });
    assert.match(ui.screen.text(), /保存内容は保持/u); ui.screen.button('Google連携を再読込'); await ui.screen.press('前の画面に戻る'); assert.equal(ui.backs(), 1); assert.deepEqual(h.calls, []);
  });
  test(`${platform} v2 Tasks normal route refuses personal v1 and foreign-account workspaces`, () => {
    for (const active of [null, { protocol: 1 }, { protocol: 2, userId: 'foreign', identity: { deviceId: 'foreign-device' } }]) {
      let opened = 0; const context = { ready: true, active, userId: 'owner' };
      const screen = screenHarness('src/app/group-v2/google-tasks.tsx', { platform, mocks: {
        '../../hooks/use-workspace': { useWorkspace: () => context },
        '../../features/sharing/v2-ui/google-tasks-screen': { V2GoogleTasksScreen: () => { opened++; return null; } },
      } });
      assert.match(screen.text(), /Google連携を設定する共有グループ/u); assert.equal(opened, 0);
    }
  });
  test(`${platform} v2 Tasks old route cannot request a Google grant after workspace selection changes`, async () => {
    const h = fixture(); const active = { protocol: 2, userId: 'owner', groupId: 'group-a', identity: { deviceId: 'device' }, googleTasks: async () => h.runtime };
    const context = { ready: true, active, userId: 'owner' }; const effects = []; let load;
    const screen = screenHarness('src/app/group-v2/google-tasks.tsx', { platform, layoutEffect: callback => effects.push(callback), mocks: {
      '../../hooks/use-workspace': { useWorkspace: () => context },
      '../../features/sharing/v2-ui/google-tasks-screen': { V2GoogleTasksScreen: props => { load = props.load; return null; } },
    } });
    effects.shift()(); const session = await load(); await session.readControl();
    context.active = { ...active, groupId: 'group-b' }; screen.render(); effects.at(-1)();
    await assert.rejects(session.reviewConnection(), /参加状態が変わり/u); await assert.rejects(session.connect({ subject: 'subject', label: 'Google', connectionRevision: 0 }), /参加状態が変わり/u);
    assert.deepEqual(h.calls, []);
  });
}
