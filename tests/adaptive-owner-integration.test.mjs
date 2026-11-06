import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
const { bindAdaptiveOwnerReader, withAdaptiveOwnerInputScope, readAdaptiveOwnerInputs, inheritAdaptiveOwnerInputScope, AdaptiveOwnerInputsChangedError } = await import('../src/platform/storage/adaptive-owner-inputs.ts');
const { sharedAdaptiveLoad } = await import('../src/features/planner/shared-adaptive-load.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');
const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
const { readAdaptivePersonalInside } = await import('../src/platform/storage/adaptive-personal-chores.ts');
const repository = await import('../src/platform/storage/repository.ts');
const { fixture: sharedFixture, seeds, now: sharedNow } = await import('./helpers/sharing-v2-repository-fixture.mjs');
const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
const preferences = timeZone => ({ schemaVersion: 1, ownerUserId: 'owner', revision: 1, timeZone, restDays: [1, 2, 3, 4, 5, 6, 7],
  loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 2 }, allowedBands: [1, 2, 3, 4, 5, 6, 7].map(weekday => ({ weekday, startMinute: 540, endMinute: 600 })) });
const subject = (id, extra = {}) => ({ id, required: true, subjectUserId: null, completed: false, virtuallyConsumed: false, cooldownSuppressed: false,
  suggestedDate: '2026-11-06', formalDate: { kind: 'automatic' }, ...extra });
const occurrence = (id, extra = {}) => ({ id, choreId: 'shared-chore', activeInPeriod: true, historical: false, assigneeIds: [], subjects: [subject(id)], ...extra });
const plan = (occurrences = [], history = []) => ({ groupId: 'group', initialized: true, members: [{ userId: 'owner', active: true }],
  chores: [{ id: 'shared-chore', name: '共有清掃', enabled: true, estimatedMinutes: 45, load: 'heavy' }], occurrences, history });
const completion = (operationId, id, extra = {}) => ({ operationId, subjectOccurrenceId: id, choreId: 'shared-chore', active: true,
  acceptance: 'accepted', outcome: 'completed', approvalConflictIds: [], performerUserId: 'owner', performedAt: '2026-11-05T01:00:00Z', ...extra });

async function personal(t, now = '2026-11-05T01:00:00Z', anchor) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const chore = createPersonalChoreDefinitions(repository.LOCAL_HOUSEHOLD_ID)[1];
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1, 2, 3, 4, 5, 6, 7], enabledChoreIds: [chore.id], previousDates: anchor ? { [chore.id]: { date: anchor, estimated: true } } : {}, weatherLocation: null });
  return { ...h, chore };
}

test('shared load reserves own and unassigned subjects once and ignores other assignees cooldown and consumed rounds', () => {
  const common = plan([occurrence('open'), occurrence('own', { assigneeIds: ['owner'] }), occurrence('other', { assigneeIds: ['member'] }),
    occurrence('each', { subjects: [subject('owner-sub', { subjectUserId: 'owner' }), subject('member-sub', { subjectUserId: 'member' })] }),
    occurrence('cooldown', { subjects: [subject('cooldown', { cooldownSuppressed: true })] }),
    occurrence('consumed', { subjects: [subject('consumed', { virtuallyConsumed: true })] }), occurrence('past', { historical: true })]);
  const original = JSON.stringify(common); const result = sharedAdaptiveLoad(common, 'owner', '2026-11-05', 'Asia/Tokyo', []);
  assert.deepEqual(result.loads.map(row => row.roundId), ['shared:group:open', 'shared:group:own', 'shared:group:owner-sub']);
  assert.ok(result.loads.every(row => row.minutes === 45 && row.slot === null)); assert.equal(JSON.stringify(common), original);
  assert.throws(() => sharedAdaptiveLoad(common, 'attacker', '2026-11-05', 'Asia/Tokyo', []), /参加/);
});

