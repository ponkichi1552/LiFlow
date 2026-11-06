import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './helpers/sqlite.mjs';
import { createIntegration, repository, now, today, listId } from './helpers/google-sync-integration.mjs';

test('180 tasks use all pages and import the final first-party hidden completion exactly once', async () => {
  const h = await createIntegration();
  try {
    assert.equal(h.tasks.size, 180);
    const lastTask = [...h.tasks.values()].at(-1);
    Object.assign(lastTask, { status: 'completed', hidden: true, completed: now.toISOString() });
    const result = await h.sync();
    assert.equal(result.kind, 'success');
    assert.equal(result.remoteTasksRead, 180);
    assert.equal(result.hiddenCompletionsRead, 1);
    assert.equal(result.imported, 1);
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].source, 'googleTasks');
    assert.equal(h.history()[0].completed_at, now.toISOString());
    const lastEntry = h.entries.at(-1);
    assert.equal(h.history()[0].schedule_entry_id, lastEntry.id);
    assert.equal(h.history()[0].scheduled_date, lastEntry.suggestedDate);
    assert.equal(h.history()[0].scheduled_window_start, lastEntry.windowStart);
    assert.equal(h.history()[0].scheduled_window_end, lastEntry.windowEnd);
    const pages = h.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/tasks'));
    assert.equal(pages.length, 2);
    assert.equal(h.calls.filter((call) => call.method === 'GET').length, 3);
    assert.equal(h.calls.filter((call) => call.method !== 'GET').length, 0);
    assert.equal((await h.snapshot()).completions[0].estimatedDate, false);
    assert.equal((await h.sync()).imported, 0);
    assert.equal(h.history().length, 1);
    assert.equal(h.state().last_completed_estimated, 0);
    assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version, 27);
  } finally { h.connection.close(); }
});

test('multiple completion snapshots survive regeneration and use the existing Scheduler for the next cycle', async () => {
  // Import three occurrences whose windows have started, retaining the separate future-checkmark contract.
  const h = await createIntegration({ cycleDays: 3, previousDate: '2026-10-14', initialToday: '2026-10-15' });
  try {
    const originals = h.entries.slice(0, 3);
    for (const [index, task] of [...h.tasks.values()].slice(0, 3).entries()) {
      Object.assign(task, { status: 'completed', hidden: true, completed: `2026-10-25T0${index + 1}:00:00.000Z` });
    }
    const result = await h.sync();
    assert.equal(result.imported, 3);
    assert.equal(h.history().length, 3);
    assert.deepEqual(h.history().map((row) => row.schedule_entry_id).sort(), originals.map((entry) => entry.id).sort());
    assert.equal(h.state().last_completed_date, today);
    assert.equal(h.state().last_completed_estimated, 0);
    const snapshot = await h.snapshot();
    assert.equal(snapshot.scheduleEntries.find((entry) => entry.choreId === h.chore.id).suggestedDate, '2026-10-28');
    assert.ok(h.events.indexOf('IMPORT') < h.events.indexOf('POST'));
    assert.equal((await h.sync()).imported, 0);
    assert.equal(h.history().length, 3);
  } finally { h.connection.close(); }
});

test('future Google completion keeps its actual timestamp without advancing the cycle before its scheduled day', async () => {
  const h = await createIntegration({ cycleDays: 7, previousDate: '2026-10-20' });
  try {
    const original = h.entries[0];
    assert.equal(original.suggestedDate, '2026-10-27');
    Object.assign(h.tasks.get('remote-0'), { status: 'completed', hidden: true, completed: now.toISOString() });
    assert.equal((await h.sync()).imported, 1);
    assert.equal(h.history()[0].completed_at, now.toISOString());
    assert.equal(h.history()[0].scheduled_date, '2026-10-27');
    assert.equal(h.state().last_completed_date, '2026-10-20');
    assert.equal((await h.snapshot()).scheduleEntries[0].id, original.id);
    const scheduledDay = await repository.loadPlannerSnapshot(h.database, '2026-10-27', new Date('2026-10-27T03:00:00.000Z'));
    assert.equal(scheduledDay.scheduleEntries[0].suggestedDate, '2026-11-03');
    assert.equal(h.history().length, 1);
  } finally { h.connection.close(); }
});

test('missing or invalid completed timestamps are skipped while valid completions and unknown tasks are handled safely', async () => {
  const h = await createIntegration();
  try {
    const tasks = [...h.tasks.values()];
    Object.assign(tasks[0], { status: 'completed', updated: now.toISOString() });
    Object.assign(tasks[1], { status: 'completed', completed: '2026-02-30T03:00:00Z' });
    Object.assign(tasks[2], { status: 'completed', hidden: true, completed: now.toISOString() });
    h.tasks.set('unknown-same-name', { id: 'unknown-same-name', title: h.chore.name, status: 'completed', completed: now.toISOString() });
    const result = await h.sync();
    assert.equal(result.kind, 'success');
    assert.equal(result.invalidCompletions, 2);
    assert.equal(result.imported, 1);
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].schedule_entry_id, h.entries[2].id);
    assert.equal(tasks[0].status, 'completed');
    assert.equal(h.calls.some((call) => call.method !== 'GET' && call.path.includes('unknown-same-name')), false);
  } finally { h.connection.close(); }
});

