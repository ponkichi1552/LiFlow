import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture, seeds } from './helpers/sharing-v2-repository-fixture.mjs';
import { fixture as planFixture } from './helpers/sharing-v2-plan-fixture.mjs';
const { initializeV2ReceiptTable, persistV2ServerReceiptsInside } = await import('../src/platform/storage/sharing-v2-receipts.ts');
const { planV2HistoryRetention } = await import('../src/features/sharing/v2/history-retention-plan.ts');

test('audit100 a hundred immutable server receipts use bounded SQLite batches and reject contradictory duplicates atomically', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeV2ReceiptTable(h.database);
  const receipts = Array.from({ length: 100 }, (_, n) => ({ schemaVersion: 2, groupId: 'group', operationId: `operation-${n}`, authorUserId: 'owner', authorDeviceId: 'device',
    receivedKeyVersion: 1, uploadSequence: n + 1, authorProofDigest: 'a'.repeat(64), receivedAtMs: 1000 }));
  let calls = 0; for (const name of ['getFirstAsync', 'getAllAsync', 'runAsync']) { const original = h.database[name]; h.database[name] = async (...args) => { calls++; return original(...args); }; }
  let changed; await h.database.withTransactionAsync(async () => { changed = await persistV2ServerReceiptsInside(h.database, 'group', receipts); });
  assert.equal(changed, true); assert.ok(calls <= 3, `receipt bridge calls: ${calls}`);
  await assert.rejects(h.database.withTransactionAsync(() => persistV2ServerReceiptsInside(h.database, 'group', [{ ...receipts[0], operationId: 'new' }, { ...receipts[1], receivedAtMs: 1001 }])));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM sharing_v2_server_receipts').get().n, 100);
});

test('audit100 reading authenticated shared state reuses the transaction receipt snapshot and avoids duplicated authority probes', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  let receiptReads = 0; let authority = 0;
  d.options.verifyCurrentAccess = async () => { authority++; };
  const read = d.database.getAllAsync;
  d.database.getAllAsync = async (sql, ...args) => { if (sql.startsWith('SELECT receipt_json FROM sharing_v2_server_receipts')) receiptReads++; return read(sql, ...args); };
  const state = await d.repository.readState();
  assert.equal(state.replica.operations.length, 4);
  assert.equal(receiptReads, 1, 'one transaction needs one exact receipt snapshot');
  assert.ok(authority <= 3, `authority probes without intervening work: ${authority}`);
  d.stopWrites(); await assert.rejects(d.repository.readState(), /account changed/u);
});

test('audit100 history retention identifies removed operations without rescanning the retained list for every fact', async () => {
  const f = await planFixture();
  for (let n = 0; n < 300; n++) f.make('chore', { name: `変更-${n}` }, { entityId: 'floor' });
  const state = f.state(); const includes = Array.prototype.includes; let comparisons = 0;
  Array.prototype.includes = function (value, ...rest) { if (value?.operationId && this[0]?.operationId) comparisons += this.length; return includes.call(this, value, ...rest); };
  try {
    const result = planV2HistoryRetention({ ...state, cutoff: '2026-10-01', throughSequence: 304 });
    assert.equal(result.retained.length, 304); assert.deepEqual(result.removedIds, []);
    assert.ok(comparisons < 1000, `retained-reference comparisons: ${comparisons}`);
  } finally { Array.prototype.includes = includes; }
});
