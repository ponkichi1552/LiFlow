import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import './helpers/typescript-loader.mjs';
import test from 'node:test';

const repository = await import('../src/platform/storage/repository.ts');
const { createPlannerRefreshController } = await import('../src/features/planner/refresh-controller.ts');


function task(name, intervalDays, evidenceUrl, step) {
  return {
    name,
    ...(intervalDays !== undefined ? { recommendedIntervalDays: intervalDays } : {}),
    ...(intervalDays === undefined ? { recommendedConditions: ['汚れが気になったとき'] } : {}),
    steps: [step],
    tools: ['やわらかい布'],
    safetyCautions: ['電源を切る'],
    estimatedMinutes: 5,
    evidence: [{ url: evidenceUrl, pageOrSection: 'お手入れ' }],
  };
}

function analysis(modelNumber, tasks, analyzedAt) {
  return {
    manufacturer: 'Dyson',
    model: modelNumber,
    tasks,
    analyzedAt,
    requiresUserReview: true,
  };
}

function product(productName, modelNumber) {
  return {
    manufacturer: 'Dyson',
    productName,
    modelNumber,
    category: '掃除機',
    officialProductUrl: 'https://www.dyson.co.jp/products/vacuum-cleaners',
    manualUrl: `https://www.dyson.co.jp/support/journey/${modelNumber}`,
  };
}

test('appliance display names avoid a repeated manufacturer and preserve stored source data and custom names', async () => {
  const { connection, database } = createDatabase();
  try {
    await repository.initializeLocalDatabase(database);
    const identity = product('Dyson V12 Detect Slim', 'SV20');
    const careTask = task('フィルター清掃', 30, identity.manualUrl, '清掃手順');
    const draft = analysis('SV20', [careTask], '2026-10-26T00:00:00.000Z');
    const saved = await repository.saveReviewedApplianceCare(database, identity, draft, [{ task: careTask }]);
    const expected = 'Dyson V12 Detect Slim（SV20）';
    assert.equal(connection.prepare('SELECT display_name FROM appliances WHERE id = ?').get(saved.applianceId).display_name, expected);
    const legacyName = 'Dyson Dyson V12 Detect Slim（SV20）';
    connection.prepare('UPDATE appliances SET display_name = ? WHERE id = ?').run(legacyName, saved.applianceId);
    const snapshot = await repository.loadPlannerSnapshot(database, '2026-10-26');
    assert.equal(snapshot.appliances.find((item) => item.id === saved.applianceId).displayName, expected);
    const context = await repository.loadApplianceCareReviewContext(database, saved.applianceId);
    assert.equal(context.appliance.displayName, expected);
    assert.equal(context.appliance.productName, identity.productName);
    assert.deepEqual(context.appliance.analysis, draft);
    assert.equal(connection.prepare('SELECT display_name FROM appliances WHERE id = ?').get(saved.applianceId).display_name, legacyName);
    connection.prepare('UPDATE appliances SET display_name = ? WHERE id = ?').run('リビングの掃除機', saved.applianceId);
    assert.equal((await repository.loadApplianceCareReviewContext(database, saved.applianceId)).appliance.displayName, 'リビングの掃除機');
  } finally { connection.close(); }
});

test('saving appliance care refreshes the shared snapshot; reading its detail preserves the cache', async () => {
  const { connection, database } = createDatabase();
  try {
    await repository.initializeLocalDatabase(database);
    const controller = createPlannerRefreshController({
      load: async () => ({
        snapshot: repository.readCachedPlannerSnapshot(database) ?? await repository.loadPlannerSnapshot(database),
        canPublishWidget: true,
      }),
      weather: async () => null,
      publish: () => {},
    });
    await controller.refresh();
    const before = controller.getSnapshot().snapshot;
    const careTask = task('フィルター清掃', 30, 'https://www.dyson.co.jp/support/journey/SV20#filter', '清掃手順');
    const saved = await repository.saveReviewedApplianceCare(database, product('V12 Detect Slim', 'SV20'),
      analysis('SV20', [careTask], new Date().toISOString()), [{ task: careTask }]);
    assert.equal(repository.readCachedPlannerSnapshot(database), null);
    await controller.refresh();
    const after = controller.getSnapshot().snapshot;
    assert.notEqual(after, before);
    assert.equal(after.appliances.some((item) => item.id === saved.applianceId), true);
    assert.equal(after.chores.some((item) => item.applianceId === saved.applianceId), true);
    await repository.loadApplianceCareReviewContext(database, saved.applianceId);
    assert.equal(repository.readCachedPlannerSnapshot(database), after);
  } finally { connection.close(); }
});

