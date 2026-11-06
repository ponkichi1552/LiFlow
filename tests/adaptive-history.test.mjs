import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
const { replayAdaptiveHistory, adaptiveModeConversionDays } = await import('../src/domain/scheduling/adaptive/history.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseline = { choreId: 'personal-bathroom', kind: 'personal', mode: 'balanced',
  initialDays: { frequent: 7, balanced: 14, relaxed: 28 }, enabled: true, fixedDays: null, version: 'recipe-v1' };
function complete(sequence, day, change = {}) {
  return { operationId: `op-${sequence}`, sequence, recordedAt: `${day}T12:00:00.000Z`, type: 'complete',
    completionId: `completion-${sequence}`, roundId: `round-${sequence}`, localDate: day, timeZone: 'Asia/Tokyo', origin: 'personal',
    mode: 'balanced', initialDays: 14, displayedWindow: null, ...change };
}
const settings = (sequence, patch) => ({ operationId: `op-${sequence}`, sequence, type: 'settings', recordedAt: '2028-01-01T00:00:00.000Z', ...patch });
const undo = (sequence, target) => ({ operationId: `op-${sequence}`, sequence, type: 'undo', recordedAt: '2029-01-01T00:00:00.000Z',
  completionId: target.completionId, targetOperationId: target.operationId });
const replay = (events, change = {}) => replayAdaptiveHistory({ policy: baseline, events, forecasts: [], fingerprint, ...change });
const every = (gaps, change = {}) => { let day = '2026-01-01'; return [complete(1, day, change), ...gaps.map((gap, i) => complete(i + 2, day = addDays(day, gap), change))]; };

test('adaptive ordered history learns after three actual intervals without manufacturing elapsed-time observations', () => {
  const events = every([60, 60, 60]);
  assert.equal(replay(events.slice(0, 3)).model.days, 14);
  const learned = replay(events); assert.equal(learned.model.days, 60); assert.equal(learned.validIntervalCount, 3);
  assert.equal(learned.lastCompletedDate, '2026-06-30');
  assert.equal(replay(every([14, 14, 180])).model.days, 14);
  assert.deepEqual(replay(events), replay(events), 'rendering or elapsed time is not an input event');
});

test('adaptive frozen displayed windows retain current parameters while inside-window observations still inform later learning', () => {
  const events = every([16, 16, 16]).map(event => ({ ...event,
    displayedWindow: { revision: `published-${event.sequence}`, from: addDays(event.localDate, -2), through: event.localDate } }));
  assert.equal(replay(events).model.days, 14);
  events.push(complete(5, addDays(events.at(-1).localDate, 60)));
  const result = replay(events); assert.equal(result.model.days, 16); assert.equal(result.validIntervalCount, 4);
  const missing = every([60, 60, 60]); missing.at(-1).displayedWindow = 'missing';
  const held = replay(missing); assert.equal(held.model.days, 14); assert.equal(held.validIntervalCount, 3);
  assert.deepEqual(held.issues, [{ operationId: 'op-4', kind: 'missingWindow' }]);
});

test('adaptive Undo removes its learning and preserves later explicit settings and independent completions', () => {
  const events = every([60, 60, 60]);
  const cancelled = replay([...events, undo(5, events[3])]);
  assert.equal(cancelled.model.days, 14); assert.equal(cancelled.validIntervalCount, 2);
  const later = complete(6, '2028-02-01');
  const result = replay([...events, settings(5, { fixedDays: 20 }), later, undo(7, events[1])]);
  assert.equal(result.model.days, 20); assert.equal(result.policy.fixedDays, 20); assert.equal(result.lastCompletedDate, later.localDate);
  assert.equal(result.validIntervalCount, 0);
  assert.equal(events.length, 4, 'raw input is immutable');
});

