import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation, verifyAuthenticatedSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { sharedGroupBootstrap } from '../src/features/sharing/planning.ts';
import { createLocalSharedOperations, initializeSharingLedger, loadSharedReplica, listSharingOutbox, loadSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { createSharedPlannerRepository } from '../src/platform/storage/shared-planner-repository.ts';
import { registerSharedRepositoryAdapter } from '../src/platform/storage/shared-repository-adapter.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const now = new Date('2026-10-27T02:00:00Z');
const choreId = 'group-test.builtin-chore-08';
async function fixture() {
  const h = createDatabase(); const identity = await createDeviceIdentity(crypto);
  const scope = { userId: 'owner', groupId: 'group-test', householdId: repository.LOCAL_HOUSEHOLD_ID };
  const roster = createSharedRoster(scope.groupId, scope.userId, identity); let id = 0; let commits = 0;
  await initializeSharedProjection(h.database, scope); await initializeSharingLedger(h.database);
  const adapter = createSharedPlannerRepository(h.database, { ...scope, identity, roster: () => roster,
    makeId: () => `edit-${++id}`, now: () => now, afterCommit: () => commits++ });
  await createLocalSharedOperations(h.database, { ...scope, deviceId: identity.deviceId, keyVersion: 1 },
    sharedGroupBootstrap({ ...scope, ownerUserId: 'owner', ownerDisplayName: '自分', name: '家族', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }), adapter.project,
    (operation) => signSharedOperation(operation, identity).authorSignature);
  const unregister = registerSharedRepositoryAdapter(h.database, adapter);
  const snapshot = () => repository.loadPlannerSnapshot(h.database, '2026-10-27', now);
  return { ...h, scope, identity, roster, adapter, snapshot, commits: () => commits, close: () => { unregister(); h.connection.close(); } };
}

test('stale shared waste label edits preserve a newer weekly, biweekly or monthly collection rule', async () => {
  for (const change of [
    { recurrence: 'weekly', collectionWeekdays: [3] },
    { recurrence: 'biweekly', collectionWeekdays: [4], anchorDate: '2026-10-29' },
    { recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 28 },
  ]) {
    const h = await fixture();
    try {
      await repository.saveWeeklyWasteSchedule(h.database, { label: '可燃ごみ', collectionWeekdays: [2] });
      const displayed = (await h.snapshot()).wasteSchedules[0];
      await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, ...change });
      const intervening = (await h.snapshot()).wasteSchedules[0];
      await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, label: '資源ごみ' }, displayed);
      assert.deepEqual((await h.snapshot()).wasteSchedules[0], { ...intervening, label: '資源ごみ' });
    } finally { h.close(); }
  }
});

test('stale shared waste edits reject same-field overwrites and incompatible collection-rule combinations atomically', async () => {
  for (const change of [{ label: '缶' }, { recurrence: 'biweekly', collectionWeekdays: [2], anchorDate: '2026-10-27' }]) {
    const h = await fixture();
    try {
      await repository.saveWeeklyWasteSchedule(h.database, { label: '可燃ごみ', collectionWeekdays: [2] });
      const displayed = (await h.snapshot()).wasteSchedules[0];
      const proposed = 'label' in change ? { ...displayed, label: 'びん' } : { ...displayed, collectionWeekdays: [4] };
      await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, ...change });
      const before = (await h.snapshot()).wasteSchedules[0];
      const pending = (await listSharingOutbox(h.database, h.scope.groupId)).length;
      await assert.rejects(repository.saveWeeklyWasteSchedule(h.database, proposed, displayed), /別の端末/);
      assert.deepEqual((await h.snapshot()).wasteSchedules[0], before);
      assert.equal((await listSharingOutbox(h.database, h.scope.groupId)).length, pending);
    } finally { h.close(); }
  }
});

test('saving an untouched old waste form creates no event and does not restore an older shared value', async () => {
  const h = await fixture();
  try {
    await repository.saveWeeklyWasteSchedule(h.database, { label: '可燃ごみ', collectionWeekdays: [2] });
    const displayed = (await h.snapshot()).wasteSchedules[0];
    await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, label: '缶' });
    const pending = (await listSharingOutbox(h.database, h.scope.groupId)).length;
    await repository.saveWeeklyWasteSchedule(h.database, displayed, displayed);
    assert.equal((await h.snapshot()).wasteSchedules[0].label, '缶');
    assert.equal((await listSharingOutbox(h.database, h.scope.groupId)).length, pending);
  } finally { h.close(); }
});

