import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { memoryTaskClaims } from './helpers/shared-task-claims.mjs';
import { sharedGoogleOccurrenceNote } from '../src/features/google-sync/workspace-policy.ts';
import { sharedTaskClaimKey, checkedSharedTaskClaim, reserveSharedTaskClaim, linkSharedTaskClaim, releaseSharedTaskClaim } from '../src/features/google-sync/shared-task-claim.ts';
import { sharedTaskCreateJournal } from '../src/features/google-sync/shared-task-create-journal.ts';
import { createGoogleOperationBudget } from '../src/features/google-sync/operation-budget.ts';

const namespace = 'private-namespace';
const identity = { accountSubject: 'private-account', taskListId: 'private-list', occurrenceMarker: sharedGoogleOccurrenceNote(namespace, 'round') };
const intent = (attemptId = 'attempt-a') => ({ ...identity, attemptId, startedAt: '2026-11-05T00:00:00Z' });

test('audit100 a timed out shared Tasks journal cannot release its caller while a SQLite transaction is still running', async () => {
  const h = await googleFixture(); const remote = memoryTaskClaims(h.namespace); const budget = createGoogleOperationBudget(60_000);
  let release; let entered; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const run = h.d.database.runAsync; let settled = false;
  h.d.database.runAsync = async (sql, ...params) => { if (sql.startsWith('INSERT INTO private_google_task_create_intents')) { entered(); await gate; } return run(sql, ...params); };
  const journal = sharedTaskCreateJournal(h.store.port.taskCreateJournal, remote.cloud, { budget, assertCurrent: async () => {} });
  const result = journal.reserve(identity).then(() => { settled = true; }, () => { settled = true; });
  try {
    await started; budget.cancel(); await new Promise(setImmediate);
    assert.equal(settled, false, 'caller must await SQLite commit or rollback even after the network budget expires');
  } finally {
    release(); await result; await new Promise(setImmediate); budget.close();
    assert.equal(await h.d.database.isInTransactionAsync(), false);
    assert.equal(h.d.connection.prepare('SELECT count(*) n FROM private_google_task_create_intents').get().n, 0);
    assert.equal(remote.calls.length, 0); h.close();
  }
});

test('shared Tasks claims contain only hashed private identities and reject malformed or cross-scope records', () => {
  const key = sharedTaskClaimKey(namespace, identity); const row = reserveSharedTaskClaim(null, key, intent());
  assert.deepEqual(checkedSharedTaskClaim(row, key), row);
  const serialized = JSON.stringify(row);
  for (const value of [namespace, identity.accountSubject, identity.taskListId, identity.occurrenceMarker, intent().startedAt]) assert.equal(serialized.includes(value), false);
  for (const change of [{ scopeHash: 'a'.repeat(64) }, { occurrenceHash: 'b'.repeat(64) }, { revision: 0 }, { revision: 1.5 }, { phase: 'expired' },
    { taskHash: 'c'.repeat(64) }, { attemptId: '' }, { unexpected: true }]) assert.throws(() => checkedSharedTaskClaim({ ...row, ...change }, key));
  assert.throws(() => sharedTaskClaimKey(namespace, { ...identity, occurrenceMarker: 'arbitrary notes' }));
});

test('a reserved shared Tasks POST cannot be granted again by replay or an elapsed device lease', () => {
  const key = sharedTaskClaimKey(namespace, identity); const row = reserveSharedTaskClaim(null, key, intent());
  for (const candidate of [intent(), intent('attempt-b'), { ...intent('attempt-c'), startedAt: '2099-01-01T00:00:00Z' }]) assert.equal(reserveSharedTaskClaim(row, key, candidate), null);
  assert.equal(releaseSharedTaskClaim(row, { attemptId: 'not-the-sender' }), null);
  const released = releaseSharedTaskClaim(row, { attemptId: intent().attemptId }); assert.equal(released.phase, 'released');
  assert.throws(() => reserveSharedTaskClaim(released, key, intent()));
  assert.equal(reserveSharedTaskClaim(released, key, intent('new-attempt')).revision, 3);
});

test('shared Tasks acknowledgement and confirmed deletion are fenced to the exact recorded task', () => {
  const key = sharedTaskClaimKey(namespace, identity); const reserved = reserveSharedTaskClaim(null, key, intent());
  const linked = linkSharedTaskClaim(reserved, key, 'task-a', intent().attemptId); assert.equal(linked.phase, 'linked'); assert.equal(linked.attemptId, intent().attemptId);
  assert.equal(linkSharedTaskClaim(linked, key, 'task-a'), null); assert.throws(() => linkSharedTaskClaim(linked, key, 'task-b'));
  assert.equal(releaseSharedTaskClaim(linked, { attemptId: intent().attemptId }), null);
  assert.equal(releaseSharedTaskClaim(linked, { taskId: 'task-b' }), null);
  assert.equal(releaseSharedTaskClaim(linked, { taskId: 'task-a' }).phase, 'released');
  assert.equal(JSON.stringify(linked).includes('task-a'), false);
});

