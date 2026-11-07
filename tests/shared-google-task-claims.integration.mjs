import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../src/features/sharing/roster.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { fixture, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { applyReceivedSharedFacts, loadSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { createV2GoogleTaskStore } from '../src/platform/storage/sharing-v2-google-tasks.ts';
import { sharedGoogleListTitle, sharedGoogleOccurrenceNote } from '../src/features/google-sync/workspace-policy.ts';
import { sharedTaskClaimKey, reserveSharedTaskClaim } from '../src/features/google-sync/shared-task-claim.ts';
import { createSharedGoogleTaskClaims } from '../src/platform/sharing/google-task-claims.ts';
import { sharedTaskCreateJournal } from '../src/features/google-sync/shared-task-create-journal.ts';
import { resolveSharedGoogleTaskList, sharedTaskListIdentity } from '../src/features/google-sync/shared-task-list.ts';
import { sharedTaskIdHash } from '../src/features/google-sync/shared-task-claim.ts';
import { createGoogleOperationBudget } from '../src/features/google-sync/operation-budget.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
const { reconcileGoogleTasks } = await import('../src/features/google-sync/reconcile-google-tasks.ts');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Use the isolated Firestore emulator only.');
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });
const namespace = 'private-test-scope';
const identity = { accountSubject: 'private-provider-account', taskListId: 'private-task-list', occurrenceMarker: sharedGoogleOccurrenceNote(namespace, 'one') };
const intent = n => ({ ...identity, attemptId: `device-attempt-${n}`, startedAt: '2026-11-05T00:00:00Z' });
const client = (userId = 'owner', scope = namespace, check = async () => {}) => {
  const firestore = env.authenticatedContext(userId).firestore();
  return { firestore, cloud: createSharedGoogleTaskClaims({ firestore, userId, namespace: scope, currentUserId: () => userId, assertCurrent: check }) };
};
const reference = firestore => sdk.doc(firestore, 'privateGoogleTaskClaims', 'owner', 'occurrences', sharedTaskClaimKey(namespace, identity).occurrenceHash);

test('Firestore arbitration covers the first shared Tasks list before independent device databases can insert duplicate tasks', async () => {
  const devices = [await googleFixture(), await googleFixture()];
  const lists = []; const tasks = new Map(); const budgets = devices.map(() => createGoogleOperationBudget(100_000));
  let reads = 0; let resume; const initialRead = new Promise(resolve => { resume = resolve; });
  const api = {
    async listTaskLists() { const result = structuredClone(lists); if (++reads <= 2) { if (reads === 2) resume(); await initialRead; } return result; },
    async createTaskList(_token, title) { const row = { id: `private-provider-list-${lists.length + 1}`, title }; lists.push(row); return { ...row }; },
    async listTasks(_token, list) { return structuredClone([...tasks.values()].filter(row => row.list === list)); },
    async createTask(_token, list, draft) { const row = { ...draft, id: `private-provider-task-${tasks.size + 1}`, list, status: 'needsAction' }; tasks.set(row.id, row); return { ...row }; },
    async getTask(_token, _list, id) { return structuredClone(tasks.get(id)); },
    async patchTask() { throw new Error('unexpected patch'); }, async deleteTask() { throw new Error('unexpected delete'); },
  };
  try {
    await Promise.all(devices.map(h => h.connect())); let sequence = 0;
    const ports = devices.map((h, i) => {
      const context = { budget: budgets[i], assertCurrent: async () => h.scope.assertAccess() };
      const { cloud } = client('owner', h.namespace);
      return { ...h.store.port, taskReadCache: undefined,
        taskCreateJournal: sharedTaskCreateJournal(h.store.port.taskCreateJournal, cloud, context),
        resolveTaskList: request => resolveSharedGoogleTaskList(request, { namespace: h.namespace, cloud: () => cloud, makeId: () => `list-attempt-${++sequence}`, context }) };
    });
    const sync = async i => reconcileGoogleTasks({ state: (await devices[i].store.readControl()).state, accessToken: 'private-provider-token',
      repository: ports[i], api, now: now(), today: await devices[i].store.readToday() });
    const first = await Promise.allSettled([sync(0), sync(1)]);
    assert.ok(first.some(row => row.status === 'fulfilled'));
    for (const row of first) if (row.status === 'rejected') assert.ok(['task_create_result_pending', 'task_list_create_result_pending'].includes(row.reason.code));
    await sync(0); await sync(1);
    assert.equal(lists.length, 1); assert.equal(tasks.size, 3);
    const mappings = await Promise.all(devices.map(h => h.links()));
    assert.equal(mappings[0].length, 3); assert.deepEqual(mappings[0].map(row => row.googleTaskId).sort(), mappings[1].map(row => row.googleTaskId).sort());
    await env.withSecurityRulesDisabled(async admin => {
      const rows = await sdk.getDocs(sdk.collection(admin.firestore(), 'privateGoogleTaskClaims', 'owner', 'occurrences'));
      assert.equal(rows.size, 4); assert.ok(rows.docs.every(row => row.data().phase === 'linked'));
      const data = JSON.stringify(rows.docs.map(row => row.data()));
      for (const raw of ['private-provider-list-', 'private-provider-task-', 'private-provider-token', 'synthetic-google-subject', 'LiFlow occurrence:']) assert.equal(data.includes(raw), false);
    });
  } finally { budgets.forEach(budget => budget.close()); devices.forEach(h => h.close()); }
});

