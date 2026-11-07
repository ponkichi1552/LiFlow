import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');

test('audit50 the personal adaptive allocator assigns identical dates under real English and Danish identifier collation', () => {
  const origin = Date.parse('2026-11-08T00:00:00Z');
  const days = ['2026-11-08', '2026-11-09'].map((date, n) => ({ date, holiday: false, heavyLimit: 1, normalLimit: 1,
    bounds: { start: origin + n * 86400000, end: origin + (n + 1) * 86400000 },
    allowed: [{ start: origin + n * 86400000 + 9 * 3600000, end: origin + n * 86400000 + 10 * 3600000 }] }));
  const tasks = ['appliance-care.A', 'appliance-care.a'].map(choreId => ({ id: `round-${choreId}`, choreId,
    baseDate: '2026-11-08', periodDays: 7, minutes: 30, load: 'heavy', purpose: 'nextRound', fixedDaily: false, windowRadiusDays: 0 }));
  const run = locale => {
    const original = String.prototype.localeCompare; const compare = new Intl.Collator(locale).compare;
    String.prototype.localeCompare = function(other) { return compare(String(this), other); };
    try { return placeAdaptiveRounds({ tasks, days, today: '2026-11-07', now: origin - 86400000,
      busy: [], fixedLoads: [], holidaysConfigured: false }); }
    finally { String.prototype.localeCompare = original; }
  };
  const english = run('en-US'); const danish = run('da-DK');
  assert.deepEqual(danish, english);
  assert.equal(new Set(english.map(row => row.recommendedDate)).size, 2);
});
