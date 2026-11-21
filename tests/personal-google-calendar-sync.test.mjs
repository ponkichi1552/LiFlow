import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarEvent, deleteCalendarEvent, restoreCalendarOccurrence, saveCalendarCategory } = await import('../src/platform/storage/calendar-events.ts');
const { createPersonalGoogleCalendarSync } = await import('../src/features/calendar/personal-google-sync.ts');
const { personalCalendarHasPendingWork } = await import('../src/features/google-sync/background-work.ts');
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { createGoogleCalendarApi, googleCalendarApiOwnsRequestAuthority, GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
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

test('OS Calendar wakeups skip settled state and external-only changes but resume a durable local edit or unfinished scan', async t => {
  const h = await harness(t); assert.equal(await personalCalendarHasPendingWork(h.database), false);
  await h.connect(); await h.sync.sync({ force: true });
  assert.equal(await personalCalendarHasPendingWork(h.database), false);
  const before = h.calls.length; h.put(h.remote());
  assert.equal(await personalCalendarHasPendingWork(h.database), false, 'remote-only discovery waits for foreground/resume/manual signals');
  assert.equal(h.calls.length, before, 'local demand inspection calls no Google API');
  await h.local(); assert.equal(await personalCalendarHasPendingWork(h.database), true);
  await h.sync.sync({ force: true }); assert.equal(await personalCalendarHasPendingWork(h.database), false);
  h.connection.prepare('INSERT INTO calendar_google_progress(subject,remaining_json) VALUES(?,?)').run('google-one', '["owned"]');
  assert.equal(await personalCalendarHasPendingWork(h.database), true);
});

test('Calendar connection status requires the native grant and distinguishes authentication failures from retryable network errors', async t => {
  let granted = false; const h = await harness(t, { hasSession: async () => granted });
  await h.connect(); const control = await h.sync.readControl();
  assert.equal(await h.sync.isConnected(control), false); assert.equal(h.calls.length, 0);
  granted = true; assert.equal(await h.sync.isConnected(control), true); assert.equal(h.calls.length, 0);
  h.api.calendars = async () => { throw new GoogleCalendarHttpError(401); };
  assert.equal((await h.sync.sync({ force: true })).kind, 'error');
  const expired = await h.sync.readControl(); assert.equal(expired.authRequired, true); assert.equal(await h.sync.isConnected(expired), false);
  h.api.calendars = async () => { throw new GoogleCalendarHttpError(503); };
  await h.sync.sync({ force: true }); assert.equal((await h.sync.readControl()).authRequired, true, 'a network error cannot certify recovery from an earlier authentication failure');
  h.api.calendars = async () => ({ items: [control.calendars[0]] });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  const recovered = await h.sync.readControl(); assert.equal(recovered.authRequired, undefined); assert.equal(await h.sync.isConnected(recovered), true);
  h.api.events = async () => { throw new GoogleCalendarHttpError(503); };
  assert.equal((await h.sync.sync({ force: true })).kind, 'error');
  const offline = await h.sync.readControl(); assert.equal(offline.authRequired, undefined); assert.equal(await h.sync.isConnected(offline), true);
  const beforeRetry = h.calls.length;
  assert.equal((await h.sync.sync({ interactive: true })).kind, 'pending');
  assert.equal(h.calls.length, beforeRetry, 'interactive authentication recovery does not bypass ordinary network backoff');

  async function authenticationFailure(t) {
    let clock = 1_800_000_000_000; let fixture;
    const counts = { identity: 0, api: 0 };
    fixture = await harness(t, { now: () => clock,
      currentSubject: async () => { counts.identity++; return 'google-one'; },
      createApi: () => { counts.api++; return fixture.api; } });
    await fixture.connect(); const event = await fixture.local();
    const insert = fixture.api.insert;
    fixture.api.insert = async () => { throw new GoogleCalendarHttpError(401); };
    assert.equal((await fixture.sync.sync({ force: true })).kind, 'error');
    const control = await fixture.sync.readControl();
    assert.equal(control.authRequired, true);
    assert.ok(fixture.links()[0].pending_json, 'the failed write retains its durable intent');
    const rows = () => fixture.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'calendar_%' ORDER BY name").all()
      .map(({ name }) => [name, fixture.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
    counts.identity = 0; counts.api = 0; fixture.calls.length = 0;
    return { ...fixture, counts, control, event, rows, setClock: value => { clock = value; }, restoreInsert: () => { fixture.api.insert = insert; } };
  }
  for (const retry of ['future', 'elapsed']) await t.test(`saved Calendar authentication failure blocks automatic identity and API work with ${retry} retry time`, async t => {
    const f = await authenticationFailure(t);
    if (retry === 'elapsed') f.setClock(f.control.retryAt + 1);
    const before = f.rows(); const writes = f.writes.length;
    const result = await f.sync.sync();
    assert.equal(f.counts.api, 0, 'automatic work stops before constructing the token-backed API');
    assert.equal(f.counts.identity, 0, 'automatic work stops before the native identity bridge');
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, writes);
    assert.deepEqual(f.rows(), before, 'pending intents, local edits, cursors, inbox and control remain intact');
    assert.ok(result.kind === 'skipped' || result.kind === 'pending');
  });
  for (const recovery of ['force', 'interactive']) await t.test(`explicit Calendar ${recovery} recovers the same pending write while authentication retry time is future`, async t => {
    const f = await authenticationFailure(t); const [pending] = f.links(); f.restoreInsert();
    const result = await f.sync.sync({ [recovery]: true });
    assert.equal(result.kind, 'success'); assert.equal(result.sent, 1);
    assert.equal(f.counts.api, 1); assert.ok(f.counts.identity > 0);
    const [accepted] = f.links();
    assert.equal(accepted.google_id, pending.google_id); assert.equal(accepted.calendar_id, pending.calendar_id);
    assert.equal(accepted.event_id, f.event.id); assert.equal(accepted.pending_json, null);
    assert.equal(accepted.local_revision, f.event.revision); assert.equal(f.events.size, 1);
    const recovered = await f.sync.readControl();
    assert.equal(recovered.authRequired, undefined); assert.equal(recovered.error, null); assert.equal(recovered.retryAt, 0);
    assert.equal(recovered.subject, f.control.subject); assert.equal(recovered.generation, f.control.generation);
    await f.sync.disable(recovered); f.counts.api = 0; f.counts.identity = 0; f.calls.length = 0;
    const before = f.rows();
    assert.equal((await f.sync.sync({ [recovery]: true })).kind, 'skipped');
    assert.deepEqual(f.counts, { identity: 0, api: 0 }); assert.equal(f.calls.length, 0); assert.deepEqual(f.rows(), before);
  });
  function delayFirstControlRead(f, expireDuringSettledRead = false) {
    const first = f.database.getFirstAsync; let reads = 0; let release; let announce;
    const gate = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { announce = resolve; });
    f.database.getFirstAsync = async (sql, ...args) => {
      const value = await first(sql, ...args);
      if (sql === 'SELECT control_json FROM calendar_google_control WHERE singleton=1') {
        reads++;
        if (reads === 1) { announce(); await gate; }
        if (reads === 2 && expireDuringSettledRead) f.setClock(1_800_000_001_001);
      }
      return value;
    };
    return { entered, release, reads: () => reads };
  }
  for (const recovery of ['interactive', 'force']) await t.test(`joined Calendar ${recovery} recovers one pending intent after an automatic authentication skip`, async t => {
    const f = await authenticationFailure(t); const [pending] = f.links(); f.restoreInsert();
    const gate = delayFirstControlRead(f); const automatic = f.sync.sync(); await gate.entered;
    const explicit = f.sync.sync({ [recovery]: true });
    const joined = f.sync.sync({ [recovery]: true }); gate.release();
    assert.equal(explicit, joined, 'multiple explicit callers share the existing trailing pass');
    const [stopped, recovered, coalesced] = await Promise.all([automatic, explicit, joined]);
    assert.deepEqual(stopped, { kind: 'skipped', received: 0, sent: 0 });
    assert.equal(recovered.kind, 'success'); assert.equal(recovered.sent, 1); assert.deepEqual(coalesced, recovered);
    assert.equal(f.counts.api, 1); assert.ok(f.counts.identity > 0);
    const [accepted] = f.links();
    assert.equal(accepted.google_id, pending.google_id); assert.equal(accepted.calendar_id, pending.calendar_id);
    assert.equal(accepted.event_id, pending.event_id); assert.equal(accepted.pending_json, null);
    assert.equal(f.events.size, 1); assert.equal((await f.sync.readControl()).authRequired, undefined);
  });
  for (const state of ['disabled', 'unbound']) await t.test(`joined interactive Calendar recovery remains local for a ${state} authentication control`, async t => {
    const f = await authenticationFailure(t); f.restoreInsert();
    if (state === 'disabled') await f.sync.disable(f.control);
    else f.connection.prepare('UPDATE calendar_google_control SET control_json=? WHERE singleton=1').run(JSON.stringify({
      ...f.control, generation: f.control.generation + 1, enabled: true, subject: '', calendars: [], targetCalendarId: null,
    }));
    const before = f.rows(); const gate = delayFirstControlRead(f);
    const automatic = f.sync.sync(); await gate.entered; const explicit = f.sync.sync({ interactive: true }); gate.release();
    assert.equal((await automatic).kind, 'skipped'); assert.equal((await explicit).kind, 'skipped');
    assert.deepEqual(f.counts, { api: 0, identity: 0 }); assert.equal(f.calls.length, 0); assert.deepEqual(f.rows(), before);
  });
  for (const outcome of ['success', 'authentication error', 'network error']) await t.test(`joined interactive Calendar request preserves a preceding ${outcome} and retries only saved authentication`, async t => {
    const f = await authenticationFailure(t); f.restoreInsert(); await f.sync.sync({ force: true });
    const [link] = f.links();
    await saveCalendarEvent(f.database, { id: f.event.id, expectedRevision: f.event.revision, value: { ...f.event, title: '回復中も保持する編集' } });
    f.counts.api = 0; f.counts.identity = 0; f.calls.length = 0;
    const events = f.api.events; let first = true; let release; let announce;
    const gate = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { announce = resolve; });
    f.api.events = async (...args) => {
      if (first) {
        first = false; announce(); await gate;
        if (outcome !== 'success') throw new GoogleCalendarHttpError(outcome === 'authentication error' ? 401 : 503);
      }
      return events(...args);
    };
    const automatic = f.sync.sync(); await entered;
    const explicit = f.sync.sync({ interactive: true }); const joined = f.sync.sync({ interactive: true }); release();
    assert.equal(explicit, joined);
    const [preceding, result] = await Promise.all([automatic, explicit]); await joined;
    assert.equal(preceding.kind, outcome === 'success' ? 'success' : 'error');
    assert.equal(result.kind, outcome === 'network error' ? 'error' : 'success');
    assert.equal(f.counts.api, outcome === 'authentication error' ? 2 : 1);
    const [after] = f.links(); assert.equal(after.google_id, link.google_id); assert.equal(after.event_id, link.event_id);
    assert.equal(f.events.size, 1); assert.equal(after.pending_json, null);
    assert.equal(after.local_revision, outcome === 'network error' ? f.event.revision : f.event.revision + 1);
    assert.equal((await readLocalCalendar(f.database)).events.find(row => row.id === f.event.id).title, '回復中も保持する編集');
    assert.equal((await f.sync.readControl()).authRequired, undefined);
  });
  for (const expiry of ['while waiting', 'during settled control read']) await t.test(`joined interactive Calendar authentication recovery does not create an API after its budget expires ${expiry}`, async t => {
    const f = await authenticationFailure(t); f.restoreInsert(); const before = f.rows();
    const gate = delayFirstControlRead(f, expiry === 'during settled control read');
    const automatic = f.sync.sync(); await gate.entered;
    const explicit = f.sync.sync({ interactive: true, budgetMs: 1000 });
    if (expiry === 'while waiting') f.setClock(1_800_000_001_001);
    gate.release();
    assert.equal((await automatic).kind, 'skipped'); assert.equal((await explicit).kind, 'pending');
    assert.equal(gate.reads(), expiry === 'while waiting' ? 1 : 2);
    assert.deepEqual(f.counts, { api: 0, identity: 0 }); assert.equal(f.calls.length, 0); assert.deepEqual(f.rows(), before);
  });
});
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

