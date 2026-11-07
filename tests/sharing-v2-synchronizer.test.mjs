import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, createSharedRoster, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { rosterCloudFields, SharingSnapshotRequiredError } from '../src/features/sharing/cloud-contract.ts';
import { createV2Synchronizer } from '../src/features/sharing/v2/synchronizer.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { signV2RecoveryLock } from '../src/features/sharing/v2/recovery-lock.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

const groupId = 'v2-sync-test'; const startingTime = Date.parse('2026-10-27T01:00:00Z');
const draft = (operationId, entityType, entityId, payload) => ({ operationId, entityType, entityId, payload, operationType: 'patch' });
const seeds = () => [draft('policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('family') }),
  draft('settings', 'settings', 'settings', { name: '検査用', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }),
  draft('chore', 'chore', 'floor', { name: '床掃除', enabled: true }), draft('config', 'chorePolicy', 'floor', { configuration: {
    policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27', intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } })];
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const first = createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 }); const roster = approveSharedDevice(first, owner, 'member', member);
  const archive = [first, roster]; const keys = new Map([[1, await crypto.randomBytes(32)], [2, await crypto.randomBytes(32)]]);
  const state = { events: [], receipts: new Map(), head: 0, snapshot: null, loseResponse: false, offline: false,
    clock: startingTime, receiptAdvanceMs: 0, receiptPages: [], changed: 0, invalidEventReceipt: false };
  const metadata = () => ({ roster, group: { ...rosterCloudFields(roster), headSequence: state.head,
    lastOperationId: state.head ? `event-${state.head}` : null, snapshotId: state.snapshot?.manifest.body.snapshotId ?? null,
    snapshotThroughSequence: state.snapshot?.manifest.body.throughSequence ?? 0 } });
  const checkNetwork = () => { if (state.offline) throw new Error('offline'); };
  const cloud = {
    async readGroup() { checkNetwork(); return metadata(); }, async readRoster(_group, revision) { return archive[revision - 1]; },
    async readSnapshot() { checkNetwork(); return state.snapshot; },
    async readReceipts(_group, ids) { checkNetwork(); state.receiptPages.push(ids.length); state.clock += state.receiptAdvanceMs;
      return ids.map((id) => state.receipts.get(id)).filter(Boolean); },
    async upload(envelope, options) {
      checkNetwork(); const existing = state.events.find((event) => event.operationId === envelope.operationId); if (existing) return existing;
      if (state.receipts.has(envelope.operationId)) throw new SharingSnapshotRequiredError('compacted');
      assert.match(options.authorProofDigest, /^[a-f0-9]{64}$/);
      const receipt = { schemaVersion: 2, groupId, operationId: envelope.operationId, authorUserId: envelope.authorUserId,
        authorDeviceId: envelope.authorDeviceId, receivedKeyVersion: envelope.keyVersion, uploadSequence: ++state.head,
        authorProofDigest: options.authorProofDigest, receivedAtMs: state.clock };
      const event = { operationId: envelope.operationId, uploadSequence: state.head, envelope, envelopeJson: JSON.stringify(envelope),
        authorProofDigest: options.authorProofDigest, serverReceipt: receipt };
      state.events.push(event); state.receipts.set(envelope.operationId, receipt);
      if (state.loseResponse) { state.loseResponse = false; throw new Error('response lost'); }
      return event;
    },
    async pull(_group, after) {
      checkNetwork(); if (state.snapshot && after < state.snapshot.manifest.body.throughSequence) throw new SharingSnapshotRequiredError('snapshot');
      const events = state.events.filter((event) => event.uploadSequence > after).slice(0, 100).map((event) => state.invalidEventReceipt ? { ...event, serverReceipt: undefined } : event);
      return { ...metadata(), events, throughSequence: events.at(-1)?.uploadSequence ?? after };
    }, async acknowledge() {},
  };
  async function device(uid = 'owner', identity = owner) {
    const h = createDatabase(); await initializeV2EventStore(h.database, { groupId, userId: uid, householdId: 'local' });
    let current = uid; let record = { groupId, userId: uid, status: 'active', anchor: first, rosterArchive: [first] };
    const assertAccount = () => { if (current !== uid) throw new Error('account changed'); };
    const repository = createV2EventRepository(h.database, { groupId, userId: uid, householdId: 'local', identity, anchor: first,
      archive: () => record.rosterArchive, now: () => new Date(state.clock), assertWritable: assertAccount });
    const options = { database: h.database, groupId, userId: uid, identity, crypto, cloud, repository,
      readRecord: async () => record, saveArchive: async (value) => { record = { ...record, rosterArchive: value }; },
      readKey: async (version) => keys.get(version)?.slice(), saveKey: async () => {}, serialized: async (work) => work(),
      changed: () => { state.changed++; }, now: () => state.clock, assertCurrentAccount: assertAccount };
    return { ...h, repository, sync: createV2Synchronizer(options), restart: () => createV2Synchronizer(options),
      logout: () => { current = 'another'; }, projection: () => h.connection.prepare('SELECT * FROM sharing_v2_projection').get() };
  }
  return { owner, member, first, roster, archive, keys, state, cloud, device };
}

test('a sharing upload that consumes the remaining budget stays incomplete and does not acknowledge a stale receive cursor',async()=>{
  const f=await fixture();const owner=await f.device();let acknowledgements=0;
  const upload=f.cloud.upload;f.cloud.upload=async(...args)=>{const result=await upload(...args);f.state.clock+=1000;return result;};
  f.cloud.acknowledge=async()=>{acknowledgements++;};
  try{
    await owner.repository.commit(seeds());const result=await owner.sync.sync({force:true,budgetMs:1000});
    assert.equal(result.sent,1);assert.equal(result.complete,false,'the final receive pass did not run');
    assert.equal(acknowledgements,0);assert.equal(result.pending,3);
  }finally{owner.connection.close();}
});

test('coalescing another sharing request cannot restart a fresh time budget after the original background budget expires',async()=>{
  const f=await fixture();const owner=await f.device();let finish;let reads=0;const pull=f.cloud.pull;
  f.cloud.pull=async(...args)=>{reads++;if(reads===1)await new Promise(resolve=>{finish=resolve;});return pull(...args);};
  try{
    await owner.repository.commit(seeds());const first=owner.sync.sync({force:true,budgetMs:1000});
    while(!finish)await new Promise(resolve=>setImmediate(resolve));
    const joined=owner.sync.sync({force:true,budgetMs:1000});f.state.clock+=1000;finish();
    const [result]=await Promise.all([first,joined]);
    assert.equal(f.state.events.length,0,'no followup may start with a renewed deadline');
    assert.equal(reads,1);assert.equal(result.complete,false);assert.equal(result.pending,4);
  }finally{owner.connection.close();}
});

test('an expired sharing failure does not start optional recovery diagnostics outside its original time budget',async()=>{
  const f=await fixture();const owner=await f.device();let probes=0;const failure=new Error('corrupt transport');
  f.cloud.ownerRecoveryEnabled=true;f.cloud.readGroup=async()=>{f.state.clock+=1000;throw failure;};
  f.cloud.readRecoveryLock=async()=>{probes++;return null;};
  try{await assert.rejects(owner.sync.sync({force:true,budgetMs:1000}),error=>error===failure);assert.equal(probes,0);}
  finally{owner.connection.close();}
});

test('v2 coordinator delivers signed facts and independent receipts between two isolated users and converges without changing v1 defaults', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const result = await owner.sync.sync({ force: true });
    assert.equal(result.pending, 0); assert.equal(result.sent, 4); assert.equal(f.state.receipts.size, 4);
    await member.sync.sync({ force: true });
    assert.equal(member.projection().fact_hash, owner.projection().fact_hash);
    assert.equal((await readSharingCheckpoint(member.database, groupId)).sequence, 4);
    assert.deepEqual(JSON.parse(member.projection().rejected_json), []);
    const before = f.state.head; await owner.restart().sync({ force: true }); assert.equal(f.state.head, before);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 lost upload response retains its outbox and the retry adopts the same immutable server receipt', async () => {
  const f = await fixture(); const owner = await f.device();
  try {
    await owner.repository.commit(seeds()); f.state.loseResponse = true;
    await assert.rejects(owner.sync.sync({ force: true }), /response lost/);
    const receipt = [...f.state.receipts.values()][0]; assert.equal((await listSharingOutbox(owner.database, groupId, Number.MAX_SAFE_INTEGER)).length, 4);
    await owner.restart().sync({ force: true });
    assert.deepEqual(f.state.receipts.get(receipt.operationId), receipt); assert.equal(f.state.head, 4);
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 0);
  } finally { owner.connection.close(); }
});
test('v2 coordinator refuses event receipt gaps and account changes without advancing the receive cursor', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); await owner.sync.sync({ force: true }); f.state.invalidEventReceipt = true;
    await assert.rejects(member.sync.sync({ force: true }), { code: 'sharing/v2-awaiting-receipt' });
    assert.equal((await readSharingCheckpoint(member.database, groupId)).cursor, null);
    assert.equal((await loadSharedReplica(member.database, groupId)).operations.length, 0);
    f.state.invalidEventReceipt = false; member.logout(); await assert.rejects(member.sync.sync({ force: true }), /account changed/);
    assert.equal((await readSharingCheckpoint(member.database, groupId)).cursor, null);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 coordinator rejects a repository bound to another account or device before opening its synchronization path', async () => {
  const f = await fixture(); const owner = await f.device();
  try {
    assert.throws(() => createV2Synchronizer({ groupId, userId: 'member', identity: f.member, repository: owner.repository }), /same account/);
    assert.equal((await readSharingCheckpoint(owner.database, groupId)).cursor, null);
  } finally { owner.connection.close(); }
});
test('v2 recovery diagnostics do not issue another network request after transport authorization or resumable evidence failures', async () => {
  for (const code of ['unavailable', 'firestore/unavailable', 'deadline-exceeded', 'cancelled', 'aborted', 'resource-exhausted', 'permission-denied', 'unauthenticated',
    'sharing/access-denied', 'sharing/scheduler-version-mismatch', 'sharing/receipt-recovery-pending', 'sharing/v2-awaiting-receipt']) {
    const f = await fixture(); const owner = await f.device(); let probes = 0;
    const failure = Object.assign(new Error('original failure'), { code });
    f.cloud.ownerRecoveryEnabled = true;
    f.cloud.readGroup = async () => { throw failure; };
    f.cloud.readRecoveryLock = async () => { probes++; throw new Error('another stalled network request'); };
    try {
      await owner.repository.commit(seeds());
      await assert.rejects(owner.sync.sync({ force: true }), error => error === failure);
      assert.equal(probes, 0, code);
      assert.equal((await listSharingOutbox(owner.database, groupId, Number.MAX_SAFE_INTEGER)).length, 4);
      assert.equal((await readSharingCheckpoint(owner.database, groupId)).cursor, null);
    } finally { owner.connection.close(); }
  }
});
test('v2 an authenticated owner recovery lock still explains a corrupt transport failure without advancing the cursor', async () => {
  const f = await fixture(); const member = await f.device('member', f.member); let reads = 0; let probes = 0;
  const normalRead = f.cloud.readGroup;
  f.cloud.ownerRecoveryEnabled = true;
  f.cloud.readGroup = async () => { if (++reads === 1) throw new Error('corrupt transport'); return normalRead(); };
  f.cloud.readRecoveryLock = async () => { probes++; return signV2RecoveryLock(f.roster, f.owner,
    { id: 'owner-review', throughSequence: 0, reviewDigest: 'a'.repeat(64) }); };
  try {
    await assert.rejects(member.sync.sync({ force: true }), { code: 'sharing/recovery-in-progress' });
    assert.equal(probes, 1);
    assert.equal((await readSharingCheckpoint(member.database, groupId)).cursor, null);
  } finally { member.connection.close(); }
});
test('v2 backlog confirmations coalesce projection and observer updates while preserving all 205 original receipts and 100-event pages', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds());
    await owner.repository.commit(Array.from({ length: 201 }, (_, index) => draft(`edit-${index}`, 'chore', 'floor', { name: `床掃除 ${index}` })));
    const result = await owner.sync.sync({ force: true }); assert.equal(result.sent, 205); assert.equal(result.pending, 0);
    assert.equal(f.state.receipts.size, 205); assert.ok(f.state.changed <= 20, `Observer invalidated ${f.state.changed} times for one backlog`);
    await member.sync.sync({ force: true }); assert.equal((await readSharingCheckpoint(member.database, groupId)).sequence, 205);
    assert.equal(member.projection().fact_hash, owner.projection().fact_hash);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 snapshot receipt recovery checkpoints bounded progress across restarts without applying an incomplete snapshot', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds());
    for (let offset = 0; offset < 2001; offset += 256) await owner.repository.commit(Array.from({ length: Math.min(256, 2001 - offset) }, (_, index) =>
      draft(`bulk-${String(offset + index).padStart(5, '0')}`, 'chore', 'floor', { name: `床掃除 ${offset + index}` })));
    const facts = await loadSharedFacts(owner.database, groupId); const replica = await loadSharedReplica(owner.database, groupId);
    f.state.head = facts.length;
    for (const fact of facts) f.state.receipts.set(fact.operation.operationId, { schemaVersion: 2, groupId, operationId: fact.operation.operationId,
      authorUserId: fact.operation.authorUserId, authorDeviceId: fact.operation.authorDeviceId, receivedKeyVersion: 2,
      uploadSequence: fact.operation.deviceSequence, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: startingTime });
    f.state.snapshot = await createEncryptedSharedSnapshot(crypto, replica, facts, f.roster, f.owner, f.keys.get(2), 'long-offline', facts.length,
      (uid, device, version) => sharedAuthorIdentity(f.archive[version - 1], uid, device, version));
    f.state.receiptAdvanceMs = 20_000;
    await assert.rejects(member.sync.sync({ force: true }), { code: 'sharing/receipt-recovery-pending' });
    assert.equal((await readSharingCheckpoint(member.database, groupId)).cursor, null);
    assert.equal(member.connection.prepare('SELECT COUNT(*) AS count FROM sharing_v2_server_receipts').get().count, 1000);
    await assert.rejects(member.restart().sync({ force: true }), { code: 'sharing/receipt-recovery-pending' });
    assert.equal((await readSharingCheckpoint(member.database, groupId)).cursor, null);
    assert.equal(member.connection.prepare('SELECT COUNT(*) AS count FROM sharing_v2_server_receipts').get().count, 2000);
    await member.restart().sync({ force: true });
    assert.deepEqual(f.state.receiptPages, [1000, 1000, 5]);
    assert.equal((await readSharingCheckpoint(member.database, groupId)).sequence, 2005);
    assert.equal(JSON.parse(member.projection().accepted_ids_json).length, 2005);
    assert.deepEqual(JSON.parse(member.projection().rejected_json), []);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('audit100 an expired initial sharing metadata read cannot start another receive request',async()=>{
  const f=await fixture();const owner=await f.device();let pulls=0;const read=f.cloud.readGroup,pull=f.cloud.pull;
  f.cloud.readGroup=async(...args)=>{const result=await read(...args);f.state.clock+=1000;return result;};
  f.cloud.pull=async(...args)=>{pulls++;return pull(...args);};
  try{await owner.repository.commit(seeds());const result=await owner.sync.sync({force:true,budgetMs:1000});
    assert.equal(result.complete,false);assert.equal(pulls,0);assert.equal(result.sent,0);assert.equal(result.pending,4);
  }finally{owner.connection.close();}
});
