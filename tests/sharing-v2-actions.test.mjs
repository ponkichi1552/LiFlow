import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, draft, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2GroupBootstrap } from '../src/features/sharing/v2/bootstrap.ts';
import { createPersonalChoreDefinitions } from '../src/domain/chores/personal-catalog.ts';
import { applyReceivedSharedFacts, loadSharedFacts, listSharingOutbox, readSharingCheckpoint, withSharingLedgerTransaction } from '../src/platform/storage/sharing-ledger.ts';
import { receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
function actions(d) { let id = 0; return createV2PlannerActions(d.repository, { makeId: () => `${d.options.userId}-action-${++id}`, now }); }

test('v2 actions record completion and targeted undo atomically and make repeated checkbox taps idempotent', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [one, duplicate] = await Promise.all([a.complete(ref), a.complete(ref)]); assert.equal(one.length + duplicate.length, 1);
    let plan = await a.readPlan(range); assert.equal(plan.occurrences[0].completed, true); assert.equal(plan.history[0].instruction.kind, 'automatic');
    assert.equal(plan.history[0].recordedAt, now().toISOString());
    const [undo, twice] = await Promise.all([a.undo(one[0].operationId), a.undo(one[0].operationId)]); assert.equal(undo.length + twice.length, 1);
    plan = await a.readPlan(range); assert.equal(plan.history.length, 1); assert.equal(plan.history[0].active, false); assert.equal(plan.occurrences[0].completed, false);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 6);
  } finally { d.connection.close(); }
});
test('v2 actions keep bootstrap separate, require explicit activation and protect administrator settings from members', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const operations = v2GroupBootstrap({ groupId, ownerUserId: 'owner', ownerDisplayName: '所有者', name: '検査', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27', kind: 'roommates' });
    await owner.repository.commit(operations); const a = actions(owner); let plan = await a.readPlan(range);
    assert.equal(plan.chores.length, createPersonalChoreDefinitions('catalog').length); assert.equal(plan.chores.some((chore) => chore.enabled), false); assert.equal(plan.occurrences.length, 0);
    assert.equal(plan.policy.kind, 'roommates'); const choreId = plan.chores[0].id;
    await a.configureChore(choreId, { policy: chorePolicyFromPreset('eachMember'), anchorDate: '2026-10-29', intervalDays: 3, windowBeforeDays: 0, windowAfterDays: 1, effectiveFrom: '2026-10-29', active: true });
    plan = await a.readPlan(range); assert.equal(plan.occurrences[0].anchorDate, '2026-10-29');
    const facts = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, facts, String(facts.length), member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    await assert.rejects(actions(member).configureChore(choreId, { ...plan.occurrences[0].configuration, effectiveFrom: '2026-10-30', active: false }, { expectedRuleVersion: 1 }), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(member.database, groupId)).length, 0);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 actions choose a direct date or signed request from current permission and preserve original work after cancelling dates', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [direct] = await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, options: { strict: true } });
    assert.equal(direct.entityType, 'designation'); await a.complete(ref, { performedAt: '2026-10-26T23:00:00Z' });
    const before = (await a.readPlan(range)).history; await a.cancelDates(ref, [direct.operationId]);
    assert.deepEqual((await a.readPlan(range)).history, before); assert.equal((await a.readPlan(range)).history[0].strictInstructionFulfilled, false);
  } finally { d.connection.close(); }
});
test('v2 actions retain original group options when changing family and roommate presets', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); await a.patchGroupPolicy({ allowSubstitution: false, completionPushEnabled: true });
    await a.changeGroupKind('roommates'); const plan = await a.readPlan(range);
    assert.equal(plan.policy.kind, 'roommates'); assert.equal(plan.policy.allowSubstitution, false); assert.equal(plan.policy.completionPushEnabled, true);
  } finally { d.connection.close(); }
});
test('v2 actions claim, release and explicit assignment affect only their intended common rounds', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); await a.claim(ref); assert.equal((await a.claim(ref)).length, 0);
    assert.deepEqual((await a.readPlan(range)).occurrences[0].assigneeIds, ['owner']);
    await a.releaseClaim(ref); assert.deepEqual((await a.readPlan(range)).occurrences[0].assigneeIds, []);
    await a.assign(ref, ['member'], 'next', true); const plan = await a.readPlan(range);
    assert.deepEqual(plan.occurrences[0].assigneeIds, []); assert.deepEqual(plan.occurrences[1].assigneeIds, ['member']);
  } finally { d.connection.close(); }
});

