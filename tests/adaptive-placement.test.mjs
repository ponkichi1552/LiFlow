import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { unionInstantSpans, subtractInstantSpans, adaptiveWindowRadius, adaptivePlacementWindows, initialAdaptiveBaseDate, placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const instant = text => Date.parse(text.endsWith('Z') ? text : `${text}:00.000Z`);
const span = (start, end) => ({ start: instant(start), end: instant(end) });
function day(date, change = {}) {
  return { date, bounds: span(`${date}T00:00`, `${addDays(date, 1)}T00:00`), allowed: [span(`${date}T09:00`, `${date}T19:00`)],
    holiday: false, heavyLimit: 1, normalLimit: 2, ...change };
}
const task = (id, change = {}) => ({ id, choreId: `chore-${id}`, baseDate: '2026-11-10', periodDays: 8, minutes: 30,
  load: 'normal', purpose: 'nextRound', fixedDaily: false, ...change });
function place(tasks, change = {}) {
  return placeAdaptiveRounds({ tasks, days: Array.from({ length: 25 }, (_, i) => day(addDays('2026-11-01', i))), busy: [], fixedLoads: [],
    today: '2026-11-01', now: instant('2026-11-01T00:00'), holidaysConfigured: false, ...change });
}

test('unknown appliance working time keeps a date-only fallback and consumes conservative capacity without inventing a duration or free slot', () => {
  const unknown = task('unknown', { minutes: null }); const known = task('known');
  const result = place([unknown, known], { days: Array.from({ length: 25 }, (_, i) => day(addDays('2026-11-01', i), { maximumMinutes: 60 })) });
  const a = result.find(row => row.id === unknown.id); const b = result.find(row => row.id === known.id);
  assert.equal(a.recommendedDate, unknown.baseDate); assert.equal(a.slot, null); assert.equal(a.fallback, true);
  assert.notEqual(b.recommendedDate, a.recommendedDate); assert.ok(b.slot);
  assert.equal(unknown.minutes, null);
  assert.throws(() => place([task('invalid', { minutes: 0 })]), /作業時間/u);
});

test('a one-day alternating phase uses ordinary next-round placement instead of accidentally becoming an immovable daily task', async () => {
  const { planPersonalAdaptiveRounds } = await import('../src/features/planner/adaptive-rounds.ts');
  const roundId = 'alternating-next';
  const chore = { id: 'alternating-chore', estimatedMinutes: 30, load: 'light', holidayPriority: false };
  const state = { policy: { choreId: chore.id, enabled: true, kind: 'personal', version: 'test' },
    model: { method: 'alternating', even: 1, odd: 10, nextOrdinal: 0 }, lastPlanCompletion: { date: '2026-11-01' } };
  const geometry = { days: ['2026-11-01', '2026-11-02', '2026-11-03'].map(date => day(date)),
    busy: [span('2026-11-02T00:00', '2026-11-03T00:00')], holidaysConfigured: false };
  const result = planPersonalAdaptiveRounds({ requests: [{ chore, roundId, state, previous: null, trigger: 'complete' }], geometry,
    ownerId: 'owner', today: '2026-11-01', now: instant('2026-11-01T10:00'), fixedLoads: [], fingerprint: () => '00'.repeat(32) });
  assert.equal(result.get(roundId).recommendedDate, '2026-11-03'); assert.ok(result.get(roundId).slot);
  const daily = planPersonalAdaptiveRounds({ requests: [{ chore, roundId, state: { ...state, model: { method: 'median', days: 1 } }, previous: null, trigger: 'complete' }], geometry,
    ownerId: 'owner', today: '2026-11-01', now: instant('2026-11-01T10:00'), fixedLoads: [], fingerprint: () => '00'.repeat(32) });
  assert.equal(daily.get(roundId).recommendedDate, '2026-11-02'); assert.equal(daily.get(roundId).slot, null);
});

test('adaptive period boundaries use rounded days and symmetric initial windows without changing their finite expansion limits', () => {
  assert.deepEqual([7, 7.99, 8, 13, 14, 29, 30, 59, 60, 89, 90, 179, 180, 10000].map(adaptiveWindowRadius), [0, 0, 1, 1, 2, 2, 3, 3, 5, 5, 7, 7, 14, 14]);
  for (const radius of [0, 1, 2, 3, 5, 7, 14]) {
    const windows = adaptivePlacementWindows('2026-11-10', radius); const width = radius * 2 + 1;
    assert.equal(new Set(windows.map(window => `${window.from}/${window.through}`)).size, windows.length);
    assert.ok(windows.every(window => (Date.parse(window.through) - Date.parse(window.from)) / 86400000 + 1 <= (radius ? Math.floor(width * 1.5) : 1)));
    assert.equal(windows[0].base, '2026-11-10'); assert.equal(windows[0].from, addDays('2026-11-10', -radius));
  }
  const candidates = adaptivePlacementWindows('2026-11-10', 1);
  assert.deepEqual(candidates.slice(0, 3), [{ base: '2026-11-10', from: '2026-11-09', through: '2026-11-11' },
    { base: '2026-11-10', from: '2026-11-08', through: '2026-11-11' }, { base: '2026-11-10', from: '2026-11-09', through: '2026-11-12' }]);
  assert.deepEqual(candidates.find(window => window.base === '2026-11-09'), { base: '2026-11-09', from: '2026-11-08', through: '2026-11-10' });
});

test('adaptive placement tries both one-day expansions and never invents a reservation for an unavailable fallback', () => {
  const days = Array.from({ length: 9 }, (_, i) => day(addDays('2026-11-06', i), { maximumMinutes: i === 6 ? 60 : 0 }));
  const selected = place([task('one')], { days })[0];
  assert.equal(selected.recommendedDate, '2026-11-12'); assert.equal(selected.placedBaseDate, '2026-11-10');
  assert.deepEqual(selected.displayedWindow, { from: '2026-11-09', through: '2026-11-12' }); assert.equal(selected.fallback, false);
  const unavailable = place([task('one')], { days: days.map(day => ({ ...day, maximumMinutes: 0 })) })[0];
  assert.equal(unavailable.recommendedDate, '2026-11-10'); assert.equal(unavailable.slot, null); assert.equal(unavailable.fallback, true);
  assert.deepEqual(unavailable.displayedWindow, { from: '2026-11-09', through: '2026-11-11' });
});

test('adaptive heavy windows contain a registered holiday without requiring its recommendation to be on that holiday', () => {
  const days = [day('2026-11-09'), day('2026-11-10'), day('2026-11-11', { holiday: true, maximumMinutes: 0 })];
  const result = place([task('heavy', { load: 'heavy' })], { days, holidaysConfigured: true })[0];
  assert.equal(result.recommendedDate, '2026-11-10'); assert.equal(result.fallback, false);
  assert.ok(result.displayedWindow.from <= '2026-11-11' && result.displayedWindow.through >= '2026-11-11');
  assert.equal(place([task('normal', { load: 'heavy' })], { days: [day('2026-11-10')], holidaysConfigured: false })[0].fallback, false);
});

test('three separate ten-minute gaps cannot reserve a continuous thirty-minute chore', () => {
  const days = [day('2026-11-10', { allowed: [span('2026-11-10T09:00', '2026-11-10T09:50')] })];
  const busy = [span('2026-11-10T09:10', '2026-11-10T09:20'), span('2026-11-10T09:30', '2026-11-10T09:40')];
  assert.equal(place([task('split')], { days, busy })[0].slot, null);
  const contiguous = place([task('continuous')], { days, busy: [span('2026-11-10T09:00', '2026-11-10T09:20')] })[0];
  assert.deepEqual(contiguous.slot, span('2026-11-10T09:20', '2026-11-10T09:50'));
});

test('an explicit disabled holiday preference is preserved rather than overwritten by heavy-chore defaults', () => {
  const days = [day('2026-11-10')];
  assert.equal(place([task('heavy', { load: 'heavy' })], { days, holidaysConfigured: true })[0].fallback, true);
  const result = place([task('heavy', { load: 'heavy', holidayPriority: false })], { days, holidaysConfigured: true })[0];
  assert.equal(result.fallback, false); assert.equal(result.recommendedDate, '2026-11-10');
});

test('calendar copies and intersecting busy intervals remove their real union only once', () => {
  const busy = [span('2026-11-10T09:00', '2026-11-10T09:20'), span('2026-11-10T09:00', '2026-11-10T09:20'), span('2026-11-10T09:10', '2026-11-10T09:30')];
  const combined = unionInstantSpans(busy); assert.deepEqual(combined, [span('2026-11-10T09:00', '2026-11-10T09:30')]);
  assert.deepEqual(subtractInstantSpans([span('2026-11-10T09:00', '2026-11-10T10:00')], combined), [span('2026-11-10T09:30', '2026-11-10T10:00')]);
  const result = place([task('union')], { days: [day('2026-11-10', { allowed: [span('2026-11-10T09:00', '2026-11-10T10:00')] })], busy })[0];
  assert.deepEqual(result.slot, span('2026-11-10T09:30', '2026-11-10T10:00'));
});

test('automatic replacement protects today tomorrow overdue and fixed-daily rounds and cannot refill their dates', () => {
  for (const date of ['2026-10-31', '2026-11-01', '2026-11-02']) {
    const previous = { id: 'kept', originalBaseDate: date, placedBaseDate: date, recommendedDate: date,
      basicWindow: null, displayedWindow: null, slot: null, fallback: true };
    assert.deepEqual(place([task('kept', { baseDate: date, purpose: 'automatic', previous })])[0], previous);
  }
  const prior = { id: 'future', originalBaseDate: '2026-11-03', placedBaseDate: '2026-11-03', recommendedDate: '2026-11-03',
    basicWindow: null, displayedWindow: null, slot: null, fallback: true };
  const moved = place([task('future', { baseDate: '2026-11-03', periodDays: 14, purpose: 'automatic', previous: prior })],
    { days: [day('2026-11-01'), day('2026-11-02')] })[0];
  assert.equal(moved.recommendedDate, '2026-11-03'); assert.equal(moved.slot, null);
  const daily = place([task('daily', { periodDays: 1, fixedDaily: true })], { days: [day('2026-11-09'), day('2026-11-11')] })[0];
  assert.equal(daily.recommendedDate, '2026-11-10'); assert.equal(daily.slot, null);
});

test('global placement uses constrained candidates before flexible tasks and keeps completed load counted exactly once', () => {
  const days = [day('2026-11-09', { maximumMinutes: 30 }), day('2026-11-10', { maximumMinutes: 30 }), day('2026-11-11', { maximumMinutes: 30 })];
  const results = place([task('flexible', { minutes: 30, load: 'heavy' }), task('constrained', { minutes: 30, purpose: 'direct', load: 'light' })], { days });
  assert.equal(results.find(row => row.id === 'constrained').recommendedDate, '2026-11-10');
  assert.notEqual(results.find(row => row.id === 'flexible').recommendedDate, '2026-11-10');
  const done = { roundId: 'done', date: '2026-11-10', minutes: 30, load: 'normal', slot: null };
  const next = place([task('next')], { days: [day('2026-11-10', { maximumMinutes: 60 })], fixedLoads: [done, { ...done }] })[0];
  assert.notEqual(next.slot, null);
  assert.throws(() => place([task('next')], { fixedLoads: [{ ...done, roundId: 'next' }] }), /古い負荷/);
  assert.throws(() => place([task('a'), task('b', { choreId: 'chore-a' })]), /未完了回/);
});

test('midnight work remains one continuous slot and its minutes respect each actual civil-day capacity', () => {
  const a = day('2026-11-10', { allowed: [span('2026-11-10T23:00', '2026-11-11T00:30')], maximumMinutes: 5 });
  const b = day('2026-11-11', { allowed: [], maximumMinutes: 25 });
  const result = place([task('midnight', { periodDays: 7 })], { days: [a, b] })[0];
  assert.deepEqual(result.slot, span('2026-11-10T23:55', '2026-11-11T00:25')); assert.equal(result.recommendedDate, a.date);
  const blocked = place([task('midnight', { periodDays: 7 })], { days: [a, { ...b, maximumMinutes: 20 }] })[0];
  assert.equal(blocked.slot, null);
});

test('today cannot reserve time already elapsed while direct edits keep their exact requested date', () => {
  const result = place([task('today', { baseDate: '2026-11-01', purpose: 'direct' })], { now: instant('2026-11-01T18:30') })[0];
  assert.deepEqual(result.slot, span('2026-11-01T18:30', '2026-11-01T19:00'));
  const explicit = place([task('exact', { purpose: 'direct' })], { days: [day('2026-11-09'), day('2026-11-10', { maximumMinutes: 0 })] })[0];
  assert.equal(explicit.recommendedDate, '2026-11-10'); assert.equal(explicit.slot, null);
});

test('a ten-thousand-interval calendar is normalized once and placement remains deterministic without mutating source input', () => {
  let reads = 0;
  const busy = Array.from({ length: 10_000 }, (_, i) => ({ get start() { reads++; return instant('2026-11-01T00:00') + i * 120_000; },
    get end() { reads++; return instant('2026-11-01T00:00') + i * 120_000 + 60_000; } }));
  const tasks = [task('a', { minutes: 10 }), task('b', { minutes: 10 })];
  const result = place(tasks, { busy }); assert.ok(reads <= busy.length * 4, 'raw Calendar input must not be rescanned for every candidate day');
  assert.deepEqual(result, place(tasks, { busy }));
  assert.equal(tasks[0].previous, undefined); assert.equal(busy.length, 10_000);
});

test('initial placement searches the first thirty days before one full long cycle and retains its saved seed only for a true fallback', () => {
  const days = Array.from({ length: 100 }, (_, i) => day(addDays('2026-11-01', i), { maximumMinutes: i === 28 || i === 40 ? 30 : 0 }));
  const first = task('initial', { purpose: 'initial', periodDays: 90 });
  const result = place([first], { days })[0];
  assert.equal(result.recommendedDate, '2026-11-29'); assert.equal(result.originalBaseDate, first.baseDate);
  assert.equal(result.displayedWindow.through >= result.recommendedDate, true);
  const extended = place([first], { days: days.map(day => ({ ...day, maximumMinutes: day.date === '2026-12-11' ? 30 : 0 })) })[0];
  assert.equal(extended.recommendedDate, '2026-12-11'); assert.equal(extended.fallback, false);
  const unavailable = place([first], { days: days.map(day => ({ ...day, maximumMinutes: day.date === '2027-02-01' ? 30 : 0 })) })[0];
  assert.equal(unavailable.recommendedDate, first.baseDate); assert.equal(unavailable.fallback, true); assert.equal(unavailable.slot, null);
});

test('initial light chores share daily time and count load rather than all appearing today and seed identity is stable', () => {
  const days = Array.from({ length: 7 }, (_, i) => day(addDays('2026-11-01', i)));
  const tasks = Array.from({ length: 7 }, (_, i) => task(`light-${i}`, { baseDate: '2026-11-01', purpose: 'initial', periodDays: 7, load: 'light' }));
  const results = place(tasks, { days }); assert.equal(new Set(results.map(row => row.recommendedDate)).size, 7);
  assert.deepEqual(results, place(tasks, { days }));
  const input = { today: '2026-11-01', periodDays: 365, ownerId: 'owner-a', choreId: 'recipe-a', version: 'catalog-6', fingerprint: () => 'abcdef0012345678' };
  const seed = initialAdaptiveBaseDate(input); assert.equal(seed, initialAdaptiveBaseDate(input));
  assert.ok(seed >= input.today && seed <= '2026-11-30');
  assert.equal(initialAdaptiveBaseDate({ ...input, periodDays: 1 }), input.today);
  assert.throws(() => place([task('invalid', { baseDate: '2026-12-01', purpose: 'initial', periodDays: 365 })], { days }), /最初の探索範囲/);
});