test('shared completion canonicalization releases others work without charging it to the owner and only confirmed accepted own work is spent', () => {
  const common = plan([occurrence('done', { subjects: [subject('done', { completed: true })] }), occurrence('pending')],
    [completion('a', 'done', { performerUserId: 'member' }), completion('b', 'done'), completion('c', 'mine'), completion('d', 'mine'),
      completion('undone', 'undone', { active: false }), completion('not-yet', 'not-yet', { acceptance: 'pending' }),
      completion('conflict', 'conflict', { approvalConflictIds: ['x'] }), completion('yesterday', 'old', { performedAt: '2026-11-03T01:00:00Z' })]);
  const result = sharedAdaptiveLoad(common, 'owner', '2026-11-05', 'Asia/Tokyo', []);
  assert.deepEqual(result.loads.map(row => [row.roundId, row.date]), [['shared:group:mine', '2026-11-05'], ['shared:group:pending', '2026-11-06']]);
});

test('shared interval load uses real instants while date-only work keeps its civil day and matching private copies are suppressed without editing them', () => {
  const fixed = { kind: 'manual', mode: 'fixed', target: { precision: 'interval', start: '2026-11-05T00:00:00Z', end: '2026-11-05T00:45:00Z' } };
  const common = plan([occurrence('fixed', { subjects: [subject('fixed', { formalDate: fixed })] }), occurrence('date')]);
  const personal = [{ id: 'private-copy', name: '共有清掃', enabled: true }]; const original = JSON.stringify(personal);
  const projected = sharedAdaptiveLoad(common, 'owner', '2026-11-04', 'Pacific/Honolulu', personal);
  assert.equal(projected.loads.find(row => row.roundId.endsWith(':fixed')).date, '2026-11-04');
  assert.equal(projected.loads.find(row => row.roundId.endsWith(':date')).date, '2026-11-06');
  assert.equal(projected.loads[1].minutes, 45); assert.deepEqual([...projected.suppressedPersonalChoreIds], ['private-copy']); assert.equal(JSON.stringify(personal), original);
});

test('one repository operation captures owner inputs once across transaction aliases and a later operation refreshes them', async () => {
  const h = createDatabase(); const child = createDatabase(); let calls = 0;
  const unbind = bindAdaptiveOwnerReader(h.database, async () => { calls++; return { ownerUserId: null, preferences: null, common: null, assertCurrent() {} }; });
  try {
    await withAdaptiveOwnerInputScope(h.database, async () => {
      const first = await readAdaptiveOwnerInputs(h.database, new Date());
      assert.equal(await readAdaptiveOwnerInputs(h.database, new Date()), first);
      await inheritAdaptiveOwnerInputScope(h.database, child.database, async () => assert.equal(await readAdaptiveOwnerInputs(child.database, new Date()), first));
    });
    assert.equal(calls, 1);
    await withAdaptiveOwnerInputScope(h.database, () => readAdaptiveOwnerInputs(h.database, new Date())); assert.equal(calls, 2);
  } finally { unbind(); h.connection.close(); child.connection.close(); }
});

test('actual repository uses protected owner timezone allowed hours and limits without writing them into public household settings', async t => {
  const h = await personal(t, '2026-11-05T00:30:00Z'); const own = preferences('Pacific/Honolulu'); own.loadLimits = { heavyDailyLimit: 1, normalDailyLimit: 3 };
  await repository.loadPlannerSnapshot(h.database);
  let capture = 0; let valid = true;
  const stop = bindAdaptiveOwnerReader(h.database, async () => { capture++; return { ownerUserId: 'owner', preferences: own, common: null, assertCurrent() { if (!valid) throw new AdaptiveOwnerInputsChangedError(); } }; }); t.after(stop);
  const before = h.connection.prepare('SELECT * FROM household_settings').all(); capture = 0;
  const snapshot = await repository.readPersonalPlannerOverlaySnapshot(h.database, new Date());
  assert.equal(capture, 1); assert.equal(snapshot.today, '2026-11-04'); assert.equal(snapshot.timeZone, 'Pacific/Honolulu');
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, memberId: repository.LOCAL_MEMBER_ID,
    now: new Date(), timeZone: 'Asia/Tokyo' }); const geometry = context.prepareGeometry();
  assert.equal(context.today, '2026-11-04'); assert.equal(geometry.days[0].heavyLimit, 1); assert.equal(geometry.days[0].normalLimit, 3);
  assert.equal(geometry.days[0].allowed[0].start, Date.parse('2026-11-04T19:00:00Z'));
  assert.deepEqual(h.connection.prepare('SELECT * FROM household_settings').all(), before);
  valid = false; assert.equal(repository.readCachedPlannerSnapshot(h.database), null);
});

