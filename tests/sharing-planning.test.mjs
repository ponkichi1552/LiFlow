import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { buildSharedReplica, compactSharedReplica } from '../src/features/sharing/replica.ts';
import { buildSharedPlannerSnapshot, sharedGroupBootstrap, sharedPlanningSignature } from '../src/features/sharing/planning.ts';
import { millisecondsUntilNextSharedDay, sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { createLocalSharedOperations, initializeSharingLedger, loadSharedReplica, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { completionCycleDate } from '../src/domain/scheduling/completion-matching.ts';
import { planSharedMutation } from '../src/features/sharing/mutations.ts';
import { planSharedConflictResolution } from '../src/features/sharing/conflict-resolution.ts';
const options = { groupId: 'group-test', ownerUserId: 'owner', ownerDisplayName: '自分', name: '家族', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' };
function fixture() {
  const drafts = sharedGroupBootstrap(options);
  return drafts.map((draft, index) => ({ ...draft, schemaVersion: 1, groupId: 'group-test', authorUserId: 'owner', authorDeviceId: 'device-a',
    deviceSequence: index + 1, logicalClock: index + 1, context: index ? { 'device-a': index } : {}, keyVersion: 1 }));
}
function next(ops, draft, device = 'device-a') {
  const replica = buildSharedReplica('group-test', ops);
  return { ...draft, operationId: draft.operationId ?? `edit-${device}-${replica.logicalClock + 1}`, schemaVersion: 1,
    groupId: 'group-test', authorUserId: device === 'device-a' ? 'owner' : 'member', authorDeviceId: device,
    deviceSequence: (replica.frontier[device] ?? 0) + 1, logicalClock: replica.logicalClock + 1,
    context: replica.frontier, keyVersion: 1 };
}
const plan = (ops, extra = {}) => buildSharedPlannerSnapshot(buildSharedReplica('group-test', ops),
  { householdId: 'local-household', now: new Date('2026-10-26T16:00:00Z'), ...extra });

test('shared category toggles stage one atomic set of field patches and reject foreign chores without changing the replica', () => {
  const ops = fixture(); const snapshot = plan(ops); const replica = buildSharedReplica('group-test', ops);
  const ids = snapshot.chores.slice(0, 3).map(row => row.id); let n = 0;
  const context = { snapshot, replica, userId: 'owner', now: new Date('2026-10-27T00:00:00Z'), makeId: () => `bulk-${++n}` };
  const result = planSharedMutation(context, 'setChoresEnabled', [ids, true]);
  assert.equal(result.drafts.length, 6);
  assert.equal(result.drafts.filter(row => row.entityType === 'chore' && row.payload.enabled === true).length, 3);
  assert.equal(result.drafts.filter(row => row.entityType === 'baseline' && row.payload.initialPending === true && row.payload.initialScheduledDate === snapshot.today).length, 3);
  const updated = [...ops]; for (const draft of result.drafts) updated.push(next(updated, draft));
  assert.equal(plan(updated).chores.filter(row => row.enabled).length, 3);
  assert.ok(snapshot.chores.every(row => !row.enabled));
  assert.throws(() => planSharedMutation(context, 'setChoresEnabled', [[ids[0], 'foreign-chore'], true]));
  assert.deepEqual(buildSharedReplica('group-test', ops), replica);
});

test('a separate shared workspace starts with 20 disabled built-ins and never imports private settings or external availability', () => {
  const ops = fixture(); const snapshot = plan(ops, { privateSettings: { frequencyMode: 'relaxed', restDays: [],
    heavyDailyLimit: 99, weatherLocation: { latitude: 0, longitude: 0, displayName: '個人用', region: 'private' },
    notificationHour: 7, calendarCountDisplayMode: 'dots' } });
  assert.equal(snapshot.chores.length, 46); assert.ok(snapshot.chores.every((chore) => !chore.enabled && chore.id.startsWith('group-test.')));
  assert.equal(snapshot.scheduleEntries.length, 0); assert.equal(snapshot.settings.frequencyMode, 'balanced');
  assert.equal(snapshot.settings.notificationHour, 7); assert.equal(snapshot.settings.calendarCountDisplayMode, 'dots');
  assert.equal(snapshot.settings.weatherLocation, undefined); assert.equal(snapshot.externalAvailabilityByDate, undefined);
  assert.equal(snapshot.today, '2026-10-27'); assert.equal(snapshot.timeZone, 'Asia/Tokyo');
});

test('unknown disabled shared chores activate from a canonical date and retain one card through interval edits, completion, undo and deletion', () => {
  const ops = fixture(); const id = 'group-test.builtin-chore-08';
  const edit = (draft) => { ops.push(next(ops, draft)); return plan(ops); };
  edit({ entityType: 'chore', entityId: id, operationType: 'patch', payload: { enabled: true, recommendedCycleDays: 17 } });
  let snapshot = edit({ entityType: 'baseline', entityId: id, operationType: 'patch', payload: { initialScheduledDate: '2026-10-27', initialPending: true } });
  const first = snapshot.scheduleEntries.find((entry) => entry.choreId === id); assert.ok(first); assert.equal(first.id, `${id}:initial`);
  const completion = next(ops, { entityType: 'completion', entityId: first.id, operationType: 'complete',
    payload: { choreId: id, completedAt: '2026-10-26T16:00:00Z', completedLocalDate: '2026-10-27', outcome: 'completed',
      scheduledDate: first.suggestedDate, scheduledWindowStart: first.windowStart, scheduledWindowEnd: first.windowEnd } });
  ops.push(completion); snapshot = plan(ops);
  assert.equal(snapshot.states.find((state) => state.choreId === id).lastCompletedDate, '2026-10-27');
  assert.equal(snapshot.completions.filter((entry) => entry.outcome === 'completed').length, 1);
  snapshot = edit({ entityType: 'completion', entityId: first.id, operationType: 'undo', payload: { targetOperationId: completion.operationId } });
  assert.equal(snapshot.completions[0].outcome, 'incomplete'); assert.equal(snapshot.scheduleEntries[0].id, first.id);
  snapshot = edit({ entityType: 'chore', entityId: id, operationType: 'delete', payload: {} });
  assert.equal(snapshot.scheduleEntries.length, 0); assert.ok(snapshot.chores.find((chore) => chore.id === id).archived);
  assert.equal(snapshot.completions.length, 1); assert.equal(snapshot.chores.find((chore) => chore.id === id).name, '室内・床・家具の掃除');
});

test('shared planning is identical across device timezones, arrival orders and private Calendar/weather input', () => {
  const ops = fixture(); const id = 'group-test.builtin-chore-08';
  ops.push(next(ops, { entityType: 'chore', entityId: id, operationType: 'patch', payload: { enabled: true } }));
  ops.push(next(ops, { entityType: 'baseline', entityId: id, operationType: 'patch', payload: { initialScheduledDate: '2026-10-27', initialPending: true } }));
  const oldZone = process.env.TZ; const signatures = [];
  try {
    for (const zone of ['Asia/Tokyo', 'America/New_York', 'Pacific/Honolulu', 'UTC']) {
      process.env.TZ = zone;
      signatures.push(sharedPlanningSignature(plan([...ops].reverse(), { privateSettings: { weatherLocation: { region: 'private', displayName: 'private', latitude: 40, longitude: 130 } } })));
    }
  } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
  assert.ok(signatures.every((signature) => signature === signatures[0]));
});

test('concurrent shared settings remain visible as conflicts and pause the affected chore until an observed resolution', () => {
  const ops = fixture(); const id = 'group-test.builtin-chore-08';
  const left = next(ops, { entityType: 'chore', entityId: id, operationType: 'patch', payload: { enabled: true, recommendedCycleDays: 7 } });
  const right = next(ops, { entityType: 'chore', entityId: id, operationType: 'patch', payload: { enabled: true, recommendedCycleDays: 17 } }, 'device-b');
  ops.push(left, right); let snapshot = plan(ops);
  assert.ok(snapshot.sharing.issues.some((issue) => issue.entityId === id && issue.kind === 'conflict'));
  assert.equal(snapshot.chores.find((chore) => chore.id === id).enabled, false);
  ops.push(next(ops, { entityType: 'chore', entityId: id, operationType: 'patch', payload: { recommendedCycleDays: 17 } }));
  snapshot = plan(ops); assert.equal(snapshot.sharing.issues.length, 0); assert.ok(snapshot.scheduleEntries.length > 0);
});

test('shared weekly, biweekly, monthly waste and one-time hiding preserve the same dates and labels', () => {
  const ops = fixture(); const edit = (draft) => ops.push(next(ops, draft));
  for (const [id, fields] of [['weekly', { label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [2] }],
    ['biweekly', { label: 'びん', recurrence: 'biweekly', collectionWeekdays: [4], anchorDate: '2026-10-29' }],
    ['monthly', { label: '粗大ごみ', recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 31 }]]) {
    edit({ entityType: 'waste', entityId: id, operationType: 'patch', payload: fields });
  }
  edit({ entityType: 'wasteVisibility', entityId: 'weekly.2026-10-27', operationType: 'patch', payload: { scheduleId: 'weekly', date: '2026-10-27', hidden: true } });
  const snapshot = plan(ops); assert.equal(snapshot.wasteSchedules.length, 3); assert.equal(snapshot.hiddenWasteDates[0].label, '可燃ごみ');
  assert.ok(snapshot.upcomingWasteDates.some((date) => date.scheduleId === 'monthly' && date.date === '2026-11-30'));
});

test('offline edits of dependent waste rule fields expose a conflict instead of creating an invalid mixed collection rule', () => {
  const ops = fixture(); const id = 'waste-concurrent';
  ops.push(next(ops, { entityType: 'waste', entityId: id, operationType: 'patch', payload: { label: 'びん', recurrence: 'weekly', collectionWeekdays: [2] } }));
  const snapshot = plan(ops); const displayed = snapshot.wasteSchedules[0];
  const replica = buildSharedReplica('group-test', ops);
  const draft = (schedule, prefix) => planSharedMutation({ replica, snapshot, now: new Date('2026-10-27T02:00:00Z'), userId: 'owner', makeId: () => prefix },
    'saveWeeklyWasteSchedule', [schedule, displayed]).drafts[0];
  const left = next(ops, draft({ ...displayed, recurrence: 'biweekly', anchorDate: '2026-10-27' }, 'fortnight-edit'));
  const right = next(ops, draft({ ...displayed, collectionWeekdays: [4] }, 'weekday-edit'), 'device-b');
  let signature;
  for (const changes of [[left, right], [right, left], [right, left, right, left]]) {
    const state = plan([...ops, ...changes]);
    assert.ok(state.sharing.issues.some((issue) => issue.entityId === id && issue.kind === 'conflict'));
    assert.equal(state.sharing.issues.some((issue) => issue.entityId === id && issue.kind === 'invalid'), false);
    assert.equal(state.wasteSchedules.some((schedule) => schedule.id === id), false);
    const nextSignature = sharedPlanningSignature(state);
    if (signature) assert.equal(nextSignature, signature); else signature = nextSignature;
  }
  for (const field of ['recurrence', 'collectionWeekdays', 'anchorDate']) {
    const merged = [...ops, left, right];
    const resolved = planSharedConflictResolution(buildSharedReplica('group-test', merged), 'waste', id, field, left.operationId, `resolve-${field}`);
    merged.push(next(merged, resolved));
    const state = plan(merged);
    assert.equal(state.sharing.issues.some((issue) => issue.entityId === id), false);
    assert.equal(state.wasteSchedules.find((schedule) => schedule.id === id).recurrence, 'biweekly');
    assert.deepEqual(state.wasteSchedules.find((schedule) => schedule.id === id).collectionWeekdays, [2]);
  }
});

test('monthly and fortnight collection-rule conflict choices remain coherent for either candidate after snapshot compaction', () => {
  const ops = fixture(); const id = 'waste-snapshot';
  ops.push(next(ops, { entityType: 'waste', entityId: id, operationType: 'patch', payload: { label: '資源ごみ', recurrence: 'weekly', collectionWeekdays: [2] } }));
  const snapshot = plan(ops); const displayed = snapshot.wasteSchedules[0];
  const replica = buildSharedReplica('group-test', ops);
  const edit = (schedule, operationId, device) => next(ops, planSharedMutation({ replica, snapshot,
    now: new Date('2026-10-27T02:00:00Z'), userId: 'owner', makeId: () => operationId }, 'saveWeeklyWasteSchedule', [schedule, displayed]).drafts[0], device);
  const monthly = edit({ ...displayed, recurrence: 'monthly', collectionWeekdays: [], monthlyDay: 28 }, 'monthly-edit', 'device-a');
  const fortnight = edit({ ...displayed, recurrence: 'biweekly', collectionWeekdays: [4], anchorDate: '2026-10-29' }, 'fortnight-edit', 'device-b');
  const merged = [...ops, monthly, fortnight];
  const compacted = buildSharedReplica('group-test', [], compactSharedReplica(buildSharedReplica('group-test', merged)));
  for (const chosen of [monthly, fortnight]) for (const field of ['recurrence', 'collectionWeekdays', 'anchorDate', 'monthlyDay']) {
    const decision = planSharedConflictResolution(compacted, 'waste', id, field, chosen.operationId, `choice-${chosen.operationId}-${field}`);
    const state = plan([...merged, next(merged, decision)]);
    assert.equal(state.sharing.issues.some((issue) => issue.entityId === id), false);
    const schedule = state.wasteSchedules.find((item) => item.id === id);
    assert.equal(schedule.recurrence, chosen.payload.recurrence);
    assert.deepEqual(schedule.collectionWeekdays, chosen.payload.collectionWeekdays);
    assert.equal(schedule.anchorDate ?? null, chosen.payload.anchorDate);
    assert.equal(schedule.monthlyDay ?? null, chosen.payload.monthlyDay);
  }
});

test('shared conflict decisions preserve ordinary field choices, deletion, restoration and stale-candidate rejection', () => {
  const ops = fixture(); const id = 'group-test.builtin-chore-08';
  const left = next(ops, { entityType: 'chore', entityId: id, operationType: 'patch', payload: { name: '家事A' } });
  const right = next(ops, { entityType: 'chore', entityId: id, operationType: 'patch', payload: { name: '家事B' } }, 'device-b');
  const conflict = buildSharedReplica('group-test', [...ops, left, right]);
  const choice = planSharedConflictResolution(conflict, 'chore', id, 'name', left.operationId, 'ordinary-choice');
  assert.deepEqual(choice.payload, { name: '家事A' });
  assert.equal(choice.operationType, 'patch');
  assert.throws(() => planSharedConflictResolution(conflict, 'chore', id, 'name', 'outdated', 'stale'), /更新されました/);
  const deletion = next(ops, { entityType: 'chore', entityId: id, operationType: 'delete', payload: {} });
  const edited = buildSharedReplica('group-test', [...ops, deletion, right]);
  assert.equal(planSharedConflictResolution(edited, 'chore', id, '$alive', deletion.operationId, 'deleted').operationType, 'delete');
  const restored = planSharedConflictResolution(edited, 'chore', id, '$alive', right.operationId, 'restored');
  assert.equal(restored.operationType, 'restore');
  assert.equal(restored.payload.name, '家事B');
  assert.ok(Object.values(restored.payload).every((value) => value !== null));
});

test('shared batch edits roll back together, project once and allocate consecutive clocks without uploading generated schedules', async () => {
  const h = createDatabase(); await initializeSharingLedger(h.database); let projections = 0;
  try {
    const author = { groupId: 'group-test', userId: 'owner', deviceId: 'device-a', keyVersion: 1 };
    await assert.rejects(createLocalSharedOperations(h.database, author, sharedGroupBootstrap(options), async () => { throw new Error('projection'); }), /projection/);
    assert.equal((await listSharingOutbox(h.database, 'group-test')).length, 0);
    const saved = await createLocalSharedOperations(h.database, author, sharedGroupBootstrap(options), async () => { projections++; });
    assert.equal(saved.length, 94); assert.equal(projections, 1); assert.equal(saved.at(-1).deviceSequence, 94);
    assert.equal((await loadSharedReplica(h.database, 'group-test')).pendingOperationIds.length, 0);
    assert.equal((await listSharingOutbox(h.database, 'group-test')).length, 94);
  } finally { h.connection.close(); }
});

test('group civil dates and midnight timers handle DST and completion timing without depending on the device zone', () => {
  assert.equal(sharedLocalDate(new Date('2026-10-26T16:00:00Z'), 'Asia/Tokyo'), '2026-10-27');
  assert.equal(millisecondsUntilNextSharedDay(new Date('2026-03-08T05:00:00Z'), 'America/New_York'), 23 * 3600000);
  assert.equal(millisecondsUntilNextSharedDay(new Date('2026-11-01T04:00:00Z'), 'America/New_York'), 25 * 3600000);
  const old = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    assert.equal(completionCycleDate({ completedAt: '2026-10-26T16:00:00Z', completedLocalDate: '2026-10-27', scheduledDate: '2026-10-27' }), '2026-10-27');
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
