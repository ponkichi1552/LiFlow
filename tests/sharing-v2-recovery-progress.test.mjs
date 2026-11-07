import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture, groupId } from './helpers/sharing-v2-plan-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { removeSharedMembers, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { signV2RecoveryWitness, verifyV2RecoveryWitnesses } from '../src/features/sharing/v2/recovery-witness.ts';
import { sealV2RecoveryHeader } from '../src/features/sharing/v2/recovery-encryption.ts';
import { readV2RecoveryEvidence } from '../src/features/sharing/v2/recovery-evidence.ts';
import { createV2RecoveryEvidenceProgress } from '../src/platform/storage/sharing-v2-recovery-evidence.ts';

async function setup(count = 61, { absent = false, witnesses = 1 } = {}) {
  const f = await fixture(); const archive = [...f.archive]; const expected = []; const signed = [];
  const records = new Map(); const quarantines = new Map(); const receipts = new Map();
  let sequence = 4;
  for (let index = 0; index < witnesses; index++) {
    const uid = index ? 'b' : 'a'; const previous = archive.at(-1); const baseline = sequence;
    const next = removeSharedMembers(previous, f.identities.owner, [uid]); archive.push(next);
    const id = `recovery-${index}`; const entries = [];
    for (let i = 0; i < count; i++) {
      const event = { schemaVersion: 2, groupId, operationId: `bad-${index}-${i}`, authorUserId: uid,
        authorDeviceId: f.identities[uid].deviceId, keyVersion: previous.body.keyVersion, uploadSequence: ++sequence,
        authorProofDigest: 'a'.repeat(64), envelopeJson: '{synthetic-broken', receivedAtMs: 1_000 };
      expected.push(event);
      const receipt = { schemaVersion: 2, groupId, operationId: event.operationId, authorUserId: uid,
        authorDeviceId: event.authorDeviceId, receivedKeyVersion: event.keyVersion, uploadSequence: sequence,
        authorProofDigest: event.authorProofDigest, receivedAtMs: event.receivedAtMs };
      if (!absent) receipts.set(event.operationId, receipt);
      const entry = { operationId: event.operationId, uploadSequence: sequence, authorUserId: uid, authorDeviceId: event.authorDeviceId,
        keyVersion: event.keyVersion, rawDigest: sharedDocumentDigest(event), receiptDigest: absent ? null : sharedDocumentDigest(receipt),
        classification: 'invalidEnvelope', preservedFactDigest: null };
      entries.push(entry); quarantines.set(event.operationId, { schemaVersion: 1, operationId: event.operationId,
        recoveryId: id, uploadSequence: sequence, keyVersion: event.keyVersion, rawDigest: entry.rawDigest });
    }
    const body = { schemaVersion: 1, groupId, snapshotId: id, ownerUserId: 'owner', ownerDeviceId: f.identities.owner.deviceId,
      previousRosterDigest: sharedRosterDigest(previous), nextRosterDigest: sharedRosterDigest(next), previousKeyVersion: previous.body.keyVersion,
      keyVersion: next.body.keyVersion, baselineSequence: baseline, throughSequence: sequence, baselineIndexDigest: 'b'.repeat(64),
      retainedIndexDigest: 'c'.repeat(64), reviewDigest: 'd'.repeat(64), entries };
    const witness = signV2RecoveryWitness(body, [], f.identities.owner); signed.push(witness);
    const encrypted = await sealV2RecoveryHeader(crypto, { body, signature: witness.signature }, await crypto.randomBytes(32), f.identities.owner);
    records.set(id, { schemaVersion: 1, snapshotId: id, previousKeyVersion: previous.body.keyVersion, keyVersion: next.body.keyVersion,
      throughSequence: sequence, lockId: `lock-${index}`, reviewDigest: body.reviewDigest, encryptedHeaderJson: JSON.stringify(encrypted) });
  }
  const verified = verifyV2RecoveryWitnesses(signed, archive, groupId); const calls = []; let clock = 0; let elapsed = 0; let active = true;
  const take = (part, ids, values) => { calls.push([part, [...ids]]); clock += elapsed; return values.filter(Boolean).map(value => structuredClone(value)); };
  const cloud = {
    async readRecoveryRecord(_group, id) { return take('record', [id], [records.get(id)])[0] ?? null; },
    async readRecoveryOriginals(_group, ids) { return take('original', ids, ids.map(id => expected.find(event => event.operationId === id))); },
    async readRecoveryQuarantines(_group, ids) { return take('quarantine', ids, ids.map(id => quarantines.get(id))); },
    async readReceipts(_group, ids) { return take('receipt', ids, ids.map(id => receipts.get(id))); },
  };
  const assertAccount = () => { if (!active) throw new Error('account changed'); };
  const progress = (db, scope = 'e'.repeat(64), keyVersion = archive.at(-1).body.keyVersion) => createV2RecoveryEvidenceProgress({ database: db,
    scopeDigest: scope, keyVersion, assertCurrentAccount: assertAccount, serialized: work => work() });
  return { expected, verified, cloud, calls, receipts, assertAccount, progress,
    stop: () => { active = false; }, advance: value => { elapsed = value; }, now: () => clock,
    read: (progress, budget = 25) => readV2RecoveryEvidence(cloud, groupId, verified, assertAccount, clock + budget, { progress, now: () => clock }) };
}

