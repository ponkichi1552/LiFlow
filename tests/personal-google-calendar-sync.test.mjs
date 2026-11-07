import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarEvent, deleteCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
const { createPersonalGoogleCalendarSync } = await import('../src/features/calendar/personal-google-sync.ts');
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { createGoogleCalendarApi, GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
const clone = value => structuredClone(value);
async function harness(t, extraInput = {}) {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  let subject = 'google-one'; let version = 0; let lost = null; let blocked; const events = new Map(); const changes = []; const calls = [];
  const calendar = { id: 'owned', summary: '個人', accessRole: 'owner', primary: true, timeZone: 'Asia/Tokyo' };
  const put = value => { const event = { ...clone(value), etag: `etag-${++version}` }; events.set(event.id, event); changes.push({ version, event }); return clone(event); };
  const api = {
    calendars: async () => { calls.push(['calendars']); return { items: [calendar] }; },
    events: async (id, cursor) => { calls.push(['events', id, clone(cursor)]); if (blocked) await blocked;
      const since = Number(cursor.syncToken?.slice(1) ?? 0); return { items: cursor.syncToken ? changes.filter(row => row.version > since).map(row => clone(row.event)) : [...events.values()].map(clone), nextSyncToken: `S${version}` }; },
    instances: async () => ({ items: [] }),
    get: async (calendarId, id) => { calls.push(['get', id]); if (!events.has(id)) throw new GoogleCalendarHttpError(404); return clone(events.get(id)); },
    insert: async (calendarId, body) => { calls.push(['insert', body.id]); if (events.has(body.id)) throw new GoogleCalendarHttpError(409); const result = put(body); if (lost === 'insert') { lost = null; throw new Error('lost acknowledgement'); } return result; },
    patch: async (calendarId, id, body, etag) => { calls.push(['patch', id, clone(body)]); const old = events.get(id); if (!old || old.etag !== etag) throw new GoogleCalendarHttpError(412); const result = put({ ...old, ...clone(body) }); if (lost === 'patch') { lost = null; throw new Error('lost acknowledgement'); } return result; },
    remove: async (calendarId, id, etag) => { calls.push(['remove', id]); const old = events.get(id); if (!old) throw new GoogleCalendarHttpError(404); if (old.etag !== etag) throw new GoogleCalendarHttpError(412); put({ id, status: 'cancelled' }); },
  };
  const makeSync = () => createPersonalGoogleCalendarSync({ database: h.database, currentSubject: async () => subject,
    authorize: async () => ({ subject, label: 'QA' }), createApi: () => api, today: () => '2026-11-01', random: () => .5, ...extraInput });
  const sync = makeSync();
  const connect = async () => { const result = await sync.connect(await sync.prepareConnection()); calls.length = 0; return result; };
  return { ...h, sync, makeSync, api, connect, put, events, calls, subject: value => { subject = value; }, loseNext: (method = 'insert') => { lost = method; }, block: value => { blocked = value; },
    local: async (extra = {}) => { const value = { ...newEventDraft('2026-11-03', 'Asia/Tokyo'), title: '予定', ...extra }; const id = await saveCalendarEvent(h.database, { value, expectedRevision: 0 }); return { ...value, id, revision: 1 }; },
    links: () => h.connection.prepare('SELECT * FROM calendar_google_links ORDER BY event_id,anchor_date').all(),
    remote: (id = 'remote', extra = {}) => ({ id, summary: 'Googleの予定', start: { date: '2026-11-04' }, end: { date: '2026-11-05' }, ...extra }),
  };
}
test('a background Calendar pass defers its initial full read but sends pending local edits and resumes in foreground', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local();
  const first = await h.sync.sync({ deltaOnly: true });
  assert.equal(first.kind, 'pending'); assert.equal(first.sent, 1);
  assert.equal(h.calls.some(call => ['calendars', 'events'].includes(call[0])), false);
  assert.equal((await h.sync.readControl()).lastSyncAt, null);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_cursors').get().n, 0);
  const id = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '背景での編集' } });
  assert.equal((await h.makeSync().sync({ deltaOnly: true })).sent, 1);
  assert.equal(h.events.size, 1); assert.equal(h.events.get(id).summary, '背景での編集');
  assert.equal(h.calls.some(call => ['calendars', 'events'].includes(call[0])), false);
  h.calls.length = 0;
  const resumed = await h.makeSync().sync();
  assert.equal(resumed.kind, 'success'); assert.equal(h.events.size, 1);
  assert.equal(h.calls.some(call => call[0] === 'calendars'), true);
  assert.ok(h.connection.prepare('SELECT sync_token FROM calendar_google_cursors').get().sync_token);
});

test('a background Calendar 410 defers the full rebuild while other calendar deltas and local writes continue', async t => {
  const h = await harness(t); let expire = false; let sharedVersion = 0;
  h.api.calendars = async () => { h.calls.push(['calendars']); return { items: [
    { id: 'owned', summary: '個人', accessRole: 'owner', primary: true },
    { id: 'shared-read', summary: '共有先', accessRole: 'reader' },
  ] }; };
  h.api.events = async (id, cursor) => {
    h.calls.push(['events', id, clone(cursor)]);
    if (id === 'owned' && expire && cursor.syncToken) { expire = false; throw new GoogleCalendarHttpError(410); }
    if (id === 'shared-read') return { items: [h.remote('shared-item', { etag: `shared-${++sharedVersion}`, summary: `共有の変更${sharedVersion}` })], nextSyncToken: `shared-${sharedVersion}` };
    return { items: [], nextSyncToken: 'owned-token' };
  };
  await h.connect(); assert.equal((await h.sync.sync()).kind, 'success');
  const previous = (await h.sync.readControl()).lastSyncAt;
  await h.local(); expire = true; h.calls.length = 0;
  const result = await h.sync.sync({ deltaOnly: true });
  assert.equal(result.kind, 'pending'); assert.equal(result.sent, 1);
  assert.equal(h.calls.some(call => call[0] === 'calendars'), false);
  assert.ok(h.calls.filter(call => call[0] === 'events').every(call => call[2].syncToken));
  assert.equal(h.connection.prepare("SELECT sync_token FROM calendar_google_cursors WHERE calendar_id='owned'").get(), undefined);
  assert.deepEqual(JSON.parse(h.connection.prepare('SELECT remaining_json FROM calendar_google_progress').get().remaining_json), ['owned']);
  assert.equal((await h.sync.readControl()).lastSyncAt, previous, 'deferral is not a completed full synchronization');
  const firstVersion = sharedVersion; h.calls.length = 0;
  assert.equal((await h.makeSync().sync({ deltaOnly: true })).kind, 'pending');
  assert.equal(sharedVersion, firstVersion + 1, 'a deferred first calendar cannot starve a later delta feed');
  assert.ok(h.calls.filter(call => call[0] === 'events').every(call => call[1] === 'shared-read' && call[2].syncToken));
  assert.equal((await readLocalCalendar(h.database)).events.find(row => row.title.startsWith('共有の変更')).title, `共有の変更${sharedVersion}`);
  h.calls.length = 0;
  assert.equal((await h.makeSync().sync()).kind, 'success');
  assert.ok(h.calls.some(call => call[0] === 'events' && call[1] === 'owned' && !call[2].syncToken));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_progress').get().n, 0);
  assert.equal(h.events.size, 1, 'the pending write was not duplicated by foreground recovery');
});