test('canonical list reads require fresh owner-authorized server data and reject cached grants or a changed account', async () => {
  const owner = client(); const listIdentity = sharedTaskListIdentity(namespace, 'private-provider-account');
  assert.equal(await owner.cloud.read(listIdentity), null);
  await owner.cloud.linked(listIdentity, 'private-list');
  const linked = await owner.cloud.read(listIdentity); assert.equal(linked.taskHash, sharedTaskIdHash('private-list'));
  assert.equal(JSON.stringify(linked).includes('private-list'), false);
  const other = client('other');
  assert.equal(await other.cloud.read(listIdentity), null, 'another account reads only its own independent namespace');
  const forgedOwner = createSharedGoogleTaskClaims({ firestore: other.firestore, userId: 'owner', namespace,
    currentUserId: () => 'owner', assertCurrent: async () => {} });
  await assertFails(forgedOwner.read(listIdentity));
  await sdk.disableNetwork(owner.firestore);
  await assert.rejects(owner.cloud.read(listIdentity));
  await sdk.enableNetwork(owner.firestore);
  let current = 'owner';
  const module = loadNativeModule('src/platform/sharing/google-task-claims.ts', {
    'firebase/firestore': { ...sdk, async getDocFromServer(...args) { const result = await sdk.getDocFromServer(...args); current = 'other'; return result; } },
    '../../features/google-sync/shared-task-claim.ts': await import('../src/features/google-sync/shared-task-claim.ts'),
    '../../features/sharing/identifier.ts': await import('../src/features/sharing/identifier.ts'),
  });
  const changed = module.createSharedGoogleTaskClaims({ firestore: owner.firestore, userId: 'owner', namespace,
    currentUserId: () => current, assertCurrent: async () => {} });
  await assert.rejects(changed.read(listIdentity), /本人アカウント/u);
  assert.deepEqual(await owner.cloud.read(listIdentity), linked);
});