test('v2 actions require recent-work confirmation before an administrator repeats a short-cycle task without changing its completed past round', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.intervalDays = 3; await d.repository.commit(initial); const a = actions(d);
    await a.complete(ref); const before = (await a.readPlan(range)).history;
    const next = { ...ref, anchorDate: '2026-10-30' }; const target = { precision: 'date', date: '2026-10-27' };
    await assert.rejects(a.changeDate(next, { mode: 'day', target }), (error) => error.reason === 'recentWork');
    await a.changeDate(next, { mode: 'day', target, confirmRecentWork: true });
    const plan = await a.readPlan(range); assert.deepEqual(plan.history, before); assert.equal(plan.occurrences[0].completed, true);
    assert.equal(plan.occurrences[1].subjects[0].formalDate.allowDuringCooldown, true); assert.equal(plan.occurrences[1].subjects[0].cooldownSuppressed, false);
  } finally { d.connection.close(); }
});
test('v2 actions require an explicit high-load confirmation and roll back a cancelled designation', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    await d.repository.commit([draft('limit', 'settings', 'settings', { heavyDailyLimit: 1 }), draft('heavy', 'chore', 'floor', { load: 'heavy' }),
      draft('mop', 'chore', 'mop', { name: '床の水拭き', enabled: true, load: 'heavy' }),
      draft('mop-configuration', 'chorePolicy', 'mop', { configuration: seeds()[3].payload.configuration })]);
    const a = actions(d); const before = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: ref.anchorDate } }), (error) => error.reason === 'highLoad');
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: ref.anchorDate }, confirmHighLoad: true });
    assert.equal((await a.readPlan(range)).occurrences.find((entry) => entry.choreId === 'floor').subjects[0].formalDate.kind, 'manual');
  } finally { d.connection.close(); }
});

test('v2 configuration autosave merges different fields but refuses stale full settings and same-field overwrite', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    await a.patchChoreConfiguration('floor', 1, { windowAfterDays: 4 }, '2026-10-27');
    await a.patchChoreConfiguration('floor', 1, { intervalDays: 3 }, '2026-10-27');
    let plan = await a.readPlan(range); assert.equal(plan.occurrences[0].configuration.windowAfterDays, 4); assert.equal(plan.occurrences[0].configuration.intervalDays, 3);
    const before = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(a.patchChoreConfiguration('floor', 1, { windowAfterDays: 5 }, '2026-10-27'), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(a.configureChore('floor', { ...seeds()[3].payload.configuration, effectiveFrom: ref.anchorDate }, { expectedRuleVersion: 1 }), { code: 'sharing/v2-stale-settings' });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    assert.equal((await a.patchChoreConfiguration('floor', 1, { intervalDays: 3 }, '2026-10-27')).length, 0);
    plan = await a.readPlan(range); assert.equal(plan.occurrences[0].configuration.ruleVersion, 3);
  } finally { d.connection.close(); }
});
test('v2 cadence edits preserve original fixed assignment facts without copying them', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); await a.assign(ref, ['member'], 'next', true);
    const before = (await d.repository.readState()).assessment.view.ofType('assignmentRule').map((op) => op.operationId);
    await a.patchChoreConfiguration('floor', 1, { windowAfterDays: 3 }, '2026-10-27');
    const state = await d.repository.readState(); assert.deepEqual(state.assessment.view.ofType('assignmentRule').map((op) => op.operationId), before);
    const plan = await a.readPlan(range); assert.equal(plan.occurrences[0].configuration.assignmentSourceVersion, 1);
    assert.deepEqual(plan.occurrences[0].assigneeIds, []); assert.deepEqual(plan.occurrences[1].assigneeIds, ['member']); assert.equal(plan.occurrences[1].assignmentFixed, true);
    await assert.rejects(a.patchChoreConfiguration('floor', 2, { intervalDays: 3 }, '2026-10-27'), { code: 'sharing/v2-assignment-remap-required' });
    assert.deepEqual((await d.repository.readState()).assessment.view.ofType('assignmentRule').map((op) => op.operationId), before);
  } finally { d.connection.close(); }
});
test('v2 unrelated configuration edits do not add a newly joined member until an explicit this-or-next assignment', async () => {
  const { createDeviceIdentity } = await import('../src/features/sharing/crypto.ts');
  const { approveSharedDevice } = await import('../src/features/sharing/roster.ts');
  const { sharingTestCrypto } = await import('./helpers/sharing-crypto.mjs');
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('eachMember'); await d.repository.commit(initial);
    const late = await createDeviceIdentity(sharingTestCrypto); f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'late', late));
    const a = actions(d); await a.patchChoreConfiguration('floor', 1, { windowAfterDays: 3 }, '2026-10-27');
    let plan = await a.readPlan(range); assert.deepEqual(plan.occurrences[0].subjectUserIds, ['member', 'owner']); assert.deepEqual(plan.occurrences[1].subjectUserIds, ['member', 'owner']);
    await a.assign({ ...ref, ruleVersion: 2 }, ['member', 'owner', 'late'], 'next', false);
    plan = await a.readPlan(range); assert.deepEqual(plan.occurrences[0].subjectUserIds, ['member', 'owner']); assert.deepEqual(plan.occurrences[1].subjectUserIds, ['late', 'member', 'owner']);
  } finally { d.connection.close(); }
});
test('v2 members may add disabled chores and procedures without gaining activation or cadence rights', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const facts = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, facts, '4', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const a = actions(member); const [added] = await a.addChore('家族で使う家事', ['道具を用意する']);
    const plan = await a.readPlan(range); const chore = plan.chores.find((entry) => entry.id === added.entityId);
    assert.equal(chore.enabled, false); assert.equal(plan.occurrences.some((entry) => entry.choreId === chore.id), false);
    assert.deepEqual(chore.instructions, ['道具を用意する']);
    assert.equal(chore.category, '追加した家事');
    await assert.rejects(a.patchChore(chore.id, { enabled: true }), { code: 'sharing/v2-authority-denied' });
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 date forms cannot silently replace a newer date that was not shown when editing began', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [first] = await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, expectedRuleIds: [] });
    await assert.rejects(a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-29' }, expectedRuleIds: [] }), { code: 'sharing/v2-stale-settings' });
    await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-29' }, expectedRuleIds: [first.operationId] });
    assert.equal((await a.readPlan(range)).occurrences[0].subjects[0].formalDate.target.date, '2026-10-29');
  } finally { d.connection.close(); }
});

