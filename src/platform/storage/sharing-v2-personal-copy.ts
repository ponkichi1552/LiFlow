import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from './sharing-v2-events';
import { prepareV2PersonalCopy, validateV2PersonalCopyReview, validateV2PersonalCopyAgainstSource, v2PersonalCopyDrafts } from '../../features/sharing/v2/personal-copy.ts';
import type { V2PersonalCopyContext, V2PersonalCopyReview, V2PersonalCopySource } from '../../features/sharing/v2/personal-copy';
import { v2ReadPoint } from '../../features/sharing/v2/view-point.ts';
import { sharedRosterDigest } from '../../features/sharing/roster.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';

type Repository = ReturnType<typeof createV2EventRepository>;
type State = Awaited<ReturnType<Repository['readState']>>;
export interface V2PersonalCopyControl {
  revision: number; review: V2PersonalCopyReview | null; status: 'review' | 'committed' | null;
  synchronization: 'pending' | 'sent' | 'needsReview' | null;
}
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A private review and the signed copy commit together. Personal IDs never enter the signed ledger. */
export function createV2PersonalCopyStore(input: { repository: Repository; userId: string; groupId: string;
  assertAccess(): void | Promise<void>; makeId(): string; now(): Date }) {
  const { repository, userId, groupId } = input;
  if (repository.scope.userId !== userId || repository.scope.groupId !== groupId) throw new Error('個人設定をコピーする保存先を確認してください。');
  const context = (state: State): V2PersonalCopyContext => {
    const roster = state.archive.at(-1)!; const at = v2ReadPoint(state.assessment.view, roster);
    const name = state.assessment.view.field('settings', 'settings', 'name', at)?.value;
    const timeZone = state.assessment.view.field('settings', 'settings', 'timeZone', at)?.value;
    if (typeof name !== 'string' || typeof timeZone !== 'string') throw new Error('コピー先のグループ設定を確認してください。');
    return { userId, groupId, administratorUserId: roster.body.ownerUserId, rosterDigest: sharedRosterDigest(roster), groupName: name, timeZone };
  };
  async function initialize(transaction: SQLiteDatabase) {
    await input.assertAccess();
    const binding = await transaction.getFirstAsync<{ user_id: string; group_id: string; schema_version: number }>('SELECT user_id,group_id,schema_version FROM sharing_v2_binding WHERE singleton=1');
    if (binding?.user_id !== userId || binding.group_id !== groupId || binding.schema_version !== 2) throw new Error('個人設定のコピー先が変わりました。');
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_private_copy_review (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0),
      status TEXT CHECK(status IN ('review','committed')), review_json TEXT);`);
    await input.assertAccess();
  }
  function proof(state: State, review: V2PersonalCopyReview) {
    const drafts = v2PersonalCopyDrafts(review);
    const operations = new Map<string, State['replica']['operations'][number]>();
    for (const operation of state.replica.operations) if (!operations.has(operation.operationId)) operations.set(operation.operationId, operation);
    for (const draft of drafts) {
      const actual = operations.get(draft.operationId);
      if (!actual || actual.authorUserId !== userId || actual.entityType !== draft.entityType || actual.entityId !== draft.entityId
        || actual.operationType !== draft.operationType || canonicalJson(actual.payload) !== canonicalJson(draft.payload)) throw new Error('コピー済みの共有記録を確認できません。');
    }
    const ready = new Set(state.assessment.view.ready.map(op => op.operationId));
    if (drafts.some(draft => !ready.has(draft.operationId))) return 'needsReview' as const;
    const pending = new Set(state.assessment.pendingOutboxIds);
    return drafts.some(draft => pending.has(draft.operationId)) ? 'pending' as const : 'sent' as const;
  }
  async function readInside(state: State, transaction: SQLiteDatabase): Promise<V2PersonalCopyControl> {
    await initialize(transaction);
    const row = await transaction.getFirstAsync<{ revision: number; status: string | null; review_json: string | null }>('SELECT revision,status,review_json FROM sharing_v2_private_copy_review WHERE singleton=1');
    if (!row) return { revision: 0, review: null, status: null, synchronization: null };
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || ![null, 'review', 'committed'].includes(row.status)
      || (row.status === null) !== (row.review_json === null)) throw new Error('コピー確認の保存形式を確認してください。');
    const review = row.review_json === null ? null : validateV2PersonalCopyReview(JSON.parse(row.review_json), { userId, groupId });
    const synchronization = row.status === 'committed' ? proof(state, review!) : null;
    return { revision: row.revision, review, status: row.status as V2PersonalCopyControl['status'], synchronization };
  }
  async function write(transaction: SQLiteDatabase, before: V2PersonalCopyControl, status: V2PersonalCopyControl['status'], review: V2PersonalCopyReview | null) {
    const revision = before.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('コピー確認の保存版を確認してください。');
    await input.assertAccess();
    await transaction.runAsync(`INSERT INTO sharing_v2_private_copy_review VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
      revision=excluded.revision,status=excluded.status,review_json=excluded.review_json`, revision, status, review === null ? null : JSON.stringify(review));
    await input.assertAccess(); return { revision, review, status, synchronization: status === 'committed' ? 'pending' as const : null };
  }
  const checkRevision = (revision: number) => { if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('コピー確認の保存版を確認してください。'); };
  const read = () => repository.readCurrent(async (state, transaction) => { await input.assertAccess(); return snapshot(await readInside(state, transaction)); });
  return { scope: Object.freeze({ userId, groupId }), read,
    readContext: () => repository.readCurrent(async state => { await input.assertAccess(); return context(state); }),
    async prepare(expectedRevision: number, source: V2PersonalCopySource, ids: readonly string[], preset: 'common' | 'eachMember') {
      checkRevision(expectedRevision); const captured = snapshot({ source, ids, preset }); let staged: V2PersonalCopyReview | undefined;
      try {
        return await repository.readCurrent(async (state, transaction) => {
          const before = await readInside(state, transaction);
          if (before.revision !== expectedRevision) throw new Error('別の画面でコピー内容が変わりました。保存内容を読み直してください。');
          staged = prepareV2PersonalCopy(captured.source, context(state), captured.ids, captured.preset, input.makeId, input.now());
          return snapshot(await write(transaction, before, 'review', staged));
        });
      } catch (error) {
        const saved = staged ? await read().catch(() => null) : null;
        if (saved?.revision === expectedRevision + 1 && saved.status === 'review' && saved.review?.id === staged?.id && saved.review?.digest === staged?.digest) return saved;
        throw error;
      }
    },
    async confirm(reference: { id: string; digest: string }, source?: V2PersonalCopySource) {
      const captured = snapshot({ reference, source }); let accepted: V2PersonalCopyControl | undefined;
      try {
        await repository.commitCurrent(async (state, transaction) => {
          const before = await readInside(state, transaction); const review = before.review;
          if (!review || review.id !== captured.reference.id || review.digest !== captured.reference.digest) throw new Error('確認したコピー内容を読み直してください。');
          if (before.status === 'committed') { accepted = before; return []; }
          if (state.archive.at(-1)!.body.ownerUserId !== userId) throw new Error('設定をコピーする管理者の権限が変わりました。');
          if (!captured.source) throw new Error('コピー元の個人設定を読み直してください。');
          const checked = validateV2PersonalCopyAgainstSource(review, context(state), captured.source, input.now());
          for (const record of checked.records) if (state.assessment.view.topic('chore', record.sharedChoreId).length) throw new Error('新しい共有家事の番号を確認してください。');
          accepted = await write(transaction, before, 'committed', checked);
          return v2PersonalCopyDrafts(checked);
        });
      } catch (error) {
        // Only an authenticated signed copy plus its atomic private receipt can recover a lost reply.
        const saved = await read().catch(() => null);
        if (saved?.status === 'committed' && saved.review?.id === captured.reference.id && saved.review.digest === captured.reference.digest) return saved;
        throw error;
      }
      if (!accepted) throw new Error('コピーの保存結果を確認できません。'); return snapshot(accepted);
    },
    async clear(expectedRevision: number) {
      checkRevision(expectedRevision);
      return repository.readCurrent(async (state, transaction) => {
        const before = await readInside(state, transaction);
        if (before.revision !== expectedRevision) throw new Error('コピー内容が変わりました。もう一度確認してください。');
        if (!before.review) return before;
        return write(transaction, before, null, null);
      });
    },
  };
}
export type V2PersonalCopyStore = ReturnType<typeof createV2PersonalCopyStore>;
