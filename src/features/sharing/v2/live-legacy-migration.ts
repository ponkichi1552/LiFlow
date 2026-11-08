import type { SQLiteDatabase } from 'expo-sqlite';
import type { SharedSyncDependencies } from '../synchronizer.ts';
import { canonicalJson } from '../operations.ts';
import { sharedAuthorIdentity, sharedRosterDigest, upgradeSharedRoster, verifySharedRosterTransition } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../snapshots.ts';
import type { EncryptedSharedSnapshot, VerifiedSharedSnapshot } from '../snapshots.ts';
import { sharedDocumentDigest, wrapGroupKey } from '../crypto.ts';
import { bindLegacyMigrationWitness, verifyLegacyMigrationSource, verifiedLegacyMigrationPin } from './legacy-migration-source.ts';
import { prepareLegacyMigrationPlan, validateLegacyMigrationPlan } from './legacy-migration-plan.ts';
import type { LegacyMigrationChoreChoice, LegacyMigrationPlan } from './legacy-migration-plan.ts';
import { createGroupPolicy } from './model.ts';
import type { GroupKind } from './model.ts';
import { createV2LegacyMigrationStager } from '../../../platform/storage/sharing-v2-legacy-migration.ts';
import { loadPublishedSharedReplica, loadSharedFacts, readSharingCheckpoint, withSharingLedgerTransaction } from '../../../platform/storage/sharing-ledger.ts';
import type { SharedReplica } from '../replica.ts';
import { sharedOperationDigest } from '../replica.ts';
import type { SharingWorkspaceRecord } from '../../../platform/storage/sharing-registry.ts';

interface Job {
  id: string; source: EncryptedSharedSnapshot; sourceArchive: VerifiedSharedRoster[]; target: VerifiedSharedRoster;
  plan: LegacyMigrationPlan; snapshot: EncryptedSharedSnapshot;
  keys: Awaited<ReturnType<typeof wrapGroupKey>>[];
}
export interface LegacyMigrationReview {
  id: string; kind: GroupKind; historyCount: number; memberCount: number;
  chores: { id: string; name: string; enabled: boolean; intervalDays: number | null; assignees: number }[];
}
export interface LiveLegacyMigrationDependencies extends Omit<SharedSyncDependencies, 'v2'> {
  catchUp(): Promise<unknown>; archive(): readonly VerifiedSharedRoster[];
  makeId(): string; assertAccess(): void;
  openTarget(generation: string): Promise<SQLiteDatabase>;
  /** The prepared key is kept only in the device vault, never in the journal/cloud metadata. */
  readPreparedKey(id: string): Promise<Uint8Array | null>; savePreparedKey(id: string, key: Uint8Array): Promise<void>;
  activate(archive: VerifiedSharedRoster[], migration: { databaseGeneration: string; sourceSnapshotDigest: string; witnessDigest: string }): Promise<void>;
}
const generationFor = (target: VerifiedSharedRoster, localGeneration?: string) => `upgrade.${sharedRosterDigest(target)}${localGeneration ? `.${localGeneration}` : ''}`;
export const legacyMigrationDatabaseGeneration = generationFor;
/** Opening and pinning must use the same existing generation, including an earlier approved conversion. */
export function v2WorkspaceDatabaseGeneration(record: Pick<SharingWorkspaceRecord, 'localGeneration' | 'v2Migration'>, archive: readonly VerifiedSharedRoster[]): string | undefined {
  if (record.v2Migration) return record.v2Migration.databaseGeneration;
  if (!archive.some(roster => roster.body.schemaVersion === 1)) return record.localGeneration;
  const transition = archive.find(roster => roster.body.schemaVersion === 2);
  if (!transition) throw new Error('v2への移行が完了していません。');
  return generationFor(transition, record.localGeneration);
}

