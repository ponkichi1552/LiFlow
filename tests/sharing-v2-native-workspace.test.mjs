import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceHarness, createWorkspaceTestTimers } from './helpers/sharing-workspaces-harness.mjs';

import { withSharingLedgerTransaction } from '../src/platform/storage/sharing-ledger.ts';
import { readSharingWorkspace, updateSharingWorkspace } from '../src/platform/storage/sharing-registry.ts';
import { approveSharedDevice, upgradeSharedRoster, createSharedRoster } from '../src/features/sharing/roster.ts';
import { rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { encodeSharedInvitation } from '../src/features/sharing/invitations.ts';
import { signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
const { syncGoogleTasksWithDependencies } = await import('../src/features/google-sync/coordinator.ts');

for (const status of ['idle', 'retryPending', 'authRequired', 'syncing']) {
  test(`a delivered native group distinguishes a fresh Tasks cadence from ${status} deferred work`, async () => {
    const h = await workspaceHarness({ deferWorkspaceTimers: true });
    try {
      const workspace = await h.api.openSharedWorkspace(h.record);
      await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' }));
      await workspace.record(); h.vault.set('sharing-enabled', 'true');
      const now = new Date(); let saves = 0; let pendingReads = 0; let googleResult;
      const state = { householdId: 'shared-v2', enabled: true, disconnected: false, taskListId: 'test-list', status,
        lastSuccessfulSyncAt: new Date(now.getTime() - 60_000).toISOString(), lastAttemptAt: now.toISOString(),
        nextRetryAt: new Date(now.getTime() + 3_600_000).toISOString(), retryCount: 0, updatedAt: now.toISOString() };
      workspace.sync = async () => ({ complete: true, pending: 0, waitingForApproval: false });
      workspace.reminders = async () => ({ synchronize: async () => {} });
      workspace.maintainHistory = async () => {};
      workspace.googleCalendar = async () => ({ synchronize: async () => ({ kind: 'skipped' }) });
      workspace.googleTasks = async () => ({ readControl: async () => ({ state, revision: 1 }), synchronize: async () => {
        googleResult = await syncGoogleTasksWithDependencies({
          loadState: async () => state, saveState: async () => { saves++; },
          hasPendingLocalChanges: async () => { pendingReads++; return false; },
          getAccessToken: async () => { throw new Error('No Google authorization is needed before the cadence is due'); },
          api: new Proxy({}, { get() { throw new Error('No Google request is allowed before the cadence is due'); } }),
        }, { now });
        return googleResult;
      } });
      assert.deepEqual(await h.api.syncSharingWorkspace(), { kind: status === 'idle' ? 'success' : 'pending' });
      assert.equal(googleResult.skipped, true);
      assert.equal(saves, 0, 'classifying an existing cadence cannot write or resend changes');
      assert.equal(pendingReads, ['idle', 'syncing'].includes(status) ? 1 : 0);
    } finally { await h.close(); }
  });
}

for (const [flag, expected, name] of [[undefined, true, 'normal v2 workspace enables owner recovery by default without changing its stored events'],
  ['false', false, 'an explicit recovery opt-out reaches the native cloud and session without changing its stored events']]) test(name, async (t) => {
  const previous = process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY;
  t.after(() => { if (previous === undefined) delete process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY; else process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY = previous; });
  if (flag === undefined) delete process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY; else process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY = flag;
  const h = await workspaceHarness({ deferWorkspaceTimers: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    assert.equal(h.cloudOptions[0].ownerRecoveryEnabled, expected);
    assert.equal(workspace.session.recovery.enabled, expected);
    assert.equal((await workspace.checkpoint()).pendingCount, 39);
    assert.equal(h.calls.includes('legacy-open'), false);
  } finally { await h.close(); }
});

test('native v2 workspace factory chooses its isolated session and never registers a legacy planner adapter', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); assert.equal(workspace.protocol, 2);
    assert.equal('adapter' in workspace, false); assert.deepEqual(h.calls, [['v2-open', 'owner', h.record.groupId, undefined]]);
    const overview = await workspace.readOverview(); assert.equal(overview.timeZone, 'Asia/Tokyo'); assert.equal(overview.chores.length, 36);
    assert.equal(overview.members[0].displayName, '自分');
    assert.equal(h.handles[1].connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0, 'legacy materialized rows stay empty');
    assert.equal((await workspace.checkpoint()).pendingCount, 39);
    await h.api.saveSharingSelection(h.record); assert.deepEqual(JSON.parse(h.vault.get('active-workspace')), { userId: 'owner', groupId: h.record.groupId });
    h.auth.uid = 'other'; await assert.rejects(workspace.readOverview(), /切り替わり/u);
  } finally { await h.close(); }
});

