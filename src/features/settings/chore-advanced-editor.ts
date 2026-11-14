import type { ChoreDefinition } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import { applyChoreSettingsPatch, parseSettingInteger, type ChoreSettingsPatch } from '../../domain/chores/settings-patch.ts';
import { createAutosaveQueue } from './autosave-queue.ts';
import { createDraftNavigation } from './draft-navigation.ts';

export interface ChoreSectionDraft { title: string; text: string }
const lines = (text: string) => text.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);

/** Private fields only. Each write is a patch against the latest definition, not a stale whole-document replacement. */
export function createChoreAdvancedEditor(chore: ChoreDefinition, today: LocalDate, save: (patch: ChoreSettingsPatch) => Promise<void>) {
  let base = chore;
  const format = (value: ChoreDefinition) => ({ name: value.name, description: value.description,
    instructions: value.instructions.join('\n'), tools: value.tools.join('\n'), cautions: value.cautions.join('\n'),
    sections: (value.procedureSections ?? []).map(section => ({ title: section.title, text: section.steps.join('\n') })),
    startDate: value.personalSchedule?.startDate ?? today, monthly: value.personalSchedule?.monthlyDay !== undefined,
    monthlyDay: String(value.personalSchedule?.monthlyDay ?? Number((value.personalSchedule?.startDate ?? today).slice(8))) });
  let raw = format(chore); let persisted = raw; let errors: Record<string, string> = {};
  const listeners = new Set<() => void>(); let publish = () => {};
  const queue = createAutosaveQueue<ChoreSettingsPatch>({ save: async patch => {
    const accepted = applyChoreSettingsPatch(base, patch); await save(patch); base = accepted;
    // Preserve partial/invalid text being entered in another field during this save.
    const formatted = format(base);
    const keys: (keyof typeof raw)[] = Object.keys(patch).flatMap(key => key === 'personalSchedule' ? ['startDate', 'monthly', 'monthlyDay'] : key === 'procedureSections' ? ['sections'] : [key]) as (keyof typeof raw)[];
    for (const key of keys) persisted = { ...persisted, [key]: formatted[key] };
  } });
  const dirty = () => JSON.stringify(raw) !== JSON.stringify(persisted);
  const discard = () => { queue.discard(); raw = { ...persisted, sections: persisted.sections.map(section => ({ ...section })) }; errors = {}; publish(); };
  const navigation = createDraftNavigation({ flush: () => queue.flush(), discard, invalid: () => Object.keys(errors).length > 0,
    failed: () => queue.getSnapshot().phase === 'error', publish: () => publish() });
  let snapshot = { raw, errors, status: queue.getSnapshot(), hasDraft: dirty(), ...navigation.state() };
  publish = () => { snapshot = { raw, errors, status: queue.getSnapshot(), hasDraft: dirty(), ...navigation.state() }; for (const listener of listeners) listener(); };
  queue.subscribe(publish);
  const validate = (field: keyof ChoreSettingsPatch, patch: ChoreSettingsPatch, immediate = false) => {
    try { applyChoreSettingsPatch(base, patch); const { [field]: _, ...remaining } = errors; errors = remaining; queue.enqueue(patch, immediate); }
    catch (cause) { queue.remove(field); errors = { ...errors, [field]: cause instanceof Error ? cause.message : '入力を確認してください。' }; }
    publish();
  };
  const changeSchedule = (patch: Partial<Pick<typeof raw, 'startDate' | 'monthly' | 'monthlyDay'>>) => {
    raw = { ...raw, ...patch };
    const day = parseSettingInteger(raw.monthlyDay, 1, 31);
    if (raw.monthly && day === undefined) { queue.remove('personalSchedule'); errors = { ...errors, personalSchedule: '毎月の日付は1〜31日で入力してください。' }; publish(); return; }
    validate('personalSchedule', { personalSchedule: { startDate: raw.startDate, ...(raw.monthly ? { monthlyDay: day! } : {}) } }, 'monthly' in patch || 'startDate' in patch);
  };
  return {
    getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush: queue.flush, discard, ...navigation,
    changeSchedule,
    changeText(field: 'name' | 'description' | 'instructions' | 'tools' | 'cautions', value: string) {
      raw = { ...raw, [field]: value };
      validate(field, { [field]: field === 'name' || field === 'description' ? value : lines(value) });
    },
    changeSections(sections: ChoreSectionDraft[]) {
      raw = { ...raw, sections };
      validate('procedureSections', { procedureSections: sections.map(section => ({ title: section.title, steps: lines(section.text) })) });
    },
  };
}
