import type { SQLiteDatabase } from 'expo-sqlite';
import type { PrivateCalendarConnectionState } from '../../features/sharing/private-calendar/connection-code.ts';
import { snapshotConnectionState } from '../../features/sharing/private-calendar/connection-code.ts';
import { exactRecord, positiveInteger } from '../../features/sharing/private-calendar/validation.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';

/** Bearer codes stay in the encrypted vault, under the existing process-safe UID lock. */
export function createPrivateCalendarConnectionStorage(port: { ownerUserId: string; assertOwner(userId: string): void | Promise<void>;
  vault: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  exclusive<T>(userId: string, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> }) {
  const uid = port.ownerUserId; assertSharedIdentifier(uid);
  const key = `private-calendar-connections:${uid}`;
  async function readLocked() {
    await port.assertOwner(uid); const text = await port.vault.getItem(key); await port.assertOwner(uid);
    if (text === null) return { revision: 0, state: { issued: null, joining: null } as PrivateCalendarConnectionState };
    if (text.length > 32_000) throw new Error('保存した接続コードを確認できません。');
    const raw = JSON.parse(text); exactRecord(raw, ['schemaVersion', 'revision', 'state']); positiveInteger(raw.revision);
    if (raw.schemaVersion !== 1) throw new Error('保存した接続コードの形式が異なります。');
    return { revision: raw.revision as number, state: snapshotConnectionState(raw.state as PrivateCalendarConnectionState, uid) };
  }
  return {
    async read() { await port.assertOwner(uid); const value = await port.exclusive(uid, readLocked); await port.assertOwner(uid); return value; },
    async save(expectedRevision: number, state: PrivateCalendarConnectionState) {
      const owned = snapshotConnectionState(state, uid); await port.assertOwner(uid);
      const value = await port.exclusive(uid, async () => {
        const before = await readLocked(); if (before.revision !== expectedRevision || before.revision >= Number.MAX_SAFE_INTEGER) throw new Error('接続処理が更新されています。再試行してください。');
        const value = { schemaVersion: 1, revision: before.revision + 1, state: owned };
        await port.assertOwner(uid); await port.vault.setItem(key, JSON.stringify(value)); await port.assertOwner(uid);
        return { revision: value.revision, state: owned };
      }); await port.assertOwner(uid); return value;
    },
  };
}
