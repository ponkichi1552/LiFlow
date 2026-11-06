import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { registerSharedRepositoryAdapter } from '../src/platform/storage/shared-repository-adapter.ts';
import { calendarEventsInTimeZone, calendarMonth, dateInMonth, indexCalendarOccurrences, newEventDraft, occurrencesOnDate, projectCalendarEvents, validateEventDraft } from '../src/features/calendar/events.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { calendarSwipe, timelineEvents } from '../src/features/calendar/layout.ts';
const { initializeLocalDatabase, loadPlannerSnapshot } = await import('../src/platform/storage/repository.ts');
const { deleteCalendarEvent, readLocalCalendar, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent, subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');

const draft = (patch = {}) => ({ ...newEventDraft('2026-10-30', 'Asia/Tokyo'), title: '授業', ...patch });
const event = (patch = {}) => ({ ...draft(patch), id: 'event.test', revision: 1 });

test('a valid personal event can be saved before the first calendar read without guessing a custom category or replacing later category edits', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  assert.equal(h.connection.prepare('SELECT count(*) AS n FROM calendar_categories').get().n, 0);
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft() });
  assert.equal((await readLocalCalendar(h.database)).events.find(row => row.id === id).title, '授業');
  await saveCalendarCategory(h.database, { id: 'personal', name: '変更した分類', color: '#123456', expectedRevision: 1 });
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ title: '次の予定' }) });
  const saved = (await readLocalCalendar(h.database)).categories.find(row => row.id === 'personal');
  assert.equal(saved.name, '変更した分類'); assert.equal(saved.color, '#123456'); assert.equal(saved.revision, 2);
  await assert.rejects(saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ categoryId: 'missing-custom' }) }), /分類/);
  assert.equal((await readLocalCalendar(h.database)).events.length, 2);
});
async function fixture(t) { const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database); return h; }

test('local calendar validates real dates durations timezones recurrence and bounded fields without accepting ambiguous civil clocks', () => {
  assert.equal(validateEventDraft(draft()).title, '授業');
  for (const patch of [{ title: '' }, { startDate: '2026-02-30' }, { endDate: '2026-10-29' }, { endMinute: 9 * 60 }, { startMinute: -1 }, { endMinute: 1440 },
    { timeZone: 'unknown/zone' }, { timeZone: undefined }, { recurrence: '__proto__' }, { recurrence: 'toString' }, { untilDate: '2026-10-01' }, { categoryId: '../group' }, { notes: 'x'.repeat(4001) },
    { startDate: '2026-03-08', endDate: '2026-03-08', startMinute: 150, endMinute: 210, timeZone: 'America/New_York' },
    { startDate: '2026-11-01', endDate: '2026-11-01', startMinute: 90, endMinute: 180, timeZone: 'America/New_York' }]) assert.throws(() => validateEventDraft(draft(patch)));
});

