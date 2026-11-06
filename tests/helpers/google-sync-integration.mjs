import { installFrozenSchedulerFixture } from './frozen-scheduler-fixture.mjs';
import assert from 'node:assert/strict';
import './typescript-loader.mjs';
import { createDatabase } from './sqlite.mjs';

export const repository = await import('../../src/platform/storage/repository.ts');
const { createGoogleTasksApi } = await import('../../src/platform/google-tasks/google-tasks-api.ts');
const { syncGoogleTasksWithDependencies } = await import('../../src/features/google-sync/coordinator.ts');
export const now = new Date('2026-10-25T03:00:00.000Z');
export const today = '2026-10-25';
export const listId = 'planner-list';

export async function createIntegration({ cycleDays = 1, previousDate = today, databasePath, choreOverrides = {}, initialToday = today } = {}) {
  const store = createDatabase(databasePath);
  const { database, connection } = store;
  await repository.initializeLocalDatabase(database); await installFrozenSchedulerFixture(database);
  let snapshot = await repository.loadPlannerSnapshot(database, initialToday);
  let chore = snapshot.chores.find((item) => item.id === 'builtin-chore-26');
  assert.ok(chore);
  chore = { ...chore, load: 'light', windowRadiusDays: 0, maxShiftDays: 0, holidayPriority: false, recommendedCycleDays: cycleDays,
    frequencyDaysByMode: { frequent: cycleDays, balanced: cycleDays, relaxed: cycleDays }, ...choreOverrides };
  await repository.updateChoreDefinition(database, chore);
  await repository.completeFirstSetup(database, {
    frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { date: previousDate } }, weatherLocation: null,
  });
  snapshot = await repository.loadPlannerSnapshot(database, initialToday);
  const entries = snapshot.scheduleEntries.filter((entry) => entry.choreId === chore.id);
  const tasks = new Map();
  for (const [index, entry] of entries.entries()) {
    const task = { id: `remote-${index}`, title: chore.name, due: `${entry.suggestedDate}T00:00:00.000Z`, status: 'needsAction' };
    tasks.set(task.id, task);
    await repository.upsertGoogleTaskLink(database, {
      householdId: repository.LOCAL_HOUSEHOLD_ID, choreId: chore.id, scheduleEntryId: entry.id,
      googleTaskListId: listId, googleTaskId: task.id,
      lastSyncedTitle: chore.name, lastSyncedDueDate: entry.suggestedDate,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
  }
  await repository.saveGoogleSyncState(database, {
    householdId: repository.LOCAL_HOUSEHOLD_ID, enabled: true, taskListId: listId, status: 'idle', retryCount: 0, updatedAt: now.toISOString(),
  });
  const calls = [];
  const events = [];
  let generated = 0;
  const fixture = { tasks, calls, events, failure: null };
  const api = createGoogleTasksApi(async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    if (parsed.pathname === '/batch') {
      const contentType = init.headers['Content-Type'];
      const boundary = contentType.match(/boundary=([^;\s]+)/u)?.[1];
      assert.ok(boundary);
      const responseBoundary = 'fixture-response-boundary';
      const responseParts = [];
      for (const rawPart of String(init.body).split(`--${boundary}`)) {
        const part = rawPart.trim();
        if (!part || part === '--') continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        assert.notEqual(headerEnd, -1);
        const partHeaders = part.slice(0, headerEnd);
        const requestId = partHeaders.match(/^Content-ID:\s*<([^>]+)>/imu)?.[1];
        assert.ok(requestId);
        const nestedRequest = part.slice(headerEnd + 4);
        const requestLine = nestedRequest.match(/^(POST|PATCH|DELETE)\s+(\S+)\s+HTTP\/1\.1/u);
        assert.ok(requestLine);
        const nestedMethod = requestLine[1];
        const nestedUrl = new URL(requestLine[2], 'https://tasks.googleapis.com');
        const bodyStart = nestedRequest.indexOf('\r\n\r\n');
        const nestedBody = bodyStart >= 0 ? nestedRequest.slice(bodyStart + 4).trim() : '';
        const nestedBodyValue = nestedBody ? JSON.parse(nestedBody) : undefined;
        calls.push({ method: nestedMethod, path: nestedUrl.pathname, query: Object.fromEntries(nestedUrl.searchParams), body: nestedBodyValue });
        events.push(nestedMethod);
        const nestedTaskId = nestedUrl.pathname.length > `/tasks/v1/lists/${listId}/tasks`.length
          ? decodeURIComponent(nestedUrl.pathname.slice(`/tasks/v1/lists/${listId}/tasks/`.length)) : undefined;
        let status = 200;
        let responseBody = '';
        if (nestedMethod === 'POST') {
          const task = { id: `generated-${++generated}`, status: 'needsAction', ...nestedBodyValue };
          tasks.set(task.id, task);
          status = 201;
          responseBody = JSON.stringify(task);
        } else {
          const task = tasks.get(nestedTaskId);
          if (!task) status = 404;
          else if (nestedMethod === 'PATCH') { Object.assign(task, nestedBodyValue); responseBody = JSON.stringify(task); }
          else if (nestedMethod === 'DELETE') { task.deleted = true; status = 204; }
        }
        responseParts.push([
          `--${responseBoundary}`,
          'Content-Type: application/http',
          `Content-ID: <response-${requestId}>`,
          '',
          `HTTP/1.1 ${status} ${status === 201 ? 'Created' : status === 204 ? 'No Content' : status === 404 ? 'Not Found' : 'OK'}`,
          ...(responseBody ? ['Content-Type: application/json; charset=UTF-8', '', responseBody] : ['', '']),
        ].join('\r\n'));
      }
      responseParts.push(`--${responseBoundary}--`, '');
      return new Response(responseParts.join('\r\n'), {
        status: 200,
        headers: { 'Content-Type': `multipart/mixed; boundary=${responseBoundary}` },
      });
    }
    // Retain only request metadata and JSON bodies, never the Authorization header.
    calls.push({ method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body: init.body ? JSON.parse(init.body) : undefined });
    events.push(method);
    if (parsed.pathname.endsWith('/users/@me/lists')) return Response.json({ items: [{ id: listId, title: '家事Planner' }] });
    const tasksPath = `/tasks/v1/lists/${listId}/tasks`;
    assert.ok(parsed.pathname.startsWith(tasksPath));
    const taskId = parsed.pathname.length > tasksPath.length ? decodeURIComponent(parsed.pathname.slice(tasksPath.length + 1)) : undefined;
    if (method === 'GET' && !taskId) {
      assert.equal(parsed.searchParams.get('showHidden'), 'true');
      assert.equal(parsed.searchParams.get('showCompleted'), 'true');
      const start = Number(parsed.searchParams.get('pageToken') ?? '0');
      if (fixture.failure && (fixture.failure.pageToken === undefined || fixture.failure.pageToken === start)) {
        return new Response('{}', { status: fixture.failure.status, headers: fixture.failure.retryAfter ? { 'Retry-After': fixture.failure.retryAfter } : {} });
      }
      const all = [...tasks.values()];
      const next = start + 100 < all.length ? String(start + 100) : undefined;
      return Response.json({ items: all.slice(start, start + 100), ...(next ? { nextPageToken: next } : {}) });
    }
    if (method === 'POST') {
      const task = { id: `generated-${++generated}`, status: 'needsAction', ...JSON.parse(init.body) };
      tasks.set(task.id, task);
      return Response.json(task);
    }
    const task = tasks.get(taskId);
    if (!task) return new Response('', { status: 404 });
    if (method === 'PATCH') { Object.assign(task, JSON.parse(init.body)); return Response.json(task); }
    if (method === 'DELETE') { task.deleted = true; return new Response(null, { status: 204 }); }
    return Response.json(task);
  });
  const dependencies = {
    loadState: () => repository.loadGoogleSyncState(database),
    hasPendingLocalChanges: (lastSuccess) => repository.hasPendingGoogleTaskChanges(database, lastSuccess),
    saveState: (state) => repository.saveGoogleSyncState(database, state),
    getAccessToken: async () => 'fixture-token', api,
    listEntriesForGoogleSync: (date, householdId) => repository.listEntriesForGoogleSync(database, date, householdId),
    listGoogleTaskLinks: (householdId) => repository.listGoogleTaskLinks(database, householdId),
    upsertGoogleTaskLink: (link) => repository.upsertGoogleTaskLink(database, link),
    deleteGoogleTaskLink: (id) => repository.deleteGoogleTaskLink(database, id),
    taskCreateJournal: {
      reserve: identity => repository.reserveGoogleTaskCreate(database, identity),
      reject: intent => repository.rejectGoogleTaskCreate(database, intent),
      linked: (identity, taskId) => repository.linkGoogleTaskCreate(database, identity, taskId),
      deleted: (identity, taskId) => repository.deleteGoogleTaskCreate(database, identity, taskId),
    },
    importGoogleTaskChanges: (changes, date) => { events.push('IMPORT'); return repository.importGoogleTaskChanges(database, changes, date, now); },
    acknowledgeGoogleTaskStatus: (link, status) => repository.acknowledgeGoogleTaskStatus(database, link, status),
  };
  return {
    ...store, ...fixture, fixture, chore, entries, dependencies,
    sync: () => syncGoogleTasksWithDependencies(dependencies, { force: true, now, recoverInterruptedAttempt: true }),
    snapshot: () => repository.loadPlannerSnapshot(database, today, now),
    history: () => connection.prepare('SELECT * FROM chore_completions ORDER BY completed_at').all(),
    state: () => connection.prepare('SELECT * FROM chore_state WHERE chore_id = ?').get(chore.id),
  };
}
