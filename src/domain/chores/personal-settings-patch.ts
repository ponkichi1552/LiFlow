import type { LocalDate } from '../shared/types';
import type { ChoreDefinition } from './types';
import { applyChoreSettingsPatch, type ChoreSettingsPatch } from './settings-patch.ts';
import { resetChoreSchedule } from './schedule-defaults.ts';
import { checkedPersonalSchedule } from './personal-schedule.ts';

export interface PersonalChoreSettingsPatch extends ChoreSettingsPatch {
  personalScheduleStartDate?: LocalDate;
  personalScheduleCadence?: { startDateWhenMissing: LocalDate } & ({ mode: 'once' | 'interval' } | { mode: 'monthly'; day: number });
}

/** Apply individual schedule fields to the current local definition, including its latest timing. */
export function applyPersonalChoreSettingsPatch(chore: ChoreDefinition, input: PersonalChoreSettingsPatch): ChoreDefinition {
  const { personalScheduleStartDate, personalScheduleCadence: cadence, ...patch } = input;
  const changesLocalSchedule = personalScheduleStartDate !== undefined || cadence !== undefined;
  const setsCycle = patch.cycleDays != null;
  if (!changesLocalSchedule && !setsCycle) return applyChoreSettingsPatch(chore, patch);
  if (changesLocalSchedule && chore.personalSchedulingKind === 'seasonal') throw new Error('季節家事は地域別の固定日を使います。');
  const before = patch.resetSchedule ? resetChoreSchedule(chore) : chore;
  let schedule = patch.personalSchedule === undefined ? before.personalSchedule
    : patch.personalSchedule === null ? undefined : checkedPersonalSchedule(patch.personalSchedule);
  const startDate = personalScheduleStartDate ?? schedule?.startDate ?? cadence?.startDateWhenMissing;
  if (changesLocalSchedule && startDate !== undefined) {
    schedule = checkedPersonalSchedule({ ...schedule, startDate,
      ...(cadence ? { once: cadence.mode === 'once' ? true : undefined, monthlyDay: cadence.mode === 'monthly' ? cadence.day : undefined } : {}) });
    patch.personalSchedule = schedule;
  }
  const saved = applyChoreSettingsPatch(chore, patch);
  if (setsCycle && schedule?.once && saved.personalSchedule && schedule.calendarTiming) {
    saved.personalSchedule = checkedPersonalSchedule({ ...saved.personalSchedule, calendarTiming: schedule.calendarTiming });
  }
  return saved;
}
