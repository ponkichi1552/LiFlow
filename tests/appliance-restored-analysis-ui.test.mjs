import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { validateSharedOperation } from '../src/features/sharing/operations.ts';
const url = 'https://www.dyson.co.jp/support/SV20';
const task = { name: 'フィルター清掃', steps: ['冷水で洗う'], tools: [], safetyCautions: [], recommendedConditions: ['乾いてから戻す'], evidence: [{ url }] };
const analysis = { manufacturer: 'Dyson', model: 'SV20', analyzedAt: '2026-10-28T00:00:00Z', requiresUserReview: true, tasks: [task] };
function context(value) { return { appliance: { id: 'stored-appliance', manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', displayName: 'V12', officialManualUrl: url, analysis: value }, chores: [] }; }
for (const platform of ['ios', 'android']) {
  test(`${platform} restored appliance details retain unsafe nested analysis values for repair instead of crashing`, async () => {
    const cases = [null, { ...analysis, tasks: null }, { ...analysis, tasks: [null] },
      ...[{ recommendedConditions: '乾燥後' }, { steps: { text: '洗う' } }, { tools: [null] }, { safetyCautions: {} },
        { estimatedMinutes: { minutes: 5 } }, { recommendedIntervalDays: { days: 30 } }, { evidence: [{ url, pageOrSection: {} }] }]
        .map(patch => ({ ...analysis, tasks: [{ ...task, ...patch }] }))];
    for (const value of cases) {
      const calls = []; let screen;
      assert.doesNotThrow(() => { screen = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'ApplianceDetailContent', platform,
        props: { context: context(value), returnTo: '/manual' }, navigate: (...args) => calls.push(args) }); });
      assert.match(screen.text(), /解析結果に確認が必要/u); assert.match(screen.text(), /保存された内容は保持/u);
      assert.equal(screen.nodes().some(node => node.type === 'FlatList'), false);
      await screen.press('一覧へ戻る'); assert.deepEqual(calls.at(-1), ['dismissTo', '/manual']);
      await screen.press('この家電を再解析'); assert.deepEqual(calls.at(-1), ['push', { pathname: '/manual/appliance-care', params: { applianceId: 'stored-appliance', returnTo: '/manual' } }]);
    }
  });
  test(`${platform} a signed legacy appliance shape that passed its original wire validator can be read safely without rewriting that history`, () => {
    const value = { ...analysis, tasks: [{ ...task, recommendedConditions: { when: '乾燥後' } }] };
    const operation = validateSharedOperation({ schemaVersion: 1, operationId: 'legacy-appliance', groupId: 'legacy-group', authorUserId: 'owner', authorDeviceId: 'owner-device',
      deviceSequence: 1, logicalClock: 1, context: {}, keyVersion: 1, entityType: 'appliance', entityId: 'stored-appliance', operationType: 'patch', payload: { analysis: value, reviewed: true } });
    const original = JSON.stringify(operation); const screen = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'ApplianceDetailContent', platform,
      props: { context: context(operation.payload.analysis) } });
    assert.match(screen.text(), /解析結果に確認が必要/u); assert.equal(JSON.stringify(operation), original);
  });
  test(`${platform} existing readable appliance analyses keep condition-only tasks empty histories while omitting reference links`, () => {
    const value = { analyzedAt: analysis.analyzedAt, tasks: [{ ...task, steps: [], evidence: [{ url: 'https://example.test/untrusted', pageOrSection: '参考資料' }] }] };
    const screen = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'ApplianceDetailContent', platform, props: { context: context(value) } });
    assert.match(screen.text(), /フィルター清掃/u); assert.match(screen.text(), /定期予定なし/u); assert.match(screen.text(), /乾いてから戻す/u);
    assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'link'), false, 'reference links are omitted without rewriting the saved evidence');
    assert.equal(value.tasks[0].evidence[0].url, 'https://example.test/untrusted');
    const empty = screenHarness('src/features/appliance-care/appliance-detail-content.tsx', { exportName: 'ApplianceDetailContent', platform,
      props: { context: context({ analyzedAt: analysis.analyzedAt, tasks: [] }) } });
    assert.equal(empty.nodes().find(node => node.type === 'FlatList').props.data.length, 0);
  });
}