test('owner recovery checkpoints each bounded proof page across SQLite reopen without changing a cursor or outbox', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'liflow-proof-progress-')); const file = join(dir, 'proof.db');
  const f = await setup(61, { witnesses: 2 }); let h = createDatabase(file); let closed = false;
  t.after(() => { if (!closed) h.connection.close(); rmSync(dir, { recursive: true }); });
  h.connection.exec("CREATE TABLE synthetic_cursor(value INTEGER); INSERT INTO synthetic_cursor VALUES(4); CREATE TABLE synthetic_outbox(value TEXT); INSERT INTO synthetic_outbox VALUES('unsent');");
  f.advance(10); let previous = 0; let completed;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { completed = await f.read(f.progress(h.database)); break; }
    catch (error) { assert.equal(error.code, 'sharing/receipt-recovery-pending'); }
    const count = h.connection.prepare('SELECT count(*) n FROM sharing_v2_recovery_evidence_cache').get().n;
    assert.ok(count > previous); previous = count;
    assert.equal(h.connection.prepare('SELECT value FROM synthetic_cursor').get().value, 4);
    assert.equal(h.connection.prepare('SELECT value FROM synthetic_outbox').get().value, 'unsent');
    h.connection.close(); h = createDatabase(file);
  }
  assert.deepEqual(completed, f.expected); assert.ok(f.calls.every(([, ids]) => ids.length <= 30));
  const requests = f.calls.flatMap(([part, ids]) => ids.map(id => `${part}:${id}`));
  assert.equal(new Set(requests).size, requests.length, 'a verified page is not fetched again after process restart');
  h.connection.close(); closed = true;
});

test('owner recovery never caches missing receipts as proof and rejects a receipt that appears after an interrupted attempt', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); const f = await setup(1, { absent: true });
  f.advance(10); await assert.rejects(f.read(f.progress(h.database)), { code: 'sharing/receipt-recovery-pending' });
  f.advance(0); assert.equal((await f.read(f.progress(h.database))).length, 1);
  const event = f.expected[0]; f.receipts.set(event.operationId, { ...event, schemaVersion: 2 });
  await assert.rejects(f.read(f.progress(h.database)), /immutable original evidence/);
  assert.equal(h.connection.prepare("SELECT count(*) n FROM sharing_v2_recovery_evidence_cache WHERE part='receipt'").get().n, 0);
  assert.equal(f.calls.filter(([part]) => part === 'receipt').length, 2);
});

