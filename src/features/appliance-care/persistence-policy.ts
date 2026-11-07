import type { Appliance, ApplianceCareAnalysisDraft, ApplianceCareTaskDraft } from './contracts';
import type { ChoreDefinition } from '../../domain/chores/types';
import type { EntityId } from '../../domain/shared/types';
import type { ApprovedApplianceCareTask, ApplianceCareProductIdentity } from './to-chore-definition';
import { toApplianceCareChore } from './to-chore-definition.ts';
import { applianceDisplayName } from './display-name.ts';

export function effectiveApplianceIntervalDays(
  manufacturerIntervalDays?: number,
  userIntervalDays?: number,
): number | undefined {
  return userIntervalDays ?? manufacturerIntervalDays;
}

export function shouldScheduleApplianceCareTask(
  task: ApplianceCareTaskDraft,
  userIntervalDays?: number,
): boolean {
  return effectiveApplianceIntervalDays(task.recommendedIntervalDays, userIntervalDays) !== undefined;
}

export function hasExactChoreNameDuplicate(
  existingChores: readonly Pick<ChoreDefinition, 'id' | 'name'>[],
  proposedName: string,
  exceptChoreId?: EntityId,
): boolean {
  return existingChores.some((chore) => chore.id !== exceptChoreId && chore.name === proposedName);
}

export function buildReviewedApplianceChore(options: {
  id: EntityId;
  householdId: EntityId;
  applianceId: EntityId;
  product: Omit<ApplianceCareProductIdentity, 'applianceId'>;
  analysis: ApplianceCareAnalysisDraft;
  approved: ApprovedApplianceCareTask;
  existing?: ChoreDefinition;
}): { definition: ChoreDefinition; hasCycle: boolean } {
  const existing = options.existing;
  const userIntervalDays = options.approved.resetUserInterval ? undefined : options.approved.userIntervalDays
    ?? existing?.userIntervalDays
    ?? existing?.recommendedCycleDays;
  const definition = toApplianceCareChore(
    options.id,
    options.householdId,
    { ...options.product, applianceId: options.applianceId },
    options.analysis,
    { task: options.approved.task, ...(userIntervalDays !== undefined ? { userIntervalDays } : {}) },
  );
  const hasCycle = shouldScheduleApplianceCareTask(options.approved.task, definition.userIntervalDays);
  if (!existing) return { definition, hasCycle };

  return {
    hasCycle,
    definition: {
      ...definition,
      enabled: hasCycle && (existing.enabled || Boolean(existing.requiresCycleSelection)),
      load: existing.load,
      windowRadiusDays: existing.windowRadiusDays,
      ...(existing.userWindowRadiusDays !== undefined ? { userWindowRadiusDays: existing.userWindowRadiusDays } : {}),
      maxShiftDays: existing.maxShiftDays,
      holidayPriority: existing.holidayPriority,
      ...(existing.laundryDryingPreference !== undefined ? { laundryDryingPreference: existing.laundryDryingPreference } : {}),
      ...(!hasCycle ? { requiresCycleSelection: true } : {}),
    },
  };
}

export function retireApplianceTaskSnapshot(chore: ChoreDefinition): ChoreDefinition {
  const { applianceCareSource: _previousSource, ...userDataAndDefinition } = chore;
  return {
    ...userDataAndDefinition,
    enabled: false,
    description: 'この項目は最新のメーカー公式解析結果に含まれていません。過去の実施履歴は保持しています。',
    instructions: [],
    tools: [],
    cautions: [],
    manufacturerRecommendedIntervalDays: undefined,
    manufacturerRecommendedConditions: undefined,
    estimatedMinutes: undefined,
  };
}

