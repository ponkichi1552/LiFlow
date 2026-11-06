import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, groupId, seeds } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2RecoveryStore } from '../src/platform/storage/sharing-v2-recovery.ts';
import { compactSharedReplica } from '../src/features/sharing/replica.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { sharedRosterDigest } from '../src/features/sharing/roster.ts';

async function setup() {
  const f = await fixture(); const device = await f.device(); await device.repository.commit(seeds());
  const state = await device.repository.readState(); const retainedBase = compactSharedReplica(state.replica);
  const raw = { schemaVersion: 2, groupId, operationId: 'bad-transport', authorUserId: 'member', authorDeviceId: f.member.deviceId,
    keyVersion: 2, uploadSequence: 1, envelopeJson: '{broken', authorProofDigest: 'a'.repeat(64), receivedAtMs: 1000 };
  const entry = { operationId: raw.operationId, authorUserId: raw.authorUserId, authorDeviceId: raw.authorDeviceId, keyVersion: 2,
    uploadSequence: 1, rawDigest: sharedDocumentDigest(raw), receiptDigest: null, classification: 'invalidEnvelope', preservedFactDigest: null };
  const draft = { review: { id: 'review-one', groupId, reviewDigest: 'b'.repeat(64), previousRosterDigest: sharedRosterDigest(f.archive.at(-1)),
    baselineSequence: 0, throughSequence: 1, retainedChanges: 0, unreadableChanges: 1, heldChanges: 0, restoredOriginals: 0,
    removeDeviceIds: [f.member.deviceId], removeUserIds: [], entries: [entry] },
  baselineIndexDigest: sharedDocumentDigest(retainedBase.operationIndex), baselineBase: retainedBase, rawEvents: [raw], receipts: [], preservedFacts: [], readyFacts: [], retainedBase, createdAtMs: 1000 };
  return { ...f, openDevice: f.device, device, draft, store: createV2RecoveryStore(device.repository) };
}

