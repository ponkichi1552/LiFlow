import type { LocalDate } from '../../../domain/shared/types';
import { isRetiredBuiltInChore } from '../../../domain/chores/catalog.ts';
import { canonicalJson } from '../operations.ts';
import type { SharedOperation } from '../operations';
import type { SharedReplica } from '../replica';
import { sharedDocumentDigest } from '../crypto.ts';
import { sharedRosterDigest } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster';
import { sharedLocalDate } from '../group-clock.ts';
import type { assessV2BusinessHistory } from './receiver-authority';
import { v2ReadPoint } from './view-point.ts';
import { v2CompletionHistory } from './completion-history.ts';
import type { V2ServerReceipt } from './server-receipts';
import { retentionIndexDigest, retentionOperationsDigest } from './history-retention-certificate.ts';
import { compareRetentionValues, validateV2RetentionBody } from './history-retention-schema.ts';
import type { V2RetentionAnchor, V2RetainedRoundState, V2RetentionBody } from './history-retention-schema';
import { v2RetainedCompletions } from './retained-completions.ts';
import { frameAtOperation } from './authority-context.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { supportsChoreRotation } from './payload-schema.ts';
import { markRotationCompletion, rotationProgressIndex, rotationProgressRows } from './rotation-progress.ts';
import type { SharedChoreConfiguration } from './model';

