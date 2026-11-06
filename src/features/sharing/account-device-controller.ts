import { canonicalJson } from './operations.ts';
import { sharedDocumentDigest, validateDevicePublicIdentity } from './crypto.ts';
import type { DeviceSecretIdentity, SharingCryptoGateway } from './crypto.ts';
import { sharedRosterDigest } from './roster.ts';
import type { VerifiedSharedRoster } from './roster.ts';
import type { SharedCloudGroup } from './cloud-contract.ts';
import { ACCOUNT_DEVICE_RESTORE_SLOTS, ACCOUNT_DEVICE_RESTORE_TTL_MS, accountDeviceRestoreAcknowledgment,
  createAccountDeviceRestoreGrant, createAccountDeviceRestoreRequest, openAccountDeviceRestoreGrant, validateAccountDeviceRestorePending } from './account-device-restore.ts';
import type { AccountDeviceRestorePending, AccountDeviceRestoreReceipt } from './account-device-restore.ts';

export interface AccountDeviceRestoreApi {
  read(groupId: string): Promise<AccountDeviceRestoreReceipt[]>;
  request(input: { groupId: string; slot: number; request: AccountDeviceRestorePending['request']; replaceRequestId: string | null }): Promise<void>;
  accept(input: { groupId: string; slot: number; requestId: string; grant: NonNullable<AccountDeviceRestoreReceipt['grant']> }): Promise<void>;
  acknowledge(input: ReturnType<typeof accountDeviceRestoreAcknowledgment>): Promise<void>;
}
export interface AccountDeviceRestoreMetadata { group: SharedCloudGroup; archive: VerifiedSharedRoster[] }
/** Every port is account-bound. No private identity or plaintext key enters the HTTP API. */
export function createAccountDeviceController(deps: {
  userId: string; identity: DeviceSecretIdentity; crypto: SharingCryptoGateway; api: AccountDeviceRestoreApi;
  assertCurrent(): void; now?(): number; newRequestId(): string;
  loadPending(): Promise<AccountDeviceRestorePending | null>; savePending(value: AccountDeviceRestorePending): Promise<void>; clearPending(): Promise<void>;
  discover(pending: AccountDeviceRestorePending | null): Promise<AccountDeviceRestoreMetadata | null>;
  minimum(metadata: AccountDeviceRestoreMetadata): Promise<number>;
  readKey(version: number, metadata: AccountDeviceRestoreMetadata): Promise<Uint8Array | null>;
  saveKey(groupId: string, version: number, key: Uint8Array): Promise<void>;
  activate(metadata: AccountDeviceRestoreMetadata): Promise<void>;
}) {
  let running: Promise<'absent' | 'waiting' | 'active' | 'restored' | 'sent'> | undefined;
  const now = deps.now ?? Date.now;
  async function work<T>(operation: () => Promise<T>): Promise<T> { deps.assertCurrent(); const result = await operation(); deps.assertCurrent(); return result; }
  async function readOwnedKey(version: number, metadata: AccountDeviceRestoreMetadata) {
    deps.assertCurrent(); const key = await deps.readKey(version, metadata);
    try { deps.assertCurrent(); return key; } catch (error) { key?.fill(0); throw error; }
  }
  async function perform() {
    const saved = await work(deps.loadPending);
    const pending = saved ? validateAccountDeviceRestorePending(saved, deps.userId) : null;
    const metadata = await work(() => deps.discover(pending));
    if (!metadata) return 'absent' as const;
    const { group, archive } = metadata, roster = archive.at(-1)!;
    if (!roster || roster.body.schemaVersion !== 2 || roster.body.closed || group.rotationRequired
      || group.rosterRevision !== roster.body.revision || group.rosterJson !== canonicalJson(roster)
      || group.revokedUserIds.includes(deps.userId)) throw new Error('Account restoration membership changed');
    const member = roster.body.members.find(member => member.userId === deps.userId);
    if (!member) throw new Error('Account is not a current group member');
    const device = member.devices.find(device => device.identity.deviceId === deps.identity.deviceId);
    if (device && canonicalJson(device.identity) !== canonicalJson(validateDevicePublicIdentity(deps.identity))) throw new Error('Current device identity differs');
    const groupId = roster.body.groupId;
    if (pending && (pending.request.body.groupId !== groupId || sharedRosterDigest(pending.anchor) !== sharedRosterDigest(archive[0])
      || sharedRosterDigest(archive[pending.previousRevision - 1]) !== pending.request.body.rosterDigest)) throw new Error('Saved account restoration pin differs');
    const receipts = await work(() => deps.api.read(groupId));
    const own = pending ? receipts.find(row => row.slot === pending.slot && sharedDocumentDigest(row.request) === sharedDocumentDigest(pending.request)) : undefined;
    if (pending && own?.status === 'accepted') {
      const grant = own.grant!, previous = archive[pending.previousRevision - 1];
      // A later owner removal always wins over an earlier, otherwise valid grant.
      if (!device || !archive.some(epoch => sharedRosterDigest(epoch) === sharedRosterDigest(grant.body.roster))) throw new Error('Restored device was removed or group changed');
      if (grant.body.minimumKeyVersion <= (group.retentionKeyVersion ?? 0)) throw new Error('Account restoration keys were retired');
      deps.assertCurrent();
      const opened = await openAccountDeviceRestoreGrant({ crypto: deps.crypto, grant, request: pending.request,
        previous, identity: deps.identity, minimumKeyVersion: grant.body.minimumKeyVersion });
      try {
        deps.assertCurrent();
        for (const [version, key] of opened.keys) await work(() => deps.saveKey(groupId, version, key));
        // Durable keys precede activation; a crash before ACK safely replays this same grant.
        await work(() => deps.activate(metadata));
        await work(() => deps.api.acknowledge(accountDeviceRestoreAcknowledgment(pending, grant, deps.identity)));
        await work(deps.clearPending);
        return 'restored' as const;
      } finally { for (const key of opened.keys.values()) key.fill(0); }
    }
    let currentKey: Uint8Array | null = null;
    if (device) currentKey = await readOwnedKey(roster.body.keyVersion, metadata);
    if (currentKey) {
      if (currentKey.length !== 32) { currentKey.fill(0); throw new Error('Invalid saved group key'); }
      currentKey.fill(0);
      await work(() => deps.activate(metadata));
      if (own?.status === 'acknowledged') await work(deps.clearPending);
      const request = receipts.find(row => row.status === 'requested' && row.request.body.identity.deviceId !== deps.identity.deviceId
        && row.request.body.rosterDigest === sharedRosterDigest(roster) && row.receivedAt <= now() + 30000
        && row.receivedAt + ACCOUNT_DEVICE_RESTORE_TTL_MS > now());
      if (request) {
        const minimumKeyVersion = await work(() => deps.minimum(metadata));
        const { grant } = await work(() => createAccountDeviceRestoreGrant({ crypto: deps.crypto, previous: roster, request: request.request,
          sponsor: deps.identity, userId: deps.userId, minimumKeyVersion, archive,
          readKey: async version => {
            const key = await readOwnedKey(version, metadata);
            // The grant factory copies its input. Wipe this owned temporary after it returns.
            if (key) ownedKeys.push(key); return key;
          } }));
        try { await work(() => deps.api.accept({ groupId, slot: request.slot, requestId: request.request.body.requestId, grant })); }
        finally { for (const key of ownedKeys) key.fill(0); }
        return 'sent' as const;
      }
      return 'active' as const;
    }
    if (own?.status === 'requested' && own.receivedAt + ACCOUNT_DEVICE_RESTORE_TTL_MS > now()
      && own.request.body.rosterDigest === sharedRosterDigest(roster)) return 'waiting' as const;
    // Preserve an ambiguous prior POST and retry its exact nonce. Never multiply pending slots.
    if (pending && !own && pending.request.body.rosterDigest === sharedRosterDigest(roster)) {
      const occupied = receipts.find(row => row.slot === pending.slot);
      await work(() => deps.api.request({ groupId, slot: pending.slot, request: pending.request, replaceRequestId: occupied?.request.body.requestId ?? null }));
      return 'waiting' as const;
    }
    const prior = receipts.find(row => row.request.body.identity.deviceId === deps.identity.deviceId);
    const slot = prior?.slot ?? Array.from({ length: ACCOUNT_DEVICE_RESTORE_SLOTS }, (_, index) => index).find(index => !receipts.some(row => row.slot === index));
    if (slot === undefined) throw new Error('All account restoration slots are occupied');
    const next: AccountDeviceRestorePending = { anchor: archive[0], previousRevision: roster.body.revision, slot,
      request: createAccountDeviceRestoreRequest(roster, deps.userId, deps.identity, deps.newRequestId()) };
    await work(() => deps.savePending(next));
    await work(() => deps.api.request({ groupId, slot, request: next.request, replaceRequestId: prior?.request.body.requestId ?? null }));
    return 'waiting' as const;
  }
  const ownedKeys: Uint8Array[] = [];
  return {
    run() {
      if (running) return running;
      const task = perform().finally(() => { for (const key of ownedKeys) key.fill(0); ownedKeys.length = 0; }); running = task;
      void task.finally(() => { if (running === task) running = undefined; }).catch(() => undefined); return task;
    },
  };
}