test('a native singleton conflict adopts only the live confirmed locally known group and preserves both historical records', async () => {
  const retained = createDatabase(); const h = await workspaceHarness({ deferWorkspaceTimers: true,
    v2Database: scope => scope[1] === 'confirmed-native-group' ? retained.database : undefined });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await h.api.saveSharingSelection(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, row => ({ ...row, status: 'active' }));
    const anchor = createSharedRoster('confirmed-native-group', 'owner', h.owner, { schemaVersion: 2 });
    const confirmed = { ...h.record, status: 'active', groupId: anchor.body.groupId, anchor, rosterArchive: [anchor] };
    await createV2WorkspaceSession({ userId: 'owner', groupId: confirmed.groupId, database: retained.database, householdId: 'shared-v2', identity: h.identity, crypto, cloud: {},
      archive: () => [anchor], readRecord: async () => ({ ...confirmed, status: 'creating' }), creationKind: 'roommates', saveArchive: async () => {},
      readKey: async () => null, saveKey: async () => {}, serialized: work => work(), changed() {}, assertCurrentAccount() {}, assertWritable() {}, makeId: () => 'restored-op', markLeft: async () => {} });
    await h.index.database.runAsync('INSERT INTO sharing_workspaces VALUES (?, ?, ?)', 'owner', confirmed.groupId, JSON.stringify(confirmed));
    h.cloud.bindMembership = async () => { throw Object.assign(new Error('another group already bound'), { code: 'sharing/access-denied' }); };
    h.cloud.readMembership = async () => confirmed.groupId;
    await assert.rejects(workspace.sync({ force: true }), /another group/u);
    assert.equal((await h.api.currentSharingWorkspace()).groupId, confirmed.groupId);
    assert.equal((await h.api.readSharingSelection()).groupId, confirmed.groupId);
    assert.equal((await readSharingWorkspace(h.index.database, 'owner', h.record.groupId)).status, 'active');
    assert.equal((await workspace.checkpoint()).pendingCount, 39, 'old encrypted data and unsent operations are retained');
    await assert.rejects(workspace.readOverview(), /所属グループ/u);
    await assert.rejects((await workspace.googleTasks()).readControl(), /所属グループ/u);
  } finally { await h.close(); retained.connection.close(); }
});
test('a pending signed invitation never opens a guessed database or reads a group key before approval', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers, pending: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); assert.equal(workspace.protocol, null); assert.equal(workspace.database, null);
    assert.equal((await workspace.sync({ force: true })).waitingForApproval, true); assert.deepEqual(h.calls, ['join']);
    assert.equal(h.handles.length, 1); assert.equal(workspace.manager, null); assert.equal((await workspace.checkpoint()).pendingCount, 0);
    await assert.rejects(h.api.saveSharingSelection(h.record), /承認/u); assert.equal(h.vault.has('active-workspace'), false);
    assert.deepEqual((await readSharingWorkspace(h.index.database, 'member', h.record.groupId)).rosterArchive, []);
  } finally { await h.close(); }
});
test('a verified pending approval opens v2 only after discovery and does not activate an empty uninitialized group', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers, pending: true });
  try {
    const waiting = await h.api.openSharedWorkspace(h.record); const next = approveSharedDevice(h.initial, h.owner, 'member', h.identity);
    const metadata = { roster: next, group: { ...rosterCloudFields(next), headSequence: 0, lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 } };
    h.cloud.readGroup = async () => metadata; h.cloud.readRoster = async () => h.initial;
    // No business events are published in this deliberately incomplete transport fixture.
    h.cloud.pull = async () => ({ ...metadata, events: [], throughSequence: 0 }); h.groupKeys.set(2, new Uint8Array(32).fill(1));
    h.cloud.acknowledge = async () => {};
    const result = await waiting.sync({ force: true }); assert.equal(result.complete, false);
    assert.equal((await h.api.openSharedWorkspace(h.record)).protocol, 2);
    assert.equal(h.handles.length, 2); assert.equal(h.calls.includes('legacy-open'), false);
    assert.equal((await readSharingWorkspace(h.index.database, 'member', h.record.groupId)).status, 'joining');
    await assert.rejects(h.api.saveSharingSelection(h.record), /承認/u);
  } finally { await h.close(); }
});
test('pending protocol discovery stops an account switch before saving membership or opening any chore database', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers, pending: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    h.cloud.readGroup = async () => { h.auth.uid = 'other'; return { roster: h.initial }; };
    await assert.rejects(workspace.sync({ force: true }), /切り替わり/u);
    assert.equal(h.handles.length, 1); assert.deepEqual((await readSharingWorkspace(h.index.database, 'member', h.record.groupId)).rosterArchive, []);
  } finally { await h.close(); }
});
test('a departed v2 session cannot save new operations while all prior signed history remains stored', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, status: 'left' }));
    await workspace.record();
    await assert.rejects(workspace.session.repository.commit([{ operationId: 'forbidden', entityType: 'chore', entityId: 'x', operationType: 'patch', payload: { name: '変更' } }]));
    assert.equal((await workspace.checkpoint()).pendingCount, 39);
  } finally { await h.close(); }
});

