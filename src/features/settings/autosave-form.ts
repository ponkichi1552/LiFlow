import { createAutosaveQueue } from './autosave-queue.ts';
import { createDraftNavigation } from './draft-navigation.ts';

/** One writer for validated forms. Partial input stays visible and can never replace a valid saved value. */
export function createAutosaveForm<Draft extends object, Value extends object, Extra extends object = Record<never, never>>(input: {
  initial: Value; draft(value: Value): Draft; clone(raw: Draft): Draft; normalize(raw: Draft): Value;
  save(value: Value): Promise<Value>; extra?(): Extra; delayMs?: number;
}) {
  let base = input.initial; let raw = input.draft(base); let touched = false;
  const listeners = new Set<() => void>();
  const queue = createAutosaveQueue<{ value: Value }>({ delayMs: input.delayMs, save: async ({ value }) => {
    base = await input.save(value);
    // Discard cannot cancel an already committed writer. Follow its returned
    // baseline when there is no newer edit, rather than displaying stale input.
    if (!touched) raw = input.draft(base);
  } });
  function snapshot() {
    let normalized: Value | null = null; let validation: string | null = null;
    try { normalized = input.normalize(raw); } catch (error) { validation = error instanceof Error ? error.message : '入力した内容を確認してください。'; }
    return { ...input.extra?.() as Extra, raw, status: queue.getSnapshot(), validation: touched ? validation : null, ...navigation.state(),
      hasDraft: touched && (validation !== null || JSON.stringify(normalized) !== JSON.stringify(base)) };
  }
  const discardDraft = () => { queue.remove('value'); raw = input.draft(base); touched = false; publish(); };
  const navigation = createDraftNavigation({ flush: () => flush(), discard: discardDraft,
    invalid: () => view.validation !== null, failed: () => queue.getSnapshot().phase === 'error', publish: () => publish() });
  let view = snapshot();
  const publish = () => { view = snapshot(); for (const listener of listeners) try { listener(); } catch { /* Observers cannot discard queued writes. */ } };
  queue.subscribe(publish);
  const change = (update: (value: Draft) => Draft) => {
    if (navigation.state().removalAllowed) return;
    raw = update(input.clone(raw)); touched = true;
    try {
      const value = input.normalize(raw); const phase = queue.getSnapshot().phase;
      if (phase !== 'saving' && phase !== 'error' && JSON.stringify(value) === JSON.stringify(base)) queue.remove('value');
      else queue.enqueue({ value });
    } catch { queue.remove('value'); }
    publish();
  };
  const flush = async () => { const success = await queue.flush(); publish(); return success && !view.hasDraft; };
  return { change, flush, getSnapshot: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    resumeNavigation: navigation.resumeNavigation, discardDraft, navigateAfterSave: navigation.navigateAfterSave,
  };
}
