import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { createV2AuthorityIndex } from '../src/features/sharing/v2/history-view.ts';
import { authorizeSharedCalendarOperation, readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { calendarPendingCountsByDate } from '../src/domain/calendar/day-entries.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { replayAdaptiveHistory } from '../src/domain/scheduling/adaptive/history.ts';
import { GoogleCalendarHttpError } from '../src/platform/google-calendar/calendar-api.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { createPersonalGoogleCalendarSync } = await import('../src/features/calendar/personal-google-sync.ts');
const calendar = { id: 'owned', summary: 'personal', accessRole: 'owner', primary: true };

test('audit50 an expired Calendar page rejected with400 retires only its cursor and resumes a full read without deleting saved events', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database);
  const api = { calendars: async () => ({ items: [calendar] }), events: async () => ({ items: [], nextPageToken: 'expired' }), instances: async () => ({ items: [] }) };
  const sync = createPersonalGoogleCalendarSync({ database: h.database, currentSubject: async () => 'owner',
    authorize: async () => ({ subject: 'owner', label: 'QA' }), createApi: () => api, today: () => '2026-11-07', now: () => Date.parse('2026-11-07T03:00:00Z') });
  await sync.connect(await sync.prepareConnection());
  api.events = async (_id, cursor) => { if (cursor.pageToken) throw new GoogleCalendarHttpError(400); return { items: [{ id: 'saved', etag: '"one"', summary: 'saved event', start: { date: '2026-11-08' }, end: { date: '2026-11-09' } }], nextPageToken: 'expired' }; };
  await sync.sync();
  assert.equal((await readLocalCalendar(h.database)).events.length, 1);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM calendar_google_cursors').get().n, 0, 'a permanently invalid page must not remain the next retry position');
  let resumedFrom;
  api.events = async (_id, cursor) => { resumedFrom = cursor; return { items: [{ id: 'saved', etag: '"two"', summary: 'recovered event', start: { date: '2026-11-08' }, end: { date: '2026-11-09' } }], nextSyncToken: 'fresh' }; };
  assert.equal((await sync.sync({ force: true })).kind, 'success');
  assert.equal(resumedFrom.pageToken, undefined); assert.equal((await readLocalCalendar(h.database)).events[0].title, 'recovered event');
});

test('audit50 adaptive history accepts a bundled timezone even when the older native Intl database lacks it', () => {
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (...args) { if (args[1]?.timeZone === 'America/Coyhaique') throw new RangeError('old native tzdb'); return new original(...args); };
  try {
    const policy = { choreId: 'bath', kind: 'personal', mode: 'balanced', initialDays: { frequent: 7, balanced: 14, relaxed: 28 }, enabled: true, fixedDays: null, version: 'one' };
    const events = [{ operationId: 'done', sequence: 1, recordedAt: '2026-11-07T12:00:00Z', type: 'complete', completionId: 'done', roundId: 'round', localDate: '2026-11-07', timeZone: 'America/Coyhaique', origin: 'personal', mode: 'balanced', initialDays: 14, displayedWindow: null }];
    const result = replayAdaptiveHistory({ policy, events, forecasts: [], fingerprint: value => createHash('sha256').update(JSON.stringify(value)).digest('hex') });
    assert.equal(result.lastCompletedDate, '2026-11-07'); assert.equal(result.validUnitCount, 1);
    assert.throws(() => replayAdaptiveHistory({ policy, events: [{ ...events[0], timeZone: 'Invalid/Zone' }], forecasts: [], fingerprint: JSON.stringify }));
  } finally { Intl.DateTimeFormat = original; }
});

test('audit50 authorizing an edit of one shared calendar event does not causally inspect a thousand unrelated events', () => {
  const { view, accept } = createV2AuthorityIndex('group');
  const category = { id: 'personal', name: 'personal', color: '#338899' };
  const make = (n, eventId, basisOperationIds = []) => ({ schemaVersion: 2, operationId: `calendar-${n}`, groupId: 'group', entityType: 'calendarEvent', entityId: `calendar-${n}`, operationType: 'patch', authorUserId: 'owner', authorDeviceId: 'device', deviceSequence: n, logicalClock: n, context: { device: n - 1 }, payload: { eventId, scope: 'series', anchorDate: null, basisOperationIds, resetExceptionIds: [], value: { ...newEventDraft('2026-11-07', 'UTC'), title: 'event' }, category } });
  for (let n = 1; n <= 1000; n++) accept(make(n, `calendar-${n}`));
  let inspected = 0; const observed = view.observed; view.observed = (rows, at) => { inspected += rows.length; return observed(rows, at); };
  authorizeSharedCalendarOperation(view, make(1001, 'calendar-1', ['calendar-1']), false);
  assert.ok(inspected <= 2, `calendar causal candidates: ${inspected}`);
  assert.equal(readSharedCalendar(view).length, 1000);
});

