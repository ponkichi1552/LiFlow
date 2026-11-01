import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';
import { buildSharedPlannerSnapshot, sharedGroupBootstrap } from '../src/features/sharing/planning.ts';
import { createLocalSharedOperations, initializeSharingLedger, loadSharedReplica, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { initializeSharedProjection, persistSharedProjection, cacheSharedScheduleIfCurrent, sharedProjectionToken } from '../src/platform/storage/sharing-projection.ts';
const { ensureLocalHousehold } = await import('../src/platform/storage/repository.ts');
const scope = { userId: 'owner', groupId: 'group-test', householdId: 'local-household' };
const author = { ...scope, deviceId: 'device-a', keyVersion: 1 };
const now = new Date('2026-10-27T02:00:00Z');
const choreId = 'group-test.builtin-chore-08';
async function fixture() {
  const h = createDatabase(); await initializeSharedProjection(h.database, scope); await initializeSharingLedger(h.database);
  const snapshot = (replica, at = now) => buildSharedPlannerSnapshot(replica, { householdId: scope.householdId, now: at, activeMemberIds: ['owner'] });
  const project = (transaction, replica) => persistSharedProjection(transaction, replica, snapshot(replica), { userId: scope.userId });
  const edit = async (drafts, options) => createLocalSharedOperations(h.database, author, drafts, options?.project ?? project);
  await edit(sharedGroupBootstrap({ ...scope, ownerUserId: 'owner', ownerDisplayName: '自分', name: '家族', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }));
  let count = 0;
  const patch = (entityType, entityId, payload, operationType = 'patch') => ({ operationId: `test-${++count}`, entityType, entityId, payload, operationType });
  return { ...h, snapshot, edit, patch, project, replica: () => loadSharedReplica(h.database, scope.groupId) };
}

test('shared projection refuses personal data conversion and another account or group without modifying the original', async () => {
  const personal = createDatabase();
  try {
    await migrateLocalDatabase(personal.database);
    await ensureLocalHousehold(personal.database);
    const before = personal.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all();
    await assert.rejects(initializeSharedProjection(personal.database, scope), /個人DB/);
    assert.deepEqual(personal.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all(), before);
    assert.equal(personal.connection.prepare("SELECT name FROM sqlite_master WHERE name='sharing_workspace_metadata'").get(), undefined);
  } finally { personal.connection.close(); }
  const h = await fixture();
  try {
    await assert.rejects(initializeSharedProjection(h.database, { ...scope, userId: 'outsider' }), /一致/);
    await assert.rejects(initializeSharedProjection(h.database, { ...scope, groupId: 'other' }), /一致/);
    await assert.rejects(ensureLocalHousehold(h.database), /共有/);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_definitions').get().n, 46);
  } finally { h.connection.close(); }
});

test('shared edits and derived cache commit atomically, preserve private fields and avoid duplicate writes', async () => {
  const h = await fixture();
  try {
    assert.equal((await listSharingOutbox(h.database, scope.groupId)).length, 94);
    await h.database.runAsync('UPDATE household_settings SET notification_hour=7, notifications_enabled=1');
    await h.edit([h.patch('chore', choreId, { enabled: true, recommendedCycleDays: 17 }),
      h.patch('baseline', choreId, { initialPending: true, initialScheduledDate: '2026-10-27' })]);
    let replica = await h.replica(); let snapshot = h.snapshot(replica);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_schedule_entries').get().n, snapshot.scheduleEntries.length);
    assert.equal(h.connection.prepare('SELECT notification_hour FROM household_settings').get().notification_hour, 7);
    const beforeWrites = h.writes.length;
    await h.project(h.database, replica);
    assert.equal(h.writes.length, beforeWrites);
    await assert.rejects(h.edit([h.patch('chore', choreId, { recommendedCycleDays: 2 })], { project: async (db, next) => {
      await h.project(db, next); throw new Error('interrupted');
    } }), /interrupted/);
    replica = await h.replica(); snapshot = h.snapshot(replica);
    assert.equal(snapshot.chores.find((chore) => chore.id === choreId).recommendedCycleDays, 17);
    assert.equal((await listSharingOutbox(h.database, scope.groupId)).length, 96);
  } finally { h.connection.close(); }
});

test('completion, targeted undo and history retain Google IDs while staging only the latest status revision', async () => {
  const h = await fixture();
  try {
    await h.edit([h.patch('chore', choreId, { enabled: true }), h.patch('baseline', choreId, { initialScheduledDate: '2026-10-27' })]);
    const entry = h.snapshot(await h.replica()).scheduleEntries[0];
    await h.database.runAsync(`INSERT INTO google_task_links (schedule_entry_id, household_id, chore_id, google_task_list_id, google_task_id, created_at, updated_at, last_synced_status)
      VALUES (?, ?, ?, 'private-list', 'private-task', '2026-10-27', '2026-10-27', 'needsAction')`, entry.id, scope.householdId, entry.choreId);
    const completion = h.patch('completion', entry.id, { choreId, completedAt: now.toISOString(), completedLocalDate: '2026-10-27', outcome: 'completed',
      scheduledDate: entry.suggestedDate, scheduledWindowStart: entry.windowStart, scheduledWindowEnd: entry.windowEnd }, 'complete');
    await h.edit([completion]);
    const completedLink = h.connection.prepare('SELECT * FROM google_task_links').get();
    assert.equal(completedLink.pending_status, 'completed');
    await h.edit([h.patch('completion', entry.id, { targetOperationId: completion.operationId }, 'undo')]);
    const undoneLink = h.connection.prepare('SELECT * FROM google_task_links').get();
    assert.equal(undoneLink.google_task_id, 'private-task'); assert.equal(undoneLink.pending_status, 'needsAction');
    assert.notEqual(undoneLink.pending_status_revision, completedLink.pending_status_revision);
    assert.equal(h.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'incomplete');
    assert.equal(h.snapshot(await h.replica()).scheduleEntries[0].id, entry.id);
    await h.edit([h.patch('chore', choreId, {}, 'delete')]);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 1);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM google_task_links').get().n, 1);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_schedule_entries').get().n, 0);
  } finally { h.connection.close(); }
});

