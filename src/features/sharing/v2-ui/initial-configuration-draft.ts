import type { V2ResponsibilityPreset } from './responsibility-choices';
import type { SharedChoreRotation } from '../v2/model';
import type { LocalDate } from '../../../domain/shared/types';

export interface InitialConfigurationDraft {
  preset: V2ResponsibilityPreset; memberIds: string[]; advanceOn: SharedChoreRotation['advanceOn'];
  anchor: string; monthly: boolean; interval: string; before: string; after: string;
}
const documents = new WeakMap<object, Map<string, ReturnType<typeof createDraft>>>();
function createDraft(today: LocalDate) {
  const initial = (): InitialConfigurationDraft => ({ preset: '', memberIds: [], advanceOn: 'completion', anchor: today, monthly: false, interval: '', before: '0', after: '0' });
  let value = initial(); let dirty = false; let insideDetails = false;
  const listeners = new Set<() => void>(); const emit = () => { for (const listener of listeners) listener(); };
  const reset = (next = initial()) => { value = next; dirty = false; emit(); };
  return { read: () => value, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change(next: InitialConfigurationDraft) { value = next; dirty = true; emit(); }, reset,
    accepted() { dirty = false; insideDetails = false; emit(); },
    openDetails() { insideDetails = true; }, resumeBasic() { insideDetails = false; },
    navigateAfterSave: async (navigate: () => void) => { if (dirty && !insideDetails) reset(); navigate(); return true; },
    resumeNavigation() {}, flush: async () => !dirty,
    getSnapshot: () => ({ hasDraft: dirty, status: { phase: 'idle' } }),
  };
}
/** Only an internal step of this same authenticated group keeps an unsubmitted initial configuration. */
export function initialConfigurationDraft(scope: object, key: string, today: LocalDate) {
  let entries = documents.get(scope); if (!entries) { entries = new Map(); documents.set(scope, entries); }
  let store = entries.get(key); if (!store) { store = createDraft(today); entries.set(key, store); }
  return store;
}
