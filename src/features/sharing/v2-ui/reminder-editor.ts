import { createDraftNavigation } from '../../settings/draft-navigation.ts';
import { createAutosaveQueue } from '../../settings/autosave-queue.ts';
import type { V2ReminderStore, V2ReminderControl } from '../../../platform/storage/sharing-v2-reminders';
import { validateV2ReminderPreferences } from '../v2/reminders.ts';
import type { V2ReminderPreferences } from '../v2/reminders';

interface ReminderDraft { enabled: boolean; hour: string; minute: string }
const draft = (value: V2ReminderPreferences): ReminderDraft => ({ enabled: value.enabled, hour: String(value.hour), minute: String(value.minute) });
function normalize(value: ReminderDraft) {
  if (!/^\d{1,2}$/u.test(value.hour) || !/^\d{1,2}$/u.test(value.minute)) throw new Error('時は0〜23、分は0〜59で入力してください。');
  return validateV2ReminderPreferences({ enabled: value.enabled, hour: Number(value.hour), minute: Number(value.minute) });
}
/** Shared autosave queue and navigation lifecycle keep partial times out of the persisted preferences. */
export function createV2ReminderEditor(input: { store: V2ReminderStore; saved: V2ReminderControl; delayMs?: number; afterSave?: () => void }) {
  let base = validateV2ReminderPreferences(input.saved.preferences); let raw = draft(base); let revision = input.saved.revision;
  let afterSave = input.afterSave;
  let touched = false;
  const listeners = new Set<() => void>();
  const queue = createAutosaveQueue<{ value: V2ReminderPreferences }>({ delayMs: input.delayMs, save: async ({ value }) => {
    const accepted = await input.store.save(revision, value); revision = accepted.revision; base = validateV2ReminderPreferences(accepted.preferences);
    if (!touched) raw = draft(base);
    try { afterSave?.(); } catch { /* Delivery failure cannot undo an accepted preference write. */ }
  } });
  function snapshot() {
    let value: V2ReminderPreferences | null = null; let validation: string | null = null;
    try { value = normalize(raw); } catch (error) { validation = error instanceof Error ? error.message : '通知時刻を確認してください。'; }
    return { raw, revision, ...navigation.state(), status: queue.getSnapshot(), validation: touched ? validation : null,
      hasDraft: touched && (validation !== null || JSON.stringify(value) !== JSON.stringify(base)) };
  }
  const discardDraft = () => { queue.remove('value'); raw = draft(base); touched = false; publish(); };
  const navigation = createDraftNavigation({ flush: () => flush(), discard: discardDraft,
    invalid: () => view.validation !== null, failed: () => queue.getSnapshot().phase === 'error', publish: () => publish() });
  let view = snapshot();
  function publish() { view = snapshot(); for (const listener of listeners) try { listener(); } catch { /* Keep saves independent of rendering. */ } }
  queue.subscribe(publish);
  async function flush() { const ok = await queue.flush(); publish(); return ok && !view.hasDraft; }
  return {
    setAfterSave(callback: () => void) { afterSave = callback; },
    getSnapshot: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change(patch: Partial<ReminderDraft>) {
      if (navigation.state().removalAllowed) return; raw = { ...raw, ...patch }; touched = true;
      try { queue.enqueue({ value: normalize(raw) }); } catch { queue.remove('value'); } publish();
    },
    flush,
    resumeNavigation: navigation.resumeNavigation, discardDraft, navigateAfterSave: navigation.navigateAfterSave,

  };
}