test('Google-origin projection does not echo a status and removed waste cascades only its visibility cache', async () => {
  const h = await fixture();
  try {
    await h.edit([h.patch('waste', 'waste-weekly', { label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [2] }),
      h.patch('wasteVisibility', 'hidden-1', { scheduleId: 'waste-weekly', date: '2026-10-27', hidden: true }),
      h.patch('chore', choreId, { enabled: true })]);
    const entry = h.snapshot(await h.replica()).scheduleEntries[0];
    await h.database.runAsync(`INSERT INTO google_task_links (schedule_entry_id, household_id, chore_id, google_task_list_id, google_task_id, created_at, updated_at)
      VALUES (?, ?, ?, 'private-list', 'private-task', '2026-10-27', '2026-10-27')`, entry.id, scope.householdId, entry.choreId);
    await h.edit([h.patch('completion', entry.id, { choreId, completedAt: now.toISOString(), completedLocalDate: '2026-10-27', outcome: 'completed' }, 'complete')], {
      project: (db, replica) => persistSharedProjection(db, replica, h.snapshot(replica), { userId: 'owner', importedGoogleOccurrenceIds: new Set([entry.id]) }),
    });
    assert.equal(h.connection.prepare('SELECT pending_status FROM google_task_links').get().pending_status, null);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM hidden_waste_occurrences').get().n, 1);
    await h.edit([h.patch('waste', 'waste-weekly', {}, 'delete')]);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM hidden_waste_occurrences').get().n, 0);
    assert.equal(h.snapshot(await h.replica()).completions.length, 1);
  } finally { h.connection.close(); }
});

test('a stale planner read cannot replace a newer shared edit or cross the workspace boundary', async () => {
  const h = await fixture();
  try {
    const replica = await h.replica(); const snapshot = h.snapshot(replica);
    const token = sharedProjectionToken(replica, snapshot);
    await h.edit([h.patch('chore', choreId, { enabled: true })]);
    assert.equal(await cacheSharedScheduleIfCurrent(h.database, token, snapshot), false);
    assert.ok(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_schedule_entries').get().n > 0);
    await assert.rejects(persistSharedProjection(h.database, await h.replica(), h.snapshot(await h.replica()), { userId: 'outsider' }), /boundaries/);
  } finally { h.connection.close(); }
});
