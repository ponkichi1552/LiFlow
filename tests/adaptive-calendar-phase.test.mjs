import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDatabase } from './helpers/sqlite.mjs';
const { replayAdaptiveHistory } = await import('../src/domain/scheduling/adaptive/history.ts');
const { predictAdaptiveDate } = await import('../src/domain/scheduling/adaptive/models.ts');
const { planPersonalAdaptiveRounds } = await import('../src/features/planner/adaptive-rounds.ts');
const { personalCadenceView } = await import('../src/features/planner/adaptive-cadence.ts');
const { prepareAdaptivePlacementInput } = await import('../src/features/planner/adaptive-input.ts');
const { createPersonalChoreDefinitions, personalChoreHistoryPolicy } = await import('../src/domain/chores/personal-catalog.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const { initializeAdaptivePersonalSchemaInside, readAdaptivePersonalInside } = await import('../src/platform/storage/adaptive-personal-chores.ts');
const { applyPersonalAdaptiveInside } = await import('../src/platform/storage/personal-adaptive-planner.ts');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const transitions = [
  { name: 'weekly adoption from a day-count round', model: { method: 'weekly', weeks: 1, weekday: 6, anchor: '2026-03-07' },
    completed: '2026-03-07', oldRule: '2026-03-05', next: '2026-03-14', days: 7, invalidOldPhase: true },
  { name: 'month-end adoption from a day-count round', model: { method: 'monthEnd', months: 1, anchor: '2026-07-31' },
    completed: '2026-07-30', oldRule: '2026-07-16', next: '2026-08-31', days: 31, invalidOldPhase: true },
  { name: 'a different fortnight phase with the same weekday', model: { method: 'weekly', weeks: 2, weekday: 6, anchor: '2026-03-07' },
    completed: '2026-03-07', oldRule: '2026-02-28', next: '2026-03-21', days: 14 },
  { name: 'a different two-month phase with a valid old month-end', model: { method: 'monthEnd', months: 2, anchor: '2026-07-31' },
    completed: '2026-07-30', oldRule: '2026-06-30', next: '2026-09-30', days: 61 },
];

test('adaptive placement and cadence use the adopted calendar phase without overwriting original completion rule dates', async t => {
  for (const value of transitions) await t.test(value.name, () => {
    const chore = { ...createPersonalChoreDefinitions('private')[0], enabled: true };
    const policy = personalChoreHistoryPolicy(chore, 'balanced');
    const event = { operationId: 'original', sequence: 1, recordedAt: `${value.completed}T12:00:00Z`, type: 'complete',
      completionId: 'completion', roundId: 'previous-round', localDate: value.completed, timeZone: 'UTC', origin: 'personal',
      mode: policy.mode, initialDays: policy.initialDays[policy.mode], displayedWindow: null, ruleDate: value.oldRule };
    // This is a projection at a method/phase transition. The full chronological
    // adoption and durable transaction are exercised separately, with real forecasts.
    const state = { ...replayAdaptiveHistory({ policy, events: [event], forecasts: [], fingerprint }), model: value.model };
    const before = JSON.stringify({ state, event });
    const geometry = prepareAdaptivePlacementInput({ from: value.completed, through: addDays(value.next, 90), timeZone: 'UTC',
      preferences: { restDays: [], heavyLimit: 2, normalLimit: 2, dayOverrides: [],
        allowedBands: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMinute: 540, endMinute: 1140 })) },
      events: [], exceptions: [], fingerprint });
    const plan = planPersonalAdaptiveRounds({ requests: [{ chore, state, previous: null, roundId: 'next-round', trigger: 'complete' }],
      geometry, ownerId: 'owner', today: value.completed, now: Date.parse(event.recordedAt), fixedLoads: [], fingerprint }).get('next-round');
    assert.equal(plan.originalBaseDate, value.next);
    assert.equal(personalCadenceView(chore, state).days, value.days);
    assert.equal(JSON.stringify({ state, event }), before, 'reading and placement preserve the frozen original and adopted model');
    if (value.invalidOldPhase) assert.throws(() => predictAdaptiveDate(state.model, value.completed, value.oldRule), /位相/);
    else assert.notEqual(predictAdaptiveDate(state.model, value.completed, value.oldRule), value.next,
      'an older valid phase must not silently move a newly adopted calendar round');
  });
});

