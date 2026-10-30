import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, projectCalendarEvents, validateEventDraft } from '../src/features/calendar/events.ts';
import { validateCustomRecurrence } from '../src/features/calendar/recurrence.ts';
const repository = await import('../src/platform/storage/repository.ts');
const storage = await import('../src/platform/storage/calendar-events.ts');
const iso = value => new Date(value).toISOString().slice(0, 10);
const dayMs = 86_400_000;

// Deliberately slow independent oracle: check every actual UTC civil date, rather than seeking into a series.
function enumerated(event, from, through) {
  const start = new Date(event.startDate + 'T00:00Z'); const result = [];
  for (let at = Date.parse(from + 'T00:00Z'); at <= Date.parse(through + 'T00:00Z'); at += dayMs) {
    const d = new Date(at); const date = iso(at); if (date < event.startDate || event.untilDate && date > event.untilDate) continue;
    const elapsed = (at - start.getTime()) / dayMs; const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
    const r = event.customRecurrence; let keep = false;
    switch (event.recurrence) {
      case 'daily': keep = true; break;
      case 'weekly': keep = elapsed % 7 === 0; break;
      case 'biweekly': keep = elapsed % 14 === 0; break;
      case 'monthly': keep = d.getUTCDate() === start.getUTCDate(); break;
      case 'yearly': keep = d.getUTCMonth() === start.getUTCMonth() && d.getUTCDate() === start.getUTCDate(); break;
      case 'custom':
        if (r.unit === 'day') keep = elapsed % r.interval === 0;
        if (r.unit === 'week') keep = Math.floor((elapsed + start.getUTCDay()) / 7) % r.interval === 0 && r.weekdays.includes(d.getUTCDay());
        if (r.unit === 'year') keep = months % (r.interval * 12) === 0 && d.getUTCDate() === start.getUTCDate();
        if (r.unit === 'month' && months % r.interval === 0) keep = r.on === 'date' ? d.getUTCDate() === start.getUTCDate()
          : d.getUTCDay() === r.weekday && (r.ordinal === -1 ? new Date(at + 7 * dayMs).getUTCMonth() !== d.getUTCMonth() : Math.ceil(d.getUTCDate() / 7) === r.ordinal);
    }
    if (keep) result.push(date);
  }
  return result;
}

test('calendar security independent civil-date oracle validates 2000 seeded recurrence and end-date combinations', () => {
  let seed = 0x5c3a2911; const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let n = 0; n < 2000; n++) {
    const start = iso(Date.UTC(2019 + random(8), random(12), 1 + random(31)));
    const from = iso(Date.parse(start) + random(2800) * dayMs); const through = iso(Date.parse(from) + (1 + random(100)) * dayMs);
    const recurrence = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom'][random(6)];
    const unit = ['day', 'week', 'month', 'year'][random(4)];
    const custom = { unit, interval: 1 + random(6), ...(unit === 'week' ? { weekdays: [...new Set([random(7), random(7)])] } : unit === 'month'
      ? random(2) ? { on: 'weekday', ordinal: [-1, 1, 2, 3, 4, 5][random(6)], weekday: random(7) } : { on: 'date' } : {}) };
    const value = validateEventDraft({ ...newEventDraft(start, 'Asia/Tokyo'), title: 'QA oracle', allDay: true, recurrence,
      untilDate: random(2) ? iso(Date.parse(start) + random(2900) * dayMs) : null, ...(recurrence === 'custom' ? { customRecurrence: custom } : {}) });
    const event = { ...value, id: 'oracle', revision: 1 }; const expected = enumerated(event, from, through);
    const actual = projectCalendarEvents([event], [], from, through);
    assert.deepEqual(actual.map(row => row.startDate), expected, JSON.stringify({ n, value, from, through }));
    assert.equal(new Set(actual.map(row => row.id)).size, actual.length);
    if (expected.length) {
      const anchorDate = expected[Math.floor(expected.length / 2)];
      assert.deepEqual(projectCalendarEvents([event], [{ eventId: event.id, anchorDate, override: null, revision: 1 }], from, through).map(row => row.startDate), expected.filter(date => date !== anchorDate));
    }
  }
});

test('calendar security hostile JSON SQL-like text and stale concurrent writes cannot alter protected data or prototype state', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database); await storage.readLocalCalendar(h.database);
  const before = await repository.loadPlannerSnapshot(h.database, '2026-10-31');
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const value = { ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: "'); DROP TABLE chores; -- <script>alert(1)</script>", allDay: true, ...hostile };
  const id = await storage.saveCalendarEvent(h.database, { expectedRevision: 0, value });
  assert.equal(Object.prototype.polluted, undefined); assert.equal(Object.hasOwn((await storage.readLocalCalendar(h.database)).events[0], '__proto__'), false);
  assert.equal((await storage.readLocalCalendar(h.database)).events[0].title, value.title);
  for (const key of ['__proto__', 'constructor', 'toString', 'prototype']) {
    await assert.rejects(storage.saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...value, recurrence: key } }));
    assert.throws(() => validateCustomRecurrence({ unit: key, interval: 1 }));
  }
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => storage.saveCalendarEvent(h.database, { id, expectedRevision: 1, value: { ...value, title: `race-${n}` } })));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter(row => row.status === 'rejected').every(row => /別の画面/.test(row.reason.message)));
  assert.equal((await storage.readLocalCalendar(h.database)).events[0].revision, 2);
  const after = await repository.loadPlannerSnapshot(h.database, '2026-10-31');
  for (const name of ['chores', 'states', 'completions', 'wasteSchedules']) assert.deepEqual(after[name], before[name]);
  assert.equal(h.connection.prepare('SELECT count(*) AS n FROM google_task_links').get().n, 0);
  assert.equal(h.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
