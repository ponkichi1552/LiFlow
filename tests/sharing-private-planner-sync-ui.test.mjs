import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privatePlannerSyncFixture, privatePreferenceInput as input } from './helpers/private-planner-sync.mjs';

async function open(h, platform, overrides = {}) {
  const effects = []; let configured = 0; const screen = screenHarness('src/features/sharing/private-planner/preference-screen.tsx', {
    exportName: 'PrivatePreferenceScreen', platform, effect: callback => effects.push(callback), props: { load: async () => ({ store: h.left.store, defaults: input(),
      sync: { engine: h.left.sync, synchronize: () => h.left.sync.synchronize(true), onConfigure: () => configured++, ...overrides } }), onBack() {} } });
  const close = effects.shift()(); for (let i = 0; i < 8; i++) await screen.flush();
  const stopStatus = effects.at(-1)(); for (let i = 0; i < 8; i++) await screen.flush();
  return { screen, effects, configured: () => configured, close: () => { close?.(); stopStatus?.(); } };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} private planner cross-device QA route is unavailable in release before any synthetic or real service opens`, () => {
    const prior = globalThis.__DEV__; globalThis.__DEV__ = false;
    try {
      let opened = 0; const screen = screenHarness('src/app/development/private-planner-sync-preview.tsx', { platform,
        mocks: { '../../platform/sharing/private-planner-preview': { createPrivatePlannerPreview: async () => { opened++; throw new Error('must remain closed'); } } } });
      assert.match(screen.text(), /開発ビルド専用/u); assert.equal(opened, 0); assert.equal(screen.nodes().some(node => node.type === 'TextInput'), false);
    } finally { if (prior === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = prior; }
  });
  test(`${platform} private preference synchronization UI shows local versus acknowledged state and freezes edits until a delayed sync finishes`, async t => {
    const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); let release; const wait = new Promise(done => { release = done; });
    h.wire.unavailable = true; await assert.rejects(() => h.left.sync.synchronize(), /offline/u); h.wire.unavailable = false;
    const ui = await open(h, platform, { synchronize: async () => { await wait; return h.left.sync.synchronize(true); } }); t.after(ui.close);
    assert.match(ui.screen.text(), /この端末に保存済み・本人端末への反映待ち/u);
    assert.match(ui.screen.text(), /前回の同期を確認できませんでした/u);
    await ui.screen.press('本人設定を今すぐ同期'); for (let i = 0; i < 5; i++) await ui.screen.flush();
    const limit = ui.screen.nodes().find(n => n.type === 'TextInput' && n.props.accessibilityLabel === '本人の重い家事の上限');
    assert.equal(limit.props.editable, false); limit.props.onChangeText('9'); await ui.screen.flush();
    assert.equal((await h.left.store.read()).loadLimits.heavyDailyLimit, 1);
    release(); for (let i = 0; i < 16; i++) await ui.screen.flush(); assert.equal((await h.left.sync.readStatus()).kind, 'synchronized');
    assert.equal(h.wire.writes, 1); assert.equal((await h.left.store.read()).loadLimits.heavyDailyLimit, 1);
  });
  test(`${platform} private preference synchronization UI keeps both conflict candidates and applies only the explicitly chosen remote configuration`, async t => {
    const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize(); await h.right.sync.synchronize();
    await h.left.store.save(1, { ...input(), timeZone: 'UTC', restDays: [1] }); await h.right.store.save(1, { ...input(), timeZone: 'America/New_York', restDays: [2] });
    await h.right.sync.synchronize(); await h.left.sync.synchronize(); const ui = await open(h, platform); t.after(ui.close);
    assert.match(ui.screen.text(), /別の本人端末と設定が異なります/u); assert.match(ui.screen.text(), /この端末の設定/u);
    assert.match(ui.screen.text(), /UTC/u); assert.match(ui.screen.text(), /America\/New_York/u);
    await ui.screen.press('別の本人端末の設定を使う'); for (let i = 0; i < 16; i++) await ui.screen.flush();
    assert.equal((await h.left.store.read()).timeZone, 'America/New_York'); assert.equal((await h.left.sync.readStatus()).kind, 'synchronized'); assert.equal(h.wire.writes, 2);
  });
  test(`${platform} private preference synchronization UI never starts a network action or discards incomplete new input`, async t => {
    const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); let started = 0;
    const ui = await open(h, platform, { synchronize: async () => started++ }); t.after(ui.close);
    const field = ui.screen.nodes().find(n => n.type === 'TextInput' && n.props.accessibilityLabel === '本人の重い家事の上限');
    field.props.onChangeText(''); await ui.screen.flush(); await ui.screen.press('本人設定を今すぐ同期'); for (let i = 0; i < 8; i++) await ui.screen.flush();
    assert.equal(started, 0); assert.match(ui.screen.text(), /未保存の入力を修正/u); assert.deepEqual((await h.left.store.read()).allowedBands, input().allowedBands);
    assert.equal(ui.screen.nodes().find(n => n.type === 'TextInput' && n.props.accessibilityLabel === '本人の重い家事の上限').props.value, '');
  });
}
