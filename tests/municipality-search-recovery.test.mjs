import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
const municipality = await import('../src/features/weather/municipality-search.ts');
function searchHook() {
  return loadNativeModule('src/features/weather/use-municipality-suggestions.ts', {
    react: { useMemo: factory => factory() }, './municipality-search': municipality,
  }).useMunicipalitySuggestions;
}
for (const platform of ['iOS', 'Android']) test(`${platform} municipality search remains available offline without waiting for network or exposing native diagnostics`, () => {
  const hook = searchHook(); const fetcher = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('native diagnostic'); };
  try {
    const value = hook('よこはま'); assert.equal(value.status, 'results'); assert.equal(value.candidates[0].name, '横浜市');
    assert.equal(value.error, null); assert.equal(calls, 0);
  } finally { globalThis.fetch = fetcher; }
});
test('offline municipality hook immediately follows the current query and stops hidden suggestions without obsolete search results', () => {
  const hook = searchHook(); assert.equal(hook('Yokohama').candidates[0].name, '横浜市');
  assert.equal(hook('Sapporo').candidates[0].name, '札幌市'); assert.equal(hook('新宿区').candidates[0].name, '新宿区');
  assert.deepEqual(hook('札幌', false), { query: '札幌', candidates: [], status: 'idle', error: null });
  assert.equal(hook('存在しない自治体').status, 'empty'); assert.equal(hook('新宿区').status, 'results'); assert.equal(hook('横').status, 'idle');
});
