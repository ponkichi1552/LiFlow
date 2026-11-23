import './helpers/typescript-loader.mjs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, createSharedRoster, sharedAuthorIdentity, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { v2OccurrenceId, v2SubjectOccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { workspaceCopyPin } from '../src/features/sharing/v2/workspace-copy-origin.ts';
import { signWorkspaceCopy, verifyCopyOrigin } from '../src/features/sharing/v2/workspace-copy-source.ts';
import { planWorkspaceCopy } from '../src/features/sharing/v2/workspace-copy-plan.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

export async function workspaceCopyFixture({ undo = false } = {}) {
  const original = await createDeviceIdentity(crypto);
  const phone = await createDeviceIdentity(crypto);
  const groupId = 'old-group';
  const destination = { groupId: 'new-group', userIds: ['member', 'owner'] };
  const first = createSharedRoster(groupId, 'owner', original, { schemaVersion: 2 });
  const tip = approveSharedDevice(first, original, 'member', phone);
  const rosters = [first, tip];
  const anchorDate = '2026-11-18';
  const facts = [], receipts = [];
  const frontier = {};
  const recordedAt = '2026-11-18T08:00:00Z';
  const append = (operationId, entityType, entityId, payload, operationType = 'patch', member = false) => {
    const userId = member ? 'member' : 'owner';
    const id = member ? phone : original;
    const deviceSequence = (frontier[id.deviceId] ?? 0) + 1;
    const operation = { schemaVersion: 2, groupId, operationId, entityType, entityId, operationType, payload, recordedAt,
      context: { ...frontier }, receiptContext: { ...frontier }, keyVersion: 2, authorUserId: userId, authorDeviceId: id.deviceId,
      logicalClock: facts.length + 1, deviceSequence };
    const fact = signSharedOperation(operation, id);
    facts.push(fact); frontier[id.deviceId] = deviceSequence;
    receipts.push({ schemaVersion: 2, groupId, operationId, authorUserId: userId, authorDeviceId: id.deviceId,
      receivedKeyVersion: 2, uploadSequence: receipts.length + 1, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: Date.parse(recordedAt) + 1000 });
  };
  append('rule', 'groupPolicy', 'policy', { configuration: createGroupPolicy('family') });
  append('settings', 'settings', 'settings', { anchorDate, name: '元のグループ', timeZone: 'Asia/Tokyo', normalDailyLimit: 3 });
  append('chore', 'chore', 'floor', { name: '床の清掃', enabled: true });
  append('cadence', 'chorePolicy', 'floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
    intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } });
  const calendar = { ...newEventDraft(anchorDate, 'Asia/Tokyo'), title: '公開しない予定', recurrence: 'weekly', categoryId: 'school', allDay: true };
  const category = { id: 'school', name: '学校', color: '#123456' };
  append('meeting', 'calendarEvent', 'meeting', { eventId: 'meeting', scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value: calendar, category });
  append('moved-meeting', 'calendarEvent', 'moved-meeting', { eventId: 'meeting', scope: 'one', anchorDate, basisOperationIds: [], resetExceptionIds: [],
    value: { ...calendar, title: '場所の変更' }, category });
  const subjectId = v2SubjectOccurrenceId(v2OccurrenceId(groupId, 'floor', anchorDate), null);
  append('completed', 'completion', subjectId, { choreId: 'floor', anchorDate, outcome: 'completed', subjectUserId: null,
    originalAssigneeIds: [], completedAt: '2026-11-18T07:00:00Z', completedByMemberId: 'member', ruleVersion: 1 }, 'complete', true);
  if (undo) append('undone', 'completion', subjectId, { targetOperationId: 'completed' }, 'undo', true);
  const origin = { groupId, revision: tip.body.revision, rosterDigest: sharedRosterDigest(tip), sequence: facts.length, userIds: destination.userIds };
  const copy = signWorkspaceCopy(workspaceCopyPin(origin), destination, { rosters, facts, receipts }, 'member', phone);
  return { copy, original, phone, origin, destination, anchorDate };
}

