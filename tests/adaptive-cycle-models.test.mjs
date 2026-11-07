import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { adaptiveReferenceLimit, roundedAdaptiveDays, weightedIntervalMedian, finiteExponentialMean, fitAdaptiveModels,
  nearestMonthEnd, predictAdaptiveDate, adaptiveRepresentativeDays, chooseAdaptiveMethod } = await import('../src/domain/scheduling/adaptive/models.ts');
const intervals = values => values.map((days, ordinal) => ({ days, ordinal }));
function fit(values, change = {}) {
  return fitAdaptiveModels({ intervals: intervals(values), currentEpochIntervals: intervals(values), currentEpochDates: [], previousRepresentativeDays: 14, ...change });
}

test('adaptive learning chooses its bounded reference count once from the previous rounded representative and does not clip long intervals to initial cadence', () => {
  assert.deepEqual([30, 30.99, 31, 90, 90.99, 91].map(adaptiveReferenceLimit), [8, 8, 6, 6, 6, 4]);
  for (const [previousRepresentativeDays, limit] of [[30, 8], [90, 6], [91, 4]]) {
    const recent = Array.from({ length: limit }, (_, i) => 91 + i);
    const numeric = values => fit(values, { previousRepresentativeDays }).filter(model => model.method === 'median' || model.method === 'exponential');
    assert.deepEqual(numeric([1000, 1000, ...recent]), numeric(recent), 'only the selected recent intervals contribute, using the previous representative');
  }
  assert.equal(roundedAdaptiveDays(0.99), 1); assert.equal(roundedAdaptiveDays(8.99), 8);
  assert.equal(fit([60, 60, 60])[0].days, 60); assert.equal(fit([14, 14, 180])[0].days, 14);
  assert.deepEqual(fit([60, 60]), []); assert.equal(fit([...Array(10).fill(7), ...Array(5).fill(180)], { previousRepresentativeDays: 91 })[0].days, 180);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => adaptiveReferenceLimit(value));
});
test('adaptive weighted median handles exact half ties and finite exponential mean keeps the oldest and newest weights within 1 to 1.5', () => {
  assert.equal(weightedIntervalMedian([1, 9, 10, 2]), 5.5);
  const expected = (151 + Math.sqrt(1.5)) / (2.5 + Math.sqrt(1.5));
  assert.ok(Math.abs(finiteExponentialMean([1, 1, 100]) - expected) < 1e-12);
  assert.equal(finiteExponentialMean([60, 60, 60]), 60);
  assert.throws(() => weightedIntervalMedian([1, 0, 2]));
});
test('adaptive alternating models retain global interval parity through a moving reference window and do not create indistinguishable rounded phases', () => {
  const result = fit([7, 21, 7, 21, 7, 21, 7, 21], { previousRepresentativeDays: 91 });
  const model = result.find(value => value.method === 'alternating');
  assert.deepEqual(model, { method: 'alternating', even: 7, odd: 21, nextOrdinal: 8 });
  assert.equal(predictAdaptiveDate(model, '2026-11-01'), '2026-11-08'); assert.equal(adaptiveRepresentativeDays(model), 14);
  assert.equal(fit([7.1, 7.9, 7.1, 7.9]).some(value => value.method === 'alternating'), false);
  assert.equal(fit([7.1, 7.9, 7.1, 7.9], { retainingAlternating: true }).some(value => value.method === 'alternating'), true);
  assert.equal(fit([7, 21, 7]).some(value => value.method === 'alternating'), false);
});
test('adaptive weekly candidates use only current-mode dates and choose the latest completed weekday on a weighted tie', () => {
  const model = fit([8, 7, 6], { currentEpochDates: ['2026-10-03', '2026-10-11', '2026-10-18', '2026-10-24'] }).find(value => value.method === 'weekly');
  assert.deepEqual(model, { method: 'weekly', weeks: 1, weekday: 6, anchor: '2026-10-24' });
  assert.equal(predictAdaptiveDate(model, '2026-11-11', '2026-10-24'), '2026-11-14');
  assert.equal(fit([14, 14, 14], { currentEpochDates: ['2026-10-01', '2026-10-15'] }).some(value => value.method === 'weekly'), false);
});
test('adaptive month-end candidates require three positive month gaps and retain the scheduled phase after early late and several-month-late completions', () => {
  assert.equal(nearestMonthEnd('2026-02-14'), '2026-01-31');
  assert.equal(nearestMonthEnd('2024-02-15'), '2024-02-29');
  const fitted = fit([29, 30, 31], { currentEpochDates: ['2026-01-31', '2026-03-01', '2026-03-31', '2026-05-01'] }).find(value => value.method === 'monthEnd');
  assert.deepEqual(fitted, { method: 'monthEnd', months: 1, anchor: '2026-04-30' });
  const model = { method: 'monthEnd', months: 1, anchor: '2026-11-30' };
  assert.equal(predictAdaptiveDate(model, '2026-11-29'), '2026-12-31');
  assert.equal(predictAdaptiveDate(model, '2026-12-01'), '2026-12-31');
  assert.equal(predictAdaptiveDate(model, '2027-03-06'), '2027-03-31');
  assert.equal(fit([1, 28, 1], { currentEpochDates: ['2026-01-30', '2026-01-31', '2026-02-28', '2026-03-01'] }).some(value => value.method === 'monthEnd'), false);
});
test('adaptive method comparisons use pairwise prior forecasts in the same epoch and require two wins and both exact improvement thresholds', () => {
  const scores = (current, candidate, epoch = 'epoch-a') => current.map((error, i) => ({ epoch, completionId: `c${i}`, errors: { median: error, exponential: candidate[i], weekly: candidate[i] } }));
  assert.equal(chooseAdaptiveMethod('median', scores([2.5, 2.5, 2.5], [2, 2, 2]), 'epoch-a', ['exponential', 'weekly']), 'exponential');
  assert.equal(chooseAdaptiveMethod('median', scores([0, 0, 0], [0, 0, 0]), 'epoch-a', ['exponential']), 'median');
  assert.equal(chooseAdaptiveMethod('median', scores([20, 1, 1], [1, 1, 1]), 'epoch-a', ['exponential']), 'median');
  assert.equal(chooseAdaptiveMethod('median', scores([2.5, 2.5, 2.5], [2, 2, 2]), 'different-epoch', ['exponential']), 'median');
  const common = scores([10, 10, 10], [1, 1, 1]);
  common.splice(1, 0, { epoch: 'epoch-a', completionId: 'no-exponential', errors: { median: 0, monthEnd: 0 } });
  assert.equal(chooseAdaptiveMethod('median', common, 'epoch-a', ['exponential', 'monthEnd']), 'exponential');
});
