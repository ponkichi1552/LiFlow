import { useState } from 'react';
import { Text, useColorScheme } from 'react-native';
import { AccordionSection } from '../../../components/accordion-section';
import { CalendarDayPicker } from '../../../components/calendar-day-picker';
import { typography } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { LocalDate } from '../../../domain/shared/types';

export function V2ConfigurationDates({ today, anchor, onAnchor, monthly = false, disabled = false, needsReview = false }: {
  today: LocalDate; anchor: string; onAnchor(date: LocalDate): void; monthly?: boolean; disabled?: boolean; needsReview?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const [open, setOpen] = useState(false);
  let value = today; try { parseLocalDate(anchor as LocalDate); value = anchor as LocalDate; } catch { /* A partial draft never creates an invalid calendar. */ }
  return <AccordionSection plain title="開始日" summary={value.replaceAll('-', '/')} expanded={open || needsReview} onToggle={() => setOpen(value => !value)}>
    {monthly && Number(value.slice(8)) > 28 ? <Text style={[typography.caption, { color: colors.muted }]}>日付のない月は月末になります。</Text> : null}
    <CalendarDayPicker today={today} initialDate={value} label="開始日カレンダー" disabled={disabled}
      selected={date => date === value} describe={date => `開始日を${date.replaceAll('-', '/')}にする`}
      onSelect={date => { if (!disabled) onAnchor(date); }} />
  </AccordionSection>;
}
