import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

function fixture(platform = 'ios') {
  const updates = []; let entries = []; let timelineReads = 0; let fail = false;
  const module = loadNativeModule('src/platform/widgets/expo-widget-gateway.ts', {
    'react-native': { Platform: { OS: platform } },
    '@/platform/widgets/NextChoreWidget': {
      __esModule: true, default: {
        updateSnapshot(snapshot) { if (fail) throw new Error('Native update failed'); updates.push(snapshot); },
        async getTimeline() { timelineReads++; return entries; },
      },
    },
  });
  return { ...module, gateway: module.expoWidgetGateway, updates, setTimeline(value) { entries = value; }, reads: () => timelineReads, setFailure(value) { fail = value; } };
}

const snapshot = { chores: [{ id: 'one', name: '掃除', completed: true }], remainingCount: 0, updatedAt: '2026-10-26T00:00:00Z' };

test('iOS decodes durable native input and acknowledges only exact committed operation IDs without replacing display props', async () => {
  const h = fixture(); const operation = { id: 'completion-intent.00000000-0000-4000-8000-000000000001', accountScope: 'owner',
    acceptedAtMs: Date.parse('2026-11-05T00:00:00Z'), householdCreatedAt: '2026-11-01T00:00:00Z', completedLocalDate: '2026-11-05', timeZone: 'Asia/Tokyo',
    entry: { id: 'row', choreId: 'chore', householdId: 'local-household', cycleBaseDate: '2026-11-05', suggestedDate: '2026-11-05', windowStart: '2026-11-05',
      windowEnd: '2026-11-05', status: 'scheduled', assignedMemberIds: [] } };
  h.setTimeline([{ date: new Date(), props: { nativeWidgetInputVersion: 1, nativeWidgetCompletionOperations: [operation] } }]);
  assert.deepEqual(await h.readIOSWidgetCompletionOperations(), [operation]);
  await h.acknowledgeIOSWidgetCompletionOperations([operation.id]);
  assert.deepEqual(h.updates, [{ __liflowAckOnly: true, __liflowAcknowledgedOperationIds: [operation.id] }]);
  h.setFailure(true); await assert.rejects(h.acknowledgeIOSWidgetCompletionOperations([operation.id]), /Native update failed/);
  h.setTimeline([{ date: new Date(), props: { nativeWidgetInputVersion: 1, nativeWidgetCompletionOperations: [operation, operation] } }]);
  await assert.rejects(h.readIOSWidgetCompletionOperations(), /重複/);
  h.setTimeline([{ date: new Date(), props: { pendingWidgetCompletionIds: ['row'] } }]);
  await assert.rejects(h.readIOSWidgetCompletionOperations(), /更新/);
});

test('iOS acknowledges a pending widget tap even when the planner content was already published', async () => {
  const h = fixture();
  await h.gateway.updateNextChore(snapshot);
  await h.gateway.updateNextChore({ ...snapshot, updatedAt: '2026-10-26T00:01:00Z' });
  assert.equal(h.updates.length, 1);
  h.setTimeline([{ date: new Date('2026-10-25'), props: { pendingWidgetCompletionIds: ['old'] } },
    { date: new Date('2026-10-26'), props: { pendingWidgetCompletionIds: ['one'] } }]);
  assert.deepEqual(await h.gateway.getPendingWidgetCompletionIds(), ['one']);
  await h.gateway.updateNextChore(snapshot);
  assert.equal(h.updates.length, 2, 'native actions must be acknowledged even if the chore was already completed');
  assert.deepEqual(h.updates.at(-1).pendingWidgetCompletionIds, []);
  h.setTimeline([{ date: new Date('2026-10-26'), props: h.updates.at(-1) }]);
  assert.deepEqual(await h.gateway.getPendingWidgetCompletionIds(), []);
  await h.gateway.updateNextChore(snapshot);
  assert.equal(h.updates.length, 2, 'acknowledged, unchanged content should remain deduplicated');
});

for (const platform of ['ios', 'android']) {
  test(`${platform} widget retries failed publishing and deduplicates successful unchanged content`, async () => {
    const h = fixture(platform);
    h.setFailure(true);
    await assert.rejects(() => h.gateway.updateNextChore(snapshot), /Native update failed/);
    h.setFailure(false);
    await h.gateway.updateNextChore(snapshot);
    assert.deepEqual(await h.gateway.getPendingWidgetCompletionIds(), []);
    await h.gateway.updateNextChore(snapshot);
    assert.equal(h.updates.length, 1);
    assert.equal(h.reads(), platform === 'ios' ? 1 : 0);
  });
}
