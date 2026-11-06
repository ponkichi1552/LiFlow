import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';

export interface SecureKeyValueGateway {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
interface Manifest { version: 1 | 2; generation: string; chunks: number; bytes: number; digest: string }
interface Cleanup { version: 1; values: Manifest[]; removed: string | null }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CHUNK_CHARACTERS = 1000;
const MAX_VALUE_BYTES = 128 * 1024;

/** Finish every native call before reporting failure: cleanup must never race an unfinished write. */
async function nativeBatch<T>(count: number, operation: (index: number) => Promise<T>): Promise<T[]> {
  const values = new Array<T>(count); let next = 0; const failures: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(4, count) }, async () => {
    while (next < count) {
      const index = next++;
      try { values[index] = await operation(index); } catch (error) {
        failures.push(error instanceof Error ? error : new Error('Secure storage operation failed', { cause: error }));
      }
    }
  }));
  if (failures.length) throw failures[0];
  return values;
}
function parseManifest(value: Manifest): Manifest {
  const encodedLength = value?.version === 1 ? value.bytes * 2 : 4 * Math.ceil(value?.bytes / 3);
  if (!value || ![1, 2].includes(value.version) || !/^[a-f0-9]{32}$/u.test(value.generation)
    || !Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_VALUE_BYTES
    || !Number.isInteger(value.chunks) || value.chunks !== Math.max(1, Math.ceil(encodedLength / CHUNK_CHARACTERS))
    || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new Error('Secure storage manifest is invalid');
  return value;
}

/** Firebase refresh credentials can exceed a single Keychain value. All chunks and cleanup metadata stay protected. */
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
    return raw === null ? null : parseManifest(JSON.parse(raw));
  }
  async function cleanup(base: string): Promise<Cleanup | null> {
    const raw = await gateway.get(`${base}.cleanup`);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Cleanup;
    if (!value || value.version !== 1 || !Array.isArray(value.values) || value.values.length < 1 || value.values.length > 2
      || !(value.removed === null || typeof value.removed === 'string' && /^[a-f0-9]{32}$/u.test(value.removed))) throw new Error('Secure storage cleanup is invalid');
    value.values.forEach(parseManifest);
    if (new Set(value.values.map(item => item.generation)).size !== value.values.length
      || value.removed !== null && !value.values.some(item => item.generation === value.removed)) throw new Error('Secure storage cleanup is invalid');
    return value;
  }
  async function writeMetadata(key: string, value: unknown) {
    const raw = JSON.stringify(value);
    try { await gateway.set(key, raw); }
    catch (error) { if (await gateway.get(key) !== raw) throw error; }
  }
  async function removeConfirmed(key: string) {
    try { await gateway.remove(key); }
    catch (error) { if (await gateway.get(key) !== null) throw error; }
  }
  async function sweep(base: string, pending: Cleanup | null, active: Manifest | null) {
    if (!pending) return { active, error: null as unknown };
    try {
      if (pending.removed === active?.generation) {
        await removeConfirmed(`${base}.manifest`); active = null;
      }
      const obsolete = pending.values.filter(value => value.generation !== active?.generation);
      const keys = obsolete.flatMap(value => Array.from({ length: value.chunks }, (_, i) => `${base}.${value.generation}.${i}`));
      await nativeBatch(keys.length, index => removeConfirmed(keys[index]));
      await removeConfirmed(`${base}.cleanup`);
      return { active, error: null as unknown };
    } catch (error) {
      return { active, error: error instanceof Error ? error : new Error('Secure storage cleanup failed', { cause: error }) };
    }
  }
  return {
    getItem(key: string): Promise<string | null> {
      return serial(key, async () => {
        const base = name(key); const pending = await cleanup(base);
        const { active: info } = await sweep(base, pending, await manifest(base));
        // A durable deletion marker denies access even while a native removal is failing.
        if (!info || info.generation === pending?.removed) return null;
        const chunks = await nativeBatch(info.chunks, i => gateway.get(`${base}.${info.generation}.${i}`));
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk === null || chunk.length > CHUNK_CHARACTERS
            || i < chunks.length - 1 && chunk.length !== CHUNK_CHARACTERS
            || !(info.version === 1 ? /^[0-9a-f]*$/u : /^[A-Za-z0-9+/=]*$/u).test(chunk)) throw new Error('Secure storage is incomplete');
        }
        const encoded = chunks.join('');
        let data: Uint8Array;
        if (info.version === 1) {
          if (encoded.length !== info.bytes * 2) throw new Error('Secure storage length mismatch');
          data = hexToBytes(encoded);
        } else {
          if (encoded.length !== 4 * Math.ceil(info.bytes / 3)) throw new Error('Secure storage length mismatch');
          data = toByteArray(encoded);
          if (fromByteArray(data) !== encoded) throw new Error('Secure storage encoding is invalid');
        }
        if (data.length !== info.bytes || bytesToHex(sha256(data)) !== info.digest) throw new Error('Secure storage integrity check failed');
        return decoder.decode(data);
      });
    },
    setItem(key: string, value: string): Promise<void> {
      const data = encoder.encode(value);
      if (data.length > MAX_VALUE_BYTES) return Promise.reject(new Error('Secure storage value is too large'));
      return serial(key, async () => {
        const base = name(key);
        const recovered = await sweep(base, await cleanup(base), await manifest(base));
        if (recovered.error) throw recovered.error;
        const previous = recovered.active;
        const random = await randomBytes(16);
        if (random.length !== 16) throw new Error('Secure random source failed');
        const generation = bytesToHex(random);
        if (generation === previous?.generation) throw new Error('Secure storage generation reused');
        const encoded = fromByteArray(data);
        const next: Manifest = { version: 2, generation, bytes: data.length,
          chunks: Math.max(1, Math.ceil(encoded.length / CHUNK_CHARACTERS)), digest: bytesToHex(sha256(data)) };
        const pending: Cleanup = { version: 1, values: previous ? [previous, next] : [next], removed: null };
        // Journal before writing chunks. A crash at any later point retains every generation's location.
        await writeMetadata(`${base}.cleanup`, pending);
        try {
          await nativeBatch(next.chunks, i => gateway.set(`${base}.${generation}.${i}`, encoded.slice(i * CHUNK_CHARACTERS, (i + 1) * CHUNK_CHARACTERS)));
          await writeMetadata(`${base}.manifest`, next);
        } catch (error) {
          let active: Manifest | null;
          try { active = await manifest(base); } catch { throw error; }
          if (active?.generation !== next.generation) { await sweep(base, pending, active); throw error; }
        }
        // Once published, the save is committed. Failed obsolete cleanup stays journaled for the next access.
        await sweep(base, pending, next);
      });
    },
    removeItem(key: string): Promise<void> {
      return serial(key, async () => {
        const base = name(key); const active = await manifest(base); const outstanding = await cleanup(base);
        if (!active && !outstanding) return;
        const values = [...(outstanding?.values ?? [])];
        if (active && !values.some(value => value.generation === active.generation)) values.push(active);
        const pending: Cleanup = { version: 1, values, removed: active?.generation ?? outstanding?.removed ?? null };
        await writeMetadata(`${base}.cleanup`, pending);
        const result = await sweep(base, pending, active);
        if (result.error) throw result.error;
      });
    },
  };
}
