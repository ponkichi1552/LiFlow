import * as liveMigration from '../../src/features/sharing/v2/live-legacy-migration.ts';
import { createDatabase } from './sqlite.mjs';
import { loadNativeModule } from './native-module.mjs';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import * as operations from '../../src/features/sharing/operations.ts';
import * as keys from '../../src/features/sharing/crypto.ts';
import * as rosters from '../../src/features/sharing/roster.ts';
import * as invitations from '../../src/features/sharing/invitations.ts';
import * as groupClock from '../../src/features/sharing/group-clock.ts';
import * as selection from '../../src/features/sharing/workspace-selection.ts';
import * as protocols from '../../src/features/sharing/workspace-protocol.ts';
import * as synchronizer from '../../src/features/sharing/synchronizer.ts';
import * as access from '../../src/features/sharing/access-state.ts';
import * as contracts from '../../src/features/sharing/cloud-contract.ts';
import * as manager from '../../src/features/sharing/group-manager.ts';
import * as sessionFactory from '../../src/features/sharing/v2/workspace-session.ts';
import * as point from '../../src/features/sharing/v2/view-point.ts';
import * as controllerAccess from '../../src/features/sharing/v2/controller-access.ts';
import * as rollout from '../../src/features/sharing/rollout.ts';
import * as registry from '../../src/platform/storage/sharing-registry.ts';
import * as ledger from '../../src/platform/storage/sharing-ledger.ts';
import { createV2ReminderStore } from '../../src/platform/storage/sharing-v2-reminders.ts';
import { createV2ReminderRuntime } from '../../src/features/sharing/v2/reminder-runtime.ts';
import { addDays } from '../../src/domain/scheduling/local-date.ts';

