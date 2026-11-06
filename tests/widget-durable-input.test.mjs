import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIntegration, repository, now } from './helpers/google-sync-integration.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
const queueStorage = await import('../src/platform/storage/widget-completion-intents.ts');
const { readNativeWidgetCompletionOperations } = queueStorage;
const { sharedLocalDate } = await import('../src/features/sharing/group-clock.ts');
const widgetSync = await import('../src/features/widgets/widget-completion-sync.ts');
const { createPlannerRefreshController } = await import('../src/features/planner/refresh-controller.ts');
const { AdaptiveOwnerInputsChangedError } = await import('../src/platform/storage/adaptive-owner-inputs.ts');

function enqueue(h, change = {}) {
  h.connection.exec('CREATE TABLE IF NOT EXISTS native_widget_completion_intents(operation_id TEXT PRIMARY KEY NOT NULL,operation_json TEXT NOT NULL)');
  const value = { id: `completion-intent.${randomUUID()}`, accountScope: 'person-a',
    householdCreatedAt: h.connection.prepare('SELECT created_at FROM households').get().created_at,
    acceptedAtMs: now.getTime(), timeZone: 'Asia/Tokyo', completedLocalDate: sharedLocalDate(now, 'Asia/Tokyo'), entry: h.entries[0], ...change };
  h.connection.prepare('INSERT INTO native_widget_completion_intents VALUES(?,?)').run(value.id, JSON.stringify(value)); return value;
}
const state = h => ({ completions: h.connection.prepare('SELECT * FROM chore_completions').all(), states: h.connection.prepare('SELECT * FROM chore_state').all(),
  google: h.connection.prepare('SELECT * FROM google_task_links').all(), journal: h.connection.prepare('SELECT * FROM chore_completion_actions').all() });

test('native widget input survives a missing listener and commits completion journal timestamp timezone and Google revision only after authorization', async t => {
  const h = await createIntegration(); t.after(() => h.connection.close()); const before = state(h); const op = enqueue(h);
  assert.deepEqual(state(h), before, 'native acceptance only writes the input queue');
  const [restored] = await readNativeWidgetCompletionOperations(h.database); assert.deepEqual(restored, op);
  let checks = 0;
  assert.equal(await repository.commitWidgetCompletionOperation(h.database, restored, () => { checks++; }), 'saved');
  assert.ok(checks >= 3); assert.deepEqual(await readNativeWidgetCompletionOperations(h.database), []);
  const completion = h.connection.prepare('SELECT * FROM chore_completions').get();
  assert.equal(completion.source, 'widget'); assert.equal(completion.completed_at, now.toISOString());
  assert.equal(completion.completed_local_date, op.completedLocalDate); assert.equal(completion.completed_time_zone, op.timeZone);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 1);
  const link = (await repository.listGoogleTaskLinks(h.database))[0]; assert.equal(link.pendingStatus, 'completed'); assert.ok(link.pendingStatusRevision);
  assert.equal(await repository.commitWidgetCompletionOperation(h.database, restored, () => {}), 'alreadyApplied');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 1);
  await repository.undoCompletedChore(h.database, completion.id);
  assert.equal(await repository.commitWidgetCompletionOperation(h.database, restored, () => {}), 'alreadyApplied', 'a lost acknowledgement cannot replay an operation after Undo');
  assert.equal(h.connection.prepare("SELECT count(*) n FROM chore_completions WHERE outcome='completed'").get().n, 0);
});

test('expired or changing subscription rejects queued widget writes and rolls back completion history Tasks state and acknowledgement together', async t => {
  for (const failAt of [1, 2, 3]) {
    const h = await createIntegration(); t.after(() => h.connection.close()); const op = enqueue(h); const before = state(h); let check = 0;
    await assert.rejects(repository.commitWidgetCompletionOperation(h.database, op, () => { if (++check === failAt) throw new Error('subscription expired or account changed'); }), /subscription/);
    assert.deepEqual(state(h), before); assert.equal((await readNativeWidgetCompletionOperations(h.database)).length, 1);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM planner_completion_intents').get().n, 0);
    await repository.commitWidgetCompletionOperation(h.database, op, () => {}); assert.equal((await readNativeWidgetCompletionOperations(h.database)).length, 0);
  }
});

test('widget inputs cannot complete a disabled removed re-created or foreign occurrence and never retarget a newer cycle', async t => {
  for (const change of ['disabled', 'removed', 'new-cycle', 'new-household', 'foreign']) {
    const h = await createIntegration(); t.after(() => h.connection.close()); const op = enqueue(h);
    if (change === 'disabled') h.connection.prepare('UPDATE chore_definitions SET enabled=0 WHERE id=?').run(op.entry.choreId);
    if (change === 'removed') h.connection.prepare('DELETE FROM chore_schedule_entries WHERE id=?').run(op.entry.id);
    if (change === 'new-cycle') h.connection.prepare('UPDATE chore_schedule_entries SET entry_json=? WHERE id=?').run(JSON.stringify({ ...op.entry, cycleBaseDate: '2026-11-30' }), op.entry.id);
    if (change === 'new-household') op.householdCreatedAt = '2000-01-01T00:00:00Z';
    if (change === 'foreign') op.entry = { ...op.entry, householdId: 'shared' };
    if (['new-household', 'foreign'].includes(change)) await assert.rejects(repository.commitWidgetCompletionOperation(h.database, op, () => {}));
    else assert.equal(await repository.commitWidgetCompletionOperation(h.database, op, () => {}), 'targetChanged');
    assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n, 0);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 0);
  }
});