for (const [platform, name] of [
  ['ios', 'ios waste editing passes its original displayed values when another group member changes the collection rule'],
  ['android', 'android waste editing passes its original displayed values when another group member changes the collection rule'],
]) test(name, async () => {
  const h = await fixture();
  try {
    await repository.saveWeeklyWasteSchedule(h.database, { label: '可燃ごみ', collectionWeekdays: [2] });
    let snapshot = await h.snapshot();
    const screen = screenHarness('src/app/waste.tsx', { platform, database: h.database, snapshot: () => snapshot,
      refresh: async () => { snapshot = await h.snapshot(); } });
    await screen.press('編集');
    const displayed = snapshot.wasteSchedules[0];
    await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, recurrence: 'monthly', monthlyDay: 28 });
    snapshot = await h.snapshot(); screen.render();
    await screen.change('ゴミの種類', 'びん');
    await screen.press('びんを選択');
    await screen.press('変更を保存');
    const saved = (await h.snapshot()).wasteSchedules[0];
    assert.equal(saved.label, 'びん');
    assert.equal(saved.recurrence, 'monthly');
    assert.equal(saved.monthlyDay, 28);
    assert.doesNotMatch(screen.text(), /別の端末/);
  } finally { h.close(); }
});

for (const [platform, name] of [
  ['ios', 'ios shared waste editor derives monthly and fortnight defaults from the group civil date'],
  ['android', 'android shared waste editor derives monthly and fortnight defaults from the group civil date'],
]) test(name, async () => {
  const h = await fixture();
  try {
    const snapshot = { ...await h.snapshot(), today: '2099-02-01' };
    const screen = screenHarness('src/app/waste.tsx', { platform, database: h.database, snapshot: () => snapshot });
    await screen.press('毎月');
    assert.equal(screen.nodes().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '毎月の収集日').props.value, '1');
    await screen.press('隔週'); await screen.press('月曜');
    assert.match(screen.text(), /2月2日/);
  } finally { h.close(); }
});

test('revalidating an unchanged shared roster reuses the snapshot instead of repeating the full planner and native outputs', async () => {
  const h = await fixture(); let denied = false;
  try {
    await repository.setChoreEnabled(h.database, choreId, true);
    const adapter = createSharedPlannerRepository(h.database, { ...h.scope, identity: h.identity,
      roster: () => structuredClone(h.roster), makeId: () => 'unused-test-operation', now: () => now,
      authorize: () => { if (denied) throw new Error('access revoked'); } });
    const first = await adapter.readSnapshot(now);
    const read = h.database.getAllAsync.bind(h.database); let bulkReads = 0;
    h.database.getAllAsync = async (...args) => { bulkReads++; return read(...args); };
    assert.equal(await adapter.readSnapshot(now), first);
    assert.equal(bulkReads, 0, 'a fresh validation of the same signed membership must not reload the event ledger');
    await repository.updateChoreSettings(h.database, choreId, { cycleDays: 9 });
    const changed = await adapter.readSnapshot(now);
    assert.notEqual(changed, first);
    assert.equal(changed.chores.find((chore) => chore.id === choreId).recommendedCycleDays, 9);
    denied = true;
    await assert.rejects(adapter.readSnapshot(now), /access revoked/, 'cached content never bypasses current authorization');
  } finally { h.close(); }
});

test('an authorization change during a shared cache read cannot return the previously authorized snapshot', async () => {
  const h = await fixture(); let denied = false;
  try {
    const adapter = createSharedPlannerRepository(h.database, { ...h.scope, identity: h.identity,
      roster: () => h.roster, makeId: () => 'unused-read-operation', now: () => now,
      authorize: () => { if (denied) throw new Error('access revoked during read'); } });
    await adapter.readSnapshot(now);
    const get = h.database.getFirstAsync.bind(h.database);
    h.database.getFirstAsync = async (...args) => {
      const value = await get(...args);
      if (args[0].includes('SELECT projection_token FROM sharing_workspace_metadata')) denied = true;
      return value;
    };
    await assert.rejects(adapter.readSnapshot(now), /access revoked during read/);
  } finally { h.close(); }
});