for (const [change, name] of [
  ['removed', 'a queued v2 Native edit rechecks removal after authorization and preserves its old facts and outbox'],
  ['rejoin', 'a queued v2 Native edit cannot write an archived database after a fresh rejoin generation'],
]) test(name, async () => {
  const h = await workspaceHarness({ deferWorkspaceTimers: true }); let release;
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const chore = (await workspace.readOverview()).chores[0];
    const before = JSON.stringify(h.handles[1].connection.prepare('SELECT * FROM sharing_operations ORDER BY operation_id').all());
    let entered; const started = new Promise(done => { entered = done; }); const gate = new Promise(done => { release = done; });
    const holding = withSharingLedgerTransaction(workspace.database, async () => { entered(); await gate; }); await started;
    const saving = workspace.session.controller.actions.patchChore(chore.id, { name: '保存を待っている編集' });
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, record => ({ ...record, status: 'removed' }));
    if (change === 'rejoin') await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, record => ({ ...record,
      status: 'joining', localGeneration: 'fresh-approved-generation', archivedLocalGenerations: ['initial'] }));
    release(); await holding;
    await assert.rejects(saving, change === 'rejoin' ? /再参加前/u : /現在編集できません/u);
    assert.equal(JSON.stringify(h.handles[1].connection.prepare('SELECT * FROM sharing_operations ORDER BY operation_id').all()), before);
    assert.equal((await workspace.checkpoint()).pendingCount, 39);
  } finally { release?.(); await h.close(); }
});

test('a queued v2 Native read refuses group contents when membership was removed during its SQLite wait', async () => {
  const h = await workspaceHarness({ deferWorkspaceTimers: true }); let release;
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); let entered;
    const started = new Promise(done => { entered = done; }); const gate = new Promise(done => { release = done; });
    const holding = withSharingLedgerTransaction(workspace.database, async () => { entered(); await gate; }); await started;
    const reading = workspace.readOverview();
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, record => ({ ...record, status: 'removed' }));
    release(); await holding; await assert.rejects(reading, /現在編集できません/u);
    assert.equal((await workspace.checkpoint()).pendingCount, 39);
  } finally { release?.(); await h.close(); }
});

