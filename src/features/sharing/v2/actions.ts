import { createV2CalendarActions } from './calendar-actions.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { createV2EventRepository, V2LocalCompletionIntent } from '../../../platform/storage/sharing-v2-events.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { v2ReadPoint } from './view-point.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { frameAtOperation } from './authority-context.ts';
import { nextV2CommonOccurrence } from './next-occurrence.ts';
import { cancellationScopeMatches } from './date-cancellations.ts';
import { v2CancellationProposal, v2CancellationSelector } from './cancellation-proposal.ts';
import { v2DatePermissionId, v2SubjectOccurrenceId } from './occurrence-id.ts';
import { recordedInstructionAt } from './recorded-instruction.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { v2CompletionHistory } from './completion-history.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { selectManualRule } from './period-rules.ts';
import { v2DateChangeOriginal } from './date-change-original.ts';
import { dateChangeContextAtOperation } from './receiver-authority.ts';
import { targetCivilDate, validateDesignationTarget } from './date-target.ts';
import { changeGroupKind } from './model.ts';
import { prepareV2ConfigurationEdit, mergeV2ConfigurationFieldEdits, V2StaleSettingsError } from './configuration-edit.ts';
import type { V2ConfigurationPatch, V2ConfigurationFieldEdit } from './configuration-edit.ts';
import { prepareV2FieldEdits, editableFieldFromOperations, readV2EditableField, V2_CHORE_DETAIL_FIELDS } from './field-edit.ts';
import type { V2EditableField, V2FieldEdit, V2FieldSaveResult } from './field-edit';
import { editableDateRightsFromOperations, prepareV2DateRightsEdit } from './date-rights-edit.ts';
import type { V2DateRightsEdit } from './date-rights-edit';
import { v2MembershipStart } from './membership-period.ts';
import { createV2WasteActions } from './waste-actions.ts';
import { createV2ApplianceActions } from './appliance-actions.ts';
import { expandedCommonWindow } from './window-extension.ts';
import { v2DateDecisionReview, v2AssignmentDecisionReview } from './decision-review.ts';
import type { V2DateDecisionEdit, V2DecisionEdit } from './decision-review.ts';
import { v2AssignmentRequestReference, approvedV2AssignmentId, observedV2AssignmentCancellations } from './assignment-state.ts';
import type { DateTarget, DesignationMode, DesignationOptions, GroupKind, GroupPolicy, RuleSelector, SharedChoreConfiguration } from './model.ts';
import { choreScheduleDefaults } from '../../../domain/chores/schedule-defaults.ts';
import type { FrequencyMode } from '../../../domain/chores/types';
import { sharedDocumentDigest } from '../crypto.ts';
import { v2RetainedCompletions } from './retained-completions.ts';

export interface V2RoundReference { choreId: string; anchorDate: LocalDate; ruleVersion: number; subjectUserId: string | null;
  /** The displayed configuration frontier is an optimistic edit guard, never part of a signed business payload. */
  expectedConfigurationIds?: readonly string[]; expectedTimeZone?: string }