test('a Calendar deadline with an unacknowledged HTTP insert preserves its intent and later edit without a duplicate after restart', async t => {
  let h, reply, remoteReply; let holdReply = false;
  const createApi = context => {
    const http = createGoogleCalendarApi({ ...context, token: async () => 'synthetic-token', fetch: async (_url, options) => {
      assert.equal(options.method, 'POST');
      remoteReply = await h.api.insert('owned', JSON.parse(options.body));
      return holdReply ? new Promise(resolve => { reply = resolve; }) : Response.json(remoteReply);
    } });
    return { ...h.api, insert: http.insert };
  };
  h = await harness(t, { createApi }); await h.connect(); const event = await h.local();
  t.mock.timers.enable({ apis: ['setTimeout'] }); holdReply = true;
  const pending = h.sync.sync({ force: true, budgetMs: 1000 });
  try {
    for (let i = 0; i < 40 && !reply; i++) await new Promise(setImmediate);
    assert.equal(typeof reply, 'function'); assert.equal(h.events.size, 1);
    t.mock.timers.tick(1000); assert.equal((await pending).kind, 'pending');
    const beforeLateReply = h.links(); assert.ok(beforeLateReply[0].pending_json); assert.equal(beforeLateReply[0].local_revision, 0);
    reply(Response.json(remoteReply)); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.deepEqual(h.links(), beforeLateReply, 'a late native response must not acknowledge the expired pass');
    await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '期限終了後の端末編集' } });
    holdReply = false; t.mock.timers.reset();
    const restarted = h.makeSync(); assert.equal((await restarted.sync({ force: true })).kind, 'success');
    assert.equal(h.events.size, 1); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
    assert.equal([...h.events.values()][0].summary, '期限終了後の端末編集');
    assert.equal((await readLocalCalendar(h.database)).events[0].title, '期限終了後の端末編集');
    assert.equal(h.links()[0].pending_json, null);
  } finally { reply?.(Response.json(remoteReply ?? {})); t.mock.timers.reset(); }
});
test('Calendar native identity timeouts release the queue and rollback an uncommitted page', async t => {
  for (const phase of ['guard', 'transaction-entry', 'page-final-fence']) await t.test(phase, async t => {
    let h, release, armed = false;
    h = await harness(t, { currentSubject: async () => {
      const inTransaction = h?.connection.isTransaction;
      const shouldHold = phase === 'guard' ? !inTransaction : phase === 'transaction-entry' ? inTransaction
        : inTransaction && h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox').get().n > 0;
      if (armed && shouldHold) return new Promise(resolve => { release = resolve; });
      return 'google-one';
    } });
    await h.connect(); h.put(h.remote('identity-timeout')); armed = true;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result; const pending = h.sync.sync({ force: true, budgetMs: 1000 }).then(value => { result = value; return value; });
    try {
      for (let i = 0; i < 50 && !release; i++) await new Promise(setImmediate);
      assert.equal(typeof release, 'function', 'the actual native identity boundary must be reached');
      t.mock.timers.tick(1000);
      for (let i = 0; i < 20 && !result; i++) await new Promise(setImmediate);
      assert.equal(result?.kind, 'pending', 'a native identity wait must end with the pass deadline');
      assert.equal(h.connection.isTransaction, false, 'no transaction may remain open after timeout');
      assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox').get().n, 0);
      assert.equal((await readLocalCalendar(h.database)).events.length, 0);
    } finally {
      armed = false; release?.('google-one'); await pending; t.mock.timers.reset();
    }
    assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox').get().n, 0, 'a late identity reply cannot commit the expired page');
    assert.equal((await readLocalCalendar(h.database)).events.length, 0);
    const recovered = await h.makeSync().sync({ force: true });
    assert.equal(recovered.kind, 'success');
    assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  });
});
test('personal Calendar stays completely OFF until selected, and disables without deleting either side', async t => {
  const h = await harness(t); await h.local(); assert.equal((await h.sync.sync()).kind, 'skipped'); assert.deepEqual(h.calls, []);
  await h.connect(); assert.equal((await h.sync.sync()).sent, 1); const control = await h.sync.readControl(); await h.sync.disable(control);
  assert.equal((await h.sync.sync()).kind, 'skipped'); assert.equal(h.events.size, 1); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
});
test('calendar access removal and restoration invalidate the private view without replaying unchanged events', async t => {
  const h = await harness(t);
  const primary = { id: 'owned', summary: '自分', primary: true, accessRole: 'owner' };
  const shared = { id: 'other', summary: '別のカレンダー', accessRole: 'reader' };
  let calendars = [primary, shared];
  h.api.calendars = async () => ({ items: calendars });
  h.api.events = async (id, cursor) => ({ items: !cursor.syncToken && id === 'other' ? [h.remote('shared-item', { etag: 'fixed' })] : [], nextSyncToken: `token-${id}` });
  await h.connect(); await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  const notifications = [];
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
  t.after(subscribeLocalCalendar(h.database, change => notifications.push(change)));
  calendars = [primary]; await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.equal(notifications.filter(change => change === 'sync').length, 1);
  notifications.length = 0; calendars = [primary, shared]; await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  assert.equal(notifications.filter(change => change === 'sync').length, 1);
  notifications.length = 0; await h.sync.sync(); assert.deepEqual(notifications.filter(change => change !== 'syncStatus'), []);
});
for (const linked of [false, true]) test(`deleting a recurring series skips its ${linked ? 'mapped' : 'unsent'} exception and never retries a deleted Google master`, async t => {
  const h = await harness(t); await h.connect();
  const event = await h.local({ allDay: true, recurrence: 'weekly' }); await h.sync.sync();
  const master = h.links()[0].google_id;
  const instance = h.remote('instance', { etag: 'initial', recurringEventId: master, originalStartTime: { date: '2026-11-10' }, start: { date: '2026-11-10' }, end: { date: '2026-11-11' } });
  h.api.instances = async () => { h.calls.push(['instances', master]); return { items: [instance] }; };
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-10', expectedExceptionRevision: 0,
    value: { ...event, title: '変更', startDate: '2026-11-11', endDate: '2026-11-11', recurrence: 'none' } });
  if (linked) { h.events.set(instance.id, instance); await h.sync.sync(); }
  await deleteCalendarEvent(h.database, { id: event.id, expectedRevision: 1 });
  const start = h.calls.length;
  h.api.instances = async () => { h.calls.push(['instances', master]); throw new GoogleCalendarHttpError(404); };
  assert.equal((await h.sync.sync()).kind, 'success');
  assert.deepEqual(h.calls.slice(start).filter(row => ['instances', 'patch', 'remove'].includes(row[0])).map(row => row.slice(0, 2)), [['remove', master]]);
  assert.equal((await h.sync.sync()).kind, 'success');
});
test('personal local create edit and delete use one stable Google id and PATCH preserves unowned Google fields', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local(); assert.equal((await h.sync.sync()).kind, 'success');
  const id = h.links()[0].google_id; h.put({ ...h.events.get(id), attendees: [{ email: 'private@example.test' }], reminders: { useDefault: true } });
  await saveCalendarEvent(h.database, { id: event.id, value: { ...event, title: '変更' }, expectedRevision: 1 });
  assert.equal((await h.sync.sync()).kind, 'success'); assert.equal(h.events.get(id).summary, '変更'); assert.equal(h.events.get(id).attendees.length, 1);
  assert.equal(h.events.get(id).reminders.useDefault, true); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
  await deleteCalendarEvent(h.database, { id: event.id, expectedRevision: 2 }); await h.sync.sync(); assert.equal(h.events.get(id).status, 'cancelled');
  await h.sync.sync(); assert.equal(h.calls.filter(row => row[0] === 'remove').length, 1);
});
test('Google creates edits and deletions are imported privately without echo writes or group-export duplicates', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote()); h.put(h.remote('shared-export', { extendedProperties: { private: { liflowShared: '1' } } }));
  assert.equal((await h.sync.sync()).kind, 'success'); let local = await readLocalCalendar(h.database); assert.equal(local.events.length, 1);
  h.put(h.remote('remote', { summary: 'Googleで変更' })); await h.sync.sync(); local = await readLocalCalendar(h.database); assert.equal(local.events[0].title, 'Googleで変更');
  h.put({ id: 'remote', status: 'cancelled' }); await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.equal(h.calls.some(row => ['insert', 'patch', 'remove'].includes(row[0])), false);
});
test('lost insert acknowledgements and application restarts cannot duplicate a personal Google event', async t => {
  const h = await harness(t); await h.connect(); await h.local(); h.loseNext(); assert.equal((await h.sync.sync({ force: true })).kind, 'error');
  assert.equal(h.events.size, 1); assert.equal(h.links().length, 1); assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.equal(h.events.size, 1); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
});
for (const method of ['insert', 'patch']) for (const action of ['edit', 'delete']) test(`personal Calendar preserves a later ${action} after a lost ${method} reply and runtime restart`, async t => {
  const h = await harness(t); await h.connect(); const event = await h.local();
  let revision = 1;
  if (method === 'patch') {
    await h.sync.sync(); await saveCalendarEvent(h.database, { id: event.id, expectedRevision: revision++, value: { ...event, title: '送信した変更' } });
  }
  h.loseNext(method); assert.equal((await h.sync.sync({ force: true })).kind, 'error');
  if (action === 'edit') await saveCalendarEvent(h.database, { id: event.id, expectedRevision: revision, value: { ...event, title: '応答喪失後の編集' } });
  else await deleteCalendarEvent(h.database, { id: event.id, expectedRevision: revision });
  const restarted = h.makeSync();
  for (let n = 0; n < 3; n++) await restarted.sync({ force: true });
  const visible = (await readLocalCalendar(h.database)).events;
  assert.equal(visible.length, action === 'edit' ? 1 : 0);
  if (action === 'edit') assert.equal(visible[0].title, '応答喪失後の編集');
  assert.equal(h.events.size, 1);
  assert.equal([...h.events.values()][0][action === 'edit' ? 'summary' : 'status'], action === 'edit' ? '応答喪失後の編集' : 'cancelled');
  assert.equal((await restarted.readConflicts()).length, 0);
});
test('a third party edit after a lost personal insert stays an explicit conflict with the newer local edit intact', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local(); h.loseNext(); await h.sync.sync();
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '端末の追加編集' } });
  const remote = [...h.events.values()][0]; h.put({ ...remote, summary: '別の編集' });
  await h.makeSync().sync({ force: true });
  assert.equal((await readLocalCalendar(h.database)).events[0].title, '端末の追加編集');
  assert.equal([...h.events.values()][0].summary, '別の編集');
  assert.equal((await h.sync.readConflicts()).length, 1);
});
test('an unconfirmed personal write is not acknowledged before HTTP succeeds and later offline edits still converge', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local();
  const insert = h.api.insert; h.api.insert = async () => { throw new Error('request never sent'); };
  assert.equal((await h.sync.sync()).kind, 'error');
  assert.equal(h.links()[0].base_json, null); assert.equal(h.links()[0].local_revision, 0); assert.ok(h.links()[0].pending_json);
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '再起動前の変更' } });
  h.api.insert = insert; const runtime = h.makeSync();
  assert.equal((await runtime.sync({ force: true })).kind, 'success');
  assert.equal((await readLocalCalendar(h.database)).events[0].title, '再起動前の変更');
  assert.equal([...h.events.values()][0].summary, '再起動前の変更');
});
test('simultaneous local and remote edits are retained as a conflict instead of silently choosing the last writer', async t => {
  const h = await harness(t); await h.connect(); const local = await h.local(); await h.sync.sync(); const id = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: local.id, value: { ...local, title: '端末の変更' }, expectedRevision: 1 });
  h.put({ ...h.events.get(id), summary: 'Googleの変更' }); await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events[0].title, '端末の変更'); assert.equal(h.events.get(id).summary, 'Googleの変更');
  assert.ok(h.links()[0].conflict_json); assert.equal(h.calls.filter(row => row[0] === 'patch').length, 0);
});
test('an edit committed while the calendar HTTP read waits survives and is exported in that pass', async t => {
  const h = await harness(t); await h.connect(); let release; h.block(new Promise(resolve => { release = resolve; }));
  const pending = h.sync.sync(); await new Promise(resolve => setTimeout(resolve, 5)); await h.local({ title: '読込中の追加' }); release();
  assert.equal((await pending).kind, 'success'); assert.equal([...h.events.values()][0].summary, '読込中の追加');
});
test('account changes while HTTP is pending cannot import data into the replacement connection', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote()); let release; h.block(new Promise(resolve => { release = resolve; }));
  const pending = h.sync.sync(); await new Promise(resolve => setTimeout(resolve, 5)); h.subject('google-two'); release();
  assert.equal((await pending).kind, 'error'); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
});
test('a previous account import never becomes a new export after switching Google accounts', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote()); await h.sync.sync(); h.events.clear(); h.subject('google-two'); await h.connect();
  await h.sync.sync(); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 0);
});
test('switching accounts displays one copy of the same accessible Google event and restores the original mapping without new exports', async t => {
  const { readPlanningInputRevision } = await import('../src/platform/storage/planning-input-revision.ts');
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
  const h = await harness(t); await h.connect(); h.put(h.remote('same-shared-calendar-event'));
  await h.sync.sync(); const first = (await readLocalCalendar(h.database)).events;
  assert.equal(first.length, 1);
  const changes = []; const stop = subscribeLocalCalendar(h.database, kind => changes.push(kind)); t.after(stop);
  const before = await readPlanningInputRevision(h.database);
  h.subject('google-two'); await h.connect();
  assert.ok(await readPlanningInputRevision(h.database) > before, 'another native SQLite connection must observe the availability change');
  assert.deepEqual(changes, ['sync'], 'the visible event scope must invalidate observers immediately on account change');
  assert.equal((await readLocalCalendar(h.database)).events.length, 0, 'the archived account must not remain visible before the new account imports');
  await h.sync.sync(); const second = (await readLocalCalendar(h.database)).events;
  assert.equal(second.length, 1); assert.notEqual(second[0].id, first[0].id);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_events WHERE deleted=0').get().n, 2, 'account archives remain intact');
  assert.equal(h.calls.some(call => ['insert', 'patch', 'remove'].includes(call[0])), false);
  h.subject('google-one'); await h.connect(); await h.sync.sync();
  assert.deepEqual((await readLocalCalendar(h.database)).events.map(row => row.id), [first[0].id]);
  assert.equal(h.events.size, 1); assert.equal(h.calls.some(call => ['insert', 'patch', 'remove'].includes(call[0])), false);
});
test('a single pass never exceeds 100 Google requests and a later pass continues the durable queue', async t => {
  const h = await harness(t); await h.connect(); for (let i = 0; i < 105; i++) await h.local({ title: `予定${i}` });
  const first = await h.sync.sync({ force: true }); assert.equal(first.kind, 'pending'); assert.equal(h.calls.length, 100); assert.equal(h.events.size, 98);
  let next;
  for (let n = 0; n < 10; n++) { const before = h.calls.length; next = await h.sync.sync({ force: true }); assert.ok(h.calls.length - before <= 100); if (next.kind === 'success') break; }
  assert.equal(next.kind, 'success'); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 105); assert.equal(h.events.size, 105); assert.equal((await readLocalCalendar(h.database)).events.length, 105);
});
test('Google 410 resets only the sync cursor and preserves local edits while a full rescan catches deletions', async t => {
  const h = await harness(t); await h.connect(); const local = await h.local(); await h.sync.sync(); const id = h.links()[0].google_id;
  const original = h.api.events; let reset = true; h.api.events = async (...args) => { if (reset) { reset = false; throw new GoogleCalendarHttpError(410); } return original(...args); };
  h.events.clear(); await saveCalendarEvent(h.database, { id: local.id, expectedRevision: 1, value: { ...local, title: 'オフラインの変更' } });
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events[0].title, 'オフラインの変更'); assert.ok(h.links().find(link => link.google_id === id).conflict_json);
});
test('Google recurring exceptions arriving before their master remain staged and then attach to the original round', async t => {
  const h = await harness(t); await h.connect(); let page = 0;
  const master = h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261106'] }));
  const moved = h.put(h.remote('exception', { recurringEventId: 'series', originalStartTime: { date: '2026-11-05' }, start: { date: '2026-11-08' }, end: { date: '2026-11-09' } }));
  h.api.events = async () => ++page === 1 ? { items: [moved], nextPageToken: 'p2' } : { items: [master], nextSyncToken: 'S2' };
  assert.equal((await h.sync.sync()).kind, 'success'); const local = await readLocalCalendar(h.database);
  assert.equal(local.events.length, 1); assert.equal(local.exceptions[0].anchorDate, '2026-11-05');
  const rounds = projectCalendarEvents(local.events, local.exceptions, '2026-11-04', '2026-11-08');
  assert.deepEqual(rounds.map(row => row.startDate), ['2026-11-04', '2026-11-06', '2026-11-08']);
});
for (const choice of ['local', 'google']) test(`an explicit ${choice} conflict decision applies only the reviewed revisions`, async t => {
  const h = await harness(t); await h.connect(); const event = await h.local(); await h.sync.sync(); const id = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '端末版' } }); h.put({ ...h.events.get(id), summary: 'Google版' }); await h.sync.sync();
  const [conflict] = await h.sync.readConflicts(); assert.equal(conflict.local.title, '端末版'); assert.equal(conflict.remote.summary, 'Google版');
  await h.sync.resolveConflict(conflict, choice); await h.sync.sync();
  assert.equal((await h.sync.readConflicts()).length, 0); assert.equal((await readLocalCalendar(h.database)).events[0].title, choice === 'local' ? '端末版' : 'Google版');
  assert.equal(h.events.get(id).summary, choice === 'local' ? '端末版' : 'Google版');
  await assert.rejects(h.sync.resolveConflict(conflict, choice), /再び変更/);
});
test('a stale conflict review never overwrites a newer offline edit', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local(); await h.sync.sync(); const id = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '端末版' } }); h.put({ ...h.events.get(id), summary: 'Google版' }); await h.sync.sync();
  const [conflict] = await h.sync.readConflicts(); await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 2, value: { ...event, title: '追加の編集' } });
  await assert.rejects(h.sync.resolveConflict(conflict, 'google'), /再び変更/); assert.equal((await readLocalCalendar(h.database)).events[0].title, '追加の編集');
  const [fresh] = await h.makeSync().readConflicts(); assert.equal(fresh.local.title, '追加の編集');
  await h.sync.resolveConflict(fresh, 'google'); await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events[0].title, 'Google版');
});