test('Google Calendar exports a retained individual edit after the new series rule removes its original day', async t => {
  const h = await harness(t); await h.connect();
  const parent = await h.local({ allDay: true, recurrence: 'daily' });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  const masterId = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: parent.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-04', expectedExceptionRevision: 0,
    value: { ...parent, title: '個別で変更した予定', startDate: '2026-11-04', endDate: '2026-11-04', recurrence: 'none' } });
  await saveCalendarEvent(h.database, { id: parent.id, expectedRevision: 1, scope: 'series',
    value: { ...parent, title: '毎月の予定', recurrence: 'monthly' } });
  assert.equal((await readLocalCalendar(h.database)).exceptions[0].detached, true);
  h.api.instances = async () => { assert.fail('an anchor missing from the new rule has no Google instance'); };
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.equal(h.events.get(masterId).summary, '毎月の予定');
  const independent = [...h.events.values()].find(event => event.id !== masterId);
  assert.equal(independent.summary, '個別で変更した予定');
  assert.deepEqual(independent.start, { date: '2026-11-04' });
  assert.equal(independent.recurringEventId, undefined);
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.equal(h.events.size, 2);
  assert.equal((await readLocalCalendar(h.database)).exceptions[0].detached, true);
});

test('a stored empty recurrence does not wake background Google Calendar sync again once inspected', async t => {
  const h = await harness(t); await h.connect();
  const { id } = await h.local({ allDay: true, recurrence: 'custom', untilDate: '2026-11-03',
    customRecurrence: { unit: 'week', interval: 1, weekdays: [0] } });
  const sent = await h.local({ title: '同時に送る正常な予定' });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.deepEqual([...h.events.values()].map(event => event.summary), [sent.title]);
  const calls = h.calls.length;
  assert.equal(await personalCalendarHasPendingWork(h.database), false);
  assert.equal(h.calls.length, calls);
  assert.ok((await readLocalCalendar(h.database)).events.some(event => event.id === id));
});

