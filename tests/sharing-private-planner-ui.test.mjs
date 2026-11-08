import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';

const defaults = { timeZone: 'Asia/Tokyo', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] };
async function open(t, platform, options = {}) {
  const f = privateCalendarSetupFixture(t, { userId: 'private-preferences-screen-owner' }); let saves = 0; let back = 0; let prevent;
  const actual = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.vault, exclusive: f.exclusive,
    assertOwner: owner => assert.equal(f.state.currentUser, owner, 'account changed') });
  const store = { read: actual.read, save: async (...args) => { saves++; return actual.save(...args); } };
  const effects = [];
  const screen = screenHarness('src/features/sharing/private-planner/preference-screen.tsx', { exportName: 'PrivatePreferenceScreen', platform,
    effect: callback => effects.push(callback), preventRemove: (enabled, callback) => { prevent = { enabled, callback }; },
    props: { load: async () => ({ store, defaults }), onBack: () => back++, ...options } });
  const cleanup = effects.shift()(); t.after(cleanup);
  for (let n = 0; n < 15 && !screen.text().includes('本人の地域'); n++) await screen.flush();
  const field = name => { const node = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === name); assert.ok(node, name); return node; };
  const fill = async (name, text) => { field(name).props.onChangeText(text); await screen.flush(); };
  const blur = async name => { field(name).props.onBlur(); for (let n = 0; n < 8; n++) await screen.flush(); };
  return { f, actual, store, screen, field, fill, blur, effects, saves: () => saves, back: () => back, prevent: () => prevent };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} inline preference sync shows actionable state and preserves retry errors without starting synchronization on open`, async () => {
    let status = { configured: false, kind: 'empty' }; let changed; let syncs = 0;
    const screen = screenHarness('src/features/sharing/private-planner/preference-screen.tsx', { exportName: 'PrivatePreferenceScreen', platform,
      effectDependencies: true, effect: fn => fn(), props: { embedded: true, syncOnly: true, onBack() {}, load: async () => ({ defaults,
        store: { read: async () => null, subscribe: callback => { changed = callback; return () => {}; }, save: async () => { throw new Error('no edits expected'); } },
        sync: { engine: { readStatus: async () => status }, synchronize: async () => { syncs++; throw new Error('synthetic failure'); }, onConfigure() {} },
      }) } });
    try {
      for (let n = 0; n < 8; n++) await screen.flush();
      assert.doesNotMatch(screen.text(), /端末未設定|同期する変更はありません/u); assert.equal(syncs, 0);
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button' && node.children?.includes('今すぐ同期')), false);
      status = { configured: true, kind: 'empty' }; changed(); for (let n = 0; n < 5; n++) await screen.flush();
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button' && node.children?.includes('今すぐ同期')), false);
      status = { configured: true, kind: 'pending' }; changed(); for (let n = 0; n < 5; n++) await screen.flush();
      assert.match(screen.text(), /同期待ち/u); await screen.press('今すぐ同期'); for (let n = 0; n < 5; n++) await screen.flush();
      assert.equal(syncs, 1); assert.match(screen.text(), /保存済みの設定と送信待ちは保持/u); screen.button('今すぐ同期');
    } finally { screen.unmount(); }
  });

  test(`${platform} account synchronization does not repeat daily planning inputs or require device setup for local edits`, async t => {
    const ui = await open(t, platform, { syncOnly: true });
    assert.match(ui.screen.text(), /設定の端末間同期/u); assert.equal(ui.screen.nodes().some(node => node.type === 'TextInput'), false);
    assert.equal(ui.saves(), 0); assert.equal(await ui.actual.read(), null);
  });
  test(`${platform} private preference UI autosaves daily limits without exposing inactive time relocation controls`, async t => {
    const ui = await open(t, platform); assert.equal(ui.saves(), 0); assert.equal(await ui.actual.read(), null);
    assert.match(ui.screen.text(), /本人向けの推奨/u); assert.match(ui.screen.text(), /他のメンバーには公開されません/u);
    assert.equal(ui.screen.text().includes('自動移動'), false); assert.equal(ui.screen.nodes().some(n => n.props.accessibilityLabel?.includes('時間帯を追加')), false);
    await ui.fill('本人の重い家事の上限', '3'); await ui.blur('本人の重い家事の上限');
    assert.equal((await ui.actual.read()).loadLimits.heavyDailyLimit, 3); assert.deepEqual((await ui.actual.read()).allowedBands, []);
    await ui.screen.press('保存済みの本人設定を再読込'); const closeReload = ui.effects.at(-1)(); t.after(closeReload);
    for (let n = 0; n < 8; n++) await ui.screen.flush();
    assert.equal(ui.field('本人の重い家事の上限').props.value, '3'); assert.equal((await ui.actual.read()).revision, 1);
  });

  test(`${platform} private preference UI discards incomplete input on hardware and visible back without blocking`, async t => {
    const ui = await open(t, platform); await ui.fill('本人の重い家事の上限', '');
    assert.equal(ui.prevent().enabled, true); let repeated = 0; ui.prevent().callback({ repeat: () => repeated++ });
    for (let n = 0; n < 6; n++) await ui.screen.flush(); assert.equal(repeated, 1);
    assert.equal(ui.saves(), 0); assert.equal(await ui.actual.read(), null);
    const visible = await open(t, platform); await visible.fill('本人の重い家事の上限', '');
    await visible.screen.press('前の画面に戻る'); assert.equal(visible.back(), 1);
    assert.equal(visible.saves(), 0); assert.equal(await visible.actual.read(), null);

  });

  test(`${platform} private preference route rejects unauthenticated access before Native protected storage opens`, async () => {
    let opened = 0; const moves = [];
    const screen = screenHarness('src/app/sharing/personal-preferences.tsx', { platform, mocks: {
      '../../hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: null }) },
      '../../hooks/use-planner-data': { usePlannerData: () => ({ snapshot: null }) },
      '../../platform/sharing/private-calendar-secrets': { nativePrivatePlannerPreferences: () => { opened++; throw new Error('must not open'); } },
      '../../platform/sharing/private-calendar-runtime': { openPrivateCalendarRuntime: () => { opened++; throw new Error('must not open runtime'); } },
    }, navigate: (...args) => moves.push(args) });
    assert.equal(opened, 0); await screen.press('共有用アカウントへ'); assert.deepEqual(moves.at(-1), ['replace', '/sharing']);
  });

  test(`${platform} invalid initial private preferences show a recoverable read error instead of crashing the editor or saving defaults`, async t => {
    let writes = 0;
    const ui = await open(t, platform, { load: async () => ({ defaults: { ...defaults, timeZone: 'Invalid/Zone' },
      store: { read: async () => null, save: async () => writes++ } }) });
    assert.match(ui.screen.text(), /保存済み設定を読み込めません/u); assert.equal(writes, 0); assert.equal(ui.screen.nodes().some(n => n.type === 'TextInput'), false);
  });
}

test('closing private preference settings before its loader resolves prevents a late protected read', async () => {
  let resolve; let effect; let reads = 0; const waiting = new Promise(done => { resolve = done; });
  const screen = screenHarness('src/features/sharing/private-planner/preference-screen.tsx', { exportName: 'PrivatePreferenceScreen',
    effect: callback => { effect ??= callback; }, props: { load: () => waiting, onBack() {} } });
  const cleanup = effect(); cleanup(); resolve({ defaults, store: { read: async () => { reads++; return null; } } }); await screen.flush();
  assert.equal(reads, 0);
});