for (const [stage, name] of [
  [1, 'an asynchronous shared authorization rejection at write boundary 1 rolls back both projection and outbox'],
  [2, 'an asynchronous shared authorization rejection at write boundary 2 rolls back both projection and outbox'],
  [3, 'an asynchronous shared authorization rejection at write boundary 3 rolls back both projection and outbox'],
  [4, 'an asynchronous shared authorization rejection at write boundary 4 rolls back both projection and outbox'],
]) test(name, async () => {
  const h = await fixture(); let checks = 0; let committed = 0; let ordinal = 0;
  try {
    const before = await loadSharedReplica(h.database, h.scope.groupId);
    const pending = await listSharingOutbox(h.database, h.scope.groupId);
    const adapter = createSharedPlannerRepository(h.database, { ...h.scope, identity: h.identity, roster: () => h.roster,
      makeId: () => `asynchronous-edit-${++ordinal}`, now: () => now, afterCommit: () => committed++, authorize: async () => {
        await new Promise(setImmediate); if (++checks === stage) throw new Error('asynchronous registry revocation');
      } });
    await assert.rejects(adapter.mutate('setChoreEnabled', [choreId, true]), /asynchronous registry revocation/u);
    assert.deepEqual(await loadSharedReplica(h.database, h.scope.groupId), before);
    assert.deepEqual(await listSharingOutbox(h.database, h.scope.groupId), pending);
    assert.equal((await h.snapshot()).chores.find(chore => chore.id === choreId).enabled, false);
    assert.equal(committed, 0);
  } finally { h.close(); }
});

test('a shared cached snapshot awaits asynchronous registry authorization before returning private group content', async () => {
  const h = await fixture(); let deny = false;
  try {
    const adapter = createSharedPlannerRepository(h.database, { ...h.scope, identity: h.identity, roster: () => h.roster,
      makeId: () => 'unused-authorized-read', now: () => now, authorize: async () => {
        await new Promise(setImmediate); if (deny) throw new Error('asynchronous read revoked');
      } });
    const before = await adapter.readSnapshot(now); assert.ok(before.chores.length);
    deny = true; await assert.rejects(adapter.readSnapshot(now), /asynchronous read revoked/u);
  } finally { h.close(); }
});

test('a local shared edit waiting for SQLite cannot commit after account or membership authorization is revoked', async () => {
  const h = await fixture(); let release, entered; let denied = false, sequence = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  try {
    const adapter = createSharedPlannerRepository(h.database, { ...h.scope, identity: h.identity,
      roster: () => h.roster, makeId: () => `queued-enable-${++sequence}`, now: () => now,
      authorize: () => { if (denied) throw new Error('access revoked while queued'); } });
    const before = (await listSharingOutbox(h.database, h.scope.groupId)).length;
    const held = createLocalSharedOperations(h.database, { ...h.scope, deviceId: h.identity.deviceId, keyVersion: 1 },
      async () => { entered(); await barrier; return []; }, h.adapter.project);
    await started;
    const pending = adapter.mutate('setChoreEnabled', [choreId, true]);
    denied = true; release(); await held;
    await assert.rejects(pending, /access revoked while queued/);
    assert.equal((await h.snapshot()).chores.find((chore) => chore.id === choreId).enabled, false);
    assert.equal((await listSharingOutbox(h.database, h.scope.groupId)).length, before);
  } finally { release?.(); h.close(); }
});

test('revocation during a shared projection rolls back both the local edit and its outbox atomically', async () => {
  const h = await fixture(); let denied = false, sequence = 0;
  try {
    const adapter = createSharedPlannerRepository(h.database, { ...h.scope, identity: h.identity,
      roster: () => h.roster, makeId: () => `mid-write-${++sequence}`, now: () => now,
      authorize: () => { if (denied) throw new Error('access revoked during projection'); } });
    const before = (await listSharingOutbox(h.database, h.scope.groupId)).length;
    const run = h.database.runAsync.bind(h.database);
    h.database.runAsync = async (...args) => {
      const result = await run(...args);
      if (args[0].includes('INSERT INTO chore_definitions')) denied = true;
      return result;
    };
    await assert.rejects(adapter.mutate('setChoreEnabled', [choreId, true]), /access revoked during projection/);
    assert.equal(h.connection.prepare('SELECT enabled FROM chore_definitions WHERE id=?').get(choreId).enabled, 0);
    assert.equal((await listSharingOutbox(h.database, h.scope.groupId)).length, before);
  } finally { h.close(); }
});

