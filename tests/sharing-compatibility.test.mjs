import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import createQr from 'qrcode-generator';
import decodeQr from 'jsqr';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { createSharedInvitation, encodeCompactSharedInvitation, encodeSharedInvitation, parseSharedInvitation } from '../src/features/sharing/invitations.ts';
import { sharingInvitationQr } from '../src/features/sharing/invitation-qr.ts';
import { sharedDateAtTime } from '../src/features/sharing/group-clock.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { assertSharedSchedulerVersion, verifySharedSchedulerContract, verifyV2SharedSchedulerContract, sharedSchedulerSourceDigest,
  assertPersonalSchedulerVersion, verifyPersonalSchedulerContract, assertPersonalPlannerIsolation } from '../scripts/check-shared-scheduler-version.mjs';
import { sharedGoogleNamespace, sharedGoogleListTitle, sharedGoogleOccurrenceNote } from '../src/features/google-sync/workspace-policy.ts';
const { syncDailyHouseworkDigest, createDailyHouseworkDigestRequests } = await import('../src/features/notifications/daily-housework-digest.ts');
const { reconcileGoogleTasks } = await import('../src/features/google-sync/reconcile-google-tasks.ts');
const { subscribeToGooglePlannerChanges, notifyGooglePlannerChanges } = await import('../src/features/google-sync/planner-change-events.ts');
const repository = await import('../src/platform/storage/repository.ts');

