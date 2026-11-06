import { randomUUID } from 'expo-crypto';
import { createAccountDeviceController } from '../../features/sharing/account-device-controller.ts';
import type { AccountDeviceRestoreMetadata } from '../../features/sharing/account-device-controller.ts';
import { validateAccountDeviceRestorePending } from '../../features/sharing/account-device-restore.ts';
import type { AccountDeviceRestorePending } from '../../features/sharing/account-device-restore.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { sharedRosterDigest, validateSharedRoster } from '../../features/sharing/roster.ts';
import { readCloudWorkspaceArchive } from '../../features/sharing/workspace-protocol.ts';
import { resolveSharedGroupKey } from '../../features/sharing/account-device-key-continuity.ts';
import { readSharingWorkspace, saveSharingWorkspace, updateSharingWorkspace } from '../storage/sharing-registry.ts';
import type { SharingWorkspaceRecord } from '../storage/sharing-registry.ts';
import { createAccountDeviceApi } from './account-device-api.ts';
import { getSharingServices, isSharingConfigured } from './firebase-services.ts';
import { createSharingCloud } from './firestore-cloud.ts';
import { nativeSharingCrypto } from './native-crypto.ts';
import { loadOrCreateSharingDeviceIdentity, loadSharingGroupKey, saveSharingGroupKey, sharingSecureVault } from './secure-store.ts';
import { currentSharingWorkspace, notifySharingWorkspaceChanged, sharingRegistryDatabase } from './workspaces.ts';

