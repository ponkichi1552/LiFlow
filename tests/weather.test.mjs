import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addDays } from '../src/domain/scheduling/local-date.ts';
import {
  applyLaundryWeatherAdjustments,
  isSuitableLaundryDay,
  LaundryWeatherAdjustmentPolicy,
} from '../src/features/weather/laundry-policy.ts';
import { optimizeLaundryScheduleForWeather } from '../src/features/weather/optimize-laundry-schedule.ts';
import './helpers/typescript-loader.mjs';
const { searchJapaneseMunicipalities } = await import('../src/features/weather/municipality-search.ts');

const today = '2026-10-24';
const householdId = 'home';

function chore(id, overrides = {}) {
  return {
    id,
    householdId,
    name: id,
    category: 'その他',
    description: '',
    enabled: true,
    frequencyDaysByMode: { frequent: 4, balanced: 4, relaxed: 4 },
    windowRadiusDays: 1,
    maxShiftDays: 4,
    load: 'light',
    holidayPriority: false,
    everyday: false,
    instructions: [],
    tools: [],
    cautions: [],
    ...overrides,
  };
}

function entry(choreId, overrides = {}) {
  const cycleBaseDate = '2026-10-26';
  return {
    id: `${choreId}:${cycleBaseDate}`,
    householdId,
    choreId,
    cycleBaseDate,
    windowStart: '2026-10-25',
    windowEnd: '2026-10-27',
    suggestedDate: cycleBaseDate,
    status: 'scheduled',
    assignedMemberIds: [],
    ...overrides,
  };
}

function settings(overrides = {}) {
  return {
    frequencyMode: 'balanced',
    restDays: [6, 7],
    loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 1 },
    ...overrides,
  };
}

function forecast(overrides = {}) {
  return Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(today, offset);
    return {
      date,
      weatherCode: 61,
      precipitationProbability: 90,
      precipitationMm: 5,
      ...overrides[date],
    };
  });
}

function weatherLocation(overrides = {}) {
  return {
    region: '東京',
    displayName: '新宿区, 東京都, 日本',
    latitude: 35.69,
    longitude: 139.70,
    ...overrides,
  };
}

function policyInput(overrides = {}) {
  return {
    today,
    chores: [chore('laundry', { category: '洗濯', laundryDryingPreference: 'either', load: 'normal' })],
    completions: [],
    dependencies: [],
    settings: settings(),
    ...overrides,
  };
}

test('romanized municipality queries do not acquire a Japanese suffix on an English Android keyboard', async () => {
  for (const input of ['Yokohama', 'Ｙｏｋｏｈａｍａ', '横浜', '横浜市']) {
    assert.equal(searchJapaneseMunicipalities(input)[0].name, '横浜市');
  }
});

test('laundry policy selects a nearby suitable day only for laundry chores', () => {
  const chores = [
    chore('laundry', { category: '洗濯', laundryDryingPreference: 'either', load: 'normal' }),
    chore('vacuum', { category: '居室', load: 'normal' }),
  ];
  const schedule = [entry('laundry'), entry('vacuum')];
  const weather = forecast({
    '2026-10-27': { weatherCode: 2, precipitationProbability: 10, precipitationMm: 0.1 },
  });
  const policy = new LaundryWeatherAdjustmentPolicy(policyInput({ chores }));
  const adjustments = policy.proposeAdjustments({ forecast: weather, schedule });

  assert.deepEqual(adjustments.map((item) => item.scheduleEntryId), ['laundry:2026-10-26']);
  assert.equal(adjustments[0].data.suggestedDate, '2026-10-27');
  const adjusted = applyLaundryWeatherAdjustments(schedule, adjustments);
  assert.equal(adjusted.length, 2);
  assert.equal(adjusted.find((item) => item.choreId === 'vacuum').suggestedDate, '2026-10-26');
});

test('policy keeps already-suitable dates and requires all weather thresholds', () => {
  assert.equal(isSuitableLaundryDay({
    date: today, weatherCode: 0, precipitationProbability: 30, precipitationMm: 0.5,
  }), true);
  assert.equal(isSuitableLaundryDay({
    date: today, weatherCode: 0, precipitationProbability: 10, precipitationMm: 0.6,
  }), false);
  assert.equal(isSuitableLaundryDay({
    date: today, weatherCode: 61, precipitationProbability: 10, precipitationMm: 0,
  }), false);
  const current = entry('laundry', { suggestedDate: '2026-10-27', cycleBaseDate: '2026-10-27' });
  const weather = forecast({
    '2026-10-27': { weatherCode: 1, precipitationProbability: 10, precipitationMm: 0 },
  });
  const policy = new LaundryWeatherAdjustmentPolicy(policyInput());
  assert.deepEqual(policy.proposeAdjustments({ forecast: weather, schedule: [current] }), []);
});

test('holiday-priority laundry prefers a rest day among equally close forecast choices', () => {
  const holidayLaundry = chore('laundry', {
    category: '洗濯', laundryDryingPreference: 'either', holidayPriority: true,
  });
  const weather = forecast({
    '2026-10-25': { weatherCode: 0, precipitationProbability: 10, precipitationMm: 0 },
    '2026-10-27': { weatherCode: 0, precipitationProbability: 10, precipitationMm: 0 },
  });
  const policy = new LaundryWeatherAdjustmentPolicy(policyInput({
    chores: [holidayLaundry],
    settings: settings({ restDays: [7] }),
  }));
  const adjustments = policy.proposeAdjustments({ forecast: weather, schedule: [entry('laundry')] });
  assert.equal(adjustments[0].data.suggestedDate, '2026-10-25');
});