for (const role of ['owner', 'reader']) test(`regular, expanded, then regular Google series converge without lost exceptions, false conflicts or duplicates (${role})`, async t => {
  const h = await harness(t); const primary = { id:'owned', summary:'個人', primary:true, accessRole:'owner', timeZone:'Asia/Tokyo' };
  const calendar = { id:'series-calendar', summary:'Series', accessRole:role, timeZone:'Asia/Tokyo' };
  h.api.calendars = async () => ({ items:[primary,calendar] });
  h.api.events = async (id, cursor) => id === primary.id ? { items:[], nextSyncToken:'owned-token' } : { items:[...h.events.values()].map(clone), nextSyncToken:'series-token' };
  const master = h.remote('series', { recurrence:['RRULE:FREQ=DAILY'] });
  const instance = h.remote('instance', { recurringEventId:'series', originalStartTime:{ date:'2026-11-04' } });
  h.put(master); h.put(instance); await h.connect(); await h.sync.sync();
  let local = await readLocalCalendar(h.database); assert.equal(projectCalendarEvents(local.events,local.exceptions,'2026-11-04','2026-11-04').length,1);
  h.api.instances = async (_id,_parent,range) => { h.calls.push(['instances',clone(range)]); return { items:[clone(instance)] }; };
  h.put({ ...master, recurrence:['RRULE:FREQ=DAILY;COUNT=2'] }); await h.sync.sync();
  local = await readLocalCalendar(h.database); assert.equal(projectCalendarEvents(local.events,local.exceptions,'2026-11-04','2026-11-04').length,1);
  h.connection.prepare("UPDATE calendar_google_links SET local_revision=0,local_base_json=NULL WHERE google_id='series'").run(); // exact legacy hidden-parent state
  h.put({ ...master, summary:'Changed while expanded', recurrence:['RRULE:FREQ=DAILY;COUNT=2'] });
  await h.sync.sync(); assert.equal((await h.sync.readConflicts()).length,0);
  h.put({ ...master, summary:'Normal again' }); await h.sync.sync();
  local = await readLocalCalendar(h.database); assert.equal(projectCalendarEvents(local.events,local.exceptions,'2026-11-04','2026-11-04').length,1);
  const calls = h.calls.filter(row => row[0]==='instances').length;
  await h.sync.requestRange('2028-11-01','2028-11-30'); await h.sync.sync();
  assert.equal(h.calls.filter(row => row[0]==='instances').length,calls,'retired expansions must not restart');
  assert.equal((await h.sync.readConflicts()).length,0);
});

