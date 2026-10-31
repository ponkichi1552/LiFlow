import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
const repository = await import('../src/platform/storage/repository.ts');

for (const platform of ['ios', 'android']) {
  test(`${platform} unjoined home and settings omit personal scope labels while joined settings retain the distinction`, async () => {
    const home = screenHarness('src/components/home-ui.tsx', { exportName: 'HomeHeader', platform, props: { today: '2026-10-31' } });
    assert.equal(home.text().includes('個人'), false); home.button('グループを開く');
    const group = { userId: 'owner', groupId: 'group', status: 'active' }; const context = { _currentValue: null };
    const audience = screenHarness('src/components/settings-audience.tsx', { exportName: 'SettingsAudience', platform,
      mocks: { '../contexts/workspace-context': { WorkspaceContext: context } } });
    assert.equal(audience.text(), ''); context._currentValue = { userId: 'owner', group }; audience.render(); assert.match(audience.text(), /個人用/u);
    context._currentValue = { userId: 'other', group }; audience.render(); assert.equal(audience.text(), '');
    const f = await privateFixture(); try {
      const snapshot = (await repository.readPersonalPlannerOverlaySnapshot(f.database)).snapshot;
      const sources = screenHarness('src/features/settings/chore-settings-sources.tsx', { exportName: 'ChoreSettingsSources', platform,
        personalData: () => ({ database: f.database, snapshot, refresh: async () => {}, readError: () => null }),
        mocks: { '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: null } } } });
      assert.equal(sources.text().includes('個人用'), false); assert.equal(sources.text().includes('グループ'), false);
      assert.ok(sources.text().includes(f.chore.category));
    } finally { f.connection.close(); }
  });
  test(`${platform} a private chore with a guide callback navigates without toggling inline details or completing the chore`, async () => {
    let opened = 0; let saves = 0; const row = { key: 'private', revision: 'revision', date: '2026-10-31', suggestedDate: '2026-10-31',
      completed: false, chore: { id: 'chore', name: '自分の家事', category: '水回り', estimatedMinutes: 15, instructions: ['手順'], load: 'light' } };
    const screen = screenHarness('src/features/sharing/v2-ui/private-task-card.tsx', { exportName: 'V2PrivateTaskCard', platform, props: {
      row, home: true, busy: false, onOpen: () => { opened++; }, run: work => work(), source: { setCompleted: async () => { saves++; } },
    } });
    assert.equal(screen.button('自分の家事の説明を開く').props.accessibilityState, undefined);
    await screen.press('自分の家事の説明を開く'); assert.equal(opened, 1); assert.equal(saves, 0);
    assert.equal(screen.text().includes('手順'), false);
  });
}
