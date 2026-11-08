import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectPersonalHistory } from '../src/features/planner/personal-history-selection.ts';
import { sharedMirrorEntryId } from '../src/features/planner/common-chore-links.ts';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const row = (id, extra = {}) => ({ id, householdId: 'own-household', choreId: id, outcome: 'completed', completedAt: now().toISOString(), ...extra });
const personalSource = completions => ({ snapshot: { completions, timeZone: 'Asia/Tokyo', chores: completions.map(item => ({ id: item.choreId, name: item.choreId })) }, database: {}, refresh: async () => {} });

test('history excludes only the active group learning mirror and preserves unrelated personal records without rewriting them', () => {
  const privateRow = row('private-work');
  const mirror = row('hidden-group-mirror', { scheduleEntryId: sharedMirrorEntryId(groupId, 'floor', 'round', 'private-work') });
  const pastGroup = row('previous-group-work', { scheduleEntryId: sharedMirrorEntryId('past-group', 'old', 'round', 'old') });
  const records = [privateRow, mirror, pastGroup]; const before = JSON.stringify(records);
  assert.deepEqual(new Set(selectPersonalHistory(records, { groupId }).map(item => item.id)), new Set([privateRow.id, pastGroup.id]));
  assert.equal(selectPersonalHistory(records).length, 3);
  assert.equal(JSON.stringify(records), before);
});

test('cancelled personal records stay stored but leave the history list and its completion total', () => {
  const undone = row('undone-work', { outcome: 'incomplete' });
  const data = { snapshot: { ...personalSource([undone]).snapshot, today: '2026-11-09' }, loading: false, error: null, refresh: async () => {} };
  assert.deepEqual(selectPersonalHistory([undone]), []);
  const screen = screenHarness('src/features/planner/history-content.tsx', { exportName: 'PlannerHistoryContent', props: { data } });
  assert.match(screen.text(), /実施履歴はありません/); assert.doesNotMatch(screen.text(), /undone-work|今月の完了/);
  assert.deepEqual(data.snapshot.completions, [undone]); screen.unmount();
});

for (const platform of ['ios', 'android']) test(`${platform} unified history shows own private work beside authorized group work and never reveals a hidden completion through its learning mirror`, async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[0].payload.configuration.showCompletionStatus = false;
    initial[3].payload.configuration.policy = { completion: 'one', assignment: { mode: 'selected', memberIds: ['owner'] } };
    await d.repository.commit(initial);
    const controller = createV2GroupController(d.repository, { makeId: () => 'history-completed', now, sync: async () => {} });
    await controller.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null });
    const ownerModel = await controller.readModel(range);
    const privateRow = row('my-private-work');
    const mirror = row('hidden-group-mirror', { scheduleEntryId: sharedMirrorEntryId(groupId, 'floor', 'round', 'my-private-work') });
    const personal = personalSource([privateRow, mirror]);
    const props = { model: ownerModel, personal, actions: controller.actions, busy: false, run: work => work(), onBack() {} };
    const owner = screenHarness('src/features/sharing/v2-ui/history-content.tsx', { exportName: 'V2HistoryContent', platform, props });
    assert.match(owner.text(), /my-private-work/); assert.doesNotMatch(owner.text(), /hidden-group-mirror/);
    assert.match(owner.text(), /床を掃除/); assert.equal(owner.nodes().some(node => node.props.accessibilityLabel === 'この完了を取り消す'), false);
    const member = screenHarness('src/features/sharing/v2-ui/history-content.tsx', { exportName: 'V2HistoryContent', platform,
      props: { ...props, model: { ...ownerModel, viewerUserId: 'member' } } });
    assert.match(member.text(), /my-private-work/); assert.doesNotMatch(member.text(), /床を掃除|hidden-group-mirror/);
    assert.equal(member.nodes().some(node => node.props.accessibilityLabel === 'この完了を取り消す'), false);
    assert.equal(ownerModel.plan.history.length, 1); assert.equal(ownerModel.plan.history[0].active, true);
    const scoped = screenHarness('src/features/sharing/v2-ui/history-content.tsx', { exportName: 'V2HistoryContent', platform, props: { ...props, choreId: 'floor' } });
    assert.doesNotMatch(scoped.text(), /my-private-work/); assert.match(scoped.text(), /床を掃除/);
    owner.unmount(); member.unmount(); scoped.unmount();
  } finally { d.connection.close(); }
});

