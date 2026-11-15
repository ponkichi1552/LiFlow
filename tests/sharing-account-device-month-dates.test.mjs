import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import * as operations from '../src/features/sharing/operations.ts';
import * as encryption from '../src/features/sharing/crypto.ts';
import * as rosters from '../src/features/sharing/roster.ts';
import * as cloud from '../src/features/sharing/cloud-contract.ts';
import * as snapshots from '../src/features/sharing/snapshots.ts';
import * as restoration from '../src/features/sharing/account-device-restore.ts';
import { createAccountDeviceController } from '../src/features/sharing/account-device-controller.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { V2_SCHEDULER_VERSION } from '../src/features/sharing/v2/payload-schema.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { createV2EventRepository, initializeV2EventStore } from '../src/platform/storage/sharing-v2-events.ts';
import { applySharingSnapshot, readSharingCheckpoint, loadSharedFacts } from '../src/platform/storage/sharing-ledger.ts';

const groupId = 'account-device-month-dates';
const oldVersion = 'liflow-shared-2-draft-57';
const now = Date.parse('2026-11-16T00:00:00Z');
const rule = { unit: 'month', interval: 1, on: 'dates', days: [11, 12] };
const category = { id: 'personal', name: '私用', color: '#3D906A' };

function serviceModule(mocks) {
  const source = readFileSync(new URL('../server/account-device-api/src/service.mjs', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName: 'account-device-service.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  Function('require', 'module', 'exports', outputText)(name => { assert.ok(name in mocks, `Unexpected service import ${name}`); return mocks[name]; }, module, module.exports);
  return module.exports;
}

/** SDK-only unit double. It never initializes Firebase or opens an emulator connection. */
function transactionStore() {
  class Timestamp { constructor(value) { this.value = value; } toMillis() { return this.value; } static fromMillis(value) { return new Timestamp(value); } }
  class Transform { constructor(kind, value) { this.kind = kind; this.value = value; } }
  const FieldValue = { serverTimestamp: () => new Transform('timestamp'), increment: value => new Transform('increment', value), delete: () => new Transform('delete') };
  const copy = value => value instanceof Timestamp ? new Timestamp(value.value) : Array.isArray(value) ? value.map(copy)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, part]) => [key, copy(part)])) : value;
  const records = new Map(); let tail = Promise.resolve(); let writes = 0;
  const ref = path => ({ path, collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }) });
  const snapshot = target => ({ exists: records.has(target.path), data: () => copy(records.get(target.path)) });
  const firestore = { doc: ref, getAll: async (...targets) => targets.map(snapshot), runTransaction(work) {
    const result = tail.then(async () => {
      const staged = []; let writing = false;
      const read = target => { assert.equal(writing, false, 'Firestore transactions must read before writing'); return snapshot(target); };
      const stage = (kind, target, data, options) => { writing = true; staged.push({ kind, path: target.path, data, options }); };
      const value = await work({ get: async target => read(target), getAll: async (...targets) => targets.map(read),
        set: (target, data, options) => stage('set', target, data, options), update: (target, data) => stage('update', target, data),
        create: (target, data) => stage('create', target, data), delete: target => stage('delete', target) });
      const next = new Map(records);
      for (const change of staged) {
        if (change.kind === 'delete') { next.delete(change.path); continue; }
        if (change.kind === 'create') assert.equal(next.has(change.path), false, 'create cannot replace a document');
        if (change.kind === 'update') assert.equal(next.has(change.path), true, 'update requires an existing document');
        const prior = next.get(change.path); const row = change.kind === 'update' || change.options?.merge ? copy(prior ?? {}) : {};
        for (const [key, part] of Object.entries(change.data)) {
          if (!(part instanceof Transform)) row[key] = copy(part);
          else if (part.kind === 'timestamp') row[key] = new Timestamp(now);
          else if (part.kind === 'increment') row[key] = (Number(prior?.[key]) || 0) + part.value;
          else delete row[key];
        }
        next.set(change.path, row);
      }
      records.clear(); for (const [path, row] of next) records.set(path, row); writes += staged.length;
      return value;
    }); tail = result.catch(() => undefined); return result;
  } };
  return { firestore, records, FieldValue, Timestamp, writes: () => writes };
}