test('a queued v2 Native command rechecks a newly stored access error while its cached model remains readable', async () => {
  const h = await workspaceHarness({ deferWorkspaceTimers: true }); let release;
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const chore = (await workspace.readOverview()).chores[0]; let entered;
    const started = new Promise(done => { entered = done; }); const gate = new Promise(done => { release = done; });
    const holding = withSharingLedgerTransaction(workspace.database, async () => { entered(); await gate; }); await started;
    const saving = workspace.session.controller.actions.patchChore(chore.id, { name: '反映しない編集' });
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, record => ({ ...record, lastErrorCode: 'permission-denied' }));
    release(); await holding; await assert.rejects(saving, /参加状態を同期/u);
    assert.equal((await workspace.readOverview()).chores.find(item => item.id === chore.id).name, chore.name);
    assert.equal((await workspace.checkpoint()).pendingCount, 39);
  } finally { release?.(); await h.close(); }
});
test('v2 UI commands recheck a stored version or access failure while cached data remains readable and retry does not invent edits', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const chore = (await workspace.readOverview()).chores[0];
    for (const code of ['sharing/scheduler-version-mismatch', 'permission-denied']) {
      await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, lastErrorCode: code }));
      for (const command of Object.values(workspace.session.controller.actions)) await assert.rejects(command());
      assert.equal((await workspace.checkpoint()).pendingCount, 39); assert.equal((await workspace.readOverview()).chores.find((item) => item.id === chore.id).name, chore.name);
    }
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, lastErrorCode: null }));
    await workspace.session.controller.actions.patchChore(chore.id, { name: '所属を確認した後の変更' });
    assert.equal((await workspace.checkpoint()).pendingCount, 40);
    assert.equal((await workspace.readOverview()).chores.find((item) => item.id === chore.id).name, '所属を確認した後の変更');
  } finally { await h.close(); }
});
test('an unsupported signed protocol during invitation discovery preserves the pin and never opens a database or reads a key', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers, pending: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const approved = approveSharedDevice(h.initial, h.owner, 'member', h.identity);
    const body = { ...approved.body, schedulerVersion: 'future-v2-unsupported' };
    const future = { body, signer: approved.signer, signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, h.owner) };
    h.cloud.readGroup = async () => ({ roster: future }); h.cloud.readRoster = async () => h.initial;
    await assert.rejects(workspace.sync({ force: true }), { code: 'sharing/scheduler-version-mismatch' });
    assert.equal(h.handles.length, 1); assert.equal(h.calls.includes('read-key'), false);
    const record = await readSharingWorkspace(h.index.database, 'member', h.record.groupId);
    assert.deepEqual(record.anchor, h.record.anchor); assert.deepEqual(record.rosterArchive, []);
  } finally { await h.close(); }
});

test('normal workspace dispatch refuses an unprepared v1 upgrade before opening either database format', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers, version: 1 });
  try {
    const upgraded = upgradeSharedRoster(h.initial, h.owner);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, rosterArchive: [h.initial, upgraded] }));
    await assert.rejects(h.api.openSharedWorkspace(h.record), { code: 'sharing/v2-migration-required' });
    assert.equal(h.handles.length, 1); assert.deepEqual(h.calls, []);
    const record = await readSharingWorkspace(h.index.database, 'owner', h.record.groupId); assert.deepEqual(record.anchor, h.initial);
  } finally { await h.close(); }
});

