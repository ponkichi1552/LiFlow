import type { ChoreDefinition, FrequencyMode } from '../../domain/chores/types';
import type { ChoreSettingsPatch } from '../../domain/chores/settings-patch';
import { applyChoreSettingsPatch, parseSettingInteger } from '../../domain/chores/settings-patch.ts';
import { createAutosaveQueue } from './autosave-queue.ts';
import { registeredChoreCycleDays } from '../../domain/chores/cycle-policy.ts';
import type { PersonalCadenceView } from '../planner/adaptive-cadence';

const cycleTextFor = (chore: ChoreDefinition, mode: FrequencyMode) => String(registeredChoreCycleDays(chore, mode) ?? '');

/** Document-owned draft and retry queue survive a virtual row being unmounted. */
export function createChoreSettingsEditor(chore: ChoreDefinition, mode: FrequencyMode,
  savePatch: (patch: ChoreSettingsPatch, base: ChoreDefinition) => Promise<void>, current?: PersonalCadenceView) {
  let draft = {
    cycleText: current?.mode === mode ? current.days === null ? '' : String(current.days) : cycleTextFor(chore, mode),
    radiusText: String(current?.mode === mode ? current.windowRadiusDays : chore.windowRadiusDays), load: chore.load, enabled: chore.enabled,
    holidayPriority: chore.holidayPriority, dryingPreference: chore.laundryDryingPreference ?? 'either',
  };
  let enabledTouched = false; let emptyCyclePending = false; let displayedBase = chore;
  let revision = 0; const draftRevisions = new Map<keyof typeof draft, number>();
  let resetDraft: { generation: number; revisions: Map<keyof typeof draft, number> } | undefined;
  type PendingPatch = ChoreSettingsPatch & { resetGeneration?: number };
  const queue = createAutosaveQueue<PendingPatch>({ save: async pending => {
    const { resetGeneration, ...patch } = pending;
    await savePatch(patch, displayedBase); displayedBase = applyChoreSettingsPatch(displayedBase, patch);
    if (patch.resetSchedule && resetDraft && resetDraft.generation === resetGeneration) {
      const result = { cycleText: cycleTextFor(displayedBase, mode),
        radiusText: String(displayedBase.windowRadiusDays), load: displayedBase.load, holidayPriority: displayedBase.holidayPriority, dryingPreference: displayedBase.laundryDryingPreference ?? 'either' };
      for (const field of Object.keys(result) as (keyof typeof result)[]) {
        if (draftRevisions.get(field) === resetDraft.revisions.get(field)) draft = { ...draft, [field]: result[field] };
      }
      resetDraft = undefined;
    }
  } });
  let state = { draft, status: queue.getSnapshot() };
  const listeners = new Set<() => void>();
  const emit = () => { state = { draft, status: queue.getSnapshot() }; for (const fn of listeners) try { fn(); } catch { /* Keep the save queue independent of rendering. */ } };
  queue.subscribe(emit);
  const update = (patch: Partial<typeof draft>) => { for (const field of Object.keys(patch) as (keyof typeof draft)[]) draftRevisions.set(field, ++revision); draft = { ...draft, ...patch }; emit(); };
  const resetCycle = () => {
    emptyCyclePending = false;
    const reset = applyChoreSettingsPatch(displayedBase, { cycleDays: null });
    update({ cycleText: cycleTextFor(reset, mode), ...(reset.requiresCycleSelection ? { enabled: false } : {}) });
    queue.enqueue({ cycleDays: null, ...(reset.requiresCycleSelection ? { enabled: false } : {}) }, true);
  };
  const flush = () => { if (emptyCyclePending) resetCycle(); return queue.flush(); };
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    flush, resetCycle,
    resetSchedule() {
      const reset = applyChoreSettingsPatch(displayedBase, { resetSchedule: true }); emptyCyclePending = false;
      for (const field of ['cycleDays', 'windowRadiusDays', 'load', 'holidayPriority', 'laundryDryingPreference'] as const) queue.remove(field);
      update({ cycleText: cycleTextFor(reset, mode),
        radiusText: String(reset.windowRadiusDays), load: reset.load, holidayPriority: reset.holidayPriority, dryingPreference: reset.laundryDryingPreference ?? 'either' });
      resetDraft = { generation: ++revision, revisions: new Map(draftRevisions) };
      queue.enqueue({ resetSchedule: true, resetGeneration: resetDraft.generation }, true);
      return queue.flush();
    },
    changeCycle(text: string) {
      emptyCyclePending = !text.trim(); const value = parseSettingInteger(text, 1, Number.MAX_SAFE_INTEGER);
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
    get(chore: ChoreDefinition, mode: FrequencyMode, save: Parameters<typeof createChoreSettingsEditor>[2], current?: PersonalCadenceView) {
      let editor = editors.get(chore.id);
      if (!editor) { editor = createChoreSettingsEditor(chore, mode, save, current); editors.set(chore.id, editor); }
      return editor;
    },
  };
}
