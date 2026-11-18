import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { privateCalendarReadOnlySource, canEditPrivateCalendarEvent } from '../src/features/calendar/private-event-projection.ts';
const { readLocalCalendar, saveCalendarDraft, saveCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readCalendarReminders, saveCalendarReminder, subscribeCalendarReminders } = await import('../src/platform/storage/calendar-reminders.ts');

const day = '2026-11-19';
const draft = (value, fields = {}) => ({ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value, ...fields });
const flush = async screen => { for (let i = 0; i < 12; i++) await screen.flush(); };

async function setup(t) {
  const db = createDatabase();
  t.after(() => db.connection.close());
  await initializeLocalDatabase(db.database);
  return db;
}

test('a personal series change moves individual notification rules and informs subscribers even without event exceptions', async t => {
  const db = await setup(t);
  const value = { ...newEventDraft(day, 'Asia/Tokyo'), title: '週の予定', recurrence: 'weekly' };
  const id = await saveCalendarEvent(db.database, { expectedRevision: 0, value });
  await saveCalendarReminder(db.database, { scope: 'personal', eventId: id, anchorDate: '2026-11-26', minutes: 10 });
  let updates = 0;
  t.after(subscribeCalendarReminders(db.database, () => { updates++; }));
  await saveCalendarEvent(db.database, { id, expectedRevision: 1, value: { ...value, startDate: '2026-11-20', endDate: '2026-11-20' } });
  assert.deepEqual((await readCalendarReminders(db.database)).rules, [{ scope: 'personal', eventId: id, anchorDate: '2026-11-27', minutes: 10 }]);
  assert.equal(updates, 1);
});

test('calendar edit authority indexes an observed snapshot and rebuilds when links change', () => {
  let reads = 0;
  const events = Array.from({ length: 400 }, (_, index) => ({ ...newEventDraft(day, 'UTC'), revision: 1,
    get id() { reads++; return `e${index}`; }, readOnly: index === 399 }));
  const exceptions = Array.from({ length: 400 }, (_, index) => ({ anchorDate: day, override: null, revision: 1,
    get eventId() { reads++; return `e${index}`; }, readOnly: index === 398 }));
  const snapshot = { events, exceptions };
  for (let attempt = 0; attempt < 70; attempt++) {
    assert.equal(privateCalendarReadOnlySource(snapshot, 'e399', day), events[399]);
    assert.equal(privateCalendarReadOnlySource(snapshot, 'e398', day), exceptions[398]);
    assert.ok(canEditPrivateCalendarEvent(snapshot, 'e397', day));
  }
  assert.ok(reads < events.length * 6, `too many snapshot reads (${reads})`);
  assert.ok(canEditPrivateCalendarEvent({ ...snapshot, exceptions: [] }, 'e398', day));
  assert.equal(canEditPrivateCalendarEvent({ ...snapshot, events: [...events, { ...events[0], id: 'new', readOnly: true }] }, 'new', day), false);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} a resumed edited appointment rolls back on draft cleanup failure and saves exactly once on retry`, async t => {
    const db = await setup(t);
    await saveCalendarDraft(db.database, draft({ ...newEventDraft(day, 'Asia/Tokyo'), title: '入力中' }));
    const snapshot = await readLocalCalendar(db.database);
    const saved = [];
    const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { platform, exportName: 'CalendarEditor', database: db.database, props: {
      initial: snapshot.draft, local: { database: db.database, snapshot, refresh: async () => {} }, onClose() {}, onSaved: date => saved.push(date),
    } });
    t.after(() => screen.unmount());
    await screen.change('予定名', '更新した予定');
    const run = db.database.runAsync;
    let fail = true;
    db.database.runAsync = async (sql, ...args) => {
      if (fail && sql.startsWith('DELETE FROM calendar_drafts')) { fail = false; throw new Error('下書きを整理できませんでした'); }
      return run(sql, ...args);
    };
    await screen.press('予定を保存'); await flush(screen);
    assert.equal(fail, false);
    assert.equal((await readLocalCalendar(db.database)).events.length, 0);
    assert.equal((await readLocalCalendar(db.database)).draft.value.title, '入力中');
    assert.deepEqual(saved, []);
    await screen.press('予定を保存'); await flush(screen);
    const current = await readLocalCalendar(db.database);
    assert.deepEqual(current.events.map(row => row.title), ['更新した予定']);
    assert.equal(current.draft, null);
    assert.deepEqual(saved, [day]);
  });

  test(`${platform} a saved appointment returns to its display-zone day and a birthday returns to the opened occurrence`, async t => {
    const db = await setup(t);
    for (const { value, opened, expected } of [
      { value: { ...newEventDraft('2026-11-18', 'America/New_York'), title: '別の地域', startMinute: 1380, endMinute: 1410 }, opened: '2026-11-18', expected: day },
      { value: { ...newEventDraft('1988-11-19', 'Asia/Tokyo', true), title: '誕生日' }, opened: day, expected: day },
    ]) {
      const id = await saveCalendarEvent(db.database, { expectedRevision: 0, value });
      const snapshot = await readLocalCalendar(db.database);
      const saved = [];
      const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { platform, exportName: 'CalendarEditor', database: db.database, props: {
        initial: draft(value, { eventId: id, anchorDate: opened, revision: 1 }), displayTimeZone: 'Asia/Tokyo',
        local: { database: db.database, snapshot, refresh: async () => {} }, onClose() {}, onSaved: date => saved.push(date),
      } });
      try {
        await screen.press('予定を保存'); await flush(screen);
        assert.deepEqual(saved, [expected]);
        assert.equal((await readLocalCalendar(db.database)).events.find(row => row.id === id).startDate, value.startDate);
      } finally { screen.unmount(); }
    }
  });
}
