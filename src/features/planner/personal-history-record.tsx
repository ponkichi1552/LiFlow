import { HistoryRecordRow } from '../../components/history-record-row';
import type { ChoreCompletion } from '../../domain/chores/types';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock';

export function PersonalHistoryRecord({ completion, name, timeZone }: {
  completion: ChoreCompletion; name: string; timeZone?: string;
}) {
  const zone = completion.completedTimeZone ?? timeZone;
  const at = new Date(completion.completedAt);
  const minute = zone ? pinnedClockAt(at, zone).minute : at.getHours() * 60 + at.getMinutes();
  const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  // Raw schedule/learning facts remain stored; the personal history only needs the actual clock.
  return <HistoryRecordRow name={name} time={time} />;
}
