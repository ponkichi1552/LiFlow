import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { searchJapaneseMunicipalities, resolveWeatherMunicipality } = createRequire(import.meta.url)('../src/features/weather/municipality-search.ts');
import { wasteCalendarLabels } from '../src/features/waste/calendar-labels.ts';
import { buildReviewedApplianceChore } from '../src/features/appliance-care/persistence-policy.ts';

test('legacy weather-location resolution does not renormalize every municipality label for each saved-setting read', () => {
  const city = searchJapaneseMunicipalities('横浜市')[0];
  const location = { displayName: city.label, latitude: city.latitude, longitude: city.longitude };
  resolveWeatherMunicipality(location);
  const original = String.prototype.normalize; let calls = 0;
  String.prototype.normalize = function (...args) { calls++; return original.apply(this, args); };
  try {
    for (let n = 0; n < 20; n++) assert.equal(resolveWeatherMunicipality(location)?.id, city.id);
    assert.ok(calls <= 20, `normalizations: ${calls}`);
  } finally { String.prototype.normalize = original; }
});

test('weekly calendar labels do not generate every occurrence when no hidden occurrence can affect the output', () => {
  let reads = 0;
  const schedule = { id: 'waste', householdId: 'home', get label() { reads++; return '缶'; }, collectionWeekdays: [1], recurrence: 'weekly' };
  const labels = wasteCalendarLabels([schedule], '2026-01-01', '2026-12-31');
  assert.deepEqual(labels.weeklyByColumn[1], ['缶']); assert.equal(labels.byDate.size, 0); assert.equal(labels.hiddenWeeklyByDate.size, 0);
  assert.ok(reads <= 3, `weekly label reads: ${reads}`);
  const hidden = wasteCalendarLabels([schedule], '2026-01-01', '2026-01-31', ['waste:2026-01-05']);
  assert.deepEqual(hidden.hiddenWeeklyByDate.get('2026-01-05'), ['缶']);
});

test('appliance reanalysis preserves the explicitly chosen adaptive execution-window override', () => {
  const task = { name: 'フィルター掃除', recommendedIntervalDays: 30, steps: ['電源を切る'], tools: [], safetyCautions: [], evidence: [] };
  const product = { manufacturer: 'Dyson', productName: '掃除機', modelNumber: 'QA', manualUrl: 'https://www.dyson.co.jp/manual.pdf' };
  const analysis = { manufacturer: product.manufacturer, model: product.modelNumber, analyzedAt: '2026-11-07T00:00Z', requiresUserReview: true, tasks: [task] };
  const options = { id: 'chore', householdId: 'home', applianceId: 'appliance', product, analysis, approved: { task } };
  const first = buildReviewedApplianceChore(options).definition;
  const next = buildReviewedApplianceChore({ ...options, existing: { ...first, windowRadiusDays: 4, userWindowRadiusDays: 4, laundryDryingPreference: 'indoors' } }).definition;
  assert.equal(next.userWindowRadiusDays, 4); assert.equal(next.windowRadiusDays, 4); assert.equal(next.laundryDryingPreference, 'indoors');
});
