import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');

test('audit50 initial fixed load reservations are unioned in one pass instead of shifting the growing busy array for each round', () => {
  const origin = Date.parse('2026-11-07T00:00:00Z'); let moved = 0; const splice = Array.prototype.splice;
  Array.prototype.splice = function(start, count, ...values) {
    if (values.length === 1 && values[0] && typeof values[0].start === 'number' && typeof values[0].end === 'number') moved += Math.max(0, this.length - start - count);
    return splice.call(this, start, count, ...values);
  };
  try {
    const loads = Array.from({ length: 1200 }, (_, n) => ({ roundId: `fixed-${n}`, date: '2026-11-07', minutes: 1, load: 'light',
      slot: { start: origin + (1200 - n) * 120000, end: origin + (1200 - n) * 120000 + 60000 } }));
    const result = placeAdaptiveRounds({ tasks: [], days: [], today: '2026-11-07', now: origin, busy: [], fixedLoads: loads, holidaysConfigured: false });
    assert.deepEqual(result, []); assert.ok(moved < 2400, `shifted reserved interval references: ${moved}`);
    assert.throws(() => placeAdaptiveRounds({ tasks: [], days: [], today: '2026-11-07', now: origin, busy: [],
      fixedLoads: [loads[0], { ...loads[0], minutes: 2 }], holidaysConfigured: false }), /重複/u, 'contradictory duplicate rounds still fail');
  } finally { Array.prototype.splice = splice; }
});