test('repository saves and retrieves appliance snapshots, separates no-cycle tasks, distinguishes same-category appliances, and preserves overrides and history on reanalysis', async () => {
  const { connection, database } = createDatabase();
  try {
    await repository.initializeLocalDatabase(database);
    const firstRunSnapshot = await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(firstRunSnapshot.settings.setupCompleted, false);
    assert.equal(firstRunSnapshot.settings.notificationsEnabled, false);

    const originalTasks = [
      task('フィルター清掃', 30, 'https://www.dyson.co.jp/support/journey/SV20#filter', '旧手順'),
      task('汚れを確認', undefined, 'https://www.dyson.co.jp/support/journey/SV20#care', '条件時の手順'),
    ];
    const initial = await repository.saveReviewedApplianceCare(
      database,
      product('V12 Detect Slim', 'SV20'),
      analysis('SV20', originalTasks, '2026-10-24T00:00:00.000Z'),
      [
        { task: originalTasks[0], userIntervalDays: 60 },
        { task: originalTasks[1] },
      ],
    );

    assert.equal(initial.scheduledTaskCount, 1);
    assert.equal(initial.noCycleTaskCount, 1);
    const firstContext = await repository.loadApplianceCareReviewContext(database, initial.applianceId);
    assert.equal(firstContext.appliance.analysis.tasks.length, 2);
    assert.equal(firstContext.appliance.analysis.tasks[1].evidence[0].pageOrSection, 'お手入れ');
    assert.equal(firstContext.chores.length, 1);
    const firstChore = firstContext.chores[0];
    assert.equal(firstChore.userIntervalDays, 60);
    assert.equal(firstChore.manufacturerRecommendedIntervalDays, 30);
    assert.equal(firstChore.applianceCareSource.evidence[0].url, originalTasks[0].evidence[0].url);
    const changedIdentityTask = task('別製品の手入れ', 30, 'https://www.dyson.co.jp/support/journey/OTHER#care', '手順');
    await assert.rejects(repository.saveReviewedApplianceCare(
      database,
      { ...product('別製品', 'OTHER'), applianceId: initial.applianceId },
      analysis('OTHER', [changedIdentityTask], '2026-10-24T00:30:00.000Z'),
      [{ task: changedIdentityTask }],
    ), /再解析で変更できません/u);

    connection.prepare(`
      INSERT INTO chore_completions
      (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('history-1', repository.LOCAL_HOUSEHOLD_ID, firstChore.id, '2026-10-20T10:00:00.000Z', 'inApp', 'entry-1', 'completed');

    const revisedTask = task('フィルター清掃', 30, 'https://www.dyson.co.jp/support/journey/SV20#filter-update', '新手順');
    await repository.saveReviewedApplianceCare(
      database,
      { ...product('V12 Detect Slim', 'SV20'), applianceId: initial.applianceId },
      analysis('SV20', [revisedTask], '2026-10-24T01:00:00.000Z'),
      [{ task: revisedTask }],
    );

    const revisedContext = await repository.loadApplianceCareReviewContext(database, initial.applianceId);
    assert.equal(revisedContext.appliance.analysis.tasks[0].steps[0], '新手順');
    assert.equal(revisedContext.appliance.analysis.tasks[0].evidence[0].url, revisedTask.evidence[0].url);
    assert.equal(revisedContext.chores.length, 1);
    assert.equal(revisedContext.chores[0].id, firstChore.id);
    assert.equal(revisedContext.chores[0].instructions[0], '新手順');
    assert.equal(revisedContext.chores[0].userIntervalDays, 60);
    assert.equal(revisedContext.chores[0].manufacturerRecommendedIntervalDays, 30);
    const snapshotAfterReanalysis = await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(snapshotAfterReanalysis.completions.some((item) => item.id === 'history-1'), true);
    assert.equal(snapshotAfterReanalysis.chores.some((item) => item.name.includes('汚れを確認')), false);

    const secondTasks = [task('ブラシの点検', 14, 'https://www.dyson.co.jp/support/journey/OTHER#brush', '点検手順')];
    const second = await repository.saveReviewedApplianceCare(
      database,
      product('別の掃除機', 'OTHER'),
      analysis('OTHER', secondTasks, '2026-10-24T02:00:00.000Z'),
      [{ task: secondTasks[0] }],
    );
    assert.notEqual(second.applianceId, initial.applianceId);
    const secondContext = await repository.loadApplianceCareReviewContext(database, second.applianceId);
    assert.equal(secondContext.appliance.modelNumber, 'OTHER');
    assert.equal(secondContext.chores.length, 1);
    assert.notEqual(secondContext.chores[0].id, revisedContext.chores[0].id);
  } finally {
    connection.close();
  }
});
