import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import * as cryptography from '../src/features/sharing/crypto.ts';
import * as operations from '../src/features/sharing/operations.ts';
import * as rosters from '../src/features/sharing/roster.ts';
import * as contracts from '../src/features/sharing/cloud-contract.ts';
import * as invitations from '../src/features/sharing/invitations.ts';
import * as snapshots from '../src/features/sharing/snapshots.ts';
import * as recovery from '../src/platform/sharing/firestore-recovery.ts';
import * as recoveryLock from '../src/features/sharing/v2/recovery-lock.ts';
import * as recoveryCloud from '../src/features/sharing/v2/recovery-cloud-contract.ts';
import * as deadlines from '../src/platform/sharing/network-deadline.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';

async function fixture() {
  const owner = await cryptography.createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const roster = rosters.createSharedRoster('transport-group', 'owner', owner);
  const base = await snapshots.createEncryptedSharedSnapshot(crypto, buildSharedReplica('transport-group', []), [], roster, owner, key, 'snapshot', 0, () => owner);
  const chunks = await Promise.all(Array.from({ length: 6 }, (_, chunkIndex) => cryptography.sealSharedSnapshotChunk(crypto, new TextEncoder().encode('[]'),
    { groupId: 'transport-group', snapshotId: 'snapshot', keyVersion: 1, chunkIndex }, key, owner)));
  const body = { ...base.manifest.body, chunks: chunks.map((chunk, n) => ({ id: `snapshot.${n}`, digest: cryptography.sharedDocumentDigest(chunk), bytes: Buffer.byteLength(operations.canonicalJson(chunk)) })) };
  let manifest = { body, signature: cryptography.signSharedDocument({ domain: 'liflow-shared-snapshot-v1', body }, owner) };
  let active = 0; let maximum = 0; const reads = []; let afterRead = () => {};
  const api = loadNativeModule('src/platform/sharing/firestore-management.ts', {
    'firebase/firestore': { doc: (...parts) => parts.map(part => part.path ?? part).join('/'), getDocFromServer: async path => {
      if (path.includes('/snapshots/')) return { data: () => ({ manifestJson: operations.canonicalJson(manifest), keyVersion: 1, throughSequence: 0 }) };
      reads.push(path); active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; afterRead();
      return { data: () => ({ snapshotId: 'snapshot', keyVersion: 1, envelopeJson: operations.canonicalJson(chunks[Number(path.split('.').at(-1))]) }) };
    } },
    '../../features/sharing/operations.ts': operations, '../../features/sharing/cloud-contract.ts': contracts,
    '../../features/sharing/roster.ts': rosters, '../../features/sharing/invitations.ts': invitations,
    '../../features/sharing/crypto.ts': cryptography, '../../features/sharing/snapshots.ts': snapshots,
    './firestore-recovery.ts': recovery, '../../features/sharing/v2/recovery-lock.ts': recoveryLock,
    '../../features/sharing/v2/recovery-cloud-contract.ts': recoveryCloud, './network-deadline.ts': deadlines,
  }).createSharingManagement({ firestore: {}, userId: 'owner', checkAccount() {}, reference: () => 'sharingGroups/transport-group', readGroup: async () => ({ roster }) });
  return { api, roster, chunks, reads, maximum: () => maximum, changeManifest: change => { manifest = change(manifest); }, after: callback => { afterRead = callback; } };
}
test('shared snapshot transport authenticates the owner manifest before any chunk read and bounds parallel restoration', async () => {
  const f = await fixture(); const result = await f.api.readSnapshot('transport-group', 'snapshot', [f.roster]);
  assert.deepEqual(result.chunks, f.chunks); assert.equal(f.maximum(), 4); assert.equal(f.reads.length, 6);
  const bad = await fixture(); bad.changeManifest(value => ({ ...value, signature: '00'.repeat(64) }));
  await assert.rejects(bad.api.readSnapshot('transport-group', 'snapshot', [bad.roster])); assert.equal(bad.reads.length, 0);
  const unpinned = await fixture();
  await assert.rejects(unpinned.api.readSnapshot('transport-group', 'snapshot'));
  assert.equal(unpinned.reads.length, 0, 'a cloud roster cannot replace a caller-pinned trust anchor');
});
test('shared snapshot transport stops issuing pages after timeout even when SDK reads complete later', async () => {
  const f = await fixture(); const original = Date.now; let clock = original(); Date.now = () => clock;
  try {
    f.after(() => { clock += 30_000; });
    await assert.rejects(f.api.readSnapshot('transport-group', 'snapshot', [f.roster]), { code: 'unavailable' });
    assert.equal(f.reads.length, 4);
  } finally { Date.now = original; }
});
