import { canonicalJson, causallyPrecedes } from '../operations.ts';
import type { JsonValue, SharedEntityType, SharedOperation, VersionVector } from '../operations.ts';
import type { SharedReplica } from '../replica.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { normalizeV2Configuration } from './configuration-normalization.ts';
import type { DateRuleCancellation, SharedChoreConfiguration } from './model.ts';
import type { V2AssignmentProjection } from './assignment-state.ts';
import type { V2RetentionBody } from './history-retention-schema';
import { validateV2RetentionBody } from './history-retention-schema.ts';
import type { V2ServerReceipt } from './server-receipts';

export class V2HistoryConflictError extends Error { readonly code = 'sharing/v2-history-conflict'; }

/** Index once per projection. Never rebuild the whole replica for each causal permission lookup. */
export function createV2HistoryView(replica: SharedReplica) {
  const pending = new Set(replica.pendingOperationIds);
  const index = createV2AuthorityIndex(replica.groupId, undefined, undefined, undefined, replica.retention ? validateV2RetentionBody(replica.retention.proposal.operation.payload.checkpoint) : undefined);
  for (const op of replica.operations) if (!pending.has(op.operationId)) index.accept(op);
  return index.view;
}

/** The receiver adds only authenticated, authorized facts; invalid writes never establish later privileges. */
export function createV2AuthorityIndex(groupId: string, assignmentProjection?: (at: SharedOperation) => V2AssignmentProjection, confirmedContext?: () => VersionVector,
  cancellationProjection?: (at?: SharedOperation) => DateRuleCancellation[], retention?: V2RetentionBody, completionReceipts: ReadonlyMap<string, V2ServerReceipt> = new Map()) {
  const ready: SharedOperation[] = []; const byId = new Map<string, SharedOperation>();
  const headContext: Record<string, number> = { ...retention?.frontier }; let headClock = 0;
  const topics = new Map<string, SharedOperation[]>(); const types = new Map<SharedEntityType, SharedOperation[]>();
  const topicFields = new Map<string, { length: number; fields: Map<string, SharedOperation[]> }>();
  const occurrences = new Map<string, SharedOperation[]>();
  const configurationVersions = new Map<string, SharedOperation[]>();
  const completionRounds = new Map<string, SharedOperation[]>(); const waitingForCompletion = new Map<string, SharedOperation[]>();
  const calendarEvents = new Map<string, SharedOperation[]>();
  const requestDecisions = new Map<string, SharedOperation[]>();
  const indexCompletion = (source: SharedOperation, operation: SharedOperation) => {
    if (source.schemaVersion !== 2 || source.operationType !== 'complete') return;
    const key = `${source.payload.choreId}\0${source.payload.anchorDate}`; const entries = completionRounds.get(key) ?? [];
    entries.push(operation); completionRounds.set(key, entries);
  };
  const accept = (op: SharedOperation) => {
    if (op.groupId !== groupId || byId.has(op.operationId)) throw new Error('Duplicate or foreign authority fact');
    ready.push(op); byId.set(op.operationId, op);
    headContext[op.authorDeviceId] = Math.max(headContext[op.authorDeviceId] ?? 0, op.deviceSequence);
    headClock = Math.max(headClock, op.logicalClock);
    const topic = `${op.entityType}:${op.entityId}`; const list = topics.get(topic) ?? []; list.push(op); topics.set(topic, list);
    const type = types.get(op.entityType) ?? []; type.push(op); types.set(op.entityType, type);
    if (op.entityType === 'calendarEvent' && typeof op.payload.eventId === 'string') {
      const facts = calendarEvents.get(op.payload.eventId) ?? []; facts.push(op); calendarEvents.set(op.payload.eventId, facts);
    }
    if (op.entityType === 'requestDecision' && typeof op.payload.requestId === 'string') {
      const id = op.payload.requestId; const facts = requestDecisions.get(id) ?? []; facts.push(op); requestDecisions.set(id, facts);
    }
    if (op.entityType === 'chorePolicy' && op.payload.configuration && typeof op.payload.configuration === 'object') {
      const version = (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion;
      const key = `${op.entityId}\0${version}`; const entries = configurationVersions.get(key) ?? [];
      entries.push(op); configurationVersions.set(key, entries);
    }
    const occurrenceId = op.entityType === 'completion' ? op.entityId : op.payload.occurrenceId;
    if (typeof occurrenceId === 'string') { const facts = occurrences.get(occurrenceId) ?? []; facts.push(op); occurrences.set(occurrenceId, facts); }
    if (op.entityType === 'completion' && op.operationType === 'complete') {
      indexCompletion(op, op); for (const related of waitingForCompletion.get(op.operationId) ?? []) indexCompletion(op, related);
      waitingForCompletion.delete(op.operationId);
    } else if (op.entityType === 'completion' && op.operationType === 'undo' || op.entityType === 'completionApproval') {
      const id = (op.payload.targetOperationId ?? op.payload.completionOperationId) as string; const source = byId.get(id);
      if (source) indexCompletion(source, op);
      else { const related = waitingForCompletion.get(id) ?? []; related.push(op); waitingForCompletion.set(id, related); }
    }
  };
  const observed = (operations: readonly SharedOperation[], at: SharedOperation) => operations.filter((op) => causallyPrecedes(op, at));
  // Index authored fields lazily per topic. The receiver can append more verified
  // facts, so extend from the previous length; never cache a causal-cut result.
  const fieldTopic = (type: SharedEntityType, id: string, field: string) => {
    const key = `${type}:${id}`; const operations = topics.get(key) ?? [];
    if (field === '$alive') return operations;
    let index = topicFields.get(key);
    if (!index) { index = { length: 0, fields: new Map() }; topicFields.set(key, index); }
    for (let offset = index.length; offset < operations.length; offset++) {
      const op = operations[offset];
      for (const name of Object.keys(op.payload)) {
        const rows = index.fields.get(name) ?? []; rows.push(op); index.fields.set(name, rows);
      }
    }
    index.length = operations.length;
    return index.fields.get(field) ?? [];
  };
  function fieldValue(operations: readonly SharedOperation[], type: SharedEntityType, field: string, at: SharedOperation,
    filter: (op: SharedOperation) => boolean = () => true): { value: JsonValue; operations: SharedOperation[] } | null {
      const writing = observed(operations, at).filter((op) => filter(op) && (field === '$alive' || Object.hasOwn(op.payload, field)));
      const latest = maximalCausalFacts(writing);
      if (!latest.length) return null;
      const value = (op: SharedOperation): JsonValue => field === '$alive' ? op.operationType !== 'delete'
        : type === 'chorePolicy' && field === 'configuration' ? normalizeV2Configuration(op.payload[field] as unknown as SharedChoreConfiguration) as unknown as JsonValue : op.payload[field];
      if (new Set(latest.map((op) => canonicalJson(value(op)))).size > 1) throw new V2HistoryConflictError(`Unresolved ${type}.${field}`);
      return { value: value(latest[0]), operations: latest };
  }
  const view = {
    groupId, ready,
    currentHead: () => ({ context: { ...headContext }, clock: headClock }),
    byId: (id: string) => byId.get(id),
    topic: (type: SharedEntityType, id: string) => topics.get(`${type}:${id}`) ?? [],
    fieldTopic,
    ofType: (type: SharedEntityType) => types.get(type) ?? [],
    calendarFactsFor: (id: string) => calendarEvents.get(id) ?? [],
    requestDecisionsFor: (id: string) => requestDecisions.get(id) ?? [],
    forOccurrence: (id: string) => occurrences.get(id) ?? [],
    completionFactsForRound: (choreId: string, anchorDate: string) => completionRounds.get(`${choreId}\0${anchorDate}`) ?? [],
    assignmentsAt: (at: SharedOperation) => assignmentProjection?.(at),
    dateCancellationsAt: (at?: SharedOperation) => cancellationProjection?.(at) ?? [],
    confirmedReceiptContext: () => confirmedContext?.(),
    retainedFrontier: () => retention?.frontier,
    completionReceipts: () => completionReceipts,
    retentionAt: (at: SharedOperation) => retention && Object.entries(retention.frontier).every(([device, count]) => (at.context[device] ?? 0) >= count) ? retention : undefined,
    observed,
    configurationVersion(choreId: string, version: number, at: SharedOperation) {
      return fieldValue(configurationVersions.get(`${choreId}\0${version}`) ?? [], 'chorePolicy', 'configuration', at);
    },
    field(type: SharedEntityType, id: string, field: string, at: SharedOperation, filter: (op: SharedOperation) => boolean = () => true):
      { value: JsonValue; operations: SharedOperation[] } | null {
      return fieldValue(fieldTopic(type, id, field), type, field, at, filter);
    },
  };
  return { view, accept };
}
export type V2HistoryView = ReturnType<typeof createV2HistoryView>;