test('remote undo reopens a locally completed occurrence without duplicating its history', async () => {
  const h = await createIntegration();
  try {
    assert.equal(await repository.completeChore(h.database, h.entries[0], undefined, 'widget'), true);
    const original = h.history()[0];
    assert.equal((await h.sync()).kind, 'success');
    assert.equal(h.tasks.get('remote-0').status, 'completed');
    assert.equal((await h.sync()).imported, 0);
    Object.assign(h.tasks.get('remote-0'), { status: 'needsAction', completed: undefined, hidden: false });
    await h.sync();
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].id, original.id);
    assert.equal(h.history()[0].source, 'googleTasks');
    assert.equal(h.history()[0].completed_at, original.completed_at);
    assert.equal(h.history()[0].outcome, 'incomplete');
  } finally { h.connection.close(); }
});

test('remote undo and remote deletion preserve imported history and the chore definition', async () => {
  const h = await createIntegration();
  try {
    const task = h.tasks.get('remote-0');
    Object.assign(task, { status: 'completed', hidden: true, completed: now.toISOString() });
    await h.sync();
    const original = h.history()[0];
    Object.assign(task, { status: 'needsAction', completed: undefined });
    await h.sync();
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].outcome, 'incomplete');
    Object.assign(task, { status: 'completed', completed: now.toISOString() });
    assert.equal((await h.sync()).imported, 1);
    assert.equal(h.history()[0].outcome, 'completed');
    task.deleted = true;
    h.calls.length = 0;
    await h.sync();
    assert.equal(h.history()[0].id, original.id);
    assert.equal(h.history()[0].source, 'googleTasks');
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_definitions WHERE id = ?').get(h.chore.id).n, 1);
    assert.equal(h.calls.some((call) => call.method === 'POST'), false);
  } finally { h.connection.close(); }
});

test('mapped completion is imported before title/due writes and obsolete cleanup; unchanged tasks are not patched', async () => {
  const h = await createIntegration();
  try {
    const task = h.tasks.get('remote-0');
    Object.assign(task, { status: 'completed', hidden: true, completed: now.toISOString(), title: 'Googleで変更された名前', due: '2026-11-01T00:00:00Z' });
    const result = await h.sync();
    assert.equal(result.imported, 1);
    const patches = h.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].path.endsWith('/remote-0'), true);
    assert.match(patches[0].body.notes, /^LiFlow personal occurrence: [a-f0-9]{64}$/u);
    assert.deepEqual({ ...patches[0].body, notes: undefined }, { title: h.chore.name, due: `${h.entries[0].suggestedDate}T00:00:00.000Z`, notes: undefined });
    assert.ok(h.events.indexOf('IMPORT') < h.events.indexOf('PATCH'));
    assert.equal(task.status, 'completed');
    assert.equal((await repository.listGoogleTaskLinks(h.database)).find((link) => link.scheduleEntryId === h.entries[0].id).googleTaskId, 'remote-0');
  } finally { h.connection.close(); }
});

test('unknown IDs and mismatched mappings cannot create a local completion', async () => {
  const h = await createIntegration();
  try {
    const completion = { googleTaskListId: listId, googleTaskId: 'remote-0', scheduleEntryId: h.entries[1].id, completedAt: now.toISOString() };
    assert.equal(await repository.importGoogleTaskCompletions(h.database, [completion], today), 0);
    assert.equal(await repository.importGoogleTaskCompletions(h.database, [{ ...completion, googleTaskListId: 'other-list', scheduleEntryId: h.entries[0].id }], today), 0);
    assert.equal(h.history().length, 0);
  } finally { h.connection.close(); }
});

test('pull failures use the shared retry/auth policy before importing or writing anything', async () => {
  const h = await createIntegration();
  try {
    for (const [status, kind, retryHours] of [[503, 'retry', 1], [429, 'retry', 2], [401, 'authRequired', null], [403, 'error', null]]) {
      h.fixture.failure = { status, retryAfter: status === 429 ? '7200' : null };
      h.calls.length = 0;
      const result = await h.sync();
      assert.equal(result.kind, kind);
      const state = await repository.loadGoogleSyncState(h.database);
      if (retryHours) assert.equal(state.nextRetryAt, new Date(now.getTime() + retryHours * 3_600_000).toISOString());
      assert.equal(h.history().length, 0);
      assert.equal(h.calls.some((call) => call.method !== 'GET'), false);
    }
    h.fixture.failure = null;
    assert.equal((await h.sync()).kind, 'success');
    const state = await repository.loadGoogleSyncState(h.database);
    assert.equal(state.retryCount, 0);
    assert.equal(state.nextRetryAt, undefined);
  } finally { h.connection.close(); }
});