for(const choice of ['local','google'])test(`a conflict resolved during another outbound HTTP request gets a trailing ${choice} synchronization`,async t=>{
  const h=await harness(t);await h.connect();const event=await h.local();await h.sync.sync();const id=h.links()[0].google_id;
  await saveCalendarEvent(h.database,{id:event.id,expectedRevision:1,value:{...event,title:'Local conflict'}});h.put({...h.events.get(id),summary:'Google conflict'});await h.sync.sync();
  const [review]=await h.sync.readConflicts();const another=await h.local({title:'Other edit'});await h.sync.sync();
  await saveCalendarEvent(h.database,{id:another.id,expectedRevision:1,value:{...another,title:'Other pending edit'}});
  let enter,release;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});const patch=h.api.patch;
  h.api.patch=async(...args)=>{enter();await gate;return patch(...args);};
  const active=h.sync.sync();await entered;await h.sync.resolveConflict(review,choice);const following=h.sync.sync({force:true});release();
  await active;const result=await following;assert.equal(result.kind,'success');
  assert.equal(h.events.get(id).summary,choice==='local'?'Local conflict':'Google conflict');assert.equal((await h.sync.readConflicts()).length,0);
  assert.equal((await readLocalCalendar(h.database)).events.find(row=>row.id===event.id).title,choice==='local'?'Local conflict':'Google conflict');
});

