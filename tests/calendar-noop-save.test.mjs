import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
const { initializeLocalDatabase, loadPlannerSnapshot, readCachedPlannerSnapshot } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarEvent, saveCalendarDraft, deleteCalendarEvent, saveOwnBirthday, subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { readCalendarReminders, subscribeCalendarReminders } = await import('../src/platform/storage/calendar-reminders.ts');
const { createPersonalGoogleCalendarSync } = await import('../src/features/calendar/personal-google-sync.ts');
const { personalCalendarHasPendingWork } = await import('../src/features/google-sync/background-work.ts');

const draft = (patch = {}) => ({ ...newEventDraft('2026-11-20', 'UTC'), title: '検査の予定', ...patch });
async function fixture(t) {
  const h = createDatabase(); t.after(() => h.connection.close());
  await initializeLocalDatabase(h.database); await readLocalCalendar(h.database); return h;
}
async function synchronized(t) {
  const h = await fixture(t); let version = 0; const remote = new Map(), changes = [], calls = [];
  const put = body => {
    const value = { ...structuredClone(body), etag: `E${++version}` }; remote.set(value.id, value); changes.push({ version, value });
    return structuredClone(value);
  };
  const api = {
    calendars: async () => { calls.push('calendars'); return { items: [{ id: 'owned', summary: '本人', accessRole: 'owner', primary: true, timeZone: 'UTC' }] }; },
    events: async (_id, cursor) => { calls.push('events'); const since = Number(cursor.syncToken?.slice(1) ?? 0);
      return { items: cursor.syncToken ? changes.filter(row => row.version > since).map(row => structuredClone(row.value)) : [...remote.values()].map(value => structuredClone(value)), nextSyncToken: `S${version}` }; },
    instances: async () => ({ items: [] }),
    get: async (_calendar, id) => { calls.push('get'); return structuredClone(remote.get(id)); },
    insert: async (_calendar, body) => { calls.push('insert'); return put(body); },
    patch: async (_calendar, id, body) => { calls.push('patch'); return put({ ...remote.get(id), ...body }); },
    remove: async (_calendar, id) => { calls.push('remove'); return put({ id, status: 'cancelled' }); },
  };
  const sync = createPersonalGoogleCalendarSync({ database: h.database, currentSubject: async () => 'test-google',
    authorize: async () => ({ subject: 'test-google', label: '検査' }), createApi: () => api, today: () => '2026-11-16', random: () => .5 });
  await sync.connect(await sync.prepareConnection()); await sync.sync({ force: true });
  const value = draft(); const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value }); await sync.sync({ force: true });
  assert.equal(await personalCalendarHasPendingWork(h.database), false);
  return { ...h, id, value, sync, calls, remote };
}

for (const platform of ['ios', 'android']) test(`${platform} unchanged personal Calendar save keeps its revision settled Google work and planner cache while a real edit still synchronizes`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T08:00:00Z') });
  const h = await synchronized(t); const snapshot = await readLocalCalendar(h.database);
  const source = snapshot.events.find(row => row.id === h.id); const before = await loadPlannerSnapshot(h.database);
  const notifications = []; const stop = subscribeLocalCalendar(h.database, change => notifications.push(change)); t.after(stop);
  let saved = 0;
  const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, database: h.database, props: {
    initial: { eventId: h.id, anchorDate: null, revision: source.revision, exceptionRevision: 0, scope: 'series', value: source },
    local: { database: h.database, snapshot, refresh: async () => {} }, onClose() {}, onSaved() { saved++; } } }); t.after(() => screen.unmount());
  h.writes.length = 0; h.calls.length = 0;
  await screen.press('予定を保存'); for (let i = 0; i < 4; i++) await screen.flush();
  assert.equal(saved, 1); assert.deepEqual((await readLocalCalendar(h.database)).events.find(row => row.id === h.id), source);
  assert.equal(h.writes.length, 0); assert.deepEqual(notifications, []); assert.equal(readCachedPlannerSnapshot(h.database), before);
  if (await personalCalendarHasPendingWork(h.database)) await h.sync.sync();
  assert.deepEqual(h.calls, [], 'an unchanged editor commit must not create demand for another Google read');
  await saveCalendarEvent(h.database, { id: h.id, expectedRevision: source.revision, value: { ...h.value, title: '変更した予定' } });
  assert.deepEqual(notifications, ['events']); assert.equal(await personalCalendarHasPendingWork(h.database), true);
  assert.equal(readCachedPlannerSnapshot(h.database), null); await h.sync.sync();
  assert.ok(h.calls.includes('patch')); assert.equal([...h.remote.values()].find(row => row.status !== 'cancelled').summary, '変更した予定');
  assert.equal(await personalCalendarHasPendingWork(h.database), false);
});

test('normalized identical Calendar content keeps both series and existing occurrence revisions without suppressing a first explicit override or cancellation restoration', async t => {
  const h = await fixture(t); const series = draft({ recurrence: 'weekly' });
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: series });
  const notifications = []; t.after(subscribeLocalCalendar(h.database, kind => notifications.push(kind)));
  h.writes.length = 0;
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, value: Object.fromEntries(Object.entries({ ...series, title: ` ${series.title} ` }).reverse()) });
  assert.equal(h.writes.length, 0); assert.deepEqual(notifications, []);
  const anchorDate = '2026-11-27', value = { ...series, startDate: anchorDate, endDate: anchorDate };
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate, expectedExceptionRevision: 0, value });
  assert.equal((await readLocalCalendar(h.database)).exceptions[0].revision, 1, 'the first explicit override retains its independent meaning');
  assert.deepEqual(notifications, ['events']); h.writes.length = 0; notifications.length = 0;
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate, expectedExceptionRevision: 1, value });
  assert.equal(h.writes.length, 0); assert.deepEqual(notifications, []);
  await deleteCalendarEvent(h.database, { id, expectedRevision: 1, anchorDate, expectedExceptionRevision: 1 });
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate, expectedExceptionRevision: 2, value });
  const exception = (await readLocalCalendar(h.database)).exceptions[0];
  assert.equal(exception.revision, 3); assert.ok(exception.override); assert.deepEqual(notifications, ['events', 'events']);
});

