import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createPlannerRefreshController } from '../src/features/planner/refresh-controller.ts';
const { readPersonalSettingsView } = await import('../src/platform/storage/personal-settings-view.ts');
const repository = await import('../src/platform/storage/repository.ts');

test('settings metadata matches the full planner with one read and no history replay or planning writes', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const full = await repository.loadPlannerSnapshot(h.database); const before = h.connection.prepare('SELECT total_changes() n').get().n;
  const queries = [];
  const view = await readPersonalSettingsView({ getAllAsync: async (sql, ...params) => {
    queries.push(sql); assert.doesNotMatch(sql, /completions|schedule_entries|adaptive_actions|google_/u);
    return h.database.getAllAsync(sql, ...params);
  } });
  assert.deepEqual(view, { settings: full.settings, chores: full.chores });
  assert.equal(queries.length, 1); assert.equal(h.connection.prepare('SELECT total_changes() n').get().n, before);
  h.connection.prepare('UPDATE chore_definitions SET enabled=0').run();
  assert.equal((await readPersonalSettingsView(h.database)).chores.every(chore => !chore.enabled), true);
});

test('native settings reads use an independent read-only WAL snapshot and never display an unfinished planner transaction', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-settings-view-')); const path = join(directory, 'private.db'); const a = createDatabase(path);
  t.after(() => { a.connection.close(); rmSync(directory, { recursive: true }); }); await repository.initializeLocalDatabase(a.database);
  let peers = 0;
  const port = { ...a.database, async withExclusiveTransactionAsync(work) {
    peers++; const b = createDatabase(path);
    try { await b.database.withTransactionAsync(() => work(b.database));
      assert.throws(() => b.connection.exec('UPDATE household_settings SET heavy_daily_limit=8'), /readonly/u);
    } finally { b.connection.close(); }
  } };
  const original = await readPersonalSettingsView(port);
  a.connection.exec("BEGIN; UPDATE household_settings SET frequency_mode='relaxed'; UPDATE chore_definitions SET enabled=0;");
  const during = await readPersonalSettingsView(port); assert.deepEqual(during, original);
  a.connection.exec('COMMIT'); const after = await readPersonalSettingsView(port);
  assert.equal(after.settings.frequencyMode, 'relaxed'); assert.equal(after.chores.every(chore => !chore.enabled), true);
  a.connection.exec("BEGIN; UPDATE household_settings SET frequency_mode='frequent';");
  assert.equal((await readPersonalSettingsView(port)).settings.frequencyMode, 'relaxed'); a.connection.exec('ROLLBACK');
  assert.deepEqual(await readPersonalSettingsView(port), after); assert.equal(peers, 5);
});

test('missing or damaged settings metadata fails without creating defaults or scheduling a chore', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  h.connection.exec("UPDATE chore_definitions SET definition_json='broken' WHERE rowid=(SELECT min(rowid) FROM chore_definitions)");
  const before = h.connection.prepare('SELECT total_changes() n').get().n;
  await assert.rejects(readPersonalSettingsView(h.database)); assert.equal(h.connection.prepare('SELECT total_changes() n').get().n, before);
  await assert.rejects(readPersonalSettingsView({ getAllAsync: async () => [] }), /個人設定/u);
});

for (const platform of ['ios', 'android']) test(`${platform} settings consumers share a metadata read while the full planner remains pending and refresh does not wait for replanning`, async () => {
  const database = {}; const effects = []; let reads = 0, planning = 0, finish, paint;
  const waiting = new Promise(resolve => { finish = resolve; }); const frame = new Promise(resolve => { paint = resolve; });
  const view = { settings: { frequencyMode: 'balanced' }, chores: [{ id: 'private', enabled: true }] };
  const planner = { database, snapshot: null, refresh: async () => { planning++; await new Promise(() => {}); } };
  const { usePersonalSettingsData } = loadNativeModule('src/hooks/use-personal-settings-data.tsx', {
    react: { useMemo: work => work(), useCallback: work => work, useEffect: work => effects.push(work), useSyncExternalStore: (_subscribe, read) => read() },
    './use-planner-data': { usePlannerData: options => { assert.deepEqual(options, { personal: true }); return planner; } },
    '../features/planner/refresh-controller': { createPlannerRefreshController },
    '../features/planner/initial-display-gate': { waitForInitialFrame: () => frame },
    '../platform/storage/personal-settings-view': { readPersonalSettingsView: async used => { assert.equal(used, database); reads++; await waiting; return view; } },
  });
  assert.equal(usePersonalSettingsData().snapshot, null); assert.equal(usePersonalSettingsData().snapshot, null);
  effects.splice(0).forEach(work => work()); await new Promise(setImmediate); assert.equal(reads, 1); assert.equal(planning, 0);
  finish(); await new Promise(setImmediate);
  let current = usePersonalSettingsData(); assert.deepEqual(current.snapshot.settings, view.settings); assert.deepEqual(current.snapshot.chores, view.chores);
  await current.refresh(); assert.equal(reads, 2); assert.equal(planning, 0, 'the current settings get a frame before full planning starts');
  paint(); await new Promise(setImmediate); assert.equal(planning, 1);
  current = usePersonalSettingsData(); assert.equal(current.error, null);
});