async function fixture({ oldAuthor = false } = {}) {
  const owner = await encryption.createDeviceIdentity(crypto), phone = await encryption.createDeviceIdentity(crypto), tablet = await encryption.createDeviceIdentity(crypto);
  const root = rosters.createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 });
  root.body.schedulerVersion = oldVersion; root.signature = encryption.signSharedDocument({ domain: 'liflow-shared-roster-v1', body: root.body }, owner);
  const joined = rosters.approveSharedDevice(root, owner, 'member', phone), current = rosters.upgradeSharedScheduler(joined, owner);
  const archive = [root, joined, current]; const key = await crypto.randomBytes(32);
  const make = (id, sequence, keyVersion, value) => encryption.signSharedOperation({ schemaVersion: 2, operationId: id, groupId, authorUserId: 'owner', authorDeviceId: owner.deviceId,
    keyVersion, deviceSequence: sequence, logicalClock: sequence, context: sequence === 1 ? {} : { [owner.deviceId]: sequence - 1 },
    receiptContext: sequence === 1 ? {} : { [owner.deviceId]: sequence - 1 }, recordedAt: new Date(now).toISOString(), entityType: 'calendarEvent', entityId: id, operationType: 'patch',
    payload: { eventId: id, scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value, category } }, owner);
  const legacyValue = { ...newEventDraft('2026-11-11', 'Asia/Tokyo'), title: '既存の予定', allDay: true, recurrence: 'monthly' };
  const monthly = { ...legacyValue, title: '毎月11日、12日ハッカソン', recurrence: 'custom', customRecurrence: rule };
  const facts = [make('legacy-calendar', 1, joined.body.keyVersion, legacyValue), make('new-month-dates', 2, oldAuthor ? joined.body.keyVersion : current.body.keyVersion, monthly)];
  const author = (uid, device, version) => rosters.sharedAuthorIdentity(archive[version - 1], uid, device, version);
  const encrypted = await snapshots.createEncryptedSharedSnapshot(crypto, buildSharedReplica(groupId, facts.map(fact => fact.operation)), facts, current, owner, key,
    'account-month-snapshot', 2, author, archive);
  const memory = transactionStore(), path = `sharingGroups/${groupId}`;
  memory.records.set(path, { ...cloud.rosterCloudFields(current), headSequence: 2, lastOperationId: 'new-month-dates', snapshotId: encrypted.manifest.body.snapshotId, snapshotThroughSequence: 2 });
  for (const roster of archive) memory.records.set(`${path}/rosters/${roster.body.revision}`, { rosterJson: operations.canonicalJson(roster) });
  memory.records.set(`${path}/snapshots/${encrypted.manifest.body.snapshotId}`, { keyVersion: current.body.keyVersion, throughSequence: 2, manifestJson: operations.canonicalJson(encrypted.manifest) });
  memory.records.set('sharingUsers/member/memberships/current', { groupId, invitationId: null });
  const service = serviceModule({
    'firebase-admin/firestore': { FieldValue: memory.FieldValue, Timestamp: memory.Timestamp },
    '../../../src/features/sharing/operations.ts': operations, '../../../src/features/sharing/crypto.ts': encryption,
    '../../../src/features/sharing/cloud-contract.ts': cloud, '../../../src/features/sharing/roster.ts': rosters,
    '../../../src/features/sharing/snapshots.ts': snapshots, '../../../src/features/sharing/account-device-restore.ts': restoration,
  }).createAccountDeviceService({ firestore: memory.firestore, now: () => now });
  const actor = { uid: 'member', provider: 'google.com', authTime: now };
  const request = restoration.createAccountDeviceRestoreRequest(current, actor.uid, tablet, 'month-device-request');
  const { grant } = await restoration.createAccountDeviceRestoreGrant({ crypto, previous: current, request, sponsor: phone, userId: actor.uid,
    minimumKeyVersion: current.body.keyVersion, readKey: async version => version === current.body.keyVersion ? key : null, archive });
  const requestInput = { groupId, slot: 0, request, replaceRequestId: null }, acceptInput = { groupId, slot: 0, requestId: request.body.requestId, grant };
  const slotPath = `${path}/accountDeviceRestores/member/accountDeviceRequests/0`;
  const receipts = facts.map((fact, index) => ({ schemaVersion: 2, groupId, operationId: fact.operation.operationId, authorUserId: fact.operation.authorUserId,
    authorDeviceId: fact.operation.authorDeviceId, receivedKeyVersion: index === 0 ? joined.body.keyVersion : current.body.keyVersion,
    uploadSequence: index + 1, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: now }));
  return { ...memory, owner, phone, tablet, root, joined, current, archive, key, facts, encrypted, author, service, actor, request, grant, requestInput, acceptInput, path, slotPath, receipts };
}

