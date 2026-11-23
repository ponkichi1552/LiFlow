import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';
import type { SignedWorkspaceCopy } from '../../features/sharing/v2/workspace-copy-source.ts';
import { withSharingLedgerTransaction } from './sharing-ledger.ts';

export function stageSharingWorkspaceCopy(db: SQLiteDatabase, groupId: string, copy: SignedWorkspaceCopy) {
  return withSharingLedgerTransaction(db, async transaction => {
    if (copy.body.destination.groupId !== groupId) throw new Error('引き継ぎ先が一致しません。');
    const payload = canonicalJson(copy);
    await transaction.execAsync('CREATE TABLE IF NOT EXISTS sharing_workspace_copy_draft (group_id TEXT PRIMARY KEY, signed_json TEXT NOT NULL)');
    await transaction.runAsync('INSERT OR IGNORE INTO sharing_workspace_copy_draft VALUES (?,?)', groupId, payload);
    const saved = await transaction.getFirstAsync<{ signed_json: string }>('SELECT signed_json FROM sharing_workspace_copy_draft WHERE group_id=?', groupId);
    if (saved?.signed_json !== payload) throw new Error('別の引き継ぎデータが保存されています。');
  });
}

export function readSharingWorkspaceCopy(db: SQLiteDatabase, groupId: string, options: { publishedOnly?: boolean } = {}) {
  return withSharingLedgerTransaction(db, async transaction => {
    const saved = await transaction.getFirstAsync<{ copy: string | null }>(`SELECT json_extract(snapshot_json,'$.workspaceCopy') AS copy
      FROM sharing_snapshot_state WHERE group_id=?`, groupId);
    if (saved?.copy) return JSON.parse(saved.copy) as SignedWorkspaceCopy;
    if (options.publishedOnly || !await transaction.getFirstAsync(`SELECT 1 FROM sqlite_master WHERE name='sharing_workspace_copy_draft' AND type='table'`)) return null;
    const staged = await transaction.getFirstAsync<{ signed_json: string }>('SELECT signed_json FROM sharing_workspace_copy_draft WHERE group_id=?', groupId);
    return staged ? JSON.parse(staged.signed_json) as SignedWorkspaceCopy : null;
  });
}

export function discardPublishedWorkspaceCopyDraft(db: SQLiteDatabase, groupId: string, copy: SignedWorkspaceCopy) {
  return withSharingLedgerTransaction(db, async transaction => {
    if (!await transaction.getFirstAsync(`SELECT 1 FROM sqlite_master WHERE name='sharing_workspace_copy_draft' AND type='table'`)) return;
    const published = await transaction.getFirstAsync<{ digest: string }>(`SELECT json_extract(snapshot_json,'$.workspaceCopy.body.contentDigest') AS digest
      FROM sharing_snapshot_state WHERE group_id=?`, groupId);
    if (published?.digest === copy.body.contentDigest) await transaction.runAsync('DELETE FROM sharing_workspace_copy_draft WHERE group_id=?', groupId);
  });
}
