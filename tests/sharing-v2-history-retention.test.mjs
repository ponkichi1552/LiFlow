import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, draft, groupId, seeds } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { loadSharedFacts, applyReceivedSharedFacts, readSharingCheckpoint, applySharingSnapshot } from '../src/platform/storage/sharing-ledger.ts';
import { buildSharedReplica, compactSharedReplica } from '../src/features/sharing/replica.ts';
import { sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { planV2HistoryRetention } from '../src/features/sharing/v2/history-retention-plan.ts';
import { assertV2RetentionBase, verifyV2RetentionWitness } from '../src/features/sharing/v2/history-retention-certificate.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { createV2HistoryRetentionRuntime } from '../src/features/sharing/v2/history-retention-runtime.ts';
import { sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { readFileSync } from 'node:fs';
import { loadNativeModule } from './helpers/native-module.mjs';
async function prepared(t, anchorDate = '2026-09-01', manualCertificate = true, format = 2) {
  let clock = new Date('2026-09-02T01:00:00Z'); const f = await fixture({ clock: () => clock });
  const owner = await f.device(); const member = await f.device('member', f.member); t.after(() => { owner.connection.close(); member.connection.close(); });
  let uploadSequence = 0; const delivered = new Map(); const receipts = new Map();
  async function deliver(device, input) {
    for (const fact of [...input].sort((a, b) => a.operation.logicalClock - b.operation.logicalClock || a.operation.operationId.localeCompare(b.operation.operationId))) if (!delivered.has(fact.operation.operationId)) {
      delivered.set(fact.operation.operationId, fact); receipts.set(fact.operation.operationId, { schemaVersion: 2, groupId, operationId: fact.operation.operationId,
        authorUserId: fact.operation.authorUserId, authorDeviceId: fact.operation.authorDeviceId, receivedKeyVersion: fact.operation.keyVersion,
        uploadSequence: ++uploadSequence, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: clock.getTime() });
    }
    const cursor = (await readSharingCheckpoint(device.database, groupId)).cursor;
    await applyReceivedSharedFacts(device.database, groupId, [...delivered.values()], String(uploadSequence), device.repository.project, cursor, clock.getTime(), device.repository.evidenceForServerReceipts([...receipts.values()]));
  }
  const source = seeds(); source[1].payload.anchorDate = anchorDate; source[3].payload.configuration.anchorDate = anchorDate;
  await owner.repository.commit(source); await deliver(owner, await loadSharedFacts(owner.database, groupId));
  const occurrenceId = v2OccurrenceId(groupId, 'floor', anchorDate);
  await owner.repository.commit([{ operationId: 'expired-work-report', entityType: 'completion', entityId: occurrenceId, operationType: 'complete',
    payload: { choreId: 'floor', anchorDate, completedAt: clock.toISOString(), completedByMemberId: 'owner', subjectUserId: null, originalAssigneeIds: [], ruleVersion: 1, outcome: 'completed', completionNote: 'alreadyDone' } }]);
  await deliver(owner, await loadSharedFacts(owner.database, groupId)); await deliver(member, []);
  clock = new Date('2026-11-01T01:00:00Z'); const state = await owner.repository.readState();
  assert.deepEqual(state.assessment.rejected.map(row => [row.operationId, row.error.message]), []);
  const plan = planV2HistoryRetention({ ...state, archive: f.archive, cutoff: '2026-10-01', throughSequence: uploadSequence, format });
  assert.ok(plan.removedIds.includes('expired-work-report'));
  if (!manualCertificate) return { ...f, owner, member, plan, receipts, deliver, now: () => clock.getTime(), head: () => uploadSequence };
  await owner.repository.commit([draft('retention-proposal', 'historyRetention', 'retention-proposal', { phase: 'proposal', checkpoint: plan.body })]);
  await deliver(owner, await loadSharedFacts(owner.database, groupId)); await deliver(member, []);
  const approval = id => ({ phase: 'approve', proposalId: 'retention-proposal', checkpointDigest: sharedDocumentDigest(plan.body), receiptDigest: sharedDocumentDigest(receipts.get('retention-proposal')) });
  await member.repository.commit([draft('member-approval', 'historyRetention', 'member-approval', approval())]); await deliver(owner, await loadSharedFacts(member.database, groupId));
  await owner.repository.commit([draft('owner-approval', 'historyRetention', 'owner-approval', approval())]); await deliver(owner, await loadSharedFacts(owner.database, groupId));
  const all = await owner.repository.readState(); const originals = await loadSharedFacts(owner.database, groupId);
  const witness = { proposal: originals.find(row => row.operation.operationId === 'retention-proposal'), proposalReceipt: receipts.get('retention-proposal'),
    approvals: originals.filter(row => ['owner-approval', 'member-approval'].includes(row.operation.operationId)) };
  const retained = new Set(plan.retained.map(op => op.operationId));
  const base = { ...compactSharedReplica(all.replica), operations: all.replica.operations.filter(op => retained.has(op.operationId) || op.deviceSequence > (plan.body.frontier[op.authorDeviceId] ?? 0)), retention: witness };
  const replica = buildSharedReplica(groupId, [], base);
  return { ...f, owner, member, plan, witness, base, replica, receipts, originals, deliver, now: () => clock.getTime(), head: () => uploadSequence };
}

test('unchanged retained projections reuse their verified certificate while changed witnesses and revoked access still fail', async t => {
  const h = await prepared(t); const ids = new Set(h.base.operations.map(op => op.operationId));
  const checkpoint = await readSharingCheckpoint(h.owner.database, groupId);
  await applySharingSnapshot(h.owner.database, groupId, { base: h.base, facts: h.originals.filter(fact => ids.has(fact.operation.operationId)),
    snapshotId: 'retention-cache', throughSequence: h.head() }, h.owner.repository.project, checkpoint.cursor, h.now(), h.owner.repository.evidenceForServerReceipts([...h.receipts.values()]));
  const source = new URL('../src/platform/storage/sharing-v2-events.ts', import.meta.url); const mocks = {};
  for (const [, name] of readFileSync(source, 'utf8').matchAll(/from ['"](\.[^'"]+\.ts)['"]/gu)) mocks[name] ??= await import(new URL(name, source));
  let checks = 0; const certificate = '../../features/sharing/v2/history-retention-certificate.ts';
  const counted = (...args) => { checks++; return assertV2RetentionBase(...args); };
  mocks[certificate] = { ...mocks[certificate], assertV2RetentionBase: counted };
  // Include the real business-assessment pass: counting only the repository's
  // direct import hid its second verification of the identical certificate.
  const receiverSource = new URL('../src/features/sharing/v2/receiver-authority.ts', import.meta.url); const receiverMocks = {};
  for (const [, name] of readFileSync(receiverSource, 'utf8').matchAll(/from ['"](\.[^'"]+\.ts)['"]/gu)) receiverMocks[name] ??= await import(new URL(name, receiverSource));
  receiverMocks['./history-retention-certificate.ts'] = { ...receiverMocks['./history-retention-certificate.ts'], assertV2RetentionBase: counted };
  mocks['../../features/sharing/v2/receiver-authority.ts'] = loadNativeModule('src/features/sharing/v2/receiver-authority.ts', receiverMocks);
  const { createV2EventRepository } = loadNativeModule('src/platform/storage/sharing-v2-events.ts', mocks);
  const repository = createV2EventRepository(h.owner.database, h.owner.options);
  const first = await repository.readState(); first.replica.retention.proposal.operation.payload.checkpoint.anchors[0].date = '2026-01-01';
  for (let i = 0; i < 3; i++) assert.equal((await repository.readState()).replica.retention.proposal.operation.payload.checkpoint.anchors[0].date, '2026-09-02');
  assert.equal(checks, 1, 'identical signed data, receipts, membership and pending operations must not recheck the same certificate');
  // The owner database remains the source, including independent on-disk edits.
  const stored = h.owner.connection.prepare('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?').get(groupId).snapshot_json;
  const tampered = JSON.parse(stored); tampered.base.retention.approvals[0].authorSignature = '0'.repeat(128);
  h.owner.connection.prepare('UPDATE sharing_snapshot_state SET snapshot_json=? WHERE group_id=?').run(JSON.stringify(tampered), groupId);
  await assert.rejects(repository.readState()); assert.equal(checks, 2);
  h.owner.connection.prepare('UPDATE sharing_snapshot_state SET snapshot_json=? WHERE group_id=?').run(stored, groupId);
  assert.equal((await repository.readState()).replica.retention.proposal.operation.payload.checkpoint.cutoff, '2026-10-01');
  h.owner.stopWrites(); await assert.rejects(repository.readState(), /account changed/);
});
test('shared history retention needs each current member and binds the exact retained state instead of trusting an owner summary', async t => {
  const h = await prepared(t).catch(error => { throw new Error(error.message + '\n' + error.stack); }); assert.equal(verifyV2RetentionWitness(h.witness, h.archive, groupId).cutoff, '2026-10-01'); assertV2RetentionBase(h.replica, h.witness, h.archive);
  assert.throws(() => verifyV2RetentionWitness({ ...h.witness, approvals: h.witness.approvals.slice(0, 1) }, h.archive, groupId), /every current member/);
  const forged = structuredClone(h.witness); forged.proposal.operation.payload.checkpoint.anchors[0].date = '2026-09-03';
  forged.proposal.operation.payload.checkpoint.anchors[0].instant += 86400_000;
  assert.throws(() => verifyV2RetentionWitness(forged, h.archive, groupId), /signature/i);
  assert.throws(() => assertV2RetentionBase({ ...h.replica, operations: h.replica.operations.filter(op => op.operationId !== 'floor') }, h.witness, h.archive), /differs/);
  assert.throws(() => verifyV2RetentionWitness(h.witness, h.archive, 'another-group'));
});
function runtime(h, device, publish) {
  let id = 0;
  return createV2HistoryRetentionRuntime({ repository: device.repository, manager: { publishSnapshot: publish },
    sync: async () => h.deliver(device, await loadSharedFacts(device.database, groupId)),
    readHead: async () => ({ sequence: h.head(), localSequence: (await readSharingCheckpoint(device.database, groupId)).sequence,
      rotationRequired: false, rosterDigest: sharedRosterDigest(h.archive.at(-1)) }),
    readOriginals: () => loadSharedFacts(device.database, groupId), assertAccess: async () => {}, now: h.now,
    makeId: () => `automatic-${device.options.userId}-${++id}` });
}
test('compacting real completion history preserves the oldest unfinished backlog instead of resurrecting previously consumed automatic slots', async t => {
  const h = await prepared(t); const range = { from: '2026-11-01', through: '2026-11-14', asOfDate: '2026-11-01' };
  const selected = plan => plan.occurrences.flatMap(round => round.subjects.filter(subject => subject.automaticBacklog === 'pending').map(subject => [round.choreId, round.anchorDate, subject.subjectUserId]));
  const before = buildV2CommonPlan(await h.owner.repository.readState(), range);
  assert.deepEqual(selected(before), [['floor', '2026-09-08', null]]);
  const ids = new Set(h.base.operations.map(op => op.operationId)); const checkpoint = await readSharingCheckpoint(h.member.database, groupId);
  await applySharingSnapshot(h.member.database, groupId, { base: h.base, facts: h.originals.filter(fact => ids.has(fact.operation.operationId)),
    snapshotId: 'backlog-retention', throughSequence: h.head() }, h.member.repository.project, checkpoint.cursor, h.now(), h.member.repository.evidenceForServerReceipts([...h.receipts.values()]));
  const state = await h.member.repository.readState(); assert.equal(state.replica.operations.some(op => op.operationId === 'expired-work-report'), false);
  const after = buildV2CommonPlan(state, range); assert.deepEqual(selected(after), selected(before));
  assert.equal(after.history.length, 0, 'no phantom completion is manufactured from the retained anchor');
});
test('monthly cleanup proposes and independently approves across isolated member databases before publishing a compacted snapshot', async t => {
  const h = await prepared(t, '2026-09-01', false); let published = 0;
  const owner = runtime(h, h.owner, async (_budget, transform) => {
    published++; const state = await h.owner.repository.readState(); const facts = await loadSharedFacts(h.owner.database, groupId);
    const replica = await transform(state.replica, { group: { headSequence: h.head() }, archive: h.archive, facts });
    const base = compactSharedReplica(replica); const ids = new Set(base.operations.map(op => op.operationId));
    const checkpoint = await readSharingCheckpoint(h.owner.database, groupId);
    await applySharingSnapshot(h.owner.database, groupId, { base, facts: facts.filter(fact => ids.has(fact.operation.operationId)), snapshotId: 'automatic-retention', throughSequence: h.head() }, h.owner.repository.project, checkpoint.cursor, h.now(), h.owner.repository.evidenceForServerReceipts([...h.receipts.values()]));
  });
  const member = runtime(h, h.member, async () => { throw new Error('a member must not publish a checkpoint'); });
  assert.equal((await owner.run()).kind, 'waiting'); assert.equal(published, 0);
  await h.deliver(h.member, []);
  await h.owner.repository.commit([draft('later-name', 'chore', 'floor', { name: '申請後の名前' })]);
  await h.deliver(h.owner, await loadSharedFacts(h.owner.database, groupId)); await h.deliver(h.member, []);
  assert.equal((await member.run()).kind, 'waiting'); await h.deliver(h.owner, []);
  assert.equal((await owner.run()).kind, 'published'); assert.equal(published, 1);
  const state = await h.owner.repository.readState(); assert.equal(state.replica.operations.some(op => op.operationId === 'expired-work-report'), false);
  assert.equal(state.replica.operations.find(op => op.operationId === 'later-name').payload.name, '申請後の名前');
  assert.equal((await owner.run()).kind, 'idle'); assert.equal(published, 1, 'unchanged history must not create redundant cleanup proposals');
});
test('a correctly owner-signed but invented cleanup summary is never automatically approved by another member', async t => {
  const h = await prepared(t, '2026-09-01', false); const checkpoint = structuredClone(h.plan.body);
  checkpoint.anchors[0].instant += 86400_000; checkpoint.anchors[0].date = '2026-09-03';
  await h.owner.repository.commit([draft('invented-summary', 'historyRetention', 'invented-summary', { phase: 'proposal', checkpoint })]);
  await h.deliver(h.owner, await loadSharedFacts(h.owner.database, groupId)); await h.deliver(h.member, []);
  const member = runtime(h, h.member, async () => { throw new Error('must not publish'); });
  assert.equal((await member.run()).kind, 'idle');
  assert.equal((await h.member.repository.readState()).assessment.view.ofType('historyRetention').filter(op => op.payload.phase === 'approve').length, 0);
});
test('deleting an old report preserves a future round current state and only its recorder or administrator can undo it', async t => {
  const h = await prepared(t, '2026-11-03'); const range = { from: '2026-11-01', through: '2026-11-10', asOfDate: '2026-11-01' };
  const before = buildV2CommonPlan(await h.owner.repository.readState(), range);
  const snapshot = { base: h.base, facts: h.originals.filter(fact => h.base.operations.some(op => op.operationId === fact.operation.operationId)), snapshotId: 'future-state-checkpoint', throughSequence: h.head() };
  for (const device of [h.owner, h.member]) {
    const checkpoint = await readSharingCheckpoint(device.database, groupId);
    await applySharingSnapshot(device.database, groupId, snapshot, device.repository.project, checkpoint.cursor, h.now(), device.repository.evidenceForServerReceipts([...h.receipts.values()]));
  }
  const after = buildV2CommonPlan(await h.owner.repository.readState(), range);
  const original = before.occurrences.find(row => row.anchorDate === '2026-11-03'); const current = after.occurrences.find(row => row.anchorDate === '2026-11-03');
  assert.equal(original.completed, true); assert.equal(current.completed, true); assert.deepEqual(current.assigneeIds, original.assigneeIds);
  assert.equal(after.history.length, 0); assert.equal(current.subjects[0].retainedCompletion.completedDate, '2026-09-02');
  assert.equal(current.subjects[0].suggestedDate, original.subjects[0].suggestedDate);
  const ref = { choreId: 'floor', anchorDate: '2026-11-03', ruleVersion: 1, subjectUserId: null };
  let i = 0; const owner = createV2PlannerActions(h.owner.repository, { makeId: () => `owner-${++i}`, now: () => new Date(h.now()) });
  const member = createV2PlannerActions(h.member.repository, { makeId: () => `member-${++i}`, now: () => new Date(h.now()) });
  assert.deepEqual(await owner.complete(ref), [], 'an erased historical report must not allow a duplicate current completion');
  const undo = { ...ref, checkpointId: sharedDocumentDigest(h.plan.body), recorderUserIds: ['owner'] };
  await assert.rejects(member.undoMany([], undo), /権限または対象/);
  assert.equal(buildV2CommonPlan(await h.member.repository.readState(), range).occurrences.find(row => row.anchorDate === ref.anchorDate).completed, true);
  await owner.undoMany([], undo);
  assert.equal(buildV2CommonPlan(await h.owner.repository.readState(), range).occurrences.find(row => row.anchorDate === ref.anchorDate).completed, false);
  assert.deepEqual(await owner.undoMany([], undo), [], 'repeated undo is idempotent');
  await owner.complete(ref); assert.equal(buildV2CommonPlan(await h.owner.repository.readState(), range).occurrences.find(row => row.anchorDate === ref.anchorDate).completed, true);
});
test('an encrypted checkpoint physically removes expired reports and receipts on both existing and fresh replicas and prevents replay resurrection', async t => {
  const h = await prepared(t).catch(error => { throw new Error(error.message + '\n' + error.stack); }); const key = await crypto.randomBytes(32); const resolve = (uid, device, version) => sharedAuthorIdentity(h.archive[version - 1], uid, device, version);
  const sealed = await createEncryptedSharedSnapshot(crypto, h.replica, h.originals, h.archive.at(-1), h.owner.options.identity, key, 'retention-snapshot', h.head(), resolve, h.archive);
  const opened = await openEncryptedSharedSnapshot(crypto, sealed, key, h.archive.at(-1), resolve, h.archive);
  assert.equal(opened.facts.some(fact => fact.operation.operationId === 'expired-work-report'), false);
  for (const device of [h.owner, h.member]) {
    const checkpoint = await readSharingCheckpoint(device.database, groupId);
    await applySharingSnapshot(device.database, groupId, opened, device.repository.project, checkpoint.cursor, h.now(), device.repository.evidenceForServerReceipts([...h.receipts.values()]));
    assert.equal(device.connection.prepare("SELECT operation_id FROM sharing_operations WHERE operation_id='expired-work-report'").get(), undefined);
    assert.equal(device.connection.prepare("SELECT operation_id FROM sharing_v2_server_receipts WHERE operation_id='expired-work-report'").get(), undefined);
    const state = await device.repository.readState(); assert.equal(state.replica.operations.some(op => op.operationId === 'expired-work-report'), false);
    assert.equal(state.assessment.view.ofType('completion').length, 0); assert.equal(state.replica.retention.proposal.operation.payload.checkpoint.anchors[0].date, '2026-09-02');
    const replay = buildSharedReplica(groupId, [h.originals.find(row => row.operation.operationId === 'expired-work-report').operation], opened.base);
    assert.equal(replay.operations.some(op => op.operationId === 'expired-work-report'), false);
  }
});
test('new completion and targeted undo keep working after old original reports are deleted', async t => {
  const h = await prepared(t).catch(error => { throw new Error(error.message + '\n' + error.stack); }); const snapshot = { base: h.base, facts: h.originals.filter(fact => h.base.operations.some(op => op.operationId === fact.operation.operationId)), snapshotId: 'retention-new-operations', throughSequence: h.head() };
  const checkpoint = await readSharingCheckpoint(h.owner.database, groupId);
  await applySharingSnapshot(h.owner.database, groupId, snapshot, h.owner.repository.project, checkpoint.cursor, h.now(), h.owner.repository.evidenceForServerReceipts([...h.receipts.values()]));
  const occurrenceId = v2OccurrenceId(groupId, 'floor', '2026-11-03');
  await h.owner.repository.commit([{ operationId: 'fresh-complete', entityType: 'completion', entityId: occurrenceId, operationType: 'complete',
    payload: { choreId: 'floor', anchorDate: '2026-11-03', completedAt: new Date(h.now()).toISOString(), completedByMemberId: 'owner', subjectUserId: null, originalAssigneeIds: [], ruleVersion: 1, outcome: 'completed' } }]);
  await h.owner.repository.commit([{ operationId: 'fresh-undo', entityType: 'completion', entityId: occurrenceId, operationType: 'undo', payload: { targetOperationId: 'fresh-complete' } }]);
  assert.deepEqual((await h.owner.repository.readState()).assessment.view.ofType('completion').map(op => op.operationId), ['fresh-complete', 'fresh-undo']);
  await assert.rejects(h.owner.repository.commit([{ operationId: 'expired-undo', entityType: 'completion', entityId: v2OccurrenceId(groupId, 'floor', '2026-09-01'), operationType: 'undo', payload: { targetOperationId: 'expired-work-report' } }]), /Referenced fact/);
});

test('legacy archive deletion checks the collective certificate every original index and unsent work before closing and removing the duplicate file', async t => {
  const h = await prepared(t); const { removeRetainedLegacyArchive } = await import('../src/platform/storage/retention-archives.ts');
  const snapshot = { base: h.base, groupId, throughSequence: h.head() }; const events = [];
  const input = { snapshot, groupId, archive: h.archive, assertAccess: async () => { events.push('access'); }, exists: async () => true,
    open: async () => ({ ...h.owner.database, closeAsync: async () => { events.push('close'); } }), remove: async () => { events.push('remove'); } };
  await removeRetainedLegacyArchive(input); assert.ok(events.indexOf('close') < events.indexOf('remove'));
  events.length = 0; await h.owner.repository.commit([draft('unsent-name', 'chore', 'floor', { name: '未送信' })]);
  await assert.rejects(removeRetainedLegacyArchive(input), /未送信/); assert.equal(events.includes('remove'), false); assert.equal(events.includes('close'), true);
  events.length = 0; await assert.rejects(removeRetainedLegacyArchive({ ...input, groupId: 'foreign-group' })); assert.deepEqual(events, []);
  const bad = structuredClone(snapshot); bad.base.retention.approvals.pop();
  await assert.rejects(removeRetainedLegacyArchive({ ...input, snapshot: bad }), /every current member/); assert.deepEqual(events, []);
});

test('audit100 physically compacted completion reports retain their Google completed state and real completion instant', async t => {
  const h = await prepared(t, '2026-11-05'); const checkpoint = await readSharingCheckpoint(h.owner.database, groupId); const ids = new Set(h.base.operations.map(op => op.operationId));
  await applySharingSnapshot(h.owner.database, groupId, { base: h.base, facts: h.originals.filter(fact => ids.has(fact.operation.operationId)), snapshotId:'google-retained', throughSequence:h.head() }, h.owner.repository.project, checkpoint.cursor, h.now(), h.owner.repository.evidenceForServerReceipts([...h.receipts.values()]));
  const state = await h.owner.repository.readState(); const plan = buildV2CommonPlan(state, { from:'2026-11-05', through:'2026-11-05', asOfDate:'2026-11-01' });
  assert.equal(plan.history.length, 0); const subject = plan.occurrences.find(row => row.anchorDate==='2026-11-05').subjects[0]; assert.equal(subject.completed,true);
  const { v2GoogleTaskItems } = await import('../src/features/sharing/v2/google-tasks-projection.ts');
  const item = v2GoogleTaskItems(plan,'owner').find(row => row.target.anchorDate==='2026-11-05');
  assert.equal(item.completedAt,'2026-09-02T01:00:00.000Z'); assert.ok(item.retainedCompletion);
});

test('audit100 Google Undo can cancel the owners acknowledged retained completion after the original report was deleted', async t => {
  const h = await prepared(t, '2026-11-05'); const checkpoint = await readSharingCheckpoint(h.owner.database, groupId); const ids = new Set(h.base.operations.map(op => op.operationId));
  await applySharingSnapshot(h.owner.database, groupId, { base:h.base, facts:h.originals.filter(fact=>ids.has(fact.operation.operationId)), snapshotId:'google-undo-retained', throughSequence:h.head() }, h.owner.repository.project, checkpoint.cursor, h.now(), h.owner.repository.evidenceForServerReceipts([...h.receipts.values()]));
  const { createV2GoogleTaskStore } = await import('../src/platform/storage/sharing-v2-google-tasks.ts'); let sequence=0;
  const store=createV2GoogleTaskStore({repository:h.owner.repository,userId:'owner',groupId,assertAccess(){},makeId:()=>`retained-google-undo-${++sequence}`,now:()=>new Date(h.now())});
  const control=await store.configure(0,{subject:'owner-google',label:'QA'},true); const namespace=control.state.householdId;
  const item=(await store.port.listEntriesForGoogleSync('2026-11-01',namespace)).find(row=>row.target.anchorDate==='2026-11-05'); assert.ok(item.completedAt);
  const link={householdId:namespace,choreId:item.target.choreId,scheduleEntryId:item.entry.id,googleTaskListId:'list',googleTaskId:'task',lastSyncedStatus:'completed',observedLocalRevision:item.localRevision,createdAt:new Date(h.now()).toISOString(),updatedAt:new Date(h.now()).toISOString()};
  await store.port.upsertGoogleTaskLink(link); await store.port.acknowledgeGoogleTaskStatus(link,'completed');
  const imported=await store.port.importGoogleTaskChanges([{...link,status:'needsAction'}]); assert.equal(imported,1);
  const state=await h.owner.repository.readState(); assert.equal(state.assessment.rejected.length,0);
  const plan=buildV2CommonPlan(state,{from:'2026-11-05',through:'2026-11-05',asOfDate:'2026-11-01'});
  assert.equal(plan.occurrences.find(row=>row.anchorDate==='2026-11-05').subjects[0].completed,false);
  assert.equal(state.replica.operations.filter(op=>op.entityType==='retainedCompletionUndo').length,1);
  assert.equal(await store.port.importGoogleTaskChanges([{...link,status:'needsAction'}]),0);
});

test('audit100 shared history certificates and packed authority positions remain identical across real English and Danish collation rules',async t=>{
 const h=await prepared(t,'2026-09-01',false);
 await h.owner.repository.commit([draft('Case.a','chore','floor',{name:'lower case'})]);await h.owner.repository.commit([draft('Case.A','chore','floor',{name:'upper case'})]);await h.deliver(h.owner,await loadSharedFacts(h.owner.database,groupId));
 const state=await h.owner.repository.readState();const input={...state,archive:h.archive,cutoff:'2026-10-01',throughSequence:h.head()};
 const original=String.prototype.localeCompare;const english=new Intl.Collator('en').compare,danish=new Intl.Collator('da').compare;
 try{String.prototype.localeCompare=function(other){return english(String(this),String(other));};const first=planV2HistoryRetention(input);
 String.prototype.localeCompare=function(other){return danish(String(this),String(other));};const next=planV2HistoryRetention(input);assert.deepEqual(next.body,first.body);assert.equal(next.body.format,2);
 }finally{String.prototype.localeCompare=original;}
});

test('audit100 legacy format-one signed history checkpoints still verify and restore without rewriting their certificate',async t=>{
 const h=await prepared(t,'2026-09-01',true,1);assert.equal(h.plan.body.format,1);assert.deepEqual(assertV2RetentionBase(h.replica,h.witness,h.archive),h.plan.body);
 const assessment=buildV2CommonPlan({replica:h.replica,assessment:(await h.owner.repository.readState()).assessment,archive:h.archive,receipts:h.receipts},{from:'2026-11-01',through:'2026-11-05',asOfDate:'2026-11-01'});assert.ok(assessment.initialized);
});
