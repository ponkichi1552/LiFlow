import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createDatabase } from './helpers/sqlite.mjs';
const { migrateLocalDatabase } = await import('../src/platform/storage/migrations.ts');
const runtime = await import('../src/platform/storage/personal-adaptive-planner.ts');
const store = await import('../src/platform/storage/adaptive-personal-chores.ts');
const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
const { prepareAdaptivePlacementInput } = await import('../src/features/planner/adaptive-input.ts');
const { initialAdaptiveBaseDate } = await import('../src/domain/scheduling/adaptive/placement.ts');
const { newEventDraft } = await import('../src/domain/calendar/events.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(select) {
  const h = createDatabase(); await migrateLocalDatabase(h.database);
  await h.database.runAsync('INSERT INTO households VALUES(?,?,?)', 'household', 'test', '2026-11-01T00:00:00Z');
  let chores = createPersonalChoreDefinitions('household'); if (select) chores = select(chores);
  let today = '2026-11-01'; let mode = 'balanced'; let events = []; let geometryCalls = 0; let currentVersion = 0;
  const preferences = { restDays: [], heavyLimit: 2, normalLimit: 2, allowedBands: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMinute: 540, endMinute: 1140 })), dayOverrides: [] };
  let states = [];
  function context(patch = {}) {
    const expectedVersion = currentVersion;
    return { householdId: 'household', ownerId: 'owner', today, now: `${today}T08:00:00Z`, mode, chores, states, fixedLoads: [],
      assignedMemberIds: () => ['self'], fingerprint,
      sourceRevision: runtime.personalAdaptiveSourceRevision({ mode, timeZone: 'UTC', preferences, calendarTiming: events, sharedLoads: [] }, fingerprint),
      prepareGeometry() { geometryCalls++; return prepareAdaptivePlacementInput({ from: today, through: addDays(today, 180), timeZone: 'UTC', preferences, events, exceptions: [], fingerprint }); },
      assertInputsCurrent() { if (currentVersion !== expectedVersion) throw new Error('input changed'); }, ...patch };
  }
  async function inside(work) { let value; await h.database.withTransactionAsync(async () => { value = await work(); }); return value; }
  const synchronize = (patch) => inside(() => runtime.synchronizePersonalAdaptiveInside(h.database, context(patch)));
  const complete = async (choreId, date, change = {}) => {
    const view = await store.readAdaptivePersonalInside(h.database, choreId); today = date;
    const operation = { operationId: `complete-${currentVersion++}`, recordedAt: `${date}T08:00:00Z`, type: 'complete', date, timeZone: 'UTC',
      origin: 'personal', completionId: `completion-${currentVersion}`, roundId: view.plan.id, planRevision: view.planRevision, ...change };
    return { operation, receipt: await inside(() => runtime.applyPersonalAdaptiveInside(h.database, context(), choreId, operation)) };
  };
  return { ...h, context, inside, synchronize, complete, geometryCalls: () => geometryCalls,
    date(value) { today = value; }, mode(value) { mode = value; currentVersion++; }, events(value) { events = value; currentVersion++; },
    chores(value) { chores = value; currentVersion++; }, states(value) { states = value; }, bump() { currentVersion++; } };
}

test('personal adaptive planner jointly generates the actual new-catalog rounds and ordinary reads or date passage do not recalculate', async () => {
  const h = await fixture();
  try {
    const views = await h.synchronize(); const input = h.context(); const entries = runtime.personalAdaptiveEntries(input, views);
    assert.ok(entries.length > 0); assert.equal(new Set(entries.map(row => row.choreId)).size, entries.length);
    assert.ok(entries.every(row => row.id.startsWith('personal-round.') && row.suggestedDate >= input.today));
    const before = h.connection.serialize(); const calls = h.geometryCalls();
    assert.deepEqual(await h.synchronize(), views); assert.deepEqual(h.connection.serialize(), before); assert.equal(h.geometryCalls(), calls);
    h.date('2027-11-01'); const old = await h.synchronize();
    assert.equal(h.geometryCalls(), calls); assert.deepEqual(h.connection.serialize(), before);
    assert.ok(runtime.personalAdaptiveEntries(h.context(), old).every(row => row.status === 'overdue'));
    assert.deepEqual([...old].map(([id, view]) => [id, view.plan?.id, view.state.model]), [...views].map(([id, view]) => [id, view.plan?.id, view.state.model]));
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_actions').get().n, 0);
  } finally { h.connection.close(); }
});

test('setup previous-date input anchors a first real plan without inventing completion observations', async () => {
  const h = await fixture(all => [{ ...all.find(chore => chore.frequencyDaysByMode.balanced === 7), enabled: true, userWindowRadiusDays: 0 }]);
  try {
    const chore = h.context().chores[0]; h.states([{ choreId: chore.id, lastCompletedDate: '2026-10-20', lastCompletedEstimated: true, initialPending: false }]);
    const views = await h.synchronize(); const view = views.get(chore.id);
    assert.equal(view.plan.originalBaseDate, '2026-10-27'); assert.equal(view.state.validUnitCount, 0);
    assert.equal(view.state.lastCompletedDate, null); assert.equal(view.state.lastPlanCompletion, null);
    assert.equal(runtime.personalAdaptiveEntries(h.context(), views)[0].status, 'overdue');
  } finally { h.connection.close(); }
});

