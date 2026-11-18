import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { calendarOccurrenceDraft } from '../src/features/calendar/direct-actions.ts';
import { calendarFutureBase, splitCalendarFuture } from '../src/domain/calendar/future-series.ts';
import { fixture, seeds, receiptsFor, groupId, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2CalendarActions } from '../src/features/sharing/v2/calendar-actions.ts';
import { calendarFutureUndoCommand } from '../src/features/sharing/v2/calendar-future-actions.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { projectSharedCalendarRecords } from '../src/features/calendar/shared-events.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const repository = await import('../src/platform/storage/repository.ts');
const storage = await import('../src/platform/storage/calendar-events.ts');
const reminders = await import('../src/platform/storage/calendar-reminders.ts');
const category = { id: 'personal', name: '私用', color: '#348DC2', revision: 1 };
const value = extra => ({ ...newEventDraft('2026-11-01', 'Asia/Tokyo'), title: '定例', recurrence: 'weekly', untilDate: '2026-12-13', ...extra });
const basis = record => JSON.stringify([record.heads.map(row => row.operationId).sort(), record.heads.map(row => row.operationId).sort()]);
const allExceptionIds = record => record.exceptions.flatMap(row => row.heads.map(head => head.operationId)).sort();
const project = snapshot => projectCalendarEvents(snapshot.events, snapshot.exceptions, '2026-11-01', '2026-12-20');
const plain = rows => rows.map(row => ({ date: row.startDate, minute: row.startMinute, title: row.title, location: row.location })).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

test('future recurrence bases use original slots and preserve monthly yearly custom and overnight durations', () => {
  for (const [series, anchor] of [
    [value(), '2026-11-15'],
    [value({ startDate: '2026-01-31', endDate: '2026-02-01', recurrence: 'monthly', untilDate: null }), '2026-03-31'],
    [value({ startDate: '2024-02-29', endDate: '2024-02-29', recurrence: 'yearly', untilDate: null }), '2028-02-29'],
    [value({ recurrence: 'custom', customRecurrence: { unit: 'week', interval: 2, weekdays: [0, 2] } }), '2026-11-17'],
  ]) {
    const original = { ...series, id: 'event', revision: 1 }, base = calendarFutureBase(original, anchor);
    assert.equal(base.startDate, anchor); assert.equal(base.recurrence, original.recurrence);
    const split = splitCalendarFuture(original, anchor, base, []); assert.equal(split.next.startDate, anchor);
    assert.ok(split.past === null || split.past.untilDate < anchor);
  }
  assert.throws(() => calendarFutureBase({ ...value(), id: 'event', revision: 1 }, '2026-11-16'), /選び直して/u);
});

