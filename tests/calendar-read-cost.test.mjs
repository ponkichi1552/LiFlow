import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { v2CalendarProjection } from '../src/features/sharing/v2-ui/calendar-projection.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { fixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { addDays } from '../src/domain/scheduling/local-date.ts';
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

test('shared calendar reuses collation within each projection while preserving native ID order counts and input', async () => {
  const f = await fixture(); const d = await f.device();
  const NativeCollator = Intl.Collator; const nativeCompare = String.prototype.localeCompare;
  try {
    await d.repository.commit(seeds());
    const controller = createV2GroupController(d.repository, { makeId: () => 'read-cost', now, sync: async () => {} });
    const model = await controller.readModel({ from: '2026-10-01', through: '2026-10-31', asOfDate: '2026-10-27' });
    const template = model.plan.occurrences[0]; assert.ok(template);
    model.plan.range = { from: '2026-10-01', through: '2027-03-29', asOfDate: '2026-10-27' };
    const ids = ['a.2', 'a_10', 'A-1', 'Z.2', 'a-2', 'z_10'];
    model.plan.occurrences = Array.from({ length: 180 }, (_, day) => ids.map((id, index) => {
      const date = addDays('2026-10-01', day);
      return { ...template, id: `round.${day}.${id}`, choreId: `chore.${index}`, anchorDate: date,
        subjects: [{ ...template.subjects[0], id, suggestedDate: date, executionWindowStart: date, executionWindowEnd: date }] };
    })).flat();
    const before = JSON.stringify(model); const expected = [...ids].sort((a, b) => nativeCompare.call(a, b));
    let constructions = 0; let individualComparisons = 0;
    Intl.Collator = new Proxy(NativeCollator, { construct(target, args) { constructions++; return Reflect.construct(target, args); } });
    String.prototype.localeCompare = function (...args) { individualComparisons++; return nativeCompare.apply(this, args); };
    for (let run = 1; run <= 2; run++) {
      const value = v2CalendarProjection(model);
      assert.equal(value.byDate.size, 180);
      for (const [date, rows] of value.byDate) { assert.deepEqual(rows.map(row => row.id), expected); assert.equal(value.counts.get(date), ids.length); }
      assert.equal(constructions, run, 'a synchronous projection reuses its comparator without retaining the previous invocation locale');
    }
    assert.equal(individualComparisons, 0, 'native localeCompare must not construct a collator for each ID comparison');
    assert.equal(JSON.stringify(model), before);
  } finally { Intl.Collator = NativeCollator; String.prototype.localeCompare = nativeCompare; d.connection.close(); }
});

test('home projection of a warmed wide calendar builds only its visible weeks with identical dates completion choices and counts', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    const controller = createV2GroupController(d.repository, { makeId: () => 'home-cost', now, sync: async () => {} });
    const model = await controller.readModel({ from: '2026-10-01', through: '2027-03-29', asOfDate: '2026-10-27' });
    const template = model.plan.occurrences[0]; assert.ok(template);
    model.plan.occurrences = Array.from({ length: 6 }, (_, index) => ({ ...template, id: `wide.${index}`, choreId: `chore.${index}`,
      subjects: [{ ...template.subjects[0], id: `subject.${index}`, suggestedDate: '2026-10-28', executionWindowStart: '2026-10-01', executionWindowEnd: '2027-03-29' }] }));
    const before = JSON.stringify(model); const range = { from: '2026-10-27', through: '2026-11-08' };
    for (const recommendedOnly of [false, true]) for (const values of [undefined, new Map([['shared:subject.0', true]])]) {
      const full = v2CalendarProjection(model, undefined, values, recommendedOnly);
      const Original = globalThis.Date; let dates = 0;
      globalThis.Date = class extends Original { constructor(...args) { super(...args); dates++; } };
      let part;
      try { part = v2CalendarProjection(model, undefined, values, recommendedOnly, range); }
      finally { globalThis.Date = Original; }
      assert.deepEqual([...part.byDate], [...full.byDate].filter(([date]) => date >= range.from && date <= range.through));
      assert.deepEqual([...part.counts], [...full.counts].filter(([date]) => date >= range.from && date <= range.through));
      assert.ok(dates < 200, `home must not expand the entire cached calendar, observed ${dates}`);
      assert.equal(JSON.stringify(model), before);
    }
  } finally { d.connection.close(); }
});
