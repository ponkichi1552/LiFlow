import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createPersonalChoreDefinitions } from '../src/domain/chores/personal-catalog.ts';
import { standardSharedChores } from '../src/features/sharing/v2/standard-catalog.ts';
import { v2GroupBootstrap } from '../src/features/sharing/v2/bootstrap.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
import { ensureV2CatalogCurrent } from '../src/features/sharing/v2/catalog-update.ts';

const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const value = { policy: chorePolicyFromPreset('common'), anchorDate: range.from, intervalDays: 7, windowBeforeDays: 0, windowAfterDays: 0, effectiveFrom: range.from, active: true };
const bootstrap = () => v2GroupBootstrap({ groupId, ownerUserId: 'owner', ownerDisplayName: '所有者', name: '新版検査', timeZone: 'Asia/Tokyo', anchorDate: range.from, kind: 'family' });
const parent = `${groupId}.liflow-catalog-6.001`, child = `${groupId}.liflow-catalog-6.062`;
function controller(device) { let id = 0; return createV2GroupController(device.repository, { makeId: () => `${device.options.userId}-catalog-${++id}`, now, sync: async () => {} }); }
async function receive(device, facts) {
  const checkpoint = await readSharingCheckpoint(device.database, groupId);
  await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, checkpoint.cursor, now().getTime(), device.repository.evidenceForServerReceipts(receiptsFor(facts)));
}

test('fresh shared groups use exactly the personal bundled recipes without reading or sharing private state', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  const personal = createPersonalChoreDefinitions('catalog'), shared = standardSharedChores(groupId);
  assert.deepEqual(shared.map(chore => chore.id), personal.map(chore => `${groupId}.${chore.id}`));
  for (const [index, chore] of shared.entries()) {
    for (const field of ['name', 'category', 'description', 'estimatedMinutes', 'load', 'tools', 'instructions', 'cautions', 'trivia']) assert.deepEqual(chore.payload[field], personal[index][field]);
    assert.equal(chore.payload.enabled, false);
    for (const field of ['householdId', 'personalRecipeId', 'personalSchedulingKind', 'personalScheduleDefaults', 'ownerUserId']) assert.equal(Object.hasOwn(chore.payload, field), false);
  }
  await d.repository.commit(bootstrap());
  const c = controller(d); const before = await c.readModel(range);
  assert.equal(before.plan.chores.length, personal.length); assert.equal(before.plan.occurrences.length, 0);
  assert.equal(await ensureV2CatalogCurrent(d.repository, () => 'must-not-add-old-catalog'), true);
  const after = await c.readModel(range);
  assert.deepEqual(after.plan.chores.map(chore => chore.id), before.plan.chores.map(chore => chore.id));
  assert.ok(after.plan.chores.every(chore => !chore.id.includes('.builtin-chore-')));
});

test('nonperiodic shared recipes receive no invented numeric cadence and remain inactive before explicit setup', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  const chore = standardSharedChores(groupId).find(chore => chore.id.endsWith('.024'));
  assert.equal(chore.payload.requiresCycleSelection, true); assert.equal(chore.payload.frequencyDaysByMode, undefined);
  await d.repository.commit(bootstrap()); const c = controller(d);
  await assert.rejects(c.actions.patchChore(chore.id, { enabled: true }), /周期と担当/u);
  assert.equal((await c.readModel(range)).plan.occurrences.length, 0);
});

test('shared split selection atomically deactivates its parent and reactivation and reset keep the same catalogue defaults', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(bootstrap());
  const c = controller(d); await c.actions.configureChore(parent, value); await c.actions.configureChore(child, value);
  let model = await c.readModel(range);
  assert.equal(model.plan.chores.find(chore => chore.id === parent).enabled, false);
  assert.equal(model.configurations.find(row => row.choreId === parent).configuration.active, false);
  assert.ok(model.plan.occurrences.filter(round => !round.historical).every(round => round.choreId !== parent));
  await c.actions.patchChore(parent, { enabled: true }); model = await c.readModel(range);
  assert.equal(model.plan.chores.find(chore => chore.id === child).enabled, false);
  const version = model.configurations.find(row => row.choreId === parent).configuration.ruleVersion;
  await c.actions.patchChoreConfiguration(parent, version, { intervalDays: 19 }, range.from);
  model = await c.readModel(range); await c.actions.resetChoreSchedules([parent], { [parent]: model.configurations.find(row => row.choreId === parent).configuration.ruleVersion });
  assert.equal((await c.readModel(range)).configurations.find(row => row.choreId === parent).configuration.intervalDays, 7);
});

test('a receiver does not schedule overlapping shared parent and split selections even when conflicting owner operations bypass the normal controls', async t => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  t.after(() => { owner.connection.close(); member.connection.close(); }); await owner.repository.commit(bootstrap());
  const c = controller(owner); await c.actions.configureChore(parent, value); await c.actions.configureChore(child, value);
  const model = await c.readModel(range); const configuration = model.configurations.find(row => row.choreId === parent).configuration;
  await owner.repository.commit([{ operationId: 'deliberate-overlap-policy', entityType: 'chorePolicy', entityId: parent, operationType: 'patch', payload: { configuration: { ...configuration, active: true, ruleVersion: configuration.ruleVersion + 1 } } },
    { operationId: 'deliberate-overlap-flag', entityType: 'chore', entityId: parent, operationType: 'patch', payload: { enabled: true } }]);
  await receive(member, await loadSharedFacts(owner.database, groupId));
  const received = await controller(member).readModel(range);
  assert.ok(received.plan.issues.some(issue => issue.kind === 'catalogSelectionConflict'));
  assert.ok(received.plan.occurrences.every(round => round.choreId !== parent && round.choreId !== child));
});
