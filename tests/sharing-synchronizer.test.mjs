import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, encryptSharedOperation, signSharedDocument, signSharedOperation, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, createSharedRoster, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { parseSharedCloudEvent, rosterCloudFields, SharingAccessError, SharingKeyVersionError, SharingSnapshotRequiredError } from '../src/features/sharing/cloud-contract.ts';
import { createSharedSynchronizer } from '../src/features/sharing/synchronizer.ts';
import * as ledger from '../src/platform/storage/sharing-ledger.ts';
import { sharingCloudWithDeadline } from '../src/platform/sharing/network-deadline.ts';

async function fixture() {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const first = createSharedRoster('group-test', 'owner', owner); const second = approveSharedDevice(first, owner, 'member', member);
  const keys = new Map([[1, await crypto.randomBytes(32)], [2, await crypto.randomBytes(32)]]);
  const state = { roster: second, archive: [first, second], events: [], snapshot: null, denied: false, pageSize: 100, failUpload: false,
    loseUploadResponse: false, incomingTamper: false, uploadEpochs: [], pages: [], acknowledgements: [] };
  const metadata = () => ({ roster: state.roster, group: { ...rosterCloudFields(state.roster), headSequence: state.events.length,
    lastOperationId: state.events.at(-1)?.operationId ?? null, snapshotId: state.snapshot?.manifest.body.snapshotId ?? null,
    snapshotThroughSequence: state.snapshot?.manifest.body.throughSequence ?? 0 } });
  const cloud = {
    async readGroup() { if (state.denied) throw new SharingAccessError('denied'); return metadata(); },
    async readRoster(_group, revision) { return state.archive[revision - 1]; },
    async readGroupKey(_group, version, deviceId) {
      const identity = deviceId === owner.deviceId ? owner : member; const uid = deviceId === owner.deviceId ? 'owner' : 'member';
      return wrapGroupKey(crypto, 'group-test', version, keys.get(version), owner, identity, uid);
    },
    async readSnapshot() { return state.snapshot; },
    async pull(_group, after) {
      const data = metadata(); if (after < data.group.snapshotThroughSequence) throw new SharingSnapshotRequiredError('compacted');
      let events = state.events.slice(after, after + state.pageSize);
      if (state.incomingTamper && events.length) events = events.map((event) => ({ ...event, envelope: { ...event.envelope, signature: '0'.repeat(128) } }));
      state.pages.push(events.length); return { ...data, events, throughSequence: events.at(-1)?.uploadSequence ?? after };
    },
    async upload(envelope) {
      state.uploadEpochs.push(envelope.keyVersion); if (state.denied) throw new SharingAccessError('denied');
      if (state.failUpload) throw new Error('offline');
      const old = state.events.find((item) => item.operationId === envelope.operationId); if (old) return old;
      if (state.roster.body.keyVersion !== envelope.keyVersion) throw new SharingKeyVersionError('epoch');
      const event = parseSharedCloudEvent(envelope.operationId, { schemaVersion: 1, authorUserId: envelope.authorUserId,
        authorDeviceId: envelope.authorDeviceId, keyVersion: envelope.keyVersion, envelopeJson: canonicalJson(envelope), uploadSequence: state.events.length + 1 }, 'group-test');
      state.events.push(event);
      if (state.loseUploadResponse) { state.loseUploadResponse = false; throw new Error('response lost'); }
      return event;
    },
    async acknowledge(_group, device, sequence) { state.acknowledgements.push({ device, sequence }); },
  };
  async function device(identity = owner, uid = 'owner', status = 'active') {
    const h = createDatabase(); await ledger.initializeSharingLedger(h.database);
    let record = { userId: uid, groupId: 'group-test', displayName: '家族', status, anchor: first,
      rosterArchive: [first], createdAt: '2026-10-27T00:00:00Z', lastSuccessfulSyncAt: null, lastErrorCode: null };
    let latest = first; const localKeys = new Map(); let projectFails = false; let projections = 0;
    const dependencies = { database: h.database, groupId: 'group-test', userId: uid, identity, crypto, cloud,
      readRecord: async () => record, saveArchive: async (archive) => { record = { ...record, rosterArchive: archive }; latest = archive.at(-1); },
      readKey: async (version) => localKeys.get(version)?.slice() ?? null,
      saveKey: async (version, key) => { localKeys.set(version, key.slice()); },
      project: async () => { if (projectFails) throw new Error('projection interrupted'); projections++; },
      serialized: (work) => work(), changed: () => {}, now: () => 10000 };
    let count = 0;
    const edit = async (values = ['床掃除']) => ledger.createLocalSharedOperations(h.database,
      { groupId: 'group-test', userId: uid, deviceId: identity.deviceId, keyVersion: state.roster.body.keyVersion },
      values.map((value) => ({ operationId: `${uid}-edit-${++count}`, entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: value } })),
      dependencies.project, (operation) => signSharedOperation(operation, identity).authorSignature);
    const coordinator = createSharedSynchronizer(dependencies);
    return { ...h, dependencies, sync: coordinator.sync, withMaintenance: coordinator.withMaintenance, edit, localKeys, roster: () => latest,
      setStatus: (status) => { record.status = status; }, failProjection: (value) => { projectFails = value; }, projections: () => projections,
      replica: () => ledger.loadSharedReplica(h.database, 'group-test'), checkpoint: () => ledger.readSharingCheckpoint(h.database, 'group-test') };
  }
  return { owner, member, first, second, keys, state, cloud, device };
}