test('reconnecting with changed Calendar permissions dirties cached events before the saved role replaces its predecessor', async t => {
  const h = await harness(t); const primary={ id:'owned',summary:'Mine',accessRole:'owner',primary:true };
  const shared={ id:'shared-role',summary:'Shared',accessRole:'writer' };
  h.api.calendars=async()=>({items:[primary,shared]});
  h.api.events=async id=>({items:id==='shared-role'?[h.remote('role-event')]:[],nextSyncToken:'same'});
  await h.connect(); await h.sync.sync(); shared.accessRole='reader';
  await h.sync.connect(await h.sync.prepareConnection());
  assert.equal(h.connection.prepare("SELECT dirty FROM calendar_google_inbox WHERE calendar_id='shared-role'").get().dirty,1);
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events[0].readOnly,true);
});
test('keeping a locally edited event after a Google deletion creates one recoverable replacement instead of reviving a tombstone', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local(); await h.sync.sync(); const oldId = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '残す' } }); h.put({ id: oldId, status: 'cancelled' }); await h.sync.sync();
  await h.sync.resolveConflict((await h.sync.readConflicts())[0], 'local'); await h.sync.sync();
  const newId = h.links()[0].google_id; assert.notEqual(newId, oldId); assert.equal(h.events.get(oldId).status, 'cancelled'); assert.equal(h.events.get(newId).summary, '残す');
  await h.sync.sync(); assert.equal([...h.events.values()].filter(row => row.status !== 'cancelled').length, 1);
});
test('Google calendars are discovered automatically and another person shared calendar stays private and read-only', async t => {
  const h = await harness(t); const primary = { id: 'owned', summary: '個人', primary: true, accessRole: 'owner', timeZone: 'Asia/Tokyo' };
  const shared = { id: 'shared', summary: '他の人の予定', accessRole: 'reader', timeZone: 'Asia/Tokyo' };
  h.api.calendars = async () => ({ items: [primary, shared] }); h.api.events = async id => ({ items: [{ ...h.remote(id), etag: 'v1' }], nextSyncToken: `S-${id}` });
  await h.connect(); await h.sync.sync(); const local = await readLocalCalendar(h.database); assert.equal(local.events.length, 2);
  const readonly = local.events.find(row => row.readOnly); assert.ok(readonly);
  await assert.rejects(saveCalendarEvent(h.database, { id: readonly.id, expectedRevision: readonly.revision, value: { ...readonly, title: '不正な変更' } }), /Googleカレンダーで編集/);
  await assert.rejects(deleteCalendarEvent(h.database, { id: readonly.id, expectedRevision: readonly.revision }), /Googleカレンダーで編集/);
  assert.equal(h.connection.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='sharing_operations'").get().n, 0);
  h.api.calendars = async () => ({ items: [primary] }); await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  assert.equal(h.calls.some(row => row[0] === 'remove'), false, 'losing calendar access never deletes Google content');
});
test('a newly added Google calendar is included without making the user select it', async t => {
  const h = await harness(t); await h.connect(); await h.sync.sync();
  h.api.calendars = async () => ({ items: [{ id: 'owned', primary: true, summary: '個人', accessRole: 'owner' }, { id: 'new', summary: '新規', accessRole: 'writer' }] });
  h.api.events = async id => ({ items: id === 'new' ? [{ ...h.remote('added'), etag: 'v1' }] : [], nextSyncToken: `S-${id}` });
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events[0].title, 'Googleの予定'); assert.equal((await h.sync.readControl()).calendars.length, 2);
});
test('transparent Google events retain their availability and do not echo an opaque edit back to Google', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('transparent', { transparency: 'transparent', htmlLink: 'javascript:alert(1)' }));
  await h.sync.sync(); await h.sync.sync(); const event = (await readLocalCalendar(h.database)).events[0]; assert.equal(event.blocksTime, false); assert.equal(event.externalUrl, undefined);
  assert.equal(h.calls.filter(row => row[0] === 'patch').length, 0);
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: event.revision, value: { ...event, title: '内容だけ変更' } }); await h.sync.sync();
  assert.equal(h.events.get('transparent').transparency, 'transparent');
});
test('official Google holidays are date annotations and never occupy a whole day or change an ordinary all-day appointment', async t => {
  const h = await harness(t);
  const owned = { id: 'owned', summary: '個人', accessRole: 'owner', primary: true, timeZone: 'Asia/Tokyo' };
  const holiday = { id: 'ja.japanese#holiday@group.v.calendar.google.com', summary: '日本の祝日', accessRole: 'reader', timeZone: 'Asia/Tokyo' };
  h.api.calendars = async () => ({ items: [owned, holiday] });
  h.api.events = async id => ({ items: [h.remote(id, { summary: id === holiday.id ? '文化の日' : '旅行', start: { date: id === holiday.id ? '2026-11-03' : '2026-11-04' }, end: { date: id === holiday.id ? '2026-11-04' : '2026-11-05' }, transparency: 'opaque' })], nextSyncToken: `token-${id}` });
  await h.connect(); await h.sync.sync();
  const snapshot = await readLocalCalendar(h.database);
  const official = snapshot.events.find(row => row.title === '文化の日');
  assert.equal(official.holiday, true); assert.equal(official.blocksTime, false);
  const ordinary = snapshot.events.find(row => row.title === '旅行');
  assert.equal(Boolean(ordinary.holiday), false); assert.equal(ordinary.blocksTime, true);
  const { projectPrivateCalendarEvents } = await import('../src/features/calendar/private-event-projection.ts');
  const projected = projectPrivateCalendarEvents(snapshot.events, snapshot.exceptions, '2026-11-03', '2026-11-04');
  assert.equal(projected.find(row => row.title === '文化の日').holiday, true);
  const { localCalendarAvailability } = await import('../src/features/calendar/local-availability.ts');
  const availability = localCalendarAvailability(snapshot.events, snapshot.exceptions, '2026-11-03', '2026-11-04', 'Asia/Tokyo');
  assert.equal(availability?.['2026-11-03']?.busyMinutes ?? 0, 0);
  assert.equal(availability?.['2026-11-04']?.busyMinutes, 1440);
  assert.equal(h.calls.some(call => ['insert', 'patch', 'remove'].includes(call[0])), false);
});
test('Google recurring instance availability overrides only that private occurrence in both personal and joined planning', async t => {
  const { projectPrivateCalendarEvents } = await import('../src/features/calendar/private-event-projection.ts');
  const { localCalendarAvailability } = await import('../src/features/calendar/local-availability.ts');
  const { createLocalCalendarAvailability } = await import('../src/features/calendar/private-availability.ts');
  for (const transparency of ['opaque', 'transparent']) {
    const h = await harness(t); await h.connect();
    h.put(h.remote('series', { transparency, recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261111'] }));
    h.put(h.remote('instance', { transparency: transparency === 'opaque' ? 'transparent' : 'opaque', recurringEventId: 'series',
      originalStartTime: { date: '2026-11-11' }, start: { date: '2026-11-11' }, end: { date: '2026-11-12' } }));
    await h.sync.sync(); const local = await readLocalCalendar(h.database);
    const occurrences = projectPrivateCalendarEvents(local.events, local.exceptions, '2026-11-04', '2026-11-11');
    assert.deepEqual(occurrences.map(row => [row.startDate, row.blocksTime]), [['2026-11-04', transparency === 'opaque'], ['2026-11-11', transparency !== 'opaque']]);
    for (const date of ['2026-11-04', '2026-11-11']) {
      const busy = occurrences.find(row => row.startDate === date).blocksTime;
      const personal = localCalendarAvailability(local.events, local.exceptions, date, date, 'Asia/Tokyo');
      assert.equal(personal?.[date]?.busyMinutes ?? 0, busy ? 1440 : 0);
      const read = createLocalCalendarAvailability(local.events, local.exceptions, { from: date, through: date }, 'Asia/Tokyo');
      assert.equal(read({ precision: 'interval', start: `${date}T00:00:00+09:00`, end: `${date}T23:59:00+09:00` }).conflict.kind, busy ? 'conflict' : 'clear');
    }
    assert.equal(h.calls.some(row => ['insert', 'patch', 'remove'].includes(row[0])), false);
  }
});
test('reopening an older private Google store repairs inherited instance metadata without replaying a local series reset', async t => {
  const { initializePersonalGoogleCalendar } = await import('../src/platform/storage/personal-google-calendar.ts');
  const { projectPrivateCalendarEvents } = await import('../src/features/calendar/private-event-projection.ts');
  const h = await harness(t); await h.connect();
  h.put(h.remote('series', { transparency: 'transparent', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261111'] }));
  h.put(h.remote('instance', { transparency: 'opaque', recurringEventId: 'series', originalStartTime: { date: '2026-11-11' }, start: { date: '2026-11-11' }, end: { date: '2026-11-12' } }));
  await h.sync.sync(); const [series] = (await readLocalCalendar(h.database)).events;
  h.connection.prepare('DELETE FROM calendar_event_exceptions WHERE event_id=?').run(series.id);
  h.connection.prepare("UPDATE calendar_google_links SET local_revision=? WHERE anchor_date<>''").run(-series.revision);
  await initializePersonalGoogleCalendar({ ...h.database }); await h.sync.sync();
  const local = await readLocalCalendar(h.database);
  assert.deepEqual(projectPrivateCalendarEvents(local.events, local.exceptions, '2026-11-04', '2026-11-11').map(row => row.blocksTime), [false, true]);
  assert.equal(h.calls.some(row => ['insert', 'patch', 'remove'].includes(row[0])), false);
  await saveCalendarEvent(h.database, { id: series.id, expectedRevision: series.revision, value: { ...series, untilDate: '2026-11-18' }, resetExceptions: true });
  await initializePersonalGoogleCalendar({ ...h.database });
  assert.equal(h.connection.prepare("SELECT dirty FROM calendar_google_inbox WHERE google_id='instance'").get().dirty, 0, 'an intentional reset is a pending local change, not a damaged import');
  await h.sync.sync(); assert.equal(h.events.get('instance').transparency, 'transparent', 'resetting the instance restores the parent availability');
});
test('an unrepresentable finite Google recurrence is expanded without changing COUNT and retains the exact private source', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('counted', { recurrence: ['RRULE:FREQ=DAILY;COUNT=2'] }));
  let page = 0; h.api.instances = async () => ++page === 1 ? { items: [{ ...h.remote('counted-1'), etag: 'i1', recurringEventId: 'counted', description: 'x'.repeat(4500) }], nextPageToken: 'next' }
    : { items: [{ ...h.remote('counted-2', { start: { date: '2026-11-05' }, end: { date: '2026-11-06' } }), etag: 'i2', recurringEventId: 'counted' }] };
  assert.equal((await h.sync.sync()).kind, 'success'); const local = await readLocalCalendar(h.database); assert.equal(local.events.length, 2); assert.ok(local.events.every(row => row.readOnly));
  assert.equal(h.events.get('counted').recurrence[0], 'RRULE:FREQ=DAILY;COUNT=2'); assert.equal(h.calls.some(row => row[0] === 'patch'), false);
  assert.equal(JSON.parse(h.links().find(row => row.google_id === 'counted-1').remote_json).description.length, 4500);
  h.put({ id: 'counted', status: 'cancelled' }); await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
});
test('Google recurrence exception edits and resets reuse the same instance instead of creating a second series', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local({ allDay: true, recurrence: 'weekly' }); await h.sync.sync(); const master = h.links()[0].google_id;
  const instance = h.put(h.remote('instance', { summary: '予定', recurringEventId: master, originalStartTime: { date: '2026-11-10' }, start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }));
  h.api.instances = async () => ({ items: [clone(h.events.get(instance.id))] });
  await h.sync.sync(); const imported = (await readLocalCalendar(h.database)).exceptions[0];
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-10', expectedExceptionRevision: imported?.revision ?? 0,
    value: { ...event, title: 'この回だけ', startDate: '2026-11-11', endDate: '2026-11-11', recurrence: 'none' } });
  assert.equal((await h.sync.sync()).kind, 'success'); assert.equal(h.events.get('instance').summary, 'この回だけ'); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
  await deleteCalendarEvent(h.database, { id: event.id, expectedRevision: 1, anchorDate: '2026-11-10', expectedExceptionRevision: (imported?.revision ?? 0) + 1 }); await h.sync.sync();
  assert.equal(h.events.get('instance').status, 'cancelled');
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, resetExceptions: true, value: { ...event, recurrence: 'daily' } }); await h.sync.sync();
  assert.equal(h.events.get('instance').status, 'confirmed'); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
});
test('a new one-occurrence edit exports when its unchanged series is filtered out of the outbound delta', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local({ allDay: true, recurrence: 'weekly' }); await h.sync.sync();
  const master = h.links()[0].google_id;
  const instance = h.remote('new-instance', { etag: 'instance-initial', recurringEventId: master, originalStartTime: { date: '2026-11-10' }, start: { date: '2026-11-10' }, end: { date: '2026-11-11' } });
  h.events.set(instance.id, instance); h.api.instances = async () => ({ items: [clone(h.events.get(instance.id))] });
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-10', expectedExceptionRevision: 0,
    value: { ...event, title: '個別の新しい変更', startDate: '2026-11-11', endDate: '2026-11-11', recurrence: 'none' } });
  const before = h.calls.length; assert.equal((await h.sync.sync()).kind, 'success');
  assert.equal(h.events.get(instance.id).summary, '個別の新しい変更');
  assert.deepEqual(h.calls.slice(before).filter(row => ['insert', 'patch', 'remove'].includes(row[0])).map(row => row.slice(0, 2)), [['patch', instance.id]]);
  await h.sync.sync(); assert.equal(h.calls.filter(row => row[0] === 'patch').length, 1);
});
test('new recurring edits retain the resolved Google instance availability and unowned fields', async t => {
  for (const transparency of ['transparent', 'opaque']) {
    const h = await harness(t); await h.connect(); const event = await h.local({ allDay: true, recurrence: 'weekly' }); await h.sync.sync();
    const master = h.links()[0].google_id;
    const instance = h.remote('new-instance', { etag: 'instance-initial', recurringEventId: master,
      originalStartTime: { date: '2026-11-10' }, start: { date: '2026-11-10' }, end: { date: '2026-11-11' }, transparency,
      attendees: [{ email: 'self@example.test', responseStatus: 'accepted' }], reminders: { useDefault: false, overrides: [] },
      conferenceData: { conferenceId: 'keep-existing-meeting' } });
    h.events.set(instance.id, instance); h.api.instances = async () => ({ items: [clone(h.events.get(instance.id))] });
    await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-10', expectedExceptionRevision: 0,
      value: { ...event, title: '名前だけ変更', startDate: '2026-11-10', endDate: '2026-11-10', recurrence: 'none' } });
    assert.equal((await h.sync.sync()).kind, 'success'); const changed = h.events.get(instance.id);
    assert.equal(changed.summary, '名前だけ変更'); assert.equal(changed.transparency, transparency);
    assert.deepEqual(changed.attendees, instance.attendees); assert.deepEqual(changed.reminders, instance.reminders);
    assert.deepEqual(changed.conferenceData, instance.conferenceData);
    const writes = h.calls.filter(row => row[0] === 'patch').length; await h.sync.sync();
    assert.equal(h.calls.filter(row => row[0] === 'patch').length, writes, 'the acknowledgement must use the actual body and avoid echo writes');
  }
});
test('an unchanged incremental pass does not invalidate every page or repeat Google writes', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote()); await h.sync.sync();
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts'); const notifications = []; const stop = subscribeLocalCalendar(h.database, change => notifications.push(change)); t.after(stop);
  const before = h.calls.length; await h.sync.sync(); assert.deepEqual(notifications.filter(change => change !== 'syncStatus'), []); assert.deepEqual(h.calls.slice(before).map(row => row[0]), ['calendars', 'events']);
});
test('all automatically discovered calendars progress beyond 100 without starving offline personal edits', async t => {
  const h = await harness(t);
  const calendars = Array.from({ length: 115 }, (_, i) => ({ id: i ? `calendar${i}` : 'owned', summary: `予定${i}`, accessRole: 'owner', primary: !i }));
  h.api.calendars = async () => { h.calls.push(['calendars']); return { items: calendars }; };
  const fetched = new Set();
  h.api.events = async id => { h.calls.push(['events', id]); fetched.add(id); return { items: [], nextSyncToken: `S-${id}` }; };
  await h.connect(); await h.local({ title: '同期途中の個人予定' });
  const first = await h.sync.sync(); assert.equal(first.kind, 'pending'); assert.equal(first.sent, 1); assert.ok(h.calls.length <= 100);
  assert.equal((await h.sync.sync()).kind, 'success'); assert.equal(fetched.size, 115);
  assert.equal([...h.events.values()].filter(row => row.summary === '同期途中の個人予定').length, 1);
  assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
});
test('long Google text and an ambiguous repeated hour become read-only without stopping other calendars or writing approximations back', async t => {
  const h = await harness(t); await h.connect();
  h.put(h.remote('long', { summary: '長'.repeat(180), description: '文'.repeat(4500) }));
  h.put(h.remote('fold', { start: { dateTime: '2026-11-01T01:30:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-01T01:30:00-05:00', timeZone: 'America/New_York' } }));
  h.put(h.remote('normal'));
  assert.equal((await h.sync.sync()).kind, 'success'); const before = await readLocalCalendar(h.database);
  assert.equal(before.events.length, 3); assert.equal(before.events.filter(row => row.readOnly).length, 2);
  assert.equal(h.calls.some(row => ['patch', 'insert'].includes(row[0])), false);
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts'); const changed = []; t.after(subscribeLocalCalendar(h.database, event => changed.push(event)));
  h.put({ ...h.events.get('long'), reminders: { useDefault: false } }); await h.sync.sync();
  assert.deepEqual(changed.filter(change => change !== 'syncStatus'), []); assert.deepEqual((await readLocalCalendar(h.database)).events.map(row => row.revision), before.events.map(row => row.revision));
  assert.equal(JSON.parse(h.links().find(row => row.google_id === 'long').remote_json).description.length, 4500);
});
test('a harmless Google representation difference cannot create an echo edit or a false simultaneous-edit conflict', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('spaces', { summary: ' 授業 ', description: ' 説明 ', recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261108T000000Z'] }));
  assert.equal((await h.sync.sync()).kind, 'success'); let [event] = (await readLocalCalendar(h.database)).events;
  assert.equal(h.calls.some(row => row[0] === 'patch'), false);
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: event.revision, value: { ...event, categoryId: 'personal' } });
  await h.sync.sync(); assert.equal(h.calls.some(row => row[0] === 'patch'), false);
  h.put({ ...h.events.get('spaces'), summary: 'Googleで内容を変更' }); await h.sync.sync();
  assert.equal((await h.sync.readConflicts()).length, 0); [event] = (await readLocalCalendar(h.database)).events;
  assert.equal(event.title, 'Googleで内容を変更'); assert.equal(h.calls.some(row => row[0] === 'patch'), false);
});
test('a distant display range expands unsupported series durably and retains previously cached dates', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY;COUNT=999'] }));
  const ranges = [];
  h.api.instances = async (_calendar, _id, range) => { ranges.push(clone(range)); return { items: [h.remote('near', { recurringEventId: 'series' }),
    ...(range.timeMax > '2028-01-01' ? [h.remote('far', { recurringEventId: 'series', start: { date: '2028-01-04' }, end: { date: '2028-01-05' } })] : [])] }; };
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  assert.equal(await h.sync.requestRange('2028-01-01', '2028-02-01'), true);
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 2);
  assert.equal(ranges.length, 2); assert.equal(ranges[1].timeMin, ranges[0].timeMax, 'range extension does not repeat previously covered dates'); assert.ok(ranges[1].timeMax > '2028-02-01');
  assert.equal(await h.sync.requestRange('2028-01-02', '2028-01-03'), false);
  await h.sync.sync(); assert.equal(ranges.length, 2, 'unchanged coverage must not repeatedly ask Google to expand a series');
});
test('role changes apply before a pending local edit can write to a now read-only shared Google calendar', async t => {
  const h = await harness(t); const calendars = [{ id: 'owned', summary: '自分', primary: true, accessRole: 'owner' }, { id: 'shared', summary: '共有元', accessRole: 'writer' }];
  h.api.calendars = async () => ({ items: calendars }); h.api.events = async id => ({ items: id === 'shared' ? [{ ...h.remote(), etag: 'v1' }] : [], nextSyncToken: `S-${id}` });
  await h.connect(); await h.sync.sync(); const [event] = (await readLocalCalendar(h.database)).events;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: event.revision, value: { ...event, title: 'オフライン編集' } });
  calendars[1].accessRole = 'reader'; await h.sync.sync(); const [current] = (await readLocalCalendar(h.database)).events;
  assert.equal(current.title, 'オフライン編集'); assert.equal(current.readOnly, true); assert.equal(h.calls.some(row => row[0] === 'patch'), false);
  await assert.rejects(saveCalendarEvent(h.database, { id: current.id, expectedRevision: current.revision, value: { ...current, title: 'さらに編集' } }), /Googleカレンダーで編集/);
});