test('an ambiguous Google recurrence update keeps its raw source and hides an obsolete time until it can be resolved', async t => {
  const h = await harness(t); await h.connect();
  const series = h.put(h.remote('series-ambiguous-offset', { recurrence: ['RRULE:FREQ=DAILY;COUNT=31'] }));
  const instance = h.remote('ambiguous-civil-time', { recurringEventId: series.id, summary: '以前の正午',
    start: { dateTime: '2026-11-01T12:00:00-05:00', timeZone: 'America/New_York' },
    end: { dateTime: '2026-11-01T13:00:00-05:00', timeZone: 'America/New_York' } });
  let source = instance;
  h.api.instances = async () => ({ items: [source] });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.deepEqual((await readLocalCalendar(h.database)).events.map(event => event.title), [instance.summary]);
  source = { ...instance, summary: '新しい会議', start: { ...instance.start, dateTime: '2026-11-01T01:30:00' } };
  h.put({ ...series, summary: 'Googleで更新' });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.deepEqual((await readLocalCalendar(h.database)).events, []);
  const retained = h.connection.prepare('SELECT event_json FROM calendar_google_inbox WHERE google_id=?').get(instance.id);
  assert.deepEqual(JSON.parse(retained.event_json), source);
  source = { ...source, start: { ...source.start, dateTime: '2026-11-01T01:30:00-05:00' } };
  h.put({ ...series, summary: 'Googleで時刻を確定' });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  const restored = (await readLocalCalendar(h.database)).events;
  assert.equal(restored[0]?.title, source.summary);
  assert.equal(restored[0]?.readOnly, true);
  assert.equal(h.calls.some(([method]) => method === 'patch' || method === 'insert' || method === 'remove'), false);
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
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts'); const notifications = [];
  t.after(subscribeLocalCalendar(h.database, change => notifications.push(change)));
  const pending = h.sync.sync(); await new Promise(resolve => setTimeout(resolve, 5)); h.subject('google-two'); release();
  assert.equal((await pending).kind, 'error'); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.deepEqual(notifications.filter(change => change === 'sync'), [], 'an uncommitted page from the old account cannot publish into the replacement scope');
});
test('an import batch rollback does not publish its partially applied event', async t => {
  const h = await harness(t); await h.connect();
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts'); const notifications = [];
  t.after(subscribeLocalCalendar(h.database, change => notifications.push(change)));
  const insert = h.connection.prepare('INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty) VALUES(?,?,?,?,1)');
  insert.run('google-one', 'owned', 'a-good', JSON.stringify(h.remote('a-good')));
  insert.run('google-one', 'owned', 'b-fail', JSON.stringify(h.remote('b-fail')));
  const original = h.database.runAsync; let eventInserts = 0;
  h.database.runAsync = async (sql, ...args) => {
    if (sql.startsWith('INSERT INTO calendar_events(id,definition_json,revision,deleted)') && ++eventInserts === 2) throw new Error('synthetic import rollback');
    return original(sql, ...args);
  };
  try { assert.equal((await h.sync.sync()).kind, 'error'); }
  finally { h.database.runAsync = original; }
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_links').get().n, 0);
  assert.deepEqual(notifications.filter(change => change === 'sync'), [], 'the transaction did not commit, so observers stay quiet');
});
test('the first imported page is observable while later pages wait and remaining page notifications coalesce', async t => {
  const h = await harness(t); await h.connect();
  let releaseSecond; let announceSecond;
  const secondPageGate = new Promise(resolve => { releaseSecond = resolve; });
  const secondPageEntered = new Promise(resolve => { announceSecond = resolve; });
  let page = 0;
  h.api.events = async (_calendarId, cursor) => {
    if (cursor.syncToken) return { items: [], nextSyncToken: cursor.syncToken };
    page++;
    if (page === 1) return { items: [h.remote('page-one')], nextPageToken: 'page-2' };
    if (page === 2) { announceSecond(); await secondPageGate; return { items: [h.remote('page-two')], nextPageToken: 'page-3' }; }
    return { items: [h.remote('page-three')], nextSyncToken: 'sync-three' };
  };
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts'); const notifications = [];
  t.after(subscribeLocalCalendar(h.database, change => { if (change === 'sync') notifications.push(change); }));
  const pending = h.sync.sync({ force: true }); await secondPageEntered;
  assert.deepEqual(notifications, ['sync'], 'the first matching-account page committed and became observable before the second request resolved');
  assert.deepEqual((await readLocalCalendar(h.database)).events.map(event => event.id), [h.links().find(link => link.google_id === 'page-one').event_id]);
  releaseSecond(); assert.equal((await pending).kind, 'success');
  assert.equal((await readLocalCalendar(h.database)).events.length, 3);
  assert.deepEqual(notifications, ['sync', 'sync'], 'later committed pages share one final observer refresh');
  await h.sync.sync();
  assert.deepEqual(notifications, ['sync', 'sync'], 'an unchanged pass emits no extra notification');
});
test('a standalone read-only Google fallback is visible while the next page is still pending', async t => {
  const h = await harness(t); await h.connect();
  const longTitle = '長'.repeat(200);
  const first = h.remote('long-title', { summary: longTitle });
  const nextPage = Promise.withResolvers();
  const release = Promise.withResolvers();
  const pages = [];
  h.api.events = async (_calendarId, cursor) => {
    pages.push(cursor.pageToken);
    if (!cursor.pageToken) return { items: [first], nextPageToken: 'second' };
    nextPage.resolve(); await release.promise;
    return { items: [], nextSyncToken: 'done' };
  };
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
  const notifications = [];
  t.after(subscribeLocalCalendar(h.database, change => { if (change === 'sync') notifications.push(change); }));
  const syncing = h.sync.sync();
  try {
    await nextPage.promise;
    assert.deepEqual(notifications, ['sync']);
    const [event] = (await readLocalCalendar(h.database)).events;
    assert.equal(event.title, longTitle.slice(0, 160)); assert.equal(event.readOnly, true);
    assert.equal(JSON.parse(h.links()[0].remote_json).summary, longTitle);
  } finally { release.resolve(); await syncing; }
  assert.deepEqual(pages, [undefined, 'second']);
  assert.deepEqual(notifications, ['sync']);
  assert.deepEqual(await syncing, { kind: 'success', received: 1, sent: 0 });
});

test('long all-day Google events retain their full read-only display span while other imports and local writes continue', async t => {
  const h = await harness(t); await h.connect(); await h.local({ title: '送信待ちの予定' });
  const long = h.put(h.remote('a-long-all-day', { start: { date: '2026-11-01' }, end: { date: '2028-11-02' } }));
  h.put(h.remote('b-ordinary'));
  const result = await h.sync.sync(); assert.equal(result.kind, 'success'); assert.equal(result.received, 2); assert.equal(result.sent, 1);
  const local = await readLocalCalendar(h.database);
  const imported = local.events.find(row => row.id === h.links().find(link => link.google_id === long.id).event_id);
  assert.equal(imported.startDate, '2026-11-01'); assert.equal(imported.endDate, '2028-11-01');
  assert.equal(imported.readOnly, true); assert.equal(imported.allDay, true);
  const savedSource = JSON.parse(h.links().find(link => link.google_id === long.id).remote_json);
  assert.deepEqual([savedSource.start.date, savedSource.end.date], ['2026-11-01', '2028-11-02']);
  const { readCalendarEventRows } = await import('../src/platform/storage/calendar-event-rows.ts');
  const laterRange = await readCalendarEventRows(h.database, { from: '2028-01-01', through: '2028-01-31' });
  assert.equal(laterRange.events.find(row => row.id === imported.id)?.endDate, '2028-11-01', 'raw long-span dates keep the event visible in later requested months');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox WHERE dirty<>0').get().n, 0);
  assert.equal(h.calls.filter(call => call[0] === 'insert').length, 1);
});

test('long timed Google events remain readable and do not block subsequent imports or outgoing edits', async t => {
  const h = await harness(t); await h.connect(); await h.local({ title: '送信する予定' });
  const long = h.put(h.remote('a-long-timed', { start: { dateTime: '2026-11-01T19:15:00Z' }, end: { dateTime: '2028-11-02T20:45:00Z' } }));
  h.put(h.remote('b-ordinary'));
  const result = await h.sync.sync();
  assert.deepEqual(result, { kind: 'success', received: 2, sent: 1 });
  const link = h.links().find(link => link.google_id === long.id);
  const { readCalendarEventRows } = await import('../src/platform/storage/calendar-event-rows.ts');
  const { events } = await readCalendarEventRows(h.database, { from: '2028-01-01', through: '2028-01-31' });
  const view = events.find(event => event.id === link.event_id);
  assert.equal(view.readOnly, true);
  assert.deepEqual([view.startDate, view.startMinute, view.endDate, view.endMinute], ['2026-11-01', 1155, '2028-11-02', 1245]);
});

