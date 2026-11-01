import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
const { initializeLocalDatabase, loadPlannerSnapshot, completeFirstSetup, readCalendarPlanningSignatures } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar, saveCalendarEvent } = await import('../src/platform/storage/calendar-events.ts');
const { refreshCalendarWithDependencies } = await import('../src/features/google-sync/calendar-coordinator.ts');

test('unchanged local busy events and Google availability use the same signature as the applied planner', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); const now = new Date('2026-11-01T01:00:00Z'); const today = '2026-11-01';
  await initializeLocalDatabase(h.database); const initial = await loadPlannerSnapshot(h.database, today, now, 'Asia/Tokyo');
  await completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [initial.chores[0].id], previousDates: {}, weatherLocation: null });
  await readLocalCalendar(h.database);
  const value = { ...newEventDraft(today, 'Asia/Tokyo'), title: '検査用の予定' };
  const id = await saveCalendarEvent(h.database, { expectedRevision: 0, value });
  await loadPlannerSnapshot(h.database, today, now, 'Asia/Tokyo');
  let regenerations = 0;
  const port = { loadState: async () => ({ enabled: true, status: 'idle', lastSuccessfulSyncAt: now.toISOString() }),
    hasFreshCoverage: async () => true, saveState: async () => assert.fail('fresh cache'), getAccessToken: async () => assert.fail('fresh cache'),
    client: {}, commitSuccess: async () => assert.fail('fresh cache'),
    readPlanningSignatures: () => readCalendarPlanningSignatures(h.database, now, 'Asia/Tokyo'),
    regeneratePlanner: async () => { regenerations++; await loadPlannerSnapshot(h.database, today, now, 'Asia/Tokyo'); return true; } };
  const options = { now, range: { from: today, through: today, timeZone: 'Asia/Tokyo' } };
  for (let n = 0; n < 3; n++) assert.equal((await refreshCalendarWithDependencies(port, options)).plannerChanged, false);
  assert.equal(regenerations, 0);
  await saveCalendarEvent(h.database, { id, expectedRevision: 1, value: { ...value, startMinute: 660, endMinute: 810 } });
  assert.equal((await refreshCalendarWithDependencies(port, options)).plannerChanged, true);
  assert.equal(regenerations, 1); assert.equal((await refreshCalendarWithDependencies(port, options)).plannerChanged, false);
});