test('250 signed edits upload in bounded pages, restore on another device and never echo or duplicate after retry', async () => {
  const f = await fixture(); const a = await f.device(); const b = await f.device(f.member, 'member');
  try {
    await a.edit(Array.from({ length: 250 }, (_, index) => `床掃除${index}`));
    const sent = await a.sync(); assert.equal(sent.sent, 250); assert.equal(sent.pending, 0);
    assert.equal(f.state.events.length, 250); assert.equal((await a.checkpoint()).sequence, 250);
    f.state.pages.length = 0; const received = await b.sync(); assert.equal(received.received, 250);
    assert.deepEqual(f.state.pages.filter((size) => size), [100, 100, 50]);
    assert.equal((await b.replica()).entities[0].fields.name, '床掃除249');
    await b.sync(); await a.sync(); assert.equal(f.state.events.length, 250); assert.equal((await b.checkpoint()).pendingCount, 0);
    assert.ok(!JSON.stringify(f.state.events).includes('床掃除'));
  } finally { a.connection.close(); b.connection.close(); }
});

test('a stalled cloud response times out without losing local edits and a late successful write is acknowledged once on retry', async () => {
  const f = await fixture(); const a = await f.device(); let release;
  try {
    const gate = new Promise((resolve) => { release = resolve; });
    a.dependencies.cloud = sharingCloudWithDeadline({ ...f.cloud, async upload(envelope) {
      const accepted = await f.cloud.upload(envelope); await gate; return accepted;
    } }, 25);
    await a.edit();
    await assert.rejects(a.sync(), (error) => error.code === 'unavailable');
    assert.equal((await a.checkpoint()).pendingCount, 1); assert.equal(f.state.events.length, 1);
    const stored = (await ledger.listSharingOutbox(a.database, 'group-test', Number.MAX_SAFE_INTEGER))[0].encryptedEnvelope;
    release(); await new Promise(setImmediate); await a.sync({ force: true });
    assert.equal((await a.checkpoint()).pendingCount, 0); assert.equal(f.state.events.length, 1);
    assert.equal(stored, f.state.events[0].envelopeJson);
  } finally { release?.(); a.connection.close(); }
});

test('network deadlines preserve synchronous unsubscribe handles and reject invalid timeout configuration', () => {
  const unsubscribe = () => {}; const cloud = { watch: () => unsubscribe, async readGroup() { return 'group'; } };
  assert.equal(sharingCloudWithDeadline(cloud).watch(), unsubscribe);
  assert.throws(() => sharingCloudWithDeadline(cloud, 0));
});

test('a lost upload response, process restart and offline retry keep one event and the exact stored ciphertext', async () => {
  const f = await fixture(); const a = await f.device();
  try {
    await a.edit(['一回目', '二回目']); f.state.loseUploadResponse = true;
    await assert.rejects(a.sync(), /response lost/); assert.equal(f.state.events.length, 1);
    const queued = await ledger.listSharingOutbox(a.database, 'group-test', Number.MAX_SAFE_INTEGER);
    assert.equal(queued[0].encryptedEnvelope, f.state.events[0].envelopeJson);
    const restarted = createSharedSynchronizer(a.dependencies);
    await restarted.sync({ force: true });
    assert.equal(f.state.events.length, 2); assert.equal((await a.checkpoint()).pendingCount, 0);
    f.state.failUpload = true; await a.edit(['オフライン']); await assert.rejects(restarted.sync(), /offline/);
    const attempts = f.state.uploadEpochs.length;
    await restarted.sync(); assert.equal(f.state.uploadEpochs.length, attempts);
    f.state.failUpload = false; await restarted.sync({ force: true });
    assert.equal(f.state.events.length, 3); assert.equal((await a.checkpoint()).pendingCount, 0);
  } finally { a.connection.close(); }
});