test('actual repository shared load is independent of the displayed range and does not double-count a matching private pending round', async t => {
  const h = await personal(t); const initial = await repository.loadPlannerSnapshot(h.database); const entry = initial.scheduleEntries[0];
  const common = plan([occurrence('fixed-load', { subjects: [subject('fixed-load', { suggestedDate: entry.suggestedDate })] })]);
  common.chores[0].name = h.chore.name;
  const saved = JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(h.chore.id).definition_json);
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: preferences('Asia/Tokyo'), common, assertCurrent() {} })); t.after(stop);
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID, memberId: repository.LOCAL_MEMBER_ID,
    now: new Date(), timeZone: 'Asia/Tokyo' });
  assert.deepEqual(context.fixedLoads.map(row => row.roundId), ['shared:group:fixed-load']); assert.equal(context.suppressedChoreIds.has(h.chore.id), true);
  await repository.loadPlannerSnapshot(h.database);
  assert.deepEqual(JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(h.chore.id).definition_json), saved);
  assert.equal((await readAdaptivePersonalInside(h.database, h.chore.id)).plan.id, entry.id);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completions').get().n, 0);
});

test('real signed shared one-person and per-member completion policies determine reservation release without rewriting common authority', async () => {
  const f = await sharedFixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); let n = 0;
    const controller = createV2GroupController(d.repository, { now: sharedNow, makeId: () => `load-${++n}`, sync: async () => {} });
    const range = { from: '2026-10-27', through: '2026-11-26', asOfDate: '2026-10-27' };
    const before = await controller.readModel(range);
    const prior = sharedAdaptiveLoad(before.plan, 'owner', range.asOfDate, 'Asia/Tokyo', []); assert.ok(prior.loads.length > 0);
    const hash = before.plan.planHash; sharedAdaptiveLoad(before.plan, 'member', range.asOfDate, 'Asia/Tokyo', []); assert.equal(before.plan.planHash, hash);
    await controller.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null });
    const after = await controller.readModel(range); const completedId = after.plan.occurrences.find(row => row.anchorDate === range.asOfDate).subjects[0].id;
    assert.equal(sharedAdaptiveLoad(after.plan, 'member', range.asOfDate, 'Asia/Tokyo', []).loads.some(row => row.roundId.endsWith(`:${completedId}`)), false);
    assert.equal(sharedAdaptiveLoad(after.plan, 'owner', range.asOfDate, 'Asia/Tokyo', []).loads.filter(row => row.date === range.asOfDate).length, 1);
  } finally { d.connection.close(); }
});

test('actual owner completion records the configured civil day and later account input drift rolls back every adaptive and completion write', async t => {
  const h = await personal(t, '2026-11-05T00:30:00Z'); let deny = false;
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: preferences('Pacific/Honolulu'), common: null,
    assertCurrent() {}, async assertCommitCurrent() { if (deny) throw new AdaptiveOwnerInputsChangedError(); } })); t.after(stop);
  const snapshot = await repository.readPersonalPlannerOverlaySnapshot(h.database, new Date());
  const receipt = await repository.completeChoreWithReceipt(h.database, snapshot.snapshot.scheduleEntries[0]);
  assert.equal(receipt.completedLocalDate, '2026-11-04'); assert.equal(receipt.completedTimeZone, 'Pacific/Honolulu');
  assert.equal((await readAdaptivePersonalInside(h.database, h.chore.id)).state.lastPlanCompletion.date, '2026-11-04');
  const tables = ['chore_completions', 'chore_state', 'personal_adaptive_actions', 'personal_adaptive_state', 'personal_adaptive_plans', 'chore_schedule_entries'];
  const before = tables.map(name => h.connection.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
  deny = true;
  await assert.rejects(repository.undoCompletionReceipt(h.database, receipt), AdaptiveOwnerInputsChangedError);
  assert.deepEqual(tables.map(name => h.connection.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()), before);
});

