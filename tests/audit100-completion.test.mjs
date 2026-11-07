import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionIntents } from '../src/features/planner/completion-intents.ts';
import { createPlannerRefreshController } from '../src/features/planner/refresh-controller.ts';
import { groupHistoryByDay } from '../src/features/planner/history-groups.ts';
import { createDatabase } from './helpers/sqlite.mjs';

const { createWidgetCompletionSync } = await import('../src/features/widgets/widget-completion-sync.ts');
const { appendCompletionUndoInside, seedCompletionJournalInside } = await import('../src/platform/storage/completion-journal.ts');

const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('audit100 completion cleanup can retry a failed protected acknowledgement without repeating the saved work', async () => {
  let saved = [], failCleanup = true, applies = 0;
  const q = createCompletionIntents({
    store: { load: async () => saved, save: async rows => {
      if (!rows.length && failCleanup) throw new Error('Keychain temporarily unavailable');
      saved = structuredClone(rows);
    } }, capture: target => ({ ...target }), makeId: () => 'operation-one', now: () => new Date('2026-11-07T01:00:00Z'),
    isCurrent: () => true, apply: async () => { applies++; }, refresh: async () => {},
  });
  await q.activate(); q.request('bath', { chore: 'bath' }, true); await tick(); await q.settled();
  assert.equal(applies, 1); assert.match(q.getSnapshot().error, /保存済み/u);
  failCleanup = false; q.retryRead(); await tick(); await q.settled();
  assert.equal(applies, 1); assert.deepEqual(saved, []); assert.equal(q.getSnapshot().error, null);
});

test('audit100 a failed planner subscriber cannot block another screen the initial read or widget publication', async () => {
  let observed = 0, published = 0;
  const controller = createPlannerRefreshController({ load: async () => ({ snapshot: { chores: ['bath'] }, canPublishWidget: true }),
    weather: async () => null, publish: () => { published++; } });
  controller.subscribe(() => { throw new Error('view listener failed'); });
  controller.subscribe(() => { observed++; });
  await assert.doesNotReject(controller.refresh());
  assert.equal(observed, 1); assert.equal(published, 1); assert.equal(controller.getSnapshot().error, null);
  await controller.waitForInitialRead();
});

test('audit100 completion history orders offset timestamps by the actual instant within a saved civil day', () => {
  const older = { id: 'old', date: '2026-11-07', timestamp: '2026-11-07T11:00:00+09:00' };
  const newer = { id: 'new', date: '2026-11-07', timestamp: '2026-11-07T06:00:00Z' };
  const result = groupHistoryByDay([older, newer], value => value);
  assert.deepEqual(result[0].records.map(row => row.id), ['new', 'old']);
});

test('audit100 recovering a hundred widget inputs indexes schedule and exact completion lookup once', async () => {
  let entryReads = 0, historyReads = 0, loads = 0; const written = [];
  const entries = Array.from({ length: 1000 }, (_, i) => ({ get id() { entryReads++; return `entry-${i}`; }, choreId: `chore-${i}`,
    windowStart: '2026-11-07', windowEnd: '2026-11-07', suggestedDate: '2026-11-07' }));
  const completions = entries.slice(0, 900).map((entry, i) => ({ id: `done-${i}`, get choreId() { historyReads++; return `chore-${i}`; },
    outcome: 'completed', scheduleEntryId: `entry-${i}` }));
  entryReads = 0;
  const sync = createWidgetCompletionSync({ pendingIds: async () => Array.from({ length: 100 }, (_, i) => `entry-${i + 900}`),
    load: async () => { loads++; return { scheduleEntries: entries, completions }; },
    complete: async entry => { written.push(entry.id); return true; }, publish: () => {} });
  const result = await sync();
  assert.equal(written.length, 100); assert.equal(loads, 2); assert.equal(result.canPublishWidget, true);
  assert.ok(entryReads < 4000, `schedule property reads: ${entryReads}`);
  assert.ok(historyReads < 4000, `completion property reads: ${historyReads}`);
});

function journalDatabase() {
  const h = createDatabase();
  h.connection.exec(`CREATE TABLE chore_completions(id TEXT PRIMARY KEY,chore_id TEXT,completed_at TEXT,completed_local_date TEXT,
    completed_time_zone TEXT,scheduled_date TEXT,scheduled_window_start TEXT,previous_chore_state_json TEXT,source TEXT,schedule_entry_id TEXT);
    CREATE TABLE chore_completion_actions(sequence INTEGER PRIMARY KEY,operation_id TEXT UNIQUE,completion_id TEXT,chore_id TEXT,action TEXT,
    target_sequence INTEGER,previous_action_sequence INTEGER,completed_at TEXT,completed_local_date TEXT,time_zone TEXT,
    scheduled_date TEXT,scheduled_window_start TEXT,previous_chore_state_json TEXT,source TEXT,origin TEXT);`);
  return h;
}

test('audit100 the completion journal freezes legacy and Undo days in their recorded region', async t => {
  const h = journalDatabase(); t.after(() => h.connection.close());
  h.connection.prepare('INSERT INTO chore_completions(id,chore_id,completed_at,completed_time_zone,source) VALUES(?,?,?,?,?)')
    .run('legacy', 'bath', '2026-11-07T03:00:00Z', 'Pacific/Honolulu', 'inApp');
  await seedCompletionJournalInside(h.database, 'bath', 'Asia/Tokyo');
  const legacy = h.connection.prepare('SELECT * FROM chore_completion_actions').get();
  assert.equal(legacy.completed_local_date, '2026-11-06');
  await appendCompletionUndoInside(h.database, 'undo', { ...legacy, origin: 'personal' }, 'bath', 'Pacific/Honolulu', '2026-11-07T03:30:00Z', 'inApp');
  assert.equal(h.connection.prepare("SELECT completed_local_date FROM chore_completion_actions WHERE action='undo'").get().completed_local_date, '2026-11-06');
});

test('audit100 seeding a long completion journal batches SQL while retaining every original fact', async t => {
  const h = journalDatabase(); t.after(() => h.connection.close());
  const insert = h.connection.prepare('INSERT INTO chore_completions(id,chore_id,completed_at,completed_local_date,completed_time_zone,source) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 500; i++) insert.run(`old-${i}`, 'bath', '2026-11-07T03:00:00Z', '2026-11-07', 'Asia/Tokyo', 'inApp');
  await seedCompletionJournalInside(h.database, 'bath', 'Asia/Tokyo');
  assert.equal(h.connection.prepare('SELECT count(*) AS n FROM chore_completion_actions').get().n, 500);
  assert.ok(h.writes.length <= 10, `SQL bridge writes: ${h.writes.length}`);
  assert.ok(h.writes.every(row => row.params.length <= 999), 'Android API29 bind parameter compatibility');
  const before = h.writes.length; await seedCompletionJournalInside(h.database, 'bath', 'Asia/Tokyo'); assert.equal(h.writes.length, before);
});