test('v2 queued configuration fields keep independent displayed revisions when another edit commits during autosave', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    await a.patchChoreConfiguration('floor', 1, { windowAfterDays: 4 }, '2026-10-27');
    const operations = await a.patchChoreConfigurationFields('floor', [
      { field: 'intervalDays', baseRuleVersion: 1, value: 3 }, { field: 'windowAfterDays', baseRuleVersion: 2, value: 5 },
    ], '2026-10-27');
    assert.equal(operations.length, 2); const current = (await a.readPlan(range)).occurrences[0].configuration;
    assert.equal(current.ruleVersion, 3); assert.equal(current.intervalDays, 3); assert.equal(current.windowAfterDays, 5);
    await assert.rejects(a.patchChoreConfigurationFields('floor', [
      { field: 'intervalDays', baseRuleVersion: 3, value: 4 }, { field: 'windowAfterDays', baseRuleVersion: 1, value: 6 },
    ], '2026-10-27'), { code: 'sharing/v2-stale-settings' });
    assert.equal((await a.readPlan(range)).occurrences[0].configuration.ruleVersion, 3);
  } finally { d.connection.close(); }
});

test('v2 generic activation edits preserve an explicit inactive timeline and re-enable without backfilling disabled daily rounds', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.intervalDays = 1;
    await d.repository.commit(initial); const a = actions(d); await a.patchChore('floor', { enabled: false });
    await a.patchChore('floor', { enabled: true }, '2026-11-02');
    const plan = await a.readPlan(range); assert.equal(plan.chores[0].enabled, true);
    assert.equal(plan.occurrences.some((entry) => entry.anchorDate >= '2026-10-28' && entry.anchorDate < '2026-11-02'), false);
    assert.ok(plan.occurrences.some((entry) => entry.anchorDate === '2026-11-02' && entry.activeInPeriod));
    assert.equal(plan.history.length, 0);
  } finally { d.connection.close(); }
});