test('normal v2 workspace commits refresh its local reminders and retain the real account and group guard', async (t) => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    const chore = (await workspace.readOverview()).chores[0]; await workspace.session.controller.actions.patchChore(chore.id, { name: '通知経路の検査用' });
    for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(h.reminderCalls.filter(value => value === 'factory').length, 1); assert.ok(h.reminderCalls.includes('sync'));
    const runtime = await workspace.reminders(); assert.equal((await runtime.store.read()).preferences.enabled, false);
    assert.equal(h.reminderCalls.includes('permission'), false); assert.equal('adapter' in workspace, false);
    h.auth.uid = 'other'; await assert.rejects(runtime.synchronize(), /切り替わり/u);
    assert.equal(h.handles[1].connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally { await h.close(); }
});

test('a bounded v2 worker does not launch an independent notification pass after its cloud budget expires', async (t) => {
  const timers = createWorkspaceTestTimers(); const previousNow = Date.now; let now = previousNow();
  Date.now = () => now;
  let reads = 0;
  const h = await workspaceHarness({ workspaceTimers: timers, cloud: { readGroup: async () => { reads++; now += 30_000; throw new Error('cloud unavailable after deadline'); } } });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    const attempts = Array.from({ length: 100 }, () => workspace.sync({ budgetMs: 1_000 }));
    assert.equal(new Set(attempts).size, 1); await assert.rejects(attempts[0], /cloud unavailable/u);
    for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(h.reminderCalls.includes('factory'), false, 'the coordinator owns the remaining worker budget');
    assert.equal(h.reminderCalls.includes('sync'), false);
    assert.equal(h.taskCalls.length, 0);
    timers.tick(1_000); for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(reads, 1, 'coalesced worker requests retain their original deadline after the first pass');
  } finally { Date.now = previousNow; await h.close(); }
});
test('coalesced foreground sync callers run one history maintenance pass while a later fresh sync still maintains history', async () => {
  let h, release; let runs = 0, compactions = 0;
  h = await workspaceHarness({ deferWorkspaceTimers: true,
    historyRuntime: { createV2HistoryRetentionRuntime: () => ({ run: async () => { runs++; } }) },
    cloud: { readGroup: async () => ({ roster: h.initial, group: { ...rosterCloudFields(h.initial), id: h.record.groupId, headSequence: 0, snapshotThroughSequence: 0 } }),
      compactHistory: async () => { compactions++; } },
  });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    let gate = new Promise(done => { release = done; });
    workspace.session.synchronizer.sync = async () => { await gate; return { waitingForApproval: false, complete: true }; };
    const attempts = Array.from({ length: 50 }, () => workspace.sync()); assert.equal(new Set(attempts).size, 1);
    release(); await Promise.all(attempts);
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    assert.equal(runs, 1); assert.equal(compactions, 1, 'coalesced callers must not multiply network cleanup');
    gate = Promise.resolve(); await workspace.sync();
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    assert.equal(runs, 2); assert.equal(compactions, 2, 'a fresh cloud result gets a fresh maintenance pass');
  } finally { await h.close(); }
});

test('disconnecting a legacy Google workspace preserves a paused v2 connection on the same Native account', async t => {
  const timers = createWorkspaceTestTimers(); const h = await workspaceHarness({ workspaceTimers: timers });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    h.vault.set('sharing-enabled', 'true'); h.taskControl.state = { enabled: false, disconnected: false, accountSubject: 'synthetic-google' };
    assert.equal(await h.api.hasOtherGoogleWorkspaceConnections({}), true);
    h.taskControl.state.disconnected = true; assert.equal(await h.api.hasOtherGoogleWorkspaceConnections({}), false);
    assert.equal(h.calls.includes('legacy-open'), false);
  } finally { await h.close(); }
});

test('loading the v2 Tasks runtime consumes the original worker budget before any Google synchronization starts', async t => {
  const timers = createWorkspaceTestTimers(); const previous = Date.now; let now = previous(); Date.now = () => now;
  const h = await workspaceHarness({ workspaceTimers: timers });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    h.vault.set('sharing-enabled', 'true'); let syncs = 0;
    workspace.sync = async () => ({}); workspace.maintainHistory = async () => {};
    workspace.reminders = async () => ({ synchronize: async () => {} });
    workspace.googleTasks = async () => { now += 30_000; return { synchronize: async () => { syncs++; } }; };
    await h.api.syncSharingWorkspace(20_000); assert.equal(syncs, 0);
  } finally { Date.now = previous; await h.close(); }
});

