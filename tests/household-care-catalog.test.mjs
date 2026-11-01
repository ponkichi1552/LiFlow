import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { HOUSEHOLD_CARE_GUIDE } from '../src/domain/chores/household-care-guide.ts';
import { CHORE_CATALOG, HOUSEHOLD_CARE_IDS, createHouseholdChoreDefinitions, builtInChoreCatalogEntry } from '../src/domain/chores/catalog.ts';
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
    assert.equal(chore.schedulingNotes, [row.frequency, row.conditions].filter(Boolean).join('\n'));
    assert.equal(chore.trivia?.[0]?.body ?? '', row.trivia);
    assert.deepEqual(chore.sourceNotes, [row.sourceUrl]);
  }
  assert.equal(builtInChoreCatalogEntry(HOUSEHOLD_CARE_IDS[12]).estimatedMinutes, 10, '675 minutes of machine operation is not the working-time estimate');
});

test('the expanded catalog preserves all original job IDs and daily jobs without assigning an ID to another job', () => {
  const rows = createHouseholdChoreDefinitions('home');
  assert.equal(rows.length, 46); assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.ok(createLegacyHouseholdChoreDefinitionsV3('home').every(row => rows.some(current => current.id === row.id)));
  assert.equal(builtInChoreCatalogEntry('group.builtin-chore-01').name, '浴室掃除');
  assert.equal(builtInChoreCatalogEntry('group.builtin-chore-02').estimatedMinutes, 35);
  assert.equal(builtInChoreCatalogEntry('builtin-chore-11').name, '食器を洗う');
  assert.equal(builtInChoreCatalogEntry('builtin-chore-16').name, '浴室の水滴取り・乾燥');
  assert.equal(builtInChoreCatalogEntry('builtin-chore-99'), undefined);
  for (const n of [10, 11]) assert.ok(isLaundryChore(rows.find(row => row.id === HOUSEHOLD_CARE_IDS[n - 1])));
  for (const n of [12, 13]) assert.equal(isLaundryChore(rows.find(row => row.id === HOUSEHOLD_CARE_IDS[n - 1])), false, 'machine maintenance is not weather-dependent laundry');
});

test('document cadence defaults stay explicit and unresolved product usage season and municipal cadences never schedule themselves', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {} });
    for (const n of [16,21,27,31,35,36]) {
      const chore = (await repository.loadPlannerSnapshot(h.database, day)).chores.find(row => row.id === HOUSEHOLD_CARE_IDS[n - 1]);
      assert.equal(chore.requiresCycleSelection, true); assert.equal(chore.enabled, false);
      await assert.rejects(repository.setChoreEnabled(h.database, chore.id, true), /周期/);
      await assert.rejects(repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id], previousDates: {} }), /周期/);
      assert.equal((await repository.loadPlannerSnapshot(h.database, day)).scheduleEntries.some(row => row.choreId === chore.id), false);
      await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 17, enabled: true });
      const current = (await repository.loadPlannerSnapshot(h.database, day)).chores.find(row => row.id === chore.id);
      assert.equal(current.requiresCycleSelection, false); assert.equal(current.recommendedCycleDays, 17); assert.equal(current.enabled, true);
      assert.equal(resetChoreSchedule(current).recommendedCycleDays, 17, 'reset must not replace a chosen cycle with the serialization placeholder');
      const cleared = applyChoreSettingsPatch(current, { cycleDays: null });
      assert.equal(cleared.requiresCycleSelection, true); assert.equal(cleared.enabled, false);
      await repository.updateChoreSettings(h.database, chore.id, { cycleDays: null });
    }
  } finally { h.connection.close(); }
});

function prepareV3(h) {
  h.connection.prepare('DELETE FROM chore_definitions WHERE CAST(substr(id,15) AS INTEGER)>20').run();
  for (const old of createLegacyHouseholdChoreDefinitionsV3('local-household')) h.connection.prepare('UPDATE chore_definitions SET name=?,enabled=?,definition_json=? WHERE id=?')
    .run(old.name, Number(old.enabled), JSON.stringify(old), old.id);
  h.connection.prepare('UPDATE household_settings SET built_in_chore_catalog_version=3').run();
}