/** Migration is the only remaining writer of legacy operations: it drains pre-existing edits, then freezes them. */
export function createLiveLegacyMigration(deps: LiveLegacyMigrationDependencies) {
  let running: Promise<unknown> | undefined;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    if (running) return Promise.reject(new Error('移行の処理中です。完了をお待ちください。'));
    const task = work(); running = task;
    void task.finally(() => { if (running === task) running = undefined; }).catch(() => undefined); return task;
  };
  async function initialize() {
    deps.assertAccess();
    const record = await deps.readRecord(); deps.assertAccess();
    if (record.status !== 'active') throw new Error('移行するグループの参加状態を確認してください。');
    await deps.database.execAsync('CREATE TABLE IF NOT EXISTS sharing_v2_upgrade_journal (id TEXT PRIMARY KEY, job_json TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0);');
  }
  async function readJob(id?: string): Promise<Job | null> {
    await initialize();
    const row = id ? await deps.database.getFirstAsync<{ job_json: string }>('SELECT job_json FROM sharing_v2_upgrade_journal WHERE id=?', id)
      : await deps.database.getFirstAsync<{ job_json: string }>('SELECT job_json FROM sharing_v2_upgrade_journal ORDER BY rowid DESC LIMIT 1');
    deps.assertAccess(); return row ? JSON.parse(row.job_json) : null;
  }
  async function bind(job: Job) {
    const sourceRoster = job.sourceArchive.at(-1)!;
    verifySharedRosterTransition(sourceRoster, job.target);
    const sourceKey = await deps.readKey(sourceRoster.body.keyVersion); deps.assertAccess();
    if (!sourceKey) throw new Error('元の共有鍵を確認してから再開してください。');
    try {
      const checkpoint = await verifyLegacyMigrationSource({ crypto: deps.crypto, encrypted: job.source, key: sourceKey,
        anchor: job.sourceArchive[0], archive: job.sourceArchive, expectedSnapshotDigest: job.plan.sourcePin.sourceSnapshotDigest,
        expectedThroughSequence: job.source.manifest.body.throughSequence, pendingLocalOperationIds: [] });
      deps.assertAccess();
      const bound = bindLegacyMigrationWitness(checkpoint, job.target, deps.identity, job.plan.groupPolicy.kind);
      validateLegacyMigrationPlan(job.plan, bound.checkpoint);
      if (canonicalJson(verifiedLegacyMigrationPin(bound.checkpoint)) !== canonicalJson(job.plan.sourcePin)) throw new Error('移行元の確認情報が変わりました。');
      return bound;
    } finally { sourceKey.fill(0); }
  }
  function review(job: Job): LegacyMigrationReview {
    const definitions = new Map(job.plan.records.map(record => [record.choreId, record]));
    // Display values come from the exact source operations that the signed migration will preserve.
    return { id: job.id, kind: job.plan.groupPolicy.kind, historyCount: job.source.manifest.body.factCount,
      memberCount: job.target.body.members.length, chores: [...definitions.values()].map(record => ({ id: record.choreId, name: record.choreId,
        enabled: record.configuration?.active === true, intervalDays: record.configuration?.intervalDays ?? null,
        assignees: record.configuration?.policy.assignment.memberIds.length ?? 0 })) };
  }
  async function checkedReview(job: Job) {
    const bound = await bind(job); const value = review(job);
    const names = new Map(bound.replica.entities.filter(entity => entity.entityType === 'chore').map(entity => [entity.entityId, entity.fields.name]));
    return { ...value, chores: value.chores.map(chore => ({ ...chore, name: typeof names.get(chore.id) === 'string' ? names.get(chore.id) as string : chore.name })) };
  }
  return {
    resumeReview: () => serial(async () => { const job = await readJob(); return job ? checkedReview(job) : null; }),
    prepare: (kind: GroupKind) => serial(async () => {
      createGroupPolicy(kind); await deps.catchUp(); deps.assertAccess();
      const record = await deps.readRecord(); const archive = [...deps.archive()]; const previous = archive.at(-1)!;
      if (record.status !== 'active' || previous.body.schemaVersion !== 1 || previous.body.ownerUserId !== deps.userId
        || previous.body.ownerDeviceId !== deps.identity.deviceId) throw new Error('旧グループの管理者端末で移行してください。');
      const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
      const metadata = await deps.cloud.readGroup(deps.groupId); deps.assertAccess();
      if (checkpoint.pendingCount || !checkpoint.lastSuccessfulSyncAt || checkpoint.sequence !== metadata.group.headSequence
        || sharedRosterDigest(previous) !== sharedRosterDigest(metadata.roster) || metadata.group.rotationRequired) throw new Error('未送信の変更・参加状態を同期してから移行してください。');
      const replica = await loadPublishedSharedReplica(deps.database, deps.groupId); const facts = await loadSharedFacts(deps.database, deps.groupId);
      const key = await deps.readKey(previous.body.keyVersion); if (!key) throw new Error('元の共有鍵を確認してください。');
      const id = `migration.${deps.makeId()}`; const author = (user: string, device: string, version: number) => sharedAuthorIdentity(archive[version - 1], user, device, version);
      try {
        const source = await createEncryptedSharedSnapshot(deps.crypto, replica, facts, previous, deps.identity, key, `${id}.source`, checkpoint.sequence, author);
        const verified = await verifyLegacyMigrationSource({ crypto: deps.crypto, encrypted: source, key, anchor: archive[0], archive,
          expectedSnapshotDigest: sharedDocumentDigest(source.manifest), expectedThroughSequence: checkpoint.sequence, pendingLocalOperationIds: [] });
        const target = upgradeSharedRoster(previous, deps.identity); const bound = bindLegacyMigrationWitness(verified, target, deps.identity, kind);
        const choices = legacyMigrationChoices(replica, target);
        const plan = prepareLegacyMigrationPlan(bound.checkpoint, { id, userId: deps.userId, groupPolicy: createGroupPolicy(kind), choices, now: new Date((deps.now ?? Date.now)()) });
        const nextKey = await deps.crypto.randomBytes(32);
        try {
          await deps.savePreparedKey(id, nextKey); deps.assertAccess();
          const snapshot = await createEncryptedSharedSnapshot(deps.crypto, bound.replica, bound.snapshot.facts, target, deps.identity, nextKey, `${id}.target`, checkpoint.sequence, author);
          const keys = [];
          for (const member of target.body.members) for (const device of member.devices) keys.push(await wrapGroupKey(deps.crypto, deps.groupId, target.body.keyVersion, nextKey, deps.identity, device.identity, member.userId));
          const job: Job = { id, source, sourceArchive: archive, target, plan, snapshot, keys };
          await initialize(); await deps.database.runAsync('INSERT INTO sharing_v2_upgrade_journal (id,job_json) VALUES (?,?)', id, canonicalJson(job));
          deps.assertAccess(); return checkedReview(job);
        } finally { nextKey.fill(0); }
      } finally { key.fill(0); }
    }),
    commit: (id: string) => serial(async () => {
      const job = await readJob(id); if (!job) throw new Error('移行の確認内容を開き直してください。');
      const bound = await bind(job); const archive = [...job.sourceArchive, job.target]; const generation = generationFor(job.target, (await deps.readRecord()).localGeneration);
      const key = await deps.readPreparedKey(id); deps.assertAccess();
      if (!key || key.length !== 32) throw new Error('この端末の移行鍵を確認できません。元のデータは保持しています。');
      try {
        await openEncryptedSharedSnapshot(deps.crypto, job.snapshot, key, job.target,
          (user, device, version) => sharedAuthorIdentity(archive[version - 1], user, device, version));
        deps.assertAccess();
        const metadata = await deps.cloud.readGroup(deps.groupId); deps.assertAccess();
        const alreadyCommitted = sharedRosterDigest(metadata.roster) === sharedRosterDigest(job.target);
        if (!alreadyCommitted) {
          validateLegacyMigrationPlan(job.plan, bound.checkpoint, new Date((deps.now ?? Date.now)()));
          if (sharedRosterDigest(metadata.roster) !== sharedRosterDigest(job.sourceArchive.at(-1)!)
            || metadata.group.headSequence !== job.source.manifest.body.throughSequence) throw new Error('確認後に共有内容が変わりました。最新の内容で移行を準備し直してください。');
        }
        const database = await deps.openTarget(generation);
        try {
          const stager = createV2LegacyMigrationStager(database, { checkpoint: bound.checkpoint, plan: job.plan,
            userId: deps.userId, groupId: deps.groupId, householdId: 'shared-v2', identity: deps.identity, archive: () => archive,
            assertAccess: deps.assertAccess, now: () => new Date((deps.now ?? Date.now)()) });
          await stager.stage(); deps.assertAccess();
        } finally { await database.closeAsync(); }
        await deps.database.runAsync('UPDATE sharing_v2_upgrade_journal SET reviewed=1 WHERE id=?', id);
        if (!alreadyCommitted) {
          await deps.cloud.prepareSnapshot(job.snapshot, job.target); deps.assertAccess();
          await deps.cloud.commitMembership(job.sourceArchive.at(-1)!, job.target, job.keys, job.source.manifest.body.throughSequence, job.snapshot.manifest);
          deps.assertAccess();
        }
        // If the commit response was lost, a retry confirms the exact signed target before using this prepared key.
        await deps.saveKey(job.target.body.keyVersion, key); deps.assertAccess();
        await deps.activate(archive, { databaseGeneration: generation, ...job.plan.sourcePin }); deps.assertAccess();
      } finally { key.fill(0); }
    }),
  };
}

