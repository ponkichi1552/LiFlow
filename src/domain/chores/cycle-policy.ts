import type { ChoreDefinition, FrequencyMode } from './types';

export const PERSONAL_HOUSEHOLD_ID = 'local-household';
/** Private reset may release a fixed period; signed shared rules keep their existing contract. */
export function isPersonalConditionBasedAppliance(chore: Pick<ChoreDefinition, 'applianceId' | 'applianceCareSource' | 'manufacturerRecommendedIntervalDays'> & { householdId?: string }): boolean {
  return chore.householdId === PERSONAL_HOUSEHOLD_ID && Boolean(chore.applianceId || chore.applianceCareSource)
    && chore.manufacturerRecommendedIntervalDays === undefined;
}
/** Registered cadence, independent of a newer analysis that has not replaced it. */
export function registeredChoreCycleDays(chore: ChoreDefinition, mode: FrequencyMode): number | undefined {
  if (chore.requiresCycleSelection || chore.personalSchedulingKind === 'seasonal') return undefined;
  const days = isPersonalConditionBasedAppliance(chore) ? chore.userIntervalDays ?? chore.recommendedCycleDays
    : chore.userIntervalDays ?? chore.recommendedCycleDays ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode];
  if (days === undefined) return undefined;
  if (!Number.isSafeInteger(days) || days <= 0) throw new RangeError('登録された家事の周期を確認してください。');
  return days;
}
export function choreCadenceLabel(chore: ChoreDefinition, mode: FrequencyMode): string {
  const days = registeredChoreCycleDays(chore, mode);
  return days === undefined ? chore.cadenceLabelsByMode?.[mode] ?? (isPersonalConditionBasedAppliance(chore) && !chore.requiresCycleSelection ? '必要なとき' : '周期未設定') : days === 1 ? '毎日' : `${days}日ごと`;
}