test('the shared worker completes group delivery without starting an unconfigured paused or disconnected optional Tasks sync', async t => {
  for (const state of [null, { enabled: false, disconnected: false }, { enabled: false, disconnected: true }]) {
    await t.test(state === null ? 'unconfigured' : state.disconnected ? 'disconnected' : 'paused', async () => {
      const h = await workspaceHarness({ deferWorkspaceTimers: true });
      try {
        const workspace = await h.api.openSharedWorkspace(h.record);
        await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
        h.vault.set('sharing-enabled', 'true'); let taskSyncs = 0;
        workspace.sync = async () => ({ complete: true, pending: 0, waitingForApproval: false });
        workspace.reminders = async () => ({ synchronize: async () => {} });
        workspace.maintainHistory = async () => {};
        workspace.googleTasks = async () => ({ readControl: async () => ({ state, revision: 1 }),
          synchronize: async () => { taskSyncs++; return { kind: 'success', skipped: true }; } });
        workspace.googleCalendar = async () => ({ synchronize: async () => ({ kind: 'skipped' }) });
        assert.deepEqual(await h.api.syncSharingWorkspace(), { kind: 'success' });
        assert.equal(taskSyncs, 0, 'an optional disabled integration must not create work or mark delivered group changes pending');
      } finally { await h.close(); }
    });
  }
});

for (const failure of ['shared', 'reminders', 'google-throw', 'retry', 'authRequired', 'error', 'success']) {
  test(`the native v2 worker preserves the ${failure} result and still attempts independent integration phases`, async () => {
    const h = await workspaceHarness({ deferWorkspaceTimers: true });
    try {
      const workspace = await h.api.openSharedWorkspace(h.record);
      await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
      h.vault.set('sharing-enabled', 'true'); const calls = [];
      workspace.sync = async () => { calls.push('shared'); if (failure === 'shared') throw new Error('synthetic shared failure'); return {}; };
      workspace.maintainHistory = async () => { calls.push('history'); };
      workspace.reminders = async () => ({ synchronize: async () => { calls.push('reminders'); if (failure === 'reminders') throw new Error('synthetic reminder failure'); } });
      workspace.googleTasks = async () => ({ readControl: async () => ({ state: { enabled: true, disconnected: false } }), synchronize: async () => {
        calls.push('google'); if (failure === 'google-throw') throw new Error('synthetic Google failure');
        return { kind: ['retry', 'authRequired', 'error'].includes(failure) ? failure : 'success', code: 'synthetic', skipped: failure === 'success' };
      } });
      if (failure === 'success') await h.api.syncSharingWorkspace();
      else await assert.rejects(h.api.syncSharingWorkspace());
      assert.deepEqual(calls, ['shared', 'reminders', 'google', 'history'], 'deliver changes before optional history maintenance');
    } finally { await h.close(); }
  });
}

test('a local commit during a bounded v2 sync cannot escape the worker through its debounce callback', async (t) => {
  const timers = createWorkspaceTestTimers(); const previousNow = Date.now; let now = previousNow();
  Date.now = () => now; let workspace; let choreId; let reads = 0;
  const h = await workspaceHarness({ workspaceTimers: timers, cloud: { readGroup: async () => {
    reads++; await workspace.session.controller.actions.patchChore(choreId, { name: 'worker中の保存' });
    now += 30_000; throw new Error('cloud unavailable after commit');
  } } });
  try {
    workspace = await h.api.openSharedWorkspace(h.record); choreId = (await workspace.readOverview()).chores[0].id;
    await assert.rejects(workspace.sync({ budgetMs: 1_000 }), /cloud unavailable/u);
    timers.tick(1_000); for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(reads, 1); assert.equal(h.reminderCalls.includes('factory'), false);
    assert.equal((await workspace.readOverview()).chores.find(row => row.id === choreId).name, 'worker中の保存', 'the local edit stays durable for the next sync');
  } finally { Date.now = previousNow; await h.close(); }
});