/** Suggestions are displayed for explicit review; old history/performers are never rewritten as new v2 completions. */
export function legacyMigrationChoices(replica: SharedReplica, roster: VerifiedSharedRoster): LegacyMigrationChoreChoice[] {
  const settings = replica.entities.find(entity => entity.entityType === 'settings' && entity.entityId === 'settings' && !entity.deleted);
  const members = new Set(roster.body.members.map(member => member.userId));
  return replica.entities.filter(entity => entity.entityType === 'chore' && !entity.deleted && entity.fields.archived !== true).map(chore => {
    if (chore.fields.enabled !== true) return { choreId: chore.entityId, kind: 'keepDisabled' };
    const baseline = replica.entities.find(entity => entity.entityType === 'baseline' && entity.entityId === chore.entityId && !entity.deleted);
    const anchor = baseline?.fields.initialScheduledDate ?? settings?.fields.anchorDate;
    const frequencies = chore.fields.frequencyDaysByMode as Record<string, number> | undefined;
    const mode = typeof settings?.fields.frequencyMode === 'string' ? settings.fields.frequencyMode : 'balanced';
    const interval = chore.fields.userIntervalDays ?? chore.fields.recommendedCycleDays ?? frequencies?.[mode] ?? chore.fields.manufacturerRecommendedIntervalDays ?? (chore.fields.everyday === true ? 1 : undefined);
    const radius = chore.fields.windowRadiusDays;
    const assignees = [...new Set(replica.entities.filter(entity => entity.entityType === 'assignment' && !entity.deleted && entity.fields.choreId === chore.entityId)
      .flatMap(entity => Array.isArray(entity.fields.memberIds) ? entity.fields.memberIds.filter((id): id is string => typeof id === 'string' && members.has(id)) : []))].sort();
    if (typeof anchor !== 'string' || typeof interval !== 'number' || typeof radius !== 'number') throw new Error('周期・基準日・実施期間が未設定の家事があります。移行内容を確認してください。');
    return { choreId: chore.entityId, kind: 'configure', configuration: { policy: { completion: 'one', assignment: { mode: assignees.length ? 'selected' : 'open', memberIds: assignees } },
      anchorDate: anchor as import('../../../domain/shared/types.ts').LocalDate, intervalDays: interval, windowBeforeDays: radius, windowAfterDays: radius, active: true } };
  });
}

