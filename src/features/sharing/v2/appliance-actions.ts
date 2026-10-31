import { V2_SCHEDULER_VERSION } from './payload-schema.ts';
import type { ProductVerifiedResponse, UploadedManualInput } from '../../appliance-care/api-contracts';
import type { ApplianceCareAnalysisDraft } from '../../appliance-care/contracts';
import { isAnalysisRecord } from '../../appliance-care/analysis-validation.ts';
import { applianceDisplayName } from '../../appliance-care/display-name.ts';
import { applianceManufacturerIdentity } from '../../appliance-care/official-url.ts';
import { toApplianceCareChore } from '../../appliance-care/to-chore-definition.ts';
import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations';
import { sharedDocumentDigest } from '../crypto.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger';
import { v2ReadPoint } from './view-point.ts';
import { normalizeV2ReviewedAppliance, normalizedApplianceModel, readV2Appliance } from './appliance-state.ts';
import type { V2ApplianceSelection } from './appliance-state';
import { readV2EditableField } from './field-edit.ts';
import { V2StaleSettingsError } from './configuration-edit.ts';
import { prepareManualDocument } from '../../appliance-care/manual-document.ts';
import { manualDocumentDrafts } from './manual-documents.ts';

export interface V2ApplianceReview { reviewed: true; result: ProductVerifiedResponse; addTaskNames: readonly string[];
  manual?: UploadedManualInput; selection?: V2ApplianceSelection; resolveOperationIds?: readonly string[]; restorePresence?: boolean; reviewedDisplayName?: string }
export interface V2ApplianceReviewResult { operations: SharedOperation[]; applianceId: string; createdChoreIds: string[]; preservedTaskNames: string[] }
export class V2ApplianceAlreadyExistsError extends Error {
  readonly code = 'sharing/v2-appliance-exists';
  readonly applianceId: string;
  constructor(applianceId: string) { super('同じメーカー・型番の共有家電があります。その家電を開いて内容を確認してください。'); this.applianceId = applianceId; }
}
export const v2ApplianceId = (groupId: string, manufacturer: string, modelNumber: string) => `appliance.${sharedDocumentDigest([groupId, applianceManufacturerIdentity(manufacturer) ?? normalizedApplianceModel(manufacturer), normalizedApplianceModel(modelNumber)])}`;
const sameIds = (a: readonly string[], b: readonly string[]) => new Set(a).size === a.length && canonicalJson([...a].sort()) === canonicalJson([...b].sort());

