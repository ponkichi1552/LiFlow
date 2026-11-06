import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarRootSetupStorage } from '../../../platform/storage/private-calendar-root-setup.ts';
import type { createPrivateCalendarAuthorityIntentStorage } from '../../../platform/storage/private-calendar-authority-intents.ts';
import type { createPrivateCalendarPairingStorage } from '../../../platform/storage/private-calendar-pairing.ts';
import type { createPrivateCalendarKeyOutbox } from '../../../platform/storage/private-calendar-key-outbox.ts';
import type { createPrivateCalendarCacheStorage } from '../../../platform/storage/private-calendar-cache.ts';
import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import { createPrivateCalendarFirstDeviceSetup } from './first-device-setup.ts';
import { createPrivateCalendarAuthoritySync } from './authority-sync.ts';
import { createPrivateCalendarKeyDelivery } from './key-delivery.ts';
import { createPrivateCalendarPairingController } from './pairing-controller.ts';
import { privateCalendarPairingReference, snapshotPrivateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from './pairing.ts';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from './pairing.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { assertPrivateCalendarWork, privateCalendarWork } from './sync-deadline.ts';
import type { PrivateCalendarWorkControl } from './sync-deadline.ts';

export interface PrivateCalendarDeviceSessionPort {
  userId: string; assertOwner(): void | Promise<void>;
  secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  roots: ReturnType<typeof createPrivateCalendarRootSetupStorage>;
  intents: ReturnType<typeof createPrivateCalendarAuthorityIntentStorage>;
  candidates: ReturnType<typeof createPrivateCalendarPairingStorage>;
  outbox: ReturnType<typeof createPrivateCalendarKeyOutbox>;
  cache: ReturnType<typeof createPrivateCalendarCacheStorage>;
  cloud: ReturnType<typeof createPrivateCalendarCloud>;
}
export interface PrivateCalendarDeviceView {
  ownerUserId: string; phase: 'unconfigured' | 'firstPending' | 'pairing' | 'approved' | 'revoked';
  deviceId: string | null; mainDeviceId: string | null; authorityDigest: string | null;
  revision: number | null; keyVersion: number | null; keyReady: boolean;
  devices: readonly { deviceId: string }[];
  reference: PrivateCalendarPairingReference | null; request: PrivateCalendarPairingRequest | null;
  pendingChange: { digest: string; observedCurrentDigest: string; reviewRequired: boolean } | null;
  pendingKeys: number; keyRetryAt: number | null;
  cache: { sequence: number; authorityCurrent: boolean; pending: boolean } | null;
}

/** A public settings facade. No secret identity or plaintext Calendar data may leave this session. */
export function createPrivateCalendarDeviceSession(port: PrivateCalendarDeviceSessionPort) {
  const { userId, secrets, roots, intents, candidates, outbox, cache, cloud } = port; assertSharedIdentifier(userId);
  const first = createPrivateCalendarFirstDeviceSetup({ userId, secrets, intents: roots, cloud });
  const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets, intents, cloud });
  const delivery = createPrivateCalendarKeyDelivery({ userId, secrets, outbox, cloud });
  const pairing = createPrivateCalendarPairingController({ userId, secrets, candidates, intents, authoritySync, delivery, cloud });
  async function read(): Promise<PrivateCalendarDeviceView> {
    await port.assertOwner(); const state = await secrets.publicState(userId);
    const empty: PrivateCalendarDeviceView = { ownerUserId: userId, phase: 'unconfigured', deviceId: null, mainDeviceId: null,
      authorityDigest: null, revision: null, keyVersion: null, keyReady: false, devices: [], reference: null, request: null,
      pendingChange: null, pendingKeys: 0, keyRetryAt: null, cache: null };
    if (!state) { await port.assertOwner(); return empty; }
    const root = await roots.read(); const candidate = await candidates.read(); const current = state.authority;
    const approved = current?.signed.body.devices.some(device => device.deviceId === state.identity.deviceId) === true;
    const pending = current ? await intents.readPending() : null;
    const keys = approved ? await outbox.status(current!) : null;
    const cached = approved ? await cache.status(current!) : null;
    const after = await secrets.publicState(userId); await port.assertOwner();
    if (after?.identity.deviceId !== state.identity.deviceId || after.authority?.digest !== current?.digest) throw new Error('本人端末の設定が読込中に変わりました。再読込してください。');
    return { ...empty, phase: root?.status === 'pending' ? 'firstPending' : current ? approved ? 'approved' : 'revoked' : candidate ? 'pairing' : 'unconfigured',
      deviceId: state.identity.deviceId, mainDeviceId: current?.signed.body.mainDeviceId ?? null, authorityDigest: current?.digest ?? null,
      revision: current?.signed.body.revision ?? null, keyVersion: current?.signed.body.keyVersion ?? null, keyReady: approved && state.hasCurrentKey,
      devices: current?.signed.body.devices.map(device => ({ deviceId: device.deviceId })) ?? [],
      reference: approved ? privateCalendarPairingReference(current!) : null, request: candidate?.status === 'prepared' ? candidate.request : null,
      pendingChange: pending ? { digest: pending.digest, observedCurrentDigest: current!.digest,
        reviewRequired: pending.signed.body.previousDigest !== current!.digest && pending.digest !== current!.digest } : null,
      pendingKeys: keys?.pending ?? 0, keyRetryAt: keys?.retryAt ?? null,
      cache: cached ? { sequence: cached.cursor.sequence, authorityCurrent: cached.authorityCurrent, pending: cached.pending } : null };
  }
  const listeners = new Set<() => void>();
  let mutation: Promise<unknown> | null = null;
  function exclusive<T>(work: () => Promise<T>, notify = true): Promise<T> {
    if (mutation) return Promise.reject(new Error('本人端末の操作が終わってから再試行してください。'));
    const pending = (async () => { await port.assertOwner(); const result = await work(); await port.assertOwner(); return result; })();
    mutation = pending; void pending.finally(() => {
      if (mutation === pending) mutation = null;
      if (notify) for (const listener of listeners) try { listener(); } catch { /* A view cannot roll back a committed device setting. */ }
    }).catch(() => {}); return pending;
  }
  async function deliver(force: boolean, control: PrivateCalendarWorkControl = {}) {
    assertPrivateCalendarWork(control);
    const state = await secrets.publicState(userId); const authority = state?.authority;
    if (!authority || !authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId)) return;
    if (!state.hasCurrentKey) {
      assertPrivateCalendarWork(control);
      if (authority.keyIssuer?.deviceId === state.identity.deviceId) { const key = await secrets.createCurrentKey(userId, authority); key.fill(0); }
      else { const wrapped = await privateCalendarWork(() => cloud.readKey(authority, state.identity.deviceId, control.assertBudget), control); if (wrapped) await secrets.receiveCurrentKey(userId, authority, wrapped); }
    }
    assertPrivateCalendarWork(control);
    await delivery.queueApprovedDevices(control); await delivery.flush({ ...control, force });
  }
  let sync: { force: boolean; promise: Promise<PrivateCalendarDeviceView> } | null = null;
  const synchronizeDevices = (options: PrivateCalendarWorkControl & { force?: boolean } = {}): Promise<PrivateCalendarDeviceView> => {
    const force = options.force !== false;
    if (sync) {
      const current = sync;
      return force && !current.force ? current.promise.then(() => synchronizeDevices({ ...options, force: true })) : current.promise;
    }
    const pending = exclusive(async () => {
      assertPrivateCalendarWork(options);
      const before = await read();
      assertPrivateCalendarWork(options);
      // Merely opening/retrying an unconfigured or unapproved device cannot create trust.
      if (before.phase === 'unconfigured' || before.phase === 'pairing') return before;
      if (before.phase === 'firstPending') await first.resume(options);
      const resumed = await authoritySync.resume(options);
      if (resumed.kind === 'review') return read();
      if (resumed.kind === 'idle') await authoritySync.refresh(options);
      assertPrivateCalendarWork(options);
      await deliver(force, options); assertPrivateCalendarWork(options); return read();
    }, force);
    sync = { force, promise: pending }; void pending.finally(() => { if (sync?.promise === pending) sync = null; }).catch(() => {}); return pending;
  };
  async function change(targetDeviceId: string, expectedDigest: string, remove: boolean) {
    const { authority } = await authoritySync.refresh(); const state = await secrets.publicState(userId);
    if (authority.digest !== expectedDigest) throw new Error('表示後に本人端末の設定が変わりました。再読込して操作を確認してください。');
    if (!state || !authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId)) throw new Error('この端末の承認は解除されています。');
    if (!authority.signed.body.devices.some(device => device.deviceId === targetDeviceId)) throw new Error('対象の本人端末が変わりました。');
    if (remove && targetDeviceId === state.identity.deviceId) throw new Error('この画面では操作中の端末を解除できません。別の承認済み端末で確認してください。');
    if (!remove && targetDeviceId === authority.signed.body.mainDeviceId) return read();
    const result = await authoritySync.change({ devices: authority.signed.body.devices.filter(device => !remove || device.deviceId !== targetDeviceId),
      mainDeviceId: remove ? authority.signed.body.mainDeviceId === targetDeviceId ? state.identity.deviceId : authority.signed.body.mainDeviceId : targetDeviceId,
      keyVersion: authority.signed.body.keyVersion + (remove ? 1 : 0) });
    if (result.kind !== 'review') await deliver(true); return read();
  }
  return { read, synchronizeDevices, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initializeFirstDevice: () => exclusive(async () => {
      const before = await read();
      if (before.authorityDigest || before.request) throw new Error('本人端末の設定が既にあります。既存の設定を確認してください。');
      await first.prepareAndResume(); return read();
    }),
    prepareConfirmedReference(reference: PrivateCalendarPairingReference) {
      const owned = snapshotPrivateCalendarPairingReference(reference);
      return exclusive(async () => {
        const protectedState = await secrets.publicState(userId);
        const pending = protectedState ? await roots.read() : null;
        if (pending?.status === 'pending') {
          // Reuse the existing reference-review action, without another confirmation.
          // An unknown/temporarily unreachable server is never evidence of a conflicting root.
          const head = await cloud.readHead(); await port.assertOwner();
          if (!head || head.ownerUserId !== userId || owned.anchor.ownerUserId !== userId
            || head.rootDigest !== owned.anchor.rootDigest || head.accountGeneration !== owned.anchor.accountGeneration
            || head.authorityDigest !== owned.authorityDigest || head.authorityRevision !== owned.authorityRevision) throw new Error('元の本人端末の最新の確認情報を確認してください。初回の準備は保持しています。');
          if (head.rootDigest === pending.digest) {
            await first.resume();
            throw new Error('この端末の初回設定は受付済みです。端末設定を再読込してください。');
          }
          if (!await roots.discardUnaccepted(pending.digest)) throw new Error('保護された本人端末の設定があります。鍵と保存データの復旧を確認してください。');
        }
        await pairing.prepareConfirmedReference(owned); return read();
      });
    },
    approveConfirmedRequest(request: PrivateCalendarPairingRequest) {
      const owned = verifyPrivateCalendarPairingRequest(request);
      return exclusive(async () => { await pairing.approve(owned); return read(); });
    },
    acceptApproval: () => exclusive(async () => { await pairing.join(); return read(); }),
    changeMain: (deviceId: string, expectedDigest: string) => exclusive(() => change(deviceId, expectedDigest, false)),
    revokeDevice: (deviceId: string, expectedDigest: string) => exclusive(() => change(deviceId, expectedDigest, true)),
    dismissReviewed: (digest: string, observedCurrentDigest: string) => exclusive(async () => {
      if (!await authoritySync.dismissReviewed(digest, observedCurrentDigest)) throw new Error('確認待ちの本人端末設定が変わりました。再読込してください。'); return read();
    }),
  };
}
export type PrivateCalendarDeviceSession = ReturnType<typeof createPrivateCalendarDeviceSession>;
