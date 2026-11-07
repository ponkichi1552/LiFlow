import type { createPrivateCalendarSecretStore } from '../private-calendar/secret-store.ts';
import type { VerifiedPrivateCalendarAuthority } from '../private-calendar/authority.ts';
import type { SharingCryptoGateway } from '../crypto.ts';
import type { createPrivatePlannerCloud } from '../../../platform/sharing/private-planner-cloud.ts';
import type { PrivatePlannerPreferenceStore } from './preference-store.ts';
import { PrivatePlannerPreferenceConflict } from './preference-store.ts';
import { openPrivatePreferences, privatePreferenceCursor, samePrivatePreferenceCursor, sealPrivatePreferences, PrivatePreferenceCloudConflict } from './preference-crypto.ts';
import { preferenceValues, samePreferenceValues } from './preference-sync-state.ts';

export type PrivatePreferenceSyncResult = { kind: 'unavailable' | 'empty' | 'received' | 'sent' | 'unchanged' | 'conflict' | 'awaitingReencryption' | 'waiting' | 'changed' };
/** All accepted plaintext and pending ciphertext stay in the owner's protected record, outside the group ledger. */
export function createPrivatePreferenceSync(port: { ownerUserId: string; assertOwner(): void | Promise<void>;
  store: PrivatePlannerPreferenceStore; secrets: ReturnType<typeof createPrivateCalendarSecretStore>; crypto: SharingCryptoGateway;
  cloud: ReturnType<typeof createPrivatePlannerCloud>; now?: () => number; randomFraction?: () => number }) {
  const { ownerUserId, store, secrets, crypto, cloud, now = Date.now, randomFraction = Math.random } = port;
  let running: { force: boolean; promise: Promise<PrivatePreferenceSyncResult> } | null = null;
  async function ownedState() {
    await port.assertOwner(); const state = await store.readSyncState(); await port.assertOwner();
    if (state.ownerUserId !== ownerUserId || state.local && state.local.ownerUserId !== ownerUserId) throw new Error('本人設定の保存先が別のアカウントです。'); return state;
  }
  async function authority() {
    await port.assertOwner(); const state = await secrets.publicState(ownerUserId); await port.assertOwner(); const current = state?.authority;
    return current && state.hasCurrentKey && current.signed.body.devices.some(device => device.deviceId === state.identity.deviceId) ? current : null;
  }
  async function ensureAuthority(expected: VerifiedPrivateCalendarAuthority, assertBudget: () => void) {
    assertBudget(); await port.assertOwner(); if ((await authority())?.digest !== expected.digest) throw new Error('本人設定の承認端末・鍵の世代が更新されています。'); assertBudget();
  }
  async function execute(force: boolean, assertBudget: () => void): Promise<PrivatePreferenceSyncResult> {
    assertBudget(); const a = await authority(); if (!a) return { kind: 'unavailable' }; let state = await ownedState(); assertBudget();
    if (!force && state.retry && state.retry.attemptedAt <= now() && state.retry.nextAt > now()) return { kind: 'waiting' };
    let incoming;
    try { incoming = await cloud.read(a, assertBudget); }
    catch (error) {
      if (state.local) await store.recordDeliveryFailure(state.local.revision, state.pending ? privatePreferenceCursor(state.pending.encrypted).digest : null, now(), randomFraction()).catch(() => undefined);
      throw error;
    }
    await ensureAuthority(a, assertBudget);
    const remoteCursor = incoming ? privatePreferenceCursor(incoming) : null;
    let rollover = false;
    if (incoming && incoming.body.authorityDigest !== a.digest) {
      // A remaining device can republish the exact baseline it already authenticated. A new/removed device cannot decrypt by guessing an old key.
      if (!state.baseline || !samePrivatePreferenceCursor(state.baseline.cursor, remoteCursor)) return { kind: 'awaitingReencryption' };
      if (state.review) return { kind: 'conflict' }; rollover = true;
    } else {
      const known = incoming && [state.baseline, state.review].find(value => value && samePrivatePreferenceCursor(value.cursor, remoteCursor));
      const key = incoming && !known ? await secrets.currentKey(ownerUserId, a) : null;
      try {
        if (incoming && !known && !key) return { kind: 'unavailable' };
        const preferences = known ? known.preferences : incoming ? await openPrivatePreferences(crypto, incoming, a, key!) : null; await ensureAuthority(a, assertBudget);
        state = await store.observeRemote(incoming ? { cursor: remoteCursor!, preferences: preferences! } : null);
      } finally { key?.fill(0); }
    }
    if (state.review) return { kind: 'conflict' };
    if (!state.local) return { kind: 'empty' };
    if (!rollover && !state.pending && samePreferenceValues(state.local, state.baseline?.preferences ?? null)) return { kind: incoming ? 'received' : 'unchanged' };
    if (state.pending?.localRevision !== state.local.revision || state.pending.encrypted.body.authorityDigest !== a.digest) {
      const key = await secrets.currentKey(ownerUserId, a); if (!key) return { kind: 'unavailable' };
      try {
        const encrypted = await sealPrivatePreferences(crypto, { preferences: preferenceValues(state.local), authority: a,
          author: await secrets.identity(ownerUserId), accountKey: key, parent: state.baseline?.cursor ?? null });
        await ensureAuthority(a, assertBudget); state = await store.prepareUpload(state.local.revision, state.baseline?.cursor ?? null, encrypted);
      } catch (error) { if (error instanceof PrivatePlannerPreferenceConflict) return { kind: 'changed' }; throw error; }
      finally { key.fill(0); }
    }
    const pending = state.pending!; const digest = privatePreferenceCursor(pending.encrypted).digest;
    try {
      await ensureAuthority(a, assertBudget); await cloud.publish(a, pending.encrypted, assertBudget); await ensureAuthority(a, assertBudget);
      const key = await secrets.currentKey(ownerUserId, a);
      try {
        if (!key) return { kind: 'unavailable' };
        const preferences = await openPrivatePreferences(crypto, pending.encrypted, a, key); await ensureAuthority(a, assertBudget);
        await store.observeRemote({ cursor: privatePreferenceCursor(pending.encrypted), preferences }); return { kind: 'sent' };
      } finally { key?.fill(0); }
    } catch (error) {
      if (error instanceof PrivatePreferenceCloudConflict) {
        // Fetch on the next bounded pass. Preserve the exact pending operation and local value until both candidates are known.
        return { kind: 'changed' };
      }
      await store.recordDeliveryFailure(pending.localRevision, digest, now(), randomFraction()).catch(() => undefined); throw error;
    }
  }
  function synchronize(force = false, assertBudget: () => void = () => {}): Promise<PrivatePreferenceSyncResult> {
      if (running) { const current = running; return force && !current.force ? current.promise.then(result => result.kind === 'waiting' ? (assertBudget(), synchronize(true, assertBudget)) : result) : current.promise; }
      const pending = execute(force, assertBudget); running = { force, promise: pending };
      void pending.finally(() => { if (running?.promise === pending) running = null; }).catch(() => undefined); return pending;
  }
  return { cloud, store, synchronize,
    async readStatus() {
      const state = await ownedState(); const configured = Boolean(await authority()); await port.assertOwner();
      return { configured, local: state.local, baseline: state.baseline?.cursor ?? null, review: state.review,
        kind: state.review ? 'conflict' as const : state.pending || state.local && !samePreferenceValues(state.local, state.baseline?.preferences ?? null)
          ? 'pending' as const : state.baseline ? 'synchronized' as const : 'empty' as const,
        nextRetryAt: state.retry?.nextAt ?? null };
    },
    async resolve(expectedRevision: number, expectedRemote: Parameters<PrivatePlannerPreferenceStore['resolveReview']>[1], choice: 'local' | 'remote') {
      await ownedState(); const result = await store.resolveReview(expectedRevision, expectedRemote, choice); await port.assertOwner(); return result;
    },
  };
}
export type PrivatePreferenceSync = ReturnType<typeof createPrivatePreferenceSync>;