test('a thousand unchanged mappings need no definition reads or Google writes and a later edit sends only its delta', async t => {
  const h = await harness(t); await h.connect();
  // Already acknowledged imports model the ordinary post-initial-sync workload.
  const control = await h.sync.readControl();
  const { receivePersonalGoogleEvent, listPersonalGoogleItems } = await import('../src/platform/storage/personal-google-store.ts');
  for (let i = 0; i < 1000; i++) {
    const remote = h.put(h.remote(`volume-${i}`, { summary: `予定 ${i}` }));
    await receivePersonalGoogleEvent(h.database, control, control.calendars[0], remote);
  }
  let reads = 0; const get = h.database.getFirstAsync;
  h.database.getFirstAsync = async (sql, ...args) => { if (sql === 'SELECT * FROM calendar_events WHERE id=?') reads++; return get(sql, ...args); };
  assert.deepEqual(await listPersonalGoogleItems(h.database, control), []);
  assert.equal(reads, 0, 'unchanged definitions must be filtered by their saved revisions in SQLite');
  for (let n = 0; n < 50; n++) { if ((await h.sync.sync()).kind === 'success') break; }
  h.calls.length = 0; reads = 0;
  const clean = await h.sync.sync(); assert.equal(clean.sent, 0); assert.equal(clean.received, 0); assert.equal(reads, 0);
  assert.deepEqual(h.calls.map(row => row[0]), ['calendars', 'events']);
  assert.ok(h.calls[1][2].syncToken, 'normal polls must use the saved incremental token');
  const changed = (await readLocalCalendar(h.database)).events.find(row => row.title === '予定 42');
  await saveCalendarEvent(h.database, { id: changed.id, expectedRevision: changed.revision, value: { ...changed, title: '変更した一件' } });
  h.calls.length = 0; const result = await h.sync.sync(); assert.equal(result.sent, 1);
  assert.deepEqual(h.calls.filter(row => ['insert', 'patch', 'remove'].includes(row[0])).map(row => [row[0], row[1]]), [['patch', 'volume-42']]);
  assert.equal(h.events.get('volume-43').summary, '予定 43');
});

