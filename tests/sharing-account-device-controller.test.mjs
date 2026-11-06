import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, approveOwnSharedDevice, createSharedRoster, removeSharedDevice, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { createAccountDeviceController } from '../src/features/sharing/account-device-controller.ts';
import { createAccountDeviceRestoreRequest, createAccountDeviceRestoreGrant, accountDeviceRestoreAcknowledgment,
  parseAccountDeviceRestoreReceipts, validateAccountDeviceRestorePending } from '../src/features/sharing/account-device-restore.ts';
import { continuousAccountDeviceEpochs, resolveSharedGroupKey } from '../src/features/sharing/account-device-key-continuity.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';

async function fixture() {
  const owner = await createDeviceIdentity(crypto), first = await createDeviceIdentity(crypto), second = await createDeviceIdentity(crypto);
  const root = createSharedRoster('automatic-restore', 'owner', owner, { schemaVersion: 2 }), joined = approveSharedDevice(root, owner, 'member', first);
  let archive = [root, joined], records = [], clock = Date.now(), requests = 0, accepts = 0;
  const keys = new Map([[2, await crypto.randomBytes(32)]]), cleanups = [];
  const metadata = () => ({ archive: structuredClone(archive), group: { ...rosterCloudFields(archive.at(-1)), headSequence: 0,
    lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 } });
  const api = {
    async read() { return structuredClone(records); },
    async request(input) { requests++; const old = records.find(row => row.slot === input.slot);
      if (old && old.request.body.requestId !== input.replaceRequestId) throw new Error('receipt CAS');
      records = records.filter(row => row.slot !== input.slot); records.push({ slot: input.slot, status: 'requested', request: input.request, receivedAt: clock }); },
    async accept(input) { accepts++; const row = records.find(row => row.slot === input.slot); assert.equal(row.request.body.requestId, input.requestId);
      const next = input.grant.body.roster; if (next.body.revision > archive.at(-1).body.revision) archive.push(next);
      row.status = 'accepted'; row.grant = input.grant; row.acceptedAt = clock; },
    async acknowledge(input) { const row = records.find(row => row.slot === input.slot); assert.equal(sharedDocumentDigest(row.grant), input.grantDigest);
      row.status = 'acknowledged'; delete row.grant; delete row.acceptedAt; },
  };
  function device(identity, saved = new Map()) {
    let pending = null, active = false, current = true, failSave = false, failAck = false, issued = 0;
    const returnedKeys = [];
    const deps = { userId: 'member', identity, crypto, api: { ...api, acknowledge: async input => { if (failAck) throw new Error('lost ACK'); await api.acknowledge(input); } },
      assertCurrent: () => { if (!current) throw new Error('account changed'); }, now: () => clock, newRequestId: () => `request-${++issued}`,
      loadPending: async () => pending && structuredClone(pending), savePending: async value => { pending = structuredClone(value); }, clearPending: async () => { pending = null; cleanups.push('pending'); },
      discover: async () => metadata(), minimum: async () => 2,
      readKey: async version => { const bytes = saved.get(version)?.slice() ?? null; if (bytes) returnedKeys.push(bytes); return bytes; },
      saveKey: async (_group, version, bytes) => { if (failSave) throw new Error('protected storage unavailable'); saved.set(version, bytes.slice()); },
      activate: async () => { active = true; } };
    return { deps, saved, returnedKeys, run: () => createAccountDeviceController(deps).run(), pending: () => pending, active: () => active,
      switch: () => { current = false; }, failSave: v => { failSave = v; }, failAck: v => { failAck = v; } };
  }
  return { owner, first, second, root, joined, keys, api, device, metadata, records: () => records,
    setArchive: value => { archive = value; }, counts: () => ({ requests, accepts }), tick: ms => { clock += ms; } };
}

test('same-account automatic restoration needs no invitation or owner and acknowledges only after durable recipient keys and activation', async () => {
  const h = await fixture(), phone = h.device(h.first, h.keys), tablet = h.device(h.second);
  assert.equal(await tablet.run(), 'waiting'); assert.equal(tablet.active(), false);
  assert.equal(h.counts().requests, 1); assert.equal(await tablet.run(), 'waiting'); assert.equal(h.counts().requests, 1);
  assert.equal(await phone.run(), 'sent'); assert.equal(h.metadata().archive.at(-1).body.ownerDeviceId, h.owner.deviceId);
  assert.equal(await tablet.run(), 'restored'); assert.equal(tablet.active(), true); assert.equal(tablet.pending(), null);
  assert.deepEqual(tablet.saved.get(2), h.keys.get(2)); assert.deepEqual(tablet.saved.get(3), h.keys.get(2));
  assert.equal(h.records()[0].grant, undefined); assert.equal(h.records()[0].status, 'acknowledged');
  assert.equal(new Set(h.metadata().archive.at(-1).body.members.find(row => row.userId === 'member').devices.map(row => row.identity.deviceId)).size, 2);
});

test('a lost submission response reuses its durable nonce and a restarted recipient retries an unacknowledged grant without another admission', async () => {
  const h = await fixture(), phone = h.device(h.first, h.keys), tablet = h.device(h.second);
  const original = tablet.deps.api.request; let lose = true;
  tablet.deps.api.request = async input => { await original(input); if (lose) { lose = false; throw new Error('lost POST response'); } };
  await assert.rejects(tablet.run(), /lost POST/); const id = tablet.pending().request.body.requestId;
  assert.equal(await tablet.run(), 'waiting'); assert.equal(tablet.pending().request.body.requestId, id); assert.equal(h.counts().requests, 1);
  await phone.run(); tablet.failAck(true); await assert.rejects(tablet.run(), /lost ACK/);
  assert.equal(tablet.active(), true); assert.equal(h.records()[0].status, 'accepted'); assert.ok(tablet.pending());
  tablet.failAck(false); assert.equal(await tablet.run(), 'restored'); assert.equal(h.metadata().archive.length, 3); assert.equal(h.counts().accepts, 1);
});