test('identical Calendar saves still reject stale series exceptions and current Google read-only authority before clearing drafts or reminders', async t => {
  const h = await synchronized(t); const pending = { eventId: h.id, anchorDate: null, revision: 1, exceptionRevision: 0, scope: 'series', value: h.value };
  await saveCalendarDraft(h.database, pending); h.writes.length = 0;
  await assert.rejects(saveCalendarEvent(h.database, { id: h.id, expectedRevision: 0, value: h.value, reminderMinutes: 10 }), /別の画面/);
  assert.equal(h.writes.length, 0); assert.equal((await readLocalCalendar(h.database)).draft.eventId, h.id);
  h.connection.exec('UPDATE calendar_google_links SET read_only=1');
  await assert.rejects(saveCalendarEvent(h.database, { id: h.id, expectedRevision: 1, value: h.value, reminderMinutes: 10 }), /Googleカレンダーで編集/);
  assert.equal(h.writes.length, 0); assert.deepEqual((await readCalendarReminders(h.database)).rules, []);
  const series = draft({ recurrence: 'weekly' }); const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: series });
  const anchorDate = '2026-11-27', value = { ...series, startDate: anchorDate, endDate: anchorDate };
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate, expectedExceptionRevision: 0, value });
  h.writes.length = 0;
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate, expectedExceptionRevision: 0, value }), /別の画面/);
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-28', expectedExceptionRevision: 0, value }), /別の画面/);
  assert.equal(h.writes.length, 0);
});

test('an unchanged Calendar body saves only changed private reminders clears its submitted draft and retains newer or shared drafts without event demand', async t => {
  const h = await fixture(t); const value = draft(); const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value });
  const submitted = { eventId: id, anchorDate: null, revision: 1, exceptionRevision: 0, scope: 'series', value, reminderMinutes: 10 };
  const shared = { ...submitted, audience: 'group', groupId: 'test-group' };
  await saveCalendarDraft(h.database, submitted); await saveCalendarDraft(h.database, shared);
  const changes = []; let reminders = 0;
  t.after(subscribeLocalCalendar(h.database, kind => changes.push(kind))); t.after(subscribeCalendarReminders(h.database, () => reminders++));
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, value, reminderMinutes: 10 });
  let current = await readLocalCalendar(h.database);
  assert.equal(current.events[0].revision, 1); assert.deepEqual(current.drafts, [shared]); assert.deepEqual(changes, ['drafts']);
  assert.equal(reminders, 1); assert.equal((await readCalendarReminders(h.database)).rules.find(row => row.eventId === id).minutes, 10);
  h.writes.length = 0; changes.length = 0;
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, value, reminderMinutes: 10 });
  assert.equal(h.writes.length, 0); assert.equal(reminders, 1); assert.deepEqual(changes, []);
  const newer = { ...submitted, value: { ...value, notes: '別の画面の新しい入力' } }; await saveCalendarDraft(h.database, newer); changes.length = 0;
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, value, reminderMinutes: null });
  current = await readLocalCalendar(h.database); assert.ok(current.drafts.some(row => row.value.notes === newer.value.notes));
  assert.ok(current.drafts.some(row => row.audience === 'group')); assert.equal(current.events[0].revision, 1);
  assert.equal((await readCalendarReminders(h.database)).rules.find(row => row.eventId === id).minutes, null); assert.equal(reminders, 2); assert.deepEqual(changes, []);
});

test('an unchanged Calendar save rolls back reminder and submitted-draft changes together and emits no premature notification', async t => {
  const h = await fixture(t); const value = draft(); const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value });
  const submitted = { eventId: id, anchorDate: null, revision: 1, exceptionRevision: 0, scope: 'series', value, reminderMinutes: 60 };
  await saveCalendarDraft(h.database, submitted);
  const before = await readLocalCalendar(h.database); const changes = []; let reminders = 0;
  t.after(subscribeLocalCalendar(h.database, kind => changes.push(kind))); t.after(subscribeCalendarReminders(h.database, () => reminders++));
  h.connection.exec("CREATE TRIGGER fail_draft_clear BEFORE DELETE ON calendar_drafts BEGIN SELECT RAISE(ABORT,'draft clear failed'); END");
  await assert.rejects(saveCalendarEvent(h.database, { id, expectedRevision: 1, value, reminderMinutes: 60 }), /draft clear failed/);
  assert.deepEqual(await readLocalCalendar(h.database), before); assert.deepEqual((await readCalendarReminders(h.database)).rules, []);
  assert.deepEqual(changes, []); assert.equal(reminders, 0);
});

test('an identical birthday body still restores the explicitly cleared own birthday with a monotonic revision', async t => {
  const h = await fixture(t); const input = { date: '2000-11-20', timeZone: 'UTC', expectedRevision: 0 };
  const id = await saveOwnBirthday(h.database, input); await deleteCalendarEvent(h.database, { id, expectedRevision: 1 });
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.equal(await saveOwnBirthday(h.database, input), id);
  const restored = (await readLocalCalendar(h.database)).events[0]; assert.equal(restored.id, id); assert.equal(restored.revision, 3);
});
