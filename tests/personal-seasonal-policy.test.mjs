import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const policy = await import('../src/domain/scheduling/adaptive/seasonal.ts');
const { adaptivePersonalDigest: fingerprint } = await import('../src/features/planner/adaptive-digest.ts');

test('seasonal clothing regions use verified structured prefectures and keep ambiguous legacy locations on the explicit national fallback', () => {
  assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: 'JP-01' }), 'hokkaido');
  assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: 'JP-07' }), 'tohoku');
  assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: 'JP-24' }), 'eastPacific');
  for (const code of [15, 16, 17, 18, 19, 20]) assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: `JP-${code}` }), 'eastInland');
  assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: 'JP-46' }), 'nationalFallback');
  assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: 'JP-46', islandGroup: 'amami' }), 'amami');
  assert.equal(policy.clothingRegionFor({ countryCode: 'JP', prefectureCode: 'JP-46', islandGroup: 'mainland' }), 'southwest');
  for (const value of [null, { region: '北海道っぽい', latitude: 43, longitude: 141 }, { countryCode: 'US', prefectureCode: 'JP-01' }]) assert.equal(policy.clothingRegionFor(value), 'nationalFallback');
});

test('seasonal initial dates follow the adopted regional table and the Amami 2026 exception never leaks into the next year', () => {
  const expected = { nationalFallback: ['05-15', '10-15'], hokkaido: ['05-15', '09-25'], tohoku: ['05-15', '10-01'],
    eastPacific: ['05-01', '10-15'], eastInland: ['05-01', '10-15'], southwest: ['04-15', '10-25'], okinawa: ['03-25', '11-01'], amami: ['04-15', '11-01'] };
  for (const [region, days] of Object.entries(expected)) {
    assert.equal(policy.clothingFixedDay(region, 'winterStorage', 2027).date, `2027-${days[0]}`);
    assert.equal(policy.clothingFixedDay(region, 'summerStorage', 2027).date, `2027-${days[1]}`);
  }
  assert.equal(policy.clothingFixedDay('amami', 'summerStorage', 2026).date, '2026-11-15');
  const meta = policy.clothingFixedDay('eastInland', 'summerStorage', 2027);
  assert.equal(meta.editorialApproximation, true); assert.ok(meta.scope.includes('代替')); assert.equal(meta.verifiedOn, '2026-11-04');
});

test('seasonal round identity includes work year and season while region and adopted dates remain changeable attributes', () => {
  const a = policy.personalSeasonalRound('clothing', 'summerStorage', 2026, 'hokkaido', fingerprint);
  const b = policy.personalSeasonalRound('clothing', 'summerStorage', 2026, 'amami', fingerprint);
  assert.equal(a.id, b.id); assert.notEqual(a.date, b.date);
  assert.notEqual(a.id, policy.personalSeasonalRound('clothing', 'winterStorage', 2026, 'hokkaido', fingerprint).id);
  assert.notEqual(a.id, policy.personalSeasonalRound('clothing', 'summerStorage', 2027, 'hokkaido', fingerprint).id);
});

test('seasonal initialization waits for each next actual fixed date without ordinary cycle windows or a fake completion', () => {
  const rounds = policy.initializePersonalSeasonalRounds({ choreId: 'clothing', region: 'nationalFallback', today: '2026-08-01', fingerprint });
  assert.deepEqual(rounds.map(round => [round.work, round.date]), [['winterStorage', '2027-05-15'], ['summerStorage', '2026-10-15']]);
  assert.ok(rounds.every(round => !Object.hasOwn(round, 'completedDate') && !Object.hasOwn(round, 'displayedWindow')));
});

test('seasonal region updates preserve completed today tomorrow and overdue rounds and do not move a future round into the past', () => {
  const a = policy.personalSeasonalRound('clothing', 'summerStorage', 2026, 'nationalFallback', fingerprint);
  for (const [today, completedRoundIds] of [['2026-10-14', new Set()], ['2026-10-15', new Set()], ['2026-11-01', new Set()], ['2026-08-01', new Set([a.id])]]) {
    assert.deepEqual(policy.updatePersonalSeasonalRegion(a, { region: 'hokkaido', today, completedRoundIds, fingerprint }), a);
  }
  assert.deepEqual(policy.updatePersonalSeasonalRegion(a, { region: 'hokkaido', today: '2026-10-01', completedRoundIds: new Set(), fingerprint }), a);
  const changed = policy.updatePersonalSeasonalRegion(a, { region: 'hokkaido', today: '2026-08-01', completedRoundIds: new Set(), fingerprint });
  assert.equal(changed.date, '2026-09-25'); assert.equal(changed.id, a.id);
});

test('a late seasonal completion closes only its work kind and advances to the first later same-kind rule date without fabricating missed-year completions', () => {
  const spring = policy.personalSeasonalRound('clothing', 'winterStorage', 2026, 'nationalFallback', fingerprint);
  const autumn = policy.personalSeasonalRound('clothing', 'summerStorage', 2026, 'nationalFallback', fingerprint);
  const next = policy.completePersonalSeasonalRound(spring, { completedDate: '2026-08-01', region: 'nationalFallback', fingerprint });
  assert.equal(next.date, '2027-05-15'); assert.equal(next.work, 'winterStorage'); assert.equal(autumn.date, '2026-10-15');
  assert.equal(policy.completePersonalSeasonalRound(spring, { completedDate: '2029-11-01', region: 'nationalFallback', fingerprint }).date, '2030-05-15');
  assert.equal(policy.completePersonalSeasonalRound(spring, { completedDate: '2026-01-01', region: 'nationalFallback', fingerprint }).date, '2027-05-15');
});

test('private adaptive fingerprints preserve persisted optional values without weakening shared canonical validation or concealing invalid numbers', () => {
  assert.equal(fingerprint({ optional: undefined, a: 1, ordered: [undefined, 2] }), fingerprint({ a: 1, ordered: [null, 2] }));
  for (const value of [undefined, NaN, Infinity, { bad: -Infinity }, { run() {} }]) assert.throws(() => fingerprint(value));
});