test('tampered ciphertext and interrupted projection do not advance the cursor or acknowledge uncommitted changes', async () => {
  const f = await fixture(); const a = await f.device(); const b = await f.device(f.member, 'member');
  try {
    await a.edit(); await a.sync(); f.state.acknowledgements.length = 0;
    f.state.incomingTamper = true; await assert.rejects(b.sync());
    assert.equal((await b.checkpoint()).sequence, 0); assert.equal((await b.replica()).operations.length, 0);
    assert.equal(f.state.acknowledgements.length, 0);
    f.state.incomingTamper = false; b.failProjection(true); await assert.rejects(b.sync(), /projection interrupted/);
    assert.equal((await b.checkpoint()).sequence, 0); assert.equal((await b.replica()).operations.length, 0);
    b.failProjection(false); await b.sync(); assert.equal((await b.checkpoint()).sequence, 1);
  } finally { a.connection.close(); b.connection.close(); }
});

test('security attack: correctly signed corrupt transport stalls safely without acknowledging it or losing independent offline edits', async () => {
  const f = await fixture(); const target = await f.device();
  try {
    const operation = { schemaVersion: 1, operationId: 'malicious-approved-author', groupId: 'group-test', authorUserId: 'member',
      authorDeviceId: f.member.deviceId, deviceSequence: 1, logicalClock: 1, context: {}, keyVersion: 2,
      entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: 'synthetic' } };
    const { signature: _signature, ...unsigned } = await encryptSharedOperation(crypto, operation, f.keys.get(2), f.member);
    unsigned.encryptedPayload = `${unsigned.encryptedPayload.startsWith('00') ? 'ff' : '00'}${unsigned.encryptedPayload.slice(2)}`;
    await f.cloud.upload({ ...unsigned, signature: signSharedDocument(unsigned, f.member) });
    await target.edit(['独立した未送信の変更']);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(target.sync({ force: true }));
      assert.equal((await target.checkpoint()).sequence, 0);
      assert.equal((await ledger.listSharingOutbox(target.database, 'group-test', Number.MAX_SAFE_INTEGER)).length, 1);
      const replica = await target.replica();
      assert.equal(replica.operations.length, 1); assert.equal(replica.entities[0].fields.name, '独立した未送信の変更');
      assert.equal(f.state.events.length, 1); assert.equal(f.state.acknowledgements.length, 0);
    }
  } finally { target.connection.close(); }
});

test('owner recovery maintenance waits for active sync and coalesces queued delivery while independent offline edits remain writable', async () => {
  const f = await fixture(); const a = await f.device(); let releaseUpload; let releaseMaintenance; let entered;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const maintenanceGate = new Promise(resolve => { releaseMaintenance = resolve; });
  const maintenanceEntered = new Promise(resolve => { entered = resolve; }); let reads = 0;
  a.dependencies.cloud = { ...f.cloud, async readGroup(...args) { reads++; return f.cloud.readGroup(...args); },
    async upload(...args) { await uploadGate; return f.cloud.upload(...args); } };
  try {
    await a.edit(['先に送信する変更']); const first = a.sync({ force: true });
    const maintenance = a.withMaintenance(async () => { entered(); await maintenanceGate; return 'reviewed'; });
    let started = false; void maintenanceEntered.then(() => { started = true; });
    await new Promise(setImmediate); assert.equal(started, false);
    releaseUpload(); await first; await maintenanceEntered;
    await a.edit(['復旧の確認中に保存した変更']);
    assert.equal((await ledger.listSharingOutbox(a.database, 'group-test', Number.MAX_SAFE_INTEGER)).length, 1);
    const before = reads; const queued = Array.from({ length: 100 }, () => a.sync({ force: true }));
    await new Promise(setImmediate); assert.equal(reads, before); assert.equal(f.state.events.length, 1);
    await assert.rejects(a.withMaintenance(async () => {}), /実行中/u);
    releaseMaintenance(); assert.equal(await maintenance, 'reviewed'); await Promise.all(queued);
    assert.equal(f.state.events.length, 2); assert.ok(reads - before <= 3, `Unexpected repeated network delivery: ${reads - before}`);
    assert.equal((await a.checkpoint()).pendingCount, 0);
  } finally { releaseUpload(); releaseMaintenance(); a.connection.close(); }
});

test('failed owner recovery maintenance releases queued sync and never leaves a persistent syncing lock', async () => {
  const f = await fixture(); const a = await f.device(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await a.edit();
    const maintenance = a.withMaintenance(async () => { await gate; throw new Error('review stale'); });
    const delivery = a.sync({ force: true });
    release(); await assert.rejects(maintenance, /review stale/); await delivery;
    assert.equal(f.state.events.length, 1); assert.equal((await a.checkpoint()).pendingCount, 0);
    assert.equal(await a.withMaintenance(async () => 'next review'), 'next review');
  } finally { release(); a.connection.close(); }
});

