import type { HouseholdPlannerSettings } from '../../domain/chores/types';
import type { Weekday } from '../../domain/shared/types';
import type { PrivatePlannerPreferenceStore } from '../sharing/private-planner/preference-store';
import type { SavedPrivatePlannerPreferences } from '../sharing/private-planner/preferences';

export type PlannerRhythm = Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>;

/** One settings form serves local planning and the authenticated owner's private recommendations. */
export function createOwnerRhythmSettings(input: { store: PrivatePlannerPreferenceStore; saved: SavedPrivatePlannerPreferences | null;
  local: HouseholdPlannerSettings; timeZone: string; saveLocal(value: PlannerRhythm, expected: PlannerRhythm): Promise<unknown>;
}) {
  let saved = input.saved; let local = input.local;
  const view = () => ({ frequencyMode: local.frequencyMode, restDays: local.restDays, heavyDailyLimit: local.heavyDailyLimit, normalDailyLimit: local.normalDailyLimit, ...(saved ? { restDays: saved.restDays,
    heavyDailyLimit: saved.loadLimits.heavyDailyLimit, normalDailyLimit: saved.loadLimits.normalDailyLimit } : {}) });
  return { settings: view,
    async save(value: PlannerRhythm) {
      // Each durable write advances only its own baseline. A failed SQLite reply must not
      // make a newer local edit reuse an obsolete protected revision on its next retry.
      const next = await input.store.save(saved?.revision ?? 0, {
        timeZone: saved?.timeZone ?? input.timeZone, allowedBands: saved?.allowedBands ?? [],
        restDays: value.restDays as Weekday[], loadLimits: { heavyDailyLimit: value.heavyDailyLimit, normalDailyLimit: value.normalDailyLimit },
      });
      saved = next;
      await input.saveLocal(value, local); local = { ...local, ...value };
    },
  };
}