async function localFixture() {
  const h = createDatabase(); await repository.initializeLocalDatabase(h.database);
  const id = await storage.saveCalendarEvent(h.database, { expectedRevision: 0, value: value() });
  for (const [anchorDate, override] of [['2026-11-08', value({ title: '過去の個別変更', startDate: '2026-11-09', endDate: '2026-11-09', recurrence: 'none', untilDate: null })],
    ['2026-11-22', value({ title: '今後の個別変更', startDate: '2026-11-25', endDate: '2026-11-25', recurrence: 'none', untilDate: null })]]) {
    await storage.saveCalendarEvent(h.database, { id, expectedRevision: 1, expectedExceptionRevision: 0, scope: 'one', anchorDate, value: override });
  }
  await storage.deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate: '2026-11-29', expectedExceptionRevision: 0 });
  const snapshot = await storage.readLocalCalendar(h.database), series = snapshot.events.find(row => row.id === id);
  await reminders.saveCalendarReminder(h.database, { scope: 'personal', eventId: id, anchorDate: null, minutes: 60 });
  await reminders.saveCalendarReminder(h.database, { scope: 'personal', eventId: id, anchorDate: '2026-11-22', minutes: 10 });
  return { h, id, snapshot, series, draft: { eventId: id, revision: series.revision, exceptionRevision: 0, anchorDate: '2026-11-15', scope: 'future', value: { ...calendarFutureBase(series, '2026-11-15'), title: '新しい定例', startDate: '2026-11-16', endDate: '2026-11-16' } } };
}
test('personal future changes atomically retain past edits future edits cancellations and private reminders and undo restores them', async t => {
  const f = await localFixture(); t.after(() => f.h.connection.close()); const before = plain(project(f.snapshot));
  const beforeRules = await reminders.readCalendarReminders(f.h.database);
  const receipt = await storage.saveCalendarFutureEvent(f.h.database, f.draft), after = await storage.readLocalCalendar(f.h.database);
  const rows = plain(project(after));
  assert.ok(rows.some(row => row.date === '2026-11-01' && row.title === '定例')); assert.ok(rows.some(row => row.date === '2026-11-09' && row.title === '過去の個別変更'));
  assert.ok(rows.some(row => row.date === '2026-11-16' && row.title === '新しい定例')); assert.ok(rows.some(row => row.date === '2026-11-25' && row.title === '今後の個別変更'));
  assert.equal(rows.filter(row => row.date === '2026-11-25').length, 1); assert.ok(!rows.some(row => row.date === '2026-11-23' || row.date === '2026-11-30'));
  const nextId = after.events.find(row => row.id !== f.id).id, rules = (await reminders.readCalendarReminders(f.h.database)).rules;
  assert.ok(rules.some(row => row.eventId === nextId && row.anchorDate === null && row.minutes === 60));
  assert.ok(rules.some(row => row.eventId === nextId && row.anchorDate === '2026-11-23' && row.minutes === 10));
  await receipt.undoFuture(); await receipt.undoFuture();
  assert.deepEqual(plain(project(await storage.readLocalCalendar(f.h.database))), before); assert.deepEqual(await reminders.readCalendarReminders(f.h.database), beforeRules);
});
test('personal future saves reject stale selected revisions and roll back a partial split without losing source data', async t => {
  const f = await localFixture(); t.after(() => f.h.connection.close()); const before = await storage.readLocalCalendar(f.h.database);
  await assert.rejects(storage.saveCalendarFutureEvent(f.h.database, { ...f.draft, revision: -1 }));
  const originalRun = f.h.database.runAsync;
  f.h.database.runAsync = async (sql, ...values) => { if (sql.startsWith('INSERT INTO calendar_events')) throw new Error('disk full'); return originalRun(sql, ...values); };
  await assert.rejects(storage.saveCalendarFutureEvent(f.h.database, f.draft), /disk full/u); f.h.database.runAsync = originalRun;
  assert.deepEqual(await storage.readLocalCalendar(f.h.database), before);
  const receipt = await storage.saveCalendarFutureEvent(f.h.database, f.draft), after = await storage.readLocalCalendar(f.h.database), next = after.events.find(row => row.id !== f.id);
  await storage.saveCalendarEvent(f.h.database, { id: next.id, expectedRevision: next.revision, value: { ...next, notes: '別の編集' } });
  await assert.rejects(receipt.undoFuture(), /上書きせず/u); assert.ok((await storage.readLocalCalendar(f.h.database)).events.some(row => row.notes === '別の編集'));
});