/** Review stores the appliance and only new, disabled chores. Existing user text, cadence and history are not rewritten. */
export function createV2ApplianceActions(repository: ReturnType<typeof createV2EventRepository>, options: { makeId: () => string; now: () => Date }) {
  const draft = (type: 'appliance' | 'chore', id: string, payload: Record<string, JsonValue>, operationType: SharedOperationDraft['operationType'] = 'patch'): SharedOperationDraft =>
    ({ operationId: options.makeId(), entityId: id, entityType: type, operationType, payload });
  return {
    deleteAppliance: (selection: V2ApplianceSelection) => repository.commitCurrent(async state => {
      if (selection.groupId !== repository.scope.groupId) throw new V2StaleSettingsError();
      const view = state.assessment.view; const current = readV2Appliance(view, v2ReadPoint(view, state.archive.at(-1)!), selection.applianceId);
      if (current.alive.kind === 'missing' || current.row.revision !== selection.revision) throw new V2StaleSettingsError();
      return current.row.deleted ? [] : [draft('appliance', selection.applianceId, {}, 'delete')];
    }),
    async reviewAppliance(input: V2ApplianceReview): Promise<V2ApplianceReviewResult> {
      const instant = options.now().toISOString(); let saved: Omit<V2ApplianceReviewResult, 'operations'> | undefined;
      const manual = input.manual ? prepareManualDocument(input.manual.base64, input.result.analysis.manualSource?.sha256) : undefined;
      if (input.manual && (input.manual.rightsConfirmed !== true || input.result.analysis.manualSource?.sha256 !== manual?.document.sha256)) throw new Error('解析したPDFの保存を確認してください。');
      const operations = await repository.commitCurrent(async state => {
        if (!input || input.reviewed !== true || !isAnalysisRecord(input.result) || input.result.status !== 'verified'
          || !isAnalysisRecord(input.result.product) || !isAnalysisRecord(input.result.officialSources)) throw new Error('解析結果を確認してから共有してください。');
        const result = input.result; const product = result.product;
        if (result.analysis.manualSource && ![V2_SCHEDULER_VERSION, 'liflow-shared-2-draft-41', 'liflow-shared-2-draft-40', 'liflow-shared-2-draft-39'].includes(state.archive.at(-1)!.body.schedulerVersion)) throw new Error('共有グループの所有者が共有画面から互換更新を行ってください。既存データは保持されます。');
        if (manual && state.archive.at(-1)!.body.schedulerVersion !== V2_SCHEDULER_VERSION) throw new Error('PDFの共有保存にはグループの互換更新が必要です。解析結果は再解析せず保存できます。');
        if (![product.manufacturer, product.productName, product.modelNumber].every(value => typeof value === 'string' && value.trim())) throw new Error('メーカー・製品名・型番を確認してください。');
        const groupId = repository.scope.groupId; const selection = input.selection;
        if (selection && selection.groupId !== groupId) throw new V2StaleSettingsError();
        const id = selection?.applianceId ?? v2ApplianceId(groupId, product.manufacturer, product.modelNumber);
        const view = state.assessment.view; const at = v2ReadPoint(view, state.archive.at(-1)!); const current = readV2Appliance(view, at, id);
        if (selection && (current.alive.kind === 'missing' || current.row.revision !== selection.revision)) throw new V2StaleSettingsError();
        if ((current.alive.kind === 'conflict' || current.row.deleted) && (!selection || input.restorePresence !== true)) throw new V2StaleSettingsError();
        if (current.source.kind === 'conflict' && (!selection || !input.resolveOperationIds || !sameIds(input.resolveOperationIds, current.source.candidates.map(candidate => candidate.operationId)))) throw new V2StaleSettingsError();
        if (input.resolveOperationIds && current.source.kind !== 'conflict') throw new V2StaleSettingsError();
        const creating = current.alive.kind === 'missing';
        const matches = (maker: string, model: string) => (applianceManufacturerIdentity(maker) ?? normalizedApplianceModel(maker)) === (applianceManufacturerIdentity(product.manufacturer) ?? normalizedApplianceModel(product.manufacturer))
          && normalizedApplianceModel(model) === normalizedApplianceModel(product.modelNumber);
        const prior = current.appliance ?? current.candidates.find(candidate => candidate.appliance && matches(candidate.appliance.manufacturer, candidate.appliance.modelNumber))?.appliance;
        const makerField = readV2EditableField(view, at, 'appliance', id, 'manufacturer'); const modelField = readV2EditableField(view, at, 'appliance', id, 'modelNumber');
        if (prior ? !matches(prior.manufacturer, prior.modelNumber) : !creating && !(makerField.kind === 'value' && typeof makerField.value === 'string'
          && modelField.kind === 'value' && typeof modelField.value === 'string' && matches(makerField.value, modelField.value))) throw new Error('別のメーカー・型番は、新しい共有家電として登録してください。');
        const oldName = readV2EditableField(view, at, 'appliance', id, 'displayName'); const oldCreated = readV2EditableField(view, at, 'appliance', id, 'createdAt');
        const content = normalizeV2ReviewedAppliance({ manufacturer: product.manufacturer.trim(), productName: product.productName.trim(), modelNumber: product.modelNumber.trim(),
          displayName: input.reviewedDisplayName ?? applianceDisplayName(product, prior?.displayName ?? (oldName.kind === 'value' && typeof oldName.value === 'string' ? oldName.value : undefined)), category: product.category ?? '',
          officialProductUrl: result.officialSources.productUrl ?? null, officialManualUrl: result.officialSources.manualUrl, analysis: result.analysis, reviewed: true });
        if (!content) throw new Error('メーカーの公式資料と解析結果を確認してください。');
        const analysis = content.analysis as unknown as ApplianceCareAnalysisDraft;
        if (!Array.isArray(input.addTaskNames) || new Set(input.addTaskNames).size !== input.addTaskNames.length
          || new Set(analysis.tasks.map(task => task.name)).size !== analysis.tasks.length
          || input.addTaskNames.some(name => !analysis.tasks.some(task => task.name === name))) throw new Error('追加するお手入れ項目を確認してください。');
        const equal = current.source.kind === 'value' && canonicalJson(current.source.value) === canonicalJson(content);
        if (!selection && !creating && !equal) throw new V2ApplianceAlreadyExistsError(id);
        const drafts: SharedOperationDraft[] = []; const createdChoreIds: string[] = []; const preservedTaskNames: string[] = []; const knownNames = new Set<string>();
        for (const choreId of new Set(view.ofType('chore').map(operation => operation.entityId))) {
          const alive = readV2EditableField(view, at, 'chore', choreId, '$alive'); if (alive.kind === 'value' && alive.value === false) continue;
          for (const candidate of readV2EditableField(view, at, 'chore', choreId, 'name').candidates) if (typeof candidate.value === 'string') knownNames.add(candidate.value);
        }
        for (const name of input.addTaskNames) {
          const task = analysis.tasks.find(task => task.name === name)!;
          const choreId = `care.${sharedDocumentDigest([groupId, id, name])}`;
          const definition = toApplianceCareChore(choreId, `shared:${groupId}`, { applianceId: id, manufacturer: product.manufacturer, productName: product.productName,
            modelNumber: product.modelNumber, category: product.category, manualUrl: result.officialSources.manualUrl, officialProductUrl: result.officialSources.productUrl }, analysis, { task });
          if (view.topic('chore', choreId).length || knownNames.has(definition.name)) { preservedTaskNames.push(name); continue; }
          const { category, description, locationOrAppliance, instructions, tools, cautions, applianceCareSource, applianceId, applianceTaskName, manufacturerRecommendedConditions } = definition;
          const fields = JSON.parse(JSON.stringify({ name: definition.name, category, description, locationOrAppliance, instructions, tools, cautions,
            applianceCareSource, applianceId, applianceTaskName, manufacturerRecommendedConditions, enabled: false }));
          drafts.push(draft('chore', choreId, fields)); createdChoreIds.push(choreId); knownNames.add(definition.name);
        }
        if (!selection && !creating && drafts.length) throw new V2ApplianceAlreadyExistsError(id);
        if (creating || !equal || input.restorePresence) drafts.unshift(draft('appliance', id, { ...content,
          createdAt: prior?.createdAt ?? (oldCreated.kind === 'value' && typeof oldCreated.value === 'string' && Number.isFinite(Date.parse(oldCreated.value)) ? oldCreated.value : instant),
          updatedAt: instant }, input.restorePresence ? 'restore' : 'patch'));
        if (manual) drafts.unshift(...manualDocumentDrafts(view, manual, options.makeId));
        saved = { applianceId: id, createdChoreIds, preservedTaskNames }; return drafts;
      });
      if (!saved) throw new V2StaleSettingsError(); return { ...saved, operations };
    },
  };
}