test('real observed-prefix calendar adoption commits completion forecast and next round atomically and supports Undo', async t => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/adaptive-calendar-phase.json', import.meta.url)));
  const current = JSON.parse(readFileSync(new URL('./fixtures/adaptive-calendar-phase-refs864.json', import.meta.url)));
  const fixtures = [...current, ...recorded.filter(f => !current.some(value => value.caseId === f.caseId && value.expectedMethod === f.expectedMethod))];
  assert.deepEqual(fixtures.map(f => f.expectedMethod).sort(), ['monthEnd', 'weekly']);
  for (const f of fixtures) await t.test(f.expectedMethod, async () => {
    const h = createDatabase();
    try {
      await initializeAdaptivePersonalSchemaInside(h.database);
      const id = f.before.policy.choreId;
      const originalEvents = JSON.stringify(f.before.events);
      const previousRevision = f.operation.planRevision;
      assert.equal(previousRevision, fingerprint(['adaptive-plan-v1', id, f.previousPlan]));
      // Restore the synthetic observed prefix recorded under its reference
      // policy. No later completion or hidden evaluation truth is supplied.
      await h.database.runAsync('INSERT INTO personal_adaptive_policies VALUES(?,?)', id, JSON.stringify(f.before.policy));
      for (const event of f.before.events) await h.database.runAsync(`INSERT INTO personal_adaptive_actions
        (sequence,operation_id,chore_id,action_type,completion_id,round_id,target_operation_id,request_digest,event_json,receipt_json)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, event.sequence, event.operationId, id, event.type, event.completionId ?? null,
      event.roundId ?? null, event.targetOperationId ?? null, 'synthetic-observed-prefix', JSON.stringify(event), '{}');
      for (const forecast of f.before.forecasts) await h.database.runAsync('INSERT INTO personal_adaptive_forecasts VALUES(?,?,?,?,?)',
        forecast.id, id, forecast.sourceSequence, forecast.forRoundId, JSON.stringify(forecast));
      await h.database.runAsync('INSERT INTO personal_adaptive_plans VALUES(?,?,?,?,?,?)', f.previousPlan.id, previousRevision,
        id, JSON.stringify(f.previousPlan), 'observed-prefix', f.operation.recordedAt);
      await h.database.runAsync('INSERT INTO personal_adaptive_state VALUES(?,?,?,?,?,?)', id, f.before.events.length,
        JSON.stringify(f.before.state), f.previousPlan.id, previousRevision, 'observed-prefix');
      const chore = { ...createPersonalChoreDefinitions('private')[0], id, enabled: true,
        estimatedMinutes: f.definition.duration_minutes, load: f.definition.load };
      const geometry = prepareAdaptivePlacementInput({ from: f.operation.date, through: addDays(f.operation.date, 180), timeZone: 'Asia/Tokyo',
        preferences: { restDays: [], heavyLimit: 2, normalLimit: 2, dayOverrides: [],
          allowedBands: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMinute: 540, endMinute: 1140 })) },
        events: [], exceptions: [], fingerprint });
      const context = { householdId: 'private', ownerId: 'owner', today: f.operation.date, now: f.operation.recordedAt,
        mode: f.before.policy.mode, chores: [chore], states: [], sourceRevision: 'real-observed-prefix-phase',
        assignedMemberIds: () => ['owner'], fixedLoads: [], fingerprint, prepareGeometry: () => geometry, assertInputsCurrent() {} };
      const apply = async operation => {
        let receipt;
        await h.database.withTransactionAsync(async () => { receipt = await applyPersonalAdaptiveInside(h.database, context, id, operation); });
        return receipt;
      };
      const receipt = await apply(f.operation);
      assert.equal(receipt.kind, 'applied');
      const after = await readAdaptivePersonalInside(h.database, id);
      assert.deepEqual(after.state.model, f.expectedModel);
      assert.equal(after.plan.originalBaseDate, predictAdaptiveDate(after.state.model, f.operation.date));
      assert.equal(after.state.lastPlanCompletion.ruleDate, f.previousPlan.originalBaseDate);
      assert.equal(personalCadenceView(chore, after.state).automatic, true);
      const saved = h.connection.prepare('SELECT event_json FROM personal_adaptive_actions WHERE operation_id=?').get(f.operation.operationId);
      assert.equal(JSON.parse(saved.event_json).ruleDate, f.previousPlan.originalBaseDate);
      const forecast = JSON.parse(h.connection.prepare('SELECT forecast_json FROM personal_adaptive_forecasts WHERE source_sequence=(SELECT sequence FROM personal_adaptive_actions WHERE operation_id=?)').get(f.operation.operationId).forecast_json);
      assert.equal(forecast.forRoundId, after.plan.id);
      assert.equal(forecast.dates[f.expectedMethod], after.plan.originalBaseDate);
      const committed = h.connection.serialize();
      assert.deepEqual(await apply(f.operation), receipt);
      assert.deepEqual(h.connection.serialize(), committed, 'exact replay cannot duplicate learning or plans');
      await apply({ type: 'undo', operationId: `undo:${f.operation.operationId}`, recordedAt: f.operation.recordedAt,
        completionId: f.operation.completionId, targetOperationId: f.operation.operationId });
      const undone = await readAdaptivePersonalInside(h.database, id);
      assert.deepEqual(undone.state.model, f.before.state.model);
      assert.equal(undone.state.lastPlanCompletion.operationId, f.before.state.lastPlanCompletion.operationId);
      assert.equal(JSON.stringify(f.before.events), originalEvents);
    } finally { h.connection.close(); }
  });
});
