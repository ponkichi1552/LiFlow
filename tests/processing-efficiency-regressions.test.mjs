import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { generateWasteCollectionDates } from '../src/features/waste/weekly-scheduler.ts';
import { addDays, weekdayOf, daysBetween } from '../src/domain/scheduling/local-date.ts';
import { LaundryWeatherAdjustmentPolicy } from '../src/features/weather/laundry-policy.ts';
const calendar = await import('../src/platform/storage/calendar-events.ts');
const repository = await import('../src/platform/storage/repository.ts');

test('waste recurrence jumps preserve a daily reference across monthly clamps anchors leap years duplicate weekdays and empty ranges', () => {
  const seed = { id: 'rule', householdId: 'home', label: 'びん', collectionWeekdays: [1, 1, 3, 7] };
  for (const start of ['2023-12-20', '2024-02-26', '2024-12-31', '2025-02-01']) for (const length of [0, 1, 14, 180, 400]) {
    const through = addDays(start, length);
    for (const recurrence of ['weekly', 'biweekly', 'monthly']) for (const anchorDate of [undefined, addDays(start, -30), addDays(start, 31)]) {
      const rule = { ...seed, recurrence, anchorDate, monthlyDay: 31 }; const expected = [];
      for (let day = start; day <= through; day = addDays(day, 1)) {
        const date = new Date(`${day}T00:00:00Z`); const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        if (recurrence === 'weekly' ? seed.collectionWeekdays.includes(weekdayOf(day))
          : recurrence === 'biweekly' ? anchorDate && day >= anchorDate && daysBetween(anchorDate, day) % 14 === 0
          : (!anchorDate || day >= anchorDate) && date.getUTCDate() === Math.min(31, last)) expected.push(day);
      }
      assert.deepEqual(generateWasteCollectionDates(rule, start, through).map(row => row.date), expected);
    }
  }
  const Original = globalThis.Date; let constructions = 0;
  globalThis.Date = class extends Original { constructor(...args) { super(...args); constructions++; } };
  try {
    const values = generateWasteCollectionDates({ ...seed, recurrence: 'monthly', monthlyDay: 31 }, '2000-01-01', '2030-12-31');
    assert.equal(values.length, 372); assert.ok(constructions < 2000, 'monthly rules must not construct a date for every non-collection day');
  } finally { globalThis.Date = Original; }
});

test('overlapping laundry windows evaluate each forecast day once and retain the least shifted matching window', () => {
  const today = '2026-11-05'; let weatherReads = 0;
  const chore = { id: 'laundry', householdId: 'home', enabled: true, name: '洗濯', category: '洗濯', laundryDryingPreference: 'outdoors',
    load: 'normal', windowRadiusDays: 14, maxShiftDays: 14, everyday: false, holidayPriority: false };
  const current = { id: 'round', householdId: 'home', choreId: chore.id, cycleBaseDate: today, suggestedDate: today,
    windowStart: addDays(today, -14), windowEnd: addDays(today, 14), status: 'inWindow', assignedMemberIds: [] };
  const forecast = Array.from({ length: 7 }, (_, offset) => ({ date: addDays(today, offset), precipitationProbability: offset ? 0 : 100,
    precipitationMm: offset ? 0 : 10, get weatherCode() { weatherReads++; return offset ? 0 : 61; } }));
  const policy = new LaundryWeatherAdjustmentPolicy({ today, chores: [chore], completions: [], dependencies: [],
    settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 2 } } });
  const [adjustment] = policy.proposeAdjustments({ schedule: [current], forecast });
  assert.ok(adjustment); assert.equal(adjustment.data.suggestedDate, addDays(today, 1));
  assert.equal(adjustment.data.windowStart, current.windowStart); assert.equal(adjustment.data.windowEnd, current.windowEnd);
  assert.ok(weatherReads <= 30, 'one date must not be rechecked for all overlapping shifted windows');
});

test('resetting already-default personal schedules preserves the reusable snapshot and writes no definition or schedule rows', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const before = await repository.loadPlannerSnapshot(h.database); assert.equal(repository.readCachedPlannerSnapshot(h.database), before);
  const changes = h.connection.prepare('SELECT total_changes() AS count').get().count;
  await repository.resetAllChoreSchedules(h.database); await repository.resetAllChoreSchedules(h.database);
  assert.equal(repository.readCachedPlannerSnapshot(h.database), before);
  assert.equal(h.connection.prepare('SELECT total_changes() AS count').get().count, changes);
});

for (const platform of ['ios', 'android']) test(`${platform} draft keystrokes read only drafts and a saved event arriving during a draft read still refreshes real availability`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  let binding; let full = 0; let partial = 0; let hold;
  const native = { ...calendar, async readLocalCalendar(...args) { full++; return calendar.readLocalCalendar(...args); },
    async readLocalCalendarDrafts(...args) { partial++; const value = await calendar.readLocalCalendarDrafts(...args); await hold; return value; } };
  const screen = screenHarness('tests/helpers/local-calendar-observer-host.tsx', { platform, exportName: 'LocalCalendarObserverHost',
    effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(),
    props: { database: h.database, capture: value => { binding = value; } },
    mocks: { '../../platform/storage/calendar-events': native, './use-personal-google-sync': { usePersonalGoogleSync: () => () => {} } } });
  await screen.flush(); const events = binding.snapshot.events; const exceptions = binding.snapshot.exceptions; const categories = binding.snapshot.categories;
  const input = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: { ...newEventDraft('2026-11-05', 'Asia/Tokyo'), title: 'input' } };
  for (let i = 0; i < 10; i++) { await calendar.saveCalendarDraft(h.database, { ...input, value: { ...input.value, title: `input${i}` } }); await screen.flush(); }
  assert.equal(full, 1); assert.equal(partial, 10); assert.equal(binding.snapshot.events, events);
  assert.equal(binding.snapshot.exceptions, exceptions); assert.equal(binding.snapshot.categories, categories);
  let release; hold = new Promise(resolve => { release = resolve; });
  await calendar.saveCalendarDraft(h.database, input); await new Promise(setImmediate);
  await calendar.saveCalendarEvent(h.database, { value: { ...input.value, title: 'saved while typing' }, expectedRevision: 0 });
  release(); await screen.flush(); await screen.flush();
  assert.equal(binding.snapshot.events.some(event => event.title === 'saved while typing'), true);
  assert.equal(full, 2); assert.equal(binding.error, null);
});