test('independent v2 device databases with the same empty Google snapshot receive one atomic creation grant and converge on one task ID', async () => {
  const family = await fixture(); const secondIdentity = await createDeviceIdentity(sharingTestCrypto);
  family.archive.push(approveSharedDevice(family.archive.at(-1), family.owner, 'owner', secondIdentity));
  const h = await googleFixture({ shared: family }); const right = await family.device('owner', secondIdentity); const budgets = [];
  try {
    const facts = await loadSharedFacts(h.d.database, groupId);
    await applyReceivedSharedFacts(right.database, groupId, facts, '4', right.repository.project, null, now().getTime(), right.repository.evidenceForServerReceipts(receiptsFor(facts)));
    let ordinal = 0;
    const other = createV2GoogleTaskStore({ ...h.scope, repository: right.repository, makeId: () => `right-attempt-${++ordinal}` });
    await h.connect(); await other.configure(0, { subject: 'synthetic-google-subject', label: '検査用' }, true);
    h.lists.push({ id: 'v2-private-list', title: sharedGoogleListTitle(h.namespace) });
    let reads = 0; let release; const barrier = new Promise(resolve => { release = resolve; });
    const api = { ...h.api, async listTasks() {
      const snapshot = structuredClone([...h.tasks.values()]);
      if (++reads <= 2) { if (reads === 2) release(); await barrier; }
      return snapshot;
    } };
    const stores = [h.store, other];
    const ports = stores.map(store => {
      const budget = createGoogleOperationBudget(100000); budgets.push(budget);
      return { ...store.port, taskReadCache: undefined, taskCreateJournal: sharedTaskCreateJournal(store.port.taskCreateJournal,
        client('owner', h.namespace).cloud, { budget, assertCurrent: async () => {} }) };
    });
    const sync = async index => reconcileGoogleTasks({ accessToken: 'synthetic-token', state: (await stores[index].readControl()).state,
      repository: ports[index], api, now: now(), today: '2026-10-27' });
    const first = await Promise.allSettled([sync(0), sync(1)]);
    assert.equal(first.filter(result => result.status === 'fulfilled').length, 1);
    const held = first.find(result => result.status === 'rejected'); assert.equal(held.reason.code, 'task_create_result_pending');
    const expected = (await h.entries()).filter(item => item.entry.suggestedDate <= '2026-11-10').length;
    assert.ok(expected > 0); assert.equal(h.tasks.size, expected); assert.equal(new Set([...h.tasks.values()].map(task => task.notes)).size, expected);
    assert.equal((await sync(0)).created, 0); assert.equal((await sync(1)).created, 0);
    const linked = await Promise.all(stores.map(store => store.port.listGoogleTaskLinks(h.namespace)));
    assert.deepEqual(linked[0].map(row => row.googleTaskId).sort(), linked[1].map(row => row.googleTaskId).sort());
    assert.equal(h.calls.filter(call => call[0] === 'create').length, expected);
    const shared = JSON.stringify(await loadSharedFacts(h.d.database, groupId));
    assert.equal(shared, JSON.stringify(facts), 'Google arbitration never writes signed household data');
    await env.withSecurityRulesDisabled(async admin => {
      const rows = await sdk.getDocs(sdk.collection(admin.firestore(), 'privateGoogleTaskClaims', 'owner', 'occurrences'));
      assert.equal(rows.size, expected); const data = JSON.stringify(rows.docs.map(row => row.data()));
      for (const secret of ['synthetic-google-subject', 'v2-private-list', 'synthetic-token', '床を掃除する', 'LiFlow occurrence:']) assert.equal(data.includes(secret), false);
      assert.ok(rows.docs.every(row => row.data().phase === 'linked'));
    });
  } finally { budgets.forEach(budget => budget.close()); h.close(); right.connection.close(); }
});

