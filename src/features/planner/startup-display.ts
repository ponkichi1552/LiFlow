import type { SharingCryptoGateway } from '../sharing/crypto';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry';
import type { V2GroupUiSession } from '../sharing/v2-ui/screen-session';
import { sharedLocalDate } from '../sharing/group-clock.ts';
import { hexToBytes } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';

type Model = Awaited<ReturnType<V2GroupUiSession['readModel']>>;
// Earlier saved plans lack the automatic-backlog target and can queue a
// checkbox against a newer missed slot before the authenticated refresh.
const VERSION = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function decodeHex(value: string, maximum: number) {
  if (typeof value !== 'string' || value.length > maximum * 2 || value.length % 2 || !/^[a-f0-9]+$/u.test(value)) throw new Error('Invalid local display');
  return hexToBytes(value);
}
function base64Length(value: string, maximum: number) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
    || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error('Invalid local display');
  const length = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (length > maximum) throw new Error('Invalid local display'); return length;
}
function decodeBytes(value: string, maximum: number, encoding?: string) {
  if (encoding === undefined) return decodeHex(value, maximum);
  if (encoding !== 'base64') throw new Error('Invalid local display');
  base64Length(value, maximum); return toByteArray(value);
}

/** This receipt identifies a saved display, never a permission to read or mutate a repository. */
export function startupDisplayScope(record: SharingWorkspaceRecord): string {
  return sharedDocumentDigest({ version: VERSION, userId: record.userId, groupId: record.groupId,
    historyRetention: record.historyRetention ?? null,
    generation: record.localGeneration ?? null, status: record.status, anchor: record.anchor, archive: record.rosterArchive });
}

/** Encrypted, device-local presentation only. The real session still verifies every operation. */
export function createStartupDisplayCache(input: {
  crypto: SharingCryptoGateway;
  read(userId: string, groupId: string): Promise<string | null>;
  write(userId: string, groupId: string, value: string): Promise<void>;
  key(userId: string, create: boolean): Promise<Uint8Array | null>;
  decryptBase64?(key: Uint8Array, nonce: string, ciphertextWithTag: string, aad: Uint8Array): Promise<Uint8Array>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async read(record: SharingWorkspaceRecord): Promise<Model | undefined> {
      if (record.status !== 'active') return;
      try {
        const [raw, key] = await Promise.all([input.read(record.userId, record.groupId), input.key(record.userId, false)]);
        if (!raw || !key || key.length !== 32 || raw.length > MAX_BYTES * 3) return;
        const envelope = JSON.parse(raw);
        if (envelope.version !== VERSION || envelope.scope !== startupDisplayScope(record)) return;
        const aad = encoder.encode(envelope.scope);
        let plaintext: Uint8Array;
        if (envelope.encoding === 'base64' && input.decryptBase64) {
          // Expo accepts base64 directly. Validate limits before crossing to native,
          // without allocating and converting the entire saved display on the JS thread.
          if (base64Length(envelope.nonce, 12) !== 12 || base64Length(envelope.ciphertext, MAX_BYTES + 16) < 16) return;
          plaintext = await input.decryptBase64(key, envelope.nonce, envelope.ciphertext, aad);
        } else {
          plaintext = await input.crypto.decrypt(key, decodeBytes(envelope.nonce, 12, envelope.encoding), decodeBytes(envelope.ciphertext, MAX_BYTES + 16, envelope.encoding), aad);
        }
        if (plaintext.length > MAX_BYTES) return;
        const { savedAt, model } = JSON.parse(decoder.decode(plaintext));
        if (!Number.isFinite(savedAt) || now().getTime() < savedAt || now().getTime() - savedAt > 24 * 60 * 60_000
          || model.viewerUserId !== record.userId || model.plan.groupId !== record.groupId
          || sharedLocalDate(now(), model.plan.timeZone) !== model.plan.range.asOfDate) return;
        if (record.historyRetention && (record.historyRetention.digest !== model.plan.historyRetention?.digest || model.legacyHistory?.length)) return;
        if (model.privateOverlay?.status === 'ready') {
          if (model.privateOverlay.ownerUserId !== record.userId
            || sharedLocalDate(now(), model.privateOverlay.timeZone) !== model.privateOverlay.today) return;
          model.privateOverlay.byDate = new Map(model.privateOverlay.byDate);
          model.privateOverlay.counts = new Map(model.privateOverlay.counts);
        }
        return model;
      } catch { /* A missing, stale or modified presentation falls back to the authenticated read. */ }
    },
    async write(record: SharingWorkspaceRecord, model: Model): Promise<void> {
      if (record.status !== 'active' || model.viewerUserId !== record.userId || model.plan.groupId !== record.groupId) return;
      if (record.historyRetention && (record.historyRetention.digest !== model.plan.historyRetention?.digest || model.legacyHistory?.length)) return;
      const scope = startupDisplayScope(record);
      const privateOverlay = model.privateOverlay?.status === 'ready' ? { ...model.privateOverlay,
        byDate: [...model.privateOverlay.byDate], counts: [...model.privateOverlay.counts] } : model.privateOverlay;
      if (privateOverlay?.status === 'ready' && privateOverlay.ownerUserId !== record.userId) return;
      const plaintext = encoder.encode(JSON.stringify({ savedAt: now().getTime(), model: { ...model, privateOverlay } }));
      if (plaintext.length > MAX_BYTES) return;
      const key = await input.key(record.userId, true); if (!key || key.length !== 32) return;
      const nonce = await input.crypto.randomBytes(12); if (nonce.length !== 12) throw new Error('Secure random source failed');
      const ciphertext = await input.crypto.encrypt(key, nonce, plaintext, encoder.encode(scope));
      await input.write(record.userId, record.groupId, JSON.stringify({ version: VERSION, scope, encoding: 'base64', nonce: fromByteArray(nonce), ciphertext: fromByteArray(ciphertext) }));
    },
  };
}
