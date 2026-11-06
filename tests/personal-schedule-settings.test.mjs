import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readPersonalScheduleSettings } = await import('../src/platform/storage/personal-schedule-settings.ts');

test('personal presentation settings read current SQLite values without loading or writing a chore plan', async () => {
  const f = createDatabase();
  try {
    await initializeLocalDatabase(f.database);
    f.connection.prepare('UPDATE household_settings SET frequency_mode=?,rest_days_json=?,heavy_daily_limit=?,normal_daily_limit=?').run('relaxed', '[2,6]', 0, 4);
    const changes = f.connection.prepare('SELECT total_changes() AS n').get().n; const queries = [];
    const settings = await readPersonalScheduleSettings({ getFirstAsync: (sql, ...parameters) => {
      queries.push(sql); return f.database.getFirstAsync(sql, ...parameters);
    } });
    assert.deepEqual(settings, { frequencyMode: 'relaxed', restDays: [2, 6], heavyDailyLimit: 0, normalDailyLimit: 4 });
    assert.equal(queries.length, 1); assert.match(queries[0], /FROM household_settings WHERE household_id=\?/u);
    assert.equal(f.connection.prepare('SELECT total_changes() AS n').get().n, changes);
    f.connection.prepare('UPDATE household_settings SET frequency_mode=?').run('frequent');
    assert.equal((await readPersonalScheduleSettings(f.database)).frequencyMode, 'frequent');
  } finally { f.connection.close(); }
});

test('missing or damaged private schedule settings fail without substituting a plan or another account defaults', async () => {
  const valid = { frequency_mode: 'balanced', rest_days_json: '[6,7]', heavy_daily_limit: 1, normal_daily_limit: 2 };
  for (const row of [null, { ...valid, frequency_mode: 'invented' }, { ...valid, rest_days_json: 'broken' },
    { ...valid, rest_days_json: '[0]' }, { ...valid, heavy_daily_limit: -1 }, { ...valid, normal_daily_limit: 0.5 }]) {
    await assert.rejects(readPersonalScheduleSettings({ getFirstAsync: async () => row }));
  }
});