test('a removed native workspace preserves its history and requests a fresh generation without serializing an undefined migration pin', async () => {
  const h = await workspaceHarness({ pending: true, deferWorkspaceTimers: true });
  try {
    await updateSharingWorkspace(h.index.database, h.record.userId, h.record.groupId, record => ({ ...record, status: 'removed',
      v2Migration: { databaseGeneration: 'prior-conversion', sourceSnapshotDigest: 'a'.repeat(64), witnessDigest: 'b'.repeat(64) } }));
    const workspace = await h.api.requestSharingWorkspace(encodeSharedInvitation(h.link));
    assert.equal(workspace.protocol, null);
    const stored = await readSharingWorkspace(h.index.database, h.record.userId, h.record.groupId);
    assert.equal(stored.status, 'joining'); assert.ok(stored.localGeneration); assert.deepEqual(stored.archivedLocalGenerations, ['initial']);
    assert.equal('v2Migration' in stored, false); assert.deepEqual(stored.anchor, h.record.anchor);
    assert.equal(h.calls.includes('legacy-open'), false); assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'v2-open'), false);
  } finally { await h.close(); }
});

test('a rejected cross-device creation releases its local membership slot without deleting unsent edits', async () => {
  const h = await workspaceHarness({ deferWorkspaceTimers: true, cloud: {
    createGroup: async () => { throw Object.assign(new Error('held elsewhere'), { code: 'permission-denied' }); },
    readMembership: async () => 'other-device-house',
  } });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const before = await workspace.checkpoint();
    await assert.rejects(workspace.sync({ force: true, budgetMs: 20_000 }), /別の端末/);
    assert.equal(await h.api.currentSharingWorkspace(), null);
    assert.equal((await readSharingWorkspace(h.index.database, h.record.userId, h.record.groupId)).status, 'removed');
    const after = await h.index.database.getAllAsync('SELECT record_json FROM sharing_workspaces');
    assert.equal(after.length, 1); assert.ok(before.pendingCount > 0);
    await assert.rejects(h.api.openSharedWorkspace(h.record), /現在所属/);
  } finally { await h.close(); }
});

for (const creating of [false, true]) test(`membership ${creating ? 'creation' : 'adoption'} consumes the original worker budget and cannot start a fresh synchronization interval`, async () => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const h = await workspaceHarness({ deferWorkspaceTimers: true, cloud: {
    bindMembership: async () => { now += 30_000; }, createGroup: async () => { now += 30_000; },
  } });
  try {
    if (!creating) await updateSharingWorkspace(h.index.database, h.record.userId, h.record.groupId, row => ({ ...row, status: 'active' }));
    const workspace = await h.api.openSharedWorkspace(h.record); let syncs = 0;
    const before = await workspace.checkpoint();
    workspace.session.synchronizer.sync = async () => { syncs++; return { complete: true }; };
    await assert.rejects(workspace.sync({ force: true, budgetMs: 20_000 }), /同期時間を使い切り/);
    assert.equal(syncs, 0); assert.equal((await workspace.checkpoint()).pendingCount, before.pendingCount);
  } finally { await h.close(); Date.now = originalNow; }
});

