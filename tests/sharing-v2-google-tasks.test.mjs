import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { seeds, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GoogleTaskStore } from '../src/platform/storage/sharing-v2-google-tasks.ts';
import { createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { loadSharedFacts, applyReceivedSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { sharedGoogleNamespace, sharedGoogleOccurrenceNote } from '../src/features/google-sync/workspace-policy.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';

const ref = item => item.target;
const count = h => h.d.connection.prepare('SELECT COUNT(*) AS n FROM sharing_operations').get().n;
function mapEntriesPort(port, transform) {
  return { ...port,
    listEntriesForGoogleSync: async (...args) => (await port.listEntriesForGoogleSync(...args)).map(transform),
    readLocalStatusSnapshot: async (...args) => {
      const value = await port.readLocalStatusSnapshot(...args); return { ...value, entries: value.entries.map(transform) };
    },
  };
}
function firstRemote(h) { return [...h.tasks.values()].find(task => !task.deleted); }
function firstItem(h) { return h.entries().then(rows => rows.find(row => row.entry.choreId === 'floor' && row.entry.cycleBaseDate === '2026-10-27')); }

test('v2 Google bindings default unconfigured, use separate private tables, and reject a different owner or workspace', async () => {
  const h = await googleFixture();
  try {
    assert.deepEqual(await h.store.readControl(), { revision: 0, label: null, state: null });
    assert.notEqual(h.namespace, sharedGoogleNamespace('owner', groupId));
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
    assert.throws(() => createV2GoogleTaskStore({ ...h.scope, userId: 'member' }), /保存先/u);
    await assert.rejects(h.store.port.listGoogleTaskLinks('personal'), /作業領域/u);
    await assert.rejects(h.store.port.listEntriesForGoogleSync('2026-10-27', 'personal'), /作業領域/u);
    assert.equal(h.tasks.size, 0);
  } finally { h.close(); }
});

test('v2 Google connection guards and private receipts do not replay business history or repeat schema setup but still refuse revoked access', async () => {
  const h = await googleFixture(); let schemaCalls = 0; let businessReads = 0;
  try {
    const store = createV2GoogleTaskStore({ ...h.scope, repository: { ...h.d.repository,
      readCurrent: async () => { businessReads++; throw new Error('authenticated business read required'); },
      withPrivateStorage: work => h.d.repository.withPrivateStorage(transaction => work(new Proxy(transaction, { get(target, key) {
        if (key === 'execAsync') return async sql => { if (/CREATE TABLE/iu.test(sql)) schemaCalls++; return target.execAsync(sql); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }))),
    } });
    assert.equal((await store.readControl()).revision, 0); const initialSchemas = schemaCalls; assert.ok(initialSchemas > 0);
    const control = await store.configure(0, { subject: 'synthetic-google-subject', label: '検査用' }, true);
    for (let index = 0; index < 30; index++) assert.equal((await store.readControl()).revision, control.revision);
    await store.saveSyncState({ ...control.state, status: 'retryPending', lastErrorCode: 'network_error' }, control.revision);
    assert.equal((await store.readControl()).state.lastErrorCode, 'network_error');
    assert.deepEqual(await store.readSavedLinks(), []);
    assert.equal(schemaCalls, initialSchemas); assert.equal(businessReads, 0);
    await assert.rejects(store.port.listEntriesForGoogleSync('2026-10-27', h.namespace), /authenticated business read/u);
    assert.equal(businessReads, 1);
    h.stop(); await assert.rejects(store.readControl(), /account changed/u);
    await assert.rejects(store.saveSyncState(control.state, control.revision), /account changed/u);
  } finally { h.close(); }
});

test('v2 Google private schema readiness is not retained after its first transaction rolls back', async () => {
  const h = await googleFixture(); let fail = true;
  try {
    const store = createV2GoogleTaskStore({ ...h.scope, repository: { ...h.d.repository,
      withPrivateStorage: work => h.d.repository.withPrivateStorage(async transaction => {
        const value = await work(transaction); if (fail) { fail = false; throw new Error('injected private commit failure'); } return value;
      }),
    } });
    await assert.rejects(store.readControl(), /injected private commit/u);
    assert.equal(h.d.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sharing_v2_private_google_control'").get().n, 0);
    assert.deepEqual(await store.readControl(), { revision: 0, label: null, state: null });
  } finally { h.close(); }
});

test('v2 private Google state rolls back when access is revoked after its SQL update', async () => {
  const h = await googleFixture(); let revoke = false;
  try {
    const store = createV2GoogleTaskStore({ ...h.scope, repository: { ...h.d.repository,
      withPrivateStorage: work => h.d.repository.withPrivateStorage(transaction => work(new Proxy(transaction, { get(target, key) {
        if (key === 'runAsync') return async (sql, ...args) => { const value = await target.runAsync(sql, ...args);
          if (revoke && /UPDATE sharing_v2_private_google_control/u.test(sql)) h.stop(); return value; };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }))),
    } });
    const control = await store.configure(0, { subject: 'synthetic-google-subject', label: '検査用' }, true);
    const before = h.d.connection.prepare('SELECT state_json FROM sharing_v2_private_google_control').get().state_json;
    revoke = true;
    await assert.rejects(store.saveSyncState({ ...control.state, status: 'retryPending', lastErrorCode: 'network_error' }, control.revision), /account changed/u);
    assert.equal(h.d.connection.prepare('SELECT state_json FROM sharing_v2_private_google_control').get().state_json, before);
  } finally { h.close(); }
});

test('v2 Tasks imports a Google completion as the authenticated owner and targeted undo without leaking mappings', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    const remote = h.tasks.get(link.googleTaskId); remote.status = 'completed'; remote.completed = '2026-10-27T00:30:00Z';
    assert.equal((await h.sync()).imported, 1);
    const done = (await loadSharedFacts(h.d.database, groupId)).find(row => row.operation.entityType === 'completion').operation;
    assert.equal(done.authorUserId, 'owner'); assert.equal(done.payload.completedByMemberId, 'owner'); assert.equal(done.payload.completedAt, '2026-10-27T00:30:00.000Z');
    assert.equal(done.entityId, item.entry.id); assert.ok((await listSharingOutbox(h.d.database, groupId)).some(row => row.operation.operationId === done.operationId));
    remote.status = 'needsAction'; remote.completed = null; assert.equal((await h.sync()).imported, 1);
    const undo = (await loadSharedFacts(h.d.database, groupId)).find(row => row.operation.operationType === 'undo').operation;
    assert.equal(undo.payload.targetOperationId, done.operationId); assert.equal((await firstItem(h)).completedAt, undefined);
    const shared = JSON.stringify(await loadSharedFacts(h.d.database, groupId));
    for (const secret of ['synthetic-google-subject', link.googleTaskId, link.googleTaskListId, 'synthetic-token']) assert.equal(shared.includes(secret), false);
    assert.equal((await h.sync()).imported, 0); assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).pendingStatus, undefined);
  } finally { h.close(); }
});

test('v2 in-app completion and undo update the same Google task in both directions', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    const [done] = await h.actions.complete(ref(item)); await h.sync(); assert.equal(h.tasks.get(link.googleTaskId).status, 'completed');
    await h.actions.undo(done.operationId); await h.sync(); assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction');
    assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).googleTaskId, link.googleTaskId);
    assert.equal(h.calls.filter(row => row[0] === 'create').length, 3);
  } finally { h.close(); }
});

