import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';

export const MAX_MANUAL_BYTES = 6 * 1024 * 1024;
export const MANUAL_CHUNK_BYTES = 96 * 1024;
export interface ManualDocument { sha256: string; byteLength: number; chunks: string[] }
export interface ManualChunk { sha256: string; content: string }
export interface SavedManual { document: ManualDocument; chunks: ManualChunk[] }
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
// Verified immutable bytes are reused during later ledger assessments. Both caches are bounded.
const checkedChunks = new Map<string, string>(); let checkedChars = 0;
const assembled = new Map<string, { manifest: string; content: string }>(); let assembledChars = 0;
const CACHE_CHAR_LIMIT = 12 * 1024 * 1024;

/** Strict, bounded, canonical base64. Neither a path nor a remote URL is accepted. */
export function decodeManualBytes(value: unknown, maxBytes = MAX_MANUAL_BYTES): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 || /[^A-Za-z0-9+/=]/u.test(value)) throw new Error('説明書PDFのデータを確認できません。');
  const bytes = toByteArray(value);
  if (bytes.length > maxBytes || fromByteArray(bytes) !== value) throw new Error('説明書PDFのデータを確認できません。');
  return bytes;
}
export function encodeManualBytes(bytes: Uint8Array): string {
  return fromByteArray(bytes);
}
export function validateManualChunk(value: unknown, entityId?: string): asserts value is ManualChunk {
  const data = value as ManualChunk;
  if (!data || Object.keys(data).sort().join(',') !== 'content,sha256' || !hex(data.sha256)
    || entityId !== undefined && entityId !== `manual-chunk.${data.sha256}`) throw new Error('説明書の一部が一致しません。');
  if (checkedChunks.get(data.sha256) === data.content) return;
  if (hash(decodeManualBytes(data.content, MANUAL_CHUNK_BYTES)) !== data.sha256) throw new Error('説明書の一部が一致しません。');
  checkedChunks.set(data.sha256, data.content); checkedChars += data.content.length;
  while (checkedChars > CACHE_CHAR_LIMIT) { const id = checkedChunks.keys().next().value!; checkedChars -= checkedChunks.get(id)!.length; checkedChunks.delete(id); }
}
export function validateManualDocument(value: unknown, entityId?: string): asserts value is ManualDocument {
  const data = value as ManualDocument;
  if (!data || Object.keys(data).sort().join(',') !== 'byteLength,chunks,sha256' || !hex(data.sha256)
    || entityId !== undefined && entityId !== `manual.${data.sha256}` || !Number.isSafeInteger(data.byteLength) || data.byteLength < 32 || data.byteLength > MAX_MANUAL_BYTES
    || !Array.isArray(data.chunks) || data.chunks.length !== Math.ceil(data.byteLength / MANUAL_CHUNK_BYTES) || !data.chunks.every(hex)) throw new Error('説明書PDFの保存情報を確認できません。');
}
/** Local storage needs only verified bytes and identity, not derived network chunks. */
export function verifyManualContent(base64: string, expectedDigest?: string) {
  const bytes = decodeManualBytes(base64);
  if (bytes.length < 32 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('説明書はPDFを選択してください。');
  const digest = hash(bytes);
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('解析したPDFと保存するPDFが一致しません。');
  return { bytes, sha256: digest, byteLength: bytes.length };
}
export function prepareManualDocument(base64: string, expectedDigest?: string): SavedManual {
  const { bytes, sha256: digest } = verifyManualContent(base64, expectedDigest);
  const chunks: ManualChunk[] = [];
  for (let start = 0; start < bytes.length; start += MANUAL_CHUNK_BYTES) {
    const part = bytes.subarray(start, start + MANUAL_CHUNK_BYTES); chunks.push({ sha256: hash(part), content: encodeManualBytes(part) });
  }
  return { document: { sha256: digest, byteLength: bytes.length, chunks: chunks.map(chunk => chunk.sha256) }, chunks };
}
/** Only a fully assembled digest-checked PDF is ever exposed to a native viewer. */
export function restoreManualDocument(document: ManualDocument, readChunk: (digest: string) => ManualChunk | undefined): string | null {
  validateManualDocument(document);
  const manifest = JSON.stringify([document.sha256, document.byteLength, document.chunks]); const cached = assembled.get(document.sha256);
  if (cached?.manifest === manifest) {
    for (const digest of document.chunks) { const chunk = readChunk(digest); if (!chunk) return null; validateManualChunk(chunk); if (chunk.sha256 !== digest) throw new Error('説明書の一部が一致しません。'); }
    return cached.content;
  }
  const bytes = new Uint8Array(document.byteLength); let offset = 0;
  for (const [index, digest] of document.chunks.entries()) {
    const chunk = readChunk(digest); if (!chunk) return null; validateManualChunk(chunk);
    if (chunk.sha256 !== digest) throw new Error('説明書の一部が一致しません。');
    const part = decodeManualBytes(chunk.content, MANUAL_CHUNK_BYTES);
    if (part.length !== Math.min(MANUAL_CHUNK_BYTES, bytes.length - offset) || index < document.chunks.length - 1 && part.length !== MANUAL_CHUNK_BYTES) throw new Error('説明書PDFが途中で切れています。');
    bytes.set(part, offset); offset += part.length;
  }
  if (offset !== bytes.length || hash(bytes) !== document.sha256 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('説明書PDFの整合性を確認できません。');
  const content = encodeManualBytes(bytes);
  if (cached) assembledChars -= cached.content.length;
  assembled.delete(document.sha256); assembled.set(document.sha256, { manifest, content }); assembledChars += content.length;
  while (assembledChars > CACHE_CHAR_LIMIT) { const id = assembled.keys().next().value!; assembledChars -= assembled.get(id)!.content.length; assembled.delete(id); }
  return content;
}