async function restoreIntoSqlite(h, t) {
  const opened = await restoration.openAccountDeviceRestoreGrant({ crypto, grant: h.grant, request: h.request, previous: h.current,
    identity: h.tablet, minimumKeyVersion: h.current.body.keyVersion });
  const archive = [...h.archive, opened.roster];
  const snapshot = await snapshots.openEncryptedSharedSnapshot(crypto, h.encrypted, opened.keys.get(h.current.body.keyVersion), h.current, h.author, archive);
  const d = createDatabase(); t.after(() => d.connection.close()); const scope = { groupId, householdId: 'account-month-local', userId: 'member' };
  await initializeV2EventStore(d.database, scope);
  const repository = createV2EventRepository(d.database, { ...scope, identity: h.tablet, anchor: h.root, archive: () => archive, assertWritable() {} });
  await applySharingSnapshot(d.database, groupId, snapshot, repository.project, null, now, repository.evidenceForServerReceipts(h.receipts));
  for (const key of opened.keys.values()) key.fill(0);
  return { ...d, repository, snapshot };
}

test('draft58 account-device service read request accept and acknowledgment restore a month-date snapshot and preserve old signed calendar history', async t => {
  const h = await fixture(); assert.equal(h.current.body.schedulerVersion, V2_SCHEDULER_VERSION);
  assert.deepEqual(await h.service.read(h.actor, { groupId }), { records: [] });
  assert.deepEqual(await h.service.request(h.actor, h.requestInput), { status: 'requested' });
  assert.equal((await h.service.read(h.actor, { groupId })).records[0].status, 'requested');
  await Promise.all([h.service.accept(h.actor, h.acceptInput), h.service.accept(h.actor, h.acceptInput)]);
  const accepted = (await h.service.read(h.actor, { groupId })).records[0]; assert.equal(accepted.status, 'accepted');
  const metadata = h.records.get(h.path); assert.equal(metadata.rosterRevision, h.current.body.revision + 1);
  assert.equal(JSON.parse(metadata.rosterJson).body.schedulerVersion, V2_SCHEDULER_VERSION); assert.equal(metadata.ownerDeviceId, h.owner.deviceId);
  const recipient = await restoreIntoSqlite(h, t); const state = await recipient.repository.readState();
  assert.deepEqual(await loadSharedFacts(recipient.database, groupId), h.facts); assert.deepEqual(state.assessment.rejected, []);
  const records = readSharedCalendar(state.assessment.view); assert.equal(records.length, 2);
  const monthly = records.find(row => row.id === 'new-month-dates').heads[0].payload.value; assert.deepEqual(monthly.customRecurrence, rule);
  assert.deepEqual(projectCalendarEvents([{ ...monthly, id: 'new-month-dates', revision: 1 }], [], '2026-11-01', '2026-12-31').map(row => row.startDate),
    ['2026-11-11', '2026-11-12', '2026-12-11', '2026-12-12']);
  assert.equal((await readSharingCheckpoint(recipient.database, groupId)).snapshotId, h.encrypted.manifest.body.snapshotId);
  const ack = restoration.accountDeviceRestoreAcknowledgment({ slot: 0, request: h.request }, h.grant, h.tablet);
  assert.deepEqual(await h.service.acknowledge(h.actor, ack), { status: 'acknowledged' }); await h.service.acknowledge(h.actor, ack);
  assert.equal(h.records.get(h.slotPath).grantJson, undefined); assert.equal(h.records.get(h.slotPath).minimumKeyVersion, undefined);
  assert.equal((await h.service.read(h.actor, { groupId })).records[0].status, 'acknowledged');
  await h.service.accept(h.actor, h.acceptInput); assert.equal(h.records.get(h.path).rosterRevision, metadata.rosterRevision);
  const stored = JSON.stringify([...h.records.values()]); assert.equal(stored.includes(monthly.title), false); assert.equal(stored.includes('"on":"dates"'), false);
});