test('v2 completion snapshots retain the approved common window and subject schedule after a later cancellation', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-31' }, extensionScope: 'future', expectedRuleIds: [] });
    const facts = await loadSharedFacts(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, '5', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const [work] = await a.complete(ref); assert.deepEqual(work.payload.recordedCommonWindow, { start: '2026-10-25', end: '2026-10-31' });
    assert.equal(work.payload.scheduledWindowEnd, '2026-10-31'); assert.equal(work.payload.scheduledDate, '2026-10-31');
    const before = (await a.readPlan(range)).history;
    const rule = (await d.repository.readState()).assessment.approvedRules[0]; await a.cancelDates(ref, [rule.operationId]);
    const plan = await a.readPlan(range); assert.deepEqual(plan.history, before); assert.equal(plan.occurrences[0].windowEnd, '2026-10-29');
    assert.equal(plan.history[0].schedule.commonWindow.end, '2026-10-31');
  } finally { d.connection.close(); }
});

test('v2 assignment requests atomically synchronize original assignees and receipt-backed approvals across two isolated user databases without duplicate taps', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const a = actions(owner); const b = actions(member); await a.assign(ref, ['member'], 'this', true);
    const send = async (facts, cursor, receipts = receiptsFor(facts)) => {
      for (const d of [owner, member]) {
        const checkpoint = await readSharingCheckpoint(d.database, groupId);
        await applyReceivedSharedFacts(d.database, groupId, facts, String(cursor), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receipts));
      }
    };
    await send(await loadSharedFacts(owner.database, groupId), 5);
    const input = { memberIds: [], start: 'this', scope: 'once', fixed: false };
    const [one, repeated] = await Promise.all([b.requestAssignment(ref, input), b.requestAssignment(ref, input)]);
    assert.equal(one.length + repeated.length, 1); const req = [...one, ...repeated][0];
    assert.ok(req.receiptContext[f.owner.deviceId] >= 5);
    assert.deepEqual((await b.readPlan(range)).occurrences[0].assigneeIds, ['member']);
    await assert.rejects(b.answerAssignment(req.operationId, 'approve'), { code: 'sharing/v2-authority-denied' });
    const requestFact = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.operationId === req.operationId); await send([requestFact], 6);
    const [answer] = await a.answerAssignment(req.operationId, 'approve'); assert.equal((await a.answerAssignment(req.operationId, 'approve')).length, 0);
    assert.deepEqual((await a.readPlan(range)).occurrences[0].assigneeIds, ['member']);
    const answerFact = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.operationId === answer.operationId); await send([answerFact], 7);
    const plan = await a.readPlan(range); assert.deepEqual(plan.occurrences[0].assigneeIds, []); assert.equal(plan.planHash, (await b.readPlan(range)).planHash);
    assert.equal((await owner.repository.readState()).assessment.assignmentRequests[0].kind, 'approved');
    assert.equal((await member.repository.readState()).assessment.assignmentRequests[0].kind, 'approved');
    await b.claim(ref); assert.deepEqual((await b.readPlan(range)).occurrences[0].assigneeIds, ['member']);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 repository persists an explicit confirmed-receipt context so a pending date extension cannot rewrite later-delivered work or its original window', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [request] = await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-31' }, extensionScope: 'future' });
    assert.equal(request.entityType, 'changeRequest'); const [work] = await a.complete(ref);
    assert.deepEqual(work.receiptContext, {}); assert.equal(work.payload.recordedInstruction.kind, 'automatic');
    assert.deepEqual(work.payload.recordedCommonWindow, { start: '2026-10-25', end: '2026-10-29' });
    const facts = await loadSharedFacts(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, '6', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.deepEqual(d.state().rejected, []); const plan = await a.readPlan(range); assert.equal(plan.history[0].instruction.kind, 'automatic');
    assert.equal(plan.history[0].schedule.commonWindow.end, '2026-10-29'); assert.equal(plan.occurrences[0].windowEnd, '2026-10-31'); assert.equal(plan.occurrences[0].completed, true);
  } finally { d.connection.close(); }
});

