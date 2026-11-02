import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { SharingCryptoGateway } from './crypto';

// Bump whenever the verifier's acceptance policy or implementation changes.
// These are mathematical verification results, never membership/authorization.
export const SIGNATURE_CACHE_POLICY = 'liflow-signature-memo:noble-curves-2.4.0:noble-hashes-2.4.0:ed25519:zip215-false:v1';
const maximumEntries = 1024;
const maximumPlaintext = 400 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = (text: string) => bytesToHex(sha256(encoder.encode(text)));
const hex = (value: unknown, size: number): value is string => typeof value === 'string' && value.length === size * 2 && /^[a-f0-9]+$/u.test(value);
type Row = [publicKey: string, signature: string, digest: string];
interface Storage {
  crypto: SharingCryptoGateway;
  key(create: boolean): Promise<Uint8Array | null>;
  read(): Promise<string | null>;
  write(encrypted: string): Promise<void>;
}

/** Only the protected local adapter may initialize this memo. No import of plain verification claims. */
export function createSignatureVerificationCache() {
  const entries = new Map<string, Row>();
  const listeners = new Set<() => void>();
  let storage: Storage | undefined;
  let initialized: Promise<void> | undefined;
  let saving: Promise<void> | undefined;
  let revision = 0, savedRevision = 0;
  const insert = (row: Row) => {
    const key = `${row[0]}:${row[1]}`;
    entries.delete(key); entries.set(key, row);
    while (entries.size > maximumEntries) entries.delete(entries.keys().next().value!);
  };
  async function restore(port: Storage) {
    try {
      const [raw, key] = await Promise.all([port.read(), port.key(false)]);
      if (!raw || raw.length > 1024 * 1024 || !key || key.length !== 32) return;
      const envelope = JSON.parse(raw);
      if (Object.keys(envelope).sort().join(',') !== 'ciphertext,nonce,policy' || envelope.policy !== SIGNATURE_CACHE_POLICY
        || !hex(envelope.nonce, 12) || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > (maximumPlaintext + 16) * 2
        || envelope.ciphertext.length < 32 || envelope.ciphertext.length % 2 || !/^[a-f0-9]+$/u.test(envelope.ciphertext)) return;
      const plaintext = await port.crypto.decrypt(key, hexToBytes(envelope.nonce), hexToBytes(envelope.ciphertext), encoder.encode(SIGNATURE_CACHE_POLICY));
      if (plaintext.length > maximumPlaintext) return;
      const rows: unknown = JSON.parse(decoder.decode(plaintext));
      if (!Array.isArray(rows) || rows.length > maximumEntries) return;
      const keys = new Set<string>(); const validated: Row[] = [];
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 3 || !hex(row[0], 32) || !hex(row[1], 64) || !hex(row[2], 32)) return;
        const id = `${row[0]}:${row[1]}`; if (keys.has(id)) return; keys.add(id);
        const current = entries.get(id); if (current && current[2] !== row[2]) return;
        validated.push([row[0], row[1], row[2]]);
      }
      // Never replace facts verified while the asynchronous restore was pending.
      const current = [...entries.values()];
      for (const row of validated) insert(row);
      for (const row of current) insert(row);
    } catch { /* A missing, locked, outdated or modified memo falls back to Ed25519. */ }
  }
  return {
    initialize(port: Storage): Promise<void> {
      if (!initialized) { storage = port; initialized = restore(port); }
      return initialized;
    },
    has(publicKey: string, signature: string, text: string): boolean {
      const row = entries.get(`${publicKey}:${signature}`);
      if (!row || row[2] !== digest(text)) return false;
      insert(row); return true;
    },
    /** Call only after the strict verifier has accepted these exact bytes. */
    rememberVerified(publicKey: string, signature: string, text: string) {
      if (!hex(publicKey, 32) || !hex(signature, 64)) throw new Error('Invalid verified signature encoding');
      const value = digest(text); const previous = entries.get(`${publicKey}:${signature}`);
      if (previous?.[2] === value) { insert(previous); return; }
      insert([publicKey, signature, value]); revision++;
      for (const listener of listeners) try { listener(); } catch { /* Persistence is optional. */ }
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush(): Promise<void> {
      if (saving) return saving;
      const pending = (async () => {
        await initialized;
        const port = storage; if (!port) return;
        while (savedRevision !== revision) {
          const current = revision;
          try {
            const plaintext = encoder.encode(JSON.stringify([...entries.values()]));
            if (plaintext.length > maximumPlaintext) return;
            const key = await port.key(true); if (!key || key.length !== 32) return;
            const nonce = await port.crypto.randomBytes(12); if (nonce.length !== 12) return;
            const encrypted = await port.crypto.encrypt(key, nonce, plaintext, encoder.encode(SIGNATURE_CACHE_POLICY));
            await port.write(JSON.stringify({ policy: SIGNATURE_CACHE_POLICY, nonce: bytesToHex(nonce), ciphertext: bytesToHex(encrypted) }));
            savedRevision = current;
          } catch { return; /* Storage failure cannot turn a valid signature into a failed user operation. */ }
        }
      })(); saving = pending;
      void pending.finally(() => { if (saving === pending) saving = undefined; }).catch(() => undefined);
      return pending;
    },
  };
}

export const signatureVerificationCache = createSignatureVerificationCache();