test('a member-profile upload reuses only the original worker time left and preserves its committed outbox entry', async () => {
  const previous = Date.now; let now = previous(); Date.now = () => now;
  const h = await workspaceHarness({ deferWorkspaceTimers: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const budgets = [];
    workspace.session.synchronizer.sync = async options => { budgets.push(options.budgetMs); if (budgets.length === 1) now += 16_000; return { complete: true }; };
    const repository = workspace.session.repository;
    repository.commitCurrent = async () => { now += 3000; return repository.commit([{ operationId: 'member-profile-budget', entityType: 'member', entityId: h.record.userId,
      operationType: 'patch', payload: { userId: h.record.userId, displayName: '同期時間の検査' } }]); };
    const before = await workspace.checkpoint(); await workspace.sync({ budgetMs: 20_000 });
    assert.deepEqual(budgets, [20_000, 1000]);
    assert.equal((await workspace.checkpoint()).pendingCount, before.pendingCount + 1, 'terminal cloud timing never discards a durable edit');
  } finally { Date.now = previous; await h.close(); }
});

test('loading the shared Calendar runtime cannot restart the exhausted OS-worker budget', async () => {
  const previous = Date.now; let now = previous(); Date.now = () => now;
  const h = await workspaceHarness({ deferWorkspaceTimers: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    h.vault.set('sharing-enabled', 'true'); let syncs = 0; let history = 0;
    workspace.sync = async () => ({}); workspace.maintainHistory = async () => { history++; };
    workspace.reminders = async () => ({ synchronize: async () => {} });
    workspace.googleTasks = async () => ({ readControl: async () => ({ state: { enabled: true, disconnected: false } }), synchronize: async () => ({ kind: 'success' }) });
    workspace.googleCalendar = async () => { now += 30_000; return { synchronize: async () => { syncs++; } }; };
    await h.api.syncSharingWorkspace(20_000); assert.equal(syncs, 0); assert.equal(history, 0);
  } finally { Date.now = previous; await h.close(); }
});

for (const mode of ['known', 'unknown', 'departed', 'account-switch', 'offline']) test(`ambiguous legacy group recovery ${mode} keeps archived rows and trusts only the current same-account membership`, async () => {
  const h = await workspaceHarness({ deferWorkspaceTimers: true }); let remoteReads = 0;
  try {
    const otherRoster = createSharedRoster('old-qa-group', 'owner', h.owner, { schemaVersion: 2 });
    const other = { ...h.record, groupId: 'old-qa-group', status: 'active', anchor: otherRoster, rosterArchive: [otherRoster] };
    const departedRoster = createSharedRoster('departed-qa-group', 'owner', h.owner, { schemaVersion: 2 });
    const departed = { ...h.record, groupId: 'departed-qa-group', status: 'left', anchor: departedRoster, rosterArchive: [departedRoster] };
    for (const row of [other, departed]) await h.index.database.runAsync('INSERT INTO sharing_workspaces(user_id,group_id,record_json) VALUES (?,?,?)', row.userId, row.groupId, JSON.stringify(row));
    await h.index.database.runAsync('DELETE FROM sharing_current_workspace');
    const before = JSON.stringify(h.index.connection.prepare('SELECT record_json FROM sharing_workspaces ORDER BY group_id').all());
    h.cloud.readMembership = async () => {
      remoteReads++; if (mode === 'offline') throw Object.assign(new Error('offline'), { code: 'unavailable' });
      if (mode === 'account-switch') h.auth.uid = 'other';
      return mode === 'unknown' ? 'unrecognized-group' : mode === 'departed' ? departed.groupId : h.record.groupId;
    };
    if (mode === 'known') {
      assert.equal((await h.api.currentSharingWorkspace()).groupId, h.record.groupId);
      assert.equal((await h.api.currentSharingWorkspace()).groupId, h.record.groupId);
      assert.equal(remoteReads, 1, 'normal reads after adoption need no Cloud request');
    } else {
      await assert.rejects(h.api.currentSharingWorkspace(), mode === 'account-switch' ? /変わりました/ : mode === 'offline' ? /offline/ : /保存データは保持/);
      assert.equal(h.index.connection.prepare('SELECT count(*) AS n FROM sharing_current_workspace').get().n, 0);
    }
    assert.equal(JSON.stringify(h.index.connection.prepare('SELECT record_json FROM sharing_workspaces ORDER BY group_id').all()), before);
  } finally { await h.close(); }
});
