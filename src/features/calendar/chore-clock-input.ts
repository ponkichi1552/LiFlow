import type { EventDraft } from './events';
import { moveCalendarStart } from './event-editing';

export type ChoreClocks = { start: number | null; end: number | null };
export const emptyChoreClocks = (): ChoreClocks => ({ start: null, end: null });
export function changeChoreClock(value: EventDraft, clocks: ChoreClocks, field: 'start' | 'end', minute: number) {
  if (field === 'start' && clocks.start !== null && clocks.end !== null) {
    const moved = moveCalendarStart({ ...value, allDay: false, startMinute: clocks.start, endMinute: clocks.end }, { startMinute: minute });
    return { value: moved, clocks: { start: moved.startMinute, end: moved.endMinute } };
  }
  return { value: { ...value, ...(field === 'start' ? { startMinute: minute } : { endMinute: minute }) }, clocks: { ...clocks, [field]: minute } };
}

/** A date-only chore must never acquire the appointment editor's placeholder times. */
export function withChoreClocks(value: EventDraft, clocks: ChoreClocks): EventDraft {
  if (!value.allDay && (clocks.start === null) !== (clocks.end === null)) throw new Error('開始時刻と終了時刻を両方選んでください。');
  return { ...value, allDay: value.allDay || clocks.start === null && clocks.end === null,
    startMinute: clocks.start ?? 0, endMinute: clocks.end ?? 0 };
}