test('v2 formal date changes keep the original common occurrence and Google ID while updating only its due date', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); const before = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    await h.actions.changeDate(ref(item), { mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
    h.calls.length = 0; await h.sync(); const after = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(after.googleTaskId, before.googleTaskId); assert.equal(h.tasks.get(after.googleTaskId).due, '2026-10-28T00:00:00.000Z');
    assert.ok(h.calls.some(row => row[0] === 'patch' && row[1] === after.googleTaskId && Object.keys(row[2]).join(',') === 'due'));
    assert.equal(h.calls.some(row => row[0] === 'create'), false);
  } finally { h.close(); }
});

test('v2 local completion during Google read cannot be silently undone by the older remote status', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    h.hooks.beforeRead = async () => { delete h.hooks.beforeRead; await h.actions.complete(ref(item)); };
    await h.sync(); assert.ok((await firstItem(h)).completedAt); assert.equal(h.tasks.get(link.googleTaskId).status, 'completed');
  } finally { h.close(); }
});

test('v2 acknowledgement of an old PATCH preserves a new local undo revision until that undo reaches Google', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); const [done] = await h.actions.complete(ref(item));
    h.hooks.afterPatch = async () => { delete h.hooks.afterPatch; await h.actions.undo(done.operationId); };
    await h.sync(); const pending = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(pending.pendingStatus, 'needsAction'); assert.ok(pending.pendingStatusRevision); assert.equal((await firstItem(h)).completedAt, undefined);
    await h.sync(); assert.equal(h.tasks.get(pending.googleTaskId).status, 'needsAction');
    assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).pendingStatus, undefined);
  } finally { h.close(); }
});

