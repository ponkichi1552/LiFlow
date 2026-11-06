import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
const { migrateLocalDatabase } = await import('../src/platform/storage/migrations.ts');
const { createPersonalChoreDefinitions, personalChoreHistoryPolicy } = await import('../src/domain/chores/personal-catalog.ts');
const { adaptivePersonalDigest: fingerprint } = await import('../src/features/planner/adaptive-digest.ts');
const store = await import('../src/platform/storage/personal-seasonal-chores.ts');
async function fixture() {
  const h = createDatabase(); await migrateLocalDatabase(h.database);
  const definition = createPersonalChoreDefinitions('household').find(chore => personalChoreHistoryPolicy(chore, 'balanced').kind === 'seasonal');
  assert.ok(definition); let region = 'nationalFallback'; let today = '2026-01-01'; let number = 0;
  const context = (change = {}) => ({ chore: { ...definition, enabled: true }, region, today, now: `${today}T12:00:00Z`, fingerprint, assertInputsCurrent() {}, ...change });
  const read = () => store.readPersonalSeasonalInside(h.database, definition.id);
  const inside = async callback => { let result; await h.database.withTransactionAsync(async () => { result = await callback(); }); return result; };
  const sync = (change) => inside(() => store.synchronizePersonalSeasonalInside(h.database, context(change)));
  const apply = (operation, change) => inside(() => store.applyPersonalSeasonalInside(h.database, context(change), operation));
  const complete = async (work, date) => {
    const current = await read(); const round = current.state.pending[work]; today = date;
    const operation = { type: 'complete', operationId: `op-${++number}`, recordedAt: `${date}T12:00:00Z`, completionId: `done-${number}`,
      roundId: round.id, date, timeZone: 'UTC', origin: 'personal' };
    return { operation, receipt: await apply(operation), view: await read() };
  };
  return { ...h, definition, context, sync, read, apply, complete, inside, region(value) { region = value; }, date(value) { today = value; } };
}

test('seasonal SQLite initialization publishes actual stable work-specific rounds and render or date passage creates no new history or duplicate rounds', async () => {
  const h = await fixture();
  try {
    const initial = await h.sync(); assert.equal(Object.keys(initial.state.pending).length, 2);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_actions').get().n, 0);
    const before = h.connection.serialize(); h.date('2027-01-01'); assert.deepEqual(await h.sync(), initial);
    assert.deepEqual(h.connection.serialize(), before);
    const entries = store.personalSeasonalEntries(h.context().chore, await h.read(), h.context().today, ['self']);
    assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.status === 'overdue' && entry.windowStart === entry.windowEnd));
  } finally { h.connection.close(); }
});

test('a late winter-storage completion and exact receipt replay never complete autumn or repeat the next yearly round', async () => {
  const h = await fixture();
  try {
    const initial = await h.sync(); const result = await h.complete('winterStorage', '2026-08-01');
    assert.equal(result.view.state.pending.winterStorage.date, '2027-05-15');
    assert.deepEqual(result.view.state.pending.summerStorage, initial.state.pending.summerStorage);
    const before = h.connection.serialize(); assert.deepEqual(await h.apply(result.operation), result.receipt); assert.deepEqual(h.connection.serialize(), before);
    assert.equal(h.connection.prepare("SELECT count(*) n FROM personal_adaptive_actions WHERE action_type='complete'").get().n, 1);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_adaptive_forecasts').get().n, 0);
  } finally { h.connection.close(); }
});

test('seasonal Undo restores its own pending work without rolling back a later autumn completion or later region setting', async () => {
  const h = await fixture();
  try {
    const initial = await h.sync(); const spring = await h.complete('winterStorage', '2026-08-01');
    const autumn = await h.complete('summerStorage', '2026-10-15');
    h.region('hokkaido'); await h.sync();
    const before = await h.read(); const undo = { type: 'undo', operationId: 'undo-spring', recordedAt: h.context().now,
      completionId: spring.operation.completionId, targetOperationId: spring.operation.operationId };
    await h.apply(undo); const after = await h.read();
    assert.equal(after.state.pending.winterStorage.id, initial.state.pending.winterStorage.id);
    assert.equal(after.state.region, 'hokkaido'); assert.deepEqual(after.state.pending.summerStorage, before.state.pending.summerStorage);
    assert.equal(after.state.pending.summerStorage.id, autumn.view.state.pending.summerStorage.id);
    assert.equal((await h.apply({ ...undo, operationId: 'undo-spring-again' })).kind, 'alreadyUndone');
  } finally { h.connection.close(); }
});

test('cancelling an older seasonal completion keeps a later same-work real completion and its next rule date', async () => {
  const h = await fixture();
  try {
    await h.sync(); const a = await h.complete('winterStorage', '2026-08-01'); const b = await h.complete('winterStorage', '2027-05-15');
    await h.apply({ type: 'undo', operationId: 'undo-old', recordedAt: h.context().now, completionId: a.operation.completionId, targetOperationId: a.operation.operationId });
    assert.deepEqual((await h.read()).state.pending.winterStorage, b.view.state.pending.winterStorage);
    const action = JSON.parse(h.connection.prepare('SELECT event_json FROM personal_adaptive_actions WHERE operation_id=?').get(b.operation.operationId).event_json);
    assert.equal(action.recordedAt, b.operation.recordedAt); assert.equal(action.timeZone, 'UTC');
  } finally { h.connection.close(); }
});

test('a failed seasonal final journal write rolls back both pending work states and immutable plan publication', async () => {
  const h = await fixture();
  try {
    await h.sync(); const before = h.connection.serialize(); const run = h.database.runAsync;
    h.database.runAsync = async (sql, ...args) => { if (sql.includes('INSERT INTO personal_adaptive_actions')) throw new Error('disk full'); return run(sql, ...args); };
    await assert.rejects(h.complete('winterStorage', '2026-08-01'), /disk full/); assert.deepEqual(h.connection.serialize(), before);
  } finally { h.connection.close(); }
});
