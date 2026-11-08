import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const ref = { choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null };
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `visibility-${d.options.userId}-${++n}`, now, sync: async () => {} }); }

for (const platform of ['ios', 'android']) test(`${platform} disabling completion status also hides unrelated history while preserving the administrator and original records`, async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial[0].payload.configuration.showCompletionStatus = false;
    initial[3].payload.configuration.policy = { completion: 'one', assignment: { mode: 'selected', memberIds: ['owner'] } };
    await owner.repository.commit(initial); const a = controller(owner); await a.actions.complete(ref);
    await receive(member, await loadSharedFacts(owner.database, groupId)); const b = controller(member);
    const record = (await b.readModel(range)).plan.history[0]; assert.ok(record.active);
    const card = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', platform,
      props: { model: await b.readModel(range), record, actions: b.actions, busy: false, run: async work => work() } });
    assert.equal(card.text(), '');
    const session = createV2ScreenSession({ controller: b, groupId, userId: 'member', now,
      readPreferences: () => ({ ownerUserId: 'member', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
    let focus; const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
      props: { purpose: 'workspace', view: 'history', loadSession: async () => session, onBack() {}, onConfiguration() {}, onHistory() {} }, focusEffect: callback => { focus = callback; } });
    const leave = focus(); for (let n = 0; n < 25 && !screen.text().includes('実施履歴'); n++) await screen.flush();
    assert.match(screen.text(), /表示する実施記録はありません/u); assert.equal(screen.nodes().find(node => node.type === 'FlatList').props.data.length, 0); leave();
    const admin = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', platform,
      props: { model: await a.readModel(range), record, actions: a.actions, busy: false, run: async work => work() } });
    assert.match(admin.text(), /床を掃除/u);
    assert.deepEqual((await b.readModel(range)).plan.history, [record]);
    await a.actions.patchGroupPolicy({ showCompletionStatus: true }); await receive(member, await loadSharedFacts(owner.database, groupId));
    const visible = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', platform,
      props: { model: await b.readModel(range), record, actions: b.actions, busy: false, run: async work => work() } });
    assert.match(visible.text(), /床を掃除/u);
  } finally { owner.connection.close(); member.connection.close(); }
});
