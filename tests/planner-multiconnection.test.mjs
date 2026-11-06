import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const today = '2026-10-24';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  const directory = mkdtempSync(join(tmpdir(), 'liflow-planner-connections-')); const path = join(directory, 'planner.db');
  const a = createDatabase(path); const b = createDatabase(path);
  t.after(() => { a.connection.close(); b.connection.close(); rmSync(directory, { recursive: true }); });
  await repository.initializeLocalDatabase(a.database);
  const first = await repository.loadPlannerSnapshot(a.database, today); const chore = first.chores[0];
  await repository.completeFirstSetup(a.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { date: '2026-10-01' } }, weatherLocation: null });
  const snapshot = await repository.loadPlannerSnapshot(a.database, today);
  await repository.initializeLocalDatabase(b.database);
  const entry = snapshot.scheduleEntries.find(row => row.choreId === chore.id);
  assert.ok(entry); return { a, b, chore, entry, snapshot };
}

for (const mutation of ['complete', 'undo', 'disable']) test(`independent SQLite connections never publish a stale plan after another connection commits ${mutation}`, async t => {
  const f = await fixture(t);
  let completion;
  if (mutation === 'undo') completion = await repository.completeChoreWithReceipt(f.b.database, f.entry);
  const captured = deferred(), release = deferred(); let held = false; let reads = 0;
  const getAll = f.a.database.getAllAsync;
  f.a.database.getAllAsync = async (sql, ...params) => {
    const rows = await getAll(sql, ...params);
    if (sql.includes('FROM chore_completions WHERE household_id = ? AND')) {
      reads++;
      if (!held) { held = true; captured.resolve(); await release.promise; }
    }
    return rows;
  };
  const pending = repository.loadPlannerSnapshot(f.a.database, today);
  try {
    await captured.promise;
    if (mutation === 'complete') completion = await repository.completeChoreWithReceipt(f.b.database, f.entry);
    if (mutation === 'undo') await repository.undoCompletionReceipt(f.b.database, completion);
    if (mutation === 'disable') await repository.setChoreEnabled(f.b.database, f.chore.id, false);
  } finally { release.resolve(); }
  const result = await pending;
  assert.ok(reads >= 2, 'the stale input must be re-read rather than committed');
  if (mutation === 'disable') {
    assert.equal(result.chores.find(row => row.id === f.chore.id).enabled, false);
    assert.equal(result.scheduleEntries.some(row => row.choreId === f.chore.id), false);
  } else assert.equal(result.completions.find(row => row.id === completion.id).outcome, mutation === 'undo' ? 'incomplete' : 'completed');
  assert.equal(repository.readCachedPlannerSnapshot(f.a.database), result);
  const stored = f.b.connection.prepare('SELECT entry_json FROM chore_schedule_entries ORDER BY id').all().map(row => JSON.parse(row.entry_json));
  assert.deepEqual(stored, [...result.scheduleEntries].sort((a, b) => a.id.localeCompare(b.id)));
});

test('late weather from one SQLite connection cannot erase a completion or rewrite another connections newer schedule', async t => {
  const f = await fixture(t);
  await repository.saveWeatherLocation(f.a.database, { region: '横浜市', displayName: '横浜市, 神奈川県', latitude: 35.44, longitude: 139.64 });
  const snapshot = await repository.loadPlannerSnapshot(f.a.database, today);
  const entered = deferred(), response = deferred();
  const weather = repository.applyWeatherToPlannerSnapshot(f.a.database, snapshot, () => true, async () => { entered.resolve(); return response.promise; });
  await entered.promise;
  const completion = await repository.completeChoreWithReceipt(f.b.database, f.entry); assert.ok(completion);
  const current = await repository.loadPlannerSnapshot(f.b.database, today);
  const stored = f.b.connection.prepare('SELECT entry_json FROM chore_schedule_entries ORDER BY id').all();
  response.resolve({ schedule: [], outcome: 'adjusted', adjustmentCount: 1 });
  assert.equal(await weather, null);
  assert.deepEqual(f.b.connection.prepare('SELECT entry_json FROM chore_schedule_entries ORDER BY id').all(), stored);
  assert.equal(current.completions.find(row => row.id === completion.id).outcome, 'completed');
});

test('a WAL commit after the planner version check rolls back the stale writer and retries from the new completion', async t => {
  const f = await fixture(t);
  // Force a derived write, then pause after the read snapshot has been opened.
  f.a.connection.exec('DELETE FROM chore_schedule_entries');
  const captured = deferred(), release = deferred(); let versionReads = 0;
  const getFirst = f.a.database.getFirstAsync;
  f.a.database.getFirstAsync = async (sql, ...params) => {
    const row = await getFirst(sql, ...params);
    if (sql === 'PRAGMA data_version' && ++versionReads === 2) { captured.resolve(); await release.promise; }
    return row;
  };
  const pending = repository.loadPlannerSnapshot(f.a.database, today);
  let completed;
  try { await captured.promise; completed = await repository.completeChoreWithReceipt(f.b.database, f.entry); }
  finally { release.resolve(); }
  const current = await pending;
  assert.ok(versionReads >= 4, 'the failed read-snapshot promotion must be retried');
  assert.equal(current.completions.find(row => row.id === completed.id).outcome, 'completed');
  const source = f.b.connection.prepare('SELECT adaptive_operation_id FROM chore_completions WHERE id=?').get(completed.id);
  assert.ok(source.adaptive_operation_id);
  assert.equal(f.b.connection.prepare("SELECT count(*) AS n FROM personal_adaptive_actions WHERE operation_id=? AND action_type='complete' AND completion_id=?")
    .get(source.adaptive_operation_id, completed.id).n, 1);
  assert.equal(f.b.connection.prepare('SELECT count(*) AS n FROM chore_schedule_entries').get().n, current.scheduleEntries.length);
});

test('the personal overlay reuses a verified cache but revalidates a background connections completion before recommending it', async t => {
  const f = await fixture(t);
  assert.equal((await repository.readPersonalPlannerOverlaySnapshot(f.a.database)).snapshot, f.snapshot);
  const completed = await repository.completeChoreWithReceipt(f.b.database, f.entry);
  const overlay = await repository.readPersonalPlannerOverlaySnapshot(f.a.database);
  assert.notEqual(overlay.snapshot, f.snapshot);
  assert.equal(overlay.snapshot.completions.find(row => row.id === completed.id).outcome, 'completed');
  assert.equal((await repository.readPersonalPlannerOverlaySnapshot(f.a.database)).snapshot, overlay.snapshot);
});

test('a reusable personal overlay still observes a completion committed by another native SQLite connection', async t => {
  const f = await fixture(t);
  assert.equal((await repository.readPersonalPlannerOverlaySnapshot(f.a.database, new Date())).snapshot, f.snapshot);
  const receipt = await repository.completeChoreWithReceipt(f.b.database, f.entry);
  const overlay = await repository.readPersonalPlannerOverlaySnapshot(f.a.database, new Date());
  assert.notEqual(overlay.snapshot, f.snapshot); assert.equal(overlay.snapshot.completions.find(row => row.id === receipt.id).outcome, 'completed');
});
