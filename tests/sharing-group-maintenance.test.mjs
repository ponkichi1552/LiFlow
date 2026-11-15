import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMaintenanceFixture, flush } from './helpers/sharing-group-maintenance.mjs';
import { createDeviceIdentity, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { createSharedInvitation, createSharedJoinRequest } from '../src/features/sharing/invitations.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { loadSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';

test('normal owner compatibility upgrade preserves 106 proofs and original keys with no additional network request or duplicate commit', async t => {
  const h = await groupMaintenanceFixture(t); await h.manager.upgradeScheduler(); await h.settled();
  assert.equal(h.record().rosterArchive.at(-1).body.schedulerVersion, 'liflow-shared-2-draft-58');
  assert.deepEqual(h.counters, { readGroup: 3, readRoster: 0, readSnapshot: 1, readReceipts: 0, pull: 4, upload: 0, acknowledge: 2, prepare: 1, commit: 1 });
  const currentKey = h.keyDigest(4); assert.notEqual(currentKey, h.initialKeyDigest);
  await h.manager.upgradeScheduler(); assert.equal(h.counters.commit, 1); assert.equal(h.counters.prepare, 1); assert.equal(h.keyDigest(4), currentKey);
});

for (const capture of ['metadata', 'record']) test(`an owner epoch change excludes a ${capture} listener started during preparation and completes post-commit adoption`, async t => {
  const h = await groupMaintenanceFixture(t), release = h.pause(); let armed = false, readsDuringPreparation;
  if (capture === 'metadata') h.state.hooks.readGroup = async value => { if (armed) { armed = false; await release.promise; } return value; };
  else h.state.hooks.readRecord = async value => { if (armed) { armed = false; await release.promise; } return value; };
  h.state.hooks.prepare = async () => {
    armed = true; const previous = h.counters.readGroup; h.listener(); await flush(); readsDuringPreparation = h.counters.readGroup - previous;
  };
  h.state.hooks.afterArchive = archive => { if (archive.at(-1).body.keyVersion === 4) release.resolve(); };
  await h.manager.upgradeScheduler(); await Promise.all(h.state.pending); await h.settled();
  assert.equal(readsDuringPreparation, 0); assert.equal(h.counters.commit, 1); assert.ok(h.counters.readGroup <= 4);
});

test('a manager waits for already active old-epoch delivery and coalesces one hundred listener retries without metadata rollback or extra snapshots', async t => {
  const h = await groupMaintenanceFixture(t), entered = h.pause(), release = h.pause(); let held = false;
  h.state.hooks.readGroup = async value => { if (!held) { held = true; entered.resolve(); await release.promise; } return value; };
  let readsDuringPreparation;
  h.state.hooks.prepare = async () => {
    const before = h.counters.readGroup; for (let i = 0; i < 100; i++) h.listener(); await flush(); readsDuringPreparation = h.counters.readGroup - before;
  };
  const active = h.listener(); await entered.promise; const upgrading = h.manager.upgradeScheduler(); await flush();
  assert.equal(h.counters.commit, 0); release.resolve(); await active;
  await upgrading; await Promise.all(h.state.pending); await h.settled();
  assert.equal(readsDuringPreparation, 0); assert.equal(h.counters.commit, 1); assert.equal(h.counters.readSnapshot, 1);
  assert.ok(h.counters.readGroup <= 5, `Listener requests must coalesce, observed ${h.counters.readGroup}`);
});

test('local edits remain writable during epoch maintenance and their exact original Outbox proof survives snapshot adoption and rekeying', async t => {
  const h = await groupMaintenanceFixture(t); let pendingProof;
  h.state.hooks.prepare = async () => {
    await h.repository.commit([{ operationId: 'offline-maintenance-edit', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: 'synthetic offline edit' } }]);
    const [pending] = await listSharingOutbox(h.database, h.repository.scope.groupId, Number.MAX_SAFE_INTEGER);
    pendingProof = sharedDocumentDigest(pending.operation); assert.equal(pending.operation.keyVersion, 3); h.listener();
  };
  await h.manager.upgradeScheduler(); await Promise.all(h.state.pending); await h.verifyOriginals();
  const [restored] = (await loadSharedFacts(h.database, h.repository.scope.groupId)).filter(fact => fact.operation.operationId === 'offline-maintenance-edit');
  assert.equal(sharedDocumentDigest(restored.operation), pendingProof); assert.equal(restored.operation.keyVersion, 3);
  const sent = h.state.events.find(event => event.operationId === 'offline-maintenance-edit'); assert.equal(sent.envelope.keyVersion, 4);
  assert.equal((await h.checkpoint()).pendingCount, 0); assert.equal((await h.repository.readState()).assessment.view.ready.length, 107);
});

