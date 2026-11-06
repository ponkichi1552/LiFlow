import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { usePlannerData } from './use-planner-data';
import { createPlannerRefreshController } from '../features/planner/refresh-controller';
import { waitForInitialFrame } from '../features/planner/initial-display-gate';
import { readPersonalSettingsView } from '../platform/storage/personal-settings-view';
import type { PersonalSettingsView } from '../platform/storage/personal-settings-view';
import type { PlannerSnapshot } from '../platform/storage/repository';

const stores = new WeakMap<SQLiteDatabase, ReturnType<typeof settingsStore>>();
function settingsStore(database: SQLiteDatabase) {
  let previous: PersonalSettingsView | undefined, signature: string | undefined;
  let observedRoot: PlannerSnapshot | null | undefined;
  const controller = createPlannerRefreshController<PersonalSettingsView>({
    load: async () => {
      const value = await readPersonalSettingsView(database); const next = JSON.stringify(value);
      if (next !== signature) { previous = value; signature = next; }
      return { snapshot: previous!, canPublishWidget: false };
    },
    weather: async () => null, publish() {},
  });
  return { controller, observe(snapshot: PlannerSnapshot | null) {
    if (observedRoot === snapshot) return;
    observedRoot = snapshot; void controller.refresh();
  } };
}

/** A settings page never needs to wait for the full adaptive/shared plan. */
export function usePersonalSettingsData() {
  const { database, snapshot: plannerSnapshot, refresh: refreshPlanner } = usePlannerData({ personal: true });
  const store = useMemo(() => {
    let value = stores.get(database);
    if (!value) { value = settingsStore(database); stores.set(database, value); }
    return value;
  }, [database]);
  const { controller } = store;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { store.observe(plannerSnapshot); }, [store, plannerSnapshot]);
  const cached = useMemo<PersonalSettingsView | null>(() => plannerSnapshot ? {
    settings: plannerSnapshot.settings, chores: plannerSnapshot.chores, today: plannerSnapshot.today, timeZone: plannerSnapshot.timeZone,
  } : null, [plannerSnapshot]);
  const refresh = useCallback(async (options?: { waitForWeather?: boolean; force?: boolean }) => {
    await controller.refresh();
    const background = waitForInitialFrame().then(() => refreshPlanner(options));
    if (options?.waitForWeather) await background; else void background.catch(() => undefined);
  }, [controller, refreshPlanner]);
  const readError = useCallback(() => controller.getSnapshot().error, [controller]);
  const snapshot = useMemo(() => state.snapshot ? { ...state.snapshot, today: cached?.today, timeZone: cached?.timeZone } : cached, [state.snapshot, cached]);
  const readSnapshot = useCallback(() => controller.getSnapshot().snapshot ?? cached, [controller, cached]);
  return { ...state, snapshot, database, refresh, readError, readSnapshot };
}
