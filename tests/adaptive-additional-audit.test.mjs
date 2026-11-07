import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAdaptivePlacementInput } from '../src/features/planner/adaptive-input.ts';
import { placeAdaptiveRounds } from '../src/domain/scheduling/adaptive/placement.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';

test('an expired one-off holiday cannot make every future heavy placement fall back', () => {
  const geometry = prepareAdaptivePlacementInput({ from: '2026-11-01', through: '2026-11-30', timeZone: 'UTC',
    preferences: { restDays: [], heavyLimit: 2, normalLimit: 2, allowedBands: Array.from({ length: 7 }, (_, n) => ({ weekday: n + 1, startMinute: 540, endMinute: 1140 })),
      dayOverrides: [{ date: '2026-01-01', holiday: true }] }, events: [], exceptions: [], fingerprint: JSON.stringify });
  const plan = placeAdaptiveRounds({ ...geometry, today: '2026-11-01', now: Date.parse('2026-11-01T00:00Z'), fixedLoads: [],
    tasks: [{ id: 'round', choreId: 'heavy', baseDate: '2026-11-10', periodDays: 30, load: 'heavy', minutes: 30, fixedDaily: false, purpose: 'nextRound' }] })[0];
  assert.equal(plan.fallback, false); assert.ok(plan.slot);
});

test('year-long placement capacity reads scale with nearby bands rather than every day times every band', () => {
  let reads = 0;
  const days = Array.from({ length: 365 }, (_, n) => {
    const date = addDays('2026-01-01', n), start = Date.parse(`${date}T00:00Z`);
    return { date, bounds: { get start() { reads++; return start; }, get end() { reads++; return start + 86400000; } },
      allowed: [{ start: start + 9 * 3600000, end: start + 19 * 3600000 }], heavyLimit: 2, normalLimit: 2, holiday: false };
  });
  const plans = placeAdaptiveRounds({ days, busy: [], fixedLoads: [], today: '2026-01-01', now: Date.parse('2026-01-01T00:00Z'), holidaysConfigured: false,
    tasks: [{ id: 'round', choreId: 'normal', baseDate: '2026-03-01', periodDays: 30, minutes: 30, load: 'normal', fixedDaily: false, purpose: 'nextRound' }] });
  assert.equal(plans[0].recommendedDate, '2026-03-01'); assert.ok(plans[0].slot);
  assert.ok(reads < 30000, `day boundary reads: ${reads}`);
});