test('v2 pending assignment requests survive unrelated configuration edits and ambiguous future mapping cannot be silently discarded', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']); await owner.repository.commit(initial);
    const a = actions(owner); const b = actions(member);
    const send = async (facts, cursor) => { for (const d of [owner, member]) {
      const old = await readSharingCheckpoint(d.database, groupId); await applyReceivedSharedFacts(d.database, groupId, facts, String(cursor), d.repository.project, old.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    } };
    await send(await loadSharedFacts(owner.database, groupId), 4);
    const [req] = await b.requestAssignment(ref, { memberIds: [], start: 'next', scope: 'once', fixed: false });
    await send((await loadSharedFacts(member.database, groupId)).filter((fact) => fact.operation.operationId === req.operationId), 5);
    await assert.rejects(a.patchChoreConfiguration('floor', 1, { intervalDays: 3 }, '2026-10-27'), { code: 'sharing/v2-assignment-remap-required' });
    assert.equal((await a.readPlan(range)).occurrences[0].configuration.ruleVersion, 1);
    await a.patchChoreConfiguration('floor', 1, { windowAfterDays: 4 }, '2026-10-27'); await a.answerAssignment(req.operationId, 'approve');
    await send(await loadSharedFacts(owner.database, groupId), 8);
    let plan = await a.readPlan(range); assert.deepEqual(plan.occurrences.find((round) => round.anchorDate === '2026-11-03').assigneeIds, []);
    assert.equal(plan.occurrences[0].configuration.assignmentSourceVersion, 1);
    await a.patchChoreConfiguration('floor', 2, { intervalDays: 1 }, '2026-10-27'); plan = await a.readPlan(range);
    assert.deepEqual(plan.occurrences.find((round) => round.anchorDate === '2026-11-03').assigneeIds, []); assert.equal(plan.occurrences[0].configuration.assignmentSourceVersion, 2);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 assignment remapping atomically cancels its original source and assigns an explicit new round without deleting history or partially committing an invalid replacement', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); const oldRef = { ...ref, anchorDate: '2026-11-03' };
    const [source] = await a.resolveAssignment(oldRef, ['member'], 'once', true);
    await a.configureChore('floor', { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-28', intervalDays: 4, windowBeforeDays: 2, windowAfterDays: 2,
      effectiveFrom: '2026-10-28', active: true }, { expectedRuleVersion: 1, preserveAssignments: false });
    const target = { ...ref, anchorDate: '2026-11-01', ruleVersion: 2 }; let plan = await a.readPlan(range);
    assert.ok(plan.issues.some((issue) => issue.kind === 'oneOffAssignmentMappingNeedsReview'));
    const count = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(a.remapAssignments([source.operationId], target, ['unknown'], 'once', false), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, count); assert.equal((await d.repository.readState()).assessment.view.ofType('assignmentCancel').length, 0);
    const changes = await a.remapAssignments([source.operationId], target, ['owner'], 'once', false);
    assert.deepEqual(changes.map((op) => op.entityType), ['assignmentCancel', 'assignmentRule']);
    plan = await a.readPlan(range); assert.equal(plan.issues.some((issue) => issue.kind === 'oneOffAssignmentMappingNeedsReview'), false);
    assert.deepEqual(plan.occurrences.find((round) => round.anchorDate === target.anchorDate).assigneeIds, ['owner']);
    assert.equal((await a.remapAssignments([source.operationId], target, ['member'], 'once', true)).length, 0);
    assert.ok((await d.repository.readState()).assessment.view.byId(source.operationId));
  } finally { d.connection.close(); }
});

test('v2 assignment forms retain displayed assignment bases and refuse stale assignment, resolution, request and checkbox changes', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); await a.assign(ref, ['owner'], 'this', true);
    const displayed = (await a.readPlan(range)).occurrences[0]; const edit = { expectedAssignmentIds: displayed.assignmentOperationIds, expectedConflictIds: displayed.assignmentConflictIds };
    await a.assign(ref, ['member'], 'this', true, edit); const count = (await listSharingOutbox(d.database, groupId)).length;
    for (const change of [() => a.assign(ref, ['owner'], 'this', false, edit), () => a.resolveAssignment(ref, ['owner'], 'once', false, edit),
      () => a.requestAssignment(ref, { memberIds: [], start: 'this', scope: 'once', fixed: false, ...edit }), () => a.complete(ref, { expectedAssigneeIds: ['owner'] })]) {
      await assert.rejects(change(), { code: 'sharing/v2-stale-settings' });
    }
    assert.equal((await listSharingOutbox(d.database, groupId)).length, count); const plan = await a.readPlan(range);
    assert.deepEqual(plan.occurrences[0].assigneeIds, ['member']); assert.equal(plan.history.length, 0);
  } finally { d.connection.close(); }
});

