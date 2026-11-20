import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfHostedWeather, createSqliteWeatherStore } from '../server/appliance-care-api/src/weather/sqlite-runtime.mjs';

const minute = 60_000;
const stamp = Date.parse('2026-11-20T06:00:00Z');
const region = 'jp-municipal.13101';
function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-self-host-weather-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'weather.sqlite');
}

test('self-hosted weather wakes on first use and resumes a scheduled retry from SQLite after restarting', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: stamp });
  const file = temporaryDatabase(t);
  const calls = [];
  const errors = [];
  const open = () => createSelfHostedWeather({ file, userAgent: 'LiFlow/case https://weather.liflow.app/contact',
    onError: () => errors.push('scheduler'),
    fetcher: async () => {
      calls.push(Date.now());
      if (calls.length === 1) return new Response(null, { status: 503 });
      const date = new Date(Date.now()).toISOString();
      return Response.json({ properties: { meta: { updated_at: date, units: { precipitation_amount: 'mm' } },
        timeseries: [{ time: date, data: { next_1_hours: { summary: { symbol_code: 'clearsky_day' },
          details: { precipitation_amount: 0 } } } }] } });
    },
  });
  let instance = open();
  const flush = () => new Promise(setImmediate);
  try {
    t.mock.timers.tick(86_400_000); await flush();
    assert.deepEqual(calls, []);
    assert.equal((await instance.service.read(region)).status, 202);
    t.mock.timers.tick(0); await flush();
    assert.equal(calls.length, 1);
    await instance.close();

    const inspection = createSqliteWeatherStore(file, Date.now, () => {});
    const retry = inspection.nextDeadline();
    inspection.close();
    assert.ok(retry - calls[0] >= 4 * minute && retry - calls[0] <= 6 * minute);
    instance = open();
    t.mock.timers.tick(retry - Date.now() - 1); await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(calls, [stamp + 86_400_000, retry]);
    assert.equal((await instance.service.read(region)).status, 200);
    assert.deepEqual(errors, []);
  } finally { await instance.close(); }
});

test('self-hosted weather waits for an interrupted worker lease and only its replacement may commit', async t => {
  const file = temporaryDatabase(t);
  let time = stamp;
  let local = createSqliteWeatherStore(file, () => time, () => {});
  assert.equal(local.nextDeadline(), null);
  await local.store.reference(region);
  const interrupted = await local.store.claim();
  assert.equal(local.nextDeadline(), stamp + minute);
  local.close();
  local = createSqliteWeatherStore(file, () => time, () => {});
  try {
    assert.equal(await local.store.claim(), null);
    time += minute;
    const replacement = await local.store.claim();
    assert.ok(replacement);
    assert.notEqual(replacement.leaseToken, interrupted.leaseToken);
    assert.equal(await local.store.finish(interrupted, { code: 'met_unavailable' }), false);
    assert.equal(await local.store.finish(replacement, { code: 'met_forbidden' }), true);
    assert.equal(local.nextDeadline(), null);
  } finally { local.close(); }
});