test('policy respects movement range, completion, initial pending status, load limits, and dependencies', () => {
  const laundry = chore('laundry', {
    category: '洗濯', laundryDryingPreference: 'either', load: 'normal', windowRadiusDays: 0, maxShiftDays: 0,
  });
  const onlyNextDaySunny = forecast({
    '2026-10-27': { weatherCode: 0, precipitationProbability: 10, precipitationMm: 0 },
  });
  const policy = new LaundryWeatherAdjustmentPolicy(policyInput({ chores: [laundry] }));
  assert.deepEqual(policy.proposeAdjustments({ forecast: onlyNextDaySunny, schedule: [entry('laundry')] }), []);

  const movableLaundry = chore('laundry', { category: '洗濯', laundryDryingPreference: 'either', load: 'normal' });
  const loadPolicy = new LaundryWeatherAdjustmentPolicy(policyInput({
    chores: [movableLaundry, chore('other', { load: 'normal' })],
  }));
  assert.deepEqual(loadPolicy.proposeAdjustments({
    forecast: onlyNextDaySunny,
    schedule: [entry('laundry'), entry('other', { suggestedDate: '2026-10-27', cycleBaseDate: '2026-10-27' })],
  }), []);

  const dependencyPolicy = new LaundryWeatherAdjustmentPolicy(policyInput({
    chores: [movableLaundry, chore('predecessor')],
    dependencies: [{ id: 'dependency', predecessorChoreId: 'predecessor', successorChoreId: 'laundry' }],
  }));
  assert.deepEqual(dependencyPolicy.proposeAdjustments({
    forecast: forecast({
      '2026-10-25': { weatherCode: 0, precipitationProbability: 10, precipitationMm: 0 },
    }),
    schedule: [
      entry('laundry'),
      // The predecessor belongs to this cycle but was suggested a day later.
      entry('predecessor', { suggestedDate: '2026-10-27', cycleBaseDate: '2026-10-26' }),
    ],
  }), []);

  const completionPolicy = new LaundryWeatherAdjustmentPolicy(policyInput({
    chores: [movableLaundry],
    completions: [{ outcome: 'completed', scheduleEntryId: 'laundry:2026-10-26' }],
  }));
  assert.deepEqual(completionPolicy.proposeAdjustments({ forecast: onlyNextDaySunny, schedule: [entry('laundry')] }), []);

  const initial = entry('laundry', { status: 'initialPending' });
  assert.deepEqual(policy.proposeAdjustments({ forecast: onlyNextDaySunny, schedule: [initial] }), []);

  const indoorPolicy = new LaundryWeatherAdjustmentPolicy(policyInput({
    chores: [chore('laundry', { category: '洗濯', laundryDryingPreference: 'indoors' })],
  }));
  assert.deepEqual(indoorPolicy.proposeAdjustments({ forecast: onlyNextDaySunny, schedule: [entry('laundry')] }), []);

  const outsideForecast = entry('laundry', { suggestedDate: '2026-10-31', cycleBaseDate: '2026-10-31' });
  assert.deepEqual(policy.proposeAdjustments({ forecast: onlyNextDaySunny, schedule: [outsideForecast] }), []);

  const incompletePolicy = new LaundryWeatherAdjustmentPolicy(policyInput({
    chores: [movableLaundry],
    completions: [{ outcome: 'incomplete', scheduleEntryId: 'laundry:2026-10-26' }],
  }));
  assert.equal(incompletePolicy.proposeAdjustments({ forecast: onlyNextDaySunny, schedule: [entry('laundry')] })[0].data.suggestedDate, '2026-10-27');
});

test('weather optimization failure leaves the original schedule and entries intact', async () => {
  const schedule = [entry('laundry')];
  const result = await optimizeLaundryScheduleForWeather({
    householdId,
    today,
    location: weatherLocation(),
    chores: [chore('laundry', { category: '洗濯', laundryDryingPreference: 'either' })],
    completions: [],
    dependencies: [],
    settings: settings(),
    schedule,
  }, { fetchForecast: async () => { throw new Error('offline'); } });

  assert.equal(result.outcome, 'unavailable');
  assert.deepEqual(result.schedule, schedule);
});

test('weather adjustment is deterministic and idempotent', () => {
  const schedule = [entry('laundry')];
  const goodForecast = forecast({
    '2026-10-27': { weatherCode: 0, precipitationProbability: 10, precipitationMm: 0 },
  });
  const policy = new LaundryWeatherAdjustmentPolicy(policyInput());
  const first = policy.proposeAdjustments({ forecast: goodForecast, schedule });
  const second = policy.proposeAdjustments({ forecast: goodForecast, schedule });
  assert.deepEqual(second, first);
  const adjusted = applyLaundryWeatherAdjustments(schedule, first);
  assert.deepEqual(policy.proposeAdjustments({ forecast: goodForecast, schedule: adjusted }), []);
  assert.equal(adjusted.length, 1);
});