test('recovery store captures a private review atomically survives restart and deduplicates original ciphertext without touching the outbox', async t => {
  const f = await setup(); t.after(() => f.device.connection.close());
  const before = f.device.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all();
  const saved = structuredClone(f.draft); const writing = f.store.save(f.draft);
  f.draft.review.id = 'caller-mutated-after-save'; await writing;
  const restarted = createV2RecoveryStore(f.device.repository); assert.deepEqual((await restarted.read()).draft, saved);
  await restarted.save(saved);
  assert.equal(f.device.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_recovery_originals').get().n, 1);
  assert.deepEqual(f.device.connection.prepare('SELECT * FROM sharing_outbox ORDER BY operation_id').all(), before);
  await assert.rejects(restarted.markApplied(saved.review.id, saved.review.reviewDigest, 'recovery-snapshot'), { code: 'sharing/recovery-review-stale' });
  await restarted.markConfirming(saved.review.id, saved.review.reviewDigest);
  assert.equal((await restarted.read()).status, 'confirming');
  await assert.rejects(restarted.save(saved), { code: 'sharing/recovery-review-stale' });
  await restarted.markApplied(saved.review.id, saved.review.reviewDigest, 'recovery-snapshot');
  const result = await restarted.read(); assert.equal(result.status, 'applied'); assert.equal(result.snapshotId, 'recovery-snapshot');
  assert.equal(result.draft.rawEvents[0].envelopeJson, '{broken');
});

test('recovery store refuses member mutation stale confirmation another scope secrets and changed original ciphertext', async t => {
  const f = await setup(); const member = await f.openDevice('member', f.member);
  t.after(() => { f.device.connection.close(); member.connection.close(); });
  await assert.rejects(createV2RecoveryStore(member.repository).save(f.draft), /所有者/u);
  await assert.rejects(f.store.save({ ...f.draft, groupKey: 'must never enter SQLite' }), /Unknown/);
  await assert.rejects(f.store.save({ ...f.draft, review: { ...f.draft.review, groupId: 'private-or-other-group' } }), /scope/);
  await f.store.save(f.draft);
  await assert.rejects(f.store.markApplied(f.draft.review.id, '0'.repeat(64), 'snapshot'), { code: 'sharing/recovery-review-stale' });
  const altered = structuredClone(f.draft); altered.rawEvents[0].envelopeJson = 'changed';
  await assert.rejects(f.store.save(altered), { code: 'sharing/recovery-review-stale' });
  assert.equal((await f.store.read()).draft.rawEvents[0].envelopeJson, '{broken');
  f.device.stopWrites(); await assert.rejects(f.store.read(), /account changed/);
});

test('recovery store rolls back original evidence and review together on an interrupted SQLite write', async t => {
  const f = await setup(); t.after(() => f.device.connection.close());
  const repository = { scope: f.device.repository.scope,
    readCurrent: read => f.device.repository.readCurrent((state, db) => read(state, new Proxy(db, { get(target, key) {
      const value = target[key];
      if (key === 'runAsync') return async (sql, ...params) => { if (sql.includes('INSERT INTO sharing_v2_recovery_review')) throw new Error('interrupted review write'); return value.call(target, sql, ...params); };
      return typeof value === 'function' ? value.bind(target) : value;
    } }))) };
  await assert.rejects(createV2RecoveryStore(repository).save(f.draft), /interrupted/);
  assert.equal(f.device.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'sharing_v2_recovery_%'").get().n, 0);
  assert.equal(f.device.connection.prepare('SELECT COUNT(*) AS n FROM sharing_outbox').get().n, 4);
  await f.store.save(f.draft); assert.equal((await f.store.read()).status, 'review');
});

test('recovery store detects altered persisted original bytes rather than replacing evidence on reload', async t => {
  const f = await setup(); t.after(() => f.device.connection.close()); await f.store.save(f.draft);
  const raw = structuredClone(f.draft.rawEvents[0]); raw.envelopeJson = 'modified on disk';
  f.device.connection.prepare('UPDATE sharing_v2_recovery_originals SET raw_json=?').run(JSON.stringify(raw));
  await assert.rejects(createV2RecoveryStore(f.device.repository).read(), /altered/);
});

test('recovery reload batches 201 immutable originals without per-original native reads or changing their signed order', async t => {
  const f = await setup(); t.after(() => f.device.connection.close());
  const draft = structuredClone(f.draft); draft.rawEvents = Array.from({ length: 201 }, (_, index) => ({ ...draft.rawEvents[0], operationId: `original-${index}`, uploadSequence: index + 1 }));
  draft.review.throughSequence = 201; draft.review.entries = draft.rawEvents.map(raw => ({ ...draft.review.entries[0], operationId: raw.operationId,
    uploadSequence: raw.uploadSequence, rawDigest: sharedDocumentDigest(raw) })); draft.review.unreadableChanges = 201;
  await f.store.save(draft); let singleReads = 0; let batches = 0;
  const { database } = f.device; const one = database.getFirstAsync; const many = database.getAllAsync;
  database.getFirstAsync = async (...args) => { if (args[0].includes('FROM sharing_v2_recovery_originals')) singleReads++; return one(...args); };
  database.getAllAsync = async (...args) => {
    const result = await many(...args);
    if (args[0].includes('FROM sharing_v2_recovery_originals')) { batches++; return result.reverse(); }
    return result;
  };
  const summary = await createV2RecoveryStore(f.device.repository).readSummary();
  assert.deepEqual(summary.draft.review, draft.review); assert.deepEqual(summary.draft.preservedFacts, draft.preservedFacts);
  assert.equal('rawEvents' in summary.draft, false); assert.equal(singleReads, 0); assert.equal(batches, 0);
  assert.deepEqual((await createV2RecoveryStore(f.device.repository).read()).draft, draft);
  assert.equal(singleReads, 0); assert.equal(batches, 3);
});