test('workspace copy preserves original authors, schedule settings, calendar exceptions and the completion/undo pair', async () => {
  for (const undo of [false, true]) {
    const f = await workspaceCopyFixture({ undo });
    const verified = verifyCopyOrigin(f.copy, f.origin, f.destination.groupId);
    const plan = planWorkspaceCopy(f.copy, workspaceCopyPin(f.origin), f.destination, 'member', '新グループ');
    assert.equal(verified.replica.operations.length, f.origin.sequence);
    assert.equal(plan.settings.normalDailyLimit, 3);
    assert.equal(plan.whenApproved.find(op => op.entityType === 'chorePolicy').payload.configuration.intervalDays, 7);
    assert.equal(plan.initial.filter(op => op.entityType === 'calendarEvent').length, 2);
    const first = plan.initial.find(op => op.payload.scope === 'series');
    const changed = plan.initial.find(op => op.payload.scope === 'one');
    assert.equal(changed.payload.eventId, first.operationId);
    assert.equal(changed.payload.value.title, '場所の変更');
    assert.equal(plan.history.length, undo ? 0 : 1);
    assert.equal(f.copy.data.facts.find(fact => fact.operation.operationId === 'completed').operation.authorUserId, 'member');
    assert.equal(plan.initial.concat(plan.whenApproved).some(op => op.entityType === 'completion'), false);
  }
});

test('workspace copy checks the source pin, every original signature and exact destination', async () => {
  const f = await workspaceCopyFixture();
  const changed = structuredClone(f.copy); changed.data.facts[2].operation.payload.name = '改変';
  assert.throws(() => verifyCopyOrigin(changed, f.origin, f.destination.groupId));
  assert.throws(() => verifyCopyOrigin(f.copy, { ...f.origin, sequence: f.origin.sequence - 1 }, f.destination.groupId));
  assert.throws(() => verifyCopyOrigin(f.copy, f.origin, 'different-group'));
  const duplicate = structuredClone(f.copy); duplicate.data.receipts[1].uploadSequence = 1;
  assert.throws(() => verifyCopyOrigin(duplicate, f.origin, f.destination.groupId));
  const wrongRoster = { ...f.origin, rosterDigest: 'a'.repeat(64) };
  assert.throws(() => verifyCopyOrigin(f.copy, wrongRoster, f.destination.groupId));
});

test('the encrypted snapshot preserves the signed origin only for approved recipients', async () => {
  const f = await workspaceCopyFixture();
  const id = f.destination.groupId;
  const key = await crypto.randomBytes(32);
  const root = createSharedRoster(id, 'member', f.phone, { schemaVersion: 2, workspaceCopy: true });
  const tip = approveSharedDevice(root, f.phone, 'owner', f.original);
  const replica = buildSharedReplica(id, []);
  const author = (uid, device, version) => sharedAuthorIdentity(version === 1 ? root : tip, uid, device, version);
  const encrypted = await createEncryptedSharedSnapshot(crypto, replica, [], tip, f.phone, key, 'copy-snapshot', 0, author, [root, tip], f.copy);
  assert.equal(JSON.stringify(encrypted).includes('公開しない予定'), false);
  const restored = await openEncryptedSharedSnapshot(crypto, encrypted, key, tip, author, [root, tip]);
  assert.deepEqual(restored.workspaceCopy, f.copy);
  assert.equal(verifyCopyOrigin(restored.workspaceCopy, f.origin, id).archive.length, 2);
  const unauthorized = approveSharedDevice(tip, f.phone, 'outsider', await createDeviceIdentity(crypto));
  await assert.rejects(createEncryptedSharedSnapshot(crypto, replica, [], unauthorized, f.phone, key, 'leaked-copy', 0, author, [root, tip, unauthorized], f.copy));
});