test('v2 remote task deletion never becomes an undo and preserves completed shared history', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); await h.actions.complete(ref(item)); await h.sync();
    const before = count(h); const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id); h.tasks.get(link.googleTaskId).deleted = true;
    await h.sync(); assert.ok((await firstItem(h)).completedAt); assert.equal(count(h), before);
    assert.equal((await h.links()).some(row => row.googleTaskId === link.googleTaskId), true, 'retain a durable deletion receipt');
    for (let pass = 0; pass < 3; pass++) assert.equal((await h.sync()).created, 0);
    const restarted = createV2GoogleTaskStore({ ...h.scope, repository: createV2EventRepository(h.d.database, h.d.options) });
    assert.equal((await h.sync(restarted.port)).created, 0);
    assert.equal([...h.tasks.values()].filter(task => !task.deleted && task.notes === h.tasks.get(link.googleTaskId).notes).length, 0);
    const done = (await loadSharedFacts(h.d.database, groupId)).find(row => row.operation.entityType === 'completion');
    await h.actions.undo(done.operation.operationId);
    assert.equal((await h.sync()).created, 1, 'a new explicit undo can recreate the now incomplete task');
  } finally { h.close(); }
});

for (const batch of [false, true]) test(`a title-only Tasks update preserves an unimported remote undo with ${batch ? 'batch' : 'individual'} HTTP and real signed SQLite history`, async t => {
  const h = await googleFixture(); t.after(() => h.close());
  if (!batch) h.api.patchTasksBatch = undefined;
  await h.connect(); await h.sync(); const item = await firstItem(h); await h.actions.complete(ref(item)); await h.sync();
  const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
  const port = mapEntriesPort(h.store.port, row => row.entry.id === item.entry.id ? { ...row, choreName: '名前だけ変更' } : row);
  h.hooks.afterPatch = async (id, patch) => {
    if (id !== link.googleTaskId || Object.keys(patch).join(',') !== 'title') return;
    delete h.hooks.afterPatch; h.tasks.get(id).status = 'needsAction'; h.tasks.get(id).completed = null;
  };
  assert.equal((await h.sync(port)).imported, 0);
  assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).lastSyncedStatus, 'completed');
  assert.ok((await firstItem(h)).completedAt);
  assert.equal((await h.sync(port)).imported, 1); assert.equal((await firstItem(h)).completedAt, undefined);
  assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction');
  assert.equal((await loadSharedFacts(h.d.database, groupId)).filter(row => row.operation.operationType === 'undo').length, 1);
});