test('personal history keeps the frozen date and matching clock after the owner changes region without a mutation', async () => {
  const work = row('my-work', { completedAt: '2026-11-08T15:30:00Z', completedLocalDate: '2026-11-09', completedTimeZone: 'Asia/Tokyo', source: 'widget' });
  const data = { snapshot: { ...personalSource([work]).snapshot, timeZone: 'America/Los_Angeles', today: '2026-11-09' }, loading: false, error: null, refresh: async () => {} };
  const screen = screenHarness('src/features/planner/history-content.tsx', { exportName: 'PlannerHistoryContent', props: { data } });
  assert.match(screen.text(), /11月9日/); assert.match(screen.text(), /00:30/); assert.match(screen.text(), /今月の完了1件/);
  assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'my-workの記録の詳細'), false);
  assert.doesNotMatch(screen.text(), /登録元|実施済み|自分/);
  assert.deepEqual(data.snapshot.completions, [work]); screen.unmount();
});

test('personal history only presents actual dates and clocks while preserving stored schedule and learning facts', async () => {
  const work = row('scheduled-work', { scheduledDate: '2026-11-09', scheduledWindowStart: '2026-11-07', scheduledWindowEnd: '2026-11-11' });
  const simple = row('old-simple-work');
  const data = { snapshot: { ...personalSource([work, simple]).snapshot, today: '2026-11-09' }, loading: false, error: null, refresh: async () => {} };
  const screen = screenHarness('src/features/planner/history-content.tsx', { exportName: 'PlannerHistoryContent', props: { data } });
  assert.equal(screen.nodes().some(node => /の記録の詳細$/.test(node.props.accessibilityLabel ?? '')), false);
  assert.match(screen.text(), /scheduled-work|old-simple-work/);
  assert.doesNotMatch(screen.text(), /予定日|実施期間|登録元|実施済み/);
  assert.deepEqual(data.snapshot.completions, [work, simple]); screen.unmount();
});

test('group history opens only original assignees and performer without exposing completion edits', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    let serial = 0;
    const controller = createV2GroupController(d.repository, { makeId: () => `simple-history-${++serial}`, now, sync: async () => {} });
    await controller.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null });
    const model = await controller.readModel(range); const record = model.plan.history[0];
    const before = JSON.stringify(record);
    const screen = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', props: {
      model, record, actions: controller.actions, busy: false, run: work => work(),
    } });
    assert.match(screen.text(), /床を掃除|10:00/);
    assert.doesNotMatch(screen.text(), /当時の担当者|実施者|登録者|予定日|実施期間/);
    await screen.press(`${model.plan.chores.find(chore => chore.id === record.choreId).name}の記録の詳細`);
    assert.match(screen.text(), /当時の担当者：/); assert.match(screen.text(), /実施者：/);
    assert.doesNotMatch(screen.text(), /登録者|登録：|予定日|実施期間|実施時点の指定/);
    assert.equal(screen.nodes().some(node => node.props.accessibilityLabel === 'この完了を取り消す'), false);
    assert.equal(JSON.stringify(record), before); screen.unmount();
    await controller.actions.undo(record.operationId);
    const afterUndo = await controller.readModel(range);
    assert.equal(afterUndo.plan.history.length, 1); assert.equal(afterUndo.plan.history[0].active, false);
    const cancelled = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', props: {
      model: afterUndo, record: afterUndo.plan.history[0], actions: controller.actions, busy: false, run: work => work(),
    } });
    assert.equal(cancelled.text(), '');
    assert.equal(cancelled.nodes().some(node => node.props.accessibilityLabel === 'この完了を取り消す'), false);
    cancelled.unmount();
  } finally { d.connection.close(); }
});
