import type { ChoreDefinition, FrequencyMode } from '../../domain/chores/types';
import type { ChoreSettingsPatch } from '../../domain/chores/settings-patch';
import { applyChoreSettingsPatch, parseSettingInteger } from '../../domain/chores/settings-patch.ts';
import { createAutosaveQueue } from './autosave-queue.ts';
import { builtInChoreCatalogEntry } from '../../domain/chores/catalog.ts';

/** Document-owned draft and retry queue survive a virtual row being unmounted. */
export function createChoreSettingsEditor(chore: ChoreDefinition, mode: FrequencyMode,
  savePatch: (patch: ChoreSettingsPatch, base: ChoreDefinition) => Promise<void>) {
  let draft = {
    cycleText: chore.requiresCycleSelection ? '' : String(chore.userIntervalDays ?? chore.recommendedCycleDays ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode]),
    radiusText: String(chore.windowRadiusDays), load: chore.load, enabled: chore.enabled,
    holidayPriority: chore.holidayPriority, dryingPreference: chore.laundryDryingPreference ?? 'either',
  };
  let enabledTouched = false; let emptyCyclePending = false; let displayedBase = chore;
  const queue = createAutosaveQueue<ChoreSettingsPatch>({ save: async patch => { await savePatch(patch, displayedBase); displayedBase = applyChoreSettingsPatch(displayedBase, patch); } });
  let state = { draft, status: queue.getSnapshot() };
  const listeners = new Set<() => void>();
  const emit = () => { state = { draft, status: queue.getSnapshot() }; for (const fn of listeners) try { fn(); } catch { /* Keep the save queue independent of rendering. */ } };
  queue.subscribe(emit);
  const update = (patch: Partial<typeof draft>) => { draft = { ...draft, ...patch }; emit(); };
  const resetCycle = () => {
    emptyCyclePending = false;
    const missing = Boolean(builtInChoreCatalogEntry(chore.id)?.requiresCycleSelection || chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined);
    update({ cycleText: missing ? '' : String(chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode]), ...(missing ? { enabled: false } : {}) });
    queue.enqueue({ cycleDays: null, ...(missing ? { enabled: false } : {}) }, true);
  };
  const flush = () => { if (emptyCyclePending) resetCycle(); return queue.flush(); };
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    flush, resetCycle,
    resetSchedule() {
      const reset = applyChoreSettingsPatch(displayedBase, { resetSchedule: true }); emptyCyclePending = false;
      for (const field of ['cycleDays', 'windowRadiusDays', 'load', 'holidayPriority', 'laundryDryingPreference'] as const) queue.remove(field);
      update({ cycleText: reset.requiresCycleSelection ? '' : String(reset.userIntervalDays ?? reset.recommendedCycleDays ?? reset.manufacturerRecommendedIntervalDays ?? reset.frequencyDaysByMode[mode]),
        radiusText: String(reset.windowRadiusDays), load: reset.load, holidayPriority: reset.holidayPriority, dryingPreference: reset.laundryDryingPreference ?? 'either' });
      queue.enqueue({ resetSchedule: true }, true);
      return queue.flush();
    },
    changeCycle(text: string) {
      emptyCyclePending = !text.trim(); const value = parseSettingInteger(text, 1, 3650);
      const autoEnable = value !== undefined && chore.requiresCycleSelection && !enabledTouched;
      update({ cycleText: text, ...(autoEnable ? { enabled: true } : {}) });
      if (value !== undefined) queue.enqueue({ cycleDays: value, ...(autoEnable ? { enabled: true } : {}) });
      else { queue.remove('cycleDays'); if (!enabledTouched && chore.requiresCycleSelection) { queue.remove('enabled'); update({ enabled: false }); } }
    },
    changeRadius(text: string) {
      update({ radiusText: text }); const value = parseSettingInteger(text, 0, 14);
      if (value !== undefined) queue.enqueue({ windowRadiusDays: value }); else queue.remove('windowRadiusDays');
    },
    changeEnabled(value: boolean) { enabledTouched = true; update({ enabled: value }); queue.enqueue({ enabled: value }, true); },
    changeLoad(value: typeof draft.load) { update({ load: value }); queue.enqueue({ load: value }, true); },
    changeHoliday(value: boolean) { update({ holidayPriority: value }); queue.enqueue({ holidayPriority: value }, true); },
    changeDrying(value: typeof draft.dryingPreference) { update({ dryingPreference: value }); queue.enqueue({ laundryDryingPreference: value }, true); },
  };
}
export type ChoreSettingsEditor = ReturnType<typeof createChoreSettingsEditor>;

export function createChoreSettingsDocument(scope: unknown) {
  const editors = new Map<string, ChoreSettingsEditor>();
  return {
    scope,
    entries: () => [...editors.entries()],
    forget: (id: string) => { editors.delete(id); },
    get(chore: ChoreDefinition, mode: FrequencyMode, save: Parameters<typeof createChoreSettingsEditor>[2]) {
      let editor = editors.get(chore.id);
      if (!editor) { editor = createChoreSettingsEditor(chore, mode, save); editors.set(chore.id, editor); }
      return editor;
    },
  };
}
