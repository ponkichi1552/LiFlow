import type { SQLiteDatabase } from 'expo-sqlite';
import { assertSharedIdentifier, canonicalJson } from '../../features/sharing/operations.ts';
import { sharedRosterDigest, validateSharedRoster } from '../../features/sharing/roster.ts';
import type { SignedSharedRoster } from '../../features/sharing/roster.ts';
import type { WrappedGroupKey } from '../../features/sharing/crypto.ts';
import type { SharedInvitationPin, SharedJoinRequest, SignedSharedInvitation } from '../../features/sharing/invitations.ts';

export type SharingWorkspaceStatus = 'creating' | 'joining' | 'active' | 'left' | 'removed';
export interface SharingWorkspaceRecord {
  userId: string;
  groupId: string;
  displayName: string;
  status: SharingWorkspaceStatus;
  anchor: SignedSharedRoster | SharedInvitationPin;
  rosterArchive: SignedSharedRoster[];
  createdAt: string;
  lastSuccessfulSyncAt: number | null;
  lastErrorCode: string | null;
  /** A new approval uses a fresh database/key pair; earlier offline edits remain archived locally. */
  localGeneration?: string;
  archivedLocalGenerations?: string[];
  /** Separate database generation; upgrading the protocol never changes an approved device identity. */
  v2Migration?: { databaseGeneration: string; sourceSnapshotDigest: string; witnessDigest: string };
  creation?: { timeZone: string; anchorDate: string; ownerDisplayName: string; wrappedKey: WrappedGroupKey; kind?: 'family' | 'roommates' };
  join?: { invitation: SignedSharedInvitation; request: SharedJoinRequest };
}
const tails = new WeakMap<SQLiteDatabase, Promise<unknown>>();
function serial<T>(database: SQLiteDatabase, operation: () => Promise<T>): Promise<T> {
  const next = (tails.get(database) ?? Promise.resolve()).then(operation, operation);
  const tail = next.then(() => undefined, () => undefined); tails.set(database, tail);
  void tail.then(() => { if (tails.get(database) === tail) tails.delete(database); }); return next;
}
function validate(record: SharingWorkspaceRecord): SharingWorkspaceRecord {
  assertSharedIdentifier(record.userId); assertSharedIdentifier(record.groupId);
  if (record.localGeneration) assertSharedIdentifier(record.localGeneration);
  if (record.v2Migration) {
    assertSharedIdentifier(record.v2Migration.databaseGeneration);
    if (!/^[a-f0-9]{64}$/u.test(record.v2Migration.sourceSnapshotDigest) || !/^[a-f0-9]{64}$/u.test(record.v2Migration.witnessDigest)) throw new Error('Invalid migration pin');
  }
  if (record.archivedLocalGenerations) {
    if (!Array.isArray(record.archivedLocalGenerations) || record.archivedLocalGenerations.length > 512) throw new Error('Too many archived workspace generations');
    for (const generation of record.archivedLocalGenerations) assertSharedIdentifier(generation);
  }
  if (record.creation?.kind !== undefined && !['family', 'roommates'].includes(record.creation.kind)) throw new Error('Invalid group creation kind');
  if (!record.displayName.trim() || record.displayName.length > 500 || !['creating', 'joining', 'active', 'left', 'removed'].includes(record.status)
    || !Number.isFinite(Date.parse(record.createdAt)) || !Array.isArray(record.rosterArchive) || record.rosterArchive.length > 4096) throw new Error('Invalid sharing workspace');
  if ('body' in record.anchor) {
    if (validateSharedRoster(record.anchor).body.groupId !== record.groupId) throw new Error('Workspace pin group mismatch');
  } else if (record.anchor.groupId !== record.groupId) throw new Error('Workspace invitation group mismatch');
  // The whitelist encoder refuses OAuth credentials, group keys and device secret keys.
  return JSON.parse(canonicalJson(record)) as SharingWorkspaceRecord;
}
function anchorDigest(anchor: SharingWorkspaceRecord['anchor']): string {
  return 'body' in anchor ? sharedRosterDigest(anchor) : anchor.digest;
}

