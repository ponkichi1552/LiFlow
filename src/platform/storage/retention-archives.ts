import type { SQLiteDatabase } from 'expo-sqlite';
import type { VerifiedSharedSnapshot } from '../../features/sharing/snapshots';
import { verifyKnownLegacyHistory } from '../../features/sharing/v2/live-legacy-migration.ts';
import { assertV2RetentionBase } from '../../features/sharing/v2/history-retention-certificate.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster';

const certifiedScopeTables = new Set([
  'sharing_operations', 'sharing_snapshot_state', 'sharing_cursors', 'sharing_v2_binding',
  'sharing_v2_server_receipts', 'sharing_workspace_metadata',
]);
const derivedTables = new Set(['personal_planning_input_revision', 'sharing_v2_projection', 'sqlite_sequence']);

async function containsUnverifiedArchiveState(database: SQLiteDatabase, groupId: string) {
  const tables = await database.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  // A certificate covers one group's shared ledger. Keep populated tables we cannot verify or regenerate.
  for (const { name } of tables) {
    if (derivedTables.has(name)) continue;
    if (name === 'calendar_notification_settings') {
      if (await database.getFirstAsync('SELECT 1 FROM calendar_notification_settings WHERE enabled IS NOT 0 LIMIT 1')) return true;
      continue;
    }
    if (certifiedScopeTables.has(name)) {
      if (await database.getFirstAsync(`SELECT 1 FROM "${name}" WHERE group_id IS NOT ? LIMIT 1`, groupId)) return true;
      continue;
    }
    const table = `"${name.replaceAll('"', '""')}"`;
    if (await database.getFirstAsync(`SELECT 1 FROM main.${table} LIMIT 1`)) return true;
  }
  return false;
}

/** Remove a duplicate legacy archive only after its entire causal index is in the accepted v2 checkpoint. */
export async function removeRetainedLegacyArchive(input: { snapshot: VerifiedSharedSnapshot; groupId: string;
  archive: readonly VerifiedSharedRoster[];
  open(): Promise<SQLiteDatabase>; exists(): Promise<boolean>; remove(): Promise<void>; assertAccess(): Promise<void> }) {
  if (!input.snapshot.base.retention || input.snapshot.base.groupId !== input.groupId) throw new Error('A verified retention checkpoint is required');
  assertV2RetentionBase(input.snapshot.base, input.snapshot.base.retention, input.archive);
  await input.assertAccess(); if (!await input.exists()) return;
  const db = await input.open(); let verified = false;
  try {
    const ledger = await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='sharing_operations'");
    if (!ledger) throw new Error('旧データの保存範囲を確認できません。');
    await verifyKnownLegacyHistory(db, input.groupId, input.snapshot);
    if (await containsUnverifiedArchiveState(db, input.groupId)) return;
    await input.assertAccess(); verified = true;
  } finally { await db.closeAsync(); }
  if (verified) { await input.assertAccess(); await input.remove(); }
}