test('a historical Google completion keeps its original owner day without capturing a past shared planning horizon for the current sync', async t => {
  const h = await personal(t, '2026-11-05T00:30:00Z');
  const entry = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries[0];
  const link = { scheduleEntryId: entry.id, householdId: repository.LOCAL_HOUSEHOLD_ID, choreId: entry.choreId,
    googleTaskListId: 'own-list', googleTaskId: 'own-task', lastSyncedStatus: 'needsAction',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await repository.upsertGoogleTaskLink(h.database, link);
  const captures = [];
  const stop = bindAdaptiveOwnerReader(h.database, async now => {
    captures.push(now.toISOString());
    return { ownerUserId: 'owner', preferences: preferences('Pacific/Honolulu'), common: null, assertCurrent() {} };
  }); t.after(stop);
  const completedAt = '2026-11-04T01:00:00Z';
  assert.equal(await repository.importGoogleTaskChanges(h.database, [{ ...link, status: 'completed', completedAt }]), 1);
  assert.deepEqual(captures, ['2026-11-05T00:30:00.000Z']);
  const row = h.connection.prepare('SELECT completed_at,completed_local_date,completed_time_zone FROM chore_completions WHERE schedule_entry_id=?').get(entry.id);
  assert.deepEqual({ ...row }, { completed_at: new Date(completedAt).toISOString(), completed_local_date: '2026-11-03', completed_time_zone: 'Pacific/Honolulu' });
  const current = repository.readCachedPlannerSnapshot(h.database);
  assert.equal(current.today, '2026-11-04'); assert.equal(current.timeZone, 'Pacific/Honolulu');
});

test('a newly assigned shared load replans only connected future private work and a no-op refresh does no further writes', async t => {
  const h = await personal(t, '2026-11-05T01:00:00Z', '2026-10-31');
  const common = plan([]); const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: preferences('Asia/Tokyo'), common, assertCurrent() {} })); t.after(stop);
  const before = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries[0]; assert.ok(before.suggestedDate > '2026-11-06');
  const original = await readAdaptivePersonalInside(h.database, h.chore.id);
  common.occurrences.push(occurrence('new-load', { subjects: [subject('new-load', { suggestedDate: before.suggestedDate })] }));
  const after = (await repository.loadPlannerSnapshot(h.database)).scheduleEntries[0];
  assert.notEqual(after.suggestedDate, before.suggestedDate); assert.equal(after.id, before.id);
  assert.deepEqual((await readAdaptivePersonalInside(h.database, h.chore.id)).state, original.state);
  h.writes.length = 0; await repository.loadPlannerSnapshot(h.database); assert.equal(h.writes.length, 0);
});

test('a private fixed-period edit is journaled while its shared copy supplies the visible load and returns intact after leaving', async t => {
  const h = await personal(t); let common = plan([]); common.chores[0].name = h.chore.name;
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: preferences('Asia/Tokyo'), common, assertCurrent() {} })); t.after(stop);
  await repository.updateChoreSettings(h.database, h.chore.id, { cycleDays: 31 });
  assert.equal((await readAdaptivePersonalInside(h.database, h.chore.id)).state.policy.fixedDays, 31);
  common = null; const restored = await repository.loadPlannerSnapshot(h.database);
  assert.equal(restored.chores.find(row => row.id === h.chore.id).recommendedCycleDays, 31);
  assert.equal((await readAdaptivePersonalInside(h.database, h.chore.id)).state.model.days, 31);
});