export interface V2RetainedUndoReference extends Pick<V2RoundReference, 'choreId' | 'anchorDate' | 'subjectUserId'> { checkpointId: string; recorderUserIds: readonly string[] }
export interface V2AssignmentEdit {
  expectedAssignmentIds?: readonly string[]; expectedConflictIds?: readonly string[]; expectedClaimIds?: readonly string[];
  expectedTargetOccurrenceId?: string;
}
export class V2ActionConfirmationError extends Error {
  readonly code = 'sharing/v2-confirmation-required';
  readonly reason: 'recentWork' | 'highLoad';
  constructor(reason: 'recentWork' | 'highLoad') {
    super(reason === 'recentWork' ? '最近実施されていますが、もう一度指定しますか？' : 'この日は家事の負荷が高くなっています。この日に指定しますか？'); this.reason = reason;
  }
}
/** Every action reads authenticated state inside the same transaction that stores its signed facts and Outbox. */
export function createV2PlannerActions(repository: ReturnType<typeof createV2EventRepository>, options: { makeId: () => string; now: () => Date }) {
  const scope = repository.scope;
  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  const draft = (entityType: SharedOperation['entityType'], entityId: string | null, payload: unknown, operationType: SharedOperation['operationType'] = 'patch'): SharedOperationDraft => {
    const operationId = options.makeId(); return { operationId, entityType, entityId: entityId ?? operationId, payload: json(payload), operationType };
  };
  const editGroupOptions = async (edits: readonly V2FieldEdit[]): Promise<V2FieldSaveResult> => {
    if (edits.some(edit => !['name', 'timeZone', 'configuration'].includes(edit.field))) throw new Error('変更するグループ設定を確認してください。');
    let fields: Record<string, V2EditableField> | undefined;
    const operations = await repository.commitCurrent(async state => {
      const view = state.assessment.view; const at = point(state);
      const settings = prepareV2FieldEdits({ view, at, type: 'settings', entityId: 'settings', allowed: ['name', 'timeZone'], edits: edits.filter(edit => edit.field !== 'configuration') });
      const policy = prepareV2FieldEdits({ view, at, type: 'groupPolicy', entityId: 'policy', allowed: ['configuration'], edits: edits.filter(edit => edit.field === 'configuration') });
      fields = { ...settings.fields, ...policy.fields };
      return [...(Object.keys(settings.patch).length ? [draft('settings', 'settings', settings.patch)] : []),
        ...(Object.keys(policy.patch).length ? [draft('groupPolicy', 'policy', policy.patch)] : [])];
    });
    if (!fields) throw new V2StaleSettingsError();
    return { operations, fields: Object.fromEntries(Object.entries(fields).map(([field, current]) => {
      const changed = operations.filter(operation => Object.hasOwn(operation.payload, field));
      return [field, changed.length ? editableFieldFromOperations(changed, field) : current];
    })) };
  };
  type State = Awaited<ReturnType<typeof repository.readState>>;
  function point(state: State): SharedOperation {
    const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
    return { ...at, authorUserId: scope.userId, authorDeviceId: scope.deviceId, deviceSequence: (at.context[scope.deviceId] ?? 0) + 1 };
  }
  const sameIds = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
  const queuedCompletionId = (id: string) => `completion.${sharedDocumentDigest(['liflow-queued-completion-v1', scope.groupId, scope.userId, scope.deviceId, id])}`;
  function expectDisplayedState(state: State, ref: V2RoundReference) {
    if (ref.expectedConfigurationIds && !sameIds(ref.expectedConfigurationIds,
      maximalCausalFacts(state.assessment.view.topic('chorePolicy', ref.choreId)).map((op) => op.operationId))) throw new V2StaleSettingsError();
    if (ref.expectedTimeZone !== undefined && ref.expectedTimeZone !== state.assessment.view.field('settings', 'settings', 'timeZone', point(state))?.value) throw new V2StaleSettingsError();
  }
  const frame = (state: State, ref: V2RoundReference) => {
    expectDisplayedState(state, ref); return frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion);
  };
  function expectAssignment(context: ReturnType<typeof frame>, edit: V2AssignmentEdit) {
    if (edit.expectedAssignmentIds && !sameIds(edit.expectedAssignmentIds, context.assignmentOperationIds)
      || edit.expectedConflictIds && !sameIds(edit.expectedConflictIds, context.assignmentConflictIds)
      || edit.expectedClaimIds && !sameIds(edit.expectedClaimIds, context.claims.activeClaimOperationIds)
      || edit.expectedTargetOccurrenceId !== undefined && edit.expectedTargetOccurrenceId !== context.frame.id) throw new V2StaleSettingsError();
  }
  function assignmentTarget(state: State, ref: V2RoundReference, start: 'this' | 'next', allowAssignmentConflict: boolean) {
    expectDisplayedState(state, ref); const at = point(state);
    const current = frameAtOperation(state.assessment.view, state.archive, at, ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict });
    if (start === 'this') return current;
    const next = nextV2CommonOccurrence(state.assessment.view, at, ref.choreId, ref.anchorDate);
    return frameAtOperation(state.assessment.view, state.archive, at, ref.choreId, next.anchorDate, next.ruleVersion, { allowAssignmentConflict });
  }
  function datePlacementReview(state: State, ref: V2RoundReference, target: DateTarget, plan = buildV2CommonPlan(state,
    { from: ref.anchorDate, through: ref.anchorDate, asOfDate: ref.anchorDate })) {
    const civil = targetCivilDate(target, plan.timeZone);
    const subject = plan.occurrences.find((round) => round.choreId === ref.choreId && round.anchorDate === ref.anchorDate)?.subjects.find((slot) => slot.subjectUserId === ref.subjectUserId);
    const targetPlan = buildV2CommonPlan(state, { from: addDays(civil, -14), through: addDays(civil, 14), asOfDate: ref.anchorDate });
    const loads = new Map(targetPlan.chores.map((chore) => [chore.id, chore.load])); const load = loads.get(ref.choreId);
    const assignees = subject?.assigneeIds ?? frame(state, ref).assigneeIds;
    let count = 0;
    for (const round of targetPlan.occurrences) for (const slot of round.subjects) {
      if (slot.id === subject?.id || !slot.required || slot.completed || slot.suggestedDate !== civil || loads.get(round.choreId) !== load) continue;
      if (!assignees.length || !slot.assigneeIds.length || slot.assigneeIds.some((uid) => assignees.includes(uid))) count++;
    }
    const limit = plan.commonSettings[load === 'heavy' ? 'heavyDailyLimit' : 'normalDailyLimit'];
    return { subject, recentWork: subject?.minimumNextExecutionDay !== null && subject?.minimumNextExecutionDay !== undefined && civil < subject.minimumNextExecutionDay,
      highLoad: load !== 'light' && typeof limit === 'number' && count + 1 > limit };
  }
  function completionDrafts(state: State, ref: V2RoundReference, input: { performedAt?: string; performerUserId?: string; additionalWork?: boolean; expectedAssigneeIds?: readonly string[] }, performedAt: string): SharedOperationDraft[] {
    const context = frame(state, ref); const at = point(state); const view = state.assessment.view;
    if (input.expectedAssigneeIds && !sameIds(input.expectedAssigneeIds, ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId])) throw new V2StaleSettingsError();
    const history = v2CompletionHistory(view, at, state.receipts, ref);
    if (!input.additionalWork && history.some(record => record.occurrenceId === context.frame.id && record.subjectUserId === ref.subjectUserId
      && record.active && record.outcome === 'completed' && record.acceptance !== 'rejected')) return [];
    if (!input.additionalWork && v2RetainedCompletions(view, at).some(row => row.choreId === ref.choreId && row.anchorDate === ref.anchorDate && row.subjectUserId === ref.subjectUserId && row.reports.length)) return [];
    const instruction = recordedInstructionAt(view, at, context.frame, ref.subjectUserId, state.assessment.formalRulesAt(at));
    const scheduledDate = instruction.kind === 'designated' ? targetCivilDate(instruction.target, instruction.timeZone) : ref.anchorDate;
    const commonWindow = expandedCommonWindow({ frame: context.frame, timeZone: instruction.timeZone, view, at, requests: state.assessment.requestStates,
      approvedRules: state.assessment.formalRulesAt(at), receiptEpochs: state.assessment.receiptEpochs });
    const windowStart = instruction.kind === 'designated' && scheduledDate < commonWindow.windowStart ? scheduledDate : commonWindow.windowStart;
    const windowEnd = instruction.kind === 'designated' && scheduledDate > commonWindow.windowEnd ? scheduledDate : commonWindow.windowEnd;
    return [draft('completion', v2SubjectOccurrenceId(context.frame.id, ref.subjectUserId), { choreId: ref.choreId, anchorDate: ref.anchorDate,
      subjectUserId: ref.subjectUserId, ruleVersion: context.config.ruleVersion, completedAt: performedAt, completedByMemberId: input.performerUserId ?? scope.userId,
      originalAssigneeIds: ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId], outcome: 'completed',
      recordedInstruction: instruction, recordedCommonWindow: { start: commonWindow.windowStart, end: commonWindow.windowEnd }, scheduledDate,
      scheduledWindowStart: windowStart, scheduledWindowEnd: windowEnd,
      completionNote: input.performedAt ? 'alreadyDone' : 'completedNow' }, 'complete')];
  }
  function undoDrafts(state: State, targetOperationIds: readonly string[], retained?: V2RetainedUndoReference): SharedOperationDraft[] {
    const view = state.assessment.view; const result: SharedOperationDraft[] = [];
    for (const targetOperationId of new Set(targetOperationIds)) {
      const target = view.byId(targetOperationId);
      if (!target || target.entityType !== 'completion' || target.operationType !== 'complete') throw new Error('取り消す完了記録を確認してください。');
      if (view.ofType('completion').some((op) => op.operationType === 'undo' && op.payload.targetOperationId === targetOperationId)) continue;
      result.push(draft('completion', target.entityId, { targetOperationId }, 'undo'));
    }
    if (retained) {
      const at = point(state); const checkpoint = view.retentionAt(at);
      if (!checkpoint || sharedDocumentDigest(checkpoint) !== retained.checkpointId) throw new V2StaleSettingsError();
      const current = v2RetainedCompletions(view, at).find(row => row.choreId === retained.choreId && row.anchorDate === retained.anchorDate && row.subjectUserId === retained.subjectUserId);
      if (!current) throw new V2StaleSettingsError();
      const recorderUserIds = [...new Set(retained.recorderUserIds)].filter(uid => current.reports.some(report => report.recorderUserId === uid));
      if (recorderUserIds.length) result.push(draft('retainedCompletionUndo', null, { choreId: retained.choreId, anchorDate: retained.anchorDate,
        subjectUserId: retained.subjectUserId, checkpointId: retained.checkpointId, recorderUserIds }));
    }
    return result;
  }
  const undoTargets = (targetOperationIds: readonly string[], retained?: V2RetainedUndoReference) => repository.commitCurrent(async state => undoDrafts(state, targetOperationIds, retained));
  function configurationFieldDrafts(state: State, choreId: string, edits: readonly NonNullable<V2ConfigurationFieldEdit>[], effectiveFrom: LocalDate): SharedOperationDraft[] {
    const at = point(state); const enabled = state.assessment.view.field('chore', choreId, 'enabled', at)?.value === true;
    const current = state.assessment.view.field('chorePolicy', choreId, 'configuration', at)?.value as unknown as SharedChoreConfiguration | undefined;
    const activation = edits.find((entry) => entry.field === 'active'); const prepared = [...edits];
    if (activation?.value === true && (!enabled || current?.active === false) && !prepared.some((entry) => entry.field === 'anchorDate')) {
      prepared.push({ field: 'anchorDate', baseRuleVersion: activation.baseRuleVersion, value: effectiveFrom });
    }
    const edit = mergeV2ConfigurationFieldEdits({ view: state.assessment.view, at, choreId, edits: prepared, effectiveFrom });
    if (!edit) return activation && typeof activation.value === 'boolean' && activation.value !== enabled
      ? [draft('chore', choreId, { enabled: activation.value, requiresCycleSelection: false })] : [];
    const configuration = prepareV2ConfigurationEdit({ view: state.assessment.view, archive: state.archive, at: point(state), choreId, ...edit });
    return [draft('chorePolicy', choreId, { configuration }), draft('chore', choreId, { enabled: configuration.active !== false, requiresCycleSelection: false })];
  }
  const configureFields = (choreId: string, edits: readonly NonNullable<V2ConfigurationFieldEdit>[], effectiveFrom: LocalDate) =>
    repository.commitCurrent(async (state) => configurationFieldDrafts(state, choreId, edits, effectiveFrom));
  function assignmentCancellations(state: State, ids: readonly string[]): SharedOperationDraft[] {
    const at = point(state); const view = state.assessment.view; const cancelled = observedV2AssignmentCancellations(view, at);
    const sources = [...new Set(ids.map((id) => {
      const source = view.byId(id); if (source && ['assignmentRule', 'assignmentRequest'].includes(source.entityType)) return id;
      const request = view.ofType('assignmentRequest').find((op) => approvedV2AssignmentId(op) === id);
      if (!request) throw new Error('解除する担当指定を確認してください。'); return request.operationId;
    }))].filter((id) => !cancelled.has(id));
    return sources.length ? [draft('assignmentCancel', null, { targetOperationIds: sources })] : [];
  }
  return {
    ...createV2WasteActions(repository, options.makeId),
    ...createV2CalendarActions(repository, options.makeId),
    ...createV2ApplianceActions(repository, options),
    readPlan: async (range: Parameters<typeof buildV2CommonPlan>[1]) => buildV2CommonPlan(await repository.readState(), range),
    addChore: (name: string, instructions: string[] = []) => {
      const id = options.makeId(); return repository.commit([draft('chore', id, { name: name.trim(), instructions, enabled: false })]);
    },
    patchChoreDetails: async (choreId: string, edits: readonly V2FieldEdit[]): Promise<V2FieldSaveResult> => {
      let prepared: ReturnType<typeof prepareV2FieldEdits> | undefined;
      const save = (split: boolean) => repository.commitCurrent(async (state) => {
        const at = point(state);
        if (state.assessment.view.field('chore', choreId, '$alive', at)?.value !== true) throw new V2StaleSettingsError();
        prepared = prepareV2FieldEdits({ view: state.assessment.view, at, type: 'chore', entityId: choreId, edits, allowed: V2_CHORE_DETAIL_FIELDS });
        if (!Object.keys(prepared.patch).length) return [];
        return split ? Object.entries(prepared.patch).map(([field, value]) => draft('chore', choreId, { [field]: value }))
          : [draft('chore', choreId, prepared.patch)];
      });
      let operations: SharedOperation[];
      try { operations = await save(false); }
      catch (cause) {
        if (!(cause instanceof Error) || cause.message !== 'Shared operation is too large' || Object.keys(prepared?.patch ?? {}).length < 2) throw cause;
        // The first transaction rolled back. Recheck the displayed bases and commit all bounded fields together.
        // An individually oversized field still rolls the entire retry back, including its sequence and outbox.
        operations = await save(true);
      }
      if (!prepared) throw new V2StaleSettingsError();
      const fields = { ...prepared.fields };
      for (const field of Object.keys(prepared.patch)) fields[field] = editableFieldFromOperations(operations, field);
      return { operations, fields };
    },
    patchChore: (choreId: string, patch: Record<string, JsonValue>, effectiveFrom?: LocalDate) => {
      const operationTime = options.now();
      return repository.commitCurrent(async (state) => {
        if (typeof patch.enabled !== 'boolean' || scope.userId !== state.archive.at(-1)!.body.ownerUserId) return [draft('chore', choreId, patch)];
        const current = state.assessment.view.field('chorePolicy', choreId, 'configuration', point(state))?.value as unknown as SharedChoreConfiguration | undefined;
        if (!current) {
          if (patch.enabled) throw new Error('周期と担当の種類を設定してから、この家事を有効にしてください。');
          return [draft('chore', choreId, patch)];
        }
        const zone = state.assessment.view.field('settings', 'settings', 'timeZone', point(state))?.value;
        if (typeof zone !== 'string') throw new Error('グループ設定を同期してください。');
        const from = effectiveFrom ?? sharedLocalDate(operationTime, zone);
        const operations = configurationFieldDrafts(state, choreId, [{ field: 'active', value: patch.enabled, baseRuleVersion: current.ruleVersion }], from);
        const { enabled: _enabled, ...other } = patch;
        if (Object.keys(other).length) operations.push(draft('chore', choreId, other));
        return operations;
      });
    },
    configureChore: (choreId: string, value: Omit<SharedChoreConfiguration, 'ruleVersion'>, edit: { expectedRuleVersion?: number; preserveAssignments?: boolean; resolveConfigurationIds?: string[] } = {}) => repository.commitCurrent(async (state) => {
      const configuration = prepareV2ConfigurationEdit({ view: state.assessment.view, archive: state.archive, at: point(state), choreId, value, ...edit });
      return [draft('chorePolicy', choreId, { configuration }), draft('chore', choreId, { enabled: value.active !== false, requiresCycleSelection: false })];
    }),
    patchChoreConfiguration: (choreId: string, baseRuleVersion: number, patch: V2ConfigurationPatch, effectiveFrom: LocalDate) => configureFields(choreId,
      Object.entries(patch).map(([field, value]) => ({ field, value, baseRuleVersion }) as NonNullable<V2ConfigurationFieldEdit>), effectiveFrom),
    patchChoreConfigurationFields: configureFields,
    resetChoreSchedules: (choreIds: readonly string[], expectedRuleVersions: Readonly<Record<string, number | undefined>>, effectiveFrom?: LocalDate) => repository.commitCurrent(async state => {
      if (scope.userId !== state.archive.at(-1)!.body.ownerUserId) throw new Error('初期値への復元はグループの管理者が行えます。');
      if (!choreIds.length || choreIds.length > 256 || new Set(choreIds).size !== choreIds.length) throw new Error('対象の家事を確認してください。');
      const view = state.assessment.view; const at = point(state); const zone = view.field('settings', 'settings', 'timeZone', at)?.value;
      if (typeof zone !== 'string') throw new V2StaleSettingsError();
      const mode = (view.field('settings', 'settings', 'frequencyMode', at)?.value ?? 'balanced') as FrequencyMode;
      const from = effectiveFrom ?? sharedLocalDate(options.now(), zone); const result: SharedOperationDraft[] = [];
      for (const choreId of choreIds) {
        if (view.field('chore', choreId, '$alive', at)?.value !== true || view.field('chore', choreId, 'archived', at)?.value === true) throw new V2StaleSettingsError();
        const current = view.field('chorePolicy', choreId, 'configuration', at)?.value as unknown as SharedChoreConfiguration | undefined;
        if (current?.ruleVersion !== expectedRuleVersions[choreId]) throw new V2StaleSettingsError();
        const facts = view.observed(view.topic('chore', choreId), at);
        const defaults = choreScheduleDefaults({ id: choreId, applianceId: facts.find(op => typeof op.payload.applianceId === 'string')?.payload.applianceId as string | undefined, manufacturerRecommendedIntervalDays: facts.find(op => typeof op.payload.manufacturerRecommendedIntervalDays === 'number')?.payload.manufacturerRecommendedIntervalDays as number | undefined });
        const initial = view.observed(view.topic('chorePolicy', choreId), at).map(op => op.payload.configuration as unknown as SharedChoreConfiguration)
          .filter(Boolean).sort((a, b) => a.ruleVersion - b.ruleVersion)[0];
        // A custom chore uses its first authenticated configuration, never another chore's name or policy.
        if (current && (defaults || initial)) {
          const appliance = facts.some(op => typeof op.payload.applianceId === 'string');
          const cycle = defaults?.requiresCycleSelection ? current.intervalDays : appliance && initial ? initial.intervalDays : defaults?.frequencyDaysByMode[mode] ?? initial!.intervalDays;
          const before = defaults?.windowRadiusDays ?? initial!.windowBeforeDays;
          const after = defaults?.windowRadiusDays ?? initial!.windowAfterDays;
          result.push(...configurationFieldDrafts(state, choreId, [
            { field: 'intervalDays', value: cycle, baseRuleVersion: current.ruleVersion },
            { field: 'windowBeforeDays', value: before, baseRuleVersion: current.ruleVersion },
            { field: 'windowAfterDays', value: after, baseRuleVersion: current.ruleVersion },
          ], from));
        }
        const first = facts[0]?.payload;
        const scheduling = defaults ?? { load: first?.load ?? 'normal', holidayPriority: first?.holidayPriority ?? false, maxShiftDays: first?.maxShiftDays ?? 4, everyday: first?.everyday ?? false };
        result.push(draft('chore', choreId, { load: scheduling.load, holidayPriority: scheduling.holidayPriority, maxShiftDays: scheduling.maxShiftDays, everyday: scheduling.everyday }));
      }
      return result;
    }),
    changeGroupKind: (kind: GroupKind) => repository.commitCurrent(async (state) => {
      const current = state.assessment.view.field('groupPolicy', 'policy', 'configuration', point(state));
      if (!current) throw new Error('グループ設定を同期してください。');
      return [draft('groupPolicy', 'policy', { configuration: changeGroupKind(current.value as unknown as GroupPolicy, kind) })];
    }),
    patchGroupPolicy: (patch: Partial<GroupPolicy>) => repository.commitCurrent(async (state) => {
      const current = state.assessment.view.field('groupPolicy', 'policy', 'configuration', point(state));
      if (!current) throw new Error('グループ設定を同期してください。');
      return [draft('groupPolicy', 'policy', { configuration: { ...current.value as object, ...patch } })];
    }),
    editGroupPolicy: (edit: Omit<V2FieldEdit, 'field'>) => editGroupOptions([{ ...edit, field: 'configuration' }]),
    editGroupOptions,
    complete: (ref: V2RoundReference, input: { performedAt?: string; performerUserId?: string; additionalWork?: boolean; expectedAssigneeIds?: readonly string[] } = {}) => {
      const performedAt = input.performedAt ?? options.now().toISOString();
      return repository.commitCurrent(async state => completionDrafts(state, ref, input, performedAt));
    },
    setCompletedIntent: (intent: V2LocalCompletionIntent, ref: V2RoundReference, completed: boolean, input: { createdAt: string; expectedAssigneeIds?: readonly string[];
      observedCompletionIds?: readonly string[]; precedingCompletionIntentIds?: readonly string[]; retainedUndo?: V2RetainedUndoReference }) => {
      if (typeof completed !== 'boolean' || !Number.isFinite(Date.parse(input.createdAt))) throw new Error('保存待ちの完了操作を確認できません。');
      return repository.commitCompletionIntent(intent, async state => {
        if (completed) return completionDrafts(state, ref, { expectedAssigneeIds: input.expectedAssigneeIds }, input.createdAt)
          .map(operation => ({ ...operation, operationId: queuedCompletionId(intent.id) }));
        const at = point(state); const view = state.assessment.view;
        const canUndo = (recorder: string) => recorder === scope.userId || state.archive.at(-1)!.body.ownerUserId === scope.userId;
        const observed = input.observedCompletionIds === undefined ? null : new Set([
          ...input.observedCompletionIds, ...(input.precedingCompletionIntentIds ?? []).map(queuedCompletionId)]);
        const targets = v2CompletionHistory(view, at, state.receipts, ref).filter(record => record.subjectUserId === ref.subjectUserId
          && record.active && record.outcome === 'completed' && canUndo(record.recorderUserId) && (!observed || observed.has(record.operationId)));
        const retained = v2RetainedCompletions(view, at).find(row => row.choreId === ref.choreId && row.anchorDate === ref.anchorDate && row.subjectUserId === ref.subjectUserId);
        const recorderUserIds = retained?.reports.map(report => report.recorderUserId).filter(uid => canUndo(uid)
          && (!observed || input.retainedUndo?.recorderUserIds.includes(uid))) ?? [];
        if (observed && recorderUserIds.length && (input.retainedUndo?.checkpointId !== sharedDocumentDigest(view.retentionAt(at))
          || input.retainedUndo.choreId !== ref.choreId || input.retainedUndo.anchorDate !== ref.anchorDate || input.retainedUndo.subjectUserId !== ref.subjectUserId)) throw new V2StaleSettingsError();
        return undoDrafts(state, targets.map(record => record.operationId), recorderUserIds.length ? {
          choreId: ref.choreId, anchorDate: ref.anchorDate, subjectUserId: ref.subjectUserId,
          checkpointId: sharedDocumentDigest(view.retentionAt(at)), recorderUserIds,
        } : undefined);
      });
    },
    undo: (targetOperationId: string) => undoTargets([targetOperationId]),
    undoMany: undoTargets,
    claim: (ref: V2RoundReference) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref);
      if (context.assigneeIds.includes(scope.userId)) return [];
      return [draft('claim', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id, userId: scope.userId })];
    }),
    releaseClaim: (ref: V2RoundReference) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); const view = state.assessment.view;
      const targets = context.claims.activeClaimOperationIds.filter((id) => view.byId(id)?.authorUserId === scope.userId);
      if (!targets.length) return [];
      return [draft('claimRelease', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id, userId: scope.userId, targetOperationIds: targets })];
    }),
    resolveClaims: (ref: V2RoundReference, assigneeIds: string[], fixed: boolean, expectedClaimIds?: readonly string[]) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref);
      if (expectedClaimIds && !sameIds(expectedClaimIds, context.claims.activeClaimOperationIds)) throw new V2StaleSettingsError();
      return [draft('claimResolution', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id,
        claimOperationIds: context.claims.activeClaimOperationIds, assigneeIds, fixed })];
    }),
    readAssignmentTarget: async (ref: V2RoundReference, start: 'this' | 'next') => {
      const state = await repository.readState(); const target = assignmentTarget(state, ref, start, true);
      return { occurrenceId: target.frame.id, anchorDate: target.frame.anchorDate, ruleVersion: target.config.ruleVersion,
        assigneeIds: target.assigneeIds, assignmentIds: target.assignmentOperationIds, conflictIds: target.assignmentConflictIds,
        mappingReviewIds: target.assignmentMappingReviewIds, claimIds: target.claims.activeClaimOperationIds,
        claimantUserIds: target.claims.assigneeIds, fixed: target.assignmentFixed, active: target.config.active !== false
          && state.assessment.view.field('chore', ref.choreId, 'enabled', point(state))?.value === true,
        completion: target.config.policy.completion };
    },
    assign: (ref: V2RoundReference, memberIds: string[], start: 'this' | 'next', fixed: boolean, edit: V2AssignmentEdit & { scope?: 'once' | 'from' } = {}) => repository.commitCurrent(async (state) => {
      const next = assignmentTarget(state, ref, start, true);
      expectAssignment(next, edit);
      return [draft('assignmentRule', null, { choreId: ref.choreId, fromOccurrenceId: next.frame.id, fromAnchorDate: next.frame.anchorDate,
        scope: edit.scope ?? 'from', memberIds, fixed, ruleVersion: next.config.ruleVersion, basisRuleIds: next.assignmentOperationIds })];
    }),
    resolveAssignment: (ref: V2RoundReference, memberIds: string[], scope: 'once' | 'from', fixed: boolean, edit: V2AssignmentEdit = {}) => repository.commitCurrent(async (state) => {
      expectDisplayedState(state, ref);
      const context = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      expectAssignment(context, edit);
      return [draft('assignmentRule', null, { choreId: ref.choreId, fromOccurrenceId: context.frame.id, fromAnchorDate: ref.anchorDate, scope, memberIds, fixed,
        ruleVersion: ref.ruleVersion, basisRuleIds: context.assignmentOperationIds,
        ...(context.assignmentReviewRequestIds.length ? { reviewedAssignmentRequestIds: context.assignmentReviewRequestIds } : {}) })];
    }),
    cancelAssignments: (sourceOperationIds: readonly string[]) => repository.commitCurrent(async (state) => assignmentCancellations(state, sourceOperationIds)),
    remapAssignments: (sourceOperationIds: readonly string[], ref: V2RoundReference, memberIds: string[], scope: 'once' | 'from', fixed: boolean, edit: V2AssignmentEdit = {}) => repository.commitCurrent(async (state) => {
      expectDisplayedState(state, ref);
      const cancellations = assignmentCancellations(state, sourceOperationIds); if (!cancellations.length) return [];
      const at = point(state); const context = frameAtOperation(state.assessment.view, state.archive, at, ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      expectAssignment(context, edit);
      const sources = new Set(cancellations[0].payload.targetOperationIds as string[]);
      if ([...sources].some((id) => state.assessment.view.byId(id)?.payload.choreId !== ref.choreId)) throw new Error('同じ家事の中で担当を対応付けてください。');
      const remaining = state.assessment.view.assignmentsAt(at)?.facts.filter((fact) => fact.payload.choreId === ref.choreId && !sources.has(fact.sourceRequestId ?? fact.operationId)) ?? [];
      const reviews = context.assignmentReviewRequestIds.filter((id) => !sources.has(id));
      return [...cancellations, draft('assignmentRule', null, { choreId: ref.choreId, memberIds, fromOccurrenceId: context.frame.id, fromAnchorDate: ref.anchorDate,
        scope, fixed, ruleVersion: ref.ruleVersion, basisRuleIds: [...new Set(remaining.map((fact) => fact.operationId))].sort(),
        ...(reviews.length ? { reviewedAssignmentRequestIds: reviews } : {}) })];
    }),
    requestAssignment: (ref: V2RoundReference, input: { memberIds: string[]; start: 'this' | 'next'; scope: 'once' | 'from'; fixed: boolean } & V2AssignmentEdit) => repository.commitCurrent(async (state) => {
      const at = point(state); const context = assignmentTarget(state, ref, input.start, false); const anchor = context.frame.anchorDate;
      expectAssignment(context, input);
      const reference = v2AssignmentRequestReference(state.assessment.view, at, context.frame,
        context.config.policy.completion === 'perMember' ? context.subjectUserIds : [], state.assessment.formalRulesAt(at));
      const proposal = { requesterUserId: scope.userId, choreId: ref.choreId, anchorDate: anchor, occurrenceId: context.frame.id,
        ruleVersion: context.config.ruleVersion, originalMemberIds: context.assigneeIds, originalAssignmentIds: context.assignmentOperationIds,
        originalClaimOperationIds: context.claims.activeClaimOperationIds, memberIds: [...input.memberIds].sort(), scope: input.scope, fixed: input.fixed, ...reference };
      if (state.assessment.assignmentRequests.some((request) => !request.cancelled && ['pendingDelivery', 'awaiting'].includes(request.kind)
        && canonicalJson(request.proposal) === canonicalJson(proposal))) return [];
      return [draft('assignmentRequest', null, proposal)];
    }),
    answerAssignment: (requestId: string, decision: 'approve' | 'reject', edit: V2DecisionEdit = {}) => repository.commitCurrent(async (state) => {
      const request = state.assessment.assignmentRequests.find((entry) => entry.requestId === requestId); if (!request) throw new Error('担当変更の申請を同期してください。');
      const review = v2AssignmentDecisionReview(state, requestId, scope.userId);
      if (edit.expectedDecisionIds && !sameIds(edit.expectedDecisionIds, review.answers.map((answer) => answer.operationId))
        || edit.expectedReviewRevision !== undefined && edit.expectedReviewRevision !== review.revision) throw new V2StaleSettingsError();
      if (request.cancelled) throw new Error('この担当変更の指定は解除されています。現在の担当を確認してください。');
      if (request.kind === (decision === 'approve' ? 'approved' : 'rejected')) return [];
      if (!['pendingDelivery', 'awaiting'].includes(request.kind)) throw new Error('この申請は締め切られています。現在の担当を確認してください。');
      const previous = state.assessment.view.ofType('assignmentDecision').find((op) => op.payload.requestId === requestId && op.authorDeviceId === scope.deviceId);
      if (previous) { if (previous.payload.decision === decision) return []; throw new Error('すでに回答しています。現在の担当を確認してください。'); }
      return [draft('assignmentDecision', null, { requestId, decision })];
    }),
    grantDateRights: (choreId: string, userId: string, enabled: boolean, rights: { changeDate: boolean; changeOthers: boolean; changeBeforeWindow: boolean }) =>
      repository.commit([draft('datePermission', v2DatePermissionId(scope.groupId, choreId, userId), { choreId, userId, enabled, rights })]),
    editDateRights: async (choreId: string, edits: readonly V2DateRightsEdit[], expectedPolicyIds: readonly string[]): Promise<V2FieldSaveResult> => {
      let prepared: ReturnType<typeof prepareV2DateRightsEdit>[] | undefined;
      const operations = await repository.commitCurrent(async (state) => {
        const at = point(state); const alive = readV2EditableField(state.assessment.view, at, 'chore', choreId, '$alive');
        const policy = readV2EditableField(state.assessment.view, at, 'groupPolicy', 'policy', 'configuration');
        if (alive.kind !== 'value' || alive.value !== true || policy.kind !== 'value'
          || !sameIds(expectedPolicyIds, policy.candidates.map(candidate => candidate.operationId))) throw new V2StaleSettingsError();
        if (edits.length > 16 || new Set(edits.map(edit => edit.userId)).size !== edits.length) throw new Error('変更するメンバーを確認してください。');
        if (edits.some(edit => !state.archive.at(-1)!.body.members.some(member => member.userId === edit.userId))) throw new V2StaleSettingsError();
        prepared = edits.map(edit => {
          const membershipStart = v2MembershipStart(state.archive, edit.userId, at.keyVersion);
          if (membershipStart === null) throw new V2StaleSettingsError();
          return prepareV2DateRightsEdit({ view: state.assessment.view, at, choreId, edit, membershipStart });
        });
        if ((policy.value as unknown as GroupPolicy).delegationEnabled !== true && prepared.some(entry => entry.payload.enabled !== false)) {
          throw new Error('委譲機能を有効にしてから権限を付与してください。');
        }
        return prepared.filter(entry => entry.changed).map(entry => draft('datePermission', entry.entityId, entry.payload));
      });
      if (!prepared) throw new V2StaleSettingsError();
      return { operations, fields: Object.fromEntries(prepared.map(entry => [entry.payload.userId, entry.changed
        ? editableDateRightsFromOperations(operations.filter(operation => operation.entityId === entry.entityId)) : entry.current])) };
    },
    changeDate: (ref: V2RoundReference, input: { mode: DesignationMode; target: DateTarget; selector?: RuleSelector; options?: Partial<DesignationOptions>;
      extensionScope?: 'once' | 'future'; reviewedRequestIds?: string[]; expectedRuleIds?: string[]; confirmDateConflict?: boolean;
      expectedAssigneeIds?: readonly string[]; expectedAssignmentIds?: readonly string[]; expectedConflictIds?: readonly string[]; expectedRequestReviewIds?: readonly string[];
      confirmRecentWork?: boolean; confirmHighLoad?: boolean }) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); expectAssignment(context, input);
      if (input.expectedAssigneeIds && !sameIds(input.expectedAssigneeIds, ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId])) throw new V2StaleSettingsError();
      const view = state.assessment.view; const at = point(state);
      const zone = view.field('settings', 'settings', 'timeZone', at)?.value as string;
      const target = validateDesignationTarget(input.mode, input.target);
      const rules = observedDateRules(view, at, state.assessment.formalRulesAt(at)); const selected = selectManualRule(rules, context.frame, ref.subjectUserId, zone);
      const originals = selected.kind === 'conflict' ? selected.candidates : selected.kind === 'selected' ? [selected.fact] : [];
      const { original, unresolved } = v2DateChangeOriginal(originals.map((fact) => fact.rule), context.frame, zone);
      const basisRuleIds = selected.kind === 'selected' ? selected.equivalentOperationIds : originals.map((fact) => fact.operationId);
      if (input.expectedRuleIds && canonicalJson([...input.expectedRuleIds].sort()) !== canonicalJson([...basisRuleIds].sort())) throw new V2StaleSettingsError();
      if ((selected.kind === 'conflict' || unresolved) && (!input.confirmDateConflict || !input.expectedRuleIds)) throw new V2StaleSettingsError();
      const selector = input.selector ?? { scope: 'once', occurrenceId: context.frame.id, anchorDate: ref.anchorDate };
      const proposedOptions = { strict: originals.some((fact) => fact.rule.strict), adminLocked: originals.some((fact) => fact.rule.adminLocked),
        forbidEarlier: originals.some((fact) => fact.rule.forbidEarlier), ...input.options };
      const plan = buildV2CommonPlan(state, { from: ref.anchorDate, through: ref.anchorDate, asOfDate: ref.anchorDate });
      const subject = plan.occurrences.find((round) => round.id === context.frame.id)?.subjects.find((slot) => slot.subjectUserId === ref.subjectUserId);
      if (input.expectedRequestReviewIds && !sameIds(input.expectedRequestReviewIds, subject?.requestReviewIds ?? [])) throw new V2StaleSettingsError();
      const civil = targetCivilDate(target, zone);
      if (subject?.dependencyNotBefore && civil < subject.dependencyNotBefore) throw new Error('先に必要な家事の実施日より後を指定してください。');
      if (subject?.dependencyBlocked && !subject.dependencyNotBefore) throw new Error('先に必要な家事の予定を確認してください。');
      const placement = datePlacementReview(state, ref, target, plan);
      if (placement.recentWork) {
        if (!input.confirmRecentWork) throw new V2ActionConfirmationError('recentWork'); proposedOptions.allowDuringCooldown = true;
      }
      if (placement.highLoad && !input.confirmHighLoad) throw new V2ActionConfirmationError('highLoad');
      const request = draft('changeRequest', null, { requesterUserId: scope.userId, choreId: ref.choreId, anchorDate: ref.anchorDate,
        occurrenceId: context.frame.id, subjectUserId: ref.subjectUserId, originalDesignationId: selected.kind === 'selected' ? selected.fact.operationId : null,
        original, proposed: target, proposedMode: input.mode, proposedOptions, selector, extensionScope: input.extensionScope ?? 'once',
        ...(basisRuleIds.length ? { basisRuleIds } : {}), ...(input.reviewedRequestIds?.length ? { reviewedRequestIds: input.reviewedRequestIds } : {}) });
      const probe = { ...at, ...request };
      const permission = dateChangeContextAtOperation(view, state.archive, probe, undefined, state.assessment.formalRulesAt(at), new Map(state.assessment.requestStates.map((entry) => [entry.requestId, entry])),
        { receipts: state.receipts, epochs: state.assessment.receiptEpochs }).permission;
      if (permission.kind === 'denied') throw new Error(permission.reason === 'fixedConflict' ? 'この時間帯は別の家事を行う必要があります。別の時間帯を指定してください'
        : permission.reason === 'dependency' ? '先に必要な家事の実施日時を確認してください。' : 'この日時を変更する権限を確認してください。');
      if (permission.kind !== 'allowed' || permission.needsRequest || input.extensionScope === 'future') return [request];
      return [{ ...request, entityType: 'designation', payload: json({ configuration: { id: request.operationId, choreId: ref.choreId, subjectUserId: ref.subjectUserId,
        selector, referenceAnchorDate: ref.anchorDate, timeZoneAtCreation: zone, mode: input.mode, target, ...proposedOptions,
        issuerUserId: scope.userId, ruleVersion: ref.ruleVersion, ...(basisRuleIds.length ? { basisRuleIds } : {}),
        ...(input.reviewedRequestIds?.length ? { reviewedRequestIds: input.reviewedRequestIds } : {}) } }) }];
    }),
    decide: (requestId: string, decision: 'approve' | 'reject' | 'counteroffer' | 'acceptCounteroffer', target: DateTarget | null = null, referenceDecisionId: string | null = null, edit: V2DateDecisionEdit = {}) =>
      repository.commitCurrent(async (state) => {
        const current = state.assessment.requestStates.find((entry) => entry.requestId === requestId);
        if (!current) throw new Error('申請を同期してください。');
        const review = v2DateDecisionReview(state, requestId, scope.userId);
        if (edit.expectedDecisionIds && !sameIds(edit.expectedDecisionIds, review.answers.map((answer) => answer.operationId))
          || edit.expectedReviewRevision !== undefined && edit.expectedReviewRevision !== review.revision) throw new V2StaleSettingsError();
        if (['approved', 'rejected', 'expired', 'tooLate', 'blocked'].includes(current.kind)) return [];
        let allowDuringCooldown = false;
        if (decision !== 'reject' && !(decision === 'approve' && current.proposal.cancellation)) {
          const offer = decision === 'acceptCounteroffer' ? current.counteroffers.find((entry) => entry.operationId === referenceDecisionId) : null;
          const chosen = decision === 'approve' ? current.proposal.proposed : decision === 'counteroffer' ? target : offer?.target;
          if (!chosen) throw new Error('最新の代替日時を確認してください。');
          const p = current.proposal;
          const context = frameAtOperation(state.assessment.view, state.archive, point(state), p.choreId, p.anchorDate);
          const placement = datePlacementReview(state, { choreId: p.choreId, anchorDate: p.anchorDate, ruleVersion: context.config.ruleVersion, subjectUserId: p.subjectUserId }, validateDesignationTarget(p.proposedMode, chosen));
          if (placement.recentWork) {
            if (decision !== 'counteroffer' && !(offer?.options ?? p.proposedOptions).allowDuringCooldown) {
              throw new Error('申請後に最近の実施が見つかりました。管理者の代替案で再指定条件を明示し、本人の承諾を確認してください。');
            }
            if (!edit.confirmRecentWork) throw new V2ActionConfirmationError('recentWork');
            allowDuringCooldown = decision === 'counteroffer';
          }
          if (placement.highLoad && !edit.confirmHighLoad) throw new V2ActionConfirmationError('highLoad');
        }
        return [draft('requestDecision', null, { requestId, decision, target, referenceDecisionId, ...(allowDuringCooldown ? { allowDuringCooldown: true } : {}) })];
      }),
    approveSubstitution: (completionOperationId: string, decision: 'approve' | 'reject') => repository.commit([draft('completionApproval', null, { completionOperationId, decision })]),
    cancelDates: (ref: V2RoundReference, targetOperationIds: string[], edit: V2AssignmentEdit & { expectedRuleIds?: readonly string[]; selector?: RuleSelector; expectedAssigneeIds?: readonly string[] } = {}) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); expectAssignment(context, edit);
      if (edit.expectedAssigneeIds && !sameIds(edit.expectedAssigneeIds, ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId])) throw new V2StaleSettingsError();
      const at = point(state); const view = state.assessment.view; const formal = state.assessment.formalRulesAt(at);
      const rules = observedDateRules(view, at, formal, true); const active = observedDateRules(view, at, formal);
      const zone = view.field('settings', 'settings', 'timeZone', at)?.value as string;
      const selected = selectManualRule(active, context.frame, ref.subjectUserId, zone);
      const currentIds = selected.kind === 'selected' ? selected.equivalentOperationIds : selected.kind === 'conflict' ? selected.candidates.map((fact) => fact.operationId) : [];
      if (edit.expectedRuleIds) {
        if (!sameIds(edit.expectedRuleIds, currentIds)) throw new V2StaleSettingsError();
      }
      if (targetOperationIds.some((id) => !rules.some((fact) => fact.operationId === id && fact.rule.choreId === context.frame.choreId && fact.rule.subjectUserId === ref.subjectUserId))) throw new Error('取り消す日時指定を確認してください。');
      if (edit.selector && targetOperationIds.some((id) => !cancellationScopeMatches(rules.find((fact) => fact.operationId === id)!.rule, edit.selector!, context.frame))) {
        throw new Error('解除する範囲は、表示した家事回から指定してください。周期が変わった元指定は適用期間全体の解除で確認してください。');
      }
      const direct = () => [draft('designationCancel', null, { targetOperationIds, ...(edit.selector ? { selector: edit.selector } : {}) })];
      // Preserve the legacy administrator API for explicitly named obsolete source rules.
      if (!edit.selector && !edit.expectedRuleIds && scope.userId === state.archive.at(-1)!.body.ownerUserId && !sameIds(targetOperationIds, currentIds)) return direct();
      const cancellation = { targetOperationIds, selector: edit.selector ?? null };
      const remaining = v2CancellationProposal(active, context.frame, ref.subjectUserId, zone, cancellation);
      const originals = selected.kind === 'conflict' ? selected.candidates : selected.kind === 'selected' ? [selected.fact] : [];
      const source = v2DateChangeOriginal(originals.map((fact) => fact.rule), context.frame, zone);
      const request = draft('changeRequest', null, { requesterUserId: scope.userId, choreId: ref.choreId, anchorDate: ref.anchorDate,
        occurrenceId: context.frame.id, subjectUserId: ref.subjectUserId, originalDesignationId: selected.kind === 'selected' ? selected.fact.operationId : null,
        original: source.original, proposed: remaining.target, proposedMode: remaining.mode, proposedOptions: remaining.options,
        selector: v2CancellationSelector(active, cancellation), extensionScope: 'once',
        basisRuleIds: currentIds, cancellation });
      const permission = dateChangeContextAtOperation(view, state.archive, { ...at, ...request }, undefined, formal,
        new Map(state.assessment.requestStates.map((entry) => [entry.requestId, entry])), { receipts: state.receipts, epochs: state.assessment.receiptEpochs }).permission;
      if (permission.kind === 'denied') throw new Error('この指定を解除する権限と残る予定を確認してください。');
      return scope.userId === state.archive.at(-1)!.body.ownerUserId && permission.kind === 'allowed' && !permission.needsRequest ? direct() : [request];
    }),
  };
}
