import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedEntityType, SharedOperation, VersionVector } from '../operations';
import type { V2HistoryView } from './history-view';
import { maximalCausalFacts } from './causal-facts.ts';
import { V2StaleSettingsError } from './configuration-edit.ts';

export interface V2FieldCandidate { operationId: string; authorUserId: string; recordedAt: string | null; value: JsonValue;
  authorDeviceId: string; deviceSequence: number; context: VersionVector }
export type V2EditableField = { kind: 'missing'; candidates: [] }
  | { kind: 'value'; value: JsonValue; candidates: V2FieldCandidate[] }
  | { kind: 'conflict'; candidates: V2FieldCandidate[] };
export interface V2FieldEdit { field: string; value: JsonValue; basisOperationIds: readonly string[];
  /** An explicit resolution must still include every currently conflicting source. */
  resolveOperationIds?: readonly string[] }
export interface V2FieldSaveResult { operations: SharedOperation[]; fields: Record<string, V2EditableField> }
export const V2_CHORE_DETAIL_FIELDS = ['name', 'description', 'instructions', 'procedureSections', 'tools', 'cautions'] as const;
export type V2ChoreDetailField = typeof V2_CHORE_DETAIL_FIELDS[number];
const clone = (value: JsonValue) => JSON.parse(canonicalJson(value)) as JsonValue;
const sameIds = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
const sameValue = (a: JsonValue | undefined, b: JsonValue | undefined) => canonicalJson(a === undefined ? [false] : [true, a]) === canonicalJson(b === undefined ? [false] : [true, b]);

export function editableFieldFromOperations(operations: readonly SharedOperation[], field: string): V2EditableField {
  return editableValueFromOperations(operations.filter((operation) => field === '$alive' || Object.hasOwn(operation.payload, field)),
    operation => field === '$alive' ? operation.operationType !== 'delete' : operation.payload[field]);
}

/** A compound editor value is derived from original signed fields; it is never a replacement operation or author proof. */
export function editableValueFromOperations(operations: readonly SharedOperation[], readValue: (operation: SharedOperation) => JsonValue): V2EditableField {
  const latest = maximalCausalFacts(operations);
  if (!latest.length) return { kind: 'missing', candidates: [] };
  const candidates = latest.map((operation) => ({ operationId: operation.operationId, authorUserId: operation.authorUserId,
    recordedAt: operation.recordedAt ?? null, value: clone(readValue(operation)),
    authorDeviceId: operation.authorDeviceId, deviceSequence: operation.deviceSequence, context: { ...operation.context } }));
  return new Set(candidates.map((candidate) => canonicalJson(candidate.value))).size === 1
    ? { kind: 'value', value: clone(candidates[0].value), candidates } : { kind: 'conflict', candidates };
}

export function readV2EditableField(view: V2HistoryView, at: SharedOperation, type: SharedEntityType, entityId: string, field: string): V2EditableField {
  return editableFieldFromOperations(view.observed(view.fieldTopic ? view.fieldTopic(type, entityId, field) : view.topic(type, entityId), at), field);
}

/** Reconstruct a displayed simple or compound value only from this entity's observed, authorized sources. */
export function readV2EditBasis(input: { view: V2HistoryView; at: SharedOperation; type: SharedEntityType; entityId: string; operationIds: readonly string[];
  accepts: (operation: SharedOperation) => boolean; readValue: (operation: SharedOperation) => JsonValue }): V2EditableField {
  if (input.operationIds.length > 256 || new Set(input.operationIds).size !== input.operationIds.length) throw new V2StaleSettingsError();
  const operations = input.operationIds.map(id => {
    const operation = input.view.byId(id);
    if (!operation || operation.entityType !== input.type || operation.entityId !== input.entityId || !input.accepts(operation)
      || input.view.observed([operation], input.at).length !== 1) throw new V2StaleSettingsError();
    return operation;
  });
  const basis = editableValueFromOperations(operations, input.readValue);
  if (!sameIds(basis.candidates.map(candidate => candidate.operationId), input.operationIds)) throw new V2StaleSettingsError();
  return basis;
}

export function compareV2ValueEdit(current: V2EditableField, base: V2EditableField, edit: Pick<V2FieldEdit, 'value' | 'resolveOperationIds'>): boolean {
  if (edit.resolveOperationIds !== undefined) {
    if (current.kind !== 'conflict' || !sameIds(current.candidates.map(candidate => candidate.operationId), edit.resolveOperationIds)
      || new Set(edit.resolveOperationIds).size !== edit.resolveOperationIds.length) throw new V2StaleSettingsError();
  } else {
    if (current.kind === 'conflict' || base.kind === 'conflict') throw new V2StaleSettingsError();
    const currentValue = current.kind === 'value' ? current.value : undefined; const baseValue = base.kind === 'value' ? base.value : undefined;
    if (!sameValue(currentValue, baseValue) && !sameValue(currentValue, edit.value)) throw new V2StaleSettingsError();
  }
  return current.kind !== 'value' || !sameValue(current.value, edit.value);
}

/** Reconstruct displayed bases from authenticated facts, then merge only the fields the user changed. */
export function prepareV2FieldEdits(input: { view: V2HistoryView; at: SharedOperation; type: SharedEntityType; entityId: string;
  allowed: readonly string[]; edits: readonly V2FieldEdit[] }) {
  const { view, at, type, entityId } = input; const patch: Record<string, JsonValue> = {}; const fields: Record<string, V2EditableField> = {};
  const seen = new Set<string>();
  for (const edit of input.edits) {
    if (!input.allowed.includes(edit.field) || seen.has(edit.field)) throw new Error('変更する項目を確認してください。'); seen.add(edit.field);
    const base = readV2EditBasis({ view, at, type, entityId, operationIds: edit.basisOperationIds,
      accepts: operation => Object.hasOwn(operation.payload, edit.field), readValue: operation => operation.payload[edit.field] });
    const current = readV2EditableField(view, at, type, entityId, edit.field); fields[edit.field] = current;
    if (compareV2ValueEdit(current, base, edit)) patch[edit.field] = clone(edit.value);
  }
  return { patch, fields };
}
