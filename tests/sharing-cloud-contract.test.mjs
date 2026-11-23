import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceIdentity, sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { assertSharedCloudAccess, boundedSharingCloudBatches, MAX_SHARED_CLOUD_BATCH_BYTES,
  parseSharedCloudEvent, parseSharedCloudGroup, rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as operations from '../src/features/sharing/operations.ts';
import * as cloudContract from '../src/features/sharing/cloud-contract.ts';
import * as networkDeadline from '../src/platform/sharing/network-deadline.ts';
import * as workspaceCopyOrigin from '../src/features/sharing/v2/workspace-copy-origin.ts';

test('cloud ACL metadata cannot substitute a pinned signed account, device or membership epoch', async () => {
  const owner = await createDeviceIdentity(crypto); const roster = createSharedRoster('group-test', 'owner', owner);
  const data = { ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 };
  assert.equal(parseSharedCloudGroup(data, 'group-test').group.ownerUserId, 'owner');
  for (const change of [{ ownerUserId: 'attacker' }, { deviceOwners: { [owner.deviceId]: 'attacker' } },
    { memberIds: ['owner', 'attacker'] }, { keyVersion: 2 }, { taskName: '平文の家事' }, { snapshotThroughSequence: 1 }]) {
    assert.throws(() => parseSharedCloudGroup({ ...data, ...change }, 'group-test'));
  }
  assert.throws(() => parseSharedCloudGroup(data, 'wrong-group'));
  assertSharedCloudAccess(data, 'owner', owner.deviceId);
  assert.throws(() => assertSharedCloudAccess(data, 'attacker'), { code: 'sharing/access-denied' });
  assert.throws(() => assertSharedCloudAccess({ ...data, revokedUserIds: ['owner'], rotationRequired: true }, 'owner'), { code: 'sharing/access-denied' });
});

test('large encrypted snapshot batches respect both the 100-document limit and the Firestore request byte limit', () => {
  const small = boundedSharingCloudBatches(Array.from({ length: 250 }, (_, index) => index), () => 1000);
  assert.deepEqual(small.map((page) => page.length), [100, 100, 50]);
  const sizes = Array.from({ length: 40 }, (_, index) => 640000 + index);
  const large = boundedSharingCloudBatches(sizes, (size) => size);
  assert.ok(large.length > 1); assert.deepEqual(large.flat(), sizes);
  assert.ok(large.every((page) => page.length <= 100 && page.reduce((sum, size) => sum + size, 0) <= MAX_SHARED_CLOUD_BATCH_BYTES));
  assert.throws(() => boundedSharingCloudBatches([MAX_SHARED_CLOUD_BATCH_BYTES + 1], (size) => size));
});

test('cloud event positions and author metadata must bind the encrypted envelope and never accept extra plaintext fields', () => {
  const envelope = { schemaVersion: 1, operationId: 'operation-test', groupId: 'group-test', authorUserId: 'owner', authorDeviceId: 'owner-device', keyVersion: 1 };
  const data = { schemaVersion: 1, authorUserId: 'owner', authorDeviceId: 'owner-device', keyVersion: 1, uploadSequence: 1, envelopeJson: JSON.stringify(envelope) };
  assert.equal(parseSharedCloudEvent('operation-test', data, 'group-test').uploadSequence, 1);
  for (const change of [{ uploadSequence: 0 }, { uploadSequence: 1.5 }, { authorUserId: 'attacker' },
    { keyVersion: 2 }, { description: '平文の内容' }]) {
    assert.throws(() => parseSharedCloudEvent('operation-test', { ...data, ...change }, 'group-test'));
  }
  assert.throws(() => parseSharedCloudEvent('other-operation', data, 'group-test'));
  assert.throws(() => parseSharedCloudEvent('operation-test', { ...data, envelopeJson: JSON.stringify({ ...envelope, schemaVersion: 2 }) }, 'group-test'));
});

test('caught-up legacy shared pulls verify the live group without issuing an empty history query', async () => {
  const owner = await createDeviceIdentity(crypto); const roster = createSharedRoster('group-test', 'owner', owner);
  let group = { ...rosterCloudFields(roster), headSequence: 2, lastOperationId: 'latest', snapshotId: null, snapshotThroughSequence: 0 };
  let rootReads = 0, queries = 0, user = 'owner';
  const cloud = loadNativeModule('src/platform/sharing/firestore-cloud.ts', {
    'firebase/firestore': {
      doc: () => ({}), collection: () => ({}), orderBy: () => ({}), startAfter: () => ({}), where: () => ({}), limit: () => ({}), query: () => ({}),
      async getDocFromServer() { rootReads++; return { data: () => group }; },
      async getDocsFromServer() { queries++; return { docs: [] }; },
    },
    '../../features/sharing/operations.ts': operations, '../../features/sharing/cloud-contract.ts': cloudContract, './network-deadline.ts': networkDeadline,
    '../../features/sharing/crypto.ts': { sharedDocumentDigest, signSharedDocument }, '../../features/sharing/roster.ts': { sharedRosterDigest },
    '../../features/sharing/v2/workspace-copy-origin.ts': workspaceCopyOrigin,
    './firestore-management.ts': { createSharingManagement: () => ({}) }, './firestore-recovery.ts': { createSharingRecovery: () => ({}) },
    './firestore-retention.ts': { createSharingHistoryRetention: () => ({}) }, './firestore-account-devices.ts': { createSharingAccountDevices: () => ({}) },
    './v2-receipts.ts': {}, './firestore-delivery.ts': {}, '../../features/sharing/v2/recovery-lock.ts': {},
    '../../features/sharing/delivery-archive.ts': {}, '../../features/sharing/delivery-proof.ts': {}, './delivery-proof-cloud.ts': {},
  }).createSharingCloud({}, 'owner', () => user);
  for (let run = 0; run < 2; run++) {
    const page = await cloud.pull('group-test', 2);
    assert.deepEqual(page.events, []); assert.equal(page.throughSequence, 2);
  }
  assert.equal(rootReads, 2); assert.equal(queries, 0);
  await assert.rejects(cloud.pull('group-test', 1), { code: 'sharing/snapshot-required' });
  assert.equal(queries, 1);
  await assert.rejects(cloud.pull('group-test', 3), { code: 'sharing/snapshot-required' });
  user = 'other';
  await assert.rejects(cloud.pull('group-test', 2), { code: 'sharing/access-denied' });
  assert.equal(queries, 1);
  user = 'owner';
  group = { ...group, ...rosterCloudFields(createSharedRoster('group-test', 'owner', owner, { schemaVersion: 2 })) };
  const current = await cloud.pull('group-test', 2);
  assert.deepEqual(current.events, []); assert.equal(current.throughSequence, 2);
  assert.equal(queries, 1, 'a caught-up V2 device also skips the empty event query');
});
