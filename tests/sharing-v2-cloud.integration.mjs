import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createDeviceIdentity, signSharedDocument, encryptSharedOperation, decryptAuthenticatedSharedOperation, signSharedOperation, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, upgradeSharedRoster, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { v2AuthorProofDigest, bindV2ServerReceipt } from '../src/features/sharing/v2/server-receipts.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { createV2Synchronizer } from '../src/features/sharing/v2/synchronizer.ts';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { V2_SCHEDULER_VERSION } from '../src/features/sharing/v2/payload-schema.ts';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { addDays as addLocalDays } from '../src/domain/scheduling/local-date.ts';
import { selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createSharedGroupManager } from '../src/features/sharing/group-manager.ts';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
import { createV2NativePair, V2_PAIR_PROJECT } from '../src/features/sharing/development/v2-native-pair.ts';
import { readCloudWorkspaceArchive } from '../src/features/sharing/workspace-protocol.ts';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { applianceResult, uploadedApplianceResult } from './helpers/sharing-v2-appliance.mjs';
import { readV2ManualDocument } from '../src/features/sharing/v2/manual-documents.ts';
import { applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { createSharedJoinRequest } from '../src/features/sharing/invitations.ts';
import { createV2PersonalCopyStore } from '../src/platform/storage/sharing-v2-personal-copy.ts';
import { createV2CompletionNoticeStore } from '../src/platform/storage/sharing-v2-completion-notices.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { projectCalendarEvents, calendarEventsInTimeZone } from '../src/domain/calendar/events.ts';
import { projectSharedCalendarRecords } from '../src/features/calendar/shared-events.ts';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
const { readPersonalChoreCopySource } = await import('../src/platform/storage/repository.ts');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run v2 cloud tests only against the local emulator.');
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await environment?.cleanup(); });
const groupId = 'v2-cloud-group';
async function fixture(schemaVersion = 2, schedulerVersion, paid = false) {
  if (paid) await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore(); await setDoc(doc(db, 'serviceConfiguration/billing'), { enforced: true });
    await setDoc(doc(db, 'billingEntitlements/owner'), { userId: 'owner', status: 'active', validUntil: Date.now() + 3600_000, expiresAt: Date.now() + 86400_000 });
  });
  const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const store = environment.authenticatedContext('owner').firestore(); let active = 'owner';
  const cloud = createSharingCloud(store, 'owner', () => active);
  const roster = createSharedRoster(groupId, 'owner', identity, { schemaVersion });
  if (schedulerVersion) { roster.body.schedulerVersion = schedulerVersion; roster.signature = signSharedDocument({ domain: 'liflow-shared-roster-v1', body: roster.body }, identity); }
  const wrapped = await wrapGroupKey(crypto, groupId, 1, key, identity, identity, 'owner');
  await cloud.createGroup(roster, wrapped);
  const make = async (sequence, patch = {}) => {
    const operation = { schemaVersion: 2, receiptContext: {}, recordedAt: '2030-01-01T00:00:00Z', groupId, operationId: `operation-${sequence}`,
      authorUserId: 'owner', authorDeviceId: identity.deviceId, keyVersion: 1, deviceSequence: sequence, logicalClock: sequence,
      context: sequence > 1 ? { [identity.deviceId]: sequence - 1 } : {}, entityType: 'chore', entityId: 'floor', operationType: 'patch',
      payload: { name: `秘密のv2家事 ${sequence}` }, ...patch };
    const fact = signSharedOperation(operation, identity);
    return { fact, envelope: await encryptSharedOperation(crypto, operation, key, identity), authorProofDigest: v2AuthorProofDigest(fact) };
  };
  return { identity, key, roster, store, cloud, make, root: doc(store, 'sharingGroups', groupId), switchAccount: () => { active = 'another'; } };
}

test('paid v2 groups create and commit encrypted receipts within Rules limits and retry the same queued edit after subscription renewal', async () => {
  const f = await fixture(2, undefined, true); const first = await f.make(1);
  const sent = await f.cloud.upload(first.envelope, { authorProofDigest: first.authorProofDigest });
  assert.equal(sent.serverReceipt.uploadSequence, 1);
  const next = await f.make(2);
  await environment.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'billingEntitlements/owner'), {
    userId: 'owner', status: 'expired', validUntil: 0, expiresAt: 0,
  }));
  await assert.rejects(f.cloud.upload(next.envelope, { authorProofDigest: next.authorProofDigest }));
  await environment.withSecurityRulesDisabled(async context => {
    assert.equal((await getDocFromServer(doc(context.firestore(), 'sharingGroups', groupId))).data().headSequence, 1);
    await setDoc(doc(context.firestore(), 'billingEntitlements/owner'), {
      userId: 'owner', status: 'active', validUntil: Date.now() + 3600_000, expiresAt: Date.now() + 86400_000,
    });
  });
  const retried = await f.cloud.upload(next.envelope, { authorProofDigest: next.authorProofDigest });
  assert.equal(retried.serverReceipt.uploadSequence, 2);
  assert.equal((await f.cloud.pull(groupId, 0)).events.length, 2);
});

