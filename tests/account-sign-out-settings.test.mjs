import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

function fixture(platform) {
  const events = []; const state = { saved: true, drainFailure: false, logoutFailure: false, saveGate: null, drainGate: null, acquired: true };
  let releases = 0;
  const workspace = { userId: 'owner', active: { drain: async () => {
    events.push('drain'); if (state.drainGate) await state.drainGate; if (state.drainFailure) throw new Error('write failed');
  } }, refreshSharing: async () => events.push('refresh') };
  const ui = screenHarness('src/features/settings/google-account-switch.tsx', { exportName: 'AccountSignOut', platform,
    layoutEffect: callback => callback(), props: { database: {}, prepare: async () => {
      events.push('save'); if (state.saveGate) await state.saveGate; return state.saved;
    }, acquire: () => state.acquired, release: () => { releases++; } }, mocks: {
      '../../contexts/workspace-context': { WorkspaceContext: { _currentValue: workspace } },
      '../../platform/sharing/auth': { signOutSharing: async () => { events.push('logout'); if (state.logoutFailure) throw new Error('auth failed'); } },
    } });
  return { ui, workspace, events, state, releases: () => releases };
}

for (const [platform, failureName, staleName] of [
  ['ios', 'ios settings logout waits for saved drafts and pending writes and remains retryable after failure',
    'ios settings logout coalesces taps and refuses a stale account or workspace'],
  ['android', 'android settings logout waits for saved drafts and pending writes and remains retryable after failure',
    'android settings logout coalesces taps and refuses a stale account or workspace'],
]) {
  test(failureName, async () => {
    const h = fixture(platform);
    h.state.acquired = false; await h.ui.press('ログアウト'); assert.deepEqual(h.events, []); assert.equal(h.releases(), 0);
    h.state.acquired = true; h.state.saved = false; await h.ui.press('ログアウト');
    assert.deepEqual(h.events, ['save']); assert.match(h.ui.text(), /設定の保存/u);
    h.state.saved = true; h.state.drainFailure = true; h.events.length = 0; await h.ui.press('ログアウト');
    assert.deepEqual(h.events, ['save', 'drain']); assert.match(h.ui.text(), /ログアウトできません/u);
    h.state.drainFailure = false; h.state.logoutFailure = true; h.events.length = 0; await h.ui.press('ログアウト');
    assert.deepEqual(h.events, ['save', 'drain', 'logout']); assert.equal(h.workspace.userId, 'owner');
    h.state.logoutFailure = false; h.events.length = 0; await h.ui.press('ログアウト');
    assert.deepEqual(h.events, ['save', 'drain', 'logout', 'refresh']); assert.equal(h.releases(), 4);
  });

  test(staleName, async () => {
    const h = fixture(platform); let finish;
    h.state.saveGate = new Promise(resolve => { finish = resolve; });
    const press = h.ui.button('ログアウト').props.onPress; press(); press(); await h.ui.flush();
    assert.deepEqual(h.events, ['save']); assert.equal(h.ui.button('ログアウト').props.disabled, true);
    h.workspace.userId = 'replacement'; await h.ui.flush(); finish(); await h.ui.flush();
    assert.deepEqual(h.events, ['save']); assert.equal(h.releases(), 1);
    h.events.length = 0; h.state.saveGate = null;
    h.state.drainGate = new Promise(resolve => { finish = resolve; });
    h.ui.button('ログアウト').props.onPress(); await h.ui.flush(); assert.deepEqual(h.events, ['save', 'drain']);
    h.workspace.active = { drain: async () => assert.fail('the new workspace must not be touched by the old logout') };
    await h.ui.flush(); finish(); await h.ui.flush();
    assert.deepEqual(h.events, ['save', 'drain']); assert.equal(h.releases(), 2);
  });
}