/** Real signatures, event repository and SQLite; only native handles/account storage/cloud I/O are injected. */
export async function workspaceHarness({ pending = false, version = 2, cloud: overrides = {}, deferWorkspaceTimers = false, privateCalendarNeeded = false, initiallyEmpty = false } = {}) {
  const handles = []; const calls = []; const cloudOptions = []; const reminderCalls = []; const taskCalls = []; const taskControl = { revision: 0, label: null, state: null }; let ordinal = 0;
  const create = () => { const h = createDatabase(); let closed = false;
    h.database.closeAsync = async () => { if (!closed) { closed = true; h.connection.close(); } }; handles.push(h); return h; };
  const index = create(); await registry.initializeSharingRegistry(index.database);
  const owner = await keys.createDeviceIdentity(crypto); const identity = pending ? await keys.createDeviceIdentity(crypto) : owner;
  const initial = rosters.createSharedRoster('native-v2-workspace', 'owner', owner, { schemaVersion: version });
  const userId = pending ? 'member' : 'owner'; const auth = { uid: userId }; const vault = new Map(); const groupKeys = new Map();
  const link = pending ? await invitations.createSharedInvitation(crypto, initial, owner, 'join-native', Date.now()) : null;
  const request = link ? invitations.createSharedJoinRequest(link, userId, identity, Date.now()) : null;
  const record = { userId, groupId: initial.body.groupId, displayName: '登録した共有グループ', status: pending ? 'joining' : 'creating',
    anchor: link?.invitation.body.pin ?? initial, rosterArchive: pending ? [] : [initial], createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null,
    ...(pending ? { join: { invitation: link.invitation, request } } : { creation: { wrappedKey: {}, kind: 'roommates', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-28', ownerDisplayName: '自分' } }) };
  if (!initiallyEmpty) await registry.saveSharingWorkspace(index.database, record);
  const cloud = { submitJoinRequest: async () => { calls.push('join'); }, readInvitation: async () => ({ status: 'open' }),
    readMembership: async () => null, bindMembership: async () => {}, readGroup: async () => { throw Object.assign(new Error('waiting for approval'), { code: 'permission-denied' }); },
    createGroup: async () => { calls.push('create-cloud'); }, readRoster: async () => initial,
    watch: () => () => {}, ...overrides };
  const api = loadNativeModule('src/platform/sharing/workspaces.ts', {
    'expo-crypto': { randomUUID: () => `native-${++ordinal}` }, 'expo-sqlite': { openDatabaseAsync: async () => index.database },
    './firebase-services.ts': { isSharingConfigured: () => true, getSharingServices: () => ({ firestore: {}, auth: {
      authStateReady: async () => {}, get currentUser() { return auth.uid ? { uid: auth.uid, displayName: '自分' } : null; } } }) },
    './native-crypto.ts': { nativeSharingCrypto: crypto },
    './secure-store.ts': { loadOrCreateSharingDeviceIdentity: async () => identity,
      loadSharingGroupKey: async (_uid, _group, version) => { calls.push('read-key'); return groupKeys.get(version)?.slice() ?? null; },
      saveSharingGroupKey: async (_uid, _group, version, bytes) => { groupKeys.set(version, bytes.slice()); },
      sharingSecureVault: { getItem: async (key) => vault.get(key) ?? null, setItem: async (key, value) => vault.set(key, value), removeItem: async (key) => vault.delete(key) } },
    './database-location.ts': { sharingDatabaseDirectory: async () => '/protected', openSharingDatabase: async () => { calls.push('legacy-open'); throw new Error('v2 must not open a legacy database'); },
      openSharingV2Database: async (...scope) => { calls.push(['v2-open', ...scope]); return create().database; } },
    './firestore-cloud.ts': { createSharingCloud: (_store, _uid, _guard, options) => { cloudOptions.push(options); cloud.ownerRecoveryEnabled = options?.ownerRecoveryEnabled ?? false; return cloud; } }, '../../features/sharing/roster.ts': rosters,
    '../../features/sharing/rollout.ts': rollout,
    '../../features/sharing/v2/live-legacy-migration.ts': liveMigration,
    '../../features/sharing/operations.ts': operations, '../../features/sharing/crypto.ts': keys,
    '../../features/sharing/workspace-protocol.ts': protocols, '../../features/sharing/v2/workspace-session.ts': sessionFactory,
    '../../features/sharing/v2/view-point.ts': point, '../../features/sharing/synchronizer.ts': synchronizer,
    '../../features/sharing/v2/controller-access.ts': controllerAccess,
    '../../features/sharing/group-manager.ts': manager, '../../features/sharing/access-state.ts': access,
    '../../features/sharing/invitations.ts': invitations, '../../features/sharing/group-clock.ts': groupClock,
    '../../features/sharing/workspace-selection.ts': selection, '../../features/sharing/cloud-contract.ts': contracts,
    '../../features/sharing/conflict-resolution.ts': {}, '../../features/sharing/planning.ts': {},
    '../storage/sharing-registry.ts': registry, '../storage/sharing-ledger.ts': ledger,
    '../storage/sharing-projection.ts': { initializeSharedProjection: async () => { throw new Error('legacy projection called'); } },
    '../storage/shared-planner-repository.ts': { createSharedPlannerRepository: () => { throw new Error('legacy planner called'); } },
    '../storage/shared-repository-adapter.ts': { registerSharedRepositoryAdapter: () => { throw new Error('legacy adapter registered'); }, sharedRepositoryAdapter: () => null },
    '../storage/repository.ts': { LOCAL_HOUSEHOLD_ID: 'local', withPlannerDatabaseOperation: async (_db, work) => work(), drainPlannerDatabaseOperations: async () => {},
      loadGoogleSyncState: async () => { throw new Error('legacy Google state queried'); } },
    '../../features/google-sync/background-task': { registerGoogleSyncBackgroundTask: async () => {} },
    './private-calendar-sync': { isPrivateCalendarWorkerNeeded: async () => privateCalendarNeeded },
    './v2-reminders': {
      createNativeV2Reminders(input) {
        reminderCalls.push('factory');
        const runtime = createV2ReminderRuntime({ ...input, store: createV2ReminderStore(input.database, input),
          gateway: { async requestPermission() { reminderCalls.push('permission'); return true; }, async hasPermission() { return true; },
            async getScheduledRequests() { return []; }, async schedule() { throw new Error('unexpected reminder creation'); }, async cancel() {} },
          readModel: async now => input.controller.readModel(({ timeZone }) => { const today = groupClock.sharedLocalDate(now, timeZone); return { from: addDays(today, -5), through: addDays(today, 30), asOfDate: today }; }) });
        const synchronize = runtime.synchronize; runtime.synchronize = (...args) => { reminderCalls.push('sync'); return synchronize(...args); }; return runtime;
      },
      async clearInactiveV2Reminders(_allowed, guard = () => {}) { await guard(); reminderCalls.push('clear-inactive'); },
      async clearV2RemindersForScope() { reminderCalls.push('clear-scope'); },
    },
    './v2-google-calendar': { createNativeV2GoogleCalendar: () => ({ synchronize: async () => ({ kind: 'skipped', sent: 0 }) }) },
    './v2-google-tasks': { createNativeV2GoogleTasks(input) {
      taskCalls.push('factory');
      return { async readControl() { await input.assertAccess(); return structuredClone(taskControl); },
        async synchronize(options) { await input.assertAccess(); taskCalls.push(['sync', options]); return { kind: 'success', skipped: true }; } };
    } },
  }, deferWorkspaceTimers ? { setTimeout: () => 1, clearTimeout: () => {} } : {});
  return { api, handles, index, calls, cloudOptions, reminderCalls, taskCalls, taskControl, auth, identity, owner, initial, record, link, request, vault, groupKeys, cloud,
    close: async () => { for (const h of handles) await h.database.closeAsync(); } };
}
