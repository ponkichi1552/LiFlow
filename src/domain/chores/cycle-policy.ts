import type { ChoreDefinition, FrequencyMode } from './types';
import { personalChoreRecipe } from './personal-catalog.ts';

export const PERSONAL_HOUSEHOLD_ID = 'local-household';
/** A guide-only task has no schedule to configure. Keep seasonal work and any
 * existing numeric cadence, including modes other than the currently selected one. */
export function hasChoreScheduleSettings(chore: Pick<ChoreDefinition, 'frequencyDaysByMode'>
  & Partial<Pick<ChoreDefinition, 'id' | 'personalRecipeId' | 'archived' | 'personalSchedulingKind' | 'userIntervalDays' | 'recommendedCycleDays' | 'manufacturerRecommendedIntervalDays' | 'personalSchedule'>>): boolean {
  if (chore.archived) return false;
  if (chore.personalSchedule?.once) return true;
  if (chore.personalSchedule?.monthlyDay !== undefined) return true;
  if (chore.personalSchedulingKind === 'seasonal') return true;
  // A shared display projection may contain a fallback seven-day value before
  // configuration. Bundled recipe identity tells us whether a real cycle exists.
  const recipeId = chore.personalRecipeId ?? /(?:^|\.)(liflow-catalog-6\.\d{3})$/u.exec(chore.id ?? '')?.[1];
  const recipe = recipeId ? personalChoreRecipe(recipeId) : undefined;
  const defaults = recipe ? Object.values(recipe.modes).flatMap(mode => mode.kind === 'days' ? [mode.days] : []) : Object.values(chore.frequencyDaysByMode ?? {});
  return [chore.userIntervalDays, chore.recommendedCycleDays, chore.manufacturerRecommendedIntervalDays,
    ...defaults].some(days => typeof days === 'number' && Number.isSafeInteger(days) && days > 0);
}
/** Private reset may release a fixed period; signed shared rules keep their existing contract. */
export function isPersonalConditionBasedAppliance(chore: Pick<ChoreDefinition, 'applianceId' | 'applianceCareSource' | 'manufacturerRecommendedIntervalDays'> & { householdId?: string }): boolean {
  return chore.householdId === PERSONAL_HOUSEHOLD_ID && Boolean(chore.applianceId || chore.applianceCareSource)
    && chore.manufacturerRecommendedIntervalDays === undefined;
}
/** Registered cadence, independent of a newer analysis that has not replaced it. */
export function registeredChoreCycleDays(chore: ChoreDefinition, mode: FrequencyMode): number | undefined {
  if (chore.personalSchedule?.once || chore.requiresCycleSelection || chore.personalSchedulingKind === 'seasonal') return undefined;
  const days = isPersonalConditionBasedAppliance(chore) ? chore.userIntervalDays ?? chore.recommendedCycleDays
    : chore.userIntervalDays ?? chore.recommendedCycleDays ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode];
  if (days === undefined) return undefined;
  if (!Number.isSafeInteger(days) || days <= 0) throw new RangeError('登録された家事の周期を確認してください。');
  return days;
}
export function choreCadenceLabel(chore: ChoreDefinition, mode: FrequencyMode): string {
  if (chore.personalSchedule?.once) return 'この日だけ';
  if (chore.personalSchedule?.monthlyDay !== undefined) return `毎月${chore.personalSchedule.monthlyDay}日`;
  const days = registeredChoreCycleDays(chore, mode);
  return days === undefined ? chore.cadenceLabelsByMode?.[mode] ?? (isPersonalConditionBasedAppliance(chore) && !chore.requiresCycleSelection ? '必要なとき' : '周期未設定') : days === 1 ? '毎日' : `${days}日ごと`;
}