/** A signed owner snapshot still may not erase originals this receiving device already accepted. */
export async function verifyKnownLegacyHistory(database: SQLiteDatabase, groupId: string, snapshot: VerifiedSharedSnapshot) {
  await withSharingLedgerTransaction(database, async transaction => {
    const facts = await transaction.getAllAsync<{ operation_json: string }>('SELECT operation_json FROM sharing_operations WHERE group_id=?', groupId);
    const incoming = new Map(snapshot.base.operationIndex.map(entry => [entry.operationId, entry]));
    const pending = await transaction.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sharing_outbox q JOIN sharing_operations o USING(operation_id) WHERE o.group_id=?', groupId);
    if (pending?.count) throw new Error('移行前の未送信変更がこの端末に残っています。保持した内容を管理者と確認してください。');
    for (const row of facts) {
      const operation = JSON.parse(row.operation_json); const receipt = incoming.get(operation.operationId);
      if (!receipt || receipt.deviceId !== operation.authorDeviceId || receipt.sequence !== operation.deviceSequence || receipt.digest !== sharedOperationDigest(operation)) throw new Error('受信済みの元の履歴が移行データに含まれていません。元の保存先を保持しています。');
    }
    const saved = await transaction.getFirstAsync<{ snapshot_json: string }>('SELECT snapshot_json FROM sharing_snapshot_state WHERE group_id=?', groupId);
    if (saved) {
      const old = JSON.parse(saved.snapshot_json) as VerifiedSharedSnapshot; const index = new Map(snapshot.base.operationIndex.map(value => [value.operationId, canonicalJson(value)]));
      for (const entry of old.base.operationIndex) if (index.get(entry.operationId) !== canonicalJson(entry)) throw new Error('保存済みの履歴番号が移行後の履歴と一致しません。');
    }
  });
}
