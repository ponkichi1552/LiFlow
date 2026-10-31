import type { SharingCryptoGateway } from '../sharing/crypto';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry';
import type { V2GroupUiSession } from '../sharing/v2-ui/screen-session';
import { sharedLocalDate } from '../sharing/group-clock.ts';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

type Model = Awaited<ReturnType<V2GroupUiSession['readModel']>>;
const VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function decodeHex(value: string, maximum: number) {
  if (typeof value !== 'string' || value.length > maximum * 2 || !/^(?:[a-f0-9]{2})+$/u.test(value)) throw new Error('Invalid local display');
  return hexToBytes(value);
}

/** This receipt identifies a saved display, never a permission to read or mutate a repository. */
export function startupDisplayScope(record: SharingWorkspaceRecord): string {
  return sharedDocumentDigest({ version: VERSION, userId: record.userId, groupId: record.groupId,
    generation: record.localGeneration ?? null, status: record.status, anchor: record.anchor, archive: record.rosterArchive });
}

/** Encrypted, device-local presentation only. The real session still verifies every operation. */
export function createStartupDisplayCache(input: {
  crypto: SharingCryptoGateway;
  read(userId: string, groupId: string): Promise<string | null>;
  write(userId: string, groupId: string, value: string): Promise<void>;
  key(userId: string, create: boolean): Promise<Uint8Array | null>;
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
        const plaintext = await input.crypto.decrypt(key, decodeHex(envelope.nonce, 12), decodeHex(envelope.ciphertext, MAX_BYTES + 16), aad);
        if (plaintext.length > MAX_BYTES) return;
        const { savedAt, model } = JSON.parse(decoder.decode(plaintext));
        if (!Number.isFinite(savedAt) || now().getTime() < savedAt || now().getTime() - savedAt > 24 * 60 * 60_000
          || model.viewerUserId !== record.userId || model.plan.groupId !== record.groupId
          || sharedLocalDate(now(), model.plan.timeZone) !== model.plan.range.asOfDate) return;
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
      const privateOverlay = model.privateOverlay?.status === 'ready' ? { ...model.privateOverlay,
        byDate: [...model.privateOverlay.byDate], counts: [...model.privateOverlay.counts] } : model.privateOverlay;
      if (privateOverlay?.status === 'ready' && privateOverlay.ownerUserId !== record.userId) return;
      const plaintext = encoder.encode(JSON.stringify({ savedAt: now().getTime(), model: { ...model, privateOverlay } }));
      if (plaintext.length > MAX_BYTES) return;
      const key = await input.key(record.userId, true); if (!key || key.length !== 32) return;
      const nonce = await input.crypto.randomBytes(12); if (nonce.length !== 12) throw new Error('Secure random source failed');
      const scope = startupDisplayScope(record);
      const ciphertext = await input.crypto.encrypt(key, nonce, plaintext, encoder.encode(scope));
      await input.write(record.userId, record.groupId, JSON.stringify({ version: VERSION, scope, nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) }));
    },
  };
}
