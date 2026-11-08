import { createAutosaveForm } from '../../settings/autosave-form.ts';
import type { PrivatePlannerPreferenceStore } from './preference-store.ts';
import { snapshotPrivatePlannerPreferences, privatePlannerPreferenceValues } from './preferences.ts';
import type { PrivatePlannerPreferences, SavedPrivatePlannerPreferences } from './preferences.ts';
import type { Weekday } from '../../../domain/shared/types.ts';
import { snapshotDayTypeCapacity } from '../../planner/day-type-capacity.ts';

export interface PrivatePreferenceDraft {
  timeZone: string; restDays: Weekday[]; heavy: string; normal: string;
  bands: { id: number; weekday: Weekday; start: string; end: string }[];
  maximumMinutes?: number; dayOverrides?: PrivatePlannerPreferences['dayOverrides'];
  dayTypes?: PrivatePlannerPreferences['dayTypes'];
}
const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const copyDays = (days: NonNullable<PrivatePlannerPreferences['dayOverrides']>) => days.map(day => ({ ...day,
  ...(day.allowedBands ? { allowedBands: day.allowedBands.map(band => ({ ...band })) } : {}) }));
function minute(raw: string, end: boolean) {
  const text = raw.normalize('NFKC').trim();
  if (end && text === '24:00') return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(text)) throw new Error('時間帯はHH:mmで入力してください。終了は24:00も指定できます。');
  const [hour, part] = text.split(':').map(Number); return hour * 60 + part;
}
function preferences(raw: PrivatePreferenceDraft) {
  if (!/^(?:[1-9]|10)$/u.test(raw.heavy) || !/^(?:[1-9]|1\d|20)$/u.test(raw.normal)) throw new Error('重い家事は1〜10件、普通の家事は1〜20件で入力してください。');
  return snapshotPrivatePlannerPreferences({ timeZone: raw.timeZone.trim(), restDays: [...raw.restDays],
    loadLimits: { heavyDailyLimit: Number(raw.heavy), normalDailyLimit: Number(raw.normal) },
    allowedBands: raw.bands.map(band => ({ weekday: band.weekday, startMinute: minute(band.start, false), endMinute: minute(band.end, true) })),
    ...(raw.maximumMinutes !== undefined ? { maximumMinutes: raw.maximumMinutes } : {}), ...(raw.dayOverrides ? { dayOverrides: raw.dayOverrides } : {}),
    ...(raw.dayTypes ? { dayTypes: raw.dayTypes } : {}) });
}

/** Reuses the app's single-writer autosave and leave/background lifecycle; incomplete times never become permission. */
export function createPrivatePreferenceEditor(input: { store: PrivatePlannerPreferenceStore; saved: SavedPrivatePlannerPreferences | null;
  defaults: PrivatePlannerPreferences; delayMs?: number }) {
  let revision = input.saved?.revision ?? 0; let nextId = 0;
  const draftFor = (value: PrivatePlannerPreferences): PrivatePreferenceDraft => ({ timeZone: value.timeZone, restDays: [...value.restDays], heavy: String(value.loadLimits.heavyDailyLimit),
    normal: String(value.loadLimits.normalDailyLimit), bands: value.allowedBands.map(band => ({ id: nextId++, weekday: band.weekday, start: time(band.startMinute), end: time(band.endMinute) })),
    ...(value.maximumMinutes !== undefined ? { maximumMinutes: value.maximumMinutes } : {}), ...(value.dayOverrides ? { dayOverrides: copyDays(value.dayOverrides) } : {}),
    ...(value.dayTypes ? { dayTypes: snapshotDayTypeCapacity(value.dayTypes) } : {}) });
  const form = createAutosaveForm({ initial: privatePlannerPreferenceValues(input.saved ?? input.defaults), draft: draftFor,
    clone: raw => ({ ...raw, restDays: [...raw.restDays], bands: raw.bands.map(band => ({ ...band })),
      ...(raw.dayOverrides ? { dayOverrides: copyDays(raw.dayOverrides) } : {}),
      ...(raw.dayTypes ? { dayTypes: snapshotDayTypeCapacity(raw.dayTypes) } : {}) }), normalize: preferences, extra: () => ({ revision }), delayMs: input.delayMs,
    save: async value => {
      const accepted = await input.store.save(revision, value); revision = accepted.revision;
      return privatePlannerPreferenceValues(accepted);
    } });
  return { ...form, addBand(day: Weekday) { if (form.getSnapshot().raw.bands.length < 56) form.change(value => ({ ...value,
    bands: [...value.bands, { id: nextId++, weekday: day, start: '', end: '' }] })); } };
}
