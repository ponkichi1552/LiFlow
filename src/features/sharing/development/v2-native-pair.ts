import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../crypto';
import { encryptSharedOperation, sharedDocumentDigest, signSharedDocument, wrapGroupKey } from '../crypto.ts';
import { createSharedRoster } from '../roster.ts';
import { createSharedInvitation, createSharedJoinRequest } from '../invitations.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { readCloudWorkspaceArchive, verifyWorkspaceArchive } from '../workspace-protocol.ts';
import type { SharedSyncDependencies, SharingCloud } from '../synchronizer';
import { createV2WorkspaceSession } from '../v2/workspace-session.ts';
import type { V2WorkspaceSession } from '../v2/workspace-session';
import { guardV2GroupController } from '../v2/controller-access.ts';
import { sharedAccessDisposition } from '../access-state.ts';
import { chorePolicyFromPreset } from '../v2/model.ts';
import { createV2ScreenSession } from '../v2-ui/screen-session.ts';
import { initializeSharingRegistry, readSharingWorkspace, saveSharingWorkspace, updateSharingWorkspace } from '../../../platform/storage/sharing-registry.ts';
import { listSharingOutbox, loadSharedFacts } from '../../../platform/storage/sharing-ledger.ts';
import { v2AuthorProofDigest } from '../v2/server-receipts.ts';

export const V2_PAIR_PROJECT = 'demo-liflow-v2-native';
export type V2PairRole = 'owner' | 'member';
export function v2PairScope(development: boolean, run: unknown, role: unknown) {
  if (!development || typeof run !== 'string' || !/^[a-z][a-z0-9-]{2,47}$/u.test(run) || typeof role !== 'string' || !['owner', 'member'].includes(role)) throw new Error('開発用の検査領域を確認してください。');
  return Object.freeze({ run, role: role as V2PairRole, groupId: `development-v2-pair-${run}`, userId: `development-v2-pair-${run}-${role}`,
    ownerId: `development-v2-pair-${run}-owner`, memberId: `development-v2-pair-${run}-member`, inviteId: `development-v2-invite-${run}` });
}