test('v2 a lost Google creation reply adopts the exact opaque occurrence note without duplicate tasks', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); h.hooks.afterCreate = async () => { delete h.hooks.afterCreate; throw new Error('reply lost'); };
    await assert.rejects(h.sync(), /reply lost/u); const ids = [...h.tasks.keys()]; assert.equal(ids.length, 3);
    assert.equal((await h.links()).length, 0); await h.sync(); assert.deepEqual([...h.tasks.keys()], ids);
    for (const link of await h.links()) assert.equal(h.tasks.get(link.googleTaskId).notes, sharedGoogleOccurrenceNote(h.namespace, link.scheduleEntryId));
  } finally { h.close(); }
});

test('v2 unresolved task rows freeze Google reads and writes while independent rows continue syncing', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const item = await firstItem(h); const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    h.tasks.get(link.googleTaskId).status = 'completed'; h.tasks.get(link.googleTaskId).completed = '2026-10-27T00:30:00Z'; const before = count(h); h.calls.length = 0;
    await h.sync(mapEntriesPort(h.store.port, row => row.entry.id === item.entry.id ? { ...row, synchronizationBlocked: true } : { ...row, choreName: '独立した変更' }));
    assert.equal(count(h), before); assert.equal(h.calls.some(row => ['patch', 'delete'].includes(row[0]) && row[1] === link.googleTaskId), false);
    assert.ok(h.calls.some(row => row[0] === 'patch' && row[1] !== link.googleTaskId));
  } finally { h.close(); }
});

test('v2 private Google binding and signed completion roll back together if a private metadata write fails', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const remote = firstRemote(h); remote.status = 'completed'; remote.completed = '2026-10-27T00:30:00Z';
    const before = count(h); const run = h.d.database.runAsync; let injected = false;
    h.d.database.runAsync = async (sql, ...args) => { const value = await run(sql, ...args); if (!injected && sql.includes('INSERT INTO sharing_v2_private_google_links') && String(args[1]).includes('"lastSyncedStatus":"completed"')) { injected = true; throw new Error('private write failed after write'); } return value; };
    await assert.rejects(h.sync(), /private write failed/u); assert.equal(injected, true); assert.equal(count(h), before);
    h.d.database.runAsync = run; assert.equal((await h.sync()).imported, 1); assert.equal(count(h), before + 1);
  } finally { h.close(); }
});

test('v2 private mappings survive repository recreation and old sync state cannot re-enable a paused connection', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const original = await h.links(); const control = await h.store.readControl();
    const repository = createV2EventRepository(h.d.database, h.d.options); const restarted = createV2GoogleTaskStore({ ...h.scope, repository });
    assert.deepEqual(await restarted.port.listGoogleTaskLinks(h.namespace), original);
    await restarted.configure(control.revision, { subject: control.state.accountSubject, label: control.label }, false);
    await assert.rejects(h.store.saveSyncState({ ...control.state, lastSuccessfulSyncAt: now().toISOString() }, control.revision), /古い同期結果/u);
    assert.equal((await h.store.readControl()).state.enabled, false);
    await assert.rejects(restarted.configure(control.revision + 1, { subject: 'other-google', label: '別アカウント' }, true), { code: 'google_account_mismatch' });
    assert.deepEqual(await restarted.port.listGoogleTaskLinks(h.namespace), original);
  } finally { h.close(); }
});

test('v2 Google undo targets only this owner’s acknowledged completions and cannot erase another member’s work', async () => {
  const h = await googleFixture(); const member = await h.family.device('member', h.family.member);
  try {
    await h.connect(); await h.sync(); const initial = await loadSharedFacts(h.d.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, initial, '4', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(initial)));
    const item = await firstItem(h); const actions = createV2PlannerActions(member.repository, { makeId: () => 'member-completion', now });
    await actions.complete(ref(item)); const facts = await loadSharedFacts(member.database, groupId);
    await applyReceivedSharedFacts(h.d.database, groupId, facts, '5', h.d.repository.project, null, now().getTime(), h.d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    await h.sync(); const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id); const remote = h.tasks.get(link.googleTaskId);
    assert.equal(remote.status, 'completed'); remote.status = 'needsAction'; remote.completed = null;
    assert.equal((await h.sync()).imported, 0); assert.ok((await firstItem(h)).completedAt); assert.equal(remote.status, 'completed');
    assert.equal((await loadSharedFacts(h.d.database, groupId)).some(row => row.operation.operationType === 'undo'), false);
  } finally { h.close(); member.connection.close(); }
});

