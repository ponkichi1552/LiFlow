import { matchesUploadedManual } from '../../appliance-care/manual-source.ts';
import type { Appliance } from '../../appliance-care/contracts';
import { isAnalysisRecord, isVerifiedApplianceAnalysis } from '../../appliance-care/analysis-validation.ts';
import { applianceManufacturerIdentity, isOfficialApplianceUrl } from '../../appliance-care/official-url.ts';
import { applianceDisplayName } from '../../appliance-care/display-name.ts';
import { canonicalJson, compareOperationIds } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations';
import { sharedDocumentDigest } from '../crypto.ts';
import type { V2HistoryView } from './history-view';
import { editableValueFromOperations, readV2EditableField } from './field-edit.ts';
import type { V2EditableField } from './field-edit';

const required = ['manufacturer', 'productName', 'modelNumber', 'displayName', 'officialManualUrl', 'analysis', 'reviewed'] as const;
const contentFields = [...required, 'category', 'officialProductUrl'] as const;
const ids = (field: V2EditableField) => field.candidates.map(candidate => candidate.operationId);
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
export const normalizedApplianceModel = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
export interface V2ApplianceSelection { groupId: string; applianceId: string; revision: string }
export interface V2ApplianceSummary { id: string; displayName: string; manufacturer: string; productName: string; modelNumber: string;
  deleted: boolean; needsReview: boolean; revision: string; candidateCount: number; selection: V2ApplianceSelection }
export interface V2ApplianceCandidate { operationId: string; authorUserId: string; recordedAt: string | null; appliance: Appliance | null }
const touchesContent = (operation: SharedOperation) => contentFields.some(field => Object.hasOwn(operation.payload, field));

export function normalizeV2ReviewedAppliance(value: unknown): Record<string, JsonValue> | null {
  if (!isAnalysisRecord(value)) return null;
  const data = value;
  if (!['manufacturer', 'productName', 'modelNumber', 'displayName', 'officialManualUrl'].every(field => text(data[field])) || data.reviewed !== true
    || !isVerifiedApplianceAnalysis(data.analysis, data.manufacturer as string)
    || !(isOfficialApplianceUrl(data.officialManualUrl as string, data.manufacturer as string) || matchesUploadedManual(data.officialManualUrl, data.analysis))
    || data.officialProductUrl != null && (typeof data.officialProductUrl !== 'string' || !isOfficialApplianceUrl(data.officialProductUrl, data.manufacturer as string))
    || data.category != null && typeof data.category !== 'string') return null;
  if (normalizedApplianceModel(data.analysis.model) !== normalizedApplianceModel(data.modelNumber as string)
    || (applianceManufacturerIdentity(data.analysis.manufacturer) ?? normalizedApplianceModel(data.analysis.manufacturer)) !== (applianceManufacturerIdentity(data.manufacturer as string) ?? normalizedApplianceModel(data.manufacturer as string))) return null;
  return JSON.parse(canonicalJson(Object.fromEntries(contentFields.map(field => [field, data[field] ?? (field === 'category' ? '' : null)]))));
}

function fieldAtSource(view: V2HistoryView, source: SharedOperation, field: string): JsonValue | undefined {
  const cut = { ...source, context: { ...source.context, [source.authorDeviceId]: source.deviceSequence } };
  const current = readV2EditableField(view, cut, 'appliance', source.entityId, field);
  if (current.kind === 'conflict') throw new Error('Unresolved original appliance');
  return current.kind === 'value' ? current.value : undefined;
}

/** The product and its reviewed analysis travel as one authored bundle, including omitted optional fields. */
export function v2ApplianceValueAt(view: V2HistoryView, source: SharedOperation): JsonValue {
  try {
    const full = required.every(field => Object.hasOwn(source.payload, field));
    const data = full ? source.payload : Object.fromEntries(contentFields.map(field => [field, fieldAtSource(view, source, field)]));
    return normalizeV2ReviewedAppliance(data);
  } catch { return null; }
}

function materialize(view: V2HistoryView, candidate: V2EditableField['candidates'][number]): Appliance | null {
  if (!candidate.value || typeof candidate.value !== 'object' || Array.isArray(candidate.value)) return null;
  try {
    const source = view.byId(candidate.operationId)!;
    const createdAt = fieldAtSource(view, source, 'createdAt'); const updatedAt = fieldAtSource(view, source, 'updatedAt');
    if (!instant(createdAt) || !instant(updatedAt)) return null;
    const { reviewed: _reviewed, officialProductUrl, category, ...content } = candidate.value;
    return { ...content, ...(officialProductUrl ? { officialProductUrl } : {}), ...(category ? { category } : {}),
      id: source.entityId, householdId: `shared:${view.groupId}`, createdAt, updatedAt } as unknown as Appliance;
  } catch { return null; }
}

export function readV2Appliance(view: V2HistoryView, at: SharedOperation, id: string) {
  const alive = readV2EditableField(view, at, 'appliance', id, '$alive');
  const source = editableValueFromOperations(view.observed(view.topic('appliance', id), at).filter(touchesContent), operation => v2ApplianceValueAt(view, operation));
  const candidates: V2ApplianceCandidate[] = source.candidates.map(candidate => ({ operationId: candidate.operationId, authorUserId: candidate.authorUserId,
    recordedAt: candidate.recordedAt, appliance: materialize(view, candidate) }));
  const appliance = alive.kind === 'value' && alive.value === true && source.kind === 'value' ? candidates[0]?.appliance ?? null : null;
  const description = appliance ?? (source.kind === 'value' ? candidates[0]?.appliance : null);
  const revision = sharedDocumentDigest([view.groupId, id, ids(alive), ids(source)]);
  const row: V2ApplianceSummary = { id, displayName: description ? applianceDisplayName(description, description.displayName) : '家電の内容を確認',
    manufacturer: description?.manufacturer ?? '', productName: description?.productName ?? '', modelNumber: description?.modelNumber ?? '',
    deleted: alive.kind === 'value' && alive.value === false, needsReview: !appliance, revision, candidateCount: candidates.length,
    selection: { groupId: view.groupId, applianceId: id, revision } };
  return { row, appliance, candidates, alive, source };
}

/** List rows omit full manuals and analysis text; only the opened appliance carries its candidates. */
export function buildV2ApplianceModel(view: V2HistoryView, at: SharedOperation, detailId?: string) {
  const records = [...new Set(view.ofType('appliance').map(operation => operation.entityId))].sort(compareOperationIds).map(id => readV2Appliance(view, at, id));
  const detail = records.find(record => record.row.id === detailId);
  const chores = detail ? [...new Set(view.ofType('chore').map(operation => operation.entityId))].sort(compareOperationIds).flatMap(id => {
    const alive = readV2EditableField(view, at, 'chore', id, '$alive'); const parent = readV2EditableField(view, at, 'chore', id, 'applianceId');
    if (alive.kind === 'value' && alive.value === true && parent.kind === 'value' && parent.value === detailId) {
      const name = readV2EditableField(view, at, 'chore', id, 'name'); return [{ id, name: name.kind === 'value' && typeof name.value === 'string' ? name.value : '家事名を確認' }];
    }
    return [];
  }) : [];
  return { rows: records.map(record => record.row), ...(detail ? { detail: { ...detail, chores } } : {}) };
}