test('v2 workspace sessions restore real encrypted bootstrap and offline edits across approved user devices without private planner adapters', async () => {
  const f = await fixture(); const ownerDb = createDatabase(); const memberDb = createDatabase(); let rejoinedDb;
  const memberIdentity = await createDeviceIdentity(crypto); const now = new Date(); const anchorDate = sharedLocalDate(now, 'Asia/Tokyo');
  let ownerArchive = [f.roster]; let memberArchive; let ownerActive = true; let ordinal = 0;
  let ownerRecord = { userId: 'owner', groupId, status: 'creating', displayName: 'セッション検査', anchor: f.roster, rosterArchive: ownerArchive,
    creation: { wrappedKey: {}, timeZone: 'Asia/Tokyo', anchorDate, ownerDisplayName: '所有者' } };
  const ownerKeys = new Map([[1, f.key]]); const memberKeys = new Map();
  function dependencies(h, userId, identity, cloud, keys, readRecord, saveArchive, archive) {
    return { database: h.database, householdId: 'v2-session-only', userId, groupId, identity, cloud, crypto, readRecord, saveArchive, archive,
      readKey: async (version) => keys.get(version)?.slice() ?? null, saveKey: async (version, value) => { keys.set(version, value.slice()); },
      serialized: async (work) => work(), changed: () => {}, assertCurrentAccount: () => { if (userId === 'owner' && !ownerActive) throw new Error('account changed'); },
      assertWritable: () => {}, makeId: () => `session-${userId}-${++ordinal}`, markLeft: async () => {} };
  }
  const ownerDeps = dependencies(ownerDb, 'owner', f.identity, f.cloud, ownerKeys, async () => ({ ...ownerRecord, rosterArchive: ownerArchive }),
    async (value) => { ownerArchive = value; }, () => ownerArchive);
  try {
    const owner = await createV2WorkspaceSession({ ...ownerDeps, creationKind: 'roommates' }); await owner.synchronizer.sync({ force: true });
    assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, 39);
    ownerRecord = { ...ownerRecord, status: 'active' };
    const invite = await owner.manager.createInvitation(); const request = createSharedJoinRequest(invite, 'member', memberIdentity, Date.now());
    const memberCloud = createSharingCloud(environment.authenticatedContext('member').firestore(), 'member', () => 'member');
    await memberCloud.submitJoinRequest(invite.invitation, request); await owner.manager.approve(invite.invitation, request);
    const joining = { userId: 'member', groupId, status: 'joining', anchor: invite.invitation.body.pin, rosterArchive: [], join: { invitation: invite.invitation, request } };
    memberArchive = await readCloudWorkspaceArchive(joining, (await memberCloud.readGroup(groupId)).roster, memberCloud.readRoster);
    const memberDeps = dependencies(memberDb, 'member', memberIdentity, memberCloud, memberKeys, async () => ({ ...joining, rosterArchive: memberArchive }),
      async (value) => { memberArchive = value; }, () => memberArchive);
    const member = await createV2WorkspaceSession(memberDeps); await member.synchronizer.sync({ force: true });
    const range = { from: anchorDate, through: addLocalDays(anchorDate, 14), asOfDate: anchorDate };
    const initial = await member.controller.readModel(range); assert.equal(initial.plan.policy.kind, 'roommates');
    assert.equal(initial.plan.chores.length, 36); assert.equal(initial.plan.occurrences.length, 0);
    const privateData = await privateFixture();
    try {
      const source = { ...await readPersonalChoreCopySource(privateData.database), scope: 'personal', ownerUserId: 'owner' };
      const privateRows = () => privateData.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map(({ name }) => [name, privateData.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
      const beforePrivate = privateRows();
      const copy = createV2PersonalCopyStore({ repository: owner.repository, userId: 'owner', groupId, assertAccess: () => {},
        makeId: () => `session-copy-${++ordinal}`, now: () => new Date() });
      const beforeCopyHead = (await f.cloud.readGroup(groupId)).group.headSequence;
      const prepared = await copy.prepare(0, source, [privateData.chore.id], 'eachMember');
      await owner.synchronizer.sync({ force: true }); assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, beforeCopyHead);
      await copy.confirm(prepared.review, source); await owner.synchronizer.sync({ force: true }); await member.synchronizer.sync({ force: true });
      const sharedCopy = prepared.review.records[0]; const deliveredCopy = (await member.controller.readModel(range)).plan;
      assert.equal(deliveredCopy.chores.find(row => row.id === sharedCopy.sharedChoreId).name, privateData.chore.name);
      const copiedRound = deliveredCopy.occurrences.find(row => row.choreId === sharedCopy.sharedChoreId);
      assert.equal(copiedRound.subjects.length, 2); assert.ok(copiedRound.subjects.every(row => !row.completed));
      assert.equal(deliveredCopy.history.length, 0); assert.deepEqual(privateRows(), beforePrivate);
      const encryptedCopy = JSON.stringify((await getDocFromServer(doc(f.root, 'events', sharedCopy.choreOperationId))).data());
      for (const privateValue of [privateData.chore.id, privateData.chore.name, privateData.chore.description]) assert.equal(encryptedCopy.includes(privateValue), false);
      const sent = await copy.read(); assert.equal(sent.synchronization, 'sent');
      await copy.confirm(prepared.review); await owner.synchronizer.sync({ force: true });
      assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, beforeCopyHead + 2);
      const noticeInput = { repository: owner.repository, userId: 'owner', groupId, assertAccess: () => {} };
      const notices = createV2CompletionNoticeStore(noticeInput); assert.equal(await notices.enabled(), false);
      await owner.controller.actions.patchGroupPolicy({ completionPushEnabled: true });
      await owner.synchronizer.sync({ force: true }); await member.synchronizer.sync({ force: true });
      assert.equal(await notices.collect(true, new Date()), null, 'opt-in initializes a non-notifying baseline');
      const [copyCompleted] = await member.controller.actions.complete({ choreId: sharedCopy.sharedChoreId, anchorDate: sharedCopy.configuration.anchorDate, ruleVersion: 1, subjectUserId: 'member' });
      assert.equal(await notices.collect(true, new Date()), null, 'unreceived work is not notified');
      await member.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
      const receivedNotice = await notices.collect(true, new Date()); assert.equal(receivedNotice.keys.length, 1); assert.deepEqual(receivedNotice.names, [privateData.chore.name]);
      const afterNotice = await f.cloud.readGroup(groupId); const restoredNotices = createV2CompletionNoticeStore(noticeInput);
      assert.equal(await restoredNotices.collect(true, new Date()), null); assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, afterNotice.group.headSequence);
      await member.controller.actions.undo(copyCompleted.operationId); await member.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
      assert.equal(await notices.collect(true, new Date()), null);
      await owner.controller.actions.patchGroupPolicy({ completionPushEnabled: false }); await owner.synchronizer.sync({ force: true }); await member.synchronizer.sync({ force: true });
      assert.deepEqual(privateRows(), beforePrivate, 'received-completion metadata remains outside the original personal database');
    } finally { privateData.connection.close(); }
    const chore = initial.plan.chores[0];
    await member.repository.commit([{ operationId: 'session-offline-edit', entityType: 'chore', entityId: chore.id, operationType: 'patch', payload: { name: '再起動後も残る変更' } }]);
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 1);
    const restart = await createV2WorkspaceSession(memberDeps);
    assert.equal((await restart.controller.readModel(range)).plan.chores.find((item) => item.id === chore.id).name, '再起動後も残る変更');
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.deepEqual((await owner.controller.readModel(range)).plan, (await restart.controller.readModel(range)).plan);
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0);
    const field = async (session) => (await session.controller.readModel(range, { detailChoreId: chore.id })).choreDetails[0].fields.name;
    const ownerBase = await field(owner); const memberBase = await field(restart);
    await owner.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: '所有者のオフライン編集', basisOperationIds: ownerBase.candidates.map((source) => source.operationId) }]);
    await restart.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: 'メンバーのオフライン編集', basisOperationIds: memberBase.candidates.map((source) => source.operationId) }]);
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    const conflict = await field(restart); assert.equal(conflict.kind, 'conflict'); assert.equal(conflict.candidates.length, 2);
    assert.deepEqual(await field(owner), conflict);
    const observed = conflict.candidates.map((source) => source.operationId); const beforeResolution = (await f.cloud.readGroup(groupId)).group.headSequence;
    await assert.rejects(restart.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: '黙った上書き', basisOperationIds: observed }]), { code: 'sharing/v2-stale-settings' });
    assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, beforeResolution);
    await restart.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: '両方を確認した名前', basisOperationIds: observed, resolveOperationIds: observed }]);
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.equal((await field(owner)).value, '両方を確認した名前'); assert.deepEqual(await field(owner), await field(restart));
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0);
    const policy = (await owner.controller.readModel(range, { groupPolicy: true })).groupPolicy;
    const basisOperationIds = policy.candidates.map(source => source.operationId);
    const headBeforePolicy = (await f.cloud.readGroup(groupId)).group.headSequence;
    await assert.rejects(restart.controller.actions.editGroupPolicy({ value: { ...policy.value, delegationEnabled: true }, basisOperationIds }), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0); assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, headBeforePolicy);
    const updatedPolicy = { ...policy.value, kind: 'family', delegationEnabled: true };
    await owner.controller.actions.editGroupPolicy({ value: updatedPolicy, basisOperationIds });
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    for (const session of [owner, restart]) {
      const model = await session.controller.readModel(range, { groupPolicy: true });
      assert.deepEqual(model.groupPolicy.value, updatedPolicy); assert.deepEqual(model.plan.policy, updatedPolicy);
      assert.equal((await session.repository.readState()).assessment.view.ofType('datePermission').length, 0);
    }
    const rightsSource = async session => session.controller.readModel(range, { permissionsChoreId: chore.id });
    const beforeGrant = await rightsSource(owner); const policyIds = beforeGrant.groupPolicy.candidates.map(source => source.operationId);
    const grantedRights = { enabled: true, rights: { changeDate: true, changeOthers: false, changeBeforeWindow: true } };
    await owner.controller.actions.editDateRights(chore.id, [{ userId: 'member', expectedMembershipStart: beforeGrant.dateRights.membershipStarts.member, value: grantedRights, basisOperationIds: [] }], policyIds);
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    const delivered = await rightsSource(restart); assert.deepEqual(delivered.dateRights.fields.member.value, grantedRights);
    const grantIds = delivered.dateRights.fields.member.candidates.map(source => source.operationId);
    await assert.rejects(restart.controller.actions.editDateRights(chore.id, [{ userId: 'member', expectedMembershipStart: beforeGrant.dateRights.membershipStarts.member, value: { ...grantedRights, enabled: false }, basisOperationIds: grantIds }], policyIds), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0);
    const groupBefore = (await owner.controller.readModel(range, { groupPolicy: true })).groupPolicy;
    await owner.controller.actions.editGroupPolicy({ value: { ...updatedPolicy, delegationEnabled: false }, basisOperationIds: groupBefore.candidates.map(source => source.operationId) });
    await assert.rejects(owner.controller.actions.editDateRights(chore.id, [{ userId: 'member', expectedMembershipStart: beforeGrant.dateRights.membershipStarts.member, value: { ...grantedRights, enabled: false }, basisOperationIds: grantIds }], policyIds), { code: 'sharing/v2-stale-settings' });
    const disabled = await rightsSource(owner);
    await owner.controller.actions.editDateRights(chore.id, [{ userId: 'member', expectedMembershipStart: beforeGrant.dateRights.membershipStarts.member, value: { ...grantedRights, enabled: false }, basisOperationIds: grantIds }], disabled.groupPolicy.candidates.map(source => source.operationId));
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    for (const session of [owner, restart]) assert.equal((await rightsSource(session)).dateRights.fields.member.value.enabled, false);
    const beforeRejoin = await rightsSource(owner);
    await owner.controller.actions.editGroupPolicy({ value: updatedPolicy, basisOperationIds: beforeRejoin.groupPolicy.candidates.map(source => source.operationId) });
    const enabled = await rightsSource(owner);
    await owner.controller.actions.editDateRights(chore.id, [{ userId: 'member', value: grantedRights,
      expectedMembershipStart: enabled.dateRights.membershipStarts.member, basisOperationIds: enabled.dateRights.fields.member.candidates.map(source => source.operationId) }], enabled.groupPolicy.candidates.map(source => source.operationId));
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    const wasteRead = async session => (await session.controller.readModel(range, { waste: true })).waste;
    const wasteCreated = await restart.controller.actions.addWasteSchedule({ label: '秘密の共有収集日', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 28 });
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.deepEqual(await wasteRead(owner), await wasteRead(restart));
    const wasteBase = (await wasteRead(owner)).rows[0]; const wasteId = wasteBase.id;
    await owner.controller.actions.editWasteSchedule(wasteId, [{ field: 'rule', value: { recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31, anchorDate: null }, basisOperationIds: wasteBase.fields.rule.candidates.map(source => source.operationId) }]);
    await restart.controller.actions.editWasteSchedule(wasteId, [{ field: 'label', value: '秘密の資源ごみ', basisOperationIds: wasteBase.fields.label.candidates.map(source => source.operationId) }]);
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    const mergedWaste = await wasteRead(owner); assert.deepEqual(mergedWaste, await wasteRead(restart));
    assert.equal(mergedWaste.schedules[0].label, '秘密の資源ごみ'); assert.equal(mergedWaste.schedules[0].monthlyDay, 31);
    const collection = mergedWaste.occurrences[0]; assert.ok(collection);
    await owner.controller.actions.setWasteOccurrenceHidden(collection.selection, true);
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    const hiddenWaste = await wasteRead(restart); assert.equal(hiddenWaste.occurrences[0].hidden, true);
    await restart.controller.actions.setWasteOccurrenceHidden(hiddenWaste.occurrences[0].selection, false);
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    const expectedWaste = await wasteRead(owner); assert.equal(expectedWaste.occurrences[0].hidden, false); assert.deepEqual(expectedWaste, await wasteRead(restart));
    const encryptedWaste = (await getDocFromServer(doc(f.root, 'events', wasteCreated[0].operationId))).data();
    assert.equal(JSON.stringify(encryptedWaste).includes('秘密の共有収集日'), false); assert.equal(JSON.stringify(encryptedWaste).includes('秘密の資源ごみ'), false);
    const reviewedAppliance = applianceResult(); reviewedAppliance.product.productName = '秘密の共有家電';
    const applianceSaved = await restart.controller.actions.reviewAppliance({ reviewed: true, result: reviewedAppliance, addTaskNames: ['フィルター清掃'] });
    assert.equal(applianceSaved.createdChoreIds.length, 1);
    const applianceRead = async session => (await session.controller.readModel(range, { appliances: true, applianceId: applianceSaved.applianceId })).appliances;
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.deepEqual(await applianceRead(owner), await applianceRead(restart));
    const oldAppliance = (await applianceRead(owner)).detail;
    reviewedAppliance.analysis.tasks[0].steps = ['再解析した秘密の手順'];
    await owner.controller.actions.reviewAppliance({ reviewed: true, result: reviewedAppliance, selection: oldAppliance.row.selection, addTaskNames: [] });
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    const applianceUpdated = (await applianceRead(restart)).detail;
    assert.deepEqual(applianceUpdated.appliance.analysis.tasks[0].steps, ['再解析した秘密の手順']);
    const linked = (await restart.controller.readModel(range)).plan.chores.find(item => item.id === applianceSaved.createdChoreIds[0]);
    assert.deepEqual(linked.instructions, ['電源を切る', '公式の手順で手入れする']); assert.equal(linked.enabled, false);
    const encryptedAppliance = (await getDocFromServer(doc(f.root, 'events', applianceSaved.operations.find(op => op.entityType === 'appliance').operationId))).data();
    for (const secret of ['秘密の共有家電', 'フィルター清掃', 'dyson.co.jp', applianceSaved.applianceId]) assert.equal(JSON.stringify(encryptedAppliance).includes(secret), false);
    await restart.controller.actions.deleteAppliance(applianceUpdated.row.selection);
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    const expectedAppliances = await applianceRead(owner); assert.equal(expectedAppliances.detail.row.deleted, true);
    assert.equal((await owner.controller.readModel(range)).plan.chores.some(item => item.id === linked.id), true);
    await owner.manager.removeMembers(['member']); await assertFails(memberCloud.readGroup(groupId));
    const rejoinInvite = await owner.manager.createInvitation(); const rejoinRequest = createSharedJoinRequest(rejoinInvite, 'member', memberIdentity, Date.now());
    await memberCloud.submitJoinRequest(rejoinInvite.invitation, rejoinRequest); await owner.manager.approve(rejoinInvite.invitation, rejoinRequest);
    const rejoinRecord = { userId: 'member', groupId, status: 'joining', anchor: rejoinInvite.invitation.body.pin, rosterArchive: [], join: { invitation: rejoinInvite.invitation, request: rejoinRequest } };
    let rejoinArchive = await readCloudWorkspaceArchive(rejoinRecord, (await memberCloud.readGroup(groupId)).roster, memberCloud.readRoster);
    rejoinedDb = createDatabase();
    const rejoined = await createV2WorkspaceSession(dependencies(rejoinedDb, 'member', memberIdentity, memberCloud, new Map(),
      async () => ({ ...rejoinRecord, rosterArchive: rejoinArchive }), async value => { rejoinArchive = value; }, () => rejoinArchive));
    await rejoined.synchronizer.sync({ force: true });
    assert.deepEqual(await wasteRead(rejoined), expectedWaste);
    assert.deepEqual(await applianceRead(rejoined), expectedAppliances);
    const fresh = await rightsSource(rejoined); assert.equal(fresh.dateRights.membershipStarts.member, 4); assert.equal(fresh.dateRights.fields.member.kind, 'missing');
    assert.ok((await rejoined.repository.readState()).assessment.view.ofType('datePermission').length > 0, 'historical grants stay in the authenticated snapshot');
    const ownerFresh = await rightsSource(owner);
    await assert.rejects(owner.controller.actions.editDateRights(chore.id, [{ userId: 'member', value: grantedRights, expectedMembershipStart: 2, basisOperationIds: [] }], ownerFresh.groupPolicy.candidates.map(source => source.operationId)), { code: 'sharing/v2-stale-settings' });
    await owner.controller.actions.editDateRights(chore.id, [{ userId: 'member', value: grantedRights,
      expectedMembershipStart: ownerFresh.dateRights.membershipStarts.member, basisOperationIds: [] }], ownerFresh.groupPolicy.candidates.map(source => source.operationId));
    await owner.synchronizer.sync({ force: true }); await rejoined.synchronizer.sync({ force: true });
    assert.deepEqual((await rightsSource(rejoined)).dateRights.fields.member.value, grantedRights);
    ownerActive = false; await assert.rejects(owner.synchronizer.sync({ force: true }), /account changed/u);
    assert.equal(ownerDb.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(memberDb.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { ownerDb.connection.close(); memberDb.connection.close(); rejoinedDb?.connection.close(); }
});

