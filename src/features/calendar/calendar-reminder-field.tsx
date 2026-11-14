import { useState } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import { Chevron } from '../../components/chevron';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarOptionPicker } from './calendar-option-picker';
export const calendarReminderOptions = [
  { value: 'none', label: '通知なし' }, { value: '0', label: '開始時' }, { value: '10', label: '10分前' }, { value: '60', label: '1時間前' }, { value: '1440', label: '前日' },
];
export function CalendarReminderField({ minutes, disabled, enabled, onChange }: { minutes: number | null; disabled?: boolean; enabled: boolean; onChange(minutes: number | null): void }) {
  const [open, setOpen] = useState(false); const colors = plannerColorsForScheme(useColorScheme());
  const value = minutes === null ? 'none' : String(minutes);
  return <View><Pressable accessibilityRole="button" accessibilityLabel="予定の通知を選択" accessibilityValue={{ text: calendarReminderOptions.find(row => row.value === value)?.label ?? '通知なし' }} disabled={disabled} onPress={() => setOpen(true)}
    style={{ minHeight: 60, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ width: 76 }}><Text style={{ ...typography.body, color: colors.ink }}>通知</Text>{!enabled ? <Text style={{ ...typography.caption, color: colors.muted }}>全体オフ</Text> : null}</View>
    <View style={{ flex: 1, minHeight: 44, backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ ...typography.body, color: colors.ink, flex: 1 }}>{calendarReminderOptions.find(row => row.value === value)?.label ?? '通知なし'}</Text><Chevron direction="down" /></View>
  </Pressable>{open ? <CalendarOptionPicker title="予定の通知" value={value} options={calendarReminderOptions} onSelect={next => onChange(next === 'none' ? null : Number(next))} onClose={() => setOpen(false)} /> : null}</View>;
}
