import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalysisRunner } from '../server/appliance-care-api/src/analysis-runner.mjs';
import { applianceCarePollDelay, waitForAppliancePoll } from '../src/features/appliance-care/polling.ts';

const request = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20', category: 'vacuum_cleaner' };
const verified = { status: 'verified', product: request,
  officialSources: { manualUrl: 'https://www.dyson.co.jp/support/SV20' }, analysis: { tasks: [{ name: 'filter' }] } };

test('same normalized request is shared in flight and cached only after a verified result', async () => {
  let calls = 0; let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  const runner = createAnalysisRunner({ analyze: async (_request, _deps, stage) => {
    calls++; stage('official_manual_analysis'); return result;
  } });
  const first = runner.run(request);
  const stages = [];
  const second = runner.run({ ...request, manufacturer: '  dyson  ' }, (stage) => stages.push(stage));
  finish(verified);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.ok(stages.includes('official_manual_analysis'));
  a.analysis.tasks[0].name = 'locally changed';
  assert.equal(b.analysis.tasks[0].name, 'filter');
  assert.equal((await runner.run(request)).analysis.tasks[0].name, 'filter');
  assert.equal(calls, 1);
});

test('explicit reanalysis and cache expiry rerun; category/model variants do not share results', async () => {
  let clock = 0, calls = 0;
  const runner = createAnalysisRunner({ now: () => clock, cacheTtlMs: 1000, analyze: async () => { calls++; return verified; } });
  await runner.run(request); await runner.run(request);
  assert.equal(calls, 1);
  await runner.run(request, undefined, { bypassCache: true });
  assert.equal(calls, 2);
  clock = 1001;
  await runner.run(request);
  await runner.run({ ...request, category: 'other' });
  await runner.run({ ...request, modelNumber: 'SV21' });
  assert.equal(calls, 5);
});

test('errors are not cached and admission limits cap distinct paid analysis work', async () => {
  let calls = 0;
  const runner = createAnalysisRunner({ maxPerHour: 2, analyze: async () => { calls++; return { status: 'error', code: 'ANALYSIS_FAILED' }; } });
  await runner.run(request); await runner.run(request);
  assert.equal((await runner.run(request)).code, 'RATE_LIMITED');
  assert.equal(calls, 2);
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const concurrent = createAnalysisRunner({ maxConcurrent: 1, analyze: async () => waiting });
  const active = concurrent.run(request);
  assert.equal((await concurrent.run({ ...request, modelNumber: 'different' })).code, 'RATE_LIMITED');
  finish(verified); await active;
});

test('polling backs off, clamps server hints, and ends promptly on abort', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((attempt) => applianceCarePollDelay(attempt)), [1000, 1500, 2000, 3000, 5000, 8000, 8000]);
  assert.equal(applianceCarePollDelay(0, -10), 1000);
  assert.equal(applianceCarePollDelay(0, 100_000), 8000);
  assert.equal(applianceCarePollDelay(0, NaN), 1000);
  const controller = new AbortController();
  const wait = waitForAppliancePoll(5000, controller.signal);
  controller.abort();
  await wait;
});
