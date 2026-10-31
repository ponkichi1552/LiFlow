import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform} personal and joined workspaces keep identical tab identities and group aliases retain date parameters`, () => {
    const context = { _currentValue: null };
    for (const view of ['home', 'calendar', 'chores', 'appliances']) {
      const screen = screenHarness('src/components/workspace-tab.tsx', { platform, exportName: 'WorkspaceTab', props: { view, children: 'private-content' }, mocks: { '../contexts/workspace-context': { WorkspaceContext: context } } });
      assert.match(screen.text(), /private-content/u); context._currentValue = { active: { protocol: 2 } }; screen.render();
      assert.equal(screen.text().includes('private-content'), false);
      assert.equal(screen.nodes().find(node => node.type === 'V2WorkspaceRoute').props.view, view);
      assert.ok(screen.nodes().some(node => node.type === 'TabsScreen' && node.props.options.tabBarStyle.display !== 'none'));
      context._currentValue = null;
    }
    for (const [file, target] of [['index', '/(tabs)'], ['calendar', '/(tabs)/explore'], ['chores', '/(tabs)/guide'], ['appliances', '/(tabs)/manual']]) {
      const params = { anchorDate: '2026-10-31', calendarDraft: 'draft-reference' };
      const alias = screenHarness(`src/app/group-v2/${file}.tsx`, { platform, params, mocks: { 'expo-router': { Redirect: 'Redirect', useLocalSearchParams: () => params } } });
      assert.deepEqual(alias.nodes().find(node => node.type === 'Redirect').props.href, { pathname: target, params });
    }
  });
  test(`${platform} group management keeps requests rules notifications history and Google export reachable outside the home list`, async () => {
    const selected = []; const screen = screenHarness('src/features/sharing/group-management-links.tsx', { platform, exportName: 'GroupManagementLinks', props: { busy: false, onSelect: target => selected.push(target) } });
    const actions = [['日時の変更申請', '/group-v2/requests'], ['担当の変更申請', '/group-v2/assignment-requests'], ['グループのルール', '/group-v2/group-rules'], ['この端末の共有通知', '/group-v2/notifications'], ['共有家事とGoogle Tasks', '/group-v2/google-tasks'], ['共有予定をGoogleにも表示', '/group-v2/google-calendar'], ['個人家事から追加', '/group-v2/personal-copy'], ['ゴミ収集日', '/group-v2/waste'], ['実施履歴', '/group-v2/history']];
    for (const [title] of actions) await screen.press(title);
    assert.deepEqual(selected, actions.map(([, target]) => target));
  });
}
