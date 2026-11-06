import { parseSettingInteger } from '../../../domain/chores/settings-patch.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { SharedChoreConfiguration } from '../v2/model.ts';
import { canonicalJson } from '../operations.ts';
import { createV2ConfigurationAutosave } from './configuration-autosave.ts';

const limits = { intervalDays: [1, 3650], windowBeforeDays: [0, 14], windowAfterDays: [0, 14] } as const;
type NumericField = keyof typeof limits;
function texts(configuration: SharedChoreConfiguration) {
  return { intervalDays: String(configuration.intervalDays), windowBeforeDays: String(configuration.windowBeforeDays),
    windowAfterDays: String(configuration.windowAfterDays), anchorDate: configuration.anchorDate, active: configuration.active !== false };
}
export interface V2EditorInput { configuration: SharedChoreConfiguration; effectiveFrom: LocalDate;
  save: Parameters<typeof createV2ConfigurationAutosave>[0]['save']; onSaved: () => Promise<void> }

/** An external store keeps remote updates and queued drafts coherent without render-time ref writes. */
export function createV2ConfigurationEditorState(initial: V2EditorInput) {
  let input = initial; let effectiveFrom = initial.effectiveFrom; let draft = texts(initial.configuration); let refreshError: string | null = null;
  let leaving = false; let removalAllowed = false;
  const listeners = new Set<() => void>();
  const autosave = createV2ConfigurationAutosave({ configuration: initial.configuration, effectiveFrom: () => effectiveFrom,
    save: (edits, from) => input.save(edits, from), onSaved: async () => { refreshError = null; await input.onSaved(); },
    onRefreshError: () => { refreshError = '保存済みです。表示を更新できなかったため、再度開いて確認してください。'; },
  });
  function state() {
    return { draft, effectiveFrom, status: autosave.getSnapshot(), refreshError, leaving, removalAllowed,
      hasDraft: Object.keys(draft).some((field) => autosave.isDirty(field as keyof typeof draft)),
      anchorError: (() => { try { parseLocalDate(draft.anchorDate); return draft.anchorDate > effectiveFrom ? '基準日は適用開始日以前にしてください。' : null; }
        catch { return '日付を年-月-日で入力してください。'; } })() };
  }
  let snapshot = state();
  function publish() {
    const next = state(); if (canonicalJson(next) === canonicalJson(snapshot)) return;
    snapshot = next; for (const listener of listeners) try { listener(); } catch { /* Observer failures cannot discard drafts. */ }
  }
  autosave.subscribe(publish);
  const numberError = (field: NumericField) => {
    const [min, max] = limits[field]; return parseSettingInteger(draft[field], min, max) === undefined ? `${min}〜${max}日の整数で入力してください。` : null;
  };
  const flush = async () => { const saved = await autosave.flush(); return saved && !snapshot.anchorError && !Object.keys(limits).some((field) => numberError(field as NumericField)); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    updateInput(next: V2EditorInput) {
      if (next.configuration.ruleVersion < input.configuration.ruleVersion) {
        input = { ...next, configuration: input.configuration }; return;
      }
      input = next; autosave.updateDisplayed(next.configuration); const received = texts(next.configuration);
      draft = Object.fromEntries(Object.entries(received).map(([field, value]) => [field, autosave.isDirty(field as keyof typeof received)
        ? draft[field as keyof typeof received] : value])) as typeof draft; publish();
    },
    flush,
    resumeNavigation() { leaving = false; removalAllowed = false; publish(); },
    async navigateAfterSave(navigate: () => void): Promise<boolean> {
      if (leaving) return false; leaving = true; publish();
      if (!await flush()) { leaving = false; publish(); return false; }
      removalAllowed = true; publish();
      try { navigate(); return true; }
      catch { leaving = false; removalAllowed = false; refreshError = '端末に保存済みです。画面を移動できなかったため、もう一度お試しください。'; publish(); return false; }
    },
    hasDraft: () => snapshot.hasDraft, numberError,
    changeEffectiveFrom(value: LocalDate) {
      if (snapshot.hasDraft || ['pending', 'saving'].includes(autosave.getSnapshot().phase)) return;
      effectiveFrom = value; publish();
    },
    changeNumber(field: NumericField, text: string) {
      draft = { ...draft, [field]: text }; const [min, max] = limits[field]; const value = parseSettingInteger(text, min, max);
      if (value === undefined) autosave.invalidate(field); else autosave.enqueue(field, value); publish();
    },
    changeAnchor(text: string) {
      draft = { ...draft, anchorDate: text as LocalDate };
      try { parseLocalDate(text as LocalDate); if (text > input.effectiveFrom) throw new Error('Later anchor'); autosave.enqueue('anchorDate', text as LocalDate); }
      catch { autosave.invalidate('anchorDate'); } publish();
    },
    changeActive(value: boolean) { draft = { ...draft, active: value }; autosave.enqueue('active', value, true); publish(); },
    discard() {
      for (const field of Object.keys(draft)) autosave.discard(field as keyof typeof draft);
      autosave.updateDisplayed(input.configuration); draft = texts(input.configuration); effectiveFrom = input.effectiveFrom; publish();
    },
  };
}