test('a stale recurring editor draft can be explicitly discarded without deleting another round or a newer draft', async t => {
  const h = await fixture(t); const { discardCalendarDraftIfUnchanged } = await import('../src/platform/storage/calendar-events.ts');
  const value = draft({ recurrence: 'weekly' }); const id = await saveCalendarEvent(h.database, { value, expectedRevision: 0 });
  const a = { eventId: id, scope: 'one', anchorDate: '2026-11-06', revision: 1, exceptionRevision: 0, value: draft({ title: '保留した編集', startDate: '2026-11-06', endDate: '2026-11-06' }) };
  const b = { ...a, anchorDate: '2026-11-13' }; await saveCalendarDraft(h.database, a); await saveCalendarDraft(h.database, b);
  await saveCalendarEvent(h.database, { id, value: { ...value, title: '新しい系列名' }, expectedRevision: 1, scope: 'series' });
  await assert.rejects(saveCalendarEvent(h.database, { id, scope: 'one', anchorDate: a.anchorDate, expectedRevision: a.revision, expectedExceptionRevision: 0, value: a.value }));
  await discardCalendarDraftIfUnchanged(h.database, a);
  let current = await readLocalCalendar(h.database); assert.equal(current.drafts.length, 1); assert.equal(current.drafts[0].anchorDate, b.anchorDate);
  const newer = { ...b, value: { ...b.value, notes: '別の画面で更新' } }; await saveCalendarDraft(h.database, newer);
  await assert.rejects(discardCalendarDraftIfUnchanged(h.database, b), /別の画面/);
  assert.equal((await readLocalCalendar(h.database)).drafts[0].value.notes, '別の画面で更新');
  await saveCalendarEvent(h.database, { id, scope: 'one', anchorDate: a.anchorDate, expectedRevision: 2, expectedExceptionRevision: 0, value: a.value });
  current = await readLocalCalendar(h.database); assert.equal(current.events[0].title, '新しい系列名'); assert.equal(current.exceptions.length, 1);
});
test('local calendar seeks long running daily and biweekly series and honors the inclusive recurrence end without duplicating instances', () => {
  const daily = projectCalendarEvents([event({ startDate: '2010-01-01', endDate: '2010-01-01', recurrence: 'daily' })], [], '2026-10-01', '2026-10-31');
  assert.equal(daily.length, 31); assert.equal(new Set(daily.map(row => row.id)).size, 31);
  const rows = projectCalendarEvents([event({ recurrence: 'biweekly', untilDate: '2026-11-27' })], [], '2026-10-01', '2026-12-31');
  assert.deepEqual(rows.map(row => row.startDate), ['2026-10-30', '2026-11-13', '2026-11-27']);
  assert.throws(() => projectCalendarEvents([], [], '2026-01-01', '2028-01-01'));
});
test('local monthly and yearly calendars skip nonexistent dates and preserve the preferred day through short months', () => {
  const monthly = event({ startDate: '2026-01-31', endDate: '2026-01-31', recurrence: 'monthly' });
  assert.deepEqual(projectCalendarEvents([monthly], [], '2026-01-01', '2026-04-30').map(row => row.startDate), ['2026-01-31', '2026-03-31']);
  const leap = event({ startDate: '2024-02-29', endDate: '2024-02-29', recurrence: 'yearly', allDay: true, birthday: true });
  assert.equal(projectCalendarEvents([leap], [], '2026-01-01', '2026-12-31').length, 0);
  assert.equal(projectCalendarEvents([leap], [], '2028-01-01', '2028-12-31')[0].startDate, '2028-02-29');
  assert.equal(dateInMonth(calendarMonth('2026-01-31', 1), 31), '2026-02-28'); assert.equal(dateInMonth('2026-03-01', 31), '2026-03-31');
});
test('local moved and cancelled recurring instances retain their anchor identity and cannot resurrect an invalid series occurrence', () => {
  const series = event({ recurrence: 'weekly' });
  const exceptions = [{ eventId: series.id, anchorDate: '2026-10-30', override: draft({ startDate: '2026-11-02', endDate: '2026-11-02', title: '補講' }), revision: 1 },
    { eventId: series.id, anchorDate: '2026-11-06', override: null, revision: 1 },
    { eventId: series.id, anchorDate: '2026-10-29', override: draft({ startDate: '2026-11-03', endDate: '2026-11-03', title: '存在しない回' }), revision: 1 }];
  const rows = projectCalendarEvents([series], exceptions, '2026-11-01', '2026-11-10');
  assert.deepEqual(rows.map(row => [row.id, row.startDate, row.title]), [['event.test:2026-10-30', '2026-11-02', '補講']]);
});
test('local multi-day and timezone projections preserve exact end boundaries and edit the original civil clock', () => {
  const row = event({ startMinute: 30, endMinute: 90 });
  const display = calendarEventsInTimeZone(projectCalendarEvents([row], [], '2026-10-29', '2026-10-31'), 'America/Los_Angeles')[0];
  assert.equal(display.startDate, '2026-10-29'); assert.equal(display.startMinute, 8 * 60 + 30); assert.equal(display.original.timeZone, 'Asia/Tokyo');
  const overnight = projectCalendarEvents([event({ endDate: '2026-10-31', startMinute: 23 * 60, endMinute: 0 })], [], '2026-10-30', '2026-10-31');
  assert.equal(occurrencesOnDate(overnight, '2026-10-31').length, 0);
  const allDay = calendarEventsInTimeZone(projectCalendarEvents([event({ allDay: true, endDate: '2026-11-01' })], [], '2026-10-30', '2026-11-02'), 'America/Los_Angeles');
  assert.equal(occurrencesOnDate(allDay, '2026-11-01').length, 1); assert.equal(allDay[0].startDate, '2026-10-30');
});
test('local recurring clocks that enter a DST gap are flagged rather than silently shifted or dropping the whole month', () => {
  const rows = projectCalendarEvents([event({ startDate: '2026-03-01', endDate: '2026-03-01', startMinute: 150, endMinute: 210, recurrence: 'weekly', timeZone: 'America/New_York' })], [], '2026-03-01', '2026-03-31');
  assert.equal(rows.length, 5); assert.equal(rows.find(row => row.startDate === '2026-03-08').timeIssue, 'gap');
  assert.equal(rows.find(row => row.startDate === '2026-03-08').startMinute, 150);
});