test('version 3 to 4 updates only untouched fields, preserves history and explicit edits, and adds disabled jobs once', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: ['builtin-chore-01'], previousDates: {} });
    let before = await repository.loadPlannerSnapshot(h.database, day);
    await repository.completeChore(h.database, before.scheduleEntries.find(row => row.choreId === 'builtin-chore-01'));
    prepareV3(h);
    const range = createLegacyHouseholdChoreDefinitionsV3('local-household').find(row => row.id === 'builtin-chore-02');
    const custom = { ...range, enabled: false, name: '自分の換気扇', instructions: ['自分の手順'], recommendedCycleDays: 17, load: 'light',
      frequencyDaysByMode: { frequent: 23, balanced: 90, relaxed: 180 } };
    h.connection.prepare('UPDATE chore_definitions SET name=?,enabled=0,definition_json=? WHERE id=?').run(custom.name, JSON.stringify(custom), custom.id);
    const history = h.connection.prepare('SELECT * FROM chore_completions ORDER BY id').all();
    const state = h.connection.prepare('SELECT * FROM chore_state WHERE chore_id=\'builtin-chore-01\'').get();
    const enabled = h.connection.prepare('SELECT id,enabled FROM chore_definitions ORDER BY id').all();
    await repository.initializeLocalDatabase({ ...h.database });
    before = await repository.loadPlannerSnapshot(h.database, day);
    assert.equal(before.chores.length, 46);
    const updated = before.chores.find(row => row.id === custom.id);
    assert.equal(updated.name, custom.name); assert.deepEqual(updated.instructions, custom.instructions); assert.equal(updated.load, 'light');
    assert.deepEqual(updated.frequencyDaysByMode, { frequent: 23, balanced: 60, relaxed: 90 });
    assert.equal(updated.recommendedCycleDays, 17); assert.equal(updated.enabled, false); assert.equal(updated.estimatedMinutes, 35);
    assert.equal(before.chores.find(row => row.id === 'builtin-chore-01').name, '浴室掃除');
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions ORDER BY id').all(), history);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_state WHERE chore_id=\'builtin-chore-01\'').get(), state);
    for (const row of enabled) assert.equal(h.connection.prepare('SELECT enabled FROM chore_definitions WHERE id=?').get(row.id).enabled, row.enabled);
    assert.ok(before.chores.filter(row => Number(row.id.slice(-2)) > 20).every(row => !row.enabled));
    const writes = h.writes.length;
    await repository.initializeLocalDatabase({ ...h.database });
    assert.equal(h.writes.slice(writes).filter(row => /UPDATE chore_definitions|INSERT OR IGNORE INTO chore_definitions/.test(row.sql)).length, 0);
  } finally { h.connection.close(); }
});

test('catalog migration failure rolls back definitions and version so a later retry remains possible', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); prepareV3(h);
    const before = h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all();
    h.connection.exec("CREATE TRIGGER stop_catalog BEFORE INSERT ON chore_definitions WHEN NEW.id='builtin-chore-25' BEGIN SELECT RAISE(ABORT,'catalog rollback'); END");
    const reopened = { ...h.database };
    await assert.rejects(repository.initializeLocalDatabase(reopened), /catalog rollback/);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_definitions ORDER BY id').all(), before);
    assert.equal(h.connection.prepare('SELECT built_in_chore_catalog_version AS v FROM household_settings').get().v, 3);
    h.connection.exec('DROP TRIGGER stop_catalog'); await repository.initializeLocalDatabase(reopened);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_definitions').get().n, 46);
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
    assert.equal(added.length, 26); assert.ok(added.every(row => row.fields.enabled === false && row.fields.requiresCycleSelection === true));
    const after = await loadSharedFacts(d.database, groupId);
    assert.equal(after.filter(fact => ['chorePolicy','completion','baseline'].includes(fact.operation.entityType)).length,
      before.filter(fact => ['chorePolicy','completion','baseline'].includes(fact.operation.entityType)).length);
    assert.equal(await ensureV2CatalogCurrent(d.repository, makeId), true);
    assert.deepEqual(await loadSharedFacts(d.database, groupId), after);
    assert.equal(CHORE_CATALOG.length, 46);
  } finally { d.connection.close(); member.connection.close(); }
});
