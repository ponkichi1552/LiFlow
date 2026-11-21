import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry, HouseholdPlannerSettings } from '../../domain/chores/types.ts';
import type { ChoreSettingsPatch } from '../../domain/chores/settings-patch.ts';
import { applyChoreSettingsPatch } from '../../domain/chores/settings-patch.ts';
import { validateChoreToggle } from '../../domain/chores/chore-groups.ts';
import { wouldCreateDependencyCycle } from '../../domain/scheduling/engine.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { PlannerSnapshot } from '../../platform/storage/repository.ts';
import type { SharedOperationDraft } from '../../platform/storage/sharing-ledger.ts';
import type { SharedRepositoryMutation } from '../../platform/storage/shared-repository-adapter.ts';
import type { WasteScheduleInput } from '../waste/contracts.ts';
import type { LocalDate } from '../../domain/shared/types.ts';
import { mergeWasteScheduleEdits, normalizeWasteSchedule, wasteCollectionRule } from '../waste/schedule-policy.ts';
import { canonicalJson } from './operations.ts';
import type { JsonValue, SharedOperation } from './operations.ts';
import type { SharedReplica } from './replica.ts';
import { sharedDocumentDigest } from './crypto.ts';
import { sharedLocalDate } from './group-clock.ts';
import { sharedPatchFromDefinition } from './planning.ts';
import { planReviewedApplianceSave } from '../appliance-care/persistence-policy.ts';
import type { ApplianceCareAnalysisDraft } from '../appliance-care/contracts.ts';
import type { ApprovedApplianceCareTask, ApplianceCareProductIdentity } from '../appliance-care/to-chore-definition.ts';

export interface SharedMutationContext {
  replica: SharedReplica; snapshot: PlannerSnapshot; userId: string; now: Date; makeId: () => string;
}
export interface SharedMutationPlan { drafts: SharedOperationDraft[]; result: unknown }
export function sharedDraft(context: SharedMutationContext, entityType: SharedOperation['entityType'], entityId: string,
  payload: Record<string, JsonValue>, operationType: SharedOperation['operationType'] = 'patch'): SharedOperationDraft {
  return { operationId: context.makeId(), entityType, entityId, operationType, payload };
}
function requiredChore(context: SharedMutationContext, id: unknown): ChoreDefinition {
  const chore = context.snapshot.chores.find((item) => item.id === id);
  if (!chore || chore.archived) throw new Error('この共有グループに家事が見つかりません。');
  return chore;
}

