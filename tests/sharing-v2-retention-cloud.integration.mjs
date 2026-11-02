import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { collection, doc, getDocFromServer, getDocsFromServer, deleteDoc, updateDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, wrapGroupKey, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { createV2Synchronizer } from '../src/features/sharing/v2/synchronizer.ts';
import { createSharedGroupManager } from '../src/features/sharing/group-manager.ts';
import { createSharedJoinRequest } from '../src/features/sharing/invitations.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { createV2HistoryRetentionRuntime } from '../src/features/sharing/v2/history-retention-runtime.ts';
import { readSharingCheckpoint, loadSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Retention attacks are restricted to the local Firestore emulator.');
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await environment?.cleanup(); });
const groupId = 'retention-cloud';

async function fixture(t) {
  const identity = await createDeviceIdentity(crypto); const memberIdentity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const roster = createSharedRoster(groupId, 'owner', identity, { schemaVersion: 2 });
  const store = uid => environment.authenticatedContext(uid).firestore(); const cloudFor = uid => createSharingCloud(store(uid), uid, () => uid, { ownerRecoveryEnabled: true });
  const cloud = cloudFor('owner'); await cloud.createGroup(roster, await wrapGroupKey(crypto, groupId, 1, key, identity, identity, 'owner'));
  let ordinal = 0;
  async function device(uid, identity, cloud, initialKey) {
    const h = createDatabase(); t.after(() => h.connection.close()); const keys = new Map(initialKey ? [[1, initialKey]] : []); let archive = [roster];
    const record = { userId: uid, groupId, status: 'active', displayName: '隔離した履歴検査', anchor: roster, rosterArchive: archive };
    await initializeV2EventStore(h.database, { userId: uid, groupId, householdId: 'shared' });
    const repository = createV2EventRepository(h.database, { userId: uid, groupId, householdId: 'shared', identity, anchor: roster, archive: () => archive, assertWritable() {} });
    const deps = { database: h.database, userId: uid, groupId, identity, cloud, crypto, repository,
      readRecord: async () => ({ ...record, rosterArchive: archive }), archive: () => archive,
      saveArchive: async value => { archive = value; }, readKey: async version => keys.get(version)?.slice() ?? null,
      saveKey: async (version, bytes) => keys.set(version, bytes.slice()), serialized: async work => work(), changed() {}, assertCurrentAccount() {} };
    const sync = createV2Synchronizer(deps); const manager = createSharedGroupManager({ ...deps, project: repository.project,
      sync: sync.sync, verifyMembership: sync.verifyMembership, makeId: () => `retention-${uid}-${++ordinal}`, markLeft: async () => {} });
    const retention = createV2HistoryRetentionRuntime({ repository, manager, sync: sync.sync, readOriginals: () => loadSharedFacts(h.database, groupId),
      readHead: async () => { const { group, roster } = await cloud.readGroup(groupId); const checkpoint = await readSharingCheckpoint(h.database, groupId);
        return { sequence: group.headSequence, localSequence: checkpoint.sequence, rotationRequired: group.rotationRequired, rosterDigest: sharedRosterDigest(roster) }; },
      assertAccess: async () => {}, makeId: () => `retention-${uid}-${++ordinal}` });
    return { ...h, repository, sync, manager, retention, deps, keys };
  }
  const owner = await device('owner', identity, cloud, key); const today = sharedLocalDate(new Date(), 'Asia/Tokyo'); const old = addDays(today, -65);
  await owner.repository.commit([
    { operationId: 'policy', entityType: 'groupPolicy', entityId: 'policy', operationType: 'patch', payload: { configuration: createGroupPolicy('family') } },
    { operationId: 'settings', entityType: 'settings', entityId: 'settings', operationType: 'patch', payload: { name: '履歴検査', timeZone: 'Asia/Tokyo', anchorDate: old } },
    { operationId: 'floor', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '床', enabled: true } },
    { operationId: 'configuration', entityType: 'chorePolicy', entityId: 'floor', operationType: 'patch', payload: { configuration: { policy: chorePolicyFromPreset('common'), anchorDate: old,
      intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } } },
  ]); await owner.sync.sync({ force: true });
  await owner.repository.commit([{ operationId: 'expired-original', entityType: 'completion', entityId: v2OccurrenceId(groupId, 'floor', old), operationType: 'complete',
    payload: { choreId: 'floor', anchorDate: old, completedAt: `${old}T01:00:00Z`, completedByMemberId: 'owner', subjectUserId: null,
      originalAssigneeIds: [], ruleVersion: 1, outcome: 'completed', completionNote: 'alreadyDone' } }]);
  await owner.sync.sync({ force: true });
  const link = await owner.manager.createInvitation(); const request = createSharedJoinRequest(link, 'member', memberIdentity, Date.now());
  const memberCloud = cloudFor('member'); await memberCloud.submitJoinRequest(link.invitation, request); await owner.manager.approve(link.invitation, request);
  const member = await device('member', memberIdentity, memberCloud); await member.sync.sync({ force: true });
  return { owner, member, device, memberIdentity, cloud, memberCloud, cloudFor, store, today, old };
}

