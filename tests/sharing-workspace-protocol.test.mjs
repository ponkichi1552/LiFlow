import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceIdentity, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createSharedInvitation } from '../src/features/sharing/invitations.ts';
import { approveSharedDevice, createSharedRoster, sharedRosterDigest, upgradeSharedRoster } from '../src/features/sharing/roster.ts';
import { readCloudWorkspaceArchive, sharedWorkspaceProtocol, verifyWorkspaceArchive } from '../src/features/sharing/workspace-protocol.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';

const record = (anchor, rosterArchive = [anchor], status = 'active') => ({ userId: 'owner', groupId: 'workspace-protocol',
  displayName: '検査グループ', status, anchor, rosterArchive, createdAt: '2026-10-27T00:00:00Z', lastSuccessfulSyncAt: null, lastErrorCode: null });
async function fixture(schemaVersion = 1) {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const initial = createSharedRoster('workspace-protocol', 'owner', owner, { schemaVersion });
  return { owner, member, initial };
}
test('workspace protocol resolution verifies pinned v1 and v2 archives without changing their inputs', async () => {
  for (const version of [1, 2]) {
    const f = await fixture(version); const latest = approveSharedDevice(f.initial, f.owner, 'member', f.member);
    const stored = record(f.initial, [f.initial, latest]); const before = JSON.stringify(stored);
    const archive = verifyWorkspaceArchive(stored); assert.deepEqual(archive, [f.initial, latest]);
    assert.equal(sharedWorkspaceProtocol(archive.at(-1)), version); assert.equal(JSON.stringify(stored), before);
    assert.equal(sharedWorkspaceProtocol(verifyWorkspaceArchive(record(f.initial, [], 'creating')).at(-1)), version);
  }
});
test('a pin-only invitation leaves its database format unknown until its full signed archive is available', async () => {
  const f = await fixture(2); const invitation = await createSharedInvitation(crypto, f.initial, f.owner, 'invite', 1000);
  const waiting = record(invitation.invitation.body.pin, [], 'joining');
  assert.equal(verifyWorkspaceArchive(waiting), null);
  assert.equal(sharedWorkspaceProtocol(verifyWorkspaceArchive(waiting, [f.initial]).at(-1)), 2);
  assert.throws(() => verifyWorkspaceArchive({ ...waiting, status: 'active' }), /Missing trusted/u);
});
test('workspace protocol verification refuses forged membership, foreign groups and a missing pinned epoch', async () => {
  const f = await fixture(2); const latest = approveSharedDevice(f.initial, f.owner, 'member', f.member);
  const invitation = await createSharedInvitation(crypto, latest, f.owner, 'invite', 1000);
  const waiting = record(invitation.invitation.body.pin, [], 'joining');
  assert.throws(() => verifyWorkspaceArchive(waiting, [f.initial]));
  const forged = structuredClone(latest); forged.body.schemaVersion = 1;
  assert.throws(() => verifyWorkspaceArchive(waiting, [f.initial, forged]));
  assert.throws(() => verifyWorkspaceArchive({ ...record(f.initial), groupId: 'foreign' }));
  const stranger = createSharedRoster('workspace-protocol', 'owner', f.member, { schemaVersion: 2 });
  assert.throws(() => verifyWorkspaceArchive(waiting, [stranger, latest]));
});
test('a verified protocol upgrade is classified as v2 without mutating the v1 trusted creation pin', async () => {
  const f = await fixture(); const upgraded = upgradeSharedRoster(f.initial, f.owner); const stored = record(f.initial, [f.initial, upgraded]);
  assert.equal(sharedWorkspaceProtocol(verifyWorkspaceArchive(stored).at(-1)), 2);
  assert.equal(stored.anchor.body.schemaVersion, 1); assert.equal(stored.rosterArchive[0].body.schemaVersion, 1);
});
test('a valid signature for an unsupported scheduler never authorizes opening a supported workspace format', async () => {
  const f = await fixture(2); const body = { ...f.initial.body, schedulerVersion: 'future-v3' };
  const future = { body, signer: f.initial.signer, signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, f.owner) };
  assert.throws(() => verifyWorkspaceArchive(record(future)), { code: 'sharing/scheduler-version-mismatch' });
});
test('a rejoin invitation must reach the old trusted chain even if both membership archives have valid signatures', async () => {
  const f = await fixture(2); const stranger = createSharedRoster('workspace-protocol', 'owner', f.member, { schemaVersion: 2 });
  const link = await createSharedInvitation(crypto, stranger, f.member, 'invite', 1000);
  const stored = { ...record(f.initial), join: { invitation: link.invitation, request: {} } };
  assert.notEqual(sharedRosterDigest(stranger), sharedRosterDigest(f.initial));
  assert.throws(() => verifyWorkspaceArchive(stored), /previously trusted/u);
});

test('cloud protocol discovery fetches bounded missing public epochs and refuses same-revision replacement or rollback', async () => {
  const f = await fixture(2); const second = approveSharedDevice(f.initial, f.owner, 'member', f.member);
  const invitation = await createSharedInvitation(crypto, second, f.owner, 'invite', 1000);
  const waiting = record(invitation.invitation.body.pin, [], 'joining'); const reads = [];
  assert.deepEqual(await readCloudWorkspaceArchive(waiting, second, async (id, revision) => { reads.push([id, revision]); return f.initial; }), [f.initial, second]);
  assert.deepEqual(reads, [['workspace-protocol', 1]]);
  const noFetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(readCloudWorkspaceArchive(record(f.initial, [f.initial, second]), f.initial, noFetch), /rollback/u);
  const stranger = createSharedRoster('workspace-protocol', 'owner', f.member, { schemaVersion: 2 });
  await assert.rejects(readCloudWorkspaceArchive(record(f.initial), stranger, noFetch), /existing revision/u);
  const body = { ...f.initial.body, revision: 4097, keyVersion: 4097, previousDigest: 'a'.repeat(64) };
  const excessive = { body, signer: f.initial.signer, signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, f.owner) };
  await assert.rejects(readCloudWorkspaceArchive(waiting, excessive, noFetch), /history limit/u);
});

test('a previously signed v1 to draft38 migration stays readable without silently replacing its trusted roster version', async () => {
  const f = await fixture(); const next = upgradeSharedRoster(f.initial, f.owner);
  const body = { ...next.body, schedulerVersion: 'liflow-shared-2-draft-38' };
  const historical = { body, signer: next.signer, signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, f.owner) };
  const stored = record(f.initial, [f.initial, historical]); const before = JSON.stringify(stored);
  assert.equal(sharedWorkspaceProtocol(verifyWorkspaceArchive(stored).at(-1)), 2);
  assert.equal(JSON.stringify(stored), before);
});