test('existing repository controls dispatch to a bound group and sign atomic outbox changes without personal catalog seeding', async () => {
  const h = await fixture();
  try {
    await repository.setChoreEnabled(h.database, choreId, true);
    let snapshot = await h.snapshot(); const first = snapshot.scheduleEntries.find((entry) => entry.choreId === choreId);
    assert.ok(first); assert.equal(first.suggestedDate, '2026-10-27');
    assert.equal(await repository.updateChoreSettings(h.database, choreId, { cycleDays: 17 }), true);
    snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries[0].id, first.id);
    assert.equal(await repository.updateChoreSettings(h.database, choreId, { cycleDays: 17 }), false);
    assert.equal(h.commits(), 2);
    assert.equal(await repository.completeChore(h.database, snapshot.scheduleEntries[0]), true);
    snapshot = await h.snapshot(); const completion = snapshot.completions[0];
    assert.equal(completion.completedByMemberId, 'owner'); assert.equal(completion.completedLocalDate, '2026-10-27');
    assert.equal(await repository.undoCompletedChore(h.database, completion.id), true);
    snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries[0].id, first.id); assert.equal(snapshot.completions[0].outcome, 'incomplete');
    const facts = await loadSharedFacts(h.database, h.scope.groupId);
    for (const fact of facts.filter((fact) => fact.operation.operationId.startsWith('edit-'))) verifyAuthenticatedSharedOperation(fact, h.identity, h.scope.groupId);
    assert.ok((await listSharingOutbox(h.database, h.scope.groupId)).length > 42);
    assert.equal(h.connection.prepare("SELECT COUNT(*) AS n FROM chore_definitions WHERE id LIKE 'builtin-%'").get().n, 0);
    await assert.rejects(repository.completeFirstSetup(h.database, {}), /個人モード/);
    await assert.rejects(repository.setCalendarAvailabilityEnabled(h.database, true), /Google Calendar/);
  } finally { h.close(); }
});

test('rapid enable, interval changes and disable produce one stable initial occurrence with no stale entry writes', async () => {
  const h = await fixture();
  try {
    await Promise.all([repository.setChoreEnabled(h.database, choreId, true), repository.updateChoreSettings(h.database, choreId, { cycleDays: 17 }),
      repository.setChoreEnabled(h.database, choreId, false)]);
    let snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries.length, 0);
    await repository.setChoreEnabled(h.database, choreId, true); snapshot = await h.snapshot();
    assert.equal(snapshot.scheduleEntries.filter((entry) => entry.id === `${choreId}:initial`).length, 1);
    assert.equal(snapshot.chores.find((chore) => chore.id === choreId).recommendedCycleDays, 17);
    await repository.updateChoreSettings(h.database, choreId, { cycleDays: null });
    assert.equal((await h.snapshot()).chores.find((chore) => chore.id === choreId).recommendedCycleDays, undefined);
  } finally { h.close(); }
});

test('saving a stale full settings form changes only edited fields and rejects overwriting an intervening same-field edit', async () => {
  const h = await fixture();
  try {
    const displayed = (await h.snapshot()).settings;
    await repository.updatePlannerSettings(h.database, { ...displayed, heavyDailyLimit: 3 });
    await repository.updatePlannerSettings(h.database, { ...displayed, frequencyMode: 'relaxed' }, displayed);
    const current = (await h.snapshot()).settings;
    assert.equal(current.heavyDailyLimit, 3); assert.equal(current.frequencyMode, 'relaxed');
    const before = (await listSharingOutbox(h.database, h.scope.groupId)).length;
    await assert.rejects(repository.updatePlannerSettings(h.database, { ...displayed, heavyDailyLimit: 4 }, displayed), /別の端末/);
    assert.equal((await listSharingOutbox(h.database, h.scope.groupId)).length, before);
    assert.equal((await h.snapshot()).settings.heavyDailyLimit, 3);
  } finally { h.close(); }
});