/** The same review/dedup/reanalysis policy serves personal SQL and encrypted shared events. */
export function planReviewedApplianceSave(options: {
  householdId: string; applianceId: string; now: string;
  product: Omit<ApplianceCareProductIdentity, 'applianceId'>;
  analysis: ApplianceCareAnalysisDraft; approvedTasks: readonly ApprovedApplianceCareTask[];
  existingAppliance?: Pick<Appliance, 'manufacturer' | 'productName' | 'modelNumber' | 'createdAt'>;
  allChores: readonly ChoreDefinition[]; newChoreId: (taskName: string) => string;
}) {
  const { product, analysis, approvedTasks, allChores, applianceId } = options;
  if (approvedTasks.length > 40 || analysis.tasks.length === 0 || analysis.tasks.length > 40) throw new RangeError('お手入れ項目は1〜40件の範囲で保存してください。');
  if (new Set(analysis.tasks.map((task) => task.name)).size !== analysis.tasks.length
    || new Set(approvedTasks.map((item) => item.task.name)).size !== approvedTasks.length
    || approvedTasks.some((item) => !analysis.tasks.some((task) => task.name === item.task.name && JSON.stringify(task) === JSON.stringify(item.task)))) {
    throw new Error('確認対象のお手入れ項目が解析結果と一致しません。');
  }
  const existing = options.existingAppliance;
  if (existing && (existing.manufacturer !== product.manufacturer || existing.productName !== product.productName || existing.modelNumber !== product.modelNumber)) {
    throw new Error('保存済み家電のメーカー・製品名・型番は再解析で変更できません。別の家電として登録してください。');
  }
  const appliance: Appliance = { id: applianceId, householdId: options.householdId, manufacturer: product.manufacturer,
    productName: product.productName, modelNumber: product.modelNumber, category: product.category,
    displayName: applianceDisplayName(product), officialProductUrl: product.officialProductUrl, officialManualUrl: product.manualUrl,
    analysis, createdAt: existing?.createdAt ?? options.now, updatedAt: options.now };
  const previous = allChores.filter((chore) => chore.applianceId === applianceId || (!chore.applianceId
    && chore.applianceCareSource?.manufacturer === product.manufacturer && chore.applianceCareSource.productName === product.productName
    && chore.applianceCareSource.modelNumber === product.modelNumber));
  const matchedIds = new Set<string>(); const definitions = new Map<string, ChoreDefinition>(); const newChoreIds = new Set<string>();
  const approvedByName = new Map(approvedTasks.map((item) => [item.task.name, item]));
  const currentNames = new Set(analysis.tasks.map((task) => task.name));
  let scheduledTaskCount = 0; let duplicateTaskCount = 0; let noCycleTaskCount = 0;
  for (const task of analysis.tasks) {
    const approved = approvedByName.get(task.name);
    const matched = previous.find((chore) => !matchedIds.has(chore.id)
      && (chore.applianceTaskName === task.name || (!chore.applianceTaskName && chore.name === task.name)));
    if (!approved && !matched) continue;
    const { definition, hasCycle } = buildReviewedApplianceChore({ id: matched?.id ?? options.newChoreId(task.name),
      householdId: options.householdId, applianceId, product, analysis, approved: approved ?? { task }, ...(matched ? { existing: matched } : {}) });
    if (matched) matchedIds.add(matched.id);
    if (!approved || !hasCycle) {
      if (approved && !hasCycle) noCycleTaskCount++;
      if (matched) definitions.set(matched.id, { ...definition, enabled: false });
      continue;
    }
    const candidates = [...allChores.filter((item) => !definitions.has(item.id)), ...definitions.values()];
    if (hasExactChoreNameDuplicate(candidates, definition.name, matched?.id)) {
      duplicateTaskCount++;
      if (matched) definitions.set(matched.id, { ...definition, name: matched.name, enabled: false });
      continue;
    }
    definitions.set(definition.id, definition); if (!matched) newChoreIds.add(definition.id); scheduledTaskCount++;
  }
  for (const chore of previous) if (!matchedIds.has(chore.id)) definitions.set(chore.id,
    currentNames.has(chore.applianceTaskName ?? chore.name) ? { ...chore, enabled: false } : retireApplianceTaskSnapshot(chore));
  return { appliance, definitions: [...definitions.values()], newChoreIds,
    result: { applianceId, scheduledTaskCount, duplicateTaskCount, noCycleTaskCount } };
}
