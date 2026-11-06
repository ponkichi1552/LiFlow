import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './helpers/sqlite.mjs';
const store = await import('../src/platform/storage/adaptive-personal-chores.ts');
const { migrateLocalDatabase } = await import('../src/platform/storage/migrations.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const { predictAdaptiveDate, adaptiveRepresentativeDays } = await import('../src/domain/scheduling/adaptive/models.ts');
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');
const recipe = JSON.parse(readFileSync(new URL('../src/domain/chores/personal-catalog-data.json', import.meta.url))).recipes[0];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(path) {
  const h = createDatabase(path); h.database.isInTransactionAsync = async () => h.connection.isTransaction;
  await migrateLocalDatabase(h.database);
  await h.database.withTransactionAsync(() => store.initializeAdaptivePersonalSchemaInside(h.database));
  let inputRevision = 1; let now = new Date('2026-01-01T12:00:00.000Z'); let plans = 0;
  const policy = { choreId: recipe.id, kind: 'personal', mode: 'balanced', initialDays: Object.fromEntries(Object.entries(recipe.modes)
    .map(([mode, cadence]) => [mode, cadence.kind === 'days' ? cadence.days : null])), enabled: true, fixedDays: null, version: 'catalog-6' };
  const view = () => store.readAdaptivePersonalInside(h.database, policy.choreId);
  function context(change = {}) {
    const today = now.toISOString().slice(0, 10);
    return { today, now: now.toISOString(), inputRevision: `input-${inputRevision}`, assertInputsCurrent() {},
      plan({ roundId, state, previous, trigger }) {
        plans++;
        const actual = state.lastPlanCompletion?.date;
        const period = adaptiveRepresentativeDays(state.model);
        const seed = parseInt(fingerprint([policy.choreId, policy.version]).slice(0, 8), 16) % Math.min(period, 30);
        const baseDate = actual ? predictAdaptiveDate(state.model, actual) : addDays(today, seed);
        const days = Array.from({ length: 100 }, (_, i) => {
          const date = addDays(baseDate, i - 45); const start = Date.parse(`${date}T00:00:00Z`);
          return { date, bounds: { start, end: start + 86400000 }, allowed: [{ start: start + 9 * 3600000, end: start + 19 * 3600000 }],
            holiday: false, maximumMinutes: 600, heavyLimit: 2, normalLimit: 2 };
        });
        return placeAdaptiveRounds({ tasks: [{ id: roundId, choreId: policy.choreId, baseDate, periodDays: period,
          minutes: recipe.estimatedMinutes, load: recipe.load, fixedDaily: period === 1,
          purpose: trigger === 'initial' ? 'initial' : trigger === 'complete' ? 'nextRound' : 'automatic', ...(previous ? { previous } : {}),
          ...(actual ? { lastCompletedDate: actual } : {}), ...(change.radius !== undefined ? { windowRadiusDays: change.radius } : {}) }],
        days, busy: [], fixedLoads: [], today, now: now.getTime(), holidaysConfigured: false })[0];
      }, ...change };
  }
  const transact = async work => { let result; await h.database.withTransactionAsync(async () => { result = await work(); }); return result; };
  const initialize = () => transact(() => store.initializeAdaptivePersonalChoreInside(h.database, policy, context(), fingerprint));
  const apply = (operation, planning = context()) => transact(() => store.applyAdaptivePersonalOperationInside(h.database, policy.choreId, operation, planning, fingerprint));
  let counter = 0;
  async function complete(date, change = {}) {
    const current = await view(); const operation = { operationId: `action-${++counter}`, type: 'complete', completionId: `completion-${counter}`,
      roundId: current.plan.id, planRevision: current.planRevision, recordedAt: `${date}T12:00:00.000Z`, date, timeZone: 'UTC', origin: 'personal', ...change };
    now = new Date(operation.recordedAt); inputRevision++;
    return { operation, receipt: await apply(operation), view: await view() };
  }
  return { ...h, policy, view, context, transact, apply, initialize, complete, plans: () => plans,
    clock(date) { now = new Date(`${date}T12:00:00.000Z`); inputRevision++; }, bump() { inputRevision++; } };
}

test('adaptive personal initialization generates a real first round without fake history and display reads do not replay', async () => {
  const h = await fixture();
  try {
    await assert.rejects(store.initializeAdaptivePersonalChoreInside(h.database, h.policy, h.context(), fingerprint), /同じトランザクション/);
    const first = await h.initialize(); assert.ok(first.plan.id.startsWith('personal-round.')); assert.ok(first.planRevision);
    assert.equal(first.state.model.days, recipe.modes.balanced.days); assert.equal(first.state.lastCompletedDate, null);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_actions').get().n, 0);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_forecasts').get().n, 0);
    const reads = h.database.getAllAsync; h.database.getAllAsync = async () => { throw new Error('display must not load history'); };
    assert.deepEqual(await h.view(), first); assert.deepEqual(await h.initialize(), first);
    assert.equal(h.plans(), 1); h.database.getAllAsync = reads;
  } finally { h.connection.close(); }
});

