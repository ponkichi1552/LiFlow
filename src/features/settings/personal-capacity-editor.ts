import type { AdaptiveDayOverride } from '../planner/adaptive-input';
import { snapshotPersonalPlacementPreferences } from '../planner/personal-placement-preferences.ts';
import type { PersonalPlacementPreferences } from '../planner/personal-placement-preferences';
import { createAutosaveForm } from './autosave-form.ts';
import type { LocalDate } from '../../domain/shared/types';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';

export interface PersonalCapacitySource {
  initial: PersonalPlacementPreferences;
  save(value: PersonalPlacementPreferences, expected: PersonalPlacementPreferences): Promise<void>;
}
interface CapacityDraft { maximum: string; days: (Omit<AdaptiveDayOverride, 'maximumMinutes'> & { id: number; maximum: string })[]; allowedBands: PersonalPlacementPreferences['allowedBands'] }
function maximum(raw: string) {
  const text = raw.normalize('NFKC').trim();
  if (text && (!/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text)))) throw new Error('時間上限は0以上の分数で入力してください。');
  return text ? Number(text) : undefined;
}
export function createPersonalCapacityEditor(input: PersonalCapacitySource & { delayMs?: number }) {
  let base = snapshotPersonalPlacementPreferences(input.initial); let nextId = 0;
  const copyDay = (day: AdaptiveDayOverride) => ({ ...day, ...(day.allowedBands ? { allowedBands: day.allowedBands.map(band => ({ ...band })) } : {}) });
  const form = createAutosaveForm<CapacityDraft, PersonalPlacementPreferences>({ initial: base, delayMs: input.delayMs,
    draft: value => ({ maximum: value.maximumMinutes === undefined ? '' : String(value.maximumMinutes),
      allowedBands: value.allowedBands.map(band => ({ ...band })), days: value.dayOverrides.map(({ maximumMinutes, ...day }) => ({ ...copyDay(day), id: nextId++, maximum: maximumMinutes === undefined ? '' : String(maximumMinutes) })) }),
    clone: raw => ({ ...raw, allowedBands: raw.allowedBands.map(band => ({ ...band })), days: raw.days.map(day => ({ ...day,
      ...(day.allowedBands ? { allowedBands: day.allowedBands.map(band => ({ ...band })) } : {}) })) }),
    normalize: raw => {
      const limit = maximum(raw.maximum);
      return snapshotPersonalPlacementPreferences({ allowedBands: raw.allowedBands, dayOverrides: raw.days.map(({ id: _id, maximum: text, ...day }) => {
        const limit = maximum(text); return { ...day, ...(limit !== undefined ? { maximumMinutes: limit } : {}) };
      }), ...(limit !== undefined ? { maximumMinutes: limit } : {}) });
    }, save: async value => { await input.save(value, base); base = value; return value; } });
  return { ...form, addDate(date: LocalDate) {
    parseLocalDate(date); if (form.getSnapshot().raw.days.some(day => day.date === date)) return;
    form.change(raw => ({ ...raw, days: [...raw.days, { id: nextId++, date, holiday: true, maximum: '' }] }));
  } };
}