test('v2 completing and undoing before a cadence edit keeps the current round actionable without replacing original history or losing a later real completion', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const a = actions(owner); await a.claim(ref);
    const [first] = await a.complete(ref); await a.undo(first.operationId);
    const originalHistory = (await a.readPlan(range)).history[0];
    await a.patchChoreConfiguration('floor', 1, { intervalDays: 17 }, '2026-10-27');
    let plan = await a.readPlan(range); const round = plan.occurrences.find((entry) => entry.anchorDate === ref.anchorDate);
    assert.equal(round.activeInPeriod, true); assert.equal(round.ruleVersion, 2); assert.equal(round.completed, false);
    assert.deepEqual(plan.history[0], originalHistory);
    assert.equal(plan.issues.some((issue) => issue.kind === 'configurationChangedDuringRound'), false);
    const [second] = await a.complete({ ...ref, ruleVersion: 2 }, { expectedAssigneeIds: ['owner'] });
    const completedHistory = (await a.readPlan(range)).history.find((entry) => entry.operationId === second.operationId);
    await a.patchChoreConfiguration('floor', 2, { windowAfterDays: 3 }, '2026-10-27');
    plan = await a.readPlan(range); const retained = plan.occurrences.find((entry) => entry.id === round.id);
    assert.equal(retained.ruleVersion, 2); assert.equal(retained.completed, true);
    assert.deepEqual(plan.history.find((entry) => entry.operationId === second.operationId), completedHistory);
    const facts = await loadSharedFacts(owner.database, groupId);
    for (const d of [owner, member]) await applyReceivedSharedFacts(d.database, groupId, facts, '20', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal((await a.readPlan(range)).planHash, (await actions(member).readPlan(range)).planHash);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 displayed round guards check the configuration frontier after waiting for SQLite and keep stale completion, dates, claims and assignments out of the outbox', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); const displayed = { ...ref, expectedConfigurationIds: ['configuration'] };
    let release; let entered; const ready = new Promise((resolve) => { entered = resolve; });
    const held = withSharingLedgerTransaction(d.database, async () => { entered(); await new Promise((resolve) => { release = resolve; }); }); await ready;
    const update = a.patchChoreConfiguration('floor', 1, { intervalDays: 17 }, '2026-10-27');
    const rejected = assert.rejects(a.complete(displayed), { code: 'sharing/v2-stale-settings' });
    release(); await held; await update; await rejected;
    const count = (await listSharingOutbox(d.database, groupId)).length;
    for (const operation of [() => a.changeDate(displayed, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } }),
      () => a.claim(displayed), () => a.releaseClaim(displayed), () => a.resolveClaims(displayed, ['owner'], false),
      () => a.assign(displayed, ['owner'], 'this', false), () => a.resolveAssignment(displayed, ['owner'], 'once', false),
      () => a.requestAssignment(displayed, { memberIds: ['owner'], start: 'this', scope: 'once', fixed: false })]) {
      await assert.rejects(operation(), { code: 'sharing/v2-stale-settings' });
    }
    assert.equal((await listSharingOutbox(d.database, groupId)).length, count); assert.equal((await a.readPlan(range)).history.length, 0);
    const cfg = (await d.repository.readState()).assessment.view.ofType('chorePolicy').at(-1);
    const [work] = await a.complete({ ...ref, ruleVersion: 2, expectedConfigurationIds: [cfg.operationId] });
    assert.equal(work.entityType, 'completion'); assert.equal(JSON.stringify(work).includes('expectedConfigurationIds'), false);
  } finally { d.connection.close(); }
});

test('v2 displayed timezone guards reject queued work and schedule changes after a timezone update without leaking UI expectations into signed facts', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); const displayed = { ...ref, expectedTimeZone: 'Asia/Tokyo' };
    let release; let entered; const ready = new Promise((resolve) => { entered = resolve; });
    const held = withSharingLedgerTransaction(d.database, async () => { entered(); await new Promise((resolve) => { release = resolve; }); }); await ready;
    const update = d.repository.commit([{ operationId: 'new-zone', entityType: 'settings', entityId: 'settings', operationType: 'patch', payload: { timeZone: 'America/New_York' } }]);
    const rejected = assert.rejects(a.complete(displayed), { code: 'sharing/v2-stale-settings' }); release(); await held; await update; await rejected;
    const count = (await listSharingOutbox(d.database, groupId)).length;
    for (const change of [() => a.changeDate(displayed, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } }),
      () => a.claim(displayed), () => a.assign(displayed, ['owner'], 'this', false)]) await assert.rejects(change(), { code: 'sharing/v2-stale-settings' });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, count);
    const [work] = await a.complete({ ...ref, expectedTimeZone: 'America/New_York' });
    assert.equal(work.payload.recordedInstruction.timeZone, 'America/New_York'); assert.equal(JSON.stringify(work).includes('expectedTimeZone'), false);
  } finally { d.connection.close(); }
});
