import { doc, getDocFromServer } from 'firebase/firestore';
import type { Firestore, DocumentData } from 'firebase/firestore';
import { createSharingDeliveryRelay } from './firestore-delivery.ts';
import { createDeliveryProofClient } from './delivery-proof-cloud.ts';
import type { SharedDeliveryArchive } from '../../features/sharing/delivery-archive';
import type { DevicePublicIdentity } from '../../features/sharing/crypto';
import type { SharedCloudGroup } from '../../features/sharing/cloud-contract';
import type { VerifiedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority';
import { assertPrivateCalendarCloudAuthority, parsePrivateCalendarCloudHead, PrivateCalendarCloudConflict } from '../../features/sharing/private-calendar/cloud-contract.ts';
import { DELIVERY_PROOF_COLLECTION, parseDeliveryPolicy, readSignedDeliveryProgress } from '../../features/sharing/delivery-proof.ts';
import type { PrivateDeliveryProgress } from '../../features/sharing/delivery-proof.ts';

export interface PrivateDeliveryPort {
  remember(authority: VerifiedPrivateCalendarAuthority, id: string, value: unknown): Promise<void>;
  recover(authority: VerifiedPrivateCalendarAuthority, id: string): Promise<unknown>;
  confirm(authority: VerifiedPrivateCalendarAuthority, kind: 'preferences' | 'calendar', digest: string): Promise<void>;
  prepare(authority: VerifiedPrivateCalendarAuthority): Promise<void>;
  has(id: string): Promise<boolean>;
  watch(changed: () => void, failed: (error: unknown) => void): () => void;
}
/** Both private domains share one device-scoped, ciphertext-only relay and durable archive. */
export function createPrivateDelivery(port: { firestore: Firestore; userId: string; assertOwner(): void; archive: SharedDeliveryArchive<unknown>;
  sign(value: unknown, deviceId: string): Promise<string>;
  state(): Promise<{ identity: DevicePublicIdentity; authority: VerifiedPrivateCalendarAuthority | null } | null> }): PrivateDeliveryPort {
  const { firestore, userId, archive } = port; const root = doc(firestore, 'privateCalendars', userId);
  let authority: VerifiedPrivateCalendarAuthority | undefined; let identity: DevicePublicIdentity | undefined;
  let relay: ReturnType<typeof createSharingDeliveryRelay<unknown>> | undefined;
  let proof: ReturnType<typeof createDeliveryProofClient> | undefined;
  let needsServing = true; let serving: Promise<void> | undefined; let stopRelay: (() => void) | undefined;
  const listeners = new Set<{ changed(): void; failed(error: unknown): void }>();
  let confirmations: Promise<void> = Promise.resolve();
  let last: { scopeKey: string; progress: PrivateDeliveryProgress } | undefined;
  let checkedPolicy: unknown;
  function reportFailure(error: unknown) {
    for (const observer of listeners) {
      try { observer.failed(error); } catch { /* Other observers and receipt retries must still run. */ }
    }
  }
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
    stopRelay = relay.watch(userId, () => { needsServing = true; checkedPolicy = undefined; for (const observer of listeners) observer.changed(); }, reportFailure);
  }
  async function current(expected: VerifiedPrivateCalendarAuthority) {
    port.assertOwner(); const state = await port.state(); port.assertOwner();
    if (!state?.authority || state.authority.digest !== expected.digest
      || !expected.signed.body.devices.some(device => device.deviceId === state.identity.deviceId)) throw new PrivateCalendarCloudConflict();
    authority = expected;
    if (!relay || identity?.deviceId !== state.identity.deviceId) {
      stopRelay?.(); stopRelay = undefined; last = undefined; checkedPolicy = undefined; identity = state.identity;
      const deviceId = identity.deviceId;
      proof = createDeliveryProofClient({ firestore, kind: 'private', userId, deviceId, check: port.assertOwner,
        authority(raw) {
          if (!authority || raw?.authorityDigest !== authority.digest || !raw.deviceIds?.includes(deviceId)) return null;
          group(raw); return { digest: authority.digest, keyVersion: authority.signed.body.keyVersion };
        },
        sign: value => port.sign(value, deviceId),
      });
      relay = createSharingDeliveryRelay<unknown>({ firestore, userId, checkAccount: port.assertOwner, reference: () => root,
        proof, parseRoot: raw => group(raw), readGroup: async () => { const value = await getDocFromServer(root); port.assertOwner(); return { group: group(value.data()) }; } }, deviceId, archive);
      watchRelay();
    }
    if (needsServing && !serving) {
      needsServing = false;
      const pending = relay.serve(userId); serving = pending;
      void pending.finally(() => { if (serving === pending) serving = undefined; }).catch(error => {
        needsServing = true; reportFailure(error);
      });
    }
    port.assertOwner(); return relay;
  }
  function report(expected: VerifiedPrivateCalendarAuthority, confirmation?: { kind: 'preferences' | 'calendar'; digest: string }) {
    const run = confirmations.then(async () => {
      const transport = await current(expected); const client = proof!, device = identity!;
      if (confirmation && (!/^[a-f0-9]{64}$/u.test(confirmation.digest) || !await archive.chunk(`${confirmation.kind}.${confirmation.digest}`))) {
        throw new Error('Private delivery is not durable');
      }
      // Watches invalidate enrollment on a real change. Outside a watch, recheck on the next real synchronization.
      const policy = parseDeliveryPolicy(checkedPolicy ?? await client.readPolicy(root));
      if (listeners.size) checkedPolicy = policy ?? false;
      if (!policy) { await transport.acknowledge(userId, 0); return; }
      const scopeKey = `${expected.digest}:${policy.enrollmentId}`;
      const field = confirmation?.kind === 'calendar' ? 'calendarDigest' : 'preferencesDigest';
      if (last?.scopeKey === scopeKey && last.progress.ready && (!confirmation || last.progress[field] === confirmation.digest)) {
        await transport.acknowledge(userId, 0); return;
      }
      const head = (await getDocFromServer(root)).data(); port.assertOwner();
      const scope = client.resolve(userId, policy, head);
      if (!scope || scope.authorityDigest !== expected.digest) throw new PrivateCalendarCloudConflict();
      let progress = last?.scopeKey === scopeKey ? { ...last.progress } : undefined;
      if (!progress) {
        const saved = (await getDocFromServer(doc(root, DELIVERY_PROOF_COLLECTION, device.deviceId))).data(); port.assertOwner();
        const previous = readSignedDeliveryProgress(scope, userId, device, saved) as PrivateDeliveryProgress | null;
        const calendarDigest = previous?.calendarDigest && await archive.chunk(`calendar.${previous.calendarDigest}`) ? previous.calendarDigest : null;
        const preferencesDigest = previous?.preferencesDigest && await archive.chunk(`preferences.${previous.preferencesDigest}`) ? previous.preferencesDigest : null;
        progress = { ready: previous?.ready === true && calendarDigest === previous.calendarDigest && preferencesDigest === previous.preferencesDigest,
          calendarDigest, preferencesDigest };
      }
      if (confirmation) progress[field] = confirmation.digest;
      if (!progress.ready) {
        const preferences = (await getDocFromServer(doc(root, 'plannerPreferences', 'current'))).data(); port.assertOwner();
        const wantedCalendar = head?.cacheHead?.authorityDigest === expected.digest ? head.cacheHead.manifestDigest : null;
        const wantedPreferences = preferences?.digest ?? null;
        progress.ready = wantedCalendar === progress.calendarDigest && wantedPreferences === progress.preferencesDigest;
      }
      port.assertOwner(); await client.publish(root, scope, progress);
      last = { scopeKey, progress };
      await transport.acknowledge(userId, 0);
    });
    confirmations = run.catch(error => {
      checkedPolicy = undefined;
      // Reuse the foreground observer's existing reconnect backoff for unfinished receipt work.
      reportFailure(error);
    });
    return run;
  }
  return {
    async remember(expected, id, value) { const transport = await current(expected); await transport.archive.saveChunk(id, value); port.assertOwner(); },
    async recover(expected, id) { const transport = await current(expected); const value = await transport.snapshotChunk(userId, id, 0); port.assertOwner(); return value; },
    confirm: (expected, kind, digest) => report(expected, { kind, digest }),
    prepare: expected => report(expected),
    async has(id) { port.assertOwner(); const stored = await archive.chunk(id); port.assertOwner(); return stored !== null; },
    watch(changed, failed) {
      const observer = { changed, failed }; listeners.add(observer); watchRelay();
      return () => { listeners.delete(observer); if (!listeners.size) { stopRelay?.(); stopRelay = undefined; } };
    },
  };
}