/** Pure proposal built only after the caller has authenticated the full original ledger. */
export function planV2HistoryRetention(input: { replica: SharedReplica; assessment: ReturnType<typeof assessV2BusinessHistory>;
  archive: readonly VerifiedSharedRoster[]; receipts: ReadonlyMap<string, V2ServerReceipt>; cutoff: LocalDate; throughSequence: number;
  previous?: V2RetentionBody; format?: V2RetentionBody['format'] }) {
  const { replica, assessment, receipts, cutoff } = input; const epoch = input.archive.at(-1)!;
  const hasRotation = input.previous?.format === 3 || replica.operations.some(op => op.entityType === 'chorePolicy'
    && (op.payload.configuration as unknown as SharedChoreConfiguration)?.policy.assignment.rotation);
  const format = input.format ?? (hasRotation ? 3 : 2);
  if (format === 3 && !supportsChoreRotation(epoch?.body.schedulerVersion ?? '')) throw new Error('Upgrade before retaining rotation progress');
  if (format !== 3 && input.previous?.rotationProgress?.length) throw new Error('Cannot discard retained rotation progress');
  if (!epoch || replica.pendingOperationIds.length || assessment.provisionalOperationIds.length
    || replica.operations.some(op => op.schemaVersion === 2 && !receipts.has(op.operationId))) throw new Error('Finish synchronization before deleting history');
  const at = v2ReadPoint(assessment.view, epoch);
  const rotationProgress = rotationProgressIndex(input.previous?.rotationProgress);
  const rememberRotation = (choreId: string, version: number, anchorDate: LocalDate) => {
    const cfg = assessment.view.configurationVersion(choreId, version, at)?.value as unknown as SharedChoreConfiguration | undefined;
    if (!cfg?.policy.assignment.rotation) return;
    if (format !== 3) throw new Error('Rotating assignments require a compatible retention format');
    markRotationCompletion(rotationProgress, choreId, cfg.rotationSourceVersion!, anchorDate);
  };
  const timeZone = assessment.view.field('settings', 'settings', 'timeZone', at)?.value;
  if (typeof timeZone !== 'string') throw new Error('Missing shared history region');
  if (input.previous && cutoff < input.previous.cutoff) throw new Error('History retention cannot move backwards');
  const expired = new Set(replica.operations.filter(op => op.entityType === 'completion' && op.operationType === 'complete'
    && sharedLocalDate(new Date(String(op.payload.completedAt)), timeZone) < cutoff).map(op => op.operationId));
  const records = v2CompletionHistory(assessment.view, at, receipts);
  const anchors = new Map<string, V2RetentionAnchor>(); const rounds = new Map<string, V2RetainedRoundState>();
  const save = (anchor: V2RetentionAnchor) => {
    if (isRetiredBuiltInChore(anchor.choreId) || anchor.through >= cutoff) return;
    const key = `${anchor.choreId}\0${anchor.subjectUserId}`;
    if (!anchors.has(key) || anchors.get(key)!.instant < anchor.instant) anchors.set(key, {
      choreId: anchor.choreId, subjectUserId: anchor.subjectUserId, date: anchor.date, anchorDate: anchor.anchorDate,
      ruleVersion: anchor.ruleVersion, instant: anchor.instant, through: anchor.through });
  };
  for (const anchor of input.previous?.anchors ?? []) save(anchor);
  for (const anchor of v2RetainedCompletions(assessment.view, at)) if (!isRetiredBuiltInChore(anchor.choreId)) {
    if (anchor.reports.length && anchor.through < cutoff) rememberRotation(anchor.choreId, anchor.ruleVersion, anchor.anchorDate);
    if (anchor.reports.length) save(anchor); if (anchor.through >= cutoff) rounds.set(`${anchor.choreId}\0${anchor.subjectUserId}\0${anchor.anchorDate}`, anchor);
  }
  for (const record of records) if (expired.has(record.operationId) && record.active && record.outcome === 'completed'
    && record.acceptance === 'accepted' && record.performedTimeConfirmed) {
    if (isRetiredBuiltInChore(record.choreId)) continue;
    const operation = assessment.view.byId(record.operationId)!;
    const frame = frameAtOperation(assessment.view, input.archive, operation, record.choreId, record.anchorDate, operation.payload.ruleVersion as number).frame;
    const anchor: V2RetentionAnchor = { choreId: record.choreId, subjectUserId: record.subjectUserId,
      date: sharedLocalDate(new Date(record.performedAt), timeZone), anchorDate: record.anchorDate,
      ruleVersion: operation.payload.ruleVersion as number, instant: Date.parse(record.performedAt), through: record.schedule?.windowEnd ?? frame.windowEnd };
    if (anchor.through < cutoff) rememberRotation(anchor.choreId, anchor.ruleVersion, anchor.anchorDate);
    save(anchor);
    if (anchor.through >= cutoff && !isRetiredBuiltInChore(anchor.choreId)) {
      const key = `${anchor.choreId}\0${anchor.subjectUserId}\0${anchor.anchorDate}`;
      const prior = rounds.get(key); const reports = new Map(prior?.reports.map(report => [report.recorderUserId, report.instant]));
      reports.set(record.recorderUserId, Math.min(reports.get(record.recorderUserId) ?? Infinity, anchor.instant));
      const instant = Math.min(...reports.values());
      rounds.set(key, { ...anchor, suggestedDate: record.schedule?.date ?? frame.anchorDate, windowStart: record.schedule?.windowStart ?? frame.windowStart,
        assignmentCut: prior?.assignmentCut ?? null, strictInstructionUnfulfilled: record.strictInstructionFulfilled === false && (!prior || prior.strictInstructionUnfulfilled),
        instant, date: sharedLocalDate(new Date(instant), timeZone), reports: [...reports].sort(([a], [b]) => compareRetentionValues(format, a, b)).map(([recorderUserId, instant]) => ({ recorderUserId, instant })) });
    }
  }
  const plans = new Map<string, ReturnType<typeof buildV2CommonPlan>>();
  for (const state of rounds.values()) {
    let plan = plans.get(state.anchorDate);
    if (!plan) { plan = buildV2CommonPlan(input, { from: state.anchorDate, through: state.anchorDate, asOfDate: cutoff }); plans.set(state.anchorDate, plan); }
    const round = plan.occurrences.find(row => row.choreId === state.choreId && row.anchorDate === state.anchorDate && row.ruleVersion === state.ruleVersion);
    state.assignmentCut = round?.assignmentCut ?? state.assignmentCut;
    state.strictInstructionUnfulfilled = round?.subjects.find(row => row.subjectUserId === state.subjectUserId)?.strictInstructionUnfulfilled ?? state.strictInstructionUnfulfilled;
  }
  const accepted = new Set(assessment.view.ready.map(op => op.operationId));
  const retired = (op: SharedOperation) => ['chore', 'baseline', 'chorePolicy', 'assignment'].includes(op.entityType) && isRetiredBuiltInChore(op.entityId)
    || typeof op.payload.choreId === 'string' && isRetiredBuiltInChore(op.payload.choreId)
    || op.entityType === 'dependency' && [op.payload.predecessorChoreId, op.payload.successorChoreId].some(id => typeof id === 'string' && isRetiredBuiltInChore(id));
  const retained = replica.operations.filter(op => !retired(op) && !expired.has(op.operationId)
    && !['historyRetention', 'retainedCompletionUndo'].includes(op.entityType)
    && !(op.entityType === 'completion' && op.operationType === 'undo' && expired.has(String(op.payload.targetOperationId)))
    && !(op.entityType === 'completionApproval' && expired.has(String(op.payload.completionOperationId))));
  const sortAnchors = <T extends V2RetentionAnchor>(values: Iterable<T>) => [...values].sort((a, b) => compareRetentionValues(format, canonicalJson(a), canonicalJson(b)));
  const rejected = new Map(assessment.rejected.map(row => [row.operationId, row.kind]));
  const states = [...retained].sort((a, b) => compareRetentionValues(format, a.operationId, b.operationId)).map(op => accepted.has(op.operationId) ? 0 : rejected.get(op.operationId) === 'conflict' ? 2 : rejected.get(op.operationId) === 'unconfirmed' ? 3 : 1);
  const authorityStates = Array.from({ length: Math.ceil(states.length / 2) }, (_, index) => ((states[index * 2] << 2) | (states[index * 2 + 1] ?? 0)).toString(16)).join('');
  const body = validateV2RetentionBody({ format, groupId: replica.groupId, rosterDigest: sharedRosterDigest(epoch), keyVersion: epoch.body.keyVersion,
    cutoff, timeZone, frontier: { ...replica.frontier }, throughSequence: input.throughSequence,
    sourceFactsDigest: sharedDocumentDigest([retentionOperationsDigest(replica.operations, format),
      sharedDocumentDigest(replica.legacyMigrationWitness ?? null), sharedDocumentDigest(replica.recoveryWitnesses ?? []),
      input.previous ? sharedDocumentDigest(input.previous) : null]),
    retainedFactsDigest: retentionOperationsDigest(retained, format), indexDigest: retentionIndexDigest(replica.operationIndex, format),
    anchors: sortAnchors(anchors.values()), roundStates: sortAnchors(rounds.values()),
    retainedCount: retained.length, authorityStates, ...(format === 3 ? { rotationProgress: rotationProgressRows(rotationProgress) } : {}) });
  const retainedIds = new Set(retained.map(op => op.operationId));
  return { body, retained, removedIds: replica.operations.filter(op => !retainedIds.has(op.operationId)).map(op => op.operationId) };
}
