import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { createPersonalGoogleCalendarSync } = await import('../src/features/calendar/personal-google-sync.ts');
const { refreshPersonalGoogleCalendars } = await import('../src/platform/storage/personal-google-calendar.ts');
const owned = { id: 'owned', summary: '個人', primary: true, accessRole: 'owner', timeZone: 'Asia/Tokyo' };
const remote = (id, extra = {}) => ({ id, etag: '"version"', summary: '予定', updated: '2026-11-07T02:00:00Z', start: { date: '2026-11-08' }, end: { date: '2026-11-09' }, ...extra });
async function setup(t) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  const api = { calendars: async () => ({ items: [owned] }), events: async () => ({ items: [], nextSyncToken: 'next' }), instances: async () => ({ items: [] }) };
  const makeSync = () => createPersonalGoogleCalendarSync({ database: h.database, currentSubject: async () => 'account', authorize: async () => ({ subject: 'account', label: 'QA' }), createApi: () => api, today: () => '2026-11-07', now: () => Date.parse('2026-11-07T03:00:00Z'), random: () => .5 });
  const sync = makeSync();
  return { ...h, api, sync, makeSync, async connect() { return sync.connect(await sync.prepareConnection()); } };
}

test('audit100 repeated CalendarList rows across pages do not block connection or duplicate synchronization', async t => {
  const h = await setup(t); let calendarsRead = 0;
  h.api.calendars = async page => { calendarsRead++; return page ? { items: [{ ...owned, summary: '更新後' }] } : { items: [owned], nextPageToken: 'second' }; };
  const review = await h.sync.prepareConnection();
  assert.equal(review.calendars.length, 1); assert.equal(review.calendars[0].summary, '更新後');
  await h.sync.connect(review);
  let received = 0; h.api.events = async () => { received++; return { items: [], nextSyncToken: 'next' }; };
  assert.equal((await h.sync.sync()).kind, 'success'); assert.equal(received, 1); assert.equal(calendarsRead, 4);
});

test('audit100 refreshing a thousand Google calendars stays below Android SQLite variable limits', async t => {
  const h = await setup(t); const control = await h.connect();
  const calendars = [owned, ...Array.from({ length: 999 }, (_, n) => ({ id: `calendar-${n}`, summary: '共有', accessRole: 'reader' }))];
  const run = h.database.runAsync; let largest = 0;
  h.database.runAsync = async (sql, ...params) => { largest = Math.max(largest, params.length); assert.ok(params.length <= 999, `SQLite variables: ${params.length}`); return run(sql, ...params); };
  const refreshed = await refreshPersonalGoogleCalendars(h.database, control, calendars);
  assert.equal(refreshed.control.calendars.length, 1000); assert.ok(largest <= 999);
});

test('audit100 staging one hundred Calendar changes uses bounded SQLite batches rather than one bridge call per event', async t => {
  const h = await setup(t); await h.connect(); const events = Array.from({ length: 100 }, (_, n) => remote(`event-${n}`));
  h.api.events = async () => ({ items: events, nextSyncToken: 'next' }); h.writes.length = 0;
  await h.sync.sync();
  const writes = h.writes.filter(row => /^INSERT INTO calendar_google_inbox\([^]*?\) VALUES/u.test(row.sql));
  assert.ok(writes.length <= 2, `inbox bridge writes: ${writes.length}`);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox').get().n, 100);
  assert.ok(writes.every(row => row.params.length <= 999));
});

test('audit100 a delayed older Calendar version cannot roll back an imported personal event', async t => {
  const h = await setup(t); await h.connect();
  h.api.events = async () => ({ items: [remote('one', { summary: '新しい内容', updated: '2026-11-07T02:50:00Z', etag: '"new"' })], nextSyncToken: 'latest' });
  assert.equal((await h.sync.sync()).kind, 'success');
  h.api.events = async () => ({ items: [remote('one', { summary: '古い内容', updated: '2026-11-07T02:00:00Z', etag: '"old"' })], nextSyncToken: 'after-old' });
  assert.equal((await h.sync.sync()).kind, 'success');
  assert.equal((await readLocalCalendar(h.database)).events[0].title, '新しい内容');
  assert.equal(JSON.parse(h.connection.prepare('SELECT remote_json FROM calendar_google_links').get().remote_json).etag, '"new"');
});