test('collective retention rotates keys and actually removes old cloud ciphertext and receipts while fresh replicas and subsequent edits survive', async t => {
  const h = await fixture(t); const root = doc(h.store('owner'), 'sharingGroups', groupId); const oldRoot = (await h.cloud.readGroup(groupId)).group;
  assert.equal((await h.owner.retention.run()).kind, 'waiting'); await h.member.sync.sync({ force: true });
  assert.equal((await h.member.retention.run()).kind, 'waiting'); await h.owner.sync.sync({ force: true });
  assert.equal((await h.owner.retention.run()).kind, 'published');
  const state = await h.owner.repository.readState(); const body = state.replica.retention.proposal.operation.payload.checkpoint;
  const current = (await h.cloud.readGroup(groupId)).group;
  assert.equal(current.keyVersion, oldRoot.keyVersion + 1); assert.equal(current.retentionKeyVersion, oldRoot.keyVersion);
  assert.equal(current.retentionThroughSequence, body.throughSequence); assert.equal(current.retentionCutoff, body.cutoff);
  assert.equal(state.replica.operations.some(op => op.operationId === 'expired-original'), false);
  let deleted = 0;
  for (let n = 0; n < 20; n++) { const r = await h.cloud.compactCertifiedHistory(groupId, body, new Set(state.replica.operations.map(op => op.operationId))); deleted += r.deleted; if (!r.pending) break; }
  assert.ok(deleted > 0);
  assert.equal((await getDocFromServer(doc(root, 'receipts', 'expired-original'))).exists(), false);
  assert.ok((await getDocsFromServer(collection(root, 'events'))).docs.every(row => row.data().uploadSequence > body.throughSequence));
  const snapshots = await getDocsFromServer(collection(root, 'snapshots')); assert.deepEqual(snapshots.docs.map(row => row.id), [current.snapshotId]);
  const chunks = await getDocsFromServer(collection(root, 'snapshotChunks'));
  assert.ok(chunks.size > 0); assert.ok(chunks.docs.every(row => row.data().snapshotId === current.snapshotId));
  for (const op of state.replica.operations) assert.equal((await getDocFromServer(doc(root, 'receipts', op.operationId))).exists(), true);
  await assertFails(deleteDoc(doc(h.store('member'), 'sharingGroups', groupId, 'receipts', 'floor')));
  await assertFails(deleteDoc(doc(h.store('foreign'), 'sharingGroups', groupId, 'snapshots', current.snapshotId)));
  const latest = state.replica.operations.find(op => op.entityType === 'historyRetention');
  await assertFails(deleteDoc(doc(root, 'receipts', latest.operationId)));
  await assertFails(updateDoc(root, { retentionThroughSequence: Math.max(0, body.throughSequence - 1), updatedAt: serverTimestamp() }));
  const fresh = await h.device('member', h.memberIdentity, h.memberCloud); await fresh.sync.sync({ force: true });
  const restored = await fresh.repository.readState(); assert.equal(sharedDocumentDigest(restored.replica.retention), sharedDocumentDigest(state.replica.retention));
  assert.equal(restored.replica.operations.some(op => op.operationId === 'expired-original'), false);
  assert.equal(buildV2CommonPlan(restored, { from: h.today, through: addDays(h.today, 7), asOfDate: h.today }).history.length, 0);
  // A post-checkpoint operation gets independent server evidence and cannot be erased by the previous cut.
  await h.owner.repository.commit([{ operationId: 'recent-name', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '新しい家事名' } }]);
  await h.owner.sync.sync({ force: true }); await fresh.sync.sync({ force: true });
  await h.cloud.compactCertifiedHistory(groupId, body, new Set((await h.owner.repository.readState()).replica.operations.map(op => op.operationId)));
  assert.equal((await getDocFromServer(doc(root, 'events', 'recent-name'))).exists(), true);
  assert.equal((await fresh.repository.readState()).assessment.view.ofType('chore').at(-1).payload.name, '新しい家事名');
  await h.owner.manager.publishSnapshot(); await fresh.sync.sync({ force: true });
  assert.equal((await h.cloud.readGroup(groupId)).group.retentionCutoff, body.cutoff);
  await h.owner.manager.removeMembers(['member']);
  await assert.rejects(h.memberCloud.readGroup(groupId), /permission|利用できません|denied/i);
  const final = (await h.cloud.readGroup(groupId)).group;
  const lock = doc(root, 'recoveryLocks', 'current');
  await environment.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(), lock.path), { keyVersion: final.keyVersion }); });
  await assert.rejects(h.cloud.compactCertifiedHistory(groupId, body, new Set()), /復旧/);
  await assertFails(deleteDoc(doc(root, 'receipts', 'floor')));
  await environment.withSecurityRulesDisabled(async context => { await deleteDoc(doc(context.firestore(), lock.path)); });
});
