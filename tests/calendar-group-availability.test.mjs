import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture as sharedFixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { createLocalCalendarAvailability, localCalendarTargetRange } from '../src/features/calendar/private-availability.ts';
import { combinePrivateCalendarAvailability, createIntervalCalendarAvailability } from '../src/features/sharing/v2/private-availability.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarEvent, deleteCalendarEvent, subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const settings = { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } };
const now = () => new Date('2026-10-27T10:00:00Z');
const interval = (start, end) => ({ precision: 'interval', start, end });
const day = date => interval(`${date}T00:00:00Z`, `${date}T23:59:00Z`);
const draft = patch => ({ ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: '非公開の検査予定', allDay: true, ...patch });

async function fixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  const f = await sharedFixture({ preset: 'assigned', members: ['a'], before: 0 }); f.make('chore', { load: 'heavy' }, { entityId: 'floor' });
  const model = () => ({ viewerUserId: 'a', plan: f.plan() });
  const localCalendar = {
    readForPlan: async (range, timeZone) => { const value = await readLocalCalendar(h.database); return { ownerUserId: 'a', availability: createLocalCalendarAvailability(value.events, value.exceptions, range, timeZone) }; },
    readOwnCalendar: async target => { const value = await readLocalCalendar(h.database); const range = localCalendarTargetRange(target, 'Asia/Tokyo');
      return range ? createLocalCalendarAvailability(value.events, value.exceptions, range, 'Asia/Tokyo')(target).conflict : { kind: 'unknown', reason: 'timeNotSpecified' }; },
  };
  const session = createV2ScreenSession({ controller: { readModel: async () => model() }, groupId: f.plan().groupId, userId: 'a', now,
    readPreferences: () => ({ ownerUserId: 'a', settings }), localCalendar });
  const read = async () => (await session.readModel()).personal.recommendations;
  const recommendation = async date => (await read()).find(row => row.occurrenceId === f.occurrence(date));
  return { ...h, f, session, recommendation };
}

test('group app calendar SQLite biweekly end dates moved exceptions cancellation and deletion reallocate only personal suggestions', async t => {
  const h = await fixture(t); const before = JSON.stringify(h.f.plan()); let changes = 0; const stop = subscribeLocalCalendar(h.database, () => { changes++; }); t.after(stop);
  assert.equal((await h.recommendation('2026-10-27')).date, '2026-10-27');
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ recurrence: 'biweekly', untilDate: '2026-11-10', location: '非公開の場所', notes: '非公開のメモ' }) });
  assert.equal((await h.recommendation('2026-10-27')).date, '2026-10-28');
  assert.equal((await h.recommendation('2026-11-10')).date, '2026-11-11');
  assert.equal((await h.recommendation('2026-11-24')).date, '2026-11-24', 'inclusive recurrence end never blocks later chores');
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-10-27', value: draft({ startDate: '2026-10-28', endDate: '2026-10-28' }) });
  assert.equal((await h.recommendation('2026-10-27')).date, '2026-10-27');
  await deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate: '2026-11-10' });
  assert.equal((await h.recommendation('2026-11-10')).date, '2026-11-10');
  await deleteCalendarEvent(h.database, { id, expectedRevision: 1 });
  assert.equal((await h.recommendation('2026-10-27')).date, '2026-10-27'); assert.equal(changes, 4);
  const value = await h.session.readModel(); assert.equal(JSON.stringify(value.plan), before);
  for (const text of ['非公開の検査予定', '非公開の場所', '非公開のメモ', 'intervals', 'events']) assert.equal(JSON.stringify(value).includes(text), false, text);
  assert.equal(h.connection.prepare('SELECT count(*) AS n FROM google_task_links').get().n, 0);
});

test('group fixed instructions report app calendar conflict without moving formal dates or scheduling an untimed chore', async t => {
  const h = await fixture(t);
  const target = interval('2026-10-27T00:00:00Z', '2026-10-27T01:00:00Z');
  h.f.designation(target, { subjectUserId: null });
  await saveCalendarEvent(h.database, { expectedRevision: 0, value: draft({ allDay: false, startMinute: 540, endMinute: 600 }) });
  const before = JSON.stringify(h.f.plan()); const row = await h.recommendation('2026-10-27');
  assert.equal(row.state, 'manual'); assert.equal(row.date, '2026-10-27'); assert.equal(row.calendar.kind, 'conflict'); assert.ok(row.reasons.includes('calendarConflict'));
  assert.deepEqual(await h.session.readOwnCalendar(target), { kind: 'conflict' });
  assert.deepEqual(await h.session.readOwnCalendar({ precision: 'date', date: '2026-10-27' }), { kind: 'unknown', reason: 'timeNotSpecified' });
  assert.equal(JSON.stringify(h.f.plan()), before);
});