async function sharedFixture() {
  const f = await fixture(), device = await f.device(); await device.repository.commit(seeds()); let id = 0;
  const actions = createV2CalendarActions(device.repository, () => `future-operation-${++id}`);
  const records = async () => readSharedCalendar((await device.repository.readState()).assessment.view);
  await actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: value(), category }); const eventId = (await records())[0].id;
  for (const [anchorDate, body] of [['2026-11-08', value({ title: '過去の個別変更', startDate: '2026-11-09', endDate: '2026-11-09', recurrence: 'none', untilDate: null })],
    ['2026-11-22', value({ title: '今後の個別変更', startDate: '2026-11-25', endDate: '2026-11-25', recurrence: 'none', untilDate: null })], ['2026-11-29', null]]) {
    const record = (await records())[0]; await actions.saveCalendarEvent({ eventId, scope: 'one', anchorDate, basisRevision: JSON.stringify([record.heads.map(row => row.operationId).sort(), []]), value: body, category: body ? category : null });
  }
  const original = (await records())[0];
  const command = { eventId, scope: 'future', anchorDate: '2026-11-15', basisRevision: basis(original), expectedExceptionIds: allExceptionIds(original),
    value: value({ startDate: '2026-11-16', endDate: '2026-11-16', title: '新しい定例', location: '共有会議室 Ｂ棟２階 西口前desk' }), category, intentId: 'calendar-intent.future-save-intent' };
  return { f, device, actions, records, original, command };
}
test('shared future changes use existing signed payloads preserve all explicit edits and converge on another device with idempotent save and undo', async t => {
  const f = await sharedFixture(); t.after(() => f.device.connection.close());
  const before = plain(project(projectSharedCalendarRecords(await f.records(), groupId)));
  const operations = await f.actions.saveCalendarEvent(f.command); assert.ok(operations.length >= 2); assert.ok(operations.every(row => ['one', 'series'].includes(row.payload.scope)));
  const after = plain(project(projectSharedCalendarRecords(await f.records(), groupId)));
  assert.ok(after.some(row => row.date === '2026-11-09' && row.title === '過去の個別変更')); assert.ok(after.some(row => row.date === '2026-11-25' && row.title === '今後の個別変更'));
  assert.ok(!after.some(row => row.date === '2026-11-23' || row.date === '2026-11-30'));
  assert.ok(after.some(row => row.date === '2026-11-16' && row.title === '新しい定例' && row.location === f.command.value.location));
  assert.ok(after.filter(row => row.title !== '新しい定例').every(row => row.location === ''));
  const retry = await f.actions.saveCalendarEvent(f.command); assert.equal(retry.calendarEventId, operations[0].payload.eventId); assert.deepEqual(plain(project(projectSharedCalendarRecords(await f.records(), groupId))), after);
  const second = await f.f.device('member', f.f.member); t.after(() => second.connection.close());
  const facts = await loadSharedFacts(f.device.database, groupId), checkpoint = await readSharingCheckpoint(second.database, groupId);
  await applyReceivedSharedFacts(second.database, groupId, facts, String(facts.length), second.repository.project, checkpoint.cursor, now().getTime(), second.repository.evidenceForServerReceipts(receiptsFor(facts)));
  assert.deepEqual(plain(project(projectSharedCalendarRecords(readSharedCalendar((await second.repository.readState()).assessment.view), groupId))), after);
  const undo = calendarFutureUndoCommand(f.original, operations, 'calendar-intent.future-undo-intent'); assert.ok(undo);
  await f.actions.undoCalendarFutureEvent(undo); await f.actions.undoCalendarFutureEvent(undo);
  assert.deepEqual(plain(project(projectSharedCalendarRecords(await f.records(), groupId))), before);
});
test('shared future edits keep detached exceptions when a changed recurrence no longer has their slot and block stale undo', async t => {
  const f = await sharedFixture(); t.after(() => f.device.connection.close());
  const command = { ...f.command, value: value({ startDate: '2026-11-15', endDate: '2026-11-15', recurrence: 'none', untilDate: null }), intentId: 'calendar-intent.future-shortened-intent' };
  const operations = await f.actions.saveCalendarEvent(command), rows = plain(project(projectSharedCalendarRecords(await f.records(), groupId)));
  assert.ok(rows.some(row => row.date === '2026-11-25' && row.title === '今後の個別変更'));
  const undo = calendarFutureUndoCommand(f.original, operations, 'calendar-intent.future-blocked-undo'); const branch = (await f.records()).find(row => row.id === operations[0].payload.eventId);
  await f.actions.saveCalendarEvent({ eventId: branch.id, scope: 'series', anchorDate: null, basisRevision: basis(branch), value: { ...command.value, notes: '別の編集' }, category });
  await assert.rejects(f.actions.undoCalendarFutureEvent(undo), /上書きせず/u);
});
test('future split at the first occurrence retains earlier detached edits and undo restores their original identity', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const id = await storage.saveCalendarEvent(h.database, { expectedRevision: 0, value: value({ untilDate: null }) });
  await storage.saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-08', value: value({ title: '残す個別変更', recurrence: 'none', untilDate: null, startDate: '2026-11-09', endDate: '2026-11-09' }) });
  await storage.saveCalendarEvent(h.database, { id, expectedRevision: 1, value: value({ startDate: '2026-12-01', endDate: '2026-12-01', recurrence: 'none', untilDate: null }) });
  await storage.saveCalendarEvent(h.database, { id, expectedRevision: 2, value: value({ startDate: '2026-12-01', endDate: '2026-12-01', untilDate: null }) });
  const before = await storage.readLocalCalendar(h.database), original = before.events[0];
  const receipt = await storage.saveCalendarFutureEvent(h.database, { eventId: id, revision: original.revision, exceptionRevision: 0, scope: 'future', anchorDate: original.startDate,
    value: { ...calendarFutureBase(original, original.startDate), startDate: '2026-12-02', endDate: '2026-12-02' } });
  assert.ok(plain(project(await storage.readLocalCalendar(h.database))).some(row => row.date === '2026-11-09' && row.title === '残す個別変更'));
  await receipt.undoFuture(); assert.deepEqual(plain(project(await storage.readLocalCalendar(h.database))), plain(project(before)));
});
test('shared future split rejects another member atomically and refuses undo after authority is revoked', async t => {
  const f = await sharedFixture(); t.after(() => f.device.connection.close()); const member = await f.f.device('member', f.f.member); t.after(() => member.connection.close());
  const facts = await loadSharedFacts(f.device.database, groupId), checkpoint = await readSharingCheckpoint(member.database, groupId);
  await applyReceivedSharedFacts(member.database, groupId, facts, String(facts.length), member.repository.project, checkpoint.cursor, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
  let id = 0; const actions = createV2CalendarActions(member.repository, () => `forbidden-future-${++id}`), before = await loadSharedFacts(member.database, groupId);
  await assert.rejects(actions.saveCalendarEvent({ ...f.command, intentId: 'calendar-intent.forbidden-future' })); assert.deepEqual(await loadSharedFacts(member.database, groupId), before);
  const operations = await f.actions.saveCalendarEvent(f.command), undo = calendarFutureUndoCommand(f.original, operations, 'calendar-intent.revoked-future-undo'); f.device.stopWrites();
  await assert.rejects(f.actions.undoCalendarFutureEvent(undo), /account changed/u);
});
test('shared future split from the first occurrence preserves the entire individual history and rejects stale exception proofs', async t => {
  const f = await sharedFixture(); t.after(() => f.device.connection.close()); const original = plain(project(projectSharedCalendarRecords(await f.records(), groupId)));
  await assert.rejects(f.actions.saveCalendarEvent({ ...f.command, expectedExceptionIds: [], intentId: 'calendar-intent.stale-future-exceptions' }), /更新/u);
  const operations = await f.actions.saveCalendarEvent({ ...f.command, anchorDate: '2026-11-01', value: value({ startDate: '2026-11-02', endDate: '2026-11-02' }), intentId: 'calendar-intent.first-future' });
  const rows = plain(project(projectSharedCalendarRecords(await f.records(), groupId)));
  assert.ok(rows.some(row => row.date === '2026-11-09' && row.title === '過去の個別変更')); assert.ok(rows.some(row => row.date === '2026-11-25' && row.title === '今後の個別変更'));
  await f.actions.undoCalendarFutureEvent(calendarFutureUndoCommand(f.original, operations, 'calendar-intent.first-future-undo'));
  assert.deepEqual(plain(project(projectSharedCalendarRecords(await f.records(), groupId))), original);
});
test('forked shared reminder preferences stay in personal storage are idempotent and never overwrite a later clock choice', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const scope = reminders.calendarReminderScope('viewer', 'group'), sourceId = 'shared.original', branchId = 'shared.future';
  await reminders.saveCalendarReminder(h.database, { scope, eventId: sourceId, anchorDate: null, minutes: 60 });
  await reminders.saveCalendarReminder(h.database, { scope, eventId: sourceId, anchorDate: '2026-11-22', minutes: 10 });
  const before = await reminders.readCalendarReminders(h.database), input = { scope, sourceId, branchId, source: { ...value(), id: sourceId, revision: 1 }, anchor: '2026-11-15', next: value({ startDate: '2026-11-16', endDate: '2026-11-16' }) };
  const receipt = await reminders.forkCalendarReminders(h.database, input), after = await reminders.readCalendarReminders(h.database);
  assert.ok(after.rules.some(row => row.scope === scope && row.eventId === branchId && row.anchorDate === '2026-11-23' && row.minutes === 10));
  const writes = h.writes.length; await reminders.forkCalendarReminders(h.database, input); assert.equal(h.writes.length, writes);
  await reminders.saveCalendarReminder(h.database, { scope, eventId: branchId, anchorDate: null, minutes: 0 }); await assert.rejects(receipt.assertCurrent(), /上書きせず/u);
  await reminders.saveCalendarReminder(h.database, { scope, eventId: branchId, anchorDate: null, minutes: 60 }); await receipt.undo(); assert.deepEqual(await reminders.readCalendarReminders(h.database), before);
});