test('an unsupported recurring replacement stays unpublished until its instance projection commits', async t => {
  const h = await harness(t); await h.connect();
  h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY'] })); await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts'); const notifications = [];
  t.after(subscribeLocalCalendar(h.database, change => { if (change === 'sync') notifications.push(change); }));
  h.put({ ...h.events.get('series'), recurrence: ['RRULE:FREQ=DAILY;COUNT=999'] });
  let releaseInstances; let announceInstances;
  const instancesGate = new Promise(resolve => { releaseInstances = resolve; });
  const instancesEntered = new Promise(resolve => { announceInstances = resolve; });
  h.api.instances = async () => {
    announceInstances(); await instancesGate;
    return { items: [h.remote('series-instance', { recurringEventId: 'series', originalStartTime: { date: '2026-11-04' }, start: { date: '2026-11-04' }, end: { date: '2026-11-05' } })] };
  };
  const pending = h.sync.sync(); await instancesEntered;
  assert.deepEqual(notifications, [], 'a partial replacement is not a publishable calendar');
  const duringReplacement = await readLocalCalendar(h.database);
  assert.equal(duringReplacement.events.length, 1, 'the prior series remains visible until every replacement instance is ready');
  assert.equal(duringReplacement.events[0].recurrence, 'daily');
  releaseInstances(); assert.equal((await pending).kind, 'success');
  assert.deepEqual(notifications, ['sync']); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
});
test('a failed unsupported recurring replacement preserves its previous projection and retries the staged scan', async t => {
  const h = await harness(t); await h.connect();
  h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY'] })); await h.sync.sync();
  const prior = (await readLocalCalendar(h.database)).events[0];
  h.put({ ...h.events.get('series'), recurrence: ['RRULE:FREQ=DAILY;COUNT=999'] });
  h.api.instances = async () => { throw new GoogleCalendarHttpError(503); };
  assert.equal((await h.sync.sync()).kind, 'error');
  const afterFailure = (await readLocalCalendar(h.database)).events;
  assert.equal(afterFailure.length, 1); assert.equal(afterFailure[0].id, prior.id);
  assert.equal(afterFailure[0].recurrence, 'daily');
  h.api.instances = async () => ({ items: [h.remote('replacement', { recurringEventId: 'series', originalStartTime: { date: '2026-11-04' } })] });
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  const replacement = (await readLocalCalendar(h.database)).events;
  assert.equal(replacement.length, 1); assert.equal(replacement[0].title, 'Googleの予定');
  assert.equal(replacement[0].recurrence, 'none');
});
test('a previous account import never becomes a new export after switching Google accounts', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote()); await h.sync.sync(); h.events.clear(); h.subject('google-two'); await h.connect();
  await h.sync.sync(); assert.equal(h.calls.filter(row => row[0] === 'insert').length, 0);
});
test('Google calendar category names follow the connected account while user-created categories remain available', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('first-account-event')); await h.sync.sync();
  const first = await readLocalCalendar(h.database); const oldGoogleCategory = first.categories.find(row => row.name === '個人');
  assert.ok(oldGoogleCategory);
  await saveCalendarCategory(h.database, { expectedRevision: 0, name: '自作の分類', color: '#7766AA' });
  h.subject('google-two'); h.api.calendars = async () => ({ items: [{ id: 'owned', summary: '別アカウントの分類', accessRole: 'owner', primary: true, timeZone: 'Asia/Tokyo' }] });
  await h.connect();
  let current = await readLocalCalendar(h.database);
  assert.equal(current.categories.some(row => row.id === oldGoogleCategory.id), false);
  assert.ok(current.categories.some(row => row.name === '自作の分類'));
  h.events.clear(); h.put(h.remote('second-account-event')); await h.sync.sync(); current = await readLocalCalendar(h.database);
  const newGoogleCategory = current.categories.find(row => row.name === '別アカウントの分類');
  assert.ok(newGoogleCategory); assert.notEqual(newGoogleCategory.id, oldGoogleCategory.id);
  assert.equal(current.categories.some(row => row.name === '個人'), false);
  assert.ok(current.categories.some(row => row.name === '自作の分類'));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_events WHERE deleted=0').get().n, 2, 'the switched account keeps the previous account event stored');
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
test('a Calendar delta 410 gets one full snapshot attempt and backs off if that tokenless request also expires', async t => {
  const h = await harness(t); await h.connect(); assert.equal((await h.sync.sync()).kind, 'success');
  const calls = []; h.api.events = async (_calendarId, cursor) => { calls.push(clone(cursor)); throw new GoogleCalendarHttpError(410); };
  const result = await h.sync.sync({ force: true });
  assert.equal(result.kind, 'error');
  assert.equal(calls.length, 2, 'an expired delta is followed by exactly one tokenless full read');
  assert.ok(calls[0].syncToken); assert.equal(calls[1].syncToken, undefined);
  const next = await h.sync.sync(); assert.equal(next.kind, 'pending', 'the failed full read uses ordinary retry backoff');
  assert.equal(calls.length, 2, 'backoff prevents a repeated tokenless read');
});
test('a tokenless Calendar 410 does not repeat the same full read in one sync pass', async t => {
  const h = await harness(t); await h.connect(); const calls = []; h.api.events = async (_calendarId, cursor) => { calls.push(clone(cursor)); throw new GoogleCalendarHttpError(410); };
  const result = await h.sync.sync({ force: true }); assert.equal(result.kind, 'error');
  assert.equal(calls.length, 1); assert.equal(calls[0].syncToken, undefined);
});
for (const localEdit of [false, true]) test(`a Google 410 full snapshot removes a missing prior exception${localEdit ? ' as a conflict when it has a local edit' : ''}`, async t => {
  const h = await harness(t); await h.connect();
  const master = h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY;UNTIL=20261110'] }));
  const exception = h.put(h.remote('exception', { recurringEventId: master.id, originalStartTime: { date: '2026-11-05' },
    start: { date: '2026-11-08' }, end: { date: '2026-11-09' } }));
  assert.equal((await h.sync.sync()).kind, 'success');
  let local = await readLocalCalendar(h.database);
  const series = local.events.find(event => h.links().some(link => link.event_id === event.id && link.google_id === master.id));
  const previous = local.exceptions.find(row => row.eventId === series.id && row.anchorDate === '2026-11-05');
  assert.ok(previous?.override);
  if (localEdit) await saveCalendarEvent(h.database, { id: series.id, expectedRevision: series.revision, scope: 'one', anchorDate: previous.anchorDate,
    expectedExceptionRevision: previous.revision, value: { ...previous.override, title: '端末で変更', startDate: '2026-11-09', endDate: '2026-11-09', recurrence: 'none' } });
  h.events.delete(exception.id);
  const original = h.api.events; let expireDelta = true;
  h.api.events = async (calendarId, cursor) => {
    if (cursor.syncToken && expireDelta) { expireDelta = false; throw new GoogleCalendarHttpError(410); }
    return original(calendarId, cursor);
  };
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  local = await readLocalCalendar(h.database);
  const current = local.exceptions.find(row => row.eventId === series.id && row.anchorDate === '2026-11-05');
  if (localEdit) {
    assert.equal(current?.override?.title, '端末で変更', 'the absent remote exception must not erase a pending local edit');
    const [conflict] = await h.sync.readConflicts(); assert.equal(conflict.eventId, series.id); assert.equal(conflict.remote.status, 'cancelled');
  } else {
    assert.equal(current, undefined, 'an authoritative full snapshot removes an exception omitted by Google');
    assert.deepEqual(projectCalendarEvents(local.events, local.exceptions, '2026-11-05', '2026-11-08').map(row => row.startDate), ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    assert.equal(h.links().find(link => link.google_id === exception.id).conflict_json, null);
  }
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

test('an unsupported exception of a locally exported series waits for its master on the next Google page', async t => {
  const h = await harness(t); await h.connect();
  await h.local({ allDay: true, recurrence: 'daily' });
  assert.equal((await h.sync.sync()).sent, 1);
  const master = h.events.get(h.links()[0].google_id);
  const exception = h.remote('long-exception', { etag: 'instance', summary: '長'.repeat(180),
    recurringEventId: master.id, originalStartTime: { date: '2026-11-04' } });
  const inbox = h.connection.prepare('SELECT dirty FROM calendar_google_inbox WHERE subject=? AND calendar_id=? AND google_id=?');
  assert.equal(inbox.get('google-one', 'owned', master.id), undefined);
  const pages = []; const expansions = [];
  h.api.events = async (_calendarId, cursor) => {
    pages.push(cursor.pageToken);
    if (!cursor.pageToken) return { items: [exception], nextPageToken: 'master-page' };
    assert.equal(inbox.get('google-one', 'owned', exception.id).dirty, 2);
    return { items: [master], nextSyncToken: 'complete' };
  };
  h.api.instances = async (calendarId, parentId) => { expansions.push([calendarId, parentId]); return { items: [exception] }; };
  h.calls.length = 0;
  assert.equal((await h.sync.sync()).kind, 'success');
  assert.deepEqual(pages, [undefined, 'master-page']);
  assert.deepEqual(expansions, [['owned', master.id]]);
  assert.deepEqual(h.calls.map(call => call[0]), ['calendars']);
  assert.equal(inbox.get('google-one', 'owned', exception.id).dirty, 0);
  const [visible] = (await readLocalCalendar(h.database)).events;
  assert.equal(visible.title, exception.summary.slice(0, 160)); assert.equal(visible.readOnly, true);
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
test('bundled Japanese holidays remain display only through Google synchronization and an ordinary holiday-date appointment still exports', async t => {
  const h = await harness(t); const { screenHarness } = await import('./helpers/screen-harness.mjs');
  const snapshot = await readLocalCalendar(h.database);
  const ui = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform: 'ios', props: {
    today: '2026-11-03', timeZone: 'Asia/Tokyo', local: { database: h.database, snapshot, refresh: async () => {} },
    dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
  } }); t.after(() => ui.unmount());
  assert.ok(ui.nodes().some(node => node.props.accessibilityLabel?.includes('祝日：文化の日')));
  assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  await h.connect(); assert.equal((await h.sync.sync()).kind, 'success');
  assert.equal(h.events.size, 0); assert.equal(h.calls.some(call => ['insert', 'patch', 'remove'].includes(call[0])), false);
  await h.local({ title: '文化の日の食事会', allDay: true });
  assert.equal((await h.sync.sync({ force: true })).sent, 1);
  assert.equal(h.events.size, 1); assert.equal([...h.events.values()][0].summary, '文化の日の食事会');
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
test('undoing a newly moved recurrence exports a reset of the same Google instance and does not resend unchanged data', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local({ allDay: true, recurrence: 'weekly' }); await h.sync.sync();
  const master = h.links()[0].google_id;
  const instance = h.put(h.remote('undo-instance', { summary: '予定', recurringEventId: master, originalStartTime: { date: '2026-11-10' }, start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }));
  h.api.instances = async () => ({ items: [clone(h.events.get(instance.id))] });
  await h.sync.sync(); let local = await readLocalCalendar(h.database);
  const before = local.exceptions.find(row => row.anchorDate === '2026-11-10');
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-10', expectedExceptionRevision: before?.revision ?? 0,
    value: { ...event, startDate: '2026-11-11', endDate: '2026-11-11', recurrence: 'none' } });
  assert.equal((await h.sync.sync()).kind, 'success'); assert.equal(h.events.get(instance.id).start.date, '2026-11-11');
  local = await readLocalCalendar(h.database); const moved = local.exceptions.find(row => row.anchorDate === '2026-11-10');
  await restoreCalendarOccurrence(h.database, { eventId: event.id, revision: 1, scope: 'one', anchorDate: moved.anchorDate, exceptionRevision: moved.revision, value: event });
  assert.equal((await h.sync.sync()).kind, 'success'); assert.equal(h.events.get(instance.id).start.date, '2026-11-10');
  assert.equal(h.calls.filter(row => row[0] === 'insert').length, 1, 'undo must not create a new Google series');
  h.calls.length = 0; await h.sync.sync(); assert.equal(h.calls.some(row => ['insert', 'patch', 'remove'].includes(row[0])), false);
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
test('native Google sync checks request authority once at transport boundaries and once around each SQLite commit', async t => {
  let identities = 0; let settingsReads = 0; let httpRequests = 0; let nativeApiGuarded = false;
  const h = await harness(t, {
    currentSubject: async () => { identities++; return 'google-one'; },
    createApi: context => {
      const api = createGoogleCalendarApi({ ...context, token: async () => 'synthetic-token', fetch: async url => {
        httpRequests++;
        if (String(url).includes('/users/me/calendarList')) return Response.json({ items: [{ id: 'owned', summary: '個人', accessRole: 'owner', primary: true }] });
        return Response.json({ items: [], nextSyncToken: 'stable-token' });
      } });
      nativeApiGuarded = googleCalendarApiOwnsRequestAuthority(api, context.assertCurrent);
      assert.equal(googleCalendarApiOwnsRequestAuthority(api, async () => {}), false, 'a different guard does not replace the current account and generation check');
      return api;
    },
  });
  await h.connect(); assert.equal(nativeApiGuarded, true); identities = 0; httpRequests = 0;
  const getFirst = h.database.getFirstAsync;
  h.database.getFirstAsync = async (sql, ...args) => {
    if (sql === 'SELECT control_json FROM calendar_google_control WHERE singleton=1') settingsReads++;
    return getFirst(sql, ...args);
  };
  const result = await h.sync.sync({ force: true });
  assert.equal(result.kind, 'success'); assert.equal(httpRequests, 2);
  assert.deepEqual({ identities, settingsReads }, { identities: 33, settingsReads: 24 },
    'the two HTTP responses retain the native pre/post transport checks without the sync wrapper repeating them');
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
test('disjoint Google display ranges expand unsupported series separately and retain previously cached dates', async t => {
  const h = await harness(t); await h.connect(); h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY;COUNT=999'] }));
  const ranges = [];
  h.api.instances = async (_calendar, _id, range) => { ranges.push(clone(range)); return { items: [h.remote('near', { recurringEventId: 'series' }),
    ...(range.timeMax > '2028-01-01' ? [h.remote('far', { recurringEventId: 'series', start: { date: '2028-01-04' }, end: { date: '2028-01-05' } })] : [])] }; };
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  assert.equal(await h.sync.requestRange('2028-01-01', '2028-02-01'), true);
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 2);
  assert.equal(ranges.length, 2); assert.ok(ranges[1].timeMin > ranges[0].timeMax, 'distant coverage stays disjoint instead of scanning the gap');
  assert.ok(ranges[0].timeMax < '2027-06-01' && ranges[1].timeMin > '2027-06-01', 'the unrelated middle period is never requested');
  assert.ok(ranges[1].timeMax > '2028-02-01');
  assert.equal(await h.sync.requestRange('2028-01-02', '2028-01-03'), false);
  await h.sync.sync(); assert.equal(ranges.length, 2, 'unchanged coverage must not repeatedly ask Google to expand a series');
});
test('an expired page in a disjoint atomic series replacement restarts every range before publishing', async t => {
  const h = await harness(t); await h.connect(); const master = h.put(h.remote('series', { recurrence: ['RRULE:FREQ=DAILY;COUNT=999'] }));
  const oldNear = h.remote('old-near', { recurringEventId: master.id, originalStartTime: { date: '2026-11-03' } });
  const oldFar = h.remote('old-far', { recurringEventId: master.id, originalStartTime: { date: '2030-01-01' }, start: { date: '2030-01-01' }, end: { date: '2030-01-02' } });
  let replacement = false; let expired = false; const requested = [];
  h.api.instances = async (_calendar, _id, range) => { requested.push({ ...clone(range) }); return { items: [range.timeMin > '2029-01-01' ? oldFar : oldNear] }; };
  assert.equal((await h.sync.sync()).kind, 'success');
  await h.sync.requestRange('2030-01-01', '2030-01-02'); assert.equal((await h.sync.sync()).kind, 'success');
  const prior = (await readLocalCalendar(h.database)).events.map(event => event.id).sort();
  assert.equal(prior.length, 2, 'both previously cached expanded occurrences are visible');
  requested.length = 0;
  h.api.instances = async (_calendar, _id, range) => {
    requested.push({ ...clone(range) });
    if (!replacement) return { items: [range.timeMin > '2029-01-01' ? oldFar : oldNear] };
    if (range.timeMin > '2029-01-01' && range.pageToken === 'expired-page' && !expired) { expired = true; throw new GoogleCalendarHttpError(400); }
    if (range.timeMin > '2029-01-01' && range.pageToken === 'expired-page')
      return { items: [h.remote('new-far-last', { recurringEventId: 'series', originalStartTime: { date: '2030-01-02' }, start: { date: '2030-01-02' }, end: { date: '2030-01-03' } })] };
    if (range.timeMin > '2029-01-01') return { items: [h.remote('new-far-first', { recurringEventId: 'series', originalStartTime: { date: '2030-01-01' }, start: { date: '2030-01-01' }, end: { date: '2030-01-02' } })], nextPageToken: 'expired-page' };
    return { items: [h.remote('new-near', { recurringEventId: 'series', originalStartTime: { date: '2026-11-03' } })] };
  };
  replacement = true; h.put({ ...master, summary: '新しい繰り返し予定' });
  assert.equal((await h.sync.sync()).kind, 'pending');
  assert.equal(expired, true); assert.deepEqual((await readLocalCalendar(h.database)).events.map(event => event.id).sort(), prior,
    'a partial staged replacement cannot change the visible projection');
  assert.ok(requested[0].timeMin > '2029-01-01' && requested[1].timeMin > '2029-01-01',
    'the currently visible far interval is scanned first and its page token stays attached to that range');
  assert.equal(requested[1].pageToken, 'expired-page');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_expansion_staged').get().n, 0, 'expired pagination clears staged rows before replay');
  const expansion = h.connection.prepare('SELECT scan_ranges_json,covered_ranges_json FROM calendar_google_expansion').get();
  assert.equal(JSON.parse(expansion.scan_ranges_json).length, 2, 'replay includes completed and pending disjoint intervals');
  assert.ok(JSON.parse(expansion.scan_ranges_json)[0].timeMin > '2029-01-01', 'replay preserves visible-range priority');
  assert.deepEqual(JSON.parse(expansion.covered_ranges_json), []);
  const replayStart = requested.length;
  assert.equal((await h.sync.sync({ force: true })).kind, 'success');
  assert.ok(requested[replayStart].timeMin > '2029-01-01' && requested[replayStart + 1].timeMin > '2029-01-01'
    && requested[replayStart + 1].pageToken === 'expired-page', 'a resumed scan keeps each page token with its prioritized range');
  const visible = (await readLocalCalendar(h.database)).events;
  assert.equal(visible.length, 3, 'the complete near and far snapshots replace the prior projection');
  assert.ok(visible.every(event => event.title === 'Googleの予定'));
  assert.ok(requested.some(range => range.timeMin > '2029-01-01') && requested.some(range => range.timeMin < '2027-01-01' && range.timeMax < '2028-01-01'));
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
  identities = 0; const result = await h.sync.sync(); assert.equal(result.kind, 'success'); assert.equal(result.received, 100);
  assert.ok(identities < 60, `native identity checks must be per HTTP/atomic batch, got ${identities}`);
});

test('a healthy thousand-event initial import drains ten Google pages in one foreground budget and yields between committed chunks', async t => {
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const h = await harness(t, { now: () => clock });
  await h.connect();
  await h.local({ title: '送信待ちの予定' });
  const pages = [];
  h.api.events = async (_calendarId, cursor) => {
    assert.equal(cursor.syncToken, undefined);
    const offset = Number(cursor.pageToken ?? 0);
    pages.push(offset); clock += 100;
    const items = Array.from({ length: 100 }, (_, i) => h.remote(`bulk-${offset + i}`, { etag: `e-${offset + i}` }));
    return offset < 900 ? { items, nextPageToken: String(offset + 100) } : { items, nextSyncToken: 'complete' };
  };

  const count = h.connection.prepare("SELECT count(*) n FROM calendar_events WHERE id GLOB 'google.*' AND deleted=0");
  const committedChunks = [];
  const transaction = h.database.withTransactionAsync;
  h.database.withTransactionAsync = async work => {
    const before = count.get().n;
    await transaction(work);
    const imported = count.get().n - before;
    if (imported) { committedChunks.push(imported); clock += imported * 4; }
  };
  const { subscribeLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
  const observed = []; let countAfterYield;
  t.after(subscribeLocalCalendar(h.database, change => {
    if (change !== 'sync') return;
    observed.push(count.get().n);
    if (observed.length === 1) setTimeout(() => { countAfterYield = count.get().n; }, 0);
  }));

  const result = await h.sync.sync({ budgetMs: 12_000 });
  assert.deepEqual(result, { kind: 'success', received: 1000, sent: 1 });
  assert.deepEqual(pages, Array.from({ length: 10 }, (_, n) => n * 100));
  assert.deepEqual(h.calls.map(call => call[0]), ['calendars', 'insert']);
  assert.equal(committedChunks.length, 40);
  assert.ok(committedChunks.every(size => size === 25));
  assert.deepEqual(observed, [25, 1000]);
  assert.equal(countAfterYield, 25, 'foreground work can run before the second transaction starts');
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox WHERE dirty<>0').get().n, 0);
  assert.equal(h.connection.prepare('SELECT sync_token FROM calendar_google_cursors').get().sync_token, 'complete');
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

test('personal Google title shortening keeps the raw title through its echo and remote edits to other fields but adopts an explicit rename', async t => {
  const h = await harness(t); await h.connect();
  const title = '毎月21日学校';
  const event = await h.local({ title, startDate: '2026-11-21', endDate: '2026-11-21', allDay: true, recurrence: 'monthly' });
  assert.equal((await h.sync.sync()).sent, 1); const id = h.links()[0].google_id;
  assert.equal(h.events.get(id).summary, '学校');
  assert.equal(JSON.parse(h.links()[0].base_json).title, '学校');
  assert.equal(JSON.parse(h.links()[0].local_base_json).title, title);
  const proof = h.events.get(id).extendedProperties.private.liflowTitleProof;
  assert.match(proof, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(h.events.get(id).extendedProperties).includes(title));
  h.calls.length = 0; await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events[0].title, title);
  assert.equal(h.calls.some(call => ['insert', 'patch', 'remove'].includes(call[0])), false);
  h.put({ ...h.events.get(id), location: '別の教室', start: { date: '2026-11-22' }, end: { date: '2026-11-23' } });
  h.calls.length = 0; await h.sync.sync(); const moved = (await readLocalCalendar(h.database)).events[0];
  assert.equal(moved.id, event.id); assert.equal(moved.title, title); assert.equal(moved.location, '別の教室'); assert.equal(moved.startDate, '2026-11-22');
  assert.equal(h.calls.some(call => call[0] === 'patch'), false);
  h.put({ ...h.events.get(id), summary: 'Googleで決めた学校名' });
  await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events[0].title, 'Googleで決めた学校名');
  assert.equal((await h.sync.readConflicts()).length, 0);
});

test('personal title preference applies to the next content write while unchanged and category-only revisions never resend names', async t => {
  let shorten = false; const h = await harness(t, { readTitleShortening: () => shorten }); await h.connect();
  const title = '毎年5月22日お父さん誕生日'; const event = await h.local({ title });
  await h.sync.sync(); const id = h.links()[0].google_id;
  assert.equal(h.events.get(id).summary, title); assert.equal(h.events.get(id).extendedProperties.private.liflowTitleProof, undefined);
  shorten = true; h.calls.length = 0; await h.sync.sync();
  assert.equal(h.events.get(id).summary, title); assert.equal(h.calls.some(call => call[0] === 'patch'), false);
  // A revision whose Google-owned data did not change is also inert.
  h.connection.prepare('UPDATE calendar_events SET revision=revision+1 WHERE id=?').run(event.id);
  await h.sync.sync(); assert.equal(h.calls.some(call => call[0] === 'patch'), false);
  let local = (await readLocalCalendar(h.database)).events[0];
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: local.revision, value: { ...local, notes: '贈り物を選ぶ' } });
  await h.sync.sync(); assert.equal(h.events.get(id).summary, 'お父さん誕生日');
  shorten = false; h.calls.length = 0; await h.makeSync().sync();
  assert.equal(h.calls.some(call => call[0] === 'patch'), false); assert.equal(h.events.get(id).summary, 'お父さん誕生日');
  local = (await readLocalCalendar(h.database)).events[0];
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: local.revision, value: { ...local, notes: '予約済み' } });
  await h.sync.sync(); assert.equal(h.events.get(id).summary, title);
  assert.equal(h.events.get(id).extendedProperties.private.liflowTitleProof, null);
  assert.equal((await readLocalCalendar(h.database)).events[0].title, title);
});

test('a raw title edit whose Google label is unchanged advances its baseline without a Google write', async t => {
  const h = await harness(t); await h.connect(); const event = await h.local({ title: '毎月21日学校' }); await h.sync.sync();
  await h.sync.sync(); h.calls.length = 0;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '毎月22日学校' } });
  await h.sync.sync(); assert.equal(h.calls.some(call => call[0] === 'patch'), false);
  assert.equal(JSON.parse(h.links()[0].local_base_json).title, '毎月22日学校'); assert.equal(h.links()[0].local_revision, 2);
  assert.equal((await readLocalCalendar(h.database)).events[0].title, '毎月22日学校');
});

