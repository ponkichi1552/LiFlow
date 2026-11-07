import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { createV2AuthorityIndex } from '../src/features/sharing/v2/history-view.ts';
import { readV2EditableField } from '../src/features/sharing/v2/field-edit.ts';
import { createGoogleTaskCreateJournal, initializeGoogleTaskCreateIntentsInside, reserveGoogleTaskCreateInside } from '../src/platform/storage/google-task-create-intents.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarDraft } = await import('../src/platform/storage/calendar-events.ts');
const { connectPersonalGoogleCalendar, readPersonalGoogleCalendarControl, refreshPersonalGoogleCalendars } = await import('../src/platform/storage/personal-google-calendar.ts');
const { newEventDraft } = await import('../src/domain/calendar/events.ts');

test('audit50 shared field reads inspect only writes to that field while later accepted edits and causal cuts remain visible', () => {
  const { view, accept } = createV2AuthorityIndex('audit50-group');
  const make = (n, payload) => ({ operationId: `op-${n}`, groupId: 'audit50-group', entityType: 'chore', entityId: 'bath',
    operationType: 'patch', authorUserId: 'owner', authorDeviceId: 'phone', deviceSequence: n, logicalClock: n,
    context: { phone: n - 1 }, payload });
  accept(make(1, { description: 'original' }));
  for (let n = 2; n <= 1000; n++) accept(make(n, { name: `name-${n}` }));
  const at = make(1001, {}); let inspected = 0; const observed = view.observed;
  view.observed = (rows, cut) => { inspected += rows.length; return observed(rows, cut); };
  assert.equal(readV2EditableField(view, at, 'chore', 'bath', 'description').value, 'original');
  assert.ok(inspected <= 2, `causal candidates inspected: ${inspected}`);
  accept(make(1001, { description: 'updated' }));
  assert.equal(readV2EditableField(view, make(1002, {}), 'chore', 'bath', 'description').value, 'updated');
  assert.equal(readV2EditableField(view, at, 'chore', 'bath', 'description').value, 'original');
  assert.equal(readV2EditableField(view, at, 'chore', 'bath', 'missing').kind, 'missing');
});

test('audit50 rejecting a Tasks creation batch uses bounded exact-attempt SQL and preserves linked or replaced reservations', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeGoogleTaskCreateIntentsInside(h.database);
  const intents = Array.from({ length: 205 }, (_, n) => ({ accountSubject: 'account', taskListId: 'list', occurrenceMarker: `round-${n}`,
    attemptId: `try-${n}`, startedAt: '2026-11-07T01:00:00Z' }));
  for (const intent of intents) await reserveGoogleTaskCreateInside(h.database, intent);
  h.connection.prepare('UPDATE private_google_task_create_intents SET remote_task_id=? WHERE occurrence_marker=?').run('saved-google-task', 'round-0');
  h.connection.prepare('UPDATE private_google_task_create_intents SET attempt_id=? WHERE occurrence_marker=?').run('newer-attempt', 'round-1');
  const journal = createGoogleTaskCreateJournal(work => h.database.withTransactionAsync(() => work(h.database)), () => 'unused', () => new Date());
  h.writes.length = 0; await journal.rejectBatch(intents);
  const remaining = h.connection.prepare('SELECT occurrence_marker FROM private_google_task_create_intents ORDER BY occurrence_marker').all();
  assert.deepEqual(remaining.map(row => row.occurrence_marker), ['round-0', 'round-1']);
  const deletes = h.writes.filter(row => row.sql.startsWith('DELETE FROM private_google_task_create_intents'));
  assert.ok(deletes.length <= 3, `reservation deletion bridge writes: ${deletes.length}`);
  assert.ok(deletes.every(row => row.params.length <= 999));
});

test('audit50 saving one existing calendar draft does not load and validate the other forty nine drafts', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  const drafts = Array.from({ length: 50 }, (_, n) => ({ eventId: `event-${n}`, revision: 1, exceptionRevision: 0,
    scope: 'series', anchorDate: null, value: { ...newEventDraft('2026-11-07', 'Asia/Tokyo'), title: `draft-${n}` } }));
  const insert = h.connection.prepare('INSERT INTO calendar_drafts(slot,draft_json) VALUES(?,?)');
  for (const row of drafts) insert.run(`event:${row.eventId}:series:`, JSON.stringify(row));
  let loaded = 0; const read = h.database.getAllAsync;
  h.database.getAllAsync = async (sql, ...args) => { const rows = await read(sql, ...args); if (sql.includes('FROM calendar_drafts')) loaded += rows.length; return rows; };
  await saveCalendarDraft(h.database, { ...drafts[20], value: { ...drafts[20].value, title: 'new text' } });
  assert.ok(loaded <= 1, `full draft bodies loaded while saving one: ${loaded}`);
  assert.equal(h.connection.prepare('SELECT count(*) AS n FROM calendar_drafts').get().n, 50);
  assert.equal(JSON.parse(h.connection.prepare('SELECT draft_json FROM calendar_drafts WHERE slot=?').get('event:event-20:series:').draft_json).value.title, 'new text');
});

test('audit50 Calendar permission reconciliation indexes prior identities and batches reimports for one thousand changed roles', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  const owned = { id: 'main', summary: 'main', primary: true, accessRole: 'owner' };
  const calendars = [owned, ...Array.from({ length: 999 }, (_, n) => ({ id: `calendar-${n}`, summary: 'shared', accessRole: 'writer' }))];
  const initial = await readPersonalGoogleCalendarControl(h.database);
  const control = await connectPersonalGoogleCalendar(h.database, initial.generation, 'account', calendars, 'main');
  const insert = h.connection.prepare('INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty,attempt_order) VALUES(?,?,?,?,0,0)');
  for (const row of calendars) insert.run('account', row.id, `remote-${row.id}`, JSON.stringify({ id: `remote-${row.id}` }));
  let identityReads = 0;
  const changed = calendars.map(row => ({ ...row, get id() { identityReads++; return row.id; }, accessRole: row.id === 'main' ? 'owner' : 'reader' }));
  h.writes.length = 0;
  const result = await refreshPersonalGoogleCalendars(h.database, control, changed);
  assert.equal(result.control.calendars.length, 1000);
  assert.ok(identityReads < 20000, `Calendar identity accesses: ${identityReads}`);
  const reimports = h.writes.filter(row => row.sql.startsWith('UPDATE calendar_google_inbox SET dirty=1'));
  assert.ok(reimports.length <= 2, `permission reimport bridge writes: ${reimports.length}`);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_inbox WHERE dirty=1').get().n, 999);
});