test('normal v2 workspace creation uses the real gateway and Rules and a no-change sync cannot enqueue another local edit', async () => {
  const f = { cloud: createSharingCloud(environment.authenticatedContext('owner').firestore(), 'owner', () => 'owner') };
  const h = await workspaceHarness({ cloud: f.cloud, deferWorkspaceTimers: true, initiallyEmpty: true });
  try {
    const workspace = await h.api.createV2SharingWorkspace('新しい家族', 'family', 'Asia/Tokyo');
    const result = await workspace.sync({ force: true, budgetMs: 120_000 }); assert.equal(result.complete, true); assert.equal(result.pending, 0);
    const record = await workspace.record(); assert.equal(record.status, 'active'); assert.ok(record.lastSuccessfulSyncAt); assert.equal(record.lastErrorCode, null);
    assert.equal((await f.cloud.readGroup(workspace.groupId)).group.headSequence, 39); assert.equal((await workspace.checkpoint()).pendingCount, 0);
    const state = await workspace.session.repository.readState(); const at = v2ReadPoint(state.assessment.view, state.archive.at(-1));
    assert.equal(state.assessment.view.field('groupPolicy', 'policy', 'configuration', at).value.kind, 'family');
    assert.equal((await workspace.readOverview()).chores.length, 36);
    await workspace.sync({ force: true }); assert.equal((await f.cloud.readGroup(workspace.groupId)).group.headSequence, 39);
    await h.api.saveSharingSelection(record); assert.deepEqual(JSON.parse(h.vault.get('active-workspace')), { groupId: workspace.groupId, userId: 'owner' });
    h.auth.uid = 'another-user'; await assert.rejects(workspace.session.controller.actions.addChore('拒否される追加'));
    assert.equal((await workspace.checkpoint()).pendingCount, 0);
  } finally { await h.close(); }
});

