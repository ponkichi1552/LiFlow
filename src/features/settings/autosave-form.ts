import { createAutosaveQueue } from './autosave-queue.ts';

/** One writer for validated forms. Partial input stays visible and can never replace a valid saved value. */
export function createAutosaveForm<Draft extends object, Value extends object, Extra extends object = Record<never, never>>(input: {
  initial: Value; draft(value: Value): Draft; clone(raw: Draft): Draft; normalize(raw: Draft): Value;
  save(value: Value): Promise<Value>; extra?(): Extra; delayMs?: number;
}) {
  let base = input.initial; let raw = input.draft(base); let touched = false; let leaving = false; let removalAllowed = false; let navigationBlocked = false;
  const listeners = new Set<() => void>();
  const queue = createAutosaveQueue<{ value: Value }>({ delayMs: input.delayMs, save: async ({ value }) => { base = await input.save(value); } });
  function snapshot() {
    let normalized: Value | null = null; let validation: string | null = null;
    try { normalized = input.normalize(raw); } catch (error) { validation = error instanceof Error ? error.message : '入力した内容を確認してください。'; }
    return { ...input.extra?.() as Extra, raw, status: queue.getSnapshot(), validation: touched ? validation : null, removalAllowed, navigationBlocked,
      hasDraft: touched && (validation !== null || JSON.stringify(normalized) !== JSON.stringify(base)) };
  }
  let view = snapshot();
  const publish = () => { view = snapshot(); for (const listener of listeners) try { listener(); } catch { /* Observers cannot discard queued writes. */ } };
  queue.subscribe(publish);
  const change = (update: (value: Draft) => Draft) => {
    if (removalAllowed || leaving) return;
    raw = update(input.clone(raw)); touched = true;
    try { queue.enqueue({ value: input.normalize(raw) }); } catch { queue.remove('value'); }
    publish();
  };
  const flush = async () => { const success = await queue.flush(); publish(); return success && !view.hasDraft; };
  return { change, flush, getSnapshot: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    resumeNavigation() { removalAllowed = false; leaving = false; publish(); },
    discardDraft() { queue.remove('value'); raw = input.draft(base); touched = false; navigationBlocked = false; publish(); },
    async navigateAfterSave(navigate: () => void) {
      if (leaving) return false; leaving = true;
      if (!await flush()) { leaving = false; navigationBlocked = true; publish(); return false; }
      removalAllowed = true; navigationBlocked = false; publish(); navigate(); return true;
    },
  };
}
