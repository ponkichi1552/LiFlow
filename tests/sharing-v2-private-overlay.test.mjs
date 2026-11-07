import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture as sharedFixture, seeds, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
const repository = await import('../src/platform/storage/repository.ts');
import { registerSharedRepositoryAdapter } from '../src/platform/storage/shared-repository-adapter.ts';
import { addDays, localDateFromDate } from '../src/domain/scheduling/local-date.ts';
import { orderDateTasks, selectDateTasks } from '../src/domain/scheduling/date-tasks.ts';
import { dateTaskRevision } from '../src/domain/scheduling/date-task-reference.ts';
import { projectV2PrivateTasks, privateOverlayForViewer } from '../src/features/sharing/v2-ui/private-overlay.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';

const today = localDateFromDate(new Date()); const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const range = { from: addDays(today, -14), through: addDays(today, 14) };
const preferences = { ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 3 } } };

test('private overlay follows the existing personal selectors including legacy completions, grace days and hidden chores', async () => {
  const f = await privateFixture();
  try {
    const { snapshot } = await repository.readPersonalPlannerOverlaySnapshot(f.database);
    const active = snapshot.chores.find((item) => item.id === f.chore.id); const disabled = { ...active, id: 'disabled', enabled: false };
    const archived = { ...active, id: 'archived', archived: true };
    const entries = Array.from({ length: 16 }, (_, n) => ({ id: `selection-${n}`, householdId: active.householdId, choreId: active.id,
      cycleBaseDate: addDays(today, n - 8), suggestedDate: addDays(today, n - 8), windowStart: addDays(today, n - 10),
      windowEnd: addDays(today, n - 6), status: 'scheduled', assignedMemberIds: [] }));
    const completions = [
      ...entries.filter((_, n) => n % 3 === 0).map((entry, n) => ({ id: `completion-${n}`, householdId: active.householdId, choreId: active.id,
        completedAt: `${addDays(today, n - 7)}T08:00:00Z`, scheduledDate: entry.suggestedDate, scheduledWindowStart: entry.windowStart,
        scheduledWindowEnd: entry.windowEnd, outcome: 'completed', ...(n % 2 ? { scheduleEntryId: entry.id } : {}) })),
      { id: 'old-actual', householdId: active.householdId, choreId: active.id, completedAt: `${today}T01:00:00Z`, completedLocalDate: today, outcome: 'completed' },
      { id: 'undone', householdId: active.householdId, choreId: active.id, completedAt: `${today}T01:01:00Z`, outcome: 'incomplete' },
      { id: 'no-entry', householdId: active.householdId, choreId: active.id, completedAt: `${addDays(today, 6)}T23:55:00Z`, completedLocalDate: addDays(today, 8), outcome: 'completed' },
    ];
    const personal = { ...snapshot, chores: [active, disabled, archived], scheduleEntries: [...entries,
      ...[disabled, archived].map((chore) => ({ ...entries[8], id: chore.id, choreId: chore.id }))], completions };
    const before = JSON.stringify(personal); const projection = projectV2PrivateTasks({ ownerUserId: 'owner', snapshot: personal, today, timeZone }, 'owner', range);
    const expected = (date, grace) => orderDateTasks(selectDateTasks(personal.scheduleEntries, personal.completions, date, grace, personal.chores), date, personal.chores);
    assert.deepEqual(projection.home.map((row) => row.revision), expected(today, 3).map(dateTaskRevision));
    for (let day = range.from; day <= range.through; day = addDays(day, 1)) {
      assert.deepEqual((projection.byDate.get(day) ?? []).map((row) => row.revision), expected(day, 0).map(dateTaskRevision), day);
    }
    assert.equal(JSON.stringify(personal), before); assert.equal(projection.home[0].chore.id, active.id);
  } finally { f.connection.close(); }
});

test('private overlay indexes large unrelated completion history once rather than rescanning it for every calendar cell', async () => {
  const f = await privateFixture();
  try {
    const { snapshot } = await repository.readPersonalPlannerOverlaySnapshot(f.database); let reads = 0;
    const history = Array.from({ length: 12000 }, (_, index) => ({ id: `old-${index}`, householdId: f.chore.householdId,
      get choreId() { reads++; return f.chore.id; }, completedAt: '2001-01-01T08:00:00Z', scheduleEntryId: `past-${index}`, outcome: 'completed' }));
    const projection = projectV2PrivateTasks({ ownerUserId: 'owner', snapshot: { ...snapshot, completions: history }, today, timeZone }, 'owner', range);
    assert.ok(projection.byDate.size > 0); assert.ok(reads < history.length * 4, `history chore lookups: ${reads}`);
    const current = selectDateTasks(snapshot.scheduleEntries, history, today, 3, snapshot.chores);
    assert.deepEqual(projection.home.map((row) => row.revision), orderDateTasks(current, today, snapshot.chores).map(dateTaskRevision));
  } finally { f.connection.close(); }
});