test('audit100 listing a thousand changed local Google events does not reread their master one by one', async t => {
  const h = await setup(t); const control = await h.connect();
  const { saveCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
  const { newEventDraft } = await import('../src/domain/calendar/events.ts');
  const { listPersonalGoogleItems } = await import('../src/platform/storage/personal-google-store.ts');
  const saved = await saveCalendarEvent(h.database, { expectedRevision: 0, value: { ...newEventDraft('2026-11-08','Asia/Tokyo'),title:'予定' } });
  const original = h.connection.prepare('SELECT * FROM calendar_events WHERE id=?').get(saved);
  const insert = h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)');
  for (let n = 0; n < 999; n++) insert.run(`additional-${n}`,original.definition_json);
  let reads = 0; for (const name of ['getFirstAsync','getAllAsync']) { const read = h.database[name]; h.database[name] = async (...args) => { reads++; return read(...args); }; }
  const items = await listPersonalGoogleItems(h.database,control);
  assert.equal(items.length,1000); assert.ok(reads <= 4, `candidate SQLite reads: ${reads}`);
  assert.ok(items.every(item => item.value.title==='予定' && item.revision===1));
});

test('audit100 Calendar page cycles fail without seventy five repeated requests and remain detected after restart', async t => {
  const h = await setup(t); await h.connect(); let calls = 0;
  h.api.events = async (_id, cursor) => { calls++; return { items: [], nextPageToken: cursor.pageToken === 'A' ? 'B' : 'A' }; };
  assert.equal((await h.sync.sync()).kind, 'error');
  assert.ok(calls <= 3, `cyclic page requests: ${calls}`);
  const before = calls;
  assert.equal((await h.makeSync().sync({ force: true })).kind, 'error');
  assert.equal(calls - before, 1, 'persisted page history must reject an already visited token');
});

test('audit100 a full Calendar rebuild queues missing deletions instead of applying an unbounded transaction', async t => {
  const h = await setup(t); await h.connect();
  h.api.events = async () => ({ items: Array.from({ length: 100 }, (_, n) => remote(`old-${n}`)), nextSyncToken: 'old' });
  for (let n = 0; n < 6; n++) await h.sync.sync({ force: true });
  assert.equal((await readLocalCalendar(h.database)).events.length, 100);
  await h.database.runAsync('DELETE FROM calendar_google_cursors');
  h.api.events = async () => ({ items: [], nextSyncToken: 'rebuilt' });
  const first = await h.sync.sync({ force: true });
  const removed = h.connection.prepare('SELECT count(*) n FROM calendar_events WHERE deleted=1').get().n;
  assert.equal(first.kind, 'pending');
  assert.ok(removed > 0 && removed <= 25, `deletions applied in one import chunk: ${removed}`);
  for (let n = 0; n < 6; n++) await h.sync.sync({ force: true });
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
});

test('audit100 ordinary Google imports do not run expanded series cleanup for every unrelated event', async t => {
  const h = await setup(t); const control = await h.connect();
  const { receivePersonalGoogleEvent } = await import('../src/platform/storage/personal-google-store.ts');
  h.writes.length = 0;
  for (let n = 0; n < 100; n++) await receivePersonalGoogleEvent(h.database, control, owned, remote(`simple-${n}`));
  const cleanup = h.writes.filter(row => /^(?:UPDATE calendar_events SET deleted=1|UPDATE calendar_google_links SET active=0|DELETE FROM calendar_google_expansion)/u.test(row.sql));
  assert.equal(cleanup.length, 0);
  assert.equal((await readLocalCalendar(h.database)).events.length, 100);
});
