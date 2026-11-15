import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId, now } from './sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest } from '../../src/features/sharing/crypto.ts';
import { approveOwnSharedDevice, sharedRosterDigest } from '../../src/features/sharing/roster.ts';
import { rosterCloudFields, SharingKeyVersionError, SharingSnapshotRequiredError } from '../../src/features/sharing/cloud-contract.ts';
import { createV2WorkspaceSession } from '../../src/features/sharing/v2/workspace-session.ts';
import { newEventDraft } from '../../src/domain/calendar/events.ts';
import * as ledger from '../../src/platform/storage/sharing-ledger.ts';

export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export const flush = () => new Promise(setImmediate);

/** Real production workspace/manager/coordinator, crypto and SQLite; only Cloud IO is in memory. */
export async function groupMaintenanceFixture(t, { schedulerVersion = 'liflow-shared-2-draft-57', ownerOnly = false } = {}) {
  const f = await fixture({ schedulerVersion }); const tablet = await createDeviceIdentity(crypto);
  if (ownerOnly) {
    f.archive.splice(1);
    f.archive.push(approveOwnSharedDevice(f.archive.at(-1), f.owner, 'owner', tablet, 'a'.repeat(64)));
    f.archive.push(approveOwnSharedDevice(f.archive.at(-1), f.owner, 'owner', await createDeviceIdentity(crypto), 'b'.repeat(64)));
  } else f.archive.push(approveOwnSharedDevice(f.archive.at(-1), f.owner, 'owner', tablet, 'a'.repeat(64)));
  const d = await f.device(); const key = await crypto.randomBytes(32); const keys = new Map([[3, key.slice()]]);
  const initialKeyDigest = sharedDocumentDigest([...key]); key.fill(0);
  let currentAccount = true, ordinal = 0;
  let record = { groupId, userId: 'owner', status: 'active', anchor: f.archive[0], rosterArchive: structuredClone(f.archive), lastErrorCode: null };
  const counters = Object.fromEntries(['readGroup', 'readRoster', 'readSnapshot', 'readReceipts', 'pull', 'upload', 'acknowledge', 'prepare', 'commit'].map(name => [name, 0]));
  const state = { roster: f.archive.at(-1), archive: structuredClone(f.archive), events: [], receipts: new Map(), snapshot: null, prepared: null,
    envelopes: new Map(), revoked: [], hooks: {}, pending: [], gates: [] };
  const metadata = () => ({ roster: structuredClone(state.roster), group: { ...rosterCloudFields(state.roster), headSequence: state.events.length,
    revokedUserIds: [...state.revoked], rotationRequired: state.revoked.length > 0, lastOperationId: state.events.at(-1)?.operationId ?? null,
    snapshotId: state.snapshot?.manifest.body.snapshotId ?? null, snapshotThroughSequence: state.snapshot?.manifest.body.throughSequence ?? 0 } });
  const copyRecord = () => structuredClone(record);
  const cloud = {
    ownerRecoveryEnabled: false,
    async readGroup() { counters.readGroup++; const value = metadata(); return state.hooks.readGroup ? state.hooks.readGroup(value) : value; },
    async readRoster(_group, revision) { counters.readRoster++; return structuredClone(state.archive[revision - 1]); },
    async readGroupKey(_group, version, deviceId) {
      const envelope = state.envelopes.get(`${version}:${deviceId}`); assert.ok(envelope, 'current committed key envelope is required'); return envelope;
    },
    async readSnapshot(_group, id) { counters.readSnapshot++; assert.equal(id, state.snapshot.manifest.body.snapshotId); return structuredClone(state.snapshot); },
    async readReceipts(_group, ids) { counters.readReceipts++; return ids.map(id => state.receipts.get(id)).filter(Boolean); },
    async pull(_group, after) {
      counters.pull++; if (state.snapshot && after < state.snapshot.manifest.body.throughSequence) throw new SharingSnapshotRequiredError();
      const events = state.events.filter(event => event.uploadSequence > after).slice(0, 100);
      return { ...metadata(), events, throughSequence: events.at(-1)?.uploadSequence ?? after };
    },
    async upload(envelope, options) {
      counters.upload++; if (envelope.keyVersion !== state.roster.body.keyVersion) throw new SharingKeyVersionError();
      const existing = state.events.find(event => event.operationId === envelope.operationId); if (existing) return existing;
      const receipt = { schemaVersion: 2, groupId, operationId: envelope.operationId, authorUserId: envelope.authorUserId,
        authorDeviceId: envelope.authorDeviceId, receivedKeyVersion: envelope.keyVersion, uploadSequence: state.events.length + 1,
        authorProofDigest: options.authorProofDigest, receivedAtMs: now().getTime() + 10000 };
      const event = { operationId: envelope.operationId, uploadSequence: receipt.uploadSequence, envelope, envelopeJson: JSON.stringify(envelope),
        authorProofDigest: receipt.authorProofDigest, serverReceipt: receipt };
      state.events.push(event); state.receipts.set(event.operationId, receipt); return event;
    },
    async acknowledge() { counters.acknowledge++; },
    async prepareSnapshot(snapshot, next, remaining) {
      counters.prepare++; state.prepared = snapshot;
      await state.hooks.prepare?.({ snapshot, next, remaining });
    },
    async commitMembership(previous, next, envelopes, sequence, manifest) {
      counters.commit++; await state.hooks.beforeCommit?.({ previous, next });
      assert.equal(sharedRosterDigest(previous), sharedRosterDigest(state.roster)); assert.equal(sequence, state.events.length);
      if (next.body.closed) assert.equal(manifest, undefined);
      else assert.equal(sharedDocumentDigest(manifest), sharedDocumentDigest(state.prepared.manifest));
      state.roster = next; state.archive.push(next); state.snapshot = state.prepared; state.revoked = [];
      for (const envelope of envelopes) state.envelopes.set(`${next.body.keyVersion}:${envelope.recipientDeviceId}`, envelope);
      await state.hooks.afterCommit?.({ previous, next });
    },
  };
  const assertCurrent = () => { if (!currentAccount) throw new Error('account changed'); };
  const dependencies = { groupId, userId: 'owner', householdId: 'group-local', database: d.database, identity: f.owner, crypto, cloud,
    archive: () => f.archive, assertCurrentAccount: assertCurrent, assertWritable: assertCurrent,
    readRecord: async () => { const value = copyRecord(); return state.hooks.readRecord ? state.hooks.readRecord(value) : value; },
    saveArchive: async archive => {
      await state.hooks.beforeArchive?.(archive);
      if (record.rosterArchive.at(-1).body.revision > archive.at(-1).body.revision) throw new Error('Membership changed concurrently');
      record = { ...record, rosterArchive: structuredClone(archive) }; f.archive.splice(0, f.archive.length, ...archive);
      await state.hooks.afterArchive?.(archive);
    },
    readKey: async version => keys.get(version)?.slice() ?? null,
    saveKey: async (version, bytes) => { await state.hooks.beforeKey?.(version); keys.set(version, bytes.slice()); },
    serialized: work => work(), changed() {}, makeId: () => `group-maintenance-${++ordinal}`,
    markLeft: async () => { record = { ...record, status: 'left' }; },
  };
  const session = await createV2WorkspaceSession(dependencies);
  t.after(async () => {
    for (const gate of state.gates) gate.resolve(); await Promise.allSettled(state.pending); for (const bytes of keys.values()) bytes.fill(0); d.connection.close();
  });
  const normal = { ...newEventDraft('2026-11-11', 'Asia/Tokyo'), title: 'synthetic preserved calendar', allDay: true, recurrence: 'monthly' };
  const category = { id: 'personal', name: '私用', color: '#3D906A' };
  const original = [...seeds(), ...Array.from({ length: 102 }, (_, index) => {
    const id = `preserved-calendar-${index}`;
    return { operationId: id, entityType: 'calendarEvent', entityId: id, operationType: 'patch', payload: {
      eventId: id, scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value: normal, category } };
  })];
  await session.repository.commit(original); await session.synchronizer.sync({ force: true, budgetMs: 120000 });
  const originalFacts = await ledger.loadSharedFacts(d.database, groupId); assert.equal(originalFacts.length, 106);
  const originalDigest = sharedDocumentDigest(originalFacts);
  for (const name of Object.keys(counters)) counters[name] = 0;
  const track = promise => { state.pending.push(promise); void promise.catch(() => undefined); return promise; };
  return { ...d, ...session, f, tablet, state, cloud, dependencies, counters, metadata, record: copyRecord, originalDigest,
    pause() { const gate = deferred(); state.gates.push(gate); return gate; }, track,
    listener: (options = {}) => track(session.synchronizer.sync({ budgetMs: 120000, ...options })),
    switchAccount: () => { currentAccount = false; }, restoreAccount: () => { currentAccount = true; },
    keyDigest: version => keys.has(version) ? sharedDocumentDigest([...keys.get(version)]) : null,
    initialKeyDigest,
    async verifyOriginals() {
      const facts = await ledger.loadSharedFacts(d.database, groupId);
      assert.equal(sharedDocumentDigest(facts.filter(fact => fact.operation.operationId !== 'offline-maintenance-edit')), originalDigest);
      assert.equal(sharedDocumentDigest([...keys.get(3)]), initialKeyDigest);
      return facts;
    },
    checkpoint: () => ledger.readSharingCheckpoint(d.database, groupId),
    async settled() {
      const checkpoint = await ledger.readSharingCheckpoint(d.database, groupId); const current = await session.repository.readState();
      assert.equal(checkpoint.pendingCount, 0); assert.equal(current.assessment.rejected.length, 0);
      assert.equal(current.assessment.view.ready.length, 106); assert.equal(checkpoint.snapshotId, state.snapshot.manifest.body.snapshotId);
      await this.verifyOriginals(); return checkpoint;
    },
  };
}
