import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readCalendarEventRows, readCalendarEventRowsPage, CalendarHistoryLimitError } = await import('../src/platform/storage/calendar-event-rows.ts');
const { createLocalCalendarAvailability } = await import('../src/features/calendar/private-availability.ts');
const { initializePersonalGoogleCalendar } = await import('../src/platform/storage/personal-google-calendar.ts');

test('calendar display-range reads skip large saved history and retain moved exceptions whose anchor is outside the range', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const insert = h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)');
  const past = { ...newEventDraft('1990-01-01', 'Asia/Tokyo'), title: '過去の保存予定', allDay: true };
  const pastJson = JSON.stringify(past);
  h.connection.exec('BEGIN');
  for (let i = 0; i < 10_001; i++) insert.run(`history.${String(i).padStart(5, '0')}`, pastJson);
  const current = { ...newEventDraft('2026-11-14', 'Asia/Tokyo'), title: '今月の予定', allDay: true };
  insert.run('current', JSON.stringify(current));
  const series = { ...newEventDraft('2026-10-01', 'Asia/Tokyo'), title: '個別回あり', allDay: true, recurrence: 'daily', untilDate: '2026-10-31' };
  insert.run('series', JSON.stringify(series));
  h.connection.prepare('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,1)')
    .run('series', '2026-10-30', JSON.stringify({ ...series, title: '移動した個別回', startDate: '2026-11-15', endDate: '2026-11-15', recurrence: 'none', untilDate: null }));
  h.connection.exec('COMMIT');

  const range = { from: '2026-11-01', through: '2026-11-30' };
  const rows = await readCalendarEventRows(h.database, range);
  assert.deepEqual(rows.events.map(row => row.id), ['current', 'series']);
  assert.deepEqual(rows.exceptions.map(row => row.anchorDate), ['2026-10-30']);
  assert.deepEqual(projectCalendarEvents(rows.events, rows.exceptions, range.from, range.through).map(row => row.title), ['今月の予定', '移動した個別回']);
  const tapped = await readCalendarEventRows(h.database, undefined, { eventId: 'series', anchorDate: '2026-10-30' });
  assert.deepEqual(tapped.events.map(row => row.id), ['series'], 'a delivered notification resolves by stable event ID after it moves outside the old displayed date');
  assert.deepEqual(tapped.exceptions.map(row => row.anchorDate), ['2026-10-30'], 'target reads include only that event’s original-anchor exception');
  const page = await readCalendarEventRowsPage(h.database, 'history.10000');
  assert.deepEqual(page.events.map(row => row.id), ['series'], 'explicit search can page beyond the visible-range projection');
  assert.deepEqual(page.exceptions.map(row => row.anchorDate), ['2026-10-30'], 'a history page keeps the moved override with its parent');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_events WHERE deleted=0').get().n, 10_003, 'range reads retain every historical source row');
  await assert.rejects(readCalendarEventRows(h.database), CalendarHistoryLimitError, 'unbounded direct reads keep the typed history limit');
});

test('display-range reads pad neighboring civil dates for New York events and moved overrides blocking Tokyo', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const insert = h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)');
  const late = { ...newEventDraft('2026-11-02', 'America/New_York'), title: 'New York late event', allDay: false,
    startMinute: 23 * 60 + 30, endDate: '2026-11-03', endMinute: 30 };
  insert.run('late', JSON.stringify(late));
  const series = { ...newEventDraft('2026-11-02', 'America/New_York'), title: 'New York series', allDay: false,
    startMinute: 9 * 60, endMinute: 10 * 60, recurrence: 'daily', untilDate: '2026-11-10' };
  insert.run('series', JSON.stringify(series));
  h.connection.prepare('INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,1)')
    .run('series', '2026-11-02', JSON.stringify({ ...series, title: 'Moved late override', startMinute: 23 * 60 + 30,
      endDate: '2026-11-03', endMinute: 30, recurrence: 'none', untilDate: null }));

  const range = { from: '2026-11-03', through: '2026-11-03' };
  const rows = await readCalendarEventRows(h.database, range);
  assert.deepEqual(rows.events.map(row => row.id), ['late', 'series']);
  assert.deepEqual(rows.exceptions.map(row => row.anchorDate), ['2026-11-02']);
  const availability = createLocalCalendarAvailability(rows.events, rows.exceptions, range, 'Asia/Tokyo');
  const blocked = availability({ precision: 'interval', start: '2026-11-03T04:30:00Z', end: '2026-11-03T05:00:00Z' });
  assert.equal(blocked.conflict.kind, 'conflict', 'both previous-civil-day sources resolve into the viewed Tokyo day');
});

test('bounded Google metadata reads probe indexed occurrence keys without copying the original provider payload', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  await initializePersonalGoogleCalendar(h.database);
  h.connection.prepare('INSERT INTO calendar_google_control(singleton,control_json) VALUES(1,?)').run(JSON.stringify({
    subject: 'self-test', calendars: [{ id: 'owned', accessRole: 'owner' }],
  }));
  const event = h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)');
  const link = h.connection.prepare('INSERT INTO calendar_google_links(subject,calendar_id,google_id,event_id,remote_json) VALUES(?,?,?,?,?)');
  const insert = (id, date, subject) => {
    event.run(id, JSON.stringify({ ...newEventDraft(date, 'Asia/Tokyo'), title: '読込テスト' }));
    link.run(subject, 'owned', id, id, JSON.stringify({ transparency: 'transparent', description: '保存元データ'.repeat(128) }));
  };
  h.connection.exec('BEGIN');
  for (let i = 0; i < 1_600; i++) insert(`test.${i}`, i < 800 ? '2026-11-14' : '2026-10-14', 'self-test');
  insert('other-account', '2026-11-14', 'previous-test'); h.connection.exec('COMMIT');
  const get = h.database.getAllAsync; let inspected = false;
  h.database.getAllAsync = async (sql, ...params) => {
    const result = await get(sql, ...params);
    if (sql.includes('AS html_link')) {
      inspected = true;
      assert.equal(result.length, 800);
      assert.ok(result.every(row => !Object.hasOwn(row, 'remote_json')));
      const queries = h.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
      assert.ok(queries.some(detail => /SEARCH l USING .*event_id=\? AND anchor_date=\?/u.test(detail)), queries.join(' / '));
    }
    return result;
  };
  const rows = await readCalendarEventRows(h.database, { from: '2026-11-01', through: '2026-11-30' });
  assert.ok(inspected);
  assert.equal(rows.events.length, 800);
  assert.ok(rows.events.every(row => row.blocksTime === false && row.readOnly === false));
});