/** Strict Emulator only. The public fixture invitation seed is NEVER a production invitation secret. */
export async function createV2NativePair(input: {
  development: boolean; projectId: string; run: string; role: V2PairRole; database: SQLiteDatabase; registry: SQLiteDatabase;
  identity: DeviceSecretIdentity; crypto: SharingCryptoGateway; cloud: SharingCloud;
  readKey: SharedSyncDependencies['readKey']; saveKey: SharedSyncDependencies['saveKey']; serialized: SharedSyncDependencies['serialized'];
  makeId: () => string; now: () => Date; invitationSeed: Uint8Array;
}) {
  const scope = v2PairScope(input.development, input.run, input.role);
  if (input.projectId !== V2_PAIR_PROJECT || input.registry === input.database || input.invitationSeed.length !== 32) throw new Error('検査用の独立したEmulator・保存先が必要です。');
  let closed = false; let session: V2WorkspaceSession | undefined; let opening: Promise<V2WorkspaceSession> | undefined;
  const listeners = new Set<() => void>(); const changed = () => { for (const listener of listeners) listener(); };
  const check = () => { if (closed || !input.development) throw new Error('検査接続は閉じています。'); };
  check(); await initializeSharingRegistry(input.registry);
  const readRecord = async () => { check(); const record = await readSharingWorkspace(input.registry, scope.userId, scope.groupId); check();
    if (!record) throw new Error('先に作成または参加申請を保存してください。'); return record; };
  const update = (change: Parameters<typeof updateSharingWorkspace>[3]) => updateSharingWorkspace(input.registry, scope.userId, scope.groupId, record => { check(); return change(record); });
  async function open() {
    check(); if (session) return session;
    if (opening) return opening;
    opening = (async () => {
      let record = await readRecord(); let archive = verifyWorkspaceArchive(record);
      if (!archive) {
        archive = await readCloudWorkspaceArchive(record, (await input.cloud.readGroup(scope.groupId)).roster, input.cloud.readRoster);
        record = await update(prior => ({ ...prior, rosterArchive: archive! }));
      }
      const value = await createV2WorkspaceSession({ database: input.database, householdId: 'development-v2-pair', groupId: scope.groupId, userId: scope.userId,
        identity: input.identity, crypto: input.crypto, cloud: input.cloud, readRecord, archive: () => archive!,
        saveArchive: async next => {
          check(); await update(prior => {
            if ((prior.rosterArchive.at(-1)?.body.revision ?? 0) > next.at(-1)!.body.revision) throw new Error('Membership changed concurrently');
            return { ...prior, rosterArchive: next };
          }); archive = next;
        }, readKey: input.readKey, saveKey: input.saveKey, serialized: input.serialized, changed,
        assertCurrentAccount: check, assertWritable: check, makeId: input.makeId, now: () => input.now().getTime(),
        markLeft: async () => { await update(prior => ({ ...prior, status: 'left' })); }, afterCommit: changed,
        ...(record.creation ? { creationKind: record.creation.kind } : {}) });
      check(); session = { ...value, controller: guardV2GroupController(value.controller, value.assertCurrentAccess) }; return session;
    })();
    try { return await opening; } finally { opening = undefined; }
  }
  async function synchronize() {
    const value = await open(); const current = await readRecord();
    if (current.status === 'creating') {
      if (!current.creation) throw new Error('作成の準備を確認してください。');
      await input.cloud.createGroup(verifyWorkspaceArchive(current)!.at(-1)!, current.creation.wrappedKey);
      await update(prior => ({ ...prior, status: 'active' }));
    }
    try {
      let result = await value.synchronizer.sync({ force: true, budgetMs: 120_000 }); check();
      if (result.complete && !result.waitingForApproval) {
        const state = await value.repository.readState();
        if (!state.assessment.view.ofType('member').some(fact => fact.entityId === scope.userId && typeof fact.payload.displayName === 'string')) {
          await value.repository.commit([{ operationId: input.makeId(), entityType: 'member', entityId: scope.userId, operationType: 'patch',
            payload: { userId: scope.userId, displayName: scope.role === 'owner' ? '検査用所有者' : '検査用メンバー' } }]);
          result = await value.synchronizer.sync({ force: true, budgetMs: 120_000 });
        }
        await update(prior => ({ ...prior, status: 'active', lastSuccessfulSyncAt: input.now().getTime(), lastErrorCode: null }));
      }
      changed(); return result;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'sharing/failed';
      const record = await readRecord(); const disposition = sharedAccessDisposition({ errorCode: code, currentAccountUserId: scope.userId,
        userId: scope.userId, deviceId: input.identity.deviceId, status: record.status, roster: verifyWorkspaceArchive(record)?.at(-1) });
      let removed = disposition === 'removed';
      if (disposition === 'check-membership') try { removed = !await input.cloud.hasMembership(scope.groupId); } catch { /* Offline does not prove removal. */ }
      await update(prior => ({ ...prior, ...(removed ? { status: 'removed' as const } : {}), lastErrorCode: code }));
      changed(); throw error;
    }
  }
  return {
    scope,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prepareOwner() {
      check(); if (scope.role !== 'owner') throw new Error('検査用所有者の操作です。');
      if (!await readSharingWorkspace(input.registry, scope.userId, scope.groupId)) {
        const now = input.now(); const roster = createSharedRoster(scope.groupId, scope.userId, input.identity, { schemaVersion: 2 });
        const key = await input.crypto.randomBytes(32);
        try {
          const wrappedKey = await wrapGroupKey(input.crypto, scope.groupId, 1, key, input.identity, input.identity, scope.userId);
          await input.saveKey(1, key); check();
          await saveSharingWorkspace(input.registry, { userId: scope.userId, groupId: scope.groupId, displayName: '開発用・異種OSグループ', status: 'creating',
            anchor: roster, rosterArchive: [roster], createdAt: now.toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null,
            creation: { wrappedKey, timeZone: 'Asia/Tokyo', anchorDate: sharedLocalDate(now, 'Asia/Tokyo'), ownerDisplayName: '検査用所有者', kind: 'family' } });
        } finally { key.fill(0); }
      }
      return synchronize();
    },
    async createInvitation() {
      check(); if (scope.role !== 'owner') throw new Error('検査用所有者の操作です。'); await synchronize();
      if ((await input.cloud.listInvitations(scope.groupId)).some(invitation => invitation.id === scope.inviteId)) return;
      const record = await readRecord(); const archive = verifyWorkspaceArchive(record)!;
      // A known seed is intentional test data. Device identities, group keys and payload nonces still use Native RNG.
      const link = await createSharedInvitation({ ...input.crypto, randomBytes: async size => {
        if (size !== 32) throw new Error('Invalid fixture invitation seed size'); return input.invitationSeed.slice();
      } }, archive.at(-1)!, input.identity, scope.inviteId, input.now().getTime());
      await input.cloud.createInvitation(link.invitation);
    },
    async requestJoin() {
      check(); if (scope.role !== 'member') throw new Error('検査用参加者の操作です。');
      const previous = await readSharingWorkspace(input.registry, scope.userId, scope.groupId);
      if (previous) {
        if (previous.status === 'joining' && previous.join) await input.cloud.submitJoinRequest(previous.join.invitation, previous.join.request);
        return;
      }
      const invitation = (await input.cloud.readInvitation(scope.inviteId)).invitation;
      const seed = Array.from(input.invitationSeed, byte => byte.toString(16).padStart(2, '0')).join('');
      const request = createSharedJoinRequest({ invitation, seed }, scope.userId, input.identity, input.now().getTime());
      await saveSharingWorkspace(input.registry, { userId: scope.userId, groupId: scope.groupId, displayName: '開発用・異種OSグループ', status: 'joining',
        anchor: invitation.body.pin, rosterArchive: [], createdAt: input.now().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null, join: { invitation, request } });
      await input.cloud.submitJoinRequest(invitation, request);
    },
    async approve() {
      check(); if (scope.role !== 'owner') throw new Error('検査用所有者の操作です。'); const value = await open();
      const invitation = (await input.cloud.readInvitation(scope.inviteId)).invitation;
      const requests = await input.cloud.listJoinRequests(invitation);
      const request = requests.requests.find(row => row.body.userId === scope.memberId);
      if (!request || requests.invalidUserIds.length) throw new Error('検査用の参加申請を確認してください。');
      await value.manager.approve(invitation, request); changed();
    },
    synchronize,
    async prepareChores() {
      check(); if (scope.role !== 'owner') throw new Error('検査用所有者の操作です。'); const value = await open();
      const ui = await this.ui(); const model = await ui.readModel({ management: true }); const today = model.plan.range.asOfDate;
      for (const [id, preset] of [['builtin-chore-08', 'common'], ['builtin-chore-14', 'eachMember']] as const) {
        const chore = model.plan.chores.find(row => row.id === `${scope.groupId}.${id}`); if (!chore) throw new Error('検査用の家事が見つかりません。');
        if (!model.configurations.find(row => row.choreId === chore.id)?.configuration) await value.controller.actions.configureChore(chore.id, {
          policy: chorePolicyFromPreset(preset), anchorDate: today, intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, effectiveFrom: today, active: true });
      }
      return synchronize();
    },
    async ui() {
      const value = await open(); return createV2ScreenSession({ controller: { ...value.controller, sync: synchronize }, groupId: scope.groupId, userId: scope.userId, now: input.now,
        readPreferences: () => ({ ownerUserId: scope.userId, settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
    },
    async proof() {
      const ui = await this.ui(); const model = await ui.readModel(); const state = await (await open()).repository.readState();
      return { groupId: scope.groupId, role: scope.role, algorithm: model.plan.algorithm, sourceHash: model.plan.sourceHash, planHash: model.plan.planHash,
        members: model.plan.members.filter(row => row.active).length, pending: model.pendingChanges, receiptPending: model.receiptPending,
        outbox: (await listSharingOutbox(input.database, scope.groupId)).length, rejected: state.assessment.rejected.length,
        receipts: state.receipts.size, keyVersion: state.archive.at(-1)!.body.keyVersion,
        recoveryProofs: state.replica.recoveryWitnesses?.length ?? 0,
        recoveryHeld: state.replica.recoveryWitnesses?.reduce((count, witness) => count + witness.body.entries.filter(entry => entry.classification === 'blockedCausality').length, 0) ?? 0,
        recoveryRestored: state.replica.recoveryWitnesses?.reduce((count, witness) => count + witness.body.entries.filter(entry => entry.classification === 'restoredOriginal').length, 0) ?? 0,
        historyHash: sharedDocumentDigest(model.plan.history), history: model.plan.history.length,
        completed: model.plan.occurrences.flatMap(round => round.subjects.filter(subject => subject.completed).map(subject => subject.id)).sort(),
        chores: model.plan.chores.map(row => ({ id: row.id, name: row.name, enabled: row.enabled })) };
    },
    /** Metadata only, even after removal. Never opens a business controller or relaxes its access guard. */
    async retainedProof() {
      check(); const record = await readRecord();
      const outbox = await listSharingOutbox(input.database, scope.groupId, Number.MAX_SAFE_INTEGER); check();
      return { groupId: scope.groupId, role: scope.role, status: record.status, outbox: outbox.length };
    },
    async recoveryPanel() {
      check(); const value = await open(); const state = await value.repository.readState();
      return { groupId: scope.groupId, recovery: value.recovery,
        isOwner: state.archive.at(-1)!.body.ownerDeviceId === input.identity.deviceId,
        devices: state.archive.at(-1)!.body.members.flatMap(member => member.devices.map(device => ({ deviceId: device.identity.deviceId,
          displayName: member.userId === scope.ownerId ? '検査用所有者' : '検査用メンバー' }))) };
    },
    /** Explicit synthetic attack button; the guarded demo project and separate UIDs never target a real group. */
    async damageTransportForRecovery() {
      check(); await synchronize(); const value = await open();
      const id = `${scope.groupId}.damaged-${scope.role}`;
      await value.repository.commit([{ operationId: id, entityType: 'chore', entityId: `${scope.groupId}.builtin-chore-08`, operationType: 'patch',
        payload: { name: '復旧検査用・床の家事' } }]);
      const fact = (await loadSharedFacts(input.database, scope.groupId)).find(item => item.operation.operationId === id);
      if (!fact) throw new Error('検査用の元の署名を確認できません。');
      const group = (await input.cloud.readGroup(scope.groupId)).group; const key = await input.readKey(group.keyVersion);
      if (!key) throw new Error('先に共有を同期してください。');
      try {
        const sealed = await encryptSharedOperation(input.crypto, fact.operation, key, input.identity, group.keyVersion);
        const { signature: _old, ...body } = sealed;
        body.encryptedPayload = `${body.encryptedPayload.startsWith('00') ? 'ff' : '00'}${body.encryptedPayload.slice(2)}`;
        await input.cloud.upload({ ...body, signature: signSharedDocument(body, input.identity) }, { authorProofDigest: v2AuthorProofDigest(fact) });
      } finally { key.fill(0); }
      check(); changed();
    },
    async removeMember() { check(); if (scope.role !== 'owner') throw new Error('検査用所有者の操作です。'); await (await open()).manager.removeMembers([scope.memberId]); changed(); },
    close() { closed = true; listeners.clear(); },
  };
}
export type V2NativePair = Awaited<ReturnType<typeof createV2NativePair>>;