test('an empty private reminder split stays complete after restart and never adopts a later source reminder', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'liflow-calendar-reminders-')), path = join(folder, 'private.sqlite');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const scope = reminders.calendarReminderScope('viewer', 'group');
  const input = { scope, sourceId: 'shared.source', branchId: 'shared.branch', source: { ...value(), id: 'shared.source', revision: 1 },
    anchor: '2026-11-15', next: value({ startDate: '2026-11-16', endDate: '2026-11-16' }) };
  const first = createDatabase(path);
  try {
    await repository.initializeLocalDatabase(first.database);
    await reminders.forkCalendarReminders(first.database, input);
  } finally { first.connection.close(); }
  const h = createDatabase(path); t.after(() => h.connection.close());
  await reminders.saveCalendarReminder(h.database, { scope, eventId: input.sourceId, anchorDate: null, minutes: 1440 });
  const before = await reminders.readCalendarReminders(h.database); const writes = h.writes.length;
  await reminders.forkCalendarReminders(h.database, input);
  assert.deepEqual(await reminders.readCalendarReminders(h.database), before);
  assert.equal(h.writes.length, writes);
});

for (const [platform, ...testNames] of [
  ['ios', 'ios repeating editor exposes exactly three scopes and switching them preserves unsaved input', 'ios dragging a repeating appointment asks all three scopes and future drag keeps its undo receipt'],
  ['android', 'android repeating editor exposes exactly three scopes and switching them preserves unsaved input', 'android dragging a repeating appointment asks all three scopes and future drag keeps its undo receipt']
]) {
  test(testNames[0], async t => {
    const original = { ...value(), id: 'event', revision: 1 }, saved = [];
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: {
      initial: { eventId: original.id, revision: 1, exceptionRevision: 0, anchorDate: '2026-11-15', scope: 'one', value: { ...value({ startDate: '2026-11-15', endDate: '2026-11-15' }), recurrence: 'none', untilDate: null } },
      local: { database: {}, snapshot: { events: [original], exceptions: [], categories: [category], drafts: [] }, refresh: async () => {}, saveEvent: async draft => saved.push(draft) }, onClose() {}, onSaved() {},
    } }); t.after(() => ui.unmount());
    await ui.change('予定名', '入力途中の名前'); await ui.press('変更する範囲を選択');
    for (const label of ['この予定だけ', '今後の予定すべて', '繰り返し全体']) ui.button(label);
    await ui.press('今後の予定すべて'); assert.equal(ui.button('変更する範囲を選択').props.accessibilityValue.text, '今後の予定すべて');
    assert.equal(saved.length, 0); await ui.press('予定を保存');
    assert.equal(saved[0].scope, 'future'); assert.equal(saved[0].anchorDate, '2026-11-15'); assert.equal(saved[0].value.recurrence, 'weekly'); assert.equal(saved[0].value.title, '入力途中の名前');
  });
  test(testNames[1], async t => {
    let undo = 0; const writes = [], original = { ...value(), id: 'event', revision: 1 };
    const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: callback => callback(), props: {
      today: '2026-11-15', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      local: { database: {}, snapshot: { events: [original], exceptions: [], categories: [category], drafts: [] }, refresh: async () => {}, saveEvent: async draft => { writes.push(draft); return { undoFuture: async () => { undo++; } }; } },
    } }); t.after(() => ui.unmount());
    await selectCalendarView(ui, '1日表示'); ui.button('定例を編集').props.onLongPress(); await ui.flush();
    const card = ui.nodes().find(node => node.props.testID?.startsWith('calendar-movable-')); card.props.onPanResponderGrant(); card.props.onPanResponderRelease(null, { dx: 0, dy: 44 }); await ui.flush();
    for (const label of ['この予定だけ', '今後の予定すべて', '繰り返し全体']) ui.button(label); assert.deepEqual(writes, []);
    await ui.press('今後の予定すべて'); assert.equal(writes[0].scope, 'future'); assert.equal(writes[0].anchorDate, '2026-11-15'); assert.equal(writes[0].value.startMinute, 600);
    await ui.press('移動を元に戻す'); assert.equal(undo, 1);
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} deleting a retained personal occurrence leaves its single parent and other individual changes in SQLite`, async t => {
    const f = await localFixture(); t.after(() => f.h.connection.close());
    await storage.saveCalendarEvent(f.h.database, { id: f.id, expectedRevision: f.series.revision, value: { ...f.series, recurrence: 'none', untilDate: null } });
    const before = await storage.readLocalCalendar(f.h.database), selected = project(before).find(row => row.title === '今後の個別変更');
    let confirm, closed = 0;
    const editor = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      alert: (_title, _message, options) => { confirm = options.find(row => row.style === 'destructive'); },
      props: { initial: calendarOccurrenceDraft(selected, false), local: { database: f.h.database, snapshot: before, refresh: async () => {} },
        onClose() { closed++; }, onSaved() {} },
    }); t.after(() => editor.unmount());
    await editor.press('この回を削除'); confirm.onPress();
    for (let i = 0; i < 20 && !closed; i++) await editor.flush();
    assert.equal(closed, 1); const after = await storage.readLocalCalendar(f.h.database);
    assert.deepEqual(after.events, before.events);
    const others = snapshot => snapshot.exceptions.filter(row => row.anchorDate !== selected.anchorDate);
    assert.deepEqual(others(after), others(before));
    assert.equal(after.exceptions.find(row => row.anchorDate === selected.anchorDate).override, null);
  });

  test(`${platform} editing and dragging a detached occurrence offer only valid scopes and leave its parent untouched`, async t => {
    const series = { ...value(), id: 'detached-series', revision: 3 }, day = '2026-11-17', writes = [];
    const override = value({ title: '個別に残した回', location: '別室', startDate: day, endDate: day, recurrence: 'none', untilDate: null });
    const exception = { eventId: series.id, anchorDate: '2026-11-16', revision: 2, detached: true, override };
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, layoutEffect: callback => callback(), props: {
      today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      local: { database: {}, snapshot: { events: [series], exceptions: [exception], categories: [category], drafts: [] }, refresh: async () => {}, saveEvent: async draft => writes.push(draft) },
    } }); t.after(() => screen.unmount());
    const checkScopes = () => {
      const future = screen.button('今後の予定すべて');
      assert.equal(future.props.disabled, true); assert.equal(future.props.accessibilityState.disabled, true);
      assert.ok(!screen.button('この予定だけ').props.disabled); assert.ok(!screen.button('繰り返し全体').props.disabled);
    };
    await selectCalendarView(screen, '1日表示'); await screen.press('個別に残した回を編集');
    await screen.press('変更する範囲を選択'); checkScopes(); await screen.press('繰り返し全体');
    await screen.press('変更する範囲を選択'); await screen.press('この予定だけ');
    const location = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '予定の場所');
    assert.equal(location.props.value ?? location.props.defaultValue, override.location);
    await screen.press('予定の編集を閉じる');
    if (screen.nodes().some(node => node.props.accessibilityLabel === '閉じるときの入力の扱い')) await screen.press('入力を破棄');
    screen.button('個別に残した回を編集').props.onLongPress(); await screen.flush();
    const card = screen.nodes().find(node => node.props.testID?.startsWith('calendar-movable-'));
    card.props.onPanResponderGrant(); card.props.onPanResponderRelease(null, { dx: 0, dy: 44 }); await screen.flush();
    checkScopes(); await screen.press('キャンセル'); assert.deepEqual(writes, []);
  });
}