test('private Tasks creation receipts deny other accounts enumeration plaintext payloads forged times and unsafe state rewrites', async () => {
  const owner = client(); const other = client('member'); const ref = reference(owner.firestore);
  assert.deepEqual(await owner.cloud.reserveBatch([intent('one')]), [true]);
  const original = (await sdk.getDocFromServer(ref)).data();
  await assertFails(sdk.getDocFromServer(reference(other.firestore)));
  await assertFails(sdk.getDocs(sdk.collection(owner.firestore, 'privateGoogleTaskClaims', 'owner', 'occurrences')));
  await assertFails(sdk.deleteDoc(ref));
  for (const patch of [{ phase: 'reserved', revision: 2 }, { phase: 'linked', revision: 2, taskHash: 'unsafe' },
    { phase: 'released', revision: 2, attemptId: 'someone-else' }, { scopeHash: 'f'.repeat(64), phase: 'released', revision: 2 },
    { phase: 'released', revision: 2, oauthToken: 'forbidden' }]) await assertFails(sdk.updateDoc(ref, { ...patch, updatedAt: sdk.serverTimestamp() }));
  const fresh = intent('other'); fresh.occurrenceMarker = sharedGoogleOccurrenceNote(namespace, 'other');
  const key = sharedTaskClaimKey(namespace, fresh); const body = reserveSharedTaskClaim(null, key, fresh);
  const newRef = sdk.doc(owner.firestore, 'privateGoogleTaskClaims', 'owner', 'occurrences', key.occurrenceHash);
  await assertFails(sdk.setDoc(newRef, { ...body, createdAt: sdk.Timestamp.fromMillis(1), updatedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(sdk.doc(other.firestore, ref.path), { ...original, createdAt: sdk.serverTimestamp(), updatedAt: sdk.serverTimestamp() }));
  assert.deepEqual((await sdk.getDocFromServer(ref)).data(), original);
});

test('private Tasks creation receipts obey paid access expiry without releasing another device reservation', async () => {
  const owner = client(); const ref = reference(owner.firestore);
  assert.deepEqual(await owner.cloud.reserveBatch([intent('original')]), [true]);
  const original = (await sdk.getDocFromServer(ref)).data();
  const configure = data => env.withSecurityRulesDisabled(async admin => {
    await sdk.setDoc(sdk.doc(admin.firestore(), 'serviceConfiguration', 'billing'), { enforced: true });
    if (data) await sdk.setDoc(sdk.doc(admin.firestore(), 'billingEntitlements', 'owner'), data);
  });
  await configure();
  await assertFails(sdk.getDocFromServer(ref));
  await assertFails(owner.cloud.reject(intent('original')));
  const other = { ...intent('new'), occurrenceMarker: sharedGoogleOccurrenceNote(namespace, 'new') };
  await assertFails(owner.cloud.reserveBatch([other]));
  await configure({ userId: 'owner', status: 'active', validUntil: 1, expiresAt: 1 });
  await assertFails(owner.cloud.linked(identity, 'not-authorized'));
  await configure({ userId: 'someone-else', status: 'active', validUntil: Date.now() + 60000, expiresAt: Date.now() + 60000 });
  await assertFails(sdk.getDocFromServer(ref));
  await configure({ userId: 'owner', status: 'grace', validUntil: Date.now() + 60000, expiresAt: Date.now() + 60000 });
  assert.deepEqual((await sdk.getDocFromServer(ref)).data(), original);
  assert.deepEqual(await owner.cloud.reserveBatch([intent('another-device')]), [false]);
});

test('Cloud Tasks receipts preserve ambiguous grants across a stopped device and release only matching definitive outcomes', async () => {
  const left = client(); const right = client();
  assert.deepEqual(await left.cloud.reserveBatch([intent('left')]), [true]);
  assert.deepEqual(await right.cloud.reserveBatch([{ ...intent('right'), startedAt: '2099-01-01T00:00:00Z' }]), [false]);
  await right.cloud.reject(intent('not-the-sender')); assert.deepEqual(await right.cloud.reserveBatch([intent('right')]), [false]);
  await left.cloud.reject(intent('left')); assert.deepEqual(await right.cloud.reserveBatch([intent('right')]), [true]);
  await right.cloud.linked(identity, 'actual-task', intent('right').attemptId);
  await assert.rejects(left.cloud.linked(identity, 'different-task'), /対応記録/u);
  await left.cloud.deleted(identity, 'different-task'); assert.deepEqual(await left.cloud.reserveBatch([intent('third')]), [false]);
  await right.cloud.deleted(identity, 'actual-task'); assert.deepEqual(await left.cloud.reserveBatch([intent('third')]), [true]);
});

test('a Cloud commit with a lost response or a subsequent owner change never grants another device an unsafe retry', async () => {
  const owner = client(); let current = 'owner';
  const module = loadNativeModule('src/platform/sharing/google-task-claims.ts', {
    'firebase/firestore': { ...sdk, async runTransaction(...args) { await sdk.runTransaction(...args); throw Object.assign(new Error('lost Cloud response'), { code: 'unavailable' }); } },
    '../../features/google-sync/shared-task-claim.ts': await import('../src/features/google-sync/shared-task-claim.ts'),
    '../../features/sharing/identifier.ts': await import('../src/features/sharing/identifier.ts'),
  });
  const lost = module.createSharedGoogleTaskClaims({ firestore: owner.firestore, userId: 'owner', namespace, currentUserId: () => current, assertCurrent: async () => {} });
  await assert.rejects(lost.reserveBatch([intent('first')]), /lost Cloud response/u);
  assert.deepEqual(await client().cloud.reserveBatch([intent('second')]), [false]);
  current = 'other'; await assert.rejects(lost.reject(intent('first')), /本人アカウント/u);
  assert.equal((await sdk.getDocFromServer(reference(owner.firestore))).data().phase, 'reserved');
});

test('Cloud Tasks reserves one bounded100-item chunk and rejects duplicates or overflow without any claim writes', async () => {
  const h = client(); const intents = Array.from({ length: 100 }, (_, n) => ({ ...intent(n), occurrenceMarker: sharedGoogleOccurrenceNote(namespace, `round-${n}`) }));
  assert.deepEqual(await h.cloud.reserveBatch(intents), Array(100).fill(true));
  assert.deepEqual(await client().cloud.reserveBatch(intents.map(row => ({ ...row, attemptId: `other.${row.attemptId}` }))), Array(100).fill(false));
  await assert.rejects(h.cloud.reserveBatch([intents[0], intents[0]]), /同じGoogle家事/u);
  await assert.rejects(h.cloud.reserveBatch([...intents, intents[0]]), /100/u);
  await h.cloud.rejectBatch(intents.map((row, index) => index < 50 ? { ...row, attemptId: 'not-the-sender' } : row));
  assert.deepEqual(await client().cloud.reserveBatch(intents.map(row => ({ ...row, attemptId: `retry.${row.attemptId}` }))),
    [...Array(50).fill(false), ...Array(50).fill(true)]);
  await assert.rejects(h.cloud.rejectBatch([...intents, intents[0]]), /100/u);
});

test('Cloud Tasks captures caller identities before async waits and cancels a late transaction before writing any grant', async () => {
  const owner = client(); let resume; const waiting = new Promise(resolve => { resume = resolve; });
  const cloud = createSharedGoogleTaskClaims({ firestore: owner.firestore, userId: 'owner', namespace, currentUserId: () => 'owner', assertCurrent: () => waiting });
  const request = intent('captured'); const accepted = cloud.reserveBatch([request]);
  request.accountSubject = 'changed-after-call'; request.occurrenceMarker = sharedGoogleOccurrenceNote(namespace, 'changed-after-call'); resume();
  assert.deepEqual(await accepted, [true]); assert.equal((await sdk.getDocFromServer(reference(owner.firestore))).data().attemptId, 'device-attempt-captured');
  assert.equal((await sdk.getDocFromServer(sdk.doc(owner.firestore, 'privateGoogleTaskClaims', 'owner', 'occurrences', sharedTaskClaimKey(namespace, request).occurrenceHash))).exists(), false);

  let tick = 0; const budget = createGoogleOperationBudget(100, () => tick);
  try {
    const module = loadNativeModule('src/platform/sharing/google-task-claims.ts', {
      'firebase/firestore': { ...sdk, runTransaction: (firestore, body, options) => sdk.runTransaction(firestore, transaction => body({
        get: async ref => { const value = await transaction.get(ref); tick = 101; return value; }, set: (...args) => transaction.set(...args),
      }), options) },
      '../../features/google-sync/shared-task-claim.ts': await import('../src/features/google-sync/shared-task-claim.ts'),
      '../../features/sharing/identifier.ts': await import('../src/features/sharing/identifier.ts'),
    });
    const late = module.createSharedGoogleTaskClaims({ firestore: owner.firestore, userId: 'owner', namespace, currentUserId: () => 'owner', assertCurrent: async () => budget.assert() });
    const next = { ...intent('late'), occurrenceMarker: sharedGoogleOccurrenceNote(namespace, 'late') };
    await assert.rejects(late.reserveBatch([next]), /時間/u);
    const ref = sdk.doc(owner.firestore, 'privateGoogleTaskClaims', 'owner', 'occurrences', sharedTaskClaimKey(namespace, next).occurrenceHash);
    assert.equal((await sdk.getDocFromServer(ref)).exists(), false);
  } finally { budget.close(); }
});
