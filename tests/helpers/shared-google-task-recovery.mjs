import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './typescript-loader.mjs';
import { createGoogleTasksApi } from '../../src/platform/google-tasks/google-tasks-api.ts';
import { fixture, seeds, groupId } from './sharing-v2-repository-fixture.mjs';
import { memoryTaskClaims } from './shared-task-claims.mjs';
import { createV2GoogleTaskStore } from '../../src/platform/storage/sharing-v2-google-tasks.ts';
const { createV2GoogleTaskRuntime } = await import('../../src/features/sharing/v2/google-tasks-runtime.ts');
import { v2NativeWorkspaceNamespace } from '../../src/features/sharing/v2/native-identity.ts';
import { resolveSharedGoogleTaskList, verifySharedTaskListForLocalChanges } from '../../src/features/google-sync/shared-task-list.ts';
import { sharedTaskCreateJournal } from '../../src/features/google-sync/shared-task-create-journal.ts';
import { withGoogleSyncOperation } from '../../src/features/google-sync/operation-lock.ts';
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function transport({ clock = () => new Date(), listId = 'planner-list', initialTasks = [], initialList = true } = {}) {
  let ordinal = 0, version = 0;
  const accounts = new Map(), requests = [], apiCalls = [];
  const state = { failure: null, afterResponse: null, beforeRequest: null };
  const account = subject => {
    if (!accounts.has(subject)) accounts.set(subject, { lists: new Map(initialList ? [[listId, { id: listId, title: '家事Planner' }]] : []),
      tasks: new Map((accounts.size === 0 ? initialTasks : []).map(value => [value.id, { ...structuredClone(value), etag: `"synthetic-${++version}"`, updated: new Date(clock().getTime() - 60000).toISOString() }])) });
    return accounts.get(subject);
  };
  const token = subject => `synthetic-${subject}`;
  const requestSubject = headers => {
    const value = new Headers(headers).get('authorization') ?? '';
    assert.ok(value.startsWith('Bearer synthetic-'), 'Only synthetic credentials may reach this transport'); return value.slice('Bearer synthetic-'.length);
  };
  function error(status) { return { status, body: { error: { code: status, message: 'synthetic provider rejection', errors: [{ reason: status === 429 ? 'rateLimitExceeded' : status === 401 ? 'authError' : 'synthetic' }] } } }; }
  async function dispatch(subject, path, method, query, body, headers = {}) {
    const remote = account(subject), listCollection = '/tasks/v1/users/@me/lists';
    const taskMatch = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path);
    const listItem = path.startsWith(listCollection + '/') ? decodeURIComponent(path.slice(listCollection.length + 1)) : null;
    const route = path === listCollection ? 'list-inventory' : listItem ? 'list-item' : taskMatch && taskMatch[2] ? 'task-item' : 'task-page';
    requests.push({ kind: 'operation', method, route, delta: query.has('updatedMin'), paged: query.has('pageToken'), writeFields: body ? Object.keys(body).sort() : [] });
    await state.beforeRequest?.({ method, route });
    if (state.failure && (!state.failure.method || state.failure.method === method) && (!state.failure.route || state.failure.route === route)) return error(state.failure.status);
    if (path === listCollection) {
      if (method === 'GET') return { status: 200, body: { items: [...remote.lists.values()] } };
      if (method === 'POST') { const value = { id: `synthetic-list-${++ordinal}`, title: body.title }; remote.lists.set(value.id, value); return { status: 201, body: value }; }
    }
    if (listItem) {
      if (!remote.lists.has(listItem)) return error(404);
      if (method === 'GET') return { status: 200, body: remote.lists.get(listItem) };
      if (method === 'DELETE') { remote.lists.delete(listItem); return { status: 204 }; }
    }
    if (!taskMatch) throw new Error('Unexpected synthetic API path');
    const selectedList = decodeURIComponent(taskMatch[1]), id = taskMatch[2] && decodeURIComponent(taskMatch[2]);
    if (!remote.lists.has(selectedList)) return error(404);
    const taskKey = id;
    if (method === 'GET' && !id) {
      const after = query.get('updatedMin'), offset = Number(query.get('pageToken') ?? 0);
      const all = [...remote.tasks.values()].filter(value => (!value.listId || value.listId === selectedList) && (!after || Date.parse(value.updated) >= Date.parse(after)));
      const items = all.slice(offset, offset + 100).map(({ listId, ...value }) => value);
      return { status: 200, body: { items, ...(offset + 100 < all.length ? { nextPageToken: String(offset + 100) } : {}) } };
    }
    if (method === 'POST') {
      const task = { ...body, id: `synthetic-task-${++ordinal}`, status: 'needsAction', etag: `"synthetic-${++version}"`, updated: clock().toISOString(), listId: selectedList };
      remote.tasks.set(task.id, task); return { status: 201, body: task };
    }
    const task = remote.tasks.get(taskKey); if (!task || task.listId && task.listId !== selectedList) return error(404);
    if (method === 'GET') return { status: 200, body: task };
    if (method === 'PATCH') {
      Object.assign(task, body, { etag: `"synthetic-${++version}"`, updated: clock().toISOString() });
      if (body.status === 'needsAction') { task.completed = null; task.hidden = false; }
      return { status: 200, body: task };
    }
    if (method === 'DELETE') {
      if (new Headers(headers).get('if-match') !== task.etag) return error(412);
      Object.assign(task, { deleted: true, updated: clock().toISOString(), etag: `"synthetic-${++version}"` }); return { status: 204 };
    }
    throw new Error('Unexpected synthetic API method');
  }
  const fetcher = async (resource, init = {}) => {
    const parsed = new URL(resource), method = init.method ?? 'GET', subject = requestSubject(init.headers);
    requests.push({ kind: 'http', method, batch: parsed.pathname === '/batch', subjectHash: digest(subject) });
    let response;
    if (parsed.pathname === '/batch') {
      const boundary = new Headers(init.headers).get('content-type').match(/boundary=([^;\s]+)/)?.[1]; assert.ok(boundary);
      const out = [], responseBoundary = 'synthetic-response-boundary';
      for (const raw of String(init.body).split(`--${boundary}`)) {
        const part = raw.trim(); if (!part || part === '--') continue;
        const headerEnd = part.indexOf('\r\n\r\n'), id = part.slice(0, headerEnd).match(/^Content-ID:\s*<([^>]+)>/im)?.[1]; assert.ok(id);
        const inner = part.slice(headerEnd + 4), match = /^(POST|PATCH|DELETE)\s+(\S+)\s+HTTP\/1\.1/.exec(inner); assert.ok(match);
        const target = new URL(match[2], 'https://tasks.googleapis.com'), bodyStart = inner.indexOf('\r\n\r\n');
        const headers = Object.fromEntries(inner.slice(0, bodyStart).split('\r\n').slice(1).filter(Boolean).map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]; }));
        const body = inner.slice(bodyStart + 4).trim(), result = await dispatch(subject, target.pathname, match[1], target.searchParams, body ? JSON.parse(body) : undefined, headers);
        out.push([`--${responseBoundary}`, 'Content-Type: application/http', `Content-ID: <response-${id}>`, '', `HTTP/1.1 ${result.status} Synthetic`, ...(result.body ? ['Content-Type: application/json', '', JSON.stringify(result.body)] : ['', ''])].join('\r\n'));
      }
      out.push(`--${responseBoundary}--`, ''); response = new Response(out.join('\r\n'), { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${responseBoundary}`, Date: clock().toUTCString() } });
    } else {
      const result = await dispatch(subject, parsed.pathname, method, parsed.searchParams, init.body ? JSON.parse(init.body) : undefined, init.headers);
      response = result.status === 204 ? new Response(null, { status: 204, headers: { Date: clock().toUTCString() } }) : Response.json(result.body, { status: result.status, headers: { Date: clock().toUTCString() } });
    }
    await state.afterResponse?.({ method, batch: parsed.pathname === '/batch' }); return response;
  };
  function api(options = {}) {
    const raw = createGoogleTasksApi(fetcher, undefined, options);
    return Object.fromEntries(Object.entries(raw).map(([name, work]) => [name, async (...args) => {
      apiCalls.push({ method: name, operations: name === 'createTasksBatch' || name === 'patchTasksBatch' ? args[2].length : 1 }); return work(...args);
    }]));
  }
  const mark = () => ({ requests: requests.length, apiCalls: apiCalls.length });
  function counts(since = { requests: 0, apiCalls: 0 }) {
    const recent = requests.slice(since.requests), ports = apiCalls.slice(since.apiCalls), http = recent.filter(x => x.kind === 'http'), operations = recent.filter(x => x.kind === 'operation');
    const methodCounts = rows => rows.reduce((all, row) => { all[row.method] = (all[row.method] ?? 0) + 1; return all; }, {});
    return { http: http.length, httpMethods: methodCounts(http), providerOperations: operations.length, providerMethods: methodCounts(operations),
      deltaPages: operations.filter(x => x.method === 'GET' && x.route === 'task-page' && x.delta).length, fullPages: operations.filter(x => x.method === 'GET' && x.route === 'task-page' && !x.delta).length,
      apiPorts: methodCounts(ports), batchSizes: ports.filter(x => x.method.endsWith('Batch')).map(x => x.operations) };
  }
  function touch(subject, id, change) { const task = account(subject).tasks.get(id); assert.ok(task); Object.assign(task, change, { updated: clock().toISOString(), etag: `"synthetic-${++version}"` }); return task; }
  return { api, token, account, touch, state, mark, counts, digest: subject => digest([...account(subject).tasks.values()]), requests, apiCalls };
}


/** Actual native Tasks boundaries; only OAuth, provider IO and Cloud IO are synthetic. */
export async function recoveryFixture(t, { multiple = false } = {}) {
  const clock = () => new Date('2026-10-27T01:00:00Z');
  const family = await fixture({ clock }); const namespace = v2NativeWorkspaceNamespace('owner', groupId);
  const cloud = memoryTaskClaims(namespace), server = transport({ clock, initialList: false });
  const directory = mkdtempSync(join(tmpdir(), 'liflow-shared-task-recovery-')); const databasePath = join(directory, 'test.db');
  const hooks = {}; let ordinal = 0, device, store, runtime, context;
  const subject = 'synthetic-google-subject'; server.account(subject);
  const claims = { ...cloud.cloud, linked: async (...args) => {
    await hooks.beforeClaimLink?.(...args); await cloud.cloud.linked(...args); await hooks.afterClaimLink?.(...args);
  } };
  server.state.beforeRequest = async event => { if (event.method === 'GET' && event.route === 'task-item') await hooks.beforeGet?.(); };
  async function open(initial) {
    device = await family.device('owner', family.owner, databasePath);
    if (initial) { const seed = seeds(); if (!multiple) seed[3].payload.configuration.intervalDays = 365; await device.repository.commit(seed); }
    store = createV2GoogleTaskStore({ repository: device.repository, userId: 'owner', groupId, assertAccess: () => {}, makeId: () => `recovery-${++ordinal}`, now: clock });
    const journal = store.port.taskCreateJournal;
    store.port.taskCreateJournal = { ...journal, read: async identity => {
      const value = await journal.read(identity); return hooks.receipt ? hooks.receipt(value) : value;
    } };
    runtime = createV2GoogleTaskRuntime({ store, now: clock, assertAccess: () => {},
      currentSubject: async () => subject, token: async () => server.token(subject),
      restoreAccount: async () => ({ subject, label: 'synthetic' }), authorizeTasks: async () => {},
      createApi: value => { context = value; return server.api({ budget: value.budget }); },
      resolveTaskList: (request, value) => resolveSharedGoogleTaskList(request, { namespace, cloud: () => claims, journal: store.port.taskCreateJournal, makeId: () => `claim-${++ordinal}`, context: value }),
      verifyTaskListForLocalChanges: (state, value) => verifySharedTaskListForLocalChanges(state, { namespace, cloud: () => claims, context: value }),
      wrapCreateJournal: (local, value) => sharedTaskCreateJournal(local, claims, value),
    });
  }
  await open(true); const review = await runtime.reviewConnection(); await runtime.connect(review);
  t.after(async () => { await withGoogleSyncOperation(async () => {}); device.connection.close(); });
  const rows = () => device.connection.prepare('SELECT * FROM sharing_operations ORDER BY operation_id').all();
  const originals = digest(rows());
  const intents = () => device.connection.prepare("SELECT * FROM private_google_task_create_intents WHERE task_list_id<>'reserved:shared-task-list:v1' ORDER BY occurrence_marker").all();
  return { server, cloud, hooks, subject, namespace, databasePath,
    get device() { return device; }, get store() { return store; }, get runtime() { return runtime; },
    factsDigest: () => digest(rows()), originals, intents,
    async run(options = {}) { const result = await runtime.synchronize({ force: true, ...options }); await withGoogleSyncOperation(async () => {}); return result; },
    async restart() { await withGoogleSyncOperation(async () => {}); device.connection.close(); await open(false); },
    async loseCreateReply() {
      let lost = false; server.state.afterResponse = async event => { if (event.batch && !lost) { lost = true; throw new TypeError('synthetic reply lost after provider commit'); } };
      const result = await this.run(); server.state.afterResponse = null; assert.equal(result.kind, 'retry');
      assert.ok(server.account(subject).tasks.size > 0); assert.equal((await store.readSavedLinks()).length, 0); return result;
    },
    cancel: () => context.budget.cancel(),
    taskClaims: () => [...cloud.rows.values()].filter(row => row.phase === 'reserved'),
  };
}
