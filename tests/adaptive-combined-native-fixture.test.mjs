import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
const { runCombinedAdaptiveScenario } = await import('./native/expo-sqlite/adaptive-combined-scenario.ts');

test('portable physical-device fixture exercises actual adaptive store learning calendar weather shared load and Undo', async () => {
  const h = createDatabase();
  try {
    const result = await runCombinedAdaptiveScenario(h.database);
    assert.equal(result.checks.length, 6);
    assert.equal(result.syntheticInputOnly, true);
    assert.equal(result.networkUsed, false);
    assert.equal(result.sharedProjectionUnchanged, true);
    assert.equal(result.learnedDays, 28);
    assert.equal(result.baselineDate, '2026-04-23');
    assert.equal(result.combinedDate, '2026-04-24');
  } finally { h.connection.close(); }
});
