import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedPeriodicSyncDue, SOLO_SHARED_POLL_INTERVAL_MS } from '../src/features/sharing/foreground-sync-policy.ts';

const now = 10_000_000;
function solo() {
  const record = { userId: 'owner', groupId: 'house', status: 'active', lastErrorCode: null, lastSuccessfulSyncAt: now - 600_000 };
  const checkpoint = { pendingCount: 0 };
  const roster = { body: { groupId: 'house', closed: false, members: [{ userId: 'owner', devices: [{ identity: { deviceId: 'device' } }] }] } };
  const tasks = { state: null }, calendar = { enabled: false };
  const workspace = { protocol: 2, userId: 'owner', groupId: 'house', identity: { deviceId: 'device' },
    record: async () => record, checkpoint: async () => checkpoint, roster: () => roster,
    googleTasks: async () => ({ readControl: async () => tasks }), googleCalendar: async () => ({ readControl: async () => calendar }) };
  return { workspace, record, checkpoint, roster, tasks, calendar };
}

test('solo idle polling defers only healthy empty single-device work until one hour without network requests', async () => {
  const { workspace, record } = solo();
  assert.equal(await sharedPeriodicSyncDue(workspace, now), false);
  assert.equal(await sharedPeriodicSyncDue(workspace, record.lastSuccessfulSyncAt + SOLO_SHARED_POLL_INTERVAL_MS - 1), false);
  assert.equal(await sharedPeriodicSyncDue(workspace, record.lastSuccessfulSyncAt + SOLO_SHARED_POLL_INTERVAL_MS), true);
  assert.equal(await sharedPeriodicSyncDue(workspace, record.lastSuccessfulSyncAt - 1), true, 'clock rollback cannot extend idle suppression');
});

test('solo polling keeps pending errors extra devices members and unknown state on the normal retry cadence', async () => {
  const changes = [
    f => { f.checkpoint.pendingCount = 1; }, f => { f.record.lastErrorCode = 'sharing/offline'; },
    f => { f.record.status = 'joining'; }, f => { f.record.status = 'creating'; },
    f => { f.record.lastSuccessfulSyncAt = null; }, f => { f.record.lastSuccessfulSyncAt = NaN; },
    f => { f.record.userId = 'other'; }, f => { f.record.groupId = 'other'; },
    f => { f.roster.body.closed = true; }, f => { f.roster.body.groupId = 'other'; },
    f => { f.roster.body.members.push({ userId: 'other', devices: [] }); },
    f => { f.roster.body.members[0].devices.push({ identity: { deviceId: 'other-device' } }); },
    f => { f.roster.body.members[0].devices[0].identity.deviceId = 'other'; },
    f => { f.roster.body.members[0].userId = 'other'; }, f => { f.workspace.protocol = null; },
    f => { f.workspace.record = async () => { throw new Error('synthetic storage error'); }; },
    f => { f.workspace.googleTasks = async () => { throw new Error('synthetic control error'); }; },
  ];
  for (const [index, change] of changes.entries()) { const fixture = solo(); change(fixture); assert.equal(await sharedPeriodicSyncDue(fixture.workspace, now), true, `normal retry case ${index}`); }
});

test('solo polling preserves Google-side change detection when shared Tasks or Calendar export is enabled', async () => {
  for (const kind of ['tasks', 'calendar']) {
    const f = solo();
    if (kind === 'tasks') f.tasks.state = { enabled: true, disconnected: false };
    else f.calendar.enabled = true;
    assert.equal(await sharedPeriodicSyncDue(f.workspace, now), true, kind);
  }
});