test('private overlay rejects other users and shared snapshots and never shifts a civil date into the group timezone', async () => {
  const f = await privateFixture();
  try {
    const data = { ownerUserId: 'owner', ...await repository.readPersonalPlannerOverlaySnapshot(f.database) };
    assert.throws(() => projectV2PrivateTasks(data, 'another-user', range), /本人/);
    assert.throws(() => projectV2PrivateTasks({ ...data, snapshot: { ...data.snapshot, sharing: { groupId: 'group' } } }, 'owner', range), /本人/);
    assert.throws(() => projectV2PrivateTasks({ ...data, snapshot: { ...data.snapshot, completions: [{ householdId: 'group' }] } }, 'owner', range), /保存先/);
    const original = projectV2PrivateTasks(data, 'owner', range);
    const otherZone = projectV2PrivateTasks({ ...data, timeZone: 'Pacific/Honolulu' }, 'owner', range);
    assert.deepEqual([...otherZone.byDate.keys()], [...original.byDate.keys()]);
    assert.deepEqual(otherZone.home.map((row) => row.date), original.home.map((row) => row.date));
    assert.throws(() => privateOverlayForViewer(original, 'another-user'), /本人以外/);
  } finally { f.connection.close(); }
});

test('personal completion and undo from a composite view persist only in the personal database and its existing Google queue', async () => {
  const f = await privateFixture(); const shared = await sharedFixture(); const d = await shared.device();
  try {
    const initial = seeds(); initial[2].entityId = f.chore.id; initial[3].entityId = f.chore.id;
    await d.repository.commit(initial); const before = JSON.stringify(d.state()); const outbox = await listSharingOutbox(d.database, groupId);
    let projection = await f.read(); let row = projection.home[0]; assert.ok(row);
    const snapshot = (await repository.readPersonalPlannerOverlaySnapshot(f.database)).snapshot;
    const task = selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores)[0];
    await repository.upsertGoogleTaskLink(f.database, { scheduleEntryId: task.entry.id, householdId: f.chore.householdId, choreId: f.chore.id,
      googleTaskListId: 'personal-list', googleTaskId: 'personal-task', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    assert.equal(await f.source.setCompleted(row.key, row.revision, true), true);
    assert.equal(f.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'completed');
    assert.equal((await repository.listGoogleTaskLinks(f.database))[0].pendingStatus, 'completed');
    projection = await f.read(); row = projection.home[0]; assert.equal(row.completed, true);
    assert.equal(projection.counts.get(today) ?? 0, 0);
    assert.equal(await f.source.setCompleted(row.key, row.revision, false), true);
    assert.equal(f.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'incomplete');
    assert.equal((await repository.listGoogleTaskLinks(f.database))[0].pendingStatus, 'needsAction');
    assert.equal(f.changed(), 2); assert.equal(JSON.stringify(d.state()), before);
    assert.deepEqual(await listSharingOutbox(d.database, groupId), outbox);
    assert.equal(d.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
  } finally { f.connection.close(); d.connection.close(); }
});

test('private overlay stale selections, repeated taps and changed access cannot undo a newer completion or invoke shared mutations', async () => {
  const f = await privateFixture();
  try {
    const row = (await f.read()).home[0];
    const results = await Promise.all([f.source.setCompleted(row.key, row.revision, true), f.source.setCompleted(row.key, row.revision, true)]);
    assert.deepEqual(results, [true, false]); assert.equal(f.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 1);
    await assert.rejects(f.source.setCompleted(row.key, row.revision, false), /選び直して/);
    const done = (await f.read()).home[0]; f.stopAccess();
    await assert.rejects(f.source.setCompleted(done.key, done.revision, false), /account changed/);
    assert.equal(f.connection.prepare('SELECT outcome FROM chore_completions').get().outcome, 'completed');
  } finally { f.connection.close(); }
});

test('the personal queue validates a displayed checkbox after concurrent edits and rolls back if access changes before saving', async () => {
  const f = await privateFixture();
  try {
    const row = (await f.read()).home[0]; const command = { date: row.date, graceDays: row.graceDays, choreId: row.chore.id, revision: row.revision, completed: true };
    let checks = 0; const guard = () => { if (++checks === 2) throw new Error('account changed in queue'); };
    await assert.rejects(repository.setPersonalDateTaskCompleted(f.database, command, guard), /account changed/);
    assert.equal(f.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
    await repository.setChoreEnabled(f.database, f.chore.id, false); f.writes.length = 0;
    await assert.rejects(repository.setPersonalDateTaskCompleted(f.database, command, () => {}), /変更/);
    assert.equal(f.writes.length, 0);
    await repository.setChoreEnabled(f.database, f.chore.id, true);
    const snapshot = await repository.loadPlannerSnapshot(f.database);
    const entry = snapshot.scheduleEntries.find((item) => item.choreId === f.chore.id);
    f.connection.prepare('UPDATE chore_schedule_entries SET entry_json = ? WHERE id = ?').run(JSON.stringify({ ...entry, windowEnd: addDays(entry.windowEnd, 1) }), entry.id);
    await assert.rejects(repository.setPersonalDateTaskCompleted(f.database, command, () => {}), /状態が変わって/);
    assert.equal(f.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
  } finally { f.connection.close(); }
});

test('personal overlay readers and writers reject v1 and v2 connections before any initialization or adapter mutation', async () => {
  for (const marker of ['sharing_workspace_metadata', 'sharing_v2_binding', 'adapter']) {
    const f = createDatabase(); let mutations = 0;
    try {
      await repository.initializeLocalDatabase(f.database); let unregister;
      if (marker === 'adapter') unregister = registerSharedRepositoryAdapter(f.database, { groupId: 'other', userId: 'owner', mutate: async () => { mutations++; } });
      else f.connection.exec(`CREATE TABLE ${marker} (marker TEXT)`);
      const before = f.connection.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(); f.writes.length = 0;
      await assert.rejects(repository.readPersonalPlannerOverlaySnapshot(f.database), /個人の保存先/);
      await assert.rejects(repository.setPersonalDateTaskCompleted(f.database, { date: today, graceDays: 0, choreId: 'floor', revision: 'forged', completed: true }, () => {}), /個人の保存先/);
      assert.equal(mutations, 0); assert.equal(f.writes.length, 0);
      assert.deepEqual(f.connection.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(), before); unregister?.();
    } finally { f.connection.close(); }
  }
});

test('same-zone private load changes only the personal recommendation and cannot enter a shared plan or outbox', async () => {
  const f = await privateFixture(); const shared = await sharedFixture(); const d = await shared.device();
  try {
    const initial = seeds(); initial[1].payload.timeZone = timeZone; initial[1].payload.anchorDate = today;
    initial[2].payload.load = 'heavy'; initial[3].payload.configuration.anchorDate = today;
    await d.repository.commit(initial); const controller = createV2GroupController(d.repository, { now: () => new Date(), makeId: () => 'unused', sync: async () => {} });
    const input = { controller, groupId, userId: 'owner', now: () => new Date(), readPreferences: () => preferences };
    const base = await createV2ScreenSession(input).readModel(); const before = await listSharingOutbox(d.database, input.groupId);
    const combined = await createV2ScreenSession({ ...input, privateTasks: f.source }).readModel();
    assert.deepEqual(combined.plan, base.plan); assert.equal(combined.plan.planHash, base.plan.planHash);
    const baseDay = base.personal.recommendations.find((entry) => entry.date === today); assert.ok(baseDay);
    assert.notEqual(combined.personal.recommendations.find((entry) => entry.subjectOccurrenceId === baseDay.subjectOccurrenceId).date, today);
    assert.equal(JSON.stringify(combined.plan).includes(f.chore.name), false);
    assert.deepEqual(await listSharingOutbox(d.database, input.groupId), before);
    const unavailable = await createV2ScreenSession({ ...input, privateTasks: { read: async () => { throw new Error('private failure'); } } }).readModel();
    assert.equal(unavailable.privateOverlay.status, 'unavailable'); assert.deepEqual(unavailable.plan, base.plan);
    const { AdaptiveOwnerInputsChangedError } = await import('../src/platform/storage/adaptive-owner-inputs.ts');
    await assert.rejects(createV2ScreenSession({ ...input, privateTasks: { read: async () => { throw new AdaptiveOwnerInputsChangedError(); } } }).readModel(),
      AdaptiveOwnerInputsChangedError, 'an unsettled owner capture must not publish a misleading shared-only model');
  } finally { f.connection.close(); d.connection.close(); }
});
