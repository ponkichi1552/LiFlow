import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { applianceResult, manualUrl } from './helpers/sharing-v2-appliance.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2ApplianceId } from '../src/features/sharing/v2/appliance-actions.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
function controller(device, clock = now) { let n = 0; return createV2GroupController(device.repository, { makeId: () => `appliance-${device.options.userId}-${++n}`, now: clock, sync: async () => {} }); }
const read = (c, id) => c.readModel(range, { appliances: true, applianceId: id });
const detail = async (c, id) => (await read(c, id)).appliances.detail;
async function receive(device, facts) { const checkpoint = await readSharingCheckpoint(device.database, groupId);
  await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, checkpoint.cursor, now().getTime(), device.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup(userId = 'owner') {
  const base = await fixture(); const owner = await base.device(); await owner.repository.commit(seeds());
  const device = userId === 'owner' ? owner : await base.device('member', base.member);
  if (device !== owner) await receive(device, await loadSharedFacts(owner.database, groupId));
  const c = controller(device); const result = applianceResult();
  const save = extra => c.actions.reviewAppliance({ reviewed: true, result, addTaskNames: result.analysis.tasks.map(task => task.name), ...extra });
  return { base, owner, device, c, result, save, close() { if (owner !== device) owner.connection.close(); device.connection.close(); } };
}

test('v2 a member explicitly shares reviewed appliance content and only new disabled chores without claiming administrator cadence', async () => {
  const f = await setup('member');
  try {
    const before = (await read(f.c)).plan; const saved = await f.save(); const value = await detail(f.c, saved.applianceId);
    assert.equal(value.appliance.analysis.tasks.length, 2); assert.equal(value.appliance.householdId, `shared:${groupId}`); assert.equal(value.row.needsReview, false);
    assert.equal(saved.createdChoreIds.length, 2); const model = await read(f.c);
    assert.deepEqual(model.plan.occurrences, before.occurrences);
    for (const chore of saved.operations.filter(operation => operation.entityType === 'chore')) {
      assert.equal(chore.payload.enabled, false); assert.deepEqual(chore.payload.instructions, ['電源を切る', '公式の手順で手入れする']);
      for (const field of ['userIntervalDays', 'recommendedCycleDays', 'manufacturerRecommendedIntervalDays', 'frequencyDaysByMode', 'windowRadiusDays', 'maxShiftDays', 'load', 'estimatedMinutes']) assert.equal(Object.hasOwn(chore.payload, field), false, field);
    }
    assert.equal((await f.device.repository.readState()).assessment.rejected.length, 0);
    assert.equal((await f.c.readModel(range)).appliances, undefined);
    assert.equal(Object.hasOwn(model.appliances.rows[0], 'analysis'), false); assert.equal(model.appliances.detail, undefined);
  } finally { f.close(); }
});

test('v2 appliance reanalysis preserves user edited chores their common cadence completion and tombstones', async () => {
  const f = await setup();
  try {
    const saved = await f.save(); const [first, second] = saved.createdChoreIds;
    await f.device.repository.commit([draft('user-chore-text', 'chore', first, { name: '私たちの掃除', instructions: ['編集した手順'], enabled: true }),
      draft('user-chore-cadence', 'chorePolicy', first, { configuration: { ...seeds()[3].payload.configuration, intervalDays: 17 } }),
      { ...draft('user-chore-delete', 'chore', second, {}), operationType: 'delete' }]);
    const before = await f.c.readModel(range); const round = before.plan.occurrences.find(row => row.choreId === first);
    assert.ok(round); await f.c.actions.complete({ choreId: first, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: null }, { performedAt: now().toISOString() });
    const knownChores = (await loadSharedFacts(f.device.database, groupId)).filter(fact => fact.operation.entityType !== 'appliance');
    const result = applianceResult(['フィルター清掃', '水滴を拭く', 'ブラシの確認']); result.analysis.tasks[0].steps = ['解析で変わった手順']; result.analysis.tasks[0].recommendedIntervalDays = 60;
    const current = await detail(f.c, saved.applianceId);
    const next = await f.save({ result, selection: current.row.selection, addTaskNames: result.analysis.tasks.map(task => task.name) });
    assert.equal(next.createdChoreIds.length, 1); assert.deepEqual(next.preservedTaskNames, ['フィルター清掃', '水滴を拭く']);
    const afterFacts = await loadSharedFacts(f.device.database, groupId);
    assert.deepEqual(afterFacts.filter(fact => knownChores.some(old => old.operation.operationId === fact.operation.operationId)), knownChores);
    assert.equal(next.operations.some(op => [first, second].includes(op.entityId)), false);
    const model = await read(f.c, saved.applianceId); assert.equal(model.plan.chores.find(row => row.id === first).name, '私たちの掃除');
    assert.equal(model.configurations.find(row => row.choreId === first).configuration.intervalDays, 17);
    assert.ok(model.plan.history.some(row => row.choreId === first)); assert.equal(model.plan.occurrences.some(row => row.choreId === second), false);
    assert.deepEqual(model.appliances.detail.appliance.analysis.tasks[0].steps, ['解析で変わった手順']);
  } finally { f.close(); }
});

test('v2 concurrent registration on separate devices shares stable appliance and chore identities without duplicate schedules', async () => {
  const f = await setup(); const member = await f.base.device('member', f.base.member);
  try {
    await receive(member, await loadSharedFacts(f.device.database, groupId)); const b = controller(member); const result = applianceResult();
    const a = await f.save(); result.analysis.tasks[0].steps = ['別端末で確認した手順'];
    const other = await b.actions.reviewAppliance({ reviewed: true, result, addTaskNames: result.analysis.tasks.map(task => task.name) });
    assert.equal(a.applianceId, other.applianceId); assert.deepEqual(a.createdChoreIds, other.createdChoreIds);
    await receive(f.device, (await loadSharedFacts(member.database, groupId)).reverse()); await receive(member, await loadSharedFacts(f.device.database, groupId));
    const model = await read(f.c, a.applianceId); assert.equal(model.appliances.rows.length, 1); assert.equal(model.appliances.detail.source.kind, 'conflict');
    assert.equal(model.plan.chores.length, 3); assert.ok(model.plan.occurrences.every(row => row.choreId === 'floor'));
    assert.deepEqual((await read(b, a.applianceId)).appliances, model.appliances);
  } finally { member.connection.close(); f.close(); }
});

test('v2 identical appliance content at different operation times does not manufacture an analysis conflict', async () => {
  const f = await setup(); const member = await f.base.device('member', f.base.member);
  try {
    const saved = await f.save(); await receive(member, await loadSharedFacts(f.device.database, groupId));
    const a = controller(member, () => new Date('2026-10-28T01:00:00Z')); const result = applianceResult(); result.product.productName = '共通の更新名';
    const row = (await detail(f.c, saved.applianceId)).row;
    await f.save({ result, selection: row.selection, addTaskNames: [] }); await a.actions.reviewAppliance({ reviewed: true, result, selection: row.selection, addTaskNames: [] });
    await receive(f.device, await loadSharedFacts(member.database, groupId)); const current = await detail(f.c, saved.applianceId);
    assert.equal(current.source.kind, 'value'); assert.equal(current.row.candidateCount, 2); assert.equal(current.appliance.productName, '共通の更新名');
  } finally { member.connection.close(); f.close(); }
});

test('v2 repairing a malformed analysis at a later time retains the custom appliance name and original registration instant', async () => {
  const f = await setup();
  try {
    const saved = await f.save(); const first = await detail(f.c, saved.applianceId); const malformed = applianceResult().analysis; malformed.tasks[0].recommendedConditions = {};
    await f.device.repository.commit([draft('malformed-with-custom-name', 'appliance', saved.applianceId, { displayName: 'ずっと使う掃除機', analysis: malformed, reviewed: true })]);
    const current = await detail(f.c, saved.applianceId); let id = 0;
    const later = createV2GroupController(f.device.repository, { makeId: () => `later-repair-${++id}`, now: () => new Date('2026-11-01T01:00:00Z'), sync: async () => {} });
    await later.actions.reviewAppliance({ reviewed: true, result: applianceResult(), selection: current.row.selection, addTaskNames: [] });
    const after = await detail(later, saved.applianceId); assert.equal(after.appliance.displayName, 'ずっと使う掃除機');
    assert.equal(after.appliance.createdAt, first.appliance.createdAt); assert.equal(after.appliance.updatedAt, '2026-11-01T01:00:00.000Z');
  } finally { f.close(); }
});

test('v2 appliance retries serialize to one identity including supported Japanese manufacturer aliases and never duplicate chores', async () => {
  const f = await setup();
  try {
    const [first, retry] = await Promise.all([f.save(), f.save()]); assert.equal(first.applianceId, retry.applianceId); assert.equal(retry.operations.length, 0);
    const before = await listSharingOutbox(f.device.database, groupId); assert.equal((await read(f.c)).appliances.rows.length, 1);
    assert.equal(v2ApplianceId(groupId, ' ダイソン ', 'ＳＶ２０'), first.applianceId);
    const changed = applianceResult(); changed.product.manufacturer = 'ダイソン';
    await assert.rejects(f.save({ result: changed }), { code: 'sharing/v2-appliance-exists' });
    const current = await detail(f.c, first.applianceId); await f.save({ selection: current.row.selection });
    assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before);
  } finally { f.close(); }
});

