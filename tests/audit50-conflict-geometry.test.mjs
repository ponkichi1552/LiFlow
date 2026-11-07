import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { bindAdaptiveOwnerReader } = await import('../src/platform/storage/adaptive-owner-inputs.ts');
const { readPersonalAdaptiveContextInside } = await import('../src/platform/storage/repository-adaptive.ts');

test('audit50 a shared event conflict reserves every candidate time without blocking unrelated days for six months', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T00:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  h.connection.exec('UPDATE household_settings SET setup_completed=1');
  const value = { ...newEventDraft('2026-11-07', 'UTC'), title: 'conflicted' };
  const head = (id, startMinute) => ({ operationId: id, logicalClock: 1, payload: { eventId: 'event', scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value: { ...value, startMinute, endMinute: startMinute + 60 }, category: { id: 'personal', name: '私用', color: '#338899' } } });
  const common = { initialized: true, groupId: 'group', members: [{ userId: 'owner', active: true }], chores: [], occurrences: [], history: [] };
  const stop = bindAdaptiveOwnerReader(h.database, async () => ({ ownerUserId: 'owner', common, sharedCalendar: [{ id: 'event', heads: [head('one', 540), head('two', 780)], exceptions: [] }], assertCurrent() {} })); t.after(stop);
  const context = await readPersonalAdaptiveContextInside(h.database, { householdId: 'local-household', memberId: 'member', now: new Date(), timeZone: 'UTC', today: '2026-11-07' });
  const geometry = context.prepareGeometry();
  assert.deepEqual(geometry.busy, [{ start: Date.parse('2026-11-07T09:00:00Z'), end: Date.parse('2026-11-07T10:00:00Z') }, { start: Date.parse('2026-11-07T13:00:00Z'), end: Date.parse('2026-11-07T14:00:00Z') }]);
});

test('audit50 conflicting shared occurrence edits reserve their possible times while preserving other recurrence days and deletion candidates', async () => {
  const { projectSharedCalendarPlanningRecords, projectSharedCalendarRecords } = await import('../src/features/calendar/shared-events.ts');
  const { localCalendarIntervals } = await import('../src/features/calendar/local-availability.ts');
  const value = { ...newEventDraft('2026-11-07', 'UTC'), title: 'weekly', recurrence: 'weekly' };
  const head = (operationId, value, scope = 'series') => ({ operationId, logicalClock: 1, payload: { value, category: value ? { id: 'personal', name: '私用', color: '#338899' } : null, scope } });
  const changed = hour => ({ ...value, startDate: '2026-11-14', endDate: '2026-11-14', recurrence: 'none', startMinute: hour * 60, endMinute: (hour + 1) * 60 });
  const records = [{ id: 'event', heads: [head('series', value)], exceptions: [{ anchorDate: '2026-11-14', heads: [head('at13', changed(13), 'one'), head('at16', changed(16), 'one'), head('delete', null, 'one')] }] }];
  const before = structuredClone(records); const projected = projectSharedCalendarPlanningRecords(records, 'group');
  assert.equal(projectSharedCalendarRecords(records, 'group').conflicted, true); assert.equal(projected.unbounded, false);
  const busy = localCalendarIntervals(projected.events, projected.exceptions, '2026-11-07', '2026-11-14', 'UTC');
  assert.deepEqual(busy.map(row => [new Date(row.start).toISOString(), new Date(row.end).toISOString()]), [
    ['2026-11-07T09:00:00.000Z', '2026-11-07T10:00:00.000Z'],
    ['2026-11-14T13:00:00.000Z', '2026-11-14T14:00:00.000Z'], ['2026-11-14T16:00:00.000Z', '2026-11-14T17:00:00.000Z']]);
  assert.deepEqual(records, before);
  assert.equal(projectSharedCalendarPlanningRecords([{ id: 'missing', heads: [], exceptions: [] }], 'group').unbounded, true);
});
