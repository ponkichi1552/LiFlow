import type { LocalDate } from '../../domain/shared/types';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
export const CALENDAR_REMINDER_MINUTES = [0, 10, 60, 1440] as const;
export interface CalendarReminderRule { scope: string; eventId: string; anchorDate: LocalDate | null; minutes: number | null }
export interface CalendarReminderSettings { enabled: boolean; rules: CalendarReminderRule[] }
export const EMPTY_CALENDAR_REMINDERS: CalendarReminderSettings = { enabled: false, rules: [] };
export function calendarReminderScope(userId?: string | null, groupId?: string) {
  if (!groupId) return 'personal';
  if (!userId) throw new Error('通知を設定するアカウントを確認してください。');
  return `group:${sharedDocumentDigest([userId, groupId])}`;
}
export function checkedReminderMinutes(value: unknown): number | null {
  if (value === null || typeof value === 'number' && (CALENDAR_REMINDER_MINUTES as readonly number[]).includes(value)) return value;
  throw new Error('通知のタイミングを選び直してください。');
}
export function calendarReminderMinutes(settings: CalendarReminderSettings, scope: string, eventId: string | null, anchorDate: LocalDate | null): number | null {
  if (!eventId) return null;
  const own = settings.rules.filter(row => row.scope === scope && row.eventId === eventId);
  return (anchorDate ? own.find(row => row.anchorDate === anchorDate) : undefined)?.minutes ??
    (anchorDate && own.some(row => row.anchorDate === anchorDate && row.minutes === null) ? null : own.find(row => !row.anchorDate)?.minutes ?? null);
}
