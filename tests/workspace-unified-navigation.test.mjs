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
  test(`${platform} settings separate group controls from personal integrations while preserving every destination`, async () => {
    const selected = [];
    const sections = {
      common: [['グループ名・ルール', '/group-v2/group-rules']],
      google: [['共有家事のGoogle Tasks連携', '/group-v2/google-tasks'], ['共有予定のGoogle表示', '/group-v2/google-calendar']],
      notifications: [['共有家事の通知', '/group-v2/notifications']],
    };
    for (const [section, actions] of Object.entries(sections)) {
      const screen = screenHarness('src/features/sharing/group-management-links.tsx', { platform, exportName: 'GroupManagementLinks', props: { section, busy: false, onSelect: target => selected.push(target) } });
      for (const [title] of actions) await screen.press(title);
      if (['common', 'requests', 'chores'].includes(section)) assert.ok(!screen.text().includes('Google'), 'account integrations do not appear in group-wide settings');
    }
    assert.deepEqual(selected, Object.values(sections).flat().map(([, target]) => target));

  });
}