test('v2 new appliance review rejects malformed metadata mismatched identities sources and unreviewed results atomically', async () => {
  const f = await setup();
  try {
    const before = await listSharingOutbox(f.device.database, groupId);
    const invalid = [value => { value.analysis = null; }, value => { value.analysis.model = 'SV99'; }, value => { value.analysis.manufacturer = 'Panasonic'; },
      value => { value.officialSources.manualUrl = 'https://example.test/manual'; }, value => { value.product.category = {}; },
      value => { value.analysis.tasks[0].recommendedConditions = '汚れたとき'; }, value => { value.analysis.tasks[0].steps = []; },
      value => { value.analysis.tasks.push(value.analysis.tasks[0]); }];
    for (const corrupt of invalid) { const result = applianceResult(); corrupt(result); await assert.rejects(f.save({ result })); }
    await assert.rejects(f.save({ reviewed: false })); await assert.rejects(f.save({ addTaskNames: ['未解析の項目'] }));
    await assert.rejects(f.save({ reviewedDisplayName: {} })); await assert.rejects(f.save({ addTaskNames: ['フィルター清掃', 'フィルター清掃'] }));
    assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal((await read(f.c)).appliances.rows.length, 0);
    const alias = applianceResult(); alias.analysis.manufacturer = 'ダイソン'; alias.analysis.model = 'ＳＶ２０';
    assert.equal((await f.save({ result: alias })).createdChoreIds.length, 2);
  } finally { f.close(); }
});