test('compact and original invitation links retain identical signed data and an independent QR reader decodes the actual URL', async () => {
  const identity = await createDeviceIdentity(crypto); const roster = createSharedRoster('group-test', 'owner', identity);
  const now = Date.now(); const link = await createSharedInvitation(crypto, roster, identity, 'invite-test', now);
  const original = encodeSharedInvitation(link); const compact = encodeCompactSharedInvitation(link);
  assert.ok(compact.length < original.length * 0.8);
  assert.deepEqual(parseSharedInvitation(original, now), parseSharedInvitation(compact, now));
  const output = sharingInvitationQr(compact, now); const matrix = createQr(0, 'M'); matrix.addData(compact, 'Byte'); matrix.make();
  assert.equal(output.modules, matrix.getModuleCount()); assert.ok(output.uri.startsWith('data:image/gif;base64,'), 'native data URI decoding requires the base64 image format');
  const gif = Buffer.from(output.uri.split(',')[1], 'base64'); assert.match(gif.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/);
  assert.equal(gif.readUInt16LE(6), (output.modules + 8) * 4); assert.equal(gif.readUInt16LE(8), (output.modules + 8) * 4);
  const scale = 4; const quiet = 4; const size = (output.modules + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / scale) - quiet; const col = Math.floor(x / scale) - quiet;
    if (row >= 0 && col >= 0 && row < output.modules && col < output.modules && matrix.isDark(row, col)) {
      const offset = (y * size + x) * 4; rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  assert.equal(decodeQr(rgba, size, size, { inversionAttempts: 'dontInvert' })?.data, compact);
  assert.throws(() => sharingInvitationQr(compact, now + 3600001), /期限/);
  const tuple = JSON.parse(decodeURIComponent(compact.split('#v2=')[1])); tuple[6] = 'another-account';
  assert.throws(() => parseSharedInvitation('houseworkplanner://sharing/join#v2=' + encodeURIComponent(JSON.stringify(tuple)), now));
});

test('shared reminder instants are independent of the device timezone and handle DST gaps, folds and fractional-hour zones', () => {
  const old = process.env.TZ;
  try {
    for (const deviceZone of ['Asia/Tokyo', 'UTC', 'Pacific/Honolulu', 'America/New_York']) {
      process.env.TZ = deviceZone;
      assert.equal(sharedDateAtTime('2026-10-27', 9, 0, 'Asia/Tokyo').toISOString(), '2026-10-27T00:00:00.000Z');
      assert.equal(sharedDateAtTime('2026-03-08', 2, 30, 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
      assert.equal(sharedDateAtTime('2026-11-01', 1, 30, 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
      assert.equal(sharedDateAtTime('2026-10-27', 9, 0, 'Asia/Kathmandu').toISOString(), '2026-10-27T03:15:00.000Z');
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('older Android Intl data cannot change shared civil dates in zones whose rules changed after Android 10', () => {
  const original = Intl.DateTimeFormat;
  try {
    Intl.DateTimeFormat = class { constructor() { throw new Error('old or unavailable OS timezone data'); } };
    assert.equal(sharedLocalDate(new Date('2026-07-01T05:00:00Z'), 'America/Mexico_City'), '2026-06-30');
    assert.equal(sharedLocalDate(new Date('2026-07-01T03:00:00Z'), 'America/Coyhaique'), '2026-07-01');
    assert.equal(sharedDateAtTime('2026-10-04', 2, 15, 'Australia/Lord_Howe').toISOString(), '2026-10-03T15:45:00.000Z');
  } finally { Intl.DateTimeFormat = original; }
});

test('shared scheduler and timezone source changes require a versioned compatibility contract', () => {
  const current = verifySharedSchedulerContract();
  assertSharedSchedulerVersion(current, current);
  assert.throws(() => assertSharedSchedulerVersion({ ...current, sourceSha256: 'a'.repeat(64) }, current), /without/);
  assert.throws(() => assertSharedSchedulerVersion({ ...current, timeZoneVersion: 'future' }, current), /without/);
  assertSharedSchedulerVersion({ ...current, version: 'liflow-shared-2', sourceSha256: 'a'.repeat(64) }, current);
});

test('v2 draft scheduler has an independent source and timezone contract without changing the live v1 contract', () => {
  const live = verifySharedSchedulerContract(); const draft = verifyV2SharedSchedulerContract();
  assert.equal(live.version, 'liflow-shared-1'); assert.match(draft.version, /^liflow-shared-2-draft-\d+$/u);
  for (const file of ['model', 'payload-schema', 'approval-deadline', 'receiver-authority', 'occurrence-id', 'common-frames', 'rule-target', 'server-receipts']) {
    assert.ok(draft.sourceFiles.includes(`src/features/sharing/v2/${file}.ts`));
  }
  assert.ok(draft.sourceFiles.includes('node_modules/moment-timezone/data/packed/latest.json'));
  assert.ok(draft.sourceFiles.includes('src/domain/scheduling/local-date.ts'));
  assert.throws(() => assertSharedSchedulerVersion(draft, draft), /Invalid/);
  assertSharedSchedulerVersion(draft, draft, { allowDraft: true });
  assert.throws(() => assertSharedSchedulerVersion({ ...draft, sourceSha256: 'a'.repeat(64) }, draft, { allowDraft: true }), /without/);
  assert.throws(() => assertSharedSchedulerVersion({ ...draft, timeZoneVersion: 'future' }, draft, { allowDraft: true }), /without/);
  const files = ['src/features/sharing/v2/model.ts', 'src/features/sharing/v2/receiver-authority.ts'];
  assert.notEqual(sharedSchedulerSourceDigest(files, () => Buffer.from('original')),
    sharedSchedulerSourceDigest(files, (file) => Buffer.from(file.endsWith('receiver-authority.ts') ? 'changed' : 'original')));
});

test('personal recommendations have a separate version contract while formal shared state cannot import private calendars', () => {
  const local = verifyPersonalSchedulerContract(); const common = verifyV2SharedSchedulerContract();
  assertPersonalSchedulerVersion(local, local);
  assert.throws(() => assertPersonalSchedulerVersion({ ...local, sourceSha256: 'a'.repeat(64) }, local), /without/);
  assert.throws(() => assertPersonalSchedulerVersion({ ...local, sourceFiles: [] }, local), /Invalid/);
  assertPersonalSchedulerVersion({ ...local, version: 'liflow-personal-2', sourceSha256: 'a'.repeat(64) }, local);
  for (const file of local.sourceFiles) assert.equal(common.sourceFiles.includes(file), false);
  const visited = assertPersonalPlannerIsolation(); assert.ok(visited.has('src/features/sharing/v2/common-plan.ts'));
  for (const statement of ["import { buildV2PersonalPlan } from './personal-plan';", "export * from './private-availability';", "const x = import('../../calendar/events');"]) {
    assert.throws(() => assertPersonalPlannerIsolation(file => file.endsWith('/common-plan.ts') ? statement : ''), /Shared formal state imports personal calendar/u);
  }
});

test('personal and shared reminders use separate namespaces; disabling or refreshing one cannot cancel another', async () => {
  const requests = new Map(); const gateway = { hasPermission: async () => true, getScheduledRequests: async () => [...requests.values()],
    schedule: async (request) => { requests.set(request.key, request); return request.key; }, cancel: async (key) => { requests.delete(key); } };
  const now = new Date('2026-10-26T22:00:00Z');
  const base = { settings: { notificationsEnabled: true, setupCompleted: true, notificationHour: 9, notificationMinute: 0 },
    chores: [{ id: 'floor', name: '床掃除', enabled: true }], completions: [], scheduleEntries: [{ id: 'floor:initial', householdId: 'home', choreId: 'floor',
      cycleBaseDate: '2026-10-27', suggestedDate: '2026-10-27', windowStart: '2026-10-27', windowEnd: '2026-10-29', status: 'inWindow', assignedMemberIds: [] }] };
  const group = { ...base, timeZone: 'Asia/Tokyo', notificationScope: sharedGoogleNamespace('owner', 'group-a'), notificationTitle: 'わが家の家事' };
  await syncDailyHouseworkDigest(gateway, base, now); const personalIds = [...requests.keys()];
  await syncDailyHouseworkDigest(gateway, group, now); assert.ok(requests.size > personalIds.length);
  const groupIds = [...requests.keys()].filter((key) => !personalIds.includes(key));
  assert.equal(createDailyHouseworkDigestRequests(group, now)[0].fireAt, '2026-10-27T00:00:00.000Z');
  await syncDailyHouseworkDigest(gateway, base, now); for (const key of groupIds) assert.ok(requests.has(key));
  await syncDailyHouseworkDigest(gateway, { ...group, settings: { ...group.settings, notificationsEnabled: false } }, now);
  assert.deepEqual([...requests.keys()], personalIds);
});

test('Google planner notifications are scoped so a shared import cannot refresh the personal widget provider', () => {
  const calls = [];
  const off = [subscribeToGooglePlannerChanges(() => { calls.push('personal'); }), subscribeToGooglePlannerChanges(() => { calls.push('a'); }, 'group-a'),
    subscribeToGooglePlannerChanges(() => { calls.push('b'); }, 'group-b')];
  try { notifyGooglePlannerChanges('group-a'); assert.deepEqual(calls, ['a']); notifyGooglePlannerChanges(); assert.deepEqual(calls, ['a', 'personal']); }
  finally { off.forEach((unsubscribe) => unsubscribe()); }
});

test('shared Google Tasks adopt only an exact workspace/occurrence marker and keep the same remote ID when due changes', async () => {
  const namespace = sharedGoogleNamespace('owner', 'group-a'); const other = sharedGoogleNamespace('owner', 'group-b');
  assert.notEqual(namespace, other); assert.notEqual(namespace, sharedGoogleNamespace('another-user', 'group-a'));
  const lists = [{ id: 'personal', title: '家事Planner' }, { id: 'shared', title: sharedGoogleListTitle(namespace) }];
  const remote = new Map([['unmarked', { id: 'unmarked', title: '床掃除', due: '2026-10-27T00:00:00.000Z', status: 'needsAction' }],
    ['other', { id: 'other', title: '床掃除', due: '2026-10-27T00:00:00.000Z', status: 'needsAction', notes: sharedGoogleOccurrenceNote(other, 'occurrence') }]]);
  const links = new Map(); const events = []; let generated = 0;
  const entry = { id: 'occurrence', choreId: 'floor', householdId: 'home', windowStart: '2026-10-27', windowEnd: '2026-10-29', suggestedDate: '2026-10-27', status: 'inWindow', assignedMemberIds: [] };
  const api = { listTaskLists: async () => lists, listTasks: async (_token, list) => { assert.equal(list, 'shared'); return [...remote.values()]; },
    createTaskList: async () => { throw new Error('wrong list'); }, getTask: async (_token, _list, id) => remote.get(id),
    createTask: async (_token, _list, draft) => { events.push('create'); const task = { id: `created-${++generated}`, ...draft, status: 'needsAction' }; remote.set(task.id, task); return task; },
    patchTask: async (_token, _list, id, patch) => { events.push('patch'); Object.assign(remote.get(id), patch); return remote.get(id); }, deleteTask: async () => { throw new Error('unexpected deletion'); } };
  const port = { taskNamespace: namespace, listEntriesForGoogleSync: async () => [{ entry, choreName: '床掃除' }], listGoogleTaskLinks: async () => [...links.values()],
    upsertGoogleTaskLink: async (link) => { links.set(link.scheduleEntryId, link); }, deleteGoogleTaskLink: async (id) => { links.delete(id); },
    importGoogleTaskChanges: async () => 0, acknowledgeGoogleTaskStatus: async () => {} };
  const options = { accessToken: 'test', state: { householdId: 'home' }, repository: port, api, today: '2026-10-27', now: new Date('2026-10-27T02:00:00Z') };
  assert.equal((await reconcileGoogleTasks(options)).created, 1); assert.equal(links.get('occurrence').googleTaskId, 'created-1');
  assert.equal(remote.get('created-1').notes, sharedGoogleOccurrenceNote(namespace, 'occurrence'));
  links.clear(); entry.suggestedDate = '2026-11-03'; remote.get('created-1').due = undefined;
  const moved = await reconcileGoogleTasks(options); assert.equal(moved.created, 0); assert.equal(moved.updated, 1);
  assert.equal(links.get('occurrence').googleTaskId, 'created-1'); assert.equal(remote.get('created-1').due, '2026-11-03T00:00:00.000Z');
  assert.deepEqual(events, ['create', 'patch']); assert.equal(remote.size, 3);
});

test('v19 disconnect metadata preserves personal Google account binding, remote IDs, history and the paused/connected distinction', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const state = { householdId: repository.LOCAL_HOUSEHOLD_ID, enabled: true, taskListId: 'owned-list', accountSubject: 'google-subject', status: 'idle', retryCount: 0, updatedAt: new Date().toISOString() };
    await repository.saveGoogleSyncState(h.database, state);
    await repository.saveGoogleSyncState(h.database, { ...state, enabled: false }); assert.equal((await repository.loadGoogleSyncState(h.database)).disconnected, undefined);
    await repository.saveGoogleSyncState(h.database, { ...state, enabled: false, disconnected: true });
    const disconnected = await repository.loadGoogleSyncState(h.database); assert.equal(disconnected.disconnected, true); assert.equal(disconnected.accountSubject, 'google-subject'); assert.equal(disconnected.taskListId, 'owned-list');
    await assert.rejects(repository.saveGoogleSyncState(h.database, { ...disconnected, enabled: true }), /再接続/);
    await repository.saveGoogleSyncState(h.database, { ...disconnected, enabled: true, disconnected: false }); assert.equal((await repository.loadGoogleSyncState(h.database)).disconnected, undefined);
  } finally { h.connection.close(); }
});