test('an old adoption or creation acknowledgement cannot consume a newer shared reservation', () => {
  const key = sharedTaskClaimKey(namespace, identity);
  const a = reserveSharedTaskClaim(null, key, intent('old'));
  const linked = linkSharedTaskClaim(a, key, 'task-x', 'old');
  const released = releaseSharedTaskClaim(linked, { taskId: 'task-x' });
  const newer = reserveSharedTaskClaim(released, key, intent('new'));
  assert.throws(() => linkSharedTaskClaim(newer, key, 'task-x'), { code: 'task_create_result_pending' });
  assert.throws(() => linkSharedTaskClaim(newer, key, 'task-x', 'old'), { code: 'task_create_result_pending' });
  assert.equal(linkSharedTaskClaim(newer, key, 'task-y', 'new').attemptId, 'new');
});

test('shared native Tasks reserves at most100 local intents in one transaction and rolls the whole chunk back on its final fence', async () => {
  const h = await googleFixture();
  try {
    const ids = Array.from({ length: 100 }, (_, i) => ({ ...identity, occurrenceMarker: sharedGoogleOccurrenceNote(h.namespace, `round-${i}`) }));
    let fence = 0;
    await assert.rejects(h.store.port.taskCreateJournal.reserveBatch(ids, () => { if (++fence === 2) throw new Error('expired before commit'); }), /expired/u);
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM private_google_task_create_intents').get().n, 0);
    assert.equal((await h.store.port.taskCreateJournal.reserveBatch(ids)).filter(Boolean).length, 100);
    assert.ok((await h.store.port.taskCreateJournal.reserveBatch(ids)).every(value => value === null));
    assert.throws(() => h.store.port.taskCreateJournal.reserveBatch([...ids, ids[0]]), /100/u);
  } finally { h.close(); }
});

test('a denied cross-device Tasks claim releases only its unused local reservation and permits later retry', async () => {
  const h = await googleFixture(); const remote = memoryTaskClaims(h.namespace); const budget = createGoogleOperationBudget(10000);
  try {
    const pending = { ...identity, occurrenceMarker: sharedGoogleOccurrenceNote(h.namespace, 'one') };
    const other = { ...pending, attemptId: 'other-device', startedAt: intent().startedAt }; await remote.cloud.reserveBatch([other]);
    const journal = sharedTaskCreateJournal(h.store.port.taskCreateJournal, remote.cloud, { budget, assertCurrent: async () => {} });
    assert.equal(await journal.reserve(pending), null);
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM private_google_task_create_intents').get().n, 0);
    await remote.cloud.reject(other); const accepted = await journal.reserve(pending); assert.ok(accepted);
    await journal.linked(pending, 'one-google-task', accepted); assert.equal(await journal.reserve(pending), null);
    assert.equal([...remote.rows.values()][0].phase, 'linked'); assert.deepEqual(remote.calls.map(call => call[1]), [1, 1, 1]);
  } finally { budget.close(); h.close(); }
});

test('a lost Cloud creation-grant response remains held across another attempt and never becomes a second provider POST', async () => {
  const h = await googleFixture(); const remote = memoryTaskClaims(h.namespace); const budget = createGoogleOperationBudget(10000); let calls = 0;
  try {
    const cloud = { ...remote.cloud, async reserveBatch(intents) { calls++; await remote.cloud.reserveBatch(intents); throw Object.assign(new Error('lost commit response'), { code: 'unavailable' }); } };
    const journal = sharedTaskCreateJournal(h.store.port.taskCreateJournal, cloud, { budget, assertCurrent: async () => {} });
    await assert.rejects(journal.reserve(identity), /lost commit/u); assert.equal(await journal.reserve(identity), null); assert.equal(calls, 1);
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM private_google_task_create_intents').get().n, 1);
  } finally { budget.close(); h.close(); }
});

test('an expired native Tasks reservation rolls back before Cloud and an explicit Cloud permission rejection remains retryable', async () => {
  const h = await googleFixture(); let tick = 0; const budget = createGoogleOperationBudget(15, () => tick); let calls = 0;
  try {
    const local = h.store.port.taskCreateJournal; const reserveBatch = local.reserveBatch.bind(local); let fences = 0;
    const journal = sharedTaskCreateJournal({ ...local, reserveBatch: (ids, fence) => reserveBatch(ids, () => { if (++fences === 2) tick = 16; fence(); }) },
      { reserveBatch: async () => { calls++; return [true]; } }, { budget, assertCurrent: async () => {} });
    await assert.rejects(journal.reserve(identity)); assert.equal(calls, 0);
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM private_google_task_create_intents').get().n, 0);
  } finally { budget.close(); h.close(); }
  const next = await googleFixture(); const nextBudget = createGoogleOperationBudget(10000);
  try {
    const journal = sharedTaskCreateJournal(next.store.port.taskCreateJournal, { reserveBatch: async () => { throw Object.assign(new Error('rules not deployed'), { code: 'permission-denied' }); } },
      { budget: nextBudget, assertCurrent: async () => {} });
    await assert.rejects(journal.reserve(identity), /rules not deployed/u);
    assert.equal(next.d.connection.prepare('SELECT COUNT(*) AS n FROM private_google_task_create_intents').get().n, 0);
  } finally { nextBudget.close(); next.close(); }
});
