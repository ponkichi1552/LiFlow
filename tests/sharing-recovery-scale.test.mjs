import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { buildSharedReplica, compactSharedReplica } from '../src/features/sharing/replica.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { recoveryArrayContent, recoveryArrayDigest } from '../src/features/sharing/v2/recovery-content.ts';
import { analyzeV2Recovery } from '../src/features/sharing/v2/recovery-analysis.ts';
import { createV2RecoveryStore } from '../src/platform/storage/sharing-v2-recovery.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';

test('recovery digests retain existing small-history proofs and bind the order count and every page of large histories', () => {
  for (const count of [0, 1, 4096]) { const rows = Array.from({ length: count }, (_, n) => `${n}`); assert.equal(recoveryArrayDigest(rows), sharedDocumentDigest(rows)); }
  const rows = Array.from({ length: 10000 }, (_, n) => `${n}`); const original = recoveryArrayDigest(rows);
  assert.equal(recoveryArrayContent(rows).pages.length, 10);
  for (const offset of [0, 999, 1000, 4096, 9999]) { const changed = [...rows]; changed[offset] = 'changed'; assert.notEqual(recoveryArrayDigest(changed), original); }
  assert.notEqual(recoveryArrayDigest([...rows].reverse()), original); assert.notEqual(recoveryArrayDigest(rows.slice(0, -1)), original);
  assert.throws(() => recoveryArrayContent(Array(512001)), /capacity/u);
});
test('recovery analysis and private restart preserve a valid 4104-receipt baseline without relaxing signed event limits', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const state = await d.repository.readState(); const operations = [...state.replica.operations];
  const last = operations.reduce((a, b) => a.deviceSequence > b.deviceSequence ? a : b);
  for (let n = 5; n <= 4104; n++) operations.push({ ...last, operationId: `long-${n}`, entityType: 'chore', entityId: 'floor', payload: { name: `床 ${n}` },
    deviceSequence: n, logicalClock: n, context: { [f.owner.deviceId]: n - 1 }, receiptContext: { [f.owner.deviceId]: n - 1 } });
  const baseline = buildSharedReplica(groupId, operations); const base = compactSharedReplica(baseline);
  const analyzed = await analyzeV2Recovery({ crypto, key: await crypto.randomBytes(32), archive: f.archive, baseline, baselineSequence: 4104,
    throughSequence: 4104, events: [], originals: [], receipts: new Map() });
  assert.equal(analyzed.baselineIndexDigest, recoveryArrayDigest(base.operationIndex)); assert.equal(analyzed.retainedIndexDigest, analyzed.baselineIndexDigest);
  const raw = { schemaVersion: 2, groupId, operationId: 'corrupt-after-large-baseline', authorUserId: 'member', authorDeviceId: f.member.deviceId,
    keyVersion: 2, uploadSequence: 4105, envelopeJson: '{broken', authorProofDigest: 'a'.repeat(64), receivedAtMs: 1000 };
  const entry = { operationId: raw.operationId, authorUserId: raw.authorUserId, authorDeviceId: raw.authorDeviceId, keyVersion: 2,
    uploadSequence: 4105, rawDigest: sharedDocumentDigest(raw), receiptDigest: null, classification: 'missingReceipt', preservedFactDigest: null };
  const draft = { review: { id: 'large-review', groupId, reviewDigest: 'b'.repeat(64), previousRosterDigest: sharedRosterDigest(f.archive.at(-1)),
    baselineSequence: 4104, throughSequence: 4105, retainedChanges: 0, unreadableChanges: 1, heldChanges: 0, restoredOriginals: 0,
    removeDeviceIds: [f.member.deviceId], removeUserIds: [], entries: [entry] }, baselineIndexDigest: analyzed.baselineIndexDigest,
    baselineBase: base, retainedBase: base, rawEvents: [raw], receipts: [], preservedFacts: [], readyFacts: [], createdAtMs: 1000 };
  const store = createV2RecoveryStore(d.repository); await store.save(draft);
  assert.deepEqual((await createV2RecoveryStore(d.repository).read()).draft, draft);
  assert.throws(() => sharedDocumentDigest(Array(4097).fill('untrusted-event')), /too large/u);
});