export function initializeSharingRegistry(database: SQLiteDatabase): Promise<void> {
  return serial(database, () => database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sharing_workspaces (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(user_id, group_id)
    );
    CREATE TABLE IF NOT EXISTS sharing_current_workspace (
      user_id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT
    );
  `));
}

/** Historical rows are retained, but only this one membership may be opened or synchronized. */
export function readCurrentSharingWorkspace(database: SQLiteDatabase, userId: string, previousGroupId?: string): Promise<SharingWorkspaceRecord | null> {
  assertSharedIdentifier(userId);
  return serial(database, async () => {
    let current = await database.getFirstAsync<{ group_id: string | null }>('SELECT group_id FROM sharing_current_workspace WHERE user_id = ?', userId);
    if (!current) {
      const rows = await database.getAllAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ?', userId);
      const eligible = rows.map(row => validate(JSON.parse(row.record_json))).filter(row => !['left', 'removed'].includes(row.status));
      const prior = eligible.find(row => row.groupId === previousGroupId);
      if (!prior && eligible.length > 1) throw new Error('以前の検査用グループの表示情報を確認できません。保存データは保持しています。');
      const groupId = prior?.groupId ?? eligible[0]?.groupId ?? null;
      await database.runAsync('INSERT OR IGNORE INTO sharing_current_workspace (user_id, group_id) VALUES (?, ?)', userId, groupId);
      current = await database.getFirstAsync<{ group_id: string | null }>('SELECT group_id FROM sharing_current_workspace WHERE user_id = ?', userId);
    }
    if (!current?.group_id) return null;
    const stored = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', userId, current.group_id);
    if (!stored) throw new Error('所属グループの保存情報を読み込めません。');
    const record = validate(JSON.parse(stored.record_json));
    if (record.userId !== userId || record.groupId !== current.group_id) throw new Error('Stored workspace identity mismatch');
    return ['left', 'removed'].includes(record.status) ? null : record;
  });
}

async function claimCurrentWorkspace(database: SQLiteDatabase, record: SharingWorkspaceRecord) {
  if (['left', 'removed'].includes(record.status)) return;
  await database.runAsync('INSERT OR IGNORE INTO sharing_current_workspace (user_id, group_id) VALUES (?, NULL)', record.userId);
  const result = await database.runAsync('UPDATE sharing_current_workspace SET group_id = ? WHERE user_id = ? AND (group_id IS NULL OR group_id = ?)', record.groupId, record.userId, record.groupId);
  if (!result.changes) throw new Error('参加または申請できるグループは一つです。現在のグループから退出するか、申請を取り消してください。');
}

export function listSharingWorkspaces(database: SQLiteDatabase, userId: string): Promise<SharingWorkspaceRecord[]> {
  assertSharedIdentifier(userId);
  return serial(database, async () => (await database.getAllAsync<{ group_id: string; record_json: string }>(
    'SELECT group_id, record_json FROM sharing_workspaces WHERE user_id = ? ORDER BY group_id', userId,
  )).map((row) => {
    const record = validate(JSON.parse(row.record_json));
    if (record.userId !== userId || record.groupId !== row.group_id) throw new Error('Stored workspace identity mismatch');
    return record;
  }));
}

export function readSharingWorkspace(database: SQLiteDatabase, userId: string, groupId: string): Promise<SharingWorkspaceRecord | null> {
  assertSharedIdentifier(userId); assertSharedIdentifier(groupId);
  return serial(database, async () => {
    const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', userId, groupId);
    const record = row ? validate(JSON.parse(row.record_json)) : null;
    if (record && (record.userId !== userId || record.groupId !== groupId)) throw new Error('Stored workspace identity mismatch');
    return record;
  });
}

export function saveSharingWorkspace(database: SQLiteDatabase, input: SharingWorkspaceRecord): Promise<void> {
  const record = validate(input);
  return serial(database, async () => {
    await database.withTransactionAsync(async () => {
    await claimCurrentWorkspace(database, record);
    await database.runAsync('INSERT OR IGNORE INTO sharing_workspaces (user_id, group_id, record_json) VALUES (?, ?, ?)', record.userId, record.groupId, canonicalJson(record));
    const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', record.userId, record.groupId);
    const stored = row ? validate(JSON.parse(row.record_json)) : null;
    if (!stored || anchorDigest(stored.anchor) !== anchorDigest(record.anchor)) throw new Error('A cloud response cannot replace a locally trusted group pin');
    });
  });
}

/** Changes read the latest row inside the queue, so a late sync result cannot restore a departed workspace. */
export function updateSharingWorkspace(database: SQLiteDatabase, userId: string, groupId: string,
  change: (current: SharingWorkspaceRecord) => SharingWorkspaceRecord): Promise<SharingWorkspaceRecord> {
  return serial(database, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', userId, groupId);
      if (!row) throw new Error('共有グループが見つかりません。');
      const old = validate(JSON.parse(row.record_json)); const previousPin = anchorDigest(old.anchor); const previousStatus = old.status; const previousGeneration = old.localGeneration;
      const previousMigration = canonicalJson(old.v2Migration ?? null);
      const next = validate(change(old));
      if (next.userId !== userId || next.groupId !== groupId || anchorDigest(next.anchor) !== previousPin) throw new Error('Workspace identity or pin cannot change');
      if (previousMigration !== 'null' && next.localGeneration === previousGeneration && canonicalJson(next.v2Migration ?? null) !== previousMigration) throw new Error('Verified migration pin cannot change');
      if (['left', 'removed'].includes(previousStatus) && next.status === 'active') throw new Error('Explicitly request group approval before rejoining');
      if (next.localGeneration !== previousGeneration && (!['left', 'removed'].includes(previousStatus) || next.status !== 'joining'
        || !next.localGeneration || !next.archivedLocalGenerations?.includes(previousGeneration ?? 'initial'))) throw new Error('Rejoining must preserve the previous local workspace');
      let changed = false;
      const write = async () => {
        const result = await database.runAsync('UPDATE sharing_workspaces SET record_json = ? WHERE user_id = ? AND group_id = ? AND record_json = ?',
          canonicalJson(next), userId, groupId, row.record_json);
        changed = result.changes === 1;
      };
      const departed = (record: SharingWorkspaceRecord) => ['left', 'removed'].includes(record.status);
      if (departed(old) === departed(next)) await write();
      else await database.withTransactionAsync(async () => {
        await claimCurrentWorkspace(database, next); await write();
        if (changed && departed(next)) await database.runAsync('UPDATE sharing_current_workspace SET group_id = NULL WHERE user_id = ? AND group_id = ?', userId, groupId);
      });
      if (changed) return next;
    }
    throw new Error('共有状態の更新が重なりました。もう一度お試しください。');
  });
}
