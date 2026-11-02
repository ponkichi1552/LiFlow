import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { choreHistoryCutoff } from '../src/domain/chores/history-retention.ts';
const { initializeLocalDatabase, loadPlannerSnapshot } = await import('../src/platform/storage/repository.ts');

test('chore history uses one calendar month including month ends leap days and year boundaries', () => {
  for (const [today, cutoff] of [['2026-11-01', '2026-10-01'], ['2026-03-31', '2026-02-28'], ['2024-03-31', '2024-02-29'], ['2026-01-31', '2025-12-31']]) {
    assert.equal(choreHistoryCutoff(today), cutoff);
  }
});
test('expired personal completion history is physically deleted while its scheduling anchor and calendar events remain', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const initial = await loadPlannerSnapshot(h.database, '2026-11-01'); const chore = initial.chores[0];
  h.connection.prepare("INSERT INTO chore_completions(id,household_id,chore_id,completed_at,source,outcome) VALUES(?,?,?,?,?,?)")
    .run('expired', 'local-household', chore.id, new Date(2026, 8, 1, 12).toISOString(), 'app', 'completed');
  h.connection.prepare('UPDATE chore_state SET last_completed_date=?,last_completed_estimated=0,initial_pending=0 WHERE chore_id=?').run('2026-09-01', chore.id);
  h.connection.prepare('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,1,1)').run('old-calendar-event', '{}');
  const snapshot = await loadPlannerSnapshot(h.database, '2026-11-01');
  assert.equal(snapshot.completions.some(record => record.id === 'expired'), false);
  assert.equal(h.connection.prepare('SELECT id FROM chore_completions WHERE id=?').get('expired'), undefined);
  assert.equal(snapshot.states.find(row => row.choreId === chore.id).lastCompletedDate, '2026-09-01');
  assert.ok(h.connection.prepare('SELECT id FROM calendar_events WHERE id=?').get('old-calendar-event'));
});
test('the cutoff day is retained and an unchanged history refresh performs no repeated deletion writes', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const initial = await loadPlannerSnapshot(h.database, '2026-11-01'), chore = initial.chores[0];
  h.connection.prepare("INSERT INTO chore_completions(id,household_id,chore_id,completed_at,source,outcome) VALUES(?,?,?,?,?,?)")
    .run('boundary', 'local-household', chore.id, new Date(2026, 9, 1).toISOString(), 'app', 'incomplete');
  assert.ok((await loadPlannerSnapshot(h.database, '2026-11-01')).completions.some(record => record.id === 'boundary'));
  const before = h.writes.length; await loadPlannerSnapshot(h.database, '2026-11-01');
  assert.equal(h.writes.length, before);
});
