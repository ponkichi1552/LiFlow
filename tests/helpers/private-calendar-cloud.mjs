import assert from 'node:assert/strict';
import { sharedDocumentDigest } from '../../src/features/sharing/crypto.ts';
import { verifyPrivateCalendarAuthorityUpdate } from '../../src/features/sharing/private-calendar/authority.ts';
import { verifyPrivateCalendarWrappedKey } from '../../src/features/sharing/private-calendar/key-envelope.ts';
import { assertPrivateCalendarCloudAuthority, privateCalendarCloudFields, PrivateCalendarCloudConflict } from '../../src/features/sharing/private-calendar/cloud-contract.ts';
import { verifyPrivateCalendarCacheCiphertext } from '../../src/features/sharing/private-calendar/cache-crypto.ts';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';

/** Deterministic transport double only. Real Rules and SDK paths have independent Emulator integration tests. */
export function privateCalendarMemoryCloud() {
  const history = []; const packets = new Map(); const flags = { controlReplyLost: false, keyReplyLost: false }; let current; const pages = [];
  let encryptedCache = null;
  const head = () => ({ ...privateCalendarCloudFields(current), cacheHead: encryptedCache ? {
    ...Object.fromEntries(['authorityDigest', 'cacheId', 'sequence', 'chunkCount'].map(key => [key, encryptedCache.manifest.body[key]])), manifestDigest: sharedDocumentDigest(encryptedCache.manifest),
  } : null });
  const cloud = {
    async readHead() { return head(); },
    async createRoot(root) {
      if (current) {
        if (root.anchor.rootDigest !== current.anchor.rootDigest || root.anchor.accountGeneration !== current.anchor.accountGeneration
          || sharedDocumentDigest(history[0]) !== root.digest) throw new PrivateCalendarCloudConflict();
        return { created: false, head: privateCalendarCloudFields(current) };
      }
      current = root; history.push(root.signed); return { created: true, head: privateCalendarCloudFields(root) };
    },
    async authorityPage(after) { pages.push(after); return { head: privateCalendarCloudFields(current), authorities: history.slice(after, after + 100) }; },
    async commitAuthority(before, next) {
      const accepted = history[next.signed.body.revision - 1];
      if (accepted) { if (sharedDocumentDigest(accepted) !== next.digest) throw new PrivateCalendarCloudConflict(); }
      else { assertPrivateCalendarCloudAuthority(privateCalendarCloudFields(current), before); current = verifyPrivateCalendarAuthorityUpdate(before, next.signed); history.push(current.signed); }
      if (flags.controlReplyLost) { flags.controlReplyLost = false; throw Object.assign(new Error('lost approval reply'), { code: 'unavailable' }); }
      return { accepted: true, head: privateCalendarCloudFields(current) };
    },
    async sendKey(authority, wrapped) {
      assertPrivateCalendarCloudAuthority(privateCalendarCloudFields(current), authority); verifyPrivateCalendarWrappedKey(wrapped, authority, wrapped.body.recipientDeviceId);
      const id = authority.digest + wrapped.body.recipientDeviceId; const json = JSON.stringify(wrapped); const previous = packets.get(id);
      if (previous && previous !== json) throw new PrivateCalendarCloudConflict();
      if (!previous) packets.set(id, json);
      if (flags.keyReplyLost) { flags.keyReplyLost = false; throw Object.assign(new Error('lost key reply'), { code: 'unavailable' }); }
    },
    async readKey(authority, deviceId) { assertPrivateCalendarCloudAuthority(privateCalendarCloudFields(current), authority); const json = packets.get(authority.digest + deviceId); return json ? JSON.parse(json) : null; },
    async uploadCache(authority, encrypted) {
      assertPrivateCalendarCloudAuthority(head(), authority); await verifyPrivateCalendarCacheCiphertext(crypto, encrypted, authority);
      if (encryptedCache && (encryptedCache.manifest.body.sequence > encrypted.manifest.body.sequence
        || encryptedCache.manifest.body.sequence === encrypted.manifest.body.sequence && sharedDocumentDigest(encryptedCache.manifest) !== sharedDocumentDigest(encrypted.manifest))) throw new PrivateCalendarCloudConflict();
      encryptedCache = structuredClone(encrypted); return { published: true };
    },
    async readCache(authority) { assertPrivateCalendarCloudAuthority(head(), authority); return encryptedCache?.manifest.body.authorityDigest === authority.digest ? structuredClone(encryptedCache) : null; },
  };
  return { cloud, history, packets, flags, pages };
}