type RestoreStatus = { userId: string; phase: 'waiting' | 'failed' } | null;
let status: RestoreStatus = null;
const listeners = new Set<() => void>();
export function accountDeviceRestoreStatus(userId: string | null): RestoreStatus { return status?.userId === userId ? status : null; }
export function subscribeAccountDeviceRestoreStatus(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function updateStatus(value: RestoreStatus) {
  if (canonicalJson(status) === canonicalJson(value)) return;
  status = value; for (const listener of listeners) try { listener(); } catch { /* Presentation never changes a committed restore. */ }
}
const attempts = new Map<string, Promise<string>>();
/** Separate from the first local frame. Both foreground and the one OS worker use this same coordinator. */
export function syncAccountDeviceRestoration(budgetMs = 20_000): Promise<string> {
  const url = process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL?.trim();
  if (!url || !isSharingConfigured()) return Promise.resolve('disabled');
  const user = getSharingServices().auth.currentUser;
  if (!user || user.isAnonymous) return Promise.resolve('absent');
  const running = attempts.get(user.uid); if (running) return running;
  const deadline = Date.now() + Math.max(1000, Math.min(budgetMs, 30_000));
  const temporaryKeys: Uint8Array[] = [];
  const assertCurrent = () => {
    if (getSharingServices().auth.currentUser !== user || Date.now() >= deadline) throw new Error('Account restoration session changed or timed out');
  };
  const task = (async () => {
    const local = await currentSharingWorkspace(); assertCurrent();
    if (local && local.status !== 'active') return 'absent'; // Never replace a manual invitation or unfinished creation.
    const registry = await sharingRegistryDatabase(); assertCurrent();
    const identity = await loadOrCreateSharingDeviceIdentity(user.uid, local?.localGeneration); assertCurrent();
    const cloud = createSharingCloud(getSharingServices().firestore, user.uid, () => getSharingServices().auth.currentUser === user ? user.uid : null);
    const pendingKey = `account-group-restore:${user.uid}`;
    let activeGroupId: string | undefined;
    const readSavedKey = async (version: number, metadata: AccountDeviceRestoreMetadata) => {
      assertCurrent(); const groupId = metadata.archive.at(-1)!.body.groupId;
      const saved = await loadSharingGroupKey(user.uid, groupId, version); if (saved) temporaryKeys.push(saved); assertCurrent(); if (saved) return saved;
      // A sponsor may already hold an earlier continuous epoch. Missing keys on
      // an approved recipient are delivered by another same-account device.
      const epoch = metadata.archive.find(epoch => epoch.body.keyVersion === version);
      if (!epoch) throw new Error('Missing account restoration epoch');
      try {
        return await resolveSharedGroupKey({ crypto: nativeSharingCrypto, userId: user.uid, identity, archive: metadata.archive, epoch,
          readKey: async value => { assertCurrent(); const result = await loadSharingGroupKey(user.uid, groupId, value); if (result) temporaryKeys.push(result); assertCurrent(); return result; },
          saveKey: async (value, key) => { assertCurrent(); await saveSharingGroupKey(user.uid, groupId, value, key); assertCurrent(); },
          readEnvelope: async value => { assertCurrent(); const result = await cloud.readGroupKey(groupId, value, identity.deviceId); assertCurrent(); return result; } });
      } catch (error) {
        assertCurrent();
        if ((error as { code?: string })?.code === 'not-found' || error instanceof Error && error.message === 'Missing device key envelope') return null;
        throw error;
      }
    };
    const controller = createAccountDeviceController({ userId: user.uid, identity, crypto: nativeSharingCrypto, assertCurrent,
      api: createAccountDeviceApi({ url, userId: user.uid, assertCurrent, getToken: () => user.getIdToken(), budgetMs: Math.min(15_000, budgetMs) }),
      newRequestId: () => `restore.${randomUUID()}`,
      loadPending: async () => { const raw = await sharingSecureVault.getItem(pendingKey); assertCurrent(); return raw ? validateAccountDeviceRestorePending(JSON.parse(raw), user.uid) : null; },
      savePending: async pending => { assertCurrent(); await sharingSecureVault.setItem(pendingKey, canonicalJson(pending)); assertCurrent();
        void import('../../features/google-sync/background-task').then(module => module.registerGoogleSyncBackgroundTask()).catch(() => undefined); },
      clearPending: async () => { assertCurrent(); await sharingSecureVault.removeItem(pendingKey); assertCurrent(); },
      discover: async (pending: AccountDeviceRestorePending | null) => {
        const groupId = await cloud.readMembership(); assertCurrent(); if (!groupId) return null;
        if (local && local.groupId !== groupId || pending && pending.request.body.groupId !== groupId) throw new Error('Account group changed during restoration');
        const historical = await readSharingWorkspace(registry, user.uid, groupId); assertCurrent();
        if (historical && ['left', 'removed'].includes(historical.status)) return null;
        const { group, roster } = await cloud.readGroup(groupId); assertCurrent();
        if (roster.body.schemaVersion !== 2) return null;
        let trusted = historical;
        if (!trusted) {
          const anchor = pending?.anchor ?? validateSharedRoster(await cloud.readRoster(groupId, 1)); assertCurrent();
          if (anchor.body.revision !== 1 || anchor.body.groupId !== groupId) throw new Error('Invalid account membership anchor');
          trusted = { userId: user.uid, groupId, displayName: '共有グループ', status: 'active', anchor, rosterArchive: [anchor],
            createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null };
        }
        const archive = await readCloudWorkspaceArchive(trusted, roster, cloud.readRoster); assertCurrent();
        activeGroupId = groupId;
        if (!historical) updateStatus({ userId: user.uid, phase: 'waiting' });
        return { group, archive };
      },
      minimum: async metadata => {
        if (!metadata.group.snapshotId) return 1;
        const manifest = await cloud.readSnapshotManifest(metadata.archive.at(-1)!.body.groupId, metadata.group.snapshotId, metadata.archive); assertCurrent();
        if (manifest.body.throughSequence !== metadata.group.snapshotThroughSequence || manifest.body.keyVersion <= (metadata.group.retentionKeyVersion ?? 0)) throw new Error('Restoration snapshot changed');
        return manifest.body.keyVersion;
      },
      readKey: readSavedKey,
      saveKey: async (groupId, version, key) => { assertCurrent(); if (groupId !== activeGroupId) throw new Error('Restoration group changed'); await saveSharingGroupKey(user.uid, groupId, version, key); assertCurrent(); },
      activate: async metadata => {
        assertCurrent(); const groupId = metadata.archive.at(-1)!.body.groupId;
        const stored = await readSharingWorkspace(registry, user.uid, groupId); assertCurrent();
        if (stored && stored.status !== 'active') throw new Error('Current workspace was left or replaced');
        if (stored && canonicalJson(stored.rosterArchive) === canonicalJson(metadata.archive)) { updateStatus(null); return; }
        const current = await cloud.readGroup(groupId); assertCurrent();
        if (sharedRosterDigest(current.roster) !== sharedRosterDigest(metadata.archive.at(-1)!) || current.group.deviceOwners[identity.deviceId] !== user.uid
          || current.group.revokedUserIds.includes(user.uid) || current.group.rotationRequired) throw new Error('Account device approval changed before activation');
        if (stored) await updateSharingWorkspace(registry, user.uid, groupId, previous => { assertCurrent();
          if (previous.status !== 'active' || previous.localGeneration !== local?.localGeneration) throw new Error('Restoration generation changed');
          return { ...previous, rosterArchive: metadata.archive, lastErrorCode: null }; });
        else {
          const record: SharingWorkspaceRecord = { userId: user.uid, groupId, displayName: '共有グループ', status: 'active', anchor: metadata.archive[0],
            rosterArchive: metadata.archive, createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null };
          assertCurrent(); await saveSharingWorkspace(registry, record);
        }
        assertCurrent(); updateStatus(null); notifySharingWorkspaceChanged();
      },
    });
    const result = await controller.run(); assertCurrent();
    if (result === 'waiting') updateStatus({ userId: user.uid, phase: 'waiting' }); else updateStatus(null);
    return result;
  })().finally(() => { for (const key of temporaryKeys) key.fill(0); }).catch(error => {
    if (getSharingServices().auth.currentUser === user && status?.userId === user.uid) updateStatus({ userId: user.uid, phase: 'failed' });
    throw error;
  });
  attempts.set(user.uid, task);
  void task.finally(() => { if (attempts.get(user.uid) === task) attempts.delete(user.uid); }).catch(() => undefined); return task;
}

export function startAccountDeviceForeground(userId: string): () => void {
  if (!process.env.EXPO_PUBLIC_SHARING_ACCOUNT_DEVICE_API_URL?.trim() || !isSharingConfigured()) return () => {};
  const user = getSharingServices().auth.currentUser; if (user?.uid !== userId) return () => {};
  let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let requested = false, running = false;
  const live = () => !stopped && getSharingServices().auth.currentUser === user;
  const schedule = (delay: number) => { clearTimeout(timer); if (live()) timer = setTimeout(() => { void run(); }, delay); };
  const run = async () => {
    if (!live()) return; if (running) { requested = true; return; }
    running = true; requested = false;
    try {
      const result = await syncAccountDeviceRestoration(); failures = 0;
      if (live()) {
        if (requested || result === 'sent') schedule(250);
        else if (result === 'waiting') schedule(5_000);
        else clearTimeout(timer); // The existing shared coordinator owns the 10-minute fallback.
      }
    } catch { failures++; if (live()) schedule(Math.min(10 * 60_000, 5_000 * 2 ** Math.min(failures, 6))); }
    finally { running = false; }
  };
  const cloud = createSharingCloud(getSharingServices().firestore, userId, () => live() ? userId : null);
  let initialSignal = true;
  const unsubscribe = cloud.watchAccountDeviceRestores(() => {
    if (initialSignal) { initialSignal = false; return; }
    if (running) requested = true; else schedule(250);
  }, () => schedule(30_000));
  void run();
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
}
