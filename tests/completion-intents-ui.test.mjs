import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCompletionIntents } from '../src/features/planner/completion-intents.ts';
import { captureCompletionTarget, completionIntentDigest } from '../src/features/planner/completion-command.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { openCalendarDay } from './helpers/calendar-ui.mjs';
import { localDateFromDate } from '../src/domain/scheduling/local-date.ts';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
import { fixture as sharedFixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { createWorkspaceDisplayStore } from '../src/features/sharing/v2-ui/workspace-display-store.ts';
const repository = await import('../src/platform/storage/repository.ts');

function runtimeFixture({ apply, refresh, at, initialSaved = [] }) {
  let release; let first = true; let saved = structuredClone(initialSaved); const readers = new Set();
  const blocked = new Promise(resolve => { release = resolve; });
  const queue = createCompletionIntents({ capture: captureCompletionTarget, makeId: () => `completion-intent.${randomUUID()}`,
    now: at, isCurrent: () => true, apply,
    store: { load: async () => saved, save: async rows => { if (first) { first = false; await blocked; } saved = structuredClone(rows); } },
    refresh: async () => { const visible = [...readers].filter(reader => reader.active()); if (!visible.length) return false;
      await refresh?.(); await Promise.all(visible.map(reader => reader.read())); },
  });
  return { queue, release, acquire() { void queue.activate(); return () => {}; },
    watchDisplay(read, active = () => true) { const reader = { read, active }; readers.add(reader); queue.retryRead(); return () => { readers.delete(reader); }; } };
}
const checkbox = screen => {
  const node = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox');
  assert.ok(node, 'the real screen must expose a chore checkbox'); return node;
};

for (const platform of ['ios', 'android']) {
  test(`${platform} restoring a committed gesture before the focused shared display cannot hide a later completion`, async () => {
    const f = await sharedFixture(); const d = await f.device(); let screen; let runtime; let store;
    try {
      await d.repository.commit(seeds()); let sequence = 0;
      const controller = createV2GroupController(d.repository, { now, makeId: () => `restored-ack-${++sequence}`, sync: async () => {} });
      const source = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const first = await source.readModel(); const round = first.plan.occurrences[0]; const subject = round.subjects[0];
      const ref = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: subject.subjectUserId };
      await controller.actions.complete(ref);
      store = createWorkspaceDisplayStore(async () => source, now);
      const session = { ...source, invalidate: store.invalidate, readModel: async options => (await store.read(options)).model };
      runtime = runtimeFixture({ at: now, apply: async () => assert.fail('a committed gesture must never be applied again'),
        initialSaved: [{ id: 'previous-committed-undo', key: `shared:${subject.id}`, completed: false, status: 'committed', createdAt: now().toISOString(),
          target: { kind: 'shared', ref, expectedAssigneeIds: [] } }] });
      runtime.release(); await runtime.queue.activate(); await runtime.queue.settled();
      assert.equal(runtime.queue.getSnapshot().values.size, 1, 'the display is not mounted yet');
      screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
        props: { purpose: 'workspace', view: 'home', lifecycleManaged: true, initialDisplay: { session, model: await session.readModel() },
          loadSession: async () => session, subscribe: store.subscribe, invalidateCompletionDisplay: store.invalidate,
          sharedCompletion: runtime, onBack() {}, onConfiguration() {}, onHistory() {} } });
      await screen.flush(); await runtime.queue.settled(); await screen.flush();
      assert.equal(runtime.queue.getSnapshot().values.size, 0);
      assert.equal(checkbox(screen).props.accessibilityState.checked, true);
    } finally { runtime?.release(); await runtime?.queue.settled(); screen?.unmount(); store?.dispose(); d.connection.close(); }
  });

  test(`${platform} a prepared shared display notification acknowledges the committed gesture and does not mask later remote changes`, async () => {
    const f = await sharedFixture(); const d = await f.device(); let screen; let runtime; let store;
    try {
      await d.repository.commit(seeds()); let operations = 0;
      const controller = createV2GroupController(d.repository, { now, makeId: () => `display-ack-${++operations}`, sync: async () => {} });
      const source = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      store = createWorkspaceDisplayStore(async () => source, now);
      const session = { ...source, invalidate: store.invalidate, readModel: async options => (await store.read(options)).model };
      runtime = runtimeFixture({ at: now, apply: intent => controller.actions.setCompletedIntent({ id: intent.id, digest: completionIntentDigest('display-ack', intent) },
        intent.target.ref, intent.completed, { createdAt: intent.createdAt, expectedAssigneeIds: intent.target.expectedAssigneeIds }) });
      await runtime.queue.activate();
      screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
        props: { purpose: 'workspace', view: 'home', lifecycleManaged: true, initialDisplay: { session, model: await session.readModel() },
          loadSession: async () => session, subscribe: store.subscribe, invalidateCompletionDisplay: store.invalidate,
          sharedCompletion: runtime, onBack() {}, onConfiguration() {}, onHistory() {} } });
      await screen.flush(); checkbox(screen).props.onPress(); screen.render();
      runtime.release(); await runtime.queue.settled(); await screen.flush();
      assert.equal(runtime.queue.getSnapshot().values.size, 0, 'a successful prepared read must release the optimistic value');
      assert.equal(runtime.queue.getSnapshot().error, null);
      assert.equal(checkbox(screen).props.accessibilityState.checked, true);
      const complete = (await d.repository.readState()).replica.operations.find(op => op.operationType === 'complete');
      assert.ok(complete); await controller.actions.undoMany([complete.operationId]);
      store.invalidate(); await store.read(); await screen.flush();
      assert.equal(checkbox(screen).props.accessibilityState.checked, false, 'a later independent Undo must be visible');
    } finally { runtime?.release(); await runtime?.queue.settled(); screen?.unmount(); store?.dispose(); d.connection.close(); }
  });

  test(`${platform} personal home and calendar immediately share the last completion gesture while protected persistence is blocked`, async () => {
    const h = await privateFixture(); let home; let calendar; let runtime; const alerts = [];
    try {
      let snapshot = await repository.loadPlannerSnapshot(h.database); let businessWrites = 0;
      const scheduled = snapshot.scheduleEntries.find(row => row.choreId === h.chore.id);
      assert.ok(scheduled, 'the screen fixture must expose the persisted occurrence to complete');
      const refresh = async () => { snapshot = await repository.loadPlannerSnapshot(h.database); };
      runtime = runtimeFixture({ at: () => new Date(), refresh, apply: async intent => {
        businessWrites++;
        await repository.setPersonalDateTaskCompletedIntent(h.database, { ...intent.target.command, completed: intent.completed },
          { id: intent.id, digest: completionIntentDigest('ui-test', intent), householdCreatedAt: snapshot.household.createdAt, createdAt: intent.createdAt }, () => {});
      } });
      await runtime.queue.activate();
      const options = { platform, database: h.database, snapshot: () => snapshot, refresh,
        alert: (...args) => alerts.push(args),
        effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
        mocks: { '../platform/storage/completion-intents': { personalCompletionIntents: () => runtime } } };
      home = screenHarness('src/app/(tabs)/index.tsx', options); await home.flush();
      const inputCountBefore = home.nodes().filter(node => node.type === 'TextInput').length;
      const visibleModalCountBefore = home.nodes().filter(node => node.type === 'Modal' && node.props.visible === true).length;
      checkbox(home).props.onPress(); home.render();
      assert.equal(checkbox(home).props.accessibilityState.checked, true); assert.equal(businessWrites, 0);
      assert.equal(alerts.length, 0, 'ordinary completion must not ask for an extra confirmation');
      assert.equal(home.nodes().filter(node => node.type === 'TextInput').length, inputCountBefore,
        'ordinary completion must not open an additional-input step');
      assert.equal(home.nodes().filter(node => node.type === 'Modal' && node.props.visible === true).length, visibleModalCountBefore,
        'ordinary completion must not open a confirmation modal');
      calendar = screenHarness('src/app/(tabs)/explore.tsx', options); await openCalendarDay(calendar, localDateFromDate(new Date()));
      assert.equal(checkbox(calendar).props.accessibilityState.checked, true);
      checkbox(calendar).props.onPress(); calendar.render(); home.render();
      assert.equal(checkbox(home).props.accessibilityState.checked, false); assert.equal(businessWrites, 0);
      checkbox(home).props.onPress(); home.render(); calendar.render();
      assert.equal(checkbox(calendar).props.accessibilityState.checked, true);
      runtime.release(); await runtime.queue.settled(); await home.flush(); await calendar.flush();
      assert.equal(businessWrites, 1, 'superseded queued gestures never write contradictory history');
      assert.equal(snapshot.completions.filter(row => row.outcome === 'completed').length, 1);
      const saved = h.connection.prepare(`SELECT id, household_id, chore_id, schedule_entry_id, source, outcome
        FROM chore_completions WHERE chore_id=? AND outcome='completed'`).all(h.chore.id);
      assert.equal(saved.length, 1, 'the normal Home action must reach the durable personal completion API');
      assert.equal(saved[0].schedule_entry_id, scheduled.id, 'the API must save the exact displayed occurrence');
      assert.equal(saved[0].source, 'inApp');
      assert.equal(h.connection.prepare('SELECT COUNT(*) AS count FROM planner_completion_intents').get().count, 1,
        'the authenticated completion intent must commit with the saved completion');
      assert.ok(h.writes.some(write => write.sql.includes('INSERT INTO chore_completions')));
      assert.equal(checkbox(home).props.accessibilityState.checked, true);
    } finally { runtime?.release(); await runtime?.queue.settled(); home?.unmount(); calendar?.unmount(); h.connection.close(); }
  });

  test(`${platform} shared home completion and Undo stay immediate and commit one authorized signed intent after the pending save`, async () => {
    const f = await sharedFixture(); const d = await f.device(); let screen; let runtime;
    try {
      await d.repository.commit(seeds()); let operations = 0;
      const controller = createV2GroupController(d.repository, { now, makeId: () => `queued-ui-${++operations}`, sync: async () => {} });
      const session = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const model = await session.readModel();
      runtime = runtimeFixture({ at: now, apply: intent => controller.actions.setCompletedIntent({ id: intent.id, digest: completionIntentDigest('shared-ui', intent) },
        intent.target.ref, intent.completed, { createdAt: intent.createdAt, expectedAssigneeIds: intent.target.expectedAssigneeIds }) });
      await runtime.queue.activate();
      screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        effectDependencies: true, focusDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
        props: { purpose: 'workspace', view: 'home', lifecycleManaged: true, initialDisplay: { session, model }, loadSession: async () => session,
          sharedCompletion: runtime, onBack() {}, onConfiguration() {}, onHistory() {} } });
      await screen.flush(); checkbox(screen).props.onPress(); screen.render();
      assert.equal(checkbox(screen).props.accessibilityState.checked, true); assert.equal(operations, 0);
      await screen.press('直前の完了を元に戻す');
      assert.equal(checkbox(screen).props.accessibilityState.checked, false); assert.equal(operations, 0);
      checkbox(screen).props.onPress(); screen.render();
      assert.equal(checkbox(screen).props.accessibilityState.checked, true);
      runtime.release(); await runtime.queue.settled(); await screen.flush();
      assert.equal(operations, 1); assert.equal(checkbox(screen).props.accessibilityState.checked, true);
      assert.equal(d.connection.prepare('SELECT count(*) AS n FROM sharing_v2_mutation_intents').get().n, 1);
      assert.equal((await d.repository.readState()).replica.operations.filter(op => op.operationType === 'complete').length, 1);
    } finally { runtime?.release(); await runtime?.queue.settled(); screen?.unmount(); d.connection.close(); }
  });
}
