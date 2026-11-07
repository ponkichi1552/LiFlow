import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createIntegration, now, repository } from './helpers/google-sync-integration.mjs';
import { googleSyncRunOptions } from '../src/features/google-sync/sync-policy.ts';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';
const { syncGoogleTasksWithDependencies } = await import('../src/features/google-sync/coordinator.ts');

test('a coherent native personal status snapshot pushes completion and Undo without an inventory read or advancing the pull checkpoint',async()=>{
  const h=await createIntegration();
  try {
    await h.sync();const last=(await repository.loadGoogleSyncState(h.database)).lastSuccessfulSyncAt;
    const dependencies={...h.dependencies,readLocalStatusSnapshot:(day,id)=>repository.readPersonalGoogleStatusSnapshot(h.database,day,id),verifyTaskListForLocalChanges:async()=>true};
    await repository.completeChore(h.database,h.entries[0]);h.calls.length=0;
    const completed=await syncGoogleTasksWithDependencies(dependencies,{now,recoverInterruptedAttempt:true});
    assert.equal(completed.localStatusesOnly,true);assert.equal(h.calls.filter(row=>row.method==='GET').length,0);assert.equal(h.calls.filter(row=>row.method==='PATCH').length,1);
    await repository.undoCompletedChore(h.database,h.history()[0].id);h.calls.length=0;
    const undone=await syncGoogleTasksWithDependencies(dependencies,{now,recoverInterruptedAttempt:true});
    assert.equal(undone.localStatusesOnly,true);assert.equal(h.calls.filter(row=>row.method==='GET').length,0);assert.equal(h.calls.filter(row=>row.method==='PATCH').length,1);
    assert.equal((await repository.loadGoogleSyncState(h.database)).lastSuccessfulSyncAt,last);
  }finally{h.connection.close();}
});

test('completion-triggered sync recovers a fresh interrupted marker and updates the same task without forcing Calendar', async () => {
  const h = await createIntegration();
  try {
    const target = h.entries[0];
    await repository.completeChore(h.database, target);
    const state = await repository.loadGoogleSyncState(h.database, repository.LOCAL_HOUSEHOLD_ID);
    await repository.saveGoogleSyncState(h.database, { ...state, status: 'syncing', lastAttemptAt: now.toISOString() });
    const calendarForces = [];
    h.dependencies.refreshCalendar = async ({ force }) => { calendarForces.push(force); return { plannerChanged: false }; };
    const result = await syncGoogleTasksWithDependencies(h.dependencies, {
      ...googleSyncRunOptions({ force: true, trigger: 'completion' }), now: new Date(now.getTime() + 60_000),
    });
    assert.equal(result.kind, 'success');
    assert.notEqual(result.skipped, true);
    assert.equal(h.tasks.get('remote-0').status, 'completed');
    assert.deepEqual(calendarForces, [false]);
    const links = await repository.listGoogleTaskLinks(h.database);
    assert.equal(links.find((link) => link.scheduleEntryId === target.id).googleTaskId, 'remote-0');
    assert.equal(h.calls.filter(({ method }) => method === 'PATCH').length, 1);
  } finally { h.connection.close(); }
});

for (const status of ['idle', 'syncing']) {
  test(`startup recovers durable widget changes from ${status} without forcing Calendar or syncing twice`, async () => {
    const h = await createIntegration();
    try {
      const target = h.entries[0];
      await repository.completeChore(h.database, target, undefined, 'widget');
      const state = await repository.loadGoogleSyncState(h.database);
      await repository.saveGoogleSyncState(h.database, { ...state, status,
        lastAttemptAt: now.toISOString(), lastSuccessfulSyncAt: now.toISOString() });
      const calendarForces = [];
      h.dependencies.refreshCalendar = async ({ force }) => { calendarForces.push(force); return { plannerChanged: false }; };
      const clock = new Date();
      const result = await syncGoogleTasksWithDependencies(h.dependencies, { now: clock });
      assert.equal(result.kind, 'success');
      assert.notEqual(result.skipped, true);
      assert.equal(h.tasks.get('remote-0').status, 'completed');
      assert.deepEqual(calendarForces, [false]);
      assert.equal(await repository.hasPendingGoogleTaskChanges(h.database, clock.toISOString()), false);
      const requests = h.calls.length;
      const second = await syncGoogleTasksWithDependencies(h.dependencies, { now: clock });
      assert.equal(second.skipped, true);
      assert.equal(h.calls.length, requests);
    } finally { h.connection.close(); }
  });
}

test('a widget completion without a Google mapping is recovered by its durable timestamp', async () => {
  const h = await createIntegration();
  try {
    await repository.completeChore(h.database, h.entries[0], undefined, 'widget');
    await h.database.runAsync('DELETE FROM google_task_links');
    assert.equal(await repository.hasPendingGoogleTaskChanges(h.database, now.toISOString()), true);
    assert.equal(await repository.hasPendingGoogleTaskChanges(h.database, new Date().toISOString()), false);
  } finally { h.connection.close(); }
});

