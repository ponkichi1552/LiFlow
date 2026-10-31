import { CHORE_CATALOG } from './catalog.ts';
import type { ChoreDefinition } from './types';

export type ChoreScheduleDefaults = Pick<ChoreDefinition, 'frequencyDaysByMode' | 'load' | 'windowRadiusDays' | 'maxShiftDays' | 'holidayPriority' | 'everyday'>;
/** Stable catalog IDs survive renames and a group's ID prefix. Never match an editable display name. */
export function choreScheduleDefaults(chore: Pick<ChoreDefinition, 'id' | 'applianceId' | 'applianceCareSource' | 'manufacturerRecommendedIntervalDays'>): ChoreScheduleDefaults | null {
  const match = /(?:^|\.)builtin-chore-(\d{2})$/.exec(chore.id);
  const builtIn = match ? CHORE_CATALOG[Number(match[1]) - 1] : undefined;
  if (builtIn) return { frequencyDaysByMode: { ...builtIn.frequencyDaysByMode }, load: builtIn.load, windowRadiusDays: builtIn.windowRadiusDays,
    maxShiftDays: builtIn.maxShiftDays, holidayPriority: builtIn.holidayPriority, everyday: builtIn.everyday };
  if (chore.applianceId || chore.applianceCareSource) {
    const cycle = chore.manufacturerRecommendedIntervalDays ?? 30;
    return { frequencyDaysByMode: { frequent: cycle, balanced: cycle, relaxed: cycle }, load: 'light', windowRadiusDays: 1, maxShiftDays: 7, holidayPriority: false, everyday: false };
  }
  return null;
}
/** Restore scheduling alone; an enabled condition-based appliance keeps its explicit cycle when no maker default exists. */
export function resetChoreSchedule(chore: ChoreDefinition): ChoreDefinition {
  const defaults = choreScheduleDefaults(chore);
  if (!defaults) throw new Error('この家事の初期値は記録されていません。');
  const keepCycle = Boolean(chore.applianceId || chore.applianceCareSource) && chore.manufacturerRecommendedIntervalDays === undefined;
  return { ...chore, ...defaults, laundryDryingPreference: undefined,
    ...(!keepCycle ? { recommendedCycleDays: undefined, userIntervalDays: undefined } : {}) };
}