test('failed secure saves and account switches never acknowledge or activate a new same-account workspace', async () => {
  const h = await fixture(), phone = h.device(h.first, h.keys), tablet = h.device(h.second);
  await tablet.run(); await phone.run(); tablet.failSave(true); await assert.rejects(tablet.run(), /protected storage/);
  assert.equal(tablet.active(), false); assert.equal(h.records()[0].status, 'accepted'); assert.ok(tablet.pending());
  tablet.failSave(false); const read = tablet.deps.discover;
  tablet.deps.discover = async (...args) => { const result = await read(...args); tablet.switch(); return result; };
  await assert.rejects(tablet.run(), /account changed/); assert.equal(tablet.active(), false); assert.equal(h.records()[0].status, 'accepted');
});

test('restoration coalesces simultaneous starts and detects request pins, account changes and removed device grants', async () => {
  const h = await fixture(), tablet = h.device(h.second), controller = createAccountDeviceController(tablet.deps);
  assert.equal(controller.run(), controller.run()); await controller.run();
  const wrong = structuredClone(tablet.pending()); wrong.request.body.userId = 'owner'; assert.throws(() => validateAccountDeviceRestorePending(wrong, 'member'));
  await h.device(h.first, h.keys).run();
  const removed = removeSharedDevice(h.metadata().archive.at(-1), h.owner, h.second.deviceId);
  h.setArchive([...h.metadata().archive, removed]); await assert.rejects(tablet.run(), /removed or group changed/);
  assert.equal(tablet.active(), false); assert.ok(tablet.pending());
});

test('an unrelated authenticated account cannot use automatic restoration to join a group and receipt pages remain bounded', async () => {
  const h = await fixture(), tablet = h.device(h.second);
  tablet.deps.userId = 'outsider'; await assert.rejects(tablet.run(), /not a current/);
  await h.device(h.second).run(); const rows = h.records();
  assert.deepEqual(parseAccountDeviceRestoreReceipts({ records: rows }, 'member', 'automatic-restore'), rows);
  for (const page of [{ records: [...rows, ...rows] }, { records: rows, token: 'unexpected' }, { records: Array(5).fill(rows[0]) }]) {
    assert.throws(() => parseAccountDeviceRestoreReceipts(page, 'member', 'automatic-restore'));
  }
});

test('continuous account-device keys open earlier owner snapshots but never bridge an owner rotation or authorize a removed device', async () => {
  const h = await fixture(), request = createAccountDeviceRestoreRequest(h.joined, 'member', h.second, 'continuity-request');
  const { grant, next } = await createAccountDeviceRestoreGrant({ crypto, previous: h.joined, request, sponsor: h.first,
    userId: 'member', minimumKeyVersion: 2, readKey: async version => h.keys.get(version), archive: [h.root, h.joined] });
  const archive = [h.root, h.joined, next]; assert.equal(continuousAccountDeviceEpochs(archive, 2, 3), true);
  const saved = new Map();
  const input = { crypto, identity: h.second, userId: 'member', archive, epoch: h.joined, readKey: async version => saved.get(version) ?? null,
    saveKey: async (version, key) => saved.set(version, key.slice()), readEnvelope: async version => { assert.equal(version, 3); return grant.body.keys.at(-1); } };
  const earlier = await resolveSharedGroupKey(input); assert.deepEqual(earlier, h.keys.get(2)); earlier.fill(0);
  const removed = removeSharedDevice(next, h.owner, h.second.deviceId);
  assert.equal(continuousAccountDeviceEpochs([...archive, removed], 2, 4), false);
  await assert.rejects(resolveSharedGroupKey({ ...input, archive: [...archive, removed] }), /not a current/);
  const foreign = createSharedRoster('foreign', 'owner', h.owner, { schemaVersion: 2 });
  await assert.rejects(resolveSharedGroupKey({ ...input, epoch: foreign }), /Unknown group/);
});

test('a member sponsoring their own new device gains neither snapshot ownership nor another members key envelope', async () => {
  const h = await fixture(), next = approveOwnSharedDevice(h.joined, h.first, 'member', h.second, 'a'.repeat(64));
  await assert.rejects(createEncryptedSharedSnapshot(crypto, buildSharedReplica('automatic-restore', [], undefined, 2), [], next, h.first,
    h.keys.get(2), 'member-owned-snapshot', 0, () => { throw new Error('unused'); }), /does not grant snapshot ownership/);
  const wrapped = await wrapGroupKey(crypto, 'automatic-restore', 3, h.keys.get(2), h.first, h.second, 'member');
  const saved = new Map([[2, h.keys.get(2)]]);
  const key = await resolveSharedGroupKey({ crypto, identity: h.first, userId: 'member', archive: [h.root, h.joined, next], epoch: next,
    readKey: async version => saved.get(version) ?? null, saveKey: async (version, key) => saved.set(version, key.slice()),
    readEnvelope: async () => { throw new Error('Existing peers must derive continuity without new envelopes'); } });
  assert.deepEqual(key, h.keys.get(2)); assert.equal(wrapped.recipientDeviceId, h.second.deviceId); key.fill(0);
});
