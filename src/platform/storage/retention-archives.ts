import type { SQLiteDatabase } from 'expo-sqlite';
import type { VerifiedSharedSnapshot } from '../../features/sharing/snapshots';
import { verifyKnownLegacyHistory } from '../../features/sharing/v2/live-legacy-migration.ts';
import { assertV2RetentionBase } from '../../features/sharing/v2/history-retention-certificate.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster';

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
    await verifyKnownLegacyHistory(db, input.groupId, input.snapshot); await input.assertAccess(); verified = true;
  } finally { await db.closeAsync(); }
  if (verified) { await input.assertAccess(); await input.remove(); }
}
