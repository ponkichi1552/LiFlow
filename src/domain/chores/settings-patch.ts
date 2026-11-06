import type { ChoreDefinition, ChoreLoad, LaundryDryingPreference } from './types';
import { resetChoreSchedule } from './schedule-defaults.ts';
import { builtInChoreCatalogEntry } from './catalog.ts';
import { isPersonalConditionBasedAppliance } from './cycle-policy.ts';

/** Only fields edited on the individual settings page. Null explicitly resets a cycle. */
export interface ChoreSettingsPatch {
  resetSchedule?: true;
  enabled?: boolean;
  cycleDays?: number | null;
  windowRadiusDays?: number;
  load?: ChoreLoad;
  holidayPriority?: boolean;
  laundryDryingPreference?: LaundryDryingPreference;
}

export function parseSettingInteger(text: string, min: number, max: number): number | undefined {
  const normalized = text.normalize('NFKC').trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
}

/** Apply to the current DB definition, so a delayed save cannot replace unrelated fresh data. */
export function applyChoreSettingsPatch(chore: ChoreDefinition, patch: ChoreSettingsPatch): ChoreDefinition {
  if (chore.personalSchedulingKind === 'seasonal' && (patch.cycleDays != null || patch.windowRadiusDays !== undefined || patch.holidayPriority !== undefined)) throw new Error('季節家事は地域別の固定日を使います。');
  const next = patch.resetSchedule ? resetChoreSchedule(chore) : { ...chore };
  if (patch.cycleDays !== undefined) {
    if (patch.cycleDays !== null && (!Number.isSafeInteger(patch.cycleDays) || patch.cycleDays < 1)) {
      throw new RangeError('周期は1日以上の整数で入力してください。');
    }
    const cycle = patch.cycleDays === null ? undefined : patch.cycleDays;
    next.recommendedCycleDays = cycle;
    // The scheduler prefers userIntervalDays; never leave an older override shadowing a new cycle.
    next.userIntervalDays = chore.applianceId ? cycle : undefined;
    next.requiresCycleSelection = Boolean(cycle === undefined && (builtInChoreCatalogEntry(chore.id)?.requiresCycleSelection
      || chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined && !isPersonalConditionBasedAppliance(chore)));
    if (next.requiresCycleSelection) next.enabled = false;
  }
  if (patch.windowRadiusDays !== undefined) {
    if (!Number.isInteger(patch.windowRadiusDays) || patch.windowRadiusDays < 0 || patch.windowRadiusDays > 14) throw new RangeError('期間幅は±0〜±14日の整数で入力してください。');
    next.windowRadiusDays = patch.windowRadiusDays;
    if (chore.personalRecipeId || chore.applianceId || chore.applianceCareSource) next.userWindowRadiusDays = patch.windowRadiusDays;
  }
  if (patch.load !== undefined) {
    if (!['light', 'normal', 'heavy'].includes(patch.load)) throw new RangeError('負荷を確認してください。');
    next.load = patch.load;
  }
  if (patch.holidayPriority !== undefined) next.holidayPriority = patch.holidayPriority;
  if (patch.laundryDryingPreference !== undefined) {
    if (!['either', 'outdoors', 'indoors'].includes(patch.laundryDryingPreference)) throw new RangeError('干し方を確認してください。');
    if (chore.category === '洗濯' || chore.laundryDryingPreference !== undefined) next.laundryDryingPreference = patch.laundryDryingPreference;
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled && next.requiresCycleSelection) throw new Error('周期を設定してから有効にしてください。');
    next.enabled = patch.enabled;
  }
  return next;
}