test('a mapped occurrence pruned from the schedule retains available due metadata without inventing a window', async () => {
  const h = await createIntegration();
  try {
    h.connection.prepare('DELETE FROM chore_schedule_entries WHERE id = ?').run(h.entries[0].id);
    assert.equal(await repository.importGoogleTaskCompletions(h.database, [{
      googleTaskListId: listId, googleTaskId: 'remote-0', scheduleEntryId: h.entries[0].id, completedAt: now.toISOString(),
    }], today), 1);
    const completion = h.history()[0];
    assert.equal(completion.scheduled_date, h.entries[0].suggestedDate);
    assert.equal(completion.scheduled_window_start, null);
    assert.equal(completion.scheduled_window_end, null);
  } finally { h.connection.close(); }
});

test('older remote completions add history while preserving the latest local chore state', async () => {
  const h = await createIntegration();
  try {
    const before = { ...h.state() };
    Object.assign(h.tasks.get('remote-0'), { status: 'completed', completed: '2026-10-24T03:00:00Z' });
    assert.equal((await h.sync()).imported, 1);
    assert.equal(h.history()[0].completed_at, '2026-10-24T03:00:00.000Z');
    assert.equal(h.state().last_completed_date, today);
    assert.deepEqual({ ...h.state() }, before);
  } finally { h.connection.close(); }
});

test('an existing occurrence record, including a local undo, is never duplicated or relabeled by Google', async () => {
  const h = await createIntegration();
  try {
    await repository.completeChore(h.database, h.entries[0]);
    const original = h.history()[0];
    await repository.undoCompletedChore(h.database, original.id);
    Object.assign(h.tasks.get('remote-0'), { status: 'completed', completed: now.toISOString() });
    assert.equal((await h.sync()).imported, 0);
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].source, 'inApp');
    assert.equal(h.history()[0].outcome, 'incomplete');
  } finally { h.connection.close(); }
});

test('Google completion and next occurrences persist after closing and reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'google-completion-persistence-'));
  const file = join(directory, 'planner.db');
  const h = await createIntegration({ cycleDays: 3, previousDate: '2026-10-22', databasePath: file });
  let reopened;
  try {
    Object.assign(h.tasks.get('remote-0'), { status: 'completed', hidden: true, completed: now.toISOString() });
    assert.equal((await h.sync()).imported, 1);
    const before = await h.snapshot();
    h.connection.close();
    reopened = createDatabase(file);
    await repository.initializeLocalDatabase(reopened.database);
    const after = await repository.loadPlannerSnapshot(reopened.database, today);
    assert.deepEqual(after.completions, before.completions);
    assert.deepEqual(after.states, before.states);
    assert.deepEqual(after.scheduleEntries, before.scheduleEntries);
    assert.equal(after.scheduleEntries.find((entry) => entry.choreId === h.chore.id).suggestedDate, '2026-10-28');
  } finally {
    if (reopened) reopened.connection.close();
    else { try { h.connection.close(); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a multiple-completion write failure rolls back the entire import transaction', async () => {
  const h = await createIntegration();
  try {
    const before = { ...h.state() };
    h.connection.exec(`CREATE TRIGGER fail_second_google_completion BEFORE INSERT ON chore_completions
      WHEN NEW.schedule_entry_id = '${h.entries[1].id.replaceAll("'", "''")}'
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`);
    const candidates = h.entries.slice(0, 2).map((entry, index) => ({
      googleTaskListId: listId, googleTaskId: `remote-${index}`, scheduleEntryId: entry.id, completedAt: now.toISOString(),
    }));
    await assert.rejects(repository.importGoogleTaskCompletions(h.database, candidates, today), /fixture write failure/u);
    assert.equal(h.history().length, 0);
    assert.deepEqual({ ...h.state() }, before);
  } finally { h.connection.close(); }
});

test('concurrent imports are serialized and a second-page failure imports nothing', async () => {
  const h = await createIntegration();
  try {
    Object.assign(h.tasks.get('remote-0'), { status: 'completed', hidden: true, completed: now.toISOString() });
    h.fixture.failure = { status: 503, pageToken: 100 };
    assert.equal((await h.sync()).kind, 'retry');
    assert.equal(h.history().length, 0);
    assert.equal(h.events.includes('IMPORT'), false);
    h.fixture.failure = null;
    const candidates = [{ googleTaskListId: listId, googleTaskId: 'remote-0', scheduleEntryId: h.entries[0].id, completedAt: now.toISOString() }];
    assert.deepEqual(await Promise.all([
      repository.importGoogleTaskCompletions(h.database, candidates, today),
      repository.importGoogleTaskCompletions(h.database, candidates, today),
    ]), [1, 0]);
    assert.equal(h.history().length, 1);
  } finally { h.connection.close(); }
});