test('owner recovery isolates account roster retention key and witness scopes without accepting another scope cache', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); const f = await setup(1); f.advance(0);
  await f.read(f.progress(h.database)); const first = f.calls.length;
  await f.read(f.progress(h.database)); assert.equal(f.calls.length, first);
  await f.read(f.progress(h.database, 'f'.repeat(64))); assert.equal(f.calls.length, first * 2);
  await f.read(f.progress(h.database, 'f'.repeat(64), 8)); assert.equal(f.calls.length, first * 3);
  const altered = structuredClone(f.verified); altered[0].body.reviewDigest = '9'.repeat(64);
  await assert.rejects(readV2RecoveryEvidence(f.cloud, groupId, altered, f.assertAccount, 1000, { progress: f.progress(h.database), now: f.now }), /encrypted server preparation/);
});

test('owner recovery revalidates persisted bytes against the signed witness even if a local attacker also rewrites the cache digest', async t => {
  for (const rewriteDigest of [false, true]) {
    const h = createDatabase(); t.after(() => h.connection.close()); const f = await setup(1); await f.read(f.progress(h.database));
    const event = { ...f.expected[0], envelopeJson: 'forged-on-disk' };
    h.connection.prepare("UPDATE sharing_v2_recovery_evidence_cache SET value_json=? WHERE part='original'").run(JSON.stringify(event));
    if (rewriteDigest) h.connection.prepare("UPDATE sharing_v2_recovery_evidence_cache SET content_digest=? WHERE part='original'").run(sharedDocumentDigest(event));
    await assert.rejects(f.read(f.progress(h.database)), rewriteDigest ? /immutable original evidence/ : /保存済み/);
  }
});

test('owner recovery rejects duplicate foreign and incomplete evidence without staging an unverified page', async t => {
  for (const kind of ['duplicate', 'foreign', 'missing']) {
    const h = createDatabase(); t.after(() => h.connection.close()); const f = await setup(2);
    const original = f.cloud.readRecoveryOriginals;
    f.cloud.readRecoveryOriginals = async (...args) => {
      const page = await original(...args); return kind === 'duplicate' ? [page[0], page[0]]
        : kind === 'foreign' ? [{ ...page[0], operationId: 'foreign' }, page[1]] : page.slice(0, 1);
    };
    await assert.rejects(f.read(f.progress(h.database)), /evidence/);
    assert.equal(h.connection.prepare("SELECT count(*) n FROM sharing_v2_recovery_evidence_cache WHERE part='original'").get().n, 0);
  }
});

test('owner recovery account changes after a server reply cannot stage that reply or continue network requests', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); const f = await setup(1); const original = f.cloud.readRecoveryRecord;
  f.cloud.readRecoveryRecord = async (...args) => { const record = await original(...args); f.stop(); return record; };
  await assert.rejects(f.read(f.progress(h.database)), /account changed/);
  assert.equal(f.calls.length, 1); assert.equal(h.connection.prepare('SELECT count(*) n FROM sharing_v2_recovery_evidence_cache').get().n, 0);
});

test('audit100 a verified recovery proof page checks and stores immutable rows in bounded SQLite batches',async t=>{
 const h=createDatabase();t.after(()=>h.connection.close());const progress=createV2RecoveryEvidenceProgress({database:h.database,scopeDigest:'1'.repeat(64),keyVersion:1,assertCurrentAccount(){},serialized:work=>work()});
 const rows=Array.from({length:30},(_,n)=>({id:`proof-${n}`,value:{operationId:`proof-${n}`,encrypted:'retained-evidence'}}));let calls=0;
 for(const name of ['getFirstAsync','getAllAsync','runAsync']){const original=h.database[name];h.database[name]=async(...args)=>{calls++;return original(...args);};}
 await progress.save('2'.repeat(64),'record',rows);assert.ok(calls<=3,`proof page bridge calls: ${calls}`);
 await assert.rejects(progress.save('2'.repeat(64),'record',[{id:'new-proof',value:{data:'new'}},{...rows[0],value:{data:'altered'}}]));
 const saved=await progress.read('2'.repeat(64),'record',[rows[0].id,'new-proof']);assert.deepEqual(saved.get(rows[0].id),rows[0].value);assert.equal(saved.has('new-proof'),false);
});
