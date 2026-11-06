import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { HOUSEHOLD_CARE_GUIDE } from '../src/domain/chores/household-care-guide.ts';
import { CHORE_CATALOG, HOUSEHOLD_CARE_IDS, RETIRED_BUILT_IN_CHORE_IDS, createHouseholdChoreDefinitions, builtInChoreCatalogEntry } from '../src/domain/chores/catalog.ts';
import { createLegacyHouseholdChoreDefinitionsV3 } from '../src/domain/chores/catalog-v3.ts';
import { upgradeBuiltInCatalogDefinition } from '../src/domain/chores/catalog-upgrade.ts';
import { commonChoreLinks } from '../src/features/planner/common-chore-links.ts';
import { guideCatalogSelection, unifiedGuideCatalog } from '../src/features/chores/guide-catalog.ts';
import { applyChoreSettingsPatch } from '../src/domain/chores/settings-patch.ts';
import { resetChoreSchedule } from '../src/domain/chores/schedule-defaults.ts';
import { isLaundryChore } from '../src/features/weather/laundry-policy.ts';
import { fixture, seeds, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { ensureV2CatalogCurrent } from '../src/features/sharing/v2/catalog-update.ts';
import { sharedPatchFromDefinition } from '../src/features/sharing/planning.ts';
import { applyReceivedSharedFacts, loadSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const repository = await import('../src/platform/storage/repository.ts');
const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
const snapshot = JSON.parse(readFileSync(new URL('../docs/catalog/household-care-2026-11-01.json', import.meta.url), 'utf8'));
const expectedMinutes = [20,35,25,10,15,20,45,10,20,30,25,15,10,30,15,10,15,20,20,10,15,10,15,10,10,10,10,15,20,25,35,10,10,10,10,15];
const day = '2026-11-01';

test('all 36 document entries retain source contents and use the user table instead of document elapsed times', () => {
  const raw = readFileSync(new URL('../docs/catalog/household-care-source-2026-11-01.txt', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), snapshot.sourceSha256);
  assert.equal(HOUSEHOLD_CARE_GUIDE.length, 36);
  assert.deepEqual(HOUSEHOLD_CARE_GUIDE.map(row => row.estimatedMinutes), expectedMinutes);
  for (const [index, row] of HOUSEHOLD_CARE_GUIDE.entries()) {
    const original = snapshot.items[index];
    for (const field of ['name','category','description','tools','instructions','cautions','trivia','conditions','frequency','frequencyEvidence','sourceUrl']) assert.deepEqual(row[field], original[field], `${index + 1}: ${field}`);
    assert.equal(Object.hasOwn(row, 'documentMinutes'), false);
    const chore = builtInChoreCatalogEntry(HOUSEHOLD_CARE_IDS[index]);
    assert.equal(chore.name, row.name); assert.equal(chore.estimatedMinutes, expectedMinutes[index]);
    assert.equal(chore.description, row.description); assert.deepEqual(chore.instructions, row.instructions);
    assert.equal(chore.tools.join(''), row.tools); assert.equal(chore.cautions.join(''), row.cautions);
    assert.ok(chore.schedulingNotes.includes(row.frequency)); if (row.conditions) assert.ok(chore.schedulingNotes.includes(row.conditions));
    assert.equal(chore.trivia?.[0]?.body ?? '', row.trivia);
    assert.deepEqual(chore.sourceNotes, []);
  }
  assert.equal(builtInChoreCatalogEntry(HOUSEHOLD_CARE_IDS[12]).estimatedMinutes, 10, '675 minutes of machine operation is not the working-time estimate');
});

test('the document catalog contains only 36 jobs and never reuses a retired job identity', () => {
  const rows = createHouseholdChoreDefinitions('home');
  assert.equal(rows.length, 36); assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.ok(RETIRED_BUILT_IN_CHORE_IDS.every(id => !rows.some(current => current.id === id))); assert.equal(RETIRED_BUILT_IN_CHORE_IDS.length, 10);
  assert.equal(builtInChoreCatalogEntry('group.builtin-chore-01').name, '浴室掃除');
  assert.equal(builtInChoreCatalogEntry('group.builtin-chore-02').estimatedMinutes, 35);
  assert.equal(builtInChoreCatalogEntry('builtin-chore-11'), undefined);
  assert.equal(builtInChoreCatalogEntry('builtin-chore-16'), undefined);
  assert.equal(builtInChoreCatalogEntry('builtin-chore-99'), undefined);
  for (const n of [10, 11]) assert.ok(isLaundryChore(rows.find(row => row.id === HOUSEHOLD_CARE_IDS[n - 1])));
  for (const n of [12, 13]) assert.equal(isLaundryChore(rows.find(row => row.id === HOUSEHOLD_CARE_IDS[n - 1])), false, 'machine maintenance is not weather-dependent laundry');
});

test('personal condition and seasonal entries no longer manufacture provisional day cycles or a municipal completion task', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
    let snapshot = await repository.loadPlannerSnapshot(h.database, day);
    for (const name of ['調理後の片付け', '枕本体の洗濯']) {
      const chore = snapshot.chores.find(row => row.name === name); assert.ok(chore);
      assert.deepEqual(chore.frequencyDaysByMode, {});
      await repository.setChoreEnabled(h.database, chore.id, true);
      snapshot = await repository.loadPlannerSnapshot(h.database, day);
      assert.equal(snapshot.chores.find(row => row.id === chore.id).enabled, true);
      assert.equal(snapshot.scheduleEntries.some(row => row.choreId === chore.id), false);
    }
    assert.equal(snapshot.chores.some(row => row.name === 'ごみ・資源の収集日に合わせたごみ出し'), false);
    assert.equal(snapshot.chores.some(row => row.name === '追いだき配管の洗浄'), false);
    const seasonal = snapshot.chores.find(row => row.personalSchedulingKind === 'seasonal'); assert.ok(seasonal);
    await assert.rejects(repository.updateChoreSettings(h.database, seasonal.id, { cycleDays: 30 }), /固定日/u);
  } finally { h.connection.close(); }
});