for (const method of ['insert', 'patch']) test(`a lost personal ${method} acknowledgement preserves its exact shortened intent across a preference change and restart`, async t => {
  let shorten = true; const h = await harness(t, { readTitleShortening: () => shorten }); await h.connect();
  const title = '旅行 4月11日から1週間'; const event = await h.local({ title }); let revision = 1;
  if (method === 'patch') {
    await h.sync.sync(); await saveCalendarEvent(h.database, { id: event.id, expectedRevision: revision++, value: { ...event, notes: '送信対象' } });
  }
  h.loseNext(method); assert.equal((await h.sync.sync({ force: true })).kind, 'error');
  const intent = JSON.parse(h.links()[0].pending_json); assert.equal(intent.payload.summary, '旅行'); assert.equal(JSON.parse(intent.localOwned).title, title);
  const originalEvents = h.api.events; h.api.events = async () => ({ items: [], nextSyncToken: 'S0' });
  shorten = false;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: revision, value: { ...event, notes: '応答喪失後の編集' } });
  assert.equal((await h.makeSync().sync({ force: true })).kind, 'success');
  h.api.events = originalEvents; await h.sync.sync({ force: true });
  assert.equal(h.events.size, 1); assert.equal([...h.events.values()][0].summary, title);
  assert.equal((await readLocalCalendar(h.database)).events[0].title, title);
  assert.equal(h.links()[0].pending_json, null); assert.equal((await h.sync.readConflicts()).length, 0);
  assert.equal(new Set(h.calls.filter(call => call[0] === 'insert').map(call => call[1])).size, 1);
});

