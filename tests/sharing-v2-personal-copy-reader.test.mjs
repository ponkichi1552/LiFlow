import { beforeEach } from 'node:test';
import { pinPrivateFixtureTime } from './helpers/sharing-v2-private-fixture.mjs';
beforeEach(pinPrivateFixtureTime);
import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { readPersonalChoreCopySource } = await import('../src/platform/storage/repository.ts');

function rows(h) {
  return h.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, h.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}
test('personal copy source selects only current definitions and frequency without reading history or generating any schedules', async () => {
  const h = await privateFixture(); const all = h.database.getAllAsync; const one = h.database.getFirstAsync; const run = h.database.runAsync; const queries = [];
  try {
    const before = rows(h); const inspect = sql => { queries.push(sql); assert.doesNotMatch(sql, /FROM\s+(chore_state|chore_completions|chore_schedule_entries|google_task_links|calendar_availability|appliances|weekly_waste)/iu); };
    h.database.getAllAsync = async (sql, ...args) => { inspect(sql); return all(sql, ...args); };
    h.database.getFirstAsync = async (sql, ...args) => { inspect(sql); return one(sql, ...args); };
    h.database.runAsync = async () => assert.fail('reading copy settings must not write planner rows');
    const chooser = await readPersonalChoreCopySource(h.database); assert.equal(chooser.householdId, 'local-household'); assert.equal(chooser.frequencyMode, 'balanced');
    assert.ok(chooser.chores.length > 1); const selected = await readPersonalChoreCopySource(h.database, [h.chore.id]); assert.equal(selected.chores.length, 1); assert.equal(selected.chores[0].name, h.chore.name);
    assert.deepEqual(Object.keys(selected).sort(), ['chores', 'frequencyMode', 'householdId']);
    assert.ok(queries.some(sql => sql.includes('id IN (?)'))); assert.deepEqual(rows(h), before);
  } finally { h.database.getAllAsync = all; h.database.getFirstAsync = one; h.database.runAsync = run; h.connection.close(); }
});
test('personal copy source bounds and parameterizes its selection and fails closed on poisoned or missing personal settings', async () => {
  const h = await privateFixture();
  try {
    for (const ids of [[], [h.chore.id, h.chore.id], Array(21).fill('x'), ['x'.repeat(513)], [null]]) await assert.rejects(readPersonalChoreCopySource(h.database, ids));
    const injection = "') OR 1=1--"; assert.deepEqual((await readPersonalChoreCopySource(h.database, [injection])).chores, []);
    const original = h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(h.chore.id).definition_json;
    h.connection.prepare('UPDATE chore_definitions SET definition_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(original), householdId: 'another-owner' }), h.chore.id);
    await assert.rejects(readPersonalChoreCopySource(h.database, [h.chore.id]), /保存形式/u);
    h.connection.prepare('UPDATE chore_definitions SET definition_json=? WHERE id=?').run(original, h.chore.id);
    h.connection.prepare('UPDATE household_settings SET frequency_mode=?').run('unknown');
    await assert.rejects(readPersonalChoreCopySource(h.database), /頻度/u);
  } finally { h.connection.close(); }
});
test('personal copy source refuses a group database or an uninitialized database without creating personal tables', async () => {
  for (const marker of ['sharing_workspace_metadata', 'sharing_v2_binding', null]) {
    const h = createDatabase();
    try {
      if (marker) h.connection.exec(`CREATE TABLE ${marker}(singleton INTEGER)`);
      const before = rows(h); await assert.rejects(readPersonalChoreCopySource(h.database)); assert.deepEqual(rows(h), before);
      assert.equal(h.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('households','chore_definitions')").get().n, 0);
    } finally { h.connection.close(); }
  }
});