test('new-catalog exact completion replay is terminal without geometry recomputation and Undo preserves a later manual cycle', async () => {
  const h = await fixture(all => [{ ...all[0], enabled: true }]);
  try {
    let views = await h.synchronize(); const choreId = h.context().chores[0].id;
    const completed = await h.complete(choreId, views.get(choreId).plan.recommendedDate); const calls = h.geometryCalls();
    assert.deepEqual(await h.inside(() => runtime.applyPersonalAdaptiveInside(h.database, h.context(), choreId, completed.operation)), completed.receipt);
    assert.equal(h.geometryCalls(), calls);
    h.chores(h.context().chores.map(chore => ({ ...chore, recommendedCycleDays: 4000 })));
    await h.synchronize();
    await h.inside(() => runtime.applyPersonalAdaptiveInside(h.database, h.context(), choreId, { type: 'undo', operationId: 'undo-source',
      completionId: completed.operation.completionId, targetOperationId: completed.operation.operationId, recordedAt: h.context().now }));
    views = await store.readAllAdaptivePersonalInside(h.database);
    assert.equal(views.get(choreId).state.model.days, 4000); assert.equal(views.get(choreId).state.policy.fixedDays, 4000);
    assert.equal(views.get(choreId).state.validUnitCount, 0);
  } finally { h.connection.close(); }
});

test('a busy interval change only replans the connected candidate dates and cannot move an unrelated distant round', async () => {
  const h = await fixture(all => {
    const a = { ...all.find(chore => chore.frequencyDaysByMode.balanced === 7 && initialAdaptiveBaseDate({ today: '2026-11-01',
      periodDays: 7, ownerId: 'owner', choreId: chore.id, version: `catalog-6:${chore.id}`, fingerprint }) >= '2026-11-04'), enabled: true, userWindowRadiusDays: 0 };
    const b = all.find(chore => chore.id !== a.id && chore.frequencyDaysByMode.balanced >= 30 && initialAdaptiveBaseDate({ today: '2026-11-01',
      periodDays: chore.frequencyDaysByMode.balanced, ownerId: 'owner', choreId: chore.id, version: `catalog-6:${chore.id}`, fingerprint }) >= '2026-11-18');
    assert.ok(b); return [a, { ...b, enabled: true, userWindowRadiusDays: 0 }];
  });
  try {
    const first = await h.synchronize(); const [a, b] = h.context().chores; const source = first.get(a.id).plan;
    const event = { ...newEventDraft(source.recommendedDate, 'UTC'), id: 'busy', revision: 1, title: 'test', allDay: true };
    h.events([event]); const after = await h.synchronize();
    assert.deepEqual(after.get(b.id), first.get(b.id));
    assert.notEqual(after.get(a.id).inputRevision, first.get(a.id).inputRevision);
    assert.equal(after.get(a.id).plan.id, source.id);
  } finally { h.connection.close(); }
});

test('the global mode change protects a current round while necessary-only new modes stop later periodic generation', async () => {
  const h = await fixture(all => [{ ...all.find(chore => chore.frequencyDaysByMode.balanced && !chore.frequencyDaysByMode.relaxed), enabled: true }]);
  try {
    const first = await h.synchronize(); const choreId = h.context().chores[0].id; const current = first.get(choreId);
    h.date(current.plan.recommendedDate); h.mode('relaxed'); const changed = await h.synchronize();
    assert.equal(changed.get(choreId).state.model, null); assert.deepEqual(changed.get(choreId).plan, current.plan);
    const done = await h.complete(choreId, current.plan.recommendedDate);
    assert.equal(done.receipt.activeRoundId, null); assert.equal((await store.readAdaptivePersonalInside(h.database, choreId)).plan, null);
  } finally { h.connection.close(); }
});

test('a stale input version rolls back a whole personal planner batch and leaves no half initialized round', async () => {
  const h = await fixture(all => [{ ...all[0], enabled: true }]);
  try {
    const before = h.connection.serialize();
    await assert.rejects(h.synchronize({ assertInputsCurrent() { throw new Error('input changed'); } }), /input changed/);
    assert.deepEqual(h.connection.serialize(), before);
    assert.equal((await h.synchronize()).size, 1);
  } finally { h.connection.close(); }
});

test('audit100 disabled personal rounds do not reserve the only remaining slot for another active chore', async () => {
  const h = await fixture(all => [{ ...all[0], enabled: true, userIntervalDays: 7, userWindowRadiusDays: 0, estimatedMinutes: 60, load: 'heavy' }]);
  try {
    const first = h.context().chores[0]; const second = { ...first, id: createPersonalChoreDefinitions('household')[1].id, personalRecipeId: createPersonalChoreDefinitions('household')[1].id };
    h.states([{ choreId: first.id, lastCompletedDate: '2026-10-29' }, { choreId: second.id, lastCompletedDate: '2026-10-29' }]);
    const prepareGeometry = () => prepareAdaptivePlacementInput({ from: '2026-11-01', through: '2026-11-10', timeZone: 'UTC',
      preferences: { restDays: [], heavyLimit: 1, normalLimit: 1, allowedBands: [], dayOverrides: [{ date: '2026-11-05', allowedBands: [{ startMinute: 540, endMinute: 600 }] }] },
      events: [], exceptions: [], fingerprint });
    const initial = await h.synchronize({ prepareGeometry }); assert.ok(initial.get(first.id).plan.slot);
    h.chores([{ ...first, enabled: false }, second]);
    const after = await h.synchronize({ prepareGeometry });
    assert.equal(after.get(first.id).state.policy.enabled, false);
    assert.ok(after.get(second.id).plan.slot, 'the disabled first chore cannot occupy Nov 5');
    assert.equal(after.get(second.id).plan.recommendedDate, '2026-11-05');
  } finally { h.connection.close(); }
});