test('local calendar interval reader unions overlap honors exact boundaries timezones birthdays and unconfirmed DST recurrences', () => {
  const event = (id, patch) => ({ ...draft({ allDay: false, ...patch }), id, revision: 1 });
  const rows = [event('a', { startMinute: 540, endMinute: 600 }), event('b', { startMinute: 570, endMinute: 630 }),
    event('birthday', { allDay: true, birthday: true, recurrence: 'yearly' }), event('foreign', { timeZone: 'America/Los_Angeles', startDate: '2026-10-26', endDate: '2026-10-26', startMinute: 17 * 60, endMinute: 18 * 60 })];
  const read = createLocalCalendarAvailability(rows, [], { from: '2026-10-27', through: '2026-10-28' }, 'Asia/Tokyo');
  assert.equal(read(interval('2026-10-26T15:00:00Z', '2026-10-27T15:00:00Z')).busyMinutes, 90);
  assert.equal(read(interval('2026-10-27T01:30:00Z', '2026-10-27T02:00:00Z')).conflict.kind, 'clear');
  assert.equal(read(interval('2026-10-27T00:59:00Z', '2026-10-27T01:01:00Z')).conflict.kind, 'conflict');
  assert.equal(read(day('2026-10-29')).conflict.reason, 'coverage');
  const dst = createLocalCalendarAvailability([event('dst', { startDate: '2026-03-01', endDate: '2026-03-01', startMinute: 150, endMinute: 210, recurrence: 'weekly', timeZone: 'America/New_York' })], [], { from: '2026-03-08', through: '2026-03-08' }, 'America/New_York');
  assert.equal(dst(interval('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z')).conflict.kind, 'unknown');
});

test('combined private calendar readers never double count or turn an unavailable source into confirmed availability', () => {
  const local = () => ({ conflict: { kind: 'clear' }, busyMinutes: 30 });
  const google = () => ({ conflict: { kind: 'clear' }, busyMinutes: 45 });
  assert.equal(combinePrivateCalendarAvailability(google, local)(day('2026-10-27')).busyMinutes, 45);
  assert.equal(combinePrivateCalendarAvailability(() => ({ conflict: { kind: 'unknown', reason: 'stale' }, busyMinutes: null }), local)(day('2026-10-27')).conflict.kind, 'unknown');
  assert.equal(combinePrivateCalendarAvailability(() => ({ conflict: { kind: 'unknown', reason: 'binding' }, busyMinutes: null }), () => ({ conflict: { kind: 'conflict' }, busyMinutes: 60 }))(day('2026-10-27')).conflict.kind, 'conflict');
  const start = Date.parse('2026-10-27T00:00:00Z'); const coverage = { start, end: start + 24 * 60 * 60_000 };
  const exact = (a, b) => createIntervalCalendarAvailability([{ start: start + a * 60_000, end: start + b * 60_000 }], coverage);
  assert.equal(combinePrivateCalendarAvailability(exact(0, 180), exact(180, 360))(day('2026-10-27')).busyMinutes, 360, 'disjoint appointments are both counted');
  assert.equal(combinePrivateCalendarAvailability(exact(0, 180), exact(60, 240))(day('2026-10-27')).busyMinutes, 240, 'overlap is counted once');
  assert.equal(combinePrivateCalendarAvailability(exact(0, 180), exact(0, 180))(day('2026-10-27')).busyMinutes, 180, 'duplicate entries count once');
  const triple = combinePrivateCalendarAvailability(combinePrivateCalendarAvailability(exact(0, 180), exact(180, 360)), exact(360, 540));
  assert.equal(triple(day('2026-10-27')).busyMinutes, 540, 'a third calendar source retains exact union, including nested combinations');
});

test('shared general events move only local recommendations and fresh fixed-date reviews include exceptions without private disclosure', async () => {
  const f = await sharedFixture({ preset: 'assigned', members: ['a'], before: 0 }); f.make('chore', { load: 'heavy' }, { entityId: 'floor' });
  const records = () => readSharedCalendar(f.state().assessment.view);
  const session = createV2ScreenSession({ groupId: f.plan().groupId, userId: 'a', now, readPreferences: () => ({ ownerUserId: 'a', settings }),
    controller: { readModel: async () => ({ viewerUserId: 'a', plan: f.plan(), calendar: records() }),
      readCalendar: async () => ({ groupId: f.plan().groupId, viewerUserId: 'a', timeZone: 'Asia/Tokyo', records: records() }) } });
  const before = JSON.stringify(f.plan().occurrences);
  const recommendation = async () => (await session.readModel()).personal.recommendations.find(row => row.occurrenceId === f.occurrence('2026-10-27'));
  assert.equal((await recommendation()).date, '2026-10-27');
  const event = f.make('calendarEvent', { eventId: 'shared.calendar', scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [],
    value: draft({ recurrence: 'weekly' }), category: { id: 'personal', name: '共有', color: '#348DC2' } }, { actor: 'a', operationId: 'shared.calendar' });
  assert.equal((await recommendation()).date, '2026-10-28');
  const target = interval('2026-10-27T00:00:00Z', '2026-10-27T01:00:00Z');
  assert.deepEqual(await session.readOwnCalendar(target), { kind: 'conflict' });
  f.make('calendarEvent', { eventId: event.operationId, scope: 'one', anchorDate: '2026-10-27', basisOperationIds: [], resetExceptionIds: [], value: null, category: null }, { actor: 'a' });
  assert.deepEqual(await session.readOwnCalendar(target), { kind: 'clear' }, 'review reads current records rather than the last screen cache');
  assert.equal((await recommendation()).date, '2026-10-27'); assert.equal(JSON.stringify(f.plan().occurrences), before, 'shared formal dates and conditions remain unchanged');
  assert.deepEqual(await session.readOwnCalendar({ precision: 'date', date: '2026-10-27' }), { kind: 'unknown', reason: 'timeNotSpecified' });
});