test('two personal installations with different title preferences preserve the same original without echoing each others labels', async t => {
  const a = await harness(t, { readTitleShortening: () => false });
  const b = await harness(t, { readTitleShortening: () => true }); Object.assign(b.api, a.api);
  await a.connect(); const title = '毎週火曜日、日曜日ランチ'; await a.local({ title }); await a.sync.sync();
  await b.connect(); await b.sync.sync(); let second = (await readLocalCalendar(b.database)).events[0];
  assert.equal(second.title, title);
  await saveCalendarEvent(b.database, { id: second.id, expectedRevision: second.revision, value: { ...second, location: '別端末で選んだ店' } });
  await b.sync.sync(); assert.equal([...a.events.values()][0].summary, 'ランチ');
  a.calls.length = 0; await a.sync.sync(); let first = (await readLocalCalendar(a.database)).events[0];
  assert.equal(first.title, title); assert.equal(first.location, '別端末で選んだ店'); assert.equal(a.calls.some(call => call[0] === 'patch'), false);
  await saveCalendarEvent(a.database, { id: first.id, expectedRevision: first.revision, value: { ...first, notes: '原文設定の端末で編集' } });
  await a.sync.sync(); assert.equal([...a.events.values()][0].summary, title);
  a.calls.length = 0; await b.sync.sync(); second = (await readLocalCalendar(b.database)).events[0];
  assert.equal(second.title, title); assert.equal(second.notes, '原文設定の端末で編集'); assert.equal(a.calls.some(call => call[0] === 'patch'), false);
  await a.sync.sync(); await b.sync.sync(); assert.equal(a.calls.some(call => call[0] === 'patch'), false);
});