function prepareV3(h) {
  h.connection.prepare('DELETE FROM chore_definitions WHERE CAST(substr(id,15) AS INTEGER)>20').run();
  for (const old of createLegacyHouseholdChoreDefinitionsV3('local-household')) h.connection.prepare('INSERT INTO chore_definitions(id,household_id,name,enabled,definition_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,definition_json=excluded.definition_json')
    .run(old.id,old.householdId,old.name, Number(old.enabled), JSON.stringify(old));
  h.connection.prepare('UPDATE household_settings SET built_in_chore_catalog_version=3').run();
}

test('adopting the new private catalogue removes old built-ins rather than guessing a history or setting migration', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); prepareV3(h);
    const old = createLegacyHouseholdChoreDefinitionsV3('local-household')[0];
    h.connection.prepare("INSERT INTO chore_completions(id,household_id,chore_id,completed_at,outcome) VALUES(?,?,?,?,'completed')")
      .run('old-private-done','local-household',old.id,'2026-10-25T01:00:00Z');
    await repository.initializeLocalDatabase({ ...h.database });
    const snapshot = await repository.loadPlannerSnapshot(h.database, day);
    assert.deepEqual(snapshot.chores.map(row => row.id), createPersonalChoreDefinitions('local-household').map(row => row.id));
    assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n, 0);
    assert.equal(snapshot.chores.filter(row => row.enabled).length, 8);
    const writes = h.writes.length; await repository.initializeLocalDatabase({ ...h.database });
    assert.equal(h.writes.slice(writes).filter(row => /UPDATE chore_definitions|INSERT OR IGNORE INTO chore_definitions/.test(row.sql)).length, 0);
  } finally { h.connection.close(); }
});

test('catalog migration failure rolls back definitions and version so a later retry remains possible', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); prepareV3(h);
    const before = h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all();
    h.connection.exec("CREATE TRIGGER stop_catalog BEFORE INSERT ON chore_definitions WHEN NEW.id='liflow-catalog-6.025' BEGIN SELECT RAISE(ABORT,'catalog rollback'); END");
    const reopened = { ...h.database };
    await assert.rejects(repository.initializeLocalDatabase(reopened), /catalog rollback/);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all(), before);
    assert.equal(h.connection.prepare('SELECT built_in_chore_catalog_version AS v FROM household_settings').get().v, 3);
    h.connection.exec('DROP TRIGGER stop_catalog'); await repository.initializeLocalDatabase(reopened);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_definitions').get().n, createPersonalChoreDefinitions('local-household').length);
  } finally { h.connection.close(); }
});

