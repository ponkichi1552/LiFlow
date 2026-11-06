import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { createHouseholdChoreDefinitions } from '../src/domain/chores/catalog.ts';
const repository = await import('../src/platform/storage/repository.ts');
const { installPersonalCatalogInside } = await import('../src/platform/storage/personal-catalog.ts');
const { createPersonalChoreDefinitions, PERSONAL_CHORE_CATALOG_VERSION } = await import('../src/domain/chores/personal-catalog.ts');
const house = repository.LOCAL_HOUSEHOLD_ID;

test('private initialization adopts only the new catalogue with eight defaults and subsequent opens never rewrite its definitions', async t => {
  const h = createDatabase(); t.after(() => h.connection.close());
  await repository.initializeLocalDatabase(h.database);
  const snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-05');
  const expected = createPersonalChoreDefinitions(house);
  assert.deepEqual(snapshot.chores.map(chore => chore.id), expected.map(chore => chore.id));
  assert.equal(snapshot.chores.filter(chore => chore.enabled).length, 8);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.scheduleEntries.length, 0, 'setup has not committed yet');
  const before = h.connection.serialize(); h.writes.length = 0;
  await repository.ensureLocalHousehold(h.database);
  assert.deepEqual(h.connection.serialize(), before); assert.equal(h.writes.length, 0);
  assert.equal(h.connection.prepare('SELECT built_in_chore_catalog_version v FROM household_settings').get().v, PERSONAL_CHORE_CATALOG_VERSION);
});

async function oldPrivateFixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  await h.database.runAsync('DELETE FROM chore_definitions');
  await h.database.runAsync('UPDATE household_settings SET built_in_chore_catalog_version=5');
  const old = createHouseholdChoreDefinitions(house)[0];
  const custom = { ...old, id: 'my-own-task', name: '自作の家事', recommendedCycleDays: 75 };
  const appliance = { ...old, id: 'appliance-care.real', applianceId: 'my-appliance', name: '登録した家電' };
  for (const chore of [old, custom, appliance]) {
    await h.database.runAsync('INSERT INTO chore_definitions VALUES(?,?,?,?,?)', chore.id, house, chore.name, 1, JSON.stringify(chore));
    await h.database.runAsync('INSERT INTO chore_state(chore_id,last_completed_date,initial_pending) VALUES(?,?,0)', chore.id, '2026-10-20');
    await h.database.runAsync('INSERT INTO chore_assignments VALUES(?,?)', chore.id, repository.LOCAL_MEMBER_ID);
    await h.database.runAsync("INSERT INTO chore_completions(id,household_id,chore_id,completed_at,outcome) VALUES(?,?,?,?,'completed')",
      `done.${chore.id}`, house, chore.id, '2026-10-20T01:00:00Z');
  }
  await repository.upsertGoogleTaskLink(h.database, { scheduleEntryId: 'old-round', householdId: house, choreId: old.id,
    googleTaskListId: 'existing-list', googleTaskId: 'existing-task', createdAt: '2026-10-20T01:00:00Z', updatedAt: '2026-10-20T01:00:00Z', lastSyncedStatus: 'needsAction' });
  return { ...h, old, custom, appliance };
}

test('new private catalogue discards approved old built-in settings and history without remapping custom jobs appliances or managed Google IDs', async t => {
  const h = await oldPrivateFixture(t);
  await h.database.withTransactionAsync(() => installPersonalCatalogInside(h.database, house, repository.LOCAL_MEMBER_ID));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_definitions WHERE id=?').get(h.old.id).n, 0);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions WHERE chore_id=?').get(h.old.id).n, 0);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_state WHERE chore_id=?').get(h.old.id).n, 0);
  for (const chore of [h.custom, h.appliance]) {
    assert.deepEqual(JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(chore.id).definition_json), chore);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions WHERE chore_id=?').get(chore.id).n, 1);
  }
  assert.equal((await repository.listGoogleTaskLinks(h.database))[0].googleTaskId, 'existing-task');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_definitions').get().n, createPersonalChoreDefinitions(house).length + 2);
});

test('failed new-catalogue installation rolls back old-history deletion and version before a safe exact retry', async t => {
  const h = await oldPrivateFixture(t);
  // SQLite may rewrite unused page bytes on rollback. Compare every logical
  // table, including history, settings, model journals and Google mappings.
  const contents = () => Object.fromEntries(h.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, h.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  const before = contents(); const run = h.database.runAsync;
  h.database.runAsync = async (sql, ...args) => {
    if (sql.startsWith('INSERT OR IGNORE INTO chore_definitions') && args[0].endsWith('.002')) throw new Error('disk-full');
    return run(sql, ...args);
  };
  await assert.rejects(h.database.withTransactionAsync(() => installPersonalCatalogInside(h.database, house, repository.LOCAL_MEMBER_ID)), /disk-full/u);
  assert.deepEqual(contents(), before);
  h.database.runAsync = run;
  await h.database.withTransactionAsync(() => installPersonalCatalogInside(h.database, house, repository.LOCAL_MEMBER_ID));
  const saved = h.connection.serialize();
  await h.database.withTransactionAsync(() => installPersonalCatalogInside(h.database, house, repository.LOCAL_MEMBER_ID));
  assert.deepEqual(h.connection.serialize(), saved);
});
