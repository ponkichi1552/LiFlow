import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events';
import type { createSharedGroupManager } from '../group-manager';
import type { SharedOperation } from '../operations';
import type { AuthenticatedSharedOperation } from '../crypto';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { sharedRosterDigest } from '../roster.ts';
import { compactSharedReplica, buildSharedReplica } from '../replica.ts';
import { v2ReadPoint } from './view-point.ts';
import { planV2HistoryRetention } from './history-retention-plan.ts';
import { retentionCovered, verifyV2RetentionWitness } from './history-retention-certificate.ts';
import type { V2RetentionWitness } from './history-retention-certificate';
import type { V2RetentionBody } from './history-retention-schema';
import { choreHistoryCutoff } from '../../../domain/chores/history-retention.ts';
import { isRetiredBuiltInChore } from '../../../domain/chores/catalog.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { V2_SCHEDULER_VERSION } from './payload-schema.ts';

type Repository = ReturnType<typeof createV2EventRepository>;
type State = Awaited<ReturnType<Repository['readState']>>;
export function v2RetentionHasLateReferences(operations: readonly SharedOperation[], body: V2RetentionBody, removedIds: ReadonlySet<string>) {
  return operations.some(op => !retentionCovered(op, body) && (op.entityType === 'retainedCompletionUndo'
    || typeof op.payload.targetOperationId === 'string' && removedIds.has(op.payload.targetOperationId)
    || typeof op.payload.completionOperationId === 'string' && removedIds.has(op.payload.completionOperationId)));
}
/** Every member recomputes before signing. No owner-supplied summary can authorize deletion alone. */
export function createV2HistoryRetentionRuntime(input: {
  repository: Repository; manager: ReturnType<typeof createSharedGroupManager>;
  sync(options: { force: boolean; budgetMs: number }): Promise<unknown>;
  readHead(): Promise<{ sequence: number; localSequence: number; rotationRequired: boolean; rosterDigest: string }>;
  readOriginals(): Promise<AuthenticatedSharedOperation[]>;
  assertAccess(): Promise<void>; makeId(): string; now?: () => number;
}) {
  const now = input.now ?? Date.now; let running: Promise<{ kind: 'idle' | 'waiting' | 'published' }> | null = null; let deadline = 0;
  const remaining = () => { const left = deadline - now(); if (left < 1000) throw new Error('履歴の整理は次の同期で続けます。'); return left; };
  const cleanState = async () => {
    remaining(); await input.assertAccess(); const state = await input.repository.readState();
    const epoch = state.archive.at(-1)!;
    if (epoch.body.schedulerVersion !== V2_SCHEDULER_VERSION || state.replica.pendingOperationIds.length || state.assessment.pendingOutboxIds.length
      || state.assessment.provisionalOperationIds.length || state.replica.operations.some(op => op.schemaVersion === 2 && !state.receipts.has(op.operationId))) return null;
    const head = await input.readHead(); remaining();
    return head.rotationRequired || head.sequence !== head.localSequence || head.rosterDigest !== sharedRosterDigest(epoch) ? null : { state, head, epoch };
  };
  const derive = async (body: V2RetentionBody) => {
    remaining(); const cut = await input.repository.readRetentionCut(body); remaining();
    const previous = cut.replica.retention?.proposal.operation.payload.checkpoint as unknown as V2RetentionBody | undefined;
    const plan = planV2HistoryRetention({ ...cut, cutoff: body.cutoff, throughSequence: body.throughSequence, previous });
    if (canonicalJson(plan.body) !== canonicalJson(body)) throw new Error('履歴整理の内容が各端末で一致しません。');
    return plan;
  };
  function obsolete(state: State, body: V2RetentionBody, removed: readonly string[]) {
    return v2RetentionHasLateReferences(state.replica.operations, body, new Set(removed));
  }
  return { run(budgetMs = 120_000) {
    if (running) { deadline = Math.min(deadline, now() + budgetMs); return running; }
    deadline = now() + budgetMs;
    const work = (async (): Promise<{ kind: 'idle' | 'waiting' | 'published' }> => {
      for (let stage = 0; stage < 3; stage++) {
        const current = await cleanState(); if (!current) return { kind: 'waiting' };
        const { state, epoch, head } = current; const view = state.assessment.view; const at = v2ReadPoint(view, epoch);
        const zone = view.field('settings', 'settings', 'timeZone', at)?.value; if (typeof zone !== 'string') return { kind: 'waiting' };
        const previous = view.retentionAt(at);
        const proposals = view.ofType('historyRetention').filter(op => op.payload.phase === 'proposal' && op.keyVersion === epoch.body.keyVersion)
          .sort((a, b) => b.logicalClock - a.logicalClock || b.operationId.localeCompare(a.operationId));
        let candidate: { proposal: SharedOperation; body: V2RetentionBody; plan: Awaited<ReturnType<typeof derive>> } | undefined;
        let serverTime: number | undefined;
        for (const proposal of proposals) {
          const body = proposal.payload.checkpoint as unknown as V2RetentionBody; const receipt = state.receipts.get(proposal.operationId);
          if (!receipt || body.rosterDigest !== sharedRosterDigest(epoch)) continue;
          if (body.cutoff > choreHistoryCutoff(sharedLocalDate(new Date(receipt.receivedAtMs), body.timeZone))) { serverTime ??= receipt.receivedAtMs; continue; }
          if (receipt.uploadSequence <= body.throughSequence || previous && (body.cutoff < previous.cutoff || sharedDocumentDigest(body) === sharedDocumentDigest(previous))) continue;
          try { const plan = await derive(body); if (!obsolete(state, body, plan.removedIds)) { candidate = { proposal, body, plan }; break; } }
          catch (error) { remaining(); if (!(error instanceof Error) || !/再同期|新しい履歴|各端末|受付位置/u.test(error.message)) throw error; }
        }
        if (!candidate) {
          if (epoch.body.ownerUserId !== input.repository.scope.userId || epoch.body.ownerDeviceId !== input.repository.scope.deviceId) return { kind: 'idle' };
          const cutoff = choreHistoryCutoff(sharedLocalDate(new Date(serverTime ?? now()), zone));
          if (previous && cutoff < previous.cutoff) return { kind: 'idle' };
          const expired = state.replica.operations.some(op => op.operationType === 'complete' && op.entityType === 'completion'
            && sharedLocalDate(new Date(String(op.payload.completedAt)), zone) < cutoff
            || op.entityType === 'chore' && isRetiredBuiltInChore(op.entityId)
            || op.entityType === 'retainedCompletionUndo' && op.recordedAt && sharedLocalDate(new Date(op.recordedAt), zone) < cutoff);
          if (!expired && !previous?.roundStates.some(row => row.through < cutoff)) return { kind: 'idle' };
          const plan = planV2HistoryRetention({ ...state, cutoff, throughSequence: head.sequence, previous });
          await input.repository.commitCurrent(async latest => {
            if (sharedRosterDigest(latest.archive.at(-1)!) !== sharedRosterDigest(epoch) || canonicalJson(latest.replica.frontier) !== canonicalJson(plan.body.frontier)) throw new Error('履歴整理の対象を再同期してください。');
            const id = input.makeId(); return [{ operationId: id, entityType: 'historyRetention', entityId: id, operationType: 'patch',
              payload: { phase: 'proposal', checkpoint: plan.body } as unknown as SharedOperation['payload'] }];
          });
          await input.sync({ force: true, budgetMs: remaining() }); continue;
        }
        const { proposal, body, plan } = candidate; const receipt = state.receipts.get(proposal.operationId)!;
        const approvals = view.ofType('historyRetention').filter(op => op.payload.phase === 'approve' && op.payload.proposalId === proposal.operationId
          && op.payload.checkpointDigest === sharedDocumentDigest(body) && op.payload.receiptDigest === sharedDocumentDigest(receipt)
          && state.receipts.has(op.operationId));
        if (!approvals.some(op => op.authorUserId === input.repository.scope.userId)) {
          const id = input.makeId();
          await input.repository.commitCurrent(async latest => {
            if (sharedRosterDigest(latest.archive.at(-1)!) !== sharedRosterDigest(epoch) || obsolete(latest, body, plan.removedIds)) throw new Error('履歴整理の対象を再同期してください。');
            const votes = latest.assessment.view.ofType('historyRetention');
            if (votes.some(op => op.payload.phase === 'approve' && op.payload.proposalId === proposal.operationId && op.authorUserId === input.repository.scope.userId)) return [];
            return [{ operationId: id, entityId: id, entityType: 'historyRetention', operationType: 'patch', payload: {
              phase: 'approve', proposalId: proposal.operationId, checkpointDigest: sharedDocumentDigest(body), receiptDigest: sharedDocumentDigest(receipt) } }];
          });
          await input.sync({ force: true, budgetMs: remaining() }); continue;
        }
        if (epoch.body.ownerDeviceId !== input.repository.scope.deviceId || epoch.body.members.some(member => !approvals.some(op => op.authorUserId === member.userId))) return { kind: 'waiting' };
        const originals = new Map((await input.readOriginals()).map(fact => [fact.operation.operationId, fact])); remaining();
        const witness: V2RetentionWitness = { proposal: originals.get(proposal.operationId)!, proposalReceipt: receipt,
          approvals: epoch.body.members.map(member => originals.get(approvals.find(op => op.authorUserId === member.userId)!.operationId)!) };
        verifyV2RetentionWitness(witness, state.archive, view.groupId);
        await input.manager.publishSnapshot(remaining(), async (published, context) => {
          const current = await input.repository.readState(); remaining();
          if (context.group.headSequence < body.throughSequence || sharedRosterDigest(context.archive.at(-1)!) !== body.rosterDigest
            || obsolete(current, body, plan.removedIds)) throw new Error('履歴整理の対象を再同期してください。');
          const fresh = await derive(body); const ids = new Set(fresh.retained.map(op => op.operationId));
          const base = compactSharedReplica(published); delete base.legacyMigrationWitness; delete base.recoveryWitnesses;
          return buildSharedReplica(view.groupId, [], { ...base, retention: witness,
            operations: published.operations.filter(op => !retentionCovered(op, body) || ids.has(op.operationId)) });
        });
        if (deadline - now() < 1000) return { kind: 'waiting' };
        const adopted = await input.repository.readState();
        return { kind: adopted.replica.retention?.proposal.operation.operationId === proposal.operationId ? 'published' : 'waiting' };
      }
      return { kind: 'waiting' };
    })().finally(() => { if (running === work) running = null; }); running = work; return work;
  } };
}