test('personal title proof and a lost acknowledgement remain bound to the original Google account', async t => {
  const h = await harness(t); await h.connect(); const title = '毎月11日、12日ハッカソン'; await h.local({ title });
  h.loseNext(); await h.sync.sync(); const pending = h.links()[0].pending_json; const writes = h.calls.filter(call => call[0] === 'insert').length;
  h.subject('different-google-account'); assert.equal((await h.makeSync().sync({ force: true })).kind, 'error');
  assert.equal(h.links()[0].pending_json, pending); assert.equal(h.calls.filter(call => call[0] === 'insert').length, writes);
  h.subject('google-one'); assert.equal((await h.makeSync().sync({ force: true })).kind, 'success');
  assert.equal(h.events.size, 1); assert.equal([...h.events.values()][0].summary, 'ハッカソン');
  assert.equal((await readLocalCalendar(h.database)).events[0].title, title); assert.equal(h.links()[0].pending_json, null);
});

for (const unacknowledged of [false, true]) test(`choosing Google after a title conflict restores the original represented by its unchanged label with pending=${unacknowledged}`, async t => {
  const h = await harness(t); await h.connect(); const title = '毎月21日学校'; const event = await h.local({ title });
  if (unacknowledged) h.loseNext(); await h.sync.sync(); const id = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, title: '毎月22日別の学校' } });
  h.put({ ...h.events.get(id), location: 'Googleで変更した教室' }); await h.sync.sync({ force: true });
  const [conflict] = await h.sync.readConflicts(); assert.ok(conflict); assert.equal(conflict.remote.summary, '学校');
  await h.sync.resolveConflict(conflict, 'google'); await h.sync.sync({ force: true });
  const local = (await readLocalCalendar(h.database)).events[0];
  assert.equal(local.title, title); assert.equal(local.location, 'Googleで変更した教室'); assert.equal(h.events.get(id).summary, '学校');
  assert.equal((await h.sync.readConflicts()).length, 0); assert.equal(h.links()[0].pending_json, null);
});

