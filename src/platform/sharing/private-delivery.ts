import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import type { Firestore, DocumentData } from 'firebase/firestore';
import { createSharingDeliveryRelay } from './firestore-delivery.ts';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';
import type { DevicePublicIdentity } from '../../features/sharing/crypto';
import type { SharedCloudGroup } from '../../features/sharing/cloud-contract';
import type { VerifiedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority';
import { assertPrivateCalendarCloudAuthority, parsePrivateCalendarCloudHead, PrivateCalendarCloudConflict } from '../../features/sharing/private-calendar/cloud-contract.ts';

export interface PrivateDeliveryPort {
  remember(authority: VerifiedPrivateCalendarAuthority, id: string, value: unknown): Promise<void>;
  recover(authority: VerifiedPrivateCalendarAuthority, id: string): Promise<unknown>;
  confirm(authority: VerifiedPrivateCalendarAuthority, kind: 'preferences' | 'calendar', digest: string): Promise<void>;
  watch(changed: () => void, failed: (error: unknown) => void): () => void;
}
/** Both private domains share one device-scoped, ciphertext-only relay and durable archive. */
export function createPrivateDelivery(port: { firestore: Firestore; userId: string; assertOwner(): void; archive: SharedDeliveryArchive<unknown>;
  state(): Promise<{ identity: DevicePublicIdentity; authority: VerifiedPrivateCalendarAuthority | null } | null> }): PrivateDeliveryPort {
  const { firestore, userId, archive } = port; const root = doc(firestore, 'privateCalendars', userId);
  let authority: VerifiedPrivateCalendarAuthority | undefined; let deviceId = '';
  let relay: ReturnType<typeof createSharingDeliveryRelay<unknown>> | undefined;
  let needsServing = true; let serving: Promise<void> | undefined; let stopRelay: (() => void) | undefined;
  const listeners = new Set<{ changed(): void; failed(error: unknown): void }>();
  const acknowledgements = new Map<string, string>();
  let advertised = false;
  function group(raw: unknown): SharedCloudGroup {
    if (!authority || !raw || typeof raw !== 'object') throw new PrivateCalendarCloudConflict();
    const { createdAt: _created, updatedAt: _updated, ...fields } = raw as DocumentData;
    const head = parsePrivateCalendarCloudHead(fields as unknown as Parameters<typeof parsePrivateCalendarCloudHead>[0], userId);
    assertPrivateCalendarCloudAuthority(head, authority);
    return { schemaVersion: 2, ownerUserId: userId, ownerDeviceId: head.mainDeviceId, memberIds: [userId],
      deviceOwners: Object.fromEntries(head.deviceIds.map(id => [id, userId])), keyVersion: head.keyVersion,
      rosterRevision: head.authorityRevision, rosterJson: head.authorityJson, revokedUserIds: [], rotationRequired: false, closed: false,
      headSequence: 0, lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 };
  }
  function watchRelay() {
    if (!relay || !listeners.size || stopRelay) return;
    stopRelay = relay.watch(userId, () => { needsServing = true; for (const observer of listeners) observer.changed(); }, error => {
      for (const observer of listeners) observer.failed(error);
    });
  }
  async function current(expected: VerifiedPrivateCalendarAuthority) {
    port.assertOwner(); const state = await port.state(); port.assertOwner();
    if (!state?.authority || state.authority.digest !== expected.digest
      || !expected.signed.body.devices.some(device => device.deviceId === state.identity.deviceId)) throw new PrivateCalendarCloudConflict();
    authority = expected;
    if (!relay || deviceId !== state.identity.deviceId) {
      stopRelay?.(); stopRelay = undefined; deviceId = state.identity.deviceId;
      relay = createSharingDeliveryRelay<unknown>({ firestore, userId, checkAccount: port.assertOwner, reference: () => root,
        parseRoot: raw => group(raw), readGroup: async () => { const value = await getDocFromServer(root); port.assertOwner(); return { group: group(value.data()) }; } }, deviceId, archive);
      watchRelay();
    }
    if (needsServing && !serving) {
      needsServing = false;
      const pending = relay.serve(userId); serving = pending;
      void pending.finally(() => { if (serving === pending) serving = undefined; }).catch(error => {
        needsServing = true; for (const observer of listeners) observer.failed(error);
      });
    }
    port.assertOwner(); return relay;
  }
  async function advertise(expected: VerifiedPrivateCalendarAuthority) {
    if (advertised) return;
    const transport = await current(expected);
    const [headDoc, preferences] = await Promise.all([getDocFromServer(root), getDocFromServer(doc(root, 'plannerPreferences', 'current'))]); port.assertOwner();
    group(headDoc.data()); const cache = headDoc.data()?.cacheHead; const digest = preferences.data()?.digest;
    if (cache && !await archive.chunk(`calendar.${cache.manifestDigest}`) || digest && !await archive.chunk(`preferences.${digest}`)) return;
    await transport.ready(userId, 0);
    advertised = true;
  }
  return {
    async remember(expected, id, value) { const transport = await current(expected); await transport.archive.saveChunk(id, value); port.assertOwner(); },
    async recover(expected, id) { const transport = await current(expected); const value = await transport.snapshotChunk(userId, id, 0); port.assertOwner(); return value; },
    async confirm(expected, kind, digest) {
      const transport = await current(expected); if (!/^[a-f0-9]{64}$/u.test(digest) || !await archive.chunk(`${kind}.${digest}`)) throw new Error('Private delivery is not durable');
      const key = `${expected.digest}:${kind}`;
      if (acknowledgements.get(key) === digest) { await transport.acknowledge(userId, 0); return; }
      if (acknowledgements.get(key) !== digest) {
        await runTransaction(firestore, async transaction => {
          const target = doc(root, 'deliveryAcknowledgements', deviceId);
          const [head, previous] = await Promise.all([transaction.get(root), transaction.get(target)]); port.assertOwner(); group(head.data());
          const old = previous.data(); const domain = kind === 'calendar' ? 'calendarDigest' : 'preferencesDigest';
          if (old?.authorityDigest === expected.digest && old[domain] === digest) return;
          transaction.set(target, { userId, deviceId, authorityDigest: expected.digest,
            calendarDigest: old?.authorityDigest === expected.digest ? old.calendarDigest : null,
            preferencesDigest: old?.authorityDigest === expected.digest ? old.preferencesDigest : null,
            [domain]: digest, updatedAt: serverTimestamp() });
        }); port.assertOwner(); acknowledgements.set(key, digest);
      }
      await advertise(expected); await transport.acknowledge(userId, 0);
    },
    watch(changed, failed) {
      const observer = { changed, failed }; listeners.add(observer); watchRelay();
      return () => { listeners.delete(observer); if (!listeners.size) { stopRelay?.(); stopRelay = undefined; } };
    },
  };
}