test('real signed per-member completion keeps the other required subject reserved without charging someone elses work', async () => {
  const f = await sharedFixture(); const d = await f.device();
  try {
    const input = seeds(); input.find(row => row.entityType === 'chorePolicy').payload.configuration.policy = { completion: 'perMember', assignment: { mode: 'all', memberIds: [] } };
    await d.repository.commit(input); let n = 0;
    const controller = createV2GroupController(d.repository, { now: sharedNow, makeId: () => `per-member-load-${++n}`, sync: async () => {} });
    const range = { from: '2026-10-27', through: '2026-11-26', asOfDate: '2026-10-27' };
    await controller.actions.complete({ choreId: 'floor', anchorDate: range.asOfDate, subjectUserId: 'owner' });
    const model = await controller.readModel(range); const round = model.plan.occurrences.find(row => row.anchorDate === range.asOfDate);
    const other = round.subjects.find(row => row.subjectUserId === 'member'); assert.equal(other.completed, false);
    const load = sharedAdaptiveLoad(model.plan, 'member', range.asOfDate, 'Asia/Tokyo', []);
    assert.equal(load.loads.filter(row => row.roundId.endsWith(`:${other.id}`)).length, 1);
    assert.equal(load.loads.filter(row => row.date === range.asOfDate).length, 1);
  } finally { d.connection.close(); }
});

test('captured shared-first recommendations stay identical across visible ranges and never accept another owner or shared source revision', async () => {
  const { capturedSharedRecommendations } = await import('../src/features/planner/shared-adaptive-load.ts');
  const common = { ...plan(), sourceHash: 'source', planHash: 'visible' };
  const fallback = { groupId: 'group', viewerUserId: 'owner', commonPlanHash: 'visible', localHash: 'fallback', recommendations: [{ subjectOccurrenceId: 'one', date: '2026-11-06' }] };
  const captured = { ownerUserId: 'owner', groupId: 'group', sourceHash: 'source', plan: { ...fallback, commonPlanHash: 'wide', recommendations: [{ subjectOccurrenceId: 'one', date: '2026-11-08' }] } };
  const read = capturedSharedRecommendations(common, fallback, captured); assert.equal(read.recommendations[0].date, '2026-11-08'); assert.equal(read.commonPlanHash, 'visible');
  for (const patch of [{ ownerUserId: 'other' }, { groupId: 'other' }, { sourceHash: 'newer' }]) assert.equal(capturedSharedRecommendations(common, fallback, { ...captured, ...patch }), fallback);
  assert.equal(fallback.recommendations[0].date, '2026-11-06');
});

test('the owner widget snapshot expires at the selected civil midnight including a 23-hour DST day', async () => {
  const { createTodayWidgetSnapshot } = await import('../src/features/widgets/today-widget-snapshot.ts');
  const one = createTodayWidgetSnapshot([], [], [], '2026-11-04', '2026-11-05T01:00:00Z', 'Pacific/Honolulu');
  assert.equal(one.displayTimeZone, 'Pacific/Honolulu'); assert.equal(one.contentUntil, Date.parse('2026-11-05T10:00:00Z'));
  const dst = createTodayWidgetSnapshot([], [], [], '2026-03-08', '2026-03-08T05:00:00Z', 'America/New_York');
  assert.equal(dst.contentUntil, Date.parse('2026-03-09T04:00:00Z')); assert.equal(dst.contentUntil - Date.parse(dst.updatedAt), 23 * 3600_000);
});