test('Google birthday imports never block available time or become ordinary editable exports', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('birthday', { eventType: 'birthday', recurrence: ['RRULE:FREQ=YEARLY'] }));
  assert.equal((await h.sync.sync()).kind, 'success');
  const event = (await readLocalCalendar(h.database)).events[0]; assert.equal(event.readOnly, true); assert.equal(event.blocksTime, false);
  assert.equal(h.calls.some(row => ['patch', 'insert'].includes(row[0])), false);
});

test('slow native import work leaves time for offline outbound edits and resumes its saved inbox without loss', async t => {
  let clock = Date.now(); const h = await harness(t, { now: () => clock }); await h.connect(); await h.local({ title: '待たせない変更' });
  for (let i = 0; i < 50; i++) h.put(h.remote(`slow-${i}`));
  const read = h.database.getFirstAsync;
  h.database.getFirstAsync = async (sql, ...args) => { if (sql === 'SELECT * FROM calendar_events WHERE id=?' && String(args[0]).startsWith('google.')) clock += 1000; return read(sql, ...args); };
  const first = await h.sync.sync(); assert.equal(first.kind, 'pending'); assert.equal(first.sent, 1); assert.ok(first.received < 50);
  let result;
  for (let n = 0; n < 8; n++) { result = await h.sync.sync(); if (result.kind === 'success') break; }
  assert.equal(result.kind, 'success'); assert.equal((await readLocalCalendar(h.database)).events.length, 51);
  assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1);
  assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM calendar_google_inbox WHERE dirty=1').get().n, 0);
});