test('v2 an oversized reviewed appliance rolls back its analysis and new chores together rather than leaving partial outbox entries', async () => {
  const f = await setup();
  try {
    const before = await listSharingOutbox(f.device.database, groupId); const result = applianceResult(); result.analysis.tasks[0].steps = ['手'.repeat(200000)];
    await assert.rejects(f.save({ result }));
    assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before); assert.equal((await read(f.c)).appliances.rows.length, 0);
    assert.equal((await f.device.repository.readState()).assessment.view.ofType('chore').length, 1);
  } finally { f.close(); }
});

test('v2 concurrent appliance reviews expose complete original bundles and an explicit current resolution converges out of order', async () => {
  const f = await setup(); const member = await f.base.device('member', f.base.member);
  try {
    const saved = await f.save(); await receive(member, await loadSharedFacts(f.device.database, groupId)); const b = controller(member);
    const original = await detail(f.c, saved.applianceId); const resultA = applianceResult(); resultA.product.productName = '名前A'; resultA.analysis.tasks[0].steps = ['手順A'];
    const resultB = applianceResult(); resultB.product.productName = '名前B'; resultB.analysis.tasks[0].steps = ['手順B'];
    await f.save({ result: resultA, selection: original.row.selection, addTaskNames: [] });
    await b.actions.reviewAppliance({ reviewed: true, result: resultB, selection: original.row.selection, addTaskNames: [] });
    await receive(f.device, (await loadSharedFacts(member.database, groupId)).reverse()); const current = await detail(f.c, saved.applianceId);
    assert.equal(current.source.kind, 'conflict'); assert.equal(current.appliance, null); assert.equal(current.row.needsReview, true);
    for (const candidate of current.candidates) assert.deepEqual(candidate.appliance.analysis.tasks[0].steps, [candidate.appliance.productName === '名前A' ? '手順A' : '手順B']);
    const before = await listSharingOutbox(f.device.database, groupId); const all = current.candidates.map(row => row.operationId);
    await assert.rejects(f.save({ result: resultB, selection: original.row.selection, resolveOperationIds: all, addTaskNames: [] }), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(f.save({ result: resultB, selection: current.row.selection, resolveOperationIds: all.slice(0, 1), addTaskNames: [] }), { code: 'sharing/v2-stale-settings' });
    assert.deepEqual(await listSharingOutbox(f.device.database, groupId), before);
    await f.save({ result: resultB, selection: current.row.selection, resolveOperationIds: all, addTaskNames: [] });
    await receive(member, await loadSharedFacts(f.device.database, groupId)); await receive(f.device, await loadSharedFacts(member.database, groupId));
    assert.deepEqual((await read(f.c, saved.applianceId)).appliances, (await read(b, saved.applianceId)).appliances);
    assert.equal((await detail(f.c, saved.applianceId)).appliance.productName, '名前B');
  } finally { member.connection.close(); f.close(); }
});

test('v2 appliance deletion preserves linked chores and restoration requires a current reviewed bundle without resurrecting deleted chores', async () => {
  const f = await setup(); const member = await f.base.device('member', f.base.member);
  try {
    const saved = await f.save(); const original = await detail(f.c, saved.applianceId);
    await receive(member, await loadSharedFacts(f.device.database, groupId)); const b = controller(member);
    await f.c.actions.deleteAppliance(original.row.selection);
    const result = applianceResult(); result.product.productName = '別端末の編集';
    await b.actions.reviewAppliance({ reviewed: true, result, selection: original.row.selection, addTaskNames: [] });
    await receive(f.device, await loadSharedFacts(member.database, groupId)); const conflict = await detail(f.c, saved.applianceId);
    assert.equal(conflict.alive.kind, 'conflict'); assert.equal(conflict.appliance, null);
    await assert.rejects(f.save({ result, selection: conflict.row.selection }), { code: 'sharing/v2-stale-settings' });
    const choresBefore = (await loadSharedFacts(f.device.database, groupId)).filter(fact => fact.operation.entityType === 'chore');
    await f.save({ result, selection: conflict.row.selection, restorePresence: true, addTaskNames: [] });
    const current = await detail(f.c, saved.applianceId); assert.ok(current.appliance);
    await assert.rejects(f.c.actions.deleteAppliance({ ...current.row.selection, groupId: 'another' }), { code: 'sharing/v2-stale-settings' });
    await f.c.actions.deleteAppliance(current.row.selection); assert.equal((await detail(f.c, saved.applianceId)).row.deleted, true);
    assert.deepEqual((await loadSharedFacts(f.device.database, groupId)).filter(fact => fact.operation.entityType === 'chore'), choresBefore);
  } finally { member.connection.close(); f.close(); }
});

test('v2 legacy partial appliance edits use their causal source and malformed stored analysis stays visible for explicit repair', async () => {
  const f = await setup();
  try {
    const saved = await f.save(); await f.device.repository.commit([draft('custom-appliance-name', 'appliance', saved.applianceId, { displayName: '私たちの掃除機' })]);
    let current = await detail(f.c, saved.applianceId); assert.equal(current.appliance.displayName, '私たちの掃除機'); assert.equal(current.appliance.officialManualUrl, manualUrl);
    const broken = applianceResult().analysis; broken.tasks[0].recommendedConditions = { text: '旧データ' };
    await f.device.repository.commit([draft('legacy-malformed-analysis', 'appliance', saved.applianceId, { analysis: broken, reviewed: true })]);
    current = await detail(f.c, saved.applianceId); assert.equal(current.row.needsReview, true); assert.equal(current.appliance, null);
    const original = (await loadSharedFacts(f.device.database, groupId)).find(fact => fact.operation.operationId === 'legacy-malformed-analysis');
    const priorCreatedAt = (await loadSharedFacts(f.device.database, groupId)).find(fact => fact.operation.entityType === 'appliance').operation.payload.createdAt;
    await f.save({ selection: current.row.selection, addTaskNames: [] }); current = await detail(f.c, saved.applianceId); assert.ok(current.appliance);
    assert.deepEqual((await loadSharedFacts(f.device.database, groupId)).find(fact => fact.operation.operationId === 'legacy-malformed-analysis'), original);
    assert.equal(current.appliance.displayName, '私たちの掃除機'); assert.equal(current.appliance.createdAt, priorCreatedAt);
  } finally { f.close(); }
});

test('v2 uploaded manual review shares digest provenance and reviewed tasks but never uploads the original PDF', async () => {
  const f = await setup();
  try {
    const result = applianceResult(); const reference = 'liflow-manual://sha256/' + 'b'.repeat(64);
    result.officialSources = { manualUrl: reference };
    result.analysis.manualSource = { kind: 'user_upload', sha256: 'b'.repeat(64) };
    for (const task of result.analysis.tasks) task.evidence = [{ url: reference, pageOrSection: '3ページ' }];
    const saved = await f.save({ result }); const value = await detail(f.c, saved.applianceId);
    assert.equal(value.row.needsReview, false); assert.deepEqual(value.appliance.analysis, result.analysis);
    assert.equal(JSON.stringify(saved.operations).includes('base64'), false);
    assert.equal(JSON.stringify(saved.operations).includes('file_data'), false);
    assert.equal((await f.device.repository.readState()).assessment.rejected.length, 0);
  } finally { f.close(); }
});
