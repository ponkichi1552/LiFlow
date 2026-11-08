import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const { createPersonalChoreDefinitions } = await import('../src/domain/chores/personal-catalog.ts');
const { readAdaptivePersonalInside } = await import('../src/platform/storage/adaptive-personal-chores.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');
const { createCalendarQueryRange, aggregateBusyMinutes, getDeviceTimeZone } = await import('../src/features/google-sync/calendar-availability.ts');
const { selectDateTasks } = await import('../src/domain/scheduling/date-tasks.ts');
const { projectV2PrivateTasks } = await import('../src/features/sharing/v2-ui/private-overlay.ts');
const { connectPersonalGoogleCalendar, updatePersonalGoogleCalendarStatus } = await import('../src/platform/storage/personal-google-calendar.ts');
const { saveCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
const { newEventDraft } = await import('../src/domain/calendar/events.ts');
const house = repository.LOCAL_HOUSEHOLD_ID;

async function fixture(t, select = values => values.slice(0, 8), initialDay = '2026-11-01', restDays = [1, 2, 3, 4, 5, 6, 7]) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${initialDay}T01:00:00Z`) });
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const definitions = select(createPersonalChoreDefinitions(house)).map(chore => ({ ...chore, enabled: true }));
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays,
    enabledChoreIds: definitions.map(chore => chore.id), previousDates: {}, weatherLocation: null });
  const snapshot = () => repository.loadPlannerSnapshot(h.database);
  const clock = day => t.mock.timers.setTime(Date.parse(`${day}T01:00:00Z`));
  return { ...h, definitions, snapshot, clock };
}

test('actual personal repository generates new-catalog rounds through the adaptive adapter without the legacy repeated schedule or fake completion history', async t => {
  const h = await fixture(t); const snapshot = await h.snapshot();
  assert.equal(snapshot.scheduleEntries.length, 8); assert.equal(snapshot.completions.length, 0);
  assert.ok(snapshot.scheduleEntries.every(row => row.id.startsWith('personal-round.')));
  assert.equal(new Set(snapshot.scheduleEntries.map(row => row.choreId)).size, 8);
  h.writes.length = 0; await h.snapshot();
  assert.equal(h.writes.length, 0, 'a display read must not write the same adaptive model/plan again');
  const ids = snapshot.scheduleEntries.map(row => row.id);
  h.clock('2027-11-01'); const overdue = await h.snapshot();
  assert.deepEqual(overdue.scheduleEntries.map(row => row.id), ids); assert.ok(overdue.scheduleEntries.every(row => row.status === 'overdue'));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_actions').get().n, 0);
  assert.equal(selectDateTasks(overdue.scheduleEntries, overdue.completions, '2027-11-01', 3, overdue.chores, true).length, 8);
  assert.equal(selectDateTasks(overdue.scheduleEntries, overdue.completions, '2027-11-01', 0, overdue.chores).length, 0, 'calendar recommendations do not multiply expired work over future dates');
});

test('actual two-week personal backlog retains its first missed round and frozen window after a month without treating missed slots as completed', async t => {
  const h = await fixture(t, values => [values.find(chore => chore.frequencyDaysByMode.balanced === 14)]);
  const first = (await h.snapshot()).scheduleEntries[0]; assert.ok(first);
  h.clock(first.suggestedDate); await repository.completeChoreWithReceipt(h.database, first);
  const oldest = (await h.snapshot()).scheduleEntries[0]; const performed = addDays(first.suggestedDate, 30);
  h.clock(performed); const late = (await h.snapshot()).scheduleEntries;
  assert.equal(late.length, 1); assert.equal(late[0].id, oldest.id); assert.equal(late[0].windowEnd, oldest.windowEnd);
  const receipt = await repository.completeChoreWithReceipt(h.database, late[0]);
  const record = h.connection.prepare('SELECT scheduled_window_end,completed_local_date FROM chore_completions WHERE schedule_entry_id=?').get(oldest.id);
  assert.equal(record.scheduled_window_end, oldest.windowEnd); assert.equal(record.completed_local_date, performed);
  const state = (await readAdaptivePersonalInside(h.database, oldest.choreId)).state;
  assert.equal(state.validIntervalCount, 1); assert.equal(state.model.days, 14);
  assert.equal(h.connection.prepare("SELECT count(*) n FROM chore_completions WHERE outcome='completed'").get().n, 2);
  await repository.undoCompletionReceipt(h.database, receipt);
  assert.equal((await h.snapshot()).scheduleEntries[0].id, oldest.id);
  assert.equal((await readAdaptivePersonalInside(h.database, oldest.choreId)).state.validIntervalCount, 0);
});

test('actual repository completion immediately publishes one next adaptive round and an exact Undo restores the old round while keeping a later fixed interval', async t => {
  const h = await fixture(t, values => [values[0]]); const before = await h.snapshot(); const entry = before.scheduleEntries[0];
  h.clock(entry.suggestedDate);
  const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt.adaptiveOperationId);
  const saved = h.connection.prepare('SELECT * FROM chore_schedule_entries').all(); assert.equal(saved.length, 1); assert.notEqual(saved[0].id, entry.id);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 0, 'the new model has one authoritative event ledger');
  await repository.updateChoreSettings(h.database, entry.choreId, { cycleDays: 4000 });
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
  const view = await readAdaptivePersonalInside(h.database, entry.choreId);
  assert.equal(view.state.policy.fixedDays, 4000); assert.equal(view.state.model.days, 4000); assert.equal(view.state.lastPlanCompletion, null);
  assert.equal(h.connection.prepare('SELECT id FROM chore_schedule_entries').get().id, entry.id);
  const redoEntry = (await h.snapshot()).scheduleEntries[0];
  const redo = await repository.completeChoreWithReceipt(h.database, redoEntry); assert.ok(redo);
  assert.notEqual(redo.adaptiveOperationId, receipt.adaptiveOperationId);
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), false, 'same-clock stale Undo cannot cancel a later redo');
});

test('initial completion and Undo restore the exact published date and window without moving any other chore', async t => {
  const h = await fixture(t, values => values.slice(0, 8), '2026-11-07', [6, 7]); const initial = await h.snapshot();
  assert.ok(initial.scheduleEntries.some(entry => entry.suggestedDate !== entry.cycleBaseDate), 'exercise a distributed initial recommendation');
  for (const original of initial.scheduleEntries) {
    h.clock(original.suggestedDate);
    for (let repeat = 0; repeat < 3; repeat++) {
      const before = await h.snapshot(); const entry = before.scheduleEntries.find(row => row.choreId === original.choreId);
      const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt);
      const completed = await h.snapshot();
      assert.deepEqual(completed.scheduleEntries.filter(row => row.choreId !== entry.choreId), before.scheduleEntries.filter(row => row.choreId !== entry.choreId));
      assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
      const restored = await h.snapshot();
      assert.deepEqual(restored.scheduleEntries, before.scheduleEntries, `${entry.choreId} Undo ${repeat + 1} restores the displayed round exactly`);
      const visible = selectDateTasks(restored.scheduleEntries, restored.completions, original.suggestedDate, 3, restored.chores, true);
      assert.equal(visible.filter(row => row.choreId === original.choreId).length, 1);
      assert.equal(visible.find(row => row.choreId === original.choreId).completed, false);
    }
  }
});

test('the schema upgrade restores a provable legacy Undo placement while preserving history and later deliberate replanning',async t=>{
  const h=await fixture(t,values=>values.slice(0,8),'2026-11-07',[6,7]);const snapshot=await h.snapshot();const entry=snapshot.scheduleEntries.find(row=>row.suggestedDate!==row.cycleBaseDate);assert.ok(entry);
  const original=await readAdaptivePersonalInside(h.database,entry.choreId);h.clock(entry.suggestedDate);
  const receipt=await repository.completeChoreWithReceipt(h.database,entry);await repository.undoCompletionReceipt(h.database,receipt);
  const complete=h.connection.prepare('SELECT * FROM personal_adaptive_actions WHERE operation_id=?').get(receipt.adaptiveOperationId);
  const value=JSON.parse(complete.event_json);delete value.planRevision;h.connection.prepare('UPDATE personal_adaptive_actions SET event_json=? WHERE operation_id=?').run(JSON.stringify(value),complete.operation_id);
  const undo=h.connection.prepare("SELECT * FROM personal_adaptive_actions WHERE chore_id=? AND action_type='undo' ORDER BY sequence DESC LIMIT 1").get(entry.choreId);
  const badRevision='a'.repeat(64);const planRow=h.connection.prepare('SELECT * FROM personal_adaptive_plans WHERE round_id=? AND revision=?').get(entry.id,original.planRevision);
  h.connection.prepare('INSERT INTO personal_adaptive_plans VALUES(?,?,?,?,?,?)').run(entry.id,badRevision,entry.choreId,JSON.stringify({...original.plan,recommendedDate:entry.cycleBaseDate}),planRow.input_revision,JSON.parse(undo.event_json).recordedAt);
  h.connection.prepare('UPDATE personal_adaptive_state SET plan_revision=? WHERE chore_id=?').run(badRevision,entry.choreId);
  const actions=h.connection.prepare('SELECT * FROM personal_adaptive_actions ORDER BY sequence').all();const completions=h.connection.prepare('SELECT * FROM chore_completions').all();
  h.connection.exec('PRAGMA user_version=27');const {migrateLocalDatabase}=await import('../src/platform/storage/migrations.ts');await migrateLocalDatabase(h.database);
  assert.deepEqual((await readAdaptivePersonalInside(h.database,entry.choreId)).plan,original.plan);
  assert.deepEqual(h.connection.prepare('SELECT * FROM personal_adaptive_actions ORDER BY sequence').all(),actions);assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions').all(),completions);
  h.connection.prepare('UPDATE personal_adaptive_plans SET published_at=? WHERE revision=?').run('2027-11-08T00:00:00.000Z',badRevision);
  h.connection.prepare('UPDATE personal_adaptive_state SET plan_revision=? WHERE chore_id=?').run(badRevision,entry.choreId);h.connection.exec('PRAGMA user_version=27');await migrateLocalDatabase(h.database);
  assert.equal((await readAdaptivePersonalInside(h.database,entry.choreId)).planRevision,badRevision,'a later replan is outside the legacy repair proof');
});

test('actual repository learns a long outside-window pace without treating late screen reads as training observations', async t => {
  const h = await fixture(t, values => [values[1]]);
  let entry = (await h.snapshot()).scheduleEntries[0]; let date = entry.suggestedDate;
  for (let i = 0; i < 5; i++) {
    h.clock(date); const current = (await h.snapshot()).scheduleEntries[0];
    assert.ok(await repository.completeChoreWithReceipt(h.database, current));
    date = addDays(date, 60);
  }
  const view = await readAdaptivePersonalInside(h.database, entry.choreId);
  assert.equal(view.state.model.days, 60); assert.equal(view.state.validIntervalCount, 4);
  assert.equal(view.plan.originalBaseDate, addDays(view.state.lastPlanCompletion.date, 60));
  const definition = h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(entry.choreId);
  assert.equal(JSON.parse(definition.definition_json).recommendedCycleDays, undefined, 'learning is not a user fixed override');
  const model = view.state.model; h.clock(addDays(date, 365)); await h.snapshot();
  assert.deepEqual((await readAdaptivePersonalInside(h.database, entry.choreId)).state.model, model);
  const snapshot = await h.snapshot(); assert.equal(snapshot.personalCadences[entry.choreId].days, 60);
  assert.equal(snapshot.personalCadences[entry.choreId].label, '60日ごと');
  const { createChoreSettingsEditor } = await import('../src/features/settings/chore-settings-editor.ts');
  const patches = []; const editor = createChoreSettingsEditor(snapshot.chores.find(chore => chore.id === entry.choreId), snapshot.settings.frequencyMode,
    async patch => { patches.push(patch); }, snapshot.personalCadences[entry.choreId]);
  assert.equal(editor.getSnapshot().draft.cycleText, '60'); assert.equal(editor.getSnapshot().draft.radiusText, '5');
  await editor.flush(); assert.equal(patches.length, 0, 'viewing a learned cadence cannot pin it as a user fixed interval');
});

test('actual repository rollbacks completion history model next-round cache and Google pending status together on a write failure', async t => {
  const h = await fixture(t, values => [values[0]]); const entry = (await h.snapshot()).scheduleEntries[0]; h.clock(entry.suggestedDate);
  const before = h.connection.serialize(); const run = h.database.runAsync;
  h.database.runAsync = async (sql, ...parameters) => {
    if (sql.startsWith('INSERT INTO chore_completions')) throw new Error('injected disk error');
    return run(sql, ...parameters);
  };
  await assert.rejects(repository.completeChoreWithReceipt(h.database, entry), /disk error/);
  assert.deepEqual(h.connection.serialize(), before);
  h.database.runAsync = run; assert.ok(await repository.completeChoreWithReceipt(h.database, entry));
  assert.equal(h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='complete'").get().n, 1);
});

test('actual individual activation and mode edits are saved as ordered adaptive events without waiting for another screen', async t => {
  const h = await fixture(t, values => [values[0]]); const chore = h.definitions[0]; await h.snapshot();
  await repository.setChoreEnabled(h.database, chore.id, false);
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.enabled, false);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_schedule_entries').get().n, 0);
  await repository.setChoreEnabled(h.database, chore.id, true);
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.enabled, true);
  await repository.updatePlannerSettings(h.database, { frequencyMode: 'relaxed', restDays: [], heavyDailyLimit: 1, normalDailyLimit: 2 });
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.mode, 'relaxed');
  assert.ok(h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='settings'").get().n >= 3);
});

for (const [mode, name] of [
  ['frequent', 'new-catalog unknown activation and explicit period edits retain one durable round across reload and midnight (frequent)'],
  ['balanced', 'new-catalog unknown activation and explicit period edits retain one durable round across reload and midnight (balanced)'],
  ['relaxed', 'new-catalog unknown activation and explicit period edits retain one durable round across reload and midnight (relaxed)'],
]) test(name, async t => {
  const h = await fixture(t, () => []);
  await repository.updatePlannerSettings(h.database, { frequencyMode: mode, restDays: [1, 2, 3, 4, 5, 6, 7], heavyDailyLimit: 2, normalDailyLimit: 3 });
  const definitions = createPersonalChoreDefinitions(house).filter(chore => Number.isSafeInteger(chore.frequencyDaysByMode[mode]));
  assert.ok(definitions.length > 8, 'exercise the optional catalogue too, not just the initial defaults');
  let previous; let day = '2026-11-01';
  for (const chore of definitions) {
    if (previous) await repository.setChoreEnabled(h.database, previous, false);
    await repository.setChoreEnabled(h.database, chore.id, true);
    let snapshot = await h.snapshot(); let rows = snapshot.scheduleEntries.filter(row => row.choreId === chore.id);
    assert.equal(rows.length, 1, chore.name); assert.ok(rows[0].id.startsWith('personal-round.'));
    assert.equal(snapshot.completions.length, 0, 'unknown activation cannot invent training history');
    await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 17 });
    snapshot = await h.snapshot(); rows = snapshot.scheduleEntries.filter(row => row.choreId === chore.id);
    assert.equal(rows.length, 1, chore.name);
    assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.fixedDays, 17);
    const original = structuredClone(rows[0]);
    assert.deepEqual((await h.snapshot()).scheduleEntries.filter(row => row.choreId === chore.id), [original]);
    day = addDays(day, 1); h.clock(day);
    const afterMidnight = (await h.snapshot()).scheduleEntries.filter(row => row.choreId === chore.id);
    assert.equal(afterMidnight.length, 1); assert.equal(afterMidnight[0].id, original.id);
    assert.equal(afterMidnight[0].cycleBaseDate, original.cycleBaseDate);
    previous = chore.id;
  }
});

test('actual first adaptive rounds are Google-sync eligible and completion Undo retains the mapped task and durable pending status', async t => {
  const h = await fixture(t, values => [values[0]]); const snapshot = await h.snapshot(); const entry = snapshot.scheduleEntries[0];
  const before = await repository.listEntriesForGoogleSync(h.database, '2026-11-01'); assert.ok(before.some(row => row.entry.id === entry.id));
  const now = new Date().toISOString();
  await repository.upsertGoogleTaskLink(h.database, { scheduleEntryId: entry.id, householdId: house, choreId: entry.choreId,
    googleTaskListId: 'fixture-list', googleTaskId: 'fixture-task', lastSyncedStatus: 'needsAction', createdAt: now, updatedAt: now });
  h.clock(entry.suggestedDate); const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt);
  let link = (await repository.listGoogleTaskLinks(h.database)).find(row => row.scheduleEntryId === entry.id);
  assert.equal(link.pendingStatus, 'completed'); assert.equal(link.googleTaskId, 'fixture-task');
  assert.ok((await repository.listEntriesForGoogleSync(h.database, entry.suggestedDate)).find(row => row.entry.id === entry.id)?.completedAt);
  await repository.undoCompletionReceipt(h.database, receipt);
  link = (await repository.listGoogleTaskLinks(h.database)).find(row => row.scheduleEntryId === entry.id);
  assert.equal(link.pendingStatus, 'needsAction'); assert.equal(link.googleTaskId, 'fixture-task');
});

test('an aggregate-only FreeBusy day cannot be turned into an invented continuous free slot by the actual adaptive repository context', async t => {
  const h = await fixture(t, values => [values[0]]);
  const date = '2026-11-05'; const now = new Date(); const timeZone = getDeviceTimeZone();
  const range = createCalendarQueryRange('2026-11-01', addDays('2026-11-01', 180), timeZone);
  const days = aggregateBusyMinutes([], range, now.toISOString()).map(day => ({ ...day, busyMinutes: day.localDate === date ? 60 : 0 }));
  await repository.setCalendarAvailabilityEnabled(h.database, true, now);
  await repository.replaceCalendarAvailabilityDays(h.database, days);
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: house, memberId: repository.LOCAL_MEMBER_ID, now, timeZone });
  const geometry = context.prepareGeometry(); const day = geometry.days.find(day => day.date === date);
  assert.ok(geometry.busy.some(span => span.start <= day.bounds.start && span.end >= day.bounds.end));
  assert.ok(!geometry.busy.some(span => span.start === day.allowed[0].start && span.end === day.allowed[0].start + 60 * 60000), 'a daily total has no known starting hour');
});

test('unchanged fresh Google coverage refreshes do not invalidate adaptive placement while actual freshness expiry does', async t => {
  const h = await fixture(t, values => [values[0]]); const now = new Date(); const zone = getDeviceTimeZone(); const from = '2026-11-01';
  const range = createCalendarQueryRange(from, addDays(from, 180), zone);
  await repository.setCalendarAvailabilityEnabled(h.database, true, now);
  await repository.replaceCalendarAvailabilityDays(h.database, aggregateBusyMinutes([], range, now.toISOString()));
  const read = instant => readPersonalAdaptiveContextInside(h.database, { householdId: house, memberId: repository.LOCAL_MEMBER_ID, now: instant, timeZone: zone });
  const first = await read(now);
  h.connection.prepare('UPDATE calendar_availability_days SET fetched_at=?').run(new Date(now.getTime() - 60_000).toISOString());
  assert.equal((await read(now)).sourceRevision, first.sourceRevision);
  assert.notEqual((await read(new Date(now.getTime() + 37 * 3600_000))).sourceRevision, first.sourceRevision);
});

test('a complete account-bound Calendar mirror uses real interval union while unfinished pages or requested-only ranges never grant free time', async t => {
  const h = await fixture(t, values => [values[0]]); const now = new Date(); const zone = 'Asia/Tokyo'; const date = '2026-11-05';
  const range = createCalendarQueryRange('2026-11-01', addDays('2026-11-01', 180), zone);
  await repository.setCalendarAvailabilityEnabled(h.database, true, now);
  await repository.saveGoogleSyncState(h.database, { householdId: house, enabled: false, accountSubject: 'same-google-account',
    status: 'idle', retryCount: 0, updatedAt: now.toISOString() });
  await repository.replaceCalendarAvailabilityDays(h.database, aggregateBusyMinutes([], range, now.toISOString())
    .map(day => ({ ...day, busyMinutes: day.localDate === date ? 90 : 0 })));
  for (const [name, startMinute, endMinute] of [['本人', 600, 660], ['Google', 630, 720], ['同期コピー', 630, 720]]) {
    await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft(date, zone), title: name, startMinute, endMinute } });
  }
  const control = await connectPersonalGoogleCalendar(h.database, 0, 'same-google-account', [{ id: 'primary', summary: '本人', accessRole: 'owner', primary: true }], 'primary');
  await updatePersonalGoogleCalendarStatus(h.database, control, { lastSyncAt: now.toISOString() });
  h.connection.prepare('INSERT INTO calendar_google_cursors(subject,calendar_id,sync_token) VALUES(?,?,?)').run('same-google-account', 'primary', 'finished-token');
  const read = async () => (await readPersonalAdaptiveContextInside(h.database, { householdId: house,
    memberId: repository.LOCAL_MEMBER_ID, now, timeZone: zone })).prepareGeometry();
  const real = await read(); const day = real.days.find(row => row.date === date);
  const otherDay = real.days.find(row => row.date === '2026-11-06');
  const busy = real.busy.filter(span => span.start < day.bounds.end && span.end > day.bounds.start);
  assert.equal(busy.length, 1); assert.equal(busy[0].end - busy[0].start, 120 * 60_000);
  const original = h.connection.prepare('SELECT control_json FROM calendar_google_control').get().control_json;
  const cases = [
    { name: 'paged', sql: "UPDATE calendar_google_cursors SET page_token='next'", cleanup: 'UPDATE calendar_google_cursors SET page_token=NULL' },
    { name: 'unreviewed', sql: `INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty) VALUES('same-google-account','primary','unreviewed','{}',1)`, cleanup: 'DELETE FROM calendar_google_inbox' },
    { name: 'remaining calendars', sql: `INSERT INTO calendar_google_progress VALUES('same-google-account','["primary"]')`, cleanup: 'DELETE FROM calendar_google_progress' },
    { name: 'unfinished expansion', sql: `INSERT INTO calendar_google_expansion(subject,calendar_id,parent_id,page_token,range_json,active) VALUES('same-google-account','primary','series',NULL,'{"timeMin":"2026-01-01T00:00:00Z","timeMax":"2028-01-01T00:00:00Z"}',1)`, cleanup: 'DELETE FROM calendar_google_expansion' },
    { name: 'short expansion', sql: `INSERT INTO calendar_google_expansion(subject,calendar_id,parent_id,page_token,range_json,active) VALUES('same-google-account','primary','series',NULL,'{"timeMin":"2026-11-01T00:00:00Z","timeMax":"2026-11-03T00:00:00Z"}',0)`, cleanup: 'DELETE FROM calendar_google_expansion' },
    { name: 'new unread calendar', control: { ...JSON.parse(original), calendars: [...JSON.parse(original).calendars, { id: 'unread', summary: '未取得', accessRole: 'reader' }] } },
    { name: 'different account', control: { ...JSON.parse(original), subject: 'another-google-account' } },
    { name: 'stale mirror', control: { ...JSON.parse(original), lastSyncAt: '2026-10-01T00:00:00Z' } },
    { name: 'initial mirror still loading', control: { ...JSON.parse(original), lastSyncAt: null } },
  ];
  for (const value of cases) {
    if (value.sql) h.connection.exec(value.sql);
    if (value.control) h.connection.prepare('UPDATE calendar_google_control SET control_json=?').run(JSON.stringify(value.control));
    const opaque = await read(); assert.ok(opaque.busy.some(span => span.start <= day.bounds.start && span.end >= day.bounds.end), value.name);
    assert.ok(opaque.busy.some(span => span.start <= otherDay.bounds.start && span.end >= otherDay.bounds.end), `${value.name}: primary-only FreeBusy zero cannot grant free time from an unfinished multi-calendar import`);
    if (value.cleanup) h.connection.exec(value.cleanup);
    h.connection.prepare('UPDATE calendar_google_control SET control_json=?').run(original);
  }
  h.connection.exec('DELETE FROM calendar_google_cursors');
  h.connection.prepare('INSERT INTO calendar_google_requested_ranges VALUES(?,?)').run('same-google-account', JSON.stringify({ timeMin: range.timeMin, timeMax: range.timeMax }));
  const requested = await read(); assert.ok(requested.busy.some(span => span.start <= day.bounds.start && span.end >= day.bounds.end));
});

test('actual seasonal repository completion and Undo keep spring and autumn independent and never enter normal cycle learning', async t => {
  const h = await fixture(t, values => [values.find(chore => chore.personalSchedulingKind === 'seasonal')], '2026-01-01');
  let snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries.length, 2);
  const spring = snapshot.scheduleEntries.find(entry => entry.seasonalWork === 'winterStorage');
  const autumn = snapshot.scheduleEntries.find(entry => entry.seasonalWork === 'summerStorage');
  h.clock('2026-08-01'); const receipt = await repository.completeChoreWithReceipt(h.database, spring);
  assert.equal(receipt.seasonalWork, 'winterStorage'); assert.ok(receipt.adaptiveOperationId);
  snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries.find(entry => entry.seasonalWork === 'winterStorage').suggestedDate, '2027-05-15');
  assert.equal(snapshot.scheduleEntries.find(entry => entry.seasonalWork === 'summerStorage').id, autumn.id);
  assert.equal(await readAdaptivePersonalInside(h.database, spring.choreId), null);
  h.clock('2026-10-15'); const autumnReceipt = await repository.completeChoreWithReceipt(h.database, autumn); assert.ok(autumnReceipt);
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
  snapshot = await h.snapshot(); assert.equal(snapshot.scheduleEntries.find(entry => entry.seasonalWork === 'winterStorage').id, spring.id);
  assert.equal(snapshot.scheduleEntries.find(entry => entry.seasonalWork === 'summerStorage').suggestedDate, '2027-10-15');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_forecasts').get().n, 0);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 0);
});

test('a generic shared seasonal title cannot implicitly complete either personal storage meaning', async t => {
  const h = await fixture(t, values => [values.find(chore => chore.personalSchedulingKind === 'seasonal')], '2026-01-01');
  const before = await h.snapshot(); const chore = h.definitions[0];
  const shared = { ...chore, id: 'group-seasonal', personalRecipeId: undefined, personalSchedulingKind: undefined };
  const result = await repository.mirrorSharedChoreCompletions(h.database, { groupId: 'group', chores: [shared], completions: [{
    id: 'shared-seasonal-done', householdId: house, choreId: shared.id, completedAt: '2026-05-15T01:00:00Z', outcome: 'completed',
    source: 'inApp', scheduleEntryId: 'group-seasonal-round', scheduledDate: '2026-05-15',
  }] }, () => {});
  assert.equal(result, 0);
  const after = await h.snapshot(); assert.deepEqual(after.scheduleEntries, before.scheduleEntries);
  assert.equal(after.completions.length, 0);
});

test('shared-mode personal overlay retains both overdue seasonal meanings with separate command keys and can complete the explicitly selected one', async t => {
  const h = await fixture(t, values => [values.find(chore => chore.personalSchedulingKind === 'seasonal')], '2026-01-01');
  h.clock('2026-11-01'); const snapshot = await h.snapshot();
  const overlay = projectV2PrivateTasks({ ownerUserId: 'owner', today: '2026-11-01', timeZone: getDeviceTimeZone(), snapshot }, 'owner',
    { from: '2026-11-01', through: '2026-11-01' });
  assert.equal(overlay.home.length, 2); assert.equal(new Set(overlay.home.map(row => row.key)).size, 2);
  const autumn = overlay.home.find(row => row.seasonalWork === 'summerStorage'); assert.ok(autumn);
  assert.equal(await repository.setPersonalDateTaskCompleted(h.database, { choreId: autumn.chore.id, date: autumn.date,
    graceDays: autumn.graceDays, revision: autumn.revision, completed: true }, () => {}), true);
  const next = await h.snapshot();
  assert.equal(next.scheduleEntries.find(entry => entry.seasonalWork === 'winterStorage').suggestedDate, '2026-05-15');
  assert.equal(next.scheduleEntries.find(entry => entry.seasonalWork === 'summerStorage').suggestedDate, '2027-10-15');
});

test('actual individual split activation replaces its aggregate without losing original settings history or activating unselected sibling work', async t => {
  const h = await fixture(t, values => [values.find(chore => chore.name === '衣類・タオルの洗濯')]);
  const parent = h.definitions[0]; const before = await h.snapshot(); const entry = before.scheduleEntries[0];
  h.clock(entry.suggestedDate); const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt);
  await repository.updateChoreSettings(h.database, parent.id, { cycleDays: 50 });
  const child = createPersonalChoreDefinitions(house).find(chore => chore.name === 'タオルだけの洗濯');
  await repository.setChoreEnabled(h.database, child.id, true);
  let snapshot = await h.snapshot();
  assert.equal(snapshot.chores.find(chore => chore.id === parent.id).enabled, false);
  assert.equal(snapshot.chores.find(chore => chore.id === parent.id).recommendedCycleDays, 50);
  assert.equal(snapshot.completions.find(row => row.choreId === parent.id).adaptiveOperationId, receipt.adaptiveOperationId);
  assert.ok(snapshot.scheduleEntries.every(row => row.choreId === child.id));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_state').get().n, 2);
  const prior = h.connection.serialize();
  await assert.rejects(repository.setChoresEnabled(h.database, [child.id, parent.id], true), /どちらか一方/u);
  assert.deepEqual(h.connection.serialize(), prior, 'an invalid bulk selection has no partial enabled, model or cache writes');
  await repository.updateChoreSettings(h.database, parent.id, { enabled: true });
  snapshot = await h.snapshot();
  assert.equal(snapshot.chores.find(chore => chore.id === child.id).enabled, false);
  assert.equal(snapshot.chores.find(chore => chore.id === parent.id).recommendedCycleDays, 50);
  assert.ok(snapshot.scheduleEntries.every(row => row.choreId === parent.id));
});

for (const minutes of [20, undefined]) test(`actual appliance rounds learn beyond their manufacturer starting period with ${minutes === undefined ? 'unknown' : 'documented'} working time and retain an ordered reanalysis boundary`, async t => {
  const h = await fixture(t, () => [], '2026-01-01');
  const product = { manufacturer: 'QA', productName: '清掃機', modelNumber: 'MODEL-A', manualUrl: 'uploaded-manual:fixture' };
  const task = { name: 'フィルター清掃', recommendedIntervalDays: 14, steps: ['電源を切って清掃する'], tools: ['布'], safetyCautions: ['完全に乾かす'], evidence: [],
    ...(minutes === undefined ? {} : { estimatedMinutes: minutes }) };
  const analysis = tasks => ({ manufacturer: 'QA', model: 'MODEL-A', tasks, analyzedAt: new Date().toISOString(), requiresUserReview: true });
  const result = await repository.saveReviewedApplianceCare(h.database, product, analysis([task]), [{ task }]);
  let snapshot = await h.snapshot(); const chore = snapshot.chores.find(chore => chore.applianceId === result.applianceId); assert.ok(chore);
  let date = snapshot.scheduleEntries.find(entry => entry.choreId === chore.id).suggestedDate; let receipt;
  for (let i = 0; i < 5; i++) {
    h.clock(date); snapshot = await h.snapshot(); const round = snapshot.scheduleEntries.find(entry => entry.choreId === chore.id);
    receipt = await repository.completeChoreWithReceipt(h.database, round); assert.ok(receipt);
    date = addDays(date, 60);
  }
  let view = await readAdaptivePersonalInside(h.database, chore.id);
  assert.equal(view.state.model.days, 60); assert.equal(view.state.validIntervalCount, 4);
  assert.equal((await h.snapshot()).personalCadences[chore.id].days, 60);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM chore_completion_actions').get().n, 0);
  if (minutes === undefined) {
    assert.equal(view.plan.slot, null); assert.equal(JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(chore.id).definition_json).estimatedMinutes, undefined);
  }
  const revised = { ...task, recommendedIntervalDays: 21 };
  await repository.saveReviewedApplianceCare(h.database, { ...product, applianceId: result.applianceId }, analysis([revised]), [{ task: revised }]);
  view = await readAdaptivePersonalInside(h.database, chore.id);
  assert.equal(view.state.policy.initialDays.balanced, 21); assert.equal(view.state.model.days, 21);
  assert.equal(view.state.validIntervalCount, 0, 'a new manufacturer starting value cannot rewrite old normalized learning inputs');
  assert.equal(await repository.undoCompletionReceipt(h.database, receipt), true);
  view = await readAdaptivePersonalInside(h.database, chore.id);
  assert.equal(view.state.policy.initialDays.balanced, 21); assert.equal(view.state.model.days, 21);
  await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 10_000 });
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.model.days, 10_000);
  await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 21 });
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.fixedDays, 21, 'an explicit fixed period remains fixed even if equal to the manufacturer default');
  await repository.updateChoreSettings(h.database, chore.id, { cycleDays: null });
  assert.equal((await readAdaptivePersonalInside(h.database, chore.id)).state.policy.fixedDays, null);
});

test('actual private appliance reset stops nonperiodic forecasts and retains original completions while a new explicit period starts a new learning epoch', async t => {
  const h = await fixture(t, () => [], '2026-01-01');
  const task = { name: '必要なときの清掃', recommendedConditions: ['汚れが気になるとき'], steps: ['清掃する'], tools: ['布'], safetyCautions: [], evidence: [], estimatedMinutes: 10 };
  const result = await repository.saveReviewedApplianceCare(h.database,
    { manufacturer: 'QA', productName: '清掃機', modelNumber: 'CONDITION', manualUrl: 'uploaded-manual:fixture' },
    { manufacturer: 'QA', model: 'CONDITION', tasks: [task], analyzedAt: new Date().toISOString(), requiresUserReview: true }, [{ task, userIntervalDays: 7 }]);
  let snapshot = await h.snapshot(); const chore = snapshot.chores.find(chore => chore.applianceId === result.applianceId);
  let entry = snapshot.scheduleEntries.find(entry => entry.choreId === chore.id); h.clock(entry.suggestedDate);
  const receipt = await repository.completeChoreWithReceipt(h.database, entry); assert.ok(receipt);
  const history = h.connection.prepare('SELECT * FROM chore_completions WHERE chore_id=?').all(chore.id);
  for (const patch of [{ resetSchedule: true }, { cycleDays: null }]) {
    await repository.updateChoreSettings(h.database, chore.id, patch);
    snapshot = await h.snapshot(); const saved = snapshot.chores.find(row => row.id === chore.id);
    assert.equal(saved.enabled, true); assert.equal(saved.requiresCycleSelection, false);
    assert.equal(saved.userIntervalDays, undefined); assert.equal(saved.recommendedCycleDays, undefined);
    assert.equal(snapshot.scheduleEntries.some(entry => entry.choreId === chore.id), false);
    let view = await readAdaptivePersonalInside(h.database, chore.id);
    assert.equal(view.state.model, null); assert.equal(view.plan, null);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions WHERE chore_id=?').all(chore.id), history);
    await repository.updateChoreSettings(h.database, chore.id, { cycleDays: 13 });
    view = await readAdaptivePersonalInside(h.database, chore.id);
    assert.equal(view.state.model.days, 13); assert.equal(view.state.validIntervalCount, 0);
    assert.ok((await h.snapshot()).scheduleEntries.some(entry => entry.choreId === chore.id));
  }
});