test('v2 hundreds of daily Tasks are restricted to the rolling window and every native batch stays at most100', async () => {
  const seed = seeds().slice(0, 2);
  for (let i = 0; i < 15; i++) seed.push({ ...seeds()[2], operationId: `chore-${i}`, entityId: `daily-${i}`, payload: { name: `合成家事${i}`, enabled: true } },
    { ...seeds()[3], operationId: `config-${i}`, entityId: `daily-${i}`, payload: { configuration: { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27', intervalDays: 1, windowBeforeDays: 0, windowAfterDays: 0, ruleVersion: 1 } } });
  const h = await googleFixture({ seed });
  try {
    await h.connect(); const result = await h.sync(); assert.equal(result.created, 225);
    assert.deepEqual(h.calls.filter(row => row[0] === 'create-batch').map(row => row[1]), [100, 100, 25]);
    assert.ok([...h.tasks.values()].every(task => task.due.slice(0, 10) >= '2026-10-27' && task.due.slice(0, 10) <= '2026-11-10'));
    h.calls.length = 0; await h.sync(); assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test('v2 private Google state rejects credential fields instead of accepting unknown persisted properties', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); const before = await h.store.readControl();
    await assert.rejects(h.store.saveSyncState({ ...before.state, accessToken: 'synthetic-sensitive-value' }, before.revision), /形式/u);
    assert.deepEqual(await h.store.readControl(), before);
  } finally { h.close(); }
});

test('v2 Tasks keeps completed personal recommendations synchronizable in both directions', async () => {
  const h = await googleFixture();
  const store = createV2GoogleTaskStore({ ...h.scope, personalize: plan => buildV2PersonalPlan(plan, {
    viewerUserId: 'owner', now: now().getTime(), settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } },
  }) });
  const entries = () => store.port.listEntriesForGoogleSync('2026-10-27', h.namespace);
  try {
    await h.connect(); await h.sync(store.port); const item = (await entries())[0];
    const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    const [done] = await h.actions.complete(ref(item)); await h.sync(store.port);
    assert.equal(h.tasks.get(link.googleTaskId).status, 'completed');
    assert.equal((await entries()).find(row => row.entry.id === item.entry.id).synchronizationBlocked, undefined);
    await h.actions.undo(done.operationId); await h.sync(store.port); assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction');
    const remote = h.tasks.get(link.googleTaskId); remote.status = 'completed'; remote.completed = '2026-10-27T00:30:00Z';
    assert.equal((await h.sync(store.port)).imported, 1);
    remote.status = 'needsAction'; remote.completed = null;
    assert.equal((await h.sync(store.port)).imported, 1);
    assert.equal((await entries()).find(row => row.entry.id === item.entry.id).completedAt, undefined);
    assert.equal((await h.links()).find(row => row.scheduleEntryId === item.entry.id).googleTaskId, link.googleTaskId);
  } finally { h.close(); }
});

test('v2 Tasks never persists unknown link fields or exposes poisoned private records', async () => {
  const h = await googleFixture();
  try {
    await h.connect(); await h.sync(); const [link] = await h.links();
    await assert.rejects(h.store.port.upsertGoogleTaskLink({ ...link, accessToken: 'synthetic-sensitive-value' }), /形式/u);
    assert.deepEqual((await h.links())[0], link);
    h.d.connection.prepare('UPDATE sharing_v2_private_google_links SET link_json=? WHERE schedule_entry_id=?').run(JSON.stringify({ ...link, refreshToken: 'synthetic-sensitive-value' }), link.scheduleEntryId);
    await assert.rejects(h.store.readSavedLinks(), /形式/u);
  } finally { h.close(); }
});
