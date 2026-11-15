import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFixture, digest } from './helpers/shared-google-task-recovery.mjs';

for (const multiple of [false, true]) test(`shared lost POST reply reopens SQLite and adopts ${multiple ? 'multiple mappings' : 'one mapping'} through the native resolver journal claim and HTTP boundaries`, async t => {
  const h = await recoveryFixture(t, { multiple }); await h.loseCreateReply(); const before = h.intents(), ids = [...h.server.account(h.subject).tasks.keys()];
  assert.ok(before.every(row => row.remote_task_id === null)); await h.restart(); const start = h.server.mark();
  assert.equal((await h.run()).kind, 'success'); assert.equal(h.server.counts(start).providerMethods.POST ?? 0, 0);
  assert.deepEqual([...h.server.account(h.subject).tasks.keys()], ids); assert.equal((await h.store.readSavedLinks()).length, ids.length);
  assert.equal(h.factsDigest(), h.originals); assert.equal(h.taskClaims().length, 0);
  for (const row of h.intents()) assert.equal(row.attempt_id, before.find(old => old.occurrence_marker === row.occurrence_marker).attempt_id);
  const repeat = h.server.mark(); await h.run(); assert.equal(h.server.counts(repeat).providerMethods.POST ?? 0, 0);
});

for (const field of ['accountSubject', 'taskListId', 'occurrenceMarker']) test(`fresh shared adoption refuses a foreign saved ${field} without borrowing or poisoning its reservation`, async t => {
  const h = await recoveryFixture(t); await h.loseCreateReply(); const original = digest(h.intents());
  h.hooks.receipt = value => value && ({ ...value, intent: { ...value.intent, [field]: 'foreign-scope' } });
  const mark = h.server.mark(); assert.notEqual((await h.run()).kind, 'success');
  assert.equal(digest(h.intents()), original); assert.equal(h.server.counts(mark).providerMethods.POST ?? 0, 0); assert.equal((await h.store.readSavedLinks()).length, 0);
});

for (const change of ['local-attempt', 'cloud-attempt', 'marker', 'task-id', 'deleted']) test(`fresh shared adoption fences ${change} changed during its GET before saving a success receipt`, async t => {
  const h = await recoveryFixture(t); await h.loseCreateReply();
  h.hooks.beforeGet = () => {
    h.hooks.beforeGet = undefined;
    if (change === 'local-attempt') h.device.connection.prepare("UPDATE private_google_task_create_intents SET attempt_id='newer-attempt' WHERE remote_task_id IS NULL").run();
    else if (change === 'cloud-attempt') { for (const row of h.cloud.rows.values()) if (row.phase === 'reserved') row.attemptId = 'another-device-attempt'; }
    else { const task = [...h.server.account(h.subject).tasks.values()][0];
      if (change === 'marker') task.notes = 'LiFlow occurrence: ' + 'f'.repeat(64);
      if (change === 'task-id') task.id = 'substituted-id';
      if (change === 'deleted') task.deleted = true;
    }
  };
  const mark = h.server.mark(); assert.notEqual((await h.run()).kind, 'success');
  assert.ok(h.intents().every(row => row.remote_task_id === null)); assert.equal((await h.store.readSavedLinks()).length, 0);
  assert.equal(h.server.counts(mark).providerMethods.POST ?? 0, 0); assert.equal(h.factsDigest(), h.originals);
});

test('cancelled shared adoption retains the durable attempt and resumes it without another POST', async t => {
  const h = await recoveryFixture(t); await h.loseCreateReply(); const before = digest(h.intents()); h.hooks.beforeGet = () => { h.hooks.beforeGet = undefined; h.cancel(); };
  assert.notEqual((await h.run()).kind, 'success'); assert.equal(digest(h.intents()), before); await h.restart();
  const mark = h.server.mark(); assert.equal((await h.run()).kind, 'success'); assert.equal(h.server.counts(mark).providerMethods.POST ?? 0, 0);
});

test('old shared creation attempts never expire into another POST and still recover through their exact claim', async t => {
  const h = await recoveryFixture(t); await h.loseCreateReply();
  h.device.connection.prepare("UPDATE private_google_task_create_intents SET started_at='2000-01-01T00:00:00.000Z' WHERE remote_task_id IS NULL").run();
  await h.restart(); const mark = h.server.mark(); assert.equal((await h.run()).kind, 'success'); assert.equal(h.server.counts(mark).providerMethods.POST ?? 0, 0);
});

test('duplicate shared marker candidates cannot consume a pending attempt or create another task', async t => {
  const h = await recoveryFixture(t); await h.loseCreateReply(); const remote = h.server.account(h.subject), task = [...remote.tasks.values()][0];
  remote.tasks.set('synthetic-duplicate', { ...task, id: 'synthetic-duplicate' }); const before = digest(h.intents()), mark = h.server.mark();
  const result = await h.run(); assert.equal(result.code, 'ambiguous_task_occurrence'); assert.equal(digest(h.intents()), before);
  assert.equal(h.server.counts(mark).providerMethods.POST ?? 0, 0); assert.equal((await h.store.readSavedLinks()).length, 0);
});

test('a lost Cloud adoption acknowledgment retains the original intent and recovers the same linked Task after reopening', async t => {
  const h = await recoveryFixture(t); await h.loseCreateReply(); let once = true;
  h.hooks.afterClaimLink = async identity => { if (once && identity.taskListId !== 'reserved:shared-task-list:v1') { once = false; throw Object.assign(new Error('synthetic lost Cloud acknowledgment'), { code: 'unavailable' }); } };
  assert.equal((await h.run()).kind, 'retry'); assert.ok(h.intents().every(row => row.remote_task_id === null));
  await h.restart(); const mark = h.server.mark(); assert.equal((await h.run()).kind, 'success');
  assert.equal(h.server.counts(mark).providerMethods.POST ?? 0, 0); assert.equal(h.factsDigest(), h.originals);
});