test('mixed-zone calendar events are ordered by their displayed date and time while retaining original editing identities', () => {
  const sources = [{ ...event({ startMinute: 600, endMinute: 660 }), id: 'japan' },
    { ...event({ timeZone: 'America/New_York', startMinute: 540, endMinute: 600 }), id: 'new-york' },
    { ...event({ allDay: true }), id: 'whole-day' }];
  const original = projectCalendarEvents(sources, [], '2026-10-30', '2026-10-30');
  const projected = calendarEventsInTimeZone(original, 'Asia/Tokyo');
  assert.deepEqual(projected.map(row => row.eventId), ['whole-day', 'japan', 'new-york']);
  assert.deepEqual(projected.map(row => row.startMinute), [540, 600, 1320]);
  assert.equal(projected[2].original, original.find(row => row.eventId === 'new-york'));
  assert.equal(projected[2].original.startMinute, 540);
});

test('calendar date indexing preserves complete cross-midnight all-day moved and DST coverage without repeated whole-month scans', () => {
  const from = '2026-10-01', through = '2026-11-30';
  const sources = [{ ...event({ startMinute: 1380, endDate: '2026-10-31', endMinute: 0 }), id: 'overnight' },
    { ...event({ allDay: true, endDate: '2026-11-02' }), id: 'multi' },
    { ...event({ startDate: '2026-10-25', endDate: '2026-10-25', startMinute: 90, endMinute: 180, timeZone: 'America/New_York', recurrence: 'weekly' }), id: 'dst' },
    ...Array.from({ length: 100 }, (_, i) => ({ ...event({ recurrence: 'daily' }), id: `daily-${i}` }))];
  const exceptions = [{ eventId: 'daily-0', anchorDate: '2026-11-03', override: draft({ startDate: '2026-11-05', endDate: '2026-11-06', title: '移動した予定' }), revision: 1 }];
  const rows = calendarEventsInTimeZone(projectCalendarEvents(sources, exceptions, from, through), 'Asia/Tokyo');
  let dateReads = 0;
  const observed = rows.map(row => ({ ...row, get startDate() { dateReads++; return row.startDate; }, get endDate() { dateReads++; return row.endDate; } }));
  const indexed = indexCalendarOccurrences(observed, from, through);
  assert.ok(dateReads <= rows.length * 4, 'each event is indexed once instead of scanned once per day');
  for (let day = from; day <= through; day = addDays(day, 1)) assert.deepEqual((indexed.get(day) ?? []).map(row => row.id), occurrencesOnDate(rows, day).map(row => row.id));
  assert.ok(!indexed.get('2026-10-31')?.some(row => row.eventId === 'overnight'));
  assert.ok(indexed.get('2026-11-06').some(row => row.id === 'daily-0:2026-11-03'));
});
test('local calendar SQLite CRUD CAS exceptions and drafts survive reopen while personal chores history and Google links remain independent', async t => {
  const h = await fixture(t); const before = await loadPlannerSnapshot(h.database, '2026-10-30');
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ recurrence: 'weekly' }) });
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-06', value: draft({ title: '変更した回', startDate: '2026-11-07', endDate: '2026-11-07' }) });
  let saved = await readLocalCalendar(h.database); assert.equal(saved.events.length, 1); assert.equal(saved.exceptions.length, 1);
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-06', value: draft() }), /別の画面/);
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-05', value: draft() }), /別の画面/);
  await deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate: '2026-11-06', expectedExceptionRevision: 1 });
  saved = await readLocalCalendar(h.database); assert.equal(saved.exceptions[0].override, null); assert.equal(saved.exceptions[0].revision, 2);
  const temporary = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: draft({ title: '', endMinute: 1 }) };
  await saveCalendarDraft(h.database, temporary); assert.deepEqual((await readLocalCalendar(h.database)).draft, temporary);
  const after = await loadPlannerSnapshot(h.database, '2026-10-30');
  for (const field of ['chores', 'states', 'completions', 'wasteSchedules', 'scheduleEntries']) assert.deepEqual(after[field], before[field]);
  assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM google_task_links').get().n, 0);
  await deleteCalendarEvent(h.database, { id, expectedRevision: 1 }); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.equal(h.connection.prepare('SELECT deleted FROM calendar_events WHERE id=?').get(id).deleted, 1);
});
test('local calendar concurrent saves reject stale revisions and series rule changes require explicit exception reset', async t => {
  const h = await fixture(t); const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ recurrence: 'weekly' }) });
  const attempts = await Promise.allSettled(['A', 'B'].map(title => saveCalendarEvent(h.database, { id, expectedRevision: 1, value: draft({ title, recurrence: 'weekly' }) })));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  await saveCalendarEvent(h.database, { id, expectedRevision: 2, scope: 'one', anchorDate: '2026-11-06', value: draft() });
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 2, value: draft({ recurrence: 'biweekly' }) }), /個別/);
  assert.equal((await readLocalCalendar(h.database)).exceptions.length, 1);
  await saveCalendarEvent(h.database, { id, expectedRevision: 2, value: draft({ recurrence: 'biweekly' }), resetExceptions: true });
  assert.equal((await readLocalCalendar(h.database)).exceptions.length, 0); assert.equal((await readLocalCalendar(h.database)).events[0].revision, 3);
});
test('saving another calendar event never discards an unrelated new or existing draft', async t => {
  const h = await fixture(t);
  const a = await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ title: 'A' }) });
  const b = await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ title: 'B' }) });
  const pending = (eventId, title) => ({ eventId, anchorDate: null, revision: eventId ? 1 : 0, exceptionRevision: 0, scope: 'series', value: draft({ title }) });
  // Keep the single draft slot used by the initial implementation readable.
  await h.database.runAsync("INSERT INTO calendar_drafts(slot,draft_json) VALUES('editor',?)", JSON.stringify(pending(null, '新しい予定の途中')));
  await saveCalendarDraft(h.database, pending(a, 'Aの途中'));
  await saveCalendarDraft(h.database, pending(b, 'Bの途中'));
  assert.equal((await readLocalCalendar(h.database)).drafts.length, 3);
  await saveCalendarEvent(h.database, { id: a, expectedRevision: 1, value: draft({ title: 'Aを保存' }) });
  assert.deepEqual((await readLocalCalendar(h.database)).drafts.map(row => row.value.title).sort(), ['Bの途中', '新しい予定の途中'].sort());
  await saveCalendarDraft(h.database, null);
  assert.deepEqual((await readLocalCalendar(h.database)).drafts.map(row => row.value.title), ['Bの途中']);
  await deleteCalendarEvent(h.database, { id: b, expectedRevision: 1 });
  assert.equal((await readLocalCalendar(h.database)).draft, null);
});
test('birthday and ordinary event drafts remain independent when saved discarded and resumed from settings', async t => {
  const h = await fixture(t);
  const ordinary = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: draft({ title: '入力途中の予定' }) };
  const birthday = { ...ordinary, value: { ...newEventDraft('2026-10-30', 'Asia/Tokyo', true), title: '入力途中の誕生日' } };
  await saveCalendarDraft(h.database, ordinary); await saveCalendarDraft(h.database, birthday);
  assert.equal((await readLocalCalendar(h.database)).drafts.length, 2);
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: birthday.value });
  assert.equal((await readLocalCalendar(h.database)).draft.value.title, ordinary.value.title);
  await saveCalendarDraft(h.database, birthday); await saveCalendarDraft(h.database, null);
  assert.equal((await readLocalCalendar(h.database)).draft.value.title, birthday.value.title);
  const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
  const screen = screenHarness('src/features/calendar/birthday-settings.tsx', { exportName: 'BirthdaySettings', database: h.database, snapshot: () => ({ today: '2026-10-30', timeZone: 'Asia/Tokyo' }),
    mocks: { './use-local-calendar': { useLocalCalendar: () => local } } });
  await screen.press('誕生日を追加');
  assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '予定名').props.defaultValue, birthday.value.title);
  await screen.press('入力を破棄'); for (let n = 0; n < 15 && (await readLocalCalendar(h.database)).draft; n++) await screen.flush();
  assert.equal((await readLocalCalendar(h.database)).draft, null);
});
test('local classification colors are reused by reference and invalid or duplicate categories never overwrite a saved color', async t => {
  const h = await fixture(t); await saveCalendarCategory(h.database, { id: 'personal', expectedRevision: 1, name: '私用', color: '#123456' });
  await assert.rejects(saveCalendarCategory(h.database, { id: 'personal', expectedRevision: 1, name: '私用', color: '#654321' }), /別の画面/);
  await assert.rejects(saveCalendarCategory(h.database, { expectedRevision: 0, name: '私用', color: '#FFFFFF' }), /同じ名前/);
  await assert.rejects(saveCalendarCategory(h.database, { expectedRevision: 0, name: 'NG', color: 'red' }));
  assert.equal((await readLocalCalendar(h.database)).categories.find(row => row.id === 'personal').color, '#123456');
});
test('local calendar refuses shared DB adapters before any write and a failed UI listener cannot turn a committed event into a failed save', async t => {
  const h = await fixture(t); const unregister = registerSharedRepositoryAdapter(h.database, { groupId: 'other', userId: 'owner', readSnapshot() {}, mutate() {} });
  const before = h.writes.length;
  await assert.rejects(saveCalendarEvent(h.database, { expectedRevision: 0, value: draft() }), /個人/); assert.equal(h.writes.length, before); unregister();
  const stop = subscribeLocalCalendar(h.database, () => { throw new Error('broken view'); });
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft() }); stop(); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
});
test('calendar gesture boundaries separate interior date motion from edge navigation and overlapping timeline events share lanes', () => {
  assert.equal(calendarSwipe(100, 100, 5, 390), 'previous'); assert.equal(calendarSwipe(100, -100, 5, 390), 'next');
  assert.equal(calendarSwipe(10, 100, 5, 390), 'home'); assert.equal(calendarSwipe(380, -100, 5, 390), 'chores');
  assert.equal(calendarSwipe(380, 100, 5, 390), null); assert.equal(calendarSwipe(100, 30, 100, 390), null);
  const first = projectCalendarEvents([event(), { ...event({ startMinute: 570, endMinute: 660 }), id: 'other' }, { ...event({ startMinute: 700, endMinute: 730 }), id: 'after' }], [], '2026-10-30', '2026-10-30');
  const layout = timelineEvents(first, '2026-10-30'); assert.equal(layout[0].lanes, 2); assert.equal(layout[1].lanes, 2); assert.equal(layout[2].lanes, 1);
});

test('unchanged local Calendar reads perform no category writes and still restore missing defaults', async () => {
  const h = createDatabase();
  try {
    await initializeLocalDatabase(h.database);
    const initial = await readLocalCalendar(h.database);
    let writes = 0; const run = h.database.runAsync;
    h.database.runAsync = async (...args) => { writes++; return run(...args); };
    for (let i = 0; i < 10; i++) assert.deepEqual((await readLocalCalendar(h.database)).categories, initial.categories);
    assert.equal(writes, 0);
    h.connection.prepare('DELETE FROM calendar_categories WHERE id=?').run(initial.categories[0].id);
    const repaired = await readLocalCalendar(h.database);
    assert.equal(writes, 1); assert.equal(repaired.categories.length, initial.categories.length);
  } finally { h.connection.close(); }
});
