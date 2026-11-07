import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { createLocalCalendarAvailability } from '../src/features/calendar/private-availability.ts';
import { localCalendarIntervals } from '../src/features/calendar/local-availability.ts';
import { googleImportedEvent } from '../src/features/calendar/google-event-import.ts';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarEvent, saveCalendarDraft, clearCalendarEditorDraft } = await import('../src/platform/storage/calendar-events.ts');
const event = patch => ({ ...newEventDraft('2026-03-01', 'America/Havana'), title: '予定', id: 'qa', revision: 1, ...patch });

test('Google timed recurrence cutoff uses the actual next civil-day boundary across midnight gaps and folds', () => {
  const body = googleEventBody(event({ recurrence: 'daily', untilDate: '2026-03-07' }));
  assert.deepEqual(body.recurrence, ['RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20260308T045959Z']);
  const folded = googleEventBody(event({ startDate: '2026-10-01', endDate: '2026-10-01', recurrence: 'daily', untilDate: '2026-10-31' }));
  assert.deepEqual(folded.recurrence, ['RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261101T035959Z']);
});

test('shared local availability counts all-day midnight transitions as actual busy coverage', () => {
  const read = createLocalCalendarAvailability([event({ allDay: true, startDate: '2026-03-08', endDate: '2026-03-08' })], [],
    { from: '2026-03-08', through: '2026-03-08' }, 'America/Havana');
  assert.deepEqual(read({ precision: 'interval', start: '2026-03-08T05:00:00Z', end: '2026-03-09T04:00:00Z' }),
    { conflict: { kind: 'conflict' }, busyMinutes: 23 * 60 });
});

test('personal placement never treats an unresolved recurring DST clock as an entirely free day', () => {
  const rows = [event({ timeZone: 'America/New_York', startMinute: 150, endMinute: 210, recurrence: 'weekly' })];
  const busy = localCalendarIntervals(rows, [], '2026-03-08', '2026-03-08', 'America/New_York');
  assert.ok(busy.some(span => span.start <= Date.parse('2026-03-08T07:00:00Z') && span.end >= Date.parse('2026-03-08T07:30:00Z')));
});

test('bulk Google import reuses bounded clock formatters without changing imported fields', () => {
  const Original = Intl.DateTimeFormat; let constructions = 0;
  Intl.DateTimeFormat = function (...args) { if (args[1]?.hourCycle === 'h23') constructions++; return new Original(...args); };
  try {
    const remote = { summary: '予定', start: { dateTime: '2026-06-01T09:00:00+02:00', timeZone: 'Europe/Paris' },
      end: { dateTime: '2026-06-01T10:00:00+02:00', timeZone: 'Europe/Paris' } };
    for (let i = 0; i < 100; i++) {
      const row = googleImportedEvent(remote, 'personal');
      assert.equal(row.startMinute, 540); assert.equal(row.endMinute, 600); assert.equal(row.startDate, '2026-06-01');
    }
    assert.ok(constructions <= 1, `clock formatter constructions: ${constructions}`);
  } finally { Intl.DateTimeFormat = Original; }
});

test('calendar display metadata does not transfer complete Google event bodies into JavaScript on every read', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const { initializePersonalGoogleCalendar } = await import('../src/platform/storage/personal-google-calendar.ts');
  await initializePersonalGoogleCalendar(h.database);
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value: event({ timeZone: 'Asia/Tokyo' }) });
  h.connection.prepare('INSERT INTO calendar_google_control(singleton,control_json) VALUES(1,?)').run(JSON.stringify({ subject: 'owner', calendars: [{ id: 'primary', accessRole: 'reader' }] }));
  h.connection.prepare(`INSERT INTO calendar_google_links(subject,calendar_id,google_id,event_id,anchor_date,read_only,active,remote_json) VALUES('owner','primary','g',?,'',1,1,?)`).run(id, JSON.stringify({ transparency: 'transparent', description: 'x'.repeat(4000), htmlLink: 'https://calendar.google.com/calendar/event?eid=qa' }));
  const original = h.database.getAllAsync; let transferred = 0;
  h.database.getAllAsync = async function (...args) {
    const rows = await original.apply(this, args);
    if (args[0].includes('FROM calendar_google_links l')) transferred += Buffer.byteLength(JSON.stringify(rows));
    return rows;
  };
  const row = (await readLocalCalendar(h.database)).events[0];
  assert.equal(row.blocksTime, false); assert.equal(row.readOnly, true); assert.ok(row.externalUrl);
  assert.ok(transferred < 750, `metadata transfer bytes: ${transferred}`);
});

test('explicit calendar draft discard cannot delete newer input saved by another editor', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const draft = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: event({ title: '古い入力' }) };
  await saveCalendarDraft(h.database, draft);
  await saveCalendarDraft(h.database, { ...draft, value: { ...draft.value, title: '新しい入力' } });
  await assert.rejects(clearCalendarEditorDraft(h.database, draft), /別の画面/);
  assert.equal((await readLocalCalendar(h.database)).draft.value.title, '新しい入力');
});