test('exact shipped renames retain one shared/private row and do not merge user names or ambiguous shared jobs', () => {
  const old = createLegacyHouseholdChoreDefinitionsV3('home').find(row => row.id === 'builtin-chore-01');
  const current = createHouseholdChoreDefinitions('home').find(row => row.id === old.id);
  const personal = { ...current, id: 'personal-bath' }; const shared = { ...old, id: 'imported-shared-bath' };
  assert.equal(upgradeBuiltInCatalogDefinition(old, current, 3).definition.id, old.id);
  assert.deepEqual(commonChoreLinks([personal], [shared]), [{ sharedChoreId: shared.id, personalChoreId: personal.id }]);
  const catalog = unifiedGuideCatalog([shared], [personal]); assert.equal(catalog.length, 1);
  assert.equal(guideCatalogSelection(catalog, 'personal', personal), 'shared:imported-shared-bath');
  assert.equal(commonChoreLinks([personal], [{ ...shared, name: '自分専用の風呂' }]).length, 0);
  assert.equal(commonChoreLinks([personal], [shared, { ...shared, id: 'another-bath' }]).length, 0);
});

test('shared catalog refresh is owner-only, transactional, idempotent and keeps policies custom edits history and explicit deletions', async () => {
  const f = await fixture(); const d = await f.device(); const member = await f.device('member', f.member);
  try {
    await d.repository.commit(seeds());
    await d.repository.commit(createLegacyHouseholdChoreDefinitionsV3('ignored').map((chore, index) => ({ operationId: `legacy-catalog-${index}`, entityType: 'chore',
      entityId: `${groupId}.${chore.id}`, operationType: 'patch', payload: sharedPatchFromDefinition({ ...chore, enabled: false }) })));
    await d.repository.commit([{ operationId: 'custom-name', entityType: 'chore', entityId: `${groupId}.builtin-chore-02`, operationType: 'patch', payload: { name: '共有の名前', instructions: ['共有の手順'] } },
      { operationId: 'deleted-range', entityType: 'chore', entityId: `${groupId}.builtin-chore-04`, operationType: 'delete', payload: {} }]);
    let n = 0; const makeId = () => `catalog-update-${++n}`;
    const before = await loadSharedFacts(d.database, groupId);
    const evidence = member.repository.evidenceForServerReceipts(receiptsFor(before));
    await applyReceivedSharedFacts(member.database, groupId, before, String(before.length), member.repository.project, null, Date.parse('2026-10-27T01:00:00Z'), evidence);
    const memberCount = (await listSharingOutbox(member.database, groupId)).length;
    assert.equal(await ensureV2CatalogCurrent(member.repository, makeId), false);
    assert.equal((await listSharingOutbox(member.database, groupId)).length, memberCount);
    assert.equal(await ensureV2CatalogCurrent(d.repository, makeId), true);
    const state = await d.repository.readState();
    assert.equal(state.replica.entities.find(row => row.entityId === `${groupId}.builtin-chore-02`).fields.name, '共有の名前');
    assert.deepEqual(state.replica.entities.find(row => row.entityId === `${groupId}.builtin-chore-02`).fields.instructions, ['共有の手順']);
    assert.equal(state.replica.entities.find(row => row.entityId === `${groupId}.builtin-chore-02`).fields.estimatedMinutes, 35);
    assert.equal(state.replica.entities.find(row => row.entityId === `${groupId}.builtin-chore-04`).deleted, true);
    const added = state.replica.entities.filter(row => row.entityType === 'chore' && Number(row.entityId.slice(-2)) > 20);
    assert.equal(added.length, 26); assert.ok(added.every(row => row.fields.enabled === false));
    const after = await loadSharedFacts(d.database, groupId);
    assert.equal(after.filter(fact => ['chorePolicy','completion','baseline'].includes(fact.operation.entityType)).length,
      before.filter(fact => ['chorePolicy','completion','baseline'].includes(fact.operation.entityType)).length);
    assert.equal(await ensureV2CatalogCurrent(d.repository, makeId), true);
    assert.deepEqual(await loadSharedFacts(d.database, groupId), after);
    assert.equal(CHORE_CATALOG.length, 36);
  } finally { d.connection.close(); member.connection.close(); }
});