test('foreground recovery retains retry backoff and permanent failures with pending local changes', async () => {
  for (const status of ['retryPending', 'authRequired', 'error']) {
    const h = await createIntegration();
    try {
      await repository.completeChore(h.database, h.entries[0], undefined, 'widget');
      const state = await repository.loadGoogleSyncState(h.database);
      await repository.saveGoogleSyncState(h.database, { ...state, status,
        nextRetryAt: new Date(now.getTime() + 3_600_000).toISOString(), lastSuccessfulSyncAt: now.toISOString() });
      const result = await syncGoogleTasksWithDependencies(h.dependencies, { now });
      assert.equal(result.skipped, true, status);
      assert.equal(h.calls.length, 0, status);
    } finally { h.connection.close(); }
  }
});

test('Android native completion SQL keeps a revision so an older network response cannot acknowledge a new action', async () => {
  const h = await createIntegration();
  try {
    const operation = { id: `completion-intent.${randomUUID()}`, accountScope: 'person-a',
      householdCreatedAt: h.connection.prepare('SELECT created_at FROM households').get().created_at,
      acceptedAtMs: now.getTime(), completedLocalDate: '2026-10-25', timeZone: 'Asia/Tokyo', entry: h.entries[0] };
    assert.equal(await repository.commitWidgetCompletionOperation(h.database, operation, () => {}), 'saved');
    const old = (await repository.listGoogleTaskLinks(h.database))[0];
    const completion = h.connection.prepare('SELECT id FROM chore_completions').get();
    await repository.undoCompletedChore(h.database, completion.id);
    await repository.commitWidgetCompletionOperation(h.database, { ...operation, completionGeneration: 1, id: `completion-intent.${randomUUID()}` }, () => {});
    const revision = (await repository.listGoogleTaskLinks(h.database))[0].pendingStatusRevision;
    assert.notEqual(revision, old.pendingStatusRevision);
    await repository.acknowledgeGoogleTaskStatus(h.database, old, 'completed');
    const current = (await repository.listGoogleTaskLinks(h.database))[0];
    assert.equal(current.pendingStatus, 'completed');
    assert.equal(current.pendingStatusRevision, revision);
  } finally { h.connection.close(); }
});

test('widget completion written before the v16 migration survives upgrade and syncs by its timestamp', async () => {
  const h = await createIntegration();
  try {
    // An immutable pre-v16 fixture verifies migration, independently of today's native input producer.
    const columnsQuery = 'PRAGMA table_info(google_task_links)';
    const insert = `INSERT INTO chore_completions(id,household_id,chore_id,completed_at,source,schedule_entry_id,
      scheduled_date,scheduled_window_start,scheduled_window_end,previous_chore_state_json,outcome)
      VALUES (?,?,?,?,'widget',?,?,?,?,?,'completed')`;
    h.connection.exec(`ALTER TABLE google_task_links DROP COLUMN pending_status;
      ALTER TABLE google_task_links DROP COLUMN pending_status_revision;
      ALTER TABLE google_task_links DROP COLUMN last_synced_status;
      PRAGMA user_version = 15;`);
    const oldColumns = h.connection.prepare(columnsQuery).all().map(({ name }) => name);
    assert.equal(oldColumns.includes('pending_status'), false);
    const target = h.entries[0];
    h.connection.prepare(insert).run('old-schema-widget', target.householdId, target.choreId,
      new Date(now.getTime() + 60_000).toISOString(), target.id, target.suggestedDate,
      target.windowStart, target.windowEnd, 'null');
    const state = await repository.loadGoogleSyncState(h.database);
    await repository.saveGoogleSyncState(h.database, { ...state, lastSuccessfulSyncAt: now.toISOString() });
    await migrateLocalDatabase(h.database);
    assert.equal(await repository.hasPendingGoogleTaskChanges(h.database, now.toISOString()), true);
    const clock = new Date(now.getTime() + 120_000);
    const result = await syncGoogleTasksWithDependencies(h.dependencies, { now: clock });
    assert.equal(result.kind, 'success'); assert.notEqual(result.skipped, true);
    assert.equal(h.tasks.get('remote-0').status, 'completed');
    assert.equal(await repository.hasPendingGoogleTaskChanges(h.database, clock.toISOString()), false);
  } finally { h.connection.close(); }
});

test('Android native completion ignores a stale widget entry after its chore was disabled', async () => {
  const h = await createIntegration();
  try {
    const source = readFileSync(new URL('../plugins/android/WidgetCompletionDatabase.kt', import.meta.url), 'utf8');
    const sql = source.match(/database\.rawQuery\(\s*("""|")(SELECT[\s\S]*?)\1,/u)?.[2];
    assert.ok(sql);
    const target = h.entries[0];
    assert.ok(h.connection.prepare(sql).get(target.id));
    h.connection.prepare('UPDATE chore_definitions SET enabled = 0 WHERE id = ?').run(target.choreId);
    assert.equal(h.connection.prepare(sql).get(target.id), undefined);
    h.connection.prepare('UPDATE chore_definitions SET enabled = 1 WHERE id = ?').run(target.choreId);
    assert.ok(h.connection.prepare(sql).get(target.id));
    assert.equal(h.connection.prepare(sql).get('removed-entry'), undefined);
  } finally { h.connection.close(); }
});
