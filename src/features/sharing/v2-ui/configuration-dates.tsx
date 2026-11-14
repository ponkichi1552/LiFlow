import { useState } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import { CalendarField } from '../../calendar/calendar-field';
import { AccordionSection } from '../../../components/accordion-section';
import { CalendarDayPicker } from '../../../components/calendar-day-picker';
import { typography } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { LocalDate } from '../../../domain/shared/types';

export function V2ConfigurationDates({ today, anchor, onAnchor, monthly = false, disabled = false, needsReview = false, unfolded = false }: {
  today: LocalDate; anchor: string; onAnchor(date: LocalDate): void; monthly?: boolean; disabled?: boolean; needsReview?: boolean; unfolded?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const [open, setOpen] = useState(false);
  let value = today; try { parseLocalDate(anchor as LocalDate); value = anchor as LocalDate; } catch { /* A partial draft never creates an invalid calendar. */ }
  if (unfolded) return <View style={{ minHeight: 58, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Text style={[typography.body, { color: colors.ink }]}>開始日</Text><CalendarField borderless hideLabel commitOnDone label="共有家事の開始日" mode="date" minute={0} date={value} disabled={disabled} onDate={onAnchor} />
  </View>;
  return <AccordionSection plain title="開始日" summary={value.replaceAll('-', '/')} expanded={open || needsReview} onToggle={() => setOpen(value => !value)}>
    {monthly && Number(value.slice(8)) > 28 ? <Text style={[typography.caption, { color: colors.muted }]}>日付のない月は月末になります。</Text> : null}
    <CalendarDayPicker today={today} initialDate={value} label="開始日カレンダー" disabled={disabled}
      selected={date => date === value} describe={date => `開始日を${date.replaceAll('-', '/')}にする`}
      onSelect={date => { if (!disabled) onAnchor(date); }} />
  </AccordionSection>;
}
