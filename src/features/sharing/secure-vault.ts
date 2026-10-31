import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export interface SecureKeyValueGateway {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
interface Manifest { version: 1; generation: string; chunks: number; bytes: number; digest: string }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CHUNK_CHARACTERS = 1000;
const MAX_VALUE_BYTES = 128 * 1024;

/** Firebase refresh credentials can exceed a single Keychain value. Every chunk stays in SecureStore. */
export function createSecureVault(gateway: SecureKeyValueGateway, randomBytes: (length: number) => Promise<Uint8Array>) {
  const tails = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = pending.then(() => undefined, () => undefined);
    tails.set(key, tail); void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return pending;
  }
  function name(key: string): string { return `liflow.sharing.${bytesToHex(sha256(encoder.encode(key)))}`; }
  async function manifest(base: string): Promise<Manifest | null> {
    const raw = await gateway.get(`${base}.manifest`);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Manifest;
    if (value.version !== 1 || !/^[a-f0-9]{32}$/u.test(value.generation)
      || !Number.isInteger(value.chunks) || value.chunks < 1 || value.chunks > Math.ceil(MAX_VALUE_BYTES * 2 / CHUNK_CHARACTERS)
      || !Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_VALUE_BYTES
      || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new Error('Secure storage manifest is invalid');
    return value;
  }
  async function clean(base: string, value: Manifest | null) {
    if (!value) return;
    await Promise.allSettled(Array.from({ length: value.chunks }, (_, i) => gateway.remove(`${base}.${value.generation}.${i}`)));
  }
  return {
    getItem(key: string): Promise<string | null> {
      return serial(key, async () => {
        const base = name(key); const info = await manifest(base);
        if (!info) return null;
        const chunks = await Promise.all(Array.from({ length: info.chunks }, (_, i) => gateway.get(`${base}.${info.generation}.${i}`)));
        for (const chunk of chunks) {
          if (chunk === null || !/^[0-9a-f]*$/u.test(chunk) || chunk.length > CHUNK_CHARACTERS) throw new Error('Secure storage is incomplete');
        }
        const hex = chunks.join('');
        if (hex.length !== info.bytes * 2) throw new Error('Secure storage length mismatch');
        const data = hexToBytes(hex);
        if (bytesToHex(sha256(data)) !== info.digest) throw new Error('Secure storage integrity check failed');
        return decoder.decode(data);
      });
    },
    setItem(key: string, value: string): Promise<void> {
      const data = encoder.encode(value);
      if (data.length > MAX_VALUE_BYTES) return Promise.reject(new Error('Secure storage value is too large'));
      return serial(key, async () => {
        const base = name(key); const previous = await manifest(base);
        const random = await randomBytes(16);
        if (random.length !== 16) throw new Error('Secure random source failed');
        const generation = bytesToHex(random);
        if (generation === previous?.generation) throw new Error('Secure storage generation reused');
        const hex = bytesToHex(data);
        const next: Manifest = { version: 1, generation, bytes: data.length,
          chunks: Math.max(1, Math.ceil(hex.length / CHUNK_CHARACTERS)), digest: bytesToHex(sha256(data)) };
        try {
          for (let i = 0; i < next.chunks; i++) await gateway.set(`${base}.${generation}.${i}`, hex.slice(i * CHUNK_CHARACTERS, (i + 1) * CHUNK_CHARACTERS));
          // Publish exactly one manifest after every new chunk has been durably written.
          await gateway.set(`${base}.manifest`, JSON.stringify(next));
        } catch (error) {
          // A native write can succeed before its response is lost. Never delete chunks
          // that a published manifest may already reference.
          let active: Manifest | null;
          try { active = await manifest(base); } catch { throw error; }
          if (active?.generation !== next.generation) { await clean(base, next); throw error; }
        }
        await clean(base, previous);
      });
    },
    removeItem(key: string): Promise<void> {
      return serial(key, async () => {
        const base = name(key); const previous = await manifest(base);
        await gateway.remove(`${base}.manifest`);
        await clean(base, previous);
      });
    },
  };
}
