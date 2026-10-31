import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';

/** Group only after the caller has applied its history visibility/authority rules. */
export function groupHistoryByDay<T>(records: readonly T[], read: (record: T) => { id: string; date: LocalDate; timestamp: string }) {
  const days = new Map<LocalDate, { value: T; id: string; timestamp: string }[]>();
  for (const value of records) {
    const { id, date, timestamp } = read(value); parseLocalDate(date);
    const rows = days.get(date) ?? []; rows.push({ value, id, timestamp }); days.set(date, rows);
  }
  let previousMonth = '';
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, rows]) => {
    const month = date.slice(0, 7); const showMonth = month !== previousMonth; previousMonth = month;
    return { date, month, showMonth, records: rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id)).map(row => row.value) };
  });
}