/** Undefined optional values become explicit resets; each edit writes only the fields it changes. */
export function sharedDefinitionDiff(previous: ChoreDefinition, next: ChoreDefinition): Record<string, JsonValue> {
  const before = sharedPatchFromDefinition(previous); const after = sharedPatchFromDefinition(next);
  const payload: Record<string, JsonValue> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = before[key] ?? null;
    const value = after[key] ?? (['requiresCycleSelection', 'archived'].includes(key) ? false : null);
    if (canonicalJson(oldValue) !== canonicalJson(value)) payload[key] = value;
  }
  return payload;
}
export function sharedDefinitionEdits(context: SharedMutationContext, previous: ChoreDefinition, next: ChoreDefinition): SharedOperationDraft[] {
  if (next.householdId !== context.snapshot.household.id || next.id !== previous.id) throw new Error('家事の保存先が一致しません。');
  if (next.enabled && next.requiresCycleSelection) throw new Error('周期を設定してから有効にしてください。');
  const payload = sharedDefinitionDiff(previous, next);
  const drafts: SharedOperationDraft[] = Object.keys(payload).length ? [sharedDraft(context, 'chore', next.id, payload)] : [];
  const canonical = context.replica.entities.find((entity) => entity.entityType === 'chore' && entity.entityId === next.id);
  if (payload.enabled === true && canonical?.fields.enabled !== true
    && !context.snapshot.states.find((state) => state.choreId === next.id)?.lastCompletedDate) {
    drafts.push(sharedDraft(context, 'baseline', next.id, { initialPending: true, initialScheduledDate: context.snapshot.today!, unknownReason: 'unknown' }));
  }
  return drafts;
}
export function sharedUndoDrafts(context: SharedMutationContext, occurrenceId: string): SharedOperationDraft[] {
  const effective = context.replica.completions.find((item) => item.occurrenceId === occurrenceId);
  // Undo only facts this device has observed. A concurrently arriving completion is retained.
  return (effective?.activeOperationIds ?? []).map((targetOperationId) => sharedDraft(context, 'completion', occurrenceId, { targetOperationId }, 'undo'));
}
export function sharedCompletionDraft(context: SharedMutationContext, entry: Pick<ChoreScheduleEntry, 'id' | 'choreId'> & Partial<ChoreScheduleEntry>,
  outcome: 'completed' | 'incomplete', completedAt = context.now.toISOString(), memberId = context.userId): SharedOperationDraft {
  return sharedDraft(context, 'completion', entry.id, { choreId: entry.choreId, completedAt,
    completedLocalDate: sharedLocalDate(new Date(completedAt), context.snapshot.timeZone!), completedByMemberId: memberId, outcome,
    ...(entry.suggestedDate ? { scheduledDate: entry.suggestedDate } : {}), ...(entry.windowStart ? { scheduledWindowStart: entry.windowStart } : {}),
    ...(entry.windowEnd ? { scheduledWindowEnd: entry.windowEnd } : {}) }, 'complete');
}

