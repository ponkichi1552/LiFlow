import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as dates from '../src/domain/scheduling/local-date.ts';
import * as models from '../src/domain/scheduling/adaptive/models.ts';
import * as cycles from '../src/domain/chores/cycle-policy.ts';
import * as matching from '../src/domain/scheduling/completion-matching.ts';
const input = (model, base) => ({ chores: [{ id: 'annual', householdId: 'local-household', enabled: true, windowRadiusDays: 2,
  frequencyDaysByMode: { balanced: 90 } }], settings: { frequencyMode: 'balanced' }, completions: [],
  scheduleEntries: [{ id: 'expired', choreId: 'annual', cycleBaseDate: base, suggestedDate: base, windowStart: base, windowEnd: base, status: 'scheduled' }],
  personalCadences: { annual: { days: 90, windowRadiusDays: 2, automatic: true, calendarModel: model } } });

test('distant calendar preview seeks directly to the next unfinished long round without replaying every missed cycle', t => {
  let predictions = 0;
  const { personalLongCalendarPreviews } = loadNativeModule('src/features/calendar/long-cycle-preview.ts', {
    '../../domain/scheduling/local-date.ts': dates, '../../domain/chores/cycle-policy.ts': cycles,
    '../../domain/scheduling/completion-matching.ts': matching,
    '../../domain/scheduling/adaptive/models.ts': { ...models, predictAdaptiveDate: (...args) => { predictions++; return models.predictAdaptiveDate(...args); } },
  });
  for (const model of [{ method: 'median', days: 90 }, { method: 'exponential', days: 90 },
    { method: 'weekly', weeks: 13, weekday: 4, anchor: '2016-01-07' },
    { method: 'monthEnd', months: 3, anchor: '2016-01-31' },
    { method: 'alternating', even: 90, odd: 100, nextOrdinal: 1 }]) {
    const base = model.anchor ?? '2016-01-01'; const snapshot = input(model, base); const before = structuredClone(snapshot);
    let expected = base, phase = model;
    do { if (phase.method === 'alternating') phase = { ...phase, nextOrdinal: phase.nextOrdinal + 1 }; expected = models.predictAdaptiveDate(phase, expected); } while (dates.addDays(expected, 2) < '2026-11-07');
    predictions = 0;
    const row = personalLongCalendarPreviews(snapshot, '2026-11-07')[0];
    assert.equal(row?.entry.suggestedDate, expected, model.method); assert.deepEqual(snapshot, before);
    t.diagnostic(`${model.method}: ${predictions} predictions`);
    assert.ok(predictions <= 3, `${model.method}: ${predictions} predictions`);
  }
});