test('adaptive mode changes normalize each recipe basis, exclude crossing intervals and preserve exact round trips', () => {
  const policy = { ...baseline, initialDays: { frequent: 3, balanced: 7, relaxed: 14 } };
  const events = every([10, 10, 10], { initialDays: 7 });
  assert.equal(replay(events, { policy }).model.days, 10);
  assert.equal(replay([...events, settings(5, { mode: 'frequent' })], { policy }).model.days, 30 / 7);
  const trip = [...events, settings(5, { mode: 'frequent' }), settings(6, { mode: 'relaxed' }), settings(7, { mode: 'balanced' })];
  assert.equal(replay(trip, { policy }).model.days, 10);
  const changed = [...events, settings(5, { mode: 'relaxed' }), complete(6, '2028-02-01', { mode: 'relaxed', initialDays: 14 })];
  const result = replay(changed, { policy }); assert.equal(result.validIntervalCount, 3); assert.equal(result.model.days, 20);
});

test('adaptive fixed release starts a fresh generation and necessary-only modes never acquire a one-day surrogate', () => {
  const events = every([60, 60, 60]);
  const fixed = [...events, settings(5, { fixedDays: 20 }), settings(6, { mode: 'relaxed' })];
  assert.equal(replay(fixed).model.days, 20);
  const released = [...fixed, settings(7, { fixedDays: null })];
  assert.equal(replay(released).model.days, 28); assert.equal(replay(released).validIntervalCount, 0);
  const dates = ['2028-01-01', '2028-01-11', '2028-01-21', '2028-01-31'];
  const newer = dates.map((day, i) => complete(8 + i, day, { mode: 'relaxed', initialDays: 28 }));
  assert.equal(replay([...released, ...newer.slice(0, 3)]).model.days, 28);
  assert.equal(replay([...released, ...newer]).model.days, 10);
  const policy = { ...baseline, initialDays: { frequent: 90, balanced: 180, relaxed: null } };
  const prior = every([180, 180, 180], { initialDays: 180 });
  assert.equal(replay([...prior, settings(5, { mode: 'relaxed' })], { policy }).model, null);
  const resumed = [...prior, settings(5, { mode: 'relaxed' }), complete(6, '2028-02-01', { mode: 'relaxed', initialDays: null }),
    settings(7, { mode: 'balanced' }), complete(8, '2028-03-01', { initialDays: 180 })];
  const result = replay(resumed, { policy }); assert.equal(result.model.days, 180); assert.equal(result.validIntervalCount, 3);
});

test('adaptive same-day units use the earliest active original and never advance twice for duplicate operations or rounds', () => {
  const events = every([60, 60, 60]); events.at(-1).displayedWindow = { revision: 'frozen', from: '2026-06-29', through: '2026-07-01' };
  const other = complete(5, events.at(-1).localDate); const result = replay([...events, other, { ...other }]);
  assert.equal(result.validUnitCount, 4); assert.equal(result.validIntervalCount, 3); assert.equal(result.model.days, 14);
  assert.equal(replay([...events, other, undo(6, events.at(-1))]).model.days, 60);
  const duplicateRound = complete(2, '2026-01-02', { roundId: events[0].roundId });
  const duplicate = replay([events[0], duplicateRound, undo(3, events[0])]);
  assert.equal(duplicate.validUnitCount, 0);
  assert.throws(() => replay([events[0], { ...events[0], localDate: '2026-01-02' }]), /同じ操作/);
  assert.deepEqual(replay(events), replay([...events].reverse()));
});

test('adaptive chronology uses saved civil days across travel and DST without rewriting UTC timestamps', () => {
  const events = ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22'].map((day, i) => complete(i + 1, day,
    { timeZone: 'America/New_York', recordedAt: `${day}T14:00:00.000Z` }));
  assert.equal(replay(events).model.days, 7);
  const travel = [complete(1, '2026-01-10'), complete(2, '2026-01-09'), complete(3, '2026-01-12'), complete(4, '2026-01-13')];
  assert.equal(replay(travel).validIntervalCount, 3); assert.equal(replay(travel).model.days, 1);
  assert.equal(replay(travel).lastCompletedDate, '2026-01-13');
});