/** Pure planning; the adapter commits these operations and their projection in one SQLite transaction. */
export function planSharedMutation(context: SharedMutationContext, kind: SharedRepositoryMutation, args: readonly unknown[]): SharedMutationPlan {
  if (kind === 'setChoresEnabled') {
    const [ids, enabled] = args; validateChoreToggle(ids, enabled);
    const plans = ids.map(id => planSharedMutation(context, 'setChoreEnabled', [id, enabled]));
    return { drafts: plans.flatMap(plan => plan.drafts), result: undefined };
  }
  const { snapshot, replica } = context; const draft = (type: SharedOperation['entityType'], id: string, fields: Record<string, JsonValue>, op?: SharedOperation['operationType']) => sharedDraft(context, type, id, fields, op);
  if (kind === 'completeFirstSetup') throw new Error('初期設定は個人モードで行ってください。共有データは個人データへ上書きされません。');
  if (kind === 'setCalendarAvailabilityEnabled') {
    if (args[0]) throw new Error('共有の予定には個人のGoogle Calendarの忙しさを使用しません。');
    return { drafts: [], result: undefined };
  }
  if (kind === 'saveReviewedApplianceCare') {
    const product = args[0] as Omit<ApplianceCareProductIdentity, 'applianceId'> & { applianceId?: string };
    if (!product.modelNumber) throw new Error('この共有形式では型番が必要です。');
    const applianceId = product.applianceId ?? `appliance.${sharedDocumentDigest([replica.groupId,
      product.manufacturer.normalize('NFKC').trim().toLowerCase(), product.modelNumber.normalize('NFKC').trim().toLowerCase()])}`;
    const existing = snapshot.appliances.find((item) => item.id === applianceId);
    if (product.applianceId && !existing) throw new Error('この共有グループに家電が見つかりません。');
    const plan = planReviewedApplianceSave({ householdId: snapshot.household.id, applianceId, now: context.now.toISOString(), product,
      analysis: args[1] as ApplianceCareAnalysisDraft, approvedTasks: args[2] as ApprovedApplianceCareTask[],
      existingAppliance: existing, allChores: snapshot.chores,
      newChoreId: (name) => `care.${sharedDocumentDigest([replica.groupId, applianceId, name])}` });
    const { id: _id, householdId: _householdId, ...fields } = plan.appliance;
    const drafts = [draft('appliance', applianceId, { ...JSON.parse(JSON.stringify(fields)), reviewed: true })];
    for (const definition of plan.definitions) {
      const before = snapshot.chores.find((item) => item.id === definition.id);
      if (before) drafts.push(...sharedDefinitionEdits(context, before, definition));
      else {
        drafts.push(draft('chore', definition.id, sharedPatchFromDefinition(definition)), draft('baseline', definition.id,
          { lastCompletedDate: null, lastCompletedEstimated: false, initialPending: true, initialScheduledDate: snapshot.today!, unknownReason: 'skipped' }),
        draft('assignment', definition.id, { choreId: definition.id, memberIds: [context.userId] }));
      }
    }
    return { drafts, result: plan.result };
  }
  if (kind === 'updatePlannerSettings') {
    const settings = args[0] as Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>;
    if (!['frequent', 'balanced', 'relaxed'].includes(settings.frequencyMode) || settings.restDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
      || !Number.isInteger(settings.heavyDailyLimit) || settings.heavyDailyLimit < 1 || settings.heavyDailyLimit > 10
      || !Number.isInteger(settings.normalDailyLimit) || settings.normalDailyLimit < 1 || settings.normalDailyLimit > 20) throw new Error('頻度・休日・家事の上限を確認してください。');
    const fields = { frequencyMode: settings.frequencyMode, restDays: [...new Set(settings.restDays)].sort(), heavyDailyLimit: settings.heavyDailyLimit, normalDailyLimit: settings.normalDailyLimit };
    const base = args[1] as typeof fields | undefined;
    const edits = Object.entries(fields).filter(([key, value]) => !base || canonicalJson(base[key as keyof typeof fields]) !== canonicalJson(value));
    if (base && edits.some(([key, value]) => canonicalJson(snapshot.settings[key as keyof typeof fields]) !== canonicalJson(base[key as keyof typeof fields])
      && canonicalJson(snapshot.settings[key as keyof typeof fields]) !== canonicalJson(value))) throw new Error('編集中に同じ設定が別の端末で変更されました。画面を開き直して、最新の内容を確認してください。');
    const changes = Object.fromEntries(edits.filter(([key, value]) => canonicalJson(snapshot.settings[key as keyof typeof fields]) !== canonicalJson(value)));
    return { drafts: Object.keys(changes).length ? [draft('settings', 'settings', changes)] : [], result: undefined };
  }
  if (['updateChoreDefinition', 'updateChoreSettings', 'setChoreEnabled'].includes(kind)) {
    const displayed = requiredChore(context, kind === 'updateChoreDefinition' ? (args[0] as ChoreDefinition).id : args[0]);
    const entity = replica.entities.find((item) => item.entityType === 'chore' && item.entityId === displayed.id)!;
    const previous = { ...displayed, enabled: entity.fields.enabled === true };
    const next = kind === 'updateChoreDefinition' ? args[0] as ChoreDefinition
      : applyChoreSettingsPatch(previous, kind === 'setChoreEnabled' ? { enabled: args[1] as boolean } : args[1] as ChoreSettingsPatch);
    if (kind === 'updateChoreSettings' && args[2]) {
      const base = args[2] as ChoreDefinition;
      if (base.id !== previous.id || base.householdId !== previous.householdId) throw new Error('家事の保存先が一致しません。');
      const patch = args[1] as ChoreSettingsPatch;
      const fields = Object.keys(patch).flatMap((key) => key === 'cycleDays' ? ['recommendedCycleDays', 'userIntervalDays', 'requiresCycleSelection'] : [key]);
      const before = sharedPatchFromDefinition(base); const after = sharedPatchFromDefinition(next);
      if (fields.some((field) => entity.conflicts[field] || (canonicalJson(entity.fields[field] ?? null) !== canonicalJson(before[field] ?? null)
        && canonicalJson(entity.fields[field] ?? null) !== canonicalJson(after[field] ?? null)))) throw new Error('この項目は別の端末で変更されました。最新の設定を読み直してください。同時編集の候補がある場合は共有グループで内容を選んでください。');
    }
    const drafts = sharedDefinitionEdits(context, previous, next);
    if (kind === 'updateChoreSettings' || kind === 'setChoreEnabled') {
      const patch = kind === 'setChoreEnabled' ? { enabled: args[1] as boolean } : args[1] as ChoreSettingsPatch;
      const fields = Object.keys(patch).flatMap((key) => key === 'cycleDays' ? ['recommendedCycleDays', 'userIntervalDays', 'requiresCycleSelection'] : [key]);
      const encoded = sharedPatchFromDefinition(next);
      const resolved = Object.fromEntries(fields.filter((field) => entity.conflicts[field]).map((field) => [field, encoded[field] ?? (field === 'requiresCycleSelection' ? false : null)]));
      if (Object.keys(resolved).length) {
        const edit = drafts.find((item) => item.entityType === 'chore');
        if (edit) Object.assign(edit.payload, resolved); else drafts.push(draft('chore', next.id, resolved));
      }
    }
    return { drafts, result: kind === 'updateChoreSettings' ? Boolean(drafts.length) : undefined };
  }
  if (kind === 'completeChore' || kind === 'completeChoreWithReceipt' || kind === 'recordIncompleteChore') {
    const entry = args[0] as ChoreScheduleEntry; const chore = snapshot.chores.find((item) => item.id === entry.choreId);
    const existing = snapshot.completions.find((item) => item.scheduleEntryId === entry.id);
    const target = snapshot.scheduleEntries.find((item) => item.id === entry.id && item.choreId === entry.choreId);
    if (entry.householdId !== snapshot.household.id || !chore?.enabled || !target || existing?.outcome === 'completed') return { drafts: [], result: kind === 'completeChoreWithReceipt' ? undefined : false };
    const member = args[1] as string | undefined;
    if (member && !snapshot.members.some((item) => item.id === member)) throw new Error('担当者が見つかりません。');
    const fact = sharedCompletionDraft(context, target, kind === 'recordIncompleteChore' ? 'incomplete' : 'completed', undefined, member);
    return { drafts: [fact], result: kind === 'completeChoreWithReceipt'
      ? { ...fact.payload, id: fact.operationId, householdId: snapshot.household.id, scheduleEntryId: target.id, source: 'inApp' } : true };
  }
  if (kind === 'undoCompletionReceipt') {
    const receipt = args[0] as ChoreCompletion;
    const fact = replica.operations.find(op => op.operationId === receipt.id && op.entityType === 'completion' && op.operationType === 'complete');
    const active = replica.completions.find(item => item.occurrenceId === receipt.scheduleEntryId);
    if (receipt.householdId !== snapshot.household.id || !fact || fact.authorUserId !== context.userId
      || fact.entityId !== receipt.scheduleEntryId || !active?.activeOperationIds.includes(fact.operationId)) return { drafts: [], result: false };
    return { drafts: [sharedDraft(context, 'completion', fact.entityId, { targetOperationId: fact.operationId }, 'undo')], result: true };
  }
  if (kind === 'undoCompletedChore') {
    const completion = snapshot.completions.find((item) => item.id === args[0]);
    const drafts = completion?.outcome === 'completed' ? sharedUndoDrafts(context, completion.scheduleEntryId!) : [];
    return { drafts, result: Boolean(drafts.length) };
  }
  if (kind === 'setChoreAssignments') {
    const chore = requiredChore(context, args[0]); const memberIds = [...new Set(args[1] as string[])].sort();
    if (memberIds.some((id) => !snapshot.sharing!.activeMemberIds.includes(id))) throw new Error('参加中のメンバーを選び直してください。');
    const existing = snapshot.assignments.find((item) => item.choreId === chore.id)?.memberIds ?? [];
    return { drafts: canonicalJson([...existing].sort()) === canonicalJson(memberIds) ? [] : [draft('assignment', chore.id, { choreId: chore.id, memberIds })], result: undefined };
  }
  if (kind === 'addHouseholdMember') {
    const displayName = (args[0] as string).trim(); if (!displayName || displayName.length > 500) throw new Error('メンバー名を入力してください。');
    const id = `manual:${context.makeId()}`;
    return { drafts: [draft('member', `member:${id}`, { userId: id, displayName })], result: id };
  }
  if (kind === 'replaceChoreDependencies') {
    const successor = requiredChore(context, args[0]); const predecessors = [...new Set(args[1] as string[])].sort();
    const previous = snapshot.dependencies.filter((item) => item.successorChoreId === successor.id);
    const proposed = snapshot.dependencies.filter((item) => item.successorChoreId !== successor.id);
    const drafts: SharedOperationDraft[] = [];
    for (const predecessor of predecessors) {
      requiredChore(context, predecessor);
      if (wouldCreateDependencyCycle(proposed, predecessor, successor.id)) throw new Error('家事の依存関係が循環するため保存できません。');
      const id = `dep.${sharedDocumentDigest([predecessor, successor.id])}`;
      proposed.push({ id, predecessorChoreId: predecessor, successorChoreId: successor.id });
      if (!previous.some((item) => item.predecessorChoreId === predecessor)) drafts.push(draft('dependency', id, { predecessorChoreId: predecessor, successorChoreId: successor.id }));
    }
    for (const item of previous) if (!predecessors.includes(item.predecessorChoreId)) drafts.push(draft('dependency', item.id, {}, 'delete'));
    return { drafts, result: undefined };
  }
  if (kind === 'saveWeeklyWasteSchedule') {
    const input = args[0] as WasteScheduleInput;
    const previous = replica.entities.find((entity) => entity.entityType === 'waste' && entity.entityId === input.id);
    if (input.id && (!previous || previous.deleted)) throw new Error('ゴミ収集日が見つかりません。');
    if (previous && Object.keys(previous.conflicts).length) throw new Error('この収集日は同時編集の候補があります。共有グループで内容を選んでください。');
    const displayed = args[1] as WasteScheduleInput | undefined;
    const current = snapshot.wasteSchedules.find((schedule) => schedule.id === input.id);
    if (displayed && !current) throw new Error('ゴミ収集日が見つかりません。');
    const normalized = displayed ? mergeWasteScheduleEdits(current!, input, displayed) : normalizeWasteSchedule(input);
    const id = input.id ?? `waste.${context.makeId()}`;
    const rule = wasteCollectionRule(normalized); const payload = { label: normalized.label, ...rule };
    const changes = Object.fromEntries(Object.entries(payload).filter(([key, value]) => canonicalJson(previous?.fields[key] ?? null) !== canonicalJson(value)));
    // Concurrent valid rule edits must become a visible conflict, rather than
    // silently combining a new weekday with another device's fortnight anchor.
    if (Object.keys(rule).some((key) => key in changes)) Object.assign(changes, rule);
    return { drafts: Object.keys(changes).length ? [draft('waste', id, changes)] : [], result: undefined };
  }
  if (kind === 'setWasteOccurrenceHidden' || kind === 'deleteWeeklyWasteSchedule') {
    const id = args[0] as string;
    if (!snapshot.wasteSchedules.some((item) => item.id === id)) throw new Error('ゴミ収集日が見つかりません。');
    if (kind === 'deleteWeeklyWasteSchedule') return { drafts: [draft('waste', id, {}, 'delete')], result: undefined };
    const date = args[1] as LocalDate; parseLocalDate(date); const hidden = args[2] as boolean;
    const key = `${id}:${date}`; const already = snapshot.hiddenWasteOccurrenceKeys.includes(key);
    return { drafts: already === hidden ? [] : [draft('wasteVisibility', `visibility.${sharedDocumentDigest([id, date])}`, { scheduleId: id, date, hidden })], result: undefined };
  }
  throw new Error(`Unsupported shared mutation: ${kind}`);
}