test('one atomic inbound batch avoids a native identity bridge round trip per imported row', async t => {
  let identities = 0; const h = await harness(t, { currentSubject: async () => { identities++; return 'google-one'; } }); await h.connect();
  for (let i = 0; i < 100; i++) h.put(h.remote(`bridge-${i}`));
  identities = 0; const result = await h.sync.sync(); assert.equal(result.kind, 'pending'); assert.equal(result.received, 25);
  assert.ok(identities < 60, `native identity checks must be per HTTP/atomic batch, got ${identities}`);
});
test('changing the native account during an inbound batch rolls back every row before it becomes visible', async t => {
  let subject = 'google-one'; const h = await harness(t, { currentSubject: async () => subject }); await h.connect();
  for (let i = 0; i < 3; i++) h.put(h.remote(`atomic-${i}`));
  const first = h.database.getFirstAsync; let reads = 0;
  h.database.getFirstAsync = async (sql, ...args) => {
    const result = await first(sql, ...args); if (sql === 'SELECT * FROM calendar_events WHERE id=?' && ++reads === 2) subject = 'foreign';
    return result;
  };
  assert.equal((await h.sync.sync()).kind, 'error'); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
});

test('manual Calendar retry after joining an expired automatic pass receives its own budget without extending a worker', async t => {
  let clock = Date.parse('2026-11-01T00:00:00Z'); const h = await harness(t, { now: () => clock }); await h.connect(); await h.local();
  let release; h.block(new Promise(resolve => { release = resolve; })); const automatic = h.sync.sync();
  for (let i = 0; i < 30 && !h.calls.some(row => row[0] === 'events'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(row => row[0] === 'events'));
  const manual = h.sync.sync({ interactive: true, force: true }); clock += 21_000; h.block(null); release();
  assert.equal((await automatic).kind, 'pending'); const result = await manual;
  assert.equal(result.kind, 'success'); assert.equal(result.sent, 1); assert.equal(h.events.size, 1);
});


for (const parentState of ['missing', 'deleting']) test(`a ${parentState} master with twenty six waiting exceptions never starves a later valid series and resumes after restart`, async t => {
  const h = await harness(t); await h.connect();
  if (parentState === 'deleting') h.put(h.remote('waiting-master', { recurrence: ['RRULE:FREQ=DAILY'] }));
  h.put(h.remote('valid-master', { recurrence: ['RRULE:FREQ=DAILY'] })); await h.sync.sync();
  const remove = h.api.remove;
  if (parentState === 'deleting') {
    const row = (await readLocalCalendar(h.database)).events.find(row => h.links().some(link => link.event_id === row.id && link.google_id === 'waiting-master'));
    await deleteCalendarEvent(h.database, { id: row.id, expectedRevision: row.revision });
    h.api.remove = async () => { throw new Error('synthetic deletion temporarily unavailable'); };
  }
  for (let n = 0; n < 26; n++) h.put(h.remote(`a-${String(n).padStart(2, '0')}`, { recurringEventId: 'waiting-master', originalStartTime: { date: `2026-11-${String(n + 1).padStart(2, '0')}` } }));
  h.put(h.remote('z-valid-instance', { summary: '後続の有効な例外', recurringEventId: 'valid-master', originalStartTime: { date: '2026-11-04' } }));
  let result;
  for (let n = 0; n < 3; n++) result = await h.makeSync().sync({ force: true });
  const local = await readLocalCalendar(h.database);
  assert.ok(projectCalendarEvents(local.events, local.exceptions, '2026-11-04', '2026-11-04').some(row => row.title === '後続の有効な例外'));
  assert.notEqual(result.kind, 'success');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox WHERE dirty=2').get().n, 26);
  if (parentState === 'missing') {
    assert.match((await h.sync.readControl()).error, /受信待ち/);
    h.put(h.remote('waiting-master', { recurrence: ['RRULE:FREQ=DAILY'] }));
  } else h.api.remove = remove;
  for (let n = 0; n < 5; n++) { result = await h.makeSync().sync({ force: true }); if (result.kind === 'success') break; }
  assert.equal(result.kind, 'success'); assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox WHERE dirty<>0').get().n, 0);
  assert.equal((await h.sync.readControl()).error, null);
  assert.ok((await readLocalCalendar(h.database)).events.some(row => row.title === 'Googleの予定'));
});

test('archived account imports cannot exhaust the visible calendar limit or hide current local appointments', async t => {
  const h = await harness(t); await h.connect(); const visible = await h.local({ title: '現在の個人予定' });
  const insert = h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,0)');
  const link = h.connection.prepare('INSERT INTO calendar_google_links(subject,calendar_id,google_id,event_id) VALUES(?,?,?,?)');
  h.connection.exec('BEGIN');
  try {
    for (let i=0;i<10001;i++) { const id=`archived-${i}`; insert.run(id,JSON.stringify({...newEventDraft('2026-11-03','Asia/Tokyo'),title:'以前のアカウント'}));link.run('previous-account','owned',id,id); }
    h.connection.exec('COMMIT');
  } catch (cause) { h.connection.exec('ROLLBACK');throw cause; }
  const current = await readLocalCalendar(h.database);
  assert.deepEqual(current.events.map(row=>row.id),[visible.id]);
  assert.equal(h.connection.prepare("SELECT count(*) n FROM calendar_google_links WHERE subject='previous-account'").get().n,10001,'archived data remains intact');
});

test('a Google calendar permission downgrade takes effect before its staged events are reimported', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('restricted')); await h.sync.sync();
  const imported=(await readLocalCalendar(h.database)).events[0]; assert.equal(imported.readOnly,false);
  const {refreshPersonalGoogleCalendars}=await import('../src/platform/storage/personal-google-calendar.ts');
  const old=await h.sync.readControl();
  await refreshPersonalGoogleCalendars(h.database,old,[...old.calendars.map(row=>({...row,primary:false,accessRole:'reader'})),{id:'new-primary',summary:'新しいメイン',primary:true,accessRole:'owner'}]);
  const current=await readLocalCalendar(h.database); assert.equal(current.events[0].readOnly,true);
  await assert.rejects(saveCalendarEvent(h.database,{id:imported.id,expectedRevision:imported.revision,value:{...imported,title:'変更できない予定'}}),/Google/);
  assert.equal((await readLocalCalendar(h.database)).events[0].title,imported.title);
});