test('shared, seasonal, display and shared-origin records never train an individual model', () => {
  const events = every([60, 60, 60]);
  for (const kind of ['shared', 'seasonal', 'display']) {
    const result = replay(events, { policy: { ...baseline, kind } }); assert.equal(result.model, null); assert.equal(result.validIntervalCount, 0);
  }
  const result = replay(events.map(event => ({ ...event, origin: 'shared' })));
  assert.equal(result.model.days, 14); assert.equal(result.lastCompletedDate, null); assert.equal(result.validUnitCount, 0);
});

test('only saved causal prior forecasts count and Undo never backfills retrospective prediction wins', () => {
  const events = []; const forecasts = []; const originals = every([60, 60, 60, 60]);
  for (const event of originals) {
    events.push(event); const result = replay(events, { forecasts, capture: { afterOperationId: event.operationId,
      forRoundId: `round-${event.sequence + 1}`, createdAt: event.recordedAt } });
    if (result.forecast) forecasts.push(result.forecast);
  }
  const before = replay(events, { forecasts }); assert.equal(before.scores.length, 4);
  const after = replay([...events, undo(6, originals[1])], { forecasts });
  assert.equal(after.scores.length, 0); assert.equal(after.lastCompletedDate, originals.at(-1).localDate);
  assert.equal(forecasts.length, 5); assert.equal(after.forecast, null);
  assert.throws(() => replay(events, { capture: { afterOperationId: 'op-2', forRoundId: 'future', createdAt: events.at(-1).recordedAt } }), /過去/);
});

test('genuine month-end forecasts can earn adoption and early or late completion retains the scheduled calendar phase', () => {
  const policy = { ...baseline, initialDays: { frequent: 20, balanced: 30, relaxed: 45 } };
  const dates = ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30', '2025-05-31', '2025-06-30', '2025-07-31', '2025-08-30', '2025-10-01'];
  const events = []; const forecasts = []; let result;
  for (const [i, day] of dates.entries()) {
    const event = complete(i + 1, day, { initialDays: 30, ruleDate: i === 7 ? '2025-08-31' : i === 8 ? '2025-09-30' : day,
      ...(i >= 7 ? { displayedWindow: { revision: `window-${i}`, from: addDays(day, -2), through: addDays(day, 2) } } : {}) });
    events.push(event); result = replay(events, { policy, forecasts, capture: { afterOperationId: event.operationId,
      forRoundId: `round-${event.sequence + 1}`, createdAt: event.recordedAt } });
    if (result.forecast) forecasts.push(result.forecast);
    if (i === 6) assert.equal(result.model.method, 'monthEnd');
    if (i === 7) assert.equal(result.forecast.dates.monthEnd, '2025-09-30');
  }
  assert.equal(result.forecast.dates.monthEnd, '2025-10-31');
  const roundTrip = replay([...events, settings(10, { mode: 'relaxed' }), settings(11, { mode: 'balanced' })], { policy, forecasts });
  assert.deepEqual(roundTrip.model, result.model);
  const month = { method: 'monthEnd', months: 1, anchor: '2026-01-31' };
  assert.equal(adaptiveModeConversionDays(month, '2026-02-01'), 28);
  assert.equal(adaptiveModeConversionDays(month, '2024-02-01'), 29);
  assert.equal(adaptiveModeConversionDays(month, '2026-01-31'), 28);
});

test('same-day originals carry their first genuine prediction to the next effective unit only while the actual round lineage survives', () => {
  const first = complete(1, '2026-01-01');
  const forecast = replay([first], { capture: { afterOperationId: first.operationId, forRoundId: 'round-2', createdAt: first.recordedAt } }).forecast;
  const second = complete(2, '2026-01-01', { recordedAt: '2026-01-01T13:00:00Z' });
  const third = complete(3, '2026-01-15');
  const result = replay([first, second, third], { forecasts: [forecast] });
  assert.equal(result.validUnitCount, 2); assert.equal(result.scores.length, 1); assert.equal(result.scores[0].completionId, third.completionId);
  assert.equal(replay([first, second, third, undo(4, second)], { forecasts: [forecast] }).scores.length, 0);
});