test('draft58 service and encrypted month snapshot bind grants acknowledgments and restored keys to the exact requesting account device and epoch', async () => {
  const h = await fixture(); const before = h.writes();
  await assert.rejects(h.service.request({ ...h.actor, uid: 'another-account' }, h.requestInput)); assert.equal(h.writes(), before);
  const staleRequest = restoration.createAccountDeviceRestoreRequest(h.joined, h.actor.uid, h.tablet, 'old-epoch-request');
  await assert.rejects(h.service.request(h.actor, { ...h.requestInput, request: staleRequest }), error => error.code === 'group_changed'); assert.equal(h.writes(), before);
  await h.service.request(h.actor, h.requestInput); const submitted = h.writes();
  const body = structuredClone(h.grant.body); body.keys[0].recipientDeviceId = h.phone.deviceId;
  const wrongGrant = { body, signature: encryption.signSharedDocument({ domain: 'liflow-account-device-grant-v1', body }, h.phone) };
  await assert.rejects(h.service.accept(h.actor, { ...h.acceptInput, grant: wrongGrant }), error => error.code === 'invalid_request'); assert.equal(h.writes(), submitted);
  assert.equal(h.records.get(h.slotPath).status, 'requested');
  await h.service.accept(h.actor, h.acceptInput); const acceptedWrites = h.writes();
  await assert.rejects(restoration.openAccountDeviceRestoreGrant({ crypto, grant: h.grant, request: h.request, previous: h.current, identity: h.phone,
    minimumKeyVersion: h.current.body.keyVersion }), /recipient differs/);
  const acknowledgment = restoration.accountDeviceRestoreAcknowledgment({ slot: 0, request: h.request }, h.grant, h.tablet);
  const wrongAck = { ...acknowledgment, signature: encryption.signSharedDocument({ domain: 'liflow-account-device-ack-v1', groupId, userId: h.actor.uid,
    requestDigest: encryption.sharedDocumentDigest(h.request), grantDigest: acknowledgment.grantDigest }, h.phone) };
  await assert.rejects(h.service.acknowledge(h.actor, wrongAck), error => error.code === 'invalid_request');
  assert.equal(h.writes(), acceptedWrites); assert.equal(h.records.get(h.slotPath).status, 'accepted');
});

test('an account-device key restoration cannot legitimize a new month shape signed in draft57 and keeps unrelated snapshot history readable', async t => {
  const h = await fixture({ oldAuthor: true }); await h.service.request(h.actor, h.requestInput); await h.service.accept(h.actor, h.acceptInput);
  // The end-to-end encrypted server can validate metadata, not calendar content.
  // The restored client rechecks the fact's immutable original and receipt epochs.
  const recipient = await restoreIntoSqlite(h, t); const state = await recipient.repository.readState();
  assert.deepEqual(readSharedCalendar(state.assessment.view).map(row => row.id), ['legacy-calendar']);
  const rejected = state.assessment.rejected.find(row => row.operationId === 'new-month-dates');
  assert.equal(rejected.kind, 'unauthorized'); assert.equal(rejected.error.code, 'sharing/v2-authority-denied');
  assert.deepEqual(await loadSharedFacts(recipient.database, groupId), h.facts, 'rejected immutable source proof is preserved');
  assert.equal((await readSharingCheckpoint(recipient.database, groupId)).snapshotId, h.encrypted.manifest.body.snapshotId);
});

test('frozen draft57 discovery blocks account restoration before API requests key saves activation or opening a draft58 month snapshot', async () => {
  const h = await fixture(); const directory = new URL('./fixtures/calendar-draft57/', import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8'));
  const source = readFileSync(new URL('payload-schema.ts.txt', directory), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.files['payload-schema.ts.txt'].sha256);
  const code = ts.transpileModule(source.slice(source.indexOf('export const V2_SCHEDULER_VERSION'), source.indexOf('type RecordValue')),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const old = { exports: {} }; Function('module', 'exports', code)(old, old.exports);
  const protocol = loadNativeModule('src/features/sharing/workspace-protocol.ts', { './operations.ts': operations, './cloud-contract.ts': cloud,
    './roster.ts': rosters, './v2/payload-schema.ts': { isSupportedV2Scheduler: old.exports.isSupportedV2Scheduler } });
  const record = { groupId, status: 'active', anchor: h.root, rosterArchive: h.archive }; const trusted = structuredClone(record); let effects = 0;
  const forbidden = () => { effects++; throw new Error('Old client must stop before private restore work'); };
  const controller = createAccountDeviceController({ userId: 'member', identity: h.tablet, crypto, assertCurrent() {}, now: () => now,
    newRequestId: forbidden, loadPending: async () => null, savePending: forbidden, clearPending: forbidden,
    discover: async () => ({ archive: protocol.verifyWorkspaceArchive(record), group: h.records.get(h.path) }), minimum: forbidden,
    api: { read: forbidden, request: forbidden, accept: forbidden, acknowledge: forbidden }, readKey: forbidden, saveKey: forbidden, activate: forbidden });
  await assert.rejects(controller.run(), { code: 'sharing/scheduler-version-mismatch' }); assert.equal(effects, 0); assert.deepEqual(record, trusted);
  assert.equal(h.writes(), 0); assert.equal(h.encrypted.manifest.body.schedulerVersion, V2_SCHEDULER_VERSION);
});