test('shared chore autosave advances its own displayed baseline, rejects a stale remote overwrite and can explicitly reload the current settings', async () => {
  const h = await fixture(); let snapshot = await h.snapshot();
  try {
    const screen = screenHarness('src/app/chores/[id].tsx', { database: h.database, params: { id: choreId }, snapshot: () => snapshot,
      refresh: async () => { snapshot = await h.snapshot(); } });
    for (const value of ['17', '21']) {
      await screen.change('家事周期の日数', value); await screen.endEditing('家事周期の日数');
      assert.equal((await h.snapshot()).chores.find((c) => c.id === choreId).recommendedCycleDays, Number(value));
      assert.doesNotMatch(screen.text(), /別の端末/);
    }
    // A settled editor follows new remote settings. A draft already being edited
    // must instead preserve its baseline and reject overwriting that newer edit.
    await screen.change('家事周期の日数', '25');
    await repository.updateChoreSettings(h.database, choreId, { cycleDays: 9, load: 'heavy' });
    snapshot = await h.snapshot(); screen.render();
    await screen.endEditing('家事周期の日数');
    assert.equal((await h.snapshot()).chores.find((c) => c.id === choreId).recommendedCycleDays, 9);
    assert.match(screen.text(), /別の端末/);
    await screen.press('最新の設定を読み直す');
    assert.equal(screen.nodes().find((n) => n.type === 'TextInput' && n.props.accessibilityLabel === '家事周期の日数').props.value, '9');
    await screen.change('家事周期の日数', '11'); await screen.endEditing('家事周期の日数');
    const current = (await h.snapshot()).chores.find((c) => c.id === choreId);
    assert.equal(current.recommendedCycleDays, 11); assert.equal(current.load, 'heavy');
  } finally { h.close(); }
});

test('Google imports retain mapping and local pending intent and propagate complete/undo as shared events once', async () => {
  const h = await fixture();
  try {
    await repository.setChoreEnabled(h.database, choreId, true);
    const entry = (await h.snapshot()).scheduleEntries[0];
    const link = { scheduleEntryId: entry.id, choreId, householdId: h.scope.householdId, googleTaskListId: 'private-list', googleTaskId: 'private-task',
      createdAt: now.toISOString(), updatedAt: now.toISOString(), lastSyncedStatus: 'needsAction' };
    await repository.upsertGoogleTaskLink(h.database, link);
    const change = { ...link, status: 'completed', completedAt: now.toISOString() };
    assert.equal(await repository.importGoogleTaskChanges(h.database, [change, change]), 1);
    assert.equal(await repository.importGoogleTaskChanges(h.database, [change]), 0);
    assert.equal((await repository.listGoogleTaskLinks(h.database))[0].pendingStatus, undefined);
    await repository.acknowledgeGoogleTaskStatus(h.database, link, 'completed');
    assert.equal(await repository.importGoogleTaskChanges(h.database, [{ ...link, status: 'needsAction' }]), 1);
    assert.equal((await h.snapshot()).completions[0].outcome, 'incomplete');
    await repository.completeChore(h.database, (await h.snapshot()).scheduleEntries[0]);
    const outboxBefore = (await listSharingOutbox(h.database, h.scope.groupId)).length;
    assert.equal(await repository.importGoogleTaskChanges(h.database, [{ ...link, status: 'needsAction' }]), 0);
    assert.equal((await listSharingOutbox(h.database, h.scope.groupId)).length, outboxBefore);
    assert.equal((await h.snapshot()).completions[0].outcome, 'completed');
  } finally { h.close(); }
});