test('a necessary-only personal definition can be enabled without creating a fake daily round or requiring a cycle input', async () => {
  const h = await fixture();
  try {
    h.policy.initialDays = { frequent: null, balanced: null, relaxed: null };
    const current = await h.initialize(); assert.equal(current.state.policy.enabled, true);
    assert.equal(current.state.model, null); assert.equal(current.plan, null); assert.equal(current.planRevision, null);
    assert.equal(h.plans(), 0); assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_forecasts').get().n, 0);
  } finally { h.connection.close(); }
});

test('adaptive personal completion atomically saves its next actual round and genuine forecast and exact operation replay cannot duplicate either', async () => {
  const h = await fixture();
  try {
    const initial = await h.initialize(); const date = initial.plan.recommendedDate;
    const result = await h.complete(date);
    assert.notEqual(result.view.plan.id, initial.plan.id); assert.equal(result.receipt.activeRoundId, result.view.plan.id);
    const row = h.connection.prepare('SELECT forecast_json FROM personal_adaptive_forecasts').get();
    const forecast = JSON.parse(row.forecast_json); assert.equal(forecast.forRoundId, result.view.plan.id);
    assert.equal(forecast.sourceOperationId, result.operation.operationId);
    const before = h.connection.serialize(); assert.deepEqual(await h.apply(result.operation), result.receipt);
    assert.deepEqual(h.connection.serialize(), before);
    await assert.rejects(h.apply({ ...result.operation, date: addDays(date, 1) }), /同じ操作/);
    assert.equal(h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='complete'").get().n, 1);
  } finally { h.connection.close(); }
});

test('adaptive personal completion binds the displayed frozen plan rather than a later calendar placement', async () => {
  const h = await fixture();
  try {
    let current = await h.initialize(); let date = current.plan.recommendedDate;
    for (let i = 0; i < 4; i++) { const completed = await h.complete(date); current = completed.view; date = addDays(date, 60); }
    const old = await h.view(); assert.equal(old.state.model.days, 60);
    h.bump(); const newer = await h.transact(() => store.replanAdaptivePersonalInside(h.database, h.policy.choreId, h.context({ radius: 14 }), fingerprint));
    assert.notEqual(newer.planRevision, old.planRevision);
    const completed = await h.complete(old.plan.recommendedDate, { planRevision: old.planRevision });
    const record = h.connection.prepare('SELECT event_json FROM personal_adaptive_actions WHERE operation_id=?').get(completed.operation.operationId);
    const event = JSON.parse(record.event_json);
    assert.deepEqual(event.displayedWindow, { revision: old.planRevision, ...old.plan.displayedWindow });
    assert.deepEqual(completed.view.state.issues, []);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_state').get().n, 1);
  } finally { h.connection.close(); }
});

test('adaptive Undo preserves a later fixed policy and later actual completion instead of restoring an obsolete entire snapshot', async () => {
  const h = await fixture();
  try {
    const initial = await h.initialize(); const a = await h.complete(initial.plan.recommendedDate);
    const b = { operationId: 'fixed-setting', type: 'settings', recordedAt: h.context().now, fixedDays: 20 };
    await h.apply(b); const scheduled = await h.view();
    const c = await h.complete(scheduled.plan.recommendedDate);
    const undo = { operationId: 'undo-a', type: 'undo', completionId: a.operation.completionId, targetOperationId: a.operation.operationId, recordedAt: h.context().now };
    await h.apply(undo); const restored = await h.view();
    assert.equal(restored.state.policy.fixedDays, 20); assert.equal(restored.state.model.days, 20);
    assert.equal(restored.state.lastPlanCompletion.operationId, c.operation.operationId); assert.equal(restored.plan.id, c.view.plan.id);
    assert.equal(h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='complete'").get().n, 2);
    assert.equal((await h.apply({ ...undo, operationId: 'undo-a-again' })).kind, 'alreadyUndone');
  } finally { h.connection.close(); }
});

test('adaptive stale completion from another SQLite connection cannot close a newer round or replay itself after Undo', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-adaptive-store-')); const path = join(directory, 'personal.sqlite');
  const a = await fixture(path); let b;
  try {
    const initial = await a.initialize(); b = await fixture(path);
    const first = await a.complete(initial.plan.recommendedDate); b.clock(first.operation.date);
    const stale = { ...first.operation, operationId: 'stale-other-connection', completionId: 'other-completion' };
    assert.equal((await b.apply(stale)).kind, 'alreadyCompleted');
    await a.apply({ operationId: 'undo-first', type: 'undo', completionId: first.operation.completionId,
      targetOperationId: first.operation.operationId, recordedAt: a.context().now });
    assert.equal((await b.apply(stale)).kind, 'alreadyCompleted', 'its terminal receipt must not become a new completion after Undo');
    const restored = await a.view(); assert.equal(restored.plan.id, initial.plan.id);
    assert.equal(restored.state.lastPlanCompletion, null);
  } finally { a.connection.close(); b?.connection.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('adaptive model plan forecast and normal sync Outbox roll back as one transaction on failure or stale calculation', async () => {
  const h = await fixture();
  try {
    const current = await h.initialize(); const date = current.plan.recommendedDate; h.clock(date);
    const operation = { operationId: 'atomic-complete', type: 'complete', completionId: 'atomic-completion', roundId: current.plan.id,
      planRevision: current.planRevision, recordedAt: h.context().now, date, timeZone: 'UTC', origin: 'personal' };
    const run = h.database.runAsync;
    h.database.runAsync = async (sql, ...parameters) => {
      if (sql.startsWith('INSERT INTO personal_adaptive_forecasts')) throw new Error('injected forecast save failure'); return run(sql, ...parameters);
    };
    await assert.rejects(h.transact(async () => {
      await h.database.runAsync("INSERT INTO sync_outbox VALUES('normal-outbox','complete','{}','2026-01-01','pending')");
      await store.applyAdaptivePersonalOperationInside(h.database, h.policy.choreId, operation, h.context(), fingerprint);
    }), /forecast save failure/);
    assert.deepEqual(await h.view(), current);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_actions').get().n, 0);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM sync_outbox').get().n, 0);
    h.database.runAsync = run;
    let checked = 0;
    await assert.rejects(h.apply(operation, h.context({ assertInputsCurrent() { if (++checked === 2) throw new Error('new calendar revision'); } })), /new calendar/);
    assert.deepEqual(await h.view(), current);
    assert.equal((await h.apply(operation)).kind, 'applied');
  } finally { h.connection.close(); }
});

test('calendar revalidation uses the saved small model and never learns again or rereads event history', async () => {
  const h = await fixture();
  try {
    const first = await h.initialize(); await h.complete(first.plan.recommendedDate); const before = await h.view();
    h.database.getAllAsync = async () => { throw new Error('calendar must not replay history'); };
    assert.deepEqual(await h.transact(() => store.replanAdaptivePersonalInside(h.database, h.policy.choreId, h.context(), fingerprint)), before);
    h.bump(); const next = await h.transact(() => store.replanAdaptivePersonalInside(h.database, h.policy.choreId, h.context(), fingerprint));
    assert.equal(next.plan.id, before.plan.id); assert.equal(next.planRevision, before.planRevision);
    assert.deepEqual(next.state.model, before.state.model); assert.equal(next.state.revision, before.state.revision);
    assert.equal(h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='complete'").get().n, 1);
  } finally { h.connection.close(); }
});

test('switching to necessary-only preserves its current protected round through revalidation completion and Undo without generating another periodic round', async () => {
  const h = await fixture();
  try {
    h.policy.initialDays.relaxed = null;
    const initial = await h.initialize(); h.clock(initial.plan.recommendedDate);
    await h.apply({ operationId: 'necessary-mode', type: 'settings', mode: 'relaxed', recordedAt: h.context().now });
    const held = await h.view(); assert.equal(held.state.model, null); assert.equal(held.plan.id, initial.plan.id);
    h.clock(addDays(initial.plan.recommendedDate, 1));
    await h.transact(() => store.replanAdaptivePersonalInside(h.database, h.policy.choreId, h.context(), fingerprint));
    assert.equal((await h.view()).plan.id, initial.plan.id);
    const done = await h.complete(h.context().today); assert.equal(done.view.plan, null);
    await h.apply({ operationId: 'undo-held-round', type: 'undo', completionId: done.operation.completionId,
      targetOperationId: done.operation.operationId, recordedAt: h.context().now });
    const restored = await h.view(); assert.equal(restored.state.model, null); assert.equal(restored.plan.id, initial.plan.id);
  } finally { h.connection.close(); }
});

test('a later necessary-only setting remains effective when an earlier regular completion is undone', async () => {
  const h = await fixture();
  try {
    h.policy.initialDays.relaxed = null;
    const initial = await h.initialize(); const done = await h.complete(initial.plan.recommendedDate);
    await h.apply({ operationId: 'later-necessary-mode', type: 'settings', mode: 'relaxed', recordedAt: h.context().now });
    assert.equal((await h.view()).plan, null);
    await h.apply({ operationId: 'undo-old-regular', type: 'undo', completionId: done.operation.completionId,
      targetOperationId: done.operation.operationId, recordedAt: h.context().now });
    const restored = await h.view(); assert.equal(restored.state.policy.mode, 'relaxed'); assert.equal(restored.plan, null);
  } finally { h.connection.close(); }
});