test('personal Google titles without recognized date text remain unchanged and carry no title proof', async t => {
  const h = await harness(t); await h.connect(); const titles = ['ＳＦ研究会２', '一二三倶楽部', '文化の日の食事会'];
  for (const title of titles) await h.local({ title });
  await h.sync.sync(); assert.deepEqual([...h.events.values()].map(event => event.summary).sort(), [...titles].sort());
  assert.ok([...h.events.values()].every(event => event.extendedProperties.private.liflowTitleProof === undefined));
  h.calls.length = 0; await h.sync.sync(); await h.makeSync().sync();
  assert.equal(h.calls.some(call => ['insert', 'patch'].includes(call[0])), false);
  assert.deepEqual((await readLocalCalendar(h.database)).events.map(event => event.title).sort(), [...titles].sort());
});

test('matching local and remote content edits converge without a false conflict caused by a shortened Google title', async t => {
  const h = await harness(t); await h.connect(); const title = '毎月21日学校'; const event = await h.local({ title });
  await h.sync.sync(); const id = h.links()[0].google_id;
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, value: { ...event, notes: '両方で同じ内容へ変更' } });
  h.put({ ...h.events.get(id), description: '両方で同じ内容へ変更' }); h.calls.length = 0;
  await h.sync.sync(); assert.equal((await h.sync.readConflicts()).length, 0);
  const local = (await readLocalCalendar(h.database)).events[0]; assert.equal(local.title, title); assert.equal(local.notes, '両方で同じ内容へ変更');
  assert.equal(h.calls.some(call => call[0] === 'patch'), false); assert.equal(h.links()[0].local_revision, local.revision);
});

test('a Google occurrence moved under a shortened series inherits its original title until that occurrence is explicitly renamed', async t => {
  const h = await harness(t); await h.connect(); const title = '毎週火曜日、日曜日ランチ';
  await h.local({ title, allDay: true, recurrence: 'daily' }); await h.sync.sync(); const parentId = h.links()[0].google_id;
  const occurrence = { id: 'shortened-instance', summary: 'ランチ', recurringEventId: parentId, originalStartTime: { date: '2026-11-04' },
    start: { date: '2026-11-05' }, end: { date: '2026-11-06' } };
  h.put(occurrence); h.calls.length = 0; await h.sync.sync();
  let local = await readLocalCalendar(h.database);
  let moved = projectCalendarEvents(local.events, local.exceptions, '2026-11-05', '2026-11-05').find(row => row.anchorDate === '2026-11-04');
  assert.equal(moved.title, title); assert.equal(moved.startDate, '2026-11-05'); assert.equal(local.events[0].title, title);
  assert.equal(h.calls.some(call => call[0] === 'patch'), false);
  h.put({ ...occurrence, summary: 'この回だけ別のランチ会' }); await h.sync.sync(); local = await readLocalCalendar(h.database);
  moved = projectCalendarEvents(local.events, local.exceptions, '2026-11-05', '2026-11-05').find(row => row.anchorDate === '2026-11-04');
  assert.equal(moved.title, 'この回だけ別のランチ会'); assert.equal(local.events[0].title, title);
});

test('Google deletion and restoration of a shortened personal event recover its retained original without an echo write', async t => {
  const h = await harness(t); await h.connect(); const title = '毎年5月22日お父さん誕生日'; await h.local({ title }); await h.sync.sync();
  const id = h.links()[0].google_id; const original = structuredClone(h.events.get(id));
  h.put({ id, status: 'cancelled' }); await h.sync.sync(); assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  h.put({ ...original, status: 'confirmed' }); h.calls.length = 0; await h.sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events[0].title, title); assert.equal(h.events.get(id).summary, 'お父さん誕生日');
  assert.equal(h.calls.some(call => call[0] === 'patch'), false); assert.equal((await h.sync.readConflicts()).length, 0);
});

test('restoring a Google occurrence under a shortened series retains its inherited raw title without changing the parent', async t => {
  const h = await harness(t); await h.connect(); const title = '毎月21日学校'; await h.local({ title, allDay: true, recurrence: 'daily' }); await h.sync.sync();
  const parent = h.links()[0].google_id; const occurrence = { id: 'restored-short-instance', summary: '学校', recurringEventId: parent,
    originalStartTime: { date: '2026-11-04' }, start: { date: '2026-11-05' }, end: { date: '2026-11-06' } };
  h.put(occurrence); await h.sync.sync(); h.put({ id: occurrence.id, status: 'cancelled', recurringEventId: parent, originalStartTime: occurrence.originalStartTime }); await h.sync.sync();
  h.put(occurrence); h.calls.length = 0; await h.sync.sync(); const local = await readLocalCalendar(h.database);
  const restored = projectCalendarEvents(local.events, local.exceptions, '2026-11-05', '2026-11-05').find(row => row.anchorDate === '2026-11-04');
  assert.equal(restored.title, title); assert.equal(local.events[0].title, title); assert.equal(h.calls.some(call => call[0] === 'patch'), false);
});

for (const source of ['google', 'local']) test(`a shortened occurrence with its own original title survives ${source} deletion and Google restoration`, async t => {
  const h = await harness(t); await h.connect(); const parentTitle = '毎月21日学校';
  const event = await h.local({ title: parentTitle, allDay: true, recurrence: 'daily' }); await h.sync.sync(); const parent = h.links()[0].google_id;
  const instance = h.put({ id: 'own-title-instance', summary: '学校', recurringEventId: parent, originalStartTime: { date: '2026-11-04' },
    start: { date: '2026-11-04' }, end: { date: '2026-11-05' } });
  h.api.instances = async () => ({ items: [clone(h.events.get(instance.id))] }); await h.sync.sync();
  const title = '毎月22日特別な学校'; const imported = (await readLocalCalendar(h.database)).exceptions[0];
  await saveCalendarEvent(h.database, { id: event.id, expectedRevision: 1, scope: 'one', anchorDate: '2026-11-04', expectedExceptionRevision: imported.revision,
    value: { ...event, title, recurrence: 'none', startDate: '2026-11-04', endDate: '2026-11-04' } }); await h.sync.sync();
  const original = clone(h.events.get(instance.id)); assert.equal(original.summary, '特別な学校');
  if (source === 'local') {
    const local = (await readLocalCalendar(h.database)).exceptions[0];
    await deleteCalendarEvent(h.database, { id: event.id, expectedRevision: 1, anchorDate: '2026-11-04', expectedExceptionRevision: local.revision });
  } else h.put({ id: instance.id, status: 'cancelled', recurringEventId: parent, originalStartTime: instance.originalStartTime });
  await h.sync.sync(); const tombstone = h.links().find(link => link.google_id === instance.id);
  assert.equal(JSON.parse(tombstone.local_base_json).deleted, true); assert.equal(JSON.parse(tombstone.local_base_json).title, title);
  h.put({ ...original, status: 'confirmed' }); h.calls.length = 0; await h.sync.sync(); const local = await readLocalCalendar(h.database);
  const restored = projectCalendarEvents(local.events, local.exceptions, '2026-11-04', '2026-11-04').find(row => row.anchorDate === '2026-11-04');
  assert.equal(restored.title, title); assert.equal(local.events[0].title, parentTitle);
  assert.equal(h.calls.some(call => call[0] === 'patch'), false); assert.equal((await h.sync.readConflicts()).length, 0);
});
