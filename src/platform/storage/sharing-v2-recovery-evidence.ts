import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';

export type RecoveryEvidencePart = 'record' | 'original' | 'quarantine' | 'receipt';
export interface V2RecoveryEvidenceProgress {
  read(witness: string, part: RecoveryEvidencePart, ids: readonly string[]): Promise<Map<string, unknown>>;
  save(witness: string, part: RecoveryEvidencePart, rows: readonly { id: string; value: unknown }[]): Promise<void>;
}

/** Staged proof is not a replica: this table cannot advance a cursor, outbox or business projection. */
export function createV2RecoveryEvidenceProgress(input: { database: SQLiteDatabase; scopeDigest: string; keyVersion: number;
  assertCurrentAccount(): void; serialized<T>(work: () => Promise<T>): Promise<T> }): V2RecoveryEvidenceProgress {
  if (!/^[a-f0-9]{64}$/u.test(input.scopeDigest) || !Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1) throw new Error('Invalid recovery evidence scope');
  const { database, assertCurrentAccount, scopeDigest, keyVersion } = input;
  async function inside<T>(work: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
    assertCurrentAccount();
    return input.serialized(() => withIsolatedSqliteTransaction(database, async db => {
      assertCurrentAccount();
      await db.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_recovery_evidence_cache (
        scope_digest TEXT NOT NULL, key_version INTEGER NOT NULL, witness_digest TEXT NOT NULL, part TEXT NOT NULL,
        entity_id TEXT NOT NULL, content_digest TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(scope_digest,key_version,witness_digest,part,entity_id)) WITHOUT ROWID;`);
      const value = await work(db); assertCurrentAccount(); return value;
    }));
  }
  function validate(witness: string, part: RecoveryEvidencePart, ids: readonly string[]) {
    if (!/^[a-f0-9]{64}$/u.test(witness) || !['record', 'original', 'quarantine', 'receipt'].includes(part) || ids.length > 30 || new Set(ids).size !== ids.length) throw new Error('Invalid recovery evidence batch');
    ids.forEach(assertSharedIdentifier);
  }
  return {
    read(witness, part, ids) {
      validate(witness, part, ids); if (!ids.length) return Promise.resolve(new Map());
      return inside(async db => {
        const rows = await db.getAllAsync<{ entity_id: string; content_digest: string; value_json: string }>(
          `SELECT entity_id,content_digest,value_json FROM sharing_v2_recovery_evidence_cache WHERE scope_digest=? AND key_version=? AND witness_digest=? AND part=? AND entity_id IN (${ids.map(() => '?').join(',')})`, scopeDigest, keyVersion, witness, part, ...ids);
        return new Map(rows.map(row => {
          if (row.value_json.length > 1_000_000) throw new Error('復旧証拠の保存内容を確認できません。');
          const value = JSON.parse(row.value_json);
          if (sharedDocumentDigest(value) !== row.content_digest) throw new Error('保存済みの復旧証拠が変わっています。原文を確認してください。');
          return [row.entity_id, value];
        }));
      });
    },
    save(witness, part, rows) {
      validate(witness, part, rows.map(row => row.id));
      const owned = rows.map(row => { const json = canonicalJson(row.value); if (json.length > 1_000_000) throw new Error('復旧証拠が上限を超えています。');
        return { id: row.id, json, digest: sharedDocumentDigest(row.value) }; });
      return inside(async db => {
        for (const row of owned) {
          const old = await db.getFirstAsync<{ content_digest: string }>('SELECT content_digest FROM sharing_v2_recovery_evidence_cache WHERE scope_digest=? AND key_version=? AND witness_digest=? AND part=? AND entity_id=?', scopeDigest, keyVersion, witness, part, row.id);
          if (old && old.content_digest !== row.digest) throw new Error('同じ復旧証拠の原文が変わっています。以前の内容は保持しています。');
          if (!old) await db.runAsync('INSERT INTO sharing_v2_recovery_evidence_cache VALUES(?,?,?,?,?,?,?)', scopeDigest, keyVersion, witness, part, row.id, row.digest, row.json);
        }
      });
    },
  };
}