test('v2 cloud commits immutable server receipts with encrypted events, bounds receipt recovery and keeps the same original timestamp on retry', async () => {
  const f = await fixture(); const facts = []; let first;
  for (let sequence = 1; sequence <= 205; sequence++) {
    const item = await f.make(sequence); facts.push(item.fact);
    const sent = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
    assert.equal(sent.serverReceipt.uploadSequence, sequence); assert.equal(sent.serverReceipt.receivedKeyVersion, 1);
    bindV2ServerReceipt(sent.serverReceipt, item.fact, [f.roster]);
    assert.ok(Math.abs(sent.serverReceipt.receivedAtMs - Date.now()) < 60_000);
    if (sequence === 1) {
      first = sent; const retry = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
      assert.deepEqual(retry.serverReceipt, sent.serverReceipt);
    }
  }
  const recovered = await f.cloud.readReceipts(groupId, facts.map((fact) => fact.operation.operationId));
  assert.deepEqual(await f.cloud.readReceipts(groupId, facts.map((fact) => fact.operation.operationId), { deadlineAtMs: Date.now() - 1 }), []);
  assert.equal(recovered.length, 205); assert.deepEqual(recovered.find((receipt) => receipt.operationId === 'operation-1'), first.serverReceipt);
  const page = await f.cloud.pull(groupId, 0); const second = await f.cloud.pull(groupId, 100); const third = await f.cloud.pull(groupId, 200);
  assert.deepEqual([page.events.length, second.events.length, third.events.length], [100, 100, 5]);
  assert.deepEqual(page.events[0].serverReceipt, first.serverReceipt);
  const raw = (await getDocFromServer(doc(f.root, 'receipts', 'operation-1'))).data();
  assert.deepEqual(Object.keys(raw).sort(), ['authorDeviceId', 'authorProofDigest', 'authorUserId', 'createdAt', 'keyVersion', 'schemaVersion', 'uploadSequence']);
  assert.equal(JSON.stringify(raw).includes('秘密'), false); assert.equal(JSON.stringify(raw).includes('authorSignature'), false);
  await assert.rejects(f.cloud.readReceipts(groupId, Array.from({ length: 1001 }, (_, index) => `id-${index}`)));
  f.switchAccount(); await assert.rejects(f.cloud.readReceipts(groupId, ['operation-1']), /切り替わり/);
});
test('v2 Rules deny forged receipt clocks, missing or mismatched paired receipts, other accounts and receipt rewrites or removal', async () => {
  const f = await fixture();
  async function forged({ omitReceipt = false, eventChange = {}, receiptChange = {}, updateRoot = true } = {}) {
    const event = { schemaVersion: 2, authorUserId: 'owner', authorDeviceId: f.identity.deviceId, keyVersion: 1,
      uploadSequence: 1, envelopeJson: 'ciphertext-only', authorProofDigest: 'a'.repeat(64), createdAt: serverTimestamp(), ...eventChange };
    const { envelopeJson: _encrypted, ...receipt } = event;
    const batch = writeBatch(f.store); batch.set(doc(f.root, 'events', 'forged'), event);
    if (!omitReceipt) batch.set(doc(f.root, 'receipts', 'forged'), { ...receipt, ...receiptChange });
    if (updateRoot) batch.update(f.root, { headSequence: 1, lastOperationId: 'forged', updatedAt: serverTimestamp() });
    return batch.commit();
  }
  await assertFails(forged({ omitReceipt: true }));
  await assertFails(forged({ eventChange: { createdAt: Timestamp.fromMillis(1000) }, receiptChange: { createdAt: Timestamp.fromMillis(1000) } }));
  await assertFails(forged({ receiptChange: { authorProofDigest: 'b'.repeat(64) } }));
  await assertFails(forged({ updateRoot: false }));
  assert.equal((await getDocFromServer(f.root)).data().headSequence, 0);
  const item = await f.make(1); await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
  const ref = doc(f.root, 'receipts', item.fact.operation.operationId);
  await assertFails(updateDoc(ref, { createdAt: serverTimestamp() })); await assertFails(deleteDoc(ref));
  await assertFails(getDocFromServer(doc(environment.authenticatedContext('outsider').firestore(), 'sharingGroups', groupId, 'receipts', 'operation-1')));
  await assertFails(setDoc(doc(f.root, 'receipts', 'unpaired'), { ...(await getDocFromServer(ref)).data(), createdAt: serverTimestamp() }));
});
test('v2 compacted events retain their original server receipt and retry requests a verified snapshot rather than recreating an acceptance time', async () => {
  const f = await fixture(); const item = await f.make(1); const accepted = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
  const replica = buildSharedReplica(groupId, [item.fact.operation]);
  const snapshot = await createEncryptedSharedSnapshot(crypto, replica, [item.fact], f.roster, f.identity, f.key, 'v2-compact', 1,
    (uid, device, version) => sharedAuthorIdentity(f.roster, uid, device, version));
  await f.cloud.prepareSnapshot(snapshot, f.roster); await f.cloud.publishSnapshot(snapshot.manifest, f.roster);
  await deleteDoc(doc(f.root, 'events', 'operation-1'));
  await assert.rejects(f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest }), { code: 'sharing/snapshot-required' });
  assert.deepEqual((await f.cloud.readReceipts(groupId, ['operation-1']))[0], accepted.serverReceipt);
  assert.equal((await getDocFromServer(f.root)).data().headSequence, 1);
});
test('v2 Rules require an explicit owner-preserving protocol upgrade snapshot and prevent downgrade', async () => {
  const f = await fixture(1); const next = upgradeSharedRoster(f.roster, f.identity);
  const fields = (await import('../src/features/sharing/cloud-contract.ts')).rosterCloudFields(next);
  const snapshotId = 'upgrade-snapshot';
  const mutate = async (extra = {}, includeSnapshot = false) => {
    const batch = writeBatch(f.store);
    batch.update(f.root, { ...fields, snapshotId, snapshotThroughSequence: 0, updatedAt: serverTimestamp(), ...extra });
    batch.set(doc(f.root, 'rosters', '2'), { rosterJson: fields.rosterJson, createdAt: serverTimestamp() });
    if (includeSnapshot) batch.set(doc(f.root, 'snapshots', snapshotId), { keyVersion: 2, throughSequence: 0, manifestJson: 'signed-encrypted-v2-manifest', createdAt: serverTimestamp() });
    return batch.commit();
  };
  await assertFails(mutate());
  await assertFails(mutate({ ownerUserId: 'outsider', memberIds: ['outsider'], deviceOwners: { [f.identity.deviceId]: 'outsider' } }, true));
  await mutate({}, true);
  const batch = writeBatch(f.store); batch.update(f.root, { schemaVersion: 1, keyVersion: 3, rosterRevision: 3, rosterJson: 'downgrade', updatedAt: serverTimestamp() });
  batch.set(doc(f.root, 'rosters', '3'), { rosterJson: 'downgrade', createdAt: serverTimestamp() });
  await assertFails(batch.commit());
});
test('v2 real gateway and Rules synchronize isolated SQLite users through key rotation, snapshot, edit, completion and targeted undo', async () => {
  const f = await fixture(); const memberIdentity = await createDeviceIdentity(crypto); let key2;
  function device(userId, identity, cloud, keys) {
    const h = createDatabase(); let archive = [f.roster];
    const repository = createV2EventRepository(h.database, { groupId, userId, householdId: 'local', identity, anchor: f.roster,
      archive: () => archive, assertWritable: () => {} });
    const dependencies = { database: h.database, groupId, userId, identity, crypto, cloud,
      readRecord: async () => ({ groupId, userId, status: 'active', anchor: f.roster, rosterArchive: archive }),
      saveArchive: async (value) => { archive = value; }, readKey: async (version) => keys.get(version)?.slice(),
      saveKey: async (version, bytes) => { keys.set(version, bytes.slice()); }, serialized: async (work) => work(),
      changed: () => {}, assertCurrentAccount: () => {} };
    const sync = createV2Synchronizer({ ...dependencies, repository }); let managerId = 0;
    const manager = createSharedGroupManager({ ...dependencies, project: repository.project, sync: sync.sync, verifyMembership: sync.verifyMembership,
      makeId: () => `v2-manager-${userId}-${++managerId}`, markLeft: async () => {} });
    return { ...h, repository, sync, keys, manager };
  }
  const owner = device('owner', f.identity, f.cloud, new Map([[1, f.key]]));
  const memberCloud = createSharingCloud(environment.authenticatedContext('member').firestore(), 'member', () => 'member');
  const member = device('member', memberIdentity, memberCloud, new Map());
  let restored;
  try {
    await initializeV2EventStore(owner.database, { groupId, userId: 'owner', householdId: 'local' });
    const change = (operationId, entityType, entityId, payload, operationType = 'patch') => ({ operationId, entityType, entityId, payload, operationType });
    await owner.repository.commit([
      change('policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('family') }),
      change('settings', 'settings', 'settings', { timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }),
      change('chore', 'chore', 'floor', { name: '床掃除', enabled: true }),
      change('configuration', 'chorePolicy', 'floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27',
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    await owner.sync.sync({ force: true });
    const invitation = await owner.manager.createInvitation();
    const request = createSharedJoinRequest(invitation, 'member', memberIdentity, Date.now());
    await memberCloud.submitJoinRequest(invitation.invitation, request); await owner.manager.approve(invitation.invitation, request);
    const next = (await f.cloud.readGroup(groupId)).roster; key2 = owner.keys.get(2); assert.ok(key2);
    assert.equal(next.body.schemaVersion, 2); assert.equal(next.body.keyVersion, 2);
    assert.equal((await f.cloud.readInvitation(invitation.invitation.body.inviteId)).status, 'used');
    await initializeV2EventStore(member.database, { groupId, userId: 'member', householdId: 'local' });
    await member.sync.sync({ force: true });
    const occurrenceId = v2OccurrenceId(groupId, 'floor', '2026-10-27');
    await member.repository.commit([change('member-edit', 'chore', 'floor', { name: '床を拭く', instructions: ['道具を用意する'] }),
      change('member-work', 'completion', occurrenceId, { choreId: 'floor', anchorDate: '2026-10-27',
        completedAt: new Date(Date.now() - 60_000).toISOString(), completedByMemberId: 'member', subjectUserId: null,
        originalAssigneeIds: [], ruleVersion: 1, outcome: 'completed' }, 'complete')]);
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    const hash = (device) => device.connection.prepare('SELECT fact_hash FROM sharing_v2_projection').get().fact_hash;
    assert.equal(hash(owner), hash(member)); assert.equal((await loadSharedReplica(owner.database, groupId)).completions.length, 1);
    await member.repository.commit([change('member-undo', 'completion', occurrenceId, { targetOperationId: 'member-work' }, 'undo')]);
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    assert.equal(hash(owner), hash(member)); assert.equal((await loadSharedReplica(owner.database, groupId)).completions.length, 0);
    for (const d of [owner, member]) {
      assert.equal((await listSharingOutbox(d.database, groupId)).length, 0);
      assert.deepEqual(JSON.parse(d.connection.prepare('SELECT rejected_json FROM sharing_v2_projection').get().rejected_json), []);
      assert.equal(d.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    }
    const anchorDate = sharedLocalDate(new Date(Date.now() + 7 * 86400000), 'Asia/Tokyo');
    const requestOccurrence = v2OccurrenceId(groupId, 'approval-floor', anchorDate);
    const day = (date) => ({ precision: 'date', date });
    await owner.repository.commit([
      change('approval-chore', 'chore', 'approval-floor', { name: '承認検査用の家事', enabled: true }),
      change('approval-policy', 'chorePolicy', 'approval-floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    const requests = (d) => JSON.parse(d.connection.prepare('SELECT request_states_json FROM sharing_v2_projection').get().request_states_json);
    await member.repository.commit([change('date-request', 'changeRequest', 'date-request', {
      requesterUserId: 'member', choreId: 'approval-floor', anchorDate, occurrenceId: requestOccurrence, subjectUserId: null,
      originalDesignationId: null, original: day(anchorDate), proposed: day(addLocalDays(anchorDate, 3)), proposedMode: 'day',
      proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false },
      selector: { scope: 'once', occurrenceId: requestOccurrence, anchorDate }, extensionScope: 'once',
    })]);
    assert.equal(requests(member)[0].kind, 'pendingDelivery');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    assert.equal(requests(owner)[0].kind, 'awaiting'); assert.deepEqual(requests(owner), requests(member));
    await owner.repository.commit([change('date-counteroffer', 'requestDecision', 'date-counteroffer', {
      requestId: 'date-request', decision: 'counteroffer', target: day(addLocalDays(anchorDate, 4)), referenceDecisionId: null, allowDuringCooldown: true,
    })]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal(requests(member)[0].kind, 'counteroffered'); assert.deepEqual(requests(member)[0].formal, day(anchorDate));
    assert.equal(requests(member)[0].counteroffers[0].options.allowDuringCooldown, true);
    await member.repository.commit([change('date-consent', 'requestDecision', 'date-consent', {
      requestId: 'date-request', decision: 'acceptCounteroffer', target: null, referenceDecisionId: 'date-counteroffer',
    })]);
    assert.equal(requests(member)[0].kind, 'counteroffered');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    assert.equal(requests(owner)[0].kind, 'approved'); assert.deepEqual(requests(owner)[0].formal, day(addLocalDays(anchorDate, 4)));
    assert.equal(requests(owner)[0].formalOptions.allowDuringCooldown, true);
    assert.deepEqual(requests(owner), requests(member)); assert.equal(hash(owner), hash(member));
    let actionId = 0; const actionOptions = { makeId: () => `assignment-action-${++actionId}`, now: () => new Date() };
    const ownerActions = createV2PlannerActions(owner.repository, actionOptions); const memberActions = createV2PlannerActions(member.repository, actionOptions);
    const assignmentRef = { choreId: 'approval-floor', anchorDate, ruleVersion: 1, subjectUserId: null };
    await ownerActions.assign(assignmentRef, ['member'], 'this', true); await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    const [assignmentRequest] = await memberActions.requestAssignment(assignmentRef, { memberIds: [], start: 'this', scope: 'once', fixed: false });
    assert.equal((await member.repository.readState()).assessment.assignmentRequests[0].kind, 'pendingDelivery');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    await ownerActions.answerAssignment(assignmentRequest.operationId, 'approve');
    assert.equal((await owner.repository.readState()).assessment.assignmentRequests[0].kind, 'awaiting');
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal((await owner.repository.readState()).assessment.assignmentRequests[0].kind, 'approved'); assert.equal(hash(owner), hash(member));
    await ownerActions.remapAssignments([assignmentRequest.operationId], { ...assignmentRef, anchorDate: addLocalDays(anchorDate, 7) }, ['owner'], 'once', false);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal((await member.repository.readState()).assessment.assignmentRequests[0].cancelled, true); assert.equal(hash(owner), hash(member));
    await owner.repository.commit([
      change('future-assignment-chore', 'chore', 'future-assignment', { name: '次回担当の検査', enabled: true }),
      change('future-assignment-cfg', 'chorePolicy', 'future-assignment', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const nextAnchor = addLocalDays(anchorDate, 2);
    await ownerActions.patchChoreConfiguration('future-assignment', 1, { intervalDays: 3, anchorDate: nextAnchor }, nextAnchor);
    const [futureAssignment] = await ownerActions.assign({ ...assignmentRef, choreId: 'future-assignment' }, ['member'], 'next', true);
    assert.equal(futureAssignment.payload.fromAnchorDate, nextAnchor); assert.equal(futureAssignment.payload.ruleVersion, 2);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); assert.equal(hash(owner), hash(member));
    await owner.repository.commit([
      change('calendar-history-chore', 'chore', 'calendar-history', { name: '移動した実施履歴の検査', enabled: true }),
      change('calendar-history-cfg', 'chorePolicy', 'calendar-history', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 30, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const historyRef = { ...assignmentRef, choreId: 'calendar-history' }; const recordedDate = addLocalDays(anchorDate, 90);
    const [oldDate] = await ownerActions.changeDate(historyRef, { mode: 'day', target: day(recordedDate) });
    const [historicalWork] = await ownerActions.complete(historyRef); await ownerActions.cancelDates(historyRef, [oldDate.operationId]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); assert.equal(hash(owner), hash(member));
    const historicalRound = async (repository) => buildV2CommonPlan(await repository.readState(), { from: recordedDate, through: recordedDate, asOfDate: anchorDate })
      .occurrences.find((entry) => entry.choreId === 'calendar-history' && entry.anchorDate === anchorDate);
    for (const d of [owner, member]) { const round = await historicalRound(d.repository); assert.ok(round); assert.equal(round.subjects[0].suggestedDate, recordedDate);
      assert.deepEqual(round.subjects[0].completionOperationIds, [historicalWork.operationId]); }
    await owner.repository.commit([
      change('partial-cancel-chore', 'chore', 'partial-cancel', { name: '期間解除の検査', enabled: true }),
      change('partial-cancel-cfg', 'chorePolicy', 'partial-cancel', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 1, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const partialRef = { ...assignmentRef, choreId: 'partial-cancel' };
    const [repeating] = await ownerActions.changeDate(partialRef, { mode: 'day', target: day(addLocalDays(anchorDate, 1)), selector: { scope: 'ongoing', from: anchorDate } });
    await ownerActions.cancelDates({ ...partialRef, anchorDate: addLocalDays(anchorDate, 2) }, [repeating.operationId], {
      selector: { scope: 'period', range: { from: addLocalDays(anchorDate, 2), through: addLocalDays(anchorDate, 4) } }, expectedRuleIds: [repeating.operationId],
    });
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); assert.equal(hash(owner), hash(member));
    const cancellationPlan = async (repository) => buildV2CommonPlan(await repository.readState(), { from: anchorDate, through: addLocalDays(anchorDate, 7), asOfDate: anchorDate })
      .occurrences.filter((round) => round.choreId === 'partial-cancel');
    const expectedCancellation = await cancellationPlan(owner.repository); assert.deepEqual(await cancellationPlan(member.repository), expectedCancellation);
    assert.deepEqual(expectedCancellation.map((round) => round.subjects[0].formalDate.kind), ['manual', 'manual', 'automatic', 'automatic', 'automatic', 'manual', 'manual', 'manual']);
    await owner.repository.commit([
      change('removal-request-chore', 'chore', 'removal-request', { name: '固定指定の解除申請検査', enabled: true }),
      change('removal-request-cfg', 'chorePolicy', 'removal-request', { configuration: { policy: chorePolicyFromPreset('assigned', ['member']), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const removalRef = { ...assignmentRef, choreId: 'removal-request' };
    const [lockedRemoval] = await ownerActions.changeDate(removalRef, { mode: 'day', target: day(addLocalDays(anchorDate, 1)),
      options: { strict: true, adminLocked: true }, selector: { scope: 'ongoing', from: anchorDate }, confirmHighLoad: true });
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    const [removalRequest] = await memberActions.cancelDates(removalRef, [lockedRemoval.operationId], {
      selector: { scope: 'period', range: { from: anchorDate, through: addLocalDays(anchorDate, 7) } }, expectedRuleIds: [lockedRemoval.operationId],
    });
    const removalState = async (repository) => (await repository.readState()).assessment.requestStates.find((state) => state.requestId === removalRequest.operationId);
    assert.equal((await removalState(member.repository)).kind, 'pendingDelivery');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true }); assert.equal((await removalState(owner.repository)).kind, 'awaiting');
    await ownerActions.decide(removalRequest.operationId, 'approve'); assert.equal((await removalState(owner.repository)).kind, 'awaiting');
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal((await removalState(member.repository)).formalAction, 'cancel'); assert.equal(hash(owner), hash(member));
    const removalPlan = async (repository) => buildV2CommonPlan(await repository.readState(), { from: anchorDate, through: addLocalDays(anchorDate, 14), asOfDate: anchorDate })
      .occurrences.filter((round) => round.choreId === 'removal-request');
    const expectedRemoval = await removalPlan(owner.repository);
    assert.deepEqual(expectedRemoval.map((round) => round.subjects[0].formalDate.kind), ['automatic', 'automatic', 'manual']);
    const sequence = (await getDocFromServer(f.root)).data().headSequence;
    const approvedSnapshot = await createEncryptedSharedSnapshot(crypto, await loadSharedReplica(owner.database, groupId), await loadSharedFacts(owner.database, groupId),
      next, f.identity, key2, 'approved-requests-v2', sequence, (uid, id, version) => sharedAuthorIdentity([f.roster, next][version - 1], uid, id, version));
    await f.cloud.prepareSnapshot(approvedSnapshot, next); await f.cloud.publishSnapshot(approvedSnapshot.manifest, next);
    restored = device('member', memberIdentity, memberCloud, new Map());
    await initializeV2EventStore(restored.database, { groupId, userId: 'member', householdId: 'local' });
    await restored.sync.sync({ force: true });
    assert.deepEqual(requests(restored), requests(owner)); assert.equal(hash(restored), hash(owner));
    assert.deepEqual((await restored.repository.readState()).assessment.assignmentRequests, (await owner.repository.readState()).assessment.assignmentRequests);
    const rules = (d) => JSON.parse(d.connection.prepare('SELECT formal_rules_json FROM sharing_v2_projection').get().formal_rules_json);
    const firstRule = rules(owner)[0]; assert.ok(firstRule.confirmation); assert.deepEqual(rules(restored), rules(owner));
    assert.equal(firstRule.rule.allowDuringCooldown, true);
    const restoredAssignment = (await restored.repository.readState()).assessment.view.byId(futureAssignment.operationId);
    assert.equal(restoredAssignment.payload.fromAnchorDate, nextAnchor); assert.equal(restoredAssignment.payload.ruleVersion, 2);
    assert.deepEqual(await historicalRound(restored.repository), await historicalRound(owner.repository));
    assert.deepEqual(await cancellationPlan(restored.repository), expectedCancellation);
    assert.deepEqual(await removalPlan(restored.repository), expectedRemoval); assert.equal((await removalState(restored.repository)).formalAction, 'cancel');
    await member.repository.commit([change('next-date-request', 'changeRequest', 'next-date-request', {
      requesterUserId: 'member', choreId: 'approval-floor', anchorDate, occurrenceId: requestOccurrence, subjectUserId: null,
      originalDesignationId: firstRule.operationId, original: firstRule.rule.target, proposed: day(addLocalDays(anchorDate, 5)), proposedMode: 'day',
      proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, basisRuleIds: [firstRule.operationId],
      selector: { scope: 'once', occurrenceId: requestOccurrence, anchorDate }, extensionScope: 'once',
    })]);
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    await owner.repository.commit([change('next-date-consent', 'requestDecision', 'next-date-consent', {
      requestId: 'next-date-request', decision: 'approve', target: null, referenceDecisionId: null,
    })]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); await restored.sync.sync({ force: true });
    for (const d of [member, restored]) { assert.deepEqual(rules(d), rules(owner)); assert.equal(hash(d), hash(owner)); }
    const selected = selectManualRule(rules(restored), { id: requestOccurrence, choreId: 'approval-floor', anchorDate, ruleVersion: 1 }, null, 'Asia/Tokyo');
    assert.equal(selected.kind, 'selected'); assert.deepEqual(selected.fact.rule.target, day(addLocalDays(anchorDate, 5)));
    const planRange = { from: anchorDate, through: addLocalDays(anchorDate, 28), asOfDate: anchorDate };
    const ownerPlan = buildV2CommonPlan(await owner.repository.readState(), planRange);
    for (const d of [member, restored]) assert.deepEqual(buildV2CommonPlan(await d.repository.readState(), planRange), ownerPlan);
    const planned = ownerPlan.occurrences.find((entry) => entry.id === requestOccurrence);
    assert.equal(planned.subjects[0].suggestedDate, addLocalDays(anchorDate, 5));
    assert.deepEqual(ownerPlan.occurrences.find((entry) => entry.choreId === 'approval-floor' && entry.anchorDate === addLocalDays(anchorDate, 7)).assigneeIds, ['owner']);
    for (const d of [owner, member, restored]) assert.equal((await listSharingOutbox(d.database, groupId)).length, 0);
    // D9 uses real encrypted events, immutable receipts and independent SQLite projections through a region change.
    await owner.repository.commit([
      change('old-region-chore', 'chore', 'region-clock', { name: '元の地域の時刻指定', enabled: true }),
      change('old-region-cfg', 'chorePolicy', 'region-clock', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const regionRef = { choreId: 'region-clock', anchorDate, ruleVersion: 1, subjectUserId: null };
    const regionTarget = { precision: 'interval', start: `${addLocalDays(anchorDate, 1)}T00:15:00.000Z`, end: `${addLocalDays(anchorDate, 1)}T00:45:00.000Z` };
    const [regionRule] = await ownerActions.changeDate(regionRef, { mode: 'fixed', target: regionTarget, selector: { scope: 'ongoing', from: anchorDate } });
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); await restored.sync.sync({ force: true });
    const originalRegionFact = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.operationId === regionRule.operationId);
    const management = await createV2GroupController(owner.repository, { ...actionOptions, sync: owner.sync.sync }).readModel(planRange, { groupPolicy: true });
    await ownerActions.editGroupOptions([
      { field: 'timeZone', value: 'America/New_York', basisOperationIds: management.groupSettings.timeZone.candidates.map(source => source.operationId) },
      { field: 'name', value: '地域変更後の共有名', basisOperationIds: management.groupSettings.name.candidates.map(source => source.operationId) },
    ]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); await restored.sync.sync({ force: true });
    const regionPlan = await ownerActions.readPlan(planRange);
    for (const d of [owner, member, restored]) {
      const plan = buildV2CommonPlan(await d.repository.readState(), planRange); assert.deepEqual(plan, regionPlan); assert.equal(plan.commonSettings.name, '地域変更後の共有名');
      const old = plan.occurrences.find((entry) => entry.choreId === 'region-clock' && entry.anchorDate === anchorDate).subjects[0];
      assert.equal(old.formalDate.kind, 'manual'); assert.equal(old.formalDate.timeZone, 'Asia/Tokyo'); assert.deepEqual(old.formalDate.target, regionTarget);
      assert.deepEqual((await loadSharedFacts(d.database, groupId)).find((fact) => fact.operation.operationId === regionRule.operationId), originalRegionFact);
    }
    const [newRegionRule] = await ownerActions.changeDate(regionRef, { mode: 'day', target: day(addLocalDays(anchorDate, 1)) });
    assert.equal(newRegionRule.payload.configuration.timeZoneAtCreation, 'America/New_York');
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); await restored.sync.sync({ force: true });
    assert.equal(hash(owner), hash(member)); assert.equal(hash(owner), hash(restored));
    const beforeRemoval = ownerPlan.history;
    await owner.manager.removeMembers(['member']); const removed = await f.cloud.readGroup(groupId);
    assert.equal(removed.roster.body.keyVersion, 3); assert.deepEqual(removed.roster.body.members.map((person) => person.userId), ['owner']);
    await assert.rejects(member.sync.sync({ force: true })); await assertFails(memberCloud.readGroup(groupId));
    assert.deepEqual(buildV2CommonPlan(await owner.repository.readState(), planRange).history, beforeRemoval);
  } finally { owner.connection.close(); member.connection.close(); restored?.connection.close(); }
});


test('native pair harness uses real encrypted v2 sessions with approval cold restore offline completion and unchanged private adapters', async () => {
  const opened = []; const makeDatabase = () => { const value = createDatabase(); opened.push(value); return value.database; };
  const run = 'cloud-native-pair'; let sequence = 0;
  const create = async role => {
    const keys = new Map(); const database = makeDatabase(); const registry = makeDatabase();
    const userId = `development-v2-pair-${run}-${role}`;
    const identity = await createDeviceIdentity(crypto);
    const deps = { development: true, projectId: V2_PAIR_PROJECT, run, role, database, registry, identity, crypto,
      cloud: createSharingCloud(environment.authenticatedContext(userId).firestore(), userId, () => userId),
      readKey: async version => keys.get(version)?.slice() ?? null, saveKey: async (version, key) => { keys.set(version, key.slice()); },
      serialized: work => work(), makeId: () => `pair-operation-${++sequence}`, now: () => new Date(), invitationSeed: new Uint8Array(32).fill(93) };
    return { deps, pair: await createV2NativePair(deps) };
  };
  try {
    const owner = await create('owner'); const member = await create('member');
    await owner.pair.prepareOwner(); await owner.pair.createInvitation(); await owner.pair.createInvitation();
    await member.pair.requestJoin(); await member.pair.requestJoin();
    await assert.rejects(member.pair.ui(), /permission|アクセス|権限|insufficient/iu);
    await owner.pair.approve(); await member.pair.synchronize(); await owner.pair.prepareChores(); await member.pair.synchronize();
    const ready = await owner.pair.proof(); const other = await member.pair.proof();
    assert.equal(ready.sourceHash, other.sourceHash); assert.equal(ready.planHash, other.planHash); assert.equal(ready.members, 2); assert.equal(ready.keyVersion, 2);
    const ui = await member.pair.ui(); const model = await ui.readModel();
    const chore = model.plan.chores.find(row => row.id.endsWith('.builtin-chore-08'));
    const ref = { choreId: chore.id, anchorDate: model.plan.range.asOfDate, ruleVersion: 1, subjectUserId: null };
    const [done] = await ui.controller.actions.complete(ref);
    assert.equal((await member.pair.proof()).outbox, 1);
    member.pair.close(); member.pair = await createV2NativePair(member.deps);
    assert.equal((await member.pair.proof()).outbox, 1); assert.equal((await member.pair.proof()).history, 1);
    await member.pair.synchronize(); await owner.pair.synchronize();
    assert.deepEqual((await owner.pair.proof()).completed, (await member.pair.proof()).completed);
    await (await member.pair.ui()).controller.actions.undo(done.operationId); await member.pair.synchronize(); await owner.pair.synchronize();
    assert.equal((await owner.pair.proof()).completed.length, 0); assert.equal((await member.pair.proof()).outbox, 0);
    assert.equal((await owner.pair.proof()).sourceHash, (await member.pair.proof()).sourceHash);
    await owner.pair.removeMember(); await assert.rejects((await member.pair.ui()).controller.sync());
    await assert.rejects((await member.pair.ui()).controller.actions.addChore('除名後の編集'), /利用状態|編集|利用でき/u);
    owner.pair.close(); member.pair.close();
  } finally { for (const openedDatabase of opened) openedDatabase.connection.close(); }
});

test('real encrypted calendar replicas converge after offline recurrence edits restart conflicts exceptions and deletion without changing formal chores', async () => {
  const opened = []; let sequence = 0;
  const db = () => { const h = createDatabase(); opened.push(h); return h.database; };
  const run = 'calendar-replica-audit';
  const create = async role => {
    const keys = new Map(); const identity = await createDeviceIdentity(crypto); const userId = `development-v2-pair-${run}-${role}`;
    const deps = { development: true, projectId: V2_PAIR_PROJECT, run, role, database: db(), registry: db(), identity, crypto,
      cloud: createSharingCloud(environment.authenticatedContext(userId).firestore(), userId, () => userId),
      readKey: async v => keys.get(v)?.slice() ?? null, saveKey: async (v, key) => { keys.set(v, key.slice()); },
      serialized: work => work(), makeId: () => `calendar-operation-${++sequence}`, now: () => new Date(), invitationSeed: new Uint8Array(32).fill(94) };
    return { deps, pair: await createV2NativePair(deps) };
  };
  let owner; let member;
  try {
    owner = await create('owner'); member = await create('member');
    await owner.pair.prepareOwner(); await owner.pair.createInvitation(); await member.pair.requestJoin();
    await owner.pair.approve(); await member.pair.synchronize(); await owner.pair.prepareChores(); await member.pair.synchronize();
    const ui = await owner.pair.ui(); const other = await member.pair.ui();
    const base = (await ui.readModel()).plan.range.asOfDate; const through = addLocalDays(base, 28);
    const formal = JSON.stringify((await ui.readModel()).plan.occurrences);
    const category = { id: 'personal', name: '共有の検査', color: '#348dc2', revision: 1 };
    const value = i => ({ ...newEventDraft(base, i % 2 ? 'America/New_York' : 'Asia/Tokyo'), title: `QA encrypted calendar ${i}`,
      notes: 'Never store this plaintext in cloud documents', allDay: true, recurrence: 'biweekly', untilDate: through });
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const controller = i % 2 ? other.controller : ui.controller;
      const [fact] = await controller.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: value(i), category }); ids.push(fact.operationId);
    }
    assert.equal((await member.pair.proof()).outbox, 6);
    member.pair.close(); member.pair = await createV2NativePair(member.deps);
    assert.equal((await member.pair.proof()).outbox, 6);
    const sync = async () => { await owner.pair.synchronize(); await member.pair.synchronize(); await owner.pair.synchronize(); await member.pair.synchronize(); };
    await sync();
    const records = async device => (await (await device.pair.ui()).controller.readCalendar()).records;
    const assertConverged = async () => {
      const a = await records(owner); const b = await records(member); assert.deepEqual(a, b);
      const projected = projectSharedCalendarRecords(a, owner.pair.scope.groupId);
      const expanded = calendarEventsInTimeZone(projectCalendarEvents(projected.events, projected.exceptions, base, through), 'Asia/Tokyo');
      return { a, projected, expanded };
    };
    const first = await assertConverged(); assert.equal(first.projected.events.length, 12); assert.ok(first.expanded.length >= 24);
    assert.equal(JSON.stringify((await (await owner.pair.ui()).readModel()).plan.occurrences), formal);
    const basis = row => JSON.stringify([row.heads.map(h => h.operationId).sort(), row.heads.map(h => h.operationId).sort()]);
    const ownerEvent = first.a.find(row => row.id === ids[0]);
    await assert.rejects((await member.pair.ui()).controller.actions.saveCalendarEvent({ eventId: ownerEvent.id, basisRevision: basis(ownerEvent), scope: 'series', anchorDate: null,
      value: { ...value(0), title: 'Not authorized' }, category }), /権限|編集|permission/u);
    const common = first.a.find(row => row.id === ids[1]);
    for (const [device, title] of [[owner, 'Concurrent owner'], [member, 'Concurrent creator']]) {
      await (await device.pair.ui()).controller.actions.saveCalendarEvent({ eventId: common.id, basisRevision: basis(common), scope: 'series', anchorDate: null,
        value: { ...value(1), title }, category });
    }
    await sync(); const conflict = await assertConverged(); assert.equal(conflict.projected.conflicted, true);
    const conflicted = conflict.a.find(row => row.id === common.id); assert.equal(conflicted.heads.length, 2);
    await (await owner.pair.ui()).controller.actions.saveCalendarEvent({ eventId: common.id, basisRevision: basis(conflicted), scope: 'series', anchorDate: null,
      value: { ...value(1), title: 'Reviewed resolution' }, category });
    await sync(); const resolved = await assertConverged(); assert.equal(resolved.projected.conflicted, false);
    const parent = resolved.a.find(row => row.id === ids[0]); const series = parent.heads.map(h => h.operationId).sort();
    await (await owner.pair.ui()).controller.actions.saveCalendarEvent({ eventId: parent.id, basisRevision: JSON.stringify([series, []]), scope: 'one', anchorDate: base,
      value: { ...value(0), title: 'Moved instance', startDate: addLocalDays(base, 1), endDate: addLocalDays(base, 1) }, category });
    await (await owner.pair.ui()).controller.actions.saveCalendarEvent({ eventId: parent.id, basisRevision: JSON.stringify([series, []]), scope: 'one', anchorDate: addLocalDays(base, 14), value: null, category: null });
    await sync(); const exceptions = await assertConverged(); assert.equal(exceptions.a.find(row => row.id === parent.id).exceptions.length, 2);
    assert.ok(exceptions.expanded.some(row => row.title === 'Moved instance'));
    for (const id of ids.slice(0, 3)) {
      const row = (await records(owner)).find(row => row.id === id);
      await (await owner.pair.ui()).controller.actions.saveCalendarEvent({ eventId: id, basisRevision: basis(row), scope: 'series', anchorDate: null, value: null, category: null });
    }
    await sync(); assert.equal((await assertConverged()).projected.events.length, 9);
    assert.equal(JSON.stringify((await (await owner.pair.ui()).readModel()).plan.occurrences), formal);
    await owner.pair.removeMember(); await assert.rejects(member.pair.synchronize());
    await assert.rejects((await member.pair.ui()).controller.readCalendar(), /利用|権限|編集|permission/u);
  } finally { owner?.pair.close(); member?.pair.close(); for (const h of opened) h.connection.close(); }
});


async function verifyOldSchedulerUpgrade(oldVersion) {
  const f = await fixture(2, oldVersion); const h = createDatabase(); const restored = createDatabase();
  let archive = [f.roster]; const keys = new Map([[1, f.key]]); let ordinal = 0;
  let record = { userId: 'owner', groupId, status: 'creating', displayName: '互換更新検査', anchor: f.roster, rosterArchive: archive,
    creation: { timeZone: 'Asia/Tokyo', anchorDate: sharedLocalDate(new Date(), 'Asia/Tokyo'), ownerDisplayName: '所有者', wrappedKey: {} } };
  const deps = database => ({ database, householdId: 'upgrade-local', userId: 'owner', groupId, identity: f.identity, cloud: f.cloud, crypto,
    readRecord: async () => ({ ...record, rosterArchive: archive }), saveArchive: async value => { archive = value; }, archive: () => archive,
    readKey: async version => keys.get(version)?.slice() ?? null, saveKey: async (version, value) => { keys.set(version, value.slice()); },
    serialized: async work => work(), changed() {}, assertCurrentAccount() {}, assertWritable() {}, makeId: () => `scheduler-upgrade-${++ordinal}`, markLeft: async () => {} });
  try {
    const owner = await createV2WorkspaceSession({ ...deps(h.database), creationKind: 'family' }); await owner.synchronizer.sync({ force: true });
    record = { ...record, status: 'active' };
    const before = await loadSharedFacts(h.database, groupId); const head = (await f.cloud.readGroup(groupId)).group.headSequence;
    await owner.manager.upgradeScheduler();
    const current = await f.cloud.readGroup(groupId); assert.equal(current.group.keyVersion, 2); assert.equal(current.group.headSequence, head);
    assert.equal(archive[0].body.schedulerVersion, oldVersion); assert.equal(archive.at(-1).body.schedulerVersion, V2_SCHEDULER_VERSION);
    const cold = await createV2WorkspaceSession(deps(restored.database)); await cold.synchronizer.sync({ force: true });
    assert.deepEqual(await loadSharedFacts(restored.database, groupId), before);
    assert.deepEqual(await listSharingOutbox(restored.database, groupId), []);
    assert.equal((await loadSharedReplica(restored.database, groupId)).operations.length, before.length);
  } finally { h.connection.close(); restored.connection.close(); }
}
test('draft38 owner upgrades through a real atomic cloud snapshot and a fresh SQLite session restores unchanged shared settings and facts', () => verifyOldSchedulerUpgrade('liflow-shared-2-draft-38'));
test('draft43 owner upgrades through a real atomic cloud snapshot and a fresh SQLite session restores unchanged shared settings and facts', () => verifyOldSchedulerUpgrade('liflow-shared-2-draft-43'));
test('draft44 owner upgrades through a real atomic cloud snapshot and a fresh SQLite session restores unchanged shared settings and facts', () => verifyOldSchedulerUpgrade('liflow-shared-2-draft-44'));

test('real Firestore stores only encrypted PDF chunks denies outsiders and restores one appliance after a lost upload response', async () => {
  const f = await fixture(); const owner = createDatabase(); const restarted = createDatabase(); let n = 0;
  const scope = { groupId, userId: 'owner', householdId: 'v2-pdf-only' };
  const repositoryFor = async database => {
    await initializeV2EventStore(database, scope);
    return createV2EventRepository(database, { ...scope, identity: f.identity, anchor: f.roster, archive: () => [f.roster], assertWritable() {} });
  };
  try {
    const repository = await repositoryFor(owner.database); const input = uploadedApplianceResult();
    const controller = createV2GroupController(repository, { makeId: () => `cloud-pdf-${++n}`, now: () => new Date(), sync: async () => {} });
    const saved = await controller.actions.reviewAppliance({ reviewed: true, ...input, addTaskNames: [] });
    const facts = await loadSharedFacts(owner.database, groupId); let lastSequence = 0;
    for (const fact of [...facts].sort((a, b) => a.operation.deviceSequence - b.operation.deviceSequence)) {
      const envelope = await encryptSharedOperation(crypto, fact.operation, f.key, f.identity);
      const proof = { authorProofDigest: v2AuthorProofDigest(fact) };
      const event = await f.cloud.upload(envelope, proof); const retry = await f.cloud.upload(envelope, proof);
      assert.equal(retry.uploadSequence, event.uploadSequence); lastSequence = event.uploadSequence;
      const raw = (await getDocFromServer(doc(f.store, 'sharingGroups', groupId, 'events', fact.operation.operationId))).data();
      assert.equal(JSON.stringify(raw).includes(input.manual.base64), false);
      assert.equal(JSON.stringify(raw).includes('%PDF-'), false);
      for (const context of [environment.unauthenticatedContext(), environment.authenticatedContext('outsider')]) {
        await assertFails(getDocFromServer(doc(context.firestore(), 'sharingGroups', groupId, 'events', fact.operation.operationId)));
      }
    }
    assert.equal(lastSequence, saved.operations.length);
    const pulled = await f.cloud.pull(groupId, 0); const original = [];
    for (const event of pulled.events) original.push(await decryptAuthenticatedSharedOperation(crypto, event.envelope, f.key, f.identity, groupId, 1));
    const cold = await repositoryFor(restarted.database);
    const receipts = pulled.events.map(event => event.serverReceipt);
    await applyReceivedSharedFacts(restarted.database, groupId, original.reverse(), String(lastSequence), cold.project, null, Date.now(), cold.evidenceForServerReceipts(receipts));
    const state = await cold.readState(); const at = v2ReadPoint(state.assessment.view, state.archive.at(-1));
    assert.equal(state.assessment.rejected.length, 0, state.assessment.rejected.map(item => item.error.message).join('; '));
    assert.equal(readV2ManualDocument(state.assessment.view, at, input.result.analysis.manualSource.sha256), input.manual.base64);
    assert.equal(state.assessment.view.ofType('appliance').length, 1);
    assert.deepEqual(await listSharingOutbox(restarted.database, groupId), []);
  } finally { owner.connection.close(); restarted.connection.close(); }
});
