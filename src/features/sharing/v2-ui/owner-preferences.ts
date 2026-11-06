import type { HouseholdPlannerSettings } from '../../../domain/chores/types';
import type { SavedPrivatePlannerPreferences } from '../private-planner/preferences';
import type { Weekday } from '../../../domain/shared/types';

/** Screens and native delivery use the same owner-only settings selection. */
export function v2OwnerScheduleSettings(userId: string, settings: Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'> | null | undefined, own: SavedPrivatePlannerPreferences | null | undefined) {
  if (!settings) throw new Error('本人の予定設定を読み込んでいます。しばらくしてから再試行してください。');
  const restDays = settings.restDays.filter((day): day is Weekday => Number.isInteger(day) && day >= 1 && day <= 7);
  if (restDays.length !== settings.restDays.length) throw new Error('本人の休日設定を確認してください。');
  if (own && own.ownerUserId !== userId) throw new Error('本人の予定設定を確認してください。');
  return { ownerUserId: userId, settings: { frequencyMode: settings.frequencyMode,
    restDays: own?.restDays ?? restDays, loadLimits: own?.loadLimits ?? { heavyDailyLimit: settings.heavyDailyLimit, normalDailyLimit: settings.normalDailyLimit } } };
}
