import type { CalendarCountColors } from '@/domain/shared/types';

export const DEFAULT_CALENDAR_COUNT_COLORS: CalendarCountColors = {
  low: '#4AADE0',
  medium: '#F2A541',
  high: '#E45B61',
};

export function parseCalendarCountColors(value: string | null | undefined): CalendarCountColors {
  if (!value) return DEFAULT_CALENDAR_COUNT_COLORS;
  try {
    const parsed = JSON.parse(value) as Partial<CalendarCountColors>;
    const validColor = (color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
    return {
      low: validColor(parsed.low) ? parsed.low : DEFAULT_CALENDAR_COUNT_COLORS.low,
      medium: validColor(parsed.medium) ? parsed.medium : DEFAULT_CALENDAR_COUNT_COLORS.medium,
      high: validColor(parsed.high) ? parsed.high : DEFAULT_CALENDAR_COUNT_COLORS.high,
    };
  } catch {
    return DEFAULT_CALENDAR_COUNT_COLORS;
  }
}
