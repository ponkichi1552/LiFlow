import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../domain/shared/types';

export function calendarRegistrationDate(value: unknown): LocalDate | undefined {
  if (typeof value !== 'string') return undefined;
  try { parseLocalDate(value as LocalDate); return value as LocalDate; } catch { return undefined; }
}