test('Android recovery ignores transient callback IDs and another account queued actions while preserving accepted inputs on authorization failure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const h = await createIntegration(); t.after(() => h.connection.close()); const op = enqueue(h); let user = 'person-b'; let allowed = true;
  const native = loadNativeModule('src/platform/widgets/refresh-planner-from-widget.ts', {
    'react-native': { Platform: { OS: 'android' } },
    '@/features/widgets/widget-completion-sync': widgetSync,
    '@/features/widgets/publish-today-widget-snapshot': { publishTodayWidgetSnapshot: async () => {} },
    '@/platform/storage/repository': repository,
    '@/platform/widgets/expo-widget-gateway': { expoWidgetGateway: { getPendingWidgetCompletionIds: async () => [] } },
    '../storage/widget-completion-intents': queueStorage,
    '../subscription/runtime': { subscriptionRequired: true, subscriptionSnapshot: () => ({ userId: user }),
      assertSubscriptionAccess: async () => { if (!allowed) throw new Error('subscription expired'); } },
  }).refreshPlannerFromWidget;
  await native(h.database, [op.entry.id], { publish: false });
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n, 0);
  assert.equal((await readNativeWidgetCompletionOperations(h.database)).length, 1);
  user = 'person-a'; allowed = false; await assert.rejects(native(h.database, [op.entry.id]), /subscription/);
  assert.equal((await readNativeWidgetCompletionOperations(h.database)).length, 1);
  allowed = true; await native(h.database, [], { publish: false });
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n, 1);
  assert.equal((await readNativeWidgetCompletionOperations(h.database)).length, 0);
});

test('retrying an owner-input read after a committed native widget action does not repeat its completion or Google revision', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const h = await createIntegration(); t.after(() => h.connection.close()); const operation = enqueue(h);
  const native = loadNativeModule('src/platform/widgets/refresh-planner-from-widget.ts', {
    'react-native': { Platform: { OS: 'android' } }, '@/features/widgets/widget-completion-sync': widgetSync,
    '@/features/widgets/publish-today-widget-snapshot': { publishTodayWidgetSnapshot: async () => assert.fail('the controller publishes') },
    '@/platform/storage/repository': repository,
    '@/platform/widgets/expo-widget-gateway': { expoWidgetGateway: { getPendingWidgetCompletionIds: async () => [] } },
    '../storage/widget-completion-intents': queueStorage,
    '../subscription/runtime': { subscriptionRequired: true, subscriptionSnapshot: () => ({ userId: 'person-a' }), assertSubscriptionAccess: async () => {} },
  }).refreshPlannerFromWidget;
  let calls = 0, effects = 0, committed;
  const controller = createPlannerRefreshController({
    load: async ids => {
      calls++;
      const result = await native(h.database, ids, { publish: false });
      if (calls === 1) { committed = state(h); throw new AdaptiveOwnerInputsChangedError(); }
      return result;
    },
    retryLoadOnError: error => error instanceof AdaptiveOwnerInputsChangedError,
    weather: async () => null, publish: () => { effects++; },
  });
  await controller.refresh({ widgetCompletionIds: [operation.entry.id], force: true });
  assert.equal(calls, 2); assert.equal(effects, 1); assert.equal(controller.getSnapshot().error, null);
  assert.deepEqual(state(h), committed, 'the retry cannot create a second completion, journal operation or Google pending status revision');
  assert.equal(committed.completions.length, 1); assert.equal(committed.journal.length, 1);
  assert.deepEqual(await readNativeWidgetCompletionOperations(h.database), []);
});

test('iOS durable input survives a lost native acknowledgement and cannot replay after local Undo', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const h = await createIntegration(); t.after(() => h.connection.close()); const operation = enqueue(h);
  h.connection.prepare('DELETE FROM native_widget_completion_intents').run();
  let pending = [operation]; let failAck = true; let brokenRead = false; let legacyReads = 0;
  const native = loadNativeModule('src/platform/widgets/refresh-planner-from-widget.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '@/features/widgets/widget-completion-sync': widgetSync,
    '@/features/widgets/publish-today-widget-snapshot': { publishTodayWidgetSnapshot: async () => {} },
    '@/platform/storage/repository': repository,
    '@/platform/widgets/expo-widget-gateway': {
      expoWidgetGateway: { getPendingWidgetCompletionIds: async () => { legacyReads++; return []; } },
      readIOSWidgetCompletionOperations: async () => { if (brokenRead) throw new Error('native input journal unreadable'); return pending; },
      acknowledgeIOSWidgetCompletionOperations: async ids => { if (failAck) throw new Error('lost ACK'); pending = pending.filter(op => !ids.includes(op.id)); },
    }, '../storage/widget-completion-intents': queueStorage,
    '../subscription/runtime': { subscriptionRequired: true, subscriptionSnapshot: () => ({ userId: 'person-a' }), assertSubscriptionAccess: async () => {} },
  }).refreshPlannerFromWidget;
  const first = await native(h.database, [], { publish: false }); assert.equal(first.canPublishWidget, false);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 1); assert.equal(pending.length, 1);
  assert.equal(legacyReads, 0, 'unreadable native input must not fall back to stale IDs');
  const completion = h.connection.prepare('SELECT id FROM chore_completions').get(); await repository.undoCompletedChore(h.database, completion.id);
  failAck = false; const retry = await native(h.database, [], { publish: false }); assert.equal(retry.canPublishWidget, true);
  assert.equal(pending.length, 0); assert.equal(h.connection.prepare("SELECT count(*) n FROM chore_completions WHERE outcome='completed'").get().n, 0);
  brokenRead = true; const before = legacyReads;
  assert.equal((await native(h.database, [operation.entry.id], { publish: false })).canPublishWidget, false);
  assert.equal(legacyReads, before);
});