test('an old encrypted outbox item rekeys after transactional absence while its original author operation stays unchanged', async () => {
  const f = await fixture(); const a = await f.device();
  try {
    f.state.roster = f.first; await a.edit();
    const item = (await ledger.listSharingOutbox(a.database, 'group-test'))[0];
    const original = canonicalJson(item.operation); const envelope = await encryptSharedOperation(crypto, item.operation, f.keys.get(1), f.owner);
    await ledger.saveSharingEnvelope(a.database, item.operation.operationId, canonicalJson(envelope)); a.localKeys.set(1, f.keys.get(1).slice());
    f.state.roster = f.second;
    f.state.snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica('group-test', []), [], f.second, f.owner, f.keys.get(2), 'rotate-empty', 0,
      (uid, device, version) => sharedAuthorIdentity(f.state.archive[version - 1], uid, device, version));
    await a.sync(); assert.deepEqual(f.state.uploadEpochs, [1, 2]);
    assert.equal(f.state.events[0].envelope.keyVersion, 2); assert.equal(canonicalJson((await a.replica()).operations[0]), original);
    assert.equal((await a.checkpoint()).snapshotId, 'rotate-empty'); assert.equal((await a.checkpoint()).pendingCount, 0);
  } finally { a.connection.close(); }
});

test('joining devices wait for approval, removed groups reject access, and local unsent changes survive both', async () => {
  const f = await fixture(); const a = await f.device(); const b = await f.device(f.member, 'member', 'joining');
  try {
    f.state.denied = true;
    assert.equal((await b.sync()).waitingForApproval, true);
    await a.edit(); await assert.rejects(a.sync(), { code: 'sharing/access-denied' });
    assert.equal((await a.checkpoint()).pendingCount, 1);
    f.state.denied = false; a.setStatus('removed'); await assert.rejects(a.sync(), { code: 'sharing/access-denied' });
    assert.equal((await a.checkpoint()).pendingCount, 1); assert.equal(f.state.events.length, 0);
  } finally { a.connection.close(); b.connection.close(); }
});

test('late snapshots compact an older prefix without rolling back newer received events or the cursor', async () => {
  const f = await fixture(); const a = await f.device();
  try {
    await a.edit(['古い', '新しい']); await a.sync();
    const facts = await ledger.loadSharedFacts(a.database, 'group-test'); const first = facts.find((fact) => fact.operation.deviceSequence === 1);
    f.state.snapshot = await createEncryptedSharedSnapshot(crypto, buildSharedReplica('group-test', [first.operation]), [first], f.second, f.owner, f.keys.get(2), 'late-prefix', 1,
      (uid, device, version) => sharedAuthorIdentity(f.state.archive[version - 1], uid, device, version));
    await a.sync(); const checkpoint = await a.checkpoint();
    assert.equal(checkpoint.sequence, 2); assert.equal(checkpoint.snapshotId, 'late-prefix');
    assert.equal((await a.replica()).entities[0].fields.name, '新しい'); assert.equal((await a.replica()).operationIndex.length, 2);
  } finally { a.connection.close(); }
});

test('concurrent triggers share one upload coordinator and one server event per operation', async () => {
  const f = await fixture(); const a = await f.device();
  try {
    await a.edit(['一回']); const first = a.sync(); const second = a.sync({ force: true }); assert.equal(first, second);
    await Promise.all([first, second]); assert.equal(f.state.events.length, 1); assert.equal((await a.checkpoint()).pendingCount, 0);
  } finally { a.connection.close(); }
});

test('audit100 a shared worker queued behind maintenance cannot restart after its caller deadline', async () => {
  const f=await fixture(); const a=await f.device(); let clock=10000,release; a.dependencies.now=()=>clock;
  const coordinator=createSharedSynchronizer(a.dependencies); let calls=0; const read=f.cloud.readGroup;
  a.dependencies.cloud={...f.cloud,readGroup:async(...args)=>{calls++;return read(...args);}};
  const gate=new Promise(resolve=>{release=resolve;});
  try{
    await a.edit(); const maintenance=coordinator.withMaintenance(()=>gate); await new Promise(setImmediate);
    const waiting=coordinator.sync({force:true,budgetMs:1000});
    clock+=1000; release(); await maintenance;
    await assert.rejects(waiting,error=>error.code==='unavailable');
    assert.equal(calls,0);assert.equal((await a.checkpoint()).pendingCount,1);
  }finally{release?.();a.connection.close();}
});
