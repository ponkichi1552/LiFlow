import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');

test('audit50 heavy adaptive window expansion indexes holiday dates rather than scanning six months for every candidate', () => {
  let reads = 0; const origin = Date.parse('2026-11-07T00:00:00Z');
  const days = Array.from({ length: 181 }, (_, n) => ({ date: addDays('2026-11-07', n),
    bounds: { start: origin + n * 86400000, end: origin + (n + 1) * 86400000 },
    allowed: [{ start: origin + n * 86400000 + 9 * 3600000, end: origin + n * 86400000 + 11 * 3600000 }],
    get holiday() { reads++; return n % 7 === 0; }, heavyLimit: 2, normalLimit: 2 }));
  const [result] = placeAdaptiveRounds({ tasks: [{ id: 'round', choreId: 'large', baseDate: '2027-01-01', periodDays: 365, minutes: 40,
    load: 'heavy', purpose: 'nextRound', fixedDaily: false }], days, today: '2026-11-07', now: origin, busy: [], fixedLoads: [], holidaysConfigured: true });
  assert.equal(result.fallback, false); assert.ok(result.slot); assert.equal(result.recommendedDate, '2027-01-02');
  assert.ok(reads < 2000, `holiday calendar inspections: ${reads}`);
});
