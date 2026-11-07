import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { initializePersonalGoogleCalendar } = await import('../src/platform/storage/personal-google-calendar.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { listPersonalGoogleItems, receivePersonalGoogleEvent } = await import('../src/platform/storage/personal-google-store.ts');
async function context(t) { const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database); await initializePersonalGoogleCalendar(h.database); return h; }
const calendar = { id: 'owned', summary: 'Google', accessRole: 'owner', timeZone: 'UTC' };
const control = { subject: 'owner', calendars: [calendar], targetCalendarId: 'owned' };
const event = n => ({ id: `event-${n}`, etag: '"v1"', summary: 'appointment', start: { date: '2026-11-07' }, end: { date: '2026-11-08' } });

test('audit50 a read only Google connection never loads unlinked personal events into an unusable export inventory', async t => {
  const h = await context(t); const value = { ...newEventDraft('2026-11-07', 'UTC'), title: 'local' };
  for (let n = 0; n < 10001; n++) h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)').run(`local-${n}`, JSON.stringify(value));
  assert.deepEqual(await listPersonalGoogleItems(h.database, { ...control, targetCalendarId: null, calendars: [{ ...calendar, accessRole: 'reader' }] }), []);
});

test('audit50 updating saved Google appointments preserves their category without repeating discarded category creation', async t => {
  const h = await context(t); for (let n = 0; n < 100; n++) await receivePersonalGoogleEvent(h.database, control, calendar, event(n));
  const before = h.writes.length;
  for (let n = 0; n < 100; n++) await receivePersonalGoogleEvent(h.database, control, calendar, { ...event(n), etag: '"v2"', summary: 'changed' });
  assert.equal(h.writes.slice(before).filter(row => row.sql?.includes('INSERT OR IGNORE INTO calendar_categories')).length, 0);
});

test('audit50 identical Calendar echoes do not rewrite a hundred unchanged local link rows', async t => {
  const h = await context(t); for (let n = 0; n < 100; n++) await receivePersonalGoogleEvent(h.database, control, calendar, event(n));
  const before = h.writes.length;
  for (let n = 0; n < 100; n++) assert.equal(await receivePersonalGoogleEvent(h.database, control, calendar, event(n)), 'unchanged');
  assert.equal(h.writes.slice(before).filter(row => row.sql?.includes('INSERT INTO calendar_google_links')).length, 0);
});