for (const failure of ['prepare', 'commit', 'cancel']) test(`a ${failure} failure releases epoch maintenance without changing proofs archive or saved keys and a bounded retry succeeds`, async t => {
  const h = await groupMaintenanceFixture(t); const error = Object.assign(new Error(`synthetic ${failure} failure`), failure === 'cancel' ? { name: 'AbortError', code: 'cancelled' } : {});
  let rejected;
  if (failure === 'commit') h.state.hooks.beforeCommit = async () => { h.listener(); throw error; };
  else h.state.hooks.prepare = async () => { h.listener(); throw error; };
  try { await h.manager.upgradeScheduler(); } catch (cause) { rejected = cause; }
  assert.equal(rejected, error); await Promise.allSettled(h.state.pending);
  assert.equal(h.record().rosterArchive.at(-1).body.keyVersion, 3); assert.equal(h.state.roster.body.keyVersion, 3); assert.equal(h.keyDigest(4), null);
  await h.verifyOriginals(); h.state.hooks.prepare = undefined; h.state.hooks.beforeCommit = undefined;
  await h.manager.upgradeScheduler(); await h.settled(); assert.equal(h.state.roster.body.keyVersion, 4);
});

for (const failure of ['lost-commit-reply', 'key-save', 'archive-save']) test(`a ${failure} after epoch commit keeps the original proofs and recovers that same epoch without another membership write`, async t => {
  const h = await groupMaintenanceFixture(t), error = new Error(`synthetic ${failure}`); let failed = false;
  const once = async () => { if (!failed) { failed = true; throw error; } };
  if (failure === 'lost-commit-reply') h.state.hooks.afterCommit = once;
  else if (failure === 'key-save') h.state.hooks.beforeKey = version => version === 4 ? once() : undefined;
  else h.state.hooks.beforeArchive = archive => archive.at(-1).body.keyVersion === 4 ? once() : undefined;
  await assert.rejects(h.manager.upgradeScheduler(), cause => cause === error);
  assert.equal(h.state.roster.body.keyVersion, 4); await h.verifyOriginals();
  h.state.hooks.afterCommit = undefined; h.state.hooks.beforeKey = undefined; h.state.hooks.beforeArchive = undefined;
  await h.manager.upgradeScheduler(); await h.settled(); assert.equal(h.counters.commit, 1); assert.equal(h.record().rosterArchive.at(-1).body.keyVersion, 4);
});

for (const failure of ['read-unavailable', 'true-rollback', 'permission']) test(`post-commit ${failure} is still rejected without unbounded retries or weakened membership validation`, async t => {
  const h = await groupMaintenanceFixture(t); const old = h.metadata(); let requestsAfterCommit = 0;
  h.state.hooks.readGroup = async value => {
    if (h.state.roster.body.keyVersion !== 4) return value; requestsAfterCommit++;
    if (failure === 'true-rollback') return old;
    throw Object.assign(new Error(`synthetic ${failure}`), { code: failure === 'permission' ? 'permission-denied' : 'unavailable' });
  };
  await assert.rejects(h.manager.upgradeScheduler(), cause => failure === 'true-rollback' ? /rollback/.test(cause.message)
    : cause.code === (failure === 'permission' ? 'permission-denied' : 'unavailable'));
  assert.equal(requestsAfterCommit, 1); assert.equal(h.state.roster.body.keyVersion, 4); assert.equal(h.record().rosterArchive.at(-1).body.keyVersion, 4);
  assert.ok(h.keyDigest(4)); await h.verifyOriginals(); h.state.hooks.readGroup = undefined;
  await h.synchronizer.sync({ force: true }); await h.settled(); assert.equal(h.counters.commit, 1);
});

for (const action of ['remove-member', 'remove-device', 'transfer-owner', 'retained-snapshot']) test(`the shared ${action} rotation uses the same listener exclusion while retaining all original facts`, async t => {
  const h = await groupMaintenanceFixture(t);
  h.state.hooks.prepare = async () => { const before = h.counters.readGroup; h.listener(); await flush(); assert.equal(h.counters.readGroup, before); };
  if (action === 'remove-member') await h.manager.removeMembers(['member']);
  else if (action === 'remove-device') await h.manager.removeDevice(h.tablet.deviceId);
  else if (action === 'transfer-owner') await h.manager.transferOwnership({ userId: 'member', deviceId: h.f.member.deviceId });
  else await h.manager.publishSnapshot(120000, async replica => replica);
  await Promise.all(h.state.pending); await h.settled(); assert.equal(h.counters.commit, 1); assert.equal(h.state.roster.body.keyVersion, 4);
});

test('shared member admission stays signature checked while using epoch maintenance and preserving the original history', async t => {
  const h = await groupMaintenanceFixture(t); const identity = await createDeviceIdentity(crypto);
  const invitation = await createSharedInvitation(crypto, h.state.roster, h.f.owner, 'maintenance-invitation', Date.now());
  const request = createSharedJoinRequest(invitation, 'new-member', identity, Date.now());
  h.state.hooks.prepare = async () => { const before = h.counters.readGroup; h.listener(); await flush(); assert.equal(h.counters.readGroup, before); };
  await h.manager.approve(invitation.invitation, request); await Promise.all(h.state.pending); await h.settled();
  assert.ok(h.state.roster.body.members.some(member => member.userId === 'new-member')); assert.equal(h.counters.commit, 1);
});

test('owner departure closes its epoch without recursively syncing inside maintenance or deleting its retained local proofs', async t => {
  const h = await groupMaintenanceFixture(t, { ownerOnly: true }); await h.manager.leave();
  assert.equal(h.state.roster.body.closed, true); assert.equal(h.record().status, 'left'); assert.equal(h.counters.commit, 1); assert.equal(h.counters.prepare, 0);
  assert.equal(sharedDocumentDigest(await loadSharedFacts(h.database, h.repository.scope.groupId)), h.originalDigest);
});
