import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { withIsolatedSqliteTransaction } from '../../../src/platform/storage/isolated-transaction';
import { bindAdaptiveOwnerReader, readAdaptiveOwnerInputs, withAdaptiveOwnerInputScope } from '../../../src/platform/storage/adaptive-owner-inputs';

/** Only run in a separately installed, empty test application. No Planner database is opened. */
export default function ConnectionsAuditApp() {
  const [report, setReport] = useState('Running independent-connection audit');
  useEffect(() => { void audit().then(value => setReport(JSON.stringify(value))); }, []);
  return <ScrollView style={{ backgroundColor: 'white' }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 64 }}>
    <Text accessibilityLabel="SQLite JS connection audit result" accessibilityValue={{ text: report }} style={{ color: 'black' }} selectable>{report}</Text>
  </ScrollView>;
}

async function audit() {
  const name = `isolated-js-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const checks: string[] = [];
  const connections: SQLite.SQLiteDatabase[] = [];
  let stage = 'open';
  let failure: string | null = null;
  let cleaned = false;
  let sqliteVersion: string | undefined;
  const require = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  const busy = async (work: Promise<unknown>) => {
    try { await work; } catch (cause) {
      require(cause instanceof Error && /SQLITE_BUSY|database is locked|database table is locked|Error code:?\s*5\b/i.test(cause.message), 'wrong-busy-rejection');
      return;
    }
    throw new Error('concurrent-write-was-accepted');
  };
  try {
    const a = await SQLite.openDatabaseAsync(name, { useNewConnection: true }); connections.push(a);
    const b = await SQLite.openDatabaseAsync(name, { useNewConnection: true }); connections.push(b);
    require(a !== b, 'same-js-connection');
    sqliteVersion = (await a.getFirstAsync<{ version: string }>('SELECT sqlite_version() AS version'))?.version;
    await a.execAsync('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO rows VALUES(1,1)');
    await b.execAsync('PRAGMA busy_timeout=0');
    stage = 'external-commit';
    const before = await b.getFirstAsync<{ data_version: number }>('PRAGMA data_version');
    await a.runAsync('UPDATE rows SET value=2 WHERE id=1');
    const after = await b.getFirstAsync<{ data_version: number }>('PRAGMA data_version');
    require(before?.data_version !== after?.data_version && (await b.getFirstAsync<{ value: number }>('SELECT value FROM rows WHERE id=1'))?.value === 2, 'external-commit-not-observed');
    checks.push(stage);

    stage = 'uncommitted-async-overlap';
    await a.execAsync('BEGIN IMMEDIATE');
    try {
      await a.runAsync('INSERT INTO rows VALUES(2,2)');
      const [row] = await Promise.all([b.getFirstAsync('SELECT id FROM rows WHERE id=2'), busy(b.runAsync('INSERT INTO rows VALUES(3,3)'))]);
      require(row === null, 'uncommitted-write-visible');
    } finally { await a.execAsync('ROLLBACK'); }
    require((await b.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM rows'))?.count === 1, 'overlap-changed-state');
    checks.push(stage);

    stage = 'stale-wal-snapshot';
    await b.execAsync('BEGIN');
    try {
      require((await b.getFirstAsync<{ value: number }>('SELECT value FROM rows WHERE id=1'))?.value === 2, 'snapshot-read');
      await a.runAsync('UPDATE rows SET value=3 WHERE id=1');
      await busy(b.runAsync('UPDATE rows SET value=4 WHERE id=1'));
    } finally { await b.execAsync('ROLLBACK'); }
    require((await b.getFirstAsync<{ value: number }>('SELECT value FROM rows WHERE id=1'))?.value === 3, 'stale-snapshot-overwrote-commit');
    checks.push(stage);

    stage = 'readonly-peer';
    await b.execAsync('PRAGMA query_only=ON');
    try {
      let rejected = false;
      try { await b.runAsync('INSERT INTO rows VALUES(4,4)'); }
      catch (cause) { require(cause instanceof Error && /SQLITE_READONLY|readonly database|read-only database|Error code:?\s*8\b/i.test(cause.message), 'wrong-readonly-rejection'); rejected = true; }
      require(rejected, 'readonly-write-accepted');
      await a.runAsync('UPDATE rows SET value=5 WHERE id=1');
      require((await b.getFirstAsync<{ value: number }>('SELECT value FROM rows WHERE id=1'))?.value === 5, 'readonly-peer-blocked-writer');
    } finally { await b.execAsync('PRAGMA query_only=OFF'); }
    checks.push(stage);

    stage = 'native-exclusive-wrapper-rollback';
    const rollback = new Error('intentional-audit-rollback');
    let callbackConnectionIndependent = false;
    try {
      await withIsolatedSqliteTransaction(a, async tx => {
        callbackConnectionIndependent = tx !== a && tx !== b;
        await tx.runAsync('INSERT INTO rows VALUES(5,5)');
        const [aRow, bRow] = await Promise.all([a.getFirstAsync('SELECT id FROM rows WHERE id=5'), b.getFirstAsync('SELECT id FROM rows WHERE id=5'), busy(b.runAsync('INSERT INTO rows VALUES(6,6)'))]);
        require(aRow === null && bRow === null, 'exclusive-write-leaked');
        throw rollback;
      });
      throw new Error('rollback-was-swallowed');
    } catch (cause) { require(cause === rollback, 'wrong-exclusive-error'); }
    require(callbackConnectionIndependent && (await a.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM rows'))?.count === 1, 'exclusive-rollback-failed');
    checks.push(stage);

    stage = 'captured-owner-final-fence';
    let current = true;
    const revoked = new Error('audit-input-revoked');
    const unbind = bindAdaptiveOwnerReader(a, async () => ({ ownerUserId: null, preferences: null, common: null,
      assertCurrent: () => { if (!current) throw revoked; } }));
    try {
      try {
        await withAdaptiveOwnerInputScope(a, async () => {
          await readAdaptiveOwnerInputs(a, new Date());
          await withIsolatedSqliteTransaction(a, async tx => { await tx.runAsync('INSERT INTO rows VALUES(7,7)'); current = false; });
        });
        throw new Error('final-owner-fence-missed');
      } catch (cause) { require(cause === revoked, 'wrong-owner-fence-error'); }
    } finally { unbind(); }
    require((await b.getFirstAsync('SELECT id FROM rows WHERE id=7')) === null, 'revoked-write-committed');
    await a.runAsync('UPDATE rows SET value=6 WHERE id=1');
    require((await b.getFirstAsync<{ value: number }>('SELECT value FROM rows WHERE id=1'))?.value === 6, 'connection-not-reusable');
    checks.push(stage);
  } catch (cause) { failure = cause instanceof Error ? cause.message : 'unknown-audit-error'; }
  finally {
    const closed = await Promise.allSettled(connections.map(value => value.closeAsync()));
    if (closed.some(value => value.status !== 'fulfilled')) failure ??= 'connection-close-failed';
    try { await SQLite.deleteDatabaseAsync(name); cleaned = true; } catch { failure ??= 'disposable-cleanup-failed'; }
  }
  const result = { result: failure ? 'NOT_PASS' : 'PASS', platform: Platform.OS, sqliteVersion,
    hermes: Boolean((globalThis as { HermesInternal?: unknown }).HermesInternal), checks, stage, failure, cleaned, existingDatabaseOpened: false };
  console.info('[LiFlow SQLite JS audit]', JSON.stringify(result));
  return result;
}
