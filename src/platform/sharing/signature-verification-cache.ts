import type { SQLiteDatabase } from 'expo-sqlite';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { signatureVerificationCache } from '../../features/sharing/signature-verification-cache.ts';
import { nativeSharingCrypto } from './native-crypto.ts';
import { sharingSecureVault } from './secure-store.ts';
import { withIsolatedSqliteTransaction } from '../storage/isolated-transaction.ts';

let initialization: Promise<void> | undefined;
/** A device-only authenticated memo of signature digests. Never a saved permission or business state. */
export function initializeNativeSignatureCache(database: SQLiteDatabase): Promise<void> {
  if (!initialization) {
    const pending = (async () => {
      await database.execAsync('CREATE TABLE IF NOT EXISTS sharing_signature_memo (singleton INTEGER PRIMARY KEY CHECK(singleton=1), encrypted_json TEXT NOT NULL)');
      let keyPromise: Promise<Uint8Array | null> | undefined;
      const key = (create: boolean): Promise<Uint8Array | null> => {
        if (keyPromise) return keyPromise;
        const task = (async () => {
          const name = 'signature-verification-key:v1';
          const saved = await sharingSecureVault.getItem(name);
          if (saved !== null) return /^[a-f0-9]{64}$/u.test(saved) ? hexToBytes(saved) : null;
          if (!create) return null;
          const generated = await nativeSharingCrypto.randomBytes(32); if (generated.length !== 32) return null;
          await sharingSecureVault.setItem(name, bytesToHex(generated)); return generated;
        })(); keyPromise = task;
        void task.finally(() => { if (keyPromise === task) keyPromise = undefined; }).catch(() => undefined);
        return task;
      };
      await signatureVerificationCache.initialize({ crypto: nativeSharingCrypto, key,
        read: async () => (await database.getFirstAsync<{ encrypted_json: string }>('SELECT encrypted_json FROM sharing_signature_memo WHERE singleton=1'))?.encrypted_json ?? null,
        write: value => withIsolatedSqliteTransaction(database, async tx => {
          await tx.runAsync('INSERT INTO sharing_signature_memo VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET encrypted_json=excluded.encrypted_json', value);
        }),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      signatureVerificationCache.subscribe(() => {
        if (timer) return;
        timer = setTimeout(() => { timer = undefined; void signatureVerificationCache.flush(); }, 1000);
      });
      // Verifications may have completed before the protected storage was ready.
      void signatureVerificationCache.flush();
    })(); initialization = pending;
    void pending.catch(() => { if (initialization === pending) initialization = undefined; });
  }
  // An optional memo must never prevent ordinary cryptographic verification.
  return initialization.catch(() => undefined);
}
