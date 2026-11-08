import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');

function fixture(platform, extraProps = {}) {
  const events = []; let saved = true; let cancel = false; let blocked;
  const group = { groupId: 'group-test', userId: 'owner' };
  const workspace = { userId: 'owner', group, active: { drain: async () => events.push('drain') }, refreshSharing: async () => events.push('refresh') };
  const screen = screenHarness('src/features/settings/google-account-switch.tsx', { exportName: 'GoogleAccountSwitch', platform,
    layoutEffect: callback => callback(), props: { database: {}, prepare: async () => { events.push('save'); if (blocked) await blocked; return saved; }, ...extraProps }, mocks: {
      '../../contexts/workspace-context': { WorkspaceContext: { _currentValue: workspace } },
      '../google-sync/account-switch': { changeGoogleAccount: async () => { events.push('select'); if (cancel) throw new Error('synthetic cancellation'); } },
    } });
  return { screen, workspace, group, events, saved: value => { saved = value; }, cancel: value => { cancel = value; }, block: value => { blocked = value; } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} account selection shares the Google settings lock and refreshes same-user connection controls after success`, async () => {
    let acquired = false; let released = 0; let refreshed = 0;
    const h = fixture(platform, { acquire: () => acquired, release: () => { released++; }, onChanged: async () => { refreshed++; } });
    await h.screen.press('Googleアカウントを変更'); assert.deepEqual(h.events, []); assert.equal(released, 0);
    acquired = true; h.cancel(true); await h.screen.press('Googleアカウントを変更'); assert.equal(released, 1); assert.equal(refreshed, 0);
    h.cancel(false); await h.screen.press('Googleアカウントを変更'); assert.equal(released, 2); assert.equal(refreshed, 1);
  });
  test(`${platform} personal settings exposes account selection only in account controls and blocks unsaved drafts`, async () => {
    const database = createDatabase();
    try {
      await repository.initializeLocalDatabase(database.database);
      const snapshot = await repository.loadPlannerSnapshot(database.database, '2026-11-05');
      const events = []; let saved = false;
      const context = { _currentValue: { userId: 'owner', active: { drain: async () => events.push('drain') }, refreshSharing: async () => events.push('refresh') } };
      const screen = screenHarness('src/app/settings.tsx', { exportName: 'SettingsContent', platform,
        transformSource: (path, source) => path.endsWith('/src/app/settings.tsx') ? source + '\nexport { SettingsContent };' : source,
        layoutEffect: callback => callback(),
        props: { section: 'account', snapshot, database: database.database, refresh: async () => {} }, mocks: {
          '@/contexts/workspace-context': { WorkspaceContext: context }, '../../contexts/workspace-context': { WorkspaceContext: context },
          '../google-sync/account-switch': { changeGoogleAccount: async () => events.push('select') },
          '../../platform/sharing/auth': { signOutSharing: async () => events.push('logout') },
          '@/features/google-sync/background-task': {},
          '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: false }) },
          '@/platform/google-tasks/google-sign-in-gateway': { hasGoogleTasksSession: async () => false },
          '@/features/settings/use-settings-autosave': { useSettingsAutosave: () => ({ status: { phase: 'idle' }, flush: async () => { events.push('save'); return saved; } }) },
          '@/features/settings/personal-capacity-settings': { PersonalCapacitySettings: () => assert.fail('the account page must not mount unrelated rhythm inputs') },
        } });
      assert.ok(screen.button('Googleアカウントを変更'));
      await screen.press('Googleアカウントを変更');
      assert.deepEqual(events, ['save']); assert.match(screen.text(), /設定の保存/);
      saved = true; await screen.flush(); events.length = 0;
      await screen.press('Googleアカウントを変更'); assert.deepEqual(events, ['save', 'drain', 'select', 'refresh']);
      events.length = 0;
      await screen.press('ログアウト'); assert.deepEqual(events, ['save', 'drain', 'logout', 'refresh']);
    } finally { database.connection.close(); }
  });
  test(`${platform} account selection saves local settings then drains writes without a logout or group change`, async () => {
    const h = fixture(platform); await h.screen.press('Googleアカウントを変更');
    assert.deepEqual(h.events, ['save', 'drain', 'select', 'refresh']); assert.equal(h.workspace.group, h.group);
    h.saved(false); h.events.length = 0; await h.screen.press('Googleアカウントを変更');
    assert.deepEqual(h.events, ['save']); assert.match(h.screen.text(), /設定の保存/); assert.equal(h.workspace.group, h.group);
  });
  test(`${platform} cancellation preserves the old account and lets account selection retry`, async () => {
    const h = fixture(platform); h.cancel(true); await h.screen.press('Googleアカウントを変更');
    assert.deepEqual(h.events, ['save', 'drain', 'select']); assert.equal(h.workspace.userId, 'owner'); assert.equal(h.workspace.group, h.group);
    assert.match(h.screen.text(), /変更を完了できません/);
    h.cancel(false); await h.screen.press('Googleアカウントを変更');
    assert.deepEqual(h.events.slice(-4), ['save', 'drain', 'select', 'refresh']);
  });
  test(`${platform} repeated selection taps open one account picker and a stale settings owner cannot authenticate`, async () => {
    const h = fixture(platform); let release; h.block(new Promise(resolve => { release = resolve; }));
    const press = h.screen.button('Googleアカウントを変更').props.onPress; press(); press();
    assert.deepEqual(h.events, ['save']); await h.screen.flush(); release(); await h.screen.flush();
    assert.deepEqual(h.events, ['save', 'drain', 'select', 'refresh']);
    h.events.length = 0; h.block(new Promise(resolve => { release = resolve; }));
    h.screen.button('Googleアカウントを変更').props.onPress();
    h.workspace.userId = 'replacement'; await h.screen.flush(); release(); await h.screen.flush();
    assert.deepEqual(h.events, ['save']); assert.match(h.screen.text(), /変更を完了できません/);
  });
}
