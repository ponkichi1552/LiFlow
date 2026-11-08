import { addDays, daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { SharedChoreConfiguration } from './model.ts';

type Cadence = Pick<SharedChoreConfiguration, 'anchorDate' | 'intervalDays' | 'monthly'>;

/** Monthly dates always derive from the original day, so February never shifts a 31st rule to the 28th. */
export function v2AnchorAtIndex(configuration: Cadence, index: number): LocalDate {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid recurrence index');
  if (!configuration.monthly) return addDays(configuration.anchorDate, index * configuration.intervalDays);
  const start = parseLocalDate(configuration.anchorDate);
  const serial = start.getUTCFullYear() * 12 + start.getUTCMonth() + index;
  const year = Math.floor(serial / 12); const month = serial % 12;
  if (year > 9999) throw new Error('Recurrence date is outside the supported range');
  const day = Math.min(start.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` as LocalDate;
}
export function v2AnchorIndexBefore(configuration: Cadence, through: LocalDate): number {
  if (!configuration.monthly) return Math.floor(daysBetween(configuration.anchorDate, through) / configuration.intervalDays);
  const start = parseLocalDate(configuration.anchorDate); const end = parseLocalDate(through);
  const index = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  return index < 0 ? -1 : v2AnchorAtIndex(configuration, index) > through ? index - 1 : index;
}
export function v2AnchorIndexOnOrAfter(configuration: Cadence, from: LocalDate): number {
  const before = v2AnchorIndexBefore(configuration, from);
  return before < 0 ? 0 : v2AnchorAtIndex(configuration, before) < from ? before + 1 : before;
}
export function v2CadenceLabel(configuration: Cadence): string {
  return configuration.monthly ? `毎月${Number(configuration.anchorDate.slice(8))}日` : `${configuration.intervalDays}日ごと`;
}
