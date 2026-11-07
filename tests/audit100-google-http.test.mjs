import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createGoogleTasksApi, GoogleTasksApiError } = await import('../src/platform/google-tasks/google-tasks-api.ts');
const { createGoogleCalendarApi, GoogleCalendarHttpError } = await import('../src/platform/google-calendar/calendar-api.ts');
const { classifyGoogleSyncFailure } = await import('../src/features/google-sync/error-classification.ts');
const { reconcileLocalGoogleTaskStatuses } = await import('../src/features/google-sync/reconcile-google-tasks.ts');

test('audit100 malformed successful Tasks JSON remains retryable instead of permanently stopping automatic sync', async () => {
  const api = createGoogleTasksApi(async () => new Response('<html>temporary gateway response</html>', { status: 200 }));
  await assert.rejects(api.listTaskLists('test-token'), error => {
    assert.ok(error instanceof GoogleTasksApiError); assert.equal(error.status, 502);
    assert.equal(classifyGoogleSyncFailure({ status: error.status, code: error.code }, new Date()).kind, 'retry');
    assert.equal(error.message.includes('<html>'), false); return true;
  });
});

test('audit100 a MIME delimiter inside task notes is data rather than a second batch response', async () => {
  const task = { id: 'created', title: '家事', status: 'needsAction', notes: 'Keep --response-boundary inside this sentence' };
  const payload = ['--response-boundary', 'Content-Type: application/http', 'Content-ID: <response-request-0>', '',
    'HTTP/1.1 201 Created', 'Content-Type: application/json', '', JSON.stringify(task), '--response-boundary--', ''].join('\r\n');
  const api = createGoogleTasksApi(async () => new Response(payload, { headers: { 'Content-Type': 'multipart/mixed; boundary=response-boundary' } }));
  const [result] = await api.createTasksBatch('test-token', 'list', [{ title: '家事', due: '2026-11-07T00:00:00Z' }]);
  assert.equal(result.ok, true); assert.deepEqual(result.task, task);
});

test('audit100 Calendar modifications require one exact strong ETag before reading credentials or sending', async () => {
  let tokens = 0, requests = 0;
  const api = createGoogleCalendarApi({ token: async () => { tokens++; return 'test-token'; }, assertCurrent: async () => {},
    fetch: async () => { requests++; return Response.json({ id: 'event', etag: '"fresh"' }); } });
  for (const etag of ['', '*', 'W/"weak"', '"old"\r\nX-Test: injected']) {
    for (const action of [() => api.patch('primary', 'event', { summary: '変更' }, etag), () => api.remove('primary', 'event', etag)]) {
      await assert.rejects(action(), error => error instanceof GoogleCalendarHttpError && error.status === 400);
    }
  }
  assert.equal(tokens, 0); assert.equal(requests, 0);
});

test('audit100 Calendar acknowledgements cannot replace the exact reserved provider identity', async () => {
  const api = createGoogleCalendarApi({ token: async () => 'test-token', assertCurrent: async () => {},
    fetch: async () => Response.json({ id: 'somebody-else', etag: '"fresh"', summary: '別の予定' }) });
  for (const action of [() => api.get('primary', 'reserved'), () => api.patch('primary', 'reserved', { summary: '変更' }, '"old"'),
    () => api.insert('primary', { id: 'reserved', summary: '追加' })]) {
    await assert.rejects(action(), error => error instanceof GoogleCalendarHttpError && error.status === 502);
  }
});

test('audit100 single Tasks reads and write acknowledgements request only their consumed fields', async () => {
  const calls = []; let bytes = 0;
  const task = { id: 'task', title: '掃除', status: 'needsAction', notes: 'Keep the user note', etag: '"v1"' };
  const unused = { kind: 'tasks#task', selfLink: 'https://tasks.googleapis.com/resource', position: '1'.repeat(300),
    links: [{ type: 'related', link: 'https://example.test/' + 'x'.repeat(1400) }] };
  const api = createGoogleTasksApi(async (url, options) => {
    const fields = new URL(url).searchParams.get('fields'); calls.push({ fields, method: options.method ?? 'GET' });
    const value = fields ? task : { ...task, ...unused }; bytes += JSON.stringify(value).length; return Response.json(value);
  });
  assert.deepEqual(await api.getTask('test-token', 'list', 'task'), task);
  assert.deepEqual(await api.createTask('test-token', 'list', { title: '掃除', due: '2026-11-07T00:00:00Z' }), task);
  assert.deepEqual(await api.patchTask('test-token', 'list', 'task', { title: '掃除' }), task);
  assert.ok(calls.every(call => call.fields?.includes('notes') && call.fields.includes('etag') && !call.fields.includes('links')));
  assert.ok(bytes < 1000, `mock HTTP response characters: ${bytes}`);
});

test('audit100 a hundred confirmed status replies update the read checkpoint in one bounded batch', async () => {
  let writes = 0, acknowledgements = 0; const captured = [];
  const entries = Array.from({ length: 100 }, (_, i) => ({ entry: { id: `entry-${i}`, suggestedDate: '2026-11-07' }, choreName: `家事${i}`,
    localRevision: `revision-${i}`, completedAt: '2026-11-07T01:00:00Z' }));
  const links = entries.map((item, i) => ({ scheduleEntryId: item.entry.id, googleTaskId: `task-${i}`, googleTaskListId: 'list',
    lastSyncedTitle: item.choreName, lastSyncedDueDate: item.entry.suggestedDate, lastSyncedStatus: 'needsAction',
    pendingStatus: 'completed', pendingStatusRevision: item.localRevision, observedLocalRevision: item.localRevision }));
  const repository = { readLocalStatusSnapshot: async () => ({ entries, links }), verifyTaskListForLocalChanges: async () => true,
    taskReadCache: { written: async (_scope, tasks) => { writes++; captured.push(...tasks); } },
    acknowledgeGoogleTaskStatus: async () => { acknowledgements++; } };
  const api = { patchTasksBatch: async (_token, _list, updates) => updates.map((update, i) => ({ requestId: `request-${i}`, ok: true,
    task: { id: update.taskId, title: `家事${i}`, ...update.patch } })) };
  const result = await reconcileLocalGoogleTaskStatuses({ accessToken: 'test-token', state: { householdId: 'local-household',
    taskListId: 'list', accountSubject: 'owner' }, repository, api, today: '2026-11-07' });
  assert.equal(result.updated, 100); assert.equal(acknowledgements, 100); assert.equal(captured.length, 100);
  assert.equal(writes, 1);
});
