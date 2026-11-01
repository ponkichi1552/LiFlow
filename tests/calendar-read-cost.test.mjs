import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');

test('unchanged Calendar rows avoid repeated timezone validation while raw edits same-revision corruption and caller mutations remain observable', async () => {
  const h = createDatabase(), other = createDatabase(); const NativeFormatter = Intl.DateTimeFormat; let validations = 0;
  try {
    await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
    await initializeLocalDatabase(other.database); await readLocalCalendar(other.database);
    const value = { ...newEventDraft('2026-11-01', 'Asia/Tokyo'), title: 'Synthetic', recurrence: 'custom', customRecurrence: { unit: 'week', interval: 2, weekdays: [0, 1] } };
    const insert = h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)');
    for (let n = 0; n < 1000; n++) insert.run(`event.${n}`, JSON.stringify(value));
    Intl.DateTimeFormat = new Proxy(NativeFormatter, { construct(target, args) { validations++; return Reflect.construct(target, args); } });
    const first = await readLocalCalendar(h.database); assert.equal(validations, 1000); validations = 0;
    first.events[0].customRecurrence.weekdays.push(6); first.events[0].title = 'mutable caller';
    for (let n = 0; n < 5; n++) { const next = await readLocalCalendar(h.database); assert.equal(next.events[0].title, value.title); assert.deepEqual(next.events[0].customRecurrence.weekdays, [0, 1]); }
    assert.equal(validations, 0);
    h.connection.prepare('UPDATE calendar_events SET definition_json=? WHERE id=?').run(JSON.stringify({ ...value, title: 'same revision edit' }), 'event.0');
    assert.equal((await readLocalCalendar(h.database)).events[0].title, 'same revision edit'); assert.equal(validations, 1);
    h.connection.prepare('UPDATE calendar_events SET definition_json=? WHERE id=?').run('{invalid', 'event.0');
    await assert.rejects(readLocalCalendar(h.database));
    h.connection.prepare('UPDATE calendar_events SET definition_json=? WHERE id=?').run(JSON.stringify(value), 'event.0');
    assert.equal((await readLocalCalendar(h.database)).events[0].title, value.title);
    other.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)').run('event.0', JSON.stringify({ ...value, title: 'other database' }));
    assert.equal((await readLocalCalendar(other.database)).events[0].title, 'other database');
    h.connection.prepare('UPDATE calendar_events SET deleted=1 WHERE id=?').run('event.0'); assert.equal((await readLocalCalendar(h.database)).events.length, 999);
  } finally { Intl.DateTimeFormat = NativeFormatter; h.connection.close(); other.connection.close(); }
});

test('calendar projection indexes unrelated exceptions once and preserves moved anchors at high volume', () => {
  let reads = 0;
  const events = Array.from({ length: 1000 }, (_, i) => ({ ...newEventDraft('2026-11-01', 'UTC'), title: 'Synthetic', allDay: true, id: `event.${i}`, revision: 1 }));
  const exceptions = Array.from({ length: 20000 }, (_, i) => ({ get eventId() { reads++; return `unrelated.${i}`; }, anchorDate: '2026-11-01', override: null, revision: 1 }));
  exceptions.push({ eventId: 'event.0', anchorDate: '2026-11-01', override: { ...events[0], startDate: '2026-11-02', endDate: '2026-11-02' }, revision: 1 });
  const rows = projectCalendarEvents(events, exceptions, '2026-11-01', '2026-11-03');
  assert.equal(rows.length, 1000); assert.equal(rows.find(row => row.eventId === 'event.0').startDate, '2026-11-02');
  assert.ok(reads <= exceptions.length * 5, `exception accesses must be linear, observed ${reads}`);
});