test('audit50 resolving concurrent shared series edits must reset reviewed exceptions before changing recurrence', async () => {
  const f = await fixture(); const category = { id: 'personal', name: 'personal', color: '#338899' };
  const series = { ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: 'weekly', recurrence: 'weekly' };
  const payload = (eventId, extra = {}) => ({ eventId, scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value: series, category, ...extra });
  const create = f.make('calendarEvent', payload('calendar.audit50'), { operationId: 'calendar.audit50', actor: 'a' });
  const exception = f.make('calendarEvent', payload(create.operationId, { scope: 'one', anchorDate: '2026-11-03', value: { ...series, title: 'one exception' } }), { actor: 'a' });
  const observed = f.facts.map(row => row.operation);
  const left = f.make('calendarEvent', payload(create.operationId, { basisOperationIds: [create.operationId], value: { ...series, title: 'left' } }), { actor: 'a', observed });
  const right = f.make('calendarEvent', payload(create.operationId, { basisOperationIds: [create.operationId], value: { ...series, title: 'right' } }), { observed });
  const basis = [left.operationId, right.operationId];
  const missing = f.make('calendarEvent', payload(create.operationId, { basisOperationIds: basis, value: { ...series, recurrence: 'monthly' } }), { actor: 'a' });
  assert.ok(f.state().assessment.rejected.some(row => row.operationId === missing.operationId), 'a conflict resolution cannot retain hidden exceptions from the replaced recurrence');
  const resolved = f.make('calendarEvent', payload(create.operationId, { basisOperationIds: basis, value: { ...series, recurrence: 'monthly' }, resetExceptionIds: [exception.operationId] }), { actor: 'a' });
  assert.ok(!f.state().assessment.rejected.some(row => row.operationId === resolved.operationId));
  assert.deepEqual(readSharedCalendar(f.state().assessment.view)[0].exceptions, []);
});

test('audit50 pending Calendar counts index legacy completions by chore instead of inspecting unrelated history per entry', () => {
  let reads = 0;
  const completions = Array.from({ length: 1000 }, (_, i) => ({ id: `done-${i}`, get choreId() { reads++; return `chore-${i}`; }, outcome: 'completed', completedAt: '2026-10-01T00:00:00Z', completedLocalDate: '2026-10-01' }));
  const entries = Array.from({ length: 200 }, (_, i) => ({ id: `entry-${i}`, choreId: `chore-${i}`, windowStart: '2026-11-07', windowEnd: '2026-11-09', suggestedDate: '2026-11-08' }));
  assert.equal(calendarPendingCountsByDate(entries, completions).get('2026-11-08'), 200);
  assert.ok(reads <= 2000, `legacy history property reads: ${reads}`);
});

test('audit50 seasonal completion also accepts a bundled timezone missing from native Intl', async t => {
  const { createPersonalChoreDefinitions, personalChoreHistoryPolicy } = await import('../src/domain/chores/personal-catalog.ts');
  const { adaptivePersonalDigest: fingerprint } = await import('../src/features/planner/adaptive-digest.ts');
  const seasonal = await import('../src/platform/storage/personal-seasonal-chores.ts');
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const chore = createPersonalChoreDefinitions('local-household').find(chore => personalChoreHistoryPolicy(chore, 'balanced').kind === 'seasonal');
  const context = { chore: { ...chore, enabled: true }, region: 'nationalFallback', today: '2026-11-07', now: '2026-11-07T12:00:00Z', fingerprint, assertInputsCurrent() {} };
  let current; await h.database.withTransactionAsync(async () => { current = await seasonal.synchronizePersonalSeasonalInside(h.database, context); });
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (...args) { if (args[1]?.timeZone === 'America/Coyhaique') throw new RangeError('old native tzdb'); return new original(...args); };
  try {
    await h.database.withTransactionAsync(async () => { const receipt = await seasonal.applyPersonalSeasonalInside(h.database, context,
      { type: 'complete', operationId: 'seasonal-zone', recordedAt: context.now, completionId: 'seasonal-done', roundId: current.state.pending.winterStorage.id,
        date: context.today, timeZone: 'America/Coyhaique', origin: 'personal' }); assert.equal(receipt.kind, 'applied'); });
  } finally { Intl.DateTimeFormat = original; }
});
