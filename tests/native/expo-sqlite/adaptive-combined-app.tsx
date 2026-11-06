import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { combinedScenarioProof, runCombinedAdaptiveScenario } from './adaptive-combined-scenario';

/** Standalone test entry only. It is never imported by the LiFlow Router. */
export default function AdaptiveCombinedAuditApp() {
  const [report, setReport] = useState('Running disposable adaptive audit');
  useEffect(() => { void audit().then(result => setReport(JSON.stringify(result))); }, []);
  return <ScrollView style={{ backgroundColor: 'white' }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 64 }}>
    <Text accessibilityLabel="Adaptive combined audit result" accessibilityValue={{ text: report }} style={{ color: 'black' }} selectable>{report}</Text>
  </ScrollView>;
}

async function audit() {
  const name = `adaptive-native-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  let database: SQLite.SQLiteDatabase | undefined; let cleaned = false; let failure: string | null = null;
  let report: Awaited<ReturnType<typeof runCombinedAdaptiveScenario>> | undefined;
  let sqliteVersion: string | undefined; let durableRestart = false;
  const started = Date.now();
  try {
    database = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
    await database.execAsync('PRAGMA journal_mode=WAL');
    sqliteVersion = (await database.getFirstAsync<{ version: string }>('SELECT sqlite_version() AS version'))?.version;
    report = await runCombinedAdaptiveScenario(database);
    await database.closeAsync(); database = undefined;
    database = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
    durableRestart = JSON.stringify(await combinedScenarioProof(database)) === JSON.stringify(report.proof);
    if (!durableRestart) throw new Error('durable-reopen-lost-model-plan-or-history');
  } catch (cause) { failure = cause instanceof Error ? cause.message : 'unknown-adaptive-audit-error'; }
  finally {
    try { await database?.closeAsync(); } catch { failure ??= 'test-connection-close-failed'; }
    try { await SQLite.deleteDatabaseAsync(name); cleaned = true; } catch { failure ??= 'test-database-cleanup-failed'; }
  }
  return { ...report, result: failure ? 'NOT_PASS' : 'PASS', platform: Platform.OS,
    hermes: Boolean((globalThis as { HermesInternal?: unknown }).HermesInternal), sqliteVersion, durableRestart,
    cleaned, existingDatabaseOpened: false, elapsedMs: Date.now() - started, failure };
}
