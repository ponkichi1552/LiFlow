import type { HouseholdPlannerSettings } from '../../domain/chores/types';
import type { Weekday } from '../../domain/shared/types';
import type { PrivatePlannerPreferenceStore } from '../sharing/private-planner/preference-store';
import type { SavedPrivatePlannerPreferences } from '../sharing/private-planner/preferences';
import type { PlannerRhythm } from '../sharing/private-planner/local-projection';
import { snapshotPlannerRhythm } from '../sharing/private-planner/local-projection.ts';
import { privatePlannerPreferenceValues } from '../sharing/private-planner/preferences.ts';
import { snapshotPersonalPlacementPreferences } from '../planner/personal-placement-preferences.ts';
import type { PersonalPlacementPreferences } from '../planner/personal-placement-preferences';
export type { PlannerRhythm } from '../sharing/private-planner/local-projection';

/** One settings form serves local planning and the authenticated owner's private recommendations. */
export function createOwnerRhythmSettings(input: { store: PrivatePlannerPreferenceStore; saved: SavedPrivatePlannerPreferences | null;
  local: HouseholdPlannerSettings; timeZone: string; saveLocal(value: PlannerRhythm, expected: PlannerRhythm): Promise<unknown>;
}) {
  let saved = input.saved; let local = input.local;
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T,>(work: () => Promise<T>): Promise<T> => { const next = tail.then(work, work); tail = next.catch(() => {}); return next; };
  const placement = () => snapshotPersonalPlacementPreferences({ allowedBands: saved?.allowedBands ?? [], dayOverrides: saved?.dayOverrides ?? [],
    ...(saved?.maximumMinutes !== undefined ? { maximumMinutes: saved.maximumMinutes } : {}) });
  const resume = async () => {
    const pending = await input.store.readLocalProjection(); if (!pending) return;
    saved = await input.store.save(pending.privateRevision, pending.preferences);
    await input.saveLocal(pending.value, pending.expected); local = { ...local, ...pending.value };
    await input.store.clearLocalProjection(pending);
  };
  const view = () => ({ frequencyMode: local.frequencyMode, restDays: [...local.restDays], heavyDailyLimit: local.heavyDailyLimit, normalDailyLimit: local.normalDailyLimit, ...(saved ? { restDays: [...saved.restDays],
    heavyDailyLimit: saved.loadLimits.heavyDailyLimit, normalDailyLimit: saved.loadLimits.normalDailyLimit } : {}) });
  return { settings: view, placement, timeZone: () => saved?.timeZone ?? input.timeZone,
    async savePlacement(value: PersonalPlacementPreferences, expected: PersonalPlacementPreferences) {
      const own = snapshotPersonalPlacementPreferences(value); const before = snapshotPersonalPlacementPreferences(expected);
      return exclusive(async () => {
      await resume();
      const current = placement();
      if (JSON.stringify(current) !== JSON.stringify(before) && JSON.stringify(current) !== JSON.stringify(own)) throw new Error('家事の時間・日別設定が別の操作で更新されています。');
      const base = saved ? privatePlannerPreferenceValues(saved) : { timeZone: input.timeZone, allowedBands: [],
        restDays: [...local.restDays] as Weekday[], loadLimits: { heavyDailyLimit: local.heavyDailyLimit, normalDailyLimit: local.normalDailyLimit } };
      const { maximumMinutes: _oldMaximum, dayOverrides: _oldDays, ...retained } = base;
      saved = await input.store.save(saved?.revision ?? 0, { ...retained, ...own, dayOverrides: [...own.dayOverrides], allowedBands: [...own.allowedBands] });
      });
    },
    resume: () => exclusive(resume),
    async save(value: PlannerRhythm) {
      const own = snapshotPlannerRhythm(value);
      return exclusive(async () => {
      // Resolve the previous exact publication first: SQLite may already have
      // committed it even when its acknowledgement never reached this writer.
      await resume();
      // Each durable write advances only its own baseline. A failed SQLite reply must not
      // make a newer local edit reuse an obsolete protected revision on its next retry.
      const preferences = {
        ...(saved ? privatePlannerPreferenceValues(saved) : { timeZone: input.timeZone, allowedBands: [] }),
        restDays: [...own.restDays] as Weekday[], loadLimits: { heavyDailyLimit: own.heavyDailyLimit, normalDailyLimit: own.normalDailyLimit },
      };
      const pending = { expected: { frequencyMode: local.frequencyMode, restDays: [...local.restDays], heavyDailyLimit: local.heavyDailyLimit, normalDailyLimit: local.normalDailyLimit },
        value: { ...own, restDays: [...own.restDays] }, privateRevision: saved?.revision ?? 0, preferences };
      await input.store.prepareLocalProjection(pending);
      const next = await input.store.save(pending.privateRevision, preferences);
      saved = next;
      await input.saveLocal(own, local); local = { ...local, ...own };
      await input.store.clearLocalProjection(pending);
      });
    },
  };
}