test('weekly/biweekly/monthly garbage, visibility, members, assignment and dependency edits remain available in shared mode', async () => {
  const h = await fixture();
  try {
    await repository.saveWeeklyWasteSchedule(h.database, { label: 'びん', recurrence: 'biweekly', collectionWeekdays: [4], anchorDate: '2026-10-29' });
    let snapshot = await h.snapshot(); const schedule = snapshot.wasteSchedules[0];
    await repository.saveWeeklyWasteSchedule(h.database, { ...schedule, recurrence: 'weekly' });
    assert.equal((await h.snapshot()).wasteSchedules[0].anchorDate, undefined);
    await repository.setWasteOccurrenceHidden(h.database, schedule.id, '2026-10-29', true);
    assert.ok((await h.snapshot()).hiddenWasteOccurrenceKeys.includes(`${schedule.id}:2026-10-29`));
    await repository.setWasteOccurrenceHidden(h.database, schedule.id, '2026-10-29', false);
    await repository.saveWeeklyWasteSchedule(h.database, { label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31 });
    snapshot = await h.snapshot(); assert.equal(snapshot.wasteSchedules.length, 2);
    const member = await repository.addHouseholdMember(h.database, '同居人');
    await repository.setChoreAssignments(h.database, choreId, [member, 'owner']);
    snapshot = await h.snapshot(); assert.equal(snapshot.assignments.find((item) => item.choreId === choreId).memberIds.length, 2);
    const other = 'group-test.builtin-chore-07';
    await repository.replaceChoreDependencies(h.database, choreId, [other]);
    await assert.rejects(repository.replaceChoreDependencies(h.database, other, [choreId]), /循環/);
    assert.equal((await h.snapshot()).dependencies.length, 1);
    await repository.replaceChoreDependencies(h.database, choreId, []);
    assert.equal((await h.snapshot()).dependencies.length, 0);
    await repository.deleteWeeklyWasteSchedule(h.database, schedule.id);
    assert.equal((await h.snapshot()).wasteSchedules.length, 1);
  } finally { h.close(); }
});

test('reviewed appliance saving uses deterministic IDs, preserves user overrides and retires omitted tasks without losing history', async () => {
  const h = await fixture();
  try {
    const product = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', manualUrl: 'https://www.dyson.co.jp/manual.pdf' };
    const task = { name: 'フィルターの洗浄', recommendedIntervalDays: 30, steps: ['冷水で洗う'], tools: ['水'], safetyCautions: ['完全に乾燥'], evidence: [{ url: product.manualUrl }] };
    const conditional = { ...task, name: 'ゴミを捨てる', recommendedIntervalDays: undefined, recommendedConditions: ['満杯のとき'] };
    const analysis = { manufacturer: 'Dyson', model: 'SV20', analyzedAt: now.toISOString(), requiresUserReview: true, tasks: [task, conditional] };
    const first = await repository.saveReviewedApplianceCare(h.database, product, analysis, analysis.tasks.map((task) => ({ task })));
    assert.equal(first.scheduledTaskCount, 1); assert.equal(first.noCycleTaskCount, 1);
    let snapshot = await h.snapshot(); assert.equal(snapshot.appliances.length, 1);
    const care = snapshot.chores.find((item) => item.applianceId === first.applianceId);
    await repository.updateChoreSettings(h.database, care.id, { cycleDays: 45, load: 'normal' });
    await repository.completeChore(h.database, (await h.snapshot()).scheduleEntries.find((entry) => entry.choreId === care.id));
    const second = await repository.saveReviewedApplianceCare(h.database, product, analysis, [{ task }]);
    assert.equal(second.applianceId, first.applianceId);
    snapshot = await h.snapshot(); assert.equal(snapshot.appliances.length, 1);
    assert.equal(snapshot.chores.find((item) => item.id === care.id).userIntervalDays, 45);
    assert.equal(snapshot.chores.find((item) => item.id === care.id).load, 'normal');
    const changedAnalysis = { ...analysis, tasks: [conditional] };
    await repository.saveReviewedApplianceCare(h.database, { ...product, applianceId: first.applianceId }, changedAnalysis, [{ task: conditional }]);
    snapshot = await h.snapshot(); assert.equal(snapshot.chores.find((item) => item.id === care.id).enabled, false);
    assert.equal(snapshot.completions.length, 1); assert.equal(snapshot.chores.find((item) => item.id === care.id).instructions.length, 0);
    assert.ok((await loadSharedReplica(h.database, h.scope.groupId)).entities.some((entity) => entity.entityType === 'appliance' && entity.fields.reviewed));
  } finally { h.close(); }
});