test('actual private planning unions protected calendar intervals with local events and keeps incomplete or stale days unknown', async t => {
  const h = await personal(t); const date = '2026-11-05'; const timeZone = 'Asia/Tokyo';
  const { saveCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
  const { newEventDraft } = await import('../src/features/calendar/events.ts');
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(date, timeZone), title: '自分だけの予定', startMinute: 540, endMinute: 560 } });
  const binding = { ownerUserId: 'owner', accountGeneration: 'generation', mainDeviceId: 'device', mainRevision: 1, calendarBinding: 'binding' };
  const cache = { ...binding, timeZone, fetchedAt: new Date().toISOString(),
    coverage: { start: '2026-11-04T15:00:00Z', end: '2026-11-05T15:00:00Z' },
    intervals: [{ start: '2026-11-05T00:10:00Z', end: '2026-11-05T00:30:00Z' }] };
  const privateCalendar = { ownerUserId: 'owner', connected: true, binding, cache };
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: preferences(timeZone), common: null, privateCalendar, assertCurrent() {} })); t.after(stop);
  const context = () => readPersonalAdaptiveContextInside(h.database, { householdId: repository.LOCAL_HOUSEHOLD_ID,
    memberId: repository.LOCAL_MEMBER_ID, now: new Date(), timeZone });
  const first = await context(); const geometry = first.prepareGeometry();
  const busy = geometry.busy.filter(row => row.start < Date.parse(cache.coverage.end));
  assert.deepEqual(busy, [{ start: Date.parse('2026-11-05T00:00:00Z'), end: Date.parse('2026-11-05T00:30:00Z') }]);
  const tomorrow = geometry.days.find(day => day.date === '2026-11-06');
  assert.ok(geometry.busy.some(row => row.start <= tomorrow.bounds.start && row.end >= tomorrow.bounds.end));
  cache.fetchedAt = '2026-11-03T00:00:00Z';
  const stale = await context(); assert.notEqual(stale.sourceRevision, first.sourceRevision);
  assert.ok(stale.prepareGeometry().busy.some(row => row.start <= geometry.days[0].bounds.start && row.end >= geometry.days[0].bounds.end));
  privateCalendar.connected = false;
  const off = (await context()).prepareGeometry();
  assert.deepEqual(off.busy, [{ start: Date.parse('2026-11-05T00:00:00Z'), end: Date.parse('2026-11-05T00:20:00Z') }]);
  privateCalendar.ownerUserId = 'other'; await assert.rejects(context, /本人/);
});

test('composing an unchanged owner home and calendar reuses the personal plan without recapturing the shared scheduler', async t => {
  const h = await personal(t); let captures = 0; let guards = 0;
  const stop = bindAdaptiveOwnerReader(h.database, async () => { captures++; return { ownerUserId: 'owner', preferences: preferences('Asia/Tokyo'), common: null,
    assertCurrent() {}, async assertCommitCurrent() { guards++; } }; }); t.after(stop);
  const initial = await repository.loadPlannerSnapshot(h.database); const before = h.connection.prepare('SELECT total_changes() n').get().n;
  captures = 0; guards = 0;
  for (let index = 0; index < 4; index++) {
    const overlay = await repository.readPersonalPlannerOverlaySnapshot(h.database, new Date());
    assert.equal(overlay.snapshot, initial); assert.equal(overlay.today, '2026-11-05'); assert.equal(overlay.timeZone, 'Asia/Tokyo');
  }
  assert.equal(captures, 0); assert.equal(guards, 4); assert.equal(h.connection.prepare('SELECT total_changes() n').get().n, before);
});

test('a silent protected preference change refuses the old cached overlay and recaptures its actual owner clock', async t => {
  const h = await personal(t, '2026-11-05T00:30:00Z'); let revision = 1; let zone = 'Asia/Tokyo'; let captures = 0;
  const stop = bindAdaptiveOwnerReader(h.database, async () => { captures++; const at = revision;
    return { ownerUserId: 'owner', preferences: { ...preferences(zone), revision }, common: null, assertCurrent() {},
      async assertCommitCurrent() { if (at !== revision) throw new AdaptiveOwnerInputsChangedError(); } }; }); t.after(stop);
  const old = await repository.loadPlannerSnapshot(h.database); captures = 0; revision++; zone = 'Pacific/Honolulu';
  const result = await repository.readPersonalPlannerOverlaySnapshot(h.database, new Date());
  assert.notEqual(result.snapshot, old); assert.equal(result.timeZone, zone); assert.equal(result.today, '2026-11-04'); assert.equal(captures, 1);
});

test('an unverified protected-cache read failure cannot fall through to an apparently successful cached personal display', async t => {
  const h = await personal(t); let fail = false;
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', preferences: preferences('Asia/Tokyo'), common: null,
    assertCurrent() {}, async assertCommitCurrent() { if (fail) throw new Error('protected calendar temporarily unreadable'); } })); t.after(stop);
  await repository.loadPlannerSnapshot(h.database); fail = true;
  await assert.rejects(repository.readPersonalPlannerOverlaySnapshot(h.database, new Date()), /protected calendar temporarily unreadable/);
});
