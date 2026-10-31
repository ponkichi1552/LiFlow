import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const [platform, name] of [
  ['ios', 'ios planner pages show a shared issue warning with a working resolution link only for the active group'],
  ['android', 'android planner pages show a shared issue warning with a working resolution link only for the active group'],
]) test(name, async () => {
  const workspace = { active: { groupId: 'group-test' }, group: null, error: null };
  const issues = { groupId: 'group-test', issueCount: 1 };
  const visits = [];
  const screen = screenHarness('src/components/planner-ui.tsx', { platform, exportName: 'Page', navigate: (...args) => visits.push(args), mocks: {
    '../contexts/workspace-context': { WorkspaceContext: { _currentValue: workspace } },
    '../contexts/planner-issues-context': { PlannerIssuesContext: { _currentValue: issues } },
  } });
  assert.ok(screen.text().includes('確認が必要な項目があります（1件）'));
  await screen.press('共有データを確認する');
  assert.deepEqual(visits, [['push', '/sharing']]);
  issues.issueCount = 0; screen.render();
  assert.ok(!screen.text().includes('確認が必要'));
  issues.issueCount = 2; issues.groupId = 'another-group'; screen.render();
  assert.ok(!screen.text().includes('確認が必要'), 'a group switch must not show stale issues');
  issues.groupId = 'group-test'; workspace.active = null; screen.render();
  assert.ok(!screen.text().includes('確認が必要'), 'personal mode must remain independent');
  workspace.active = { groupId: 'group-test' }; screen.render();
  assert.ok(screen.text().includes('確認が必要な項目があります（2件）'));
});
