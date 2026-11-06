import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
const repository = await import('../src/platform/storage/repository.ts');

async function setup() {
  const h = await privateFixture(); const overlay = await h.read(); const row = overlay.home.find(item => item.chore.id === h.chore.id);
  assert.ok(row); const snapshot = await repository.loadPlannerSnapshot(h.database);
  const command = { date: row.date, graceDays: row.graceDays, choreId: row.chore.id, revision: row.revision, completed: true };
  const identity = number => ({ id: `completion-intent.55a4e011-1dac-4c8d-b817-${String(number).padStart(12, '0')}`,
    digest: sharedDocumentDigest({ number, command }), householdCreatedAt: snapshot.household.createdAt, createdAt: new Date().toISOString() });
  return { ...h, row, command, identity };
}

test('personal completion intents follow one exact cycle through queued undo and replay no successful write', async () => {
  const h = await setup();
  try {
    const completed = h.identity(1), undone = h.identity(2);
    assert.equal(await repository.setPersonalDateTaskCompletedIntent(h.database, h.command, completed, () => {}), true);
    await repository.loadPlannerSnapshot(h.database);
    assert.equal(await repository.setPersonalDateTaskCompletedIntent(h.database, { ...h.command, completed: false }, undone, () => {}), true,
      'the original displayed reference can undo the same cycle after its completion revision changes');
    assert.equal(await repository.setPersonalDateTaskCompletedIntent(h.database, h.command, completed, () => {}), false);
    const current = await repository.loadPlannerSnapshot(h.database);
    const matching = current.completions.filter(row => row.scheduleEntryId === JSON.parse(h.row.revision)[0]);
    assert.ok(matching.length > 0); assert.ok(matching.every(row => row.outcome === 'incomplete'));
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM planner_completion_intents').get().n, 2);
  } finally { h.connection.close(); }
});

test('personal completion intents refuse a changed installation scope, target digest and another cycle', async () => {
  const h = await setup();
  try {
    const identity = h.identity(1);
    await assert.rejects(repository.setPersonalDateTaskCompletedIntent(h.database, h.command, { ...identity, householdCreatedAt: 'other-installation' }, () => {}), /保存先/);
    await repository.setPersonalDateTaskCompletedIntent(h.database, h.command, identity, () => {});
    await assert.rejects(repository.setPersonalDateTaskCompletedIntent(h.database, h.command, { ...identity, digest: 'f'.repeat(64) }, () => {}), /一致しません/);
    const before = h.connection.prepare('SELECT count(*) AS n FROM planner_completion_intents').get().n;
    await assert.rejects(repository.setPersonalDateTaskCompletedIntent(h.database, { ...h.command, revision: 'different-cycle' }, h.identity(2), () => {}), /状態が変わって/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM planner_completion_intents').get().n, before);
  } finally { h.connection.close(); }
});

test('personal completion intents reject an edited execution window before saving a different occurrence', async () => {
  const h = await setup();
  try {
    const id = JSON.parse(h.row.revision)[0];
    const entry = JSON.parse(h.connection.prepare('SELECT entry_json FROM chore_schedule_entries WHERE id=?').get(id).entry_json);
    h.connection.prepare('UPDATE chore_schedule_entries SET entry_json=? WHERE id=?').run(JSON.stringify({ ...entry, windowEnd: addDays(entry.windowEnd, 1) }), id);
    await assert.rejects(repository.setPersonalDateTaskCompletedIntent(h.database, h.command, h.identity(1), () => {}), /状態が変わって/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM planner_completion_intents').get().n, 0);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM chore_completion_actions').get().n, 0);
  } finally { h.connection.close(); }
});

test('personal completion intents roll back history and the acknowledgement when access changes during the write', async () => {
  const h = await setup(); const original = h.database.runAsync; let access = true;
  const before = h.connection.prepare('SELECT count(*) AS n FROM chore_completions').get().n;
  h.database.runAsync = async function (sql, ...args) {
    const result = await original.call(this, sql, ...args);
    if (sql.includes('INSERT INTO planner_completion_intents')) access = false;
    return result;
  };
  try {
    await assert.rejects(repository.setPersonalDateTaskCompletedIntent(h.database, h.command, h.identity(1), () => { if (!access) throw new Error('account changed'); }), /account changed/);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM chore_completions').get().n, before);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM planner_completion_intents').get().n, 0);
  } finally { h.database.runAsync = original; h.connection.close(); }
});
