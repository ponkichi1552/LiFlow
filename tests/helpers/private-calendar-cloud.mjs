import assert from 'node:assert/strict';
import { sharedDocumentDigest } from '../../src/features/sharing/crypto.ts';
import { verifyPrivateCalendarAuthorityUpdate } from '../../src/features/sharing/private-calendar/authority.ts';
import { verifyPrivateCalendarWrappedKey } from '../../src/features/sharing/private-calendar/key-envelope.ts';
import { assertPrivateCalendarCloudAuthority, privateCalendarCloudFields, PrivateCalendarCloudConflict } from '../../src/features/sharing/private-calendar/cloud-contract.ts';
import { verifyPrivateCalendarCacheCiphertext } from '../../src/features/sharing/private-calendar/cache-crypto.ts';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { canonicalJson } from '../../src/features/sharing/operations.ts';

/** Deterministic transport double only. Real Rules and SDK paths have independent Emulator integration tests. */
export function privateCalendarMemoryCloud() {
  const history = []; const packets = new Map(); const flags = { controlReplyLost: false, keyReplyLost: false, keyBlocked: false }; let current; const pages = [];
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
      if (flags.keyBlocked) throw Object.assign(new Error('synthetic offline key delivery'), { code: 'unavailable' });
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
  const codes = new Map(), listeners = new Map(); let codeReads = 0;
  const changed = id => { for (const listener of listeners.get(id) ?? []) queueMicrotask(listener); };
  const connectionCloud = {
    async create(grant) {
      assert.equal(grant.body.reference.authorityDigest, current.digest);
      const id = grant.body.codeId, existing = codes.get(id);
      if (existing) assert.equal(canonicalJson(existing.grant), canonicalJson(grant));
      else codes.set(id, structuredClone({ grant, state: 'open', claim: null })); changed(id);
    },
    async read(id) { codeReads++; return codes.has(id) ? structuredClone(codes.get(id)) : null; },
    async claim(grant, claim) {
      const row = codes.get(grant.body.codeId); assert.ok(row); assert.equal(canonicalJson(row.grant), canonicalJson(grant));
      if (row.state !== 'open') assert.equal(canonicalJson(row.claim), canonicalJson(claim), 'used code');
      else { assert.ok(grant.body.expiresAt > Date.now()); row.state = 'claimed'; row.claim = structuredClone(claim); }
      changed(grant.body.codeId); return structuredClone(row);
    },
    async complete(grant, digest) {
      const row = codes.get(grant.body.codeId); assert.equal(sharedDocumentDigest(row.claim.request), digest);
      assert.equal(canonicalJson(row.grant), canonicalJson(grant)); row.state = 'complete'; changed(grant.body.codeId);
    },
    watch(id, listener) {
      let group = listeners.get(id); if (!group) listeners.set(id, group = new Set()); group.add(listener); queueMicrotask(listener);
      return () => group.delete(listener);
    },
  };
  return { cloud, connectionCloud, codes, codeReads: () => codeReads, watchers: () => [...listeners.values()].reduce((sum, value) => sum + value.size, 0), history, packets, flags, pages };
}
