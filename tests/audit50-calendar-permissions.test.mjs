import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { projectPrivateCalendarEvents } from '../src/features/calendar/private-event-projection.ts';
import { GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { saveCalendarEvent, deleteCalendarEvent, readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { connectPersonalGoogleCalendar, readPersonalGoogleCalendarControl } = await import('../src/platform/storage/personal-google-calendar.ts');
const { writePersonalGoogleLink } = await import('../src/platform/storage/personal-google-store.ts');
const { createPersonalGoogleCalendarSync } = await import('../src/features/calendar/personal-google-sync.ts');
const owned = { id: 'owned', summary: 'personal', accessRole: 'owner', primary: true, timeZone: 'UTC' };
async function setup(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  const control = await readPersonalGoogleCalendarControl(h.database); await connectPersonalGoogleCalendar(h.database, control.generation, 'owner', [owned], 'owned');
  return h;
}

test('audit50 a locked Google exception does not block editing a different occurrence and its own lock remains visible', async t => {
  const h = await setup(t); const value = { ...newEventDraft('2026-11-07', 'UTC'), title: 'weekly', recurrence: 'weekly' };
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value });
  const parent = { subject: 'owner', calendar_id: 'owned', google_id: 'master', event_id: id, anchor_date: '', etag: '"parent"', base_json: '{}', local_revision: 1, remote_json: '{}', conflict_json: null, read_only: 0 };
  await writePersonalGoogleLink(h.database, parent);
  await writePersonalGoogleLink(h.database, { ...parent, google_id: 'locked-instance', anchor_date: '2026-11-14', read_only: 1, remote_json: JSON.stringify({ locked: true, htmlLink: 'https://calendar.google.com/calendar/event?eid=locked' }) });
  const exceptional = { ...value, startDate: '2026-11-14', endDate: '2026-11-14', recurrence: 'none' };
  h.connection.prepare('INSERT INTO calendar_event_exceptions VALUES(?,?,?,1)').run(id, '2026-11-14', JSON.stringify(exceptional));
  await assert.doesNotReject(saveCalendarEvent(h.database, { id, expectedRevision: 1, expectedExceptionRevision: 0, scope: 'one', anchorDate: '2026-11-21', value: { ...value, startDate: '2026-11-21', endDate: '2026-11-21', title: 'allowed occurrence' } }));
  await assert.rejects(deleteCalendarEvent(h.database, { id, expectedRevision: 1, expectedExceptionRevision: 1, anchorDate: '2026-11-14' }), /Google/u);
  const saved = await readLocalCalendar(h.database); const rows = projectPrivateCalendarEvents(saved.events, saved.exceptions, '2026-11-14', '2026-11-21');
  const locked = rows.find(row => row.anchorDate === '2026-11-14');
  assert.equal(locked.readOnly, true); assert.equal(locked.externalUrl, 'https://calendar.google.com/calendar/event?eid=locked');
  assert.notEqual(rows.find(row => row.anchorDate === '2026-11-21').readOnly, true);
});

test('audit50 unsupported recurring Calendar instances recover an expired400 page while retaining the imported prefix', async t => {
  const h = await setup(t); let failed = false; let pageCalls = 0;
  const remote = { id: 'series', etag: '"series"', summary: 'complex recurring', recurrence: ['RRULE:FREQ=DAILY;COUNT=10'], start: { date: '2026-11-07' }, end: { date: '2026-11-08' } };
  const item = { id: 'instance', etag: '"one"', summary: 'kept', recurringEventId: 'series', originalStartTime: { date: '2026-11-07' }, start: { date: '2026-11-07' }, end: { date: '2026-11-08' } };
  const api = { calendars: async () => ({ items: [owned] }), events: async () => ({ items: [remote], nextSyncToken: 'delta' }), instances: async (_id, _parent, range) => {
    pageCalls++; if (range.pageToken && !failed) { failed = true; throw new GoogleCalendarHttpError(400); }
    return range.pageToken ? { items: [] } : { items: [item], nextPageToken: 'expired' };
  } };
  const sync = createPersonalGoogleCalendarSync({ database: h.database, currentSubject: async () => 'owner', authorize: async () => ({ subject: 'owner', label: 'QA' }), createApi: () => api, today: () => '2026-11-07' });
  await sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events.filter(row => row.title === 'kept').length, 1);
  const position = h.connection.prepare('SELECT page_token FROM calendar_google_expansion').get();
  assert.equal(position.page_token, null, 'expired instance page must be retired without discarding its full range');
  api.events = async () => ({ items: [], nextSyncToken: 'after' });
  const before = pageCalls; await sync.sync({ force: true });
  assert.ok(pageCalls - before >= 2, 'recovery starts from the first instance page');
  assert.equal(h.connection.prepare('SELECT active FROM calendar_google_expansion').get().active, 0);
});
