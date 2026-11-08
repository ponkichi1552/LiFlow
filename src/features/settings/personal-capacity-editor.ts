import type { AdaptiveAllowedBand, AdaptiveDayOverride } from '../planner/adaptive-input';
import { snapshotPersonalPlacementPreferences } from '../planner/personal-placement-preferences.ts';
import type { PersonalPlacementPreferences } from '../planner/personal-placement-preferences';
import { createAutosaveForm } from './autosave-form.ts';
import type { LocalDate, Weekday } from '../../domain/shared/types';
import { parseLocalDate, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { DayType } from '../planner/day-type-capacity';
import { defaultDayTypeBands } from '../planner/day-type-capacity.ts';

export interface PersonalCapacitySource {
  initial: PersonalPlacementPreferences;
  save(value: PersonalPlacementPreferences, expected: PersonalPlacementPreferences): Promise<void>;
}
interface CapacityBandDraft { id: number; startMinute: number | null; endMinute: number | null }
interface CapacityTypeDraft { maximum: string; bands?: CapacityBandDraft[] }
interface CapacityDraft {
  maximum: string; days: (Omit<AdaptiveDayOverride, 'maximumMinutes'> & { id: number; maximum: string })[];
  allowedBands: PersonalPlacementPreferences['allowedBands'];
  dayTypes?: Record<DayType, CapacityTypeDraft>;
}
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
      ...(value.dayTypes ? { dayTypes: Object.fromEntries((['workday', 'holiday'] as const).map(kind => [kind, {
        maximum: value.dayTypes![kind].maximumMinutes === undefined ? '' : String(value.dayTypes![kind].maximumMinutes),
        ...(value.dayTypes![kind].allowedBands !== undefined ? { bands: value.dayTypes![kind].allowedBands!.map(band => ({ ...band, id: nextId++ })) } : {}),
      }])) as Record<DayType, CapacityTypeDraft> } : {}),
      allowedBands: value.allowedBands.map(band => ({ ...band })), days: value.dayOverrides.map(({ maximumMinutes, ...day }) => ({ ...copyDay(day), id: nextId++, maximum: maximumMinutes === undefined ? '' : String(maximumMinutes) })) }),
    clone: raw => ({ ...raw, allowedBands: raw.allowedBands.map(band => ({ ...band })), days: raw.days.map(day => ({ ...day,
      ...(day.allowedBands ? { allowedBands: day.allowedBands.map(band => ({ ...band })) } : {}) })),
      ...(raw.dayTypes ? { dayTypes: Object.fromEntries((['workday', 'holiday'] as const).map(kind => [kind, { ...raw.dayTypes![kind],
        ...(raw.dayTypes![kind].bands ? { bands: raw.dayTypes![kind].bands!.map(band => ({ ...band })) } : {}) }])) as Record<DayType, CapacityTypeDraft> } : {}) }),
    normalize: raw => {
      const limit = maximum(raw.maximum);
      const profile = (value: CapacityTypeDraft) => {
        const maximumMinutes = maximum(value.maximum);
        return { ...(maximumMinutes !== undefined ? { maximumMinutes } : {}), ...(value.bands !== undefined ? { allowedBands: value.bands.map(band => {
          if (band.startMinute === null || band.endMinute === null) throw new Error('時間帯の開始・終了を選んでください。');
          return { startMinute: band.startMinute, endMinute: band.endMinute };
        }) } : {}) };
      };
      return snapshotPersonalPlacementPreferences({ allowedBands: raw.allowedBands, dayOverrides: raw.days.map(({ id: _id, maximum: text, ...day }) => {
        const limit = maximum(text); return { ...day, ...(limit !== undefined ? { maximumMinutes: limit } : {}) };
      }), ...(limit !== undefined ? { maximumMinutes: limit } : {}),
      ...(raw.dayTypes ? { dayTypes: { workday: profile(raw.dayTypes.workday), holiday: profile(raw.dayTypes.holiday) } } : {}) });
    }, save: async value => { await input.save(value, base); base = value; return value; } });
  const changeType = (kind: DayType, change: (value: CapacityTypeDraft) => CapacityTypeDraft) => form.change(raw => {
    // Convert the old shared cap only after an explicit edit, retaining its value for the other day type.
    const dayTypes = raw.dayTypes ?? { workday: { maximum: raw.maximum }, holiday: { maximum: raw.maximum } };
    return { ...raw, maximum: '', dayTypes: { ...dayTypes, [kind]: change(dayTypes[kind]) } };
  });
  return { ...form, addDate(date: LocalDate) {
    parseLocalDate(date); if (form.getSnapshot().raw.days.some(day => day.date === date)) return;
    form.change(raw => ({ ...raw, days: [...raw.days, { id: nextId++, date, holiday: true, maximum: '' }] }));
  }, toggleHoliday(date: LocalDate, restDays: readonly Weekday[]) {
    parseLocalDate(date); const regular = restDays.includes(weekdayOf(date));
    form.change(raw => {
      const prior = raw.days.find(day => day.date === date); const holiday = !(prior?.holiday ?? regular);
      const { holiday: _old, ...retained } = prior ?? { id: nextId++, date, maximum: '' };
      const replacement = { ...retained, ...(holiday !== regular ? { holiday } : {}) };
      const others = raw.days.filter(day => day.date !== date);
      return { ...raw, days: replacement.holiday !== undefined || replacement.maximum !== '' || replacement.allowedBands !== undefined ? [...others, replacement] : others };
    });
  }, setDateMaximum(date: LocalDate, value: string) {
    parseLocalDate(date); form.change(raw => {
      const prior = raw.days.find(day => day.date === date);
      return { ...raw, days: [...raw.days.filter(day => day.date !== date), { ...(prior ?? { id: nextId++, date }), maximum: value }] };
    });
  }, setMaximum(kind: DayType, value: string) { changeType(kind, profile => ({ ...profile, maximum: value })); },
  setBandTime(kind: DayType, id: number | undefined, edge: 'startMinute' | 'endMinute', minute: number, shown?: AdaptiveAllowedBand) {
    changeType(kind, profile => {
      const bands = profile.bands ?? []; const found = bands.some(band => band.id === id);
      return { ...profile, bands: found ? bands.map(band => band.id === id ? { ...band, [edge]: minute } : band)
        : [...bands, { id: nextId++, ...(shown ?? defaultDayTypeBands(kind)[0]), [edge]: minute }] };
    });
  } };
}
