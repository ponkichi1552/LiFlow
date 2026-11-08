import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';

async function open(runtime, platform, operation = null) {
  let mount; const screen = screenHarness('src/features/sharing/private-calendar/source-screen.tsx', { exportName: 'PrivateCalendarSourceScreen', platform,
    effect: callback => { mount ??= callback; }, props: { embedded: Boolean(operation), loadRuntime: async () => runtime, onBack() {}, onDevices() {} },
    mocks: operation ? { '../../settings/account-operation': { useAccountOperation: () => operation } } : {} });
  const close = mount(); for (let i = 0; i < 40 && screen.nodes().some(node => node.type === 'ActivityIndicator'); i++) await screen.flush();
  assert.equal(screen.nodes().some(node => node.type === 'ActivityIndicator'), false); return { screen, close };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} inline private Calendar source shares the account lock and releases it after a failed action`, async t => {
    const f = privateCalendarRuntimeFixture(t); await f.devices.initializeFirstDevice(); let busy = true; let releases = 0;
    const operation = { get busy() { return busy; }, acquire() { if (busy) return false; busy = true; return true; }, release() { busy = false; releases++; } };
    const runtime = f.open(); const ui = await open(runtime, platform, operation); t.after(ui.close);
    const action = ui.screen.button('Googleアカウントを確認').props.onPress;
    await action(); assert.equal(f.state.checks, 0); assert.equal(releases, 0);
    busy = false; ui.screen.render(); await action(); assert.equal(f.state.checks, 1); assert.equal(releases, 1);
    runtime.checkGoogleAccount = async () => { throw new Error('synthetic account failure'); };
    await action(); await ui.screen.flush(); assert.equal(busy, false); assert.equal(releases, 2); assert.match(ui.screen.text(), /保存済みの内容は保持/u);
    assert.equal(f.state.googleReads, 0); assert.deepEqual(f.state.consents, []);
  });
  test(`${platform} private Calendar source screen previews the Google identity before explicit consent and confirms stopping without revoking Tasks`, async t => {
    const f = privateCalendarRuntimeFixture(t); await f.devices.initializeFirstDevice(); const runtime = f.open(); const ui = await open(runtime, platform); t.after(ui.close);
    assert.equal(f.state.checks, 0); assert.deepEqual(f.state.consents, []); assert.equal(f.state.googleReads, 0);
    await ui.screen.press('Googleアカウントを確認'); assert.match(ui.screen.text(), /Synthetic Google account/u); assert.deepEqual(f.state.consents, []);
    await ui.screen.press('このアカウントで接続'); assert.deepEqual(f.state.consents, [f.googleSubject]); assert.equal(f.state.googleReads, 1);
    assert.match(ui.screen.text(), /空き時間を更新しました/u); const before = (await runtime.readSettings()).device.authorityDigest;
    await ui.screen.press('Google Calendarの取得を停止'); assert.equal((await runtime.readSettings()).device.authorityDigest, before);
    await ui.screen.press('取得を続ける'); assert.equal((await runtime.readSettings()).connected, true);
    await ui.screen.press('Google Calendarの取得を停止'); await ui.screen.press('確認して取得を停止');
    assert.equal((await runtime.readSettings()).connected, false); assert.notEqual((await runtime.readSettings()).device.authorityDigest, before);
    assert.equal(await runtime.readForPlan(), null); assert.equal(f.state.googleReads, 1); assert.equal((await f.f.readProtected()).hasStoredKeys, true);
  });

  test(`${platform} private Calendar source screen restores a missing Native Google session only after a separate explicit action`, async t => {
    const f = privateCalendarRuntimeFixture(t); await f.devices.initializeFirstDevice(); const account = f.state.account; f.state.account = null;
    f.port.restoreGoogleAccount = async () => { f.state.restores++; f.state.account = account; return account; };
    const ui = await open(f.open(), platform); t.after(ui.close); assert.equal(f.state.restores, 0);
    await ui.screen.press('Googleアカウントを確認'); assert.equal(f.state.restores, 0); assert.equal(f.state.googleReads, 0);
    await ui.screen.press('この端末でGoogleログインを確認'); assert.equal(f.state.restores, 1); assert.deepEqual(f.state.consents, []);
    assert.match(ui.screen.text(), /Synthetic Google account/u); assert.equal(f.transport.history.length, 1);
  });

  test(`${platform} private Calendar source screen retains an unacknowledged source switch and resumes it without repeated consent or a new revision`, async t => {
    const f = privateCalendarRuntimeFixture(t); await f.devices.initializeFirstDevice(); const runtime = f.open(); const ui = await open(runtime, platform); t.after(ui.close);
    await ui.screen.press('Googleアカウントを確認'); f.transport.flags.controlReplyLost = true; await ui.screen.press('このアカウントで接続');
    assert.match(ui.screen.text(), /受付の確認待ち/u); assert.equal(f.state.googleReads, 0); assert.equal(f.transport.history.length, 2);
    await ui.screen.press('保存した変更の受付を確認・再開'); assert.equal((await runtime.readSettings()).pendingTargetDigest, null);
    assert.equal(f.transport.history.length, 2); assert.equal(f.state.consents.length, 1); assert.equal(f.state.googleReads, 0);
    await ui.screen.press('最新の時間帯を取得・同期'); assert.equal(f.state.googleReads, 1); assert.match(ui.screen.text(), /空き時間を更新しました/u);
  });

  test(`${platform} closing private Calendar source before initialization prevents late reads and queued user actions`, async () => {
    let resolve; let mount; let reads = 0; const pending = new Promise(done => { resolve = done; });
    const screen = screenHarness('src/features/sharing/private-calendar/source-screen.tsx', { exportName: 'PrivateCalendarSourceScreen', platform,
      effect: callback => { mount ??= callback; }, props: { loadRuntime: () => pending, onBack() {}, onDevices() {} } });
    const cleanup = mount(); const queued = screen.button('取得元の設定を再読込').props.onPress; cleanup();
    resolve({ readSettings: async () => { reads++; throw new Error('must not read after closing'); } }); await screen.flush(); await queued();
    assert.equal(reads, 0); assert.equal(screen.button('取得元の設定を再読込').props.disabled, true);
  });
}

test('private Calendar source route requires an authenticated UID before composing Native Google or protected services', async () => {
  let opens = 0; const moves = []; const screen = screenHarness('src/app/sharing/private-calendar-source.tsx', { mocks: {
    '../../hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: null }) },
    '../../platform/sharing/private-calendar-runtime': { openPrivateCalendarRuntime: () => { opens++; throw new Error('must not open'); } },
  }, navigate: (...args) => moves.push(args) });
  assert.equal(opens, 0); await screen.press('共有用アカウントへ'); assert.deepEqual(moves.at(-1), ['replace', '/sharing']);
});
