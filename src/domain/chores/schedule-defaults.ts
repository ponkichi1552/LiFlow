import { builtInChoreCatalogEntry } from './catalog.ts';
import type { ChoreDefinition } from './types';
import { isPersonalConditionBasedAppliance } from './cycle-policy.ts';
import { bundledChoreScheduleDefaults } from './personal-catalog.ts';

export type ChoreScheduleDefaults = Pick<ChoreDefinition, 'frequencyDaysByMode' | 'load' | 'windowRadiusDays' | 'maxShiftDays' | 'holidayPriority' | 'everyday' | 'requiresCycleSelection'>;
/** Stable catalog IDs survive renames and a group's ID prefix. Never match an editable display name. */
export function choreScheduleDefaults(chore: Pick<ChoreDefinition, 'id' | 'applianceId' | 'applianceCareSource' | 'manufacturerRecommendedIntervalDays' | 'personalRecipeId' | 'personalScheduleDefaults' | 'customPersonal'> & { householdId?: string }): ChoreScheduleDefaults | null {
  if ((chore.personalRecipeId || chore.customPersonal) && chore.personalScheduleDefaults) return { ...chore.personalScheduleDefaults,
    frequencyDaysByMode: { ...chore.personalScheduleDefaults.frequencyDaysByMode } };
  const standard = bundledChoreScheduleDefaults(chore.id);
  if (standard) return standard;
  const builtIn = builtInChoreCatalogEntry(chore.id);
  if (builtIn) return { frequencyDaysByMode: { ...builtIn.frequencyDaysByMode }, load: builtIn.load, windowRadiusDays: builtIn.windowRadiusDays,
    maxShiftDays: builtIn.maxShiftDays, holidayPriority: builtIn.holidayPriority, everyday: builtIn.everyday, requiresCycleSelection: builtIn.requiresCycleSelection };
  if (chore.applianceId || chore.applianceCareSource) {
    const necessaryOnly = isPersonalConditionBasedAppliance(chore);
    const cycle = chore.manufacturerRecommendedIntervalDays ?? 30;
    return { frequencyDaysByMode: necessaryOnly ? {} : { frequent: cycle, balanced: cycle, relaxed: cycle }, load: 'light', windowRadiusDays: 1,
      maxShiftDays: 7, holidayPriority: false, everyday: false, ...(necessaryOnly ? { requiresCycleSelection: false } : {}) };
  }
  return null;
}
/** Restore scheduling alone; private condition-based appliances return to necessary-only. */
export function resetChoreSchedule(chore: ChoreDefinition): ChoreDefinition {
  const defaults = choreScheduleDefaults(chore);
  if (!defaults) throw new Error('この家事の初期値は記録されていません。');
  const keepCycle = defaults.requiresCycleSelection || Boolean(chore.applianceId || chore.applianceCareSource)
    && chore.manufacturerRecommendedIntervalDays === undefined && !isPersonalConditionBasedAppliance(chore);
  return { ...chore, ...defaults, ...(keepCycle ? { requiresCycleSelection: chore.requiresCycleSelection } : {}),
    ...(chore.customPersonal ? { userWindowRadiusDays: defaults.windowRadiusDays } : {}),
    ...(chore.personalRecipeId || chore.applianceId || chore.applianceCareSource ? { userWindowRadiusDays: undefined } : {}),
    laundryDryingPreference: chore.personalScheduleDefaults?.laundryDryingPreference ?? builtInChoreCatalogEntry(chore.id)?.laundryDryingPreference,
    ...(!keepCycle ? { recommendedCycleDays: undefined, userIntervalDays: undefined } : {}) };
}
