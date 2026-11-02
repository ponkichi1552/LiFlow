import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from './operations.ts';

const encoder = new TextEncoder();
const digests = new Map<string, string>();
const maximumContentBytes = 8 * 1024 * 1024;
const maximumEntryBytes = 2 * 1024 * 1024;
let contentBytes = 0;
const weight = (text: string) => text.length * 2 + 256;

/** Reuse pure SHA-256 arithmetic, never validation, identity or authority. */
export function sharedContentDigest(value: unknown): string {
  // Always canonicalize again: caller-owned objects may have been mutated.
  const text = canonicalJson(value);
  const cached = digests.get(text);
  if (cached !== undefined) { digests.delete(text); digests.set(text, cached); return cached; }
  const digest = bytesToHex(sha256(encoder.encode(text)));
  const size = weight(text);
  // A large snapshot must not evict the whole cache or remain resident here.
  if (size > maximumEntryBytes) return digest;
  while (digests.size >= 4096 || contentBytes + size > maximumContentBytes) {
    const oldest = digests.keys().next().value!;
    digests.delete(oldest); contentBytes -= weight(oldest);
  }
  digests.set(text, digest); contentBytes += size;
  return digest;
}
